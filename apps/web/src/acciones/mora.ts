"use server";

/**
 * La mora y los estudios jurídicos (encargo E-a): derivar en lote, los estudios de la administración,
 * su criterio general, y la mora y los estudios de cada barrio.
 *
 * Los mismos cuatro pasos que el resto de las acciones (ADR-0002 §4.2): `parse` con el esquema de
 * `@admin-barrios/shared/mora`, `conSesion`, **una** llamada al servicio y `revalidatePath` + resultado
 * serializable. Quién puede, que un estudio trabaje en el barrio de la unidad, que no se dé de baja un
 * estudio con unidades derivadas: lo deciden el esquema, el servicio y la base. Acá no hay ninguna de
 * esas reglas.
 *
 * Lo único que se adapta antes del `parse` es **la forma** en que llega un formulario: las unidades de
 * una tanda son varias casillas ocultas con el mismo nombre (`valoresDe` no las junta) y el estudio de
 * cada barrio viaja en un campo por barrio. Los valores que vuelven a la pantalla son siempre los crudos.
 */

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import {
  agregarEstudioSchema,
  bajaEstudioSchema,
  buscarEstudioSchema,
  criterioAdministracionSchema,
  derivarSchema,
  editarVinculoSchema,
  estudioDelBarrioSchema,
  moraBarrioSchema,
  vincularEstudioSchema,
} from "@admin-barrios/shared/mora";
import { idSchema } from "@admin-barrios/shared/consultas";
import {
  agregarEstudio,
  bajaEstudio,
  buscarEstudio,
  cambiarEstudioDelBarrio,
  derivar,
  editarVinculo,
  guardarCriterioAdministracion,
  guardarMoraBarrio,
  vincularEstudio,
  type ResultadoDerivacion,
} from "@admin-barrios/data/servicios/mora";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion } from "./resultado.ts";

/**
 * El esquema valida lo que llegó y, si pasa, **se le da al servicio la misma entrada**, no la salida
 * del `parse`: el servicio vuelve a parsear (es su límite), y la salida ya transformada —los meses
 * como número, la intimación como booleano— no pasaría por segunda vez el mismo esquema.
 */
function validar<S extends z.ZodTypeAny>(
  esquema: S,
  entrada: unknown,
): { readonly ok: true; readonly entrada: z.input<S> } | { readonly ok: false; readonly error: z.ZodError } {
  const r = esquema.safeParse(entrada);
  return r.success ? { ok: true, entrada: entrada as z.input<S> } : { ok: false, error: r.error };
}

/** Las dos listas de mora: la de todos los barrios y la de cada barrio. */
function revalidarLaMora(): void {
  revalidatePath("/mora", "page");
  revalidatePath("/[barrio]/mora", "page");
}

/** Los estudios y el criterio se ven en las dos configuraciones y en las listas (el diálogo de derivar). */
function revalidarLosEstudios(): void {
  revalidatePath("/configuracion/estudios", "page");
  revalidatePath("/[barrio]/configuracion/mora", "page");
  revalidarLaMora();
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Derivar
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * «Derivar N unidades». Cada casilla oculta `unidad` es `{unidad}|{barrio}`; el estudio de cada barrio
 * viaja en `estudio-{barrio}`. El motivo y la nota valen para toda la tanda.
 */
export async function derivarAction(
  _previo: ResultadoDeAccion<ResultadoDerivacion>,
  form: FormData,
): Promise<ResultadoDeAccion<ResultadoDerivacion>> {
  const valores = valoresDe(form);
  const unidades = form
    .getAll("unidad")
    .filter((v): v is string => typeof v === "string")
    .map((v) => {
      const [unidadFuncionalId = "", barrioId = ""] = v.split("|");
      return { unidadFuncionalId, barrioId, estudioId: valores[`estudio-${barrioId}`] ?? "" };
    });
  const entrada = validar(derivarSchema, { unidades, motivo: valores["motivo"], nota: valores["nota"] });
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => derivar(tx, entrada.entrada));
  // Los estudios también: sus «derivadas» cambian (y `revalidarLosEstudios` incluye la mora).
  if (resultado.estado === "ok") revalidarLosEstudios();
  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Estudios de la administración (Configuración general › Estudios jurídicos)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type EstudioEncontrado = {
  /** Lo que se buscó, tal cual: el formulario del paso dos lo vuelve a mostrar. */
  readonly dato: string;
  readonly estudio: { readonly id: string; readonly nombre: string; readonly vinculado: boolean } | null;
};

/**
 * El primer paso de «Agregar un estudio»: buscar por correo o CUIT **exacto**. No escribe nada; pasa por
 * `ejecutar` igual, para leer bajo la sesión y traducir un rechazo como en cualquier otra acción.
 */
export async function buscarEstudioAction(
  _previo: ResultadoDeAccion<EstudioEncontrado>,
  form: FormData,
): Promise<ResultadoDeAccion<EstudioEncontrado>> {
  const valores = valoresDe(form);
  const entrada = buscarEstudioSchema.safeParse(valores);
  const administracion = idSchema.safeParse(valores["administracionId"]);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  if (!administracion.success) return camposInvalidos(administracion.error, valores);

  return ejecutar(valores, async (tx) => ({
    dato: entrada.data.dato,
    estudio: await buscarEstudio(tx, { administracionId: administracion.data, dato: entrada.data.dato }),
  }));
}

export async function agregarEstudioAction(
  _previo: ResultadoDeAccion<{ readonly estudioId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly estudioId: string }>> {
  const valores = valoresDe(form);
  const entrada = validar(agregarEstudioSchema, valores);
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => agregarEstudio(tx, entrada.entrada));
  if (resultado.estado === "ok") revalidarLosEstudios();
  return resultado;
}

export async function vincularEstudioAction(
  _previo: ResultadoDeAccion<{ readonly estudioId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly estudioId: string }>> {
  const valores = valoresDe(form);
  const entrada = validar(vincularEstudioSchema, valores);
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    await vincularEstudio(tx, entrada.entrada);
    return { estudioId: entrada.entrada.estudioId };
  });
  if (resultado.estado === "ok") revalidarLosEstudios();
  return resultado;
}

export async function editarVinculoAction(
  _previo: ResultadoDeAccion<{ readonly estudioId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly estudioId: string }>> {
  const valores = valoresDe(form);
  const entrada = validar(editarVinculoSchema, valores);
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    await editarVinculo(tx, entrada.entrada);
    return { estudioId: entrada.entrada.estudioId };
  });
  if (resultado.estado === "ok") revalidarLosEstudios();
  return resultado;
}

/** «Dar de baja». Si tiene unidades derivadas la base lo frena, y el mensaje llega tal cual. */
export async function bajaEstudioAction(
  _previo: ResultadoDeAccion<{ readonly estudioId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly estudioId: string }>> {
  const valores = valoresDe(form);
  const entrada = validar(bajaEstudioSchema, valores);
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    await bajaEstudio(tx, entrada.entrada);
    return { estudioId: entrada.entrada.estudioId };
  });
  if (resultado.estado === "ok") revalidarLosEstudios();
  return resultado;
}

export async function guardarCriterioAdministracionAction(
  _previo: ResultadoDeAccion<{ readonly guardado: true }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly guardado: true }>> {
  const valores = valoresDe(form);
  const entrada = validar(criterioAdministracionSchema, valores);
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    await guardarCriterioAdministracion(tx, entrada.entrada);
    return { guardado: true as const };
  });
  if (resultado.estado === "ok") revalidarLosEstudios();
  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Mora y estudios del barrio (Configuración del barrio › Mora y estudios)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export async function guardarMoraBarrioAction(
  _previo: ResultadoDeAccion<{ readonly guardado: true }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly guardado: true }>> {
  const valores = valoresDe(form);
  const entrada = validar(moraBarrioSchema, valores);
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    await guardarMoraBarrio(tx, entrada.entrada);
    return { guardado: true as const };
  });
  if (resultado.estado === "ok") revalidarLosEstudios();
  return resultado;
}

/** Sumar o sacar un estudio del barrio, o hacerlo el de por defecto. */
export async function cambiarEstudioDelBarrioAction(
  _previo: ResultadoDeAccion<{ readonly estudioId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly estudioId: string }>> {
  const valores = valoresDe(form);
  const entrada = validar(estudioDelBarrioSchema, valores);
  if (!entrada.ok) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    await cambiarEstudioDelBarrio(tx, entrada.entrada);
    return { estudioId: entrada.entrada.estudioId };
  });
  if (resultado.estado === "ok") revalidarLosEstudios();
  return resultado;
}
