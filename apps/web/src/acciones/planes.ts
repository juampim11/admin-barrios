"use server";

/**
 * Los planes de pago (P2a-1): el catálogo de la administración, las reglas de cada barrio y
 * «Declarar caído».
 *
 * Los mismos cuatro pasos que el resto de las acciones (ADR-0002 §4.2): `parse` con el esquema de
 * `@admin-barrios/shared/planes`, `conSesion`, **una** llamada al servicio y `revalidatePath` +
 * resultado serializable. Quién puede y qué cuadra lo deciden el esquema, el servicio y la base.
 *
 * Lo único que se adapta antes del `parse` es la forma: los barrios de un plan del catálogo llegan como
 * varias casillas con el mismo nombre (`valoresDe` no las junta).
 */

import type { z } from "zod";
import {
  bajaPlanDelCatalogoSchema,
  declararCaidoSchema,
  guardarPlanDelCatalogoSchema,
  guardarReglasDePlanesSchema,
} from "@admin-barrios/shared/planes";
import { darDeBajaPlanDelCatalogo, guardarPlanDelCatalogo, guardarReglasDePlanes } from "@admin-barrios/data/servicios/planes-configuracion";
import { declararCaido, type ResultadoDeLaCaida } from "@admin-barrios/data/servicios/planes";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion } from "./resultado.ts";
import { revalidarLosPlanes } from "./revalidar-mora.ts";

/** Igual que en `acciones/mora.ts`: al servicio va la entrada, no la salida del `parse`. */
function validar<S extends z.ZodTypeAny>(
  esquema: S,
  entrada: unknown,
): { readonly ok: true; readonly entrada: z.input<S> } | { readonly ok: false; readonly error: z.ZodError } {
  const r = esquema.safeParse(entrada);
  return r.success ? { ok: true, entrada: entrada as z.input<S> } : { ok: false, error: r.error };
}

export async function guardarPlanDelCatalogoAction(
  _previo: ResultadoDeAccion<{ readonly planId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly planId: string }>> {
  const valores = valoresDe(form);
  const barrioIds = form.getAll("barrioIds").filter((v): v is string => typeof v === "string");
  const entrada = validar(guardarPlanDelCatalogoSchema, { ...valores, barrioIds });
  // Los barrios marcados vuelven juntos (una clave por casilla se pisaría): así no se pierden tras un error.
  const devueltos = { ...valores, barrioIds: barrioIds.join(",") };
  if (!entrada.ok) return camposInvalidos(entrada.error, devueltos);
  const resultado = await ejecutar(devueltos, (tx) => guardarPlanDelCatalogo(tx, entrada.entrada));
  if (resultado.estado === "ok") revalidarLosPlanes();
  return resultado;
}

export async function bajaPlanDelCatalogoAction(
  _previo: ResultadoDeAccion<{ readonly dadoDeBaja: true }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly dadoDeBaja: true }>> {
  const valores = valoresDe(form);
  const entrada = validar(bajaPlanDelCatalogoSchema, valores);
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, async (tx) => {
    await darDeBajaPlanDelCatalogo(tx, entrada.entrada);
    return { dadoDeBaja: true as const };
  });
  if (resultado.estado === "ok") revalidarLosPlanes();
  return resultado;
}

export async function guardarReglasDePlanesAction(
  _previo: ResultadoDeAccion<{ readonly guardado: true }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly guardado: true }>> {
  const valores = valoresDe(form);
  const entrada = validar(guardarReglasDePlanesSchema, valores);
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, async (tx) => {
    await guardarReglasDePlanes(tx, entrada.entrada);
    return { guardado: true as const };
  });
  if (resultado.estado === "ok") revalidarLosPlanes();
  return resultado;
}

export async function declararCaidoAction(
  _previo: ResultadoDeAccion<ResultadoDeLaCaida>,
  form: FormData,
): Promise<ResultadoDeAccion<ResultadoDeLaCaida>> {
  const valores = valoresDe(form);
  const entrada = validar(declararCaidoSchema, valores);
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);
  const q = declararCaidoSchema.parse(entrada.entrada);
  const resultado = await ejecutar(valores, (tx) => declararCaido(tx, { planId: q.planId, nota: q.nota === "" ? null : q.nota }));
  if (resultado.estado === "ok") revalidarLosPlanes();
  return resultado;
}
