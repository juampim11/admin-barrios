/**
 * BL-052 a: los importes de las tablas van a la derecha, con dígitos tabulares.
 *
 * Por qué hay un test: la clase `.numerica` existía y se usaba en unas 160 celdas, y ninguna quedaba a la
 * derecha, porque `.tabla th, .tabla td { text-align: left }` (especificidad 0,1,1) le ganaba a
 * `.numerica` (0,1,0). Compilaba, pasaba todo y solo se veía mirando la pantalla. Lo que se verifica
 * acá es la causa, no el síntoma: que el «a la izquierda» de la tabla no pueda volver a ganarle a la clase.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./ui.module.css", import.meta.url), "utf8");

/** Las reglas del archivo: selector y cuerpo. Alcanza para este CSS plano (sin anidado ni @media con `.tabla`). */
const reglas = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim(), cuerpo: m[2]! }));

describe("alineación de las celdas de la tabla (BL-052 a)", () => {
  it("ninguna regla `.tabla th` / `.tabla td` fija `text-align` con especificidad que le gane a `.numerica`", () => {
    const culpables = reglas.filter(
      (r) =>
        /text-align\s*:/.test(r.cuerpo) &&
        r.selector.split(",").some((s) => /\.tabla\b/.test(s) && /\b(th|td)\b/.test(s) && !/:where\(\.tabla\)/.test(s) && !/numerica/.test(s)),
    );
    expect(culpables.map((r) => r.selector)).toEqual([]);
  });

  it("el «a la izquierda» de la tabla existe, pero con `:where` (especificidad cero)", () => {
    const base = reglas.find((r) => /:where\(\.tabla\)/.test(r.selector) && /text-align\s*:\s*left/.test(r.cuerpo));
    expect(base?.selector).toBeDefined();
  });

  it("`.numerica` alinea a la derecha con dígitos tabulares", () => {
    const numerica = reglas.find((r) => r.selector === ".numerica");
    expect(numerica?.cuerpo).toMatch(/text-align\s*:\s*right/);
    expect(numerica?.cuerpo).toMatch(/font-variant-numeric\s*:\s*tabular-nums/);
  });
});
