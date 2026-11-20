/**
 * Cliente de datos neutral (ADR-0000 §3.1): Drizzle sobre Postgres, sin SDK de ningún proveedor.
 *
 * Dos conexiones, dos privilegios distintos:
 *  - `app_request` (pool de request): **sujeto a RLS**. Cada operación corre dentro de una
 *    transacción que hace `set_config('app.user_id', …, true)` → las policies ven al usuario.
 *  - `app_job` (pool de jobs): **BYPASSRLS**, solo server-side (ingestas multi-barrio, reescritura
 *    de paths). Nunca se expone al cliente ni se usa para atender un request de usuario.
 */

import pg from "pg";
import { describirErrorParaLog } from "@admin-barrios/shared/error-para-log";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema/index.ts";

// `bigint` (int8) como número: el `nid` del path es un contador chico, muy lejos de MAX_SAFE_INTEGER.
// El dinero NO pasa por acá: `numeric` se sigue leyendo como string (exactitud, ver shared/dinero).
pg.types.setTypeParser(20, (valor: string) => Number(valor));

/**
 * Conexión **sujeta a RLS**: es la única que puede atender un request de usuario, y solo a través de
 * `conUsuario()`. El tipo está marcado a propósito (no es un alias de `NodePgDatabase` pelado) para
 * que el compilador impida el error que abre el agujero más caro del sistema: pasarle a
 * `conUsuario()` la conexión de jobs, que tiene `BYPASSRLS`. El `set_config` se ejecutaría igual, el
 * código se **leería** aislado, y no aislaría nada.
 */
export type DbRequest = NodePgDatabase<typeof schema> & { readonly __rls: "sujeto" };

/** Conexión de jobs: **BYPASSRLS**. Ve todos los barrios. Nunca atiende un request de usuario. */
export type DbJob = NodePgDatabase<typeof schema> & { readonly __rls: "bypass" };

/** Conexión de mantenimiento (dueño del esquema): migraciones, seeds y scripts locales. */
export type DbMantenimiento = NodePgDatabase<typeof schema> & { readonly __rls: "dueño" };

/**
 * Conexión que **puede llevar la identidad de un usuario**: la de request (producción) o la de
 * mantenimiento (scripts locales). Es lo que aceptan los servicios de negocio. **Nunca `DbJob`**:
 * un job que necesita actuar en nombre de alguien abre una conexión de request, no le pone una
 * identidad a una conexión que saltea la RLS.
 */
export type DbConIdentidad = DbRequest | DbMantenimiento;


export type OpcionesConexion = {
  /** URL de conexión. Por defecto, la variable de entorno indicada en `variable`. */
  url?: string | undefined;
  variable?: string;
  maxConexiones?: number;
  /** Corte para abrir una conexión. Ver `crearPoolRequest`: el default de `pg` es esperar para siempre. */
  timeoutConexionMs?: number;
  /** Cuánto vive una conexión ociosa antes de cerrarse. Ver `crearPoolRequest`. */
  ociosaMs?: number;
  /** Tope de una consulta (lado cliente). Ver `CONSULTA_MS`. */
  consultaMs?: number;
};

/**
 * Lo que tarda como máximo **una consulta** antes de darse por colgada (`query_timeout` de `pg`, del lado del
 * cliente), y que una conexión inactiva tarda en mandar su primer paquete de `keepAlive`.
 *
 * Por qué hace falta: con un corte **silencioso** (un firewall o un NAT que descarta los paquetes sin mandar un
 * RST) la consulta en vuelo no falla nunca: el socket sigue «abierto», la bomba queda en `corriendo = true` y el
 * worker parece sano sin procesar nada (S5b). `keepAlive` hace que el sistema operativo detecte la conexión
 * muerta, y el tope de consulta convierte el cuelgue en un error que el `catch` de la bomba ya sabe manejar.
 *
 * Por qué 60 s: es una consulta, no un trabajo. **No se midió** con un barrio de 340 unidades y contención de
 * locks: es un tope de seguridad, no un cálculo, y si una consulta lo supera la falla es un error visible, no
 * un cuelgue. Los trabajos largos (el PDF de cada boleta en Chromium, el
 * ZIP de 340 boletas, la distribución) son **muchas consultas cortas** de milisegundos con el trabajo pesado
 * afuera de la base, y el trabajo entero tiene su propia ventana de 10 minutos (`VENTANA_DE_EJECUCION`, con
 * latido cada 10 s): ninguna consulta suelta del repo se acerca al minuto. El más lento de los conocidos es el
 * armado del borrador de una liquidación de un barrio grande (segundos). Si alguna vez una consulta legítima
 * necesita más, el tope se sube **en esa consulta** (`opciones.consultaMs` de un pool aparte) y no acá.
 */
export const CONSULTA_MS = 60_000;
/**
 * Primer paquete de `keepAlive`. Es solo el arranque: el intervalo y la cantidad de sondas siguientes son los
 * del sistema operativo (en Linux, por defecto, unos 11 minutos hasta darla por muerta), así que una conexión
 * **ociosa** cortada en silencio se detecta tarde; la cubren el tope de consulta y el reemplazo del pool.
 */
export const KEEPALIVE_INICIAL_MS = 10_000;

function urlDe(opciones: OpcionesConexion, variablePorDefecto: string): string {
  const variable = opciones.variable ?? variablePorDefecto;
  const url = opciones.url ?? process.env[variable];
  if (!url) throw new Error(`Falta ${variable} en el entorno (ver .env.example)`);
  return url;
}

/**
 * Pool de request: sujeto a RLS. Usar SIEMPRE a través de `conUsuario`.
 *
 * `connectionTimeoutMillis` explícito: el default de `pg` es **0 = esperar para siempre**. Con un
 * puerto que acepta la conexión TCP pero no completa el handshake —un pooler saturado, una base que
 * está arrancando, una regla de red a medio aplicar— una aserción de arranque se cuelga sin decir
 * nada y el contenedor queda "levantando" indefinidamente. Cinco segundos es de sobra en cualquier
 * red donde este proceso tenga sentido, y convierte ese cuelgue en un error con causa.
 */
export function crearPoolRequest(opciones: OpcionesConexion = {}): pg.Pool {
  return new pg.Pool({
    connectionString: urlDe(opciones, "DATABASE_URL_APP"),
    max: opciones.maxConexiones ?? 10,
    connectionTimeoutMillis: opciones.timeoutConexionMs ?? 5_000,
    /*
     * [encargo 17b] Un minuto, no los 10 segundos por defecto de `pg`. Con 10 s, una pantalla que se
     * refresca sola cada 4 a 30 segundos (Envío, mientras corre un trabajo) encontraba el pool vacío en
     * casi cada pedido y abría conexiones nuevas todo el tiempo. Abrir una conexión es justo el momento
     * frágil: si el hilo de Node queda ocupado más que `connectionTimeoutMillis` con la conexión a medio
     * abrir, el corte se dispara apenas el hilo vuelve —antes de leer la respuesta de la base, que ya
     * había llegado— y el pedido falla con «Connection terminated due to connection timeout». Con las
     * conexiones vivas, los pedidos las reutilizan y esa ventana casi no existe.
     */
    idleTimeoutMillis: opciones.ociosaMs ?? 60_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_INICIAL_MS,
    query_timeout: opciones.consultaMs ?? CONSULTA_MS,
  });
}

/**
 * Verifica que la conexión **realmente** esté sujeta a la RLS, preguntándoselo a la base.
 *
 * Este es el hueco que ningún otro cerrojo tapa, y conviene entenderlo con precisión: los controles
 * de `tools/infra/credenciales.ts` y de `apps/web/src/servidor/configuracion.ts` verifican **nombres
 * de variable** —que no llegue `DATABASE_URL` ni `DATABASE_URL_JOB`—, no privilegios. Un DSN de
 * superusuario, o del dueño del esquema, puesto en `DATABASE_URL_APP` pasa los cinco cerrojos sin
 * despeinarse: el nombre de la variable es el correcto. Y el resultado no es un error, es peor —
 * las policies dejan de evaluarse y **todos los barrios se le sirven a todos los usuarios, en
 * silencio**, con el código leyéndose exactamente igual de aislado que antes.
 *
 * Dos atributos, y ninguno de los dos se hereda por pertenencia a otro rol (son atributos del rol
 * con el que se hace login, que es justamente el que importa acá):
 *  · `rolsuper`      — un superusuario saltea la RLS siempre.
 *  · `rolbypassrls`  — literalmente el permiso de saltearla.
 *
 * Lo que **no** hace falta chequear es "que no sea el dueño de las tablas": el dueño también
 * saltearía las policies, pero todas las tablas del esquema tienen `FORCE ROW LEVEL SECURITY`, que
 * existe exactamente para cerrar ese caso.
 */
export async function verificarConexionSujetaARls(db: DbConIdentidad): Promise<void> {
  const fila = (
    await db.execute<{ usuario: string; es_super: boolean; saltea_rls: boolean }>(sql`
      select current_user::text as usuario,
             coalesce(rolsuper, false)     as es_super,
             coalesce(rolbypassrls, false) as saltea_rls
        from pg_roles
       where rolname = current_user
    `)
  ).rows[0];

  if (!fila) throw new Error("no se pudo leer el rol de la conexión en pg_roles: no se arranca a ciegas");

  if (fila.es_super || fila.saltea_rls) {
    throw new Error(
      `la conexión de request está usando el rol "${fila.usuario}", que ` +
        `${fila.es_super ? "es SUPERUSUARIO" : "tiene BYPASSRLS"}: las policies no se evaluarían y ` +
        "todos los barrios quedarían visibles para todos los usuarios, sin ningún error a la vista. " +
        "DATABASE_URL_APP tiene que apuntar al rol `app_request` (ver .env.example y ADR-0002 §3.2).",
    );
  }
}

/**
 * Pool de jobs: BYPASSRLS. Nunca para atender un request de usuario.
 *
 * `connectionTimeoutMillis` por el mismo motivo que en `crearPoolRequest`, y acá el síntoma es aún
 * más silencioso: con el default de `pg` (**0 = esperar para siempre**), un pool agotado —una
 * conexión que alguien no devolvió— deja al worker colgado pidiendo trabajo, sin error, sin log y
 * sin dejar de parecer sano.
 */
export function crearPoolJob(opciones: OpcionesConexion = {}): pg.Pool {
  return new pg.Pool({
    connectionString: urlDe(opciones, "DATABASE_URL_JOB"),
    max: opciones.maxConexiones ?? 4,
    connectionTimeoutMillis: opciones.timeoutConexionMs ?? 5_000,
    // Lo mismo que en `crearPoolRequest` (ver el comentario de allá): el worker barre la cola cada tanto y
    // con los 10 s por defecto de `pg` encontraba el pool vacío en cada barrido, y abrir una conexión es el
    // momento frágil («Connection terminated due to connection timeout», demo del 12/11 y ensayo del 15/11).
    idleTimeoutMillis: opciones.ociosaMs ?? 60_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_INICIAL_MS,
    query_timeout: opciones.consultaMs ?? CONSULTA_MS,
  });
}

/**
 * Que ningún error de conexión de un pool tire el proceso ni deje datos de la conexión en el log.
 *
 * **Conexión ociosa.** `pg.Pool` emite `'error'` cuando una conexión ociosa se rompe (la base se reinicia, un
 * firewall corta la sesión, failover) y en Node un `'error'` sin oyente es una excepción no capturada que mata
 * el proceso. El pool descarta la conexión rota y abre otra solo: lo único que hace falta es registrarlo.
 *
 * **Conexión en uso (S5b).** `pg-pool` le saca su oyente al cliente cuando lo presta y se lo devuelve al
 * recibirlo. Si la conexión se corta **entre dos consultas** de una transacción abierta (el handler renderiza,
 * llama a otro servicio…), el `'error'` del cliente no tenía a nadie y tiraba el proceso. Se deja un oyente
 * propio en cada cliente nuevo: la consulta que esté en vuelo falla sola, `drizzle` hace el `rollback` y
 * suelta el cliente, y `pg-pool` lo descarta porque ya no es consultable.
 *
 * **Consulta colgada.** `query_timeout` rechaza la consulta pero **no cierra la conexión**: el `rollback` que
 * `drizzle` manda a continuación se colgaba otros 60 s sobre la misma conexión muerta, y después `release()`
 * la devolvía al pool. Cuando una consulta de un cliente vence, se corta su socket: el `rollback` falla en el
 * acto y el pool la descarta.
 *
 * Los logs llevan el nombre del pool y `describirErrorParaLog` (mensaje y código, nunca el objeto de error: el
 * de `pg` trae la contraseña del rol). Va en todo pool de un proceso de larga vida.
 */
export function registrarErrorDePool(pool: pg.Pool, nombre: string): void {
  const prestados = new WeakSet<pg.PoolClient>();
  pool.on("acquire", (c) => prestados.add(c));
  pool.on("release", (_e, c) => prestados.delete(c));

  pool.on("error", (error) => {
    console.error(`[db] conexión ociosa del pool «${nombre}» caída (el pool la reemplaza sola): ${describirErrorParaLog(error)}`);
  });

  pool.on("connect", (cliente) => {
    // Solo mientras está prestado: ocioso, el error le llega al pool y lo registra el oyente de arriba.
    cliente.on("error", (error) => {
      if (!prestados.has(cliente)) return;
      console.error(`[db] conexión en uso del pool «${nombre}» caída (la consulta en vuelo falla y el pool la descarta): ${describirErrorParaLog(error)}`);
    });

    const consultar = cliente.query.bind(cliente) as (...a: unknown[]) => unknown;
    (cliente as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const resultado = consultar(...args);
      // «Query read timeout» es el texto de `pg` 8.22; si cambia, el test de timeout lo muestra.
      // Con `callback` (lo que usa `pool.query`) el pool ya descarta el cliente si hay error; el camino sin
      // `callback` es el de `drizzle` dentro de una transacción.
      if (typeof args[args.length - 1] === "function" || !esPromesa(resultado)) return resultado;
      return resultado.catch((error: unknown) => {
        if (error instanceof Error && error.message === "Query read timeout") cortarConexion(cliente);
        throw error;
      });
    };
  });
}

const esPromesa = (x: unknown): x is Promise<unknown> => typeof (x as { catch?: unknown } | null)?.catch === "function";

/** Corta el socket de un cliente cuya consulta venció. `pg` no tiene un `destroy()` público. */
function cortarConexion(cliente: pg.PoolClient): void {
  (cliente as unknown as { connection?: { stream?: { destroy?: () => void } } }).connection?.stream?.destroy?.();
}

// El doble casteo (`as unknown as`) no es adorno: el tipo de Drizzle no se superpone con la marca,
// así que `as DbRequest` a secas no compila. Es el precio de marcar el privilegio en el tipo.
/** Conexión para atender usuarios: se usa con `conUsuario()`, que es lo único que la acepta. */
export function crearDbRequest(pool: pg.Pool): DbRequest {
  return drizzle(pool, { schema }) as unknown as DbRequest;
}

/**
 * Conexión de jobs (BYPASSRLS). **No la acepta `conUsuario()`**: si un job necesita actuar en nombre
 * de un usuario, tiene que abrir una conexión de request, no ponerle una identidad a esta.
 */
export function crearDbJob(pool: pg.Pool): DbJob {
  return drizzle(pool, { schema }) as unknown as DbJob;
}

/**
 * Conexión de mantenimiento (dueño del esquema). **Solo scripts**: seeds, backfills, fixtures de
 * test. Que el nombre sea incómodo es a propósito: si aparece en `apps/` o en un servicio, está mal.
 */
export function crearDbMantenimiento(pool: pg.Pool): DbMantenimiento {
  return drizzle(pool, { schema }) as unknown as DbMantenimiento;
}

/** Un uuid canónico en minúsculas o mayúsculas. No valida versión: los ids los emite la base. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ejecuta `fn` en una transacción con la identidad del usuario seteada para la RLS.
 *
 * `set_config(..., true)` = **LOCAL a la transacción**: al terminar, el valor se descarta. Un `SET`
 * de sesión (sin `LOCAL`) se pegaría a la conexión y el siguiente request del pool heredaría el
 * usuario anterior → **fuga de tenant** (doc 03 §A.9.4). Esto además es compatible con poolers en
 * modo transacción (pgBouncer/Supavisor).
 *
 * **Dos verificaciones que cuestan cero y cierran el último modo de falla silencioso** (ADR-0002
 * §3.2):
 *
 *  1. `userId` tiene que ser un uuid **antes** de entrar. `app.current_user_id()` hace
 *     `current_setting('app.user_id')::uuid`: un valor que no castea revienta en CADA evaluación de
 *     policy, con un error crudo de Postgres, en la consulta más lejana al origen del problema.
 *  2. El `set_config` **devuelve el valor efectivo**: se compara con el pedido y se lanza si no
 *     coinciden. Sin esto, "la identidad no se seteó" se ve exactamente igual que "este barrio no
 *     tiene datos cargados" — la RLS devuelve cero filas y la pantalla sale vacía. Un `default deny`
 *     indistinguible de un resultado vacío legítimo es un `default deny` que nadie descubre.
 *
 * Ninguna de las dos agrega un round-trip: la primera es una regex y la segunda usa la sentencia que
 * ya se estaba mandando.
 */
export async function conUsuario<T>(
  db: DbConIdentidad,
  userId: string,
  fn: (tx: DbRequest) => Promise<T>,
): Promise<T> {
  if (!UUID.test(userId)) {
    throw new Error(
      `la identidad para la RLS no es un uuid (${JSON.stringify(userId)}): se rechaza acá y no en ` +
        "la primera policy que la evalúe",
    );
  }
  return db.transaction(async (tx) => {
    const fila = (
      await tx.execute<{ efectivo: string | null }>(
        sql`select set_config('app.user_id', ${userId}, true) as efectivo`,
      )
    ).rows[0];
    if (fila?.efectivo !== userId) {
      throw new Error(
        "la identidad no quedó puesta en la transacción: la RLS devolvería cero filas y eso se vería " +
          `como "no hay datos" (pedido ${userId}, efectivo ${JSON.stringify(fila?.efectivo ?? null)})`,
      );
    }
    return fn(tx as unknown as DbRequest);
  });
}

/**
 * Igual que `conUsuario` pero **sin identidad**: `app.current_user_id()` devuelve `null`,
 * `accessible_tenant_ids()` no devuelve nada y toda tabla de barrio da **cero filas**. Sirve para
 * probar el default deny, y es el único camino de la pantalla de entrada (ADR-0002 §3.1): lo único
 * que puede leer es lo que tenga una policy `using (true)`, o sea `usuario_demo` y nada más.
 *
 * **No es una conexión privilegiada.** Es la misma conexión sujeta a RLS, sin identidad puesta. La
 * alternativa tentadora —usar `DbJob` (BYPASSRLS) para armar el login— está explícitamente prohibida
 * por el ADR-0002 §2.3, ni una vez ni en desarrollo.
 */
export async function sinUsuario<T>(
  db: DbConIdentidad,
  fn: (tx: DbRequest) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => fn(tx as unknown as DbRequest));
}
