import { describe, expect, it } from "vitest";
import { codigoDePago } from "@admin-barrios/shared/codigo-pago";
import { interpretarBusquedaDeUnidad } from "./busqueda-de-unidad.ts";

const leer = (t: string) => {
  const b = interpretarBusquedaDeUnidad(t);
  return { manzana: b.manzana, lote: b.lote, numeros: b.numerosDeCodigo, impreso: b.codigoImpreso };
};

describe("qué se entiende de lo que se tipea en la búsqueda de unidades (encargo 10, BL-030 c)", () => {
  it.each(["Mza 1", "mza 1", "MZA 1", "mza1", "Mza. 1", "Manzana 1", "1-", "1 -", "mza 1-"])("%j es la manzana 1, sola", (t) => {
    expect(leer(t)).toMatchObject({ manzana: "1", lote: null, numeros: [] });
  });

  it("una manzana con letra también", () => {
    expect(leer("Mza A")).toMatchObject({ manzana: "a", lote: null });
    expect(leer("A-")).toMatchObject({ manzana: "a", lote: null });
  });

  it.each(["Mza 1 Lote 2", "mza 1 lote 2", "Mza 1 lt 2", "mza1-2", "1 lote 2"])("%j es la manzana 1, lote 2", (t) => {
    expect(leer(t)).toMatchObject({ manzana: "1", lote: "2" });
  });

  it("«1-2» es la manzana 1 lote 2, y también puede ser el código 1 con su verificador", () => {
    expect(leer("1-2")).toEqual({ manzana: "1", lote: "2", numeros: ["1"], impreso: null });
  });

  it.each([
    ["19", "19"],
    ["000019", "19"],
    ["000019-7", "19"],
    ["000019-x", "19"],
    ["000004-5", "4"],
  ])("el código %j busca la unidad %j", (t, numero) => {
    const b = leer(t);
    expect(b.numeros).toEqual([numero]);
    expect(b.manzana).toBeNull();
  });

  it("el código impreso completo, sin separador, se reconoce por su verificador", () => {
    const impreso = codigoDePago(19, { largo: 6, prefijo: "", separador: "" }); // «000019» + verificador
    const b = leer(impreso);
    expect(b.impreso).toBe("000019");
    expect(b.numeros).toEqual([String(Number(impreso))]);
  });

  it("un nombre o un texto cualquiera no es manzana ni código", () => {
    expect(leer("Quintanilla")).toEqual({ manzana: null, lote: null, numeros: [], impreso: null });
    expect(leer("zzz-no-existe")).toMatchObject({ manzana: null, numeros: [] });
  });

  it("«1 1» (manzana y lote con espacio) no es el código 11: sigue buscando por parecido", () => {
    expect(leer("1 1")).toEqual({ manzana: null, lote: null, numeros: [], impreso: null });
  });

  it("un número larguísimo no es un código de pago (B1)", () => {
    expect(leer("123456789012345678901234567890").numeros).toEqual([]);
  });
});
