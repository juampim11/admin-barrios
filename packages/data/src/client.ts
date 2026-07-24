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

export type Db = NodePgDatabase<typeof schema>;

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

export function crearDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

/**
 * Ejecuta `fn` en una transacción con la identidad del usuario seteada para la RLS.
 *
 * `set_config(..., true)` = **LOCAL a la transacción**: al terminar, el valor se descarta. Un `SET`
 * de sesión (sin `LOCAL`) se pegaría a la conexión y el siguiente request del pool heredaría el
 * usuario anterior → **fuga de tenant** (doc 03 §A.9.4). Esto además es compatible con poolers en
 * modo transacción (pgBouncer/Supavisor).
 */
export async function conUsuario<T>(db: Db, userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx as unknown as Db);
  });
}

/** Igual que `conUsuario` pero sin usuario: la RLS no deja ver nada. Útil para probar el default deny. */
export async function sinUsuario<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx as unknown as Db));
}
