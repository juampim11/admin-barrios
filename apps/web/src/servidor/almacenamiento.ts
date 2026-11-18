import "server-only";

/**
 * **El único camino de `apps/web` al almacenamiento de objetos.**
 *
 * Mismo patrón que `db.ts`: un solo archivo conoce el adapter concreto, y el test de arquitectura
 * (regla 12) falla si `@admin-barrios/almacenamiento/s3` se nombra desde cualquier otro lado. La
 * regla dura de `CLAUDE.md` §1 no es "no usar S3": es que ningún servicio de negocio lo llame
 * directo.
 *
 * **La credencial de la web es de solo lectura y aun así alcanza al bucket entero.** Eso hay que
 * tenerlo presente cada vez que se toque este archivo: presignar una URL **no consulta a nadie**, se
 * calcula localmente con la clave. Lo único que separa "la boleta de esta unidad" de "todas las
 * boletas de todos los barrios" es que la `storage_key` haya salido de una fila leída bajo RLS —
 * `prepararDescarga()` en `@admin-barrios/data/servicios/documentos`. Una ruta que acepte una clave
 * por parámetro convierte esta credencial en una llave maestra.
 */

import { crearAlmacenamientoS3 } from "@admin-barrios/almacenamiento/s3";
import {
  ObjetoNoEncontrado,
  SUFIJO_PATRON_CLAVE_ADJUNTO_GESTION,
  SUFIJO_PATRON_CLAVE_DOCUMENTO_PLAN,
  SUFIJO_PATRON_CLAVE_RENDICION,
  TTL_SUBIDA_SEGUNDOS,
  type ObjectStorage,
  type SubidaFirmada,
} from "@admin-barrios/almacenamiento";
import { TAMANO_MAXIMO_COMPROBANTE_BYTES } from "@admin-barrios/shared/cobros";
import { ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { leerConfiguracion, type Configuracion } from "./configuracion.ts";
import { firmaCoincideConLaClave } from "./firma-de-archivo.ts";

let instancia: ObjectStorage | null = null;

/**
 * Devuelve el almacenamiento, o **lanza con un mensaje propio** si el proceso no lo tiene
 * configurado. El mensaje importa: sin esto, una instancia sin `S3_*` falla con un error del SDK de
 * AWS en el medio de una descarga, y el motivo queda a tres capas del síntoma.
 */
export function almacenamiento(): ObjectStorage {
  if (instancia) return instancia;
  const config = leerConfiguracion();
  if (!config.s3) {
    throw new Error(
      "esta instancia de la web no tiene configurado el almacenamiento de documentos: faltan las " +
        "variables S3_* (ver apps/web/.env.local.example). La descarga no puede funcionar sin ellas.",
    );
  }
  instancia = crearAlmacenamientoS3({
    endpoint: config.s3.endpoint,
    endpointPublico: config.s3.endpointPublico,
    region: config.s3.region,
    bucket: config.s3.bucket,
    forzarRutaDeBucket: config.s3.rutaDeBucket,
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
    credencialesSubida: config.s3.subida ?? undefined,
  });
  return instancia;
}

/**
 * Firma el POST de subida de un comprobante. **Única puerta de la acción a esta credencial**: el
 * gate de arquitectura (regla 9) no deja que un archivo `"use server"` importe
 * `@admin-barrios/almacenamiento` directo, así que `acciones/cobros.ts` llama acá, nunca al adapter.
 *
 * Recibe la `storageKey` ya registrada por `prepararSubidaDeComprobante()` (la auditoría se escribió
 * antes, en `packages/data`) y el `contentType` que la acompaña — los mismos que declaró quien pidió
 * subir, para que la condición `eq` del POST policy sea exacta.
 */
/**
 * Rechaza con `subida_no_configurada` si este entorno no tiene la credencial de subida. Las acciones
 * lo llaman **antes** de registrar el pedido de subida: si no, cada intento dejaba una fila de
 * solicitud huérfana (revisión de código, BL-019).
 */
export function exigirSubidaConfigurada(configuracion: Configuracion = leerConfiguracion()): void {
  if (configuracion.s3?.subida) return;
  throw new ErrorDeNegocio({
    codigo: "subida_no_configurada",
    mensaje: "La subida de archivos no está configurada en este entorno.",
    sugerencia:
      "Avisale a quien administra el sistema: falta la credencial de subida (S3_SUBIDA_COMPROBANTE_*, ver apps/web/.env.local.example). Mientras tanto, lo demás se puede guardar sin el archivo.",
    correlacion: `web-${crypto.randomUUID().slice(0, 8)}`,
  });
}

export async function urlDeSubidaDeComprobante(
  clave: string,
  contentType: string,
  /** Solo para los tests: en la aplicación es siempre la del proceso. */
  configuracion: Configuracion = leerConfiguracion(),
): Promise<SubidaFirmada> {
  /*
   * BL-019: sin la credencial de subida, el adapter lanza un `Error` común, la acción lo dejaba
   * escapar y la pantalla decía «No se pudo pedir la URL de subida. Probá de nuevo» — como si fuera
   * la red. Reintentar no arregla nada: es configuración del entorno. Se rechaza con un código propio
   * que la acción devuelve como `falla`, con un mensaje que dice qué falta.
   */
  exigirSubidaConfigurada(configuracion);
  return almacenamiento().urlFirmadaDeSubida(clave, {
    expiraEnSegundos: TTL_SUBIDA_SEGUNDOS,
    contentType,
    tamanoMaximoBytes: TAMANO_MAXIMO_COMPROBANTE_BYTES,
  });
}

/**
 * Si este entorno puede firmar subidas. Lo pregunta la ficha de mora **antes** de ofrecer el adjunto
 * de una gestión: sin la credencial, el diálogo lo dice y deja registrar sin archivo solo los canales
 * que no lo piden (encargo E-a2). No expone nada: es un sí o un no.
 */
export function subidaConfigurada(configuracion: Configuracion = leerConfiguracion()): boolean {
  return configuracion.s3?.subida != null;
}

/** Lo que se leyó del adjunto de una gestión. */
export type AdjuntoLeido =
  /** No existe, o la clave no es de un adjunto de ese barrio: el mismo caso, con el mismo mensaje. */
  | { readonly estado: "no_verificable" }
  /** Existe, pero los bytes no son los de su extensión (`firma-de-archivo.ts`). */
  | { readonly estado: "tipo_invalido" }
  | { readonly estado: "ok"; readonly contenido: Buffer };

/**
 * Lee lo que el navegador subió como adjunto de una gestión, para que la acción calcule su sha256
 * **leyendo el objeto** (el servicio no confía en un hash del cliente).
 *
 * `barrioId` es el de la unidad, **ya verificado bajo la sesión** por quien llama (la acción lo saca
 * del servicio, que exige poder registrar en ese barrio): la credencial de la web alcanza al bucket
 * entero, y una clave que manda el cliente no puede servir para leer otra cosa que un adjunto de
 * gestión **de ese barrio**. La forma se mira antes de tocar el almacenamiento. El tamaño lo acotó el
 * POST firmado (`TAMANO_MAXIMO_COMPROBANTE_BYTES`).
 */
export async function leerAdjuntoDeGestion(clave: string, barrioId: string): Promise<AdjuntoLeido> {
  if (!/^[0-9a-f-]{36}$/.test(barrioId)) return { estado: "no_verificable" };
  if (!new RegExp(`^barrios/${barrioId}${SUFIJO_PATRON_CLAVE_ADJUNTO_GESTION}`).test(clave)) return { estado: "no_verificable" };
  let contenido: Buffer;
  try {
    contenido = await almacenamiento().get(clave);
  } catch (e) {
    if (e instanceof ObjetoNoEncontrado) return { estado: "no_verificable" };
    throw e;
  }
  return firmaCoincideConLaClave(contenido, clave) ? { estado: "ok", contenido } : { estado: "tipo_invalido" };
}

/**
 * Lee lo que el navegador subió como documento de un plan (el firmado o el del estudio, encargo P2a-3),
 * para que la acción calcule su SHA-256 **leyendo el objeto**. Mismo criterio que `leerAdjuntoDeGestion`:
 * `barrioId` y `planId` ya los verificó quien llama bajo la sesión (con permiso de agregar documentos a
 * ese plan), y la clave del cliente tiene que ser de ese plan antes de tocar el almacenamiento.
 */
export async function leerDocumentoSubidoDelPlan(clave: string, barrioId: string, planId: string): Promise<AdjuntoLeido> {
  const uuid = /^[0-9a-f-]{36}$/;
  if (!uuid.test(barrioId) || !uuid.test(planId)) return { estado: "no_verificable" };
  if (!new RegExp(`^barrios/${barrioId}${SUFIJO_PATRON_CLAVE_DOCUMENTO_PLAN}`).test(clave) || !clave.startsWith(`barrios/${barrioId}/planes/${planId}/`)) {
    return { estado: "no_verificable" };
  }
  let contenido: Buffer;
  try {
    contenido = await almacenamiento().get(clave);
  } catch (e) {
    if (e instanceof ObjetoNoEncontrado) return { estado: "no_verificable" };
    throw e;
  }
  return firmaCoincideConLaClave(contenido, clave) ? { estado: "ok", contenido } : { estado: "tipo_invalido" };
}

/**
 * Lee lo que el navegador subió para una rendición del estudio (el PDF firmado o el comprobante de un
 * ingreso, encargo P2b), para que la acción calcule su SHA-256 **leyendo el objeto**. Mismo criterio que
 * `leerDocumentoSubidoDelPlan`: `barrioId` y `rendicionId` ya los verificó quien llama bajo la sesión, y
 * la clave tiene que ser de esa rendición antes de tocar el almacenamiento. El PDF firmado va solo en PDF.
 */
export async function leerArchivoDeRendicion(clave: string, barrioId: string, rendicionId: string, soloPdf: boolean): Promise<AdjuntoLeido> {
  const uuid = /^[0-9a-f-]{36}$/;
  if (!uuid.test(barrioId) || !uuid.test(rendicionId)) return { estado: "no_verificable" };
  if (!new RegExp(`^barrios/${barrioId}${SUFIJO_PATRON_CLAVE_RENDICION}`).test(clave) || !clave.startsWith(`barrios/${barrioId}/rendiciones/${rendicionId}/`)) {
    return { estado: "no_verificable" };
  }
  if (soloPdf && !clave.endsWith(".pdf")) return { estado: "tipo_invalido" };
  let contenido: Buffer;
  try {
    contenido = await almacenamiento().get(clave);
  } catch (e) {
    if (e instanceof ObjetoNoEncontrado) return { estado: "no_verificable" };
    throw e;
  }
  return firmaCoincideConLaClave(contenido, clave) ? { estado: "ok", contenido } : { estado: "tipo_invalido" };
}
