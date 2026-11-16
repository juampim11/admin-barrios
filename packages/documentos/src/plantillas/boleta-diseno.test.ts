/**
 * El diseño de doc 09 §E, verificado donde se puede verificar sin abrir un navegador: **en el CSS y
 * en el markup**. No mide píxeles (eso es el proyecto `pdf`); afirma las reglas que, si se rompen,
 * producen una hoja que se ve bien en la pantalla de quien la escribió y mal en la mano del vecino.
 */

import { describe, expect, it } from "vitest";
import { fontSizePrint, light, printInk, printMinLegibleZona1 } from "@admin-barrios/design-tokens";
import { cifra } from "@admin-barrios/shared/documentos";
import { sumarMontos } from "@admin-barrios/shared/dinero";
import { cuerpoBoleta, cuerpoDelTotal, estilosBoleta, LARGO_CONCEPTO_CON_BARRAS, PRESUPUESTO_MM } from "./boleta.ts";
import { vistaBoletaDeMuestra } from "../fixtures/boleta-muestra.ts";

const css = estilosBoleta();
const vista = vistaBoletaDeMuestra();
const html = cuerpoBoleta(vista);

/** Todos los `font-size` declarados en el CSS, en pt. */
function cuerposDeclarados(): number[] {
  return [...css.matchAll(/font-size:\s*([\d.]+)pt/g)].map((m) => Number(m[1]));
}

describe("el piso tipográfico del frente (doc 09 §E.5.2 y §E.8.2)", () => {
  it("ningún cuerpo del frente baja de 8 pt — el escenario de diseño es un teléfono, no el papel", () => {
    // Es el linter que pide §E.8.2: si alguien "achica un poquito para que entre", el build lo dice.
    // 7 pt existe en la escala, pero SOLO para el pie legal del dorso, que todavía no se imprime.
    const chicos = cuerposDeclarados().filter((pt) => pt < fontSizePrint.xs);
    expect(chicos).toEqual([]);
  });

  it("el importe grande usa el techo de la escala y la zona 1 su piso", () => {
    expect(fontSizePrint["4xl"]).toBe(32);
    expect(printMinLegibleZona1).toBe(14);
    expect(css).toContain(`font-size:${fontSizePrint.xl}pt`);
  });
});

describe("las tintas del papel (doc 09 §E.5.3)", () => {
  it("`textMuted` está prohibido: a 4,6:1 no sobrevive a una fotocopia", () => {
    expect(css).not.toContain("#6B7686");
  });

  it("el instrumento va en negro puro, y sale del token — no de un hex escrito a mano", () => {
    expect(printInk.instrumentoInk).toBe("#000000");
    expect(css).toContain(`.exclusion{flex:0 0 auto;color:${printInk.instrumentoInk}`);
  });

  it("no hay ningún color escrito a mano en la hoja: todos los hex del CSS son de tokens", () => {
    /*
     * La lista se **arma con los tokens**, no con los hex copiados: cuando las bandas pasaron de
     * recuadro a píldora sumaron un fondo cada una, y con los literales el test habría que
     * actualizarlo a mano cada vez —que es exactamente la disciplina que este caso existe para no
     * necesitar—. Lo que afirma sigue siendo lo mismo: **ningún color de la hoja se escribe acá**.
     *
     * El acento del barrio no entra en esta lista y no es un olvido: **va inline**, como la variable
     * `--acento` del `<article>`, porque es dato del barrio y no una decisión de diseño.
     *
     * *(Boleta nueva, encargo 16c: la lista cambió de tintas porque la hoja cambió de dibujo. Se
     * fueron las de las píldoras de banda —`primary`, `info`, `morosidad`— y entraron las de la
     * maqueta: `danger` para la deuda de meses anteriores y el aviso de la bonificación perdida,
     * `success` para lo que se descuenta y el aviso de la bonificación ganada.)*
     */
    const permitidos = new Set(
      [
        ...Object.values(printInk),
        light.danger,
        light.dangerSubtle,
        light.success,
        light.successSubtle,
        light.warning,
        light.warningSubtle,
      ].map((c) => c.toUpperCase()),
    );
    const usados = [...css.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toUpperCase());
    expect([...new Set(usados)].filter((c) => !permitidos.has(c))).toEqual([]);
  });

  it("el acento del barrio entra inline como variable, y el CSS solo la nombra", () => {
    expect(html).toContain(`<article class="boleta" style="--acento:${vista.marca.barrio.acentoHex}">`);
    expect(css).toContain("var(--acento)");
    expect(css).not.toContain(vista.marca.barrio.acentoHex);
  });
});

describe("el importe grande no se pisa con la fecha de vencimiento", () => {
  it("un importe normal sale en 32 pt", () => {
    expect(cuerpoDelTotal("358.997,97")).toBe(fontSizePrint["4xl"]);
  });

  it("un importe largo **se achica lo necesario** en vez de invadir la celda de al lado", () => {
    const pt = cuerpoDelTotal("12.898.997,97");
    expect(pt).toBeLessThan(fontSizePrint["4xl"]);
    expect(pt).toBeGreaterThanOrEqual(printMinLegibleZona1);
  });

  it("el cuerpo elegido siempre entra en la celda, para cualquier largo de importe", () => {
    for (const texto of ["0,00", "1.234,56", "358.997,97", "12.898.997,97", "999.999.999.999,99"]) {
      const pt = cuerpoDelTotal(texto);
      const anchoMm = texto.length * 0.6 * pt * (25.4 / 72);
      expect(anchoMm).toBeLessThanOrEqual(PRESUPUESTO_MM.celdaTotal);
    }
  });

  it("nunca baja del piso legible de la zona 1: antes que un total ilegible, la guarda corta", () => {
    expect(cuerpoDelTotal("1".repeat(200))).toBe(printMinLegibleZona1);
  });

  it("cada celda del bloque grande es su propia caja acotada, con guarda de desborde", () => {
    // Boleta nueva: las dos celdas son las de la maqueta —«Total a pagar» y «Vence el»— dentro del
    // recuadro del acento. Antes se llamaban `titular-total` / `titular-vence` (la zona 1 vieja).
    for (const zona of ["pago-total", "pago-vence"]) {
      expect(html).toContain(`data-desborde="${zona}"`);
    }
    // El `padding-bottom` es parte de la guarda, no aire: con el total en 32 pt la mancha del glifo
    // sobresale de su caja de línea y `scrollHeight` denunciaba un desborde de la celda que no era.
    expect(css).toContain(".pago > .celda{min-width:0;overflow:hidden;padding-bottom:.8mm}");
  });

  it("la fecha de vencimiento va en el piso de la capa «sin zoom», no en el cuerpo de la maqueta", () => {
    expect(css).toContain(`.pago .vence .fecha{font-size:${printMinLegibleZona1}pt`);
  });
});

describe("las marcas de estado son dibujos, no caracteres", () => {
  it("no queda ni un marcador de texto tipo `[ok]` en la hoja", () => {
    for (const literal of ["[ok]", "[OK]", "[!]", "[*]", "[i]", "[?]", "[ ]"]) {
      expect(html).not.toContain(literal);
    }
  });

  /*
   * Boleta nueva (encargo 16c): las bandas ya no son píldoras al lado del nombre. Las que cambian
   * cómo se lee la hoja (bonificación, vista previa, interés pendiente) salen como **avisos** de la
   * maqueta; «al día» y «saldo anterior» ya los dice la deuda de meses anteriores, con su cifra, y no
   * se imprimen dos veces. El glifo sigue: el aviso nunca se comunica solo por color.
   */
  it("cada aviso lleva su glifo como SVG en línea", () => {
    const avisos = html.match(/<div class="aviso aviso--[a-z]+">/g) ?? [];
    const conGlifo = html.match(/<div class="aviso aviso--[a-z]+"><svg class="glifo"/g) ?? [];
    expect(avisos.length).toBeGreaterThan(0);
    expect(conGlifo).toHaveLength(avisos.length);
  });

  it("el glifo hereda la tinta de su banda: no hay color quemado adentro del SVG", () => {
    // La muestra imprime el aviso de la bonificación (la estrella, que se rellena) y ya no el de «al
    // día» (el tilde, que se traza): vale cualquiera de las dos, mientras sea `currentColor`.
    expect(html).toMatch(/(stroke|fill)="currentColor"/);
    expect(html).not.toMatch(/<svg class="glifo"[^>]*>[\s\S]{0,400}?(stroke|fill)="#/);
  });

  it("no depende de ningún emoji ni de una fuente de íconos: la red está apagada", () => {
    // Cualquier punto de código fuera del plano básico sería un emoji o un dingbat de fuente.
    expect(html).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{FE0F}]/u);
    expect(css).not.toMatch(/@font-face/);
  });

  it("cada tono de aviso declara su tinta de barra y de fondo", () => {
    for (const tono of ["critico", "ok", "atencion", "info"]) {
      expect(css).toContain(`.aviso--${tono}{border-left-color:`);
    }
  });

  it("«al día» y «saldo anterior» no se imprimen como aviso: los dice la deuda, con su cifra", () => {
    expect(vista.bandas.some((b) => b.clave === "al_dia")).toBe(true);
    expect(html).not.toContain(vista.bandas.find((b) => b.clave === "al_dia")?.texto ?? "∅");
  });
});

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * SIN TALÓN TROQUELADO (boleta nueva, encargo 16c)
 *
 * Reemplaza a «el troquel y la zona de exclusión», que afirmaba la línea de corte con su tijera y el
 * talón adentro del recorte. La maqueta aprobada es una hoja A4 sin troquel: el banco y las
 * billeteras leen el código de pago o el QR. `presentacion.troquel` y `presentacion.talon` siguen en
 * la vista `boleta/1` —no se tocó— y la plantilla no los dibuja, lo declare o no el medio de cobro.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
describe("sin troquel, y la zona de exclusión del instrumento (doc 09 §E.6)", () => {
  it("la muestra declara troquel y talón, y la hoja no dibuja ni la línea de corte ni el talón", () => {
    expect(vista.bloquePago.presentacion.troquel).not.toBeNull();
    expect(vista.bloquePago.presentacion.talon).not.toBeNull();
    expect(html).not.toContain('class="troquel"');
    expect(html).not.toContain('class="talon"');
    expect(html).not.toContain('class="tijera"');
    expect(html).not.toContain(vista.bloquePago.presentacion.troquel ?? "∅");
    expect(css).not.toMatch(/\.troquel|\.talon|\.tijera|dashed/);
  });

  it("«Cómo pagar» y los símbolos lineales viven dentro de la zona de exclusión", () => {
    const zona = html.slice(html.indexOf('class="exclusion"'));
    for (const parte of ['class="como"', 'class="simbolos"', 'data-simbologia="qrcode"']) {
      expect(zona).toContain(parte);
    }
    // El instrumento, en negro puro (doc 09 §E.5.3, regla 2).
    expect(css).toContain(`.exclusion{flex:0 0 auto;color:${printInk.instrumentoInk}`);
  });

  it("la zona de exclusión es el ancla que el renderizador usa para frenar la marca de agua", () => {
    expect(html).toContain("data-exclusion");
  });

  it("el QR va al costado de los datos y el código de barras en su propio renglón, a lo ancho", () => {
    const como = html.slice(html.indexOf('class="como"'), html.indexOf('class="simbolos"'));
    expect(como).toContain('data-simbologia="qrcode"');
    expect(como).not.toContain('data-simbologia="interleaved2of5"');
    expect(html.slice(html.indexOf('class="simbolos"'))).toContain('data-simbologia="interleaved2of5"');
  });
});

describe("el presupuesto vertical (doc 09 §E.2.2)", () => {
  it("la cabecera tiene alto fijo y la composición del gasto es la única zona con tope", () => {
    // El logo del cliente nunca define la altura de la cabecera.
    expect(css).toContain(`.enc{height:${PRESUPUESTO_MM.cabecera}mm`);
    expect(css).toContain(`max-height:${PRESUPUESTO_MM.detalle}mm`);
  });

  it("el detalle sigue declarando su guarda: si no entra, no se emite", () => {
    expect(html).toContain('class="zona3" data-desborde="detalle"');
  });

  it("sin franja a sangre: la cabecera cierra con el filete del acento, como la maqueta", () => {
    // Reemplaza a «la franja de acento se come el margen superior». La hoja arranca en el margen.
    expect(html).not.toContain('class="franja"');
    expect(css).toContain("padding:var(--m-top) var(--m-right) var(--m-bottom) var(--m-left)");
    expect(css).toMatch(/\.enc\{[^}]*border-bottom:[^;]*var\(--acento\)/);
  });
});


/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE DEPENDE DEL BARRIO Y NO PUEDE SALIR SIEMPRE (regla 6 de CLAUDE.md, en el papel)
 *
 * Tres textos y un bloque entero se imprimían **siempre**, y en un barrio de valor fijo cobrado por
 * transferencia decían cosas falsas: que hay una caja donde presentar el cupón, que el importe sale
 * de repartir un gasto, y una zona de cincuenta y seis milímetros con un guión en cada celda.
 *
 * Cada caso de acá tiene su contracara —que en el barrio donde SÍ corresponde siga saliendo—, porque
 * un condicional demasiado ancho rompe el uso real, que es peor que el texto de más.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
describe("la hoja depende del barrio", () => {
  /**
   * Una boleta de **valor fijo**: las líneas son `cuota_fija`, sin gasto del período ni coeficiente.
   *
   * Las tres cosas van juntas y no por prolijidad: el esquema exige que el gasto del período exista
   * **si y solo si** la línea es un prorrateo. El primer intento de esta muestra nulaba los dos
   * campos dejando `clase: "prorrateo"` y la vista lo rechazó — que es exactamente lo que ese
   * invariante existe para hacer.
   */
  const deValorFijo = () => {
    const base = vistaBoletaDeMuestra();
    return vistaBoletaDeMuestra({
      detalle: {
        ...base.detalle,
        lineas: base.detalle.lineas.map((l) => ({
          ...l,
          clase: "cuota_fija" as const,
          gastoDelPeriodo: null,
          coeficiente: null,
          importeTeorico: null,
        })),
      },
    });
  };

  it("la zona del reparto NO se imprime cuando no hubo reparto", () => {
    expect(cuerpoBoleta(deValorFijo())).not.toContain('class="zona3"');
  });

  it("pero sigue estando cuando el barrio sí prorratea", () => {
    expect(html).toContain('class="zona3" data-desborde="detalle"');
  });

  it("los conceptos se titulan con el mes, como la maqueta, y no con un comentario del programador", () => {
    // Boleta nueva: «Conceptos de julio» reemplaza a «Detalle del período».
    expect(html).toContain("Conceptos de julio");
    expect(html).not.toContain("De dónde sale ese número");
    expect(html).not.toContain("Qué cubre");
  });

  it("las instrucciones del medio de cobro se imprimen; el talón y el troquel, nunca", () => {
    const base = vistaBoletaDeMuestra();
    const sinCaja = vistaBoletaDeMuestra({
      bloquePago: {
        ...base.bloquePago,
        presentacion: { troquel: null, talon: "COMPROBANTE PARA VOS", instrucciones: ["Transferí y guardá el comprobante."] },
      },
    });
    const hoja = cuerpoBoleta(sinCaja);
    expect(hoja).not.toContain("EN LA CAJA");
    expect(hoja).not.toContain("COMPROBANTE PARA VOS");
    expect(hoja).toContain("data-exclusion");
    expect(hoja).toContain("Transferí y guardá el comprobante.");
  });

  it("el título del documento es la denominación del barrio, no una palabra de la plantilla", () => {
    const social = cuerpoBoleta(vistaBoletaDeMuestra({ periodo: { ...vista.periodo, denominacionConcepto: "cuota social" } }));
    expect(social).toContain('<span class="etq">Cuota social</span>');
    expect(social).toContain('<div class="mes" data-sin-marca>Julio 2026</div>');
  });
});

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * SIN TARJETA DE EVOLUCIÓN (boleta nueva, encargo 16c)
 *
 * Acá había doce casos sobre la tarjeta «Evolución mensual» (barras, rótulos en los extremos, eje en
 * cero, las dos filas y la variación). La maqueta aprobada no la tiene y la hoja nueva no la dibuja:
 * `evolucion` sigue en la vista `boleta/1` y solo se usa para el aviso del adjunto, que es un
 * requisito del usuario (2026-08-05) y sobrevive en el pie.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
describe("la evolución y el aviso del adjunto", () => {
  it("no se dibuja la tarjeta de evolución, aunque la vista la traiga", () => {
    expect(vista.evolucion).not.toBeNull();
    expect(html).not.toContain('class="evolucion"');
    expect(html).not.toContain("Evolución mensual");
  });

  it("con evolución, el pie avisa que va adjunta la liquidación del mes anterior", () => {
    expect(html).toContain(`Va adjunta la liquidación de ${vista.evolucion?.puntos.at(-2)?.etiqueta}`);
  });

  it("sin evolución, tampoco el aviso del adjunto", () => {
    expect(cuerpoBoleta(vistaBoletaDeMuestra({ evolucion: null }))).not.toContain("Va adjunta la liquidación");
  });

  /*
   * Reemplaza a «el pie se ancla al fondo de la hoja, tenga o no troquel». El anclaje existía para que
   * la tijera cayera siempre en el mismo lugar; sin troquel, solo dejaba media hoja en blanco entre
   * «Cómo pagar» y el pie de una boleta corta. La maqueta pone el pie a continuación del contenido.
   */
  it("el pie sigue al contenido, como la maqueta, y dice la emisión y el folio", () => {
    expect(css).toContain(".pie{margin-top:1.2mm;");
    expect(css).not.toContain("margin-top:auto");
    expect(html).toContain(`Emitida el ${vista.emision.fecha?.texto} · página 1 de 1`);
    const sinEmitir = cuerpoBoleta(vistaBoletaDeMuestra({ emision: { fecha: null, comprobante: null } }));
    expect(sinEmitir).toContain("Documento sin emitir · página 1 de 1");
  });
});

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LAS REGLAS QUE IMPONE LA MAQUETA (encargo 16c)
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
describe("la boleta nueva: qué cobra el bloque grande", () => {
  const delMes = vista.totales.delPeriodo;
  const deuda = [
    {
      periodo: "2026-05",
      etiqueta: "Mayo 2026",
      vencimiento: { iso: "2026-05-10", texto: "10/05/2026" },
      capital: cifra("400.00"),
      interes: cifra("24.00"),
      total: cifra("424.00"),
    },
    {
      periodo: "2026-06",
      etiqueta: "Junio 2026",
      vencimiento: { iso: "2026-06-10", texto: "10/06/2026" },
      capital: cifra("200.00"),
      interes: cifra("6.00"),
      total: cifra("206.00"),
    },
  ];
  const conDeuda = (modo: "solo_mes" | "mes_mas_deuda") => {
    const aPagar = cifra(sumarMontos(delMes.monto, "630.00"));
    const importe = modo === "solo_mes" ? delMes : aPagar;
    const base = vistaBoletaDeMuestra();
    return vistaBoletaDeMuestra({
      totales: { delPeriodo: delMes, saldoAnterior: cifra("600.00"), interes: cifra("30.00"), aPagar },
      interes: {
        base: cifra("600.00"),
        tasaMensualTexto: null,
        dias: 30,
        computadoHasta: { iso: "2026-07-31", texto: "31/07/2026" },
        arrastre: { pendiente: cifra("0.00"), alCorte: cifra("30.00") },
      },
      cupon: { modo, importe, deudaNoIncluida: cifra(modo === "solo_mes" ? "630.00" : "0.00") },
      deudaAnterior: deuda,
      bloquePago: { ...base.bloquePago, importes: { alVencimiento: importe, alTope: null } },
    } as never);
  };
  const seccion = (h: string, apertura: string) =>
    h.slice(h.indexOf(apertura), h.indexOf("</section>", h.indexOf(apertura)));
  const bloqueGrande = (h: string) => seccion(h, '<section class="pago"');
  const seccionDeuda = (h: string) => seccion(h, '<section class="deuda"');

  it("con «solo el mes», la deuda anterior NO suma al bloque grande: va aparte, mes por mes", () => {
    const v = conDeuda("solo_mes");
    const h = cuerpoBoleta(v);
    expect(bloqueGrande(h)).toContain(`>${delMes.texto}</span>`);
    expect(h).not.toContain(v.totales.aPagar.texto);
    expect(bloqueGrande(h)).toContain("Cobra solo julio");
    const d = seccionDeuda(h);
    expect(d).toContain("no incluida en este cupón");
    expect(d).toContain("Mayo 2026");
    expect(d).toContain("Junio 2026");
    // El total de la deuda es lo que el cupón no cobra, y es una cifra de la vista.
    expect(d).toContain(`<td class="num cifra">${v.cupon?.deudaNoIncluida.texto}</td>`);
    // Va DESPUÉS de los conceptos del mes, no adentro de su tabla.
    expect(h.indexOf('<section class="deuda"')).toBeGreaterThan(h.indexOf('<section class="conceptos-bloque"'));
    expect(h.slice(0, h.indexOf('<section class="deuda"'))).not.toContain("Saldo de períodos anteriores");
  });

  it("con «el mes más la deuda», el bloque grande suma la deuda y la tabla queda como detalle", () => {
    const v = conDeuda("mes_mas_deuda");
    const h = cuerpoBoleta(v);
    expect(bloqueGrande(h)).toContain(`>${v.totales.aPagar.texto}</span>`);
    expect(bloqueGrande(h)).toContain("Incluye la deuda de meses anteriores");
    expect(bloqueGrande(h)).not.toContain("Cobra solo");
    const d = seccionDeuda(h);
    expect(d).toContain("incluida en el total a pagar");
    expect(d).not.toContain("no incluida");
    // El saldo y el interés están impresos con su cifra en la fila del total adeudado (doc 07 §B).
    expect(d).toContain(`<td class="num cifra">${v.totales.saldoAnterior.texto}</td>`);
    expect(d).toContain(`<td class="num cifra">${v.totales.interes?.texto}</td>`);
  });

  it("el interés de la tabla de la deuda dice a qué fecha se calculó, con año", () => {
    expect(seccionDeuda(cuerpoBoleta(conDeuda("solo_mes")))).toContain("Interés al 31/07/2026");
  });

  it("no promete el cupón de deuda, que todavía no existe (decisión del encargo 16)", () => {
    expect(cuerpoBoleta(conDeuda("solo_mes"))).not.toMatch(/propio cupón|Pedilo a la administración/);
  });

  it("con «solo el mes» al día no hay tabla, pero se dice que no hay deuda", () => {
    const h = cuerpoBoleta(
      vistaBoletaDeMuestra({ cupon: { modo: "solo_mes", importe: delMes, deudaNoIncluida: cifra("0.00") }, deudaAnterior: [] } as never),
    );
    expect(h).not.toContain('<section class="deuda"');
    expect(h).toContain("No registra deuda de meses anteriores.");
  });
});

describe("la boleta nueva: fechas, avisos y composición", () => {
  it("el segundo vencimiento y la fecha de corte se imprimen con año", () => {
    const base = vistaBoletaDeMuestra();
    const h = cuerpoBoleta(
      vistaBoletaDeMuestra({
        bloquePago: {
          ...base.bloquePago,
          fechas: { vencimiento: base.bloquePago.fechas.vencimiento, tope: { iso: "2026-08-20", texto: "20/08/2026" } },
          importes: { alVencimiento: base.bloquePago.importes.alVencimiento, alTope: base.bloquePago.importes.alVencimiento },
        },
        periodo: { ...base.periodo, fechaCorte: { iso: "2026-08-25", texto: "25/08/2026" } },
      }),
    );
    expect(h).toContain('2.º vencimiento <b class="cifra">20/08/2026</b>, mismo importe');
    expect(h).toContain('Se puede pagar hasta el <b class="cifra">25/08/2026</b>');
  });

  it("si el segundo vencimiento lleva otro importe, lo dice con su cifra", () => {
    const base = vistaBoletaDeMuestra();
    const h = cuerpoBoleta(
      vistaBoletaDeMuestra({
        bloquePago: {
          ...base.bloquePago,
          fechas: { vencimiento: base.bloquePago.fechas.vencimiento, tope: { iso: "2026-08-20", texto: "20/08/2026" } },
          importes: { alVencimiento: base.bloquePago.importes.alVencimiento, alTope: cifra("365000.00") },
        },
      }),
    );
    expect(h).toContain('2.º vencimiento <b class="cifra">20/08/2026</b>: <b class="cifra">$ 365.000,00</b>');
  });

  it("el aviso «sin bonificación» aparece solo cuando la vista dice que no se aplicó", () => {
    expect(html).not.toContain("aviso--critico");
    const sinBonif = cuerpoBoleta(
      vistaBoletaDeMuestra({
        bandas: [
          {
            clave: "bonificacion_no_aplicada",
            marca: "info",
            titulo: "Bonificación no aplicada",
            texto: "Este mes no se aplicó la bonificación por pago en término de $ 15.000,00.",
          },
        ],
      }),
    );
    expect(sinBonif).toContain('<div class="aviso aviso--critico">');
    expect(sinBonif).toContain("Bonificación no aplicada.");
    // Y va con los conceptos del mes, que es donde falta el descuento.
    const conceptos = sinBonif.slice(sinBonif.indexOf('<section class="conceptos-bloque"'));
    expect(conceptos.indexOf("aviso--critico")).toBeLessThan(conceptos.indexOf("</section>"));
  });

  it("la bonificación ganada se avisa en verde, y la vista previa arriba, antes de los conceptos", () => {
    expect(html).toContain('<div class="aviso aviso--ok">');
    const previa = cuerpoBoleta(
      vistaBoletaDeMuestra({
        bandas: [{ clave: "vista_previa", marca: "borrador", titulo: "Vista previa", texto: "No es un comprobante de pago." }],
      }),
    );
    expect(previa.indexOf("aviso--info")).toBeLessThan(previa.indexOf('<section class="conceptos-bloque"'));
  });

  it("el recuadro de la unidad imprime unidad, titular y coeficiente; no deja casilleros vacíos", () => {
    const apertura = '<section class="ident"';
    const ident = html.slice(html.indexOf(apertura), html.indexOf("</section>", html.indexOf(apertura)));
    expect(ident).toContain(vista.unidad.etiqueta);
    expect(ident).toContain(vista.unidad.destinatario);
    expect(ident).toContain(`${vista.detalle.coeficiente.participacionTexto} %`);
    // El N.º de acción no está en `boleta/1`: no se imprime un rótulo sin dato.
    expect(ident).not.toContain("acción");
    expect(ident.match(/class="etq"/g)).toHaveLength(3);
  });

  it("sin logo van las iniciales del barrio en el bloque del acento", () => {
    expect(html).toContain('<div class="sello" aria-hidden="true">DA</div>');
  });

  it("la barra G-8 se cae, y nunca el nombre, cuando un concepto no entra con ella", () => {
    const base = vistaBoletaDeMuestra();
    const largo = "Poda de altura en los espacios verdes del ingreso";
    expect(largo.length).toBeGreaterThan(LARGO_CONCEPTO_CON_BARRAS);
    const h = cuerpoBoleta(
      vistaBoletaDeMuestra({
        detalle: { ...base.detalle, lineas: base.detalle.lineas.map((l, i) => (i === 0 ? { ...l, concepto: largo } : l)) },
      }),
    );
    expect(h).toContain(largo);
    expect(h).not.toContain("g-pista");
    // Con los nombres de la muestra, que entran, la barra sigue.
    expect(html).toContain("g-pista");
  });
});
