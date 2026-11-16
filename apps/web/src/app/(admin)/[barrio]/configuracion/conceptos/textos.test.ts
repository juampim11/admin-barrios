/**
 * Los textos de «Conceptos del barrio» (encargo 16b). Lo que se fija: que un concepto sin valor lo
 * diga, que el porcentaje se lea como lo escribe una persona, que la bonificación de la regla siga a
 * «Cómo se devenga», y que lo que se dice de un gasto dependa de dónde sale el importe del mes.
 */

import { describe, expect, it } from "vitest";
import { aQuienVa, cadaMes, comoSeCalcula, comoSeReparteElGasto, porcentajeLegible, resumenDeUnidades, type ConceptoParaTexto } from "./textos.ts";

const base: ConceptoParaTexto = {
  clase: "cargo",
  metodo: "monto_fijo",
  destinatario: "una_unidad",
  grupoNombre: null,
  grupoUnidades: null,
  modoMes: "mano",
  unidadUso: null,
  deLaRegla: false,
  valorVigente: { montoFijo: "15000.00", porcentaje: null, precioUnitario: null, tope: null },
};
const valor = (v: Partial<NonNullable<ConceptoParaTexto["valorVigente"]>>) => ({ montoFijo: null, porcentaje: null, precioUnitario: null, tope: null, ...v });

describe("cómo se calcula", () => {
  it("un importe fijo es por unidad", () => {
    expect(comoSeCalcula(base, "expensa")).toBe("$ 15.000,00 por unidad");
  });

  it("lo que se cobra por uso dice su unidad, o «uso» si no la tiene", () => {
    const porUso: ConceptoParaTexto = { ...base, metodo: "precio_x_cantidad", valorVigente: valor({ precioUnitario: "12000.00" }) };
    expect(comoSeCalcula({ ...porUso, unidadUso: "turno" }, "expensa")).toBe("$ 12.000,00 por turno");
    expect(comoSeCalcula(porUso, "expensa")).toBe("$ 12.000,00 por uso");
  });

  it("un porcentaje nombra lo que el barrio cobra y lleva su tope", () => {
    const c: ConceptoParaTexto = { ...base, clase: "descuento", metodo: "porcentaje", valorVigente: valor({ porcentaje: "7.500000", tope: "20000.00" }) };
    expect(comoSeCalcula(c, "expensa")).toBe("7,5 % de la expensa, hasta $ 20.000,00");
    expect(comoSeCalcula(c, "cuota social")).toBe("7,5 % de la cuota social, hasta $ 20.000,00");
  });

  it("el importe a cargar cada vez no necesita valor", () => {
    expect(comoSeCalcula({ ...base, metodo: "importe_libre", valorVigente: null }, "expensa")).toBe("Importe a cargar cada vez");
  });

  it("sin un valor que rija hoy, lo dice en vez de mostrar un cero", () => {
    expect(comoSeCalcula({ ...base, valorVigente: null }, "expensa")).toBe("Sin valor vigente");
  });
});

describe("el porcentaje, como se lee", () => {
  it.each([
    ["7.500000", "7,5"],
    ["10.000000", "10"],
    ["10", "10"],
    ["0.250000", "0,25"],
  ])("%s → %s", (crudo, legible) => {
    expect(porcentajeLegible(crudo)).toBe(legible);
  });
});

describe("a quién va y cómo entra cada mes", () => {
  it("un grupo se nombra con cuántas unidades tiene", () => {
    const c: ConceptoParaTexto = { ...base, destinatario: "grupo", grupoNombre: "Lotes baldíos", grupoUnidades: 1, modoMes: "sola" };
    expect(aQuienVa(c, "no")).toBe("Grupo: Lotes baldíos (1 unidad)");
    expect(cadaMes(c, "no")).toBe("Sola");
  });

  it("lo que se cobra por uso entra por planilla o a mano", () => {
    const c: ConceptoParaTexto = { ...base, destinatario: "por_uso", modoMes: "planilla_o_mano" };
    expect(aQuienVa(c, "no")).toBe("Quien lo usó");
    expect(cadaMes(c, "no")).toBe("Por planilla o a mano");
  });

  it("la bonificación de la regla sigue lo que dice «Cómo se devenga», no lo cargado en el concepto", () => {
    const regla: ConceptoParaTexto = { ...base, clase: "descuento", deLaRegla: true, destinatario: "todas" };
    expect([aQuienVa(regla, "sola"), cadaMes(regla, "sola")]).toEqual(["Las que están al día", "Sola"]);
    expect([aQuienVa(regla, "a_mano"), cadaMes(regla, "a_mano")]).toEqual(["Una unidad", "A mano"]);
    expect(cadaMes(regla, "no")).toBe("No se aplica");
  });
});

describe("lo que se dice de un gasto no asume un modelo", () => {
  it("la extraordinaria se reparte siempre", () => {
    expect(comoSeReparteElGasto("extraordinaria", "administracion")).toBe("Se reparte por coeficiente dentro del cupón del mes");
    expect(comoSeReparteElGasto("extraordinaria", "gastos")).toBe("Se reparte por coeficiente dentro del cupón del mes");
  });

  it("un gasto de todos los meses se reparte solo si el importe del mes sale de los gastos", () => {
    expect(comoSeReparteElGasto("ordinaria", "gastos")).toContain("Se reparte");
    expect(comoSeReparteElGasto("ordinaria", "administracion")).toContain("No se reparte aparte");
    expect(comoSeReparteElGasto("ordinaria", null)).toBe("Depende de cómo se devenga en este barrio");
  });
});

describe("el resumen de las unidades de un grupo", () => {
  it("muestra las primeras y cuántas más", () => {
    expect(resumenDeUnidades([])).toBe("Todavía sin unidades");
    expect(resumenDeUnidades(["A", "B"])).toBe("A, B");
    expect(resumenDeUnidades(["A", "B", "C", "D", "E", "F"])).toBe("A, B, C, D y 2 más");
  });
});
