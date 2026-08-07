/**
 * Borra y recrea la base LOCAL (esquemas `public`, `app` y el historial de migraciones de Drizzle).
 * Solo desarrollo: nunca apuntar esto a una base con datos reales.
 *
 * Uso: `pnpm --filter @admin-barrios/data reset && pnpm db:migrate && pnpm db:setup`
 */
import pg from "pg";
import { config as cargarEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exigirEntornoLocal } from "./solo-desarrollo.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
cargarEnv({ path: resolve(aqui, "../../../.env"), quiet: true });

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("Falta DATABASE_URL (ver .env.example)");
exigirEntornoLocal("reset-dev (borra los esquemas de la base)");
if (!/localhost|127\.0\.0\.1|@postgres[:/]/.test(url)) {
  throw new Error(`DATABASE_URL no parece local (${url}). reset-dev se niega a borrar una base remota.`);
}

const cliente = new pg.Client({ connectionString: url });
await cliente.connect();
try {
  await cliente.query("drop schema if exists app cascade");
  await cliente.query("drop schema if exists public cascade");
  await cliente.query("create schema public");
  await cliente.query("drop schema if exists drizzle cascade");
  console.log("Base local reseteada. Ahora: pnpm db:migrate && pnpm db:setup");
} finally {
  await cliente.end();
}
