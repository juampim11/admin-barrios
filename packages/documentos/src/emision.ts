/**
 * De `VistaBoleta` a `DocumentoSolicitado`.
 *
 * Es **el único camino** por el que una boleta llega al motor, y por eso acá vive la salvaguarda del
 * ADR-0001 §10: cuando el medio de cobranza resuelto declara `sinValorDePago`, la marca de agua
 * `MUESTRA — SIN VALOR DE PAGO` **no es opcional y no se puede apagar**. No hay parámetro que la
 * desactive, la plantilla no la conoce, y quien la estampa es el renderizador sobre el DOM ya
 * cargado. Un documento con un código de barras legible y un importe se parece demasiado a un
 * instrumento de pago real como para que esa marca dependa de que alguien se acuerde de activarla.
 */

import { parsearVistaBoleta, type VistaBoleta } from "@admin-barrios/shared/documentos";
import { registroPorDefecto } from "./cobranza/index.ts";
import type { RegistroMediosCobranza } from "./cobranza/medio-cobranza.ts";
import type { DocumentoSolicitado, MargenesMm } from "./generador.ts";
import { cuerpoBoleta, estilosBoleta, type FuenteEmbebida } from "./plantillas/boleta.ts";

/** El texto exacto. No es configurable por cliente ni por plantilla. */
export const MARCA_MUESTRA = "MUESTRA — SIN VALOR DE PAGO";

/** Doc 09 §E.2.2. El inferior nunca baja de 10 mm: zona no imprimible de las impresoras hogareñas. */
export const MARGENES_BOLETA_MM: MargenesMm = { top: 12, right: 14, bottom: 10, left: 14 };

/**
 * Arma la solicitud de **una** boleta.
 *
 * @param vista Se re-valida acá aunque venga tipada: es el borde por el que un documento entra a
 *   renderizarse, y una vista armada a mano en un script o traída de `documento_liquidacion.vista`
 *   tiene que pasar por los mismos invariantes de dinero que una recién calculada.
 */
export type OpcionesSolicitud = {
  readonly fuentes?: readonly FuenteEmbebida[];
  /**
   * Registro de adapters de cobranza. Se usa para **re-verificar el bloque de pago acá**, y no solo
   * cuando se arma: la re-emisión desde una vista congelada (`documento_liquidacion.vista`) entra
   * por este camino sin pasar por ningún adapter, así que sin esto un bloque de demostración al que
   * alguien le apagó `sinValorDePago` saldría **sin marca de agua**, con su código de barras intacto.
   * **Falla cerrado**: si la clave del medio no está registrada, no se renderiza.
   */
  readonly registro?: RegistroMediosCobranza;
};

export function solicitudDeBoleta(vista: VistaBoleta, opciones: OpcionesSolicitud = {}): DocumentoSolicitado {
  const v = parsearVistaBoleta(vista);

  // Compuerta de construcción (ADR-0001 §7.2) en el único cuello de botella que existe entre una
  // vista y el motor. `resolver()` lanza si el medio no está registrado: antes que renderizar un
  // instrumento que nadie sabe verificar, no se renderiza.
  const verificacion = (opciones.registro ?? registroPorDefecto()).resolver(v.bloquePago.medio).verificar(v.bloquePago);
  if (!verificacion.ok) {
    throw new Error(`el bloque de pago no verifica y el documento no se renderiza: ${verificacion.motivos.join("; ")}`);
  }

  return {
    estilos: estilosBoleta(opciones.fuentes ?? []),
    cuerpo: cuerpoBoleta(v),
    formato: "A4",
    margenesMm: MARGENES_BOLETA_MM,
    // Sin `??`, sin parámetro, sin `if` que alguien pueda ampliar: sale de la vista o no sale.
    marcaAgua: v.bloquePago.sinValorDePago ? MARCA_MUESTRA : null,
    paginasEsperadas: 1,
    // La boleta es de una página y ya trae su marca por el camino del DOM: no hay nada que sellar
    // página por página, y numerar "Página 1 de 1" es ruido.
    selloPorPagina: null,
  };
}

/** Arma el lote. Todas las boletas comparten los mismos estilos: una pasada, un juego de fuentes. */
export function solicitudesDeBoletas(
  vistas: readonly VistaBoleta[],
  opciones: OpcionesSolicitud = {},
): DocumentoSolicitado[] {
  // El registro se resuelve una vez para todo el lote, no una por boleta.
  const registro = opciones.registro ?? registroPorDefecto();
  return vistas.map((v) => solicitudDeBoleta(v, { ...opciones, registro }));
}
