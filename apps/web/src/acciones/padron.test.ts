/**
 * El CUIT informativo del titular (encargo 17b, 7i), contra las acciones de verdad del padrón. Lo único
 * doblado es la frontera —la sesión, la caché de Next y los servicios—; el `parse` con los esquemas de
 * `shared` y el armado de la entrada son los de producción.
 *
 * Lo que se fija:
 *  - «Editar» arma `cuitsInformativos` desde los campos `cuitInformativo.N.*` del formulario, y si el
 *    formulario no los trae el servicio recibe el campo ausente (no toca ningún CUIT);
 *  - un CUIT mal escrito no llega al servicio y **el error cae en su campo**, en los tres formularios;
 *  - el alta y el cambio de titular le pasan el CUIT al servicio, y si el documento ya es un CUIT el
 *    informativo se ignora (mismo número) o se rechaza en su campo (otro número).
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResultadoDeAccion } from "./resultado.ts";

vi.mock("../servidor/db.ts", () => ({ conSesion: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { agregarUnidad, cambiarTitular, editarUnidad } = vi.hoisted(() => ({
  agregarUnidad: vi.fn(),
  cambiarTitular: vi.fn(),
  editarUnidad: vi.fn(),
}));
vi.mock("@admin-barrios/data/servicios/padron-edicion", () => ({
  agregarUnidad,
  cambiarTitular,
  editarUnidad,
  cambiarVencimientosDelBarrio: vi.fn(),
  crearBarrio: vi.fn(),
  crearVersionCoeficientes: vi.fn(),
  darDeBaja: vi.fn(),
}));

const { agregarUnidadAction, cambiarTitularAction, editarUnidadAction } = await import("./padron.ts");

const formulario = (valores: Readonly<Record<string, string>>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(valores)) f.append(k, v);
  return f;
};
const INICIAL = { estado: "inicial" } as ResultadoDeAccion<never>;
const erroresDe = (r: ResultadoDeAccion<unknown>, campo: string) => (r.estado === "campos" ? (r.campos[campo] ?? []) : []);

// Dos CUIT con el verificador bien, y uno con el verificador mal.
const CUIT = "20-11111111-2";
const OTRO_CUIT = "20-27989690-5";
const CUIT_MALO = "20-11111111-3";

const unidadFuncionalId = randomUUID();
const ana = randomUUID();
const raul = randomUUID();
const edicion = { unidadFuncionalId, estado: "construido" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  agregarUnidad.mockResolvedValue({ unidadFuncionalId, codigoPago: "0001" });
  cambiarTitular.mockResolvedValue({ cerrados: 1 });
  editarUnidad.mockResolvedValue(undefined);
});

describe("editarUnidadAction · CUIT informativo de los titulares vigentes", () => {
  it("arma `cuitsInformativos` en el orden de los campos; vacío viaja como «borrar»", async () => {
    const r = await editarUnidadAction(
      INICIAL,
      formulario({
        ...edicion,
        "cuitInformativo.0.obligadoId": ana,
        "cuitInformativo.0.cuit": CUIT,
        "cuitInformativo.1.obligadoId": raul,
        "cuitInformativo.1.cuit": "",
      }),
    );
    expect(r.estado).toBe("ok");
    expect(editarUnidad.mock.calls[0]?.[1].cuitsInformativos).toEqual([
      { obligadoId: ana, cuit: "20111111112" },
      { obligadoId: raul, cuit: null },
    ]);
  });

  it("si el formulario no trae ningún titular, el campo va ausente: no se toca ningún CUIT", async () => {
    const r = await editarUnidadAction(INICIAL, formulario(edicion));
    expect(r.estado).toBe("ok");
    expect(editarUnidad.mock.calls[0]?.[1].cuitsInformativos).toBeUndefined();
  });

  it("un CUIT mal escrito no llega al servicio y el error cae en el campo de ESE titular", async () => {
    const r = await editarUnidadAction(
      INICIAL,
      formulario({
        ...edicion,
        "cuitInformativo.0.obligadoId": ana,
        "cuitInformativo.0.cuit": CUIT,
        "cuitInformativo.1.obligadoId": raul,
        "cuitInformativo.1.cuit": CUIT_MALO,
      }),
    );
    expect(r.estado).toBe("campos");
    expect(erroresDe(r, "cuitInformativo.1.cuit")).toHaveLength(1);
    expect(erroresDe(r, "cuitInformativo.0.cuit")).toHaveLength(0);
    expect(editarUnidad).not.toHaveBeenCalled();
  });
});

describe("agregarUnidadAction · CUIT informativo del titular", () => {
  const alta = { barrioId: randomUUID(), manzana: "A", lote: "9", estado: "construido", "titular.0.nombre": "Ana Ejemplo" };

  it("con DNI, el CUIT llega al servicio como dato del titular", async () => {
    const r = await agregarUnidadAction(INICIAL, formulario({ ...alta, "titular.0.documento": "27989690", "titular.0.cuitInformativo": OTRO_CUIT }));
    expect(r.estado).toBe("ok");
    expect(agregarUnidad.mock.calls[0]?.[1].titulares[0].cuitInformativo).toBe("20279896905");
  });

  it("si el documento ya es ese CUIT, el informativo se ignora", async () => {
    const r = await agregarUnidadAction(INICIAL, formulario({ ...alta, "titular.0.documento": CUIT, "titular.0.cuitInformativo": CUIT }));
    expect(r.estado).toBe("ok");
    expect(agregarUnidad.mock.calls[0]?.[1].titulares[0].cuitInformativo).toBeNull();
  });

  it.each([
    ["mal escrito", "27989690", CUIT_MALO],
    ["distinto del CUIT que ya es su documento", CUIT, OTRO_CUIT],
  ])("un CUIT %s se rechaza en su campo, sin llegar al servicio", async (_caso, documento, cuit) => {
    const r = await agregarUnidadAction(INICIAL, formulario({ ...alta, "titular.0.documento": documento, "titular.0.cuitInformativo": cuit }));
    expect(r.estado).toBe("campos");
    expect(erroresDe(r, "titular.0.cuitInformativo")).toHaveLength(1);
    expect(agregarUnidad).not.toHaveBeenCalled();
  });
});

describe("cambiarTitularAction · CUIT informativo del titular nuevo", () => {
  const cambio = { unidadFuncionalId, desde: "2026-10-01", motivo: "venta", "titular.nombre": "Ana Ejemplo", "titular.documento": "27989690" };

  it("el CUIT llega al servicio como dato del titular", async () => {
    const r = await cambiarTitularAction(INICIAL, formulario({ ...cambio, "titular.cuitInformativo": OTRO_CUIT }));
    expect(r.estado).toBe("ok");
    expect(cambiarTitular.mock.calls[0]?.[1].titular.cuitInformativo).toBe("20279896905");
  });

  it("un CUIT mal escrito se rechaza en su campo, sin llegar al servicio", async () => {
    const r = await cambiarTitularAction(INICIAL, formulario({ ...cambio, "titular.cuitInformativo": CUIT_MALO }));
    expect(r.estado).toBe("campos");
    expect(erroresDe(r, "titular.cuitInformativo")).toHaveLength(1);
    expect(cambiarTitular).not.toHaveBeenCalled();
  });
});
