/**
 * Una conexión **ociosa** del worker que se corta no tiene que tirar el proceso (BL-036 d, BL-049 b).
 *
 * `pg.Pool` emite `'error'` cuando una conexión ociosa se rompe y, sin oyente, Node lo trata como una
 * excepción no capturada. Acá se corta de verdad —`pg_terminate_backend` sobre la conexión que quedó
 * ociosa en el pool de la cola— y se comprueba que (1) el proceso sigue vivo, (2) queda una línea de log
 * sin datos de conexión y (3) el pool atiende la consulta siguiente con otra conexión.
 *
 * Corre contra Postgres real: ningún doble reproduce el corte de un backend (mismo criterio que
 * `cola.db.test.ts`).
 *
 * Correr con: pnpm vitest run --project db apps/worker/test/pool-ocioso.db.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { crearPoolJob, registrarErrorDePool } from "@admin-barrios/data/client";
import { abrirColaDeTrabajos } from "../src/servidor/cola.ts";

let admin: pg.Pool;
const abiertos: pg.Pool[] = [];

beforeAll(() => {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("Falta DATABASE_URL: los tests de base necesitan `pnpm db:up` y un .env");
  admin = new pg.Pool({ connectionString: url, max: 2 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(abiertos.map((p) => p.end()));
  await admin.end();
});

const pidDe = async (pool: pg.Pool) => (await pool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

describe("una conexión ociosa del worker que se corta", () => {
  it("el pool de la cola deja una línea de log, el proceso sigue y la consulta siguiente anda con otra conexión", async () => {
    const urlJob = process.env["DATABASE_URL_JOB"];
    if (!urlJob) throw new Error("Falta DATABASE_URL_JOB: los tests de base necesitan `pnpm db:up` y un .env");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { pool } = abrirColaDeTrabajos(urlJob);
    abiertos.push(pool);

    // Una sola conexión, que queda ociosa en el pool.
    const pidAntes = await pidDe(pool);
    expect(pool.idleCount).toBe(1);

    await admin.query("select pg_terminate_backend($1)", [pidAntes]);

    // El corte llega como `'error'` del pool: con oyente queda en el log; sin él, vitest lo reportaría como
    // excepción no capturada y el test fallaría.
    await vi.waitFor(() => expect(log).toHaveBeenCalled(), { timeout: 5_000 });
    const linea = String(log.mock.calls[0]![0]);
    expect(linea).toContain("«cola»");
    // Ni dirección, ni puerto, ni usuario, ni la URL: solo el mensaje y el código.
    expect(linea).not.toMatch(/\d+\.\d+\.\d+\.\d+|localhost|postgres(ql)?:\/\//);

    // El barrido siguiente funciona, con una conexión nueva.
    const pidDespues = await pidDe(pool);
    expect(pidDespues).not.toBe(pidAntes);
  });

  it("registrarErrorDePool: un error emitido sobre el pool no lo tira, y no copia los datos de conexión", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pool = crearPoolJob({ url: "postgres://alguien:secreto@10.9.8.7:5999/x" });
    abiertos.push(pool);
    registrarErrorDePool(pool, "prueba");

    const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", address: "10.9.8.7", port: 5999 });
    expect(() => pool.emit("error", error)).not.toThrow();

    const linea = String(log.mock.calls[0]![0]);
    expect(linea).toContain("«prueba»");
    expect(linea).toContain("read ECONNRESET (ECONNRESET)");
    expect(linea).not.toMatch(/10\.9\.8\.7|5999|secreto/);
  });

  it("sin el oyente el mismo error SÍ es una excepción (el test mira lo que de verdad protege)", () => {
    const pool = crearPoolJob({ url: "postgres://alguien:secreto@10.9.8.7:5999/x" });
    abiertos.push(pool);
    expect(() => pool.emit("error", new Error("read ECONNRESET"))).toThrow(/ECONNRESET/);
  });
});
