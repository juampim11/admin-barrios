/**
 * Encargo P2b, contra Postgres real (`0097`): la cuota en la boleta en los dos modos de cobro, la
 * imputación cuando cobra el estudio y la rendición manual. **Cada número al centavo, sobre un caso
 * que se sigue a mano.**
 *
 * El barrio: cuatro unidades con coeficiente 0,25 y $ 4.000 de gasto por mes, o sea **$ 1.000 por
 * boleta**, sin interés por mora (las cuentas quedan limpias) y orden «capital primero». Cada mes
 * vence el 10. Junio y julio quedan impagos y el 20/07/2026 tres unidades firman un plan del catálogo
 * de 2 cuotas fijas con esos dos meses: **$ 2.000 → 2 cuotas de $ 1.000**.
 *   · Unidad 1 y unidad 2: cobra el **estudio**, cuotas el 10/08 y el 10/09.
 *   · Unidad 3: cobra el **barrio**, cuotas el 10/10 y el 10/11.
 *   · Unidad 4: sin plan (su boleta es la de siempre).
 * Agosto, septiembre y octubre se emiten (cada emisión emite las cuotas que vencen en el mes).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { registroPorDefecto } from "@admin-barrios/documentos/cobranza";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { enBase } from "../src/errores.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { registrarEImputarPago } from "../src/servicios/deuda.ts";
import { anularPago, registrarPago } from "../src/servicios/pagos.ts";
import { imputarPago } from "../src/servicios/cobros.ts";
import { agregarEstudio, cambiarEstudioDelBarrio } from "../src/servicios/mora.ts";
import { crearPlanDeCatalogo, declararCaido } from "../src/servicios/planes.ts";
import { armarVistaBoleta } from "../src/servicios/vista-boleta.ts";
import {
  adjuntarPdfDeRendicion,
  agregarCuotaARendicion,
  agregarIngresoARendicion,
  confirmarRendicion,
  crearRendicion,
  quitarIngresoDeRendicion,
  rendicion,
} from "../src/servicios/planes-rendicion.ts";
import { borrarArbol, borrarParametrosDe, cargarParametro, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf: [string, string, string, string];
let conceptoId: string;
let estudio: string;
const planDe = new Map<string, string>(); // unidad → plan
const liqDe = new Map<string, string>(); // `${unidad}:${periodo}` → liquidación
const registro = registroPorDefecto();

const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminA = () => arbol.usuarios.adminEstudioA;
const CUIT = "30710000146";
const CBU = "0000003110000000000502";
const SHA = "b".repeat(64);
/** Un SHA-256 distinto por archivo: el mismo comprobante no acredita dos ingresos (`uq_plan_rendicion_ingreso_sha`). */
const sha = (n: number) => String(n).padStart(64, "c");
const clave = (rendicionId: string, n: number, ext = "pdf") => `barrios/${barrio()}/rendiciones/${rendicionId}/${String(n).padStart(22, "R")}.${ext}`;

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

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
  const { rows: l } = await admin.query<{ id: string; unidad_funcional_id: string }>("select id, unidad_funcional_id from liquidacion where periodo_id = $1", [
    periodoId,
  ]);
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

async function cuotas(unidad: string) {
  const { rows } = await admin.query<{ numero: number; liquidacion_id: string; saldo: string }>(
    `select pc.numero, pc.liquidacion_id, app.saldo_de_liquidacion(pc.liquidacion_id)::text as saldo
       from plan_cuota pc where pc.plan_id = $1 order by pc.numero`,
    [planDe.get(unidad)],
  );
  return rows;
}

const imputacionesDe = async (pagoId: string) =>
  (
    await admin.query<{ liquidacion_id: string; monto: string }>(
      "select liquidacion_id, monto_imputado::text as monto from pago_imputacion where pago_id = $1 and anulado_at is null order by monto_imputado desc",
      [pagoId],
    )
  ).rows;

async function limpiar(): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["plan_rendicion_pago", "plan_rendicion_ingreso", "plan_rendicion_cuota", "plan_rendicion", "plan_evento", "plan_cuota", "plan_liquidacion",
      "plan_pago", "plan_parametro_barrio_historia", "plan_parametro_barrio", "plan_catalogo_barrio", "estudio_barrio", "interes_condonacion",
      "pago_imputacion_interes", "pago_imputacion", "interes_devengado", "saldo_uf", "pago", "item_liquidacion", "liquidacion", "gasto_periodo",
      "periodo_expensa", "concepto", "coeficiente", "coeficiente_version", "unidad_funcional"]) {
      await c.query(`delete from ${t} where barrio_id = any($1::uuid[])`, [[barrio(), arbol.barrioB1.id]]);
    }
    await c.query("delete from plan_catalogo where administracion_id = $1", [arbol.adminA.id]);
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
  await crearBarrio(admin, arbol.barrioB1.id);
  await limpiar();
  await admin.query("update barrio set cuenta_cbu = $2 where barrio_id = $1", [barrio(), CBU]);
  await borrarParametrosDe(admin, [barrio()]);
  const n = barrio();
  await cargarParametro(admin, n, "interes.cobra", false);
  await cargarParametro(admin, n, "imputacion.orden", "capital_primero");
  const { rows: ufs } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
     select $1, '7', g::text, 'construido' from generate_series(1, 4) g order by g returning id`,
    [n],
  );
  uf = [ufs[0]!.id, ufs[1]!.id, ufs[2]!.id, ufs[3]!.id];
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

  estudio = (
    await como(adminA(), (tx) =>
      agregarEstudio(tx, {
        administracionId: arbol.adminA.id,
        nombre: "Estudio de las Rendiciones",
        cuit: CUIT,
        correoAvisos: `${CUIT}@estudio.test`,
        telefonoBoleta: "(0351) 555-0142",
        preferenciaAviso: "cada_derivacion",
      }),
    )
  ).estudioId;
  await como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: n, estudioId: estudio, accion: "sumar" }));
  const k = await como(adminA(), (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into plan_catalogo (administracion_id, nombre, sistema, tasa_mensual, cuotas_min, cuotas_max, estudio_id, modo_cobro, creado_por)
      values (${arbol.adminA.id}, 'Dos cuotas con el estudio', 'fija', 0, 2, 6, ${estudio}, 'estudio', app.current_user_id()),
             (${arbol.adminA.id}, 'Dos cuotas en la boleta', 'fija', 0, 2, 6, null, 'barrio', app.current_user_id())
      returning id`),
  );
  const [conEstudio, enBoleta] = [k.rows[0]!.id, k.rows[1]!.id];
  for (const id of [conEstudio, enBoleta]) {
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
  await firmar(uf[0], conEstudio, "2026-08-10");
  await firmar(uf[1], conEstudio, "2026-08-10");
  await firmar(uf[2], enBoleta, "2026-10-10");
  await emitirMes("2026-08", "2026-08-10");
  await emitirMes("2026-09", "2026-09-10");
  await emitirMes("2026-10", "2026-10-10");
});

afterAll(async () => {
  await limpiar();
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
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

describe("la cuota en la boleta", () => {
  it("cobra el barrio: renglón aparte, suma al total y al cupón (1.000 de octubre + 1.000 de la cuota)", async () => {
    const v = await como(adminA(), (tx) => armarVistaBoleta(tx, liqDe.get(`${uf[2]}:2026-10`)!, { registro }));
    expect(v.planDePagos).toEqual({
      cobra: "barrio",
      cuotas: [{ etiqueta: "Plan de pagos · cuota 1 de 2", vencimiento: { iso: "2026-10-10", texto: "10/10/2026" }, importe: { monto: "1000.00", texto: "1.000,00" } }],
      total: { monto: "1000.00", texto: "1.000,00" },
      aPagarConLaCuota: { monto: "2000.00", texto: "2.000,00" },
      estudio: null,
    });
    expect(v.totales.aPagar.monto).toBe("1000.00");
    expect(v.bloquePago.importes.alVencimiento.monto).toBe("2000.00");
  });

  it("cobra el estudio: se informa con el nombre y el teléfono, y no suma (el cupón cobra 1.000)", async () => {
    const v = await como(adminA(), (tx) => armarVistaBoleta(tx, liqDe.get(`${uf[0]}:2026-09`)!, { registro }));
    expect(v.planDePagos).toEqual({
      cobra: "estudio",
      cuotas: [{ etiqueta: "Plan de pagos · cuota 2 de 2", vencimiento: { iso: "2026-09-10", texto: "10/09/2026" }, importe: { monto: "1000.00", texto: "1.000,00" } }],
      total: { monto: "1000.00", texto: "1.000,00" },
      aPagarConLaCuota: null,
      estudio: { nombre: "Estudio de las Rendiciones", contacto: "(0351) 555-0142" },
    });
    expect(v.bloquePago.importes.alVencimiento.monto).toBe("1000.00");
  });

  it("una unidad sin plan no trae cuota y su cupón es el de siempre", async () => {
    const v = await como(adminA(), (tx) => armarVistaBoleta(tx, liqDe.get(`${uf[3]}:2026-10`)!, { registro }));
    expect(v.planDePagos).toBeNull();
    expect(v.bloquePago.importes.alVencimiento.monto).toBe(v.totales.aPagar.monto);
  });

  it("el saldo anterior de la boleta deja afuera las cuotas del estudio y nombra la cuota del barrio", async () => {
    const { rows } = await admin.query<{ id: string }>(
      "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, '2026-11', '2026-11-10') returning id",
      [barrio()],
    );
    await admin.query("insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '4000.00')", [
      barrio(),
      rows[0]!.id,
      conceptoId,
    ]);
    await como(adminA(), (tx) => generarLiquidaciones(tx, { periodoId: rows[0]!.id, origenSaldo: "calculado", fechaCorteMora: "2026-11-01" }));
    const { rows: l } = await admin.query<{ unidad_funcional_id: string; saldo_anterior: string; deuda_anterior: { periodo: string; capital: string; cuotaDelPlan?: string }[] }>(
      "select unidad_funcional_id, saldo_anterior::text, deuda_anterior from liquidacion where periodo_id = $1",
      [rows[0]!.id],
    );
    const de = (u: string) => l.find((x) => x.unidad_funcional_id === u)!;
    // Unidad 2 (estudio): agosto, septiembre y octubre (3.000); sus dos cuotas vencidas (2.000) no.
    expect(de(uf[1]).saldo_anterior).toBe("3000.00");
    expect(de(uf[1]).deuda_anterior.some((m) => m.cuotaDelPlan)).toBe(false);
    // Unidad 3 (barrio): los tres meses más la cuota 1, vencida el 10/10 (4.000), nombrada como cuota.
    expect(de(uf[2]).saldo_anterior).toBe("4000.00");
    expect(de(uf[2]).deuda_anterior.filter((m) => m.cuotaDelPlan)).toEqual([
      { periodo: "2026-10", vencimiento: "2026-10-10", capital: "1000.00", interes: "0.00", cuotaDelPlan: "Plan de pagos · cuota 1 de 2" },
    ]);
    // Unidad 4 (sin plan): los cinco meses impagos de siempre, sin el campo nuevo.
    expect(de(uf[3]).saldo_anterior).toBe("5000.00");
    expect(de(uf[3]).deuda_anterior.every((m) => !("cuotaDelPlan" in m))).toBe(true);
    // Se vuelve a generar y se emite al final del archivo (con otro corte).
  });
});

describe("cuando cobra el estudio, un pago común nunca va a la cuota", () => {
  it("con «cuota primero», un pago de 1.000 cubre la expensa de agosto aunque la cuota 1 del estudio esté vencida", async () => {
    const [c1, c2] = await cuotas(uf[0]);
    const { id: p1 } = await pagar(uf[0], "1000.00", "2026-09-05");
    expect(await imputacionesDe(p1)).toEqual([{ liquidacion_id: liqDe.get(`${uf[0]}:2026-08`), monto: "1000.00" }]);
    // 1.500 el 20/09: septiembre entero (1.000) y 500 a octubre; las cuotas, intactas.
    const { id: p2 } = await pagar(uf[0], "1500.00", "2026-09-20");
    expect(await imputacionesDe(p2)).toEqual([
      { liquidacion_id: liqDe.get(`${uf[0]}:2026-09`), monto: "1000.00" },
      { liquidacion_id: liqDe.get(`${uf[0]}:2026-10`), monto: "500.00" },
    ]);
    expect((await cuotas(uf[0])).map((c) => c.saldo)).toEqual(["1000.00", "1000.00"]);
    expect([c1!.saldo, c2!.saldo]).toEqual(["1000.00", "1000.00"]);
  });

  it("un pago que sobra queda sin imputar (saldo a favor), no se va a la cuota del estudio", async () => {
    const { id } = await pagar(uf[0], "800.00", "2026-10-01");
    // Octubre tenía 500 pendientes: 500 a octubre, 300 sin imputar.
    expect(await imputacionesDe(id)).toEqual([{ liquidacion_id: liqDe.get(`${uf[0]}:2026-10`), monto: "500.00" }]);
    expect((await cuotas(uf[0])).map((c) => c.saldo)).toEqual(["1000.00", "1000.00"]);
  });

  it("la imputación a mano a una cuota del estudio se rechaza", async () => {
    const { id } = await como(adminA(), (tx) =>
      registrarPago(tx, { unidadFuncionalId: uf[0], obligadoId: null, monto: "100.00", fecha: "2026-10-02", origen: "extracto", comprobanteAdjunto: null }),
    );
    const [c1] = await cuotas(uf[0]);
    const e = await capturar(() => como(adminA(), (tx) => imputarPago(tx, { pagoId: id, liquidacionId: c1!.liquidacion_id, montoImputado: "100.00" })));
    expect(e.codigo).toBe("sin_permiso");
    expect(e.message).toBe("Esa cuota del plan la cobra el estudio: solo entra por la rendición.");
  });

  it("si cobra el barrio, la cuota se imputa como siempre (cuota primero)", async () => {
    const [c1] = await cuotas(uf[2]);
    const { id } = await pagar(uf[2], "1000.00", "2026-10-05");
    expect(await imputacionesDe(id)).toEqual([{ liquidacion_id: c1!.liquidacion_id, monto: "1000.00" }]);
  });
});

describe("la rendición", () => {
  let r: string;

  it("se carga en borrador: 1.000 de la cuota 1 y 400 (parcial) de la cuota 2, que llegan en 900 + 500", async () => {
    r = (await como(adminA(), (tx) => crearRendicion(tx, { barrioId: barrio(), estudioId: estudio, periodo: "2026-09" }))).rendicionId;
    const [c1, c2] = await cuotas(uf[0]);
    await como(adminA(), (tx) => agregarCuotaARendicion(tx, { rendicionId: r, planCuotaId: planCuotaId(c1!), importe: "1000.00", fechaCobro: "2026-09-09", medioVecino: "transferencia" }));
    await como(adminA(), (tx) => agregarCuotaARendicion(tx, { rendicionId: r, planCuotaId: planCuotaId(c2!), importe: "400.00", fechaCobro: "2026-09-11", medioVecino: "cheque" }));
    const sinPdf = await capturar(() => como(adminA(), (tx) => confirmarRendicion(tx, { rendicionId: r })));
    expect(sinPdf.message).toBe("Falta la rendición firmada por el estudio (PDF).");
    await como(adminA(), (tx) => adjuntarPdfDeRendicion(tx, { rendicionId: r, clave: clave(r, 1), nombre: "rendicion-septiembre.pdf", sha256: SHA, bytes: 1234 }));
    const { id: i1 } = await como(adminA(), (tx) =>
      agregarIngresoARendicion(tx, { rendicionId: r, fecha: "2026-10-01", medio: "transferencia", importe: "900.00", clave: clave(r, 2), nombre: null, sha256: sha(2), bytes: 99 }),
    );
    const noCuadra = await capturar(() => como(adminA(), (tx) => confirmarRendicion(tx, { rendicionId: r })));
    expect(noCuadra.message).toBe("Las cuotas suman $ 1.400,00 y los ingresos $ 900,00.");
    await como(adminA(), (tx) =>
      agregarIngresoARendicion(tx, { rendicionId: r, fecha: "2026-10-05", medio: "deposito", importe: "500.00", clave: clave(r, 3, "jpg"), nombre: "boleta.jpg", sha256: sha(3), bytes: 99 }),
    );
    const vista = await como(adminA(), (tx) => rendicion(tx, { rendicionId: r }));
    expect(vista).toMatchObject({ estado: "borrador", totalCuotas: "1.400,00", totalIngresos: "1.400,00", diferencia: "0,00", cuadra: true, puedeEditar: true });
    expect(vista.cuotas.map((c) => [c.cuota, c.parcial, c.cobro, c.importe])).toEqual([
      ["Cuota 1 de 2", false, "09/09/2026 · transferencia", "1.000,00"],
      ["Cuota 2 de 2", true, "11/09/2026 · cheque", "400,00"],
    ]);
    // Un ingreso a otra cuenta no entra.
    const otraCuenta = await capturar(() =>
      como(adminA(), (tx) =>
        enBase(() =>
          tx.execute(sql`
            insert into plan_rendicion_ingreso (rendicion_id, barrio_id, fecha, medio, importe, cuenta_cbu, comprobante_clave, comprobante_sha256, comprobante_bytes)
            values (${r}, ${barrio()}, '2026-10-01', 'transferencia', 1, '0000003110000000000441', ${clave(r, 9)}, ${sha(9)}, 1)`),
        ),
      ),
    );
    expect(otraCuenta.message).toBe("El ingreso tiene que ser a la cuenta del barrio.");
    expect(i1).toBeTruthy();
  });

  it("al confirmarla, cada pedazo de ingreso es un pago imputado a su cuota: 900 y 100 a la cuota 1, 400 a la 2", async () => {
    const { pagos } = await como(adminA(), (tx) => confirmarRendicion(tx, { rendicionId: r }));
    expect(pagos).toBe(3);
    const [c1, c2] = await cuotas(uf[0]);
    const { rows } = await admin.query<{ fecha: string; monto: string; origen: string; liq: string; comprobante: string | null }>(
      `select p.fecha::text, p.monto::text, p.origen, pi.liquidacion_id as liq, p.comprobante_adjunto as comprobante
         from plan_rendicion_pago rp join pago p on p.id = rp.pago_id join pago_imputacion pi on pi.pago_id = p.id
        where rp.rendicion_id = $1 order by p.fecha, p.monto desc`,
      [r],
    );
    expect(rows).toEqual([
      { fecha: "2026-10-01", monto: "900.00", origen: "rendicion", liq: c1!.liquidacion_id, comprobante: null },
      { fecha: "2026-10-05", monto: "400.00", origen: "rendicion", liq: c2!.liquidacion_id, comprobante: null },
      { fecha: "2026-10-05", monto: "100.00", origen: "rendicion", liq: c1!.liquidacion_id, comprobante: null },
    ]);
    expect([c1!.saldo, c2!.saldo]).toEqual(["0.00", "600.00"]);
    const vista = await como(adminA(), (tx) => rendicion(tx, { rendicionId: r }));
    expect(vista.estado).toBe("confirmada");
    expect(vista.puedeEditar).toBe(false);
    expect(vista.pagos.map((p) => [p.cuota, p.importe, p.estado])).toEqual([
      ["Cuota 1 de 2", "900,00", "pagada"],
      ["Cuota 1 de 2", "100,00", "pagada"],
      ["Cuota 2 de 2", "400,00", "parcial"],
    ]);
    const { rows: ev } = await admin.query<{ detalle: { sha256: string; importe: number } }>(
      "select detalle from plan_evento where plan_id = $1 and tipo = 'rendicion_confirmada'",
      [planDe.get(uf[0])],
    );
    expect(ev.map((e) => [e.detalle.sha256, Number(e.detalle.importe)])).toEqual([[SHA, 1400]]);
  });

  it("confirmada, no cambia: no se quita un ingreso ni se anula uno de sus pagos", async () => {
    const vista = await como(adminA(), (tx) => rendicion(tx, { rendicionId: r }));
    const e = await capturar(() => como(adminA(), (tx) => quitarIngresoDeRendicion(tx, { id: vista.ingresos[0]!.id })));
    expect(e.message).toBe("La rendición ya está confirmada: no se modifica.");
    const { rows } = await admin.query<{ id: string }>("select pago_id as id from plan_rendicion_pago where rendicion_id = $1 limit 1", [r]);
    const a = await capturar(() => como(adminA(), (tx) => anularPago(tx, { pagoId: rows[0]!.id, motivo: "Se cargó mal." })));
    expect(a.codigo).toBe("sin_permiso");
    expect(a.message).toBe("El pago de una rendición confirmada no se anula.");
    // Tampoco su imputación sola (security-engineer).
    const imp = await capturar(() =>
      como(adminA(), (tx) =>
        enBase(() => tx.execute(sql`update pago_imputacion set anulado_at = now(), anulado_por = app.current_user_id(), motivo_anulacion = 'Se cargó mal, prueba.' where pago_id = ${rows[0]!.id}`)),
      ),
    );
    expect(imp.message).toBe("El pago de una rendición confirmada no se anula.");
  });

  it("el estado y los pagos de una rendición no se escriben a mano, y el operador no la carga", async () => {
    const otra = await crearRendicion2();
    const estado = await capturar(() =>
      como(adminA(), (tx) => enBase(() => tx.execute(sql`update plan_rendicion set estado = 'confirmada' where id = ${otra}`))),
    );
    expect(estado.codigo).toBe("sin_permiso");
    const pago = await capturar(() =>
      como(adminA(), (tx) =>
        enBase(() =>
          tx.execute(sql`insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen) values (${barrio()}, ${uf[0]}, 1, '2026-10-01', 'rendicion')`),
        ),
      ),
    );
    expect(pago.message).toBe("El pago de una rendición lo registra la confirmación de la rendición.");
    const [, c2] = await cuotas(uf[0]);
    const operador = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        agregarCuotaARendicion(tx, { rendicionId: otra, planCuotaId: planCuotaId(c2!), importe: "1.00", fechaCobro: "2026-10-01", medioVecino: "efectivo" }),
      ),
    );
    expect(operador.codigo).toBe("sin_permiso");
    expect(operador.message).toBe("La rendición la carga la administración del barrio.");
  });

  it("el mismo comprobante no acredita dos ingresos, y dos borradores no cubren dos veces la misma cuota", async () => {
    const a = await crearRendicion2();
    const b = await crearRendicion2();
    const [, c2] = await cuotas(uf[0]);
    // A la cuota 2 le faltan 600: cada borrador rinde 400 (la suma, 800, pasa el saldo).
    for (const [r, n] of [[a, 20], [b, 30]] as const) {
      await como(adminA(), (tx) => agregarCuotaARendicion(tx, { rendicionId: r, planCuotaId: planCuotaId(c2!), importe: "400.00", fechaCobro: "2026-10-07", medioVecino: "efectivo" }));
      await como(adminA(), (tx) => adjuntarPdfDeRendicion(tx, { rendicionId: r, clave: clave(r, n), nombre: null, sha256: sha(n), bytes: 1 }));
      await como(adminA(), (tx) =>
        agregarIngresoARendicion(tx, { rendicionId: r, fecha: "2026-10-08", medio: "deposito", importe: "400.00", clave: clave(r, n + 1), nombre: null, sha256: sha(n + 1), bytes: 1 }),
      );
    }
    const repetido = await capturar(() =>
      como(adminA(), (tx) =>
        agregarIngresoARendicion(tx, { rendicionId: b, fecha: "2026-10-08", medio: "deposito", importe: "1.00", clave: clave(b, 99), nombre: null, sha256: sha(21), bytes: 1 }),
      ),
    );
    expect(repetido.message).toBe("Ese comprobante ya está cargado en otro ingreso del barrio.");
    await como(adminA(), (tx) => confirmarRendicion(tx, { rendicionId: a }));
    const segunda = await capturar(() => como(adminA(), (tx) => confirmarRendicion(tx, { rendicionId: b })));
    expect(segunda.message).toBe("Una cuota de la rendición ya no tiene ese saldo: otra rendición la cubrió.");
    expect((await cuotas(uf[0]))[1]!.saldo).toBe("200.00");
  });

  it("una cuota de otro barrio da el mismo mensaje que una que no existe", async () => {
    const otra = await crearRendicion2();
    const ajena = await cuotaDeOtroBarrio();
    const e1 = await capturar(() =>
      como(adminA(), (tx) => agregarCuotaARendicion(tx, { rendicionId: otra, planCuotaId: ajena, importe: "1.00", fechaCobro: "2026-10-01", medioVecino: "efectivo" })),
    );
    const e2 = await capturar(() =>
      como(adminA(), (tx) =>
        agregarCuotaARendicion(tx, { rendicionId: otra, planCuotaId: "00000000-0000-4000-8000-000000000000", importe: "1.00", fechaCobro: "2026-10-01", medioVecino: "efectivo" }),
      ),
    );
    expect(e1.message).toBe("Esa cuota no existe o no es de este barrio.");
    expect(e2.message).toBe(e1.message);
  });

  it("un plan con una rendición en borrador no cae; confirmada, cae y lo rendido vuelve a la deuda original", async () => {
    const otra = (await como(adminA(), (tx) => crearRendicion(tx, { barrioId: barrio(), estudioId: estudio, periodo: "2026-10" }))).rendicionId;
    const [c1] = await cuotas(uf[1]);
    await como(adminA(), (tx) => agregarCuotaARendicion(tx, { rendicionId: otra, planCuotaId: planCuotaId(c1!), importe: "100.00", fechaCobro: "2026-10-03", medioVecino: "efectivo" }));
    const e = await capturar(() => como(adminA(), (tx) => declararCaido(tx, { planId: planDe.get(uf[1])!, nota: "Dos cuotas impagas." })));
    expect(e.message).toBe("El plan tiene cuotas en una rendición en borrador.");
    await como(adminA(), (tx) => adjuntarPdfDeRendicion(tx, { rendicionId: otra, clave: clave(otra, 4), nombre: null, sha256: sha(4), bytes: 1 }));
    await como(adminA(), (tx) =>
      agregarIngresoARendicion(tx, { rendicionId: otra, fecha: "2026-10-06", medio: "transferencia", importe: "100.00", clave: clave(otra, 5), nombre: null, sha256: sha(5), bytes: 1 }),
    );
    await como(adminA(), (tx) => confirmarRendicion(tx, { rendicionId: otra }));
    // Con la cuota 1 todavía con 900 impagos y la 2 entera, cae.
    await como(adminA(), (tx) => declararCaido(tx, { planId: planDe.get(uf[1])!, nota: "Dos cuotas impagas." }));
    const { rows } = await admin.query<{ liq: string; monto: string }>(
      `select pi.liquidacion_id as liq, pi.monto_imputado::text as monto from plan_rendicion_pago rp join pago_imputacion pi on pi.pago_id = rp.pago_id
        where rp.rendicion_id = $1 and pi.anulado_at is null`,
      [otra],
    );
    expect(rows).toEqual([{ liq: liqDe.get(`${uf[1]}:2026-06`), monto: "100.00" }]);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("la cuota del barrio en la boleta, con lo que de verdad se debe (code-reviewer)", () => {
  it("pagada la cuota, la vista de la boleta ya emitida no la vuelve a cobrar", async () => {
    // La cuota 1 de la unidad 3 se pagó entera el 05/10 (arriba): la boleta de octubre queda sin cuota.
    const v = await como(adminA(), (tx) => armarVistaBoleta(tx, liqDe.get(`${uf[2]}:2026-10`)!, { registro }));
    expect(v.planDePagos).toBeNull();
    expect(v.bloquePago.importes.alVencimiento.monto).toBe(v.totales.aPagar.monto);
  });

  it("un mes generado después del vencimiento de la cuota se emite, y la cuota va en su renglón y no en el saldo", async () => {
    const { rows } = await admin.query<{ id: string }>("select id from periodo_expensa where barrio_id = $1 and periodo = '2026-11' and origen = 'mensual'", [
      barrio(),
    ]);
    const periodoId = rows[0]!.id;
    // Corte el 15/11: la cuota 2 de la unidad 3 venció el 10/11, pero nace recién al emitir noviembre.
    await como(adminA(), (tx) => generarLiquidaciones(tx, { periodoId, origenSaldo: "calculado", fechaCorteMora: "2026-11-15" }));
    await como(adminA(), (tx) => emitirPeriodo(tx, { periodoId }));
    const { rows: l } = await admin.query<{ id: string; saldo_anterior: string; total: string }>(
      "select id, saldo_anterior::text, total::text from liquidacion where periodo_id = $1 and unidad_funcional_id = $2",
      [periodoId, uf[2]],
    );
    // Agosto, septiembre y octubre (3.000): la cuota 1 está pagada y la 2 no es saldo anterior.
    expect(l[0]!.saldo_anterior).toBe("3000.00");
    const v = await como(adminA(), (tx) => armarVistaBoleta(tx, l[0]!.id, { registro }));
    expect(v.planDePagos?.cuotas.map((c) => [c.etiqueta, c.importe.monto])).toEqual([["Plan de pagos · cuota 2 de 2", "1000.00"]]);
    expect(v.planDePagos?.aPagarConLaCuota?.monto).toBe("5000.00");
    expect(v.bloquePago.importes.alVencimiento.monto).toBe("5000.00");
  });
});

const planCuotaIds = new Map<string, string>();
function planCuotaId(c: { liquidacion_id: string }): string {
  return planCuotaIds.get(c.liquidacion_id)!;
}
beforeAll(async () => {
  const { rows } = await admin.query<{ id: string; liquidacion_id: string }>(
    "select id, liquidacion_id from plan_cuota where barrio_id = $1 and liquidacion_id is not null",
    [barrio()],
  );
  for (const r of rows) planCuotaIds.set(r.liquidacion_id, r.id);
});

async function crearRendicion2(): Promise<string> {
  return (await como(adminA(), (tx) => crearRendicion(tx, { barrioId: barrio(), estudioId: estudio, periodo: "2026-08" }))).rendicionId;
}

/** Una cuota cualquiera en el barrio B1 (escrita sin triggers: solo importa que exista). */
async function cuotaDeOtroBarrio(): Promise<string> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    const { rows: u } = await c.query<{ id: string }>(
      "insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad, codigo_pago_numero) values ($1, '9', '9', 'construido', 9999) returning id",
      [arbol.barrioB1.id],
    );
    const { rows: p } = await c.query<{ id: string }>(
      `insert into plan_pago (barrio_id, unidad_funcional_id, tipo, sistema, modo_cobro, estudio_id, estado, deuda_capital, deuda_interes, total_cuotas,
                              cantidad_cuotas, creado_por)
       values ($1, $2, 'a_medida', 'libre', 'estudio', $3, 'pendiente', 10, 0, 10, 1, $4) returning id`,
      [arbol.barrioB1.id, u[0]!.id, estudio, adminA()],
    );
    const { rows: q } = await c.query<{ id: string }>(
      "insert into plan_cuota (plan_id, barrio_id, numero, vencimiento, importe, capital) values ($1, $2, 1, '2026-10-10', 10, 10) returning id",
      [p[0]!.id, arbol.barrioB1.id],
    );
    await c.query("commit");
    return q[0]!.id;
  } finally {
    c.release();
  }
}
