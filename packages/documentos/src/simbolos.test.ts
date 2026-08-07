/**
 * Las guardas de geometría del renderizador (ADR-0001 §7.1).
 *
 * Acá no se decodifica nada: eso es caro y vive en el proyecto `pdf`
 * (`test/codigo-de-barras.test.ts`). Lo que se afirma acá es que el renderizador **no deja salir**
 * un símbolo con las tres fallas silenciosas.
 */

import { describe, expect, it } from "vitest";
import { GEOMETRIA, LADO_MINIMO_QR_MM, renderizarSimbolo, revisarCargaSimbolo } from "./simbolos.ts";
import { ANCHO_UTIL_MM } from "./plantillas/boleta.ts";

const simbolo = (carga: string, simbologia: "interleaved2of5" | "code128" | "qrcode" = "interleaved2of5") =>
  ({ tipo: "simbolo", etiqueta: "Código", simbologia, carga, leible: null }) as const;

describe("cantidad impar de dígitos en Interleaved 2 of 5", () => {
  it("se rechaza explícitamente: la librería antepondría un 0 en silencio", () => {
    const motivos = revisarCargaSimbolo("interleaved2of5", "1234567");
    expect(motivos.join(" ")).toMatch(/impar/);
    expect(() => renderizarSimbolo(simbolo("1234567"), { anchoUtilMm: ANCHO_UTIL_MM })).toThrow(/impar/);
  });

  it("con cantidad par pasa", () => {
    expect(revisarCargaSimbolo("interleaved2of5", "12345678")).toEqual([]);
  });

  it("rechaza lo que no son dígitos", () => {
    expect(revisarCargaSimbolo("interleaved2of5", "12A45678").join(" ")).toMatch(/dígitos/);
  });
});

describe("fondo", () => {
  it("el SVG lleva SIEMPRE un rectángulo blanco opaco, y no hay parámetro para sacarlo", () => {
    const r = renderizarSimbolo(simbolo("12345678"), { anchoUtilMm: ANCHO_UTIL_MM });
    expect(r.svg).toContain('fill="#FFFFFF"');
    // El fondo cubre la caja entera, zona muda incluida: con fondo transparente el símbolo NO SE LEE.
    expect(r.svg).toMatch(/<rect x="0" y="0" width="[\d.]+" height="[\d.]+" fill="#FFFFFF"\/>/);
  });
});

describe("geometría — la impone el renderizador, no el adapter", () => {
  it("el ancho sale declarado en milímetros fijos, no en píxeles", () => {
    const r = renderizarSimbolo(simbolo("12345678"), { anchoUtilMm: ANCHO_UTIL_MM });
    expect(r.svg).toMatch(/^<svg [^>]*width="[\d.]+mm" height="[\d.]+mm"/);
    expect(r.anchoMm).toBeCloseTo(r.modulos * r.anchoModuloMm + 2 * r.zonaMudaMm, 3);
  });

  it("un código de 58 dígitos entra en los 182 mm útiles, con la zona muda de 5 mm a cada lado", () => {
    const r = renderizarSimbolo(simbolo("0".repeat(58)), { anchoUtilMm: ANCHO_UTIL_MM });
    expect(r.anchoMm).toBeLessThanOrEqual(ANCHO_UTIL_MM);
    expect(r.zonaMudaMm).toBe(5);
    expect(r.anchoModuloMm).toBeGreaterThanOrEqual(GEOMETRIA.interleaved2of5.anchoModuloMinimoMm);
  });

  it("si no entra ni con el piso de X-dimension, NO se emite", () => {
    expect(() => renderizarSimbolo(simbolo("0".repeat(120)), { anchoUtilMm: ANCHO_UTIL_MM })).toThrow(
      /no se emite un código que la caja no va a leer/,
    );
    // Y tampoco entra el mismo código en una hoja angosta.
    expect(() => renderizarSimbolo(simbolo("0".repeat(58)), { anchoUtilMm: 60 })).toThrow(/X-dimension/);
  });

  it("el QR sale cuadrado y nunca por debajo del lado mínimo de papel impreso", () => {
    const r = renderizarSimbolo(simbolo("HOLA", "qrcode"), { anchoUtilMm: ANCHO_UTIL_MM });
    expect(r.altoMm).toBeCloseTo(r.anchoMm, 3);
    expect(r.anchoMm - 2 * r.zonaMudaMm).toBeGreaterThanOrEqual(LADO_MINIMO_QR_MM);
  });

  it("Code 128 acepta ASCII imprimible y rechaza el resto", () => {
    expect(revisarCargaSimbolo("code128", "ABC-123")).toEqual([]);
    expect(revisarCargaSimbolo("code128", "año").join(" ")).toMatch(/ASCII/);
  });
});
