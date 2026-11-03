"use server";

/**
 * Las escrituras del alta de barrio y del padrón (T3, BL-009; ADR-0010). Mismos cuatro pasos que el
 * resto de `acciones/` (ADR-0002 §4.2): `parse` con un esquema de `@admin-barrios/shared/escrituras`,
 * `conSesion` vía `ejecutar`, **una** llamada a un servicio de `@admin-barrios/data/servicios/*`, y
 * `revalidatePath` + resultado serializable.
 *
 * Quién puede lo decide la base (`padron_evento` solo lo escriben admin_barrio y admin_plataforma,
 * `0065`); las pantallas esconden los botones con `puedeEditarPadron`, que es dato para la UI.
 *
 * Dos cosas propias de este archivo:
 *   - **Campos anidados.** Los titulares viajan como `titular.0.nombre`, `titular.1.documento`…: los
 *     errores vuelven con esa misma clave (`erroresAnidados`), para que caigan en su campo.
 *   - **La planilla del padrón no pasa por acá**: sube por `app/api/padron/planilla/route.ts` (el
 *     archivo puede pesar más que el tope de una acción). Acá solo la de coeficientes, que es chica.
 */

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import {
  agregarUnidadSchema,
  cambiarTitularSchema,
  crearBarrioSchema,
  darDeBajaSchema,
  editarUnidadSchema,
  nuevaVersionCoeficientesSchema,
} from "@admin-barrios/shared/escrituras";
import { filasDeCsv } from "@admin-barrios/shared/padron";
import {
  agregarUnidad,
  cambiarTitular,
  crearBarrio,
  crearVersionCoeficientes,
  darDeBaja,
  editarUnidad,
  type TitularCambiado,
  type UnidadAgregada,
  type VersionCreada,
} from "@admin-barrios/data/servicios/padron-edicion";
import { conConfirmacion } from "./confirmacion.ts";
import { ejecutar } from "./ejecutar.ts";
import { valoresDe, type ResultadoDeAccion, type ValoresDeFormulario } from "./resultado.ts";
import { ArchivoRechazado, filasDeXlsx, MAX_BYTES_PLANILLA, textoDeCsv } from "../servidor/planilla/padron-xlsx.ts";

const RUTA_PADRON = "/[barrio]/padron";
const RUTA_FICHA = "/[barrio]/padron/[unidad]";
const RUTA_COEFICIENTES = "/[barrio]/padron/coeficientes";

/** Los errores de Zod con su clave completa (`titular.0.nombre`), no solo el primer tramo. */
function erroresAnidados<T>(error: z.ZodError, valores: ValoresDeFormulario): ResultadoDeAccion<T> {
  const campos: Record<string, string[]> = {};
  for (const issue of error.issues) {
    // `titulares.0.nombre` (la ruta del esquema) → `titular.0.nombre` (el nombre del campo).
    const clave = issue.path.map(String).join(".").replace(/^titulares\./, "titular.");
    (campos[clave] ??= []).push(issue.message);
  }
  return { estado: "campos", campos, valores };
}

/** Los titulares del formulario (`titular.0.nombre`, …) como lista, en orden de índice. */
function titularesDe(valores: ValoresDeFormulario): Record<string, string>[] {
  const porIndice = new Map<number, Record<string, string>>();
  for (const [clave, valor] of Object.entries(valores)) {
    const m = /^titular\.(\d{1,2})\.(nombre|caracter|documento|mail|telefono)$/.exec(clave);
    if (!m) continue;
    const i = Number.parseInt(m[1]!, 10);
    const t = porIndice.get(i) ?? {};
    t[m[2]!] = valor;
    porIndice.set(i, t);
  }
  return [...porIndice.entries()].sort(([a], [b]) => a - b).map(([, t]) => t);
}

// ── Nuevo barrio ─────────────────────────────────────────────────────────────────────────────

export async function crearBarrioAction(
  _previo: ResultadoDeAccion<{ readonly barrioId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly barrioId: string }>> {
  const valores = valoresDe(form);
  const entrada = crearBarrioSchema.safeParse(valores);
  if (!entrada.success) return erroresAnidados(entrada.error, valores);
  const resultado = await ejecutar(valores, (tx) => crearBarrio(tx, entrada.data));
  if (resultado.estado === "ok") revalidatePath("/", "page");
  return resultado;
}

// ── Unidades ─────────────────────────────────────────────────────────────────────────────────

export async function agregarUnidadAction(
  _previo: ResultadoDeAccion<UnidadAgregada>,
  form: FormData,
): Promise<ResultadoDeAccion<UnidadAgregada>> {
  // `confirmarTitularRegistrado` llega solo por el merge con la confirmación, nunca oculto (BL-024).
  const valores = valoresDe(form);
  const entrada = agregarUnidadSchema.safeParse({ ...conConfirmacion(valores), titulares: titularesDe(valores) });
  if (!entrada.success) return erroresAnidados(entrada.error, valores);
  const resultado = await ejecutar(valores, (tx) => agregarUnidad(tx, entrada.data));
  if (resultado.estado === "ok") revalidatePath(RUTA_PADRON, "page");
  return resultado;
}

export async function editarUnidadAction(_previo: ResultadoDeAccion<null>, form: FormData): Promise<ResultadoDeAccion<null>> {
  const valores = valoresDe(form);
  const entrada = editarUnidadSchema.safeParse(valores);
  if (!entrada.success) return erroresAnidados(entrada.error, valores);
  const resultado = await ejecutar(valores, async (tx) => {
    await editarUnidad(tx, entrada.data);
    return null;
  });
  if (resultado.estado === "ok") {
    revalidatePath(RUTA_PADRON, "page");
    revalidatePath(RUTA_FICHA, "page");
  }
  return resultado;
}

export async function cambiarTitularAction(
  _previo: ResultadoDeAccion<TitularCambiado>,
  form: FormData,
): Promise<ResultadoDeAccion<TitularCambiado>> {
  const valores = valoresDe(form);
  const titular = Object.fromEntries(
    Object.entries(valores).flatMap(([k, v]) => (k.startsWith("titular.") ? [[k.slice("titular.".length), v]] : [])),
  );
  const entrada = cambiarTitularSchema.safeParse({ ...conConfirmacion(valores), titular });
  if (!entrada.success) return erroresAnidados(entrada.error, valores);
  const resultado = await ejecutar(valores, (tx) => cambiarTitular(tx, entrada.data));
  if (resultado.estado === "ok") {
    revalidatePath(RUTA_PADRON, "page");
    revalidatePath(RUTA_FICHA, "page");
  }
  return resultado;
}

export async function darDeBajaAction(
  _previo: ResultadoDeAccion<{ readonly sinBoletaDesde: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly sinBoletaDesde: string }>> {
  const valores = valoresDe(form);
  const entrada = darDeBajaSchema.safeParse(valores);
  if (!entrada.success) return erroresAnidados(entrada.error, valores);
  const resultado = await ejecutar(valores, (tx) => darDeBaja(tx, entrada.data));
  if (resultado.estado === "ok") {
    revalidatePath(RUTA_PADRON, "page");
    revalidatePath(RUTA_FICHA, "page");
  }
  return resultado;
}

// ── Planillas ────────────────────────────────────────────────────────────────────────────────

/**
 * La planilla de coeficientes (chica: manzana, lote y coeficiente) → filas de texto. La del padrón,
 * que puede pesar hasta 5 MB, sube por `app/api/padron/planilla/route.ts` (el tope de una acción es
 * 1 MB). Las dos pasan por el mismo lector endurecido.
 */
async function filasDelArchivo(form: FormData): Promise<{ filas: string[][] } | { error: string }> {
  const archivo = form.get("archivo");
  if (!(archivo instanceof File) || archivo.size === 0) return { error: "Elegí el archivo de la planilla (Excel o CSV)." };
  if (archivo.size > MAX_BYTES_PLANILLA) return { error: "El archivo pasa de 5 MB: partilo en varios." };
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  try {
    if (/\.csv$/i.test(archivo.name)) return { filas: filasDeCsv(textoDeCsv(bytes)) };
    if (/\.xlsx$/i.test(archivo.name)) return { filas: await filasDeXlsx(Buffer.from(bytes)) };
  } catch (e) {
    if (e instanceof ArchivoRechazado) return { error: e.message };
    throw e;
  }
  return { error: "El archivo tiene que ser un Excel (.xlsx) o un CSV." };
}

const falla = <T>(mensaje: string, valores: ValoresDeFormulario): ResultadoDeAccion<T> => ({
  estado: "campos",
  campos: { archivo: [mensaje] },
  valores,
});

// ── Coeficientes ─────────────────────────────────────────────────────────────────────────────

export async function nuevaVersionCoeficientesAction(
  _previo: ResultadoDeAccion<VersionCreada>,
  form: FormData,
): Promise<ResultadoDeAccion<VersionCreada>> {
  const valores = valoresDe(form);
  const entrada = nuevaVersionCoeficientesSchema.safeParse(valores);
  if (!entrada.success) return erroresAnidados(entrada.error, valores);
  let planilla: string[][] | undefined;
  if (entrada.data.forma === "planilla") {
    const leido = await filasDelArchivo(form);
    if ("error" in leido) return falla(leido.error, valores);
    planilla = leido.filas;
  }
  const resultado = await ejecutar(valores, (tx) => crearVersionCoeficientes(tx, { ...entrada.data, planilla }));
  if (resultado.estado === "ok") {
    revalidatePath(RUTA_COEFICIENTES, "page");
    revalidatePath(RUTA_PADRON, "page");
  }
  return resultado;
}
