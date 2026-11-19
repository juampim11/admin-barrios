/**
 * Encargo F4 tramo 3 (BL-053 a, c), contra Postgres real (`0100`): anular una rendición confirmada y los
 * cuatro ojos. **Cada número al centavo, sobre un caso que se sigue a mano.**
 *
 * El barrio: cuatro unidades con coeficiente 0,25 y $ 4.000 de gasto por mes, o sea **$ 1.000 por
 * boleta**, sin interés por mora. Junio y julio quedan impagos y el 20/07/2026 tres unidades firman un plan
 * del catálogo **que cobra el estudio**, de 2 cuotas fijas con esos dos meses: **$ 2.000 → 2 cuotas de
 * $ 1.000**, el 10/08 y el 10/09. Se emiten agosto y septiembre (cada emisión emite su cuota).
 *   · Unidades 1 y 2: la rendición de septiembre rinde la cuota 1 entera de la 1 ($ 1.000) y $ 400 de la
 *     cuota 1 de la 2 (parcial). Al anularla, las dos vuelven exactamente a $ 1.000.
 *   · Unidad 3: una rendición paga sus dos cuotas y el plan se cumple. Al anularla, vuelve a vigente.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { anularRendicionSchema } from "@admin-barrios/shared/planes-rendicion";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { agregarEstudio, cambiarEstudioDelBarrio, moraDeLaAdministracion } from "../src/servicios/mora.ts";
import { crearPlanDeCatalogo, declararCaido } from "../src/servicios/planes.ts";
import { firmanteDelConvenio, guardarFirmanteDelConvenio, guardarReglasDePlanes } from "../src/servicios/planes-configuracion.ts";
import {
  adjuntarPdfDeRendicion,
  agregarCuotaARendicion,
  agregarIngresoARendicion,
  anularRendicion,
  confirmarRendicion,
  consecuenciasDeAnularRendicion,
  crearRendicion,
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
const planDe = new Map<string, string>();
let catalogo: string;
/** Junio y julio de cada unidad (la deuda que entra a los planes). */
const juniojulio = new Map<string, string[]>();
/** El día 10 del mes que viene: el primer vencimiento de un plan firmado hoy. */
let proximoVencimiento: string;
const periodoDe = new Map<string, string>();
const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminA = () => arbol.usuarios.adminEstudioA;
const otroAdmin = () => arbol.usuarios.adminBarrioA1;
const CUIT = "30710000170";
const CBU = "0000003110000000000519";
let n = 0;
const sha = () => String(++n).padStart(64, "d");
const clave = (r: string, ext = "pdf") => `barrios/${barrio()}/rendiciones/${r}/${String(n).padStart(22, "Q")}.${ext}`;

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
  periodoDe.set(periodo, rows[0]!.id);
  await admin.query("insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '4000.00')", [
    barrio(),
    rows[0]!.id,
    conceptoId,
  ]);
  await como(adminA(), (tx) => generarLiquidaciones(tx, { periodoId: rows[0]!.id }));
  await como(adminA(), (tx) => emitirPeriodo(tx, { periodoId: rows[0]!.id }));
}

/** Las cuotas de un plan: id, liquidación y lo que le falta pagar. */
async function cuotas(u: string) {
  const { rows } = await admin.query<{ id: string; numero: number; saldo: string }>(
    "select pc.id, pc.numero, app.saldo_de_liquidacion(pc.liquidacion_id)::text as saldo from plan_cuota pc where pc.plan_id = $1 order by pc.numero",
    [planDe.get(u)],
  );
  return rows;
}

/** Una rendición confirmada de septiembre con estas cuotas, cargada y confirmada por `usuario`. */
async function rendicionConfirmada(usuario: string, partes: readonly { cuota: string; importe: string }[]): Promise<string> {
  const { rendicionId: r } = await como(usuario, (tx) =>
    crearRendicion(tx, { barrioId: barrio(), estudioId: estudio, periodo: "2026-09", confirmarOtraRendicion: true }),
  );
  await cargar(usuario, r, partes);
  await como(usuario, (tx) => confirmarRendicion(tx, { rendicionId: r }));
  return r;
}

async function cargar(usuario: string, r: string, partes: readonly { cuota: string; importe: string }[]): Promise<void> {
  for (const p of partes) {
    await como(usuario, (tx) => agregarCuotaARendicion(tx, { rendicionId: r, planCuotaId: p.cuota, importe: p.importe, fechaCobro: "2026-09-12", medioVecino: "efectivo" }));
  }
  const total = partes.reduce((s, p) => s + Number(p.importe), 0).toFixed(2);
  const s1 = sha();
  await como(usuario, (tx) => adjuntarPdfDeRendicion(tx, { rendicionId: r, clave: clave(r), nombre: null, sha256: s1, bytes: 1 }));
  const s2 = sha();
  await como(usuario, (tx) => agregarIngresoARendicion(tx, { rendicionId: r, fecha: "2026-09-15", medio: "transferencia", importe: total, clave: clave(r), nombre: null, sha256: s2, bytes: 1 }));
}

async function limpiar(): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["plan_rendicion_pago", "plan_rendicion_ingreso", "plan_rendicion_cuota", "plan_rendicion", "plan_evento", "plan_cuota", "plan_liquidacion",
      "plan_pago", "plan_parametro_barrio_historia", "plan_parametro_barrio", "plan_catalogo_barrio", "estudio_barrio", "interes_condonacion",
      "pago_imputacion_interes", "pago_imputacion", "interes_devengado", "saldo_uf", "pago", "item_liquidacion", "liquidacion", "gasto_periodo",
      "periodo_expensa", "concepto", "coeficiente", "coeficiente_version", "unidad_funcional"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
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
  await limpiar();
  await admin.query("update barrio set cuenta_cbu = $2 where barrio_id = $1", [barrio(), CBU]);
  await borrarParametrosDe(admin, [barrio()]);
  const b = barrio();
  await cargarParametro(admin, b, "interes.cobra", false);
  await cargarParametro(admin, b, "imputacion.orden", "capital_primero");
  const { rows: ufs } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
     select $1, '6', g::text, 'construido' from generate_series(1, 4) g order by g returning id`,
    [b],
  );
  uf = [ufs[0]!.id, ufs[1]!.id, ufs[2]!.id, ufs[3]!.id];
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [b],
  );
  for (const u of uf) {
    await admin.query("insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1, $2, $3, 0.25)", [b, v[0]!.id, u]);
  }
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
  const { rows: c } = await admin.query<{ id: string }>(
    "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
    [b],
  );
  conceptoId = c[0]!.id;
  estudio = (
    await como(adminA(), (tx) =>
      agregarEstudio(tx, {
        administracionId: arbol.adminA.id,
        nombre: "Estudio de las Anulaciones",
        cuit: CUIT,
        correoAvisos: `${CUIT}@estudio.test`,
        telefonoBoleta: "(0351) 555-0170",
        preferenciaAviso: "cada_derivacion",
      }),
    )
  ).estudioId;
  await como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: b, estudioId: estudio, accion: "sumar" }));
  const k = await como(adminA(), (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into plan_catalogo (administracion_id, nombre, sistema, tasa_mensual, cuotas_min, cuotas_max, estudio_id, modo_cobro, creado_por)
      values (${arbol.adminA.id}, 'Dos cuotas con el estudio', 'fija', 0, 2, 6, ${estudio}, 'estudio', app.current_user_id()) returning id`),
  );
  await como(adminA(), (tx) => tx.execute(sql`insert into plan_catalogo_barrio (catalogo_id, barrio_id) values (${k.rows[0]!.id}, ${b})`));
  await emitirMes("2026-06", "2026-06-10");
  await emitirMes("2026-07", "2026-07-10");
  const { rows: liqs } = await admin.query<{ id: string; unidad_funcional_id: string }>(
    "select l.id, l.unidad_funcional_id from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id where pe.barrio_id = $1 and pe.periodo in ('2026-06', '2026-07')",
    [b],
  );
  catalogo = k.rows[0]!.id;
  for (const u of uf) juniojulio.set(u, liqs.filter((l) => l.unidad_funcional_id === u).map((l) => l.id));
  const { rows: h } = await admin.query<{ v: string }>(
    "select to_char(date_trunc('month', (now() at time zone zona_horaria)::date) + interval '1 month 9 days', 'YYYY-MM-DD') as v from barrio where barrio_id = $1",
    [b],
  );
  proximoVencimiento = h[0]!.v;
  for (const u of uf) {
    const { planId } = await como(adminA(), (tx) =>
      crearPlanDeCatalogo(tx, {
        unidadFuncionalId: u,
        liquidacionIds: liqs.filter((l) => l.unidad_funcional_id === u).map((l) => l.id),
        catalogoId: k.rows[0]!.id,
        cuotas: 2,
        primerVencimiento: "2026-08-10",
        fecha: "2026-07-20",
      }),
    );
    planDe.set(u, planId);
  }
  await emitirMes("2026-08", "2026-08-10");
  await emitirMes("2026-09", "2026-09-10");
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

describe("(a) anular una rendición confirmada", () => {
  let r: string;

  it("una cuota entera (1.000) y otra parcial (400): al anular, las dos vuelven exactamente a 1.000", async () => {
    const [c1u1] = await cuotas(uf[0]);
    const [c1u2] = await cuotas(uf[1]);
    r = await rendicionConfirmada(adminA(), [
      { cuota: c1u1!.id, importe: "1000.00" },
      { cuota: c1u2!.id, importe: "400.00" },
    ]);
    expect([(await cuotas(uf[0]))[0]!.saldo, (await cuotas(uf[1]))[0]!.saldo]).toEqual(["0.00", "600.00"]);
    const antes = await como(adminA(), (tx) => consecuenciasDeAnularRendicion(tx, { rendicionId: r }));
    expect(antes.map((c) => c.texto)).toEqual(["Mza 6 · Lote 1: sus cuotas vuelven a deber $ 1.000,00.", "Mza 6 · Lote 2: sus cuotas vuelven a deber $ 400,00."]);
    const { pagos } = await como(adminA(), (tx) => anularRendicion(tx, { rendicionId: r, motivo: "El estudio rindió el mes equivocado." }));
    expect(pagos).toBe(2);
    expect([(await cuotas(uf[0]))[0]!.saldo, (await cuotas(uf[1]))[0]!.saldo]).toEqual(["1000.00", "1000.00"]);
  });

  it("no se borra nada: la traza y los pagos siguen, anulados con el motivo; la rendición dice quién, cuándo y por qué", async () => {
    const { rows } = await admin.query<{ anulado: boolean; motivo: string; imputacion_viva: boolean }>(
      `select p.anulado_at is not null as anulado, p.motivo_anulacion as motivo,
              exists (select 1 from pago_imputacion pi where pi.pago_id = p.id and pi.anulado_at is null) as imputacion_viva
         from plan_rendicion_pago rp join pago p on p.id = rp.pago_id where rp.rendicion_id = $1`,
      [r],
    );
    expect(rows).toEqual([
      { anulado: true, motivo: "El estudio rindió el mes equivocado.", imputacion_viva: false },
      { anulado: true, motivo: "El estudio rindió el mes equivocado.", imputacion_viva: false },
    ]);
    const vista = await como(adminA(), (tx) => rendicion(tx, { rendicionId: r }));
    expect(vista.estado).toBe("anulada");
    expect(vista.anulada).toMatch(/^Anulada el \d{2}\/\d{2}\/\d{4} por la administración: El estudio rindió el mes equivocado\.$/);
    expect(vista.puedeAnular).toBe(false);
    expect(vista.pagos.map((p) => p.estado)).toEqual(["anulado", "anulado"]);
    const { rows: ev } = await admin.query<{ n: number }>("select count(*)::int as n from plan_evento where tipo = 'rendicion_anulada' and barrio_id = $1", [barrio()]);
    expect(ev[0]!.n).toBe(2);
  });

  it("una anulada no se anula otra vez, no se vuelve a confirmar y no se modifica", async () => {
    const dos = await capturar(() => como(adminA(), (tx) => anularRendicion(tx, { rendicionId: r, motivo: "Otra vez, por las dudas." })));
    expect(dos.message).toBe("La rendición ya está anulada.");
    const confirmar = await capturar(() => como(adminA(), (tx) => confirmarRendicion(tx, { rendicionId: r })));
    expect(confirmar.message).toBe("La rendición está anulada: no se vuelve a confirmar.");
    const [, c2u1] = await cuotas(uf[0]);
    const agregar = await capturar(() =>
      como(adminA(), (tx) => agregarCuotaARendicion(tx, { rendicionId: r, planCuotaId: c2u1!.id, importe: "1.00", fechaCobro: "2026-09-12", medioVecino: "efectivo" })),
    );
    expect(agregar.message).toBe("La rendición está anulada: no se modifica.");
  });

  it("el motivo es obligatorio", () => {
    const sinMotivo = anularRendicionSchema.safeParse({ rendicionId: r, motivo: "  " });
    expect(sinMotivo.error?.issues[0]?.message).toBe("Contá por qué se anula la rendición.");
  });

  it("una en borrador no se anula", async () => {
    const { rendicionId: b } = await como(adminA(), (tx) => crearRendicion(tx, { barrioId: barrio(), estudioId: estudio, periodo: "2026-09", confirmarOtraRendicion: true }));
    const e = await capturar(() => como(adminA(), (tx) => anularRendicion(tx, { rendicionId: b, motivo: "No se tendría que poder." })));
    expect(e.message).toBe("La rendición está en borrador: se corrige sin anularla.");
  });

  it("si la rendición cumplió un plan, al anularla vuelve a vigente: las cuotas con su saldo, y otra vez en la boleta y en la mora", async () => {
    const [c1, c2] = await cuotas(uf[2]);
    const rc = await rendicionConfirmada(adminA(), [
      { cuota: c1!.id, importe: "1000.00" },
      { cuota: c2!.id, importe: "1000.00" },
    ]);
    const estado = async () => (await admin.query<{ estado: string }>("select estado from plan_pago where id = $1", [planDe.get(uf[2])])).rows[0]!.estado;
    expect(await estado()).toBe("cumplido");
    const antes = await como(adminA(), (tx) => consecuenciasDeAnularRendicion(tx, { rendicionId: rc }));
    expect(antes).toEqual([
      {
        unidad: "Mza 6 · Lote 3",
        vuelveADeber: "2.000,00",
        reabre: true,
        deudaReimputada: null,
        bloquea: false,
        texto: "El plan de Mza 6 · Lote 3 está cumplido: vuelve a vigente y sus cuotas vuelven a deber $ 2.000,00.",
      },
    ]);
    await como(adminA(), (tx) => anularRendicion(tx, { rendicionId: rc, motivo: "Rendición cargada dos veces." }));
    expect(await estado()).toBe("vigente");
    expect((await cuotas(uf[2])).map((c) => c.saldo)).toEqual(["1000.00", "1000.00"]);
    const { rows: ev } = await admin.query<{ detalle: { rendicionId: string; motivo: string } }>(
      "select detalle from plan_evento where plan_id = $1 and tipo = 'reabierto'",
      [planDe.get(uf[2])],
    );
    expect(ev.map((e) => e.detalle)).toEqual([{ rendicionId: rc, motivo: "Rendición cargada dos veces." }]);
    // En la boleta de septiembre vuelve la cuota 2 (con lo que le falta), y en la mora la unidad está «En plan».
    const { rows: boleta } = await admin.query<{ unidad_funcional_id: string; numero: number; importe: string }>(
      "select unidad_funcional_id, numero, importe::text from app.cuotas_del_plan_en_boleta($1) where unidad_funcional_id = $2",
      [periodoDe.get("2026-09"), uf[2]],
    );
    expect(boleta).toEqual([{ unidad_funcional_id: uf[2], numero: 2, importe: "1000.00" }]);
    const mora = await como(adminA(), (tx) => moraDeLaAdministracion(tx, { barrioId: barrio() }));
    expect(mora!.filas.find((f) => f.unidadFuncionalId === uf[2])?.situacion).toBe("en_plan");
  });

  /** Lo que todavía deben junio y julio de una unidad (la deuda original de su plan). */
  const deudaOriginal = async (u: string) =>
    (
      await admin.query<{ s: string }>("select sum(app.saldo_de_liquidacion(l))::numeric(14,2)::text as s from unnest($1::uuid[]) l", [juniojulio.get(u)])
    ).rows[0]!.s;

  it("si el plan cayó, queda caído: el diálogo dice cuánto vuelve a deber la deuda de la unidad, y vuelve exactamente eso", async () => {
    // Unidad 2: la cuota 1 volvió a 1.000 al anular la primera rendición. Otra rinde 300 y el plan cae.
    const [c1] = await cuotas(uf[1]);
    const r2 = await rendicionConfirmada(adminA(), [{ cuota: c1!.id, importe: "300.00" }]);
    await como(adminA(), (tx) => declararCaido(tx, { planId: planDe.get(uf[1])!, nota: "Dos cuotas impagas." }));
    // La caída reimputó esos 300 a junio y julio: la deuda original quedó en 1.700.
    expect(await deudaOriginal(uf[1])).toBe("1700.00");
    const antes = await como(adminA(), (tx) => consecuenciasDeAnularRendicion(tx, { rendicionId: r2 }));
    expect(antes.map((c) => [c.texto, c.deudaReimputada])).toEqual([
      ["El plan de Mza 6 · Lote 2 cayó: lo que se había reimputado a la deuda de la unidad vuelve a deber $ 300,00.", { capital: "300,00", interes: "0,00" }],
    ]);
    await como(adminA(), (tx) => anularRendicion(tx, { rendicionId: r2, motivo: "El estudio no recibió ese pago." }));
    expect(await deudaOriginal(uf[1])).toBe("2000.00");
    expect((await admin.query<{ estado: string }>("select estado from plan_pago where id = $1", [planDe.get(uf[1])])).rows[0]!.estado).toBe("caido");
  });

  it("(code-reviewer, M1) si esa deuda está ahora en otro plan vigente, no se anula: reabriría lo que ese plan canceló", async () => {
    const [c1] = await cuotas(uf[3]);
    const r3 = await rendicionConfirmada(adminA(), [{ cuota: c1!.id, importe: "300.00" }]);
    await como(adminA(), (tx) => declararCaido(tx, { planId: planDe.get(uf[3])!, nota: "Dos cuotas impagas." }));
    // Un plan nuevo sobre junio y julio (con los 300 reimputados ahí adentro).
    await como(adminA(), (tx) =>
      crearPlanDeCatalogo(tx, { unidadFuncionalId: uf[3], liquidacionIds: juniojulio.get(uf[3])!, catalogoId: catalogo, cuotas: 2, primerVencimiento: proximoVencimiento }),
    );
    const e = await capturar(() => como(adminA(), (tx) => anularRendicion(tx, { rendicionId: r3, motivo: "Prueba del freno." })));
    expect(e.message).toBe("La deuda que cubrió la rendición está ahora en otro plan vigente o cumplido: no se anula.");
  });
});

describe("(b) quién firma los convenios", () => {
  it("se carga en un barrio que todavía no tenía reglas de planes (alta de la fila), y se vuelve a vaciar", async () => {
    expect(await como(adminA(), (tx) => firmanteDelConvenio(tx, { barrioId: barrio() }))).toBeNull();
    await como(adminA(), (tx) =>
      guardarFirmanteDelConvenio(tx, { barrioId: barrio(), tipo: "administrador_poder", nombre: "Juan Gómez", poder: "Esc. N.º 1 del 01/01/2025", cargo: "No va" }),
    );
    // El cargo no corresponde al tipo: no se guarda.
    expect(await como(adminA(), (tx) => firmanteDelConvenio(tx, { barrioId: barrio() }))).toEqual({
      tipo: "administrador_poder",
      nombre: "Juan Gómez",
      cargo: null,
      poder: "Esc. N.º 1 del 01/01/2025",
    });
    await como(adminA(), (tx) => guardarFirmanteDelConvenio(tx, { barrioId: barrio(), tipo: "ninguno" }));
    expect(await como(adminA(), (tx) => firmanteDelConvenio(tx, { barrioId: barrio() }))).toBeNull();
  });
});

describe("(c) cuatro ojos", () => {
  it("apagado (por defecto), quien carga la rendición la confirma", async () => {
    const [, c2u1] = await cuotas(uf[0]);
    const r = await rendicionConfirmada(adminA(), [{ cuota: c2u1!.id, importe: "100.00" }]);
    expect((await como(adminA(), (tx) => rendicion(tx, { rendicionId: r }))).estado).toBe("confirmada");
  });

  it("encendido, quien la cargó no la confirma (la pantalla lo dice y el servidor lo frena); otra persona sí", async () => {
    await como(adminA(), (tx) =>
      guardarReglasDePlanes(tx, { barrioId: barrio(), cuotasParaCaer: "2", ordenImputacion: "administracion", financiaMora: "no", quitaRequiereActa: "no", rendicionCuatroOjos: "si" }),
    );
    const [, c2u1] = await cuotas(uf[0]);
    const { rendicionId: r } = await como(adminA(), (tx) => crearRendicion(tx, { barrioId: barrio(), estudioId: estudio, periodo: "2026-09", confirmarOtraRendicion: true }));
    await cargar(adminA(), r, [{ cuota: c2u1!.id, importe: "100.00" }]);
    expect((await como(adminA(), (tx) => rendicion(tx, { rendicionId: r }))).laConfirmaOtraPersona).toBe(true);
    expect((await como(otroAdmin(), (tx) => rendicion(tx, { rendicionId: r }))).laConfirmaOtraPersona).toBe(false);
    const e = await capturar(() => como(adminA(), (tx) => confirmarRendicion(tx, { rendicionId: r })));
    expect(e.codigo).toBe("sin_permiso");
    expect(e.message).toBe("La confirma otra persona de la administración.");
    await como(otroAdmin(), (tx) => confirmarRendicion(tx, { rendicionId: r }));
    expect((await como(adminA(), (tx) => rendicion(tx, { rendicionId: r }))).estado).toBe("confirmada");
  });

  it("encendido, también la frena quien cargó la última cuota o el último ingreso, aunque no la haya creado", async () => {
    const [, c2u2] = await cuotas(uf[0]);
    const { rendicionId: r } = await como(otroAdmin(), (tx) => crearRendicion(tx, { barrioId: barrio(), estudioId: estudio, periodo: "2026-09", confirmarOtraRendicion: true }));
    await cargar(adminA(), r, [{ cuota: c2u2!.id, importe: "50.00" }]);
    // La creó `otroAdmin` y la terminó de cargar `adminA`: ninguno de los dos la confirma.
    const e1 = await capturar(() => como(adminA(), (tx) => confirmarRendicion(tx, { rendicionId: r })));
    const e2 = await capturar(() => como(otroAdmin(), (tx) => confirmarRendicion(tx, { rendicionId: r })));
    expect([e1.message, e2.message]).toEqual(["La confirma otra persona de la administración.", "La confirma otra persona de la administración."]);
  });
});
