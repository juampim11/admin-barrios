/**
 * `prepararPlanillaDeDeuda`: lo que queda de la planilla de deuda anterior después de leerla y antes
 * de validarla. Lo que se fija: que achicarla **no cambia lo que `leerPlanillaDeDeuda` dice de ella**
 * (las mismas deudas, los mismos saldos a favor, los mismos errores y los mismos números de fila), y
 * los topes.
 */

import { describe, expect, it } from "vitest";
import { leerPlanillaDeDeuda, MAX_FILAS_DEUDA, plantillaDeDeuda } from "@admin-barrios/shared/activacion";
import { MAX_LARGO_DE_CELDA_DE_DEUDA, prepararPlanillaDeDeuda } from "./deuda.ts";

const preparada = (filas: string[][]) => {
  const r = prepararPlanillaDeDeuda(filas);
  if (!r.ok) throw new Error(r.mensaje);
  return r.filas;
};

describe("prepararPlanillaDeDeuda", () => {
  it("deja solo las columnas de deuda, en su orden, aunque vengan mezcladas con otras", () => {
    const filas = [
      ["Propietario", "Venció", "LOTE", "Manzana", "Falta pagar", "Concepto", "Mes", "Observaciones"],
      ["Ana Ejemplo", "10/08/2026", "7", "1", "125000", "Expensa", "08/2026", "reclamó"],
    ];
    expect(preparada(filas)).toEqual([
      ["manzana", "lote", "mes", "concepto", "vencimiento", "importe"],
      ["1", "7", "08/2026", "Expensa", "10/08/2026", "125000"],
    ]);
  });

  it("la planilla modelo pasa entera y se lee igual", () => {
    const modelo = plantillaDeDeuda();
    expect(preparada(modelo)).toEqual(modelo);
    const leida = leerPlanillaDeDeuda(preparada(modelo));
    expect(leida.errores).toEqual([]);
    expect(leida.deudas).toHaveLength(2);
    expect(leida.aFavor).toHaveLength(1);
  });

  it("no cambia lo que la lectura dice de la planilla: mismas deudas, mismos errores, mismas filas", () => {
    const filas = [
      ["manzana", "lote", "mes", "concepto", "Importe adeudado", "vencimiento", "nota"],
      ["1", "7", "08/2026", "Expensa", "125000", "10/08/2026", "x"],
      ["", "", "", "", "", "", ""],
      ["2", "15", "13/2026", "Expensa", "100", "10/08/2026", ""],
      ["2", "", "08/2026", "Expensa", "100", "10/08/2026", ""],
      ["3", "1", "08/2026", "C".repeat(300), "100", "10/08/2026", ""],
      ["3", "2", "08/2026", "Expensa", "125.000", "10/08/2026", ""],
      ["4", "1", "", "", "-18000", "", ""],
      ["", "", "", "", "", "", ""],
    ];
    expect(leerPlanillaDeDeuda(preparada(filas))).toEqual(leerPlanillaDeDeuda(filas));
  });

  it("si falta una columna, no decide nada: la lectura dice cuál falta", () => {
    const filas = [
      ["manzana", "lote", "mes", "vencimiento", "importe"],
      ["1", "7", "08/2026", "10/08/2026", "125000"],
    ];
    const leida = leerPlanillaDeDeuda(preparada(filas));
    expect(leida.deudas).toEqual([]);
    expect(leida.errores[0]?.mensaje).toContain("Falta: concepto");
  });

  it("corta cada celda y saca las filas vacías del final", () => {
    const filas = [[...plantillaDeDeuda()[0]!], ["1", "7", "08/2026", "C".repeat(900), "10/08/2026", "125000"], ["", "", "", "", "", ""], []];
    const r = preparada(filas);
    expect(r).toHaveLength(2);
    expect(r[1]?.[3]).toHaveLength(MAX_LARGO_DE_CELDA_DE_DEUDA);
  });

  it("rechaza una planilla vacía y una con más filas que el tope", () => {
    expect(prepararPlanillaDeDeuda([])).toEqual({ ok: false, mensaje: "La planilla está vacía." });
    expect(prepararPlanillaDeDeuda([[], ["", ""]])).toEqual({ ok: false, mensaje: "La planilla está vacía." });
    const encabezado = [...plantillaDeDeuda()[0]!];
    const muchas = [encabezado, ...Array.from({ length: MAX_FILAS_DEUDA + 1 }, (_, i) => ["1", String(i + 1), "08/2026", "Expensa", "10/08/2026", "100"])];
    const r = prepararPlanillaDeDeuda(muchas);
    expect(r.ok).toBe(false);
    // Justo en el tope, entra.
    expect(prepararPlanillaDeDeuda(muchas.slice(0, MAX_FILAS_DEUDA + 1)).ok).toBe(true);
  });
});
