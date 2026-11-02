/**
 * Propiedades del código de pago por UF (BL-012). No son casos a mano: valen para cualquier número,
 * cualquier formato de barrio y cualquier error que `fast-check` genere.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  codigoDePago,
  digitoVerificador,
  FORMATO_CODIGO_PAGO_INICIAL,
  leerCodigoDePago,
  verificadorValido,
  type FormatoCodigoPago,
} from "./codigo-pago.ts";

const RUNS = { numRuns: 1000 };

const formatoArb: fc.Arbitrary<FormatoCodigoPago> = fc.record({
  largo: fc.integer({ min: 3, max: 12 }),
  prefijo: fc.stringMatching(/^\d{0,6}$/),
  separador: fc.constantFrom("-" as const, "" as const),
});

/** Un número que entra en el largo del formato. */
const casoArb = formatoArb.chain((formato) =>
  fc.record({ formato: fc.constant(formato), numero: fc.integer({ min: 1, max: Math.min(10 ** formato.largo - 1, Number.MAX_SAFE_INTEGER) }) }),
);

const soloDigitos = (codigo: string) => codigo.replace(/-/g, "");

describe("propiedades del código de pago", () => {
  it("DETERMINÍSTICO — el mismo número con el mismo formato da siempre el mismo código", () => {
    fc.assert(
      fc.property(casoArb, ({ formato, numero }) => {
        expect(codigoDePago(numero, formato)).toBe(codigoDePago(numero, formato));
      }),
      RUNS,
    );
  });

  it("ÚNICO DENTRO DEL BARRIO — números distintos dan códigos distintos (y se leen de vuelta)", () => {
    fc.assert(
      fc.property(
        formatoArb.chain((formato) =>
          fc.record({
            formato: fc.constant(formato),
            numeros: fc.uniqueArray(fc.integer({ min: 1, max: Math.min(10 ** formato.largo - 1, 9_999_999) }), {
              minLength: 2,
              maxLength: 300,
            }),
          }),
        ),
        ({ formato, numeros }) => {
          const codigos = numeros.map((n) => codigoDePago(n, formato));
          expect(new Set(codigos).size).toBe(numeros.length);
          for (const [i, c] of codigos.entries()) expect(leerCodigoDePago(c, formato)).toBe(numeros[i]);
        },
      ),
      RUNS,
    );
  });

  it("UN DÍGITO MAL — cambiar cualquier dígito del código (incluido el verificador) se detecta", () => {
    fc.assert(
      fc.property(casoArb, fc.nat(), fc.integer({ min: 1, max: 9 }), ({ formato, numero }, posicion, salto) => {
        const digitos = soloDigitos(codigoDePago(numero, formato));
        const i = posicion % digitos.length;
        const otro = String((Number(digitos[i]) + salto) % 10);
        const conError = `${digitos.slice(0, i)}${otro}${digitos.slice(i + 1)}`;
        expect(verificadorValido(conError)).toBe(false);
      }),
      RUNS,
    );
  });

  it("TRANSPOSICIÓN — invertir dos dígitos contiguos distintos se detecta", () => {
    fc.assert(
      fc.property(casoArb, fc.nat(), ({ formato, numero }, posicion) => {
        const digitos = soloDigitos(codigoDePago(numero, formato));
        const i = posicion % (digitos.length - 1);
        fc.pre(digitos[i] !== digitos[i + 1]);
        const transpuesto = `${digitos.slice(0, i)}${digitos[i + 1]}${digitos[i]}${digitos.slice(i + 2)}`;
        expect(verificadorValido(transpuesto)).toBe(false);
      }),
      RUNS,
    );
  });

  it("NUMÉRICO — el código son solo dígitos (y el separador elegido), con el largo exacto del formato", () => {
    fc.assert(
      fc.property(casoArb, ({ formato, numero }) => {
        const codigo = codigoDePago(numero, formato);
        expect(codigo).toMatch(formato.separador === "-" ? /^\d+-\d$/ : /^\d+$/);
        expect(soloDigitos(codigo)).toHaveLength(formato.prefijo.length + formato.largo + 1);
      }),
      RUNS,
    );
  });
});

describe("casos a mano", () => {
  it("el ejemplo clásico de Damm: 572 → verificador 4", () => {
    expect(digitoVerificador("572")).toBe(4);
    expect(verificadorValido("5724")).toBe(true);
  });

  it("formato inicial: seis dígitos con guion; con prefijo de red y sin separador", () => {
    expect(codigoDePago(1, FORMATO_CODIGO_PAGO_INICIAL)).toMatch(/^000001-\d$/);
    expect(codigoDePago(42, { largo: 6, prefijo: "123", separador: "" })).toMatch(/^123000042\d$/);
  });

  it("un número que no entra en el largo del barrio se rechaza: se agranda el largo, no se trunca", () => {
    expect(() => codigoDePago(1000, { largo: 3, prefijo: "", separador: "-" })).toThrow(/agrandar el largo/);
  });

  it("leer: con o sin separador; con prefijo ajeno o verificador malo, null", () => {
    const f = { largo: 6, prefijo: "77", separador: "-" as const };
    const c = codigoDePago(15, f);
    expect(leerCodigoDePago(c, f)).toBe(15);
    expect(leerCodigoDePago(` ${c.replace("-", "")} `, f)).toBe(15);
    expect(leerCodigoDePago(c.replace(/^77/, "78"), f)).toBeNull();
  });
});
