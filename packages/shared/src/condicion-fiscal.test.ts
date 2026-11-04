import { describe, expect, it } from "vitest";
import { CONDICIONES_FISCALES, opcionesDeCondicionFiscal, registrarProveedorSchema } from "./escrituras.ts";

describe("condición fiscal del proveedor (encargo 10, BL-030 g)", () => {
  it("la lista es la pedida, en ese orden", () => {
    expect(CONDICIONES_FISCALES).toEqual([
      "Responsable Inscripto",
      "Monotributo",
      "Exento",
      "IVA no alcanzado",
      "Consumidor final",
    ]);
  });

  it("sin valor previo, o con uno de la lista, el desplegable ofrece solo la lista", () => {
    expect(opcionesDeCondicionFiscal(null).map((o) => o.valor)).toEqual([...CONDICIONES_FISCALES]);
    expect(opcionesDeCondicionFiscal("Monotributo").map((o) => o.valor)).toEqual([...CONDICIONES_FISCALES]);
  });

  it("un valor viejo que no está en la lista se ofrece tal cual, para que editar no lo cambie", () => {
    const opciones = opcionesDeCondicionFiscal("Resp. Inscripto");
    expect(opciones).toHaveLength(CONDICIONES_FISCALES.length + 1);
    expect(opciones.at(-1)).toEqual({ valor: "Resp. Inscripto", texto: "Resp. Inscripto (como estaba cargado)" });
  });

  it("el esquema sigue aceptando el valor viejo (no se pierde al guardar una edición)", () => {
    const base = { barrioId: "11111111-1111-4111-8111-111111111111", razonSocial: "Proveedor de prueba" };
    expect(registrarProveedorSchema.safeParse({ ...base, condicionFiscal: "Resp. Inscripto" }).success).toBe(true);
    expect(registrarProveedorSchema.safeParse({ ...base, condicionFiscal: "Exento" }).success).toBe(true);
  });
});
