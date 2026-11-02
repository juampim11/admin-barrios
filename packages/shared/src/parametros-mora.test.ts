/**
 * El registro de parámetros de mora y sus conversiones (ADR-0006). La conversión porcentaje ↔ fracción
 * es la única puerta entre lo que tipea una persona y lo que se guarda: si se equivoca, se cobra otra
 * tasa. Por eso además de casos a mano va una propiedad de ida y vuelta.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CLAVES_PARAMETRO,
  fijarParametroSchema,
  fraccionAPorcentaje,
  millonesimasATasa,
  porcentajeAFraccion,
  REGISTRO_PARAMETROS,
  tasaAMillonesimas,
  textoDeValor,
  validarValorParametro,
  valorDesdeFormulario,
} from "./parametros-mora.ts";

describe("el registro", () => {
  it("tiene una definición por clave, en el mismo orden, y cada valor inicial es válido para su clave", () => {
    expect(REGISTRO_PARAMETROS.map((d) => d.clave)).toEqual([...CLAVES_PARAMETRO]);
    for (const d of REGISTRO_PARAMETROS) expect(validarValorParametro(d.clave, d.inicial)).toBeNull();
  });

  it("solo las dos tasas exigen respaldo", () => {
    expect(REGISTRO_PARAMETROS.filter((d) => d.requiereRespaldo).map((d) => d.clave)).toEqual([
      "interes.tasa_compensatoria",
      "interes.tasa_punitoria",
    ]);
  });

  it("ningún texto cita un artículo ni califica a nadie (legal-ph, lenguaje prohibido)", () => {
    const todo = REGISTRO_PARAMETROS.flatMap((d) => [d.nombre, d.ayuda, ...(d.opciones?.map((o) => o.texto) ?? [])]).join(" ");
    expect(todo).not.toMatch(/art\.|artículo|moros|deudor|ejecutab/i);
  });

  it("el orden de imputación tiene dos opciones: «estricto por antigüedad» ya no existe", () => {
    expect(REGISTRO_PARAMETROS.find((d) => d.clave === "imputacion.orden")?.opciones?.map((o) => o.valor)).toEqual([
      "intereses_primero_capital_antiguo",
      "capital_primero",
    ]);
    expect(validarValorParametro("imputacion.orden", "fifo_estricto")).not.toBeNull();
  });
});

describe("tasas: porcentaje en la pantalla, fracción en la base", () => {
  it("casos a mano", () => {
    expect(porcentajeAFraccion("2,5")).toBe("0.025");
    expect(porcentajeAFraccion("3")).toBe("0.03");
    expect(porcentajeAFraccion("3,2 %")).toBe("0.032");
    expect(porcentajeAFraccion("0")).toBe("0");
    expect(porcentajeAFraccion("100")).toBe("1");
    expect(porcentajeAFraccion("0,0001")).toBe("0.000001");
    expect(fraccionAPorcentaje("0.025")).toBe("2.5");
    expect(textoDeValor("interes.tasa_compensatoria", "0.032")).toBe("3,2 %");
  });

  it("rechaza lo que no es un porcentaje entre 0 y 100 con hasta cuatro decimales", () => {
    for (const malo of ["", "abc", "-1", "100,01", "2,55555", "1e2", "2.5.1"]) expect(porcentajeAFraccion(malo)).toBeNull();
  });

  it("ida y vuelta exacta para cualquier tasa de la base", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), (m) => {
        const fraccion = millonesimasATasa(m);
        expect(tasaAMillonesimas(fraccion)).toBe(m);
        expect(porcentajeAFraccion(fraccionAPorcentaje(fraccion))).toBe(fraccion);
      }),
      { numRuns: 500 },
    );
  });
});

describe("lo que llega del formulario", () => {
  it("convierte cada tipo a la forma de la base", () => {
    expect(valorDesdeFormulario("interes.cobra", "si")).toEqual({ valor: true });
    expect(valorDesdeFormulario("interes.gracia_dias", "5")).toEqual({ valor: 5 });
    expect(valorDesdeFormulario("interes.tolerancia", "1.000,5")).toEqual({ valor: "1000.50" });
    expect(valorDesdeFormulario("interes.tolerancia", "100")).toEqual({ valor: "100.00" });
    expect(valorDesdeFormulario("interes.forma_gracia", "escalon")).toEqual({ valor: "escalon" });
    expect("error" in valorDesdeFormulario("interes.gracia_dias", "-1")).toBe(true);
    expect("error" in valorDesdeFormulario("interes.forma_gracia", "otra")).toBe(true);
  });

  const base = {
    nodoId: "11111111-2222-4333-8444-555555555555",
    rigeDesde: "2026-12-01",
    motivo: "Lo votó la asamblea de septiembre",
  };

  it("una tasa sin respaldo cae en los campos del respaldo, no en un cartel", () => {
    const r = fijarParametroSchema.safeParse({ ...base, clave: "interes.tasa_compensatoria", valor: "2,5" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const campos = r.error.issues.map((i) => i.path.join("."));
      expect(campos).toContain("respaldoTipo");
      expect(campos).toContain("respaldoReferencia");
    }
  });

  it("con respaldo, la tasa llega convertida a fracción", () => {
    const r = fijarParametroSchema.parse({
      ...base,
      clave: "interes.tasa_compensatoria",
      valor: "2,5",
      respaldoTipo: "reglamento",
      respaldoReferencia: "Reglamento, art. 12",
      respaldoAdjunto: "",
    });
    expect(r.valor).toBe("0.025");
    expect(r.respaldoAdjunto).toBeNull();
    expect(r.confirmarActivarInteres).toBe(false);
  });

  it("el motivo de menos de 15 caracteres cae en su campo", () => {
    const r = fijarParametroSchema.safeParse({ ...base, motivo: "corto", clave: "interes.gracia_dias", valor: "3" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join("."))).toContain("motivo");
  });
});
