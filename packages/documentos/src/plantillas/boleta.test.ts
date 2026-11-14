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
import { cifra } from "@admin-barrios/shared/documentos";
import { sumarMontos } from "@admin-barrios/shared/dinero";

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

  it("la zona 1 muestra las DOS fechas con su importe, no un canal de pago", () => {
    /*
     * Reemplaza al caso «Dónde pagás dice LUGARES»: esa celda se cayó cuando la zona 1 pasó a la
     * tabla de vencimientos del mock. Dónde se paga vive ahora en el pie, que es una sección titulada
     * con los datos completos — resumir un canal en dos palabras arriba no aportaba nada que el pie
     * no dijera mejor. Lo que la zona 1 sí tiene que contestar es cuánto se paga en cada fecha.
     */
    expect(html).toContain("<table class=\"vencimientos\">");
    expect(html).toContain("Vencimiento");
    expect(html).toContain(vista.bloquePago.fechas.vencimiento.texto);
    expect(html).toContain(vista.bloquePago.importes.alVencimiento.texto);
    expect(html).not.toContain("Dónde pagás");
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

describe("la fecha de corte (encargo 15, 0078)", () => {
  it("se imprime «Se puede pagar hasta el dd/mm» solo si el período la tiene", () => {
    expect(html).not.toContain("Se puede pagar hasta");
    const conCorte = cuerpoBoleta(
      vistaBoletaDeMuestra({ periodo: { ...vista.periodo, fechaCorte: { iso: "2026-08-25", texto: "25/08/2026" } } }),
    );
    expect(conCorte).toMatch(/Se puede pagar hasta el <b class="cifra">25\/08<\/b>/);
    expect(revisarLenguaje(conCorte.replace(/<[^>]*>/g, " "))).toEqual([]);
  });
});

describe("el cupón que cobra solo el mes (encargo 16, 0080)", () => {
  const delMes = vista.totales.delPeriodo;
  const conCupon = vistaBoletaDeMuestra({
    totales: { delPeriodo: delMes, saldoAnterior: cifra("600.00"), interes: cifra("18.00"), aPagar: cifra(sumarMontos(delMes.monto, "618.00")) },
    interes: {
      base: cifra("600.00"),
      tasaMensualTexto: null,
      dias: 30,
      computadoHasta: { iso: "2026-07-10", texto: "10/07/2026" },
      arrastre: { pendiente: cifra("0.00"), alCorte: cifra("18.00") },
    },
    cupon: { modo: "solo_mes", importe: delMes, deudaNoIncluida: cifra("618.00") },
    deudaAnterior: [
      {
        periodo: "2026-06",
        etiqueta: "Junio 2026",
        vencimiento: { iso: "2026-06-10", texto: "10/06/2026" },
        capital: cifra("600.00"),
        interes: cifra("18.00"),
        total: cifra("618.00"),
      },
    ],
    periodo: { ...vista.periodo, fechaCorte: { iso: "2026-08-25", texto: "25/08/2026" } },
  } as never);
  const htmlCupon = cuerpoBoleta(conCupon);
  const inicioZona2 = htmlCupon.indexOf('<section class="zona2">');
  const zona2 = htmlCupon.slice(inicioZona2, htmlCupon.indexOf("</section>", inicioZona2));

  it("«TOTAL A PAGAR» es el del mes, arriba y en el detalle", () => {
    expect(zona2).toContain(`<td><span class="nombre">TOTAL A PAGAR</span></td><td class="imp cifra">${delMes.texto}</td>`);
    // El titular de la zona 1 lleva el importe del cupón, no el total con deuda.
    expect(htmlCupon).toContain(`pt">${delMes.texto}</span>`);
    expect(htmlCupon).not.toContain(conCupon.totales.aPagar.texto);
  });

  it("debajo va la deuda de meses anteriores, mes por mes, con su total aparte y dicho que no está incluida", () => {
    const total = zona2.indexOf("TOTAL A PAGAR");
    const deuda = zona2.indexOf("Deuda de meses anteriores (no incluida en este cupón)");
    expect(deuda).toBeGreaterThan(total);
    expect(zona2).toContain("Junio 2026");
    expect(zona2).toContain("Venció el 10/06/2026 · capital $ 600,00 + interés $ 18,00");
    expect(zona2).toContain('Total de la deuda de meses anteriores</span></td><td class="imp cifra">618,00<');
    // Con el desglose, el saldo y el interés ya no van como renglones que suman.
    expect(zona2).not.toContain("Saldo de períodos anteriores");
    expect(revisarLenguaje(htmlCupon.replace(/<[^>]*>/g, " "))).toEqual([]);
  });

  it("el corte se imprime con año", () => {
    expect(htmlCupon).toContain('Se puede pagar hasta el <b class="cifra">25/08/2026</b>');
  });

  it("al día, el renglón de la deuda se imprime en cero: nada se esconde", () => {
    const alDia = cuerpoBoleta(
      vistaBoletaDeMuestra({ cupon: { modo: "solo_mes", importe: delMes, deudaNoIncluida: cifra("0.00") }, deudaAnterior: [] } as never),
    );
    expect(alDia).toContain("No registra deuda de meses anteriores");
  });

  it("sin desglose y con deuda fuera del cupón, se informa debajo del total y no como sumando", () => {
    const sinDesglose = cuerpoBoleta(vistaBoletaDeMuestra({ ...conCupon, deudaAnterior: null } as never));
    const z = sinDesglose.slice(sinDesglose.indexOf('<section class="zona2">'));
    expect(z).not.toContain("Saldo de períodos anteriores");
    expect(z.indexOf("Deuda de meses anteriores (no incluida en este cupón)")).toBeGreaterThan(z.indexOf("TOTAL A PAGAR"));
    expect(z).toContain('<td class="imp cifra">618,00</td>');
  });

  it("sin modo de cupón, la hoja es la de siempre: saldo, interés y total a pagar", () => {
    expect(html).toContain("Saldo de períodos anteriores");
    expect(html).not.toContain("Deuda de meses anteriores");
  });
});
