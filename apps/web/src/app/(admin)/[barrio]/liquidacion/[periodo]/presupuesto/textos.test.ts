import { describe, expect, it } from "vitest";
import {
  cuentaDelImporte,
  descripcionDelImporte,
  elMes,
  enElMesAnterior,
  importePrecargado,
  rotuloDelImporte,
  totalesDelPresupuesto,
} from "./textos.ts";

describe("los textos del presupuesto del mes", () => {
  it("el mes se dice solo, en minúscula", () => {
    expect(elMes("2026-11")).toBe("noviembre");
    expect(elMes("2027-01")).toBe("enero");
  });

  it("suma los rubros con importe y el margen, en centavos; un campo vacío no suma", () => {
    expect(totalesDelPresupuesto(["5400000.00", "1350000.00", "", "0.10", "0.20"], "600000.00")).toEqual({
      gastoEsperado: "6750000.30",
      totalAPedir: "7350000.30",
    });
    expect(totalesDelPresupuesto([], "")).toEqual({ gastoEsperado: "0.00", totalAPedir: "0.00" });
  });

  it("el rótulo del importe sale de cómo llama el barrio a lo que cobra, o es el total del mes", () => {
    expect(rotuloDelImporte("por_unidad", "Cuota social")).toBe("Cuota social por unidad");
    expect(rotuloDelImporte("total_del_mes", "Expensa")).toBe("Total del mes");
  });

  it("por unidad: la cuenta y si cubre, sobra o falta", () => {
    expect(cuentaDelImporte({ modo: "por_unidad", unidades: 45, importe: "200000.00", totalAPedir: "9000000.00" })).toEqual({
      cuenta: "45 unidades × $ 200.000,00 = $ 9.000.000,00",
      cubre: true,
      lectura: "Cubre el presupuesto.",
    });
    expect(cuentaDelImporte({ modo: "por_unidad", unidades: 45, importe: "210000.00", totalAPedir: "9000000.00" })?.lectura).toBe(
      "Cubre el presupuesto y sobran $ 450.000,00.",
    );
    expect(cuentaDelImporte({ modo: "por_unidad", unidades: 45, importe: "195000.00", totalAPedir: "9000000.00" })).toEqual({
      cuenta: "45 unidades × $ 195.000,00 = $ 8.775.000,00",
      cubre: false,
      lectura: "No cubre el presupuesto: faltan $ 225.000,00.",
    });
    expect(cuentaDelImporte({ modo: "por_unidad", unidades: 1, importe: "10.00", totalAPedir: "10.00" })?.cuenta).toBe(
      "1 unidad × $ 10,00 = $ 10,00",
    );
  });

  it("por coeficiente: el total del mes, sin multiplicar", () => {
    expect(cuentaDelImporte({ modo: "total_del_mes", unidades: 45, importe: "8999999.99", totalAPedir: "9000000.00" })).toEqual({
      cuenta: "$ 8.999.999,99 en total, repartido por coeficiente entre 45 unidades",
      cubre: false,
      lectura: "No cubre el presupuesto: faltan $ 0,01.",
    });
  });

  it("sin un importe escrito no hay cuenta", () => {
    expect(cuentaDelImporte({ modo: "por_unidad", unidades: 45, importe: "", totalAPedir: "9000000.00" })).toBeNull();
  });

  it("el mes anterior, si tuvo importe", () => {
    expect(enElMesAnterior("por_unidad", "2026-11", "195000.00")).toBe("En noviembre fue $ 195.000,00 por unidad.");
    expect(enElMesAnterior("total_del_mes", "2026-11", "9000000.00")).toBe("En noviembre fue $ 9.000.000,00 en total.");
    expect(enElMesAnterior("por_unidad", "2026-11", null)).toBeNull();
  });

  it("la descripción por omisión y el importe con el que arranca el campo", () => {
    expect(descripcionDelImporte("2026-12")).toBe("Presupuesto de diciembre 2026");
    expect(importePrecargado({ vigente: "200000.00", queCubre: "199000.00" })).toBe("200000.00");
    expect(importePrecargado({ vigente: null, queCubre: "199000.00" })).toBe("199000.00");
    expect(importePrecargado({ vigente: null, queCubre: null })).toBe("");
  });
});
