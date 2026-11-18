/**
 * De `VistaAcuerdoPlan` a `DocumentoSolicitado`: el único camino por el que el PDF de un plan de pagos
 * llega al motor (encargo P2a-3). Mismo andamiaje que el informe y el listado (`emision-informes.ts`).
 *
 * Tres cosas que se deciden acá y no en otro lado:
 *
 *  1. **El sello «Propuesta» en todas las hojas** de un plan pendiente. Se deriva del estado del plan
 *     en la vista, no de una opción: una hoja de un plan sin aprobar no se puede leer como el acuerdo.
 *  2. **El filtro de lenguaje corre y bloquea sobre lo que escribe el sistema** (la descripción del
 *     plan, las leyendas, el pie del emisor), igual que en el resto de la familia.
 *  3. **Las cláusulas del modelo NO pasan por el filtro, a propósito.** Son el texto de un convenio que
 *     redacta o valida el estudio y firman las dos partes: si un estudio escribe «acciones judiciales»
 *     en una cláusula, es su texto, no una afirmación del sistema sobre la deuda. El filtro existe para
 *     que la boleta y los informes no amenacen (doc 07 §E); bloquear un convenio redactado por un
 *     abogado por eso sería decidir su contenido. El borrador del sistema (`CLAUSULAS_BORRADOR`) sí
 *     pasa el filtro: lo verifica `emision-acuerdo-plan.test.ts`.
 */

import { parsearVistaAcuerdoPlan, type VistaAcuerdoPlan } from "@admin-barrios/shared/documentos";
import type { DocumentoSolicitado } from "./generador.ts";
import { MARGENES_ARCHIVO_MM } from "./emision-informes.ts";
import { revisarTextosImpresos } from "./lenguaje-prohibido.ts";
import type { FuenteEmbebida } from "./plantillas/comun.ts";
import { cuerpoAcuerdoPlan, estilosAcuerdoPlan, MARCA_PROPUESTA, textosImpresosDelAcuerdo } from "./plantillas/acuerdo-plan.ts";

export type OpcionesAcuerdoPlan = { readonly fuentes?: readonly FuenteEmbebida[] };

export function solicitudDeAcuerdoPlan(vista: VistaAcuerdoPlan, opciones: OpcionesAcuerdoPlan = {}): DocumentoSolicitado {
  // Se re-valida aunque venga tipada: es el borde por el que el documento entra a renderizarse, y los
  // cuadres de dinero se controlan acá también.
  const v = parsearVistaAcuerdoPlan(vista);
  const motivos = revisarTextosImpresos(textosImpresosDelAcuerdo(v));
  if (motivos.length > 0) {
    throw new Error(`plan de pagos: hay lenguaje que este documento no puede imprimir — ${motivos.join("; ")}`);
  }
  return {
    estilos: estilosAcuerdoPlan(opciones.fuentes ?? []),
    cuerpo: cuerpoAcuerdoPlan(v),
    formato: "A4",
    margenesMm: MARGENES_ARCHIVO_MM,
    marcaAgua: null,
    // Depende de cuántas cláusulas tenga el modelo y de cuántas cuotas tenga el plan: es dato.
    paginasEsperadas: "variable",
    selloPorPagina: { marcaAgua: v.plan.estado === "pendiente" ? MARCA_PROPUESTA : null, numerarPaginas: true },
  };
}
