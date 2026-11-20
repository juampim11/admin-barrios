/**
 * Encargo P2a-3, contra Postgres real (`0096`): el modelo de cláusulas y los documentos de un plan.
 *
 *   · el modelo: uno por administración y estudio, el general como respaldo, nace con el borrador sin
 *     validar, y solo lo edita la administración;
 *   · la vista del PDF: las cifras que guardó la base y las cláusulas completadas, por los dos caminos;
 *   · el trabajo que arma el PDF: quién lo puede pedir, y que sin modelo el camino a no se encola;
 *   · los documentos: append-only, con su SHA-256 en `plan_evento`, la clave atada al plan.
 *
 * El caso, para leer a mano: el barrio A1, cuatro unidades que deben enero 2026 a $ 1.000 cada una, sin
 * interés por mora. Un plan a medida de $ 900 (450 + 450) tiene $ 100 de quita de capital (10 %).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { CLAUSULAS_BORRADOR } from "@admin-barrios/shared/planes-documentos";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { agregarEstudio, cambiarEstudioDelBarrio } from "../src/servicios/mora.ts";
import { proponerPlanAMedida, retirarPlan } from "../src/servicios/planes.ts";
import {
  agregarDocumentoDelPlan,
  armarVistaDeAcuerdoPlan,
  crearModeloDeClausulas,
  documentosDelPlan,
  encolarDocumentoDelPlan,
  encolarElAcuerdoDelPlan,
  guardarModeloDeClausulas,
  modelosDeClausulas,
  prepararDescargaDeDocumentoDelPlan,
  prepararSubidaDeDocumentoDelPlan,
  registrarDocumentoGeneradoDelPlan,
} from "../src/servicios/planes-documentos.ts";
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

const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminA = () => arbol.usuarios.adminEstudioA;
// Distintos de los de `planes-armar.test.ts`: los CUIT son únicos en toda la base.
const CUIT_A = "30710000081";
const CUIT_B = "30710000103";
const SHA = "a".repeat(64);

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

const aMedida = (unidad: string, estudioId: string | null = null) =>
  como(adminA(), (tx) =>
    proponerPlanAMedida(tx, {
      unidadFuncionalId: unidad,
      liquidacionIds: [enero.get(unidad)!],
      cronograma: [
        { numero: 1, vencimiento: dia(30), importe: "450.00" },
        { numero: 2, vencimiento: dia(60), importe: "450.00" },
      ],
      motivo: "Ofrece pagar en dos cuotas.",
      ...(estudioId ? { modoCobro: "estudio" as const, estudioId } : {}),
    }),
  );

const claveDe = (planId: string, token = "T".repeat(22)) => `barrios/${barrio()}/planes/${planId}/${token}.pdf`;

async function limpiar(): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query("delete from trabajo where barrio_id = $1", [barrio()]);
    for (const t of ["plan_documento", "plan_evento", "plan_cuota", "plan_liquidacion", "plan_pago", "plan_parametro_barrio", "estudio_barrio"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("delete from plan_modelo_clausulas_historia where administracion_id = any($1::uuid[])", [[arbol.adminA.id, arbol.adminB.id]]);
    await c.query("delete from plan_modelo_clausulas where administracion_id = any($1::uuid[])", [[arbol.adminA.id, arbol.adminB.id]]);
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
  estudio = (await nuevo(adminA(), arbol.adminA.id, "Estudio de los Convenios", CUIT_A)).estudioId;
  estudioDeOtra = (await nuevo(arbol.usuarios.adminEstudioB, arbol.adminB.id, "Estudio Ajeno", CUIT_B)).estudioId;
  await como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: barrio(), estudioId: estudio, accion: "sumar" }));
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

describe("el modelo de cláusulas", () => {
  it("nace con el borrador sin validar, uno general y uno por estudio, y lo edita solo la administración", async () => {
    const vacio = await como(adminA(), (tx) => modelosDeClausulas(tx, { administracionId: arbol.adminA.id }));
    expect(vacio).toMatchObject({ puedeEditar: true, general: null, estudios: [{ estudioId: estudio, nombre: "Estudio de los Convenios", modelo: null }] });

    const { modeloId } = await como(adminA(), (tx) => crearModeloDeClausulas(tx, { administracionId: arbol.adminA.id, estudioId: null }));
    const creado = await como(adminA(), (tx) => modelosDeClausulas(tx, { administracionId: arbol.adminA.id }));
    expect(creado.general).toMatchObject({ id: modeloId, clausulas: CLAUSULAS_BORRADOR, textoValidado: false });

    // Un segundo general no: se edita el que hay.
    const doble = await capturar(() => como(adminA(), (tx) => crearModeloDeClausulas(tx, { administracionId: arbol.adminA.id, estudioId: "" })));
    expect(doble.message).toBe("La administración ya tiene su modelo general.");

    await como(adminA(), (tx) =>
      guardarModeloDeClausulas(tx, {
        modeloId,
        clausulas: JSON.stringify([{ titulo: "Única", texto: "La deuda de {unidad} es {deuda}." }]),
        textoValidado: "si",
      }),
    );
    const { rows } = await admin.query("select clausulas, texto_validado, actualizado_por from plan_modelo_clausulas where id = $1", [modeloId]);
    expect(rows[0]).toEqual({ clausulas: [{ titulo: "Única", texto: "La deuda de {unidad} es {deuda}." }], texto_validado: true, actualizado_por: adminA() });

    // El contador del barrio lo lee (es de la administración del barrio) pero no lo edita, y otra administración ni lo ve.
    const contador = await como(arbol.usuarios.contadorA1, (tx) => modelosDeClausulas(tx, { administracionId: arbol.adminA.id }));
    expect(contador.puedeEditar).toBe(false);
    const ajeno = await capturar(() =>
      como(arbol.usuarios.adminEstudioB, (tx) => guardarModeloDeClausulas(tx, { modeloId, clausulas: JSON.stringify(CLAUSULAS_BORRADOR), textoValidado: "no" })),
    );
    expect(ajeno.message).toBe("Ese modelo no existe o no lo podés editar.");
    await expect(
      como(arbol.usuarios.contadorA1, (tx) => crearModeloDeClausulas(tx, { administracionId: arbol.adminA.id, estudioId: estudio })),
    ).rejects.toThrow();

    // Volver al borrador para los tests que siguen.
    await como(adminA(), (tx) => guardarModeloDeClausulas(tx, { modeloId, clausulas: JSON.stringify(CLAUSULAS_BORRADOR), textoValidado: "no" }));
    // La historia del modelo: cada alta y cada cambio, con quién (revisión de seguridad, M2).
    const { rows: historia } = await admin.query("select count(*)::int as n, bool_and(registrado_por = $2) as de_admin from plan_modelo_clausulas_historia where administracion_id = $1", [
      arbol.adminA.id,
      adminA(),
    ]);
    expect(historia[0].n).toBeGreaterThanOrEqual(3);
    expect(historia[0].de_admin).toBe(true);

  });

  it("el estudio del modelo tiene que trabajar con la administración, y una variable que no existe no se guarda", async () => {
    const e = await capturar(() => como(adminA(), (tx) => crearModeloDeClausulas(tx, { administracionId: arbol.adminA.id, estudioId: estudioDeOtra })));
    expect(e.message).toBe("Ese estudio no trabaja con la administración.");

    const general = (await admin.query<{ id: string }>("select id from plan_modelo_clausulas where administracion_id = $1 and estudio_id is null", [arbol.adminA.id]))
      .rows[0]!.id;
    await expect(
      como(adminA(), (tx) =>
        guardarModeloDeClausulas(tx, { modeloId: general, clausulas: JSON.stringify([{ titulo: "X", texto: "Paga {monto}." }]), textoValidado: "no" }),
      ),
    ).rejects.toThrow(/usa \{monto\}, que no es una de las variables/);

    // La base controla la forma aunque el servicio no esté: una cláusula sin texto no entra.
    await expect(
      como(adminA(), (tx) => tx.execute(sql`update plan_modelo_clausulas set clausulas = '[{"titulo": "Sola"}]'::jsonb where id = ${general}`)),
    ).rejects.toThrow(/cada cláusula lleva un título/);
  });
});

describe("la vista del PDF", () => {
  it("camino a: las cifras de la base y las cláusulas completadas; el modelo del estudio gana al general", async () => {
    const { planId } = await aMedida(uf[0]);
    const v = await como(adminA(), (tx) => armarVistaDeAcuerdoPlan(tx, { planId, camino: "modelo", fechaIso: hoy }));
    expect(v.plan.estado).toBe("pendiente");
    expect(v.deuda.total.texto).toBe("1.000,00");
    expect(v.quita).toMatchObject({ total: { texto: "100,00" }, capital: { texto: "100,00" }, porcentaje: "10" });
    expect(v.totalDelPlan.texto).toBe("900,00");
    expect(v.cuotas.map((c) => c.importe.texto)).toEqual(["450,00", "450,00"]);
    expect(v.textoAValidar).toBe(true);
    expect(v.clausulas?.[0]?.texto).toContain("Mza 2 · Lote 1");
    expect(v.clausulas?.[0]?.texto).toContain("$ 1.000,00");
    expect(v.clausulas?.[1]?.texto).toContain("(en este caso, $ 100,00)");
    expect(v.clausulas?.[2]?.texto).toContain("Si quedan 2 cuotas vencidas");
    expect(JSON.stringify(v.clausulas)).not.toMatch(/\{[a-zA-Z]+\}/);

    // Con un modelo propio del estudio, un plan que cobra ese estudio usa el suyo.
    const { modeloId } = await como(adminA(), (tx) => crearModeloDeClausulas(tx, { administracionId: arbol.adminA.id, estudioId: estudio }));
    await como(adminA(), (tx) =>
      guardarModeloDeClausulas(tx, { modeloId, clausulas: JSON.stringify([{ titulo: "Del estudio", texto: "Cobra el estudio por {unidad}." }]), textoValidado: "si" }),
    );
    const conEstudio = await aMedida(uf[1], estudio);
    const ve = await como(adminA(), (tx) => armarVistaDeAcuerdoPlan(tx, { planId: conEstudio.planId, camino: "modelo", fechaIso: hoy }));
    expect(ve.clausulas).toEqual([{ titulo: "Del estudio", texto: "Cobra el estudio por Mza 2 · Lote 2." }]);
    expect(ve.textoAValidar).toBe(false);
    expect(ve.plan.cobro).toBe("Cobra y rinde Estudio de los Convenios");

    // Camino b: sin cláusulas, y dice qué estudio redactó el documento que acompaña.
    const vb = await como(adminA(), (tx) => armarVistaDeAcuerdoPlan(tx, { planId: conEstudio.planId, camino: "anexo", fechaIso: hoy }));
    expect(vb).toMatchObject({ camino: "anexo", clausulas: null, textoAValidar: false, estudio: "Estudio de los Convenios" });

    // El contador lee el plan pero no arma sus documentos.
    await expect(como(arbol.usuarios.contadorA1, (tx) => armarVistaDeAcuerdoPlan(tx, { planId, camino: "anexo", fechaIso: hoy }))).rejects.toThrow(
      "Quien pidió el PDF ya no administra el barrio.",
    );
    await como(adminA(), (tx) => retirarPlan(tx, { planId: conEstudio.planId, motivo: "Prueba de la vista terminada." }));
    await admin.query("delete from plan_modelo_clausulas_historia where modelo_id = $1", [modeloId]);
    await admin.query("delete from plan_modelo_clausulas where id = $1", [modeloId]);
  });
});

describe("el trabajo que arma el PDF", () => {
  it("lo pide la administración; uno por camino a la vez; sin modelo el camino a no se encola", async () => {
    const { planId } = await aMedida(uf[2]);
    // Con modelo, «Enviar y armar el acuerdo» pide el camino a.
    const a = await como(adminA(), (tx) => encolarElAcuerdoDelPlan(tx, { planId }));
    const otra = await como(adminA(), (tx) => encolarDocumentoDelPlan(tx, { planId, camino: "modelo" }));
    expect(otra.trabajoId).toBe(a.trabajoId);
    const { rows } = await admin.query("select tipo, barrio_id, solicitado_por, estado from trabajo where id = $1", [a.trabajoId]);
    expect(rows[0]).toEqual({ tipo: "emitir_acuerdo_plan", barrio_id: barrio(), solicitado_por: adminA(), estado: "encolado" });
    const b = await como(adminA(), (tx) => encolarDocumentoDelPlan(tx, { planId, camino: "anexo" }));
    expect(b.trabajoId).not.toBe(a.trabajoId);
    const docs = await como(adminA(), (tx) => documentosDelPlan(tx, { planId }));
    expect(docs).toMatchObject({ armando: { modelo: true, anexo: true }, hayModelo: true, modeloSinValidar: true, puedeAgregar: true });

    // Tampoco recibe el que ya está armándose como si lo hubiera pedido.
    await expect(como(arbol.usuarios.contadorA1, (tx) => encolarDocumentoDelPlan(tx, { planId, camino: "anexo" }))).rejects.toThrow(
      "No podés agregar documentos a este plan.",
    );
    await admin.query("delete from trabajo where referencia_id = $1", [planId]);

    // Sin modelo (ni del estudio ni general), el camino a no; el b sí.
    const guardado = await admin.query("select * from plan_modelo_clausulas where administracion_id = $1", [arbol.adminA.id]);
    await admin.query("delete from plan_modelo_clausulas_historia where administracion_id = $1", [arbol.adminA.id]);
    await admin.query("delete from plan_modelo_clausulas where administracion_id = $1", [arbol.adminA.id]);
    try {
      const e = await capturar(() => como(adminA(), (tx) => encolarDocumentoDelPlan(tx, { planId, camino: "modelo" })));
      expect(e.message).toBe("Todavía no hay un modelo de cláusulas para este plan.");
      // «Enviar y armar el acuerdo» (pantalla 3) no falla sin modelo: arma solo el anexo.
      const solo = await como(adminA(), (tx) => encolarElAcuerdoDelPlan(tx, { planId }));
      const { rows: t } = await admin.query("select tipo from trabajo where id = $1", [solo.trabajoId]);
      expect(t[0]).toEqual({ tipo: "emitir_anexo_plan" });
    } finally {
      // Se devuelven tal como estaban (sin el trigger, que pondría como autor a nadie).
      const c = await admin.connect();
      try {
        await c.query("begin");
        await c.query("set local session_replication_role = replica");
        for (const m of guardado.rows) {
          await c.query(
            "insert into plan_modelo_clausulas (id, administracion_id, estudio_id, clausulas, texto_validado, actualizado_por) values ($1, $2, $3, $4, $5, $6)",
            [m.id, m.administracion_id, m.estudio_id, JSON.stringify(m.clausulas), m.texto_validado, m.actualizado_por],
          );
        }
        await c.query("commit");
      } finally {
        c.release();
      }
      await admin.query("delete from trabajo where referencia_id = $1", [planId]);
    }

    // Un plan retirado no lleva documentos nuevos.
    await como(adminA(), (tx) => retirarPlan(tx, { planId, motivo: "Prueba del trabajo terminada." }));
    const r = await capturar(() => como(adminA(), (tx) => encolarDocumentoDelPlan(tx, { planId, camino: "anexo" })));
    expect(r.message).toBe("El plan está rechazado o retirado: no lleva documentos nuevos.");
  });
});

describe("los documentos del plan", () => {
  it("append-only: cada uno deja su SHA-256 en plan_evento, y la clave tiene que ser de ese plan", async () => {
    const { planId } = await aMedida(uf[3]);
    const vista = await como(adminA(), (tx) => armarVistaDeAcuerdoPlan(tx, { planId, camino: "modelo", fechaIso: hoy }));
    const registrar = () =>
      como(adminA(), (tx) =>
        registrarDocumentoGeneradoDelPlan(tx, {
          planId,
          camino: "modelo",
          storageKey: claveDe(planId, "W".repeat(22)),
          sha256: SHA,
          bytes: 1,
          vista,
          motor: "chromium/test",
          plantillaHash: "b".repeat(64),
        }),
      );
    // Lo que arma el sistema no lo registra el request por su cuenta (revisión de seguridad, A1): hace falta
    // el trabajo `corriendo` de quien lo pidió, y eso lo pone solo la cola.
    expect((await capturar(registrar)).message).toBe("El PDF del plan lo registra solo el sistema, mientras lo arma.");
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query(
        "insert into trabajo (barrio_id, tipo, referencia_id, estado, solicitado_por, iniciado_at) values ($1, 'emitir_acuerdo_plan', $2, 'corriendo', $3, now())",
        [barrio(), planId, adminA()],
      );
      await c.query("commit");
    } finally {
      c.release();
    }
    // Y la vista tiene que ser del estado en que está el plan (si se aprobó mientras se armaba, no).
    const deOtroEstado = await capturar(() =>
      como(adminA(), (tx) =>
        registrarDocumentoGeneradoDelPlan(tx, {
          planId,
          camino: "modelo",
          storageKey: claveDe(planId, "X".repeat(22)),
          sha256: SHA,
          bytes: 1,
          vista: { ...vista, plan: { ...vista.plan, estado: "vigente" } },
          motor: "chromium/test",
          plantillaHash: "b".repeat(64),
        }),
      ),
    );
    expect(deOtroEstado.message).toBe("El plan cambió de estado mientras se armaba el PDF (por ejemplo, se aprobó).");
    const generado = await como(adminA(), (tx) =>
      registrarDocumentoGeneradoDelPlan(tx, {
        planId,
        camino: "modelo",
        storageKey: claveDe(planId),
        sha256: SHA,
        bytes: 1234,
        vista,
        motor: "chromium/test",
        plantillaHash: "b".repeat(64),
      }),
    );
    const subida = await como(adminA(), (tx) => prepararSubidaDeDocumentoDelPlan(tx, { planId, contentType: "application/pdf" }));
    expect(subida.storageKey).toMatch(new RegExp(`^barrios/${barrio()}/planes/${planId}/[A-Za-z0-9_-]{22,64}\\.pdf$`));
    const firmado = await como(adminA(), (tx) =>
      agregarDocumentoDelPlan(tx, { planId, clase: "firmado", clave: subida.storageKey, nombre: "convenio firmado.pdf", sha256: "c".repeat(64), bytes: 99, contentType: "application/pdf" }),
    );

    const { rows: eventos } = await admin.query<{ detalle: Record<string, unknown> }>(
      "select detalle from plan_evento where plan_id = $1 and tipo = 'documento_agregado' order by registrado_at",
      [planId],
    );
    expect(eventos.map((e) => e.detalle)).toEqual([
      { documentoId: generado.documentoId, clase: "acuerdo", sha256: SHA, bytes: 1234, nombre: null, estadoPlan: "pendiente" },
      { documentoId: firmado.documentoId, clase: "firmado", sha256: "c".repeat(64), bytes: 99, nombre: "convenio firmado.pdf", estadoPlan: "pendiente" },
    ]);

    const lista = await como(arbol.usuarios.contadorA1, (tx) => documentosDelPlan(tx, { planId }));
    expect(lista.documentos.map((d) => d.clase)).toEqual(["firmado", "acuerdo"]);
    expect(lista.puedeAgregar).toBe(false);

    // Ni se reemplaza ni se borra, tampoco la administración; y la vista congelada no se lee desde el request.
    await expect(como(adminA(), (tx) => tx.execute(sql`update plan_documento set sha256 = ${"d".repeat(64)} where id = ${firmado.documentoId}`))).rejects.toThrow();
    await expect(como(adminA(), (tx) => tx.execute(sql`delete from plan_documento where id = ${firmado.documentoId}`))).rejects.toThrow();
    await expect(como(adminA(), (tx) => tx.execute(sql`select vista from plan_documento where id = ${generado.documentoId}`))).rejects.toThrow();

    // Una clave de otro plan no entra; el contador y otra administración no agregan.
    const otro = await aMedida(uf[0]).catch(() => null);
    // Si no hay otro plan, la clave ajena es la de este con el último dígito CAMBIADO. Antes se reemplazaba
    // siempre por «0»: cuando el uuid ya terminaba en «0» (1 de cada 16) la clave resultaba del mismo plan,
    // la base la aceptaba y el test fallaba «sin motivo» (CI 44466805990). Acá es distinta por construcción.
    const ajena = claveDe(otro?.planId ?? planId.replace(/.$/, (d) => (d === "0" ? "1" : "0")), "U".repeat(22));
    const e = await capturar(() =>
      como(adminA(), (tx) => agregarDocumentoDelPlan(tx, { planId, clase: "del_estudio", clave: ajena, nombre: "x.pdf", sha256: SHA, bytes: 1, contentType: "application/pdf" })),
    );
    expect(e.message).toBe("El archivo no es de este plan.");
    await expect(
      como(arbol.usuarios.contadorA1, (tx) =>
        agregarDocumentoDelPlan(tx, { planId, clase: "firmado", clave: claveDe(planId, "V".repeat(22)), nombre: "x.pdf", sha256: SHA, bytes: 1, contentType: "application/pdf" }),
      ),
    ).rejects.toThrow(/permiso/);
    await expect(como(arbol.usuarios.adminEstudioB, (tx) => prepararSubidaDeDocumentoDelPlan(tx, { planId, contentType: "application/pdf" }))).rejects.toThrow(
      "Ese plan no existe o no tenés acceso.",
    );

    // La descarga: la clave sale de la fila, y el nombre dice la unidad, no el titular.
    const descarga = await como(adminA(), (tx) => prepararDescargaDeDocumentoDelPlan(tx, { documentoId: generado.documentoId }));
    expect(descarga).toEqual({ storageKey: claveDe(planId), nombreArchivo: "Acuerdo-plan-Mza-2-Lote-4.pdf", sha256: SHA });
    await expect(como(arbol.usuarios.adminEstudioB, (tx) => prepararDescargaDeDocumentoDelPlan(tx, { documentoId: generado.documentoId }))).rejects.toThrow(
      "Ese documento no existe o no tenés acceso.",
    );

    await admin.query("delete from trabajo where referencia_id = $1", [planId]);
    if (otro) await como(adminA(), (tx) => retirarPlan(tx, { planId: otro.planId, motivo: "Prueba de documentos terminada." }));
    await como(adminA(), (tx) => retirarPlan(tx, { planId, motivo: "Prueba de documentos terminada." }));
  });
});
