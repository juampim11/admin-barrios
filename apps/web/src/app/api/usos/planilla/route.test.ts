/**
 * `/api/usos/planilla` (encargo 16b). Se doblan la sesión y los servicios; el lector de planillas y
 * `prepararPlanillaDeUsos` son los de verdad. Lo que se fija: que el permiso se mira **antes** de leer
 * el archivo, que el handler no escribe (solo pide la vista previa), que al servicio le llegan las
 * filas achicadas a las columnas de usos, y los rechazos del archivo.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { rechazar } from "@admin-barrios/data/errores";

const PERIODO = "00000000-0000-4000-8000-000000000002";
const ORIGEN = "http://localhost:4000";

let sesion: "ok" | "sin_sesion" = "ok";
vi.mock("../../../../servidor/db.ts", () => ({
  conSesionHttp: async (fn: (tx: unknown) => Promise<unknown>) => {
    if (sesion === "sin_sesion") return { ok: false };
    return { ok: true, valor: await fn({}) };
  },
}));

const conceptosDelMes = vi.fn();
const vistaPrevia = vi.fn();
const aplicar = vi.fn();
vi.mock("@admin-barrios/data/servicios/conceptos-del-mes", () => ({
  conceptosDelMes: (...args: unknown[]) => conceptosDelMes(...args),
  vistaPreviaDePlanillaDeUsos: (...args: unknown[]) => vistaPrevia(...args),
  aplicarPlanillaDeUsos: (...args: unknown[]) => aplicar(...args),
}));

const { GET, POST } = await import("./route.ts");

const CSV = "Propietario;manzana;lote;concepto;fecha;cantidad\nAna Ejemplo;1;4;Cancha;08/11/2026;1\n";

/** Un cuerpo que avisa si alguien lo leyó. */
function subir(consulta: string, texto: string, cabeceras: Record<string, string> = { origin: ORIGEN }) {
  let leido = false;
  // Sin cola (`highWaterMark: 0`): `pull` corre recién cuando alguien lee, no al crear el cuerpo.
  const cuerpo = new ReadableStream<Uint8Array>(
    {
      pull(control) {
        leido = true;
        control.enqueue(new TextEncoder().encode(texto));
        control.close();
      },
    },
    { highWaterMark: 0 },
  );
  const pedido = new Request(`${ORIGEN}/api/usos/planilla?${consulta}`, {
    method: "POST",
    body: cuerpo,
    headers: cabeceras,
    // Node exige declararlo cuando el cuerpo es un stream.
    duplex: "half",
  } as RequestInit);
  return { respuesta: POST(pedido), fueLeido: () => leido };
}

describe("POST /api/usos/planilla", () => {
  beforeEach(() => {
    sesion = "ok";
    conceptosDelMes.mockReset();
    conceptosDelMes.mockResolvedValue({ puedeCargar: true });
    vistaPrevia.mockReset();
    vistaPrevia.mockResolvedValue({ archivo: "usos.csv", filasLeidas: 1, renglones: [], errores: [], total: "0.00" });
    aplicar.mockReset();
  });

  it("devuelve la vista previa y las filas achicadas a las columnas de usos, sin escribir nada", async () => {
    const { respuesta } = subir(`periodo=${PERIODO}&nombre=usos.csv`, CSV);
    const r = await respuesta;
    const filas = [
      ["manzana", "lote", "concepto", "fecha", "cantidad"],
      ["1", "4", "Cancha", "08/11/2026", "1"],
    ];

    expect(r.status).toBe(200);
    expect(vistaPrevia).toHaveBeenCalledWith(expect.anything(), { periodoId: PERIODO, archivo: "usos.csv", filas });
    expect(await r.json()).toEqual({ estado: "ok", valor: { vista: expect.objectContaining({ archivo: "usos.csv" }), filas } });
    expect(aplicar).not.toHaveBeenCalled();
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("a quien no puede cargar le contesta 403 sin leer el archivo", async () => {
    conceptosDelMes.mockResolvedValue({ puedeCargar: false });
    const { respuesta, fueLeido } = subir(`periodo=${PERIODO}&nombre=usos.csv`, CSV);
    expect((await respuesta).status).toBe(403);
    expect(fueLeido()).toBe(false);
    expect(vistaPrevia).not.toHaveBeenCalled();
  });

  it("sin sesión contesta 401 sin leer el archivo", async () => {
    sesion = "sin_sesion";
    const { respuesta, fueLeido } = subir(`periodo=${PERIODO}&nombre=usos.csv`, CSV);
    expect((await respuesta).status).toBe(401);
    expect(fueLeido()).toBe(false);
  });

  it("desde otro origen contesta 403 sin abrir la sesión", async () => {
    const { respuesta } = subir(`periodo=${PERIODO}&nombre=usos.csv`, CSV, { origin: "http://otro.example" });
    expect((await respuesta).status).toBe(403);
    expect(conceptosDelMes).not.toHaveBeenCalled();
  });

  it("con un período que no es un id contesta 400", async () => {
    const { respuesta } = subir("periodo=1&nombre=usos.csv", CSV);
    expect((await respuesta).status).toBe(400);
    expect(conceptosDelMes).not.toHaveBeenCalled();
  });

  it("un archivo que no es .xlsx ni .csv se rechaza en el campo, sin pedir la vista previa", async () => {
    const { respuesta } = subir(`periodo=${PERIODO}&nombre=usos.xls`, CSV);
    const cuerpo = (await (await respuesta).json()) as { estado: string; campos: { archivo: string[] } };
    expect(cuerpo.estado).toBe("campos");
    expect(cuerpo.campos.archivo[0]).toContain(".xlsx");
    expect(vistaPrevia).not.toHaveBeenCalled();
  });

  it("del nombre del archivo queda solo la base, sin la ruta", async () => {
    const { respuesta } = subir(`periodo=${PERIODO}&nombre=${encodeURIComponent("C:\\reservas\\usos.csv")}`, CSV);
    await respuesta;
    expect(vistaPrevia).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ archivo: "usos.csv" }));
  });

  it("si el servicio rechaza, vuelve el rechazo y no la planilla", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vistaPrevia.mockImplementation(async () => rechazar("periodo_no_editable", "El mes ya está emitido: no se le cargan usos.", "Van en el mes siguiente."));
    const { respuesta } = subir(`periodo=${PERIODO}&nombre=usos.csv`, CSV);
    const cuerpo = (await (await respuesta).json()) as { estado: string; error: { codigo: string } };
    expect(cuerpo.estado).toBe("falla");
    expect(cuerpo.error.codigo).toBe("periodo_no_editable");
  });
});

describe("GET /api/usos/planilla?tipo=plantilla", () => {
  beforeEach(() => {
    sesion = "ok";
  });

  it("baja la planilla modelo como .xlsx", async () => {
    const r = await GET(new Request(`${ORIGEN}/api/usos/planilla?tipo=plantilla`));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("spreadsheetml");
    expect(r.headers.get("content-disposition")).toContain("planilla-de-usos-modelo.xlsx");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sin sesión contesta 401, y con otro tipo 400", async () => {
    expect((await GET(new Request(`${ORIGEN}/api/usos/planilla?tipo=otra`))).status).toBe(400);
    sesion = "sin_sesion";
    expect((await GET(new Request(`${ORIGEN}/api/usos/planilla?tipo=plantilla`))).status).toBe(401);
  });
});
