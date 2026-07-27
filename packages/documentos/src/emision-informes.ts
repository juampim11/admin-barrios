/**
 * De `VistaInformeMensual` / `VistaListadoMora` a `DocumentoSolicitado`.
 *
 * Es **el único camino** por el que estos dos documentos llegan al motor, y por eso acá viven las
 * guardas que no pueden depender de que alguien se acuerde. Mismo criterio que `emision.ts` para la
 * boleta: la marca de agua no es un parámetro, se deriva del dato.
 *
 * Tres cosas que pasan acá y en ningún otro lado:
 *
 *  1. **El filtro de lenguaje prohibido corre y BLOQUEA** (doc 07 §E). En el listado de saldos es
 *     donde más probablemente aparezcan "moroso", "intimación" o "acciones legales" —y es más
 *     probable que las escriba el cliente que nosotros—, así que no se avisa: no se emite. Corre acá
 *     y no en el parser de la vista congelada, porque la lista va a crecer y el día que crezca todos
 *     los documentos viejos que la contengan dejarían de poder abrirse (ADR-0001 §6).
 *  2. **El listado nominado lleva marca de agua y folio en TODAS las páginas.** Se deriva de
 *     `detalle.modo`, no de una opción. Una hoja con nombres y saldos que se cae de un escritorio sin
 *     decir a quién estaba dirigida es el peor caso de este documento.
 *  3. **`destinatarios` distinto de `directorio` se rechaza en runtime.** No existe el vínculo
 *     usuario → unidad funcional (doc 07 §F, ADR-0001 §13): mandarle el listado "a los propietarios"
 *     obligaría a aparear dos listas por índice, que es exactamente lo que §F.2 prohíbe. El valor
 *     vive en el tipo porque la configuración del barrio ya lo contempla; la emisión no lo acepta.
 */

import {
  esFaltante,
  parsearVistaInformeMensual,
  parsearVistaListadoMora,
  textosImpresosDeInforme,
  textosImpresosDeListadoMora,
  type VistaInformeMensual,
  type VistaListadoMora,
} from "@admin-barrios/shared/documentos";
import { printMargenesArchivo } from "@admin-barrios/design-tokens";
import type { DocumentoSolicitado, MargenesMm } from "./generador.ts";
import { revisarTextosImpresos } from "./lenguaje-prohibido.ts";
import type { FuenteEmbebida } from "./plantillas/comun.ts";
import { cuerpoInformeMensual, estilosInformeMensual } from "./plantillas/informe-mensual.ts";
import { cuerpoListadoMora, estilosListadoMora } from "./plantillas/listado-mora.ts";

/**
 * Márgenes de los A4 multipágina de la familia. 18 mm a la izquierda porque estos documentos **se
 * archivan**: una perforadora de dos agujeros muerde a ~12 mm del borde. La boleta sigue en 14/14 —
 * no se archiva, se corta y se entrega, y su código de barras necesita los 182 mm.
 */
export const MARGENES_ARCHIVO_MM: MargenesMm = printMargenesArchivo;

/** El texto exacto del sello del listado nominado. No es configurable por cliente ni por plantilla. */
export const MARCA_USO_INTERNO = "USO INTERNO — CONTIENE DATOS PERSONALES";

export type OpcionesInforme = { readonly fuentes?: readonly FuenteEmbebida[] };

function bloquearLenguaje(textos: readonly string[], documento: string): void {
  const motivos = revisarTextosImpresos(textos);
  if (motivos.length > 0) {
    throw new Error(`${documento}: hay lenguaje que este documento no puede imprimir — ${motivos.join("; ")}`);
  }
}

export function solicitudDeInformeMensual(
  vista: VistaInformeMensual,
  opciones: OpcionesInforme = {},
): DocumentoSolicitado {
  // Se re-valida aunque venga tipada: es el borde por el que un documento entra a renderizarse, y
  // una vista armada a mano o traída de la base tiene que pasar por los mismos invariantes de dinero.
  const v = parsearVistaInformeMensual(vista);
  bloquearLenguaje(textosImpresosDeInforme(v), "informe mensual");

  return {
    estilos: estilosInformeMensual(opciones.fuentes ?? []),
    cuerpo: cuerpoInformeMensual(v),
    formato: "A4",
    margenesMm: MARGENES_ARCHIVO_MM,
    marcaAgua: null,
    // Depende de cuántos grupos de gasto tenga el barrio y de cuántos superen el piso de
    // desagregación: es dato, no diseño.
    paginasEsperadas: "variable",
    selloPorPagina: { marcaAgua: null, numerarPaginas: true },
  };
}

export function solicitudDeListadoMora(
  vista: VistaListadoMora,
  opciones: OpcionesInforme = {},
): DocumentoSolicitado {
  const v = parsearVistaListadoMora(vista);

  if (v.politica.destinatarios !== "directorio") {
    throw new Error(
      `no se puede emitir para "${v.politica.destinatarios}": todavía no existe el vínculo entre un ` +
        "usuario y su unidad funcional, así que el envío tendría que aparear dos listas por índice — " +
        "y es exactamente así como el listado de un barrio termina en la casilla de otro (doc 07 §F.2)",
    );
  }

  // El nombre del titular NO entra al filtro: no es un texto del documento sino el dato de una
  // persona. Si alguien se apellida "Veraz", el filtro bloquearía todo el listado por un apellido —
  // y de paso dejaría escrito en el log que ese apellido está en la nómina.
  bloquearLenguaje(textosImpresosDeListadoMora(v), "listado de saldos pendientes");

  const nominado = v.detalle.modo === "nominado";
  return {
    estilos: estilosListadoMora(opciones.fuentes ?? []),
    cuerpo: cuerpoListadoMora(v),
    formato: "A4",
    margenesMm: MARGENES_ARCHIVO_MM,
    marcaAgua: null,
    paginasEsperadas: "variable",
    // Sin `??`, sin parámetro: sale del modo de la vista o no sale. Una re-emisión desde la vista
    // congelada entra por este mismo camino, así que tampoco se le puede apagar por ahí.
    selloPorPagina: { marcaAgua: nominado ? MARCA_USO_INTERNO : null, numerarPaginas: true },
  };
}

/**
 * Cuántos huecos declara un informe. Sirve para que la UI pueda avisar **antes** de emitir cuántos
 * renglones van a salir en `pendiente`, en vez de que el administrador lo descubra en el PDF.
 */
export function contarPendientesDelInforme(v: VistaInformeMensual): number {
  const financieros = [
    v.financiero.fondos.saldoInicial,
    v.financiero.fondos.ingresos,
    v.financiero.fondos.egresos,
    v.financiero.fondos.saldoFinal,
    v.financiero.deudaProveedores.saldoInicial,
    v.financiero.deudaProveedores.pagadoEnElPeriodo,
    v.financiero.deudaProveedores.saldoFinal,
    v.financiero.deudaProveedores.cierreDelPeriodoAnterior,
  ];
  return (
    v.conciliacion.renglones.filter((r) => esFaltante(r.importe)).length +
    v.denominadores.filter((d) => esFaltante(d.valorTexto)).length +
    financieros.filter(esFaltante).length
  );
}
