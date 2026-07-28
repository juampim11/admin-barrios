/**
 * El candado del ADR-0002 §2.4, vuelta 1: **el proceso no atiende**.
 *
 * Lo que se protege es que el sustituto de desarrollo no pueda instanciarse en ningún entorno que no
 * sea `local`. El test recorre **todos** los valores que la variable puede tomar en la vida real,
 * incluidos los que un `!== "produccion"` habría dejado pasar: eso es lo que hace que sea un test de
 * la regla y no del caso feliz.
 */

import { describe, expect, it } from "vitest";
import { crearAuthProvider, permiteIngresoSinSesion } from "./registro.ts";

const deps = { buscarUsuarioDemo: async () => null };

/**
 * Los valores que rompen un chequeo escrito como lista de prohibidos. `"produccion"` es el obvio;
 * los otros son los que importan: son los que `NODE_ENV !== "production"` dejaba entrar.
 */
const NO_LOCALES = [
  "produccion",
  "staging",
  "Local", // mayúscula
  "local ", // espacio al final
  "prod",
  "development",
  "",
  undefined,
  null,
  0,
  false,
] as const;

describe("crearAuthProvider — el gate por APP_ENTORNO", () => {
  it("con APP_ENTORNO=local devuelve el sustituto, marcado como NO apto para producción", () => {
    const provider = crearAuthProvider({ entorno: "local", proveedor: "dev-suplantacion" }, deps);
    expect(provider.clave).toBe("dev-suplantacion");
    expect(provider.aptoParaProduccion).toBe(false);
    // Y solo por eso existe la puerta de ingreso sin sesión (§3.1).
    expect(permiteIngresoSinSesion(provider)).toBe(true);
  });

  for (const entorno of NO_LOCALES) {
    it(`lanza con APP_ENTORNO=${JSON.stringify(entorno)}`, () => {
      expect(() =>
        crearAuthProvider({ entorno, proveedor: "dev-suplantacion" } as never, deps),
      ).toThrow();
    });
  }

  it("lanza si falta APP_ENTORNO por completo (sin default, a propósito)", () => {
    expect(() => crearAuthProvider({ proveedor: "dev-suplantacion" }, deps)).toThrow(/APP_ENTORNO/);
  });

  it("lanza si falta AUTH_PROVIDER", () => {
    expect(() => crearAuthProvider({ entorno: "local" }, deps)).toThrow(/AUTH_PROVIDER/);
  });

  it("un adapter de producción todavía no existe: se dice, no se cae a un default silencioso", () => {
    for (const proveedor of ["supabase", "cognito", "gotrue"]) {
      expect(() => crearAuthProvider({ entorno: "produccion", proveedor }, deps)).toThrow(
        /no tiene adapter implementado/,
      );
    }
  });

  it("pedir el sustituto en staging o producción no degrada a otra cosa: lanza y nombra el motivo", () => {
    expect(() => crearAuthProvider({ entorno: "staging", proveedor: "dev-suplantacion" }, deps)).toThrow(
      /solo se habilita con APP_ENTORNO="local"/,
    );
  });
});
