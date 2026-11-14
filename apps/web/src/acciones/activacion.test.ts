/**
 * Las acciones de la activación del barrio (encargo 17), contra las acciones de verdad. Lo único
 * doblado es la frontera —la sesión, la caché de Next y los servicios—; el `parse`, `ejecutar` y la
 * traducción del rechazo son los de producción.
 *
 * Lo que se fija:
 *  - **la tasa llega al servicio como la escribió la persona** («3,5»), no ya transformada a fracción:
 *    `activarBarrio` vuelve a parsear con el mismo esquema, y «0.035000» releído como porcentaje sería
 *    un 0,035 % mensual;
 *  - el rechazo de la base por falta de motivo se muestra **en el campo**;
 *  - las filas de la planilla viajan como texto en un campo oculto y llegan al servicio como celdas.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorDeNegocio } from "@admin-barrios/shared/errores";
import type { ResultadoDeAccion } from "./resultado.ts";

vi.mock("../servidor/db.ts", () => ({ conSesion: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { activarBarrio, cargarDeudaAnterior, declararSinDeudaAnterior } = vi.hoisted(() => ({
  activarBarrio: vi.fn(),
  cargarDeudaAnterior: vi.fn(),
  declararSinDeudaAnterior: vi.fn(),
}));
vi.mock("@admin-barrios/data/servicios/activacion", () => ({ activarBarrio, cargarDeudaAnterior, declararSinDeudaAnterior }));

const { activarBarrioAction, cargarDeudaAnteriorAction, declararSinDeudaAnteriorAction } = await import("./activacion.ts");

const formulario = (valores: Readonly<Record<string, string>>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(valores)) f.append(k, v);
  return f;
};
const INICIAL = { estado: "inicial" } as ResultadoDeAccion<never>;
const barrioId = randomUUID();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("activarBarrioAction", () => {
  it("manda al servicio la tasa como se escribió, no la fracción ya transformada", async () => {
    activarBarrio.mockResolvedValue({ activadoEl: "2026-11-14", primerPeriodo: "2026-12", tasa: "0.035000", tasaVigente: "0.030000" });
    const r = await activarBarrioAction(INICIAL, formulario({ barrioId, tasa: "3,5", motivo: "Así lo fijó la asamblea." }));
    expect(r.estado).toBe("ok");
    expect(activarBarrio).toHaveBeenCalledTimes(1);
    expect(activarBarrio.mock.calls[0]?.[1]).toEqual({ barrioId, tasa: "3,5", motivo: "Así lo fijó la asamblea." });
  });

  it("una tasa que no es un porcentaje no llega al servicio: el error va en su campo", async () => {
    const r = await activarBarrioAction(INICIAL, formulario({ barrioId, tasa: "tres" }));
    expect(r.estado).toBe("campos");
    expect(r.estado === "campos" ? r.campos["tasa"]?.[0] : "").toContain("porcentaje mensual");
    expect(activarBarrio).not.toHaveBeenCalled();
  });

  it("si la base pide el motivo, el rechazo se muestra en el campo «motivo»", async () => {
    activarBarrio.mockRejectedValue(
      new ErrorDeNegocio({
        codigo: "dato_invalido",
        mensaje: "La tasa no es la vigente del barrio: escribí el motivo.",
        sugerencia: "Contá por qué se usa otra tasa.",
        correlacion: "test",
        datos: { campo: "motivo" },
      }),
    );
    const r = await activarBarrioAction(INICIAL, formulario({ barrioId, tasa: "5" }));
    expect(r).toEqual({
      estado: "campos",
      campos: { motivo: ["La tasa no es la vigente del barrio: escribí el motivo."] },
      valores: { barrioId, tasa: "5" },
    });
  });

  it("otro rechazo de la base sale como falla, sin tocar", async () => {
    activarBarrio.mockRejectedValue(
      new ErrorDeNegocio({ codigo: "dato_invalido", mensaje: "El barrio ya está activado.", sugerencia: "Recargá el tablero.", correlacion: "test" }),
    );
    const r = await activarBarrioAction(INICIAL, formulario({ barrioId, tasa: "3" }));
    expect(r.estado).toBe("falla");
    expect(r.estado === "falla" ? r.error.mensaje : "").toBe("El barrio ya está activado.");
  });
});

describe("cargarDeudaAnteriorAction", () => {
  const filas = [
    ["manzana", "lote", "mes", "concepto", "vencimiento", "importe"],
    ["1", "7", "08/2026", "Expensa", "10/08/2026", "125000"],
  ];

  it("las filas viajan como texto en un campo oculto y llegan al servicio como celdas", async () => {
    cargarDeudaAnterior.mockResolvedValue({ deudas: 1, unidades: 1, total: "125000.00", saldosAFavor: 0, totalAFavor: "0.00", reemplaza: false });
    const r = await cargarDeudaAnteriorAction(INICIAL, formulario({ barrioId, archivo: "deuda.xlsx", filas: JSON.stringify(filas) }));
    expect(r.estado).toBe("ok");
    expect(cargarDeudaAnterior.mock.calls[0]?.[1]).toEqual({ barrioId, archivo: "deuda.xlsx", filas });
  });

  it("un campo de filas que no es una lista de celdas no llega al servicio", async () => {
    for (const malas of ["no es json", JSON.stringify({ a: 1 }), JSON.stringify([[1, 2]]), JSON.stringify([])]) {
      const r = await cargarDeudaAnteriorAction(INICIAL, formulario({ barrioId, archivo: "deuda.xlsx", filas: malas }));
      expect(r.estado).toBe("campos");
    }
    expect(cargarDeudaAnterior).not.toHaveBeenCalled();
  });
});

describe("declararSinDeudaAnteriorAction", () => {
  it("solo manda el barrio, y un id que no es un id no llega al servicio", async () => {
    declararSinDeudaAnterior.mockResolvedValue({ deudas: 0, unidades: 0, total: "0.00", saldosAFavor: 0, totalAFavor: "0.00", reemplaza: false });
    expect((await declararSinDeudaAnteriorAction(INICIAL, formulario({ barrioId, otra: "cosa" }))).estado).toBe("ok");
    expect(declararSinDeudaAnterior.mock.calls[0]?.[1]).toEqual({ barrioId });
    expect((await declararSinDeudaAnteriorAction(INICIAL, formulario({ barrioId: "no-es-un-id" }))).estado).toBe("campos");
    expect(declararSinDeudaAnterior).toHaveBeenCalledTimes(1);
  });
});
