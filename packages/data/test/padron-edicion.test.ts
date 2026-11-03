/**
 * El alta de barrio y el padrón editable contra Postgres real (T3, BL-009; ADR-0010, migración `0065`).
 *
 * Lo que se prueba es lo que la base hace cumplir: quién escribe (solo la administración del barrio,
 * y nunca en otra administración ni en otro barrio), una cuenta por unidad en toda la administración,
 * que el cambio de titular no mueve la deuda, que la baja no reutiliza el código ni borra la historia,
 * que el saldo inicial entra una vez, que una versión de coeficientes no rige desde un período emitido
 * y que el período no se genera con unidades sin coeficiente.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import {
  agregarUnidad,
  cambiarTitular,
  confirmarImportacion,
  crearBarrio as crearBarrioServicio,
  crearVersionCoeficientes,
  darDeBaja,
  editarUnidad,
  exportarPadron,
  fichaDeUnidad,
  vistaPreviaDeImportacion,
} from "../src/servicios/padron-edicion.ts";
import { columnasDelPadron } from "@admin-barrios/shared/padron";
import { borrarArbol, borrarParametrosDe, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
const creadosPorServicio: string[] = [];

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const a1 = () => arbol.barrioA1.id;
const adminA1 = () => arbol.usuarios.adminBarrioA1;

// CBU inventados con los verificadores bien, sobre una entidad que no existe (000).
const CBU_1 = "0000003110000000000410";
const CBU_2 = "0000003110000000000427";
const CBU_PADRE = "0000003110000000000434";
const CBU_BARRIO_NUEVO = "0000003110000000000502";

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

async function limpiarBarrio(c: pg.PoolClient, barrioId: string) {
  for (const t of [
    "padron_evento", "interes_devengado", "saldo_uf", "item_liquidacion", "liquidacion", "gasto_periodo", "periodo_expensa",
    "concepto", "coeficiente", "coeficiente_version", "cuota_fija", "cuota_fija_version", "unidad_contacto", "unidad_obligado",
    "obligado", "unidad_funcional", "codigo_pago_secuencia", "mandato_administracion", "documento_barrio",
    "barrio_atributo_vigencia", "barrio",
  ]) {
    await c.query(`delete from ${t} where barrio_id = $1`, [barrioId]);
  }
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  for (const b of [arbol.barrioA1.id, arbol.barrioA2.id, arbol.barrioB1.id]) {
    await crearBarrio(admin, b, { figuraJuridica: "sa", adecuadoArt2075: "no_aplica" });
    await admin.query(
      `update barrio set identificacion_pago = 'cuenta_por_unidad', recaudador = 'Recaudador de prueba', cuenta_cbu = null where barrio_id = $1`,
      [b],
    ).catch(() => undefined);
  }
  // A1 y A2 (misma administración) cobran con cuenta por unidad; B1 (otra administración) también.
  await admin.query(`update barrio set cuenta_cbu = $2, identificacion_pago = 'cuenta_por_unidad', recaudador = 'Recaudador de prueba' where barrio_id = $1`, [a1(), CBU_PADRE]);
  await admin.query(`update barrio set cuenta_cbu = $2, identificacion_pago = 'cuenta_por_unidad', recaudador = 'Recaudador de prueba' where barrio_id = $1`, [arbol.barrioA2.id, "0000003110000000000441"]);
  await admin.query(`update barrio set cuenta_cbu = $2, identificacion_pago = 'cuenta_por_unidad', recaudador = 'Recaudador de prueba' where barrio_id = $1`, [arbol.barrioB1.id, CBU_PADRE]);
});

afterAll(async () => {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const b of [...creadosPorServicio, arbol.barrioA1.id, arbol.barrioA2.id, arbol.barrioB1.id]) await limpiarBarrio(c, b);
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarParametrosDe(admin, creadosPorServicio);
  for (const id of creadosPorServicio) await admin.query("delete from tenant_node where id = $1", [id]);
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("nuevo barrio", () => {
  const alta = (administradorId: string, nombre = "Barrio de Prueba T3") => ({
    administradorId,
    nombre,
    razonSocial: "",
    cuit: "30-55555555-1".replace("30-55555555-1", ""),
    municipio: "Malagueño",
    figuraJuridica: "sa",
    modelo: "fija",
    diaVencimiento: "10",
    primerPeriodo: "2027-01",
    identificacionPago: "cuenta_unica",
    cuentaCbu: CBU_BARRIO_NUEVO,
    cuentaAlias: "prueba.t3.expensas",
    recaudador: "",
    medioCobranza: "transferencia-qr",
    codigoPagoPrefijo: "",
    mandatoDesde: "2026-11-01",
    actaAdjunto: "",
    adecuadoArt2075: "",
    encuadreUrbanistico: "",
    serviciosInternos: "",
    reglamentoInscripto: "",
  });

  it("la administración crea un barrio con los datos legales «A confirmar»: nodo, ficha, mandato y evento", async () => {
    const { barrioId } = await como(arbol.usuarios.adminEstudioA, (tx) => crearBarrioServicio(tx, alta(arbol.adminA.id) as never));
    creadosPorServicio.push(barrioId);
    const { rows } = await admin.query(
      `select b.municipio, b.adecuado_art_2075, b.encuadre_urbanistico, b.servicios_internos_a_cargo_de, b.reglamento_inscripto,
              b.identificacion_pago, b.modelo_liquidacion::text as modelo, n.parent_id,
              (select count(*)::int from barrio_atributo_vigencia v where v.barrio_id = b.barrio_id) as vigencias,
              (select administrador_id from mandato_administracion m where m.barrio_id = b.barrio_id) as mandato,
              (select rol from padron_evento e where e.barrio_id = b.barrio_id and e.tipo = 'alta_barrio') as rol
         from barrio b join tenant_node n on n.id = b.barrio_id where b.barrio_id = $1`,
      [barrioId],
    );
    expect(rows[0]).toEqual({
      municipio: "malagueno",
      adecuado_art_2075: null,
      encuadre_urbanistico: null,
      servicios_internos_a_cargo_de: null,
      reglamento_inscripto: null,
      identificacion_pago: "cuenta_unica",
      modelo: "fija",
      parent_id: arbol.adminA.id,
      // Solo los ejes con valor (figura y municipio): «A confirmar» no se versiona.
      vigencias: 2,
      mandato: arbol.adminA.id,
      rol: "admin_barrio",
    });
    // Los admin de la administración lo ven por herencia, sin membresías nuevas.
    const visibles = await como(arbol.usuarios.adminEstudioA, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from barrio where barrio_id = ${barrioId}`),
    );
    expect(visibles.rows[0]?.n).toBe(1);
  });

  it("RLS: no se puede crear un barrio en otra administración", async () => {
    const e = await capturar(() => como(arbol.usuarios.adminEstudioA, (tx) => crearBarrioServicio(tx, alta(arbol.adminB.id, "Intruso") as never)));
    expect(e.codigo).toBe("sin_permiso");
    // Y por la puerta de atrás, la base lo rechaza igual.
    await expect(
      como(arbol.usuarios.adminEstudioA, (tx) =>
        tx.execute(sql`insert into tenant_node (tipo, nombre, parent_id) values ('barrio', 'Intruso', ${arbol.adminB.id})`),
      ),
      // El trigger que arma el `path` no ve un padre ajeno (RLS de lectura) y corta antes que la policy.
    ).rejects.toThrow(/row-level security|inexistente/i);
    // Un admin de UN barrio no crea barrios en la administración.
    const e2 = await capturar(() => como(adminA1(), (tx) => crearBarrioServicio(tx, alta(arbol.adminA.id, "Hermano") as never)));
    expect(e2.codigo).toBe("sin_permiso");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("padrón editable", () => {
  let lote4: string;

  it("agregar una unidad con dos titulares: código de pago solo, una sola recibe la boleta", async () => {
    const r = await como(adminA1(), (tx) =>
      agregarUnidad(tx, {
        barrioId: a1(),
        manzana: "1",
        lote: "4",
        superficie: "605,00",
        estado: "construido",
        nomenclatura: "",
        cbu: CBU_1,
        alias: "prueba.mz1.l4",
        saldoInicial: "",
        titulares: [
          { nombre: "Pablo Ferreyra", caracter: "propietario", documento: "20-11111111-2", mail: "pablo@correo.example", telefono: "" },
          { nombre: "Ana Ledesma", caracter: "propietario", documento: "27222222", mail: "ana@correo.example", telefono: "" },
        ],
        recibeBoleta: "0",
      }),
    );
    lote4 = r.unidadFuncionalId;
    expect(r.codigoPago).toMatch(/^\d{6}-\d$/);
    const ficha = await como(adminA1(), (tx) => fichaDeUnidad(tx, { unidadFuncionalId: lote4 }));
    expect(ficha?.titulares.map((t) => [t.nombre, t.recibeBoleta])).toEqual([
      ["Pablo Ferreyra", true],
      ["Ana Ledesma", false],
    ]);
    expect(ficha?.superficie).toBe("605.00");
    expect(ficha?.cbu).toBe(CBU_1);
    expect(ficha?.historial[0]?.tipo).toBe("alta");
  });

  it("escriben admin_plataforma y admin_barrio: operador y contador ven sin poder escribir", async () => {
    for (const u of [arbol.usuarios.operadorA1, arbol.usuarios.contadorA1]) {
      const e = await capturar(() =>
        como(u, (tx) => agregarUnidad(tx, { barrioId: a1(), manzana: "9", lote: "9", estado: "baldio", titulares: [] })),
      );
      expect(e.codigo).toBe("sin_permiso");
    }
    // El historial del padrón lo escribe solo la administración, aunque se intente directo.
    await expect(
      como(arbol.usuarios.operadorA1, (tx) =>
        tx.execute(sql`insert into padron_evento (barrio_id, unidad_funcional_id, tipo) values (${a1()}, ${lote4}, 'edicion')`),
      ),
    ).rejects.toThrow();
    const ficha = await como(arbol.usuarios.contadorA1, (tx) => fichaDeUnidad(tx, { unidadFuncionalId: lote4 }));
    expect(ficha?.etiqueta).toBeTruthy();
  });

  it("RLS: no se puede editar el padrón de otro barrio", async () => {
    // adminBarrioA1 no es admin de A2 (hermano) ni de B1 (otra administración).
    for (const ajeno of [arbol.barrioA2.id, arbol.barrioB1.id]) {
      const e = await capturar(() =>
        como(adminA1(), (tx) => agregarUnidad(tx, { barrioId: ajeno, manzana: "1", lote: "1", estado: "baldio", titulares: [] })),
      );
      expect(e.codigo).toBe("sin_permiso");
    }
    const { rows } = await admin.query<{ id: string }>(
      "insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad) values ($1, '5', '5', 'baldio') returning id",
      [arbol.barrioB1.id],
    );
    const e = await capturar(() =>
      como(adminA1(), (tx) => editarUnidad(tx, { unidadFuncionalId: rows[0]!.id, estado: "construido" })),
    );
    expect(["referencia_inexistente", "sin_permiso"]).toContain(e.codigo);
    const { rows: sigue } = await admin.query<{ e: string }>("select estado_unidad::text as e from unidad_funcional where id = $1", [rows[0]!.id]);
    expect(sigue[0]?.e).toBe("baldio");
  });

  it("una cuenta por unidad: el CBU no se repite en la administración, sí en otra", async () => {
    const e = await capturar(() =>
      como(arbol.usuarios.adminEstudioA, (tx) =>
        agregarUnidad(tx, { barrioId: arbol.barrioA2.id, manzana: "1", lote: "1", estado: "baldio", cbu: CBU_1, titulares: [] }),
      ),
    );
    expect(e.codigo).toBe("cuenta_repetida");
    // La cuenta padre de un barrio de la administración tampoco puede ser la de una unidad.
    const e2 = await capturar(() =>
      como(arbol.usuarios.adminEstudioA, (tx) =>
        agregarUnidad(tx, { barrioId: arbol.barrioA2.id, manzana: "1", lote: "1", estado: "baldio", cbu: CBU_PADRE, titulares: [] }),
      ),
    );
    expect(e2.codigo).toBe("cuenta_repetida");
    // Otra administración: es otra cuenta del sistema, no se cruza.
    await como(arbol.usuarios.adminEstudioB, (tx) =>
      agregarUnidad(tx, { barrioId: arbol.barrioB1.id, manzana: "2", lote: "2", estado: "baldio", cbu: CBU_1, titulares: [] }),
    );
    // Un CBU con el verificador mal no entra ni por la puerta de atrás.
    await expect(
      admin.query("update unidad_funcional set cbu = '0000003110000000000411' where id = $1", [lote4]),
    ).rejects.toThrow(/uf_cbu_chk/);
  });

  it("un operador no puede cargar una cuenta: el trigger no le sirve para preguntar si existe en otro barrio", async () => {
    await expect(
      como(arbol.usuarios.operadorA1, (tx) =>
        tx.execute(sql`insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad, cbu) values (${a1()}, '8', '8', 'baldio', ${CBU_2})`),
      ),
    ).rejects.toThrow(/lo modifica la administración/);
  });

  it("la exportación del padrón es de la administración, y queda registrada", async () => {
    const e = await capturar(() => como(arbol.usuarios.contadorA1, (tx) => exportarPadron(tx, { barrioId: a1() })));
    expect(e.codigo).toBe("sin_permiso");
    await como(adminA1(), (tx) => exportarPadron(tx, { barrioId: a1() }));
    const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from padron_evento where barrio_id = $1 and tipo = 'exportacion'", [a1()]);
    expect(rows[0]?.n).toBe(1);
  });

  it("un documento ya registrado con otro nombre pide confirmación; confirmado, se usa la persona registrada", async () => {
    const pedir = () =>
      como(adminA1(), (tx) =>
        agregarUnidad(tx, {
          barrioId: a1(),
          manzana: "1",
          lote: "6",
          estado: "baldio",
          titulares: [{ nombre: "Pablo A. Ferreyra", documento: "20111111112" }],
        }),
      );
    expect((await capturar(pedir)).codigo).toBe("titular_ya_registrado");
    const r = await como(adminA1(), (tx) =>
      agregarUnidad(tx, {
        barrioId: a1(),
        manzana: "1",
        lote: "6",
        estado: "baldio",
        titulares: [{ nombre: "Pablo A. Ferreyra", documento: "20111111112" }],
        confirmarTitularRegistrado: "1",
      }),
    );
    const ficha = await como(adminA1(), (tx) => fichaDeUnidad(tx, { unidadFuncionalId: r.unidadFuncionalId }));
    expect(ficha?.titulares[0]?.nombre).toBe("Pablo Ferreyra");
  });

  it("cambiar titular: los anteriores cierran el día anterior y la deuda sigue con la unidad", async () => {
    await admin.query(
      "insert into saldo_uf (barrio_id, unidad_funcional_id, saldo_actual) values ($1, $2, 48200) on conflict (barrio_id, unidad_funcional_id) do update set saldo_actual = 48200",
      [a1(), lote4],
    );
    const futuro = await capturar(() =>
      como(adminA1(), (tx) => cambiarTitular(tx, { unidadFuncionalId: lote4, desde: "2099-01-01", titular: { nombre: "Carla Gómez" }, motivo: "venta" })),
    );
    expect(futuro.codigo).toBe("fecha_de_titular_invalida");
    const hoy = (await admin.query<{ h: string }>("select (now() at time zone 'America/Argentina/Buenos_Aires')::date::text as h")).rows[0]!.h;
    const anterior = await capturar(() =>
      como(adminA1(), (tx) => cambiarTitular(tx, { unidadFuncionalId: lote4, desde: "2000-01-01", titular: { nombre: "Carla Gómez" }, motivo: "venta" })),
    );
    expect(anterior.codigo).toBe("fecha_de_titular_invalida");

    // Los actuales rigen desde hoy: el cambio, con fecha de hoy, no puede ser; se los corre un día atrás.
    await admin.query("update unidad_obligado set desde = desde - 10 where unidad_funcional_id = $1", [lote4]);
    const r = await como(adminA1(), (tx) =>
      cambiarTitular(tx, {
        unidadFuncionalId: lote4,
        desde: hoy,
        titular: { nombre: "Carla Gómez", documento: "27-44444444-0".replace("27-44444444-0", "27444444"), mail: "carla@correo.example" },
        motivo: "venta",
        detalle: "Escritura del día",
        respaldoTipo: "escritura",
        respaldoReferencia: "Escritura 123",
      }),
    );
    expect(r).toEqual({ deuda: "48200.00", cerrados: 2 });
    const { rows } = await admin.query<{ nombre: string; hasta: string | null; notif: boolean; dia_antes: boolean }>(
      `select o.nombre, uo.hasta::text as hasta, uo.es_notificado as notif, (uo.hasta = $2::date - 1) as dia_antes
         from unidad_obligado uo join obligado o on o.id = uo.obligado_id where uo.unidad_funcional_id = $1 order by o.nombre`,
      [lote4, hoy],
    );
    expect(rows.map((x) => [x.nombre, x.hasta === null, x.notif, x.hasta === null || x.dia_antes])).toEqual([
      ["Ana Ledesma", false, false, true],
      ["Carla Gómez", true, true, true],
      ["Pablo Ferreyra", false, true, true],
    ]);
    // La deuda no se movió: sigue en la cuenta corriente de la unidad.
    const { rows: s } = await admin.query<{ s: string }>("select saldo_actual::text as s from saldo_uf where unidad_funcional_id = $1", [lote4]);
    expect(s[0]?.s).toBe("48200.00");
    const ficha = await como(adminA1(), (tx) => fichaDeUnidad(tx, { unidadFuncionalId: lote4 }));
    expect(ficha?.anteriores.map((t) => t.nombre).sort()).toEqual(["Ana Ledesma", "Pablo Ferreyra"]);
    expect(ficha?.historial[0]).toMatchObject({ tipo: "cambio_titular", motivo: "venta", respaldo: "escritura · Escritura 123" });
    await admin.query("delete from saldo_uf where unidad_funcional_id = $1", [lote4]);
  });

  it("dar de baja: conserva la historia y el código no se reutiliza", async () => {
    const antes = (await admin.query<{ n: string }>("select codigo_pago_numero::text as n from unidad_funcional where id = $1", [lote4])).rows[0]!.n;
    const r = await como(adminA1(), (tx) => darDeBaja(tx, { unidadFuncionalId: lote4, motivo: "unificacion", detalle: "Se unificó con Mz 1 · Lote 5" }));
    expect(r.sinBoletaDesde).toMatch(/^\d{4}-\d{2}$/);
    const nueva = await como(adminA1(), (tx) => agregarUnidad(tx, { barrioId: a1(), manzana: "1", lote: "7", estado: "baldio", titulares: [] }));
    const n = (await admin.query<{ n: string }>("select codigo_pago_numero::text as n from unidad_funcional where id = $1", [nueva.unidadFuncionalId])).rows[0]!.n;
    expect(Number(n)).toBeGreaterThan(Number(antes));
    const ficha = await como(adminA1(), (tx) => fichaDeUnidad(tx, { unidadFuncionalId: lote4 }));
    expect(ficha?.baja?.motivo).toBe("unificacion");
    expect(ficha?.historial.map((e) => e.tipo)).toEqual(["baja", "cambio_titular", "alta"]);
    expect((await capturar(() => como(adminA1(), (tx) => editarUnidad(tx, { unidadFuncionalId: lote4, estado: "baldio" })))).codigo).toBe(
      "unidad_dada_de_baja",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("coeficientes, saldo inicial y generación del período", () => {
  let conceptoId: string;

  async function periodo(p: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, $2, $3) returning id",
      [a1(), p, `${p}-10`],
    );
    await admin.query(
      "insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '3000.00')",
      [a1(), rows[0]!.id, conceptoId],
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    const { rows: c } = await admin.query<{ id: string }>(
      "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
      [a1()],
    );
    conceptoId = c[0]!.id;
  });

  it("sin coeficiente para una unidad activa, el período no se genera y lo dice", async () => {
    const p = await periodo("2026-12");
    const e = await capturar(() => como(adminA1(), (tx) => generarLiquidaciones(tx, { periodoId: p, origenSaldo: "calculado", fechaCorteMora: "2026-11-01" })));
    // Todavía no hay ninguna versión: es el rechazo de siempre.
    expect(e.codigo).toBe("barrio_sin_coeficientes");

    // Una versión iguales por lote que rige desde 12/2026: suma 1 exacto.
    const v = await como(adminA1(), (tx) => crearVersionCoeficientes(tx, { barrioId: a1(), forma: "iguales", rigeDesde: "2026-12" }));
    expect(v.suma).toBe("1.000000000");
    // Una unidad nueva después: queda sin coeficiente en esa versión.
    await como(adminA1(), (tx) =>
      agregarUnidad(tx, { barrioId: a1(), manzana: "2", lote: "1", estado: "baldio", saldoInicial: "1500.00", titulares: [] }),
    );
    const e2 = await capturar(() => como(adminA1(), (tx) => generarLiquidaciones(tx, { periodoId: p, origenSaldo: "calculado", fechaCorteMora: "2026-11-01" })));
    expect(e2.codigo).toBe("unidades_sin_coeficiente");
    expect(e2.message).toMatch(/Mza 2 · Lote 1/);

    // Una versión nueva por superficie no se puede: hay unidades sin superficie.
    expect((await capturar(() => como(adminA1(), (tx) => crearVersionCoeficientes(tx, { barrioId: a1(), forma: "superficie", rigeDesde: "2026-12" })))).codigo).toBe(
      "dato_invalido",
    );
    // Por planilla, que suma 1 y reemplaza a la de 12/2026 antes de liquidar.
    const { rows: activas } = await admin.query<{ manzana: string; lote: string }>(
      "select manzana, lote from unidad_funcional where barrio_id = $1 and baja_at is null order by manzana, lote",
      [a1()],
    );
    const planilla = [["manzana", "lote", "coeficiente"], ...activas.map((u, i) => [u.manzana, u.lote, i === 0 ? "2" : "1"])];
    const v2 = await como(adminA1(), (tx) =>
      crearVersionCoeficientes(tx, { barrioId: a1(), forma: "planilla", rigeDesde: "2026-12", planilla }),
    );
    expect(v2.suma).toBe("1.000000000");
    const r = await como(adminA1(), (tx) => generarLiquidaciones(tx, { periodoId: p, origenSaldo: "calculado", fechaCorteMora: "2026-11-01" }));
    expect(r.unidadesLiquidadas).toBe(activas.length);
  });

  it("el saldo inicial entra una vez, con origen carga manual, y después de emitir no se cambia", async () => {
    const { rows: p } = await admin.query<{ id: string }>("select id from periodo_expensa where barrio_id = $1 and periodo = '2026-12'", [a1()]);
    const periodoId = p[0]!.id;
    const { rows } = await admin.query<{ saldo: string; origen: string; exigible: string; id: string }>(
      `select l.saldo_anterior::text as saldo, l.saldo_anterior_origen as origen, l.importe_exigible::text as exigible, u.id
         from liquidacion l join unidad_funcional u on u.id = l.unidad_funcional_id
        where l.periodo_id = $1 and u.manzana = '2' and u.lote = '1'`,
      [periodoId],
    );
    expect(rows[0]).toMatchObject({ saldo: "1500.00", origen: "carga_manual" });
    await como(adminA1(), (tx) => emitirPeriodo(tx, { periodoId }));
    const e = await capturar(() => como(adminA1(), (tx) => editarUnidad(tx, { unidadFuncionalId: rows[0]!.id, estado: "baldio", saldoInicial: "2000.00" })));
    expect(e.codigo).toBe("saldo_inicial_usado");

    // Un período nuevo: generado, y después el padrón cambia con un alta y una baja (la CANTIDAD de
    // unidades queda igual). La emisión lo frena: la base solo compara cantidades.
    const enero = await periodo("2027-01");
    await como(adminA1(), (tx) => generarLiquidaciones(tx, { periodoId: enero, origenSaldo: "calculado", fechaCorteMora: "2026-12-01" }));
    const nueva = await como(adminA1(), (tx) => agregarUnidad(tx, { barrioId: a1(), manzana: "5", lote: "1", estado: "baldio", titulares: [] }));
    await como(adminA1(), (tx) => darDeBaja(tx, { unidadFuncionalId: rows[0]!.id, motivo: "carga_por_error", detalle: "Prueba de alta y baja con un borrador abierto" }));
    const e3 = await capturar(() => como(adminA1(), (tx) => emitirPeriodo(tx, { periodoId: enero })));
    expect(e3.codigo).toBe("borrador_desactualizado");
    void nueva;

    // Y una versión de coeficientes no rige desde un período emitido.
    const e2 = await capturar(() => como(adminA1(), (tx) => crearVersionCoeficientes(tx, { barrioId: a1(), forma: "iguales", rigeDesde: "2026-12" })));
    expect(e2.codigo).toBe("coeficientes_superpuestos");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("planilla del padrón", () => {
  const ENC = [...columnasDelPadron(true)];
  const fila = (v: Partial<Record<(typeof ENC)[number], string>>) => ENC.map((c) => v[c] ?? "");

  it("vista previa sin escribir; con un error no se importa nada; corregida, entra todo", async () => {
    const b = arbol.barrioA2.id;
    const conError = [
      ENC,
      fila({ manzana: "3", lote: "1", superficie_m2: "600", estado: "Baldío", titular: "Lucas Herrera", cuit_o_dni: "20-11111111-2", recibe_boleta: "sí", cbu_unidad: CBU_2 }),
      fila({ manzana: "3", lote: "1", titular: "Valentina Ruiz", cuit_o_dni: "27222222" }),
      fila({ manzana: "3", lote: "2", titular: "Mal Documento", cuit_o_dni: "20-12345678-0" }),
    ];
    const previa = await como(arbol.usuarios.adminEstudioA, (tx) => vistaPreviaDeImportacion(tx, { barrioId: b, archivo: "padron.csv", filas: conError }));
    expect([previa.altas, previa.conError, previa.ok]).toEqual([1, 1, false]);
    const e = await capturar(() => como(arbol.usuarios.adminEstudioA, (tx) => confirmarImportacion(tx, { barrioId: b, archivo: "padron.csv", filas: conError })));
    expect(e.codigo).toBe("planilla_con_errores");
    const { rows: nada } = await admin.query<{ n: number }>("select count(*)::int as n from unidad_funcional where barrio_id = $1 and manzana = '3'", [b]);
    expect(nada[0]?.n).toBe(0);

    const bien = conError.slice(0, 3);
    const r = await como(arbol.usuarios.adminEstudioA, (tx) => confirmarImportacion(tx, { barrioId: b, archivo: "padron.csv", filas: bien }));
    expect(r).toEqual({ altas: 1, correcciones: 0, sinCambios: 0 });
    const exportado = await como(arbol.usuarios.adminEstudioA, (tx) => exportarPadron(tx, { barrioId: b }));
    const filas31 = exportado.filter((f) => f[0] === "3" && f[1] === "1");
    expect(filas31.map((f) => f[ENC.indexOf("titular")])).toEqual(["Lucas Herrera", "Valentina Ruiz"]);
    // Lo exportado vuelve a entrar sin cambios.
    const vuelta = await como(arbol.usuarios.adminEstudioA, (tx) => vistaPreviaDeImportacion(tx, { barrioId: b, archivo: "padron.csv", filas: exportado }));
    expect(vuelta.ok).toBe(true);
    expect(vuelta.altas + vuelta.correcciones).toBe(0);
    // El historial dice de qué planilla vino.
    const { rows: ev } = await admin.query<{ archivo: string; rol: string }>(
      "select e.archivo, e.rol from padron_evento e join unidad_funcional u on u.id = e.unidad_funcional_id where u.barrio_id = $1 and u.manzana = '3'",
      [b],
    );
    expect(ev[0]).toEqual({ archivo: "padron.csv", rol: "admin_barrio" });
  });
});
