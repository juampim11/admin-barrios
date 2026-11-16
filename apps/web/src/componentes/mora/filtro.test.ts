import { describe, expect, it } from "vitest";
import type { FilaMora } from "@admin-barrios/data/servicios/mora";
import { contarVistas, filtrarMora, leerFiltroMora, parametrosDelFiltro, SIN_DERIVAR } from "./filtro.ts";
import { chipsDeSituacion, criterioEnPalabras, mesesDelCriterio, textoDeUltimaGestion } from "./textos.ts";

const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";
const E1 = "33333333-3333-4333-8333-333333333333";

type Fila = Pick<FilaMora, "barrioId" | "meses" | "situacion" | "derivacion" | "promesa" | "ultimaGestion">;

const fila = (p: Partial<Fila>): Fila => ({
  barrioId: B1,
  meses: 4,
  situacion: "con_deuda",
  derivacion: null,
  promesa: null,
  ultimaGestion: null,
  ...p,
});

const derivada = { id: "d", estudioId: E1, estudio: "Estudio Demo", desde: "2026-11-01" };

describe("el filtro que trae la URL", () => {
  it("ignora lo que no tiene forma, y entra por «Para derivar»", () => {
    expect(leerFiltroMora({ barrio: "x", estudio: "y", ver: "z" }, { conBarrio: true })).toEqual({
      barrio: null,
      estudio: null,
      ver: "para_derivar",
    });
  });

  it("en el barrio no hay filtro de barrio", () => {
    expect(leerFiltroMora({ barrio: B1, estudio: SIN_DERIVAR, ver: "derivadas" }, { conBarrio: false })).toEqual({
      barrio: null,
      estudio: SIN_DERIVAR,
      ver: "derivadas",
    });
  });

  it("no escribe en la URL lo que vale por defecto", () => {
    expect(parametrosDelFiltro({ barrio: null, estudio: null, ver: "para_derivar" })).toEqual({ barrio: null, estudio: null, ver: null });
  });
});

describe("qué filas quedan y cuántas hay en cada chip", () => {
  const filas = [
    fila({ situacion: "para_derivar" }),
    fila({ barrioId: B2, situacion: "para_derivar", promesa: { gestionId: "g", fecha: "2026-11-01", monto: "1.00", pagado: "0.00", estado: "vencida" } }),
    fila({ situacion: "derivada", derivacion: derivada }),
    // Derivada que ya no debe nada vencido: sale en «Derivadas» y no en «Con deuda».
    fila({ meses: 0, situacion: "derivada", derivacion: derivada }),
  ];

  it("cuenta por chip dentro del barrio y el estudio", () => {
    expect(contarVistas(filas, { barrio: null, estudio: null, ver: "con_deuda" })).toEqual({
      con_deuda: 3,
      para_derivar: 2,
      derivadas: 2,
      promesa_vencida: 1,
    });
    expect(contarVistas(filas, { barrio: B1, estudio: SIN_DERIVAR, ver: "con_deuda" })).toEqual({
      con_deuda: 1,
      para_derivar: 1,
      derivadas: 0,
      promesa_vencida: 0,
    });
  });

  it("el estudio recorta las derivadas a ese estudio", () => {
    expect(filtrarMora(filas, { barrio: null, estudio: E1, ver: "derivadas" })).toHaveLength(2);
  });
});

describe("la situación y la última gestión en palabras", () => {
  it("una derivada dice a qué estudio, en lila", () => {
    expect(chipsDeSituacion(fila({ situacion: "derivada", derivacion: derivada }))).toEqual([
      { tono: "derivada", texto: "Derivada · Estudio Demo" },
    ]);
  });

  it("una promesa pendiente dice la fecha; una vencida, que venció", () => {
    const promesa = { gestionId: "g", fecha: "2026-11-20", monto: "1.00" as const, pagado: "0.00" as const };
    expect(chipsDeSituacion(fila({ situacion: "promesa", promesa: { ...promesa, estado: "pendiente" } }))).toEqual([
      { tono: "alerta", texto: "Promesa al 20/11" },
    ]);
    expect(chipsDeSituacion(fila({ situacion: "debajo_del_minimo", promesa: { ...promesa, estado: "vencida" } }))).toEqual([
      { tono: "peligro", texto: "Promesa vencida" },
    ]);
    expect(chipsDeSituacion(fila({ situacion: "debajo_del_minimo" }))).toEqual([{ tono: "alerta", texto: "Debajo del monto mínimo" }]);
  });

  it("la última gestión va con canal, fecha y resultado", () => {
    expect(
      textoDeUltimaGestion(fila({ ultimaGestion: { fecha: "2026-11-09", canal: "llamada", resultado: "no_contesta", autor: "administracion", retiradaEl: null } })),
    ).toBe("Llamada · 09/11/2026 · No contesta");
    expect(textoDeUltimaGestion(fila({}))).toBeNull();
  });

  it("una derivación que se retiró dice el retiro, no la derivación", () => {
    expect(
      textoDeUltimaGestion(fila({ ultimaGestion: { fecha: "2026-11-01", canal: "derivacion", resultado: null, autor: "administracion", retiradaEl: "2026-11-12" } })),
    ).toBe("Retirada del estudio · 12/11/2026");
  });

  it("una derivada con la promesa vencida lleva los dos chips", () => {
    const promesa = { gestionId: "g", fecha: "2026-11-01", monto: "1.00" as const, pagado: "0.00" as const, estado: "vencida" as const };
    expect(chipsDeSituacion(fila({ situacion: "derivada", derivacion: derivada, promesa })).map((c) => c.texto)).toEqual([
      "Derivada · Estudio Demo",
      "Promesa vencida",
    ]);
  });

  it("el criterio en palabras: 0 meses, 1 mes, varios", () => {
    expect(mesesDelCriterio(0)).toBe("con algún mes vencido");
    expect(mesesDelCriterio(1)).toBe("más de 1 mes");
    expect(criterioEnPalabras({ meses: 3, montoMinimo: "300000.00" })).toBe("más de 3 meses de deuda vencida y desde $ 300.000,00");
  });
});
