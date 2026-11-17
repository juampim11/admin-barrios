/**
 * Qué pantallas se refrescan después de escribir algo de la mora (encargo E-a y E-a2). Lo comparten
 * `acciones/mora.ts` y `acciones/gestiones.ts`; vive aparte porque un archivo `"use server"` solo
 * exporta acciones.
 *
 * Patrones de ruta y no URLs concretas, mismo criterio que `revalidarElPeriodo()` en
 * `acciones/liquidacion.ts`: las acciones no traen el barrio (se deriva bajo RLS).
 */

import { revalidatePath } from "next/cache";

/** Las dos listas de mora —la de todos los barrios y la de cada barrio— y la ficha de cada unidad. */
export function revalidarLaMora(): void {
  revalidatePath("/mora", "page");
  revalidatePath("/[barrio]/mora", "page");
  revalidatePath("/[barrio]/mora/[unidad]", "page");
  revalidatePath("/[barrio]/mora/[unidad]/plan", "page");
}

/**
 * [P2a-2] Un plan que se registra, se aprueba o se rechaza: la mora y además la cobranza, porque al
 * firmarse los meses incluidos dejan de deber (el estado de cuenta y la grilla cambian).
 */
export function revalidarElPlanDeLaUnidad(): void {
  revalidarLaMora();
  revalidatePath("/[barrio]/cobros", "page");
  revalidatePath("/[barrio]/cobros/[unidad]", "page");
}

/** P2a-1: el catálogo y las reglas de los planes, y lo que muestra la mora (el chip «En plan»). */
export function revalidarLosPlanes(): void {
  revalidatePath("/configuracion/planes", "page");
  revalidarLaMora();
}

/** Los estudios y el criterio se ven en las dos configuraciones y en las listas (el diálogo de derivar). */
export function revalidarLosEstudios(): void {
  revalidatePath("/configuracion/estudios", "page");
  revalidatePath("/[barrio]/configuracion/mora", "page");
  revalidarLaMora();
}
