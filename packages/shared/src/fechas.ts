/**
 * Fechas para impresión. **Sin `Intl`, sin zona horaria, sin `Date`.**
 *
 * Mismo motivo que el formato de dinero (`dinero.ts`): un Node slim sin ICU completo degrada
 * `Intl.DateTimeFormat("es-AR")` en silencio, y `new Date("2026-08-10")` se interpreta en UTC — que
 * en Argentina (UTC−3) devuelve el **día anterior**. Un vencimiento corrido un día es un vecino que
 * paga tarde por culpa del sistema.
 *
 * La base entrega `date` como string `YYYY-MM-DD` (`mode: "string"` en Drizzle): acá solo se
 * reordena texto.
 */

import { z } from "zod";

/** Fecha calendario `YYYY-MM-DD`, tal como la entrega Postgres. */
export const fechaIsoSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "fecha inválida (esperado YYYY-MM-DD)");
export type FechaIso = z.infer<typeof fechaIsoSchema>;

/** `"2026-08-10"` → `"10/08/2026"`. */
export function formatearFecha(iso: string): string {
  const [anio, mes, dia] = fechaIsoSchema.parse(iso).split("-");
  return `${dia}/${mes}/${anio}`;
}

/** `"2026-07"` → `"07/2026"`. Etiqueta del período tal como se lee en la boleta. */
export function formatearPeriodo(periodo: string): string {
  const [anio, mes] = z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "período inválido (YYYY-MM)")
    .parse(periodo)
    .split("-");
  return `${mes}/${anio}`;
}
