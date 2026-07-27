/**
 * **La marca de agua no toca el instrumento** (doc 09 §E.6 y §E.12.12).
 *
 * El defecto que este test fija estaba en el papel: la capa se estampaba con `inset:0` sobre el
 * `<article>` entero, así que la leyenda cruzaba el cupón **y el código de barras**. Una marca de
 * agua sobre un símbolo lineal le baja el contraste y la caja deja de leerlo; una vista previa
 * impresa por error con el código tachado es un vecino que no puede pagar.
 *
 * Se verifica la **geometría del DOM ya maquetado**, no el CSS: la capa la inyecta el renderizador
 * después de cargar el markup, así que mirar la plantilla no probaría nada. Y se mide contra
 * `[data-exclusion]` en vez de contra una constante en mm porque la zona de pago cambia de tamaño
 * con la variante (doc 09 §E.10): una medida fija volvería a fallar en cuanto un barrio cobre
 * distinto.
 */

import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import { crearGeneradorChromium, MARCA_AGUA_ANCLA } from "../src/adapters/chromium.ts";
import { MARCA_MUESTRA, solicitudesDeBoletas } from "../src/emision.ts";
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

const DECLARADO = process.env["CHROME_PATH"] ?? process.env["PUPPETEER_EXECUTABLE_PATH"];
if (DECLARADO && !existsSync(DECLARADO)) {
  throw new Error(`CHROME_PATH apunta a "${DECLARADO}" y ahí no hay nada: el gate de PDF no se saltea en silencio`);
}

const vista = vistaBoletaDeMuestra();

describe.skipIf(!CHROMIUM)("la marca de agua respeta la zona de exclusión", () => {
  let medida: { marcaAbajo: number; exclusionArriba: number; simboloArriba: number; alto: number } | null = null;
  let texto = "";

  beforeAll(async () => {
    const generador = crearGeneradorChromium({
      rutaEjecutable: CHROMIUM,
      // Se mide la hoja **con la marca ya estampada**, en el mismo pase que produce el PDF.
      alMedirMarcaDeAgua: (m) => {
        medida = m;
      },
    });
    const [pdf] = await generador.generarLote(solicitudesDeBoletas([vista]), { timeoutMs: 60_000, chunk: 1 });
    const doc = await getDocumentProxy(new Uint8Array(pdf ?? new Uint8Array()));
    texto = (await extractText(doc, { mergePages: true })).text.replace(/\s+/g, " ");
  }, 120_000);

  it("la marca sigue estampada: sin ella, una muestra se confunde con un instrumento de pago", () => {
    expect(texto).toContain(MARCA_MUESTRA);
  });

  it("la capa termina ARRIBA del troquel: ni el cupón ni el código de barras quedan cruzados", () => {
    expect(medida).not.toBeNull();
    expect(medida!.marcaAbajo).toBeLessThanOrEqual(medida!.exclusionArriba + 1);
    expect(medida!.marcaAbajo).toBeLessThan(medida!.simboloArriba);
  });

  it("y tampoco es una capa de un milímetro: sigue cubriendo la parte humana de la hoja", () => {
    // Si alguien la achica "para que no moleste", deja de cumplir su función. Al menos media hoja.
    expect(medida!.marcaAbajo).toBeGreaterThan(medida!.alto * 0.5);
  });

  it("el ancla es un atributo propio del renderizador, no una clase de la plantilla", () => {
    expect(MARCA_AGUA_ANCLA).toBe("data-marca-agua");
  });
});

describe.skipIf(CHROMIUM)("la marca de agua respeta la zona de exclusión", () => {
  it("saltado: no hay Chromium instalado (definí CHROME_PATH)", () => {
    expect(CHROMIUM).toBeUndefined();
  });
});
