import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  coeficienteDesdeTexto,
  ESCALA_COEFICIENTE,
  repartirCoeficientes,
  sumarCoeficientes,
} from "./coeficientes.ts";

const RUNS = { numRuns: 1000 };

/** Pesos realistas y extremos: superficies con centavos, unos por lote, y alguno ínfimo frente a otro enorme. */
const pesoArb = fc.oneof(
  fc.integer({ min: 1, max: 5_000_000 }).map((c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`).filter((p) => p !== "0.00"),
  fc.constant("1"),
  fc.integer({ min: 1, max: 999_999_999 }).map((n) => `0.${String(n).padStart(9, "0")}`),
  fc.integer({ min: 1, max: 999_999_999_999 }).map(String),
);
const unidadesArb = fc
  .array(pesoArb, { minLength: 1, maxLength: 700 })
  .map((pesos) => pesos.map((peso, i) => ({ unidadFuncionalId: `u${i}`, peso })));

describe("repartirCoeficientes", () => {
  it("la suma da siempre 1 exacto", () => {
    fc.assert(
      fc.property(unidadesArb, (unidades) => {
        expect(sumarCoeficientes(repartirCoeficientes(unidades).map((c) => c.valor))).toBe("1.000000000");
      }),
      RUNS,
    );
  });

  it("ningún coeficiente es cero ni negativo", () => {
    fc.assert(
      fc.property(unidadesArb, (unidades) => {
        for (const c of repartirCoeficientes(unidades)) expect(coeficienteDesdeTexto(c.valor) > 0n).toBe(true);
      }),
      RUNS,
    );
  });

  it("es determinístico: los mismos pesos dan los mismos coeficientes", () => {
    fc.assert(
      fc.property(unidadesArb, (unidades) => {
        expect(repartirCoeficientes(unidades)).toEqual(repartirCoeficientes(unidades.map((u) => ({ ...u }))));
      }),
      RUNS,
    );
  });

  it("tiene 9 decimales y respeta el orden de entrada", () => {
    fc.assert(
      fc.property(unidadesArb, (unidades) => {
        const r = repartirCoeficientes(unidades);
        expect(r.map((c) => c.unidadFuncionalId)).toEqual(unidades.map((u) => u.unidadFuncionalId));
        for (const c of r) expect(c.valor).toMatch(/^\d\.\d{9}$/);
      }),
      RUNS,
    );
  });

  it("iguales por lote: tres unidades dan 0,333333333 y la última se lleva el resto", () => {
    const r = repartirCoeficientes(["a", "b", "c"].map((id) => ({ unidadFuncionalId: id, peso: "1" })));
    expect(r.map((c) => c.valor)).toEqual(["0.333333333", "0.333333333", "0.333333334"]);
  });

  it("por superficie: proporcional, con el resto a la última", () => {
    const r = repartirCoeficientes([
      { unidadFuncionalId: "a", peso: "600.00" },
      { unidadFuncionalId: "b", peso: "300.00" },
      { unidadFuncionalId: "c", peso: "100.00" },
    ]);
    expect(r.map((c) => c.valor)).toEqual(["0.600000000", "0.300000000", "0.100000000"]);
  });

  it("una planilla que ya suma 1 queda igual", () => {
    const r = repartirCoeficientes([
      { unidadFuncionalId: "a", peso: "0.012500000" },
      { unidadFuncionalId: "b", peso: "0.987500000" },
    ]);
    expect(r.map((c) => c.valor)).toEqual(["0.012500000", "0.987500000"]);
  });

  it("una unidad sola tiene coeficiente 1", () => {
    expect(repartirCoeficientes([{ unidadFuncionalId: "a", peso: "605.00" }])[0]?.valor).toBe("1.000000000");
  });

  it("una unidad ínfima frente a una enorme no queda en cero", () => {
    const r = repartirCoeficientes([
      { unidadFuncionalId: "chica", peso: "0.000000001" },
      { unidadFuncionalId: "grande", peso: "999999999999" },
    ]);
    expect(coeficienteDesdeTexto(r[0]!.valor)).toBe(1n);
    expect(coeficienteDesdeTexto(r[1]!.valor)).toBe(ESCALA_COEFICIENTE - 1n);
  });

  it("rechaza un peso cero o mal escrito, y una lista vacía", () => {
    expect(() => repartirCoeficientes([{ unidadFuncionalId: "a", peso: "0" }])).toThrow(/mayor que cero/);
    expect(() => repartirCoeficientes([{ unidadFuncionalId: "a", peso: "-3" }])).toThrow(/peso inválido/);
    expect(() => repartirCoeficientes([])).toThrow(/no hay unidades/);
  });
});
