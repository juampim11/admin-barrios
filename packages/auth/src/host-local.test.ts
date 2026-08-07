/**
 * Vuelta 2 del candado (ADR-0002 §2.4): el chequeo de `Host`.
 *
 * El caso que da nombre a este archivo es `[::1]:4000`: un `split(":")[0]` devuelve `"["` y deja a
 * la persona afuera de su propia máquina. Es el bug que hace que alguien saque el chequeo del medio
 * "porque no anda", y con eso se pierde la defensa entera.
 */

import { describe, expect, it } from "vitest";
import { esHostLocal } from "./host-local.ts";

describe("esHostLocal", () => {
  it("acepta las tres formas de decir 'esta máquina', con y sin puerto", () => {
    for (const host of [
      "localhost",
      "localhost:4000",
      "LOCALHOST:4000",
      "127.0.0.1",
      "127.0.0.1:4000",
      "[::1]",
      "[::1]:4000", // el que un split(":")[0] rompe
      "  localhost:4000  ",
    ]) {
      expect(esHostLocal(host), host).toBe(true);
    }
  });

  it("rechaza cualquier host remoto", () => {
    for (const host of [
      "admin-barrios.example",
      "10.0.0.5:4000",
      "192.168.1.20",
      "127.0.0.1.evil.example", // el prefijo no alcanza: se compara el host entero
      "localhost.evil.example",
      "[2001:db8::1]:4000",
      "evil.example:4000",
    ]) {
      expect(esHostLocal(host), host).toBe(false);
    }
  });

  it("rechaza lo malformado en vez de adivinar (adivinar es de donde salen los bypass)", () => {
    for (const host of [
      "::1", // IPv6 sin corchetes: no es un Host válido
      "[::1", // corchete sin cerrar
      "[]:4000",
      "localhost:no-es-un-puerto",
      "localhost:4000:5000",
      "",
      "   ",
      null,
      undefined,
    ]) {
      expect(esHostLocal(host), JSON.stringify(host)).toBe(false);
    }
  });
});
