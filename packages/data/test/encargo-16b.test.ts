/**
 * Encargo 16b (Etapa 1.3), contra Postgres real (`0082`, `0083`, `0084`):
 *  - Grupos de unidades: los arma la administración, se expanden al calcular, y su RLS.
 *  - Lo que el catálogo aplica solo: se aplica al calcular el mes y sobrevive a volver a calcular.
 *  - La planilla de usos: la vista previa con sus errores por fila, la aplicación entera o nada, la
 *    suma de usos contra la cantidad del renglón, y el detalle en la boleta.
 *  - El importe a cargar cada vez (una multa), con el límite propio del operador.
 *  - El orden de cálculo: expensa, bonificación y después el resto.
 *  - Permisos por rol.
 *
 * Escenario: tres unidades con coeficientes 0,5 / 0,3 / 0,2 y $ 2.000 de gasto por mes
 * ($ 1.000 / $ 600 / $ 400 de expensa).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { registroPorDefecto } from "@admin-barrios/documentos/cobranza";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirMes } from "../src/servicios/circuito-del-mes.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { crearConceptoBoleta, editarConceptoBoleta, listarConceptosBoleta } from "../src/servicios/conceptos-boleta.ts";
import { aplicarConceptoAUnidad } from "../src/servicios/cargos.ts";
import { armarVistasDelPeriodo } from "../src/servicios/vista-boleta.ts";
import { borrarGrupoDeUnidades, crearGrupoDeUnidades, editarGrupoDeUnidades, listarGruposDeUnidades } from "../src/servicios/grupos.ts";
import { aplicarPlanillaDeUsos, conceptosDelMes, vistaPreviaDePlanillaDeUsos } from "../src/servicios/conceptos-del-mes.ts";
import { borrarArbol, borrarParametrosDe, cargarParametro, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf1: string;
let uf2: string;
let uf3: string;
let ufDeOtroBarrio: string;
let conceptoId: string;

const registro = registroPorDefecto();
const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminB = () => arbol.usuarios.adminBarrioA1;
const operador = () => arbol.usuarios.operadorA1;

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

async function crearPeriodo(periodo: string, vencimiento: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, modelo, primer_vencimiento) values ($1, $2, 'variable', $3) returning id",
    [barrio(), periodo, vencimiento],
  );
  await admin.query(
    "insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '2000.00')",
    [barrio(), rows[0]!.id, conceptoId],
  );
  return rows[0]!.id;
}

const emitir = (periodoId: string, usuario = adminB()) =>
  como(usuario, (tx) => emitirMes(tx, { periodoId, huellaVista: null, vistaCalculadaEl: null, confirmarCambios: false }));
const calcular = (periodoId: string) => como(adminB(), (tx) => generarLiquidaciones(tx, { periodoId, origenSaldo: "calculado" }));

/** Un concepto de boleta por el servicio (el camino de la pantalla), con valor desde siempre. */
const concepto = (campos: Record<string, unknown>) =>
  como(adminB(), (tx) =>
    crearConceptoBoleta(tx, {
      barrioId: barrio(), clase: "cargo", metodo: "monto_fijo", baseCalculo: "sin_base", clasificacionFiscal: "sin_clasificar",
      financiamiento: null, requiereAdmin: false, ordenImpresion: 0, vigenteDesde: "2000-01-01",
      montoFijo: null, porcentaje: null, precioUnitario: null, tope: null,
      ...campos,
    } as never),
  );

const grupo = (nombre: string, unidades: string[]) => como(adminB(), (tx) => crearGrupoDeUnidades(tx, { barrioId: barrio(), nombre, unidades }));

type Aplicacion = { uf: string; nombre: string; origen: string; importe: string | null; cantidad: string | null; detalle: string; anulada: boolean; por: string };
const aplicacionesDe = async (periodoId: string): Promise<Aplicacion[]> =>
  (
    await admin.query<Aplicacion>(
      `select unidad_funcional_id as uf, nombre_concepto as nombre, origen_evaluacion as origen, importe_resuelto::text as importe,
              trim_scale(cantidad)::text as cantidad, detalle, anulado_at is not null as anulada, aplicado_por as por
         from concepto_boleta_unidad where periodo_id = $1 order by aplicado_at, unidad_funcional_id`,
      [periodoId],
    )
  ).rows;
const vivas = async (periodoId: string) => (await aplicacionesDe(periodoId)).filter((a) => !a.anulada);
const totalesDe = async (periodoId: string): Promise<string[]> => {
  const { rows } = await admin.query<{ uf: string; total: string }>("select unidad_funcional_id as uf, total::text from liquidacion where periodo_id = $1", [periodoId]);
  return [uf1, uf2, uf3].map((u) => rows.find((r) => r.uf === u)!.total);
};

const ENCABEZADO = ["manzana", "lote", "concepto", "fecha", "cantidad"];
const planilla = (periodoId: string, archivo: string, filas: string[][], extra: Record<string, unknown> = {}) => ({
  periodoId, archivo, filas: [ENCABEZADO, ...filas], confirmarMontoInusual: true, ...extra,
});

/** Pádel a $ 120 el turno y club house a $ 450 la jornada: lo que entra por planilla. */
async function conceptosPorUso(): Promise<void> {
  await concepto({ nombre: "Cancha de pádel", metodo: "precio_x_cantidad", precioUnitario: "120.00", destinatario: "por_uso", modoMes: "planilla_o_mano", unidadUso: "turno" });
  await concepto({ nombre: "Uso del club house", metodo: "precio_x_cantidad", precioUnitario: "450.00", destinatario: "por_uso", modoMes: "planilla_o_mano", unidadUso: "jornada" });
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, barrio(), { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  await crearBarrio(admin, arbol.barrioA2.id, { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  const { rows: ufs } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
     values ($1,'1','1','construido'), ($1,'1','2','construido'), ($1,'1','3','baldio') returning id`,
    [barrio()],
  );
  [uf1, uf2, uf3] = [ufs[0]!.id, ufs[1]!.id, ufs[2]!.id];
  ufDeOtroBarrio = (
    await admin.query<{ id: string }>("insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad) values ($1,'1','1','construido') returning id", [arbol.barrioA2.id])
  ).rows[0]!.id;
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [barrio()],
  );
  await admin.query(
    "insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,0.5), ($1,$2,$4,0.3), ($1,$2,$5,0.2)",
    [barrio(), v[0]!.id, uf1, uf2, uf3],
  );
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
  conceptoId = (
    await admin.query<{ id: string }>(
      "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
      [barrio()],
    )
  ).rows[0]!.id;
  // Sin interés: los importes del escenario quedan redondos.
  for (const [clave, valor] of [
    ["interes.cobra", false], ["interes.tasa_compensatoria", "0.03"], ["interes.tasa_punitoria", "0"], ["interes.gracia_dias", 0],
    ["interes.forma_gracia", "corre_inicio"], ["interes.tolerancia", "0.00"], ["imputacion.orden", "intereses_primero_capital_antiguo"],
  ] as const) {
    await cargarParametro(admin, barrio(), clave, valor);
  }
});

afterEach(async () => {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of [
      "trabajo", "padron_evento", "bonificacion_excepcion", "saldo_uf", "concepto_boleta_unidad_uso", "concepto_boleta_unidad_evento",
      "concepto_boleta_unidad", "item_liquidacion", "liquidacion", "gasto_periodo", "periodo_expensa", "concepto_boleta_valor",
      "concepto_boleta", "grupo_unidades_miembro", "grupo_unidades", "limite_aplicacion_barrio",
    ]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("delete from parametro_valor where nodo_id = $1 and clave not like 'interes.%' and clave <> 'imputacion.orden'", [barrio()]);
    await c.query("commit");
  } finally {
    c.release();
  }
});

afterAll(async () => {
  await borrarParametrosDe(admin, [barrio()]);
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const b of [barrio(), arbol.barrioA2.id]) {
      for (const t of ["concepto", "coeficiente", "coeficiente_version", "unidad_funcional", "codigo_pago_secuencia", "barrio_atributo_vigencia", "barrio"]) {
        await c.query(`delete from ${t} where barrio_id = $1`, [b]);
      }
    }
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("grupos de unidades", () => {
  it("la administración arma un grupo eligiendo unidades, lo edita y lo borra si nadie lo usa", async () => {
    const { grupoId } = await grupo("Lotes baldíos", [uf1, uf3]);
    let grupos = await como(adminB(), (tx) => listarGruposDeUnidades(tx, { barrioId: barrio() }));
    expect(grupos).toEqual([{ id: grupoId, nombre: "Lotes baldíos", unidades: [{ id: uf1, etiqueta: "Mza 1 · Lote 1" }, { id: uf3, etiqueta: "Mza 1 · Lote 3" }], usadoPor: [] }]);

    // Editar manda la lista completa: sale la 1, entra la 2, y cambia el nombre.
    await como(adminB(), (tx) => editarGrupoDeUnidades(tx, { grupoId, nombre: "Baldíos", unidades: [uf2, uf3] }));
    grupos = await como(adminB(), (tx) => listarGruposDeUnidades(tx, { barrioId: barrio() }));
    expect(grupos[0]).toMatchObject({ nombre: "Baldíos", unidades: [{ id: uf2 }, { id: uf3 }] });

    // El nombre no se repite (ni con otras mayúsculas), y una unidad de otro barrio no entra.
    expect((await capturar(() => grupo("baldíos", [uf1]))).codigo).toBe("dato_invalido");
    expect((await capturar(() => grupo("Con una ajena", [uf1, ufDeOtroBarrio]))).codigo).toBe("dato_invalido");

    // Con un concepto que lo usa no se borra; sin él, sí.
    const { conceptoId: pasto } = await concepto({ nombre: "Corte de pasto", montoFijo: "150.00", destinatario: "grupo", grupoId, modoMes: "sola" });
    expect((await capturar(() => como(adminB(), (tx) => borrarGrupoDeUnidades(tx, { grupoId })))).message).toMatch(/lo usa el concepto «Corte de pasto»/);
    await como(adminB(), (tx) => editarConceptoBoleta(tx, { conceptoBoletaId: pasto, nombre: "Corte de pasto", activo: true, destinatario: "todas", grupoId: "", modoMes: "sola", unidadUso: "" }));
    await como(adminB(), (tx) => borrarGrupoDeUnidades(tx, { grupoId }));
    expect(await como(adminB(), (tx) => listarGruposDeUnidades(tx, { barrioId: barrio() }))).toEqual([]);
  });

  it("RLS y permisos: operador, contador y auditor los leen y no los cambian; un propietario y otra administración no ven nada", async () => {
    const { grupoId } = await grupo("Lotes baldíos", [uf1, uf3]);
    for (const u of [operador(), arbol.usuarios.contadorA1, arbol.usuarios.auditorA1]) {
      expect(await como(u, (tx) => listarGruposDeUnidades(tx, { barrioId: barrio() }))).toHaveLength(1);
      expect((await capturar(() => como(u, (tx) => crearGrupoDeUnidades(tx, { barrioId: barrio(), nombre: "Otro", unidades: [uf2] })))).codigo).toBe("sin_permiso");
      expect((await capturar(() => como(u, (tx) => editarGrupoDeUnidades(tx, { grupoId, nombre: "Otro", unidades: [] })))).codigo).toBe("sin_permiso");
      // Tampoco por SQL directo: las policies de las dos tablas.
      await expect(
        como(u, (tx) => tx.execute(sql`insert into grupo_unidades (barrio_id, nombre) values (${barrio()}, 'Colado')`)),
      ).rejects.toThrow(/row-level security/);
      await expect(
        como(u, (tx) => tx.execute(sql`insert into grupo_unidades_miembro (grupo_id, unidad_funcional_id, barrio_id) values (${grupoId}, ${uf2}, ${barrio()})`)),
      ).rejects.toThrow(/row-level security/);
      const borradas = await como(u, (tx) => tx.execute(sql`delete from grupo_unidades_miembro where grupo_id = ${grupoId}`));
      expect(borradas.rowCount).toBe(0);
    }
    for (const u of [arbol.usuarios.propietarioA1, arbol.usuarios.adminEstudioB]) {
      for (const tabla of ["grupo_unidades", "grupo_unidades_miembro"]) {
        const { rows } = await como(u, (tx) => tx.execute(sql`select count(*)::int as n from ${sql.identifier(tabla)}`));
        expect(rows[0]).toEqual({ n: 0 });
      }
    }
    // La FK compuesta: una unidad de otro barrio no entra ni escribiendo en la tabla.
    await expect(
      como(adminB(), (tx) => tx.execute(sql`insert into grupo_unidades_miembro (grupo_id, unidad_funcional_id, barrio_id) values (${grupoId}, ${ufDeOtroBarrio}, ${barrio()})`)),
    ).rejects.toThrow(/fk_grupo_miembro_uf|foreign key/);
    const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from grupo_unidades_miembro where grupo_id = $1", [grupoId]);
    expect(rows[0]!.n).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("lo que el catálogo aplica solo", () => {
  /** «Corte de pasto» a $ 150, solo, al grupo de las unidades 1 y 3. */
  async function pasto(): Promise<{ grupoId: string; pastoId: string }> {
    const { grupoId } = await grupo("Lotes baldíos", [uf1, uf3]);
    const { conceptoId: pastoId } = await concepto({ nombre: "Corte de pasto", montoFijo: "150.00", destinatario: "grupo", grupoId, modoMes: "sola" });
    return { grupoId, pastoId };
  }

  it("el grupo se expande al calcular: una aplicación por unidad del grupo, firmada por quien emite", async () => {
    await pasto();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    // Antes de calcular no hay aplicaciones, y la pestaña ya dice a quién va y cuánto.
    expect(await aplicacionesDe(enero)).toEqual([]);
    const antes = await como(adminB(), (tx) => conceptosDelMes(tx, { periodoId: enero }));
    expect(antes.conceptos).toEqual([
      expect.objectContaining({ nombre: "Corte de pasto", origen: "sola", aQuien: "Grupo: Lotes baldíos", unidades: 2, importe: "300.00" }),
    ]);
    expect(antes.conceptos[0]!.aplicaciones.map((a) => [a.aplicacionId, a.unidad, a.importe])).toEqual([[null, "Mza 1 · Lote 1", "150.00"], [null, "Mza 1 · Lote 3", "150.00"]]);

    await emitir(enero);
    expect((await vivas(enero)).map((a) => [a.uf, a.nombre, a.origen, a.importe, a.detalle, a.por]).sort()).toEqual(
      [
        [uf1, "Corte de pasto", "catalogo_sola", "150.00", "Grupo: Lotes baldíos", adminB()],
        [uf3, "Corte de pasto", "catalogo_sola", "150.00", "Grupo: Lotes baldíos", adminB()],
      ].sort(),
    );
    expect(await totalesDe(enero)).toEqual(["1150.00", "600.00", "550.00"]);
    const despues = await como(adminB(), (tx) => conceptosDelMes(tx, { periodoId: enero }));
    expect(despues).toMatchObject({ emitido: true, puedeCargar: false });
    expect(despues.conceptos[0]).toMatchObject({ origen: "sola", unidades: 2, importe: "300.00" });
    // En la boleta dice de dónde sale, sin una fecha de «hecho».
    const vistas = await como(adminB(), (tx) => armarVistasDelPeriodo(tx, enero, { registro }));
    expect(vistas[0]!.composicion.map((r) => [r.etiqueta, r.aclaracion])).toEqual([["Expensa ordinaria 01/2025", null], ["Corte de pasto", "Grupo: Lotes baldíos"]]);
  });

  it("sobrevive a volver a calcular el borrador, y sigue al grupo: quien sale lo pierde y quien entra lo recibe", async () => {
    const { grupoId } = await pasto();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await calcular(enero);
    const primeras = (await vivas(enero)).map((a) => a.uf).sort();
    expect(primeras).toEqual([uf1, uf3].sort());
    // Volver a calcular sin cambios: las mismas dos, sin duplicar ni anular.
    await calcular(enero);
    await calcular(enero);
    expect(await aplicacionesDe(enero)).toHaveLength(2);
    // Sale la 1 y entra la 2.
    await como(adminB(), (tx) => editarGrupoDeUnidades(tx, { grupoId, nombre: "Lotes baldíos", unidades: [uf2, uf3] }));
    await calcular(enero);
    expect((await vivas(enero)).map((a) => a.uf).sort()).toEqual([uf2, uf3].sort());
    const anuladas = (await aplicacionesDe(enero)).filter((a) => a.anulada);
    expect(anuladas.map((a) => a.uf)).toEqual([uf1]);
    await emitir(enero);
    expect(await totalesDe(enero)).toEqual(["1000.00", "750.00", "550.00"]);
  });

  it("un concepto que se aplica solo no se carga a mano; y si deja de aplicarse solo, lo que había se anula al calcular", async () => {
    const { pastoId } = await pasto();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    const aMano = await capturar(() =>
      como(adminB(), (tx) =>
        aplicarConceptoAUnidad(tx, { periodoId: enero, unidadFuncionalId: uf2, conceptoBoletaId: pastoId, fechaHecho: null, cantidad: null, detalle: "a mano", origenEvaluacion: "carga_manual", confirmarMontoInusual: true }),
      ),
    );
    expect(aMano.codigo).toBe("dato_invalido");
    expect(aMano.message).toMatch(/se aplica solo/);

    await calcular(enero);
    await como(adminB(), (tx) => editarConceptoBoleta(tx, { conceptoBoletaId: pastoId, nombre: "Corte de pasto", activo: true, destinatario: "una_unidad", grupoId: "", modoMes: "mano", unidadUso: "" }));
    await calcular(enero);
    expect(await vivas(enero)).toEqual([]);
    expect(await totalesDe(enero)).toEqual(["1000.00", "600.00", "400.00"]);
  });

  it("a todas las unidades, y la emisión no acepta una aplicación «sola» que el catálogo no aplica solo", async () => {
    const { conceptoId: seguridad } = await concepto({ nombre: "Refuerzo de seguridad", montoFijo: "50.00", destinatario: "todas", modoMes: "sola" });
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await calcular(enero);
    expect((await vivas(enero)).map((a) => [a.origen, a.importe, a.detalle])).toEqual(Array(3).fill(["catalogo_sola", "50.00", "Todas las unidades"]));
    // Alguien le cambia el modo por fuera, sin recalcular: `app.validar_emision` lo ve.
    await admin.query("update concepto_boleta set modo_mes = 'mano', destinatario = 'una_unidad' where id = $1", [seguridad]);
    const e = await capturar(() => como(adminB(), (tx) => emitirPeriodo(tx, { periodoId: enero })));
    expect(e.codigo).toBe("borrador_desactualizado");
    expect(e.message).toBe("Un concepto que se aplicaba solo cambió después de calcular el mes.");
  });

  it("emite quien hoy puede emitir: un operador, con su tope de cargos", async () => {
    await pasto();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    const sinTope = await capturar(() => emitir(enero, operador()));
    expect(sinTope.codigo).toBe("tope_operador");
    expect(sinTope.message).toMatch(/«Corte de pasto», que se aplica solo, supera lo que un operador puede aplicar/);
    await admin.query(
      "insert into limite_aplicacion_barrio (barrio_id, monto_max_operador, porcentaje_max_operador, monto_max_cargo_operador, vigente_desde) values ($1, 0, 0, 200, '2000-01-01')",
      [barrio()],
    );
    await emitir(enero, operador());
    expect(new Set((await vivas(enero)).map((a) => a.por))).toEqual(new Set([operador()]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("la planilla de usos", () => {
  it("la vista previa agrupa por unidad y concepto, sin escribir nada", async () => {
    await conceptosPorUso();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    const vista = await como(adminB(), (tx) =>
      vistaPreviaDePlanillaDeUsos(
        tx,
        planilla(enero, "reservas-diciembre.xlsx", [
          ["1", "1", "Cancha de pádel", "03/12/2024", "1"],
          ["1", "1", "cancha de padel", "17/12/2024", "1"], // sin acento ni mayúsculas: el mismo concepto
          ["1", "2", "Uso del club house", "2024-12-08", "1"],
        ]),
      ),
    );
    expect(vista.errores).toEqual([]);
    expect(vista.renglones.map((r) => [r.unidad, r.concepto, r.cantidad, r.cantidadTotal, r.precioUnitario, r.importe, r.usos.length])).toEqual([
      ["Mza 1 · Lote 1", "Cancha de pádel", "2", "2", "120.00", "240.00", 2],
      ["Mza 1 · Lote 2", "Uso del club house", "1", "1", "450.00", "450.00", 1],
    ]);
    expect(vista.total).toBe("690.00");
    expect(await aplicacionesDe(enero)).toEqual([]);
  });

  it("los errores van por fila, todos juntos: unidad inexistente, fecha imposible, concepto que no es por uso", async () => {
    await conceptosPorUso();
    await concepto({ nombre: "Corte de pasto", montoFijo: "150.00" });
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    const mala = planilla(enero, "con-errores.xlsx", [
      ["1", "1", "Cancha de pádel", "03/12/2024", "1"], // fila 2: bien
      ["9", "9", "Cancha de pádel", "03/12/2024", "1"], // fila 3: la unidad no existe
      ["1", "2", "Cancha de pádel", "31/02/2025", "1"], // fila 4: la fecha no existe
      ["1", "2", "Corte de pasto", "03/12/2024", "1"], // fila 5: no se cobra por uso
      ["1", "2", "Sauna", "03/12/2024", "1"], // fila 6: no está en el catálogo
      ["1", "3", "Cancha de pádel", "03/12/2024", "0"], // fila 7: cantidad en cero
      ["", "", "", "", ""], // vacía: no cuenta
      ["1", "3", "Uso del club house", "", "1"], // fila 9: sin fecha
    ]);
    const vista = await como(adminB(), (tx) => vistaPreviaDePlanillaDeUsos(tx, mala));
    expect(vista.errores).toEqual([
      { fila: 3, mensaje: "La unidad Mza 9 · Lote 9 no existe en el barrio o está dada de baja." },
      { fila: 4, mensaje: "La fecha «31/02/2025» no existe o no se entiende: escribila como dd/mm/aaaa." },
      { fila: 5, mensaje: "El concepto «Corte de pasto» no se cobra por uso: no entra por planilla." },
      { fila: 6, mensaje: "El concepto «Sauna» no está en los conceptos del barrio." },
      { fila: 7, mensaje: "La cantidad tiene que ser un número mayor que cero (hasta tres decimales)." },
      { fila: 9, mensaje: "La fecha «» no existe o no se entiende: escribila como dd/mm/aaaa." },
    ]);
    // Con un solo error no se carga nada: entera o nada.
    const e = await capturar(() => como(adminB(), (tx) => aplicarPlanillaDeUsos(tx, mala)));
    expect(e.codigo).toBe("dato_invalido");
    expect(e.message).toBe("La planilla tiene 6 errores: no se cargó nada.");
    expect(await aplicacionesDe(enero)).toEqual([]);
    // Sin las columnas, ni empieza.
    const sinColumnas = await como(adminB(), (tx) => vistaPreviaDePlanillaDeUsos(tx, { periodoId: enero, archivo: "otra.csv", filas: [["unidad", "importe"], ["1", "2"]] }));
    expect(sinColumnas.errores[0]!.mensaje).toMatch(/necesita las columnas manzana, lote, concepto, fecha y cantidad/);
  });

  it("se aplica: un renglón por unidad y concepto con la cantidad sumada, cada uso en su tabla, y el detalle en la boleta", async () => {
    await conceptosPorUso();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    const aplicada = await como(adminB(), (tx) =>
      aplicarPlanillaDeUsos(
        tx,
        planilla(enero, "reservas-diciembre.xlsx", [
          ["1", "1", "Cancha de pádel", "17/12/2024", "1"],
          ["1", "1", "Cancha de pádel", "03/12/2024", "1"],
          ["1", "2", "Uso del club house", "08/12/2024", "1"],
        ]),
      ),
    );
    expect(aplicada).toEqual({ renglones: 2, usos: 3, total: "690.00" });
    expect((await vivas(enero)).map((a) => [a.uf, a.nombre, a.origen, a.cantidad, a.por]).sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([
      [uf1, "Cancha de pádel", "planilla", "2", adminB()],
      [uf2, "Uso del club house", "planilla", "1", adminB()],
    ]);
    const { rows: usos } = await admin.query(
      `select c.unidad_funcional_id as uf, u.fecha::text, trim_scale(u.cantidad)::text as cantidad, u.archivo, u.fila, u.creado_por
         from concepto_boleta_unidad_uso u join concepto_boleta_unidad c on c.id = u.aplicacion_id
        where c.periodo_id = $1 order by u.fecha`,
      [enero],
    );
    expect(usos).toEqual([
      { uf: uf1, fecha: "2024-12-03", cantidad: "1", archivo: "reservas-diciembre.xlsx", fila: 3, creado_por: adminB() },
      { uf: uf2, fecha: "2024-12-08", cantidad: "1", archivo: "reservas-diciembre.xlsx", fila: 4, creado_por: adminB() },
      { uf: uf1, fecha: "2024-12-17", cantidad: "1", archivo: "reservas-diciembre.xlsx", fila: 2, creado_por: adminB() },
    ]);

    // La pestaña: el archivo y cuántos usos.
    const mes = await como(adminB(), (tx) => conceptosDelMes(tx, { periodoId: enero }));
    expect(mes.conceptos.map((c) => [c.nombre, c.origen, c.aQuien, c.unidades, c.importe, c.deDonde])).toEqual([
      ["Cancha de pádel", "planilla", "Quien lo usó", 1, "240.00", "reservas-diciembre.xlsx · 2 turnos"],
      ["Uso del club house", "planilla", "Quien lo usó", 1, "450.00", "reservas-diciembre.xlsx · 1 jornada"],
    ]);

    await emitir(enero);
    expect(await totalesDe(enero)).toEqual(["1240.00", "1050.00", "400.00"]);
    const vistas = await como(adminB(), (tx) => armarVistasDelPeriodo(tx, enero, { registro }));
    expect(vistas[0]!.composicion.map((r) => [r.etiqueta, r.importe.monto, r.aclaracion])).toEqual([
      ["Expensa ordinaria 01/2025", "1000.00", null],
      ["Cancha de pádel", "240.00", "03/12, 17/12 · 2 turnos"],
    ]);
    expect(vistas[1]!.composicion[1]).toMatchObject({ etiqueta: "Uso del club house", aclaracion: "08/12 · 1 jornada" });
  });

  it("una segunda planilla del mes suma: el renglón anterior se anula y el nuevo lleva todos los usos; la misma planilla dos veces no entra", async () => {
    await conceptosPorUso();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await como(adminB(), (tx) => aplicarPlanillaDeUsos(tx, planilla(enero, "primera-quincena.xlsx", [["1", "1", "Cancha de pádel", "03/12/2024", "1"]])));
    const repetida = await como(adminB(), (tx) => vistaPreviaDePlanillaDeUsos(tx, planilla(enero, "PRIMERA-QUINCENA.xlsx", [["1", "1", "Cancha de pádel", "03/12/2024", "1"]])));
    expect(repetida.errores[0]).toEqual({ fila: 1, mensaje: "La planilla «PRIMERA-QUINCENA.xlsx» ya se aplicó en este mes. Si es otra, cambiale el nombre al archivo." });

    const segunda = await como(adminB(), (tx) => vistaPreviaDePlanillaDeUsos(tx, planilla(enero, "segunda-quincena.xlsx", [["1", "1", "Cancha de pádel", "20/12/2024", "2"]])));
    expect(segunda.renglones[0]).toMatchObject({ cantidad: "2", cantidadAnterior: "1", cantidadTotal: "3", importe: "360.00" });
    await como(adminB(), (tx) => aplicarPlanillaDeUsos(tx, planilla(enero, "segunda-quincena.xlsx", [["1", "1", "Cancha de pádel", "20/12/2024", "2"]])));
    const todas = await aplicacionesDe(enero);
    expect(todas.map((a) => [a.cantidad, a.anulada])).toEqual([["1", true], ["3", false]]);
    const { rows } = await admin.query<{ n: number; suma: string }>(
      `select count(*)::int as n, trim_scale(sum(u.cantidad))::text as suma from concepto_boleta_unidad_uso u
         join concepto_boleta_unidad c on c.id = u.aplicacion_id where c.periodo_id = $1 and c.anulado_at is null`,
      [enero],
    );
    expect(rows[0]).toEqual({ n: 2, suma: "3" });
    await emitir(enero);
    expect((await totalesDe(enero))[0]).toBe("1360.00");
  });

  it("la emisión verifica la suma de los usos contra la cantidad del renglón; y los usos solo se agregan", async () => {
    await conceptosPorUso();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await como(adminB(), (tx) => aplicarPlanillaDeUsos(tx, planilla(enero, "reservas.xlsx", [["1", "1", "Cancha de pádel", "03/12/2024", "2"]])));
    const { rows: ap } = await admin.query<{ id: string }>("select id from concepto_boleta_unidad where periodo_id = $1", [enero]);
    // Un uso de más, metido por fuera de la planilla: el renglón dice 2 y sus usos suman 3.
    await como(adminB(), (tx) =>
      tx.execute(sql`
        insert into concepto_boleta_unidad_uso (barrio_id, aplicacion_id, fecha, cantidad, archivo)
        values (${barrio()}, ${ap[0]!.id}, '2024-12-10', 1, 'colado.xlsx')
      `),
    );
    await calcular(enero);
    const e = await capturar(() => como(adminB(), (tx) => emitirPeriodo(tx, { periodoId: enero })));
    expect(e.codigo).toBe("borrador_desactualizado");
    expect(e.message).toBe("Hay usos de planilla que no coinciden con lo cargado en la boleta.");
    // No se editan ni se borran, ni siquiera el dueño de la base.
    await expect(admin.query("update concepto_boleta_unidad_uso set cantidad = 5 where aplicacion_id = $1", [ap[0]!.id])).rejects.toThrow(/append-only/);
    await expect(admin.query("delete from concepto_boleta_unidad_uso where aplicacion_id = $1", [ap[0]!.id])).rejects.toThrow(/append-only/);
    // Y un uso no cuelga de una aplicación que no vino de una planilla.
    const { conceptoId: otro } = await concepto({ nombre: "Reposición de llave", montoFijo: "80.00" });
    const manual = await como(adminB(), (tx) =>
      aplicarConceptoAUnidad(tx, { periodoId: enero, unidadFuncionalId: uf2, conceptoBoletaId: otro, fechaHecho: null, cantidad: null, detalle: "llave", origenEvaluacion: "carga_manual", confirmarMontoInusual: true }),
    );
    await expect(
      como(adminB(), (tx) =>
        tx.execute(sql`insert into concepto_boleta_unidad_uso (barrio_id, aplicacion_id, fecha, cantidad, archivo) values (${barrio()}, ${manual.id}, '2024-12-10', 1, 'x.xlsx')`),
      ),
    ).rejects.toThrow(/vino de una planilla/);
  });

  it("emitido, no se cargan más usos; y el tope de 100 usos por unidad y concepto se avisa en la vista previa", async () => {
    await conceptosPorUso();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    const demasiados = await como(adminB(), (tx) => vistaPreviaDePlanillaDeUsos(tx, planilla(enero, "muchos.xlsx", [["1", "1", "Cancha de pádel", "03/12/2024", "60"], ["1", "1", "Cancha de pádel", "04/12/2024", "41"]])));
    expect(demasiados.errores[0]!.mensaje).toBe("Mza 1 · Lote 1 suma 101 turnos de «Cancha de pádel» en el mes: el máximo por unidad es 100.");
    await como(adminB(), (tx) => aplicarPlanillaDeUsos(tx, planilla(enero, "reservas.xlsx", [["1", "1", "Cancha de pádel", "03/12/2024", "1"]])));
    await emitir(enero);
    const e = await capturar(() => como(adminB(), (tx) => aplicarPlanillaDeUsos(tx, planilla(enero, "tarde.xlsx", [["1", "2", "Cancha de pádel", "03/12/2024", "1"]]))));
    expect(e.codigo).toBe("periodo_no_editable");
    const { rows: ap } = await admin.query<{ id: string }>("select id from concepto_boleta_unidad where periodo_id = $1", [enero]);
    await expect(
      como(adminB(), (tx) =>
        tx.execute(sql`insert into concepto_boleta_unidad_uso (barrio_id, aplicacion_id, fecha, cantidad, archivo) values (${barrio()}, ${ap[0]!.id}, '2024-12-10', 1, 'x.xlsx')`),
      ),
    ).rejects.toThrow(/ya está emitida/);
  });

  it("pasa por la confirmación de monto inusual y por los topes del operador; contador y auditor no la suben", async () => {
    await conceptosPorUso();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    const filas = [["1", "1", "Cancha de pádel", "03/12/2024", "1"]];
    // La unidad todavía no tiene ninguna boleta contra la cual comparar: la base pide confirmar.
    const sinConfirmar = await capturar(() => como(adminB(), (tx) => aplicarPlanillaDeUsos(tx, planilla(enero, "a.xlsx", filas, { confirmarMontoInusual: false }))));
    expect(sinConfirmar.codigo).toBe("cargo_requiere_confirmacion");
    expect(await aplicacionesDe(enero)).toEqual([]);
    // Un operador sin tope de cargos no carga usos, confirme o no.
    const sinTope = await capturar(() => como(operador(), (tx) => aplicarPlanillaDeUsos(tx, planilla(enero, "a.xlsx", filas))));
    expect(sinTope.codigo).toBe("sin_limite_de_aplicacion");
    await admin.query(
      "insert into limite_aplicacion_barrio (barrio_id, monto_max_operador, porcentaje_max_operador, monto_max_cargo_operador, vigente_desde) values ($1, 0, 0, 200, '2000-01-01')",
      [barrio()],
    );
    await como(operador(), (tx) => aplicarPlanillaDeUsos(tx, planilla(enero, "a.xlsx", filas)));
    const supera = await capturar(() => como(operador(), (tx) => aplicarPlanillaDeUsos(tx, planilla(enero, "b.xlsx", [["1", "1", "Cancha de pádel", "04/12/2024", "1"]]))));
    expect(supera.codigo).toBe("tope_operador"); // $ 240 contra un tope de $ 200
    for (const u of [arbol.usuarios.contadorA1, arbol.usuarios.auditorA1]) {
      expect((await capturar(() => como(u, (tx) => aplicarPlanillaDeUsos(tx, planilla(enero, "c.xlsx", filas))))).codigo).toBe("sin_permiso");
      expect((await capturar(() => como(u, (tx) => vistaPreviaDePlanillaDeUsos(tx, planilla(enero, "c.xlsx", filas))))).codigo).toBe("sin_permiso");
    }
    // Un propietario y otra administración no leen los usos.
    for (const u of [arbol.usuarios.propietarioA1, arbol.usuarios.adminEstudioB]) {
      const { rows } = await como(u, (tx) => tx.execute(sql`select count(*)::int as n from concepto_boleta_unidad_uso`));
      expect(rows[0]).toEqual({ n: 0 });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("el importe a cargar cada vez", () => {
  const multa = () => concepto({ nombre: "Multa", metodo: "importe_libre", destinatario: "una_unidad", modoMes: "mano" });
  const aplicar = (usuario: string, periodoId: string, conceptoBoletaId: string, unidad: string, importe: string | null) =>
    como(usuario, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId, unidadFuncionalId: unidad, conceptoBoletaId, fechaHecho: "2025-01-14", cantidad: null, importe,
        detalle: "Perro suelto, acta del 14/01", origenEvaluacion: "carga_manual", confirmarMontoInusual: true,
      }),
    );

  it("la multa se carga con su importe, se emite y la boleta la dice", async () => {
    const { conceptoId: multaId } = await multa();
    const catalogo = await como(adminB(), (tx) => listarConceptosBoleta(tx, { barrioId: barrio() }));
    expect(catalogo[0]).toMatchObject({ nombre: "Multa", metodo: "importe_libre", destinatario: "una_unidad", modoMes: "mano", valorVigente: { montoFijo: null, porcentaje: null, precioUnitario: null } });
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    expect((await capturar(() => aplicar(adminB(), enero, multaId, uf2, null))).codigo).toBe("dato_invalido");
    expect((await capturar(() => aplicar(adminB(), enero, multaId, uf2, "0.00"))).codigo).toBe("dato_invalido");
    const aplicada = await aplicar(adminB(), enero, multaId, uf2, "300.00");
    expect(aplicada.importeEstimado).toBe("300.00");
    // La pestaña: a mano, con quién y cuándo.
    const mes = await como(adminB(), (tx) => conceptosDelMes(tx, { periodoId: enero }));
    expect(mes.conceptos[0]).toMatchObject({ nombre: "Multa", origen: "mano", aQuien: "Una unidad", unidades: 1, importe: "300.00" });
    await emitir(enero);
    expect(await totalesDe(enero)).toEqual(["1000.00", "900.00", "400.00"]);
    const vistas = await como(adminB(), (tx) => armarVistasDelPeriodo(tx, enero, { registro }));
    expect(vistas[1]!.composicion[1]).toMatchObject({ etiqueta: "Multa", importe: { monto: "300.00" }, aclaracion: "Perro suelto, acta del 14/01 · 2025-01-14" });
  });

  it("en cualquier otro método, el importe que mande el pedido se descarta: manda el catálogo", async () => {
    const { conceptoId: llave } = await concepto({ nombre: "Reposición de llave", montoFijo: "80.00" });
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await aplicar(adminB(), enero, llave, uf1, "99999.00");
    await emitir(enero);
    expect((await totalesDe(enero))[0]).toBe("1080.00");
  });

  it("el operador tiene su propio límite para importes a mano, acumulado por unidad y por mes, y falla cerrado", async () => {
    const { conceptoId: multaId } = await multa();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    // Sin ningún límite cargado, no carga importes a mano.
    expect((await capturar(() => aplicar(operador(), enero, multaId, uf2, "300.00"))).codigo).toBe("sin_limite_de_aplicacion");
    // Con tope de cargos pero sin el límite propio, tampoco: son dos permisos distintos.
    await admin.query(
      "insert into limite_aplicacion_barrio (barrio_id, monto_max_operador, porcentaje_max_operador, monto_max_cargo_operador, vigente_desde) values ($1, 0, 0, 100000, '2000-01-01')",
      [barrio()],
    );
    const sinPropio = await capturar(() => aplicar(operador(), enero, multaId, uf2, "300.00"));
    expect(sinPropio.codigo).toBe("sin_limite_de_aplicacion");
    expect(sinPropio.message).toMatch(/hasta qué importe puede cargar a mano un operador/);
    await admin.query("update limite_aplicacion_barrio set monto_max_importe_libre_operador = 500 where barrio_id = $1", [barrio()]);
    await aplicar(operador(), enero, multaId, uf2, "300.00");
    // La segunda a la misma unidad en el mes suma $ 600: supera el límite aunque sola no lo haga.
    const acumulada = await capturar(() => aplicar(operador(), enero, multaId, uf2, "300.00"));
    expect(acumulada.codigo).toBe("tope_operador");
    expect(acumulada.message).toBe("Ese importe, con lo ya cargado a la unidad en el mes, suma $ 600.00 y tu límite para importes a mano es $ 500.00.");
    // A otra unidad sí, y un administrador no tiene ese límite.
    await aplicar(operador(), enero, multaId, uf3, "500.00");
    await aplicar(adminB(), enero, multaId, uf2, "5000.00");
    await emitir(enero);
    expect(await totalesDe(enero)).toEqual(["1000.00", "5900.00", "900.00"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("el orden de cálculo y los permisos del catálogo", () => {
  it("orden fijo: la expensa, la bonificación por pago en término, y después el resto", async () => {
    // Bonificación sola del 10 % (encargo 16), un concepto que se aplica solo, usos por planilla y una multa.
    for (const [clave, valor] of Object.entries({
      "devengado.origen": "gastos", "devengado.reparto": "coeficiente", "cupon.cobra": "solo_mes",
      "bonificacion.modo": "sola", "bonificacion.forma": "porcentaje", "bonificacion.valor": "10", "bonificacion.tope": "500.00",
    })) {
      await cargarParametro(admin, barrio(), clave, valor);
    }
    const { rows: bonif } = await admin.query<{ id: string }>(
      `insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo, clasificacion_fiscal, financiamiento, regla_barrio)
       values ($1, 'Bonificación por pago en término', 'descuento', 'porcentaje', 'expensa_ordinaria', 'sin_clasificar', 'absorbe_barrio', 'bonificacion_pago_en_termino')
       returning id`,
      [barrio()],
    );
    await admin.query(
      "insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, porcentaje, tope, vigente_desde) values ($1, $2, 'porcentaje', 10, 500, '2000-01-01')",
      [barrio(), bonif[0]!.id],
    );
    await concepto({ nombre: "Tasa de seguridad", montoFijo: "50.00", destinatario: "todas", modoMes: "sola" });
    await conceptosPorUso();
    const { conceptoId: multaId } = await concepto({ nombre: "Aviso de multa", metodo: "importe_libre" });
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await como(adminB(), (tx) => aplicarPlanillaDeUsos(tx, planilla(enero, "reservas.xlsx", [["1", "1", "Cancha de pádel", "03/12/2024", "1"]])));
    await como(adminB(), (tx) =>
      aplicarConceptoAUnidad(tx, { periodoId: enero, unidadFuncionalId: uf1, conceptoBoletaId: multaId, fechaHecho: "2025-01-14", cantidad: null, importe: "30.00", detalle: "acta", origenEvaluacion: "carga_manual", confirmarMontoInusual: true }),
    );
    // La pestaña del mes, antes de emitir, ya los ordena igual.
    const mes = await como(adminB(), (tx) => conceptosDelMes(tx, { periodoId: enero }));
    expect(mes.conceptos.map((c) => [c.nombre, c.origen])).toEqual([
      ["Bonificación por pago en término", "bonificacion"],
      ["Tasa de seguridad", "sola"],
      ["Cancha de pádel", "planilla"],
      ["Aviso de multa", "mano"],
    ]);
    await emitir(enero);
    const vistas = await como(adminB(), (tx) => armarVistasDelPeriodo(tx, enero, { registro }));
    expect(vistas[0]!.composicion.map((r) => [r.etiqueta, r.importe.monto])).toEqual([
      ["Expensa ordinaria 01/2025", "1000.00"],
      ["Bonificación por pago en término", "-100.00"], // 10 % de la expensa común, no del resto
      ["Aviso de multa", "30.00"],
      ["Cancha de pádel", "120.00"],
      ["Tasa de seguridad", "50.00"],
    ]);
    expect((await totalesDe(enero))[0]).toBe("1100.00");
  });

  it("el catálogo lo define la administración: el operador aplica, pero no crea ni edita conceptos", async () => {
    const { conceptoId: llave } = await concepto({ nombre: "Reposición de llave", montoFijo: "80.00" });
    for (const u of [operador(), arbol.usuarios.contadorA1, arbol.usuarios.auditorA1]) {
      const crear = await capturar(() =>
        como(u, (tx) =>
          crearConceptoBoleta(tx, {
            barrioId: barrio(), nombre: "Colado", clase: "cargo", metodo: "monto_fijo", baseCalculo: "sin_base", clasificacionFiscal: "sin_clasificar",
            financiamiento: null, requiereAdmin: false, ordenImpresion: 0, vigenteDesde: "2000-01-01", montoFijo: "1.00", porcentaje: null, precioUnitario: null, tope: null,
          }),
        ),
      );
      expect(crear.codigo).toBe("sin_permiso");
      const editar = await capturar(() =>
        como(u, (tx) => editarConceptoBoleta(tx, { conceptoBoletaId: llave, nombre: "Otro nombre", activo: true, destinatario: "todas", grupoId: "", modoMes: "sola", unidadUso: "" })),
      );
      expect(editar.codigo).toBe("sin_permiso");
    }
    const { rows } = await admin.query<{ nombre: string; modo_mes: string | null }>("select nombre, modo_mes from concepto_boleta where barrio_id = $1", [barrio()]);
    expect(rows).toEqual([{ nombre: "Reposición de llave", modo_mes: "mano" }]);
  });

  it("las reglas de «a quién va y cómo entra» las hace cumplir el esquema y también la base", async () => {
    // Sola con un importe que depende de usos, o por planilla sin ser por uso: no pasa el esquema.
    await expect(concepto({ nombre: "Mal 1", metodo: "precio_x_cantidad", precioUnitario: "10.00", destinatario: "todas", modoMes: "sola" })).rejects.toThrow(/aplicarse solo/);
    await expect(concepto({ nombre: "Mal 2", montoFijo: "10.00", modoMes: "planilla_o_mano" })).rejects.toThrow(/Por planilla entra solo lo que se cobra por uso/);
    await expect(concepto({ nombre: "Mal 3", montoFijo: "10.00", destinatario: "grupo", modoMes: "sola" })).rejects.toThrow(/Elegí el grupo/);
    await expect(concepto({ nombre: "Mal 4", clase: "descuento", metodo: "importe_libre", financiamiento: "absorbe_barrio" })).rejects.toThrow(/es de un cargo/);
    // Y por SQL, los checks de `0083`.
    const insertar = (extra: string) =>
      admin.query(
        `insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo, clasificacion_fiscal, ${extra.split("=")[0]!.trim()})
         values ($1, 'Por SQL', 'cargo', 'precio_x_cantidad', 'sin_base', 'sin_clasificar', ${extra.split("=")[1]!.trim()})`,
        [barrio()],
      );
    await expect(insertar("modo_mes = 'sola'")).rejects.toThrow(/concepto_boleta_sola_chk/);
    await expect(insertar("destinatario = 'grupo'")).rejects.toThrow(/concepto_boleta_grupo_chk/);
    await expect(insertar("destinatario = 'cualquiera'")).rejects.toThrow(/concepto_boleta_destinatario_chk/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("los casos de las revisiones", () => {
  const hace = async (dias: number) =>
    (await admin.query<{ f: string }>("select ((now() at time zone 'America/Argentina/Buenos_Aires')::date - $1::int)::text as f", [dias])).rows[0]!.f;
  const dma = (iso: string) => iso.split("-").reverse().join("/");
  /** Un mes cuyo número es el de hoy, para que las fechas de los usos caigan en la ventana. */
  const mesDeHoy = async () => (await hace(0)).slice(0, 7);

  it("una fecha posterior a hoy o demasiado vieja no entra: la fecha de un uso fija el precio", async () => {
    await conceptosPorUso();
    const mes = await mesDeHoy();
    const periodo = await crearPeriodo(mes, `${mes}-28`);
    const manana = await hace(-1);
    const ayer = await hace(1);
    const vista = await como(adminB(), (tx) =>
      vistaPreviaDePlanillaDeUsos(tx, {
        periodoId: periodo, archivo: "fechas.xlsx",
        filas: [ENCABEZADO, ["1", "1", "Cancha de pádel", dma(manana), "1"], ["1", "1", "Cancha de pádel", "03/11/2062", "1"], ["1", "1", "Cancha de pádel", "03/01/2020", "1"], ["1", "1", "Cancha de pádel", dma(ayer), "1"]],
      }),
    );
    expect(vista.errores.map((e) => e.fila)).toEqual([2, 3, 4]);
    expect(vista.errores[0]!.mensaje).toMatch(/es posterior a hoy/);
    expect(vista.errores[2]!.mensaje).toMatch(/es demasiado vieja para este mes/);
    expect(vista.renglones).toHaveLength(1);
  });

  it("el precio que muestra la vista previa es el que se graba, también cuando el precio cambió entre dos planillas", async () => {
    const mes = await mesDeHoy();
    const { conceptoId: padel } = await concepto({ nombre: "Cancha de pádel", metodo: "precio_x_cantidad", precioUnitario: "100.00", destinatario: "por_uso", modoMes: "planilla_o_mano", unidadUso: "turno", vigenteDesde: "2000-01-01" });
    // El precio sube a $ 120 desde hace 5 días.
    await admin.query(
      "insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, precio_unitario, vigente_desde) values ($1, $2, 'precio_x_cantidad', 120, $3)",
      [barrio(), padel, await hace(5)],
    );
    const periodo = await crearPeriodo(mes, `${mes}-28`);
    const subir = (archivo: string, fecha: string) => ({ periodoId: periodo, archivo, filas: [ENCABEZADO, ["1", "1", "Cancha de pádel", dma(fecha), "1"]], confirmarMontoInusual: true });
    // La primera planilla trae un uso de hace 2 días (precio nuevo); la segunda, uno de hace 10 (precio viejo).
    const [hace2, hace10] = [await hace(2), await hace(10)];
    await como(adminB(), (tx) => aplicarPlanillaDeUsos(tx, subir("a.xlsx", hace2)));
    const vista = await como(adminB(), (tx) => vistaPreviaDePlanillaDeUsos(tx, subir("b.xlsx", hace10)));
    // El renglón queda con 2 usos al precio del ÚLTIMO uso del mes: $ 120, no $ 100.
    expect(vista.renglones[0]).toMatchObject({ cantidadTotal: "2", precioUnitario: "120.00", importe: "240.00" });
    const aplicada = await como(adminB(), (tx) => aplicarPlanillaDeUsos(tx, subir("b.xlsx", hace10)));
    expect(aplicada.total).toBe("240.00");
    await calcular(periodo);
    expect((await vivas(periodo)).map((a) => [a.cantidad, a.importe])).toEqual([["2", "240.00"]]);
  });

  it("el mismo uso no entra dos veces aunque la planilla cambie de nombre; y dos renglones vivos de planilla no existen", async () => {
    await conceptosPorUso();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    const fila = ["1", "1", "Cancha de pádel", "03/12/2024", "1"];
    await como(adminB(), (tx) => aplicarPlanillaDeUsos(tx, planilla(enero, "reservas.xlsx", [fila])));
    const renombrada = await como(adminB(), (tx) => vistaPreviaDePlanillaDeUsos(tx, planilla(enero, "reservas-corregida.xlsx", [fila, ["1", "1", "Cancha de pádel", "04/12/2024", "0,5"], ["1", "1", "Cancha de pádel", "05/12/2024", "0,25"]])));
    expect(renombrada.errores).toEqual([{ fila: 2, mensaje: "Mza 1 · Lote 1 ya tiene cargado ese uso de «Cancha de pádel» del 03/12/2024 en este mes." }]);
    // Las cantidades con decimales suman exacto: 1 + 0,5 + 0,25.
    expect(renombrada.renglones[0]).toMatchObject({ cantidad: "0.75", cantidadTotal: "1.75", importe: "210.00" });
    // El candado de la base: un segundo renglón vivo de planilla para la misma unidad y concepto no entra.
    const { rows: ap } = await admin.query<{ concepto: string }>("select concepto_boleta_id as concepto from concepto_boleta_unidad where periodo_id = $1", [enero]);
    await expect(
      como(adminB(), (tx) =>
        tx.execute(sql`
          insert into concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id, fecha_hecho, cantidad, detalle, origen_evaluacion, confirmacion_monto_inusual)
          values (${enero}, ${uf1}, ${ap[0]!.concepto}, '2024-12-03', 1, 'duplicada', 'planilla', true)
        `),
      ),
    ).rejects.toThrow(/uq_cbu_automatico_unico|ya existe|duplicate/i);
  });

  it("dos conceptos que solo difieren en un acento: la planilla no elige, lo dice", async () => {
    await conceptosPorUso();
    await concepto({ nombre: "Cancha de padel", metodo: "precio_x_cantidad", precioUnitario: "90.00", destinatario: "por_uso", modoMes: "planilla_o_mano" });
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    const vista = await como(adminB(), (tx) => vistaPreviaDePlanillaDeUsos(tx, planilla(enero, "a.xlsx", [["1", "1", "Cancha de pádel", "03/12/2024", "1"]])));
    expect(vista.errores[0]!.mensaje).toMatch(/Hay más de un concepto del barrio que se llama «Cancha de pádel»/);
    expect(vista.renglones).toEqual([]);
  });

  it("un descuento que se aplica solo, por porcentaje: convive con la bonificación, sobrevive a recalcular y uno fijo mayor que la expensa se avisa con la unidad", async () => {
    await concepto({ nombre: "Descuento por adhesión al débito", clase: "descuento", metodo: "porcentaje", baseCalculo: "expensa_ordinaria", financiamiento: "absorbe_barrio", porcentaje: "5", tope: "500.00", destinatario: "todas", modoMes: "sola" });
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await calcular(enero);
    await calcular(enero);
    expect((await vivas(enero)).map((a) => [a.origen, a.importe]).sort()).toEqual([["catalogo_sola", "20.00"], ["catalogo_sola", "30.00"], ["catalogo_sola", "50.00"]]);
    expect(await aplicacionesDe(enero)).toHaveLength(3);
    expect(await totalesDe(enero)).toEqual(["950.00", "570.00", "380.00"]);
    // Uno de importe fijo de $ 450: la unidad 3 paga $ 400 de expensa.
    await concepto({ nombre: "Descuento por obra", clase: "descuento", financiamiento: "absorbe_barrio", montoFijo: "450.00", destinatario: "todas", modoMes: "sola" });
    const e = await capturar(() => calcular(enero));
    expect(e.codigo).toBe("periodo_incompleto");
    expect(e.message).toBe("El descuento «Descuento por obra» es mayor que la expensa de una unidad (Mza 1 · Lote 3).");
  });

  it("un concepto que se aplica solo, cargado a mitad de mes, vale para ese mes; y si no tiene valor, se dice antes de escribir nada", async () => {
    await concepto({ nombre: "Refuerzo de seguridad", montoFijo: "50.00", destinatario: "todas", modoMes: "sola", vigenteDesde: "2025-01-14" });
    const diciembre = await crearPeriodo("2024-12", "2024-12-10");
    const sinValor = await capturar(() => calcular(diciembre));
    expect(sinValor.message).toBe("El concepto «Refuerzo de seguridad» se aplica solo y no tiene un valor que rija este mes.");
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await calcular(enero);
    const { rows } = await admin.query<{ fecha: string; importe: string }>(
      "select distinct fecha_hecho::text as fecha, importe_resuelto::text as importe from concepto_boleta_unidad where periodo_id = $1",
      [enero],
    );
    expect(rows).toEqual([{ fecha: "2025-01-14", importe: "50.00" }]);
  });

  it("un cambio de valor entre dos cálculos reemplaza la aplicación; un concepto desactivado y una unidad dada de baja dejan de recibirlo", async () => {
    const { grupoId } = await grupo("Lotes baldíos", [uf1, uf3]);
    const { conceptoId: pastoId } = await concepto({ nombre: "Corte de pasto", montoFijo: "150.00", destinatario: "grupo", grupoId, modoMes: "sola" });
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await calcular(enero);
    await admin.query(
      "insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, monto_fijo, vigente_desde) values ($1, $2, 'monto_fijo', 180, '2025-01-01')",
      [barrio(), pastoId],
    );
    await calcular(enero);
    expect((await vivas(enero)).map((a) => a.importe)).toEqual(["180.00", "180.00"]);
    expect((await aplicacionesDe(enero)).filter((a) => a.anulada)).toHaveLength(2);
    // Desactivado: al recalcular no queda ninguna.
    await como(adminB(), (tx) => editarConceptoBoleta(tx, { conceptoBoletaId: pastoId, nombre: "Corte de pasto", activo: false, destinatario: "grupo", grupoId, modoMes: "sola", unidadUso: "" }));
    await calcular(enero);
    expect(await vivas(enero)).toEqual([]);
    // Un grupo vacío no aplica nada y no rompe.
    await como(adminB(), (tx) => editarConceptoBoleta(tx, { conceptoBoletaId: pastoId, nombre: "Corte de pasto", activo: true, destinatario: "grupo", grupoId, modoMes: "sola", unidadUso: "" }));
    await como(adminB(), (tx) => editarGrupoDeUnidades(tx, { grupoId, nombre: "Lotes baldíos", unidades: [] }));
    await calcular(enero);
    expect(await vivas(enero)).toEqual([]);
  });

  it("quién cambió un grupo o un concepto queda en el historial del barrio", async () => {
    const { grupoId } = await grupo("Lotes baldíos", [uf1, uf3]);
    const { conceptoId: pastoId } = await concepto({ nombre: "Corte de pasto", montoFijo: "150.00", destinatario: "grupo", grupoId, modoMes: "sola" });
    await como(adminB(), (tx) => editarGrupoDeUnidades(tx, { grupoId, nombre: "Baldíos", unidades: [uf2, uf3] }));
    await como(adminB(), (tx) => editarConceptoBoleta(tx, { conceptoBoletaId: pastoId, nombre: "Corte de pasto", activo: true, destinatario: "todas", grupoId: "", modoMes: "sola", unidadUso: "" }));
    // Guardar sin cambios no agrega nada.
    await como(adminB(), (tx) => editarGrupoDeUnidades(tx, { grupoId, nombre: "Baldíos", unidades: [uf2, uf3] }));
    const { rows } = await admin.query<{ detalle: string; por: string; rol: string }>(
      "select detalle, creado_por as por, rol from padron_evento where barrio_id = $1 and tipo = 'configuracion_barrio' order by created_at",
      [barrio()],
    );
    expect(rows.map((r) => r.detalle)).toEqual([
      "Grupo de unidades «Lotes baldíos»: se crea con 2 unidades (Mza 1 · Lote 1, Mza 1 · Lote 3).",
      "Grupo de unidades «Lotes baldíos»: pasa a llamarse «Baldíos»; entran Mza 1 · Lote 2; salen Mza 1 · Lote 1.",
      expect.stringMatching(/^Concepto «Corte de pasto»: a quién va: grupo → todas; grupo: .+ → sin cargar\.$/),
    ]);
    expect(new Set(rows.map((r) => `${r.por}|${r.rol}`))).toEqual(new Set([`${adminB()}|admin_barrio`]));
  });

  it("la pestaña no cuenta dos veces lo cargado a mano de un concepto que pasó a aplicarse solo", async () => {
    const { conceptoId: llave } = await concepto({ nombre: "Aporte al club", montoFijo: "50.00" });
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await como(adminB(), (tx) =>
      aplicarConceptoAUnidad(tx, { periodoId: enero, unidadFuncionalId: uf1, conceptoBoletaId: llave, fechaHecho: null, cantidad: null, detalle: "a mano", origenEvaluacion: "carga_manual", confirmarMontoInusual: true }),
    );
    await como(adminB(), (tx) => editarConceptoBoleta(tx, { conceptoBoletaId: llave, nombre: "Aporte al club", activo: true, destinatario: "todas", grupoId: "", modoMes: "sola", unidadUso: "" }));
    const mes = await como(adminB(), (tx) => conceptosDelMes(tx, { periodoId: enero }));
    expect(mes.conceptos.map((c) => [c.nombre, c.origen, c.unidades, c.importe])).toEqual([["Aporte al club", "sola", 3, "150.00"]]);
  });
});
