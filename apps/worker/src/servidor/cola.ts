/**
 * **El único módulo del sistema que toca la conexión con `BYPASSRLS`.**
 *
 * ADR-0002 §5.2 regla 11, verificada en `apps/web/src/arquitectura.test.ts`: si el identificador
 * `DbJob` aparece en cualquier otro archivo de `apps/worker/src`, el gate falla. El motivo es
 * concreto — el cerrojo del compilador impide *pasarle* `DbJob` a un servicio (`conUsuario` no lo
 * acepta), pero `dbJob.execute(sql\`…\`)` compila perfecto, y ahí el aislamiento se evapora sin que
 * nada se rompa.
 *
 * Lo que esta conexión hace, en total: **tomar una fila de la cola y moverle el estado**. Nada más.
 * Las liquidaciones, la vista de la boleta y el registro del documento emitido corren con
 * `conUsuario(dbRequest, trabajo.solicitadoPor, …)`, o sea bajo RLS y con la identidad de quien
 * apretó el botón (ADR-0002 §6.4 punto 2).
 */

import pg from "pg";
import { sql } from "drizzle-orm";
import { crearDbJob, crearPoolJob, type DbJob } from "@admin-barrios/data/client";

/**
 * La cota de la delegación. Un trabajo más viejo que esto **no se toma**: pasa a `fallado`.
 *
 * Sin esta cota, un trabajo que quedó `encolado` mientras el worker estuvo caído resucita la
 * identidad de alguien días después — y esa identidad puede haber perdido la membresía, o el rol, o
 * la persona puede haberse ido del estudio (ADR-0002 §6.4 punto 6).
 */
const VENTANA_DE_DELEGACION = "1 hour";

/**
 * Cuánto puede estar un trabajo en `corriendo` antes de darlo por muerto.
 *
 * **Este es el estado que deja un período bloqueado si nadie lo limpia**, y el camino para llegar es
 * de lo más común: el proceso se reinicia en medio del lote, lo mata el límite de memoria, o falla
 * el `update` que lo cerraba. La fila queda `corriendo`, el índice único
 * `uq_trabajo_pendiente` la sigue contando como pendiente, y **encolar de nuevo rebota para
 * siempre** — sin salida desde la aplicación, porque el rol de request no puede tocar `trabajo`.
 *
 * 10 minutos: un lote de 200 boletas son ~15 segundos (ADR-0001 §2.1), así que el margen sigue siendo
 * de 40× y la única forma de que un trabajo vivo lo cruce es que esté colgado de verdad. El número
 * importa porque **es cuánto tiempo el período queda intocable** si el proceso muere en el medio: no
 * hay riesgo en bajarlo y sí hay costo en dejarlo alto.
 */
const VENTANA_DE_EJECUCION = "10 minutes";

export type TrabajoTomado = {
  readonly id: string;
  readonly tipo: "emitir_documentos_periodo";
  readonly barrioId: string;
  readonly referenciaId: string;
  readonly solicitadoPor: string;
  readonly intento: number;
};

type FilaTomada = {
  id: string;
  tipo: "emitir_documentos_periodo";
  barrio_id: string;
  referencia_id: string;
  solicitado_por: string;
  intento: number;
};

/** El pool con BYPASSRLS. Se abre una sola vez, en el arranque del proceso. */
export function abrirColaDeTrabajos(url: string): { db: DbJob; pool: pg.Pool } {
  // Tres conexiones y no dos: una la ocupa permanentemente el `LISTEN`, y con un pool de dos una
  // sola conexión mal devuelta dejaba al worker esperando para siempre, sin error y sin log.
  //
  // Y `timeoutConexionMs` explícito por el mismo motivo que lo tiene el pool de request: el default
  // de `pg` es **0 = esperar indefinidamente**, así que un pool agotado o una base que no completa
  // el handshake se ve exactamente igual que "no hay trabajos".
  const pool = crearPoolJob({ url, maxConexiones: 3, timeoutConexionMs: 5_000 });
  return { db: crearDbJob(pool), pool };
}

/**
 * Verifica que la conexión de la cola **sea realmente la que tiene que ser**.
 *
 * Es la simétrica de `verificarConexionSujetaARls()`, y los dos modos de falla que cierra son
 * invisibles sin ella: si `DATABASE_URL_JOB` apunta por error a `app_request`, `tomarTrabajo`
 * devuelve cero filas **para siempre** y nadie emite nunca —falla cerrado, pero en silencio—; si
 * apunta al dueño del esquema, este proceso gana DDL.
 */
export async function verificarConexionDeCola(db: DbJob): Promise<void> {
  const fila = (
    await db.execute<{ usuario: string; es_super: boolean; saltea_rls: boolean }>(sql`
      select current_user::text as usuario,
             coalesce(rolsuper, false)     as es_super,
             coalesce(rolbypassrls, false) as saltea_rls
        from pg_roles where rolname = current_user
    `)
  ).rows[0];

  if (!fila) throw new Error("no se pudo leer el rol de la conexión de la cola: no se arranca a ciegas");

  if (fila.es_super) {
    throw new Error(
      `la conexión de la cola usa el rol "${fila.usuario}", que es SUPERUSUARIO: este proceso no ` +
        "tiene ningún motivo para poder hacer DDL. DATABASE_URL_JOB tiene que apuntar a `app_job`.",
    );
  }
  if (!fila.saltea_rls) {
    throw new Error(
      `la conexión de la cola usa el rol "${fila.usuario}", que NO tiene BYPASSRLS: tomar un trabajo ` +
        "devolvería cero filas para siempre y nadie emitiría nunca, sin ningún error a la vista. " +
        "DATABASE_URL_JOB tiene que apuntar a `app_job` (ver .env.example).",
    );
  }
}

/**
 * Toma el trabajo más viejo que esté encolado y dentro de la ventana de delegación.
 *
 * `for update skip locked` es lo que permite que haya más de un worker sin que dos tomen la misma
 * fila. Devuelve `null` cuando no hay nada — que es el caso normal, y por eso la consulta va por el
 * índice parcial `idx_trabajo_encolado` y no escanea la tabla.
 */
export async function tomarTrabajo(db: DbJob): Promise<TrabajoTomado | null> {
  const fila = (
    await db.execute<FilaTomada>(sql`
      update trabajo
         set estado = 'corriendo', iniciado_at = now(), intento = intento + 1
       where id = (
         select id from trabajo
          where estado = 'encolado'
            and solicitado_at > now() - interval '${sql.raw(VENTANA_DE_DELEGACION)}'
          order by solicitado_at
            for update skip locked
          limit 1
       )
      returning id, tipo::text as tipo, barrio_id, referencia_id, solicitado_por, intento
    `)
  ).rows[0];

  if (!fila) return null;
  return {
    id: fila.id,
    tipo: fila.tipo,
    barrioId: fila.barrio_id,
    referenciaId: fila.referencia_id,
    solicitadoPor: fila.solicitado_por,
    intento: fila.intento,
  };
}

/** Mueve el progreso. Se llama **una vez por chunk**: 4 `UPDATE` para 200 boletas, no 200. */
export async function avanzarTrabajo(
  db: DbJob,
  trabajoId: string,
  avance: { hechos?: number; total?: number },
): Promise<void> {
  await db.execute(sql`
    update trabajo
       set hechos = coalesce(${avance.hechos ?? null}::integer, hechos),
           total  = coalesce(${avance.total ?? null}::integer, total)
     where id = ${trabajoId}
  `);
}

/**
 * Cierra el trabajo.
 *
 * `mensajeDeError` ya viene traducido por quien llama. **Nunca un `e.message` crudo**: los
 * `raise exception` de este esquema interpolan valores de filas, y lo que se escriba acá lo lee
 * después una pantalla (ADR-0002 §4.2).
 */
export async function terminarTrabajo(
  db: DbJob,
  trabajoId: string,
  resultado: { ok: true } | { ok: false; mensajeDeError: string },
): Promise<void> {
  await db.execute(sql`
    update trabajo
       set estado = ${resultado.ok ? "terminado" : "fallado"}::app.estado_trabajo,
           terminado_at = now(),
           error = ${resultado.ok ? null : resultado.mensajeDeError}
     where id = ${trabajoId}
  `);
}

/**
 * Cierra los dos estados que, si nadie los toca, dejan un período trabado para siempre.
 *
 * **Los dos, y no solo el primero.** La versión que solo barría `encolado` dejaba el agujero más
 * caro de esta pieza: un worker que se reinicia en medio del lote deja la fila en `corriendo`, el
 * índice único la sigue contando como pendiente, y el período no se puede volver a emitir **ni
 * desde la aplicación ni desde ningún lado que no sea el dueño del esquema**.
 *
 * - `encolado` vencido → la identidad del solicitante no se resucita días después.
 * - `corriendo` vencido → el trabajo estaba colgado o el proceso murió; se libera el período.
 *
 * En los dos casos queda `fallado` con el motivo escrito, que es un estado del que la pantalla sabe
 * salir: ofrece generar de nuevo, y generar de nuevo **completa lo que falta** sin duplicar nada.
 */
export async function caducarRezagados(db: DbJob): Promise<number> {
  const filas = await db.execute<{ id: string }>(sql`
    update trabajo
       set estado = 'fallado', terminado_at = now(),
           error = case
             when estado = 'encolado'
               then 'La generación quedó esperando demasiado tiempo y se canceló por seguridad.'
             else 'La generación se interrumpió y no terminó. Volver a generar completa lo que falte.'
           end
     where (estado = 'encolado'  and solicitado_at <= now() - interval '${sql.raw(VENTANA_DE_DELEGACION)}')
        or (estado = 'corriendo' and iniciado_at   <= now() - interval '${sql.raw(VENTANA_DE_EJECUCION)}')
    returning id
  `);
  return filas.rows.length;
}

/**
 * `LISTEN trabajo_nuevo` sobre una conexión dedicada.
 *
 * Disparo por evento y no por cron (`03-reglas-desarrollo-optimizado.md` §5): latencia de
 * milisegundos y cero polling. **Nota de portabilidad que es fácil de olvidar:** `LISTEN` no
 * funciona a través de un pooler en modo transacción. Si el hosting introduce uno, este proceso
 * tiene que conectarse directo, o degradar a solo-barrido con intervalo corto. Por eso la reconexión
 * de acá abajo no es opcional: si el `LISTEN` se cae, el barrido sigue siendo la red de seguridad.
 */
export function escucharTrabajos(pool: pg.Pool, alAvisar: () => void): { cerrar: () => Promise<void> } {
  let cliente: pg.PoolClient | null = null;
  let cerrado = false;

  async function conectar(): Promise<void> {
    if (cerrado) return;
    let tomado: pg.PoolClient | null = null;
    try {
      tomado = await pool.connect();
      tomado.on("notification", () => alAvisar());
      tomado.on("error", (e) => {
        // `release(e)` y no `release()`: con el argumento, `pg` **destruye** la conexión rota en vez
        // de devolverla al pool. Sin él, el próximo que la pida recibe una conexión muerta.
        tomado?.release(e);
        if (cliente === tomado) cliente = null;
        setTimeout(() => void conectar(), 5_000);
      });
      await tomado.query("listen trabajo_nuevo");
      cliente = tomado;
    } catch {
      // **Devolver el cliente es lo que estaba faltando.** Si `connect()` resolvió y el `listen`
      // falló, sin este `release` la conexión quedaba tomada para siempre; unas pocas vueltas de
      // reintento agotaban el pool y el worker se colgaba pidiendo trabajo, sin error y sin log.
      tomado?.release();
      cliente = null;
      setTimeout(() => void conectar(), 5_000);
    }
  }

  void conectar();

  return {
    async cerrar() {
      cerrado = true;
      cliente?.release();
      cliente = null;
    },
  };
}
