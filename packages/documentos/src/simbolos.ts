/**
 * El renderizador de símbolos de pago (ADR-0001 §7).
 *
 * **La geometría la impone este módulo, no el adapter de cobranza.** El adapter decide simbología,
 * carga y dígito verificador —lo que depende del convenio—; el ancho de módulo, la zona muda, el
 * fondo y la proporción los decide acá. Así **todo adapter futuro hereda gratis** las tres guardas
 * de abajo, en vez de depender de que cada convenio nuevo se acuerde de copiarlas.
 *
 * Las tres fallas silenciosas medidas en ADR-0001 §7.1 — ninguna tira error sola, las tres terminan
 * en un vecino que no puede pagar en la caja:
 *
 *  1. **Fondo transparente.** Es el default de `bwip-js`. El mismo símbolo con fondo transparente
 *     **no se lee**; con `#FFFFFF` lee perfecto. Acá el fondo blanco es forzado y **no hay
 *     parámetro** para cambiarlo.
 *  2. **Cantidad impar de dígitos en Interleaved 2 of 5.** I2of5 codifica de a pares: con 55 dígitos
 *     `bwip-js` genera **sin error** y **antepone un `0` en silencio**, así que el símbolo codifica
 *     un número distinto del que está impreso debajo. Verificado en este repo: `1234567` produce el
 *     símbolo **byte a byte idéntico** a `01234567`, y el lector devuelve `01234567`. Acá se
 *     rechaza explícitamente.
 *  3. **Escalado de impresión.** Un símbolo correcto reducido por el "ajustar a página" del diálogo
 *     de impresión deja de leerse. El SVG sale con el ancho declarado en **milímetros fijos**, y si
 *     no entra en el ancho útil con el piso de X-dimension, **falla la emisión**.
 */

import { toSVG } from "bwip-js/node";
import type { InstrumentoSimbolo, Simbologia } from "@admin-barrios/shared/documentos";

/** Nombre de la simbología en BWIPP. */
const BCID: Record<Simbologia, string> = {
  interleaved2of5: "interleaved2of5",
  code128: "code128",
  qrcode: "qrcode",
};

export type GeometriaSimbolo = {
  /** X-dimension preferida, en mm. Es la que se usa si el símbolo entra. */
  readonly anchoModuloPreferidoMm: number;
  /** **Piso duro**: por debajo de esto no se emite, aunque entrara en la hoja. */
  readonly anchoModuloMinimoMm: number;
  /** Zona muda a izquierda y derecha, en mm. Doc 09 §E.6: ≥ 5 mm en el cupón; 4 mm en el QR. */
  readonly zonaMudaMm: number;
  /**
   * Zona muda arriba y abajo, en mm. En un código lineal el lector barre en horizontal, así que
   * arriba y abajo alcanza con separarlo del texto vecino; en el QR es simétrica y sí hace falta.
   */
  readonly zonaMudaVerticalMm: number;
  /** Alto de las barras, en mm. En el QR el alto lo fija el lado (es cuadrado). */
  readonly altoMm: number;
};

/**
 * La tabla de geometría del producto. **No es configurable por barrio ni por plantilla**: es lo que
 * hace que el símbolo de cualquier convenio futuro salga legible en una caja.
 */
export const GEOMETRIA: Readonly<Record<Simbologia, GeometriaSimbolo>> = {
  interleaved2of5: { anchoModuloPreferidoMm: 0.33, anchoModuloMinimoMm: 0.25, zonaMudaMm: 5, zonaMudaVerticalMm: 1, altoMm: 13 },
  code128: { anchoModuloPreferidoMm: 0.33, anchoModuloMinimoMm: 0.25, zonaMudaMm: 5, zonaMudaVerticalMm: 1, altoMm: 12 },
  // El QR se lee desde papel láser con un teléfono: mínimo 25 × 25 mm de lado y 4 mm de zona muda
  // (doc 09 §E.10.1, variante P4).
  //
  // OJO con el número: en las simbologías lineales el ancho del `viewBox` de bwip-js es la cantidad
  // de módulos, pero en `qrcode` son **2 unidades por celda real** (medido: 42 unidades para un QR
  // de 21 × 21). O sea que `0.6` acá es una celda de 1,2 mm, no de 0,6. La salida es correcta —el
  // lado total y el piso de 25 mm se calculan sobre las mismas unidades—, pero el "piso de
  // X-dimension" del QR está expresado en media celda y no en celda. Anotado para que un adapter
  // futuro no lo lea como si fuera el mismo número que el de las lineales.
  qrcode: { anchoModuloPreferidoMm: 0.45, anchoModuloMinimoMm: 0.4, zonaMudaMm: 4, zonaMudaVerticalMm: 4, altoMm: 0 },
};

/** Lado mínimo del QR impreso, en mm (doc 09 §E.10.1). */
export const LADO_MINIMO_QR_MM = 25;

// --- Compuerta 1: la carga ----------------------------------------------------------------------

/**
 * Valida la carga contra el alfabeto y la estructura de su simbología. **Es la misma función que
 * usa `MedioCobranza.verificar()`**: la compuerta de construcción y la de render no pueden
 * discrepar sobre qué es una carga válida.
 *
 * @returns lista de motivos. Vacía = la carga es válida.
 */
export function revisarCargaSimbolo(simbologia: Simbologia, carga: string): string[] {
  const motivos: string[] = [];
  if (carga.length === 0) motivos.push("la carga está vacía");

  if (simbologia === "interleaved2of5") {
    if (!/^\d+$/.test(carga)) motivos.push("Interleaved 2 of 5 solo codifica dígitos");
    if (carga.length % 2 !== 0) {
      motivos.push(
        `Interleaved 2 of 5 codifica de a pares y la carga tiene ${carga.length} dígitos (impar): ` +
          "la librería antepondría un 0 en silencio y el símbolo codificaría un número distinto del impreso",
      );
    }
  }

  if (simbologia === "code128" && !/^[\x20-\x7e]+$/.test(carga)) {
    motivos.push("Code 128 solo codifica ASCII imprimible en esta plantilla");
  }

  if (simbologia === "qrcode" && carga.length > 2000) {
    motivos.push("el payload del QR es demasiado largo para leerse desde papel impreso");
  }

  return motivos;
}

// --- Compuerta 3: la geometría ------------------------------------------------------------------

export type SimboloRenderizado = {
  /** SVG con `width`/`height` declarados en **milímetros fijos** y fondo blanco opaco. */
  readonly svg: string;
  readonly anchoMm: number;
  readonly altoMm: number;
  /** X-dimension efectivamente usada. */
  readonly anchoModuloMm: number;
  readonly zonaMudaMm: number;
  /** Módulos del símbolo, sin la zona muda. Lo reporta el propio generador, no se estima. */
  readonly modulos: number;
};

/** Lee el `viewBox` del SVG que produce `bwip-js` a escala 1: ancho = cantidad de módulos. */
function leerViewBox(svg: string): { ancho: number; alto: number } {
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  const ancho = Number(m?.[1]);
  const alto = Number(m?.[2]);
  if (!m || !Number.isFinite(ancho) || !Number.isFinite(alto) || ancho <= 0) {
    // Falla cerrado: si no se puede medir el símbolo, no se puede garantizar que entre en la hoja.
    throw new Error("no se pudo medir el símbolo generado (viewBox ausente o ilegible)");
  }
  return { ancho, alto };
}

/** Contenido del `<svg>` de bwip-js, sin su etiqueta raíz. */
function contenidoDe(svg: string): string {
  const abre = svg.indexOf(">");
  const cierra = svg.lastIndexOf("</svg>");
  if (abre < 0 || cierra < 0) throw new Error("el símbolo generado no es un SVG reconocible");
  return svg.slice(abre + 1, cierra);
}

/**
 * Dibuja el instrumento como **SVG vectorial**, con fondo blanco forzado y ancho en milímetros.
 *
 * SVG y no imagen: es nítido a cualquier DPI de impresora, no agrega un request de red (la red está
 * apagada en el renderizador) y el ancho se declara en la unidad en la que un lector láser falla o
 * no falla.
 *
 * @param anchoUtilMm Ancho útil de la hoja. Si el símbolo no entra ni con el piso de X-dimension,
 *   **se lanza**: antes que emitir un código que la caja no va a leer.
 */
export function renderizarSimbolo(
  instrumento: InstrumentoSimbolo,
  opciones: { readonly anchoUtilMm: number },
): SimboloRenderizado {
  const motivos = revisarCargaSimbolo(instrumento.simbologia, instrumento.carga);
  if (motivos.length > 0) {
    throw new Error(`carga inválida para ${instrumento.simbologia}: ${motivos.join("; ")}`);
  }

  const esQr = instrumento.simbologia === "qrcode";
  const geo = GEOMETRIA[instrumento.simbologia];

  const svgCrudo = toSVG({
    bcid: BCID[instrumento.simbologia],
    text: instrumento.carga,
    scale: 1,
    // **Al QR no se le pasa `height`.** Con `height` bwip-js devuelve una matriz de 58 × 71 módulos
    // para un símbolo que es cuadrado: escalarla a un cuadrado deforma los módulos y el teléfono
    // deja de leerlo. El alto del QR lo fija su propio lado.
    ...(esQr ? {} : { height: geo.altoMm }),
    includetext: false,
    // GUARDA 1 — fondo blanco opaco. No es un parámetro de la plantilla ni del adapter: el default
    // de bwip-js es transparente, y con fondo transparente el símbolo NO SE LEE.
    backgroundcolor: "FFFFFF",
    barcolor: "000000",
    // La zona muda se agrega en mm más abajo; acá el símbolo sale pelado para poder medirlo.
    paddingwidth: 0,
    paddingheight: 0,
  });

  const { ancho: modulos, alto: modulosAlto } = leerViewBox(svgCrudo);

  // GUARDA 3 — la geometría tiene que entrar en el ancho útil, con el piso de X-dimension.
  const anchoConModulo = (mm: number) => modulos * mm + 2 * geo.zonaMudaMm;
  let anchoModuloMm = geo.anchoModuloPreferidoMm;
  if (anchoConModulo(anchoModuloMm) > opciones.anchoUtilMm) {
    // Se achica hasta lo que entre, nunca por debajo del piso.
    anchoModuloMm = (opciones.anchoUtilMm - 2 * geo.zonaMudaMm) / modulos;
  }
  if (anchoModuloMm < geo.anchoModuloMinimoMm) {
    throw new Error(
      `el símbolo ${instrumento.simbologia} de ${instrumento.carga.length} caracteres necesita ` +
        `${anchoConModulo(geo.anchoModuloMinimoMm).toFixed(1)} mm con el piso de X-dimension ` +
        `(${geo.anchoModuloMinimoMm} mm) y el ancho útil es ${opciones.anchoUtilMm} mm: no se emite un ` +
        "código que la caja no va a leer",
    );
  }

  // Un QR con poco payload tiene pocos módulos y saldría diminuto: se **agranda** hasta el lado
  // mínimo, no se rechaza. El piso de módulo es para que no salga demasiado chico; el lado mínimo
  // es para que un teléfono lo lea desde papel impreso, y se cumplen los dos subiendo la escala.
  if (esQr && modulos * anchoModuloMm < LADO_MINIMO_QR_MM) {
    anchoModuloMm = LADO_MINIMO_QR_MM / modulos;
  }

  const anchoSimboloMm = modulos * anchoModuloMm;
  const altoMm = esQr ? anchoSimboloMm : geo.altoMm;
  if (anchoSimboloMm + 2 * geo.zonaMudaMm > opciones.anchoUtilMm) {
    throw new Error(
      `el símbolo ${instrumento.simbologia} necesita ${(anchoSimboloMm + 2 * geo.zonaMudaMm).toFixed(1)} mm ` +
        `y el ancho útil es ${opciones.anchoUtilMm} mm`,
    );
  }

  const anchoTotalMm = anchoSimboloMm + 2 * geo.zonaMudaMm;
  const altoTotalMm = altoMm + 2 * geo.zonaMudaVerticalMm;
  const mm = (n: number) => n.toFixed(3);

  // El SVG se arma en unidades de milímetro y el símbolo va anidado con su propio `viewBox`: la
  // zona muda queda **dentro del rectángulo blanco del propio símbolo**, así nada se le puede poner
  // al costado por un accidente de layout, y el ancho impreso no depende del CSS que lo rodee.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mm(anchoTotalMm)}mm" height="${mm(altoTotalMm)}mm" ` +
    `viewBox="0 0 ${mm(anchoTotalMm)} ${mm(altoTotalMm)}" shape-rendering="crispEdges">` +
    // GUARDA 1, otra vez y explícita: fondo blanco opaco en toda la caja, zona muda incluida.
    `<rect x="0" y="0" width="${mm(anchoTotalMm)}" height="${mm(altoTotalMm)}" fill="#FFFFFF"/>` +
    `<svg x="${mm(geo.zonaMudaMm)}" y="${mm(geo.zonaMudaVerticalMm)}" width="${mm(anchoSimboloMm)}" height="${mm(altoMm)}" ` +
    `viewBox="0 0 ${modulos} ${modulosAlto}" preserveAspectRatio="none">${contenidoDe(svgCrudo)}</svg>` +
    "</svg>";

  return {
    svg,
    anchoMm: anchoTotalMm,
    altoMm: altoTotalMm,
    anchoModuloMm,
    zonaMudaMm: geo.zonaMudaMm,
    modulos,
  };
}
