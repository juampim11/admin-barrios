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

/**
 * Mismo criterio que `SUFIJO_PATRON_CLAVE`, para el recibo de un pago — espejo de
 * `recibo_storage_key_chk` (`0038_recibos.sql`). Constante propia y no una variante de la de
 * documentos: son dos `CHECK` distintos en la base, y `documentos-rls.test.ts` compara
 * `SUFIJO_PATRON_CLAVE` contra el suyo **letra por letra** — mezclarlas rompería ese cross-check.
 */
export const SUFIJO_PATRON_CLAVE_RECIBO = "/pagos/[0-9a-f-]{36}/recibos/[A-Za-z0-9_-]{22,64}\\.pdf$";

/**
 * Mismo criterio, para el comprobante adjunto a un pago manual — espejo de
 * `pago_comprobante_storage_key_chk` (`0032_pago.sql`). A diferencia de las otras dos, admite más
 * de una extensión: un comprobante puede ser el PDF de una transferencia o la foto de un depósito.
 */
export const SUFIJO_PATRON_CLAVE_COMPROBANTE = "/pagos/comprobantes/[A-Za-z0-9_-]{22,64}\\.(pdf|jpg|jpeg|png)$";

/** El patrón completo de un documento de período, para un barrio dado. */
export function patronClaveDe(barrioId: string): RegExp {
  return new RegExp(`^barrios/${barrioId}${SUFIJO_PATRON_CLAVE}`);
}

/** Las extensiones que acepta un comprobante, y el content-type S3/MinIO exacto que le corresponde
 * a cada una — se usa para armar la condición `eq` del POST presignado de subida. */
export const EXTENSION_COMPROBANTE_POR_CONTENT_TYPE = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
} as const;
export type ContentTypeDeComprobante = keyof typeof EXTENSION_COMPROBANTE_POR_CONTENT_TYPE;

/**
 * Arma la clave canónica del comprobante adjunto de un pago manual. **Sin `pagoId`**, a diferencia
 * de `claveDeDocumento()`/la de un recibo: la subida pasa ANTES de que exista la fila de `pago` —
 * `registrarPago()` recién la recibe como parámetro, ya subida (`0032_pago.sql`).
 */
export function claveDeComprobante(entrada: {
  barrioId: string;
  token: string;
  contentType: ContentTypeDeComprobante;
}): string {
  const extension = EXTENSION_COMPROBANTE_POR_CONTENT_TYPE[entrada.contentType];
  const clave = `barrios/${entrada.barrioId}/pagos/comprobantes/${entrada.token}.${extension}`;
  revisarClave(clave);
  return clave;
}

/**
 * El content-type que le corresponde a la extensión de CUALQUIER clave del bucket — el reverso de
 * `EXTENSION_COMPROBANTE_POR_CONTENT_TYPE`, más `pdf` (que ya es uno de sus valores, pero acá cubre
 * también un `documento_emitido`/`recibo_emitido`, que nunca pasan por `claveDeComprobante` y aun
 * así son `.pdf`). Exhaustiva contra los tres `SUFIJO_PATRON_CLAVE*`: ninguno admite una extensión
 * que no esté acá, así que `urlFirmada()` la puede usar sin un `default` que adivine.
 */
export const CONTENT_TYPE_POR_EXTENSION: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

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
 * Los tres sufijos válidos hoy, en el mismo orden que sus `CHECK` en la base. **Bug real, cerrado
 * acá:** hasta esta migración de código, `revisarClave()` solo conocía el de documentos —
 * `prepararDescargaDeRecibo()`/`prepararDescargaDeComprobante()` (`documentos.ts`) devolvían una
 * `storageKey` válida contra su propio `CHECK` de Postgres, pero `urlFirmada()` la rechazaba antes
 * de firmar nada. Confirmado con un test real contra MinIO
 * (`packages/almacenamiento/test/s3.test.ts`, bloque "DIAGNÓSTICO"), no solo por lectura de código:
 * las dos rutas de descarga (`/api/recibos/[reciboId]`, `/api/comprobantes/[pagoId]`) devolvían 500
 * para cualquier clave real.
 */
const SUFIJOS_PATRON_CLAVE = [SUFIJO_PATRON_CLAVE, SUFIJO_PATRON_CLAVE_RECIBO, SUFIJO_PATRON_CLAVE_COMPROBANTE];

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
  const prefijoBarrio = "^barrios/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const valida = SUFIJOS_PATRON_CLAVE.some((sufijo) => new RegExp(`${prefijoBarrio}${sufijo}`).test(clave));
  if (!valida) {
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

/**
 * Cuánto vive una URL de SUBIDA firmada. **180 segundos — más corto que el techo de 600s, y por un
 * motivo de escritura, no de lectura**: una firma de subida filtrada u olvidada en un log es una
 * ventana en la que alguien puede escribir un objeto con esa credencial, no solo leerlo, así que
 * conviene una ventana más corta que la de descarga en la misma proporción en que escribir pesa más
 * que leer.
 *
 * Pero no puede ser tan corta como `TTL_DESCARGA_SEGUNDOS` (90s): a diferencia de una boleta en PDF
 * —unos pocos KB, servidos por la aplicación—, acá el propio navegador transfiere hasta
 * `TAMANO_MAXIMO_COMPROBANTE_BYTES` (10 MB, `@admin-barrios/shared/cobros`) directo contra el
 * storage. A 90s, una conexión de ~1 Mbps (mala, pero no rara en un celular) ya está al límite para
 * los 10 MB completos, sin margen para reintento. 180s da el doble de esa ventana — más margen para
 * una conexión mala, sin acercarse al techo del ADR.
 */
export const TTL_SUBIDA_SEGUNDOS = 180;

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

export type OpcionesUrlFirmadaDeSubida = {
  expiraEnSegundos: number;
  /** Condición `eq` exacta del POST policy — nunca `starts-with` (panel `arquitecto-software` +
   * `security-engineer`, 2026-08-18): con `starts-with` alguien podría declarar `image/jpeg` y que
   * el objeto se guarde con cualquier otro tipo real. */
  contentType: string;
  /** Condición `content-length-range` del POST policy: `[0, tamanoMaximoBytes]`. La hace cumplir
   * S3/MinIO en el propio POST, no un `Content-Length` que el cliente puede mentir. */
  tamanoMaximoBytes: number;
};

/**
 * Lo que un cliente necesita para completar un POST multipart directo contra el storage:
 * `campos.key`, `campos["Content-Type"]` y el resto de lo que exige el POST policy viajan como
 * campos de un `FormData`, en el orden que S3/MinIO espera — no se arman a mano del lado de la app.
 */
export type SubidaFirmada = {
  readonly url: string;
  readonly campos: Readonly<Record<string, string>>;
};

export interface ObjectStorage {
  put(clave: string, cuerpo: Buffer, opciones: OpcionesPut): Promise<void>;
  get(clave: string): Promise<Buffer>;
  getStream(clave: string): Promise<Readable>;
  urlFirmada(clave: string, opciones: OpcionesUrlFirmada): Promise<string>;
  /**
   * Firma un POST directo del navegador al storage (`createPresignedPost`), con la clave y el
   * content-type fijados por el servidor —nunca por el cliente— y el tamaño acotado por S3/MinIO.
   *
   * **Dos decisiones aceptadas, tomadas por el panel y no resueltas en este incremento:**
   *
   *  1. **Objetos huérfanos, sin purga automática.** Una URL firmada y nunca usada, o usada pero
   *     cuyo `pago` nunca se registró, deja un objeto en `pagos/comprobantes/` sin fila que lo
   *     referencie. No hay job de limpieza: el volumen esperado es bajo (un archivo de unos pocos
   *     MB por intento abandonado) y el criterio del repo es "no purgar nunca por defecto"
   *     (ADR-0001 §6, ver el docstring de arriba). Si el volumen real lo justifica, se agrega un
   *     barrido explícito más adelante, con su propia credencial de `s3:DeleteObject` — hoy nadie
   *     la tiene.
   *  2. **Sin validación de magic bytes.** El content-type que llega al bucket es el que declaró el
   *     cliente en el POST (verificado `eq` contra la extensión de la clave, no contra los bytes
   *     reales del archivo): un PDF renombrado a `.jpg` pasa la condición igual. Se acepta porque
   *     quien sube es un actor de confianza (operador/admin autenticado, no un público anónimo) y
   *     porque la descarga fuerza `Content-Disposition: attachment` con el nombre que fija el
   *     servidor y una extensión de una lista cerrada (`SUFIJO_PATRON_CLAVE_COMPROBANTE`) — no hay
   *     researcher que dependa de un content-type mentido para ejecutar nada.
   */
  urlFirmadaDeSubida(clave: string, opciones: OpcionesUrlFirmadaDeSubida): Promise<SubidaFirmada>;
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
