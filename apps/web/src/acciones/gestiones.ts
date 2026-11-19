"use server";

/**
 * La ficha de mora de una unidad (encargo E-a2; maqueta de mora, pantalla 3): registrar y anular una
 * gestión, el adjunto de una gestión, y retirar la unidad del estudio.
 *
 * Los mismos cuatro pasos que el resto (ADR-0002 §4.2): `parse` con el esquema de
 * `@admin-barrios/shared/mora`, `conSesion`, **una** llamada al servicio y la revalidación. Quién
 * puede, la promesa de hoy en adelante y hasta el plazo, el doble clic, que la clave del adjunto sea
 * del barrio de la unidad: lo deciden el esquema, el servicio y la base.
 *
 * **El adjunto se sube como el comprobante de un pago** (`acciones/cobros.ts`): primero se pide la
 * clave y la URL firmada, el navegador sube el archivo directo al almacenamiento y recién después se
 * registra la gestión con la clave. Al registrar, la acción **lee el objeto** y calcula su sha256: el
 * servicio no confía en un hash que mande el navegador (ver `registrarGestion`).
 */

import {
  anularGestionSchema,
  prepararSubidaDeAdjuntoSchema,
  registrarGestionSchema,
  retirarSchema,
  type PrepararSubidaDeAdjunto,
  type RegistrarGestion,
} from "@admin-barrios/shared/mora";
import { ErrorDeNegocio } from "@admin-barrios/shared/errores";
import {
  anularGestion,
  prepararSubidaDeAdjuntoDeGestion,
  registrarGestion,
  sha256DeAdjunto,
  tipoDeAdjunto,
} from "@admin-barrios/data/servicios/gestiones";
import { retirar } from "@admin-barrios/data/servicios/mora";
import { conConfirmacion } from "./confirmacion.ts";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, traducirFallo, valoresDe, type ResultadoDeAccion } from "./resultado.ts";
import { revalidarLaMora, revalidarLosEstudios } from "./revalidar-mora.ts";
import { exigirSubidaConfigurada, leerAdjuntoDeGestion, urlDeSubidaDeComprobante } from "../servidor/almacenamiento.ts";

/** Lo que necesita el navegador para subir el adjunto directo al almacenamiento. */
export type SubidaDeAdjuntoPreparada = {
  readonly storageKey: string;
  readonly url: string;
  readonly campos: Readonly<Record<string, string>>;
};

/**
 * Pide la clave y la URL de subida del adjunto de una gestión. **No registra la gestión**: es el paso
 * previo, igual que `prepararSubidaDeComprobanteAction`. La URL se firma con la misma puerta y el
 * mismo tamaño máximo que el comprobante de un pago (`urlDeSubidaDeComprobante`: recibe la clave y el
 * tipo, no sabe de qué es). Sin `revalidatePath`: no cambia nada que se vea.
 */
export async function prepararSubidaDeAdjuntoDeGestionAction(
  _previo: ResultadoDeAccion<SubidaDeAdjuntoPreparada>,
  form: FormData,
): Promise<ResultadoDeAccion<SubidaDeAdjuntoPreparada>> {
  const valores = valoresDe(form);
  const entrada = prepararSubidaDeAdjuntoSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  try {
    exigirSubidaConfigurada();
  } catch (e) {
    return { estado: "falla", error: traducirFallo(e), valores };
  }
  const resultado = await ejecutar(valores, (tx) => prepararSubidaDeAdjuntoDeGestion(tx, entrada.data));
  if (resultado.estado !== "ok") return resultado;

  let subida: Awaited<ReturnType<typeof urlDeSubidaDeComprobante>>;
  try {
    subida = await urlDeSubidaDeComprobante(resultado.valor.storageKey, entrada.data.contentType);
  } catch (e) {
    return { estado: "falla", error: traducirFallo(e), valores };
  }
  return { estado: "ok", valor: { storageKey: resultado.valor.storageKey, url: subida.url, campos: subida.campos } };
}

/** Un rechazo del adjunto, como `falla` con su mensaje (no hay campo al que atarlo: es el archivo). */
function rechazoDelAdjunto(mensaje: string): ErrorDeNegocio {
  return new ErrorDeNegocio({
    codigo: "dato_invalido",
    mensaje,
    sugerencia: "Volvé a elegir el archivo, esperá a que diga «listo para enviar» y registrá la gestión.",
    correlacion: `web-${crypto.randomUUID().slice(0, 8)}`,
  });
}

/**
 * «No existe» y «no se pudo verificar» dicen lo mismo (security-engineer): la diferencia no le sirve a
 * quien registra y sí a quien tantea claves.
 */
const ADJUNTO_NO_VERIFICABLE = "El archivo no llegó a subirse o no se pudo verificar; elegilo de nuevo.";
const ADJUNTO_DE_OTRO_TIPO = "El archivo no es un PDF, JPG o PNG válido.";

/**
 * «Registrar gestión». El formulario manda el adjunto como dos campos sueltos —la clave que dejó la
 * subida (`adjuntoClave`) y el nombre del archivo (`adjuntoNombre`)— y acá se arma el objeto que pide
 * el esquema. Lo único que se hace antes del servicio, fuera de la transacción (nada lento adentro de
 * `conSesion`), es leer el objeto subido y calcular su sha256.
 */
export async function registrarGestionAction(
  _previo: ResultadoDeAccion<{ readonly gestionId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly gestionId: string }>> {
  const valores = valoresDe(form);
  const clave = valores["adjuntoClave"] ?? "";
  const entrada: RegistrarGestion = {
    unidadFuncionalId: valores["unidadFuncionalId"] ?? "",
    canal: valores["canal"] as RegistrarGestion["canal"],
    resultado: valores["resultado"] as RegistrarGestion["resultado"],
    nota: valores["nota"] ?? null,
    promesaFecha: valores["promesaFecha"] ?? null,
    promesaMonto: valores["promesaMonto"] ?? null,
    adjunto: clave === "" ? null : { clave, nombre: valores["adjuntoNombre"] ?? "" },
  };
  const validado = registrarGestionSchema.safeParse(entrada);
  if (!validado.success) return camposInvalidos(validado.error, valores);

  let adjuntoSha256: string | null = null;
  if (entrada.adjunto) {
    const clave = entrada.adjunto.clave;
    /*
     * Antes de tocar el bucket: la sesión y el permiso de registrar en el barrio de la unidad. Lo
     * resuelve `prepararSubidaDeAdjuntoDeGestion` —la misma verificación que dio la clave al subir, bajo
     * RLS y sin escribir nada— y su clave nueva dice el barrio (`barrios/{barrio}/gestiones/…`): con
     * ese barrio se arma el patrón que la clave del cliente tiene que cumplir. No hay un servicio que
     * devuelva solo el barrio, y esto evita tocar `packages/data` en esta tanda.
     */
    const permiso = await ejecutar(valores, (tx) =>
      prepararSubidaDeAdjuntoDeGestion(tx, { unidadFuncionalId: entrada.unidadFuncionalId, contentType: tipoDeAdjunto(clave) as PrepararSubidaDeAdjunto["contentType"] }),
    );
    if (permiso.estado === "falla" || permiso.estado === "confirmar") return { estado: "falla", error: permiso.error, valores };
    if (permiso.estado !== "ok") return { estado: "falla", error: traducirFallo(rechazoDelAdjunto(ADJUNTO_NO_VERIFICABLE)), valores };
    const barrioId = permiso.valor.storageKey.split("/")[1] ?? "";

    let leido: Awaited<ReturnType<typeof leerAdjuntoDeGestion>>;
    try {
      leido = await leerAdjuntoDeGestion(clave, barrioId);
    } catch (e) {
      return { estado: "falla", error: traducirFallo(e), valores };
    }
    if (leido.estado === "no_verificable") return { estado: "falla", error: traducirFallo(rechazoDelAdjunto(ADJUNTO_NO_VERIFICABLE)), valores };
    if (leido.estado === "tipo_invalido") return { estado: "falla", error: traducirFallo(rechazoDelAdjunto(ADJUNTO_DE_OTRO_TIPO)), valores };
    adjuntoSha256 = sha256DeAdjunto(leido.contenido);
  }

  // Al servicio, la entrada (no la salida del `parse`): él vuelve a parsear, que es su límite.
  const resultado = await ejecutar(valores, (tx) => registrarGestion(tx, { ...entrada, adjuntoSha256 }));
  if (resultado.estado === "ok") revalidarLaMora();
  return resultado;
}

/** «Anular» una gestión de la administración, con motivo. La gestión queda, tachada. */
export async function anularGestionAction(
  _previo: ResultadoDeAccion<{ readonly gestionId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly gestionId: string }>> {
  const valores = valoresDe(form);
  const entrada = anularGestionSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    await anularGestion(tx, entrada.data);
    return { gestionId: entrada.data.gestionId };
  });
  if (resultado.estado === "ok") revalidarLaMora();
  return resultado;
}

/** «Retirar del estudio». La historia queda: gestiones, foto de la derivación y el retiro. */
export async function retirarAction(
  _previo: ResultadoDeAccion<{ readonly derivacionId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly derivacionId: string }>> {
  const valores = valoresDe(form);
  // [F4 tramo 4] La confirmación de retirar con deuda («Pagó la deuda»): solo alimenta el `parse`.
  const entrada = retirarSchema.safeParse(conConfirmacion(valores));
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    await retirar(tx, entrada.data);
    return { derivacionId: entrada.data.derivacionId };
  });
  // Los estudios también: sus «derivadas» cambian (y `revalidarLosEstudios` incluye la mora).
  if (resultado.estado === "ok") revalidarLosEstudios();
  return resultado;
}
