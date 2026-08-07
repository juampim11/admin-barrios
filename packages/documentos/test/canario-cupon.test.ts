/**
 * **El canario del cupón** (ADR-0001 §7.2, compuerta 2, "una vez por lote sobre la primera boleta").
 *
 * Éste es el test que faltaba, y su ausencia dejó pasar una falla grave: el código de barras se
 * emitía **ilegible** porque el QR se imprimía encima de su último tramo, zona muda incluida. La
 * hoja se veía impecable y ningún lector leía nada.
 *
 * `codigo-de-barras.test.ts` no podía atraparlo: verifica la **carga** regenerando el símbolo con
 * parámetros propios. Acá se verifica la **geometría**, que es la capa donde estaba la falla —
 * se renderiza la boleta completa en Chromium, se recorta la zona del cupón tal como sale impresa y
 * se le pasa a un lector de verdad. Si algo se imprime encima del código, este test se pone rojo.
 */

import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import puppeteer from "puppeteer-core";
import { readBarcodes } from "zxing-wasm/reader";
import { prepararLectorSinRed } from "./lector-simbolos.ts";
import type { InstrumentoSimbolo } from "@admin-barrios/shared/documentos";
import { htmlDeLote } from "../src/adapters/chromium.ts";
import { solicitudDeBoleta } from "../src/emision.ts";
import { vistaBoletaDeMuestra } from "../src/fixtures/boleta-muestra.ts";

const CANDIDATOS = [
  process.env["CHROME_PATH"],
  process.env["PUPPETEER_EXECUTABLE_PATH"],
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];
const CHROMIUM = CANDIDATOS.find((ruta): ruta is string => !!ruta && existsSync(ruta));

// Si alguien declaró explícitamente dónde está el navegador y ahí no está, es un error de entorno,
// no una razón para saltear: sin esto, mover el binario en la imagen del runner dejaría **CI en
// verde con cero cobertura de PDF**.
const DECLARADO = process.env["CHROME_PATH"] ?? process.env["PUPPETEER_EXECUTABLE_PATH"];
if (DECLARADO && !existsSync(DECLARADO)) {
  throw new Error(`CHROME_PATH apunta a "${DECLARADO}" y ahí no hay nada: el gate de PDF no se saltea en silencio`);
}

const vista = vistaBoletaDeMuestra();
const simbolos = vista.bloquePago.instrumentos.filter((i): i is InstrumentoSimbolo => i.tipo === "simbolo");

describe.skipIf(!CHROMIUM)("canario: el cupón impreso se lee", () => {
  /** Recortes de la hoja renderizada, uno por símbolo, en PNG a alta resolución. */
  let recortes: Map<string, Uint8Array>;

  beforeAll(async () => {
    // El lector lee su WebAssembly del disco, no del CDN: ver `lector-simbolos.ts`.
    await prepararLectorSinRed();
    const navegador = await puppeteer.launch({
      executablePath: CHROMIUM ?? "",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    try {
      const page = await navegador.newPage();
      // 5× para que el lector tenga píxeles de sobra: lo que se verifica es la geometría, no la
      // resolución de una impresora concreta.
      await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 5 });
      await page.setContent(htmlDeLote([solicitudDeBoleta(vista)]), { waitUntil: "load" });

      recortes = new Map();
      const cajas = await page.evaluate(() => {
        type Caja = { x: number; y: number; width: number; height: number };
        type Nodo = { getBoundingClientRect(): Caja; getAttribute(n: string): string | null };
        const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Nodo> } }).document;
        // Solo el `<svg>` externo de cada símbolo: el interno es el que dibuja bwip-js.
        const nodos = doc.querySelectorAll("[data-simbologia] > svg");
        const salida: (Caja & { simbologia: string })[] = [];
        for (let i = 0; i < nodos.length; i++) {
          const nodo = nodos[i];
          if (!nodo) continue;
          const r = nodo.getBoundingClientRect();
          const padre = doc.querySelectorAll("[data-simbologia]")[i];
          salida.push({
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            simbologia: padre?.getAttribute("data-simbologia") ?? "",
          });
        }
        return salida;
      });

      expect(cajas.length).toBe(simbolos.length);
      for (const caja of cajas) {
        const simbolo = simbolos.find((s) => s.simbologia === caja.simbologia);
        if (!simbolo) continue;
        // El recorte se toma de la PÁGINA, no del elemento: así, si algo se imprimió encima, entra
        // en la captura. Recortar el elemento lo dibujaría aislado y taparía justamente el bug.
        const png = await page.screenshot({
          clip: { x: caja.x, y: caja.y, width: caja.width, height: caja.height },
          type: "png",
        });
        recortes.set(simbolo.simbologia, new Uint8Array(png));
      }
      await page.close();
    } finally {
      await navegador.close();
    }
  }, 120_000);

  it("recortó un símbolo por instrumento de la boleta", () => {
    expect([...recortes.keys()].sort()).toEqual([...simbolos.map((s) => s.simbologia)].sort());
  });

  for (const simbolo of simbolos) {
    const formato = simbolo.simbologia === "interleaved2of5" ? "ITF" : simbolo.simbologia === "code128" ? "Code128" : "QRCode";
    it(`${simbolo.etiqueta} se decodifica DESDE LA HOJA y coincide con lo impreso`, async () => {
      const png = recortes.get(simbolo.simbologia);
      expect(png).toBeDefined();
      const leidos = await readBarcodes(new Blob([png ?? new Uint8Array()], { type: "image/png" }), {
        formats: [formato],
        tryHarder: true,
      });
      expect(leidos.map((r) => r.text)).toContain(simbolo.carga);
    }, 60_000);
  }
});

describe.skipIf(CHROMIUM)("canario: el cupón impreso se lee", () => {
  it("saltado: no hay Chromium instalado (definí CHROME_PATH)", () => {
    expect(CHROMIUM).toBeUndefined();
  });
});
