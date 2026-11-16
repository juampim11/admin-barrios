/**
 * Los textos de «Gastos contra presupuesto» (encargo 16c, pantalla 6 de la maqueta), como funciones
 * puras. No calculan nada: dicen en palabras lo que resolvió `gastosContraPresupuesto` (la diferencia,
 * el avance y si se pasó) y eligen, de los avisos del mes, el del rubro que se pasó.
 */

import type { Falta } from "@admin-barrios/data/servicios/circuito-del-mes";
import { aCentavos, formatearMonto, restarMontos } from "@admin-barrios/shared/dinero";

/**
 * Un importe con su signo, como en la maqueta: «$ 37.700,00» o «− $ 270.000,00». El menos va delante
 * del signo pesos (no «$ -270.000,00»), con el guion largo de resta.
 */
export function conSigno(monto: string): { readonly texto: string; readonly negativo: boolean } {
  const negativo = aCentavos(monto) < 0n;
  return negativo
    ? { texto: `− $ ${formatearMonto(restarMontos("0.00", monto))}`, negativo }
    : { texto: `$ ${formatearMonto(monto)}`, negativo };
}

/**
 * La marca de la fila: «Se pasó» cuando lo gastado supera lo presupuestado; «Sin cargar» cuando el
 * rubro está presupuestado y todavía no tiene gasto; si no, nada.
 */
export function marcaDelRubro(r: {
  readonly presupuesto: string | null;
  readonly gastado: string;
  readonly excedido: boolean;
}): { readonly tono: "peligro" | "neutro"; readonly texto: string } | null {
  if (r.excedido) return { tono: "peligro", texto: "Se pasó" };
  if (r.presupuesto !== null && aCentavos(r.gastado) === 0n) return { tono: "neutro", texto: "Sin cargar" };
  return null;
}

/** «Fuera del presupuesto»: un rubro con gasto que no estaba presupuestado. */
export const FUERA_DEL_PRESUPUESTO = "Fuera del presupuesto";

/** De los avisos del mes, los de un rubro que se pasó de su presupuesto (los marca `avisosDelMes` con `clase`). */
export function avisosDeRubrosExcedidos(avisos: readonly Falta[]): Falta[] {
  return avisos.filter((a) => a.clase === "presupuesto");
}
