/**
 * «Deuda anterior a la activación» (encargo 17b, punto 6): lo que dice la pantalla de verificar con el
 * barrio ya activado. Lo que se fija: que la explicación del ajuste esté siempre, y que solo prometa
 * «subir otra planilla» mientras de verdad se puede.
 */

import { describe, expect, it } from "vitest";
import { COMO_SE_CORRIGE_LA_DEUDA_ANTERIOR, comoSeCorrigeYaActivado, DEUDA_ANTERIOR_A_LA_ACTIVACION } from "./textos.ts";

describe("la deuda anterior, con el barrio ya activado", () => {
  it("el enlace del tablero y el título de la pantalla se llaman igual", () => {
    expect(DEUDA_ANTERIOR_A_LA_ACTIVACION).toBe("Deuda anterior a la activación");
  });

  it("cuando ya no se reemplaza, dice que se corrige con un ajuste y por dónde", () => {
    const texto = comoSeCorrigeYaActivado(false);
    expect(texto).toBe(COMO_SE_CORRIGE_LA_DEUDA_ANTERIOR);
    expect(texto).toContain("«Conceptos del mes» → «Aplicar un concepto»");
    expect(texto).toContain("un cargo si faltó deuda, un descuento si sobró, con el motivo");
    expect(texto).not.toContain("todavía se puede subir otra planilla");
  });

  it("mientras se puede reemplazar lo dice, y explica igual el ajuste de después", () => {
    const texto = comoSeCorrigeYaActivado(true);
    expect(texto).toContain("todavía se puede subir otra planilla");
    expect(texto).toContain("«Conceptos del mes» → «Aplicar un concepto»");
    expect(texto).toContain("un cargo si faltó deuda o un descuento si sobró, con el motivo");
  });
});
