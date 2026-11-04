import { describe, expect, it } from "vitest";
import { etiquetaDelMesDelServicio } from "./fechas.ts";

describe("«Mes del servicio» junto al gasto (encargo 11, BL-030 k)", () => {
  it.each([
    ["2026-10", "Servicio de octubre/2026"],
    ["2026-01", "Servicio de enero/2026"],
    ["2027-12", "Servicio de diciembre/2027"],
  ])("%j → %j", (mes, texto) => {
    expect(etiquetaDelMesDelServicio(mes)).toBe(texto);
  });

  it("un mes que no es YYYY-MM no se inventa: falla", () => {
    expect(() => etiquetaDelMesDelServicio("2026-13")).toThrow();
    expect(() => etiquetaDelMesDelServicio("octubre")).toThrow();
  });
});
