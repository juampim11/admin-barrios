/**
 * Lo que el correo saliente **no** puede hacer.
 *
 * Los dos controles que este archivo fija son de la clase que no se detecta mirando el resultado:
 * un correo con una cabecera inyectada se manda igual y parece normal, y un cuerpo con el importe
 * adentro también. Por eso se prueban acá y no en una revisión.
 *
 * El transporte real no se ejerce: `sendMail` contra un servidor de verdad es otra clase de test y
 * otra dependencia. Lo que se prueba es **la frontera** — lo que el adapter acepta y lo que rechaza
 * antes de llegar al transporte, y qué dice el cuerpo que se arma.
 */
import { describe, expect, it, vi } from "vitest";
import { direccionDeRebote, nuevoMensajeId } from "./index.ts";
import { armarCuerpoDeLiquidacion, VERSION_PLANTILLA_LIQUIDACION } from "./plantillas/liquidacion.ts";

const DATOS = {
  barrioNombre: "Los Álamos",
  periodoEtiqueta: "07/2026",
  denominacion: "expensa",
  unidadEtiqueta: "MZ 3 — LOTE 7",
  nombreDestinatario: "Ana Pérez",
  responderA: "administracion@losalamos.test",
} as const;

describe("el cuerpo del correo", () => {
  it("dice de qué barrio, qué período y qué unidad es", () => {
    const c = armarCuerpoDeLiquidacion(DATOS);
    expect(c.asunto).toContain("Los Álamos");
    expect(c.asunto).toContain("07/2026");
    expect(c.asunto).toContain("MZ 3 — LOTE 7");
    expect(c.version).toBe(VERSION_PLANTILLA_LIQUIDACION);
  });

  /**
   * **El control que más importa de este archivo.** El cuerpo viaja en claro, queda indexado en el
   * buzón y aparece en la vista previa de una pantalla bloqueada. El importe está en el adjunto, que
   * es el documento; en el cuerpo sería la deuda de una familia legible desde el teléfono apagado.
   */
  it("no lleva importes, ni saldos, ni menciones de deuda", () => {
    const c = armarCuerpoDeLiquidacion(DATOS);
    const todo = `${c.asunto}\n${c.texto}`.toLowerCase();

    expect(todo).not.toMatch(/\$|importe|total a pagar|saldo/);
    expect(todo).not.toMatch(/deuda|adeuda|mora|moroso|deudor/);
  });

  /** Un link con token sería un secreto de portador por el mismo canal, que sobrevive al reenvío. */
  it("no lleva ningún enlace", () => {
    const c = armarCuerpoDeLiquidacion(DATOS);
    expect(c.texto).not.toMatch(/https?:\/\//);
  });

  /** Cada envío es de una unidad: el cuerpo no puede nombrar ninguna otra. */
  it("nombra una sola unidad", () => {
    const c = armarCuerpoDeLiquidacion(DATOS);
    const menciones = c.texto.match(/MZ \d+/g) ?? [];
    expect(new Set(menciones).size).toBeLessThanOrEqual(1);
  });

  /**
   * La denominación sale del barrio y no está horneada: en una SA no son "expensas" sino aportes, y
   * un correo que diga lo contrario contradice al documento que adjunta.
   */
  it("usa la denominación del barrio, no 'expensa' fijo", () => {
    const c = armarCuerpoDeLiquidacion({ ...DATOS, denominacion: "cuota social" });
    expect(c.texto).toContain("cuota social");
    expect(c.texto.toLowerCase()).not.toContain("expensa");
  });

  /**
   * El mismo filtro que el papel. Si una palabra prohibida se cuela, **no se manda**: un correo es
   * más difícil de retirar que un PDF, porque ya está en la bandeja de quien lo recibió.
   */
  it("no se arma si el texto no pasa el filtro de lenguaje", () => {
    // El filtro persigue lenguaje de **ejecutividad e intimación** —lo que convierte un aviso en una
    // amenaza—, no una palabra suelta como "moroso". Un texto con "bajo apercibimiento" frena el
    // envío antes de que salga.
    expect(() =>
      armarCuerpoDeLiquidacion({ ...DATOS, denominacion: "cuota bajo apercibimiento" }),
    ).toThrow(/filtro de lenguaje/);
  });

  it("sin nombre del destinatario saluda igual, sin dejar un hueco", () => {
    const c = armarCuerpoDeLiquidacion({ ...DATOS, nombreDestinatario: null });
    expect(c.texto.startsWith("Hola:")).toBe(true);
    expect(c.texto).not.toContain("null");
  });
});

describe("el adapter rechaza las cabeceras inyectadas", () => {
  /**
   * El nombre del barrio y el del contacto son texto que escribe un humano y terminan en el
   * `Subject` y en el display-name del `To`. Con un CR/LF se pueden inventar cabeceras enteras.
   *
   * **Rechaza y no limpia**: limpiar convierte un dato corrupto en un envío silencioso con el nombre
   * alterado. Rechazar frena el envío y deja el problema a la vista.
   */
  it.each([
    ["asunto", { asunto: "Expensas\r\nBcc: espia@ajeno.test" }],
    ["nombre del destinatario", { para: { direccion: "ana@ejemplo.test", nombre: "Ana\nBcc: x@y.test" } }],
    ["nombre del remitente", { de: { direccion: "admin@ejemplo.test", nombre: "Barrio\rX-Fake: 1" } }],
  ])("un salto de línea en el %s frena el envío", async (_campo, parche) => {
    const { crearNotificadorSmtp } = await import("./adapters/smtp.ts");
    const notificador = crearNotificadorSmtp({
      host: "localhost",
      puerto: 465,
      usuario: "u",
      password: "p",
      seguro: true,
    });

    const base = {
      para: { direccion: "ana@ejemplo.test", nombre: "Ana" },
      de: { direccion: "admin@ejemplo.test", nombre: "Barrio" },
      responderA: null,
      asunto: "Expensas 07/2026",
      cuerpoTexto: "Hola",
      cuerpoHtml: null,
      adjuntos: [],
      mensajeId: nuevoMensajeId("ejemplo.test"),
      returnPath: null,
    };

    await expect(notificador.enviar({ ...base, ...parche })).rejects.toThrow(/salto de línea/);
  });
});

describe("el Message-ID y el VERP", () => {
  /**
   * Lo genera el emisor y no el transporte: si lo pusiera el servidor, cambiaría al cambiar de
   * proveedor y el registro dejaría de ser estable — que es justamente lo que va a permitir aparear
   * un rebote con su envío el día que exista la fuente.
   */
  it("el Message-ID tiene la forma del RFC y lleva el dominio adentro", () => {
    const id = nuevoMensajeId("barrio.test");
    expect(id).toMatch(/^<[0-9a-f-]{36}@barrio\.test>$/);
  });

  it("dos mensajes nunca comparten id", () => {
    expect(nuevoMensajeId("barrio.test")).not.toBe(nuevoMensajeId("barrio.test"));
  });

  /**
   * VERP reduce el problema de "parsear un email arbitrario" a "leer un uuid de una dirección". Se
   * configura hoy y todavía no se lee: es la diferencia entre rediseñar y escribir un consumidor.
   */
  it("la dirección de rebote lleva el id del envío", () => {
    const envio = "0f8b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d";
    expect(direccionDeRebote("rebotes.barrio.test", envio)).toBe(`rebotes+${envio}@rebotes.barrio.test`);
  });
});

describe("la superficie del transporte", () => {
  /*
   * **Acá había un test que no probaba nada, y se sacó en vez de dejarlo pasando.** Intentaba
   * verificar que la firma no acepta varios destinatarios leyendo `modulo.toString()`, que sobre un
   * namespace de módulo no devuelve la fuente: pasaba sin comprobar nada.
   *
   * Lo que garantiza que no haya `cc`, `bcc` ni un array de destinatarios es **el tipo**
   * (`MensajeDeCorreo.para` es un objeto, no un array), y eso lo verifica el typecheck en cada
   * corrida. Un test verde que no comprueba lo que dice comprobar es peor que no tenerlo — más
   * todavía sobre este punto, que es el que impide agrupar destinatarios "para ahorrar envíos".
   */

  it("no expone ninguna forma de leer un buzón", async () => {
    const modulo = await import("./index.ts");
    const exportados = Object.keys(modulo);
    expect(exportados.some((n) => /recibir|leer|imap|bandeja/i.test(n))).toBe(false);
  });
});
