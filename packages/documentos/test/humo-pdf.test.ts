/**
 * Capa 4 de ADR-0001 §8 — **humo del PDF**: que el artefacto exista y sea sano.
 *
 * Lo que se afirma es deliberadamente poco y muy estable:
 *
 *  - cabecera `%PDF-` y la cantidad de páginas esperada;
 *  - **el texto extraído contiene el total formateado exactamente igual que en el modelo de vista**
 *    — es el test que atrapa el bug de ICU;
 *  - la marca de agua obligatoria está en el papel;
 *  - **de la red no salió nada**: la intercepción aborta todo lo que no sea `data:`.
 *
 * **Nunca se afirma sobre los bytes ni sobre el hash del PDF**: un PDF trae fecha de creación e
 * identificadores propios, así que el hash cambia en cada corrida. El `sha256` de §6 es para
 * auditar lo emitido, no para comparar en un test.
 */

import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import { crearGeneradorChromium, permitida } from "../src/adapters/chromium.ts";
import { MARCA_MUESTRA, MARGENES_BOLETA_MM, solicitudesDeBoletas } from "../src/emision.ts";
import { vistaBoletaDeMuestra } from "../src/fixtures/boleta-muestra.ts";
import type { DocumentoSolicitado } from "../src/generador.ts";

/** Rutas donde suele estar el navegador cuando no hay `CHROME_PATH` (desarrollo local). */
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
const abortados: string[] = [];

describe("qué deja pasar el renderizador (no hace falta navegador)", () => {
  it("solo `about:blank` y los `data:` de los mediatypes que la plantilla necesita", () => {
    expect(permitida("about:blank")).toBe(true);
    expect(permitida("data:image/png;base64,AAAA")).toBe(true);
    expect(permitida("data:font/woff2;base64,AAAA")).toBe(true);
    expect(permitida("data:image/svg+xml;base64,AAAA")).toBe(true);
  });

  it("aborta todo lo que salga a la red", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "https://cdn.ejemplo.test/logo.png",
      "file:///etc/passwd",
      "//cdn.ejemplo.test/logo.png",
      "ftp://ejemplo.test/x",
    ]) {
      expect(permitida(url)).toBe(false);
    }
  });

  it("aborta los `data:` que no son ni imagen ni fuente — un `data:text/html` es un documento nuevo", () => {
    for (const url of [
      "data:text/html,<script>fetch('http://x')</script>",
      "data:application/javascript,alert(1)",
      "data:text/css,@import url(http://x)",
      "data:,algo",
      "DATA:TEXT/HTML,x",
    ]) {
      expect(permitida(url)).toBe(false);
    }
  });
});

describe.skipIf(!CHROMIUM)("humo del PDF", () => {
  let pdfs: Uint8Array[] = [];

  beforeAll(async () => {
    const generador = crearGeneradorChromium({
      rutaEjecutable: CHROMIUM,
      alAbortarRequest: (url) => abortados.push(url),
    });
    // Tres boletas en UNA sola pasada: es la forma en que se emite de verdad.
    pdfs = await generador.generarLote(solicitudesDeBoletas([vista, vista, vista]), {
      timeoutMs: 60_000,
      chunk: 50,
    });
  }, 120_000);

  it("devuelve un PDF por documento, en el mismo orden", () => {
    expect(pdfs).toHaveLength(3);
  });

  it("cada artefacto es un PDF sano de una página", async () => {
    for (const pdf of pdfs) {
      expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
      const doc = await getDocumentProxy(new Uint8Array(pdf));
      expect(doc.numPages).toBe(1);
    }
  });

  it("el total del papel es EXACTAMENTE la cadena del modelo de vista (el bug de ICU)", async () => {
    const doc = await getDocumentProxy(new Uint8Array(pdfs[0] ?? new Uint8Array()));
    const { text } = await extractText(doc, { mergePages: true });
    const plano = text.replace(/\s+/g, " ");
    expect(plano).toContain(vista.totales.aPagar.texto);
    expect(plano).toContain(vista.detalle.gastoDelBarrio.texto);
    // Y no hay ni una cifra en formato en-US, que es como se vería la degradación de `Intl`.
    expect(plano).not.toMatch(/\d{1,3}(,\d{3})+\.\d{2}/);
  });

  it("las dos fechas del cupón y el comprobante están en el papel", async () => {
    const doc = await getDocumentProxy(new Uint8Array(pdfs[0] ?? new Uint8Array()));
    const { text } = await extractText(doc, { mergePages: true });
    expect(text.replace(/\s+/g, " ")).toContain(vista.bloquePago.fechas.vencimiento.texto);
    expect(text).toContain(vista.emision.comprobante ?? "");
  });

  it("la marca de agua obligatoria salió estampada, aunque la plantilla no la contiene", async () => {
    const doc = await getDocumentProxy(new Uint8Array(pdfs[0] ?? new Uint8Array()));
    const { text } = await extractText(doc, { mergePages: true });
    expect(text.replace(/\s+/g, " ")).toContain(MARCA_MUESTRA);
  });

  it("el PDF trae fuentes embebidas (si no, no habría texto que extraer)", async () => {
    const doc = await getDocumentProxy(new Uint8Array(pdfs[0] ?? new Uint8Array()));
    const { text } = await extractText(doc, { mergePages: true });
    expect(text.trim().length).toBeGreaterThan(200);
  });

  it("de la red no salió NADA: solo `data:` y `about:blank` pasan", () => {
    expect(abortados).toEqual([]);
  });

  it("el JavaScript del contenido está apagado — y el estampado sigue funcionando", async () => {
    // `setJavaScriptEnabled(false)` toma efecto en la **próxima navegación**, y `setContent()` es
    // una navegación: si quedara después, no protegería nada y el test igual pasaría en verde. Por
    // eso se verifica el efecto y no la llamada: un script que borra el documento no lo borra.
    const generador = crearGeneradorChromium({ rutaEjecutable: CHROMIUM });
    const conScript: DocumentoSolicitado = {
      // La hoja tiene el tamaño de una página para que la capa de la marca de agua entre entera:
      // en un artículo de dos centímetros se recortaría y el texto extraído quedaría a medias.
      //
      // `p{margin:0}` no es cosmética: el margen por defecto del párrafo **se escapa del artículo**
      // (`position:relative` no abre un contexto de formato) y le suma 16 px a una hoja que ya mide
      // exactamente una página, así que el render salía en 2 páginas y el lote no se podía partir.
      // La plantilla real no lo sufre porque su primer hijo es la franja, sin margen superior.
      estilos: "body{margin:0}p{margin:0}article{position:relative;width:210mm;height:297mm;overflow:hidden}",
      cuerpo:
        '<article><p>TEXTO QUE TIENE QUE SOBREVIVIR</p>' +
        "<script>document.body.textContent='BORRADO POR EL SCRIPT'</script></article>",
      formato: "A4",
      margenesMm: MARGENES_BOLETA_MM,
      // La marca de agua la pone `page.evaluate`, que va por el protocolo de depuración y NO se ve
      // afectado: si apareciera, el estampado sigue vivo con el JS del contenido apagado.
      marcaAgua: "CANARIO",
      paginasEsperadas: 1,
      selloPorPagina: null,
    };
    const [pdf] = await generador.generarLote([conScript], { timeoutMs: 60_000, chunk: 1 });
    const doc = await getDocumentProxy(new Uint8Array(pdf ?? new Uint8Array()));
    const { text } = await extractText(doc, { mergePages: true });
    expect(text).toContain("TEXTO QUE TIENE QUE SOBREVIVIR");
    expect(text).not.toContain("BORRADO POR EL SCRIPT");
    expect(text).toContain("CANARIO");
  }, 120_000);

  it("`generar()` de un documento suelto devuelve lo mismo que el lote de uno", async () => {
    const generador = crearGeneradorChromium({ rutaEjecutable: CHROMIUM });
    const uno = await generador.generar(solicitudesDeBoletas([vista])[0]!, { timeoutMs: 60_000 });
    const doc = await getDocumentProxy(new Uint8Array(uno));
    expect(doc.numPages).toBe(1);
    const { text } = await extractText(doc, { mergePages: true });
    expect(text.replace(/\s+/g, " ")).toContain(vista.totales.aPagar.texto);
  }, 120_000);

  it("y si un documento trajera una URL externa, se aborta antes de salir", async () => {
    const escapes: string[] = [];
    const generador = crearGeneradorChromium({
      rutaEjecutable: CHROMIUM,
      alAbortarRequest: (url) => escapes.push(url),
    });
    // El markup lo arma la plantilla y nunca emite URLs (ver `plantillas/boleta.test.ts`); acá se
    // fuerza el caso a mano para probar que la mitigación del §3.2 es real y no una intención.
    const conSsrf: DocumentoSolicitado = {
      estilos: "body{margin:0}",
      cuerpo: '<article><img src="http://169.254.169.254/latest/meta-data/"><p>hola</p></article>',
      formato: "A4",
      margenesMm: MARGENES_BOLETA_MM,
      marcaAgua: null,
      paginasEsperadas: 1,
      selloPorPagina: null,
    };
    const [pdf] = await generador.generarLote([conSsrf], { timeoutMs: 60_000, chunk: 1 });
    expect(pdf).toBeDefined();
    expect(escapes.some((u) => u.startsWith("http://169.254.169.254"))).toBe(true);
  }, 120_000);

  it("si un documento desborda su página, la emisión falla en vez de partir mal el lote", async () => {
    const generador = crearGeneradorChromium({ rutaEjecutable: CHROMIUM });
    const desbordado: DocumentoSolicitado = {
      estilos: "@page{size:A4;margin:0}",
      cuerpo: `<article>${"<p>línea</p>".repeat(400)}</article>`,
      formato: "A4",
      margenesMm: MARGENES_BOLETA_MM,
      marcaAgua: null,
      paginasEsperadas: 1,
      selloPorPagina: null,
    };
    await expect(generador.generarLote([desbordado], { timeoutMs: 60_000, chunk: 1 })).rejects.toThrow(
      /algo desbordó su página/,
    );
  }, 120_000);
});

describe.skipIf(CHROMIUM)("humo del PDF", () => {
  it("saltado: no hay Chromium instalado (definí CHROME_PATH)", () => {
    expect(CHROMIUM).toBeUndefined();
  });
});
