"use server";

/**
 * La rendición manual del estudio (encargo P2b, pantalla 5): abrirla, cargarle las cuotas que cobró
 * el estudio y los ingresos al barrio, adjuntar el PDF firmado y confirmarla.
 *
 * Los mismos pasos que el resto (ADR-0002 §4.2): `parse` con el esquema de
 * `@admin-barrios/shared/planes-rendicion`, `conSesion`, una llamada al servicio y la revalidación.
 *
 * **Los archivos se suben como los documentos del plan** (`acciones/planes-documentos.ts`): primero se
 * pide la clave y la URL firmada, el navegador sube directo al almacenamiento y recién después se agrega
 * con la clave. Al agregarlo, la acción **lee el objeto** y calcula su SHA-256: el servicio no confía en
 * un hash que mande el navegador.
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ErrorDeNegocio } from "@admin-barrios/shared/errores";
import {
  adjuntarPdfDeRendicionSchema,
  agregarCuotaARendicionSchema,
  agregarIngresoARendicionSchema,
  crearRendicionSchema,
  prepararSubidaDeRendicionSchema,
} from "@admin-barrios/shared/planes-rendicion";
import { idSchema } from "@admin-barrios/shared/consultas";
import {
  adjuntarPdfDeRendicion,
  agregarCuotaARendicion,
  agregarIngresoARendicion,
  confirmarRendicion,
  crearRendicion,
  prepararSubidaDeRendicion,
  quitarCuotaDeRendicion,
  quitarIngresoDeRendicion,
  rendicionParaSubir,
} from "@admin-barrios/data/servicios/planes-rendicion";
import { sha256DeAdjunto } from "@admin-barrios/data/servicios/gestiones";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, traducirFallo, valoresDe, type ResultadoDeAccion } from "./resultado.ts";
import { revalidarElPlanDeLaUnidad } from "./revalidar-mora.ts";
import { exigirSubidaConfigurada, leerArchivoDeRendicion, urlDeSubidaDeComprobante } from "../servidor/almacenamiento.ts";
import { rutaDeRendicion } from "../rutas.ts";

function revalidarLasRendiciones(): void {
  revalidatePath("/[barrio]/rendiciones", "page");
  revalidatePath("/[barrio]/rendiciones/[rendicion]", "page");
}

/** «Nueva rendición»: el estudio y el mes que rinde. Lleva a la rendición, en borrador. */
export async function crearRendicionAction(
  _previo: ResultadoDeAccion<{ readonly rendicionId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly rendicionId: string }>> {
  const valores = valoresDe(form);
  const entrada = crearRendicionSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, (tx) => crearRendicion(tx, entrada.data));
  if (resultado.estado !== "ok") return resultado;
  revalidarLasRendiciones();
  redirect(rutaDeRendicion(entrada.data.barrioId, resultado.valor.rendicionId));
}

/** «Agregar la cuota»: una cuota que cobró el estudio, con el importe (pago parcial permitido). */
export async function agregarCuotaARendicionAction(
  _previo: ResultadoDeAccion<{ readonly id: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly id: string }>> {
  const valores = valoresDe(form);
  const entrada = agregarCuotaARendicionSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, (tx) => agregarCuotaARendicion(tx, entrada.data));
  if (resultado.estado === "ok") revalidarLasRendiciones();
  return resultado;
}

/** «Quitar» una cuota o un ingreso de la rendición en borrador. */
export async function quitarDeRendicionAction(_previo: ResultadoDeAccion<null>, form: FormData): Promise<ResultadoDeAccion<null>> {
  const valores = valoresDe(form);
  const id = idSchema.safeParse(valores["id"]);
  const que = valores["que"];
  if (!id.success || (que !== "cuota" && que !== "ingreso")) return { estado: "falla", error: traducirFallo(new Error("pedido inválido")), valores };
  const resultado = await ejecutar(valores, async (tx) => {
    if (que === "cuota") await quitarCuotaDeRendicion(tx, { id: id.data });
    else await quitarIngresoDeRendicion(tx, { id: id.data });
    return null;
  });
  if (resultado.estado === "ok") revalidarLasRendiciones();
  return resultado;
}

/** «Confirmar la rendición»: cada pedazo de ingreso queda como un pago imputado a su cuota. */
export async function confirmarRendicionAction(
  _previo: ResultadoDeAccion<{ readonly pagos: number }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly pagos: number }>> {
  const valores = valoresDe(form);
  const id = idSchema.safeParse(valores["rendicionId"]);
  if (!id.success) return { estado: "falla", error: traducirFallo(new Error("pedido inválido")), valores };
  const resultado = await ejecutar(valores, (tx) => confirmarRendicion(tx, { rendicionId: id.data }));
  if (resultado.estado === "ok") {
    revalidarLasRendiciones();
    revalidarElPlanDeLaUnidad();
  }
  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Los archivos: el PDF firmado y el comprobante de cada ingreso
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type SubidaDeRendicionPreparada = {
  readonly storageKey: string;
  readonly url: string;
  readonly campos: Readonly<Record<string, string>>;
};

/** Pide la clave y la URL de subida. No agrega nada: es el paso previo. */
export async function prepararSubidaDeRendicionAction(
  _previo: ResultadoDeAccion<SubidaDeRendicionPreparada>,
  form: FormData,
): Promise<ResultadoDeAccion<SubidaDeRendicionPreparada>> {
  const valores = valoresDe(form);
  const entrada = prepararSubidaDeRendicionSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  try {
    exigirSubidaConfigurada();
  } catch (e) {
    return { estado: "falla", error: traducirFallo(e), valores };
  }
  const resultado = await ejecutar(valores, (tx) => prepararSubidaDeRendicion(tx, entrada.data));
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

const ARCHIVO_NO_VERIFICABLE = "El archivo no llegó a subirse o no se pudo verificar; elegilo de nuevo.";

/** Lee el archivo subido (con el permiso sobre la rendición ya verificado) y devuelve su SHA-256 y sus bytes. */
async function leerYMedir(
  valores: Readonly<Record<string, string>>,
  rendicionId: string,
  clave: string,
  soloPdf: boolean,
): Promise<{ readonly ok: true; readonly sha256: string; readonly bytes: number } | { readonly ok: false; readonly falla: ResultadoDeAccion<never> }> {
  const permiso = await ejecutar(valores, (tx) => rendicionParaSubir(tx, { rendicionId }));
  if (permiso.estado === "falla" || permiso.estado === "confirmar") return { ok: false, falla: { estado: "falla", error: permiso.error, valores } };
  if (permiso.estado !== "ok") return { ok: false, falla: { estado: "falla", error: traducirFallo(rechazoDelArchivo(ARCHIVO_NO_VERIFICABLE)), valores } };
  let leido: Awaited<ReturnType<typeof leerArchivoDeRendicion>>;
  try {
    leido = await leerArchivoDeRendicion(clave, permiso.valor.barrioId, rendicionId, soloPdf);
  } catch (e) {
    return { ok: false, falla: { estado: "falla", error: traducirFallo(e), valores } };
  }
  if (leido.estado === "no_verificable") return { ok: false, falla: { estado: "falla", error: traducirFallo(rechazoDelArchivo(ARCHIVO_NO_VERIFICABLE)), valores } };
  if (leido.estado === "tipo_invalido") {
    const mensaje = soloPdf ? "La rendición firmada tiene que ser un PDF válido." : "El archivo no es un PDF, JPG o PNG válido.";
    return { ok: false, falla: { estado: "falla", error: traducirFallo(rechazoDelArchivo(mensaje)), valores } };
  }
  return { ok: true, sha256: sha256DeAdjunto(leido.contenido), bytes: leido.contenido.byteLength };
}

/** «Adjuntar» el PDF firmado por el estudio (mientras está en borrador, se puede cambiar). */
export async function adjuntarPdfDeRendicionAction(_previo: ResultadoDeAccion<null>, form: FormData): Promise<ResultadoDeAccion<null>> {
  const valores = valoresDe(form);
  const entrada = adjuntarPdfDeRendicionSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const medido = await leerYMedir(valores, entrada.data.rendicionId, entrada.data.clave, true);
  if (!medido.ok) return medido.falla;
  const resultado = await ejecutar(valores, async (tx) => {
    await adjuntarPdfDeRendicion(tx, { ...entrada.data, sha256: medido.sha256, bytes: medido.bytes });
    return null;
  });
  if (resultado.estado === "ok") revalidarLasRendiciones();
  return resultado;
}

/** «Agregar el ingreso»: una transferencia o un depósito a la cuenta del barrio, con su comprobante. */
export async function agregarIngresoARendicionAction(
  _previo: ResultadoDeAccion<{ readonly id: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly id: string }>> {
  const valores = valoresDe(form);
  const entrada = agregarIngresoARendicionSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const medido = await leerYMedir(valores, entrada.data.rendicionId, entrada.data.clave, false);
  if (!medido.ok) return medido.falla;
  const resultado = await ejecutar(valores, (tx) => agregarIngresoARendicion(tx, { ...entrada.data, sha256: medido.sha256, bytes: medido.bytes }));
  if (resultado.estado === "ok") revalidarLasRendiciones();
  return resultado;
}
