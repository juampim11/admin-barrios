/**
 * Escribe las variables CSS de los tokens en `apps/web/src/app/tokens.generated.css`.
 * Correr con `pnpm tokens:css` cada vez que cambian los tokens.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generarCssVars } from "../css.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
const destino = resolve(aqui, "../../../apps/web/src/app/tokens.generated.css");

mkdirSync(dirname(destino), { recursive: true });
writeFileSync(destino, generarCssVars(), "utf8");
console.log(`tokens → ${destino}`);
