/**
 * El payload del QR de pago contra el estándar EMVCo / Transferencias 3.0 (BL-013): estructura TLV
 * sin desbordes ni tags repetidos, moneda 032 (ARS), importe con punto decimal, CRC-16/CCITT-FALSE
 * válido al final. Se lee con `leerEmv`, no con una expresión regular sobre la cadena.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { codigoDePago, FORMATO_CODIGO_PAGO_INICIAL } from "@admin-barrios/shared/codigo-pago";
import { conCrc, crc16, leerEmv, tlv } from "./emvco.ts";
import { CVU_INEXISTENTE, payloadQrPago } from "./inercia.ts";

describe("CRC-16/CCITT-FALSE", () => {
  it("da el vector de control del algoritmo: «123456789» → 29B1", () => {
    expect(crc16("123456789")).toBe("29B1");
  });

  it("leerEmv rechaza un CRC que no corresponde y una estructura que se desborda", () => {
    const bueno = conCrc(tlv("00", "01") + tlv("53", "032"));
    expect(() => leerEmv(bueno)).not.toThrow();
    expect(() => leerEmv(`${bueno.slice(0, -1)}${bueno.endsWith("0") ? "1" : "0"}`)).toThrow(/CRC/);
    expect(() => leerEmv("000201539903")).toThrow();
  });
});

describe("el payload que genera el medio de transferencia", () => {
  it("cumple EMVCo para cualquier importe y cualquier código de pago", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 99_999_999_99n }),
        fc.integer({ min: 1, max: 999_999 }),
        fc.stringMatching(/^[A-Z0-9-]{1,25}$/),
        (centavos, numero, comprobante) => {
          const importe = `${centavos / 100n}.${(centavos % 100n).toString().padStart(2, "0")}`;
          const codigoPago = codigoDePago(numero, FORMATO_CODIGO_PAGO_INICIAL);
          const payload = payloadQrPago({
            barrio: "Barrio de prueba",
            comprobante,
            codigoPago,
            periodo: "2026-07",
            vencimiento: "2026-08-10",
            fechaTope: null,
            importe,
          });
          const campos = leerEmv(payload); // lanza si la estructura o el CRC están mal
          expect([...campos.keys()]).toEqual(["00", "26", "53", "54", "62", "63"]);
          expect(campos.get("00")).toBe("01");
          expect(campos.get("53")).toBe("032");
          expect(campos.get("54")).toBe(importe);
          expect(campos.get("26")).toContain(CVU_INEXISTENTE);
          expect(campos.get("62")).toContain(tlv("05", codigoPago.replace(/\D/g, "")));
        },
      ),
      { numRuns: 300 },
    );
  });
});
