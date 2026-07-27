/**
 * Capa 2 de ADR-0001 §8: **estructura, no apariencia.** Nada de píxeles: que estén los campos
 * obligatorios, que ningún renglón desaparezca por valer cero, que no haya lenguaje prohibido, que
 * no salga ninguna URL externa, y que las cadenas de dinero sean **idénticas** a las del modelo de
 * vista.
 */

import { describe, expect, it } from "vitest";
import { revisarLenguaje } from "../lenguaje-prohibido.ts";
import { cuerpoBoleta, escapar, estilosBoleta } from "./boleta.ts";
import { vistaBoletaDeMuestra } from "../fixtures/boleta-muestra.ts";

const vista = vistaBoletaDeMuestra();
const html = cuerpoBoleta(vista);

describe("el dinero llega intacto a la hoja", () => {
  it("cada cadena de dinero del modelo de vista aparece tal cual en el HTML", () => {
    const cadenas = [
      vista.totales.aPagar.texto,
      vista.totales.delPeriodo.texto,
      vista.totales.saldoAnterior.texto,
      vista.totales.interes?.texto ?? "",
      vista.detalle.gastoDelBarrio.texto,
      ...vista.detalle.lineas.map((l) => l.importe.texto),
      ...vista.composicion.map((r) => r.importe.texto),
    ].filter(Boolean);
    for (const cadena of cadenas) expect(html).toContain(cadena);
  });

  it("el total aparece en la zona 1, en el cupón y en el talón, y es la misma cadena", () => {
    const apariciones = html.split(vista.totales.aPagar.texto).length - 1;
    expect(apariciones).toBeGreaterThanOrEqual(3);
  });

  it("la plantilla no formatea: no hay ningún número con separadores en formato en-US", () => {
    expect(html).not.toMatch(/\d{1,3}(,\d{3})+\.\d{2}/);
  });
});

describe("nunca se omite, aunque valga cero (doc 07 §B)", () => {
  it("saldo anterior, interés y los dos totales están siempre", () => {
    expect(html).toContain("Saldo de períodos anteriores");
    expect(html).toContain("Total del período");
    expect(html).toContain("TOTAL A PAGAR");
    expect(html).toMatch(/Interés/);
  });

  it("con saldo anterior en cero el renglón sigue impreso", () => {
    expect(vista.totales.saldoAnterior.monto).toBe("0.00");
    expect(html).toMatch(/Saldo de períodos anteriores[\s\S]{0,200}0,00/);
  });

  it("con el interés pendiente de definición dice 'pendiente', no 0,00", () => {
    const pendiente = cuerpoBoleta(vistaBoletaDeMuestra({ totales: { ...vista.totales, interes: null }, interes: null }));
    expect(pendiente).toContain("pendiente de definición");
    expect(pendiente).toMatch(/<td class="imp">pendiente<\/td>/);
  });

  it("los tres slots de banda ocupan lugar aunque estén vacíos: el troquel no se mueve", () => {
    // La banda con contenido lleva además su modificador de color (doc 09 §E.4.1).
    expect(html.match(/class="banda(?: vacia| banda--[a-z_]+)?"/g)).toHaveLength(3);
    expect(html).toContain("banda vacia");
  });
});

describe("lo que la hoja tiene que decir", () => {
  it("trae el gasto entero del barrio y el coeficiente al lado", () => {
    expect(html).toContain("El barrio gastó");
    expect(html).toContain(vista.detalle.coeficiente.participacionTexto);
  });

  it("«Dónde pagás» dice LUGARES, no los campos del cupón", () => {
    // Se armaba juntando las etiquetas de los instrumentos de texto, así que la celda terminaba
    // diciendo "Pago electrónico · CBU · Alias · Convenio". El convenio es el número del acuerdo con
    // la red: un campo del cupón del pie, no un lugar donde se pueda ir a pagar.
    const celda = html.slice(html.indexOf("Dónde pagás"), html.indexOf("</section>"));
    expect(celda).toContain(vista.bloquePago.canalesDePago[0]);
    expect(celda).not.toContain("Convenio");
    // Y el cupón los sigue imprimiendo todos: no se borró información, se movió a donde se lee.
    expect(html).toContain("Convenio");
  });

  it("la columna Tipo lleva la clasificación del art. 2048, en palabra completa", () => {
    expect(html).toContain("Ordinaria");
    expect(html).toContain("Extraordinaria");
    expect(html).toContain("Fondo de reserva");
  });

  it("NO imprime la clasificación fiscal: su audiencia es el contador (doc 07 §C.1)", () => {
    for (const termino of ["alcanzado", "no_alcanzado", "IIBB", "ingreso_ajeno", "sin_clasificar"]) {
      expect(html.toLowerCase()).not.toContain(termino.toLowerCase());
    }
  });

  it("cita el respaldo de la extraordinaria en positivo y anclado a su línea", () => {
    expect(html).toContain("Respaldo: Acta de Asamblea");
  });

  it("el cargo dice el hecho que lo originó, no solo el concepto", () => {
    expect(html).toContain("1 turno");
  });
});

describe("lo que la hoja NO puede decir ni hacer", () => {
  it("ninguna frase de la lista prohibida del doc 07 §E", () => {
    // Se revisa el texto visible, no el markup: los nombres de clase CSS no son lenguaje impreso.
    const texto = html.replace(/<[^>]*>/g, " ");
    expect(revisarLenguaje(texto)).toEqual([]);
  });

  it("ninguna URL externa: la red está apagada en el renderizador (guarda anti-SSRF de §3.2)", () => {
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i);
    expect(estilosBoleta()).not.toMatch(/https?:|@import/i);
  });

  it("escapa todo campo de origen humano", () => {
    const conInyeccion = vistaBoletaDeMuestra({
      unidad: { etiqueta: "Mza 99 · Lote 07", destinatario: '<script>alert(1)</script>"' },
    });
    const salida = cuerpoBoleta(conInyeccion);
    expect(salida).not.toContain("<script>");
    expect(salida).toContain("&lt;script&gt;");
  });

  it("no estampa la marca de agua: eso lo hace el renderizador, no la plantilla", () => {
    expect(html).not.toContain("MUESTRA — SIN VALOR DE PAGO");
  });

  it("no tiene un `if` por banco: recorre los instrumentos y pinta", () => {
    for (const inst of vista.bloquePago.instrumentos) expect(html).toContain(escapar(inst.etiqueta));
  });
});

describe("el instrumento", () => {
  it("el código de barras sale embebido como SVG con fondo blanco y ancho en mm", () => {
    expect(html).toContain('fill="#FFFFFF"');
    expect(html).toMatch(/<svg [^>]*width="[\d.]+mm"/);
  });

  it("las dos fechas del cupón salen del bloque de pago, no de otro lado", () => {
    expect(html).toContain(vista.bloquePago.fechas.vencimiento.texto);
  });
});
