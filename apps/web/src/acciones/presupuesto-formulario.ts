/**
 * La forma en que llega el formulario del presupuesto (encargo 16c), y nada más.
 *
 * El esquema (`guardarPresupuestoSchema`) espera una lista de rubros; un formulario manda campos
 * sueltos. Cada rubro viaja como `rubro:<conceptoId>` con su importe canónico, y acá se arma la lista
 * en el orden en que vino. **No decide nada**: ni qué rubros valen, ni si un importe es negativo, ni
 * si el concepto es del barrio. Eso lo dicen el esquema, el servicio y la base.
 *
 * Aparte de la acción porque un archivo `"use server"` solo exporta funciones asíncronas, y porque la
 * isla de la pantalla nombra los campos con la misma función: si el nombre cambiara de un lado solo,
 * los rubros dejarían de llegar sin ningún error.
 */

import type { z } from "zod";
import { mensajeParaPantalla, type ErroresPorCampo, type ValoresDeFormulario } from "./resultado.ts";

const PREFIJO_RUBRO = "rubro:";

/** El nombre del campo del importe de un rubro. */
export const campoDelRubro = (conceptoId: string): string => `${PREFIJO_RUBRO}${conceptoId}`;

/** El formulario, con la forma que espera `guardarPresupuestoSchema`. Lo crudo sigue en `valores`. */
export function presupuestoDelFormulario(valores: ValoresDeFormulario): {
  readonly periodoId: string | undefined;
  readonly margen: string | undefined;
  readonly rubros: { readonly conceptoId: string; readonly monto: string }[];
} {
  // Un rubro con el campo vacío no está en el presupuesto: la pantalla lista los rubros con gasto el
  // mes anterior como sugerencia, y uno que no se completa no se presupuesta (no es un «$ 0,00»).
  const rubros = Object.entries(valores)
    .filter(([clave, monto]) => clave.startsWith(PREFIJO_RUBRO) && monto.trim() !== "")
    .map(([clave, monto]) => ({ conceptoId: clave.slice(PREFIJO_RUBRO.length), monto }));
  // Sin margen escrito, el margen es cero: el campo es opcional en la pantalla.
  const margen = valores["margen"]?.trim() === "" ? "0.00" : valores["margen"];
  return { periodoId: valores["periodoId"], margen, rubros };
}

/**
 * Los errores del `parse`, cada uno en su campo: el de un rubro, en `rubro:<conceptoId>` (que es
 * donde la pantalla lo dibuja); el del margen, en `margen`; lo que no es de un campo, en `""`.
 */
export function erroresDelPresupuesto(
  error: z.ZodError,
  entrada: ReturnType<typeof presupuestoDelFormulario>,
): ErroresPorCampo {
  const campos: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const [primero, indice] = issue.path;
    const rubro = primero === "rubros" && typeof indice === "number" ? entrada.rubros[indice] : undefined;
    const clave = rubro ? campoDelRubro(rubro.conceptoId) : typeof primero === "string" && primero !== "rubros" ? primero : "";
    (campos[clave] ??= []).push(mensajeParaPantalla(issue));
  }
  return campos;
}
