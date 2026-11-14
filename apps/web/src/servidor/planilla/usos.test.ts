/**
 * `prepararPlanillaDeUsos`: lo que queda de la planilla después de leerla y antes de validarla. Lo
 * que se fija: que achicarla **no cambia lo que `leerPlanillaUsos` dice de ella** (los mismos usos,
 * los mismos errores y los mismos números de fila), y los topes.
 */

import { describe, expect, it } from "vitest";
import { leerPlanillaUsos, MAX_FILAS_USOS } from "@admin-barrios/shared/conceptos";
import { MAX_LARGO_DE_CELDA_DE_USOS, prepararPlanillaDeUsos } from "./usos.ts";

const preparada = (filas: string[][]) => {
  const r = prepararPlanillaDeUsos(filas);
  if (!r.ok) throw new Error(r.mensaje);
  return r.filas;
};

describe("prepararPlanillaDeUsos", () => {
  it("deja solo las columnas de usos, en su orden, aunque vengan mezcladas con otras", () => {
    const filas = [
      ["Propietario", "Fecha", "LOTE", "Manzana", "Cantidad", "Concepto", "Observaciones"],
      ["Ana Ejemplo", "08/11/2026", "4", "1", "1", "Cancha", "vino con invitados"],
    ];
    expect(preparada(filas)).toEqual([
      ["manzana", "lote", "concepto", "fecha", "cantidad"],
      ["1", "4", "Cancha", "08/11/2026", "1"],
    ]);
  });

  it("no cambia lo que la lectura dice de la planilla: mismos usos, mismos errores, mismas filas", () => {
    const filas = [
      ["manzana", "lote", "concepto", "fecha", "cantidad", "nota"],
      ["1", "4", "Cancha", "08/11/2026", "1", "x"],
      ["", "", "", "", "", ""],
      ["2", "15", "Salón", "31/02/2026", "1", ""],
      ["2", "", "Salón", "22/11/2026", "2", ""],
      ["3", "1", "C".repeat(300), "22/11/2026", "2", ""],
      ["", "", "", "", "", ""],
    ];
    expect(leerPlanillaUsos(preparada(filas))).toEqual(leerPlanillaUsos(filas));
  });

  it("si falta una columna, no decide nada: la lectura dice cuál falta", () => {
    const filas = [
      ["manzana", "lote", "fecha", "cantidad"],
      ["1", "4", "08/11/2026", "1"],
    ];
    const leida = leerPlanillaUsos(preparada(filas));
    expect(leida.usos).toEqual([]);
    expect(leida.errores[0]?.mensaje).toContain("Falta: concepto");
  });

  it("corta cada celda y saca las filas vacías del final", () => {
    const filas = [["manzana", "lote", "concepto", "fecha", "cantidad"], ["1", "4", "C".repeat(900), "08/11/2026", "1"], ["", "", "", "", ""], []];
    const r = preparada(filas);
    expect(r).toHaveLength(2);
    expect(r[1]?.[2]).toHaveLength(MAX_LARGO_DE_CELDA_DE_USOS);
  });

  it("rechaza una planilla vacía y una con más filas que el tope", () => {
    expect(prepararPlanillaDeUsos([])).toEqual({ ok: false, mensaje: "La planilla está vacía." });
    const larga = [["manzana", "lote", "concepto", "fecha", "cantidad"], ...Array.from({ length: MAX_FILAS_USOS + 1 }, () => ["1", "4", "Cancha", "08/11/2026", "1"])];
    const r = prepararPlanillaDeUsos(larga);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.mensaje).toContain("partila en varias");
  });

  it("rechaza una planilla que, aun achicada, es demasiado texto para volver al navegador", () => {
    const gorda = [
      ["manzana", "lote", "concepto", "fecha", "cantidad"],
      ...Array.from({ length: MAX_FILAS_USOS }, () => ["1".repeat(160), "4".repeat(160), "C".repeat(160), "08/11/2026", "1"]),
    ];
    expect(prepararPlanillaDeUsos(gorda).ok).toBe(false);
  });
});
