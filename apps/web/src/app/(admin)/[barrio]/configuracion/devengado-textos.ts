/**
 * Cómo se **dice** «Cómo se devenga» en la pantalla (encargo 16): el resumen corto de una
 * configuración, el renglón de ejemplo del reparto y el texto de cada cambio del historial.
 *
 * Son funciones puras, sin base ni React, para poder probarlas (`devengado-textos.test.ts`) y para
 * que la isla y la parte de servidor digan lo mismo. Acá **no se calcula dinero**: los importes
 * llegan resueltos del servicio (`leerComoSeDevenga`) y solo se formatean con `shared/dinero`.
 */

import { aCentavos, formatearMonto, montoSchema } from "@admin-barrios/shared/dinero";
import {
  TEXTO_CUPON,
  TEXTO_MODO_BONIFICACION,
  TEXTO_ORIGEN,
  TEXTO_REPARTO,
  textoDePorcentaje,
  type ComoSeDevenga,
  type OrigenDevengado,
  type RepartoDevengado,
  type ValorDeBonificacion,
} from "@admin-barrios/shared/devengado";
import { definicionDe, textoDeValor, type ClaveParametro } from "@admin-barrios/shared/parametros-mora";

const pesos = (m: string): string => `$ ${formatearMonto(m)}`;
const enMinuscula = (t: string): string => t.charAt(0).toLowerCase() + t.slice(1);

/** «1 unidad» / «212 unidades». */
const unidades = (n: number): string => (n === 1 ? "1 unidad" : `${n} unidades`);

/** «7,5 % de la expensa, hasta $ 20.000,00 por unidad» / «$ 15.000,00 por unidad». `null` si no hay valor. */
export function textoDeCuanto(cuanto: ValorDeBonificacion | null): string | null {
  if (cuanto === null) return null;
  if (cuanto.forma === "importe") return `${pesos(cuanto.valor)} por unidad`;
  return `${textoDePorcentaje(cuanto.valor)} de la expensa${cuanto.tope ? `, hasta ${pesos(cuanto.tope)} por unidad` : ""}`;
}

/** La bonificación en una frase: «sola, a quien está al día (7,5 % de la expensa, …)». */
export function textoDeBonificacion(bonificacion: ComoSeDevenga["bonificacion"]): string {
  if (bonificacion.modo === "no") return TEXTO_MODO_BONIFICACION.no;
  const cuanto = textoDeCuanto(bonificacion.cuanto);
  return `${TEXTO_MODO_BONIFICACION[bonificacion.modo]}${cuanto ? ` (${cuanto})` : ""}`;
}

/** Una configuración entera en un renglón, para «Desde <mes>: …». */
export function resumenCorto(config: ComoSeDevenga): string {
  const bonificacion =
    config.bonificacion.modo === "no" ? "no bonifica" : `bonificación ${enMinuscula(textoDeBonificacion(config.bonificacion))}`;
  return `${TEXTO_ORIGEN[config.origen].corto}, ${TEXTO_REPARTO[config.reparto].corto}; ${TEXTO_CUPON[config.cuponCobra].corto}; ${bonificacion}.`;
}

/** El renglón de ejemplo del punto 2, y si hay que mandar a la persona a cargar la cuota. */
export type EjemploDeReparto = { readonly texto: string; readonly cargarEnCuota: boolean };

/**
 * Qué significa la combinación elegida de origen y reparto, con las cifras de hoy si las hay. Solo
 * informa: el panel no carga cuotas ni crea versiones de coeficientes.
 */
export function ejemploDeReparto(entrada: {
  readonly origen: OrigenDevengado;
  readonly reparto: RepartoDevengado;
  readonly unidades: number;
  readonly referencia: { readonly importePorUnidad: string | null; readonly totalDelMes: string | null };
}): EjemploDeReparto {
  const { origen, reparto, referencia } = entrada;
  if (origen === "gastos") {
    return {
      texto:
        reparto === "igual"
          ? "Los gastos del mes, en partes iguales (con la versión de coeficientes «partes iguales» del barrio)."
          : "Los gastos del mes, repartidos por coeficiente.",
      cargarEnCuota: false,
    };
  }
  if (reparto === "coeficiente") {
    return referencia.totalDelMes
      ? { texto: `${pesos(referencia.totalDelMes)} en total; cada unidad paga según su coeficiente.`, cargarEnCuota: false }
      : { texto: "El total del mes se carga en Configuración → Cuota; cada unidad paga según su coeficiente.", cargarEnCuota: true };
  }
  if (referencia.importePorUnidad && referencia.totalDelMes) {
    // La cuenta se muestra entera solo si cierra: con una unidad sin importe, «× N» no daría el total.
    const cierra = aCentavos(referencia.importePorUnidad) * BigInt(entrada.unidades) === aCentavos(referencia.totalDelMes);
    return {
      texto: cierra
        ? `${pesos(referencia.importePorUnidad)} por unidad × ${unidades(entrada.unidades)} = ${pesos(referencia.totalDelMes)}`
        : `${pesos(referencia.importePorUnidad)} por unidad; hoy el barrio pide ${pesos(referencia.totalDelMes)} por mes en total.`,
      cargarEnCuota: false,
    };
  }
  return referencia.totalDelMes
    ? {
        texto: `Hoy el barrio pide ${pesos(referencia.totalDelMes)} por mes en total. El importe por unidad se carga en Configuración → Cuota.`,
        cargarEnCuota: true,
      }
    : { texto: "El importe por unidad se carga en Configuración → Cuota.", cargarEnCuota: true };
}

/** Lo mínimo de una fila del historial para decir qué cambió. */
export type FilaDeCambio = { readonly rigeDesde: string; readonly clave: ClaveParametro; readonly valor: string | null };

/**
 * «Qué cambió» de una fila del historial: el nombre de lo que se cambió y a qué valor.
 *
 * El valor de la bonificación se guarda como un número suelto: si es un porcentaje o un importe lo
 * dice la **forma** que regía ese mes, que se busca en el mismo historial (viene del más nuevo al más
 * viejo). Si no se encuentra, se muestra el número como está, sin inventarle una unidad.
 */
export function textoDelCambio(fila: FilaDeCambio, historial: readonly FilaDeCambio[]): string {
  const nombre = definicionDe(fila.clave).nombre;
  if (fila.valor === null) return `${nombre}: vuelve a como era antes de configurarlo`;
  return `${nombre}: ${valorDelCambio(fila.clave, fila.valor, fila.rigeDesde, historial)}`;
}

function valorDelCambio(clave: ClaveParametro, valor: string, rigeDesde: string, historial: readonly FilaDeCambio[]): string {
  const esMonto = montoSchema.safeParse(valor).success;
  if (clave === "bonificacion.tope") return esMonto ? pesos(valor) : valor;
  if (clave === "bonificacion.valor") {
    const forma = historial
      .filter((h) => h.clave === "bonificacion.forma" && h.valor !== null && h.rigeDesde <= rigeDesde)
      .reduce<FilaDeCambio | null>((mejor, h) => (mejor === null || h.rigeDesde > mejor.rigeDesde ? h : mejor), null)?.valor;
    if (forma === "porcentaje") return textoDePorcentaje(valor);
    if (forma === "importe" && esMonto) return pesos(valor);
  }
  return textoDeValor(clave, valor);
}
