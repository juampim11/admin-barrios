import { defineConfig } from "drizzle-kit";
import { config as cargarEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const aqui = dirname(fileURLToPath(import.meta.url));
cargarEnv({ path: resolve(aqui, "../../.env"), quiet: true });

// Migraciones en SQL plano versionadas en el repo (ADR-0000 §5): aplicables con `drizzle-kit migrate`
// contra CUALQUIER Postgres (Docker local, RDS, Supabase, Neon). Nunca editar una ya aplicada.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgres://admin_barrios:admin_barrios_dev@localhost:5432/admin_barrios",
  },
  verbose: true,
  strict: true,
});
