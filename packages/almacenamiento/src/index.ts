/**
 * `ObjectStorage` — la interfaz propia de almacenamiento de objetos (ADR-0000 §3.3).
 *
 * El dominio **nunca** ve el SDK de S3. Los tres proveedores previstos (MinIO local, S3 real, el
 * endpoint S3-compatible de Supabase) hablan el mismo protocolo, así que la interfaz es delgada —
 * pero existe igual, para poder cambiar a un proveedor no-S3 sin tocar un servicio.
 *
 * ### Tres diferencias con la firma ilustrativa del ADR-0000 §3.3, y por qué
 *
 * 1. **`put` es condicional.** El ADR-0002 §6.4 exige `If-None-Match: *`: un reintento **no** puede
 *    sobreescribir un objeto ya emitido. `storage_key unique` protege la fila, no el objeto; sin el
 *    put condicional una segunda corrida cambia el PDF y deja intacto el `sha256` que lo acredita —
 *    un documento emitido cuya integridad declarada es mentira.
 * 2. **`urlFirmada` recibe opciones.** El `no-store` de la respuesta de la aplicación **no viaja al
 *    objeto**: sin `response-cache-control` en el presign, un proxy intermedio puede cachear el PDF.
 *    Y sin `response-content-disposition=attachment` el archivo se renderiza inline — que es lo que
 *    hace que el desplegador de vistas previas de una aplicación de mensajería muestre el importe y
 *    el nombre del titular en la burbuja del chat.
 * 3. **No hay `remove()`.** La retención por defecto es "no purgar nunca" (ADR-0001 §6) y las tablas
 *    de documentos son append-only. Un `remove()` disponible es un `remove()` que alguien va a
 *    llamar. El día que exista una purga, se agrega con su decisión escrita y su credencial propia
 *    — hoy ni la web ni el worker tienen `s3:DeleteObject`, y eso es a propósito.
 */

import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";

/** Las tres carpetas posibles. Cerrado a propósito: es parte del patrón que verifica la base. */
export const CARPETAS_DOCUMENTO = {
  boleta_unidad: "boletas",
  informe_mensual: "informes",
  listado_saldos_pendientes: "listados",
} as const;

export type TipoDocumento = keyof typeof CARPETAS_DOCUMENTO;

/**
 * El patrón de la clave, **desde el segundo segmento en adelante**.
 *
 * Está escrito dos veces —acá en TypeScript y en el `check` de `documento_emitido` en SQL— porque
 * son dos lenguajes y no hay forma de compartir una expresión regular entre ellos. Que no diverjan
 * **no es una convención**: `packages/data/test/documentos-rls.test.ts` le pide a Postgres su propia
 * definición del `check` y verifica que contenga exactamente esta cadena.
 */
export const SUFIJO_PATRON_CLAVE = "/periodos/[0-9a-f-]{36}/(boletas|informes|listados)/[A-Za-z0-9_-]{22,64}\\.pdf$";

/** El patrón completo para un barrio dado: el mismo que evalúa la base sobre su propia fila. */
export function patronClaveDe(barrioId: string): RegExp {
  return new RegExp(`^barrios/${barrioId}${SUFIJO_PATRON_CLAVE}`);
}

/**
 * Un token de 128 bits de un generador criptográfico, en base64url (22 caracteres).
 *
 * **El token no es la autorización.** El bucket es privado y quien decide si alguien puede bajar un
 * documento es la RLS sobre `documento_emitido`. El token existe para que **regenerar cree un objeto
 * nuevo**: la URL que se emitió ayer sigue apuntando al PDF que se auditó ayer, y el documento nuevo
 * no pisa al viejo (ADR-0001 §6).
 */
export function nuevoToken(): string {
  return randomBytes(16).toString("base64url");
}

/** Arma la clave canónica de un documento. Es el único lugar donde se construye una clave. */
export function claveDeDocumento(entrada: {
  barrioId: string;
  periodoId: string;
  tipo: TipoDocumento;
  token: string;
}): string {
  const clave = `barrios/${entrada.barrioId}/periodos/${entrada.periodoId}/${
    CARPETAS_DOCUMENTO[entrada.tipo]
  }/${entrada.token}.pdf`;
  revisarClave(clave);
  return clave;
}

/**
 * Valida una clave y lanza si no sirve. **Corre en todos los métodos del adapter, no solo en `put`.**
 *
 * El caso que justifica el alfabeto cerrado: `barrios/{A}/../{B}/x.pdf` **satisface** cualquier
 * comprobación de prefijo, y resuelve a otro barrio apenas alguien haga un `path.join` sobre la
 * clave — un adapter sobre filesystem, una herramienta de migración, un CDN. Por eso el control no
 * es "empieza con", es un patrón anclado de los dos lados con un alfabeto que no incluye ni `.`
 * repetido, ni `/` de más, ni `\`.
 */
export function revisarClave(clave: string): void {
  if (clave.includes("..") || clave.includes("//") || clave.includes("\\") || clave.startsWith("/")) {
    throw new Error("clave de almacenamiento con recorrido de rutas: se rechaza antes de tocar el storage");
  }
  const generico = new RegExp(
    `^barrios/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${SUFIJO_PATRON_CLAVE}`,
  );
  if (!generico.test(clave)) {
    // Sin interpolar la clave: es el puntero directo al objeto y este mensaje termina en un log.
    throw new Error("clave de almacenamiento con forma inválida: se rechaza antes de tocar el storage");
  }
}

/**
 * Cuánto vive una URL firmada de descarga. **90 segundos.**
 *
 * ADR-0001 §9 fija el techo (≤ 10 min) y ADR-0002 §6.5 el criterio (60–120 s, no 600). Acá está el
 * número, una sola vez: una URL firmada descarga **sin sesión** mientras dure, el `302` se sigue en
 * el acto, y lo único que estira la ventana es un teléfono con mala señal.
 */
export const TTL_DESCARGA_SEGUNDOS = 90;

/** El techo del ADR-0001 §9, verificado en un test y en el `check` de `descarga_documento`. */
export const TTL_MAXIMO_SEGUNDOS = 600;

export type OpcionesPut = {
  contentType: string;
  /**
   * `If-None-Match: *`. Con `true`, escribir sobre una clave existente **falla** en vez de pisarla.
   * Es el default y hay que tener un motivo muy bueno para pasarlo en `false`.
   */
  siNoExiste?: boolean;
  /** Se graba en el objeto además de en el presign: defensa en profundidad. */
  descargarComo?: string;
};

export type OpcionesUrlFirmada = {
  expiraEnSegundos: number;
  /** Nombre de archivo de la descarga. **Nunca el nombre de una persona**: viaja en el querystring. */
  descargarComo: string;
};

export interface ObjectStorage {
  put(clave: string, cuerpo: Buffer, opciones: OpcionesPut): Promise<void>;
  get(clave: string): Promise<Buffer>;
  getStream(clave: string): Promise<Readable>;
  urlFirmada(clave: string, opciones: OpcionesUrlFirmada): Promise<string>;
}

/** Se lanza cuando `put` condicional encuentra el objeto ya escrito. La emisión lo trata como "ya está". */
export class ObjetoYaExiste extends Error {
  constructor() {
    super("el objeto ya existe y el put es condicional: no se sobreescribe un documento emitido");
    this.name = "ObjetoYaExiste";
  }
}

/** Se lanza cuando la clave no está en el bucket. La ruta de descarga lo traduce a un 404. */
export class ObjetoNoEncontrado extends Error {
  constructor() {
    super("el objeto no está en el almacenamiento");
    this.name = "ObjetoNoEncontrado";
  }
}
