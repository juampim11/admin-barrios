/**
 * «Cómo se devenga» (encargo 16): los valores por defecto, lo que llega del formulario y quién recibe
 * la bonificación. Sin base: lo que toca Postgres está en `packages/data/test/encargo-16.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  cambiarComoSeDevengaSchema,
  inicialDeBarrioNuevo,
  modeloDeOrigen,
  porcentajeDeBonificacion,
  porDefecto,
  recibeBonificacion,
} from "./devengado.ts";
import { CLAVES_DE_MORA, REGISTRO_PARAMETROS, validarValorParametro } from "./parametros-mora.ts";

const BARRIO = "11111111-1111-4111-8111-111111111111";
const base = {
  barrioId: BARRIO,
  rigeDesde: "2026-12",
  origen: "administracion",
  reparto: "igual",
  cuponCobra: "solo_mes",
  bonificacionModo: "sola",
  bonificacionForma: "porcentaje",
  bonificacionValor: "7,5 %",
  bonificacionTope: "20.000,00",
  motivo: "Lo resolvió la comisión en noviembre",
};

describe("sin nada cargado, el comportamiento anterior", () => {
  it("el modelo del barrio manda, el cupón cobra el mes más la deuda y la bonificación es a mano", () => {
    expect(porDefecto("fija")).toEqual({
      origen: "administracion",
      reparto: "igual",
      cuponCobra: "mes_mas_deuda",
      bonificacion: { modo: "a_mano", cuanto: null },
    });
    expect(porDefecto("variable")).toMatchObject({ origen: "gastos", reparto: "coeficiente", cuponCobra: "mes_mas_deuda" });
  });

  it("un barrio nuevo nace con su modelo y con el cupón que cobra solo el mes", () => {
    expect(inicialDeBarrioNuevo("fija")).toEqual({ origen: "administracion", reparto: "igual", cuponCobra: "solo_mes" });
    expect(inicialDeBarrioNuevo("variable")).toEqual({ origen: "gastos", reparto: "coeficiente", cuponCobra: "solo_mes" });
  });

  it("el origen decide el modelo del mes", () => {
    expect([modeloDeOrigen("administracion"), modeloDeOrigen("gastos")]).toEqual(["fija", "variable"]);
  });
});

describe("el registro de parámetros", () => {
  it("las siete claves son del barrio, sin valor inicial, y no aparecen entre las de mora", () => {
    const delBarrio = REGISTRO_PARAMETROS.filter((d) => d.soloBarrio);
    expect(delBarrio.map((d) => d.clave)).toEqual([
      "devengado.origen",
      "devengado.reparto",
      "cupon.cobra",
      "bonificacion.modo",
      "bonificacion.forma",
      "bonificacion.valor",
      "bonificacion.tope",
    ]);
    expect(delBarrio.every((d) => d.inicial === null && !d.requiereRespaldo)).toBe(true);
    expect(CLAVES_DE_MORA).toHaveLength(7);
    expect(CLAVES_DE_MORA.some((c) => c.startsWith("devengado") || c.startsWith("cupon") || c.startsWith("bonificacion"))).toBe(false);
  });

  it("valida cada valor como la base", () => {
    expect(validarValorParametro("devengado.origen", "administracion")).toBeNull();
    expect(validarValorParametro("devengado.origen", "designado")).not.toBeNull();
    expect(validarValorParametro("cupon.cobra", "solo_mes")).toBeNull();
    expect(validarValorParametro("bonificacion.valor", "7.5")).toBeNull();
    expect(validarValorParametro("bonificacion.valor", "0")).not.toBeNull();
    expect(validarValorParametro("bonificacion.valor", "-1")).not.toBeNull();
    expect(validarValorParametro("bonificacion.tope", "20000.00")).toBeNull();
    expect(validarValorParametro("bonificacion.tope", "0.00")).not.toBeNull();
  });
});

describe("lo que llega del formulario", () => {
  it("el porcentaje se lee como lo tipea una persona", () => {
    expect(porcentajeDeBonificacion("7,5")).toBe("7.5");
    expect(porcentajeDeBonificacion("7.50 %")).toBe("7.5");
    expect(porcentajeDeBonificacion("10")).toBe("10");
    expect(porcentajeDeBonificacion("100")).toBe("100");
    expect(porcentajeDeBonificacion("0,01")).toBe("0.01");
    // El piso es el de la base (0,01 %): un 0,005 rebotaría recién al guardar el concepto.
    for (const malo of ["0", "0,005", "100,01", "-5", "siete", "", "7,55555"]) expect(porcentajeDeBonificacion(malo)).toBeNull();
  });

  it("con porcentaje sale el valor y su tope; con importe, el importe y sin tope", () => {
    expect(cambiarComoSeDevengaSchema.parse(base).cuanto).toEqual({ forma: "porcentaje", valor: "7.5", tope: "20000.00" });
    expect(
      cambiarComoSeDevengaSchema.parse({ ...base, bonificacionForma: "importe", bonificacionValor: "15.000", bonificacionTope: "" }).cuanto,
    ).toEqual({ forma: "importe", valor: "15000.00", tope: null });
    // El importe canónico (punto decimal) no se lee como miles.
    expect(
      cambiarComoSeDevengaSchema.parse({ ...base, bonificacionForma: "importe", bonificacionValor: "15000.00", bonificacionTope: "" }).cuanto,
    ).toEqual({ forma: "importe", valor: "15000.00", tope: null });
    expect(cambiarComoSeDevengaSchema.parse({ ...base, bonificacionTope: "20000.00" }).cuanto?.tope).toBe("20000.00");
  });

  it("un porcentaje sin tope no pasa, y la que se aplica sola sin valor tampoco", () => {
    const sinTope = cambiarComoSeDevengaSchema.safeParse({ ...base, bonificacionTope: "" });
    expect(sinTope.success).toBe(false);
    expect(sinTope.error?.issues[0]?.path).toEqual(["bonificacionTope"]);
    const sinValor = cambiarComoSeDevengaSchema.safeParse({ ...base, bonificacionValor: "" });
    expect(sinValor.error?.issues[0]?.path).toEqual(["bonificacionValor"]);
    const enCero = cambiarComoSeDevengaSchema.safeParse({ ...base, bonificacionForma: "importe", bonificacionValor: "0" });
    expect(enCero.success).toBe(false);
  });

  it("«no bonifica» descarta el cuánto; «a mano» lo deja opcional", () => {
    expect(cambiarComoSeDevengaSchema.parse({ ...base, bonificacionModo: "no" }).cuanto).toBeNull();
    expect(
      cambiarComoSeDevengaSchema.parse({ ...base, bonificacionModo: "a_mano", bonificacionForma: "", bonificacionValor: "", bonificacionTope: "" }).cuanto,
    ).toBeNull();
    expect(cambiarComoSeDevengaSchema.parse({ ...base, bonificacionModo: "a_mano" }).cuanto).toMatchObject({ forma: "porcentaje", valor: "7.5" });
  });

  it("el motivo es obligatorio y el mes tiene forma de mes", () => {
    expect(cambiarComoSeDevengaSchema.safeParse({ ...base, motivo: "corto" }).success).toBe(false);
    expect(cambiarComoSeDevengaSchema.safeParse({ ...base, rigeDesde: "2026-12-01" }).success).toBe(false);
  });
});

describe("quién recibe la bonificación", () => {
  it("la regla es estar al día, y la excepción manda sobre la regla en los dos sentidos", () => {
    expect(recibeBonificacion({ alDia: true, excepcion: null })).toBe(true);
    expect(recibeBonificacion({ alDia: false, excepcion: null })).toBe(false);
    expect(recibeBonificacion({ alDia: false, excepcion: "dar" })).toBe(true);
    expect(recibeBonificacion({ alDia: true, excepcion: "quitar" })).toBe(false);
  });
});
