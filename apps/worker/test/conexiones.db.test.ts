/**
 * S5b: lo que pasa con las conexiones del worker cuando algo sale mal en serio, contra Postgres real.
 *
 *  · una consulta que supera el tope (corte silencioso) termina en error y la conexión se descarta;
 *  · la bomba, cuando la cola se cuelga, vuelve a `corriendo = false` y sigue procesando;
 *  · una conexión **en uso** que se corta entre dos consultas de una transacción no tira el proceso: la
 *    siguiente consulta falla, la transacción termina en error y el pool sigue atendiendo;
 *  · ningún log lleva usuario, contraseña, host ni puerto de la conexión.
 *
 * Correr con: pnpm vitest run --project db apps/worker/test/conexiones.db.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { crearDbJob, crearPoolJob, registrarErrorDePool } from "@admin-barrios/data/client";
import { describirErrorParaLog } from "@admin-barrios/shared/error-para-log";
import { crearBomba, type Cola } from "../src/bomba.ts";

let admin: pg.Pool;
let urlJob: string;
const abiertos: pg.Pool[] = [];

/** Un pool de jobs con el tope de consulta corto, con los oyentes de S5b puestos. */
const poolDePrueba = (consultaMs?: number) => {
  const pool = crearPoolJob({ url: urlJob, maxConexiones: 2, ...(consultaMs !== undefined ? { consultaMs } : {}) });
  registrarErrorDePool(pool, "prueba");
  abiertos.push(pool);
  return pool;
};

/** Lo que loguea la conexión que se usa para las pruebas, sin la contraseña real. */
const SECRETOS = /app_job_dev|app_job\b|localhost|127\.0\.0\.1|::1|5432/;

beforeAll(() => {
  const url = process.env["DATABASE_URL"];
  const job = process.env["DATABASE_URL_JOB"];
  if (!url || !job) throw new Error("Faltan DATABASE_URL y DATABASE_URL_JOB: los tests de base necesitan `pnpm db:up` y un .env");
  urlJob = job;
  admin = new pg.Pool({ connectionString: url, max: 2 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(abiertos.map((p) => p.end()));
  await admin.end();
});

describe("una consulta colgada (corte silencioso)", () => {
  it("pool.query: supera el tope, termina en error, y la consulta siguiente anda", async () => {
    const pool = poolDePrueba(300);
    const t0 = Date.now();
    await expect(pool.query("select pg_sleep(10)")).rejects.toThrow(/Query read timeout/);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect((await pool.query<{ n: number }>("select 1 as n")).rows[0]!.n).toBe(1);
  });

  it("dentro de una transacción de drizzle: termina en error enseguida (el rollback no se cuelga otro tope) y se descarta la conexión", async () => {
    const pool = poolDePrueba(300);
    const db = crearDbJob(pool);
    const pidAntes = (await pool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    const t0 = Date.now();
    // Llega el error del `rollback` sobre la conexión ya cortada («Connection terminated unexpectedly»), que
    // en `drizzle` tapa al original: lo que importa es que termina en error y rápido.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(db.transaction(async (tx) => tx.execute(sql`select pg_sleep(10)`))).rejects.toThrow();
    // Con un solo tope de 300 ms: si el `rollback` esperara otro, pasarían más de 600 ms.
    expect(Date.now() - t0).toBeLessThan(1_500);
    // La conexión envenenada no vuelve al pool: la siguiente consulta usa otra.
    const pidDespues = (await pool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    expect(pidDespues).not.toBe(pidAntes);
  });

  it("la bomba vuelve a `corriendo = false` y sigue procesando después de una consulta colgada", async () => {
    const pool = poolDePrueba(300);
    let llamadas = 0;
    const cola: Cola = {
      // La primera vez la cola se cuelga en la base; la segunda, no hay trabajo.
      tomar: async () => {
        llamadas++;
        if (llamadas === 1) await pool.query("select pg_sleep(10)");
        return null;
      },
      avanzar: async () => undefined,
      latir: async () => undefined,
      terminar: async () => undefined,
    };
    const bomba = crearBomba({ cola, handlers: {} as never, contexto: {} as never, latidoMs: 10_000 });

    await expect(bomba.bombear()).rejects.toThrow(/Query read timeout/);
    expect(bomba.corriendo()).toBe(false);
    // El barrido siguiente funciona.
    await expect(bomba.bombear()).resolves.toBeUndefined();
    expect(llamadas).toBe(2);
  });
});

describe("una autenticación fallida de verdad", () => {
  it("el mensaje del servidor nombra al rol y a la base, y la línea de log no", async () => {
    const u = new URL(urlJob);
    const rol = decodeURIComponent(u.username);
    const base = u.pathname.slice(1);
    u.password = "clave-equivocada-de-prueba";
    const pool = new pg.Pool({ connectionString: u.toString(), max: 1, connectionTimeoutMillis: 3_000 });
    abiertos.push(pool);
    const error = await pool.query("select 1").then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const linea = describirErrorParaLog(error, { pila: true });
    expect(linea).not.toContain("clave-equivocada-de-prueba");
    expect(linea).not.toContain(`"${rol}"`);
    expect(linea).not.toContain(`"${base}"`);
    expect(linea).not.toMatch(/localhost|127\.0\.0\.1|5432/);
  });
});

describe("una conexión EN USO que se corta entre dos consultas de una transacción", () => {
  it("no tira el proceso: la transacción termina en error, queda un log sin datos de conexión y el pool sigue", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = poolDePrueba();
    const db = crearDbJob(pool);

    let pidEnLaTransaccion = 0;
    await expect(
      db.transaction(async (tx) => {
        pidEnLaTransaccion = Number((await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid);
        // Se corta la conexión mientras la transacción está abierta y SIN una consulta en vuelo: es el momento
        // en que el cliente no tiene ningún oyente de `'error'` si no lo pone el pool.
        await admin.query("select pg_terminate_backend($1)", [pidEnLaTransaccion]);
        await new Promise((r) => setTimeout(r, 500));
        await tx.execute(sql`select 1`);
      }),
    ).rejects.toThrow();

    // Si el proceso hubiera caído por el `'error'` sin oyente, vitest habría reportado una excepción no capturada.
    const lineas = log.mock.calls.map((c) => String(c[0]));
    expect(lineas.some((l) => l.includes("conexión en uso del pool «prueba»"))).toBe(true);
    for (const l of lineas) expect(l).not.toMatch(SECRETOS);

    // El pool sigue atendiendo, con otra conexión.
    const pid = (await pool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    expect(pid).not.toBe(pidEnLaTransaccion);
  });
});
