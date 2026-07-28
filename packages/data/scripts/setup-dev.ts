/**
 * Prepara la base LOCAL de desarrollo: crea los roles de login que usan la app y los jobs.
 *
 * Por qué existe: las migraciones crean los roles `app_request` (sin login, sujeto a RLS) y
 * `app_job` (BYPASSRLS) **sin contraseña** — un secreto nunca va al repo. Cada entorno les asigna
 * credenciales por su cuenta; esto hace esa parte para el entorno local, leyendo el `.env`.
 *
 * Correr después de `pnpm db:migrate`.
 */
import pg from "pg";
import { config as cargarEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exigirEntornoLocal } from "./solo-desarrollo.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
cargarEnv({ path: resolve(aqui, "../../../.env"), quiet: true });

const urlAdmin = process.env["DATABASE_URL"];
const usuarioApp = process.env["APP_DB_USER"] ?? "app_request_dev";
const passApp = process.env["APP_DB_PASSWORD"];
const passJob = process.env["JOB_DB_PASSWORD"];

if (!urlAdmin) throw new Error("Falta DATABASE_URL (ver .env.example)");
if (!passApp || !passJob) throw new Error("Faltan APP_DB_PASSWORD / JOB_DB_PASSWORD (ver .env.example)");
// En producción los roles y sus contraseñas se crean por entorno, nunca desde un script del repo.
exigirEntornoLocal("setup-dev (le pone contraseña a los roles de la app)");

const cliente = new pg.Client({ connectionString: urlAdmin });
await cliente.connect();

try {
  // El nombre de un rol no es parametrizable en DDL: se valida antes de interpolarlo.
  if (!/^[a-z_][a-z0-9_]*$/.test(usuarioApp)) throw new Error(`APP_DB_USER inválido: ${usuarioApp}`);

  const existe = await cliente.query("select 1 from pg_roles where rolname = $1", [usuarioApp]);
  if (existe.rowCount === 0) {
    await cliente.query(`create role ${usuarioApp} login inherit in role app_request`);
  }
  // nosuperuser/nobypassrls explícitos: si este rol saltara la RLS, el aislamiento sería decorativo.
  await cliente.query(`alter role ${usuarioApp} with password ${quoteLiteral(passApp)} nosuperuser nobypassrls`);
  await cliente.query(`alter role app_job with password ${quoteLiteral(passJob)}`);

  console.log(`Roles locales listos: ${usuarioApp} (sujeto a RLS) y app_job (BYPASSRLS).`);
} finally {
  await cliente.end();
}

/** Escapa una contraseña como literal SQL (DDL no admite parámetros). */
function quoteLiteral(valor: string): string {
  return `'${valor.replace(/'/g, "''")}'`;
}
