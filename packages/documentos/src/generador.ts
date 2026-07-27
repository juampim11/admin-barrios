/**
 * `GeneradorDocumento` — el motor detrás de una interfaz (ADR-0001 §4.2).
 *
 * Nada del negocio conoce Chromium. El adapter concreto vive en `./adapters/chromium.ts` y
 * **solo lo importa el worker**: si `puppeteer-core` entrara al bundle de Next, la imagen de la app
 * se infla y volvemos al problema que el ADR evita (regla verificada en
 * `src/importaciones-web.test.ts`).
 */

import { z } from "zod";

/** Márgenes en milímetros. Los de la boleta salen del presupuesto vertical de doc 09 §E.2.2. */
export const margenesMmSchema = z
  .object({
    top: z.number().min(0),
    right: z.number().min(0),
    /** Nunca menos de 10 mm: las impresoras hogareñas tienen ~8–12 mm no imprimibles, y un código
     *  de barras a 6 mm del borde sale cortado y no lo lee ninguna caja (doc 09 §E.2.2). */
    bottom: z.number().min(0),
    left: z.number().min(0),
  })
  .readonly();
export type MargenesMm = z.infer<typeof margenesMmSchema>;

/**
 * Un documento pedido al motor.
 *
 * **El markup viene partido en `estilos` + `cuerpo`, no en un `html` único** (ADR-0001 §4.2 lo
 * ilustra como una sola cadena). El motivo es la razón de ser de esta decisión: el lote se renderiza
 * en **una sola pasada**, así que las hojas de estilo y las fuentes se declaran **una vez para las N
 * boletas** — que es exactamente de dónde salen los 39 ms por boleta contra los 725 de un render
 * suelto. Con un `<html>` completo por documento habría que recortarlo con expresiones regulares
 * para poder concatenarlo, que es peor. Para el email y la vista web está `htmlCompleto()`.
 */
export const documentoSolicitadoSchema = z
  .object({
    /** CSS del documento. Idéntico entre boletas del mismo lote: se emite una sola vez. */
    estilos: z.string().min(1),
    /** Fragmento HTML del documento (un `<article>`), ya escapado. */
    cuerpo: z.string().min(1),
    formato: z.literal("A4"),
    margenesMm: margenesMmSchema,
    /**
     * Texto de la marca de agua, o `null`. **No lo decide la plantilla**: lo pone
     * `solicitudDeBoleta()` a partir de `bloquePago.sinValorDePago`, y lo estampa el renderizador
     * sobre el DOM ya cargado (ADR-0001 §10).
     */
    marcaAgua: z.string().min(1).nullable(),
    /**
     * Cuántas páginas tiene que ocupar este documento. Es lo que permite partir el PDF del lote sin
     * adivinar: si el total de páginas renderizadas no coincide con la suma de este campo, algo
     * desbordó y **la emisión falla** en vez de entregar boletas cortadas por la mitad.
     *
     * `"variable"` es para los documentos cuya cantidad de páginas **depende del dato** y no del
     * diseño: un listado de saldos pendientes tiene tantas páginas como unidades tenga el barrio, y
     * exigirle un número sería inventarlo. **Renuncia al lote**: un documento de paginación variable
     * se renderiza solo, porque sin la cuenta de páginas no hay forma de saber dónde termina uno y
     * empieza el siguiente — y partir por posición entregaría media lista con el pie de otro barrio.
     * El adapter lo hace cumplir; no es una convención.
     */
    paginasEsperadas: z.union([z.number().int().positive(), z.literal("variable")]),
    /**
     * Lo que el renderizador estampa **en cada página**, después de renderizar.
     *
     * Existe porque la marca de agua del DOM (`marcaAgua`) es una capa por `<article>`: en un
     * documento de seis páginas aparece **una sola vez, en el medio de la tercera**, y las otras
     * cinco se imprimen sin marca y se leen como definitivas. Y porque el folio (`Página N de M`) no
     * lo puede poner ni la plantilla ni el CSS: Chromium no implementa las cajas de margen de
     * `@page`, y el `footerTemplate` de `page.pdf()` es **por pasada**, así que en un lote imprimiría
     * el pie del documento equivocado.
     *
     * `null` = no se estampa nada. Es el caso de la boleta, que es de una página y ya trae su marca
     * de agua por el camino del DOM.
     */
    selloPorPagina: z
      .object({
        /** Marca de agua repetida en **todas** las páginas, o `null`. */
        marcaAgua: z.string().min(1).nullable(),
        /** Estampa `Página N de M` abajo a la derecha, dentro del margen inferior. */
        numerarPaginas: z.boolean(),
      })
      .readonly()
      .nullable(),
  })
  .readonly();
export type DocumentoSolicitado = z.infer<typeof documentoSolicitadoSchema>;

export type OpcionesGeneracion = {
  /** Techo duro por pasada. Con Chromium el `Promise.race` sí funciona: el render corre fuera de Node. */
  readonly timeoutMs: number;
};

export type OpcionesLote = OpcionesGeneracion & {
  /** Boletas por pasada. 50 es el dial de memoria medido: ~520 MB contra ~780 MB con 200. */
  readonly chunk: number;
};

export interface GeneradorDocumento {
  /** `"chromium/150"`. Se persiste con el documento: una versión distinta mide el texto distinto. */
  readonly motor: string;
  /** Un documento. */
  generar(doc: DocumentoSolicitado, opciones: OpcionesGeneracion): Promise<Uint8Array>;
  /**
   * Un lote: **una sola pasada del motor**, un PDF por elemento de entrada, en el mismo orden.
   *
   * Está en la interfaz a propósito: es donde vive la diferencia de 6× medida en ADR-0001 §2.1. Un
   * adapter que no sepa lotear (el plan B) lo implementa como un `for` sin que el llamador cambie.
   */
  generarLote(docs: readonly DocumentoSolicitado[], opciones: OpcionesLote): Promise<Uint8Array[]>;
}

/**
 * Los márgenes, como CSS.
 *
 * `@page` va con `margin:0` y el margen real lo pone el `padding` de la hoja: es lo que permite que
 * la franja de acento salga **a sangre** sobre el margen superior (doc 09 §E.2.3) sin que la
 * plantilla tenga que conocer el número. Las variables son la única fuente: si alguien cambia
 * `margenesMm`, la franja se corre con él.
 */
export function cssDeMargenes(margenes: MargenesMm): string {
  return (
    "@page{size:A4;margin:0}" +
    `:root{--m-top:${margenes.top}mm;--m-right:${margenes.right}mm;--m-bottom:${margenes.bottom}mm;--m-left:${margenes.left}mm}`
  );
}

/** Documento HTML autónomo, para el email y para la vista web. Mismo markup que el PDF. */
export function htmlCompleto(doc: DocumentoSolicitado, titulo: string): string {
  return [
    "<!doctype html>",
    '<html lang="es-AR"><head><meta charset="utf-8">',
    `<title>${titulo.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"))}</title>`,
    `<style>${cssDeMargenes(doc.margenesMm)}${doc.estilos}</style>`,
    "</head><body>",
    doc.cuerpo,
    "</body></html>",
  ].join("");
}
