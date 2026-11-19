/**
 * Encargo F6 tramo 1 (BL-056), contra Postgres real (`0101`): **el saldo a favor se aplica en la boleta
 * siguiente**. Lo que sobra de un pago se imputa al emitir el mes, con el orden del barrio. Cada número
 * al centavo, sobre un caso que se sigue a mano.
 *
 * El barrio: diez unidades con coeficiente 0,1, sin interés por mora (la pasada de interés no imputa nada)
 * y orden de interés «capital primero». Abril cuesta **$ 200.000 por unidad** ($ 2.000.000 de gasto) y
 * cada mes desde mayo **$ 250.000** ($ 2.500.000). Cada mes vence el día 10.
 *
 * El 20/04 la unidad 1 y la unidad 6 pasan abril a un plan del catálogo de 2 cuotas fijas sin interés:
 * **$ 200.000 → 2 cuotas de $ 100.000**, que vencen el 10/05 y el 10/06 (el mismo día que la expensa).
 * La de la unidad 6 la **cobra el estudio**.
 *
 *   · Unidad 1 (el ejemplo del titular): debe la cuota 1 y mayo, $ 350.000, y paga $ 400.000. Quedan
 *     $ 50.000 a favor, que al emitir junio van a la cuota 2 (vence el mismo día que la expensa: primero
 *     la cuota). La boleta de junio queda pagada en parte.
 *   · Unidad 2: debe abril y mayo, $ 450.000, y paga $ 1.000.000. Quedan $ 550.000: junio se cubre entero
 *     y sobran $ 300.000, que siguen a favor.
 *   · Unidad 3: paga abril y mayo justo, y el 01/06 —antes de que se emita junio— paga $ 100.000 más.
 *   · Unidad 4: paga abril y mayo justo y trae $ 30.000 a favor de la activación.
 *   · Unidad 5: el caso «a elección de quien registra», en septiembre.
 *   · Unidad 6: debe la cuota 1 (del estudio) y mayo, y paga $ 400.000: $ 250.000 a mayo y $ 150.000 a
 *     favor, que al emitir junio van a la expensa y nunca a una cuota del estudio.
 * Julio se emite con el barrio en «No se aplica solo»; agosto, de nuevo en «Se aplica en la boleta siguiente».
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { nuevoToken } from "@admin-barrios/almacenamiento";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import type { OrdenElegibleAlRegistrar } from "@admin-barrios/shared/planes";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { registrarEImputarPago } from "../src/servicios/deuda.ts";
import { anularPago } from "../src/servicios/pagos.ts";
import { registroPorDefecto } from "@admin-barrios/documentos/cobranza";
import { armarVistasDelPeriodo } from "../src/servicios/vista-boleta.ts";
import { boletasDelMes } from "../src/servicios/circuito-del-mes.ts";
import { listarSaldosUF } from "../src/servicios/cobros.ts";
import { agregarEstudio, cambiarEstudioDelBarrio } from "../src/servicios/mora.ts";
import { crearPlanDeCatalogo } from "../src/servicios/planes.ts";
import { guardarReglasDePlanes } from "../src/servicios/planes-configuracion.ts";
import { borrarArbol, borrarParametrosDe, cargarParametro, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf: string[];
let conceptoId: string;
let catalogoEnBoleta: string;
const periodoDe = new Map<string, string>(); // periodo → id
const liqDe = new Map<string, string>(); // `${unidad}:${periodo}` → liquidación
const pagoDe = new Map<string, string>(); // caso → pago

const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminA = () => arbol.usuarios.adminEstudioA;
const CUIT = "30710000162";

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

async function emitirMes(periodo: string, vencimiento: string, gasto: string): Promise<void> {
  const { rows } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, $2, $3) returning id",
    [barrio(), periodo, vencimiento],
  );
  const periodoId = rows[0]!.id;
  periodoDe.set(periodo, periodoId);
  await admin.query("insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', $4)", [
    barrio(),
    periodoId,
    conceptoId,
    gasto,
  ]);
  await como(adminA(), (tx) => generarLiquidaciones(tx, { periodoId }));
  await como(adminA(), (tx) => emitirPeriodo(tx, { periodoId }));
  const { rows: l } = await admin.query<{ id: string; unidad_funcional_id: string }>("select id, unidad_funcional_id from liquidacion where periodo_id = $1", [
    periodoId,
  ]);
  for (const x of l) liqDe.set(`${x.unidad_funcional_id}:${periodo}`, x.id);
}

const pagarPorExtracto = async (unidad: string, monto: string, fecha: string) =>
  (
    await como(adminA(), (tx) =>
      registrarEImputarPago(tx, {
        pago: { unidadFuncionalId: unidad, obligadoId: null, monto, fecha, origen: "extracto", comprobanteAdjunto: null },
        confirmarPagoConInteres: true,
        noCobrarInteres: null,
      }),
    )
  ).id;

const pagarAMano = async (unidad: string, monto: string, fecha: string, ordenPlanElegido: OrdenElegibleAlRegistrar | null) =>
  (
    await como(adminA(), (tx) =>
      registrarEImputarPago(tx, {
        pago: {
          unidadFuncionalId: unidad,
          obligadoId: null,
          monto,
          fecha,
          origen: "manual",
          comprobanteAdjunto: `barrios/${barrio()}/pagos/comprobantes/${nuevoToken()}.pdf`,
          ordenPlanElegido,
        },
        confirmarPagoConInteres: true,
        noCobrarInteres: null,
      }),
    )
  ).id;

/**
 * A qué fue el pago: por cada liquidación, cuánto. Una expensa se nombra por su mes (`2026-06`); una
 * cuota, por su número (`cuota 2`). (Las imputaciones de un mismo pago pueden compartir `created_at`:
 * el orden de las filas no dice nada; lo dicen los importes.)
 */
async function adondeFue(pagoId: string): Promise<Record<string, string>> {
  const { rows } = await admin.query<{ clave: string; monto: string }>(
    `select coalesce('cuota ' || (select pc.numero from plan_cuota pc where pc.liquidacion_id = l.id), pe.periodo) as clave,
            sum(pi.monto_imputado)::text as monto
       from pago_imputacion pi join liquidacion l on l.id = pi.liquidacion_id join periodo_expensa pe on pe.id = l.periodo_id
      where pi.pago_id = $1 and pi.anulado_at is null
      group by 1`,
    [pagoId],
  );
  return Object.fromEntries(rows.map((r) => [r.clave, r.monto]));
}

/** Lo que le queda al pago sin imputar: su saldo a favor. */
async function sobra(pagoId: string): Promise<string> {
  const { rows } = await admin.query<{ sobra: string }>(
    `select (p.monto - coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = p.id and anulado_at is null), 0)
                     - coalesce((select sum(monto_imputado) from pago_imputacion_interes where pago_id = p.id and anulado_at is null), 0))::text as sobra
       from pago p where p.id = $1`,
    [pagoId],
  );
  return rows[0]!.sobra;
}

const saldo = async (liquidacionId: string) =>
  (await admin.query<{ saldo: string }>("select app.saldo_de_liquidacion($1)::text as saldo", [liquidacionId])).rows[0]!.saldo;

/** La liquidación de la cuota `numero` del plan de la unidad. */
async function cuota(unidad: string, numero: number): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "select pc.liquidacion_id as id from plan_cuota pc join plan_pago pp on pp.id = pc.plan_id where pp.unidad_funcional_id = $1 and pc.numero = $2",
    [unidad, numero],
  );
  return rows[0]!.id;
}

const imputacionesDelBarrio = async () =>
  (
    await admin.query<{ n: string; total: string }>(
      `select count(*)::text as n, coalesce(sum(pi.monto_imputado), 0)::text as total
         from pago_imputacion pi join pago p on p.id = pi.pago_id where p.barrio_id = $1 and pi.anulado_at is null`,
      [barrio()],
    )
  ).rows[0]!;

/** Las boletas de un mes emitido, de la grilla del mes (`boletasDelMes`). */
async function boletasEmitidas(periodoId: string) {
  const r = await como(adminA(), (tx) => boletasDelMes(tx, { periodoId }));
  if (r.estado !== "emitida") throw new Error(`el mes no está emitido: ${r.estado}`);
  return r;
}

const paraRevisar = async (pagoId: string) =>
  (await admin.query<{ marca: boolean }>("select imputacion_para_revisar as marca from pago where id = $1", [pagoId])).rows[0]!.marca;

async function limpiar(): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["plan_evento", "plan_cuota", "plan_liquidacion", "plan_pago", "plan_parametro_barrio_historia", "plan_parametro_barrio", "plan_catalogo_barrio",
      "saldo_a_favor_boleta", "estudio_barrio", "interes_condonacion", "pago_imputacion_interes", "pago_imputacion", "interes_devengado", "saldo_uf", "pago", "item_liquidacion",
      "liquidacion", "gasto_periodo", "periodo_expensa", "concepto", "coeficiente", "coeficiente_version", "unidad_funcional"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("delete from plan_catalogo where administracion_id = $1", [arbol.adminA.id]);
    await c.query("delete from plan_parametro_administracion_historia where administracion_id = $1", [arbol.adminA.id]);
    await c.query("delete from plan_parametro_administracion where administracion_id = $1", [arbol.adminA.id]);
    await c.query("delete from estudio_administracion where administracion_id = $1", [arbol.adminA.id]);
    await c.query("delete from estudio_juridico where cuit = $1", [CUIT]);
    await c.query("commit");
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, barrio(), { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  await limpiar();
  await borrarParametrosDe(admin, [barrio()]);
  const n = barrio();
  await cargarParametro(admin, n, "interes.cobra", false);
  await cargarParametro(admin, n, "imputacion.orden", "capital_primero");
  const { rows: ufs } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
     select $1, '8', g::text, 'construido' from generate_series(1, 10) g order by g returning id`,
    [n],
  );
  uf = ufs.map((r) => r.id);
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [n],
  );
  for (const u of uf) {
    await admin.query("insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1, $2, $3, 0.1)", [n, v[0]!.id, u]);
  }
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
  const { rows: c } = await admin.query<{ id: string }>(
    "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
    [n],
  );
  conceptoId = c[0]!.id;

  const estudio = (
    await como(adminA(), (tx) =>
      agregarEstudio(tx, {
        administracionId: arbol.adminA.id,
        nombre: "Estudio del Saldo",
        cuit: CUIT,
        correoAvisos: `${CUIT}@estudio.test`,
        telefonoBoleta: "(0351) 555-0162",
        preferenciaAviso: "cada_derivacion",
      }),
    )
  ).estudioId;
  await como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: n, estudioId: estudio, accion: "sumar" }));
  const k = await como(adminA(), (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into plan_catalogo (administracion_id, nombre, sistema, tasa_mensual, cuotas_min, cuotas_max, estudio_id, modo_cobro, creado_por)
      values (${arbol.adminA.id}, 'Dos cuotas en la boleta', 'fija', 0, 2, 6, null, 'barrio', app.current_user_id()),
             (${arbol.adminA.id}, 'Dos cuotas con el estudio', 'fija', 0, 2, 6, ${estudio}, 'estudio', app.current_user_id())
      returning id`),
  );
  const [enBoleta, conEstudio] = [k.rows[0]!.id, k.rows[1]!.id];
  catalogoEnBoleta = enBoleta;
  for (const id of [enBoleta, conEstudio]) {
    await como(adminA(), (tx) => tx.execute(sql`insert into plan_catalogo_barrio (catalogo_id, barrio_id) values (${id}, ${n})`));
  }

  await emitirMes("2026-04", "2026-04-10", "2000000.00");
  for (const [unidad, catalogoId] of [
    [uf[0]!, enBoleta],
    [uf[5]!, conEstudio],
    // [tramo 2] Dos más con el plan en la boleta, para la cuota que el crédito cubre entera (code-reviewer, B1).
    [uf[7]!, enBoleta],
    [uf[8]!, enBoleta],
  ] as const) {
    await como(adminA(), (tx) =>
      crearPlanDeCatalogo(tx, {
        unidadFuncionalId: unidad,
        liquidacionIds: [liqDe.get(`${unidad}:2026-04`)!],
        catalogoId,
        cuotas: 2,
        primerVencimiento: "2026-05-10",
        fecha: "2026-04-20",
      }),
    );
  }
  await emitirMes("2026-05", "2026-05-10", "2500000.00");
});

afterAll(async () => {
  await limpiar();
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query("delete from barrio where barrio_id = $1", [barrio()]);
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarParametrosDe(admin, [barrio()]);
  await borrarArbol(admin, arbol);
  await appPool.end();
  await admin.end();
});

// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("la regla", () => {
  it("una administración nueva nace con «Se aplica en la boleta siguiente», y el barrio sin valor propio la hereda", async () => {
    const { rows } = await admin.query<{ adm: string; barrio: string }>(
      `select (select x.valor #>> '{}' from app.parametro_resuelto_interno($1, 'saldo_a_favor.aplicacion', current_date) x) as adm,
              app.saldo_a_favor_del_barrio($2, current_date) as barrio`,
      [arbol.adminA.id, barrio()],
    );
    expect(rows[0]).toEqual({ adm: "boleta_siguiente", barrio: "boleta_siguiente" });
  });

  it("la base solo acepta los dos valores", async () => {
    await expect(admin.query(`select app.validar_parametro('saldo_a_favor.aplicacion', '"manual"')`)).resolves.toBeDefined();
    await expect(admin.query(`select app.validar_parametro('saldo_a_favor.aplicacion', '"cuando_quiera"')`)).rejects.toThrow(/boleta siguiente/);
  });
});

describe("al emitir junio, con «Se aplica en la boleta siguiente»", () => {
  let antes: Awaited<ReturnType<typeof imputacionesDelBarrio>>;

  beforeAll(async () => {
    pagoDe.set("ejemplo", await pagarPorExtracto(uf[0]!, "400000.00", "2026-05-15"));
    pagoDe.set("mayor", await pagarPorExtracto(uf[1]!, "1000000.00", "2026-05-15"));
    await pagarPorExtracto(uf[2]!, "450000.00", "2026-05-15");
    await pagarPorExtracto(uf[3]!, "450000.00", "2026-05-15");
    pagoDe.set("estudio", await pagarPorExtracto(uf[5]!, "400000.00", "2026-05-15"));
    pagoDe.set("antes", await pagarPorExtracto(uf[2]!, "100000.00", "2026-06-01"));
    // [tramo 2] Unidad 8: cuota 1 + mayo (350.000) y paga 470.000: quedan 120.000, que cubren la cuota 2 entera
    // (la última: el plan se cumple) y 20.000 de junio. Unidad 9: paga 700.000: quedan 350.000, justo
    // la cuota 2 y junio.
    pagoDe.set("cuotaEntera", await pagarPorExtracto(uf[7]!, "470000.00", "2026-05-15"));
    pagoDe.set("justo", await pagarPorExtracto(uf[8]!, "700000.00", "2026-05-15"));
    // El saldo a favor de la activación, como lo deja `app.cargar_deuda_historica` (un cobro sin imputar
    // de origen `activacion`, sin comprobante y con la firma de quien subió la planilla).
    // La fila se escribe directo (sin los triggers que exigen que la escriba esa función con una sesión);
    // el saldo a favor de la activación por el camino real lo prueba `encargo-17.test.ts`.
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      const { rows } = await c.query<{ id: string }>(
        `insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen, usuario_registrador)
         values ($1, $2, 30000.00, '2026-04-01', 'activacion', $3) returning id`,
        [barrio(), uf[3]!, adminA()],
      );
      await c.query("commit");
      pagoDe.set("activacion", rows[0]!.id);
    } finally {
      c.release();
    }
    antes = await imputacionesDelBarrio();
    await emitirMes("2026-06", "2026-06-10", "2500000.00");
  });

  it("el ejemplo del titular: cuota 100.000 + expensa 250.000, paga 400.000; los 50.000 que sobran van a la boleta de junio", async () => {
    const id = pagoDe.get("ejemplo")!;
    // Mayo: la cuota 1 y la expensa vencen el mismo día; la cuota primero. Junio: lo mismo con la cuota 2.
    expect(await adondeFue(id)).toEqual({ "cuota 1": "100000.00", "2026-05": "250000.00", "cuota 2": "50000.00" });
    expect(await sobra(id)).toBe("0.00");
    // Lo de junio queda pagado en parte: la cuota 2 debe 50.000 y la expensa, entera.
    expect(await saldo(await cuota(uf[0]!, 2))).toBe("50000.00");
    expect(await saldo(liqDe.get(`${uf[0]!}:2026-06`)!)).toBe("250000.00");
  });

  it("un crédito mayor que lo del mes: junio queda cubierto y el resto sigue a favor", async () => {
    const id = pagoDe.get("mayor")!;
    expect(await adondeFue(id)).toEqual({ "2026-04": "200000.00", "2026-05": "250000.00", "2026-06": "250000.00" });
    expect(await saldo(liqDe.get(`${uf[1]!}:2026-06`)!)).toBe("0.00");
    expect(await sobra(id)).toBe("300000.00");
  });

  it("un pago registrado antes de la emisión: no tenía a qué ir y se aplica al emitir", async () => {
    const id = pagoDe.get("antes")!;
    expect(await adondeFue(id)).toEqual({ "2026-06": "100000.00" });
    expect(await saldo(liqDe.get(`${uf[2]!}:2026-06`)!)).toBe("150000.00");
    expect(await sobra(id)).toBe("0.00");
  });

  it("el saldo a favor de la activación también se aplica", async () => {
    const id = pagoDe.get("activacion")!;
    expect(await adondeFue(id)).toEqual({ "2026-06": "30000.00" });
    expect(await saldo(liqDe.get(`${uf[3]!}:2026-06`)!)).toBe("220000.00");
    expect(await sobra(id)).toBe("0.00");
  });

  it("la cuota que cobra el estudio sigue sin imputarse: el crédito va solo a la expensa", async () => {
    const id = pagoDe.get("estudio")!;
    expect(await adondeFue(id)).toEqual({ "2026-05": "250000.00", "2026-06": "150000.00" });
    expect(await saldo(liqDe.get(`${uf[5]!}:2026-06`)!)).toBe("100000.00");
    expect(await saldo(await cuota(uf[5]!, 1))).toBe("100000.00");
    expect(await saldo(await cuota(uf[5]!, 2))).toBe("100000.00");
    expect(await sobra(id)).toBe("0.00");
  });

  it("la emisión agregó exactamente lo que se aplicó: 50.000 + 250.000 + 100.000 + 30.000 + 150.000 + 120.000 + 350.000", async () => {
    const despues = await imputacionesDelBarrio();
    // Una imputación por unidad, y dos en las unidades 8 y 9 (la cuota 2 y junio).
    expect(Number(despues.n) - Number(antes.n)).toBe(9);
    expect((BigInt(despues.total.replace(".", "")) - BigInt(antes.total.replace(".", ""))).toString()).toBe("105000000"); // $ 1.050.000,00
  });

  it("volver a aplicar no imputa dos veces, y el mes no se vuelve a emitir", async () => {
    const antesDeRepetir = await imputacionesDelBarrio();
    await como(adminA(), (tx) => tx.execute(sql`select app.aplicar_saldo_a_favor_al_emitir(${periodoDe.get("2026-06")!}::uuid)`));
    const e = await capturar(() => como(adminA(), (tx) => emitirPeriodo(tx, { periodoId: periodoDe.get("2026-06")! })));
    expect(e.codigo).toBeDefined();
    expect(await imputacionesDelBarrio()).toEqual(antesDeRepetir);
    expect(await sobra(pagoDe.get("mayor")!)).toBe("300000.00");
  });

  it("[tramo 2] la boleta de junio de la unidad 1: expensa 250.000 + cuota 100.000 − saldo a favor 50.000 = 300.000", async () => {
    const periodoId = periodoDe.get("2026-06")!;
    const { rows } = await admin.query("select modo, aplicado::text, aplicado_en_cupon::text as en_cupon, aplicado_a_cuotas::text as a_cuotas, queda::text from app.saldo_a_favor_de_boleta($1, $2)", [periodoId, uf[0]!]);
    expect(rows).toEqual([{ modo: "boleta_siguiente", aplicado: "50000.00", en_cupon: "50000.00", a_cuotas: "50000.00", queda: "0.00" }]);
    // La grilla del mes: la cuota entera, el crédito aparte y lo que se cobra, neto.
    const b = await boletasEmitidas(periodoId);
    expect(b.boletas.find((x) => x.unidadFuncionalId === uf[0]!)).toMatchObject({ cuotaDelPlan: "100000.00", saldoAFavorAplicado: "50000.00", saldoAFavorQueda: "0.00", aPagar: "300000.00" });
    // La boleta (PDF): la cuota entera, el renglón del crédito y el bloque de pago por el neto.
    const [v] = await como(adminA(), (tx) => armarVistasDelPeriodo(tx, periodoId, { registro: registroPorDefecto(), liquidacionIds: [liqDe.get(`${uf[0]!}:2026-06`)!] }));
    expect(v!.planDePagos?.cuotas.map((c) => c.importe.monto)).toEqual(["100000.00"]);
    expect(v!.planDePagos?.aPagarConLaCuota?.monto).toBe("350000.00");
    expect(v!.saldoAFavor).toMatchObject({ modo: "boleta_siguiente", aplicado: { monto: "50000.00" }, totalAPagar: { monto: "300000.00" }, queda: { monto: "0.00" } });
    expect(v!.bloquePago.importes.alVencimiento.monto).toBe("300000.00");
  });

  it("[tramo 2] un crédito mayor que el mes: la boleta cobra $ 0 y dice que quedan 300.000 para el mes siguiente", async () => {
    const periodoId = periodoDe.get("2026-06")!;
    const b = await boletasEmitidas(periodoId);
    expect(b.boletas.find((x) => x.unidadFuncionalId === uf[1]!)).toMatchObject({ saldoAFavorAplicado: "250000.00", saldoAFavorQueda: "300000.00", aPagar: "0.00" });
    const [v] = await como(adminA(), (tx) => armarVistasDelPeriodo(tx, periodoId, { registro: registroPorDefecto(), liquidacionIds: [liqDe.get(`${uf[1]!}:2026-06`)!] }));
    expect(v!.saldoAFavor).toMatchObject({ aplicado: { monto: "250000.00" }, totalAPagar: { monto: "0.00" }, queda: { monto: "300000.00" } });
    expect(v!.bloquePago.importes.alVencimiento.monto).toBe("0.00");
    // Cobros: la unidad 2 sigue con 300.000 a favor; la 1, con nada.
    const s = await como(adminA(), (tx) => listarSaldosUF(tx, { barrioId: barrio() }));
    expect(s.saldos.find((x) => x.unidadFuncionalId === uf[1]!)?.aFavor).toBe("300000.00");
    expect(s.saldos.find((x) => x.unidadFuncionalId === uf[0]!)?.aFavor).toBe("0.00");
  });

  it("[tramo 2] una cuota que el crédito cubre entera (la última del plan) sigue en la boleta: 250.000 + 100.000 − 120.000 = 230.000", async () => {
    const periodoId = periodoDe.get("2026-06")!;
    expect(await adondeFue(pagoDe.get("cuotaEntera")!)).toEqual({ "cuota 1": "100000.00", "2026-05": "250000.00", "cuota 2": "100000.00", "2026-06": "20000.00" });
    const { rows } = await admin.query<{ estado: string }>("select estado from plan_pago where unidad_funcional_id = $1", [uf[7]!]);
    expect(rows[0]!.estado).toBe("cumplido");
    const b = await boletasEmitidas(periodoId);
    expect(b.boletas.find((x) => x.unidadFuncionalId === uf[7]!)).toMatchObject({ cuotaDelPlan: "100000.00", saldoAFavorAplicado: "120000.00", aPagar: "230000.00" });
    const [v] = await como(adminA(), (tx) => armarVistasDelPeriodo(tx, periodoId, { registro: registroPorDefecto(), liquidacionIds: [liqDe.get(`${uf[7]!}:2026-06`)!] }));
    expect(v!.planDePagos?.cuotas.map((c) => c.importe.monto)).toEqual(["100000.00"]);
    expect(v!.saldoAFavor).toMatchObject({ aplicado: { monto: "120000.00" }, totalAPagar: { monto: "230000.00" } });
    expect(v!.bloquePago.importes.alVencimiento.monto).toBe("230000.00");
    // Lo que de verdad debe la unidad: junio menos los 20.000.
    expect(await saldo(liqDe.get(`${uf[7]!}:2026-06`)!)).toBe("230000.00");
  });

  it("[tramo 2] un crédito igual a la expensa más la cuota: la boleta cobra $ 0 y no un negativo", async () => {
    const periodoId = periodoDe.get("2026-06")!;
    const b = await boletasEmitidas(periodoId);
    expect(b.boletas.find((x) => x.unidadFuncionalId === uf[8]!)).toMatchObject({ cuotaDelPlan: "100000.00", saldoAFavorAplicado: "350000.00", aPagar: "0.00" });
    const [v] = await como(adminA(), (tx) => armarVistasDelPeriodo(tx, periodoId, { registro: registroPorDefecto(), liquidacionIds: [liqDe.get(`${uf[8]!}:2026-06`)!] }));
    expect(v!.saldoAFavor).toMatchObject({ aplicado: { monto: "350000.00" }, totalAPagar: { monto: "0.00" }, queda: { monto: "0.00" } });
    expect(v!.bloquePago.importes.alVencimiento.monto).toBe("0.00");
  });

  it("aplicarlo fuera de la emisión de un mes se rechaza", async () => {
    const { rows } = await admin.query<{ id: string }>("select id from periodo_expensa where barrio_id = $1 and origen = 'plan' limit 1", [barrio()]);
    await expect(como(adminA(), (tx) => tx.execute(sql`select app.aplicar_saldo_a_favor_al_emitir(${rows[0]!.id}::uuid)`))).rejects.toThrow(/al emitir un mes/);
  });
});

describe("con «No se aplica solo», la emisión no toca el crédito", () => {
  it("julio se emite y los 300.000 de la unidad 2 siguen en el pago", async () => {
    await cargarParametro(admin, barrio(), "saldo_a_favor.aplicacion", "manual");
    const antes = await imputacionesDelBarrio();
    await emitirMes("2026-07", "2026-07-10", "2500000.00");
    expect(await imputacionesDelBarrio()).toEqual(antes);
    expect(await saldo(liqDe.get(`${uf[1]!}:2026-07`)!)).toBe("250000.00");
    expect(await sobra(pagoDe.get("mayor")!)).toBe("300000.00");
    // [tramo 2] La boleta de julio informa los 300.000 a favor y no los resta.
    const periodoId = periodoDe.get("2026-07")!;
    const { rows } = await admin.query("select modo, aplicado::text, queda::text from app.saldo_a_favor_de_boleta($1, $2)", [periodoId, uf[1]!]);
    expect(rows).toEqual([{ modo: "manual", aplicado: "0.00", queda: "300000.00" }]);
    const [v] = await como(adminA(), (tx) => armarVistasDelPeriodo(tx, periodoId, { registro: registroPorDefecto(), liquidacionIds: [liqDe.get(`${uf[1]!}:2026-07`)!] }));
    expect(v!.saldoAFavor).toMatchObject({ modo: "manual", aplicado: { monto: "0.00" }, totalAPagar: { monto: "250000.00" }, queda: { monto: "300000.00" } });
    expect(v!.bloquePago.importes.alVencimiento.monto).toBe("250000.00");
  });

  it("de vuelta en «Se aplica en la boleta siguiente», agosto lo aplica: julio entero (más viejo) y 50.000 de agosto", async () => {
    await cargarParametro(admin, barrio(), "saldo_a_favor.aplicacion", "boleta_siguiente");
    // [tramo 2] Desde agosto el cupón cobra solo el mes: julio es deuda de antes, fuera del cupón.
    await cargarParametro(admin, barrio(), "cupon.cobra", "solo_mes", "2026-08-01");
    await emitirMes("2026-08", "2026-08-10", "2500000.00");
    const id = pagoDe.get("mayor")!;
    expect(await adondeFue(id)).toEqual({
      "2026-04": "200000.00",
      "2026-05": "250000.00",
      "2026-06": "250000.00",
      "2026-07": "250000.00",
      "2026-08": "50000.00",
    });
    expect(await saldo(liqDe.get(`${uf[1]!}:2026-08`)!)).toBe("200000.00");
    expect(await sobra(id)).toBe("0.00");
    // [tramo 2] Con «solo el mes»: el cupón es agosto (250.000). De los 300.000, 250.000 cubrieron julio (no
    // bajan el cupón) y 50.000, agosto: la boleta cobra 200.000. Este barrio no arrastra la deuda en la
    // boleta (saldo anterior «sin movimientos»): lo que el cupón no cobra es 0 y lo que sigue adeudado,
    // también (nunca negativo); lo cubierto de julio se dice en una línea.
    const [v] = await como(adminA(), (tx) => armarVistasDelPeriodo(tx, periodoDe.get("2026-08")!, { registro: registroPorDefecto(), liquidacionIds: [liqDe.get(`${uf[1]!}:2026-08`)!] }));
    expect(v!.cupon).toMatchObject({ modo: "solo_mes", importe: { monto: "250000.00" }, deudaNoIncluida: { monto: "0.00" } });
    expect(v!.saldoAFavor).toMatchObject({
      aplicado: { monto: "50000.00" },
      aplicadoADeudaAnterior: { monto: "250000.00" },
      deudaAnteriorQueda: { monto: "0.00" },
      totalAPagar: { monto: "200000.00" },
    });
    expect(v!.bloquePago.importes.alVencimiento.monto).toBe("200000.00");
    // La deuda de antes ya no se avisa: el crédito la cubrió.
    expect(v!.bandas.some((b) => b.clave === "saldo_anterior")).toBe(false);
  });
});

describe("«A elección de quien registra»", () => {
  it("al emitir, la más vieja primero aunque quien registró eligiera la cuota, y el pago queda «para revisar»", async () => {
    // La unidad 5 pasa abril a un plan: 2 cuotas de 100.000 que vencen el 20/09 y el 20/10.
    await como(adminA(), (tx) =>
      crearPlanDeCatalogo(tx, {
        unidadFuncionalId: uf[4]!,
        liquidacionIds: [liqDe.get(`${uf[4]!}:2026-04`)!],
        catalogoId: catalogoEnBoleta,
        cuotas: 2,
        primerVencimiento: "2026-09-20",
        fecha: "2026-08-25",
      }),
    );
    await como(adminA(), (tx) =>
      guardarReglasDePlanes(tx, { barrioId: barrio(), cuotasParaCaer: "2", ordenImputacion: "a_eleccion", financiaMora: "no", quitaRequiereActa: "no" }),
    );
    // Debe mayo a agosto, 1.000.000, y paga 1.040.000 eligiendo «primero la cuota» (todavía no hay ninguna emitida).
    const id = await pagarAMano(uf[4]!, "1040000.00", "2026-08-28", "cuota_primero");
    expect(await sobra(id)).toBe("40000.00");
    expect(await paraRevisar(id)).toBe(false);

    // Septiembre: la expensa vence el 10/09 y la cuota 1, el 20/09. Con la elección, irían a la cuota;
    // al emitir nadie elige: la más vieja, la expensa.
    await emitirMes("2026-09", "2026-09-10", "2500000.00");
    expect(await adondeFue(id)).toEqual({
      "2026-05": "250000.00",
      "2026-06": "250000.00",
      "2026-07": "250000.00",
      "2026-08": "250000.00",
      "2026-09": "40000.00",
    });
    expect(await saldo(await cuota(uf[4]!, 1))).toBe("100000.00");
    expect(await saldo(liqDe.get(`${uf[4]!}:2026-09`)!)).toBe("210000.00");
    expect(await paraRevisar(id)).toBe(true);
  });
});

describe("anular un pago cuyo sobrante ya se aplicó al emitir", () => {
  it("se anulan con él también las imputaciones de la emisión, y la boleta vuelve a deber lo que debía", async () => {
    // La unidad 3: los 100.000 que pagó el 01/06 se aplicaron a junio al emitir (junio quedó en 150.000).
    const id = pagoDe.get("antes")!;
    await como(adminA(), (tx) => anularPago(tx, { pagoId: id, motivo: "Prueba: el pago se anula entero." }));
    expect(await adondeFue(id)).toEqual({});
    expect(await saldo(liqDe.get(`${uf[2]!}:2026-06`)!)).toBe("250000.00");
    // [tramo 2] La boleta de junio deja de restar ese crédito: vuelve a cobrar los 250.000.
    const [v] = await como(adminA(), (tx) => armarVistasDelPeriodo(tx, periodoDe.get("2026-06")!, { registro: registroPorDefecto(), liquidacionIds: [liqDe.get(`${uf[2]!}:2026-06`)!] }));
    expect(v!.saldoAFavor).toMatchObject({ aplicado: { monto: "0.00" }, totalAPagar: { monto: "250000.00" } });
    expect(v!.bloquePago.importes.alVencimiento.monto).toBe("250000.00");
    const b = await boletasEmitidas(periodoDe.get("2026-06")!);
    expect(b.boletas.find((x) => x.unidadFuncionalId === uf[2]!)).toMatchObject({ saldoAFavorAplicado: "0.00", aPagar: "250000.00" });
  });
});

describe("un barrio sin orden de imputación (una administración migrada que todavía no lo fijó)", () => {
  it("la emisión sale igual: el pago sin orden a su fecha se saltea y su sobrante queda como estaba", async () => {
    // La unidad 7 debe abril a septiembre (1.450.000) y paga 1.500.000: sobran 50.000.
    const id = await pagarPorExtracto(uf[6]!, "1500000.00", "2026-09-25");
    expect(await sobra(id)).toBe("50000.00");
    // Sin `imputacion.orden` ni en el barrio ni en la administración (como dejó `0057` §7 a algunas migradas).
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("delete from parametro_valor where clave = 'imputacion.orden' and nodo_id = any($1::uuid[])", [[barrio(), arbol.adminA.id]]);
      await c.query("commit");
    } finally {
      c.release();
    }
    try {
      await emitirMes("2026-10", "2026-10-10", "2500000.00");
      expect(await sobra(id)).toBe("50000.00");
      expect(await saldo(liqDe.get(`${uf[6]!}:2026-10`)!)).toBe("250000.00");
      expect(await paraRevisar(id)).toBe(false);
    } finally {
      await cargarParametro(admin, barrio(), "imputacion.orden", "capital_primero");
    }
  });
});
