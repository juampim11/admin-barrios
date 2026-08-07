/**
 * El adapter de suplantación: qué deja pasar y qué no.
 *
 * El caso que más importa es el último: **con el elenco vacío no se emite identidad**. Esa es la
 * vuelta 3 del candado (ADR-0002 §2.4), la única que aguanta sola, y acá se ejercita con el elenco
 * simulado. Contra Postgres real —incluidos los grants y la policy— lo verifica
 * `packages/data/test/usuario-demo.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { crearAuthDevSuplantacion, COOKIE_SESION_DEV } from "./dev-suplantacion.ts";
import type { EntradaHttp } from "../auth-provider.ts";

const ANA = {
  usuarioId: "00000000-0000-4000-8000-000000000001",
  email: "ana@ejemplo.test",
  nombre: "Ana Demo",
};

const elenco = new Map([[ANA.usuarioId, ANA]]);
const conElenco = crearAuthDevSuplantacion({ buscarUsuarioDemo: async (id) => elenco.get(id) ?? null });
const sinElenco = crearAuthDevSuplantacion({ buscarUsuarioDemo: async () => null });

function entrada(opciones: { host?: string; cookie?: string } = {}): EntradaHttp {
  return {
    headers: new Map(opciones.host === undefined ? [] : [["host", opciones.host]]),
    cookies: new Map(opciones.cookie === undefined ? [] : [[COOKIE_SESION_DEV, opciones.cookie]]),
  };
}

describe("dev-suplantacion", () => {
  it("se declara NO apto para producción: es un campo del contrato, no un comentario", () => {
    expect(conElenco.aptoParaProduccion).toBe(false);
    expect(conElenco.clave).toBe("dev-suplantacion");
  });

  describe("iniciarSesion", () => {
    it("entra con alguien del elenco y devuelve la cookie a escribir", async () => {
      const r = await conElenco.iniciarSesion({
        tipo: "suplantacion",
        usuarioId: ANA.usuarioId,
        entrada: entrada({ host: "localhost:4000" }),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.identidad.usuarioId).toBe(ANA.usuarioId);
      expect(r.cookie.valor).toBe(ANA.usuarioId);
      expect(r.cookie.httpOnly).toBe(true);
      expect(r.cookie.sameSite).toBe("lax");
    });

    it("NO confía en el uuid que manda el navegador: tiene que estar en el elenco", async () => {
      const r = await conElenco.iniciarSesion({
        tipo: "suplantacion",
        usuarioId: "11111111-1111-4111-8111-111111111111",
        entrada: entrada({ host: "localhost:4000" }),
      });
      expect(r.ok).toBe(false);
    });

    it("hace el MISMO chequeo de Host que sesionDe (la cookie se puede poner a mano)", async () => {
      const r = await conElenco.iniciarSesion({
        tipo: "suplantacion",
        usuarioId: ANA.usuarioId,
        entrada: entrada({ host: "admin-barrios.example" }),
      });
      expect(r.ok).toBe(false);
    });

    it("el motivo del rechazo es siempre el mismo: el formulario no enumera el elenco", async () => {
      const ajeno = await conElenco.iniciarSesion({
        tipo: "suplantacion",
        usuarioId: "11111111-1111-4111-8111-111111111111",
        entrada: entrada({ host: "localhost" }),
      });
      const remoto = await conElenco.iniciarSesion({
        tipo: "suplantacion",
        usuarioId: ANA.usuarioId,
        entrada: entrada({ host: "evil.example" }),
      });
      expect(ajeno.ok).toBe(false);
      expect(remoto.ok).toBe(false);
      if (ajeno.ok || remoto.ok) return;
      expect(ajeno.motivo).toBe(remoto.motivo);
    });
  });

  describe("sesionDe", () => {
    it("devuelve la sesión con una cookie válida y Host local", async () => {
      const s = await conElenco.sesionDe(entrada({ host: "[::1]:4000", cookie: ANA.usuarioId }));
      expect(s?.identidad.usuarioId).toBe(ANA.usuarioId);
      expect(s?.origen).toBe("dev-suplantacion");
      expect(s?.expiraEn.getTime()).toBeGreaterThan(Date.now());
    });

    it("sin cookie, con cookie basura o con Host remoto: no hay sesión", async () => {
      expect(await conElenco.sesionDe(entrada({ host: "localhost" }))).toBeNull();
      expect(await conElenco.sesionDe(entrada({ host: "localhost", cookie: "no-soy-un-uuid" }))).toBeNull();
      expect(await conElenco.sesionDe(entrada({ host: "localhost", cookie: "' or 1=1 --" }))).toBeNull();
      expect(await conElenco.sesionDe(entrada({ host: "evil.example", cookie: ANA.usuarioId }))).toBeNull();
      expect(await conElenco.sesionDe(entrada({ cookie: ANA.usuarioId }))).toBeNull(); // sin Host
    });

    it("se revalida contra el elenco en CADA request: vaciar la tabla mata las sesiones abiertas", async () => {
      const s = await sinElenco.sesionDe(entrada({ host: "localhost", cookie: ANA.usuarioId }));
      expect(s).toBeNull();
    });
  });

  it("CON EL ELENCO VACÍO NO SE EMITE IDENTIDAD POR NINGÚN CAMINO (la vuelta 3 del candado)", async () => {
    const inicio = await sinElenco.iniciarSesion({
      tipo: "suplantacion",
      usuarioId: ANA.usuarioId,
      entrada: entrada({ host: "localhost:4000" }),
    });
    expect(inicio.ok).toBe(false);
    expect(await sinElenco.sesionDe(entrada({ host: "localhost:4000", cookie: ANA.usuarioId }))).toBeNull();
  });

  it("cerrarSesion describe la cookie a expirar, no toca ningún almacén", async () => {
    const cookie = await conElenco.cerrarSesion();
    expect(cookie.nombre).toBe(COOKIE_SESION_DEV);
    expect(cookie.maxEdad).toBe(0);
    expect(cookie.valor).toBe("");
  });
});
