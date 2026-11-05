/**
 * **La cadena del mes, de punta a punta** (ensayo de T2, 2026-11-05): emitir → boletas en PDF →
 * informe → paquete, con la bomba de la cola de verdad (`src/bomba.ts`) y la cola de verdad
 * (`src/servidor/cola.ts`). Lo único falso es el generador de PDF (en esta máquina y en el gate barato
 * no hay Chromium) y el almacenamiento, que es un mapa en memoria. La cadena real, con Chromium y
 * MinIO, se verifica a mano con el worker (ver la guía de prueba, «Envío»).
 *
 * Lo que el ensayo encontró y esto fija:
 * - **El informe de un barrio de cuota fija fallaba siempre** («un problema del sistema»): sumaba la
 *   expensa sin la cuota fija y el grupo quedaba negativo.
 * - **Un trabajo huérfano** (el worker se reinició en el medio) quedaba `corriendo` diez minutos y
 *   después pedía volver a generar a mano. Ahora, sin latido, se reencola solo.
 *
 * Correr con: pnpm vitest run --project db apps/worker/test/cadena-del-mes.db.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type pg from "pg";
import { sql } from "drizzle-orm";
import { conUsuario, type DbRequest } from "@admin-barrios/data/client";
import { boletasDelMes, emitirMes } from "@admin-barrios/data/servicios/circuito-del-mes";
import { definirCuotaFija } from "@admin-barrios/data/servicios/cuota-fija";
import { panoramaDeDistribucion } from "@admin-barrios/data/servicios/distribucion";
import { ObjetoNoEncontrado, ObjetoYaExiste, type ObjectStorage } from "@admin-barrios/almacenamiento";
import type { GeneradorDocumento } from "@admin-barrios/documentos";
import { registroPorDefecto } from "@admin-barrios/documentos/cobranza";
import {
  borrarArbol,
  borrarParametrosDe,
  cargarParametro,
  crearArbol,
  crearBarrio,
  dbDe,
  dbDeJob,
  poolAdmin,
  poolApp,
  poolJob,
  type Arbol,
} from "../../../packages/data/test/helpers.ts";
import { crearBomba, type Cola } from "../src/bomba.ts";
import { avanzarTrabajo, caducarRezagados, latirTrabajo, terminarTrabajo, tomarTrabajo } from "../src/servidor/cola.ts";
import { emitirDocumentosDelPeriodo } from "../src/emision.ts";
import { emitirInformeDelPeriodo } from "../src/emision-informe.ts";
import { armarPaqueteDelPeriodo } from "../src/paquete.ts";
import { distribuirLiquidaciones } from "../src/distribucion.ts";
import { emitirReciboDePago } from "../src/emision-recibo.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let jobPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
const objetos = new Map<string, Buffer>();

const variable = () => arbol.barrioA1.id;
const fija = () => arbol.barrioA2.id;
const barrios = () => [variable(), fija()];

/** Un PDF de mentira: los handlers solo lo guardan, lo cuentan y lo meten en el ZIP. */
const PDF_FALSO = Buffer.from("%PDF-1.4\n% generador falso del test de la cadena\n%%EOF\n");
const generadorFalso: GeneradorDocumento = {
  motor: "falso/1",
  generar: async () => new Uint8Array(PDF_FALSO),
  generarLote: async (docs) => docs.map(() => new Uint8Array(PDF_FALSO)),
};

const almacenamientoEnMemoria: ObjectStorage = {
  async put(clave, cuerpo, opciones) {
    if (opciones.siNoExiste && objetos.has(clave)) throw new ObjetoYaExiste();
    objetos.set(clave, Buffer.from(cuerpo));
  },
  async get(clave) {
    const o = objetos.get(clave);
    if (!o) throw new ObjetoNoEncontrado();
    return o;
  },
  async getStream(clave) {
    return Readable.from(await this.get(clave));
  },
  async urlFirmada(clave) {
    return `memoria://${clave}`;
  },
  async urlFirmadaDeSubida() {
    throw new Error("el test de la cadena no sube nada");
  },
};

/** La cola de verdad, acotada a los barrios del test: no toma trabajos de la demo de quien lo corre. */
function colaDelTest(): Cola {
  const dbCola = dbDeJob(jobPool);
  return {
    tomar: async () => {
      for (const b of barrios()) {
        const t = await tomarTrabajo(dbCola, { soloDelBarrio: b });
        if (t) return t;
      }
      return null;
    },
    avanzar: (id, avance) => avanzarTrabajo(dbCola, id, avance),
    latir: (id) => latirTrabajo(dbCola, id),
    terminar: (id, resultado) => terminarTrabajo(dbCola, id, resultado),
  };
}

const bomba = () =>
  crearBomba({
    cola: colaDelTest(),
    handlers: {
      emitir_documentos_periodo: emitirDocumentosDelPeriodo,
      emitir_informe_periodo: emitirInformeDelPeriodo,
      armar_paquete_periodo: armarPaqueteDelPeriodo,
      distribuir_liquidaciones: distribuirLiquidaciones,
      emitir_recibo_pago: emitirReciboDePago,
    },
    contexto: {
      db,
      almacenamiento: almacenamientoEnMemoria,
      generador: generadorFalso,
      registroDeMedios: registroPorDefecto(),
      correo: null,
      chunk: 50,
      timeoutMs: 30_000,
    },
    latidoMs: 50,
    log: { log: () => undefined, warn: () => undefined, error: (...a: unknown[]) => console.error(...a) },
  });

async function crearUnidadesDe(barrioId: string): Promise<string[]> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
     values ($1,'1','1','construido'), ($1,'1','2','construido'), ($1,'1','3','baldio') returning id`,
    [barrioId],
  );
  return rows.map((r) => r.id);
}

async function coeficientes(barrioId: string, unidades: readonly string[]): Promise<void> {
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [barrioId],
  );
  await admin.query(
    "insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,0.4), ($1,$2,$4,0.4), ($1,$2,$5,0.2)",
    [barrioId, v[0]!.id, unidades[0], unidades[1], unidades[2]],
  );
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
}

async function parametros(barrioId: string): Promise<void> {
  await borrarParametrosDe(admin, [barrioId]);
  for (const [clave, valor] of [
    ["interes.cobra", true], ["interes.tasa_compensatoria", "0.03"], ["interes.tasa_punitoria", "0"], ["interes.gracia_dias", 0],
    ["interes.forma_gracia", "corre_inicio"], ["interes.tolerancia", "0.00"], ["imputacion.orden", "intereses_primero_capital_antiguo"],
  ] as const) {
    await cargarParametro(admin, barrioId, clave, valor);
  }
}

/** Emite el mes con el circuito de T2: la vista previa y «Emitir» con su huella. */
async function emitir(barrioId: string, periodoId: string): Promise<void> {
  const usuario = arbol.usuarios.adminEstudioA;
  const vista = await conUsuario(db, usuario, (tx) => boletasDelMes(tx, { periodoId }));
  if (vista.estado !== "vista_previa") throw new Error(`la vista previa de ${barrioId} no se calculó: ${JSON.stringify(vista).slice(0, 300)}`);
  await conUsuario(db, usuario, (tx) => emitirMes(tx, { periodoId, huellaVista: vista.huella, vistaCalculadaEl: vista.calculadaEl }));
}

const trabajosDe = async (periodoId: string) =>
  (
    await admin.query<{ tipo: string; estado: string; error: string | null }>(
      "select tipo, estado::text as estado, error from trabajo where referencia_id = $1 order by solicitado_at, tipo",
      [periodoId],
    )
  ).rows;

let periodoVariable: string;
let periodoFija: string;

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  jobPool = poolJob();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);

  // Por coeficiente: tres unidades, $ 3.000 de vigilancia.
  await crearBarrio(admin, variable(), { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  await coeficientes(variable(), await crearUnidadesDe(variable()));
  const { rows: c } = await admin.query<{ id: string }>(
    "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
    [variable()],
  );
  await parametros(variable());
  const { rows: pv } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, '2025-03', '2025-03-10') returning id",
    [variable()],
  );
  periodoVariable = pv[0]!.id;
  await admin.query(
    "insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '3000.00')",
    [variable(), periodoVariable, c[0]!.id],
  );

  // Cuota fija: tres unidades a $ 50.000. Es el caso del informe que fallaba en Los Talas.
  await crearBarrio(admin, fija(), { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  await admin.query("update barrio set modelo_liquidacion = 'fija' where barrio_id = $1", [fija()]);
  // El motor pide una versión de coeficientes cerrada también en cuota fija (Los Talas la tiene).
  await coeficientes(fija(), await crearUnidadesDe(fija()));
  await parametros(fija());
  await conUsuario(db, arbol.usuarios.adminEstudioA, (tx) =>
    definirCuotaFija(tx, { barrioId: fija(), rigeDesde: "2025-01", descripcion: "Acta 1 (test)", forma: "importe", importe: "50000.00" }),
  );
  const { rows: pf } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento, modelo) values ($1, '2025-03', '2025-03-10', 'fija') returning id",
    [fija()],
  );
  periodoFija = pf[0]!.id;
});

afterEach(() => {
  objetos.clear();
});

afterAll(async () => {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const b of barrios()) {
      await c.query("delete from paquete_distribucion_item where paquete_id in (select id from paquete_distribucion where barrio_id = $1)", [b]);
      for (const t of ["paquete_distribucion", "documento_emitido", "trabajo", "interes_devengado", "saldo_uf", "item_liquidacion", "liquidacion",
        "gasto_periodo", "periodo_expensa", "cuota_fija", "cuota_fija_version", "concepto", "coeficiente", "coeficiente_version",
        "unidad_funcional", "codigo_pago_secuencia", "barrio_atributo_vigencia", "barrio"]) {
        await c.query(`delete from ${t} where barrio_id = $1`, [b]);
      }
    }
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarParametrosDe(admin, barrios());
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end(), jobPool.end()]);
});

describe("al emitir, la cadena se arma sola hasta el final", () => {
  it.each([
    ["por coeficiente", () => variable(), () => periodoVariable],
    ["de cuota fija (el informe que fallaba)", () => fija(), () => periodoFija],
  ])("barrio %s: boletas en PDF, informe y paquete terminan, y Envío lo dice", async (_nombre, barrioDe, periodoDe) => {
    await emitir(barrioDe(), periodoDe());

    // Al emitir quedan encolados las boletas y el informe (D5); el paquete, todavía no.
    expect((await trabajosDe(periodoDe())).map((t) => `${t.tipo}:${t.estado}`).sort()).toEqual([
      "emitir_documentos_periodo:encolado",
      "emitir_informe_periodo:encolado",
    ]);

    await bomba().bombear();

    // Los tres pasos terminados, sin ningún fallo: el paquete lo encadenó la bomba al terminar los PDF.
    const trabajos = await trabajosDe(periodoDe());
    expect(trabajos.filter((t) => t.estado !== "terminado")).toEqual([]);
    expect(trabajos.map((t) => t.tipo).sort()).toEqual(["armar_paquete_periodo", "emitir_documentos_periodo", "emitir_informe_periodo"]);

    // Lo que lee la pestaña Envío.
    const panorama = await conUsuario(db, arbol.usuarios.adminEstudioA, (tx) => panoramaDeDistribucion(tx, { periodoId: periodoDe() }));
    expect(panorama.boletas).toBe(3);
    expect(panorama.informeEmitido).toBe(true);
    expect(panorama.paquete?.documentos).toBe(3);
    expect(panorama.paquete?.boletasFaltantes).toBe(0);
  });
});

describe("un trabajo huérfano se reencola solo", () => {
  it("sin latido hace un minuto vuelve a la cola, y la bomba lo termina", async () => {
    // Un período emitido, sus boletas ya generadas por la prueba de arriba: se vuelven a pedir.
    const usuario = arbol.usuarios.adminEstudioA;
    await conUsuario(db, usuario, (tx) =>
      // Lo mismo que hace el botón «Preparar los PDF».
      tx.execute(sql`insert into trabajo (tipo, referencia_id) values ('emitir_documentos_periodo', ${periodoVariable})`),
    );
    const dbCola = dbDeJob(jobPool);
    const tomado = await tomarTrabajo(dbCola, { soloDelBarrio: variable() });
    expect(tomado?.tipo).toBe("emitir_documentos_periodo");

    // El proceso «muere»: nadie lo cierra y el latido se corta. Pasa un minuto.
    await admin.query("update trabajo set latido_at = now() - interval '2 minutes' where id = $1", [tomado!.id]);

    const { reencolados } = await caducarRezagados(dbCola);
    expect(reencolados).toBeGreaterThanOrEqual(1);
    const { rows } = await admin.query<{ estado: string }>("select estado::text as estado from trabajo where id = $1", [tomado!.id]);
    expect(rows[0]!.estado).toBe("encolado");

    await bomba().bombear();
    const { rows: fin } = await admin.query<{ estado: string; intento: number }>(
      "select estado::text as estado, intento from trabajo where id = $1",
      [tomado!.id],
    );
    expect(fin[0]).toEqual({ estado: "terminado", intento: 2 });
  });

  it("un envío por correo huérfano NO se reintenta solo: queda fallado, con su botón", async () => {
    const dbCola = dbDeJob(jobPool);
    // Se arma a mano la fila: el envío necesita boletas y paquete, que la prueba de arriba dejó.
    await conUsuario(db, arbol.usuarios.adminEstudioA, (tx) =>
      tx.execute(sql`insert into trabajo (tipo, referencia_id) values ('distribuir_liquidaciones', ${periodoVariable})`),
    );
    const tomado = await tomarTrabajo(dbCola, { soloDelBarrio: variable() });
    expect(tomado?.tipo).toBe("distribuir_liquidaciones");
    await admin.query("update trabajo set latido_at = now() - interval '2 minutes' where id = $1", [tomado!.id]);
    await caducarRezagados(dbCola);
    const { rows } = await admin.query<{ estado: string }>("select estado::text as estado from trabajo where id = $1", [tomado!.id]);
    expect(rows[0]!.estado).toBe("fallado");
  });
});
