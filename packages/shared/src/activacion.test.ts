/**
 * La planilla de deuda anterior y los esquemas de la activación (encargo 17). Sin base: lo que toca
 * Postgres está en `packages/data/test/encargo-17.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  activarBarrioSchema,
  cargarDeudaAnteriorSchema,
  leerImporteDePlanilla,
  leerMesDePlanilla,
  leerPlanillaDeDeuda,
  MAX_FILAS_DEUDA,
  plantillaDeDeuda,
  porcentajeDeTasa,
  tasaDePorcentaje,
} from "./activacion.ts";

const ENCABEZADO = ["manzana", "lote", "mes", "concepto", "vencimiento", "importe"];
const ID = "11111111-1111-4111-8111-111111111111";

describe("la planilla de deuda", () => {
  it("lee una deuda por renglón, y un renglón negativo sin mes como saldo a favor", () => {
    const { deudas, aFavor, errores } = leerPlanillaDeDeuda([
      ENCABEZADO,
      ["1", "7", "08/2026", "Expensa", "10/08/2026", "125000"],
      [" 1 ", "7", "10/2026", "Expensa", "2026-10-10", "62.500,50"],
      ["2", "3", "", "", "", "-18000"],
    ]);
    expect(errores).toEqual([]);
    expect(deudas).toEqual([
      { fila: 2, manzana: "1", lote: "7", periodo: "2026-08", concepto: "Expensa", vencimiento: "2026-08-10", importe: "125000.00" },
      { fila: 3, manzana: "1", lote: "7", periodo: "2026-10", concepto: "Expensa", vencimiento: "2026-10-10", importe: "62500.50" },
    ]);
    expect(aFavor).toEqual([{ fila: 4, manzana: "2", lote: "3", importe: "18000.00" }]);
  });

  it("el encabezado no distingue mayúsculas, acentos ni orden, y acepta «importe que falta pagar»", () => {
    const { deudas, errores } = leerPlanillaDeDeuda([
      ["Importe que falta pagar", "VENCIMIENTO", "Concepto", "Mes", "Lote", "Manzana", "observaciones"],
      ["1500,5", "05/09/2026", "Obra de cloacas", "9/2026", "A", "3", "no se lee"],
    ]);
    expect(errores).toEqual([]);
    expect(deudas).toEqual([
      { fila: 2, manzana: "3", lote: "A", periodo: "2026-09", concepto: "Obra de cloacas", vencimiento: "2026-09-05", importe: "1500.50" },
    ]);
  });

  it("más de una columna de importe no se adivina, y «importe original» no es el importe", () => {
    expect(
      leerPlanillaDeDeuda([
        ["manzana", "lote", "mes", "concepto", "vencimiento", "importe", "importe adeudado"],
        ["1", "1", "08/2026", "Expensa", "10/08/2026", "900", "100"],
      ]).errores,
    ).toEqual([{ fila: 1, mensaje: "La planilla tiene más de una columna de importe: dejá una sola, con lo que falta pagar." }]);
    const { deudas, errores } = leerPlanillaDeDeuda([
      ["manzana", "lote", "mes", "concepto", "vencimiento", "importe original", "importe pagado", "importe adeudado"],
      ["1", "1", "08/2026", "Expensa", "10/08/2026", "900", "800", "100"],
    ]);
    expect(errores).toEqual([]);
    expect(deudas[0]?.importe).toBe("100.00");
  });

  it("un saldo a favor con concepto o vencimiento es una deuda con el signo al revés: no entra", () => {
    const { aFavor, errores } = leerPlanillaDeDeuda([ENCABEZADO, ["1", "1", "", "Expensa", "", "-100"], ["1", "2", "", "", "10/08/2026", "-100"]]);
    expect(aFavor).toEqual([]);
    expect(errores.map((e) => e.fila)).toEqual([2, 3]);
    expect(errores[0]?.mensaje).toBe("Un saldo a favor va sin concepto ni vencimiento. Si es una deuda, escribila en positivo y con su mes.");
  });

  it("sin las columnas no lee nada y dice cuáles faltan", () => {
    expect(leerPlanillaDeDeuda([["unidad", "mes", "importe"], ["1", "08/2026", "10"]]).errores).toEqual([
      { fila: 1, mensaje: "La planilla necesita las columnas manzana, lote, mes, concepto, vencimiento e importe. Faltan: manzana, lote, concepto, vencimiento." },
    ]);
    expect(leerPlanillaDeDeuda([]).errores[0]?.fila).toBe(1);
    expect(leerPlanillaDeDeuda([ENCABEZADO, ["", "", "", "", "", ""]]).errores).toEqual([{ fila: 1, mensaje: "La planilla no tiene filas." }]);
  });

  it("los errores van por fila, con el número de fila del archivo", () => {
    const { deudas, aFavor, errores } = leerPlanillaDeDeuda([
      ENCABEZADO,
      ["1", "", "08/2026", "Expensa", "10/08/2026", "100"], // 2
      ["1", "1", "08/2026", "Expensa", "10/08/2026", "cien"], // 3
      ["1", "1", "08/2026", "Expensa", "10/08/2026", "0"], // 4
      ["1", "1", "", "Expensa", "10/08/2026", "100"], // 5
      ["1", "1", "agosto", "Expensa", "10/08/2026", "100"], // 6
      ["1", "1", "08/2026", "", "10/08/2026", "100"], // 7
      ["1", "1", "08/2026", "Expensa", "31/02/2026", "100"], // 8
      ["1", "1", "08/2026", "Expensa", "10/08/2026", "-100"], // 9: negativo con mes
      ["1", "1", "08/2026", "Expensa", "10/08/2026", "100"], // 10: entra
    ]);
    expect(deudas.map((d) => d.fila)).toEqual([10]);
    expect(aFavor).toEqual([]);
    expect(errores.map((e) => e.fila)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(errores.map((e) => e.mensaje)).toEqual([
      "Falta la manzana o el lote.",
      "El importe «cien» no se entiende: escribilo sin punto de miles (125000 o 125000,50).",
      "El importe es cero: un mes que no debe nada no va en la planilla.",
      "Falta el mes de la deuda (mm/aaaa).",
      "El mes «agosto» no se entiende: escribilo como mm/aaaa.",
      "Falta el concepto.",
      "El vencimiento «31/02/2026» no existe o no se entiende: escribilo como dd/mm/aaaa.",
      "Un importe negativo es un saldo a favor y va sin mes. Si es una deuda, escribila en positivo.",
    ]);
  });

  it("un renglón repetido es un error; el mismo mes con otro vencimiento u otro concepto, no", () => {
    const { deudas, errores } = leerPlanillaDeDeuda([
      ENCABEZADO,
      ["1", "1", "08/2026", "Expensa", "10/08/2026", "100"],
      ["1", "1", "08/2026", "expensa", "10/08/2026", "50"], // repetido (el concepto no distingue mayúsculas)
      ["1", "1", "08/2026", "Extraordinaria", "10/08/2026", "70"],
      ["1", "1", "08/2026", "Expensa", "25/08/2026", "30"],
    ]);
    expect(deudas.map((d) => d.importe)).toEqual(["100.00", "70.00", "30.00"]);
    expect(errores).toEqual([{ fila: 3, mensaje: "Renglón repetido: es la misma unidad, mes, concepto y vencimiento que la fila 2." }]);
  });

  it("una unidad no trae deuda y saldo a favor a la vez, ni dos saldos a favor", () => {
    const { deudas, aFavor, errores } = leerPlanillaDeDeuda([
      ENCABEZADO,
      ["1", "1", "08/2026", "Expensa", "10/08/2026", "100"],
      ["1", "1", "", "", "", "-40"],
      ["2", "2", "", "", "", "-10"],
      ["2", "2", "", "", "", "-5"],
    ]);
    expect(deudas).toHaveLength(1);
    expect(aFavor).toEqual([{ fila: 4, manzana: "2", lote: "2", importe: "10.00" }]);
    expect(errores).toEqual([
      { fila: 3, mensaje: "La unidad trae deuda y saldo a favor: descontá el saldo de lo que debe y dejá un solo dato." },
      { fila: 5, mensaje: "La unidad ya tiene un saldo a favor en la fila 4: sumalos en un solo renglón." },
    ]);
  });

  it("una entrada de terceros: celdas larguísimas, fórmulas y planillas enormes no pasan", () => {
    const larga = "x".repeat(300);
    expect(leerPlanillaDeDeuda([ENCABEZADO, [larga, "1", "08/2026", "Expensa", "10/08/2026", "1"]]).errores[0]?.mensaje).toBe("La manzana o el lote son demasiado largos.");
    expect(leerPlanillaDeDeuda([ENCABEZADO, ["1", "1", "08/2026", larga, "10/08/2026", "1"]]).errores[0]?.mensaje).toBe("El nombre del concepto es demasiado largo.");
    expect(leerPlanillaDeDeuda([ENCABEZADO, ["1", "1", "08/2026", "Expensa", "10/08/2026", "=1+1"]]).errores).toHaveLength(1);
    expect(leerPlanillaDeDeuda([ENCABEZADO, ["1", "1", "08/2026", "Expensa", "=HOY()", "1"]]).errores).toHaveLength(1);
    const enorme = [ENCABEZADO, ...Array.from({ length: MAX_FILAS_DEUDA + 1 }, () => ["1", "1", "08/2026", "Expensa", "10/08/2026", "1"])];
    expect(leerPlanillaDeDeuda(enorme)).toEqual({ deudas: [], aFavor: [], errores: [{ fila: 1, mensaje: `La planilla tiene más de ${MAX_FILAS_DEUDA} filas.` }] });
    // El esquema de la acción tampoco acepta celdas que no sean texto ni una planilla mucho más grande.
    expect(cargarDeudaAnteriorSchema.safeParse({ barrioId: ID, archivo: "a.xlsx", filas: enorme }).success).toBe(true);
    expect(cargarDeudaAnteriorSchema.safeParse({ barrioId: ID, archivo: "a.xlsx", filas: enorme.concat(enorme) }).success).toBe(false);
    expect(cargarDeudaAnteriorSchema.safeParse({ barrioId: ID, archivo: "a.xlsx", filas: [[1, 2] as never] }).success).toBe(false);
    expect(cargarDeudaAnteriorSchema.safeParse({ barrioId: ID, archivo: "", filas: [ENCABEZADO] }).success).toBe(false);
  });

  it("la planilla modelo se lee sin errores", () => {
    const { deudas, aFavor, errores } = leerPlanillaDeDeuda(plantillaDeDeuda());
    expect(errores).toEqual([]);
    expect([deudas.length, aFavor.length]).toEqual([2, 1]);
  });
});

describe("el mes y el importe de la planilla", () => {
  it("el mes: mm/aaaa, m/aaaa o aaaa-mm", () => {
    expect(["08/2026", "8/2026", "2026-08", "2026-08-01", "12-2025"].map(leerMesDePlanilla)).toEqual(["2026-08", "2026-08", "2026-08", "2026-08", "2025-12"]);
    for (const malo of ["", "13/2026", "0/2026", "08/26", "agosto 2026", "2026/08", "08/1999", "=A1"]) expect(leerMesDePlanilla(malo)).toBeNull();
  });

  it("el importe, en centavos y con su signo", () => {
    expect(
      ["125000", "125000,5", "125000.50", "125.000,50", "1.250.000", "$ 1.250.000,05", "-18000", "- $ 40,10", "0,01", "7.5"].map(leerImporteDePlanilla),
    ).toEqual([12500000n, 12500050n, 12500050n, 12500050n, 125000000n, 125000005n, -1800000n, -4010n, 1n, 750n]);
  });

  it("lo que no se puede saber no se adivina", () => {
    // «125.000»: ¿ciento veinticinco mil o ciento veinticinco? Sin coma no se sabe.
    for (const malo of ["125.000", "1.000", "1,2,3", "12.34.56", "1.25,5", "1e5", "ciento", "", "1,234", "1234567890123", "=1+1", "--5"]) {
      expect(leerImporteDePlanilla(malo)).toBeNull();
    }
  });
});

describe("la tasa para la deuda anterior", () => {
  it("un porcentaje mensual pasa a fracción con seis decimales, y vuelve", () => {
    expect(["3", "3,5", "2.75", "0", "100", "0,0001", "6 %"].map(tasaDePorcentaje)).toEqual([
      "0.030000", "0.035000", "0.027500", "0.000000", "1.000000", "0.000001", "0.060000",
    ]);
    expect(["0.030000", "0.035000", "0.027500", "0.000000", "1.000000", "0.000001", "0.03"].map(porcentajeDeTasa)).toEqual([
      "3", "3,5", "2,75", "0", "100", "0,0001", "3",
    ]);
    for (const malo of ["", "-1", "101", "100,5", "3,12345", "tres", "1e2"]) expect(tasaDePorcentaje(malo)).toBeNull();
  });

  it("activar pide la tasa, y el motivo vacío es que no hay motivo", () => {
    expect(activarBarrioSchema.parse({ barrioId: ID, tasa: "3,5", motivo: "  " })).toEqual({ barrioId: ID, tasa: "0.035000", motivo: null });
    expect(activarBarrioSchema.parse({ barrioId: ID, tasa: "6", motivo: "El reglamento anterior" })).toEqual({
      barrioId: ID,
      tasa: "0.060000",
      motivo: "El reglamento anterior",
    });
    expect(activarBarrioSchema.safeParse({ barrioId: ID, tasa: "" }).success).toBe(false);
    const mala = activarBarrioSchema.safeParse({ barrioId: ID, tasa: "150" });
    expect(mala.success).toBe(false);
    expect(mala.success ? null : mala.error.issues[0]?.path).toEqual(["tasa"]);
  });
});
