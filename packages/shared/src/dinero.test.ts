import { describe, expect, it } from "vitest";
import { aCentavos, deCentavos, prorratear, restarMontos, sumarMontos } from "./dinero.ts";

describe("montos exactos", () => {
  it("no pierde precisión donde el float fallaría", () => {
    // 0.1 + 0.2 === 0.30000000000000004 con number; acá tiene que dar exacto.
    expect(sumarMontos("0.10", "0.20")).toBe("0.30");
  });

  it("ida y vuelta a centavos", () => {
    expect(aCentavos("1234.56")).toBe(123456n);
    expect(aCentavos("-8.00")).toBe(-800n);
    expect(deCentavos(123456n)).toBe("1234.56");
    expect(deCentavos(-5n)).toBe("-0.05");
    expect(deCentavos(0n)).toBe("0.00");
  });

  it("rechaza formatos ambiguos", () => {
    expect(() => aCentavos("1234.5")).toThrow();
    expect(() => aCentavos("1.234,56")).toThrow();
    expect(() => aCentavos("1234")).toThrow();
  });

  it("suma y resta grandes sin desbordar", () => {
    expect(sumarMontos("99999999.99", "0.01")).toBe("100000000.00");
    expect(restarMontos("100.00", "133.33")).toBe("-33.33");
  });
});

describe("prorrateo por coeficiente", () => {
  it("reparte proporcionalmente", () => {
    const partes = prorratear("1000.00", [
      ["uf-1", "0.50"],
      ["uf-2", "0.50"],
    ]);
    expect(partes).toEqual([
      ["uf-1", "500.00"],
      ["uf-2", "500.00"],
    ]);
  });

  it("la suma de las partes SIEMPRE cierra igual al total (resto a la última)", () => {
    const total = "1000.00";
    const partes = prorratear(total, [
      ["uf-1", "0.333333"],
      ["uf-2", "0.333333"],
      ["uf-3", "0.333334"],
    ]);
    expect(sumarMontos(...partes.map(([, m]) => m))).toBe(total);
  });

  it("cierra también con muchas unidades y coeficientes despapadejos", () => {
    const coefs = Array.from({ length: 47 }, (_, i) => [`uf-${i}`, `0.0${(i % 7) + 1}`] as const);
    const partes = prorratear("123456.78", coefs);
    expect(sumarMontos(...partes.map(([, m]) => m))).toBe("123456.78");
  });

  it("soporta prorrateo no proporcional (pesos arbitrarios, no porcentajes)", () => {
    // Coeficientes por superficie: 120 m2 vs 80 m2 sobre un total de 200.
    const partes = prorratear("500.00", [
      ["uf-1", "120"],
      ["uf-2", "80"],
    ]);
    expect(partes).toEqual([
      ["uf-1", "300.00"],
      ["uf-2", "200.00"],
    ]);
  });

  it("no acepta repartir entre nadie ni con coeficientes en cero", () => {
    expect(() => prorratear("100.00", [])).toThrow();
    expect(() => prorratear("100.00", [["uf-1", "0"]])).toThrow();
  });
});
