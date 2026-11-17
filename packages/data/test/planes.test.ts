/**
 * Encargo P1, contra Postgres real (`0092`, `0093`): el motor de los planes de pago. **Cada número al
 * centavo, sobre un caso que se sigue a mano.**
 *
 * El barrio: cuatro unidades con coeficiente 0,25 y $ 4.000 de gasto por mes, o sea **$ 1.000 por
 * boleta**. Mora del 3 % mensual, sin gracia ni punitoria (`interes = base × 0,03 × días / 30`), y
 * desde el 21/09/2026 del 6 % (el cambio de tasa en el medio de un plan). Orden de imputación:
 * capital primero. Junio vence el 10/06 y julio el 10/07; los meses se emiten sin arrastrar saldo
 * (no cierran tramos), así la mora la cierra solo lo que se prueba.
 *
 * La unidad 1 firma el 20/07/2026 un plan del catálogo de 4 cuotas fijas sin interés con junio y julio:
 *   mora de junio  1.000 × 0,03 × 40/30 = 40,00   (10/06 → 20/07)
 *   mora de julio  1.000 × 0,03 × 10/30 = 10,00   (10/07 → 20/07)
 *   deuda que entra 2.050,00  →  4 cuotas de 512,50 (10/08, 10/09, 10/10, 10/11).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { sumarMontos } from "@admin-barrios/shared/dinero";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { deudaALaFecha, registrarEImputarPago, registrarTramos } from "../src/servicios/deuda.ts";
import { anularPago } from "../src/servicios/pagos.ts";
import { crearPlanDeCatalogo, declararCaido, proponerPlanAMedida, aprobarPlan, retirarPlan, saldoTotalDeUnidad } from "../src/servicios/planes.ts";
import { borrarArbol, borrarParametrosDe, cargarParametro, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf: string[];
let conceptoId: string;
let catalogoFijo: string;
let catalogoFrances: string;
const liqDe = new Map<string, string>(); // `${unidad}:${periodo}` → liquidación

const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminA = () => arbol.usuarios.adminEstudioA;

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

/** Un mes de $ 4.000 (= $ 1.000 por unidad), emitido sin arrastrar saldo (no cierra tramos de mora). */
async function emitirMes(periodo: string, vencimiento: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, $2, $3) returning id",
    [barrio(), periodo, vencimiento],
  );
  const periodoId = rows[0]!.id;
  await admin.query("insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '4000.00')", [
    barrio(),
    periodoId,
    conceptoId,
  ]);
  await como(adminA(), (tx) => generarLiquidaciones(tx, { periodoId }));
  await como(adminA(), (tx) => emitirPeriodo(tx, { periodoId }));
  const { rows: l } = await admin.query<{ id: string; unidad_funcional_id: string }>(
    "select id, unidad_funcional_id from liquidacion where periodo_id = $1",
    [periodoId],
  );
  for (const x of l) liqDe.set(`${x.unidad_funcional_id}:${periodo}`, x.id);
  return periodoId;
}

const pagar = (unidad: string, monto: string, fecha: string) =>
  como(adminA(), (tx) =>
    registrarEImputarPago(tx, {
      pago: { unidadFuncionalId: unidad, obligadoId: null, monto, fecha, origen: "extracto", comprobanteAdjunto: null },
      confirmarPagoConInteres: true,
      noCobrarInteres: null,
    }),
  );

async function cuotasDe(planId: string) {
  const { rows } = await admin.query<{ numero: number; vencimiento: string; importe: string; capital: string; interes: string; liquidacion_id: string | null }>(
    "select numero, vencimiento::text, importe::text, capital::text, interes::text, liquidacion_id from plan_cuota where plan_id = $1 order by numero",
    [planId],
  );
  return rows;
}

const estadoDe = async (planId: string) =>
  (await admin.query<{ estado: string }>("select estado from plan_pago where id = $1", [planId])).rows[0]!.estado;

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, barrio(), { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  await crearBarrio(admin, arbol.barrioB1.id);
  await borrarParametrosDe(admin, [barrio()]);
  const n = barrio();
  await cargarParametro(admin, n, "interes.cobra", true);
  await cargarParametro(admin, n, "interes.tasa_compensatoria", "0.03");
  await cargarParametro(admin, n, "interes.tasa_compensatoria", "0.06", "2026-09-21");
  await cargarParametro(admin, n, "interes.tasa_punitoria", "0");
  await cargarParametro(admin, n, "interes.gracia_dias", 0);
  await cargarParametro(admin, n, "interes.forma_gracia", "corre_inicio");
  await cargarParametro(admin, n, "interes.tolerancia", "0.00");
  await cargarParametro(admin, n, "imputacion.orden", "capital_primero");
  const { rows: ufs } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
     select $1, '1', g::text, 'construido' from generate_series(1, 4) g order by g returning id`,
    [n],
  );
  uf = ufs.map((r) => r.id);
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [n],
  );
  for (const u of uf) {
    await admin.query("insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1, $2, $3, 0.25)", [n, v[0]!.id, u]);
  }
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
  const { rows: c } = await admin.query<{ id: string }>(
    "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
    [n],
  );
  conceptoId = c[0]!.id;
  // El catálogo lo carga la administración (con identidad, bajo RLS).
  const k = await como(adminA(), (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into plan_catalogo (administracion_id, nombre, sistema, tasa_mensual, cuotas_min, cuotas_max, creado_por)
      values (${arbol.adminA.id}, 'Hasta 6 cuotas sin interés', 'fija', 0, 2, 6, app.current_user_id()),
             (${arbol.adminA.id}, '12 cuotas al 2 %', 'frances', 0.02, 2, 12, app.current_user_id())
      returning id`),
  );
  [catalogoFijo, catalogoFrances] = [k.rows[0]!.id, k.rows[1]!.id];
  for (const id of [catalogoFijo, catalogoFrances]) {
    await como(adminA(), (tx) => tx.execute(sql`insert into plan_catalogo_barrio (catalogo_id, barrio_id) values (${id}, ${n})`));
  }
  await emitirMes("2026-06", "2026-06-10");
  await emitirMes("2026-07", "2026-07-10");
});

afterAll(async () => {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["plan_evento", "plan_cuota", "plan_liquidacion", "plan_pago", "plan_parametro_barrio", "plan_catalogo_barrio", "interes_condonacion",
      "pago_imputacion_interes", "pago_imputacion", "interes_devengado", "saldo_uf", "pago", "item_liquidacion", "liquidacion", "gasto_periodo",
      "periodo_expensa", "concepto", "coeficiente", "coeficiente_version", "unidad_funcional"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("delete from plan_catalogo where administracion_id = $1", [arbol.adminA.id]);
    await c.query("delete from barrio where barrio_id = any($1::uuid[])", [[barrio(), arbol.barrioB1.id]]);
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

describe("la firma", () => {
  let plan: string;

  it("entra la deuda con su mora a la fecha de firma, al centavo, y la cubre un pago no monetario", async () => {
    plan = (
      await como(adminA(), (tx) =>
        crearPlanDeCatalogo(tx, {
          unidadFuncionalId: uf[0]!,
          liquidacionIds: [liqDe.get(`${uf[0]}:2026-06`)!, liqDe.get(`${uf[0]}:2026-07`)!],
          catalogoId: catalogoFijo,
          cuotas: 4,
          primerVencimiento: "2026-08-10",
          fecha: "2026-07-20",
        }),
      )
    ).planId;
    const { rows } = await admin.query("select estado, deuda_capital::text, deuda_interes::text, total_cuotas::text, fecha_firma::text from plan_pago where id = $1", [plan]);
    expect(rows[0]).toEqual({ estado: "vigente", deuda_capital: "2000.00", deuda_interes: "50.00", total_cuotas: "2050.00", fecha_firma: "2026-07-20" });
    expect((await cuotasDe(plan)).map((c) => [c.vencimiento, c.importe])).toEqual([
      ["2026-08-10", "512.50"],
      ["2026-09-10", "512.50"],
      ["2026-10-10", "512.50"],
      ["2026-11-10", "512.50"],
    ]);
    const { rows: pago } = await admin.query("select monto::text, origen, fecha::text from pago where id = (select pago_firma_id from plan_pago where id = $1)", [plan]);
    expect(pago[0]).toEqual({ monto: "2050.00", origen: "plan", fecha: "2026-07-20" });
    // La mora quedó cerrada a la firma, sobre el capital, y cubierta.
    const { rows: mora } = await admin.query<{ monto: string; base: string; hasta: string }>(
      "select monto::text, base::text, hasta::text from interes_devengado where unidad_funcional_id = $1 order by monto desc",
      [uf[0]],
    );
    expect(mora).toEqual([
      { monto: "40.00", base: "1000.00", hasta: "2026-07-20" },
      { monto: "10.00", base: "1000.00", hasta: "2026-07-20" },
    ]);
  });

  it("ninguna cuota se emite antes de su mes: julio es el último mes emitido", async () => {
    expect((await cuotasDe(plan)).every((c) => c.liquidacion_id === null)).toBe(true);
  });

  it("al emitirse cada mes, sale su cuota (agosto con agosto)", async () => {
    await emitirMes("2026-08", "2026-08-10");
    const c = await cuotasDe(plan);
    expect(c.map((x) => x.liquidacion_id !== null)).toEqual([true, false, false, false]);
    const { rows } = await admin.query("select l.vencimiento::text, l.total::text, pe.origen, pe.periodo from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id where l.id = $1", [
      c[0]!.liquidacion_id,
    ]);
    expect(rows[0]).toEqual({ vencimiento: "2026-08-10", total: "512.50", origen: "plan", periodo: "2026-08" });
  });

  it("la unidad sale de la mora: junio y julio ya no deben nada", async () => {
    const d = (await como(adminA(), (tx) => deudaALaFecha(tx, { barrioId: barrio(), fecha: "2026-08-05", unidadFuncionalId: uf[0]! }))).get(uf[0]!);
    // El 05/08 la única deuda es la expensa de agosto (vence el 10/08): ni junio ni julio, ni la cuota de agosto (todavía no venció).
    expect(d?.porMes.map((m) => [m.periodo, m.origen])).toEqual([["2026-08", "mensual"]]);
  });
});

describe("una cuota que no venció no aparece en ningún saldo", () => {
  it("ni en el mes por mes, ni en la mora, ni en lo vencido", async () => {
    const { rows: c } = await admin.query<{ liquidacion_id: string }>(
      "select liquidacion_id from plan_cuota where numero = 1 and plan_id = (select id from plan_pago where unidad_funcional_id = $1)",
      [uf[0]],
    );
    // Al 09/08, la cuota 1 (vence 10/08) está emitida pero no vencida.
    const d = (await como(adminA(), (tx) => deudaALaFecha(tx, { barrioId: barrio(), fecha: "2026-08-09", unidadFuncionalId: uf[0]! }))).get(uf[0]!);
    expect(d?.porMes.some((m) => m.liquidacionId === c[0]!.liquidacion_id)).toBe(false);
    expect(d?.tramos.some((t) => t.liquidacionId === c[0]!.liquidacion_id)).toBe(false);
    // Al 11/08 ya venció: es deuda, mes por mes.
    const despues = (await como(adminA(), (tx) => deudaALaFecha(tx, { barrioId: barrio(), fecha: "2026-08-11", unidadFuncionalId: uf[0]! }))).get(uf[0]!);
    expect(despues?.porMes.find((m) => m.liquidacionId === c[0]!.liquidacion_id)).toMatchObject({ origen: "plan", capital: "512.50" });
  });
});

describe("la mora corre solo sobre el capital de la cuota impaga", () => {
  it("en una cuota francesa, la base es la amortización, no el interés de financiación", async () => {
    const { planId } = await como(adminA(), (tx) =>
      crearPlanDeCatalogo(tx, {
        unidadFuncionalId: uf[1]!,
        liquidacionIds: [liqDe.get(`${uf[1]}:2026-06`)!, liqDe.get(`${uf[1]}:2026-07`)!],
        catalogoId: catalogoFrances,
        cuotas: 2,
        primerVencimiento: "2026-08-12",
        fecha: "2026-07-20",
      }),
    );
    const c = await cuotasDe(planId);
    // Francés 2 % en 2 cuotas sobre 2.050: cuota = 2.050 × 0,02 / (1 − 1,02⁻²) = 1.055,85. La primera
    // abre en interés 2.050 × 0,02 = 41,00 y capital 1.014,85; la segunda, interés 1.035,15 × 0,02 = 20,70.
    expect(c.map((x) => [x.importe, x.capital, x.interes])).toEqual([
      ["1055.85", "1014.85", "41.00"],
      ["1055.85", "1035.15", "20.70"],
    ]);
    await emitirMes("2026-09", "2026-09-10"); // ya se emitió agosto: esto emite la cuota 2 junto con septiembre.
    const d = (await como(adminA(), (tx) => deudaALaFecha(tx, { barrioId: barrio(), fecha: "2026-08-22", unidadFuncionalId: uf[1]! }))).get(uf[1]!);
    const tramo = d?.tramos.find((t) => t.liquidacionId === c[0]!.liquidacion_id);
    // La base es el capital ORIGINAL de la cuota: 1.014,85 de amortización menos los 50,00 de mora de
    // junio y julio que amortiza (`mora_incluida`): 964,85. Ni la financiación (41,00) ni la mora vieja
    // devengan mora. 964,85 × 0,03 × 10/30 = 9,6485 → 9,64 (el motor trunca).
    const { rows: mi } = await admin.query("select mora_incluida::text from plan_cuota where plan_id = $1 order by numero", [planId]);
    expect(mi.map((x) => x.mora_incluida)).toEqual(["50.00", "0.00"]);
    expect(tramo?.base).toBe("964.85");
    expect(tramo?.resultado).toMatchObject({ interes: "9.64" });
    expect(d?.porMes.find((m) => m.liquidacionId === c[0]!.liquidacion_id)?.capital).toBe("1055.85");
  });
});

describe("la imputación: la cuota primero, sin depender del orden de creación", () => {
  it("una cuota y una expensa del mismo vencimiento se imputan igual las cree quien las cree primero", async () => {
    // Unidad 1 debe la cuota 1 (10/08) y la expensa de agosto (10/08), y la cuota 2 (10/09) y la expensa de
    // septiembre (10/09). Con «cuota primero» (el default), un pago de 512,50 va entero a la cuota 1 —la
    // cuota más vieja, antes que la expensa del mismo vencimiento—. Se prueba con la creación invertida.
    const cuota = (await admin.query<{ liquidacion_id: string }>(
      "select liquidacion_id from plan_cuota where numero = 1 and plan_id = (select id from plan_pago where unidad_funcional_id = $1)",
      [uf[0]],
    )).rows[0]!.liquidacion_id;
    const expensa = liqDe.get(`${uf[0]}:2026-08`)!;
    const imputado = async () =>
      (await admin.query<{ liquidacion_id: string; monto: string }>(
        `select pi.liquidacion_id, pi.monto_imputado::text as monto from pago_imputacion pi join pago p on p.id = pi.pago_id
          where p.unidad_funcional_id = $1 and p.fecha = '2026-09-10' and p.origen = 'extracto' and pi.anulado_at is null`,
        [uf[0]],
      )).rows;
    const c = await admin.connect();
    try {
      for (const invertido of [false, true]) {
        await c.query("begin");
        await c.query("set local session_replication_role = replica");
        if (invertido) {
          await c.query("update liquidacion set created_at = now() - interval '1 day' where id = $1", [cuota]);
          await c.query("update liquidacion set created_at = now() where id = $1", [expensa]);
        } else {
          await c.query("update liquidacion set created_at = now() - interval '1 day' where id = $1", [expensa]);
          await c.query("update liquidacion set created_at = now() where id = $1", [cuota]);
        }
        await c.query("commit");
        const { id: pagoId } = await pagar(uf[0]!, "512.50", "2026-09-10");
        expect(await imputado()).toEqual([{ liquidacion_id: cuota, monto: "512.50" }]);
        await como(adminA(), (tx) => anularPago(tx, { pagoId, motivo: "Prueba del orden de imputación." }));
      }
    } finally {
      c.release();
    }
  });
});

describe("con un plan vigente, lo que cubrió su deuda no se anula", () => {
  it("un pago que imputó a un mes incluido no se anula; el pago del plan, tampoco", async () => {
    const { id: pagoId } = await pagar(uf[2]!, "300.00", "2026-07-01");
    await como(adminA(), (tx) =>
      crearPlanDeCatalogo(tx, {
        unidadFuncionalId: uf[2]!,
        liquidacionIds: [liqDe.get(`${uf[2]}:2026-06`)!, liqDe.get(`${uf[2]}:2026-07`)!],
        catalogoId: catalogoFijo,
        cuotas: 2,
        primerVencimiento: "2026-08-15",
        fecha: "2026-07-20",
      }),
    );
    const e = await capturar(() => como(adminA(), (tx) => anularPago(tx, { pagoId, motivo: "Se cargó mal." })));
    expect(e.codigo).toBe("sin_permiso");
    expect(e.message).toMatch(/plan de pagos vigente/);
    const { rows } = await admin.query<{ id: string }>("select pago_firma_id as id from plan_pago where unidad_funcional_id = $1", [uf[2]]);
    const e2 = await capturar(() => como(adminA(), (tx) => anularPago(tx, { pagoId: rows[0]!.id, motivo: "Prueba de anulación." })));
    expect(e2.message).toMatch(/plan de pagos/);
  });
});

describe("el pago y las cuotas de un plan no se cargan a mano", () => {
  it("un insert directo con origen plan se rechaza, y un período de plan también", async () => {
    const intento = (consulta: ReturnType<typeof sql>) => como(adminA(), (tx) => tx.execute(consulta));
    await expect(
      intento(sql`insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen, estado_conciliacion)
                  values (${barrio()}, ${uf[3]}, 100, '2026-07-01', 'plan', 'conciliado')`),
    ).rejects.toThrow();
    await expect(intento(sql`insert into periodo_expensa (barrio_id, periodo, origen) values (${barrio()}, '2026-12', 'plan')`)).rejects.toThrow();
    const { rows } = await admin.query("select count(*)::int as n from pago where unidad_funcional_id = $1 and origen = 'plan'", [uf[3]]);
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe("una firma a medias no deja nada", () => {
  it("si la firma falla después de crear el pago y cerrar la mora, no queda ni el pago, ni la mora, ni el plan vigente", async () => {
    const { planId } = await como(adminA(), (tx) =>
      proponerPlanAMedida(tx, {
        unidadFuncionalId: uf[3]!,
        liquidacionIds: [liqDe.get(`${uf[3]}:2026-06`)!],
        cronograma: [{ numero: 1, vencimiento: "2026-12-10", importe: "900.00" }],
        motivo: "Ofrece 900 por junio.",
      }),
    );
    const antes = await admin.query("select (select count(*) from pago where unidad_funcional_id = $1)::int as pagos, (select count(*) from interes_devengado where unidad_funcional_id = $1)::int as mora", [uf[3]]);
    await expect(
      como(adminA(), async (tx) => {
        const d = (await deudaALaFecha(tx, { barrioId: barrio(), fecha: "2026-11-17", unidadFuncionalId: uf[3]! })).get(uf[3]!)!;
        const { rows } = await tx.execute<{ id: string }>(sql`select app.plan_crear_pago(${planId}::uuid, 1000.00, current_date) as id`);
        await registrarTramos(tx, d.tramos, { origen: "pago", pagoId: rows[0]!.id });
        // El pago no es la deuda: la firma lo rechaza y la transacción entera se deshace.
        await tx.execute(sql`select app.plan_firmar(${planId}::uuid, ${rows[0]!.id}::uuid)`);
      }),
    ).rejects.toThrow();
    const despues = await admin.query("select (select count(*) from pago where unidad_funcional_id = $1)::int as pagos, (select count(*) from interes_devengado where unidad_funcional_id = $1)::int as mora", [uf[3]]);
    expect(despues.rows).toEqual(antes.rows);
    expect(await estadoDe(planId)).toBe("pendiente");
    await como(adminA(), (tx) => retirarPlan(tx, { planId, motivo: "Prueba terminada." }));
    expect(await estadoDe(planId)).toBe("retirado");
  });
});

describe("el saldo total no cambia al firmar un plan sin interés ni quita", () => {
  it("antes y después de firmar, la unidad debe lo mismo (las cuotas por emitir cuentan)", async () => {
    const antes = await como(adminA(), (tx) => saldoTotalDeUnidad(tx, { unidadFuncionalId: uf[3]! }));
    // Un plan a medida con lo justo: la deuda de hoy en tres cuotas futuras.
    const d = (await como(adminA(), (tx) => deudaALaFecha(tx, { barrioId: barrio(), fecha: "2026-11-17", unidadFuncionalId: uf[3]! }))).get(uf[3]!)!;
    const incluidos = d.porMes.filter((m) => [liqDe.get(`${uf[3]}:2026-06`), liqDe.get(`${uf[3]}:2026-07`)].includes(m.liquidacionId));
    const total = incluidos.reduce((s, m) => s + BigInt(Math.round(Number(m.capital) * 100)) + BigInt(Math.round(Number(m.interes) * 100)), 0n);
    const tercio = total / 3n;
    const ultima = total - tercio * 2n;
    const monto = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;
    const { planId: p2 } = await como(adminA(), (tx) =>
      proponerPlanAMedida(tx, {
        unidadFuncionalId: uf[3]!,
        liquidacionIds: incluidos.map((m) => m.liquidacionId),
        cronograma: [
          { numero: 1, vencimiento: "2026-12-10", importe: monto(tercio) },
          { numero: 2, vencimiento: "2027-01-10", importe: monto(tercio) },
          { numero: 3, vencimiento: "2027-02-10", importe: monto(ultima) },
        ],
        motivo: "La deuda de hoy en tres cuotas.",
      }),
    );
    await como(adminA(), (tx) => aprobarPlan(tx, { planId: p2 }));
    const despues = await como(adminA(), (tx) => saldoTotalDeUnidad(tx, { unidadFuncionalId: uf[3]! }));
    expect(despues).toBe(antes);
    const { rows } = await admin.query("select quita_interes::text, quita_capital::text from plan_pago where id = $1", [p2]);
    expect(rows[0]).toEqual({ quita_interes: "0.00", quita_capital: "0.00" });
  });
});

describe("la caída", () => {
  it("vuelve la deuda original menos lo pagado, y se cobra la mora que no corrió, sin interés sobre interés", async () => {
    // Unidad 1: firmó el 20/07 (2.050,00). Paga la cuota 1 el 10/08 (512,50). Las cuotas 2 (10/09) y
    // 3 (10/10) quedan impagas y vencidas → con 2 impagas, se puede declarar caído.
    await pagar(uf[0]!, "512.50", "2026-08-10");
    await emitirMes("2026-10", "2026-10-10");
    const plan = (await admin.query<{ id: string }>("select id from plan_pago where unidad_funcional_id = $1 and estado = 'vigente'", [uf[0]])).rows[0]!.id;
    const r = await como(adminA(), (tx) => declararCaido(tx, { planId: plan, nota: "Dos cuotas impagas." }));
    expect(await estadoDe(plan)).toBe("caido");
    expect([r.deudaOriginal, r.pagadoDelPlan]).toEqual(["2050.00", "512.50"]);
    // Lo pagado vuelve a la deuda (capital primero, lo más viejo): junio queda con 487,50 de capital.
    const pendiente = async (liq: string) =>
      (await admin.query<{ p: string }>("select app.capital_pendiente($1)::text as p", [liq])).rows[0]!.p;
    expect(await pendiente(liqDe.get(`${uf[0]}:2026-06`)!)).toBe("487.50");
    expect(await pendiente(liqDe.get(`${uf[0]}:2026-07`)!)).toBe("1000.00");
    // El cargo: la mora de la firma (20/07) a hoy sobre el capital que sigue impago, con el cambio de
    // tasa del 21/09 en el medio. Las bases son el capital, nunca la mora de antes (40,00 y 10,00).
    const { rows: cargo } = await admin.query<{ base: string; desde: string; hasta: string; monto: string }>(
      `select base::text, desde::text, hasta::text, monto::text from interes_devengado
        where unidad_funcional_id = $1 and desde = '2026-07-20' order by base::numeric`,
      [uf[0]],
    );
    expect(cargo.map((c) => [c.base, c.desde])).toEqual([
      ["487.50", "2026-07-20"],
      ["1000.00", "2026-07-20"],
    ]);
    expect(r.cargo).toBe(sumarMontos("0.00", ...cargo.map((c) => c.monto)));
    // Las cuotas emitidas e impagas se cancelaron: no se cuentan dos veces.
    const { rows: cuotas } = await admin.query<{ saldo: string }>(
      "select app.saldo_de_liquidacion(c.liquidacion_id)::text as saldo from plan_cuota c where c.plan_id = $1 and c.liquidacion_id is not null",
      [plan],
    );
    expect(cuotas.every((c) => c.saldo === "0.00")).toBe(true);
  });
});

describe("el pago no monetario no se fabrica ni se usa suelto (revisión de seguridad)", () => {
  it("un pago de plan creado a mano no se imputa ni se confirma; la emisión y el cierre no se llaman de afuera", async () => {
    const caido = (await admin.query<{ id: string }>("select id from plan_pago where unidad_funcional_id = $1 and estado = 'caido'", [uf[0]])).rows[0]!.id;
    await expect(
      como(adminA(), async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`select app.plan_crear_pago(${caido}::uuid, 500.00, '2026-11-01') as id`);
        await tx.execute(sql`select app.resolver_imputacion(${rows[0]!.id}::uuid)`);
      }),
    ).rejects.toThrow(/lo imputa solo su plan/);
    await expect(
      como(adminA(), async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`select app.plan_crear_pago(${caido}::uuid, 500.00, '2026-11-01') as id`);
        await tx.execute(sql`insert into pago_imputacion (pago_id, liquidacion_id, monto_imputado) values (${rows[0]!.id}, ${liqDe.get(`${uf[0]}:2026-10`)!}, 500.00)`);
      }),
    ).rejects.toThrow(/lo imputa solo su plan/);
    // Suelto, sin imputar: no se confirma.
    await expect(como(adminA(), (tx) => tx.execute(sql`select app.plan_crear_pago(${caido}::uuid, 500.00, '2026-11-01')`))).rejects.toThrow(/se imputa entero/);
    await expect(como(adminA(), (tx) => tx.execute(sql`select app.plan_emitir_cuotas(${arbol.barrioB1.id}::uuid)`))).rejects.toThrow(/permission denied/);
    await expect(como(adminA(), (tx) => tx.execute(sql`select app.plan_caer_cerrar(${caido}::uuid, 0, '{}'::jsonb)`))).rejects.toThrow(/ya se cerró/);
    const { rows } = await admin.query("select count(*)::int as n from pago where unidad_funcional_id = $1 and origen = 'plan' and monto = 500", [uf[0]]);
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe("RLS", () => {
  it("otra administración no ve los planes, sus cuotas ni sus eventos", async () => {
    for (const t of ["plan_pago", "plan_cuota", "plan_liquidacion", "plan_evento", "plan_catalogo"]) {
      const { rows } = await como(arbol.usuarios.adminEstudioB, (tx) => tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${t}`)));
      expect(rows[0]!.n, t).toBe(0);
    }
  });
});
