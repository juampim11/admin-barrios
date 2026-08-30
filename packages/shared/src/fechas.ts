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

/**
 * Marca de tiempo local `YYYY-MM-DD HH:MM[:SS][.ffffff]±TZ` → `"30/08/2026 00:51"`.
 *
 * **Es para un instante ya convertido a la zona del barrio, no para un `timestamptz` crudo en UTC.**
 * La diferencia importa y por eso el nombre no es `formatearInstante`: quien llama tiene que haberlo
 * traído con `at time zone`, igual que hace el resto del sistema. Acá **no se convierte nada** — no
 * hay `Date` ni `Intl`, por el mismo motivo que el resto de este archivo.
 *
 * Nació porque las pantallas venían imprimiendo `valor.slice(0, 16).replace("T", " ")` a mano (cinco
 * lugares). Eso tenía dos problemas: mostraba la hora **UTC** —a las 21:00 de Argentina, el día
 * siguiente— y el `replace("T", " ")` era **código muerto**, porque el `::text` de Postgres separa
 * fecha y hora con un espacio, no con la `T` de ISO. Compilaba, se veía casi bien, y solo se notaba
 * mirando el reloj.
 *
 * Acepta el separador `T` además del espacio: si algún día el valor llega en ISO real, no miente.
 */
export function formatearFechaHora(marca: string): string {
  const texto = z
    .string()
    .regex(
      /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?(\.\d+)?([+-]\d{2}(:?\d{2})?)?$/,
      "marca de tiempo inválida (esperado YYYY-MM-DD HH:MM)",
    )
    .parse(marca);

  const [fecha, resto] = texto.split(/[T ]/);
  const [anio, mes, dia] = fecha!.split("-");
  // Solo `HH:MM`: los segundos no le dicen nada a quien mira cuándo se armó un paquete, y el offset
  // ya se consumió al convertir.
  const hora = resto!.slice(0, 5);
  return `${dia}/${mes}/${anio} ${hora}`;
}
