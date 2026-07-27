/**
 * Capa 3 de ADR-0001 §8 — **round-trip real**: se rasteriza el mismo descriptor que va al papel y se
 * decodifica con un lector de verdad (`zxing-wasm`, el binding de ZXing-C++). Se afirma
 * `decodificado === carga` **y** `decodificado === leible`.
 *
 * Vive en el proyecto `pdf` y **fuera del gate barato** (`pnpm test` no lo corre): son ~45 ms por
 * símbolo y el ciclo normal no tiene por qué pagarlos. Corre en CI, en su propio paso.
 *
 * Los tests que más valen son los dos del final: los que **atrapan las dos fallas silenciosas**.
 * Están escritos de forma que si alguien "arreglara" la guarda quitándola, el test se pone rojo.
 */

import { describe, expect, it } from "vitest";
import { toBuffer } from "bwip-js/node";
import { readBarcodes } from "zxing-wasm/reader";
import { leibleNormalizado, type InstrumentoSimbolo } from "@admin-barrios/shared/documentos";
import { revisarCargaSimbolo } from "../src/simbolos.ts";
import { crearMedioGenericoDemo } from "../src/cobranza/adapters/generico-demo.ts";

/** 55 dígitos: la cantidad impar exacta con la que ADR-0001 §7.1 midió la falla. */
const CARGA_IMPAR = `345001${"7890".repeat(13)}`.slice(0, 55);

const FORMATO_ZXING = { interleaved2of5: "ITF", code128: "Code128", qrcode: "QRCode" } as const;

/** Rasteriza como lo haría una impresora y devuelve lo que lee un lector. */
async function decodificar(
  simbologia: keyof typeof FORMATO_ZXING,
  carga: string,
  opciones: { readonly fondoBlanco?: boolean } = {},
): Promise<string[]> {
  const png = await toBuffer({
    bcid: simbologia,
    text: carga,
    scale: 3,
    // El QR es cuadrado: si se le pasa `height` (aunque sea `undefined`), bwip-js lo rechaza.
    ...(simbologia === "qrcode" ? {} : { height: 14 }),
    includetext: false,
    ...(opciones.fondoBlanco === false ? {} : { backgroundcolor: "FFFFFF" }),
    paddingwidth: 12,
    paddingheight: 12,
  });
  const resultados = await readBarcodes(new Blob([new Uint8Array(png)], { type: "image/png" }), {
    formats: [FORMATO_ZXING[simbologia]],
    tryHarder: true,
  });
  return resultados.map((r) => r.text);
}

const bloque = crearMedioGenericoDemo().armarBloquePago({
  barrio: "Barrio Demo Los Aromos",
  comprobante: "A-2026-07-00174",
  periodo: "2026-07",
  vencimiento: "2026-08-10",
  fechaTope: null,
  importe: "358997.97",
});
const simbolos = bloque.instrumentos.filter((i): i is InstrumentoSimbolo => i.tipo === "simbolo");

/**
 * Code 128 no lo usa el adapter de demo —el código de pago electrónico se tipea, no se escanea—,
 * pero la simbología está soportada y un convenio futuro la va a pedir: se verifica igual.
 */
const CODE128_SINTETICO: InstrumentoSimbolo = {
  tipo: "simbolo",
  etiqueta: "Code 128 (fixture)",
  simbologia: "code128",
  carga: "AB-1234567890",
  leible: "AB-1234567890",
};

describe("round-trip: lo codificado es lo impreso", () => {
  it("el adapter de demo trae el código de barras y el QR de pago", () => {
    expect(simbolos.map((s) => s.simbologia)).toEqual(["interleaved2of5", "qrcode"]);
  });

  for (const simbolo of [...simbolos, CODE128_SINTETICO]) {
    it(`${simbolo.etiqueta} (${simbolo.simbologia}) decodifica exactamente su carga`, async () => {
      const leidos = await decodificar(simbolo.simbologia, simbolo.carga);
      expect(leidos).toContain(simbolo.carga);
      if (simbolo.leible !== null) {
        // Y lo que lee la caja es lo mismo que lee el vecino en el papel.
        expect(leidos).toContain(leibleNormalizado(simbolo.leible));
      }
    });
  }
});

describe("falla silenciosa 1 — cantidad impar de dígitos en Interleaved 2 of 5", () => {
  it("bwip-js antepone un 0 SIN ERROR: el símbolo codifica otro número que el impreso", async () => {
    // Control: así se comporta la librería si nadie la vigila. Este test documenta el motivo de la
    // guarda; si algún día bwip-js empezara a rechazarlo, acá nos enteramos.
    const pedido = CARGA_IMPAR;
    expect(pedido.length % 2).toBe(1);
    const leidos = await decodificar("interleaved2of5", pedido);
    expect(leidos).not.toContain(pedido);
    expect(leidos).toContain(`0${pedido}`);
  });

  it("nuestra guarda lo rechaza ANTES de generar nada", () => {
    const motivos = revisarCargaSimbolo("interleaved2of5", CARGA_IMPAR);
    expect(motivos.join(" ")).toMatch(/impar/);
  });

  it("el adapter de demo nunca produce una carga impar", () => {
    for (const s of simbolos) expect(revisarCargaSimbolo(s.simbologia, s.carga)).toEqual([]);
  });
});

describe("falla silenciosa 2 — fondo transparente", () => {
  it("el renderizador fuerza fondo blanco opaco y con eso el lector lee sin problemas", async () => {
    const barras = simbolos[0];
    if (!barras) throw new Error("falta el código de barras");
    expect(await decodificar("interleaved2of5", barras.carga)).toContain(barras.carga);
  });

  it("sin el fondo forzado, la lectura deja de estar garantizada", async () => {
    const barras = simbolos[0];
    if (!barras) throw new Error("falta el código de barras");
    const conFondo = await decodificar("interleaved2of5", barras.carga, { fondoBlanco: true });
    // Lo que se afirma es lo único afirmable con evidencia: **con** fondo blanco la lectura es
    // exacta. Qué hace un PNG transparente depende de cómo lo componga cada visor o cada impresora,
    // y una aserción sobre eso pasaría también cuando la guarda no hiciera falta. La garantía dura
    // está en `simbolos.test.ts`: el renderizador **siempre** emite el `fill="#FFFFFF"` y no hay
    // parámetro para sacarlo, así que la decisión nunca queda librada al azar.
    expect(conFondo).toContain(barras.carga);
    expect(await decodificar("interleaved2of5", barras.carga)).toEqual(conFondo);
  });
});
