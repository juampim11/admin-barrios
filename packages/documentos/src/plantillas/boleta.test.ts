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
import { cifra, parsearVistaBoleta } from "@admin-barrios/shared/documentos";
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

  // Boleta nueva (16c): sin talón, las tres apariciones son el bloque grande, el total del mes y el
  // total a pagar de los conceptos. La cadena es la misma, que es lo que el caso afirma.
  it("el total aparece en el bloque grande, en el total del mes y en el total a pagar, y es la misma cadena", () => {
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
    // Boleta nueva: «Total del período» y «TOTAL A PAGAR» pasan a «Total de julio» y «Total a pagar».
    expect(html).toContain("Total de julio");
    expect(html).toContain("Total a pagar");
    expect(html).toMatch(/Interés/);
  });

  it("con saldo anterior en cero el renglón sigue impreso", () => {
    expect(vista.totales.saldoAnterior.monto).toBe("0.00");
    expect(html).toMatch(/Saldo de períodos anteriores[\s\S]{0,200}0,00/);
  });

  it("con el interés pendiente de definición dice 'pendiente', no 0,00", () => {
    const pendiente = cuerpoBoleta(vistaBoletaDeMuestra({ totales: { ...vista.totales, interes: null }, interes: null }));
    expect(pendiente).toContain("pendiente de definición");
    expect(pendiente).toMatch(/<td class="num">pendiente<\/td>/);
  });

  /*
   * Acá vivía «los tres slots de banda ocupan lugar aunque estén vacíos: el troquel no se mueve».
   * La boleta nueva no tiene troquel que anclar ni bandas en píldora: las que cambian la lectura
   * salen como avisos (ver `boleta-diseno.test.ts`), así que el caso no tiene qué afirmar.
   */
});

describe("lo que la hoja tiene que decir", () => {
  it("trae el gasto entero del barrio y el coeficiente al lado", () => {
    expect(html).toContain("El barrio gastó");
    expect(html).toContain(vista.detalle.coeficiente.participacionTexto);
  });

  it("el bloque grande dice cuánto y cuándo, no un canal de pago", () => {
    /*
     * Boleta nueva (16c): la tabla de vencimientos de la zona 1 pasa a ser el bloque grande de la
     * maqueta —«Total a pagar» y «Vence el»—, con el segundo vencimiento como aclaración debajo.
     * Dónde se paga sigue viviendo en «Cómo pagar».
     */
    const pago = html.slice(html.indexOf('<section class="pago"'), html.indexOf("</section>", html.indexOf('<section class="pago"')));
    expect(pago).toContain("Vence el");
    expect(pago).toContain(vista.bloquePago.fechas.vencimiento.texto);
    expect(pago).toContain(vista.bloquePago.importes.alVencimiento.texto);
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
      unidad: { etiqueta: "Mza 99 · Lote 07", destinatario: '<script>alert(1)</script>"', numeroAccion: "<b>A-1</b>" },
    });
    const salida = cuerpoBoleta(conInyeccion);
    expect(salida).not.toContain("<script>");
    expect(salida).toContain("&lt;script&gt;");
    // El N.º de acción también es de origen humano (lo carga la administración en el padrón).
    expect(salida).not.toContain("<b>A-1</b>");
    expect(salida).toContain("&lt;b&gt;A-1&lt;/b&gt;");
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

describe("el N.º de acción y el CUIT del barrio (encargo 16c)", () => {
  const con = vistaBoletaDeMuestra({
    unidad: { etiqueta: "Mza 99 · Lote 07", destinatario: "GÓMEZ, ANA", numeroAccion: "LT-0042" },
    barrio: { nombre: "Barrio Demo Los Aromos", figuraJuridica: "ph_especial", domicilio: "Ruta E-53 km 12", cuit: "30-71234567-1" },
  });
  const sin = vistaBoletaDeMuestra({
    unidad: { etiqueta: "Mza 99 · Lote 07", destinatario: "GÓMEZ, ANA", numeroAccion: null },
    barrio: { nombre: "Barrio Demo Los Aromos", figuraJuridica: "ph_especial", domicilio: null, cuit: null },
  });

  it("se imprimen cuando vienen: el N.º de acción en el recuadro y el CUIT junto al domicilio", () => {
    const html = cuerpoBoleta(con);
    expect(html).toMatch(/N\.º de acción<\/span><b class="cifra">LT-0042<\/b>/);
    expect(html).toContain('<div class="barrio-sub">CUIT 30-71234567-1 · Ruta E-53 km 12</div>');
  });

  it("cuando no vienen, no queda hueco: ni casillero, ni rótulo, ni renglón vacío", () => {
    const html = cuerpoBoleta(sin);
    expect(html).not.toContain("N.º de acción");
    expect(html).not.toContain("CUIT");
    expect(html).not.toContain('class="barrio-sub"');
    // El recuadro queda con sus tres casilleros: unidad, titular y coeficiente.
    expect((html.match(/<section class="ident"[^]*?<\/section>/)?.[0].match(/<div/g) ?? []).length).toBe(3);
  });

  it("el dinero es el mismo con y sin los dos datos", () => {
    expect(con.totales.aPagar.monto).toBe(sin.totales.aPagar.monto);
  });
});

describe("la fecha de corte (encargo 15, 0078)", () => {
  // Boleta nueva (16c): la fecha va **siempre con año** (nota de la maqueta: el corte de diciembre
  // puede caer en enero). Antes, sin modo de cupón, se imprimía solo «dd/mm».
  it("se imprime «Se puede pagar hasta el dd/mm/aaaa» solo si el período la tiene", () => {
    expect(html).not.toContain("Se puede pagar hasta");
    const conCorte = cuerpoBoleta(
      vistaBoletaDeMuestra({ periodo: { ...vista.periodo, fechaCorte: { iso: "2026-08-25", texto: "25/08/2026" } } }),
    );
    expect(conCorte).toMatch(/Se puede pagar hasta el <b class="cifra">25\/08\/2026<\/b>/);
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
  /*
   * Boleta nueva (16c): la «zona 2» vieja es ahora la sección de conceptos del mes, y la deuda de
   * meses anteriores sale de su tabla a una sección propia, con la barra roja. Los importes que estos
   * casos afirman son los mismos de antes; cambia el markup donde se buscan.
   */
  const seccion = (h: string, apertura: string) => {
    const i = h.indexOf(apertura);
    return i < 0 ? "" : h.slice(i, h.indexOf("</section>", i));
  };
  const conceptos = seccion(htmlCupon, '<section class="conceptos-bloque"');
  const deudaHtml = seccion(htmlCupon, '<section class="deuda"');

  it("el total es el del mes, arriba y en los conceptos", () => {
    expect(conceptos).toContain(`<tr class="total"><td>Total de julio</td><td class="num cifra">${delMes.texto}</td></tr>`);
    // El bloque grande lleva el importe del cupón, no el total con deuda.
    expect(htmlCupon).toContain(`pt">${delMes.texto}</span>`);
    expect(htmlCupon).not.toContain(conCupon.totales.aPagar.texto);
  });

  it("debajo va la deuda de meses anteriores, mes por mes, con su total aparte y dicho que no está incluida", () => {
    expect(htmlCupon.indexOf('<section class="deuda"')).toBeGreaterThan(htmlCupon.indexOf('<section class="conceptos-bloque"'));
    expect(deudaHtml).toContain("Deuda de meses anteriores · no incluida en este cupón");
    expect(deudaHtml).toContain(
      '<tr><td>Junio 2026</td><td class="cifra">10/06/2026</td><td class="num cifra">600,00</td><td class="num cifra">18,00</td><td class="num cifra">618,00</td></tr>',
    );
    expect(deudaHtml).toContain('<td class="num cifra">618,00</td></tr>');
    // Con el desglose, el saldo y el interés ya no van como renglones que suman.
    expect(conceptos).not.toContain("Saldo de períodos anteriores");
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
    expect(seccion(sinDesglose, '<section class="conceptos-bloque"')).not.toContain("Saldo de períodos anteriores");
    const d = seccion(sinDesglose, '<section class="deuda"');
    expect(sinDesglose.indexOf('<section class="deuda"')).toBeGreaterThan(sinDesglose.indexOf("Total de julio"));
    expect(d).toContain("Deuda de meses anteriores · no incluida en este cupón");
    expect(d).toContain('<td class="num cifra">618,00</td>');
  });

  it("sin modo de cupón, la hoja es la de siempre: saldo, interés y total a pagar", () => {
    expect(html).toContain("Saldo de períodos anteriores");
    expect(html).not.toContain("Deuda de meses anteriores");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Encargo P2b: la cuota del plan de pagos, en los dos modos de cobro.
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("la cuota del plan de pagos", () => {
  const cuota = { etiqueta: "Plan de pagos · cuota 3 de 12", vencimiento: { iso: "2026-10-10", texto: "10/10/2026" }, importe: cifra("114285.69") };
  const conCuota = (cobra: "barrio" | "estudio") => {
    const base = vistaBoletaDeMuestra();
    const aPagar = sumarMontos(base.totales.aPagar.monto, "114285.69");
    const bloque =
      cobra === "barrio"
        ? {
            ...base.bloquePago,
            importes: { alVencimiento: cifra(aPagar), alTope: base.bloquePago.importes.alTope === null ? null : cifra(aPagar) },
          }
        : base.bloquePago;
    return parsearVistaBoleta({
      ...base,
      bloquePago: bloque,
      planDePagos: {
        cobra,
        cuotas: [cuota],
        total: cifra("114285.69"),
        aPagarConLaCuota: cobra === "barrio" ? cifra(aPagar) : null,
        estudio: cobra === "estudio" ? { nombre: "Estudio Jurídico Ejemplo", contacto: "(0351) 555-0142" } : null,
      },
    });
  };

  it("cobra el barrio: la cuota va en un renglón aparte y el total a pagar la incluye", () => {
    const v = conCuota("barrio");
    const h = cuerpoBoleta(v);
    expect(h).toContain("Plan de pagos · cuota 3 de 12");
    expect(h).toContain("114.285,69");
    expect(h).toContain(v.planDePagos!.aPagarConLaCuota!.texto);
    expect(h).toContain("Incluye la cuota del plan de pagos");
    expect(h).not.toContain("Se paga al estudio");
  });

  it("cobra el estudio: se informa con el nombre y el contacto, y no suma al total", () => {
    const v = conCuota("estudio");
    const h = cuerpoBoleta(v);
    expect(h).toContain("Se paga al estudio");
    expect(h).toContain("Esta cuota se paga a Estudio Jurídico Ejemplo, (0351) 555-0142. No está incluida en el total.");
    expect(h).toContain("Plan de pagos · cuota 3 de 12: $ 114.285,69, vence el 10/10/2026.");
    // El bloque grande y el total a pagar son los de siempre.
    expect(h).toContain(`<span class="importe" style="font-size:`);
    expect(h.split(v.totales.aPagar.texto).length - 1).toBeGreaterThanOrEqual(2);
    expect(h).not.toContain("Incluye la cuota del plan de pagos");
  });

  it("el modelo rechaza una cuota del barrio que no suma al cupón", () => {
    const base = vistaBoletaDeMuestra();
    expect(() =>
      parsearVistaBoleta({
        ...base,
        planDePagos: { cobra: "barrio", cuotas: [cuota], total: cifra("114285.69"), aPagarConLaCuota: base.totales.aPagar, estudio: null },
      }),
    ).toThrow(/lo del cupón más la cuota/);
  });

  it("sin plan, la hoja es exactamente la de siempre", () => {
    expect(cuerpoBoleta(parsearVistaBoleta({ ...vistaBoletaDeMuestra(), planDePagos: null }))).toBe(html);
  });
});
