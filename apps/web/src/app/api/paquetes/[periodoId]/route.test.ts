/**
 * `GET /api/paquetes/[periodoId]` — encargo 14. En la demo del 2026-11-12 esta ruta dio 500 cuatro
 * veces seguidas: el servicio devolvía la clave del ZIP y `urlFirmada()` la rechazaba por no conocer
 * `.zip`. Se dobla solo la sesión (el servicio que lee bajo RLS); el almacenamiento es el de verdad,
 * armado por `servidor/almacenamiento.ts` con una configuración de entorno de prueba. Firmar es
 * cálculo local, así que no hace falta MinIO.
 */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claveDePaquete, nuevoToken } from "@admin-barrios/almacenamiento";

const ENTORNO = {
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

vi.mock("../../../../servidor/configuracion.ts", async (original) => {
  const real = await original<typeof import("../../../../servidor/configuracion.ts")>();
  return { ...real, leerConfiguracion: () => real.leerConfiguracion(ENTORNO) };
});

let respuestaDelServicio: unknown;
vi.mock("../../../../servidor/db.ts", () => ({
  conSesionHttp: async () => {
    if (respuestaDelServicio instanceof Error) throw respuestaDelServicio;
    return respuestaDelServicio;
  },
}));

const { GET } = await import("./route.ts");

const pedir = (periodoId: string) =>
  GET(new Request(`http://localhost:4000/api/paquetes/${periodoId}`), { params: Promise.resolve({ periodoId }) });

describe("GET /api/paquetes/[periodoId]", () => {
  beforeEach(() => {
    respuestaDelServicio = undefined;
  });

  it("con un paquete armado, redirige con 302 a una URL firmada que anuncia `application/zip`", async () => {
    const barrioId = randomUUID();
    const periodoId = randomUUID();
    respuestaDelServicio = {
      ok: true,
      valor: {
        storageKey: claveDePaquete({ barrioId, periodoId, token: nuevoToken() }),
        nombreArchivo: "Boletas-2026-11.zip",
      },
    };

    const respuesta = await pedir(periodoId);

    expect(respuesta.status).toBe(302);
    const destino = new URL(respuesta.headers.get("location") ?? "");
    expect(destino.pathname).toContain(`/periodos/${periodoId}/paquetes/`);
    expect(destino.searchParams.get("response-content-type")).toBe("application/zip");
    expect(respuesta.headers.get("cache-control")).toBe("no-store");
    expect(respuesta.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("sin sesión contesta 401 y no firma nada", async () => {
    respuestaDelServicio = { ok: false };
    const respuesta = await pedir(randomUUID());
    expect(respuesta.status).toBe(401);
    expect(respuesta.headers.get("location")).toBeNull();
  });
});
