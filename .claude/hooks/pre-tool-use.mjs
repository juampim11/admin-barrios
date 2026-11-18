// Ejecutable del hook PreToolUse: lee el JSON de la herramienta por stdin y, si `frenos.mjs` lo
// prohíbe, escribe el motivo por stderr y sale con código 2 (el código con el que Claude Code bloquea).
// Si la entrada no se puede leer NO bloquea (código 0): un hook roto no debe dejar a todo el equipo
// sin herramientas; el fallo se avisa por stderr con código 1, que Claude Code muestra sin bloquear.
import { evaluar } from "./frenos.mjs";

let crudo = "";
process.stdin.setEncoding("utf8");
for await (const trozo of process.stdin) crudo += trozo;

let entrada;
try {
  // PowerShell 5.1 antepone un BOM al canalizar texto a un programa nativo: se descarta.
  entrada = JSON.parse(crudo.replace(/^﻿/, ""));
} catch (error) {
  process.stderr.write(`Hook de frenos con error (no bloquea): la entrada no es JSON (${error instanceof Error ? error.message : String(error)})\n`);
  process.exit(1);
}

// Falla CERRADO: si `evaluar` lanza una excepción, se bloquea. Un hook que se rompe en silencio
// dejaría todo abierto sin que nadie se entere.
try {
  const resultado = evaluar(entrada);
  if (resultado.bloquear) {
    process.stderr.write(`${resultado.motivo}\n`);
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`Frenado por regla del proyecto: el hook de frenos falló (${error instanceof Error ? error.message : String(error)}) y por seguridad bloquea; pedíselo al titular.\n`);
  process.exitCode = 2;
}
