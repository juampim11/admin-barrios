/**
 * Adapter Chromium de `GeneradorDocumento` (ADR-0001 §3 y §3.1).
 *
 * **Este archivo lo importa SOLO el worker.** `apps/web` puede importar las plantillas y los
 * símbolos; si `puppeteer-core` entrara al bundle de Next, la imagen de la app se infla +734 MB y
 * volvemos al problema que el ADR evita. Lo verifica `../importaciones-web.test.ts`, que falla si
 * el grafo de importaciones de la web llega hasta acá.
 *
 * Tres cosas que hace este adapter y que no son detalles:
 *
 *  1. **Un pase por lote y split posterior.** Se arma UN documento con todas las boletas separadas
 *     por salto de página, se renderiza una vez y se parte con `pdf-lib`. Ahí vive la diferencia de
 *     6× medida en §2.1: el *subsetting* de fuentes se paga una vez para las N páginas, no N veces.
 *  2. **Red apagada.** Se intercepta cada request y se **aborta todo** lo que no sea `data:` o
 *     `about:blank`. Es la mitigación de SSRF/exfiltración de §3.2, y no es confianza: el adapter
 *     lleva la cuenta de lo que abortó y la expone para que un test la afirme.
 *  3. **La marca de agua la estampa acá**, sobre el DOM ya cargado y con estilos en línea que la
 *     plantilla no puede pisar (§10). No es un elemento del markup: es una capa que el renderizador
 *     agrega después.
 */

import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { printInk } from "@admin-barrios/design-tokens";
import { cssDeMargenes } from "../generador.ts";
import type { DocumentoSolicitado, GeneradorDocumento, OpcionesGeneracion, OpcionesLote } from "../generador.ts";

export type OpcionesChromium = {
  /** Ruta al Chromium de la imagen. Por defecto, `CHROME_PATH` o `PUPPETEER_EXECUTABLE_PATH`. */
  readonly rutaEjecutable?: string | undefined;
  /** Argumentos extra. Los de contenedor ya están puestos. */
  readonly argumentosExtra?: readonly string[];
  /** Se invoca por cada request abortado. Sirve para auditar que de verdad no sale nada. */
  readonly alAbortarRequest?: (url: string) => void;
  /**
   * Se invoca una vez por documento con marca de agua, con la geometría de la capa **ya estampada**.
   * Existe para que `test/marca-de-agua.test.ts` pueda afirmar que la marca no cruza el instrumento
   * sin tener que volver a maquetar la hoja por su cuenta — el bug que se busca vive justamente en
   * la diferencia entre lo que dice el CSS y lo que quedó en el DOM.
   */
  readonly alMedirMarcaDeAgua?: (medida: MedidaMarcaDeAgua) => void;
};

/** Todas las coordenadas en px de CSS, relativas al borde superior del `<article>`. */
export type MedidaMarcaDeAgua = {
  /** Borde inferior de la capa de marca de agua. */
  readonly marcaAbajo: number;
  /** Borde superior de la zona de exclusión del instrumento. */
  readonly exclusionArriba: number;
  /** Borde superior del primer símbolo de pago (el que una marca encima dejaría ilegible). */
  readonly simboloArriba: number;
  /** Alto del artículo. */
  readonly alto: number;
  /** Caja **ya rotada** de la leyenda, que es lo que de verdad pisa o no pisa al contenido. */
  readonly rotuloArriba: number;
  readonly rotuloAbajo: number;
  /** Cuántos rótulos protegidos quedaron cruzados por esa caja. Tiene que ser 0. */
  readonly rotulosCruzados: number;
};

/** Atributo con el que el renderizador marca su capa. La plantilla no lo conoce (ADR-0001 §10). */
export const MARCA_AGUA_ANCLA = "data-marca-agua";

/**
 * Atributo con el que la **plantilla** declara un rótulo que la marca de agua no puede cruzar.
 *
 * Es el mismo contrato que `[data-exclusion]`, un escalón más abajo: aquella zona no se toca porque
 * una marca encima del código de barras deja al vecino sin poder pagar; estos rótulos no se tocan
 * porque son la navegación de la hoja. Con la marca encima de "QUÉ CUBRE", el lector pierde el título
 * de la única zona que explica de dónde sale el número — y una muestra ilegible no demuestra nada.
 *
 * La plantilla **declara**; el renderizador **decide** dónde y de qué tamaño estampa (ADR-0001 §10).
 */
export const MARCA_LIBRE_ANCLA = "data-sin-marca";

/** Cuerpo máximo de la leyenda, en pt. Es el de siempre; de acá sólo se baja para que entre. */
const CUERPO_MARCA_PT = 26;

/**
 * Piso del cuerpo de la leyenda, en pt. Por debajo deja de cumplir su función y **conviene que pise
 * un rótulo antes que volverse un susurro**: el riesgo que cubre es que una muestra pase por
 * instrumento de pago.
 */
const CUERPO_MARCA_MIN_PT = 14;

/** Aire alrededor de cada rótulo protegido, en px de CSS (~1 mm). Rozarlo también es cruzarlo. */
const AIRE_ROTULO_PX = 4;

/** `--no-sandbox --disable-dev-shm-usage --disable-gpu`: operar Chromium en contenedor (§3.2). */
const ARGUMENTOS_CONTENEDOR = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  "--no-first-run",
  "--font-render-hinting=none",
] as const;

/**
 * Mediatypes que un `data:` puede declarar. Todo lo demás se aborta.
 *
 * No alcanza con exigir `data:`: un `data:text/html,…` en un `<iframe>` es un documento nuevo, y un
 * `data:application/javascript` es código. La lista blanca deja pasar **solo lo que la plantilla
 * necesita de verdad**: los logos y las fuentes embebidas (ADR-0001 §3.2). Los símbolos de pago no
 * entran acá porque van como SVG **en línea**, no como recurso.
 */
const MEDIATYPES_PERMITIDOS = [
  // Espejo exacto de `logoDocumentoSchema` (`shared/documentos/primitivas.ts`). Si el schema y el
  // interceptor divergen, gana el más laxo — así que se mantienen idénticos a mano y con este
  // comentario al lado.
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  // Espejo exacto de `fuenteEmbebidaSchema` (`plantillas/boleta.ts`). Nada de
  // `application/octet-stream`: en la práctica es un comodín para cualquier cosa.
  "font/woff2",
  "font/woff",
  "font/ttf",
] as const;

/** URLs que el renderizador tiene permitido cargar. Todo lo demás se aborta. */
export function permitida(url: string): boolean {
  if (url === "about:blank") return true;
  if (!url.startsWith("data:")) return false;
  const mediatype = url.slice("data:".length).split(/[;,]/, 1)[0]?.toLowerCase() ?? "";
  return (MEDIATYPES_PERMITIDOS as readonly string[]).includes(mediatype);
}

export function rutaChromiumPorDefecto(opciones: OpcionesChromium = {}): string {
  const ruta = opciones.rutaEjecutable ?? process.env["CHROME_PATH"] ?? process.env["PUPPETEER_EXECUTABLE_PATH"];
  if (!ruta) {
    throw new Error(
      "no hay Chromium: definí CHROME_PATH (en la imagen del worker lo instala el gestor de paquetes; " +
        "en CI, ubuntu-latest ya lo trae y no hay que descargar nada)",
    );
  }
  return ruta;
}

/** Corre `fn` con techo de tiempo. Con Chromium el race funciona: el render corre fuera de Node. */
async function conTimeout<T>(fn: () => Promise<T>, timeoutMs: number, escape: () => Promise<void>): Promise<T> {
  let reloj: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, rechazar) => {
        reloj = setTimeout(() => rechazar(new Error(`el render superó el techo de ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    await escape().catch(() => undefined);
    throw error;
  } finally {
    if (reloj) clearTimeout(reloj);
  }
}

/**
 * HTML de una pasada: un solo `<head>` con los estilos (una vez) y los N cuerpos concatenados.
 *
 * **El salto de página lo pone la plantilla**, con `page-break-after` sobre su propio contenedor —
 * el adapter no lo inyecta. Es a propósito (una plantilla puede querer un documento de dos páginas),
 * pero tiene una consecuencia que conviene tener presente: un `DocumentoSolicitado` de una plantilla
 * que no declare el salto se concatenaría en la misma página. Lo atrapa el chequeo de páginas de
 * `partir()`, que compara el total renderizado contra la suma de `paginasEsperadas`.
 *
 * Si un lote trajera estilos distintos entre documentos se emiten todos, deduplicados: es la puerta
 * abierta a mezclar plantillas en un lote sin que el adapter tenga que saber cuáles son.
 */
export function htmlDeLote(docs: readonly DocumentoSolicitado[]): string {
  const primero = docs[0];
  if (!primero) throw new Error("el lote está vacío");
  // Un lote comparte hoja: márgenes distintos en la misma pasada darían páginas de distinto tamaño
  // útil y el troquel dejaría de caer en el mismo lugar. Se corta acá, no se promedia.
  const distintos = docs.some((d) => JSON.stringify(d.margenesMm) !== JSON.stringify(primero.margenesMm));
  if (distintos) throw new Error("el lote mezcla documentos con márgenes distintos: se rendericen en pasadas separadas");

  const estilos = [...new Set(docs.map((d) => d.estilos))].join("\n");
  return [
    "<!doctype html>",
    '<html lang="es-AR"><head><meta charset="utf-8">',
    `<style>${cssDeMargenes(primero.margenesMm)}${estilos}</style>`,
    "</head><body>",
    docs.map((d) => d.cuerpo).join(""),
    "</body></html>",
  ].join("");
}

// El callback de `page.evaluate` corre **en el navegador**, no en Node. Se declaran acá los pocos
// tipos del DOM que necesita en vez de sumar `lib: DOM` a todo el paquete: si el paquete conociera
// `document`, un archivo de Node podría usarlo por accidente y fallar recién en producción.
type ElementoDom = {
  setAttribute(nombre: string, valor: string): void;
  getAttribute(nombre: string): string | null;
  textContent: string | null;
  readonly style: { position: string; fontSize: string; marginTop: string };
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  getBoundingClientRect(): { readonly top: number; readonly height: number };
  querySelector(selector: string): ElementoDom | null;
  querySelectorAll(selector: string): ArrayLike<ElementoDom>;
  appendChild(hijo: ElementoDom): void;
};
type VentanaDom = {
  document: { querySelectorAll(selector: string): ArrayLike<ElementoDom>; createElement(tag: string): ElementoDom };
};

/**
 * Estampa la marca de agua sobre cada `<article>`. Se ejecuta **después** de cargar el markup, con
 * estilos en línea `!important` y un elemento que la plantilla no conoce ni puede seleccionar: no
 * hay CSS de plantilla que lo apague (ADR-0001 §10).
 *
 * **Se detiene arriba de la zona de exclusión** (`[data-exclusion]`, doc 09 §E.6 y §E.12.12). El
 * motivo no es estético: una marca de agua cruzada sobre el código de barras baja su contraste y la
 * caja deja de leerlo, y una vista previa impresa por error con el símbolo tachado es un vecino que
 * **no puede pagar**. Si el documento no declara zona de exclusión, la capa cubre la hoja entera —
 * es el caso de una plantilla sin instrumento, donde no hay nada que proteger.
 *
 * **Y no cruza los rótulos que la plantilla declara con `[data-sin-marca]`.** Es el mismo criterio un
 * escalón más abajo: la leyenda se acomoda en el hueco más alto que dejan esos rótulos y, si no entra
 * a cuerpo pleno, se achica hasta entrar. El defecto que esto arregla se veía en la muestra emitida —
 * la diagonal caía justo sobre "QUÉ CUBRE"— y no era mala suerte: la capa centraba la leyenda en la
 * banda entera sin mirar qué había debajo, así que el rótulo que le tocara dependía de cuánto ocupara
 * el detalle de esa unidad.
 *
 * La opacidad y el cuerpo son los de una marca que **se lee y no domina**: tiene que impedir que una
 * muestra se confunda con un instrumento de pago, no comerse el documento que se está mostrando.
 */
async function estamparMarcasDeAgua(
  page: Page,
  textos: readonly (string | null)[],
  limites: { readonly maxPt: number; readonly minPt: number; readonly airePx: number },
): Promise<MedidaMarcaDeAgua[]> {
  return page.evaluate(
    (marcas: (string | null)[], lim: { maxPt: number; minPt: number; airePx: number }) => {
      const { document: doc } = globalThis as unknown as VentanaDom;
      const articulos = doc.querySelectorAll("article");
      const medidas: MedidaMarcaDeAgua[] = [];
      marcas.forEach((texto, i) => {
        if (texto === null) return;
        const contenedor = articulos[i];
        if (!contenedor) return;
        // El alto disponible se mide contra el DOM ya maquetado, no contra una constante: la zona de
        // exclusión cambia de tamaño con la variante de pago (doc 09 §E.10), y una medida fija dejaría
        // la marca cruzando el cupón en cuanto una administración cobre distinto.
        const exclusion = contenedor.querySelector("[data-exclusion]");
        const caja = contenedor.getBoundingClientRect();
        const arriba = caja.top;
        // Se ancla por `top`/`bottom` y **no por `height`**: el alto medido viene con decimales, y una
        // capa 0,01 px más alta que la hoja empuja una segunda página en blanco. Con `bottom:0` la
        // capa calza exacto por definición, sin depender del redondeo del layout.
        const desdeAbajo = exclusion ? Math.max(0, caja.top + caja.height - exclusion.getBoundingClientRect().top) : 0;
        const capa = doc.createElement("div");
        // Ancla de verificación: `test/marca-de-agua.test.ts` mide esta capa contra la zona de
        // exclusión. Sin un ancla, el test tendría que adivinar cuál de los `div` es la marca.
        capa.setAttribute("data-marca-agua", "");
        capa.setAttribute(
          "style",
          [
            "position:absolute !important",
            "left:0 !important",
            "right:0 !important",
            "top:0 !important",
            `bottom:${desdeAbajo}px !important`,
            "overflow:hidden !important",
            "display:flex !important",
            // `flex-start` y no `center`: la leyenda se ubica con un margen calculado, y con
            // `center` el navegador reparte ese margen entre arriba y abajo (queda a la mitad).
            "align-items:flex-start !important",
            "justify-content:center !important",
            "pointer-events:none !important",
            "z-index:2147483647 !important",
            "opacity:.10 !important",
            "visibility:visible !important",
            "font-family:sans-serif !important",
            "font-weight:700 !important",
            "color:#000 !important",
          ].join(";"),
        );
        const rotulo = doc.createElement("div");
        const estiloRotulo = (cuerpoPt: number, margenPx: number) =>
          rotulo.setAttribute(
            "style",
            [
              "transform:rotate(-28deg) !important",
              `font-size:${cuerpoPt}pt !important`,
              `margin-top:${margenPx}px !important`,
              "letter-spacing:.10em !important",
              "white-space:nowrap !important",
            ].join(";"),
          );
        estiloRotulo(lim.maxPt, 0);
        rotulo.textContent = texto;
        capa.appendChild(rotulo);
        contenedor.style.position = "relative";
        contenedor.appendChild(capa);

        // --- Dónde entra la leyenda ---------------------------------------------------------
        // Los rótulos protegidos parten la banda en huecos; se elige el más alto. `getBoundingClientRect`
        // de un elemento rotado ya devuelve la caja **rotada**, que es la que de verdad pisa contenido.
        const cajaCapa = capa.getBoundingClientRect();
        const bandaArriba = cajaCapa.top - arriba;
        const bandaAbajo = bandaArriba + cajaCapa.height;
        const protegidos = contenedor.querySelectorAll("[data-sin-marca]");
        const vetados: { a: number; b: number }[] = [];
        for (let k = 0; k < protegidos.length; k++) {
          const p = protegidos[k];
          if (!p) continue;
          const r = p.getBoundingClientRect();
          const a = Math.max(bandaArriba, r.top - arriba - lim.airePx);
          const b = Math.min(bandaAbajo, r.top - arriba + r.height + lim.airePx);
          if (b > a) vetados.push({ a, b });
        }
        vetados.sort((x, y) => x.a - y.a);

        // Barrido de izquierda a derecha quedándose con el hueco más alto. `mejor` arranca **vacío**:
        // si arrancara valiendo la banda entera, ningún hueco podría superarla y la leyenda volvería
        // a centrarse sobre todo el documento, que es el defecto que esto arregla. El centinela del
        // final cierra el último hueco (y cubre el caso sin rótulos protegidos: la banda entera).
        let mejor = { a: bandaArriba, b: bandaArriba };
        let cursor = bandaArriba;
        for (const v of [...vetados, { a: bandaAbajo, b: bandaAbajo }]) {
          if (v.a > cursor && v.a - cursor > mejor.b - mejor.a) mejor = { a: cursor, b: v.a };
          cursor = Math.max(cursor, v.b);
        }

        // --- Cuánto mide para entrar ---------------------------------------------------------
        const altoPleno = rotulo.getBoundingClientRect().height;
        const disponible = mejor.b - mejor.a;
        const cuerpo =
          altoPleno <= disponible
            ? lim.maxPt
            : Math.max(lim.minPt, Math.floor(((lim.maxPt * disponible) / altoPleno) * 10) / 10);
        if (cuerpo !== lim.maxPt) estiloRotulo(cuerpo, 0);

        const sinMargen = rotulo.getBoundingClientRect();
        const centroActual = sinMargen.top - arriba + sinMargen.height / 2;
        const margen = Math.max(0, (mejor.a + mejor.b) / 2 - centroActual);
        estiloRotulo(cuerpo, margen);

        const final = rotulo.getBoundingClientRect();
        const rotuloArriba = final.top - arriba;
        const rotuloAbajo = rotuloArriba + final.height;
        const rotulosCruzados = vetados.filter((v) => rotuloArriba < v.b && rotuloAbajo > v.a).length;

        const simbolo = contenedor.querySelector("[data-simbologia]");
        medidas.push({
          marcaAbajo: bandaAbajo,
          exclusionArriba: exclusion ? exclusion.getBoundingClientRect().top - arriba : Number.POSITIVE_INFINITY,
          simboloArriba: simbolo ? simbolo.getBoundingClientRect().top - arriba : Number.POSITIVE_INFINITY,
          alto: contenedor.getBoundingClientRect().height,
          rotuloArriba,
          rotuloAbajo,
          rotulosCruzados,
        });
      });
      return medidas;
    },
    textos as (string | null)[],
    limites as { maxPt: number; minPt: number; airePx: number },
  );
}

/**
 * Busca contenido que no entró en la caja que tiene reservada, **a lo alto y a lo ancho**.
 *
 * Las dos direcciones hicieron falta, y cada una la descubrió un PDF real:
 *
 *  - **Alto**: la zona del detalle tiene alto acotado y `overflow:hidden`, así que un concepto de
 *    más desaparecía sin decir nada — y el total de la zona 2 lo seguía sumando. Una cifra sin la
 *    línea que la explica es exactamente lo que la regla dura del proyecto prohíbe.
 *  - **Ancho**: el código de barras mide los 182 mm útiles enteros. Cuando compartía fila con el QR,
 *    el SVG se derramaba fuera de su contenedor y el QR —posterior en el DOM— **se imprimía encima
 *    del último 24 % del símbolo**. La hoja se veía impecable y un lector no leía nada: la falla
 *    silenciosa perfecta, del tipo que ADR-0001 §7.1 enumera.
 */
async function buscarDesbordes(page: Page, esperados: number): Promise<string[]> {
  return page.evaluate((cantidadEsperada: number) => {
    const { document: doc } = globalThis as unknown as VentanaDom;
    const problemas: string[] = [];
    const articulos = doc.querySelectorAll("article");

    // El lote se parte por posición, y la marca de agua se estampa por posición: si la cantidad de
    // artículos no es la de documentos pedidos, cualquier índice de acá en adelante es el de otro
    // vecino. Se corta antes de mirar nada más.
    if (articulos.length !== cantidadEsperada) {
      problemas.push(
        `el markup rindió ${articulos.length} artículos y se pidieron ${cantidadEsperada} documentos: ` +
          "no se puede aparear cada boleta con su lugar en el lote",
      );
      return problemas;
    }

    for (let i = 0; i < articulos.length; i++) {
      const articulo = articulos[i];
      if (!articulo) continue;
      const zonas = articulo.querySelectorAll("[data-desborde]");
      for (let j = 0; j < zonas.length; j++) {
        const zona = zonas[j];
        if (!zona) continue;
        const nombre = zona.getAttribute("data-desborde");
        // 1 px de tolerancia: el redondeo del layout no es un desborde.
        if (zona.scrollHeight > zona.clientHeight + 1) {
          problemas.push(
            `documento ${i + 1}: la zona "${nombre}" necesita ${zona.scrollHeight} px de alto y tiene ${zona.clientHeight} px`,
          );
        }
        if (zona.scrollWidth > zona.clientWidth + 1) {
          problemas.push(
            `documento ${i + 1}: la zona "${nombre}" necesita ${zona.scrollWidth} px de ancho y tiene ${zona.clientWidth} px ` +
              "(algo se está imprimiendo encima de otra cosa)",
          );
        }
      }
      if (articulo.scrollHeight > articulo.clientHeight + 1) {
        problemas.push(`documento ${i + 1}: el contenido no entra en la hoja`);
      }
    }
    return problemas;
  }, esperados);
}

/** 1 mm en puntos PostScript, que es la unidad en la que `pdf-lib` dibuja. */
function mmAPt(mm: number): number {
  return (mm * 72) / 25.4;
}

/** Cuerpo del folio, en pt. Coincide con `fontSizePrint.xs`, el piso del papel. */
const FOLIO_PT = 8;

/** Los mismos grados que usa la capa DOM, para que un borrador se vea igual por los dos caminos. */
const INCLINACION_MARCA = 28;

/** Qué fracción del ancho de la hoja ocupa la proyección horizontal de la marca de agua. */
const FRACCION_MARCA = 0.62;

function hexARgb(hex: string): ReturnType<typeof rgb> {
  // Con `#888` la conversión ingenua devolvía un color equivocado sin decir nada. Los tokens de
  // papel son todos de 6 dígitos, así que lo que hay que hacer con otra cosa es cortar.
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`color inválido para el sello: ${hex}`);
  const n = Number.parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export function crearGeneradorChromium(opciones: OpcionesChromium = {}): GeneradorDocumento {
  const ruta = rutaChromiumPorDefecto(opciones);

  async function abrirNavegador(): Promise<Browser> {
    return puppeteer.launch({
      executablePath: ruta,
      headless: true,
      args: [...ARGUMENTOS_CONTENEDOR, ...(opciones.argumentosExtra ?? [])],
    });
  }

  /** Renderiza una pasada y devuelve el PDF entero, sin partir. */
  async function renderizarPasada(
    navegador: Browser,
    docs: readonly DocumentoSolicitado[],
    timeoutMs: number,
  ): Promise<Uint8Array> {
    const page = await navegador.newPage();
    try {
      // **JavaScript apagado en el contenido.** La plantilla no tiene ni una línea de script: es
      // HTML y CSS. Apagarlo saca de la superficie todo lo que un `<script>` inyectado por un campo
      // de texto podría intentar, sin costar nada. `page.evaluate` sigue funcionando —corre por el
      // protocolo de depuración, no por el contenido—, así que el estampado de la marca de agua y
      // la verificación de desbordes no se ven afectados.
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        if (permitida(req.url())) void req.continue();
        else {
          opciones.alAbortarRequest?.(req.url());
          void req.abort();
        }
      });

      return await conTimeout(
        async () => {
          await page.setContent(htmlDeLote(docs), { waitUntil: "load", timeout: timeoutMs });

          const desbordes = await buscarDesbordes(page, docs.length);
          if (desbordes.length > 0) {
            throw new Error(
              `hay contenido que no entra y se perdería sin aviso: ${desbordes.join("; ")}. ` +
                "Antes que emitir una boleta con una cifra sin la línea que la explica, no se emite.",
            );
          }

          const medidas = await estamparMarcasDeAgua(
            page,
            docs.map((d) => d.marcaAgua),
            { maxPt: CUERPO_MARCA_PT, minPt: CUERPO_MARCA_MIN_PT, airePx: AIRE_ROTULO_PX },
          );
          for (const medida of medidas) opciones.alMedirMarcaDeAgua?.(medida);
          return page.pdf({
            format: "A4",
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
          });
        },
        timeoutMs,
        // El escape es cerrar la página: el job falla con el detalle y no queda un proceso colgado.
        async () => void (await page.close({ runBeforeUnload: false })),
      );
    } finally {
      if (!page.isClosed()) await page.close().catch(() => undefined);
    }
  }

  /** Parte el PDF del lote en un archivo por documento, respetando `paginasEsperadas`. */
  async function partir(pdfLote: Uint8Array, docs: readonly DocumentoSolicitado[]): Promise<Uint8Array[]> {
    // Un documento de paginación variable **no se puede partir por posición**: no hay número contra
    // el cual verificar dónde termina. Por eso renuncia al lote — y si alguien lo mezcla igual, se
    // corta acá antes de entregar media lista con el pie de otro barrio.
    if (docs.some((d) => d.paginasEsperadas === "variable")) {
      if (docs.length !== 1) {
        throw new Error(
          "un documento de paginación variable se renderiza solo: en lote no hay forma de saber " +
            "dónde termina uno y empieza el siguiente",
        );
      }
      return [pdfLote];
    }

    const origen = await PDFDocument.load(pdfLote);
    const esperadas = docs.reduce((a, d) => a + (d.paginasEsperadas === "variable" ? 0 : d.paginasEsperadas), 0);
    if (origen.getPageCount() !== esperadas) {
      // Falla cerrado: si el contenido desbordó, partir por posición entregaría boletas cortadas por
      // la mitad y con el cupón de otro vecino. Antes que eso, no se emite.
      throw new Error(
        `el lote renderizó ${origen.getPageCount()} páginas y se esperaban ${esperadas} ` +
          `(${docs.length} documentos): algo desbordó su página`,
      );
    }

    const salida: Uint8Array[] = [];
    let cursor = 0;
    for (const doc of docs) {
      const paginasDelDoc = doc.paginasEsperadas === "variable" ? 1 : doc.paginasEsperadas;
      const destino = await PDFDocument.create();
      const indices = Array.from({ length: paginasDelDoc }, (_, i) => cursor + i);
      const paginas = await destino.copyPages(origen, indices);
      for (const p of paginas) destino.addPage(p);
      salida.push(await destino.save());
      cursor += paginasDelDoc;
    }
    return salida;
  }

  /**
   * Estampa el folio y la marca de agua **en cada página**, sobre el PDF ya partido.
   *
   * Va acá y no en la plantilla por dos motivos que se resuelven juntos (ADR-0001 §10 ya fija el
   * criterio: la marca la pone el renderizador):
   *
   *  - **El folio no lo puede poner el CSS.** Chromium no implementa las cajas de margen de `@page`,
   *    así que no hay `counter(page)`; y `footerTemplate` de `page.pdf()` es por pasada, no por
   *    documento, así que en un lote imprimiría el pie del barrio equivocado.
   *  - **La capa DOM de marca de agua es una por `<article>`.** En un documento de seis páginas
   *    aparece una sola vez, en el medio de la tercera: las otras cinco se imprimen sin marca y se
   *    leen como definitivas. Es el peor caso de un documento que circula fotocopiado.
   */
  async function sellar(bytes: Uint8Array, doc: DocumentoSolicitado): Promise<Uint8Array> {
    const sello = doc.selloPorPagina;
    if (sello === null) return bytes;

    const pdf = await PDFDocument.load(bytes);
    const paginas = pdf.getPages();
    // Helvetica es una de las 14 fuentes base del formato: no se embebe ningún archivo y no sale
    // ningún request. El folio no es contenido del documento, es un sello del renderizador.
    const fuente = await pdf.embedFont(StandardFonts.Helvetica);
    const negrita = sello.marcaAgua === null ? fuente : await pdf.embedFont(StandardFonts.HelveticaBold);
    const tinta = hexARgb(printInk.textSecondary);

    paginas.forEach((pagina, i) => {
      const { width, height } = pagina.getSize();
      if (sello.numerarPaginas) {
        const texto = `Página ${i + 1} de ${paginas.length}`;
        const ancho = fuente.widthOfTextAtSize(texto, FOLIO_PT);
        // Alineado con **los márgenes del propio documento**, no con dos números escritos a mano: si
        // alguien mueve `margenesMm`, el folio se mueve con él. Y la línea de base va apenas por
        // encima del margen inferior, no a 6 mm del borde: `generador.ts` documenta que las
        // impresoras hogareñas tienen ~8–12 mm no imprimibles, y un folio que no se imprime en un
        // documento pensado para archivarse no sirve para nada.
        pagina.drawText(texto, {
          x: width - mmAPt(doc.margenesMm.right) - ancho,
          y: mmAPt(doc.margenesMm.bottom + 1.5),
          size: FOLIO_PT,
          font: fuente,
          color: tinta,
        });
      }
      if (sello.marcaAgua !== null) {
        // El cuerpo se **calcula** para que la diagonal ocupe siempre la misma fracción de la hoja.
        // Con un cuerpo fijo, `MUESTRA — SIN VALOR DE PAGO` entraba y una marca más larga cruzaba la
        // página entera de esquina a esquina, tapando cuatro columnas de dinero.
        const radianes = (INCLINACION_MARCA * Math.PI) / 180;
        const anchoObjetivo = (width * FRACCION_MARCA) / Math.cos(radianes);
        const cuerpo = Math.min(26, anchoObjetivo / negrita.widthOfTextAtSize(sello.marcaAgua, 1));
        const ancho = negrita.widthOfTextAtSize(sello.marcaAgua, cuerpo);
        pagina.drawText(sello.marcaAgua, {
          x: width / 2 - (ancho / 2) * Math.cos(radianes),
          y: height / 2 - (ancho / 2) * Math.sin(radianes),
          size: cuerpo,
          font: negrita,
          color: rgb(0, 0, 0),
          opacity: 0.1,
          rotate: degrees(INCLINACION_MARCA),
        });
      }
    });
    return pdf.save();
  }

  return {
    // Se persiste con el documento: una versión distinta de Chromium mide el texto distinto y
    // regenerar produciría un documento distinto del que se envió (ADR-0001 §6).
    motor: "chromium/puppeteer-core",

    async generar(doc, { timeoutMs }: OpcionesGeneracion) {
      const [uno] = await this.generarLote([doc], { timeoutMs, chunk: 1 });
      if (!uno) throw new Error("el motor no devolvió el documento");
      return uno;
    },

    async generarLote(docs, { timeoutMs, chunk }: OpcionesLote) {
      if (docs.length === 0) return [];
      if (chunk < 1) throw new Error("el chunk tiene que ser al menos 1");

      // Navegador **efímero por job**: se abre, se usa y se cierra. Nada de procesos que sobreviven.
      const navegador = await abrirNavegador();
      try {
        const salida: Uint8Array[] = [];
        for (let i = 0; i < docs.length; i += chunk) {
          const pedazo = docs.slice(i, i + chunk);
          const pdfLote = await renderizarPasada(navegador, pedazo, timeoutMs);
          const partes = await partir(pdfLote, pedazo);
          for (const [j, parte] of partes.entries()) {
            const doc = pedazo[j];
            // Falla cerrado, como el resto del adapter. Hoy el apareo `partes[j] ↔ pedazo[j]` es
            // correcto por construcción, pero si alguna vez dejara de serlo, ese archivo saldría
            // **sin sellar**: un listado nominado sin la marca de uso interno y sin folio.
            if (!doc) throw new Error(`el lote rindió ${partes.length} partes y se pidieron ${pedazo.length} documentos`);
            salida.push(await sellar(parte, doc));
          }
        }
        return salida;
      } finally {
        await navegador.close().catch(() => undefined);
      }
    },
  };
}
