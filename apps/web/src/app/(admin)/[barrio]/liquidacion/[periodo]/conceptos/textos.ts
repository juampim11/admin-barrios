/**
 * Los textos de «Conceptos del mes» (encargo 16b, pantalla 4 de la maqueta), como funciones puras.
 *
 * No calculan nada: dicen en palabras lo que resolvieron `conceptosDelMes`, la vista previa de la
 * planilla y las boletas del mes. Están aparte de la pantalla para poder probarlas sin base.
 */

import { formatearMonto } from "@admin-barrios/shared/dinero";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { textoDeUsos, type UnidadDeUso } from "@admin-barrios/shared/conceptos";

export type OrigenDelConcepto = "bonificacion" | "sola" | "planilla" | "mano";

const pesos = (monto: string): string => `$ ${formatearMonto(monto)}`;

/** El chip de «de dónde sale»: la bonificación de la regla y lo que aplica el catálogo entran solos. */
export function chipDeOrigen(origen: OrigenDelConcepto): { readonly tono: "marca" | "info" | "neutro"; readonly texto: string } {
  switch (origen) {
    case "bonificacion":
    case "sola":
      return { tono: "marca", texto: "Sola" };
    case "planilla":
      return { tono: "info", texto: "Planilla" };
    case "mano":
      return { tono: "neutro", texto: "A mano" };
  }
}

/** Lo que se dice cuando un importe todavía no existe. Nunca un cero: `null` no es «$ 0,00». */
export const SE_CALCULA_AL_EMITIR = "se calcula al emitir";

export const cuantasUnidades = (n: number): string => (n === 1 ? "1 unidad" : `${n} unidades`);

/** Un uso de una planilla, con su fecha: «08/11/2026 · 1 turno». */
export function usoConFecha(uso: { readonly fecha: string; readonly cantidad: string }, unidad: UnidadDeUso | null): string {
  return `${formatearFecha(uso.fecha)} · ${textoDeUsos(uso.cantidad, unidad)}`;
}

/**
 * La cantidad de un renglón de la vista previa: lo de esta planilla y, si ya había usos de planillas
 * anteriores del mes, con cuánto queda. La suma la hizo el servicio (`cantidadTotal`).
 */
export function cantidadDelRenglon(
  r: { readonly cantidad: string; readonly cantidadAnterior: string; readonly cantidadTotal: string },
  unidad: UnidadDeUso | null,
): string {
  if (r.cantidadAnterior === "0") return textoDeUsos(r.cantidadTotal, unidad);
  return `${textoDeUsos(r.cantidad, unidad)} de esta planilla + ${textoDeUsos(r.cantidadAnterior, unidad)} ya cargados = ${textoDeUsos(r.cantidadTotal, unidad)}`;
}

/** «Fila 7» o, para lo que es de la planilla entera (el encabezado, el nombre repetido), «La planilla». */
export const dondeEstaElError = (fila: number): string => (fila <= 1 ? "La planilla" : `Fila ${fila}`);

export function tituloDeErrores(n: number): string {
  return n === 1 ? "La planilla tiene 1 error: no se puede aplicar." : `La planilla tiene ${n} errores: no se puede aplicar.`;
}

export const CORREGI_LA_PLANILLA = "Corregí la planilla y volvé a subirla: se carga entera o no se carga.";

/** «Listo: se cargaron 12 usos en 5 renglones, por $ 96.000,00.» */
export function planillaAplicada(hecho: { readonly renglones: number; readonly usos: number; readonly total: string }): string {
  const usos = hecho.usos === 1 ? "se cargó 1 uso" : `se cargaron ${hecho.usos} usos`;
  const renglones = hecho.renglones === 1 ? "1 renglón de boleta" : `${hecho.renglones} renglones de boleta`;
  return `Listo: ${usos} en ${renglones}, por ${pesos(hecho.total)}.`;
}

/**
 * El pie de la pestaña. «Devengado» es lo que suman los cupones del mes; la deuda de meses anteriores
 * va al lado, como referencia. Qué cobra el cupón lo eligió el barrio en «Cómo se devenga»: si además
 * del mes cobra la deuda, los cupones la incluyen y se dice, en vez de afirmar que no suma.
 */
export function pieDelMes(
  mes: string,
  totales: { readonly cupones: string; readonly expensa: string; readonly cargos: string; readonly deudaAnterior: string; readonly boletas: number },
  cuponCobra: "solo_mes" | "mes_mas_deuda" | null,
): {
  readonly devengado: { readonly valor: string; readonly etiqueta: string };
  readonly deuda: { readonly valor: string; readonly etiqueta: string };
  readonly origen: string;
} {
  const soloElMes = cuponCobra === "solo_mes";
  const cupones = totales.boletas === 1 ? "el cupón del mes" : `los ${totales.boletas} cupones del mes`;
  return {
    devengado: {
      valor: pesos(totales.cupones),
      etiqueta: soloElMes ? `Devengado de ${mes}` : `Cupones de ${mes}`,
    },
    deuda: {
      valor: pesos(totales.deudaAnterior),
      etiqueta: soloElMes
        ? "Deuda de meses anteriores. No es devengado de este mes: va como referencia, sin sumar"
        : "Deuda de meses anteriores. En este barrio el cupón también la cobra: ya está dentro de los cupones",
    },
    origen: `Es lo que suman ${cupones}. Del mes: ${pesos(totales.expensa)} del importe del mes y ${pesos(totales.cargos)} de conceptos (cargos menos descuentos).`,
  };
}
