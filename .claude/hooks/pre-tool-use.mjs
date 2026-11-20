// Ejecutable del hook PreToolUse: lee el JSON de la herramienta por stdin y, si `frenos.mjs` lo
// prohíbe, escribe el motivo por stderr y sale con código 2 (el código con el que Claude Code bloquea).
// Si la entrada no se puede leer NO bloquea (código 0): un hook roto no debe dejar a todo el equipo
// sin herramientas; el fallo se avisa por stderr con código 1, que Claude Code muestra sin bloquear.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  // [F7] El mensaje de `git commit -F archivo` / `gh pr create --body-file archivo` se lee de verdad para
  // buscar la marca de IA (antes se pasaba vacío; security-engineer, m3). Si no se puede leer, vacío.
  const resultado = evaluar(entrada, {
    leerArchivo: (ruta) => {
      try {
        return readFileSync(resolve(entrada?.cwd || process.cwd(), ruta), "utf8");
      } catch {
        return "";
      }
    },
  });
  if (resultado.bloquear) {
    process.stderr.write(`${resultado.motivo}\n`);
    process.exitCode = 2;
  } else if (resultado.preguntar) {
    // [F7] Modo supervisado: se pide aprobación aunque `permissions.allow` lo permita.
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: resultado.preguntar },
      })}\n`,
    );
  }
} catch (error) {
  process.stderr.write(`Frenado por regla del proyecto: el hook de frenos falló (${error instanceof Error ? error.message : String(error)}) y por seguridad bloquea; pedíselo al titular.\n`);
  process.exitCode = 2;
}
