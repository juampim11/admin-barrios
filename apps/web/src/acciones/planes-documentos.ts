"use server";

/**
 * Los documentos de un plan de pagos (encargo P2a-3): el modelo de cláusulas (Configuración › Estudios
 * jurídicos), el PDF del plan por sus dos caminos y los documentos que se suben (el firmado y el del
 * estudio), desde la ficha de la unidad.
 *
 * Los mismos pasos que el resto (ADR-0002 §4.2): `parse` con el esquema de
 * `@admin-barrios/shared/planes-documentos`, `conSesion`, una llamada al servicio y la revalidación.
 *
 * **Un documento se sube como el adjunto de una gestión** (`acciones/gestiones.ts`): primero se pide la
 * clave y la URL firmada, el navegador sube el archivo directo al almacenamiento y recién después se
 * agrega con la clave. Al agregarlo, la acción **lee el objeto** y calcula su SHA-256: el servicio no
 * confía en un hash que mande el navegador.
 */

import { ErrorDeNegocio } from "@admin-barrios/shared/errores";
import {
  agregarDocumentoDelPlanSchema,
  armarDocumentoDelPlanSchema,
  crearModeloDeClausulasSchema,
  guardarModeloDeClausulasSchema,
  prepararSubidaDeDocumentoDelPlanSchema,
} from "@admin-barrios/shared/planes-documentos";
import {
  agregarDocumentoDelPlan,
  barrioDelPlanParaSubir,
  crearModeloDeClausulas,
  encolarDocumentoDelPlan,
  guardarModeloDeClausulas,
  prepararSubidaDeDocumentoDelPlan,
} from "@admin-barrios/data/servicios/planes-documentos";
import { sha256DeAdjunto, tipoDeAdjunto } from "@admin-barrios/data/servicios/gestiones";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, traducirFallo, valoresDe, type ResultadoDeAccion } from "./resultado.ts";
import { revalidarElPlanDeLaUnidad, revalidarLosEstudios } from "./revalidar-mora.ts";
import { exigirSubidaConfigurada, leerDocumentoSubidoDelPlan, urlDeSubidaDeComprobante } from "../servidor/almacenamiento.ts";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El modelo de cláusulas
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** «Crear el modelo»: el general de la administración o el de un estudio, con el borrador. */
export async function crearModeloDeClausulasAction(
  _previo: ResultadoDeAccion<{ readonly modeloId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly modeloId: string }>> {
  const valores = valoresDe(form);
  const entrada = crearModeloDeClausulasSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, (tx) => crearModeloDeClausulas(tx, entrada.data));
  if (resultado.estado === "ok") revalidarLosEstudios();
  return resultado;
}

/**
 * Las cláusulas del editor: los campos `titulo.N` y `texto.N`, en orden de `N` (la clave de cada fila,
 * creciente; ver `configuracion/estudios/modelos.tsx`). Si ya viene `clausulas` armado, se respeta.
 */
function armarClausulasDelFormulario(valores: Readonly<Record<string, string>>): string {
  if (valores["clausulas"] !== undefined) return valores["clausulas"];
  const claves = Object.keys(valores)
    .map((k) => /^titulo\.(\d+)$/.exec(k)?.[1])
    .filter((n): n is string => n !== undefined)
    .map((n) => Number.parseInt(n, 10))
    .sort((a, b) => a - b);
  return JSON.stringify(claves.map((n) => ({ titulo: valores[`titulo.${n}`] ?? "", texto: valores[`texto.${n}`] ?? "" })));
}

/** «Guardar» un modelo: sus cláusulas y si el estudio ya validó el texto. */
export async function guardarModeloDeClausulasAction(
  _previo: ResultadoDeAccion<{ readonly modeloId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly modeloId: string }>> {
  const valores = valoresDe(form);
  const entrada = guardarModeloDeClausulasSchema.safeParse({ ...valores, clausulas: armarClausulasDelFormulario(valores) });
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, (tx) =>
    guardarModeloDeClausulas(tx, { modeloId: entrada.data.modeloId, clausulas: entrada.data.clausulas, textoValidado: entrada.data.textoValidado ? "si" : "no" }),
  );
  if (resultado.estado === "ok") revalidarLosEstudios();
  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El PDF del plan
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** «Armar el PDF» por uno de los dos caminos. Lo arma el worker; la ficha se refresca sola mientras tanto. */
export async function armarDocumentoDelPlanAction(
  _previo: ResultadoDeAccion<{ readonly trabajoId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly trabajoId: string }>> {
  const valores = valoresDe(form);
  const entrada = armarDocumentoDelPlanSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, (tx) => encolarDocumentoDelPlan(tx, entrada.data));
  if (resultado.estado === "ok") revalidarElPlanDeLaUnidad();
  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Subir el firmado o el documento del estudio
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Lo que necesita el navegador para subir el documento directo al almacenamiento. */
export type SubidaDeDocumentoPreparada = {
  readonly storageKey: string;
  readonly url: string;
  readonly campos: Readonly<Record<string, string>>;
};

/** Pide la clave y la URL de subida. No agrega el documento: es el paso previo. */
export async function prepararSubidaDeDocumentoDelPlanAction(
  _previo: ResultadoDeAccion<SubidaDeDocumentoPreparada>,
  form: FormData,
): Promise<ResultadoDeAccion<SubidaDeDocumentoPreparada>> {
  const valores = valoresDe(form);
  const entrada = prepararSubidaDeDocumentoDelPlanSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  try {
    exigirSubidaConfigurada();
  } catch (e) {
    return { estado: "falla", error: traducirFallo(e), valores };
  }
  const resultado = await ejecutar(valores, (tx) => prepararSubidaDeDocumentoDelPlan(tx, entrada.data));
  if (resultado.estado !== "ok") return resultado;
  let subida: Awaited<ReturnType<typeof urlDeSubidaDeComprobante>>;
  try {
    subida = await urlDeSubidaDeComprobante(resultado.valor.storageKey, entrada.data.contentType);
  } catch (e) {
    return { estado: "falla", error: traducirFallo(e), valores };
  }
  return { estado: "ok", valor: { storageKey: resultado.valor.storageKey, url: subida.url, campos: subida.campos } };
}

function rechazoDelArchivo(mensaje: string): ErrorDeNegocio {
  return new ErrorDeNegocio({
    codigo: "dato_invalido",
    mensaje,
    sugerencia: "Volvé a elegir el archivo, esperá a que diga «listo para enviar» y agregalo.",
    correlacion: `web-${crypto.randomUUID().slice(0, 8)}`,
  });
}

/** «No existe» y «no se pudo verificar» dicen lo mismo (mismo criterio que el adjunto de una gestión). */
const ARCHIVO_NO_VERIFICABLE = "El archivo no llegó a subirse o no se pudo verificar; elegilo de nuevo.";
const ARCHIVO_DE_OTRO_TIPO = "El archivo no es un PDF, JPG o PNG válido.";

/**
 * «Agregar» el firmado o el documento del estudio. Antes del servicio, fuera de la transacción: el
 * permiso sobre el plan (que da su barrio), y leer el objeto subido para calcular su SHA-256.
 */
export async function agregarDocumentoDelPlanAction(
  _previo: ResultadoDeAccion<{ readonly documentoId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly documentoId: string }>> {
  const valores = valoresDe(form);
  const entrada = agregarDocumentoDelPlanSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const { planId, clave } = entrada.data;

  const permiso = await ejecutar(valores, (tx) => barrioDelPlanParaSubir(tx, { planId }));
  if (permiso.estado === "falla" || permiso.estado === "confirmar") return { estado: "falla", error: permiso.error, valores };
  if (permiso.estado !== "ok") return { estado: "falla", error: traducirFallo(rechazoDelArchivo(ARCHIVO_NO_VERIFICABLE)), valores };

  let leido: Awaited<ReturnType<typeof leerDocumentoSubidoDelPlan>>;
  try {
    leido = await leerDocumentoSubidoDelPlan(clave, permiso.valor.barrioId, planId);
  } catch (e) {
    return { estado: "falla", error: traducirFallo(e), valores };
  }
  if (leido.estado === "no_verificable") return { estado: "falla", error: traducirFallo(rechazoDelArchivo(ARCHIVO_NO_VERIFICABLE)), valores };
  if (leido.estado === "tipo_invalido") return { estado: "falla", error: traducirFallo(rechazoDelArchivo(ARCHIVO_DE_OTRO_TIPO)), valores };

  const contenido = leido.contenido;
  const resultado = await ejecutar(valores, (tx) =>
    agregarDocumentoDelPlan(tx, {
      ...entrada.data,
      sha256: sha256DeAdjunto(contenido),
      bytes: contenido.byteLength,
      contentType: tipoDeAdjunto(clave),
    }),
  );
  if (resultado.estado === "ok") revalidarElPlanDeLaUnidad();
  return resultado;
}
