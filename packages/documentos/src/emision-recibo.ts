/**
 * De `VistaRecibo` a `DocumentoSolicitado` — el mismo camino que `emision.ts` traza para la boleta.
 *
 * **Sin la salvaguarda de marca de agua de `solicitudDeBoleta()`**, y no por descuido: esa
 * salvaguarda existe porque una boleta lleva un instrumento de pago (código de barras, QR, cupón) que
 * un tercero podría confundir con uno real (ADR-0001 §10). Un recibo no lleva nada de eso — confirma
 * un pago que ya ocurrió, no ofrece una forma de pagar — así que no hay nada que estampar.
 */

import { parsearVistaRecibo, type VistaRecibo } from "@admin-barrios/shared/documentos";
import type { DocumentoSolicitado } from "./generador.ts";
import { MARGENES_BOLETA_MM } from "./emision.ts";
import type { FuenteEmbebida } from "./plantillas/comun.ts";
import { cuerpoRecibo, estilosRecibo } from "./plantillas/recibo.ts";

export type OpcionesSolicitudRecibo = {
  readonly fuentes?: readonly FuenteEmbebida[];
};

/**
 * Arma la solicitud de **un** recibo.
 *
 * @param vista Se re-valida acá aunque venga tipada: es el borde por el que un documento entra a
 *   renderizarse, mismo criterio que `solicitudDeBoleta()`.
 */
export function solicitudDeRecibo(vista: VistaRecibo, opciones: OpcionesSolicitudRecibo = {}): DocumentoSolicitado {
  const v = parsearVistaRecibo(vista);

  return {
    estilos: estilosRecibo(opciones.fuentes ?? []),
    cuerpo: cuerpoRecibo(v),
    formato: "A4",
    // Mismos márgenes que la boleta (doc 09 §E.2.2) — reusados por IMPORTACIÓN directa, no copiados:
    // si el día de mañana cambian, los dos documentos se mueven juntos, sin un segundo lugar que
    // alguien se tenga que acordar de tocar.
    margenesMm: MARGENES_BOLETA_MM,
    marcaAgua: null,
    paginasEsperadas: 1,
    // El recibo es de una página: no hay nada que sellar página por página, y numerar
    // "Página 1 de 1" es ruido (mismo criterio que la boleta).
    selloPorPagina: null,
  };
}

/** Arma el lote. Todos los recibos comparten los mismos estilos: una pasada, un juego de fuentes. */
export function solicitudesDeRecibos(
  vistas: readonly VistaRecibo[],
  opciones: OpcionesSolicitudRecibo = {},
): DocumentoSolicitado[] {
  return vistas.map((v) => solicitudDeRecibo(v, opciones));
}
