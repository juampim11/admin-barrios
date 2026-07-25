/**
 * `app.current_user_id()` en SUS DOS MODOS (ADR-0000 §8 la marcó como la pieza nueva a probar):
 *
 *  - **Self-hosted / AWS:** la app declara al usuario con `set_config('app.user_id', …, true)`.
 *  - **Supabase:** existe `auth.uid()` y la función delega en ella, sin tocar una sola policy.
 *
 * Además se verifica lo que más caro sale si falla: que la identidad **no sobreviva** a la
 * transacción (si quedara pegada a la conexión del pool, el siguiente request vería otro tenant).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { conUsuario, crearDbRequest, sinUsuario, type DbRequest } from "../src/client.ts";
import { borrarArbol, crearArbol, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;

/** Deja el stub original: `auth.uid()` devuelve NULL (Postgres puro, sin GoTrue). */
async function restaurarStubAuth(): Promise<void> {
  await admin.query(`create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$`);
}

/** Simula el entorno Supabase: `auth.uid()` devuelve el usuario de la sesión. */
async function simularSupabase(userId: string): Promise<void> {
  await admin.query(
    `create or replace function auth.uid() returns uuid language sql stable as $$ select '${userId}'::uuid $$`,
  );
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
});

afterEach(async () => {
  await restaurarStubAuth();
});

afterAll(async () => {
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

async function usuarioActual(tx: DbRequest): Promise<string | null> {
  const res = await tx.execute<{ uid: string | null }>(sql`select app.current_user_id() as uid`);
  return res.rows[0]?.uid ?? null;
}

describe("modo self-hosted (SET LOCAL app.user_id)", () => {
  it("la app declara al usuario y la base lo ve", async () => {
    const id = arbol.usuarios.adminBarrioA1;
    expect(await conUsuario(db, id, usuarioActual)).toBe(id);
  });

  it("sin declarar usuario, la identidad es nula (y la RLS no muestra nada)", async () => {
    expect(await sinUsuario(db, usuarioActual)).toBeNull();
  });
});

describe("modo Supabase (auth.uid)", () => {
  it("delega en auth.uid() sin cambiar una sola policy", async () => {
    await simularSupabase(arbol.usuarios.adminBarrioA1);

    const visibles = await sinUsuario(db, async (tx) => {
      const res = await tx.execute<{ nombre: string }>(sql`select nombre from tenant_node order by path`);
      return res.rows.map((r) => r.nombre);
    });

    expect(visibles).toEqual(["Los Álamos", "Náutica interna"]);
  });

  it("si están los dos, gana el que declara la app (precedencia del coalesce)", async () => {
    await simularSupabase(arbol.usuarios.adminEstudioB);
    const id = arbol.usuarios.adminBarrioA1;
    expect(await conUsuario(db, id, usuarioActual)).toBe(id);
  });
});

describe("la identidad NO se pega a la conexión (fuga de tenant)", () => {
  it("con una sola conexión reutilizada, el usuario no sobrevive a la transacción", async () => {
    // max: 1 fuerza que las dos operaciones usen exactamente la misma conexión física.
    const poolUnico = new pg.Pool({ connectionString: process.env["DATABASE_URL_APP"], max: 1 });
    const dbUnico = crearDbRequest(poolUnico);
    try {
      const dentro = await conUsuario(dbUnico, arbol.usuarios.adminBarrioA1, usuarioActual);
      expect(dentro).toBe(arbol.usuarios.adminBarrioA1);

      const despues = await sinUsuario(dbUnico, usuarioActual);
      expect(despues).toBeNull();
    } finally {
      await poolUnico.end();
    }
  });

  it("un usuario inexistente no hereda permisos de nadie", async () => {
    expect(
      await conUsuario(db, randomUUID(), async (tx) => {
        const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from tenant_node`);
        return res.rows[0]?.n;
      }),
    ).toBe("0");
  });
});
