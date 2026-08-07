/**
 * El contrato de la serie histórica (doc 10 §I.9, hueco F-7).
 *
 * Lo que se afirma acá no es cómo se dibuja —eso es de la plantilla— sino **qué se puede meter en una
 * tira**: que los puntos vengan hechos, en orden, sin saltos, y expresados como texto publicado. Es la
 * capa que impide que alguien conecte la fuente real recalculando la historia en cada emisión.
 */

import { describe, expect, it } from "vitest";
import { magnitudPublicada, mesSiguiente, serieHistoricaSchema } from "./series.ts";

const punto = (periodo: string, texto: string | null, unidades: number | null = null) => ({
  periodo,
  etiqueta: `${periodo.slice(5)}/${periodo.slice(0, 4)}`,
  texto,
  unidades,
});

describe("la serie llega hecha y ordenada", () => {
  it("acepta una ventana de meses consecutivos", () => {
    const serie = serieHistoricaSchema.parse({
      puntos: [punto("2026-03", "1.000,00"), punto("2026-04", "2.000,00"), punto("2026-05", "3.000,00")],
    });
    expect(serie.puntos).toHaveLength(3);
  });

  it("**rechaza un salto de mes**: un período sin informe se declara, no se omite", () => {
    expect(() =>
      serieHistoricaSchema.parse({ puntos: [punto("2026-03", "1.000,00"), punto("2026-05", "3.000,00")] }),
    ).toThrow(/consecutivos/);
  });

  it("un mes sin informe entra como hueco y reserva su lugar", () => {
    const serie = serieHistoricaSchema.parse({
      puntos: [punto("2026-03", "1.000,00"), punto("2026-04", null), punto("2026-05", "3.000,00")],
    });
    expect(serie.puntos[1]?.texto).toBeNull();
  });

  it("una ventana entera de huecos no es una serie", () => {
    expect(() =>
      serieHistoricaSchema.parse({ puntos: [punto("2026-03", null), punto("2026-04", null)] }),
    ).toThrow(/ventana vacía/);
  });

  it("no admite más de 12 períodos: por encima, las columnas bajan del ancho mínimo", () => {
    const puntos = Array.from({ length: 13 }, (_, i) => punto(`2026-${String(i + 1).padStart(2, "0")}`, "1.000,00"));
    expect(() => serieHistoricaSchema.parse({ puntos })).toThrow(/12 períodos/);
  });

  it("el cambio de año no rompe la contigüidad", () => {
    expect(mesSiguiente("2026-12")).toBe("2027-01");
    expect(() =>
      serieHistoricaSchema.parse({ puntos: [punto("2026-12", "1.000,00"), punto("2027-01", "2.000,00")] }),
    ).not.toThrow();
  });
});

describe("la magnitud sale del texto publicado y de ningún otro lado (§I.8.2)", () => {
  it("lee el formato argentino, con o sin signo, con `$` y con `%`", () => {
    expect(magnitudPublicada("1.234.567,89")).toBe(1_234_567_890_000n);
    expect(magnitudPublicada("$ 1.000,00")).toBe(1_000_000_000n);
    expect(magnitudPublicada("94,05")).toBe(94_050_000n);
    expect(magnitudPublicada("101,92 %")).toBe(101_920_000n);
    expect(magnitudPublicada("−1.000,00")).toBe(-1_000_000_000n);
    expect(magnitudPublicada("-1.000,00")).toBe(-1_000_000_000n);
  });

  it("**rechaza un monto de dominio**: es el error que dibujaría una barra mil veces más corta", () => {
    expect(() => magnitudPublicada("1234567.89")).toThrow(/texto impreso/);
  });

  it("dos textos publicados iguales dan la misma magnitud, vengan de donde vengan", () => {
    expect(magnitudPublicada("101.892.000,00")).toBe(magnitudPublicada("$ 101.892.000,00"));
  });
});
