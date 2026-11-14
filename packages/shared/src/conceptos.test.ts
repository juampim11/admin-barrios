/**
 * «Conceptos del barrio» (encargo 16b): la lectura de la planilla de usos, los textos y las reglas de
 * «a quién va y cómo entra». Sin base: lo que toca Postgres está en `packages/data/test/encargo-16b.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  aplicarPlanillaDeUsosSchema,
  detalleDeUsos,
  leerFechaDePlanilla,
  leerPlanillaUsos,
  MAX_FILAS_USOS,
  plantillaDeUsos,
  revisarComoEntraElConcepto,
  textoDeUsos,
} from "./conceptos.ts";
import { crearConceptoBoletaSchema } from "./escrituras.ts";

const ENCABEZADO = ["manzana", "lote", "concepto", "fecha", "cantidad"];

describe("la planilla de usos", () => {
  it("lee una fila por uso, con la fecha y la cantidad normalizadas", () => {
    const { usos, errores } = leerPlanillaUsos([
      ENCABEZADO,
      ["1", "4", "Cancha de pádel", "08/11/2026", "1"],
      [" 2 ", "15", "Uso del club house", "2026-11-22", "1,5"],
      ["3", "A", "Cancha de pádel", "3/1/26", "2.0"],
    ]);
    expect(errores).toEqual([]);
    expect(usos).toEqual([
      { fila: 2, manzana: "1", lote: "4", concepto: "Cancha de pádel", fecha: "2026-11-08", cantidad: "1" },
      { fila: 3, manzana: "2", lote: "15", concepto: "Uso del club house", fecha: "2026-11-22", cantidad: "1.5" },
      { fila: 4, manzana: "3", lote: "A", concepto: "Cancha de pádel", fecha: "2026-01-03", cantidad: "2" },
    ]);
  });

  it("el encabezado no distingue mayúsculas, acentos ni orden de columnas", () => {
    const { usos, errores } = leerPlanillaUsos([
      ["Cantidad", "FECHA", "Concepto", "Lote", "Manzana", "observaciones"],
      ["2", "01/12/2026", "Pádel", "7", "1", "no se lee"],
    ]);
    expect(errores).toEqual([]);
    expect(usos).toEqual([{ fila: 2, manzana: "1", lote: "7", concepto: "Pádel", fecha: "2026-12-01", cantidad: "2" }]);
  });

  it("sin las columnas no lee nada y dice cuáles faltan", () => {
    expect(leerPlanillaUsos([["unidad", "concepto", "fecha"], ["1", "x", "y"]])).toEqual({
      usos: [],
      errores: [{ fila: 1, mensaje: "La planilla necesita las columnas manzana, lote, concepto, fecha y cantidad. Faltan: manzana, lote, cantidad." }],
    });
    expect(leerPlanillaUsos([]).errores[0]?.fila).toBe(1);
    expect(leerPlanillaUsos([ENCABEZADO, ["", "", "", "", ""]]).errores).toEqual([{ fila: 1, mensaje: "La planilla no tiene filas." }]);
  });

  it("los errores van por fila, con el número de fila de la planilla, y las filas vacías no cuentan", () => {
    const { usos, errores } = leerPlanillaUsos([
      ENCABEZADO,
      ["1", "", "Pádel", "01/12/2026", "1"],
      ["", "", "", "", ""],
      ["1", "1", "", "01/12/2026", "1"],
      ["1", "1", "Pádel", "31/02/2026", "1"],
      ["1", "1", "Pádel", "ayer", "1"],
      ["1", "1", "Pádel", "01/12/2026", "0"],
      ["1", "1", "Pádel", "01/12/2026", "-2"],
      ["1", "1", "Pádel", "01/12/2026", "1,2345"],
      ["1", "1", "Pádel", "01/12/2026", "dos"],
      ["1", "1", "Pádel", "01/12/2026", "1"],
    ]);
    expect(usos).toHaveLength(1);
    expect(usos[0]?.fila).toBe(11);
    expect(errores.map((e) => e.fila)).toEqual([2, 4, 5, 6, 7, 8, 9, 10]);
    expect(errores[0]?.mensaje).toBe("Falta la manzana o el lote.");
    expect(errores[1]?.mensaje).toBe("Falta el concepto.");
    expect(errores[2]?.mensaje).toBe("La fecha «31/02/2026» no existe o no se entiende: escribila como dd/mm/aaaa.");
    expect(errores[4]?.mensaje).toBe("La cantidad tiene que ser un número mayor que cero (hasta tres decimales).");
  });

  it("la fecha tiene que existir: no pasa un 31 de febrero, un 29/02 de un año común ni un mes 13", () => {
    expect(leerFechaDePlanilla("29/02/2024")).toBe("2024-02-29");
    expect(leerFechaDePlanilla("2026-11-08T00:00:00.000Z")).toBe("2026-11-08");
    for (const mala of ["29/02/2025", "31/04/2026", "00/01/2026", "15/13/2026", "2026-02-30", "32/01/2026", "", "1/1/1999", "=HOY()", "2026-11-081"]) {
      expect(leerFechaDePlanilla(mala)).toBeNull();
    }
  });

  it("una entrada de terceros: celdas larguísimas, fórmulas y planillas enormes no pasan", () => {
    const larga = "x".repeat(300);
    expect(leerPlanillaUsos([ENCABEZADO, [larga, "1", "Pádel", "01/12/2026", "1"]]).errores[0]?.mensaje).toBe("La manzana o el lote son demasiado largos.");
    expect(leerPlanillaUsos([ENCABEZADO, ["1", "1", larga, "01/12/2026", "1"]]).errores[0]?.mensaje).toBe("El nombre del concepto es demasiado largo.");
    expect(leerPlanillaUsos([ENCABEZADO, ["1", "1", "Pádel", "01/12/2026", "=1+1"]]).errores).toHaveLength(1);
    // «1.000» no se adivina (¿mil o uno?): es un error, no un uso.
    expect(leerPlanillaUsos([ENCABEZADO, ["1", "1", "Pádel", "01/12/2026", "1.000"]]).errores).toHaveLength(1);
    const enorme = [ENCABEZADO, ...Array.from({ length: MAX_FILAS_USOS + 1 }, () => ["1", "1", "Pádel", "01/12/2026", "1"])];
    expect(leerPlanillaUsos(enorme)).toEqual({ usos: [], errores: [{ fila: 1, mensaje: `La planilla tiene más de ${MAX_FILAS_USOS} filas: partila en varias.` }] });
    // El esquema de la acción tampoco acepta más filas ni celdas que no sean texto.
    expect(aplicarPlanillaDeUsosSchema.safeParse({ periodoId: "11111111-1111-4111-8111-111111111111", archivo: "a.xlsx", filas: enorme }).success).toBe(true);
    expect(aplicarPlanillaDeUsosSchema.safeParse({ periodoId: "11111111-1111-4111-8111-111111111111", archivo: "a.xlsx", filas: enorme.concat(enorme) }).success).toBe(false);
    expect(aplicarPlanillaDeUsosSchema.safeParse({ periodoId: "11111111-1111-4111-8111-111111111111", archivo: "a.xlsx", filas: [[1, 2] as never] }).success).toBe(false);
    expect(aplicarPlanillaDeUsosSchema.parse({ periodoId: "11111111-1111-4111-8111-111111111111", archivo: "a.xlsx", filas: [ENCABEZADO] }).confirmarMontoInusual).toBe(false);
  });

  it("la planilla modelo se lee sin errores", () => {
    expect(leerPlanillaUsos(plantillaDeUsos()).errores).toEqual([]);
  });
});

describe("el detalle de los usos en la boleta", () => {
  it("las fechas y el total: «03/11, 17/11 · 2 turnos»", () => {
    expect(detalleDeUsos([{ fecha: "2026-11-17" }, { fecha: "2026-11-03" }], "2", "turno")).toBe("03/11, 17/11 · 2 turnos");
    expect(detalleDeUsos([{ fecha: "2026-11-08" }], "1", "jornada")).toBe("08/11 · 1 jornada");
    expect(detalleDeUsos([{ fecha: "2026-11-08" }, { fecha: "2026-11-08" }], "3", null)).toBe("08/11 · 3 usos");
    expect(detalleDeUsos([], "1", null)).toBe("1 uso");
  });

  it("con muchos usos no desborda el renglón", () => {
    const usos = Array.from({ length: 9 }, (_, i) => ({ fecha: `2026-11-${String(i + 1).padStart(2, "0")}` }));
    expect(detalleDeUsos(usos, "9", "turno")).toBe("01/11, 02/11, 03/11, 04/11, 05/11, 06/11… · 9 turnos");
  });

  it("el singular y el plural, con decimales", () => {
    expect([textoDeUsos("1", "turno"), textoDeUsos("1.000", "turno"), textoDeUsos("2", "jornada"), textoDeUsos("1.5", null)]).toEqual([
      "1 turno",
      "1 turno",
      "2 jornadas",
      "1,5 usos",
    ]);
  });
});

describe("a quién va y cómo entra cada mes", () => {
  const base = { clase: "cargo", metodo: "monto_fijo", destinatario: "una_unidad", grupoId: null, modoMes: "mano", unidadUso: null } as const;

  it("lo de siempre (una unidad, a mano) no tiene nada que revisar", () => {
    expect(revisarComoEntraElConcepto(base)).toEqual([]);
  });

  it("«sola» va a todas o a un grupo, con un importe que no depende de usos ni de un importe a mano", () => {
    expect(revisarComoEntraElConcepto({ ...base, destinatario: "todas", modoMes: "sola" })).toEqual([]);
    expect(revisarComoEntraElConcepto({ ...base, modoMes: "sola" }).map((p) => p.campo)).toEqual(["modoMes"]);
    expect(revisarComoEntraElConcepto({ ...base, destinatario: "todas", modoMes: "sola", metodo: "precio_x_cantidad" }).map((p) => p.campo)).toEqual(["modoMes"]);
    expect(revisarComoEntraElConcepto({ ...base, destinatario: "todas", modoMes: "sola", metodo: "importe_libre" }).map((p) => p.campo)).toEqual(["modoMes"]);
  });

  it("el grupo va si y solo si el concepto es para un grupo; la planilla, solo por uso", () => {
    expect(revisarComoEntraElConcepto({ ...base, destinatario: "grupo" }).map((p) => p.campo)).toEqual(["grupoId"]);
    expect(revisarComoEntraElConcepto({ ...base, grupoId: "g" }).map((p) => p.campo)).toEqual(["grupoId"]);
    expect(revisarComoEntraElConcepto({ ...base, modoMes: "planilla_o_mano" }).map((p) => p.campo)).toEqual(["modoMes"]);
    expect(revisarComoEntraElConcepto({ ...base, unidadUso: "turno" }).map((p) => p.campo)).toEqual(["unidadUso"]);
    expect(revisarComoEntraElConcepto({ ...base, metodo: "precio_x_cantidad", destinatario: "por_uso", modoMes: "planilla_o_mano", unidadUso: "turno" })).toEqual([]);
  });

  it("el alta de un concepto de importe libre no lleva ningún valor, y es de un cargo", () => {
    const alta = {
      barrioId: "11111111-1111-4111-8111-111111111111", nombre: "Multa", clase: "cargo", metodo: "importe_libre", baseCalculo: "sin_base",
      clasificacionFiscal: "sin_clasificar", financiamiento: null, vigenteDesde: "2026-11-01", montoFijo: "", porcentaje: "", precioUnitario: "", tope: "",
    };
    const leido = crearConceptoBoletaSchema.parse(alta);
    expect(leido).toMatchObject({ metodo: "importe_libre", montoFijo: null, destinatario: "una_unidad", grupoId: null, modoMes: "mano", unidadUso: null });
    expect(crearConceptoBoletaSchema.safeParse({ ...alta, montoFijo: "100.00" }).success).toBe(false);
    expect(crearConceptoBoletaSchema.safeParse({ ...alta, clase: "descuento", financiamiento: "absorbe_barrio" }).success).toBe(false);
  });
});
