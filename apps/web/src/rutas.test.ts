/**
 * El `?volver=` de las pantallas que se abren desde más de un lugar (encargo 8, T1 §2): solo una ruta
 * interna del mismo barrio. Lo que no pasa cae en la ruta lógica de origen, sin error.
 */

import { describe, expect, it } from "vitest";
import { conListo, conVuelta, destinoDeVuelta, leerListo, rutaDePagoDeUnidad } from "./rutas.ts";

const BARRIO = "11111111-1111-4111-8111-111111111111";
const OTRO = "22222222-2222-4222-8222-222222222222";
const PADRON = `/${BARRIO}/padron`;

describe("destinoDeVuelta", () => {
  it("acepta una ruta interna del mismo barrio", () => {
    const periodo = `/${BARRIO}/liquidacion/33333333-3333-4333-8333-333333333333`;
    expect(destinoDeVuelta(BARRIO, periodo, PADRON)).toBe(periodo);
    expect(destinoDeVuelta(BARRIO, `/${BARRIO}/liquidacion/nuevo`, PADRON)).toBe(`/${BARRIO}/liquidacion/nuevo`);
  });

  it.each([
    ["sin valor", undefined],
    ["un arreglo", [`/${BARRIO}/padron`, "x"]],
    ["otro barrio", `/${OTRO}/padron`],
    ["un dominio ajeno", "//otro.com/x"],
    ["una URL absoluta", `https://otro.com/${BARRIO}/padron`],
    ["javascript:", "javascript:alert(1)"],
    ["una barra doble adentro", `/${BARRIO}//otro.com`],
    ["una barra invertida", `/${BARRIO}/\\otro.com`],
    ["una consulta", `/${BARRIO}/padron?x=1`],
    ["un fragmento", `/${BARRIO}/padron#x`],
    ["la raíz del barrio sin barra", `/${BARRIO}`],
  ])("rechaza %s y vuelve a la ruta de origen", (_caso, crudo) => {
    expect(destinoDeVuelta(BARRIO, crudo, PADRON)).toBe(PADRON);
  });

  it("conVuelta arma lo que destinoDeVuelta acepta", () => {
    const enlace = conVuelta(`/${BARRIO}/padron/coeficientes`, `/${BARRIO}/liquidacion/nuevo`);
    const volver = new URLSearchParams(enlace.split("?")[1]).get("volver");
    expect(destinoDeVuelta(BARRIO, volver, PADRON)).toBe(`/${BARRIO}/liquidacion/nuevo`);
  });
});

describe("rutaDePagoDeUnidad", () => {
  it("lleva la unidad en el parámetro que lee cobros/nuevo", () => {
    expect(rutaDePagoDeUnidad(BARRIO, OTRO)).toBe(`/${BARRIO}/cobros/nuevo?unidad=${OTRO}`);
  });
});

describe("conListo / leerListo (encargo 9, PR 1 §2)", () => {
  const LISTA = `/${BARRIO}/proveedores`;

  it("el alta vuelve a su lista con la clave y el id, y la lista los lee", () => {
    const destino = conListo(LISTA, "proveedor", OTRO);
    expect(destino).toBe(`${LISTA}?listo=proveedor&id=${OTRO}`);
    const parametros = Object.fromEntries(new URL(destino, "http://x").searchParams);
    expect(leerListo(parametros, "proveedor")).toEqual({ id: OTRO });
  });

  it("una lista ignora el «Listo:» de otra alta", () => {
    expect(leerListo({ listo: "gasto", id: OTRO }, "proveedor")).toBeNull();
    expect(leerListo({}, "proveedor")).toBeNull();
  });

  it("un id que no es un uuid no llega a la pantalla (el aviso sale sin nombre)", () => {
    expect(leerListo({ listo: "cargo", id: "<script>" }, "cargo")).toEqual({ id: null });
    expect(leerListo({ listo: "cargo", id: [OTRO, OTRO] }, "cargo")).toEqual({ id: null });
  });
});
