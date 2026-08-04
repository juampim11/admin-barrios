/**
 * Borra la carpeta de compilación de Next (`apps/web/.next`).
 *
 * **Por qué existe un script para un `rm -rf`.** El servidor de desarrollo y `pnpm build` escriben
 * en la **misma** carpeta, así que correr uno con el otro levantado la deja inconsistente. El
 * síntoma no dice nada de eso: la pantalla muestra
 * *"Jest worker encountered child process exceptions, exceeding retry limit"*, que suena a un error
 * de la aplicación y no lo es. Y encima es intermitente —las rutas ya compiladas siguen andando y
 * las nuevas revientan—, que es la peor forma de un error.
 *
 * Pasó dos veces el 2026-08-04 mientras se verificaban pantallas. Un comando escrito, con nombre
 * propio y citado en la guía de prueba, cuesta menos que volver a diagnosticarlo.
 *
 * No toca la base ni los `node_modules`: solo el caché de compilación, que Next reconstruye solo.
 */

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const destino = resolve(raiz, "apps/web/.next");

rmSync(destino, { recursive: true, force: true });
console.log(`Caché de compilación borrado: ${destino}`);
console.log("La primera visita a cada pantalla va a tardar: está compilando, no está colgada.");
