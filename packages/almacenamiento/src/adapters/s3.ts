/**
 * El único adapter concreto de `ObjectStorage`: `@aws-sdk/client-s3` (ADR-0000 §3.3).
 *
 * Vive detrás de la subruta `@admin-barrios/almacenamiento/s3` —igual que `/chromium` en
 * `packages/documentos`— para que el SDK propietario no esté al alcance de un `import` desde el
 * dominio. La regla dura de `CLAUDE.md` §1 no es "no usar S3": es que ningún servicio de negocio lo
 * llame directo. Lo nombran `apps/web/src/servidor/*` y `apps/worker/src/*`, y nadie más; hay un
 * test de grafo que lo verifica.
 *
 * **Este módulo no lee `process.env`.** La configuración entra por parámetro, desde la única puerta
 * al entorno que cada aplicación tiene (ADR-0002 §5.2 regla 8).
 */

import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";
import {
  ObjetoNoEncontrado,
  ObjetoYaExiste,
  TTL_MAXIMO_SEGUNDOS,
  revisarClave,
  type ObjectStorage,
  type OpcionesPut,
  type OpcionesUrlFirmada,
} from "../index.ts";

export type ConfiguracionS3 = {
  /** Por dónde habla ESTE proceso con el almacenamiento. */
  endpoint: string;
  /**
   * Por dónde lo alcanza **el navegador de quien descarga**. Si no se declara, es el mismo.
   *
   * Existe por un caso que rompe la descarga entera y que no se ve leyendo el código: con la
   * aplicación en un contenedor, `endpoint` es `http://minio:9000` —un nombre que solo existe dentro
   * de la red de contenedores— y la URL firmada se le devuelve **al navegador del host**, donde ese
   * nombre no resuelve. El botón de descargar no llega a ningún lado.
   *
   * Y no se puede arreglar reescribiendo el host después de firmar: **la firma incluye el encabezado
   * `host`**, así que cambiar `minio:9000` por `localhost:9000` invalida la URL. Hay que firmar desde
   * el principio con el host que va a usar el navegador — que es exactamente lo que hace esto.
   *
   * En un entorno real las dos son la misma dirección y este campo no se declara.
   */
  endpointPublico?: string | undefined;
  region: string;
  bucket: string;
  /** MinIO necesita rutas (`/bucket/clave`); S3 real usa subdominio. */
  forzarRutaDeBucket: boolean;
  accessKeyId: string;
  secretAccessKey: string;
};

/**
 * El nombre de archivo que ve quien descarga.
 *
 * **Nunca el nombre del titular.** Viaja en el querystring de la URL firmada, que va al log de
 * acceso del proveedor de almacenamiento exactamente igual que la clave — y la regla de no poner
 * datos personales en la clave existe por ese log. Se sanea acá y no en el llamador, porque un
 * saneado que hay que acordarse de hacer no es un saneado.
 */
function saneado(nombre: string): string {
  const limpio = nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return limpio.length > 0 ? limpio : "documento.pdf";
}

export function crearAlmacenamientoS3(config: ConfiguracionS3): ObjectStorage {
  const credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  const comun = {
    region: config.region,
    forcePathStyle: config.forzarRutaDeBucket,
    credentials,
  };

  /** El que habla de verdad con el almacenamiento: leer, escribir. */
  const cliente = new S3Client({ ...comun, endpoint: config.endpoint });

  /**
   * El que **solo firma**. Nunca abre una conexión —presignar es puro cálculo local— así que puede
   * apuntar a una dirección que este proceso ni siquiera alcanza: la que va a usar el navegador.
   * Cuando las dos direcciones coinciden es el mismo cliente y no cuesta nada.
   */
  const clienteFirmante =
    config.endpointPublico && config.endpointPublico !== config.endpoint
      ? new S3Client({ ...comun, endpoint: config.endpointPublico })
      : cliente;

  async function cuerpoDe(clave: string): Promise<Readable> {
    revisarClave(clave);
    try {
      const salida = await cliente.send(new GetObjectCommand({ Bucket: config.bucket, Key: clave }));
      if (!salida.Body) throw new ObjetoNoEncontrado();
      return salida.Body as Readable;
    } catch (e) {
      if (e instanceof S3ServiceException && (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404)) {
        throw new ObjetoNoEncontrado();
      }
      throw e;
    }
  }

  return {
    async put(clave, cuerpo, opciones: OpcionesPut) {
      revisarClave(clave);
      const condicional = opciones.siNoExiste ?? true;
      try {
        await cliente.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: clave,
            Body: cuerpo,
            ContentType: opciones.contentType,
            // En el objeto además de en el presign: si algún día el bucket se configura mal, el
            // archivo sigue bajando como adjunto y con su tipo declarado.
            ...(opciones.descargarComo
              ? { ContentDisposition: `attachment; filename="${saneado(opciones.descargarComo)}"` }
              : {}),
            // `If-None-Match: *` — soportado por S3 y por MinIO. Es lo que impide que un reintento
            // cambie el contenido de un documento ya emitido dejando su `sha256` intacto.
            ...(condicional ? { IfNoneMatch: "*" } : {}),
          }),
        );
      } catch (e) {
        if (
          e instanceof S3ServiceException &&
          (e.name === "PreconditionFailed" || e.$metadata?.httpStatusCode === 412)
        ) {
          throw new ObjetoYaExiste();
        }
        throw e;
      }
    },

    async get(clave) {
      const flujo = await cuerpoDe(clave);
      const partes: Buffer[] = [];
      for await (const parte of flujo) partes.push(Buffer.from(parte as Buffer));
      return Buffer.concat(partes);
    },

    async getStream(clave) {
      return cuerpoDe(clave);
    },

    async urlFirmada(clave, opciones: OpcionesUrlFirmada) {
      revisarClave(clave);
      if (opciones.expiraEnSegundos <= 0 || opciones.expiraEnSegundos > TTL_MAXIMO_SEGUNDOS) {
        throw new Error(
          `el vencimiento de una URL firmada tiene que estar entre 1 y ${TTL_MAXIMO_SEGUNDOS} segundos`,
        );
      }
      return getSignedUrl(
        clienteFirmante,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: clave,
          // El `no-store` de la respuesta de la aplicación NO viaja al objeto: sin esto, un CDN o un
          // proxy intermedio puede cachear el PDF.
          ResponseCacheControl: "no-store",
          ResponseContentType: "application/pdf",
          ResponseContentDisposition: `attachment; filename="${saneado(opciones.descargarComo)}"`,
        }),
        { expiresIn: opciones.expiraEnSegundos },
      );
    },
  };
}
