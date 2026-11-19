"use server";

/**
 * Los planes de pago (P2a-1): el catálogo de la administración, las reglas de cada barrio y
 * «Declarar caído». [P2a-2] Armar un plan (del catálogo o a medida), aprobarlo y rechazarlo.
 *
 * Los mismos cuatro pasos que el resto de las acciones (ADR-0002 §4.2): `parse` con el esquema de
 * `@admin-barrios/shared/planes`, `conSesion`, **una** llamada al servicio y `revalidatePath` +
 * resultado serializable. Quién puede y qué cuadra lo deciden el esquema, el servicio y la base.
 *
 * Lo único que se adapta antes del `parse` es la forma: los barrios de un plan del catálogo llegan como
 * varias casillas con el mismo nombre (`valoresDe` no las junta).
 */

import type { z } from "zod";
import { redirect } from "next/navigation";
import {
  aprobarPlanSchema,
  bajaPlanDelCatalogoSchema,
  cerrarPlanSchema,
  declararCaidoSchema,
  registrarPlanAMedidaSchema,
  registrarPlanDelCatalogoSchema,
  guardarReglasGeneralesDePlanesSchema,
  guardarPlanDelCatalogoSchema,
  guardarReglasDePlanesSchema,
} from "@admin-barrios/shared/planes";
import {
  darDeBajaPlanDelCatalogo,
  guardarReglasGeneralesDePlanes,
  guardarPlanDelCatalogo,
  guardarReglasDePlanes,
} from "@admin-barrios/data/servicios/planes-configuracion";
import {
  aprobarPlan,
  crearPlanDeCatalogo,
  declararCaido,
  proponerPlanAMedida,
  rechazarPlan,
  type ResultadoDeLaCaida,
} from "@admin-barrios/data/servicios/planes";
import { encolarElAcuerdoDelPlan } from "@admin-barrios/data/servicios/planes-documentos";
import { conConfirmacion } from "./confirmacion.ts";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion } from "./resultado.ts";
import { rutaDeFichaDeMora } from "../rutas.ts";
import { revalidarElPlanDeLaUnidad, revalidarLosPlanes } from "./revalidar-mora.ts";

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

/**
 * Las reglas generales de los planes de la administración: el orden de imputación entre la cuota del plan
 * y la expensa (F4 tramo 1) y el tope de tasa equivalente de un plan a medida (F4 tramo 2).
 */
export async function guardarReglasGeneralesDePlanesAction(
  _previo: ResultadoDeAccion<{ readonly guardado: true }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly guardado: true }>> {
  const valores = valoresDe(form);
  const entrada = validar(guardarReglasGeneralesDePlanesSchema, valores);
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, async (tx) => {
    await guardarReglasGeneralesDePlanes(tx, entrada.entrada);
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

// ────────────────────────────────────────────────────────────────────────────────────────────────
// [P2a-2] Armar un plan (pantallas 2 y 3), aprobarlo y rechazarlo
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Los meses elegidos llegan como varias casillas ocultas con el mismo nombre (`valoresDe` no las junta). */
function conMeses(form: FormData) {
  const valores = valoresDe(form);
  const liquidacionIds = form.getAll("liquidacionIds").filter((v): v is string => typeof v === "string");
  return { valores, liquidacionIds, devueltos: { ...valores, liquidacionIds: liquidacionIds.join(",") } };
}

/** Un plan del catálogo: el servidor arma las cuotas con la deuda de este momento y queda vigente. */
export async function registrarPlanDelCatalogoAction(
  _previo: ResultadoDeAccion<{ readonly planId: string; readonly barrioId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly planId: string; readonly barrioId: string }>> {
  const { valores, liquidacionIds, devueltos } = conMeses(form);
  // [F4 tramo 2] La confirmación de que la unidad derivada sale del estudio: solo alimenta el `parse`.
  const entrada = registrarPlanDelCatalogoSchema.safeParse({ ...conConfirmacion(valores), liquidacionIds });
  if (!entrada.success) return camposInvalidos(entrada.error, devueltos);
  const resultado = await ejecutar(devueltos, (tx) => crearPlanDeCatalogo(tx, entrada.data));
  if (resultado.estado === "ok") {
    revalidarElPlanDeLaUnidad();
    // A la ficha desde el servidor, afuera de la transacción ya cerrada: la página de armar se vuelve a
    // dibujar con «ya tiene un plan» y la isla que navegaría deja de existir (mismo motivo que Emitir).
    redirect(rutaDeFichaDeMora(resultado.valor.barrioId, entrada.data.unidadFuncionalId, { ver: "plan" }));
  }
  return resultado;
}

/** Un plan a medida: queda pendiente hasta que lo apruebe la administración. */
export async function proponerPlanAMedidaAction(
  _previo: ResultadoDeAccion<{ readonly planId: string; readonly barrioId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly planId: string; readonly barrioId: string }>> {
  const { valores, liquidacionIds, devueltos } = conMeses(form);
  // [F4 tramo 2] La confirmación del importe de más: solo alimenta el `parse`.
  const entrada = registrarPlanAMedidaSchema.safeParse({ ...conConfirmacion(valores), liquidacionIds });
  if (!entrada.success) return camposInvalidos(entrada.error, devueltos);
  // [P2a-3] «Enviar y armar el acuerdo (PDF)»: el mismo envío, y en la misma transacción se pide el PDF.
  const conAcuerdo = valores["despues"] === "acuerdo";
  const resultado = await ejecutar(devueltos, async (tx) => {
    const propuesto = await proponerPlanAMedida(tx, entrada.data);
    if (conAcuerdo) await encolarElAcuerdoDelPlan(tx, { planId: propuesto.planId });
    return propuesto;
  });
  if (resultado.estado === "ok") {
    revalidarElPlanDeLaUnidad();
    // A la ficha desde el servidor, afuera de la transacción ya cerrada: la página de armar se vuelve a
    // dibujar con «ya tiene un plan» y la isla que navegaría deja de existir (mismo motivo que Emitir).
    redirect(rutaDeFichaDeMora(resultado.valor.barrioId, entrada.data.unidadFuncionalId, { ver: "plan" }));
  }
  return resultado;
}

/** Aprueba un plan a medida pendiente (con el acta, si el barrio la exige): se firma con la deuda de hoy. */
export async function aprobarPlanAction(
  _previo: ResultadoDeAccion<{ readonly aprobado: true }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly aprobado: true }>> {
  const valores = valoresDe(form);
  // [F4 tramo 2] La confirmación de que la unidad derivada sale del estudio.
  const entrada = validar(aprobarPlanSchema, conConfirmacion(valores));
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, async (tx) => {
    await aprobarPlan(tx, entrada.entrada);
    return { aprobado: true as const };
  });
  if (resultado.estado === "ok") revalidarElPlanDeLaUnidad();
  return resultado;
}

export async function rechazarPlanAction(
  _previo: ResultadoDeAccion<{ readonly rechazado: true }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly rechazado: true }>> {
  const valores = valoresDe(form);
  const entrada = validar(cerrarPlanSchema, valores);
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, async (tx) => {
    await rechazarPlan(tx, entrada.entrada);
    return { rechazado: true as const };
  });
  if (resultado.estado === "ok") revalidarElPlanDeLaUnidad();
  return resultado;
}
