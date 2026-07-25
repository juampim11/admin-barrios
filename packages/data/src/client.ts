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
};

function urlDe(opciones: OpcionesConexion, variablePorDefecto: string): string {
  const variable = opciones.variable ?? variablePorDefecto;
  const url = opciones.url ?? process.env[variable];
  if (!url) throw new Error(`Falta ${variable} en el entorno (ver .env.example)`);
  return url;
}

/** Pool de request: sujeto a RLS. Usar SIEMPRE a través de `conUsuario`. */
export function crearPoolRequest(opciones: OpcionesConexion = {}): pg.Pool {
  return new pg.Pool({ connectionString: urlDe(opciones, "DATABASE_URL_APP"), max: opciones.maxConexiones ?? 10 });
}

/** Pool de jobs: BYPASSRLS. Nunca para atender un request de usuario. */
export function crearPoolJob(opciones: OpcionesConexion = {}): pg.Pool {
  return new pg.Pool({ connectionString: urlDe(opciones, "DATABASE_URL_JOB"), max: opciones.maxConexiones ?? 4 });
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

/**
 * Ejecuta `fn` en una transacción con la identidad del usuario seteada para la RLS.
 *
 * `set_config(..., true)` = **LOCAL a la transacción**: al terminar, el valor se descarta. Un `SET`
 * de sesión (sin `LOCAL`) se pegaría a la conexión y el siguiente request del pool heredaría el
 * usuario anterior → **fuga de tenant** (doc 03 §A.9.4). Esto además es compatible con poolers en
 * modo transacción (pgBouncer/Supavisor).
 */
export async function conUsuario<T>(
  db: DbConIdentidad,
  userId: string,
  fn: (tx: DbRequest) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx as unknown as DbRequest);
  });
}

/** Igual que `conUsuario` pero sin usuario: la RLS no deja ver nada. Útil para probar el default deny. */
export async function sinUsuario<T>(
  db: DbConIdentidad,
  fn: (tx: DbRequest) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => fn(tx as unknown as DbRequest));
}
