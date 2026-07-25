import { describe, expect, it } from "vitest";
import {
  aCentavos,
  coeficienteAEntero,
  deCentavos,
  prorratear,
  prorratearDetallado,
  restarMontos,
  sumarMontos,
} from "./dinero.ts";

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

describe("prorrateo detallado: lo que se cobra y lo que da la calculadora", () => {
  it("el teórico se calcula sobre la SUMA de coeficientes, no sobre una escala fija", () => {
    // Coeficientes como pesos relativos (art. 2081: superficie/lote/mixto NO suman 1).
    // Este es el caso que estaba mal: dividir por una escala fija daba $29.700 en vez de $297.
    const partes = prorratearDetallado("900.00", [
      ["uf-1", "33.0"],
      ["uf-2", "33.0"],
      ["uf-3", "34.0"],
    ]);
    expect(partes.map((p) => p.monto)).toEqual(["297.00", "297.00", "306.00"]);
    expect(partes.map((p) => p.montoTeorico)).toEqual(["297.00", "297.00", "306.00"]);
  });

  it("si una unidad quedó fuera del reparto, el teórico se renormaliza igual que el cobro", () => {
    // Versión cerrada con 4 unidades al 0.25; una se dio de baja después, así que reparte entre 3.
    const partes = prorratearDetallado("1000.00", [
      ["uf-1", "0.25"],
      ["uf-2", "0.25"],
      ["uf-3", "0.25"],
    ]);
    expect(partes.map((p) => p.montoTeorico)).toEqual(["333.33", "333.33", "333.33"]);
    expect(sumarMontos(...partes.map((p) => p.monto))).toBe("1000.00");
  });

  it("el ajuste (cobro − teórico) es de centavos, y la suma cierra igual", () => {
    const partes = prorratearDetallado("100.02", [
      ["a", "0.25"],
      ["b", "0.25"],
      ["c", "0.25"],
      ["d", "0.25"],
    ]);
    for (const p of partes) {
      // En centavos, para no comparar con la aritmética de punto flotante que este módulo evita.
      const ajuste = aCentavos(p.monto) - aCentavos(p.montoTeorico);
      expect(ajuste >= -1n && ajuste <= 1n).toBe(true);
    }
    expect(sumarMontos(...partes.map((p) => p.monto))).toBe("100.02");
  });

  it("redondea bien en negativo (el día que existan las notas de crédito)", () => {
    const partes = prorratearDetallado("-10.00", [
      ["a", "0.5"],
      ["b", "0.5"],
    ]);
    expect(partes.map((p) => p.montoTeorico)).toEqual(["-5.00", "-5.00"]);
    expect(sumarMontos(...partes.map((p) => p.monto))).toBe("-10.00");
  });

  it("coeficienteAEntero trunca a 9 decimales, igual que la columna de la base", () => {
    expect(coeficienteAEntero("0.012345678")).toBe(12345678n);
    expect(coeficienteAEntero("0.0123456789")).toBe(12345678n); // el décimo decimal se descarta
    expect(coeficienteAEntero("120")).toBe(120_000_000_000n);
    expect(() => coeficienteAEntero("-0.5")).toThrow();
  });
});
