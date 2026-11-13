/**
 * Encargo 14 (demo del 2026-11-12): «Descargar el paquete» daba 500 porque `zip` no estaba en
 * `CONTENT_TYPE_POR_EXTENSION`. Estos tests no necesitan MinIO: firmar una URL es cálculo local con
 * la clave, y es justo ahí —antes de cualquier red— donde fallaba.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  claveDePaquete,
  CONTENT_TYPE_POR_EXTENSION,
  extensionesDeLasClavesValidas,
  nuevoToken,
} from "./index.ts";
import { crearAlmacenamientoS3 } from "./adapters/s3.ts";

describe("la tabla de content-types cubre toda clave válida", () => {
  it("las extensiones se leen de los patrones: pdf, jpg, jpeg, png y zip", () => {
    expect(extensionesDeLasClavesValidas()).toEqual(["jpeg", "jpg", "pdf", "png", "zip"]);
  });

  it("cada extensión que admite una clave válida tiene su content-type", () => {
    const sinContentType = extensionesDeLasClavesValidas().filter((e) => !CONTENT_TYPE_POR_EXTENSION[e]);
    expect(sinContentType).toEqual([]);
  });
});

describe("firmar la URL de una clave de paquete", () => {
  // Credenciales de mentira: `getSignedUrl` no consulta a nadie, así que no hace falta un MinIO.
  const almacenamiento = crearAlmacenamientoS3({
    endpoint: "http://localhost:9000",
    region: "us-east-1",
    bucket: "admin-barrios",
    forzarRutaDeBucket: true,
    accessKeyId: "prueba",
    secretAccessKey: "prueba-secreto",
  });

  it("firma, y anuncia `application/zip` con el nombre de descarga", async () => {
    const clave = claveDePaquete({ barrioId: randomUUID(), periodoId: randomUUID(), token: nuevoToken() });
    const url = new URL(
      await almacenamiento.urlFirmada(clave, { expiraEnSegundos: 90, descargarComo: "Boletas-2026-11.zip" }),
    );
    expect(url.pathname).toContain("/paquetes/");
    expect(url.searchParams.get("response-content-type")).toBe("application/zip");
    expect(url.searchParams.get("response-content-disposition")).toContain("Boletas-2026-11.zip");
  });
});
