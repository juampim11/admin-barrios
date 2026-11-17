import { describe, expect, it } from "vitest";
import {
  cronogramaDeLasFilas,
  filasCompletas,
  opcionesDeCuotas,
  rangoDeVencimientos,
  repartirLoQueFalta,
  resumenDelCatalogo,
  vencimientoDeLaSiguiente,
  type FilaAMedida,
} from "./armar.ts";

const fila = (clave: string, anticipo: boolean, vencimiento: string, importe: string): FilaAMedida => ({ clave, anticipo, vencimiento, importe });

describe("armar un plan: el catálogo", () => {
  it("las cuotas del plan primero, y las demás aparte (pasan a ser a medida)", () => {
    const o = opcionesDeCuotas({ cuotasMin: 7, cuotasMax: 12 });
    expect(o.slice(0, 6).map((x) => x.valor)).toEqual(["12", "11", "10", "9", "8", "7"]);
    expect(new Set(o.slice(0, 6).map((x) => x.grupo))).toEqual(new Set(["Las del plan"]));
    expect(o).toHaveLength(60);
    expect(o.find((x) => x.valor === "13")?.grupo).toBe("Fuera del plan (pasa a ser a medida)");
  });

  it("el resumen del plan, en una línea", () => {
    expect(
      resumenDelCatalogo({
        id: "x",
        nombre: "12 cuotas al 2 %",
        sistema: "frances",
        tasaMensual: "0.020000",
        tasaPorcentaje: "2",
        cuotasMin: 7,
        cuotasMax: 12,
        anticipo: "opcional",
        anticipoMaxPorcentaje: "30.00",
        deudaMaxima: "1500000.00",
        estudio: null,
        modoCobro: "barrio",
      }),
    ).toBe("7 a 12 cuotas, francés al 2 % mensual, anticipo opcional de hasta el 30 %, para deudas de hasta $ 1.500.000,00.");
  });

  it("el rango de vencimientos no cuenta el anticipo", () => {
    expect(
      rangoDeVencimientos([
        { numero: 0, vencimiento: "2026-11-20" },
        { numero: 1, vencimiento: "2026-12-10" },
        { numero: 12, vencimiento: "2027-11-10" },
      ]),
    ).toBe("Primera cuota: 10/12/2026 · última: 10/11/2027.");
  });
});

describe("armar un plan: el cronograma a medida", () => {
  const filas = [fila("a", true, "2026-11-20", "300000.00"), fila("b", false, "2026-12-10", ""), fila("c", false, "2027-01-10", "")];

  it("el anticipo es la 0 y las cuotas se numeran en orden", () => {
    expect(cronogramaDeLasFilas(filas).map((c) => c.numero)).toEqual([0, 1, 2]);
    expect(filasCompletas(filas)).toEqual([{ numero: 0, vencimiento: "2026-11-20", importe: "300000.00" }]);
  });

  it("repartir lo que falta: deuda menos anticipo en partes iguales, la última ajusta los centavos", () => {
    // El caso de la maqueta: 1.208.610,15 − 300.000 = 908.610,15 en dos cuotas.
    const r = repartirLoQueFalta(filas, "1208610.15");
    expect(r.map((f) => f.importe)).toEqual(["300000.00", "454305.07", "454305.08"]);
    expect(repartirLoQueFalta([fila("a", true, "2026-11-20", "")], "100.00").map((f) => f.importe)).toEqual([""]);
  });

  it("la cuota nueva vence un mes después de la última (o la sugerida, si no hay)", () => {
    expect(vencimientoDeLaSiguiente(filas, "2026-12-10")).toBe("2027-02-10");
    expect(vencimientoDeLaSiguiente([fila("a", true, "2026-11-20", "1.00")], "2026-12-10")).toBe("2026-12-10");
  });
});
