"use server";

/**
 * El catálogo de proveedores del barrio: alta y corrección.
 *
 * Mismos cuatro pasos que `acciones/cobros.ts` (ADR-0002 §4.2): `parse` con un esquema Zod de
 * `@admin-barrios/shared/escrituras`, `conSesion`, **una** llamada a un servicio de
 * `@admin-barrios/data/servicios/*`, y `revalidatePath` + resultado serializable. Ver el comentario
 * de cabecera de `liquidacion.ts` para el porqué de cada uno.
 *
 * **`barrioId` viaja en el formulario, como campo oculto** — `registrarProveedorSchema` lo exige
 * (`packages/shared/src/escrituras.ts`, corregido para que el docstring dejara de decir lo
 * contrario): un proveedor no cuelga de ningún período ni de ninguna otra fila de la que derivarlo
 * bajo RLS, mismo caso que `crearPeriodoSchema` en `liquidacion.ts`.
 *
 * **No hay acción de desactivación acá.** `desactivarProveedor()` existe en el servicio y está
 * probado del lado del backend, pero no se pidió como parte de este cierre de gaps — se agrega
 * cuando la pantalla que la necesite se diseñe.
 *
 * **Los nombres de ruta son provisorios.** Todavía no existe ninguna pantalla de Proveedores/OP —
 * `/[barrio]/proveedores` sigue la misma convención kebab que `cobros`/`liquidacion`, pero se
 * confirma (o se corrige) recién cuando se diseñe la pantalla real.
 */

import { revalidatePath } from "next/cache";
import { registrarProveedorSchema, corregirProveedorSchema } from "@admin-barrios/shared/escrituras";
import {
  registrarProveedor,
  corregirProveedor,
  type Proveedor,
} from "@admin-barrios/data/servicios/proveedores";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion } from "./resultado.ts";

const RUTA_PROVEEDORES = "/[barrio]/proveedores";

/** Alta de un proveedor del catálogo del barrio. */
export async function registrarProveedorAction(
  _previo: ResultadoDeAccion<Proveedor>,
  form: FormData,
): Promise<ResultadoDeAccion<Proveedor>> {
  const valores = valoresDe(form);
  const entrada = registrarProveedorSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => registrarProveedor(tx, entrada.data));
  if (resultado.estado === "ok") {
    // Patrón de ruta, no la URL concreta: mismo motivo que el resto del kit (ver el comentario de
    // cabecera de `acciones/liquidacion.ts`), aunque acá sí se tenga el `barrioId` a mano — usarlo
    // para armar la URL sería la única acción que lo hace distinto, sin ganar nada.
    revalidatePath(RUTA_PROVEEDORES, "page");
  }
  return resultado;
}

/** Corrige los datos de un proveedor ya cargado. Nunca cambia `activo` — eso es
 *  `desactivarProveedor()`, sin acción todavía (ver el comentario de cabecera). */
export async function corregirProveedorAction(
  _previo: ResultadoDeAccion<Proveedor>,
  form: FormData,
): Promise<ResultadoDeAccion<Proveedor>> {
  const valores = valoresDe(form);
  const entrada = corregirProveedorSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => corregirProveedor(tx, entrada.data));
  if (resultado.estado === "ok") {
    revalidatePath(RUTA_PROVEEDORES, "page");
  }
  return resultado;
}
