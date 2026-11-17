/**
 * Encargo P2a-2, contra Postgres real (`0095`): armar un plan desde las pantallas 2 y 3.
 *
 *   · lo que lee la pantalla (`datosParaArmarPlan`);
 *   · el plan del catálogo con «quién cobra» elegido, y fuera de sus parámetros (pasa a ser a medida);
 *   · el estudio de un plan del catálogo, controlado por la base: de la administración y de cada barrio;
 *   · el acta: si el barrio la exige, un plan con quita no se aprueba sin ella.
 *
 * El caso, para leer a mano: el barrio A1 de «Estudio Pérez», cuatro unidades que deben enero 2026
 * (vencido el 10/01) a $ 1.000 cada una, sin interés por mora (el barrio no lo cobra). Un plan a medida
 * de $ 900 tiene $ 100 de quita de capital.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { agregarEstudio, cambiarEstudioDelBarrio } from "../src/servicios/mora.ts";
import { aprobarPlan, crearPlanDeCatalogo, planesDeUnidad, proponerPlanAMedida, retirarPlan } from "../src/servicios/planes.ts";
import { darDeBajaPlanDelCatalogo, guardarPlanDelCatalogo, guardarReglasDePlanes } from "../src/servicios/planes-configuracion.ts";
import { datosParaArmarPlan } from "../src/servicios/planes-armar.ts";
import { borrarArbol, borrarParametrosDe, cargarParametro, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf: [string, string, string, string];
let enero: Map<string, string>;
let hoy: string;
let estudio: string;
let estudioDeOtra: string;
let catalogo: string;

const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminA = () => arbol.usuarios.adminEstudioA;
const CUIT_A = "30710000065";
const CUIT_B = "30710000073";

const dia = (n: number) => {
  const d = new Date(`${hoy}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

const aMedida = (unidad: string, importe: string, acta: { actaReferencia?: string | null } = {}) =>
  como(adminA(), (tx) =>
    proponerPlanAMedida(tx, {
      unidadFuncionalId: unidad,
      liquidacionIds: [enero.get(unidad)!],
      cronograma: [
        { numero: 1, vencimiento: dia(30), importe: "450.00" },
        { numero: 2, vencimiento: dia(60), importe: importe },
      ],
      motivo: "Ofrece pagar en dos cuotas.",
      ...acta,
    }),
  );

const estadoDe = async (planId: string) =>
  (await admin.query<{ estado: string }>("select estado from plan_pago where id = $1", [planId])).rows[0]!.estado;

async function limpiar(): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["plan_evento", "plan_cuota", "plan_liquidacion", "plan_pago", "plan_parametro_barrio_historia", "plan_parametro_barrio",
      "plan_catalogo_barrio", "pago_imputacion_interes", "pago_imputacion", "interes_devengado", "pago", "derivacion_foto", "derivacion",
      "estudio_barrio"]) {
      await c.query(`delete from ${t} where barrio_id = any($1::uuid[])`, [[barrio(), arbol.barrioA2.id]]);
    }
    await c.query("delete from plan_catalogo where administracion_id = $1", [arbol.adminA.id]);
    await c.query("delete from estudio_administracion where administracion_id = any($1::uuid[])", [[arbol.adminA.id, arbol.adminB.id]]);
    await c.query("delete from estudio_juridico where cuit = any($1::text[])", [[CUIT_A, CUIT_B]]);
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
  await crearBarrio(admin, arbol.barrioA2.id);
  await crearBarrio(admin, arbol.barrioB1.id);
  await borrarParametrosDe(admin, [barrio()]);
  await cargarParametro(admin, barrio(), "interes.cobra", false);
  const { rows: ufs } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
     values ($1,'2','1','construido'), ($1,'2','2','construido'), ($1,'2','3','construido'), ($1,'2','4','construido') returning id`,
    [barrio()],
  );
  uf = [ufs[0]!.id, ufs[1]!.id, ufs[2]!.id, ufs[3]!.id];
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [barrio()],
  );
  for (const u of uf) {
    await admin.query("insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1, $2, $3, 0.25)", [barrio(), v[0]!.id, u]);
  }
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
  const { rows: c } = await admin.query<{ id: string }>(
    "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
    [barrio()],
  );
  const { rows: p } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, '2026-01', '2026-01-10') returning id",
    [barrio()],
  );
  await admin.query("insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '4000.00')", [
    barrio(),
    p[0]!.id,
    c[0]!.id,
  ]);
  await como(adminA(), (tx) => generarLiquidaciones(tx, { periodoId: p[0]!.id, origenSaldo: "calculado", fechaCorteMora: "2026-01-01" }));
  await como(adminA(), (tx) => emitirPeriodo(tx, { periodoId: p[0]!.id }));
  const { rows: l } = await admin.query<{ id: string; unidad_funcional_id: string }>("select id, unidad_funcional_id from liquidacion where periodo_id = $1", [
    p[0]!.id,
  ]);
  enero = new Map(l.map((x) => [x.unidad_funcional_id, x.id]));
  hoy = (await admin.query<{ hoy: string }>("select (now() at time zone zona_horaria)::date::text as hoy from barrio where barrio_id = $1", [barrio()])).rows[0]!
    .hoy;

  await limpiar();
  const nuevo = (usuario: string, administracionId: string, nombre: string, cuit: string) =>
    como(usuario, (tx) =>
      agregarEstudio(tx, { administracionId, nombre, cuit, correoAvisos: `${cuit}@estudio.test`, telefonoBoleta: null, preferenciaAviso: "cada_derivacion" }),
    );
  estudio = (await nuevo(adminA(), arbol.adminA.id, "Estudio de los Planes", CUIT_A)).estudioId;
  estudioDeOtra = (await nuevo(arbol.usuarios.adminEstudioB, arbol.adminB.id, "Estudio de Otra Administración", CUIT_B)).estudioId;
  // El estudio trabaja en A1, no en A2.
  await como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: barrio(), estudioId: estudio, accion: "sumar" }));
  catalogo = (
    await como(adminA(), (tx) =>
      guardarPlanDelCatalogo(tx, {
        administracionId: arbol.adminA.id,
        nombre: "Hasta 6 cuotas con el estudio",
        sistema: "fija",
        tasaPorcentaje: null,
        cuotasMin: "2",
        cuotasMax: "6",
        anticipo: "no",
        anticipoMaxPorcentaje: null,
        deudaMaxima: null,
        estudioId: estudio,
        modoCobro: "estudio",
        barrioIds: [barrio()],
      }),
    )
  ).planId;
});

afterAll(async () => {
  await limpiar();
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["item_liquidacion", "liquidacion", "gasto_periodo", "periodo_expensa", "concepto", "coeficiente", "coeficiente_version", "unidad_funcional"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("delete from barrio where barrio_id = any($1::uuid[])", [[barrio(), arbol.barrioA2.id, arbol.barrioB1.id]]);
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

describe("lo que lee la pantalla de armar", () => {
  it("los meses vencidos con su capital, el catálogo del barrio, sus estudios, las reglas y la primera cuota", async () => {
    const d = (await como(adminA(), (tx) => datosParaArmarPlan(tx, { unidadFuncionalId: uf[0] })))!;
    expect(d.meses).toEqual([{ liquidacionId: enero.get(uf[0]), periodo: "2026-01", vencimiento: "2026-01-10", capital: "1000.00", interes: "0.00" }]);
    expect(d.catalogo.map((c) => [c.nombre, c.cuotasMin, c.cuotasMax, c.estudio?.nombre, c.modoCobro])).toEqual([
      ["Hasta 6 cuotas con el estudio", 2, 6, "Estudio de los Planes", "estudio"],
    ]);
    expect(d.estudios).toEqual([{ id: estudio, nombre: "Estudio de los Planes" }]);
    expect(d.reglas).toEqual({ financiaMora: false, quitaRequiereActa: false });
    // El mes que viene, el día de vencimiento de la boleta (10 si el barrio no tiene uno cargado).
    const { rows } = await admin.query<{ esperado: string }>(
      `select (date_trunc('month', $2::date) + interval '1 month' + (coalesce(dia_vencimiento, 10) - 1) * interval '1 day')::date::text as esperado
         from barrio where barrio_id = $1`,
      [barrio(), hoy],
    );
    expect(d.primerVencimiento).toBe(rows[0]!.esperado);
    expect(d.vencimientoAnticipo).toBe(dia(5));
    expect(d.planAbierto).toBeNull();
    expect(d.puedeArmar).toBe(true);
  });

  it("el contador lee, pero no arma", async () => {
    const d = (await como(arbol.usuarios.contadorA1, (tx) => datosParaArmarPlan(tx, { unidadFuncionalId: uf[0] })))!;
    expect(d.puedeArmar).toBe(false);
  });
});

describe("el estudio de un plan del catálogo lo controla la base (0095)", () => {
  it("un barrio donde el estudio no trabaja no entra en el plan", async () => {
    const e = await capturar(() =>
      como(adminA(), (tx) =>
        guardarPlanDelCatalogo(tx, {
          administracionId: arbol.adminA.id,
          planId: catalogo,
          nombre: "Hasta 6 cuotas con el estudio",
          sistema: "fija",
          tasaPorcentaje: null,
          cuotasMin: "2",
          cuotasMax: "6",
          anticipo: "no",
          anticipoMaxPorcentaje: null,
          deudaMaxima: null,
          estudioId: estudio,
          modoCobro: "estudio",
          barrioIds: [barrio(), arbol.barrioA2.id],
        }),
      ),
    );
    expect(e.message).toBe("El estudio del plan no trabaja en alguno de los barrios elegidos.");
    // Y directo contra la tabla, sin el servicio.
    await expect(
      como(adminA(), (tx) => tx.execute(sql`insert into plan_catalogo_barrio (catalogo_id, barrio_id) values (${catalogo}, ${arbol.barrioA2.id})`)),
    ).rejects.toThrow(/no trabaja en uno de sus barrios/);
  });

  it("un estudio de otra administración no entra, ni por el servicio ni directo", async () => {
    await expect(
      como(adminA(), (tx) =>
        tx.execute(sql`
          insert into plan_catalogo (administracion_id, nombre, sistema, cuotas_min, cuotas_max, estudio_id, modo_cobro, creado_por)
          values (${arbol.adminA.id}, 'Con un estudio ajeno', 'fija', 1, 3, ${estudioDeOtra}, 'estudio', app.current_user_id())`),
      ),
    ).rejects.toThrow(/no trabaja con la administración/);
    await expect(
      como(adminA(), (tx) => tx.execute(sql`update plan_catalogo set estudio_id = ${estudioDeOtra} where id = ${catalogo}`)),
    ).rejects.toThrow(/no trabaja con la administración/);
  });

  it("no se saca el estudio de un barrio mientras un plan activo lo use; dado de baja el plan, sí", async () => {
    // Otro plan, para no tocar el que usan los demás tests.
    const { planId } = await como(adminA(), (tx) =>
      guardarPlanDelCatalogo(tx, {
        administracionId: arbol.adminA.id,
        nombre: "Para sacar el estudio",
        sistema: "fija",
        tasaPorcentaje: null,
        cuotasMin: "1",
        cuotasMax: "3",
        anticipo: "no",
        anticipoMaxPorcentaje: null,
        deudaMaxima: null,
        estudioId: estudio,
        modoCobro: "barrio",
        barrioIds: [barrio()],
      }),
    );
    const sacar = () => como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: barrio(), estudioId: estudio, accion: "sacar" }));
    const e = await capturar(sacar);
    expect(e.message).toBe("Ese estudio está en un plan del catálogo de este barrio.");
    await como(adminA(), (tx) => darDeBajaPlanDelCatalogo(tx, { administracionId: arbol.adminA.id, planId }));
    // Sigue el otro plan activo con el mismo estudio: todavía no se puede.
    expect((await capturar(sacar)).message).toBe("Ese estudio está en un plan del catálogo de este barrio.");
  });
});

describe("el plan del catálogo desde la pantalla 2", () => {
  it("fuera de sus parámetros se rechaza con el motivo que muestra la pantalla", async () => {
    const e = await capturar(() =>
      como(adminA(), (tx) =>
        crearPlanDeCatalogo(tx, { unidadFuncionalId: uf[0], liquidacionIds: [enero.get(uf[0])!], catalogoId: catalogo, cuotas: 8, primerVencimiento: dia(30) }),
      ),
    );
    expect(e.message).toBe("El plan va de 2 a 6 cuotas.");
  });

  it("«quién cobra» se puede cambiar al barrio: el plan queda sin estudio", async () => {
    const { planId } = await como(adminA(), (tx) =>
      crearPlanDeCatalogo(tx, {
        unidadFuncionalId: uf[0],
        liquidacionIds: [enero.get(uf[0])!],
        catalogoId: catalogo,
        cuotas: 2,
        primerVencimiento: dia(30),
        modoCobro: "barrio",
      }),
    );
    const { rows } = await admin.query("select estado, modo_cobro, estudio_id, total_cuotas::text from plan_pago where id = $1", [planId]);
    expect(rows[0]).toEqual({ estado: "vigente", modo_cobro: "barrio", estudio_id: null, total_cuotas: "1000.00" });
    const d = (await como(adminA(), (tx) => datosParaArmarPlan(tx, { unidadFuncionalId: uf[0] })))!;
    expect(d.planAbierto).toEqual({ id: planId, estado: "vigente" });
  });
});

describe("el acta (0095): si el barrio la exige, una quita no se aprueba sin ella", () => {
  beforeAll(async () => {
    await como(adminA(), (tx) =>
      guardarReglasDePlanes(tx, { barrioId: barrio(), cuotasParaCaer: "2", ordenImputacion: "cuota_primero", financiaMora: "no", quitaRequiereActa: "si" }),
    );
  });

  it("sin acta queda pendiente; con el acta se aprueba, y queda el evento", async () => {
    const { planId } = await aMedida(uf[1], "450.00");
    const [pendiente] = await como(adminA(), (tx) => planesDeUnidad(tx, { unidadFuncionalId: uf[1] }));
    expect(pendiente).toMatchObject({ estado: "pendiente", pideActa: true, actaReferencia: null, quita: "100.00", quitaInteres: "0.00", quitaCapital: "100.00" });

    const e = await capturar(() => como(adminA(), (tx) => aprobarPlan(tx, { planId })));
    expect(e.message).toBe("El plan tiene una quita y el barrio exige el acta de aprobación para perdonarla.");
    expect(await estadoDe(planId)).toBe("pendiente");

    // Un acta cargada antes y reemplazada al aprobar: el evento guarda las dos (revisión de seguridad).
    await como(adminA(), (tx) => tx.execute(sql`select app.plan_cargar_acta(${planId}::uuid, 'Acta 11, la equivocada', null)`));
    await como(adminA(), (tx) => aprobarPlan(tx, { planId, actaReferencia: "Acta de comisión n.º 12 del 10/11/2026" }));
    expect(await estadoDe(planId)).toBe("vigente");
    const [vigente] = await como(adminA(), (tx) => planesDeUnidad(tx, { unidadFuncionalId: uf[1] }));
    expect(vigente).toMatchObject({ actaReferencia: "Acta de comisión n.º 12 del 10/11/2026", actaAdjunta: false });
    const { rows } = await admin.query<{ detalle: Record<string, unknown> }>(
      "select detalle from plan_evento where plan_id = $1 and tipo = 'acta_cargada' order by registrado_at",
      [planId],
    );
    expect(rows.map((r) => r.detalle)).toEqual([
      { referencia: "Acta 11, la equivocada", adjunto: null, referenciaAnterior: null, adjuntoAnterior: null },
      { referencia: "Acta de comisión n.º 12 del 10/11/2026", adjunto: null, referenciaAnterior: "Acta 11, la equivocada", adjuntoAnterior: null },
    ]);
  });

  it("quien no administra el barrio no propone, no aprueba ni carga el acta (la base, no la pantalla)", async () => {
    const { planId } = await aMedida(uf[2], "450.00");
    const contador = arbol.usuarios.contadorA1;
    await expect(
      como(contador, (tx) =>
        proponerPlanAMedida(tx, {
          unidadFuncionalId: uf[2],
          liquidacionIds: [enero.get(uf[2])!],
          cronograma: [{ numero: 1, vencimiento: dia(30), importe: "900.00" }],
          motivo: "Intento sin permiso.",
        }),
      ),
    ).rejects.toThrow();
    await expect(como(contador, (tx) => aprobarPlan(tx, { planId, actaReferencia: "Acta trucha" }))).rejects.toThrow();
    await expect(como(contador, (tx) => tx.execute(sql`select app.plan_cargar_acta(${planId}::uuid, 'Acta trucha', null)`))).rejects.toThrow(
      /no es de un barrio que administres/,
    );
    // Otra administración: ni el acta ni la aprobación.
    const otra = arbol.usuarios.adminEstudioB;
    await expect(como(otra, (tx) => tx.execute(sql`select app.plan_cargar_acta(${planId}::uuid, 'Acta ajena', null)`))).rejects.toThrow(
      /no es de un barrio que administres/,
    );
    await expect(como(otra, (tx) => aprobarPlan(tx, { planId, actaReferencia: "Acta ajena" }))).rejects.toThrow();
    expect(await estadoDe(planId)).toBe("pendiente");
    const { rows } = await admin.query("select count(*)::int as n from plan_evento where plan_id = $1 and tipo = 'acta_cargada'", [planId]);
    expect(rows[0]).toEqual({ n: 0 });
    await como(adminA(), (tx) => retirarPlan(tx, { planId, motivo: "Prueba de permisos terminada." }));
  });

  it("un adjunto subido de verdad para OTRO barrio no se acepta como acta", async () => {
    const { planId } = await aMedida(uf[2], "450.00");
    const deOtro = `barrios/${arbol.barrioB1.id}/parametros/respaldos/BBBBBBBBBBBBBBBBBBBBBBBBBB.pdf`;
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("insert into subida_respaldo_solicitada (nodo_id, storage_key, content_type, solicitado_por) values ($1, $2, 'application/pdf', $3)", [
        arbol.barrioB1.id,
        deOtro,
        arbol.usuarios.adminEstudioB,
      ]);
      await c.query("commit");
    } finally {
      c.release();
    }
    try {
      const e = await capturar(() => como(adminA(), (tx) => aprobarPlan(tx, { planId, actaReferencia: "Acta 13", actaAdjunto: deOtro })));
      expect(e.message).toBe("El acta no está completa: falta su referencia o el archivo no es de este barrio.");
      expect(await estadoDe(planId)).toBe("pendiente");
    } finally {
      await admin.query("delete from subida_respaldo_solicitada where storage_key = $1", [deOtro]);
      await como(adminA(), (tx) => retirarPlan(tx, { planId, motivo: "Prueba del adjunto terminada." }));
    }
  });

  it("un adjunto que no se subió para el barrio no se acepta", async () => {
    const { planId } = await aMedida(uf[2], "450.00");
    const e = await capturar(() =>
      como(adminA(), (tx) =>
        aprobarPlan(tx, { planId, actaReferencia: "Acta 13", actaAdjunto: `barrios/${barrio()}/parametros/respaldos/AAAAAAAAAAAAAAAAAAAAAAAA.pdf` }),
      ),
    );
    expect(e.message).toBe("El acta no está completa: falta su referencia o el archivo no es de este barrio.");
    expect(await estadoDe(planId)).toBe("pendiente");
    // Sin quita no hace falta el acta: se retira este y se propone uno por la deuda entera.
    await como(adminA(), (tx) => retirarPlan(tx, { planId, motivo: "Se arma sin quita." }));
    const sinQuita = await aMedida(uf[2], "550.00");
    await como(adminA(), (tx) => aprobarPlan(tx, { planId: sinQuita.planId }));
    expect(await estadoDe(sinQuita.planId)).toBe("vigente");
  });

  it("cargada al proponer, alcanza para aprobar", async () => {
    const { planId } = await aMedida(uf[3], "450.00", { actaReferencia: "Acta de comisión n.º 14" });
    await como(adminA(), (tx) => aprobarPlan(tx, { planId }));
    expect(await estadoDe(planId)).toBe("vigente");
  });

  it("el acta es solo de planes a medida, y no se carga dos veces en uno ya aprobado", async () => {
    const vigente = (await admin.query<{ id: string }>("select id from plan_pago where unidad_funcional_id = $1 and estado = 'vigente'", [uf[3]])).rows[0]!.id;
    await expect(como(adminA(), (tx) => tx.execute(sql`select app.plan_cargar_acta(${vigente}::uuid, 'Acta 15', null)`))).rejects.toThrow(
      /a medida pendiente/,
    );
  });
});
