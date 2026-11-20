/**
 * Guard compartido de los scripts que **solo** pueden correr en desarrollo (reset, roles, seed, demo).
 *
 * Antes cada script preguntaba `if (process.env.NODE_ENV === "production") throw`. Eso es una **lista
 * de prohibidos**, y falla abierta para todo lo demás: `undefined`, `"Production"`, `"prod"`,
 * `"staging"`. Y `NODE_ENV` además dice cómo se compila, no en qué entorno se está corriendo — hay
 * razones legítimas para levantar un entorno real con `NODE_ENV=development`.
 *
 * Acá se invierte: **lo que no está declarado explícitamente como desarrollo, es producción**
 * (docs/devops/01-entornos.md §2.2). Un script que borra esquemas enteros y siembra datos de demo no
 * puede depender de que alguien se haya acordado de setear una variable.
 */
export function exigirEntornoLocal(queHace: string): void {
  const entorno = process.env["APP_ENTORNO"];
  if (entorno !== "local") {
    throw new Error(
      `${queHace} solo corre en desarrollo. APP_ENTORNO=${entorno ? `"${entorno}"` : "(sin definir)"} ` +
        `y se exige "local". Lo que no está declarado explícitamente como desarrollo se trata como ` +
        `producción (docs/devops/01-entornos.md §2.2). Si es tu máquina, revisá el .env de la raíz.`,
    );
  }
  exigirBaseLocal(queHace);
}

/** Hosts que cuentan como «la base de mi máquina»: loopback y el servicio `postgres` del compose. */
const HOSTS_LOCALES = new Set(["localhost", "127.0.0.1", "::1", "postgres", "host.docker.internal"]);

/**
 * La base a la que apuntan las URLs tiene que ser la local. `APP_ENTORNO=local` lo declara quien escribe el
 * `.env`; esto mira a dónde se va a conectar de verdad (S2: `pnpm db:*` está en el allow del asistente, y un
 * `DATABASE_URL` apuntando a staging o producción no tiene que alcanzar a ejecutar nada).
 * Una URL que no se puede interpretar cuenta como no local. Una variable sin definir se ignora: el que la
 * necesita ya falla por su cuenta (o usa el default local de `drizzle.config.ts`).
 */
export function exigirBaseLocal(queHace: string): void {
  for (const clave of ["DATABASE_URL", "DATABASE_URL_APP", "DATABASE_URL_JOB"]) {
    const url = process.env[clave];
    if (!url) continue;
    let host = "";
    try {
      const u = new URL(url);
      host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      // `?host=` y `?hostaddr=` pisan el host de la URL en `pg`/libpq: `…@localhost/db?host=prod` pasaría el chequeo
      // y conectaría a otro lado. Se rechazan (y `service`/`socket`, que también redirigen la conexión).
      for (const p of ["host", "hostaddr", "service", "socket"]) {
        if (u.searchParams.has(p)) host = `?${p}=`;
      }
    } catch {
      // host vacío: se trata como no local
    }
    if (!HOSTS_LOCALES.has(host)) {
      throw new Error(
        `${queHace} se niega a correr: ${clave} apunta a ${host ? `«${host}»` : "una dirección que no se pudo interpretar"}, ` +
          `que no es la base local (localhost, 127.0.0.1 o el servicio «postgres» del compose).`,
      );
    }
  }
}

// `pnpm db:migrate` llama a este archivo directo antes de `drizzle-kit migrate`: carga el `.env` como los demás
// scripts y verifica la base (sin APP_ENTORNO: migrar la base local no exige declararla «local», pero sí que lo sea).
// Se invoca con la bandera explícita `--verificar` (no se adivina si el archivo es el principal).
if (process.argv.includes("--verificar")) {
  const { config } = await import("dotenv");
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve } = await import("node:path");
  config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"), quiet: true });
  exigirBaseLocal("db:migrate");
}
