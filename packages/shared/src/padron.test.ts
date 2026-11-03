import { describe, expect, it } from "vitest";
import {
  columnasDelPadron,
  csvDeFilas,
  filasDeCsv,
  filasDePlantilla,
  filasParaExportar,
  leerNumeroDePlanilla,
  leerPlanillaCoeficientes,
  leerPlanillaPadron,
  planDePadron,
  PlanillaInvalida,
  type UnidadExistente,
} from "./padron.ts";
import { normalizarCuit, cbuValido, leerDocumento, nombresIguales } from "./cuentas.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENC = [...columnasDelPadron(true)];
const fila = (v: Partial<Record<(typeof ENC)[number], string>>) => ENC.map((c) => v[c] ?? "");
const leer = (filas: string[][], cuentaPorUnidad = true) => leerPlanillaPadron([ENC, ...filas], { cuentaPorUnidad });

// CBU válidos inventados sobre una entidad que no existe (000): el verificador es real.
const CBU_A = "0000003110000000000410";
const CBU_B = "0000003110000000000427";

describe("cuentas", () => {
  it("valida CBU, CUIT y documento", () => {
    expect(cbuValido(CBU_A)).toBe(true);
    expect(cbuValido(CBU_B)).toBe(true);
    expect(cbuValido("0000003110000000000411")).toBe(false);
    expect(normalizarCuit("20-11111111-2")).toBe("20111111112");
    expect(normalizarCuit("20-12345678-0")).toBeNull();
    expect(leerDocumento("27.222.222")).toEqual({ tipo: "dni", numero: "27222222" });
    expect(leerDocumento("20-12345678-0")).toBe("invalido");
    expect(nombresIguales("Pérez, Ana María", "ana maria PEREZ")).toBe(true);
  });
});

describe("leerPlanillaPadron", () => {
  it("una fila por titular: dos titulares de la misma unidad, con una sola marca", () => {
    const r = leer([
      fila({ manzana: "1", lote: "4", superficie_m2: "605,00", estado: "Construida", titular: "Pablo Ferreyra", cuit_o_dni: "20111111112", recibe_boleta: "sí", cbu_unidad: CBU_A }),
      fila({ manzana: "1", lote: "4", titular: "Ana Ledesma", cuit_o_dni: "27222222" }),
    ]);
    expect(r).toHaveLength(1);
    const u = r[0]!;
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.superficie).toBe("605.00");
    expect(u.estado).toBe("construido");
    expect(u.cbu).toBe(CBU_A);
    expect(u.titulares.map((t) => [t.nombre, t.recibeBoleta])).toEqual([
      ["Pablo Ferreyra", true],
      ["Ana Ledesma", false],
    ]);
  });

  it("un CUIT con el verificador mal es un error de esa fila", () => {
    const [u] = leer([fila({ manzana: "3", lote: "12", titular: "X Y", cuit_o_dni: "20-12345678-0" })]);
    expect(u?.ok).toBe(false);
    if (u?.ok === false) expect(u.error).toMatch(/no es válido: revisá el dígito verificador/);
  });

  it("la misma unidad separada en dos lugares es un error", () => {
    const r = leer([
      fila({ manzana: "11", lote: "4", titular: "A B" }),
      fila({ manzana: "11", lote: "5", titular: "C D" }),
      fila({ manzana: "11", lote: "4", titular: "E F" }),
    ]);
    const u = r.find((x) => x.etiqueta?.includes("4"));
    expect(u?.ok).toBe(false);
    if (u?.ok === false) expect(u.error).toMatch(/está dos veces en la planilla \(filas 2 y 4\)/);
  });

  it("datos de la unidad repetidos en la segunda fila son un error", () => {
    const [u] = leer([
      fila({ manzana: "1", lote: "1", superficie_m2: "600", titular: "A B", recibe_boleta: "x" }),
      fila({ manzana: "1", lote: "1", superficie_m2: "600", titular: "C D" }),
    ]);
    expect(u?.ok).toBe(false);
  });

  it("dos titulares sin marca, o dos marcas, son un error", () => {
    expect(leer([fila({ manzana: "1", lote: "1", titular: "A B" }), fila({ manzana: "1", lote: "1", titular: "C D" })])[0]?.ok).toBe(false);
    expect(
      leer([fila({ manzana: "1", lote: "1", titular: "A B", recibe_boleta: "sí" }), fila({ manzana: "1", lote: "1", titular: "C D", recibe_boleta: "sí" })])[0]?.ok,
    ).toBe(false);
  });

  it("con cuenta única, una planilla con cbu_unidad se rechaza en esa fila", () => {
    const [u] = leerPlanillaPadron([ENC, fila({ manzana: "1", lote: "1", cbu_unidad: CBU_A })], { cuentaPorUnidad: false });
    expect(u?.ok).toBe(false);
  });

  it("sin manzana y lote en el encabezado, o con más de 5.000 filas, se rechaza el archivo", () => {
    expect(() => leerPlanillaPadron([["titular"], ["x"]], { cuentaPorUnidad: false })).toThrow(PlanillaInvalida);
    const muchas = Array.from({ length: 5001 }, (_, i) => fila({ manzana: "1", lote: String(i) }));
    expect(() => leer(muchas)).toThrow(/más de 5.000/);
  });

  it("los números aceptan coma o punto decimal y separador de miles", () => {
    expect(leerNumeroDePlanilla("48.200,50")).toBe("48200.50");
    expect(leerNumeroDePlanilla("612.5")).toBe("612.50");
    expect(leerNumeroDePlanilla("48.200")).toBe("48200.00");
    expect(leerNumeroDePlanilla("-3")).toBeNull();
  });
});

const existente = (v: Partial<UnidadExistente> & { id: string; manzana: string; lote: string }): UnidadExistente => ({
  dadaDeBaja: false,
  superficie: "620.00",
  estado: "baldio",
  nomenclatura: null,
  cbu: null,
  alias: null,
  saldoInicial: "0.00",
  saldoInicialEditable: true,
  titulares: [],
  ...v,
});

describe("planDePadron", () => {
  it("alta, corrige y sin cambios", () => {
    const lectura = leer([
      fila({ manzana: "1", lote: "3", superficie_m2: "640,00" }),
      fila({ manzana: "1", lote: "4", titular: "Pablo Ferreyra", cuit_o_dni: "20111111112" }),
      fila({ manzana: "1", lote: "5", superficie_m2: "620" }),
    ]);
    const plan = planDePadron(lectura, [existente({ id: "u3", manzana: "1", lote: "3" }), existente({ id: "u5", manzana: "1", lote: "5" })], []);
    expect(plan.ok).toBe(true);
    expect(plan.unidades.map((u) => u.accion)).toEqual(["corrige", "alta", "sin_cambios"]);
    expect(plan.unidades[0]?.detalle[0]).toBe("Superficie 620,00 → 640,00 m².");
    expect([plan.altas, plan.correcciones, plan.sinCambios]).toEqual([1, 1, 1]);
  });

  it("un CUIT ya registrado con otro nombre queda a revisar, y se decide en pantalla", () => {
    const lectura = leer([fila({ manzana: "5", lote: "2", titular: "Raúl A. Molina", cuit_o_dni: "20111111112" })]);
    const registradas = [{ obligadoId: "o1", nombre: "Raúl Molina", documento: { tipo: "cuit" as const, numero: "20111111112" }, unidades: ["Mz 2 · Lote 7"] }];
    const sinDecidir = planDePadron(lectura, [], registradas);
    expect(sinDecidir.ok).toBe(false);
    expect(sinDecidir.aRevisar).toBe(1);
    const misma = planDePadron(lectura, [], registradas, new Map([[2, "misma"]]));
    expect(misma.ok).toBe(true);
    expect(misma.unidades[0]?.titulares[0]?.obligadoId).toBe("o1");
    const otra = planDePadron(lectura, [], registradas, new Map([[2, "otra"]]));
    expect(otra.ok).toBe(false);
    expect(otra.conError).toBe(1);
  });

  it("el mismo nombre con el mismo CUIT es la misma persona, sin preguntar; el mismo CUIT en dos lotes no es error", () => {
    const lectura = leer([
      fila({ manzana: "1", lote: "1", titular: "molina raul", cuit_o_dni: "20111111112" }),
      fila({ manzana: "1", lote: "2", titular: "Raúl Molina", cuit_o_dni: "20111111112" }),
    ]);
    const plan = planDePadron(lectura, [], [{ obligadoId: "o1", nombre: "Raúl Molina", documento: { tipo: "cuit", numero: "20111111112" }, unidades: [] }]);
    expect(plan.ok).toBe(true);
    expect(plan.unidades.every((u) => u.titulares[0]?.obligadoId === "o1")).toBe(true);
  });

  it("un cambio de titular por planilla es un error", () => {
    const lectura = leer([fila({ manzana: "1", lote: "1", titular: "Otra Persona", cuit_o_dni: "27222222" })]);
    const plan = planDePadron(
      lectura,
      [existente({ id: "u1", manzana: "1", lote: "1", titulares: [{ obligadoId: "o1", nombre: "Ana Ejemplo", documento: { tipo: "cuit", numero: "20111111112" }, email: null, telefono: null }] })],
      [],
    );
    expect(plan.ok).toBe(false);
    expect(plan.unidades[0]?.error).toMatch(/Cambiar titular/);
  });

  it("un saldo inicial ya usado en una boleta no se corrige", () => {
    const lectura = leer([fila({ manzana: "1", lote: "1", saldo_inicial: "1000" })]);
    const plan = planDePadron(lectura, [existente({ id: "u1", manzana: "1", lote: "1", saldoInicial: "500.00", saldoInicialEditable: false })], []);
    expect(plan.unidades[0]?.error).toMatch(/se carga una sola vez/);
  });

  it("una cuenta repetida dentro de la planilla es un error", () => {
    const plan = planDePadron(leer([fila({ manzana: "1", lote: "1", cbu_unidad: CBU_A }), fila({ manzana: "1", lote: "2", cbu_unidad: CBU_A })]), [], []);
    expect(plan.conError).toBe(1);
  });
});

describe("exportar, plantilla y CSV", () => {
  it("lo exportado se vuelve a importar sin cambios (ida y vuelta)", () => {
    const u = existente({
      id: "u1",
      manzana: "1",
      lote: "4",
      superficie: "605.00",
      estado: "construido",
      cbu: CBU_A,
      alias: "ceibos.mz1.l4",
      titulares: [
        { obligadoId: "o1", nombre: "Pablo Ferreyra", documento: { tipo: "cuit", numero: "20111111112" }, email: "pablo@correo.example", telefono: null },
        { obligadoId: "o2", nombre: "Ana Ledesma", documento: { tipo: "dni", numero: "27222222" }, email: null, telefono: null },
      ],
    });
    const filas = filasParaExportar(
      [{ ...u, titulares: u.titulares.map((t, i) => ({ ...t, caracter: "propietario" as const, recibeBoleta: i === 0 })) }],
      true,
    );
    const vuelta = filasDeCsv(csvDeFilas(filas));
    expect(vuelta).toEqual(filas);
    const plan = planDePadron(leerPlanillaPadron(vuelta, { cuentaPorUnidad: true }), [u], []);
    expect(plan.ok).toBe(true);
    expect(plan.unidades[0]?.accion).toBe("sin_cambios");
  });

  it("la plantilla trae el encabezado y una fila de ejemplo que se puede importar", () => {
    for (const porUnidad of [true, false]) {
      const p = filasDePlantilla(porUnidad);
      expect(p).toHaveLength(2);
      expect(p[0]?.includes("cbu_unidad")).toBe(porUnidad);
      expect(planDePadron(leerPlanillaPadron(p, { cuentaPorUnidad: porUnidad }), [], []).altas).toBe(1);
    }
  });

  it("el CSV entiende comillas, punto y coma y saltos de línea", () => {
    expect(filasDeCsv('a;b\r\n"x;1";"di ""hola"""\r\n')).toEqual([
      ["a", "b"],
      ["x;1", 'di "hola"'],
    ]);
  });

  it("la planilla de coeficientes", () => {
    expect(leerPlanillaCoeficientes([["manzana", "lote", "coeficiente"], ["1", "1", "0,5"], ["1", "2", "0.5"]])).toEqual({
      ok: true,
      filas: [
        { fila: 2, manzana: "1", lote: "1", peso: "0.500000000" },
        { fila: 3, manzana: "1", lote: "2", peso: "0.500000000" },
      ],
    });
    expect(leerPlanillaCoeficientes([["manzana", "lote", "coeficiente"], ["1", "1", "0"]]).ok).toBe(false);
  });
});

describe("la planilla de ejemplo de la demo (docs/demo/padron-de-ejemplo.csv)", () => {
  it("se importa limpia en un barrio nuevo con cuenta por unidad: 30 altas, una con dos titulares", () => {
    const texto = readFileSync(fileURLToPath(new URL("../../../docs/demo/padron-de-ejemplo.csv", import.meta.url)), "utf8");
    const plan = planDePadron(leerPlanillaPadron(filasDeCsv(texto), { cuentaPorUnidad: true }), [], []);
    expect(plan.unidades.filter((u) => u.error).map((u) => u.error)).toEqual([]);
    expect([plan.ok, plan.altas]).toEqual([true, 30]);
    expect(plan.unidades.find((u) => u.etiqueta === "Mza A · Lote 2")?.titulares).toHaveLength(2);
  });
});
