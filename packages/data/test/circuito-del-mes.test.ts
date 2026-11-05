/**
 * El circuito del mes (ADR-0011, T2) contra Postgres real: **emitir calcula** (D1).
 *
 * - La vista previa se calcula al pedirla y no deja nada escrito.
 * - Si nada cambió, lo emitido es lo de la vista previa, boleta por boleta.
 * - Si algo cambió, emitir no emite: dice qué cambió y se confirma con las cifras nuevas.
 * - Dos emisiones a la vez: una sola gana.
 * - Los importes son, al centavo, los del circuito de antes («Generar el borrador» y «Emitir»).
 * - El mes se abre solo, los vencimientos se cambian hasta emitir, y lo que falta se separa en lo que
 *   bloquea y lo que avisa.
 * - Al emitir se encolan solos las boletas en PDF y el informe (D5).
 *
 * El escenario: dos unidades con coeficiente 0,5 y $ 2.000 de gasto (= $ 1.000 por boleta), tasa 3 %
 * mensual. Enero se emite con el circuito de antes y la unidad 2 no paga: febrero arrastra saldo e
 * interés, que corre hasta hoy.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { nuevoToken } from "@admin-barrios/almacenamiento";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { registrarEImputarPago } from "../src/servicios/deuda.ts";
import {
  abrirMesEnCurso,
  boletasDelMes,
  cambiarVencimientos,
  emitirMes,
  loQueFaltaDelMes,
  mesEnMisBarrios,
} from "../src/servicios/circuito-del-mes.ts";
import { encadenarElPaquete } from "../src/servicios/trabajos.ts";
import {
  borrarArbol,
  borrarParametrosDe,
  cargarParametro,
  crearArbol,
  crearBarrio,
  dbDe,
  poolAdmin,
  poolApp,
  type Arbol,
} from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf1: string;
let uf2: string;
let conceptoId: string;

const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminB = () => arbol.usuarios.adminBarrioA1;

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
    "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, $2, $3) returning id",
    [barrio(), periodo, vencimiento],
  );
  await admin.query(
    "insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '2000.00')",
    [barrio(), rows[0]!.id, conceptoId],
  );
  return rows[0]!.id;
}

/** Enero con el circuito de antes; febrero en borrador, con saldo e interés para arrastrar. */
async function escenario(): Promise<string> {
  const enero = await crearPeriodo("2025-01", "2025-01-10");
  await como(adminB(), (tx) => generarLiquidaciones(tx, { periodoId: enero, origenSaldo: "calculado", fechaCorteMora: "2025-01-01" }));
  await como(adminB(), (tx) => emitirPeriodo(tx, { periodoId: enero }));
  await pagar(uf1, "1000.00", "2025-01-05"); // la 1 paga en término; la 2 no paga
  return crearPeriodo("2025-02", "2025-02-10");
}

const pagar = (unidad: string, monto: string, fecha: string) =>
  como(adminB(), (tx) =>
    registrarEImputarPago(tx, {
      pago: { unidadFuncionalId: unidad, obligadoId: null, monto, fecha, origen: "manual", comprobanteAdjunto: `barrios/${barrio()}/pagos/comprobantes/${nuevoToken()}.pdf` },
      confirmarPagoConInteres: true,
      noCobrarInteres: null,
    }),
  );

const COLUMNAS = `l.unidad_funcional_id, l.subtotal_ordinarias::text, l.subtotal_extraordinarias::text, l.subtotal_fondo_reserva::text,
  l.subtotal_cuota_fija::text, l.subtotal_cargos::text, l.subtotal_descuentos::text, l.saldo_anterior::text, l.saldo_anterior_origen,
  l.interes_mora::text, l.total::text, l.importe_exigible::text, l.dias_atraso, l.fecha_corte_mora::text, l.coeficiente_aplicado::text`;

const liquidacionesDe = async (periodoId: string) =>
  (await admin.query(`select ${COLUMNAS} from liquidacion l where l.periodo_id = $1 order by l.unidad_funcional_id`, [periodoId])).rows;

const estadoDe = async (periodoId: string) =>
  (await admin.query<{ estado: string }>("select estado::text as estado from periodo_expensa where id = $1", [periodoId])).rows[0]!.estado;

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, barrio(), { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  const { rows: ufs } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad) values ($1,'1','1','construido'), ($1,'1','2','construido') returning id`,
    [barrio()],
  );
  [uf1, uf2] = [ufs[0]!.id, ufs[1]!.id];
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [barrio()],
  );
  await admin.query("insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,0.5), ($1,$2,$4,0.5)", [
    barrio(), v[0]!.id, uf1, uf2,
  ]);
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
  const { rows: c } = await admin.query<{ id: string }>(
    "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
    [barrio()],
  );
  conceptoId = c[0]!.id;
  await borrarParametrosDe(admin, [barrio()]);
  for (const [clave, valor] of [
    ["interes.cobra", true], ["interes.tasa_compensatoria", "0.03"], ["interes.tasa_punitoria", "0"], ["interes.gracia_dias", 0],
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
    for (const t of ["trabajo", "interes_condonacion", "pago_imputacion_interes", "pago_imputacion", "interes_devengado", "saldo_uf", "pago",
      "item_liquidacion", "liquidacion", "orden_pago", "proveedor", "gasto_periodo", "periodo_expensa"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("update barrio set modelo_liquidacion = null, dia_vencimiento = null where barrio_id = $1", [barrio()]);
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
    for (const t of ["concepto", "coeficiente", "coeficiente_version", "unidad_funcional", "codigo_pago_secuencia", "barrio_atributo_vigencia", "barrio"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("la vista previa (D1)", () => {
  it("se calcula al pedirla y no deja nada escrito: ni boletas, ni firma, ni tramos de interés", async () => {
    const febrero = await escenario();
    const tramosAntes = (await admin.query("select count(*)::int as n from interes_devengado where barrio_id = $1", [barrio()])).rows[0].n;
    const vista = await como(adminB(), (tx) => boletasDelMes(tx, { periodoId: febrero }));
    expect(vista.estado).toBe("vista_previa");
    if (vista.estado !== "vista_previa") return;
    expect(vista.totales.boletas).toBe(2);
    // La 2 arrastra $ 1.000 de enero con interés a hoy; la 1 solo el mes.
    expect(vista.boletas.find((b) => b.unidadFuncionalId === uf1)).toMatchObject({ expensa: "1000.00", saldoAnterior: "0.00", interes: "0.00", total: "1000.00" });
    expect(Number(vista.boletas.find((b) => b.unidadFuncionalId === uf2)!.interes)).toBeGreaterThan(0);

    expect(await liquidacionesDe(febrero)).toEqual([]);
    expect(await estadoDe(febrero)).toBe("borrador");
    expect((await admin.query("select count(*)::int as n from interes_devengado where barrio_id = $1", [barrio()])).rows[0].n).toBe(tramosAntes);
  });

  it("si la emisión no pasaría, la vista previa lo dice con el motivo de la base", async () => {
    const febrero = await escenario();
    // Una unidad nueva sin coeficiente: el prorrateo no tiene con qué repartirle.
    const { rows } = await admin.query<{ id: string }>(
      "insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad) values ($1,'1','3','construido') returning id",
      [barrio()],
    );
    try {
      const vista = await como(adminB(), (tx) => boletasDelMes(tx, { periodoId: febrero }));
      expect(vista.estado).toBe("bloqueada");
      const faltas = await como(adminB(), (tx) => loQueFaltaDelMes(tx, { periodoId: febrero, vista }));
      expect(faltas[0]).toMatchObject({ tipo: "bloquea" });
    } finally {
      await admin.query("set session_replication_role = replica");
      await admin.query("delete from unidad_funcional where id = $1", [rows[0]!.id]);
      await admin.query("set session_replication_role = origin");
    }
  });
});

describe("emitir calcula (D1)", () => {
  it("si nada cambió, lo emitido es la vista previa, boleta por boleta", async () => {
    const febrero = await escenario();
    const vista = await como(adminB(), (tx) => boletasDelMes(tx, { periodoId: febrero }));
    if (vista.estado !== "vista_previa") throw new Error(vista.estado);
    const r = await como(adminB(), (tx) => emitirMes(tx, { periodoId: febrero, huellaVista: vista.huella, vistaCalculadaEl: vista.calculadaEl }));
    expect(r.totales).toEqual(vista.totales);
    const emitidas = await como(adminB(), (tx) => boletasDelMes(tx, { periodoId: febrero }));
    expect(emitidas.estado).toBe("emitida");
    if (emitidas.estado === "emitida") {
      expect(emitidas.boletas).toEqual(vista.boletas);
      expect(emitidas.huella).toBe(vista.huella);
    }
  });

  it("si entró un pago después de la vista previa, no emite: dice qué cambió, y con las cifras nuevas sí", async () => {
    const febrero = await escenario();
    const vista = await como(adminB(), (tx) => boletasDelMes(tx, { periodoId: febrero }));
    if (vista.estado !== "vista_previa") throw new Error(vista.estado);
    await pagar(uf2, "500.00", "2025-02-05");

    const e = await capturar(() => como(adminB(), (tx) => emitirMes(tx, { periodoId: febrero, huellaVista: vista.huella, vistaCalculadaEl: vista.calculadaEl })));
    expect(e.codigo).toBe("emision_con_cambios");
    expect(e.message, e.message).toMatch(/entró 1 pago/);
    expect(e.message).toMatch(/El total pasa de \$ /);
    expect(e.datos["totalAntes"]).toBe(vista.totales.total);
    expect(await estadoDe(febrero)).toBe("borrador");
    expect(await liquidacionesDe(febrero)).toEqual([]);

    const r = await como(adminB(), (tx) => emitirMes(tx, { periodoId: febrero, huellaVista: e.datos["cifras"]!, vistaCalculadaEl: vista.calculadaEl }));
    expect(r.totales.total).toBe(e.datos["totalAhora"]);
    expect(await estadoDe(febrero)).toBe("emitida");
  });

  it("dos emisiones a la vez: una sola gana", async () => {
    const febrero = await escenario();
    const resultados = await Promise.allSettled([
      como(adminB(), (tx) => emitirMes(tx, { periodoId: febrero })),
      como(arbol.usuarios.adminEstudioA, (tx) => emitirMes(tx, { periodoId: febrero })),
    ]);
    const ok = resultados.filter((r) => r.status === "fulfilled");
    const mal = resultados.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(mal).toHaveLength(1);
    expect((mal[0]!.reason as ErrorDeNegocio).codigo).toBe("periodo_no_editable");
    expect(await liquidacionesDe(febrero)).toHaveLength(2);
  });

  it("los importes emitidos son, al centavo, los del circuito de antes con los mismos datos", async () => {
    const febrero = await escenario();
    // El circuito de antes, en un punto de guardado: «Generar el borrador» y «Emitir». Se leen las
    // boletas y se vuelve atrás.
    const antes = await como(adminB(), async (tx) => {
      await tx.execute(sql`savepoint circuito_de_antes`);
      await generarLiquidaciones(tx, { periodoId: febrero, origenSaldo: "calculado" });
      await emitirPeriodo(tx, { periodoId: febrero });
      const { rows } = await tx.execute(sql.raw(`select ${COLUMNAS} from liquidacion l where l.periodo_id = '${febrero}' order by l.unidad_funcional_id`));
      await tx.execute(sql`rollback to savepoint circuito_de_antes`);
      return rows;
    });
    expect(antes).toHaveLength(2);
    expect(await estadoDe(febrero)).toBe("borrador");

    await como(adminB(), (tx) => emitirMes(tx, { periodoId: febrero }));
    expect(await liquidacionesDe(febrero)).toEqual(antes);
  });

  it("un rol de solo lectura no emite", async () => {
    const febrero = await escenario();
    const e = await capturar(() => como(arbol.usuarios.contadorA1, (tx) => emitirMes(tx, { periodoId: febrero })));
    expect(["sin_permiso", "periodo_no_encontrado"]).toContain(e.codigo);
    expect(await estadoDe(febrero)).toBe("borrador");
  });

  it("al emitir se encolan solos las boletas en PDF y el informe (D5); el paquete no se duplica", async () => {
    const febrero = await escenario();
    const r = await como(adminB(), (tx) => emitirMes(tx, { periodoId: febrero }));
    expect(r.encolados).toEqual({ boletas: true, informe: true });
    const { rows } = await admin.query<{ tipo: string }>("select tipo from trabajo where referencia_id = $1 order by tipo", [febrero]);
    expect(rows.map((x) => x.tipo)).toEqual(["emitir_documentos_periodo", "emitir_informe_periodo"]);
    // Con un paquete ya encolado, encadenar no encola otro.
    await admin.query("set session_replication_role = replica");
    await admin.query(
      "insert into trabajo (barrio_id, tipo, referencia_id, solicitado_por, estado) values ($1, 'armar_paquete_periodo', $2, $3, 'encolado')",
      [barrio(), febrero, adminB()],
    );
    await admin.query("set session_replication_role = origin");
    expect(await como(adminB(), (tx) => encadenarElPaquete(tx, { periodoId: febrero }))).toBeNull();
  });
});

describe("el mes se abre solo, y sus vencimientos", () => {
  it("abre el mes en curso con el modelo y el día de vencimiento del barrio, una sola vez", async () => {
    await admin.query("update barrio set modelo_liquidacion = 'variable', dia_vencimiento = 10 where barrio_id = $1", [barrio()]);
    const a = await como(adminB(), (tx) => abrirMesEnCurso(tx, { barrioId: barrio() }));
    expect(a?.recienAbierto).toBe(true);
    const b = await como(adminB(), (tx) => abrirMesEnCurso(tx, { barrioId: barrio() }));
    expect(b).toEqual({ ...a!, recienAbierto: false });
    const { rows } = await admin.query<{ modelo: string; venc: string; mes: string }>(
      `select p.modelo::text as modelo, p.primer_vencimiento::text as venc,
              to_char((p.periodo || '-01')::date + interval '1 month', 'YYYY-MM') || '-10' as mes
         from periodo_expensa p where p.id = $1`,
      [a!.periodoId],
    );
    // Por coeficiente vence el mes siguiente, en el día del barrio.
    expect(rows[0]).toMatchObject({ modelo: "variable" });
    expect(rows[0]!.venc).toBe(rows[0]!.mes);
  });

  it("un rol de solo lectura no lo abre", async () => {
    expect(await como(arbol.usuarios.contadorA1, (tx) => abrirMesEnCurso(tx, { barrioId: barrio() }))).toBeNull();
  });

  it("los vencimientos se cambian con motivo hasta emitir; después, no", async () => {
    const febrero = await escenario();
    await como(adminB(), (tx) =>
      cambiarVencimientos(tx, { periodoId: febrero, primerVencimiento: "2025-02-12", segundoVencimiento: "2025-02-22", motivo: "Feriado largo" }),
    );
    const { rows } = await admin.query("select primer_vencimiento::text as a, segundo_vencimiento::text as b, motivo_vencimientos as m from periodo_expensa where id = $1", [febrero]);
    expect(rows[0]).toEqual({ a: "2025-02-12", b: "2025-02-22", m: "Feriado largo" });
    await como(adminB(), (tx) => emitirMes(tx, { periodoId: febrero }));
    const e = await capturar(() =>
      como(adminB(), (tx) => cambiarVencimientos(tx, { periodoId: febrero, primerVencimiento: "2025-02-15", motivo: "Tarde" })),
    );
    expect(e.codigo).toBe("periodo_no_editable");
  });
});

describe("lo que falta y el mes en mis barrios", () => {
  it("las órdenes de pago sin aprobar avisan, no bloquean", async () => {
    const febrero = await escenario();
    await admin.query("set session_replication_role = replica");
    const { rows: pr } = await admin.query<{ id: string }>("insert into proveedor (barrio_id, razon_social) values ($1, 'Seguridad SA') returning id", [barrio()]);
    await admin.query(
      `insert into orden_pago (barrio_id, proveedor_id, periodo_id, concepto_id, descripcion, monto, estado, creada_por)
       values ($1, $2, $3, $4, 'Vigilancia', '550.00', 'pendiente', $5)`,
      [barrio(), pr[0]!.id, febrero, conceptoId, adminB()],
    );
    await admin.query("set session_replication_role = origin");
    const vista = await como(adminB(), (tx) => boletasDelMes(tx, { periodoId: febrero }));
    const faltas = await como(adminB(), (tx) => loQueFaltaDelMes(tx, { periodoId: febrero, vista }));
    expect(faltas).toEqual([expect.objectContaining({ tipo: "avisa", titulo: "1 orden de pago sin aprobar por $ 550,00" })]);
  });

  it("el mes en curso de cada barrio, con su estado en palabras", async () => {
    await admin.query("update barrio set modelo_liquidacion = 'variable', dia_vencimiento = 10 where barrio_id = $1", [barrio()]);
    const antes = (await como(adminB(), (tx) => mesEnMisBarrios(tx))).find((m) => m.barrioId === barrio());
    expect(antes).toMatchObject({ estado: "sin_abrir", periodoId: null, unidades: 2 });
    await como(adminB(), (tx) => abrirMesEnCurso(tx, { barrioId: barrio() }));
    const despues = (await como(adminB(), (tx) => mesEnMisBarrios(tx))).find((m) => m.barrioId === barrio());
    expect(despues).toMatchObject({ estado: "preparando" });
    // Otro barrio no se ve.
    expect((await como(arbol.usuarios.adminEstudioB, (tx) => mesEnMisBarrios(tx))).some((m) => m.barrioId === barrio())).toBe(false);
  });
});

describe("lo que pidió security-engineer (T2)", () => {
  it("los vencimientos de un mes emitido no se cambian ni yendo directo a la tabla (0072)", async () => {
    const febrero = await escenario();
    await como(adminB(), (tx) => emitirMes(tx, { periodoId: febrero }));
    await expect(
      como(adminB(), (tx) => tx.execute(sql`update periodo_expensa set primer_vencimiento = '2025-01-01' where id = ${febrero}`)),
    ).rejects.toThrow(/los vencimientos de un período emitida no se pueden cambiar/);
    const { rows } = await admin.query("select primer_vencimiento::text as v from periodo_expensa where id = $1", [febrero]);
    expect(rows[0].v).toBe("2025-02-10");
  });

  it("un contador ve el mes pero no cambia sus vencimientos: «sin permiso», no «emitido»", async () => {
    const febrero = await escenario();
    const e = await capturar(() =>
      como(arbol.usuarios.contadorA1, (tx) => cambiarVencimientos(tx, { periodoId: febrero, primerVencimiento: "2025-02-12", motivo: "Prueba" })),
    );
    expect(e.codigo).toBe("sin_permiso");
  });

  it("otro barrio no emite, no cambia vencimientos ni abre el mes de este; no se toca nada", async () => {
    const febrero = await escenario();
    const ajeno = arbol.usuarios.adminEstudioB;
    expect((await capturar(() => como(ajeno, (tx) => emitirMes(tx, { periodoId: febrero })))).codigo).toBe("periodo_no_encontrado");
    expect(
      (await capturar(() => como(ajeno, (tx) => cambiarVencimientos(tx, { periodoId: febrero, primerVencimiento: "2025-02-12", motivo: "Ajeno" })))).codigo,
    ).toBe("periodo_no_encontrado");
    expect(await como(ajeno, (tx) => abrirMesEnCurso(tx, { barrioId: barrio() }))).toBeNull();
    expect(await estadoDe(febrero)).toBe("borrador");
  });

  it("la vista previa no deja candados: otra conexión toma el período y los cobros enseguida", async () => {
    const febrero = await escenario();
    await como(adminB(), async (tx) => {
      await boletasDelMes(tx, { periodoId: febrero });
      // Sin cerrar esta transacción, otra conexión prueba los mismos candados sin esperar.
      const c = await admin.connect();
      try {
        await c.query("begin");
        const { rows } = await c.query<{ ok: boolean }>(
          "select pg_try_advisory_xact_lock(hashtextextended('cobros-de-unidad:' || $1::text, 0)) as ok",
          [uf2],
        );
        expect(rows[0]!.ok).toBe(true);
        await c.query("set local lock_timeout = '1s'");
        await c.query("select 1 from periodo_expensa where id = $1 for no key update", [febrero]);
        await c.query("rollback");
      } finally {
        c.release();
      }
    });
  });
});

describe("un gasto extraordinario sin respaldo de asamblea bloquea el mes (maqueta T2)", () => {
  it("la vista previa lo muestra como lo que bloquea, y emitir lo rechaza sin emitir nada", async () => {
    const febrero = await escenario();
    const { rows: c } = await admin.query<{ id: string }>(
      "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Obra del portón', 'extraordinaria', 'sin_clasificar') returning id",
      [barrio()],
    );
    await admin.query(
      `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto, sin_respaldo_asamblea, motivo_sin_respaldo)
       values ($1, $2, $3, 'Reparación de urgencia del portón', '600.00', true, 'Urgencia: se rompió el motor')`,
      [barrio(), febrero, c[0]!.id],
    );
    try {
      const vista = await como(adminB(), (tx) => boletasDelMes(tx, { periodoId: febrero }));
      expect(vista.estado).toBe("bloqueada");
      if (vista.estado === "bloqueada") expect(vista.motivo).toMatch(/«Reparación de urgencia del portón» es extraordinario y no tiene respaldo de asamblea/);
      const faltas = await como(adminB(), (tx) => loQueFaltaDelMes(tx, { periodoId: febrero, vista }));
      expect(faltas[0]).toMatchObject({ tipo: "bloquea", donde: "gastos" });
      const e = await capturar(() => como(adminB(), (tx) => emitirMes(tx, { periodoId: febrero })));
      expect(e.codigo).toBe("periodo_incompleto");
      expect(await estadoDe(febrero)).toBe("borrador");
    } finally {
      await admin.query("set session_replication_role = replica");
      await admin.query("delete from gasto_periodo where concepto_id = $1", [c[0]!.id]);
      await admin.query("delete from concepto where id = $1", [c[0]!.id]);
      await admin.query("set session_replication_role = origin");
    }
  });
});
