/**
 * BL-019: sin la credencial de subida (`S3_SUBIDA_COMPROBANTE_*`), pedir la URL de subida de un
 * adjunto —comprobante de pago, de orden de pago o respaldo de una tasa— tiene que rechazar con un
 * código propio que la acción devuelve como `falla`, y no lanzar un `Error` común que la pantalla
 * muestra como «Probá de nuevo». Reintentar no arregla una variable de entorno que falta.
 */

import { describe, expect, it } from "vitest";
import { esErrorDeNegocio } from "@admin-barrios/shared/errores";
import { urlDeSubidaDeComprobante } from "./almacenamiento.ts";
import { leerConfiguracion } from "./configuracion.ts";

const S3_SIN_SUBIDA = {
  APP_ENTORNO: "local",
  DATABASE_URL_APP: "postgres://app_request:x@localhost:5432/admin_barrios",
  AUTH_PROVIDER: "dev-suplantacion",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "admin-barrios",
  S3_FORCE_PATH_STYLE: "true",
  S3_ACCESS_KEY_ID: "app_web_dev",
  S3_SECRET_ACCESS_KEY: "app_web_dev_secret",
};

describe("la subida sin credencial de subida (BL-019)", () => {
  it("rechaza con `subida_no_configurada`, un error de negocio, y no con un Error común", async () => {
    // Un entorno armado a mano y no el del proceso: el del corredor de tests trae credenciales que la
    // guarda de `configuracion.ts` (con razón) no deja leer a la web.
    const configuracion = leerConfiguracion(S3_SIN_SUBIDA);
    expect(configuracion.s3?.subida ?? null).toBeNull();

    const clave = "administraciones/11111111-2222-4333-8444-555555555555/parametros/respaldos/abcdefghijklmnopqrstuv.pdf";
    const error = await urlDeSubidaDeComprobante(clave, "application/pdf", configuracion).then(
      () => null,
      (e: unknown) => e,
    );
    expect(esErrorDeNegocio(error), String(error)).toBe(true);
    if (esErrorDeNegocio(error)) {
      expect(error.codigo).toBe("subida_no_configurada");
      expect(error.sugerencia).toMatch(/S3_SUBIDA_COMPROBANTE_/);
    }
  });
});
