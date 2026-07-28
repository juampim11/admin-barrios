/**
 * La regla de importación del ADR-0001 §3, verificada en CI:
 *
 * > `apps/web` puede importar `plantillas/` y `simbolos.ts`; **no puede importar
 * > `adapters/chromium.ts`**. Si Chromium entra al bundle de Next, la imagen de la app se infla
 * > +734 MB y volvemos al problema que este ADR evita.
 *
 * Es fácil de romper sin darse cuenta —un `export *` de más en un `index.ts` alcanza—, así que en
 * vez de mirar los imports directos se camina el **grafo entero** desde las entradas de la web,
 * atravesando los paquetes del workspace por su mapa de `exports`.
 *
 * El caminante ya no vive acá: se extrajo a `tools/arquitectura/grafo.ts` (ADR-0002 §5.3), porque
 * las once reglas de `apps/web/src/arquitectura.test.ts` necesitan exactamente lo mismo. **Este test
 * queda donde está**: la regla de Chromium es del ADR-0001 y su test vive con su paquete.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { archivosFuente, grafo, RAIZ, resolverWorkspace } from "../../../tools/arquitectura/grafo.ts";

/** Paquetes que **no pueden** aparecer en el grafo de la app web. */
const VETADOS = ["puppeteer-core", "puppeteer", "playwright", "pdf-lib"];

const CHROMIUM = resolve(RAIZ, "packages/documentos/src/adapters/chromium.ts");

describe("regla de importación: la web no arrastra el motor", () => {
  it("el caminante detecta de verdad el motor (si no, todo lo demás sería un falso verde)", () => {
    const { archivos, externos } = grafo([CHROMIUM]);
    expect(archivos.has(CHROMIUM)).toBe(true);
    expect(externos).toContain("puppeteer-core");
    expect(externos).toContain("pdf-lib");
  });

  it("apps/web no llega a `adapters/chromium.ts` por ningún camino", () => {
    const { archivos, externos } = grafo(archivosFuente(join(RAIZ, "apps/web/src")));
    expect(archivos.has(CHROMIUM)).toBe(false);
    for (const vetado of VETADOS) expect(externos).not.toContain(vetado);
  });

  it("la entrada pública de `documentos` tampoco lo exporta: `.` es seguro para la web", () => {
    const { archivos, externos } = grafo([resolve(RAIZ, "packages/documentos/src/index.ts")]);
    expect(archivos.has(CHROMIUM)).toBe(false);
    for (const vetado of VETADOS) expect(externos).not.toContain(vetado);
  });

  it("el adapter vive detrás de su propia subruta de `exports`", () => {
    expect(resolverWorkspace("@admin-barrios/documentos/chromium")).toBe(CHROMIUM);
  });
});
