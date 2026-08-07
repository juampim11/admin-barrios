/**
 * `ObjectStorage` contra MinIO **de verdad**.
 *
 * Por qué no alcanza con un doble de prueba, y por eso este proyecto de tests existe aparte: lo que
 * se está verificando no es nuestra lógica sino **el acuerdo con el proveedor** — que el `put`
 * condicional se traduzca a un `412`, que la URL firmada la acepte quien la tiene que aceptar, que
 * los encabezados de respuesta viajen en el presign. Una URL firmada que MinIO rechaza es una falla
 * silenciosa de la misma familia que las tres de ADR-0001 §7.1: el código se ve impecable y el vecino
 * no puede descargar nada.
 *
 * Requiere `pnpm db:up` (que levanta MinIO y crea el bucket y las dos cuentas de servicio).
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claveDeDocumento,
  nuevoToken,
  ObjetoNoEncontrado,
  ObjetoYaExiste,
  TTL_MAXIMO_SEGUNDOS,
  type ObjectStorage,
} from "../src/index.ts";
import { crearAlmacenamientoS3 } from "../src/adapters/s3.ts";

const endpoint = process.env["S3_ENDPOINT"] ?? `http://localhost:${process.env["MINIO_API_PORT"] ?? "9000"}`;
const bucket = process.env["S3_BUCKET"] ?? process.env["MINIO_BUCKET"] ?? "admin-barrios";

const almacenamiento: ObjectStorage = crearAlmacenamientoS3({
  endpoint,
  region: process.env["S3_REGION"] ?? "us-east-1",
  bucket,
  forzarRutaDeBucket: true,
  // La cuenta del worker: es la única que escribe.
  accessKeyId: process.env["S3_WORKER_ACCESS_KEY_ID"] ?? "app_worker_dev",
  secretAccessKey: process.env["S3_WORKER_SECRET_ACCESS_KEY"] ?? "app_worker_dev_secret",
});

const barrioId = randomUUID();
const periodoId = randomUUID();
const clave = claveDeDocumento({ barrioId, periodoId, tipo: "boleta_unidad", token: nuevoToken() });
const contenido = Buffer.from("%PDF-1.4 contenido de prueba");

beforeAll(async () => {
  await almacenamiento.put(clave, contenido, {
    contentType: "application/pdf",
    descargarComo: "Expensas-2026-01-Mza-1-Lote-2.pdf",
  });
});

afterAll(() => {
  // No se borra: la interfaz **no tiene `remove()`** a propósito (la retención por defecto es no
  // purgar nunca y las tablas de documentos son append-only). Los objetos de prueba son de unos
  // bytes y viven en el MinIO local.
});

describe("el ida y vuelta con el almacenamiento real", () => {
  it("lo que se guardó es exactamente lo que vuelve", async () => {
    expect(await almacenamiento.get(clave)).toEqual(contenido);
  });

  it("una clave que no existe se distingue de un error del proveedor", async () => {
    const otra = claveDeDocumento({ barrioId, periodoId, tipo: "boleta_unidad", token: nuevoToken() });
    await expect(almacenamiento.get(otra)).rejects.toBeInstanceOf(ObjetoNoEncontrado);
  });

  it("el `put` condicional NO pisa un documento ya emitido", async () => {
    // Es el control del que depende que el `sha256` guardado siga acreditando el archivo que hay.
    // Sin él, una segunda corrida cambia el PDF y deja intacto el hash: un documento emitido cuya
    // integridad declarada es mentira.
    await expect(
      almacenamiento.put(clave, Buffer.from("otro contenido"), { contentType: "application/pdf" }),
    ).rejects.toBeInstanceOf(ObjetoYaExiste);
    expect(await almacenamiento.get(clave)).toEqual(contenido);
  });
});

describe("la URL firmada", () => {
  it("descarga el archivo, y con los encabezados que la hacen segura", async () => {
    const url = await almacenamiento.urlFirmada(clave, {
      expiraEnSegundos: 90,
      descargarComo: "Expensas-2026-01-Mza-1-Lote-2.pdf",
    });

    const respuesta = await fetch(url);
    expect(respuesta.status).toBe(200);
    expect(Buffer.from(await respuesta.arrayBuffer())).toEqual(contenido);

    // `no-store` va en el PRESIGN, no en el 302 de la aplicación: el de la aplicación no viaja al
    // objeto, y sin esto un CDN o un proxy intermedio puede cachear el PDF.
    expect(respuesta.headers.get("cache-control")).toBe("no-store");
    // `attachment` es lo que evita que el desplegador de vistas previas de una aplicación de
    // mensajería muestre el importe y el destinatario en la burbuja del chat.
    expect(respuesta.headers.get("content-disposition")).toContain("attachment");
    expect(respuesta.headers.get("content-type")).toBe("application/pdf");
  });

  it("el nombre de archivo se sanea: nunca llega crudo al querystring", async () => {
    const url = await almacenamiento.urlFirmada(clave, {
      expiraEnSegundos: 60,
      descargarComo: 'raro"; drop\ntable\\.pdf',
    });
    const respuesta = await fetch(url);
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get("content-disposition")).not.toContain('"; drop');
  });

  it("no se puede pedir una URL más larga que el techo del ADR", async () => {
    await expect(
      almacenamiento.urlFirmada(clave, {
        expiraEnSegundos: TTL_MAXIMO_SEGUNDOS + 1,
        descargarComo: "x.pdf",
      }),
    ).rejects.toThrow(/vencimiento/);
  });
});

describe("firmar para el navegador y no para uno mismo", () => {
  // El caso real: la aplicación corre en un contenedor y alcanza el almacenamiento como
  // `http://minio:9000`, pero la URL firmada la sigue el navegador del host, donde ese nombre no
  // existe. El botón de descargar apunta a la nada, y **no se puede arreglar reescribiendo el host
  // después**: la firma incluye el encabezado `host`.
  const comoEnContenedor = crearAlmacenamientoS3({
    endpoint: "http://minio:9000",
    endpointPublico: endpoint,
    region: process.env["S3_REGION"] ?? "us-east-1",
    bucket,
    forzarRutaDeBucket: true,
    accessKeyId: process.env["S3_WORKER_ACCESS_KEY_ID"] ?? "app_worker_dev",
    secretAccessKey: process.env["S3_WORKER_SECRET_ACCESS_KEY"] ?? "app_worker_dev_secret",
  });

  it("la URL firmada usa la dirección pública, no la interna", async () => {
    const url = await comoEnContenedor.urlFirmada(clave, {
      expiraEnSegundos: 60,
      descargarComo: "x.pdf",
    });
    expect(url).toContain(endpoint);
    expect(url).not.toContain("minio:9000");
  });

  it("y esa URL la acepta el almacenamiento de verdad", async () => {
    // Lo que hace que este test valga: no alcanza con que la cadena se vea bien. Si la firma se
    // calculara con el host interno y solo se reemplazara el texto, esto devolvería 403.
    const url = await comoEnContenedor.urlFirmada(clave, {
      expiraEnSegundos: 60,
      descargarComo: "x.pdf",
    });
    const respuesta = await fetch(url);
    expect(respuesta.status).toBe(200);
    expect(Buffer.from(await respuesta.arrayBuffer())).toEqual(contenido);
  });
});

describe("el bucket es privado", () => {
  it("un GET anónimo contra una clave conocida devuelve 403", async () => {
    // Diez líneas, y es lo único que atrapa a alguien que corrió `mc anonymous set download` para
    // "probar una cosa". Sin esto, todo el trabajo de RLS de la ruta de descarga no protege nada.
    const respuesta = await fetch(`${endpoint}/${bucket}/${clave}`);
    expect(respuesta.status).toBe(403);
  });
});
