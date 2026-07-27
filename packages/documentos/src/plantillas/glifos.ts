/**
 * Glifos geométricos de la hoja, **dibujados en SVG en línea**.
 *
 * Por qué no un emoji ni una fuente de íconos, y por qué no es una preferencia estética:
 *
 *  - **La red está apagada en el renderizador** (ADR-0001 §3.2): una fuente de íconos por URL no
 *    cargaría, y un `data:` de una fuente entera para seis figuras es peso muerto en cada boleta.
 *  - **Un glifo que la fuente no tiene se renderiza como NADA** (doc 07 §B). La marca de la banda es
 *    justo lo que doc 09 §E.8.3 exige que sobreviva a la escala de grises y a la fotocopia: si
 *    desaparece, la banda queda comunicando **solo por color**, que es lo que la regla prohíbe.
 *  - Los emojis, además, salen a color y con el estilo de la plataforma: en un documento que se
 *    fotocopia eso es una mancha, no una señal.
 *
 * Se dibujan en un `viewBox` de 16 × 16 y en `currentColor`, así el tamaño y la tinta los decide el
 * CSS de la zona que los usa y no hay un segundo lugar donde configurar color.
 */

import type { BandaEstado } from "@admin-barrios/shared/documentos";

/** El trazo, en unidades del `viewBox` de 16. A 3,5 mm impresos da ~0,5 mm de línea: sobrevive al fax. */
const TRAZO = 2.1;

const COMUN = `fill="none" stroke="currentColor" stroke-width="${TRAZO}" stroke-linecap="round" stroke-linejoin="round"`;

/**
 * Un dibujo por marca de banda. Las claves son las de `MARCAS_BANDA` (`shared/documentos`): el
 * modelo de vista manda una **clave semántica**, nunca un carácter, y acá se resuelve a figura.
 */
const DIBUJOS: Record<BandaEstado["marca"], string> = {
  // ✓ al día — la pera del tilde bien abierta para que no se confunda con una "v" a 3 mm.
  ok: `<path d="M3 8.6 L6.4 12 L13 4.6" ${COMUN}/>`,
  // ! saldo anterior — signo de admiración dentro de un triángulo: dos formas, no una.
  atencion:
    `<path d="M8 2.2 L14.8 13.8 H1.2 Z" ${COMUN}/>` +
    `<path d="M8 6.2 V9.4" ${COMUN}/><circle cx="8" cy="11.9" r="1" fill="currentColor"/>`,
  // ★ bonificación — estrella llena: a 3 mm una estrella de contorno se empasta.
  estrella: `<path d="M8 1.6 L10 6.2 L15 6.7 L11.3 10 L12.4 14.9 L8 12.3 L3.6 14.9 L4.7 10 L1 6.7 L6 6.2 Z" fill="currentColor"/>`,
  // i informativo — círculo con la barra y el punto separados.
  info:
    `<circle cx="8" cy="8" r="6.4" ${COMUN}/>` +
    `<path d="M8 7.4 V11.4" ${COMUN}/><circle cx="8" cy="4.7" r="1.05" fill="currentColor"/>`,
  // ? pendiente de definición — el arco y el punto, sin depender de ninguna tipografía.
  pregunta:
    `<circle cx="8" cy="8" r="6.4" ${COMUN}/>` +
    `<path d="M5.9 6.1 A2.3 2.3 0 1 1 8.3 8.9 V10" ${COMUN}/>` +
    `<circle cx="8.3" cy="12.2" r="1.05" fill="currentColor"/>`,
  // ▢ vista previa — cuadro punteado: se lee como "todavía no es definitivo".
  borrador: `<rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1.4" ${COMUN} stroke-dasharray="2.6 2.2"/>`,
};

/**
 * La marca de una banda, como SVG en línea.
 *
 * `aria-hidden` no es decorativo por descuido: la palabra y la cifra van **siempre** al lado
 * (doc 09 §E.8.3), así que el dibujo es redundante por diseño y no lleva información propia.
 */
export function glifoBanda(marca: BandaEstado["marca"], claseCss = "glifo"): string {
  return (
    `<svg class="${claseCss}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">` +
    DIBUJOS[marca] +
    "</svg>"
  );
}

/**
 * La tijera del troquel. Es uno de los dos únicos agregados permitidos alrededor del instrumento
 * (doc 09 §E.6): orienta el corte y **no entra en el rectángulo del instrumento**.
 */
export function glifoTijera(claseCss = "tijera"): string {
  return (
    `<svg class="${claseCss}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">` +
    `<path d="M4.9 11.4 L12.6 2.4 M11.1 11.4 L3.4 2.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>` +
    `<circle cx="3.6" cy="12.7" r="1.9" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
    `<circle cx="12.4" cy="12.7" r="1.9" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
    "</svg>"
  );
}
