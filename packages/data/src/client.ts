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
};

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
  });
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
