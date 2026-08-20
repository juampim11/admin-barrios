/**
 * `validarArchivoDeComprobante()` y `armarFormDataDeSubida()` — las dos funciones puras del hook de
 * subida. El resto del hook (estado de React, efectos) no tiene test automatizado acá: el repo no
 * tiene infraestructura de render de componentes/hooks (todos los proyectos de vitest corren en
 * `environment: "node"`, sin `@testing-library`), mismo criterio que `documentos/generacion.tsx`,
 * que tampoco la tiene.
 */
import { describe, expect, it } from "vitest";
import { armarFormDataDeSubida, validarArchivoDeComprobante } from "./useSubidaDeComprobante.ts";

function archivoDe(bytes: number, type: string, nombre = "comprobante"): File {
  return new File([new ArrayBuffer(bytes)], nombre, { type });
}

describe("validarArchivoDeComprobante()", () => {
  it("un PDF chico pasa", () => {
    expect(validarArchivoDeComprobante(archivoDe(1024, "application/pdf"))).toBeNull();
  });

  it("una imagen jpeg o png también pasan", () => {
    expect(validarArchivoDeComprobante(archivoDe(1024, "image/jpeg"))).toBeNull();
    expect(validarArchivoDeComprobante(archivoDe(1024, "image/png"))).toBeNull();
  });

  it("un tipo fuera del catálogo cerrado se rechaza, y el mensaje nombra el tipo", () => {
    const mensaje = validarArchivoDeComprobante(archivoDe(1024, "application/msword"));
    expect(mensaje).toMatch(/application\/msword/);
  });

  it("un archivo sin tipo (type vacío) se rechaza con un mensaje legible, no en blanco", () => {
    const mensaje = validarArchivoDeComprobante(archivoDe(1024, ""));
    expect(mensaje).toMatch(/tipo desconocido/);
  });

  it("un archivo de exactamente el límite pasa", () => {
    expect(validarArchivoDeComprobante(archivoDe(10 * 1024 * 1024, "application/pdf"))).toBeNull();
  });

  it("un archivo un byte más grande que el límite se rechaza", () => {
    const mensaje = validarArchivoDeComprobante(archivoDe(10 * 1024 * 1024 + 1, "application/pdf"));
    expect(mensaje).toMatch(/10 MB/);
  });
});

describe("armarFormDataDeSubida()", () => {
  it("los campos del presign viajan, y el archivo viaja bajo la clave `file`", () => {
    const archivo = archivoDe(10, "application/pdf", "comprobante.pdf");
    const formData = armarFormDataDeSubida({ key: "barrios/x/pagos/comprobantes/abc.pdf", "Content-Type": "application/pdf" }, archivo);

    expect(formData.get("key")).toBe("barrios/x/pagos/comprobantes/abc.pdf");
    expect(formData.get("Content-Type")).toBe("application/pdf");
    expect(formData.get("file")).toBe(archivo);
  });

  it("el archivo va DESPUÉS de los campos del presign, no antes", () => {
    // El orden de las entradas de un FormData es el orden de inserción — S3/MinIO arma el POST
    // policy contra ese orden (mismo control que `formularioDe()` en `s3.test.ts`, del lado del
    // servidor), así que este test no es cosmético: un `file` insertado primero rompe la subida.
    const archivo = archivoDe(10, "image/png", "comprobante.png");
    const formData = armarFormDataDeSubida({ key: "clave", policy: "pol", signature: "sig" }, archivo);

    const claves = [...formData.keys()];
    expect(claves.indexOf("file")).toBe(claves.length - 1);
    expect(claves.slice(0, -1)).toEqual(["key", "policy", "signature"]);
  });
});
