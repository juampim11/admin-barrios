/**
 * El acento del barrio en el papel (doc 09 §E.9.3). El cliente elige el matiz; la legibilidad la
 * fija el sistema.
 */

import { describe, expect, it } from "vitest";
import { ACENTO_NEUTRO, acentoImpreso, contrasteContraBlanco, CONTRASTE_MINIMO } from "./acento-impreso.ts";

describe("acentoImpreso", () => {
  it("sin color declarado sale un gris neutro, nunca la marca del producto", () => {
    expect(acentoImpreso(null)).toBe(ACENTO_NEUTRO);
    expect(contrasteContraBlanco(ACENTO_NEUTRO)).toBeGreaterThanOrEqual(CONTRASTE_MINIMO);
  });

  it("un color que ya cumple se imprime tal cual: es la marca del cliente", () => {
    // Bordó oscuro: 9,66:1 contra blanco. Pasa holgado y no se toca.
    expect(acentoImpreso("#772B30")).toBe("#772b30");
    expect(contrasteContraBlanco("#772B30")).toBeGreaterThan(9);
  });

  it("un color ilegible se oscurece conservando el matiz, hasta alcanzar el piso", () => {
    // Amarillo puro: 1,07:1 contra blanco — invisible en la franja.
    expect(contrasteContraBlanco("#FFFF00")).toBeLessThan(1.2);
    const corregido = acentoImpreso("#FFFF00");
    expect(contrasteContraBlanco(corregido)).toBeGreaterThanOrEqual(CONTRASTE_MINIMO);
    // Sigue siendo el mismo matiz (amarillo/ocre): rojo y verde altos, azul en cero.
    const [r, g, b] = [corregido.slice(1, 3), corregido.slice(3, 5), corregido.slice(5, 7)].map((h) => parseInt(h, 16));
    expect(b).toBe(0);
    expect(r).toBe(g);
  });

  it("no rechaza ningún color: todos salen cumpliendo el piso", () => {
    for (const color of ["#ffffff", "#fefefe", "#00ffff", "#ff00ff", "#c9d2dc", "#000000"]) {
      expect(contrasteContraBlanco(acentoImpreso(color))).toBeGreaterThanOrEqual(CONTRASTE_MINIMO);
    }
  });

  it("rechaza lo que no es un color", () => {
    expect(() => acentoImpreso("rojo")).toThrow();
    expect(() => acentoImpreso("hsl(355 46% 32%)")).toThrow();
    expect(() => acentoImpreso("#abc")).toThrow();
  });
});
