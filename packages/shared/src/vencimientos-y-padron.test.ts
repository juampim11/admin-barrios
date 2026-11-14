/**
 * Encargo 15, sin base: los esquemas nuevos (vencimientos del barrio, fecha de corte del mes, la
 * figura «Sin entidad constituida», los datos informativos de la unidad) y la planilla del padrón con
 * el número de acción y el residente.
 */

import { describe, expect, it } from "vitest";
import {
  cambiarVencimientosSchema,
  crearPeriodoSchema,
  editarUnidadSchema,
  vencimientosDelBarrioSchema,
} from "./escrituras.ts";
import { FIGURAS_JURIDICAS, sugerirDenominacionConcepto } from "./barrio.ts";
import {
  columnasDelPadron,
  COLUMNAS_PADRON,
  filasDePlantilla,
  filasParaExportar,
  leerPlanillaPadron,
  planDePadron,
  type UnidadExistente,
} from "./padron.ts";

const ID = "00000000-0000-4000-8000-000000000001";

describe("los vencimientos del barrio", () => {
  it("vacío es «no usa»; los rangos son los de la base", () => {
    expect(vencimientosDelBarrioSchema.parse({ barrioId: ID, diaVencimiento: "10", diasSegundoVencimiento: "", diasCorte: "" })).toEqual({
      barrioId: ID,
      diaVencimiento: 10,
      diasSegundoVencimiento: null,
      diasCorte: null,
    });
    expect(vencimientosDelBarrioSchema.parse({ barrioId: ID, diaVencimiento: 10, diasSegundoVencimiento: "15", diasCorte: "0" })).toMatchObject({
      diasSegundoVencimiento: 15,
      diasCorte: 0,
    });
    for (const malo of [
      { diaVencimiento: 29 },
      { diaVencimiento: 10, diasSegundoVencimiento: 0 },
      { diaVencimiento: 10, diasSegundoVencimiento: 61 },
      { diaVencimiento: 10, diasCorte: -1 },
      { diaVencimiento: 10, diasCorte: 181 },
      { diaVencimiento: 10, diasCorte: "2,5" },
    ]) {
      expect(vencimientosDelBarrioSchema.safeParse({ barrioId: ID, ...malo }).success, JSON.stringify(malo)).toBe(false);
    }
  });
});

describe("la fecha de corte del mes", () => {
  const base = { periodoId: ID, primerVencimiento: "2026-12-10", motivo: "Prueba" };

  it("no antes del último vencimiento (el segundo, si hay)", () => {
    expect(cambiarVencimientosSchema.safeParse({ ...base, fechaCorte: "2026-12-10" }).success).toBe(true);
    expect(cambiarVencimientosSchema.safeParse({ ...base, fechaCorte: "2026-12-09" }).success).toBe(false);
    expect(cambiarVencimientosSchema.safeParse({ ...base, segundoVencimiento: "2026-12-20", fechaCorte: "2026-12-15" }).success).toBe(false);
    expect(cambiarVencimientosSchema.parse({ ...base, fechaCorte: "" }).fechaCorte).toBeNull();
  });

  it("al abrir a mano: vacía se propone después; con fecha y sin vencimiento, no", () => {
    const alta = { barrioId: ID, periodo: "2026-12", modelo: "fija", notas: "" };
    expect(crearPeriodoSchema.parse({ ...alta, primerVencimiento: "2026-12-10" }).fechaCorte).toBeNull();
    const sinVencimiento = crearPeriodoSchema.safeParse({ ...alta, primerVencimiento: "", fechaCorte: "2026-12-30" });
    expect(sinVencimiento.success).toBe(false);
    expect(sinVencimiento.error?.issues[0]?.path).toEqual(["fechaCorte"]);
  });
});

describe("la figura «Sin entidad constituida»", () => {
  it("es una figura del producto, y no tiene denominación que inventar", () => {
    expect(FIGURAS_JURIDICAS).toContain("sin_entidad");
    expect(sugerirDenominacionConcepto("sin_entidad")).toBeNull();
  });
});

describe("los datos informativos de la unidad en «Editar»", () => {
  it("lo que no viene queda `undefined` (no se pisa); vacío es `null` (se borra)", () => {
    const sinCampos = editarUnidadSchema.parse({ unidadFuncionalId: ID, estado: "baldio" });
    expect([sinCampos.numeroAccion, sinCampos.residenteNombre, sinCampos.residenteMail]).toEqual([undefined, undefined, undefined]);
    const vacios = editarUnidadSchema.parse({ unidadFuncionalId: ID, estado: "baldio", numeroAccion: "", residenteNombre: "", residenteMail: "" });
    expect([vacios.numeroAccion, vacios.residenteNombre, vacios.residenteMail]).toEqual([null, null, null]);
    expect(editarUnidadSchema.safeParse({ unidadFuncionalId: ID, estado: "baldio", residenteCaracter: "dueño" }).success).toBe(false);
    expect(editarUnidadSchema.safeParse({ unidadFuncionalId: ID, estado: "baldio", numeroAccion: "x".repeat(31) }).success).toBe(false);
  });
});

describe("la planilla del padrón con número de acción y residente", () => {
  const ENC = [...columnasDelPadron(false)];
  const fila = (v: Partial<Record<(typeof ENC)[number], string>>) => ENC.map((c) => v[c] ?? "");
  const leer = (filas: string[][]) => leerPlanillaPadron([ENC, ...filas], { cuentaPorUnidad: false });
  const existente = (v: Partial<UnidadExistente> & { id: string; manzana: string; lote: string }): UnidadExistente => ({
    dadaDeBaja: false,
    superficie: null,
    estado: "baldio",
    nomenclatura: null,
    cbu: null,
    alias: null,
    saldoInicial: "0.00",
    saldoInicialEditable: true,
    numeroAccion: null,
    residente: null,
    titulares: [],
    ...v,
  });

  it("entran sin subir el tope de columnas del lector de XLSX (20)", () => {
    expect(COLUMNAS_PADRON.length).toBe(19);
    expect(filasDePlantilla(true)[0]).toEqual([...COLUMNAS_PADRON]);
  });

  it("una planilla de antes (sin las columnas nuevas) se sigue leyendo", () => {
    const vieja = ["manzana", "lote", "titular"];
    const [u] = leerPlanillaPadron([vieja, ["1", "1", "Ana"]], { cuentaPorUnidad: false });
    expect(u).toMatchObject({ ok: true, numeroAccion: null, residente: null });
  });

  it("se leen de la primera fila; en las siguientes son un error", () => {
    const [u] = leer([
      fila({ manzana: "1", lote: "1", titular: "Ana", numero_accion: "A-1", residente: "Beto", residente_caracter: "Inquilina", residente_mail: "BETO@correo.example" }),
    ]);
    expect(u).toMatchObject({
      ok: true,
      numeroAccion: "A-1",
      residente: { nombre: "Beto", caracter: "inquilino", telefono: null, mail: "beto@correo.example" },
    });
    const [dos] = leer([
      fila({ manzana: "1", lote: "1", titular: "Ana", recibe_boleta: "sí" }),
      fila({ manzana: "1", lote: "1", titular: "Carla", numero_accion: "A-1" }),
    ]);
    expect(dos?.ok).toBe(false);
  });

  it("los errores del residente se dicen por fila", () => {
    const errores = [
      fila({ manzana: "1", lote: "1", residente_mail: "x@correo.example" }),
      fila({ manzana: "1", lote: "2", residente: "Beto", residente_caracter: "dueño" }),
      fila({ manzana: "1", lote: "3", residente: "Beto", residente_telefono: "abc" }),
      fila({ manzana: "1", lote: "4", numero_accion: "x".repeat(31) }),
    ].map((f) => leer([f])[0]!);
    expect(errores.map((e) => (e.ok ? "ok" : e.error))).toEqual([
      "Hay carácter, teléfono o mail del residente sin su nombre.",
      "El carácter del residente «dueño» no es válido: Inquilino, Residente u Otro.",
      "El teléfono del residente va con números, espacios, guiones o paréntesis.",
      "El número de acción tiene hasta 30 caracteres.",
    ]);
  });

  it("el número de acción no se repite: ni dentro de la planilla ni con otra unidad del barrio", () => {
    const lectura = leer([
      fila({ manzana: "1", lote: "1", numero_accion: "A-1" }),
      fila({ manzana: "1", lote: "2", numero_accion: " a-1 " }),
      fila({ manzana: "1", lote: "3", numero_accion: "A-9" }),
      fila({ manzana: "2", lote: "1", numero_accion: "A-7" }),
    ]);
    const plan = planDePadron(lectura, [
      existente({ id: "u9", manzana: "5", lote: "5", numeroAccion: "a-9" }),
      existente({ id: "u21", manzana: "2", lote: "1", numeroAccion: "A-6" }),
    ], []);
    expect(plan.unidades.map((u) => u.error ?? u.accion)).toEqual([
      "alta",
      "El número de acción a-1 ya está en la fila 2: es único en el barrio.",
      "El número de acción A-9 ya es de Mza 5 · Lote 5: es único en el barrio. Para pasárselo a esta unidad, primero sacáselo a la otra desde su ficha.",
      "corrige",
    ]);
    expect(plan.unidades[3]!.detalle).toContain("Número de acción A-6 → A-7.");
  });

  it("se exporta y vuelve a entrar sin cambios", () => {
    const u = existente({
      id: "u1",
      manzana: "1",
      lote: "1",
      numeroAccion: "A-1",
      residente: { nombre: "Beto", caracter: "otro", telefono: "351 555-0100", mail: "beto@correo.example" },
    });
    const filas = filasParaExportar([{ ...u, titulares: [] }], false);
    expect(filas[1]!.slice(-5)).toEqual(["A-1", "Beto", "Otro", "351 555-0100", "beto@correo.example"]);
    const plan = planDePadron(leerPlanillaPadron(filas, { cuentaPorUnidad: false }), [u], []);
    expect(plan.unidades[0]!.accion).toBe("sin_cambios");
  });
});

describe("sin nombre no hay residente (uf_residente_con_nombre_chk)", () => {
  it("el alta rechaza carácter, teléfono o mail del residente sin su nombre", async () => {
    const { agregarUnidadSchema } = await import("./escrituras.ts");
    const base = { barrioId: ID, manzana: "1", lote: "1", estado: "baldio" };
    const r = agregarUnidadSchema.safeParse({ ...base, residenteMail: "x@correo.example" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["residenteNombre"]);
    expect(agregarUnidadSchema.safeParse({ ...base, residenteNombre: "Beto", residenteMail: "x@correo.example" }).success).toBe(true);
  });
});
