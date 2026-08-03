/**
 * `apps/worker` — el proceso que genera los documentos.
 *
 * **Disparo por evento, con red de seguridad** (ADR-0002 §6.3 y presupuesto de recursos §5):
 * `LISTEN trabajo_nuevo` da latencia de milisegundos y cero polling; el barrido cada 60 s cubre lo
 * que se perdió por una reconexión y en un día típico **no devuelve nada**, porque va por un índice
 * parcial. Un cron ancho correría en vacío 364 días al año.
 *
 * Este archivo hace tres cosas y ninguna más: abre las conexiones, verifica que sean las que tienen
 * que ser, y bombea la cola. El trabajo real está en `emision.ts` y el acceso a la cola en
 * `servidor/cola.ts`.
 */

import { config as cargarEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  crearDbRequest,
  crearPoolRequest,
  verificarConexionSujetaARls,
} from "@admin-barrios/data/client";
import { crearGeneradorChromium } from "@admin-barrios/documentos/chromium";
import { crearMedioGenericoDemo } from "@admin-barrios/documentos/cobranza";
import { crearAlmacenamientoS3 } from "@admin-barrios/almacenamiento/s3";
import { leerConfiguracion } from "./servidor/configuracion.ts";
import {
  abrirColaDeTrabajos,
  avanzarTrabajo,
  caducarRezagados,
  escucharTrabajos,
  terminarTrabajo,
  tomarTrabajo,
  verificarConexionDeCola,
} from "./servidor/cola.ts";
import { emitirDocumentosDelPeriodo, ErrorDeEmision } from "./emision.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
cargarEnv({ path: resolve(aqui, "../.env.local"), quiet: true });

const config = leerConfiguracion();

const { db: dbCola, pool: poolCola } = abrirColaDeTrabajos(config.urlBaseJob);
const poolRequest = crearPoolRequest({ url: config.urlBaseApp, maxConexiones: 4 });
const dbRequest = crearDbRequest(poolRequest);

// Las dos aserciones de arranque, y son dos porque son dos modos de falla distintos. La primera es
// la que ya corre la web: si `DATABASE_URL_APP` apuntara a un rol con BYPASSRLS, **toda la emisión**
// perdería el aislamiento en silencio y el código se leería exactamente igual de aislado. La segunda
// es la simétrica: si la de la cola NO tiene BYPASSRLS, `tomarTrabajo` devuelve cero filas para
// siempre y nadie emite nunca — falla cerrado, pero invisible.
await verificarConexionSujetaARls(dbRequest);
await verificarConexionDeCola(dbCola);

const almacenamiento = crearAlmacenamientoS3({
  endpoint: config.s3Endpoint,
  region: config.s3Region,
  bucket: config.s3Bucket,
  forzarRutaDeBucket: config.s3RutaDeBucket,
  accessKeyId: config.s3AccessKeyId,
  secretAccessKey: config.s3SecretAccessKey,
});

const generador = crearGeneradorChromium();
const medio = crearMedioGenericoDemo();

/**
 * El despacho por tipo. **Record cerrado y no `switch` con `default`**: el día que el enum de
 * Postgres gane un valor, esto deja de compilar hasta que alguien decida qué código corre. Un
 * `default` silencioso sobre la columna que decide qué se ejecuta es exactamente lo que no queremos.
 */
const HANDLERS = {
  emitir_documentos_periodo: emitirDocumentosDelPeriodo,
} as const;

let corriendo = false;
let pendiente = false;
let apagando = false;

/**
 * Arranca el bombeo sin dejar una promesa suelta.
 *
 * `void bombear()` a secas era un bug con dientes: el `try/catch` de adentro envuelve al handler,
 * pero **no** a `tomarTrabajo` ni al barrido. Un parpadeo de la base ahí adentro era una promesa
 * rechazada sin capturar, y en Node eso **termina el proceso** — que además arranca con
 * `restart: "no"`, así que no vuelve, y si tenía un trabajo tomado lo dejaba en `corriendo`.
 */
function bombearSeguro(): void {
  void bombear().catch((e) => {
    console.error("el bombeo de la cola falló:", e instanceof Error ? e.name : "desconocido", e);
  });
}

async function bombear(): Promise<void> {
  // Reentrada: si llega un aviso mientras se está trabajando, se anota y se vuelve al terminar.
  if (corriendo) {
    pendiente = true;
    return;
  }
  corriendo = true;
  try {
    for (;;) {
      // Durante el apagado no se toma trabajo nuevo: tomar uno para abandonarlo dos segundos después
      // es exactamente cómo se fabrica una fila `corriendo` huérfana.
      if (apagando) break;
      const trabajo = await tomarTrabajo(dbCola);
      if (!trabajo) break;

      const arranque = Date.now();
      try {
        const handler = HANDLERS[trabajo.tipo];
        const resultado = await handler(trabajo, {
          db: dbRequest,
          almacenamiento,
          generador,
          medio,
          chunk: config.chunk,
          timeoutMs: config.timeoutMs,
          alAvanzar: (avance) => avanzarTrabajo(dbCola, trabajo.id, avance),
        });
        await terminarTrabajo(dbCola, trabajo.id, { ok: true });
        // Sin barrio, sin período y sin identidad: un log es un almacén que se envía afuera.
        console.log(
          `trabajo ${trabajo.id}: ${resultado.escritos} documentos en ${Date.now() - arranque} ms` +
            (resultado.yaEstaban > 0 ? ` (${resultado.yaEstaban} ya estaban)` : ""),
        );
      } catch (e) {
        // Lo que se escribe en `trabajo.error` lo lee después una pantalla: nunca un `e.message`
        // crudo, porque los `raise exception` del esquema interpolan valores de filas que quien mira
        // el trabajo puede no tener derecho a ver (ADR-0002 §4.2).
        const mensaje =
          e instanceof ErrorDeEmision
            ? e.message
            : "La generación falló por un problema del sistema y no se completó.";
        await terminarTrabajo(dbCola, trabajo.id, { ok: false, mensajeDeError: mensaje });
        console.error(`trabajo ${trabajo.id} falló:`, e instanceof Error ? e.name : "desconocido", e);
      }
    }
  } finally {
    corriendo = false;
    if (pendiente && !apagando) {
      pendiente = false;
      bombearSeguro();
    }
  }
}

const escucha = escucharTrabajos(poolCola, () => bombearSeguro());

const barrido = setInterval(() => {
  void (async () => {
    const caducados = await caducarRezagados(dbCola);
    if (caducados > 0) console.warn(`${caducados} trabajo(s) caducados por exceder la ventana`);
    await bombear();
  })().catch((e) => {
    // Igual que el bombeo: sin este `catch`, un parpadeo de la base durante el barrido termina el
    // proceso, y `restart: "no"` hace que no vuelva.
    console.error("el barrido de la cola falló:", e instanceof Error ? e.name : "desconocido", e);
  });
}, config.intervaloBarridoMs);

/**
 * La última red. Cualquier promesa sin `catch` que se escape en el futuro deja un log en vez de
 * matar el proceso — que, con un trabajo tomado, es la forma de fabricar una fila `corriendo`
 * huérfana. **No reemplaza a los `catch`**: los hace visibles en lugar de fatales.
 */
process.on("unhandledRejection", (razon) => {
  console.error("promesa rechazada sin capturar en el worker:", razon);
});

// Al arrancar, una pasada: puede haber quedado algo encolado mientras el proceso estuvo caído.
await bombear();

console.log(
  `worker listo — entorno ${config.entorno}, chunk ${config.chunk}, ` +
    `barrido cada ${config.intervaloBarridoMs / 1000} s`,
);

/**
 * Apagado ordenado. Tres cosas que la versión anterior no hacía, y las tres tienen el mismo síntoma:
 * un trabajo abandonado en `corriendo`.
 *
 * 1. **Dejar de tomar trabajo nuevo** antes que nada.
 * 2. **Esperar al lote en vuelo** —hasta un techo— en vez de cortar en el medio del render.
 * 3. **Ser idempotente**: dos señales seguidas no disparan dos cierres del pool.
 *
 * Si el techo se agota igual, el trabajo queda `corriendo` — y para eso está el barrido de
 * `caducarRezagados`, que ahora sí lo cierra. Son dos redes, no una.
 */
async function apagar(senal: string): Promise<void> {
  if (apagando) return;
  apagando = true;
  console.log(`${senal}: cerrando. No se toma trabajo nuevo.`);
  clearInterval(barrido);

  const hasta = Date.now() + 30_000;
  while (corriendo && Date.now() < hasta) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (corriendo) {
    console.warn("se agotó la espera con un lote en vuelo: queda `corriendo` y lo cierra el barrido");
  }

  await escucha.cerrar();
  await poolCola.end();
  await poolRequest.end();
  process.exit(0);
}

process.on("SIGINT", () => void apagar("SIGINT"));
process.on("SIGTERM", () => void apagar("SIGTERM"));
