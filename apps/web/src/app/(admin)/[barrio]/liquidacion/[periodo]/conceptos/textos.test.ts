/**
 * Los textos de «Conceptos del mes» (encargo 16b). Lo que se fija: el chip de cada origen, cómo se
 * dice la cantidad de un renglón de la vista previa, y que el pie no afirme que la deuda «no suma»
 * cuando el cupón de ese barrio también la cobra.
 */

import { describe, expect, it } from "vitest";
import { cantidadDelRenglon, chipDeOrigen, dondeEstaElError, pieDelMes, planillaAplicada, tituloDeErrores, usoConFecha } from "./textos.ts";

describe("el chip de «de dónde sale»", () => {
  it("la bonificación de la regla y lo que aplica el catálogo entran solos", () => {
    expect(chipDeOrigen("bonificacion").texto).toBe("Sola");
    expect(chipDeOrigen("sola").texto).toBe("Sola");
    expect(chipDeOrigen("planilla").texto).toBe("Planilla");
    expect(chipDeOrigen("mano").texto).toBe("A mano");
  });
});

describe("la vista previa de la planilla", () => {
  it("un uso se dice con su fecha y su unidad", () => {
    expect(usoConFecha({ fecha: "2026-11-08", cantidad: "1" }, "turno")).toBe("08/11/2026 · 1 turno");
    expect(usoConFecha({ fecha: "2026-11-08", cantidad: "1.5" }, null)).toBe("08/11/2026 · 1,5 usos");
  });

  it("la cantidad dice con cuánto queda si ya había usos de otra planilla del mes", () => {
    expect(cantidadDelRenglon({ cantidad: "2", cantidadAnterior: "0", cantidadTotal: "2" }, "turno")).toBe("2 turnos");
    expect(cantidadDelRenglon({ cantidad: "2", cantidadAnterior: "1", cantidadTotal: "3" }, "turno")).toBe(
      "2 turnos de esta planilla + 1 turno ya cargados = 3 turnos",
    );
  });

  it("un error de la planilla entera no se le atribuye a una fila", () => {
    expect(dondeEstaElError(1)).toBe("La planilla");
    expect(dondeEstaElError(7)).toBe("Fila 7");
    expect(tituloDeErrores(1)).toContain("1 error");
    expect(tituloDeErrores(3)).toContain("3 errores");
  });

  it("al aplicar dice cuánto se cargó", () => {
    expect(planillaAplicada({ renglones: 5, usos: 12, total: "96000.00" })).toBe(
      "Listo: se cargaron 12 usos en 5 renglones de boleta, por $ 96.000,00.",
    );
    expect(planillaAplicada({ renglones: 1, usos: 1, total: "8000.00" })).toBe("Listo: se cargó 1 uso en 1 renglón de boleta, por $ 8.000,00.");
  });
});

describe("el pie de la pestaña", () => {
  const totales = { cupones: "1000000.00", expensa: "900000.00", cargos: "100000.00", deudaAnterior: "250000.00", boletas: 212 };

  it("con «solo el mes», el devengado son los cupones y la deuda va sin sumar", () => {
    const pie = pieDelMes("noviembre 2026", totales, "solo_mes");
    expect(pie.devengado).toEqual({ valor: "$ 1.000.000,00", etiqueta: "Devengado de noviembre 2026" });
    expect(pie.deuda.valor).toBe("$ 250.000,00");
    expect(pie.deuda.etiqueta).toContain("No es devengado de este mes: va como referencia, sin sumar");
    expect(pie.origen).toContain("los 212 cupones del mes");
  });

  it.each([["mes_mas_deuda" as const], [null]])("si el cupón también cobra la deuda (%s), no dice que no suma", (cuponCobra) => {
    const pie = pieDelMes("noviembre 2026", totales, cuponCobra);
    expect(pie.devengado.etiqueta).toBe("Cupones de noviembre 2026");
    expect(pie.deuda.etiqueta).not.toContain("sin sumar");
    expect(pie.deuda.etiqueta).toContain("ya está dentro de los cupones");
  });
});
