/**
 * Formato de impresión. Es el test que atrapa el bug de dinero más caro y más invisible: un total
 * que en pantalla dice `359.000,00` y en el PDF dice `359,000.00` porque el runtime no traía ICU
 * completo (doc 07 §A). Nada de esto pasa por `Intl`, así que el formato no depende del entorno.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatearDecimal, formatearMonto } from "./dinero.ts";
import { formatearFecha, formatearPeriodo } from "./fechas.ts";

describe("formatearMonto", () => {
  it("usa punto de miles y coma decimal (es-AR)", () => {
    expect(formatearMonto("359000.00")).toBe("359.000,00");
    expect(formatearMonto("18900000.00")).toBe("18.900.000,00");
    expect(formatearMonto("999.99")).toBe("999,99");
    expect(formatearMonto("1000.05")).toBe("1.000,05");
    expect(formatearMonto("0.00")).toBe("0,00");
  });

  it("mantiene el signo del descuento, con guion ASCII (un glifo faltante se imprime como nada)", () => {
    expect(formatearMonto("-34000.00")).toBe("-34.000,00");
    expect(formatearMonto("-0.01")).toBe("-0,01");
  });

  it("normaliza el cero negativo: un menos delante de un cero se lee como un error", () => {
    expect(formatearMonto("-0.00")).toBe("0,00");
  });

  it("no pasa por `Intl`: se verifica sobre la implementación, no sobre la salida", () => {
    // Setear `LANG` no prueba nada — `Intl.NumberFormat("es-AR")` lleva la locale en la llamada, así
    // que una implementación basada en `Intl` daría el mismo resultado en esta máquina y otro
    // distinto en una imagen sin ICU completo. Lo único que se puede afirmar desde acá es que el
    // módulo **no la usa**, que es la propiedad que evita el bug (doc 07 §A).
    const fuente = readFileSync(new URL("./dinero.ts", import.meta.url), "utf8");
    expect(fuente).not.toMatch(/Intl/);
    expect(readFileSync(new URL("./fechas.ts", import.meta.url), "utf8")).not.toMatch(/Intl|new Date/);
  });

  it("rechaza lo que no es un monto exacto de 2 decimales", () => {
    expect(() => formatearMonto("359000")).toThrow();
    expect(() => formatearMonto("359000.1")).toThrow();
    expect(() => formatearMonto("1e5")).toThrow();
  });
});

describe("formatearDecimal", () => {
  it("redondea a la cantidad de decimales pedida", () => {
    expect(formatearDecimal("1.907400000", 4)).toBe("1,9074");
    expect(formatearDecimal("1.90745", 4)).toBe("1,9075");
    expect(formatearDecimal("1.90744", 4)).toBe("1,9074");
    expect(formatearDecimal("0.03", 4)).toBe("0,0300");
    expect(formatearDecimal("3", 4)).toBe("3,0000");
  });

  it("agrupa los miles y admite cero decimales", () => {
    expect(formatearDecimal("18900000", 0)).toBe("18.900.000");
  });

  it("rechaza lo que no es un decimal", () => {
    expect(() => formatearDecimal("uno", 2)).toThrow();
    expect(() => formatearDecimal("1.0", -1)).toThrow();
  });
});

describe("fechas", () => {
  it("imprime dd/mm/aaaa sin pasar por Date (que en UTC devolvería el día anterior)", () => {
    expect(formatearFecha("2026-08-10")).toBe("10/08/2026");
    expect(formatearFecha("2026-01-01")).toBe("01/01/2026");
  });

  it("imprime el período como mm/aaaa", () => {
    expect(formatearPeriodo("2026-07")).toBe("07/2026");
  });

  it("rechaza fechas mal formadas", () => {
    expect(() => formatearFecha("10/08/2026")).toThrow();
    expect(() => formatearFecha("2026-13-01")).toThrow();
    expect(() => formatearPeriodo("2026-13")).toThrow();
  });
});
