/**
 * `GET /api/padron/planilla?tipo=a_una_fecha` — «Padrón a una fecha» (encargo 15, `0078`). Se doblan
 * la sesión y los servicios del padrón; la planilla (`xlsxDeFilas`) es la de verdad. Lo que se fija:
 * que la fecha se valida **antes** de abrir la sesión, que el servicio recibe la fecha pedida, el
 * nombre del archivo, las cabeceras de `exportar`, y los mismos códigos de rol.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { rechazar } from "@admin-barrios/data/errores";

const BARRIO = "00000000-0000-4000-8000-000000000001";

let sesion: "ok" | "sin_sesion" = "ok";
let aperturas = 0;
vi.mock("../../../../servidor/db.ts", () => ({
  conSesionHttp: async (fn: (tx: unknown) => Promise<unknown>) => {
    aperturas += 1;
    if (sesion === "sin_sesion") return { ok: false };
    return { ok: true, valor: await fn({}) };
  },
}));

const padronAUnaFecha = vi.fn();
vi.mock("@admin-barrios/data/servicios/padron-edicion", () => ({
  confirmarImportacion: vi.fn(),
  exportarPadron: vi.fn(async () => [["unidad"]]),
  leerBarrioDelPadron: async () => ({ id: BARRIO, nombre: "Barrio de prueba", cuentaPorUnidad: false }),
  padronAUnaFecha: (...args: unknown[]) => padronAUnaFecha(...args),
  puedeEditarPadron: vi.fn(),
  vistaPreviaDeImportacion: vi.fn(),
}));

const { GET } = await import("./route.ts");

const pedir = (consulta: string) => GET(new Request(`http://localhost:4000/api/padron/planilla?${consulta}`));

describe("GET /api/padron/planilla?tipo=a_una_fecha", () => {
  beforeEach(() => {
    sesion = "ok";
    aperturas = 0;
    padronAUnaFecha.mockReset();
    padronAUnaFecha.mockResolvedValue([
      ["unidad", "numero_accion", "titular", "caracter", "documento", "porcentaje_titularidad", "desde"],
      ["Mza 1 · Lote 2", "A-7", "Ana Ejemplo", "Propietario", "27-12345678-9", "100", "01/03/2024"],
    ]);
  });

  it("baja la planilla con la fecha en el nombre y las cabeceras de exportar", async () => {
    const respuesta = await pedir(`barrio=${BARRIO}&tipo=a_una_fecha&fecha=2026-05-01`);

    expect(respuesta.status).toBe(200);
    expect(padronAUnaFecha).toHaveBeenCalledWith(expect.anything(), { barrioId: BARRIO, fecha: "2026-05-01" });
    expect(respuesta.headers.get("content-type")).toContain("spreadsheetml");
    expect(respuesta.headers.get("content-disposition")).toContain("padron-al-2026-05-01");
    expect(respuesta.headers.get("cache-control")).toBe("no-store");
    expect(respuesta.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([["fecha=2026-13-01"], ["fecha=01/05/2026"], ["fecha="], [""]])(
    "con una fecha inválida (%s) contesta 400 sin abrir la sesión",
    async (fecha) => {
      const respuesta = await pedir(`barrio=${BARRIO}&tipo=a_una_fecha&${fecha}`);
      expect(respuesta.status).toBe(400);
      expect(aperturas).toBe(0);
      expect(padronAUnaFecha).not.toHaveBeenCalled();
    },
  );

  it("sin sesión contesta 401", async () => {
    sesion = "sin_sesion";
    const respuesta = await pedir(`barrio=${BARRIO}&tipo=a_una_fecha&fecha=2026-05-01`);
    expect(respuesta.status).toBe(401);
  });

  it("si el servicio rechaza por rol, contesta 403 y no baja nada", async () => {
    padronAUnaFecha.mockImplementation(async () =>
      rechazar("sin_permiso", "No tenés permiso para exportar el padrón.", "Pedíselo a la administración."),
    );
    const respuesta = await pedir(`barrio=${BARRIO}&tipo=a_una_fecha&fecha=2026-05-01`);
    expect(respuesta.status).toBe(403);
    expect(respuesta.headers.get("content-disposition")).toBeNull();
  });
});
