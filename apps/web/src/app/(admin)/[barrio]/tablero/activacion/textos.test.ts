/**
 * Los textos de la activación del barrio (encargo 17). Lo que se fija: qué paso está hecho y cuándo
 * se habilita «Verificar antes de activar», cómo se dice lo cargado (incluida una planilla que solo
 * trae saldos a favor), que la comparación con el sistema anterior sea en centavos, y que el diálogo
 * de activación no hable de deudas en un barrio que no trae.
 */

import { describe, expect, it } from "vitest";
import {
  chipDeRenglon,
  compararConElSistemaAnterior,
  consecuenciasDeActivar,
  deudasEnPalabras,
  dondeEstaElError,
  lineaDeActivado,
  listoDeLaDeudaAnterior,
  pasosDeLaActivacion,
  saldosAFavorEnPalabras,
  sePuedeVerificar,
  tasaEnPalabras,
  tituloDeErrores,
  type EstadoParaLosPasos,
} from "./textos.ts";

const base: EstadoParaLosPasos = {
  unidades: 212,
  conceptos: 4,
  deudaAnterior: null,
  deudas: 0,
  unidadesConDeuda: 0,
  totalDeuda: "0.00",
  saldosAFavor: 0,
  totalAFavor: "0.00",
};
const cargada: EstadoParaLosPasos = {
  ...base,
  deudaAnterior: "cargada",
  deudas: 12,
  unidadesConDeuda: 5,
  totalDeuda: "1250000.00",
  saldosAFavor: 2,
  totalAFavor: "18000.50",
};

describe("los cuatro pasos del tablero", () => {
  it("cada paso dice lo que hay y si está hecho", () => {
    const pasos = pasosDeLaActivacion(cargada);
    expect(pasos.map((p) => p.clave)).toEqual(["padron", "conceptos", "deuda", "activar"]);
    expect(pasos.map((p) => p.hecho)).toEqual([true, true, true, false]);
    expect(pasos[0]?.detalle).toEqual(["212 unidades"]);
    expect(pasos[1]?.detalle).toEqual(["4 conceptos"]);
    expect(pasos[2]?.detalle).toEqual(["12 deudas de 5 unidades por $ 1.250.000,00.", "2 saldos a favor por $ 18.000,50."]);
  });

  it("sin padrón o sin conceptos, el paso queda pendiente y no se puede verificar", () => {
    const pasos = pasosDeLaActivacion({ ...cargada, unidades: 0, conceptos: 0 });
    expect(pasos.slice(0, 2).map((p) => p.hecho)).toEqual([false, false]);
    expect(sePuedeVerificar({ ...cargada, unidades: 0 })).toBe(false);
    expect(sePuedeVerificar({ ...cargada, conceptos: 0 })).toBe(false);
  });

  it("la deuda anterior tiene tres estados: sin resolver, cargada y «no trae»", () => {
    expect(pasosDeLaActivacion(base)[2]?.hecho).toBe(false);
    expect(sePuedeVerificar(base)).toBe(false);
    const sinDeuda = pasosDeLaActivacion({ ...base, deudaAnterior: "sin_deuda" })[2];
    expect(sinDeuda?.hecho).toBe(true);
    expect(sinDeuda?.detalle).toEqual(["El barrio no trae deuda."]);
    expect(sePuedeVerificar({ ...base, deudaAnterior: "sin_deuda" })).toBe(true);
    expect(sePuedeVerificar(cargada)).toBe(true);
  });

  it("una planilla que solo trae saldos a favor no dice «0 deudas»", () => {
    const soloFavor = { ...cargada, deudas: 0, unidadesConDeuda: 0, totalDeuda: "0.00", saldosAFavor: 1, totalAFavor: "18000.00" };
    expect(pasosDeLaActivacion(soloFavor)[2]?.detalle).toEqual(["1 saldo a favor por $ 18.000,00."]);
    expect(listoDeLaDeudaAnterior(soloFavor)).toBe("Listo: la deuda anterior quedó cargada, con 1 saldo a favor por $ 18.000,00.");
  });

  it("los singulares", () => {
    expect(deudasEnPalabras({ deudas: 1, unidadesConDeuda: 1, totalDeuda: "100.00" })).toBe("1 deuda de 1 unidad por $ 100,00");
    expect(saldosAFavorEnPalabras({ saldosAFavor: 1, totalAFavor: "5.00" })).toBe("1 saldo a favor por $ 5,00");
    expect(listoDeLaDeudaAnterior(cargada)).toBe(
      "Listo: la deuda anterior quedó cargada, con 12 deudas de 5 unidades por $ 1.250.000,00 y 2 saldos a favor por $ 18.000,50.",
    );
  });

  it("«Activado el…» solo si el barrio se activó pasando por acá", () => {
    expect(lineaDeActivado({ activadoEl: null, activadoPor: "Ana Ejemplo" })).toBeNull();
    expect(lineaDeActivado({ activadoEl: "2026-11-14", activadoPor: "Ana Ejemplo" })).toBe("Activado el 14/11/2026 por Ana Ejemplo");
    expect(lineaDeActivado({ activadoEl: "2026-11-14 10:22:01.5+00", activadoPor: null })).toBe("Activado el 14/11/2026");
  });
});

describe("la vista previa de la planilla", () => {
  it("una deuda «Entra» y un saldo a favor va «A favor»", () => {
    expect(chipDeRenglon("deuda").texto).toBe("Entra");
    expect(chipDeRenglon("a_favor").texto).toBe("A favor");
  });

  it("un error de la planilla entera no se le atribuye a una fila", () => {
    expect(dondeEstaElError(1)).toBe("La planilla");
    expect(dondeEstaElError(7)).toBe("Fila 7");
    expect(tituloDeErrores(1)).toContain("1 error");
    expect(tituloDeErrores(3)).toContain("3 errores");
  });
});

describe("verificar antes de activar", () => {
  it("la tasa se dice como porcentaje mensual", () => {
    expect(tasaEnPalabras("0.030000")).toBe("3 % mensual");
    expect(tasaEnPalabras("0.035000")).toBe("3,5 % mensual");
    expect(tasaEnPalabras("0.000000")).toBe("0 % mensual (sin interés)");
  });

  it("comparar con el sistema anterior: vacío, coincide o la diferencia, en centavos", () => {
    expect(compararConElSistemaAnterior("1250000.00", "")).toEqual({ estado: "vacio" });
    expect(compararConElSistemaAnterior("1250000.00", "   ")).toEqual({ estado: "vacio" });
    expect(compararConElSistemaAnterior("1250000.00", "1.250.000")).toEqual({ estado: "coincide", texto: "Coincide" });
    expect(compararConElSistemaAnterior("1250000.00", "1250000,00")).toEqual({ estado: "coincide", texto: "Coincide" });
    expect(compararConElSistemaAnterior("1250000.10", "1.250.000,30")).toEqual({
      estado: "difiere",
      texto: "Diferencia de $ 0,20: el sistema tiene menos que el sistema anterior",
    });
    expect(compararConElSistemaAnterior("1250000.00", "1.240.000")).toEqual({
      estado: "difiere",
      texto: "Diferencia de $ 10.000,00: el sistema tiene más que el sistema anterior",
    });
    // Un centavo es una diferencia: no hay redondeo que la esconda.
    expect(compararConElSistemaAnterior("0.01", "0").estado).toBe("difiere");
    expect(compararConElSistemaAnterior("0.00", "0").estado).toBe("coincide");
  });

  it("el diálogo dice lo cargado, el primer mes, la tasa y hasta cuándo se puede volver a subir", () => {
    const lineas = consecuenciasDeActivar({ ...cargada, primerPeriodo: "2026-12", tasa: "0.035000" });
    expect(lineas[0]).toBe("Quedan cargadas 12 deudas de 5 unidades por $ 1.250.000,00 y 2 saldos a favor.");
    expect(lineas[1]).toBe("El primer mes a devengar es diciembre 2026.");
    expect(lineas[2]).toContain("3,5 % mensual");
    expect(lineas[3]).toBe(
      "Hasta que emitas diciembre 2026 podés volver a subir la planilla. Después, la deuda anterior se corrige solo con un ajuste, que queda registrado.",
    );
  });

  it("en un barrio que no trae deuda, el diálogo no habla de deudas ni de tasa", () => {
    const lineas = consecuenciasDeActivar({ ...base, deudaAnterior: "sin_deuda", primerPeriodo: "2026-12", tasa: "0.030000" });
    expect(lineas[0]).toBe("El barrio no trae deuda anterior.");
    expect(lineas.some((l) => l.includes("% mensual"))).toBe(false);
  });
});
