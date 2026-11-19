/**
 * Encargo F4 tramo 1 (BL-055 e), contra Postgres real (`0098`): qué va primero entre la cuota del plan y
 * la expensa cuando un pago no dice a qué va. **Cada número al centavo, sobre un caso que se sigue a mano.**
 *
 * El barrio: diez unidades con coeficiente 0,1 y $ 10.000 de gasto por mes, o sea **$ 1.000 por
 * boleta**, sin interés por mora (la pasada de interés no imputa nada y las cuentas quedan limpias) y
 * orden de interés «capital primero». Junio (vence el 10/06) y julio (10/07) quedan impagos y el
 * 20/07/2026 cada unidad con plan firma uno del catálogo de 2 cuotas fijas sin interés con esos dos
 * meses: **$ 2.000 → 2 cuotas de $ 1.000**. Después se emite agosto, que vence el 10/08 y emite la cuota 1
 * de cada plan (todas vencen en agosto). Cada unidad debe entonces **la cuota 1 ($ 1.000) y la expensa de
 * agosto ($ 1.000)**, y paga **$ 1.500 el 25/08**: alcanza para una entera y la mitad de la otra.
 *
 *   · Unidad 1: cuota 1 el **20/08** (la expensa, del 10/08, es más vieja). Se prueba en los tres órdenes.
 *   · Unidad 2: cuota 1 el **05/08** (la cuota es más vieja).
 *   · Unidades 3, 7, 8, 9 y 10: cuota 1 el **10/08**, el mismo día que la expensa (y del mismo período).
 *     Son cinco porque, sin el desempate, el orden lo decidiría el id de la fila, que es al azar: con una
 *     sola, un desempate roto pasaría la mitad de las veces; con cinco, una de cada 32.
 *   · Unidad 4: cuota 1 el 05/08, pero la **cobra el estudio**: un pago común nunca va a ella.
 *   · Unidad 5: cuota 1 el 20/08, en un barrio «a elección de quien registra».
 * Al final se emite septiembre (expensa 10/09; la cuota 2 de la unidad 2 vence el 05/09) para el caso de
 * tres deudas intercaladas (`contador`, F4 tramo 1).
 *
 * Garantía implícita (`contador`): junio y julio entraron al plan y por fecha serían lo más viejo; si la
 * imputación los tomara, `adondeFue` devolvería una clave `otra:` y el `toEqual` fallaría. Lo que entró al
 * plan no se cobra dos veces.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { nuevoToken } from "@admin-barrios/almacenamiento";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import type { GuardarOrdenGeneralDeImputacion, GuardarReglasDePlanes, OrdenElegibleAlRegistrar } from "@admin-barrios/shared/planes";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { enBase } from "../src/errores.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { registrarEImputarPago } from "../src/servicios/deuda.ts";
import { anularPago, listarPagosDeUnidad } from "../src/servicios/pagos.ts";
import { listarSaldosUF } from "../src/servicios/cobros.ts";
import { agregarEstudio, cambiarEstudioDelBarrio } from "../src/servicios/mora.ts";
import { crearPlanDeCatalogo } from "../src/servicios/planes.ts";
import {
  configuracionDePlanes,
  guardarOrdenGeneralDeImputacion,
  guardarReglasDePlanes,
  ordenDeImputacionDelBarrio,
} from "../src/servicios/planes-configuracion.ts";
import { borrarArbol, borrarParametrosDe, cargarParametro, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf: string[];
let conceptoId: string;
const planDe = new Map<string, string>(); // unidad → plan
const liqDe = new Map<string, string>(); // `${unidad}:${periodo}` → liquidación

const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminA = () => arbol.usuarios.adminEstudioA;
const CUIT = "30710000154";

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

async function emitirMes(periodo: string, vencimiento: string): Promise<void> {
  const { rows } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, $2, $3) returning id",
    [barrio(), periodo, vencimiento],
  );
  const periodoId = rows[0]!.id;
  await admin.query("insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '10000.00')", [
    barrio(),
    periodoId,
    conceptoId,
  ]);
  await como(adminA(), (tx) => generarLiquidaciones(tx, { periodoId }));
  await como(adminA(), (tx) => emitirPeriodo(tx, { periodoId }));
  const { rows: l } = await admin.query<{ id: string; unidad_funcional_id: string }>("select id, unidad_funcional_id from liquidacion where periodo_id = $1", [
    periodoId,
  ]);
  for (const x of l) liqDe.set(`${x.unidad_funcional_id}:${periodo}`, x.id);
}

/** Un pago que entra solo (el extracto): nadie elige nada. */
const pagarPorExtracto = (unidad: string, monto: string, fecha: string) =>
  como(adminA(), (tx) =>
    registrarEImputarPago(tx, {
      pago: { unidadFuncionalId: unidad, obligadoId: null, monto, fecha, origen: "extracto", comprobanteAdjunto: null },
      confirmarPagoConInteres: true,
      noCobrarInteres: null,
    }),
  );

/** Un pago cargado a mano, con (o sin) la elección de quien registra. */
const pagarAMano = (unidad: string, monto: string, fecha: string, ordenPlanElegido: OrdenElegibleAlRegistrar | null) =>
  como(adminA(), (tx) =>
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
  );

const anular = (pagoId: string) => como(adminA(), (tx) => anularPago(tx, { pagoId, motivo: "Prueba del orden de imputación." }));

async function cuota1(unidad: string): Promise<string> {
  const { rows } = await admin.query<{ liquidacion_id: string }>("select liquidacion_id from plan_cuota where plan_id = $1 and numero = 1", [planDe.get(unidad)]);
  return rows[0]!.liquidacion_id;
}

/**
 * A qué fue el pago: cuánto a la cuota 1 y cuánto a la expensa de agosto. (Las imputaciones de un mismo
 * pago comparten `created_at`: el orden de las filas no dice nada; lo dicen los importes.)
 */
async function adondeFue(pagoId: string, unidad: string): Promise<Record<string, string>> {
  const cuota = await cuota1(unidad);
  const expensa = liqDe.get(`${unidad}:2026-08`);
  const { rows } = await admin.query<{ liquidacion_id: string; monto: string }>(
    "select liquidacion_id, monto_imputado::text as monto from pago_imputacion where pago_id = $1 and anulado_at is null",
    [pagoId],
  );
  return Object.fromEntries(rows.map((r) => [r.liquidacion_id === cuota ? "cuota" : r.liquidacion_id === expensa ? "expensa" : `otra:${r.liquidacion_id}`, r.monto]));
}

const paraRevisar = async (pagoId: string) =>
  (await admin.query<{ marca: boolean }>("select imputacion_para_revisar as marca from pago where id = $1", [pagoId])).rows[0]!.marca;

/**
 * El reemplazo del barrio (`administracion` = «Como la administración»). Reciben `string` a propósito: un
 * test manda un valor que no es de los cuatro y tiene que rechazarlo el esquema, no el compilador.
 */
const reglaDelBarrio = (orden: string) =>
  como(adminA(), (tx) =>
    guardarReglasDePlanes(tx, { barrioId: barrio(), cuotasParaCaer: "2", ordenImputacion: orden as GuardarReglasDePlanes["ordenImputacion"], financiaMora: "no", quitaRequiereActa: "no" }),
  );
const reglaGeneral = (orden: string) =>
  como(adminA(), (tx) =>
    guardarOrdenGeneralDeImputacion(tx, { administracionId: arbol.adminA.id, ordenImputacion: orden as GuardarOrdenGeneralDeImputacion["ordenImputacion"] }),
  );

async function limpiar(): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["plan_evento", "plan_cuota", "plan_liquidacion", "plan_pago", "plan_parametro_barrio_historia", "plan_parametro_barrio", "plan_catalogo_barrio",
      "estudio_barrio", "interes_condonacion", "pago_imputacion_interes", "pago_imputacion", "interes_devengado", "saldo_uf", "pago", "item_liquidacion",
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
     select $1, '9', g::text, 'construido' from generate_series(1, 10) g order by g returning id`,
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
        nombre: "Estudio del Orden",
        cuit: CUIT,
        correoAvisos: `${CUIT}@estudio.test`,
        telefonoBoleta: "(0351) 555-0154",
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
  for (const id of [enBoleta, conEstudio]) {
    await como(adminA(), (tx) => tx.execute(sql`insert into plan_catalogo_barrio (catalogo_id, barrio_id) values (${id}, ${n})`));
  }

  await emitirMes("2026-06", "2026-06-10");
  await emitirMes("2026-07", "2026-07-10");
  const firmar = async (unidad: string, catalogoId: string, primerVencimiento: string) => {
    const { planId } = await como(adminA(), (tx) =>
      crearPlanDeCatalogo(tx, {
        unidadFuncionalId: unidad,
        liquidacionIds: [liqDe.get(`${unidad}:2026-06`)!, liqDe.get(`${unidad}:2026-07`)!],
        catalogoId,
        cuotas: 2,
        primerVencimiento,
        fecha: "2026-07-20",
      }),
    );
    planDe.set(unidad, planId);
  };
  await firmar(uf[0]!, enBoleta, "2026-08-20");
  await firmar(uf[1]!, enBoleta, "2026-08-05");
  await firmar(uf[2]!, enBoleta, "2026-08-10");
  await firmar(uf[3]!, conEstudio, "2026-08-05");
  await firmar(uf[4]!, enBoleta, "2026-08-20");
  await firmar(uf[6]!, enBoleta, "2026-08-10");
  await firmar(uf[7]!, enBoleta, "2026-08-10");
  await firmar(uf[8]!, enBoleta, "2026-08-10");
  await firmar(uf[9]!, enBoleta, "2026-08-10");
  await emitirMes("2026-08", "2026-08-10");
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

describe("sin nada cargado rige «La más vieja primero»", () => {
  it("el barrio sin regla propia y la administración sin valor general resuelven la más vieja", async () => {
    expect(await como(adminA(), (tx) => ordenDeImputacionDelBarrio(tx, { barrioId: barrio() }))).toBe("mas_vieja_primero");
    const cfg = await como(adminA(), (tx) => configuracionDePlanes(tx, { administracionId: arbol.adminA.id }));
    expect(cfg?.ordenImputacionGeneral).toBe("mas_vieja_primero");
    expect(cfg?.reglas.find((r) => r.barrioId === barrio())).toMatchObject({ ordenImputacion: null, ordenImputacionEfectivo: "mas_vieja_primero" });
  });

  it("la expensa del 10/08 es más vieja que la cuota del 20/08: 1.000 a la expensa y 500 a la cuota", async () => {
    const { id } = await pagarPorExtracto(uf[0]!, "1500.00", "2026-08-25");
    expect(await adondeFue(id, uf[0]!)).toEqual({ expensa: "1000.00", cuota: "500.00" });
    expect(await paraRevisar(id)).toBe(false);
    await anular(id);
  });

  it("la cuota del 05/08 es más vieja que la expensa del 10/08: 1.000 a la cuota y 500 a la expensa", async () => {
    const { id } = await pagarPorExtracto(uf[1]!, "1500.00", "2026-08-25");
    expect(await adondeFue(id, uf[1]!)).toEqual({ cuota: "1000.00", expensa: "500.00" });
    await anular(id);
  });

  it("cuota y expensa vencen el mismo día (10/08): primero la cuota, 1.000, y 500 a la expensa", async () => {
    for (const u of [uf[2]!, uf[6]!, uf[7]!, uf[8]!, uf[9]!]) {
      const { id } = await pagarPorExtracto(u, "1500.00", "2026-08-25");
      expect(await adondeFue(id, u)).toEqual({ cuota: "1000.00", expensa: "500.00" });
      await anular(id);
    }
  });

  it("una cuota que cobra el estudio no se imputa aunque sea la más vieja: 1.000 a la expensa y 500 quedan sin imputar", async () => {
    const { id } = await pagarPorExtracto(uf[3]!, "1500.00", "2026-08-25");
    expect(await adondeFue(id, uf[3]!)).toEqual({ expensa: "1000.00" });
    const { rows } = await admin.query<{ saldo: string }>("select app.saldo_de_liquidacion($1)::text as saldo", [await cuota1(uf[3]!)]);
    expect(rows[0]!.saldo).toBe("1000.00");
    // Los 500 quedan en el pago, sin imputar (saldo a favor de la unidad, trazable a este pago).
    const { rows: sobra } = await admin.query<{ sobra: string }>(
      `select (p.monto - coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = p.id and anulado_at is null), 0))::text as sobra
         from pago p where p.id = $1`,
      [id],
    );
    expect(sobra[0]!.sobra).toBe("500.00");
    await anular(id);
  });
});

describe("el mismo pago de 1.500 (unidad 1: expensa 10/08, cuota 20/08) en cada orden del barrio", () => {
  it("«Primero la cuota del plan»: 1.000 a la cuota y 500 a la expensa, aunque la expensa sea más vieja", async () => {
    await reglaDelBarrio("cuota_primero");
    const { id } = await pagarPorExtracto(uf[0]!, "1500.00", "2026-08-25");
    expect(await adondeFue(id, uf[0]!)).toEqual({ cuota: "1000.00", expensa: "500.00" });
    await anular(id);
  });

  it("«Primero la expensa»: 1.000 a la expensa y 500 a la cuota", async () => {
    await reglaDelBarrio("expensa_primero");
    const { id } = await pagarPorExtracto(uf[0]!, "1500.00", "2026-08-25");
    expect(await adondeFue(id, uf[0]!)).toEqual({ expensa: "1000.00", cuota: "500.00" });
    await anular(id);
  });

  it("«Primero la expensa» con la cuota más vieja (unidad 2): igual 1.000 a la expensa y 500 a la cuota", async () => {
    const { id } = await pagarPorExtracto(uf[1]!, "1500.00", "2026-08-25");
    expect(await adondeFue(id, uf[1]!)).toEqual({ expensa: "1000.00", cuota: "500.00" });
    await anular(id);
  });

  it("«La más vieja primero» elegida en el barrio: 1.000 a la expensa y 500 a la cuota", async () => {
    await reglaDelBarrio("mas_vieja_primero");
    const { id } = await pagarPorExtracto(uf[0]!, "1500.00", "2026-08-25");
    expect(await adondeFue(id, uf[0]!)).toEqual({ expensa: "1000.00", cuota: "500.00" });
    await anular(id);
  });
});

describe("el valor general y el reemplazo del barrio", () => {
  it("«Como la administración» toma el general: con «Primero la cuota del plan» general, 1.000 a la cuota", async () => {
    await reglaGeneral("cuota_primero");
    await reglaDelBarrio("administracion");
    const cfg = await como(adminA(), (tx) => configuracionDePlanes(tx, { administracionId: arbol.adminA.id }));
    expect(cfg?.ordenImputacionGeneral).toBe("cuota_primero");
    expect(cfg?.reglas.find((r) => r.barrioId === barrio())).toMatchObject({ ordenImputacion: null, ordenImputacionEfectivo: "cuota_primero" });
    const { id } = await pagarPorExtracto(uf[0]!, "1500.00", "2026-08-25");
    expect(await adondeFue(id, uf[0]!)).toEqual({ cuota: "1000.00", expensa: "500.00" });
    await anular(id);
  });

  it("el del barrio le gana al general: barrio «Primero la expensa» con general «Primero la cuota»", async () => {
    await reglaDelBarrio("expensa_primero");
    const { id } = await pagarPorExtracto(uf[0]!, "1500.00", "2026-08-25");
    expect(await adondeFue(id, uf[0]!)).toEqual({ expensa: "1000.00", cuota: "500.00" });
    await anular(id);
  });

  it("cada cambio del general queda en su historia, con quién", async () => {
    const { rows } = await admin.query<{ orden_imputacion: string; cargado_por: string }>(
      "select orden_imputacion, cargado_por from plan_parametro_administracion_historia where administracion_id = $1 order by registrado_at",
      [arbol.adminA.id],
    );
    expect(rows).toEqual([{ orden_imputacion: "cuota_primero", cargado_por: adminA() }]);
  });

  it("un valor que no es de los cuatro se rechaza: el esquema y, por debajo, la base", async () => {
    await expect(reglaGeneral("cualquiera")).rejects.toThrow(/Elegí el orden/);
    await expect(
      como(adminA(), (tx) => tx.execute(sql`update plan_parametro_administracion set orden_imputacion = 'cualquiera' where administracion_id = ${arbol.adminA.id}`)),
    ).rejects.toThrow();
    await expect(
      como(adminA(), (tx) => tx.execute(sql`update plan_parametro_barrio set orden_imputacion = 'cualquiera' where barrio_id = ${barrio()}`)),
    ).rejects.toThrow();
  });
});

describe("«A elección de quien registra» (unidad 5: expensa 10/08, cuota 20/08)", () => {
  it("el pago que entra solo se imputa la más vieja primero y queda «para revisar»", async () => {
    await reglaDelBarrio("a_eleccion");
    expect(await como(adminA(), (tx) => ordenDeImputacionDelBarrio(tx, { barrioId: barrio() }))).toBe("a_eleccion");
    const { id } = await pagarPorExtracto(uf[4]!, "1500.00", "2026-08-25");
    expect(await adondeFue(id, uf[4]!)).toEqual({ expensa: "1000.00", cuota: "500.00" });
    expect(await paraRevisar(id)).toBe(true);
    const pagos = await como(adminA(), (tx) => listarPagosDeUnidad(tx, { unidadFuncionalId: uf[4]! }));
    expect(pagos.find((p) => p.id === id)?.paraRevisar).toBe(true);
    // La grilla de Cobros lo cuenta en la unidad, y en ninguna otra.
    const grilla = await como(adminA(), (tx) => listarSaldosUF(tx, { barrioId: barrio() }));
    expect(grilla.saldos.filter((s) => s.pagosParaRevisar > 0).map((s) => [s.unidadFuncionalId, s.pagosParaRevisar])).toEqual([[uf[4]!, 1]]);
    await anular(id);
    // Anulado, ya no se cuenta.
    const despues = await como(adminA(), (tx) => listarSaldosUF(tx, { barrioId: barrio() }));
    expect(despues.saldos.every((s) => s.pagosParaRevisar === 0)).toBe(true);
  });

  it("un pago a mano sin elección (un script, no la pantalla) también va a la más vieja y queda «para revisar»", async () => {
    const { id } = await pagarAMano(uf[4]!, "1500.00", "2026-08-25", null);
    expect(await adondeFue(id, uf[4]!)).toEqual({ expensa: "1000.00", cuota: "500.00" });
    expect(await paraRevisar(id)).toBe(true);
    await anular(id);
  });

  it("si la unidad no debe ninguna cuota del plan, la elección no importa y el pago no se marca", async () => {
    const { id } = await pagarPorExtracto(uf[5]!, "500.00", "2026-08-25");
    expect(await paraRevisar(id)).toBe(false);
    await anular(id);
  });

  it("a mano, quien registra elige «Primero la cuota del plan»: 1.000 a la cuota y 500 a la expensa, sin marca", async () => {
    const { id } = await pagarAMano(uf[4]!, "1500.00", "2026-08-25", "cuota_primero");
    expect(await adondeFue(id, uf[4]!)).toEqual({ cuota: "1000.00", expensa: "500.00" });
    expect(await paraRevisar(id)).toBe(false);
    await anular(id);
  });

  it("a mano con «La más vieja primero» (la preseleccionada): 1.000 a la expensa y 500 a la cuota, sin marca", async () => {
    const { id } = await pagarAMano(uf[4]!, "1500.00", "2026-08-25", "mas_vieja_primero");
    expect(await adondeFue(id, uf[4]!)).toEqual({ expensa: "1000.00", cuota: "500.00" });
    expect(await paraRevisar(id)).toBe(false);
    await anular(id);
  });

  it("en un barrio que no es «a elección», lo elegido no cuenta: rige el del barrio y no hay marca", async () => {
    await reglaDelBarrio("expensa_primero");
    const { id } = await pagarAMano(uf[4]!, "1500.00", "2026-08-25", "cuota_primero");
    expect(await adondeFue(id, uf[4]!)).toEqual({ expensa: "1000.00", cuota: "500.00" });
    expect(await paraRevisar(id)).toBe(false);
    // Y no se guarda: la fila no dice «eligió cuota primero» cuando se imputó con otro orden.
    const { rows } = await admin.query<{ orden: string | null }>("select orden_plan_elegido as orden from pago where id = $1", [id]);
    expect(rows[0]!.orden).toBeNull();
    await anular(id);
  });
});

describe("la base cuida la elección y la marca", () => {
  it("un pago de extracto no lleva elección (lo frena el esquema y, si no, la base)", async () => {
    await expect(
      como(adminA(), (tx) =>
        registrarEImputarPago(tx, {
          pago: { unidadFuncionalId: uf[5]!, obligadoId: null, monto: "10.00", fecha: "2026-08-25", origen: "extracto", comprobanteAdjunto: null, ordenPlanElegido: "cuota_primero" },
          confirmarPagoConInteres: true,
          noCobrarInteres: null,
        }),
      ),
    ).rejects.toThrow(/el orden lo elige quien registra un pago a mano/);
    const e = await capturar(() =>
      como(adminA(), (tx) =>
        enBase(() =>
          tx.execute(sql`
            insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen, orden_plan_elegido)
            values (${barrio()}, ${uf[5]!}, 10, '2026-08-25', 'extracto', 'cuota_primero')`),
        ),
      ),
    );
    expect(e.message).toBe("Qué se paga primero lo elige quien registra un pago a mano.");
  });

  it("la marca y la elección no se escriben a mano", async () => {
    const { id } = await pagarPorExtracto(uf[5]!, "10.00", "2026-08-25");
    const marca = await capturar(() => como(adminA(), (tx) => enBase(() => tx.execute(sql`update pago set imputacion_para_revisar = true where id = ${id}`))));
    expect(marca.codigo).toBe("sin_permiso");
    const eleccion = await capturar(() =>
      como(adminA(), (tx) => enBase(() => tx.execute(sql`update pago set orden_plan_elegido = 'cuota_primero' where id = ${id}`))),
    );
    expect(eleccion.message).toMatch(/no se edita/i);
    await anular(id);
  });
});

describe("tres deudas intercaladas (unidad 2: cuota 1 05/08, expensa 10/08, cuota 2 05/09)", () => {
  /** Cuánto fue a cada deuda de la unidad 2, por nombre. */
  async function repartoU2(pagoId: string): Promise<Record<string, string>> {
    const { rows: c } = await admin.query<{ numero: number; liquidacion_id: string }>(
      "select numero, liquidacion_id from plan_cuota where plan_id = $1 and numero > 0",
      [planDe.get(uf[1]!)],
    );
    const nombre = new Map<string, string>([
      ...c.map((x) => [x.liquidacion_id, `cuota${x.numero}`] as [string, string]),
      [liqDe.get(`${uf[1]}:2026-08`)!, "agosto"],
      [liqDe.get(`${uf[1]}:2026-09`)!, "septiembre"],
    ]);
    const { rows } = await admin.query<{ liquidacion_id: string; monto: string }>(
      "select liquidacion_id, monto_imputado::text as monto from pago_imputacion where pago_id = $1 and anulado_at is null",
      [pagoId],
    );
    return Object.fromEntries(rows.map((r) => [nombre.get(r.liquidacion_id) ?? `otra:${r.liquidacion_id}`, r.monto]));
  }

  it("la más vieja: 2.500 → cuota 1 1.000, agosto 1.000 y 500 a la cuota 2 (septiembre, del 10/09, nada)", async () => {
    await emitirMes("2026-09", "2026-09-10");
    await reglaDelBarrio("mas_vieja_primero");
    const { id } = await pagarPorExtracto(uf[1]!, "2500.00", "2026-09-25");
    expect(await repartoU2(id)).toEqual({ cuota1: "1000.00", agosto: "1000.00", cuota2: "500.00" });
    await anular(id);
  });

  it("primero la cuota, con el mismo pago: cuota 1 y cuota 2 enteras y 500 a agosto", async () => {
    await reglaDelBarrio("cuota_primero");
    const { id } = await pagarPorExtracto(uf[1]!, "2500.00", "2026-09-25");
    expect(await repartoU2(id)).toEqual({ cuota1: "1000.00", cuota2: "1000.00", agosto: "500.00" });
    await anular(id);
  });
});
