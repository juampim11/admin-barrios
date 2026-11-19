/**
 * Encargo F4 tramo 2 (BL-055 a, b, c), contra Postgres real (`0099`): los controles de los planes. Cada
 * cifra al centavo, sobre un caso que se sigue a mano.
 *
 * El barrio: ocho unidades con coeficiente 0,125 y $ 8.000 de gasto por mes, o sea **$ 1.000 por boleta**,
 * sin interés por mora (la deuda que entra a un plan es justo el capital). Junio, julio y agosto vencieron
 * (el 10 de cada mes) y nadie pagó: cada unidad debe $ 3.000. A un plan entran junio y julio (**$ 2.000**);
 * agosto queda afuera, vencido, para que la unidad tenga deuda que derivar.
 *
 *   · Unidad 1: el plan a medida que cobra de más (la tasa equivalente y el tope) y dos planes abiertos.
 *   · Unidad 2: plan del catálogo vigente → no se deriva.
 *   · Unidad 3: plan a medida pendiente → no se deriva.
 *   · Unidad 4: derivada, firma un plan del catálogo → confirma y sale del estudio.
 *   · Unidad 5: derivada, se aprueba un plan a medida → confirma y sale del estudio.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { agregarEstudio, cambiarEstudioDelBarrio, derivar, moraDeLaAdministracion } from "../src/servicios/mora.ts";
import { aprobarPlan, crearPlanDeCatalogo, proponerPlanAMedida, retirarPlan } from "../src/servicios/planes.ts";
import { configuracionDePlanes, guardarReglasGeneralesDePlanes } from "../src/servicios/planes-configuracion.ts";
import { borrarArbol, borrarParametrosDe, cargarParametro, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf: string[];
let conceptoId: string;
let catalogo: string;
let estudio: string;
/** El día 10 de los próximos meses: el cronograma tiene que vencer después de hoy. */
let vence: readonly string[];
const liqDe = new Map<string, string>(); // `${unidad}:${periodo}` → liquidación

const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminA = () => arbol.usuarios.adminEstudioA;
const CUIT = "30710000162";
const ESTUDIO = "Estudio de los Controles";

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
  await admin.query("insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '8000.00')", [
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

const junioYJulio = (u: string) => [liqDe.get(`${u}:2026-06`)!, liqDe.get(`${u}:2026-07`)!];

/** Un plan a medida de una cuota (la 1, el mes que viene) por `importe`, sobre junio y julio. */
const aMedida = (u: string, importe: string, confirmarExcedente = false) =>
  como(adminA(), (tx) =>
    proponerPlanAMedida(tx, {
      unidadFuncionalId: u,
      liquidacionIds: junioYJulio(u),
      cronograma: [{ numero: 1, vencimiento: vence[0]!, importe }],
      motivo: "Prueba de los controles del plan.",
      confirmarExcedente,
    }),
  );

const delCatalogo = (u: string, confirmarDerivada = false) =>
  como(adminA(), (tx) =>
    crearPlanDeCatalogo(tx, { unidadFuncionalId: u, liquidacionIds: junioYJulio(u), catalogoId: catalogo, cuotas: 2, primerVencimiento: vence[0]!, confirmarDerivada }),
  );

const derivarA = (u: string) =>
  como(adminA(), (tx) => derivar(tx, { unidades: [{ unidadFuncionalId: u, barrioId: barrio(), estudioId: estudio }], motivo: "criterio_cumplido", nota: null }));

const derivacionDe = async (u: string) =>
  (
    await admin.query<{ retirada: boolean; motivo: string | null }>(
      "select retirada_at is not null as retirada, retiro_motivo as motivo from derivacion where unidad_funcional_id = $1 order by derivada_at desc limit 1",
      [u],
    )
  ).rows[0];

const tope = (porcentaje: string) =>
  como(adminA(), (tx) => guardarReglasGeneralesDePlanes(tx, { administracionId: arbol.adminA.id, ordenImputacion: "mas_vieja_primero", topeTasaPorcentaje: porcentaje }));

async function limpiar(): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["plan_evento", "plan_cuota", "plan_liquidacion", "plan_pago", "plan_catalogo_barrio", "gestion_anulacion", "gestion", "derivacion_foto",
      "derivacion", "estudio_barrio", "interes_condonacion", "pago_imputacion_interes", "pago_imputacion", "interes_devengado", "saldo_uf", "pago",
      "item_liquidacion", "liquidacion", "gasto_periodo", "periodo_expensa", "concepto", "coeficiente", "coeficiente_version", "unidad_funcional"]) {
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
     select $1, '8', g::text, 'construido' from generate_series(1, 8) g order by g returning id`,
    [n],
  );
  uf = ufs.map((r) => r.id);
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [n],
  );
  for (const u of uf) {
    await admin.query("insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1, $2, $3, 0.125)", [n, v[0]!.id, u]);
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
        nombre: ESTUDIO,
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
      insert into plan_catalogo (administracion_id, nombre, sistema, tasa_mensual, cuotas_min, cuotas_max, creado_por)
      values (${arbol.adminA.id}, 'Hasta 6 cuotas sin interés', 'fija', 0, 2, 6, app.current_user_id()) returning id`),
  );
  catalogo = k.rows[0]!.id;
  await como(adminA(), (tx) => tx.execute(sql`insert into plan_catalogo_barrio (catalogo_id, barrio_id) values (${catalogo}, ${n})`));
  await emitirMes("2026-06", "2026-06-10");
  await emitirMes("2026-07", "2026-07-10");
  await emitirMes("2026-08", "2026-08-10");
  const { rows: h } = await admin.query<{ vence: string[] }>(
    `select array(select to_char(date_trunc('month', x.hoy) + make_interval(months => m) + interval '9 days', 'YYYY-MM-DD') from generate_series(1, 3) m) as vence
       from (select (now() at time zone zona_horaria)::date as hoy from barrio where barrio_id = $1) x`,
    [n],
  );
  vence = h[0]!.vence;
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

describe("(a) un plan a medida que cobra más que la deuda ($ 2.000)", () => {
  it("una cuota de $ 2.200 al mes es 10 % mensual: pide confirmar con el importe de más y la tasa", async () => {
    const e = await capturar(() => aMedida(uf[0]!, "2200.00"));
    expect(e.codigo).toBe("plan_excede_deuda_requiere_confirmacion");
    expect(e.message).toBe("El cronograma cobra $ 200,00 más que la deuda: equivale a un 10,00 % mensual. ¿Lo confirmás?");
    expect(e.datos).toMatchObject({ excedente: "200.00", tasa: "0.100000" });
  });

  it("$ 2.201 es 10,05 %: pasa el tope de 10 % y no se guarda, ni confirmando (el servidor no confía en la pantalla)", async () => {
    const e = await capturar(() => aMedida(uf[0]!, "2201.00", true));
    expect(e.codigo).toBe("dato_invalido");
    expect(e.message).toBe("El cronograma equivale a un 10,05 % mensual y el tope es 10 %: ajustá las cuotas.");
    const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from plan_pago where unidad_funcional_id = $1", [uf[0]]);
    expect(rows[0]!.n).toBe(0);
  });

  it("(code-reviewer, m3) se confirma una cifra: si las cuotas cambiaron después de ver el pedido, vuelve a preguntar", async () => {
    const e = await capturar(() =>
      como(adminA(), (tx) =>
        proponerPlanAMedida(tx, {
          unidadFuncionalId: uf[0]!,
          liquidacionIds: junioYJulio(uf[0]!),
          cronograma: [{ numero: 1, vencimiento: vence[0]!, importe: "2150.00" }],
          motivo: "Prueba de los controles del plan.",
          confirmarExcedente: true,
          // Lo que se le mostró era el pedido de $ 2.200 (200 de más); después bajó la cuota a 2.150.
          cifrasConfirmadas: "200.00",
        }),
      ),
    );
    expect(e.codigo).toBe("plan_excede_deuda_requiere_confirmacion");
    expect(e.datos["cifras"]).toBe("150.00");
  });

  it("justo en el tope ($ 2.200, 10 %) y confirmado, se guarda pendiente", async () => {
    const { planId } = await aMedida(uf[0]!, "2200.00", true);
    const { rows } = await admin.query<{ estado: string; total: string; fin: string }>(
      "select estado, total_cuotas::text as total, interes_financiacion::text as fin from plan_pago where id = $1",
      [planId],
    );
    expect(rows[0]).toEqual({ estado: "pendiente", total: "2200.00", fin: "200.00" });
  });

  it("(c) con ese plan pendiente, la unidad no puede tener otro abierto: ni a medida ni del catálogo", async () => {
    const otro = await capturar(() => aMedida(uf[0]!, "2000.00"));
    expect(otro.codigo).toBe("plan_abierto_ya_existe");
    expect(otro.message).toBe("La unidad ya tiene un plan abierto: aprobalo, rechazalo o retiralo antes de armar otro.");
    const catalogoTambien = await capturar(() => delCatalogo(uf[0]!));
    expect(catalogoTambien.codigo).toBe("plan_abierto_ya_existe");
  });

  it("(c) la base lo impone aunque se escriba a mano (sin triggers: el índice único no es un trigger)", async () => {
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await expect(
        c.query(
          `insert into plan_pago (barrio_id, unidad_funcional_id, tipo, sistema, modo_cobro, estado, deuda_capital, deuda_interes, total_cuotas, cantidad_cuotas, creado_por)
           values ($1, $2, 'a_medida', 'libre', 'barrio', 'pendiente', 1, 0, 1, 1, $3)`,
          [barrio(), uf[0], adminA()],
        ),
      ).rejects.toThrow(/uq_plan_pago_abierto_por_unidad/);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("retirado el pendiente, se puede armar otro; sin exceso no pide nada", async () => {
    const { rows } = await admin.query<{ id: string }>("select id from plan_pago where unidad_funcional_id = $1 and estado = 'pendiente'", [uf[0]]);
    await como(adminA(), (tx) => retirarPlan(tx, { planId: rows[0]!.id, motivo: "Prueba." }));
    const { planId } = await aMedida(uf[0]!, "2000.00");
    await como(adminA(), (tx) => retirarPlan(tx, { planId, motivo: "Prueba." }));
  });

  it("el tope lo fija la administración: con 5 %, $ 2.200 (10 %) ya no entra y $ 2.100 (5 %, justo) sí", async () => {
    await tope("5");
    const cfg = await como(adminA(), (tx) => configuracionDePlanes(tx, { administracionId: arbol.adminA.id }));
    expect(cfg?.topeTasaPorcentaje).toBe("5");
    const e = await capturar(() => aMedida(uf[0]!, "2200.00", true));
    expect(e.message).toBe("El cronograma equivale a un 10,00 % mensual y el tope es 5 %: ajustá las cuotas.");
    const { planId } = await aMedida(uf[0]!, "2100.00", true);
    await como(adminA(), (tx) => retirarPlan(tx, { planId, motivo: "Prueba." }));
    await tope("10");
  });
});

describe("(b) derivar y planes abiertos", () => {
  it("una unidad con un plan vigente no se deriva", async () => {
    await delCatalogo(uf[1]!);
    const e = await capturar(() => derivarA(uf[1]!));
    expect(e.codigo).toBe("derivacion_con_plan_abierto");
    expect(e.message).toBe("La unidad tiene un plan de pagos abierto: no se deriva mientras siga.");
  });

  it("una unidad con un plan pendiente tampoco", async () => {
    await aMedida(uf[2]!, "2000.00");
    const e = await capturar(() => derivarA(uf[2]!));
    expect(e.codigo).toBe("derivacion_con_plan_abierto");
  });

  it("(code-reviewer, M1) la lista de mora no ofrece para derivar las unidades con un plan abierto: vigente o pendiente cuentan como «En plan»", async () => {
    const m = await como(adminA(), (tx) => moraDeLaAdministracion(tx, { barrioId: barrio() }));
    const situacion = (u: string) => m!.filas.find((f) => f.unidadFuncionalId === u)?.situacion;
    expect(situacion(uf[1]!)).toBe("en_plan");
    expect(situacion(uf[2]!)).toBe("en_plan");
    // Una sin plan sigue pudiendo derivarse (si cumple el criterio del barrio).
    expect(situacion(uf[5]!)).not.toBe("en_plan");
  });

  it("firmar un plan del catálogo sobre una unidad derivada pide confirmar; confirmado, la saca del estudio como siempre", async () => {
    await derivarA(uf[3]!);
    const e = await capturar(() => delCatalogo(uf[3]!));
    expect(e.codigo).toBe("plan_unidad_derivada_requiere_confirmacion");
    expect(e.message).toBe(`La unidad está derivada a ${ESTUDIO}: al firmar sale del estudio.`);
    expect(await derivacionDe(uf[3]!)).toEqual({ retirada: false, motivo: null });
    await delCatalogo(uf[3]!, true);
    expect(await derivacionDe(uf[3]!)).toEqual({ retirada: true, motivo: "plan_administracion" });
  });

  it("aprobar un plan a medida sobre una unidad derivada pide confirmar; confirmado, la saca del estudio", async () => {
    await derivarA(uf[4]!);
    const { planId } = await aMedida(uf[4]!, "2000.00");
    const e = await capturar(() => como(adminA(), (tx) => aprobarPlan(tx, { planId })));
    expect(e.codigo).toBe("plan_unidad_derivada_requiere_confirmacion");
    expect((await admin.query<{ estado: string }>("select estado from plan_pago where id = $1", [planId])).rows[0]!.estado).toBe("pendiente");
    await como(adminA(), (tx) => aprobarPlan(tx, { planId, confirmarDerivada: true }));
    expect((await admin.query<{ estado: string }>("select estado from plan_pago where id = $1", [planId])).rows[0]!.estado).toBe("vigente");
    expect(await derivacionDe(uf[4]!)).toEqual({ retirada: true, motivo: "plan_administracion" });
  });
});
