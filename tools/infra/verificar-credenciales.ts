/**
 * Guard de arranque: el proceso **no atiende** si en su entorno hay una credencial que no le toca.
 *
 * Es el candado en runtime. El test de CI verifica el `docker-compose.yml` (estático) y no puede ver
 * un `docker run -e DATABASE_URL_JOB=…`, un manifiesto de Kubernetes escrito a mano ni una variable
 * cargada en el panel del hosting. Esto sí.
 *
 * Uso:
 *   node tools/infra/verificar-credenciales.ts --rol=web
 *   node tools/infra/verificar-credenciales.ts --rol=web --exigir-requeridas
 *   node tools/infra/verificar-credenciales.ts --rol=web --dotenv=apps/web/.env.local
 *
 * `--dotenv` existe porque en el host el proceso de Next carga `apps/web/.env.local` **después** de
 * arrancar: sin mirar el archivo, el guard no vería la credencial que la app sí va a ver.
 *
 * Sin dependencias: lo ejecuta el contenedor antes de que exista nada instalado.
 */

import { existsSync, readFileSync } from "node:fs";
import { REGLAS, verificar, type RolDeProceso, faltantesContraEjemplo } from "./credenciales.ts";

/** Parseo mínimo de un `.env`: `CLAVE=valor`, comillas opcionales, comentarios de línea completa. */
function leerDotenv(ruta: string): Record<string, string> {
  let contenido: string;
  try {
    contenido = readFileSync(ruta, "utf8");
  } catch {
    return {}; // Que el archivo no exista es normal y no es una violación.
  }
  const salida: Record<string, string> = {};
  for (const linea of contenido.split(/\r?\n/)) {
    const encontrado = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linea);
    if (!encontrado?.[1]) continue;
    const valor = (encontrado[2] ?? "").trim().replace(/\s+#.*$/, "");
    salida[encontrado[1]] = valor.replace(/^(['"])(.*)\1$/, "$2");
  }
  return salida;
}

function principal(argumentos: readonly string[]): number {
  const prefijoRol = "--rol=";
  const rolCrudo = argumentos.find((a) => a.startsWith(prefijoRol))?.slice(prefijoRol.length);
  if (!rolCrudo || !(rolCrudo in REGLAS)) {
    console.error(`Uso: --rol=<${Object.keys(REGLAS).join("|")}> [--exigir-requeridas] [--dotenv=ruta]`);
    return 2;
  }
  const rol = rolCrudo as RolDeProceso;

  const entorno: Record<string, string | undefined> = { ...process.env };
  for (const argumento of argumentos) {
    if (argumento.startsWith("--dotenv=")) {
      Object.assign(entorno, leerDotenv(argumento.slice("--dotenv=".length)));
    }
  }

  // Aviso, no violación: lo que el `.example` tiene y el archivo real no (BL-019). Solo nombres.
  for (const argumento of argumentos) {
    if (!argumento.startsWith("--dotenv=")) continue;
    const ruta = argumento.slice("--dotenv=".length);
    // Sin archivo real no hay nada que comparar: el entorno llega por el proceso (docker, CI), y
    // avisar que "faltan todas" sería falso.
    if (!existsSync(ruta)) continue;
    const faltan = faltantesContraEjemplo(leerDotenv(ruta), leerDotenv(`${ruta}.example`)).filter(
      (nombre) => !process.env[nombre],
    );
    if (faltan.length > 0) {
      console.warn(
        [
          "",
          `⚠ A ${ruta} le faltan variables que sí están en ${ruta}.example:`,
          ...faltan.map((n) => `  - ${n}`),
          "  Copialas del .example (en local, los valores de ahí sirven tal cual). Sin ellas, la",
          "  función que las usa no anda; el resto arranca igual.",
          "",
        ].join("\n"),
      );
    }
  }

  const violaciones = verificar(rol, entorno, {
    exigirRequeridas: argumentos.includes("--exigir-requeridas"),
  });
  if (violaciones.length === 0) return 0;

  console.error(`\n✖ El proceso "${rol}" no arranca: su entorno está mal armado.`);
  console.error(`  ${REGLAS[rol].descripcion}\n`);
  for (const violacion of violaciones) {
    console.error(`  - ${violacion.variable}: ${violacion.motivo}`);
  }
  console.error(
    "\n  Qué recibe cada proceso: docs/devops/01-entornos.md §2.1." +
      "\n  Si de verdad hace falta una variable nueva, se declara en tools/infra/credenciales.ts" +
      "\n  (y el cambio se ve en el diff, que es donde se tiene que discutir).\n",
  );
  return 1;
}

// `exitCode` y no `process.exit()`: con `exit()`, Windows aborta el proceso mientras todavía está
// escribiendo en stderr y el mensaje —que es todo el valor de este guard— sale cortado, con un
// código de salida que no es el que se pidió.
process.exitCode = principal(process.argv.slice(2));
