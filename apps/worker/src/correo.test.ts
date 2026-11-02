/**
 * El remitente sale de una variable de entorno escrita a mano, y de ahí va derecho a la cabecera
 * `From:`. Partirlo mal no rompe nada visible: manda el correo con un display-name raro, o peor, con
 * la dirección entera metida adentro del nombre.
 */
import { describe, expect, it } from "vitest";
import { armarCorreoDelWorker, partirRemitente } from "./correo.ts";
import type { Configuracion } from "./servidor/configuracion.ts";

describe("partirRemitente", () => {
  it("separa el nombre de la dirección", () => {
    expect(partirRemitente("Administración <liquidaciones@barrio.test>")).toEqual({
      nombre: "Administración",
      direccion: "liquidaciones@barrio.test",
    });
  });

  it("una casilla sola no inventa un nombre", () => {
    expect(partirRemitente("liquidaciones@barrio.test")).toEqual({
      nombre: null,
      direccion: "liquidaciones@barrio.test",
    });
  });

  it("tolera los espacios de más que trae una variable de entorno", () => {
    expect(partirRemitente("  Consorcio Norte  < admin@barrio.test >  ")).toEqual({
      nombre: "Consorcio Norte",
      direccion: "admin@barrio.test",
    });
  });

  it("un nombre vacío entre comillas angulares queda en null, no en cadena vacía", () => {
    expect(partirRemitente("<admin@barrio.test>").nombre).toBeNull();
  });
});

const BASE = {
  entorno: "local",
  urlBaseJob: "x",
  urlBaseApp: "x",
  s3Endpoint: "x",
  s3Region: "x",
  s3Bucket: "x",
  s3RutaDeBucket: false,
  s3AccessKeyId: "x",
  s3SecretAccessKey: "x",
  chunk: 50,
  timeoutMs: 1000,
  intervaloBarridoMs: 60_000,
} as unknown as Configuracion;

describe("armarCorreoDelWorker", () => {
  it("sin variables SMTP devuelve null, y el worker arranca igual", () => {
    expect(armarCorreoDelWorker(BASE)).toBeNull();
  });

  /**
   * **Una configuración a medias es peor que ninguna**: el worker arrancaría creyendo que puede
   * mandar y fallaría recién con el lote en la mano, dejando filas registradas para un envío que no
   * puede ocurrir. Ante la duda, no hay correo.
   */
  it("con la mitad de las variables también devuelve null", () => {
    const aMedias = { ...BASE, smtpHost: "smtp.test", smtpPuerto: 465, smtpUsuario: "u" };
    expect(armarCorreoDelWorker(aMedias as Configuracion)).toBeNull();
  });

  it("con las seis arma el notificador y parte el remitente", () => {
    const completo = {
      ...BASE,
      smtpHost: "smtp.test",
      smtpPuerto: 465,
      smtpUsuario: "u",
      smtpPassword: "p",
      smtpRemitente: "Consorcio <admin@barrio.test>",
      smtpDominioRebotes: "rebotes.barrio.test",
    } as Configuracion;

    const correo = armarCorreoDelWorker(completo);
    expect(correo).not.toBeNull();
    expect(correo!.remitente).toEqual({ nombre: "Consorcio", direccion: "admin@barrio.test" });
    expect(correo!.dominioRebotes).toBe("rebotes.barrio.test");
  });
});
