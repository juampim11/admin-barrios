/**
 * Las acciones del presupuesto del mes (encargo 16c), contra las acciones de verdad. Lo único doblado
 * es la frontera —la sesión, la caché de Next y los servicios—; el `parse`, `ejecutar` y la traducción
 * del rechazo son los de producción.
 *
 * Lo que se fija:
 *  - los rubros llegan al servicio como lista, desde los campos `rubro:<conceptoId>`, y uno vacío no
 *    se presupuesta;
 *  - un importe mal escrito vuelve **en el campo de su rubro**, sin llamar al servicio;
 *  - el rechazo del servicio (mes emitido) se muestra como falla.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { campoDelRubro } from "./presupuesto-formulario.ts";
import type { ResultadoDeAccion } from "./resultado.ts";

vi.mock("../servidor/db.ts", () => ({ conSesion: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { guardarPresupuesto, copiarPresupuestoDelMesAnterior } = vi.hoisted(() => ({
  guardarPresupuesto: vi.fn(),
  copiarPresupuestoDelMesAnterior: vi.fn(),
}));
vi.mock("@admin-barrios/data/servicios/presupuesto", () => ({ guardarPresupuesto, copiarPresupuestoDelMesAnterior }));

const { guardarPresupuestoAction, copiarPresupuestoAction } = await import("./presupuesto.ts");

const formulario = (valores: Readonly<Record<string, string>>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(valores)) f.append(k, v);
  return f;
};
const INICIAL = { estado: "inicial" } as ResultadoDeAccion<never>;
const periodoId = randomUUID();
const vigilancia = randomUUID();
const seguros = randomUUID();
const jardin = randomUUID();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("guardar el presupuesto", () => {
  it("arma la lista de rubros desde los campos; un rubro vacío no va y un margen vacío es cero", async () => {
    guardarPresupuesto.mockResolvedValue(undefined);
    const r = await guardarPresupuestoAction(
      INICIAL,
      formulario({
        periodoId,
        [campoDelRubro(vigilancia)]: "5400000.00",
        [campoDelRubro(seguros)]: "",
        [campoDelRubro(jardin)]: "0.00",
        margen: "",
        _agregar: "",
      }),
    );
    expect(r.estado).toBe("ok");
    expect(guardarPresupuesto).toHaveBeenCalledWith(
      {},
      {
        periodoId,
        rubros: [
          { conceptoId: vigilancia, monto: "5400000.00" },
          { conceptoId: jardin, monto: "0.00" },
        ],
        margen: "0.00",
      },
    );
  });

  it("un importe negativo vuelve en el campo de su rubro, sin llamar al servicio", async () => {
    const r = await guardarPresupuestoAction(
      INICIAL,
      formulario({ periodoId, [campoDelRubro(vigilancia)]: "-1.00", margen: "10.00" }),
    );
    expect(r.estado).toBe("campos");
    if (r.estado !== "campos") return;
    expect(r.campos[campoDelRubro(vigilancia)]).toEqual(["El importe no puede ser negativo."]);
    expect(guardarPresupuesto).not.toHaveBeenCalled();
  });

  it("el rechazo del servicio se muestra como falla, con lo tipeado intacto", async () => {
    guardarPresupuesto.mockRejectedValue(
      new ErrorDeNegocio({
        codigo: "periodo_no_editable",
        mensaje: "El mes ya se emitió: el presupuesto queda como se cargó.",
        sugerencia: "El presupuesto se carga mientras el mes se prepara.",
        correlacion: "test",
      }),
    );
    const valores = { periodoId, [campoDelRubro(vigilancia)]: "100.00", margen: "0.00" };
    const r = await guardarPresupuestoAction(INICIAL, formulario(valores));
    expect(r.estado).toBe("falla");
    if (r.estado !== "falla") return;
    expect(r.error.codigo).toBe("periodo_no_editable");
    expect(r.valores).toEqual(valores);
  });
});

describe("copiar del mes anterior", () => {
  it("manda solo el período", async () => {
    copiarPresupuestoDelMesAnterior.mockResolvedValue({ rubros: 5 });
    const r = await copiarPresupuestoAction(INICIAL, formulario({ periodoId }));
    expect(r).toEqual({ estado: "ok", valor: { rubros: 5 } });
    expect(copiarPresupuestoDelMesAnterior).toHaveBeenCalledWith({}, { periodoId });
  });

  it("un período que no es un id no llega al servicio", async () => {
    const r = await copiarPresupuestoAction(INICIAL, formulario({ periodoId: "x" }));
    expect(r.estado).toBe("campos");
    expect(copiarPresupuestoDelMesAnterior).not.toHaveBeenCalled();
  });
});
