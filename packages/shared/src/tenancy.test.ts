import { describe, expect, it } from "vitest";
import {
  esDescendienteOIgual,
  pathPadre,
  pathTenantSchema,
  profundidad,
  ROLES_ESCRITURA_BARRIO,
} from "./tenancy.ts";

describe("subárbol de tenancía", () => {
  it("un nodo pertenece a su propio subárbol", () => {
    expect(esDescendienteOIgual("1.7", "1.7")).toBe(true);
  });

  it("un subsector pertenece al subárbol de su barrio y del administrador", () => {
    expect(esDescendienteOIgual("1.7.30", "1.7")).toBe(true);
    expect(esDescendienteOIgual("1.7.30", "1")).toBe(true);
  });

  it("NO confunde 1.7 con 1.70 (el bug clásico del prefijo)", () => {
    expect(esDescendienteOIgual("1.70", "1.7")).toBe(false);
    expect(esDescendienteOIgual("1.70.5", "1.7")).toBe(false);
  });

  it("barrios hermanos jamás se ven", () => {
    expect(esDescendienteOIgual("1.9", "1.7")).toBe(false);
    expect(esDescendienteOIgual("1.7", "1.9")).toBe(false);
  });

  it("administradores distintos no se ven", () => {
    expect(esDescendienteOIgual("2.3", "1")).toBe(false);
  });

  it("padre y profundidad", () => {
    expect(pathPadre("1.7.30")).toBe("1.7");
    expect(pathPadre("1")).toBeNull();
    expect(profundidad("1.7.30")).toBe(3);
  });

  it("valida el formato del path", () => {
    expect(pathTenantSchema.safeParse("1.7.30").success).toBe(true);
    expect(pathTenantSchema.safeParse("1.07").success).toBe(false);
    expect(pathTenantSchema.safeParse("1..7").success).toBe(false);
    expect(pathTenantSchema.safeParse("a.b").success).toBe(false);
  });
});

describe("roles", () => {
  it("propietario y residente no escriben datos operativos del barrio", () => {
    expect(ROLES_ESCRITURA_BARRIO).not.toContain("propietario");
    expect(ROLES_ESCRITURA_BARRIO).not.toContain("residente");
    expect(ROLES_ESCRITURA_BARRIO).not.toContain("auditor");
  });
});
