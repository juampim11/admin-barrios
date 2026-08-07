/**
 * El diseño de doc 09 §E, verificado donde se puede verificar sin abrir un navegador: **en el CSS y
 * en el markup**. No mide píxeles (eso es el proyecto `pdf`); afirma las reglas que, si se rompen,
 * producen una hoja que se ve bien en la pantalla de quien la escribió y mal en la mano del vecino.
 */

import { describe, expect, it } from "vitest";
import { fontSizePrint, light, printInk, printInk as tinta, printMinLegibleZona1 } from "@admin-barrios/design-tokens";
import { ALTO_TIRA_MM, cuerpoBoleta, cuerpoDelTotal, estilosBoleta, PRESUPUESTO_MM } from "./boleta.ts";
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
     * El acento del barrio no entra en esta lista y no es un olvido: **va inline** (la franja, el
     * sello y el filete del adjunto), porque es dato del barrio y no una decisión de diseño.
     */
    const permitidos = new Set(
      [
        ...Object.values(printInk),
        light.primary,
        light.primarySubtle,
        light.info,
        light.infoSubtle,
        light.warning,
        light.warningSubtle,
        light.morosidad.alDia.fg,
        light.morosidad.alDia.bg,
        light.morosidad.vencido.fg,
        light.morosidad.vencido.bg,
      ].map((c) => c.toUpperCase()),
    );
    const usados = [...css.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toUpperCase());
    expect([...new Set(usados)].filter((c) => !permitidos.has(c))).toEqual([]);
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

  it("cada celda del titular es su propia caja acotada, con guarda de desborde", () => {
    // Dos celdas, no tres: `titular-donde` se cayó cuando la zona 1 pasó a la tabla de vencimientos
    // del mock. Dónde se paga vive en el pie, que ahora es una sección titulada con los datos.
    for (const zona of ["titular-total", "titular-vence"]) {
      expect(html).toContain(`data-desborde="${zona}"`);
    }
    // El `padding-bottom` es parte de la guarda, no aire: con el total en 32 pt la mancha del glifo
    // sobresale de su caja de línea y `scrollHeight` denunciaba un desborde de la celda que no era.
    expect(css).toContain(".titular > div{min-width:0;overflow:hidden;padding-bottom:1mm}");
  });
});

describe("las marcas de estado son dibujos, no caracteres", () => {
  it("no queda ni un marcador de texto tipo `[ok]` en la hoja", () => {
    for (const literal of ["[ok]", "[OK]", "[!]", "[*]", "[i]", "[?]", "[ ]"]) {
      expect(html).not.toContain(literal);
    }
  });

  it("cada banda con contenido lleva su glifo como SVG en línea", () => {
    const conGlifo = html.match(/<div class="banda banda--[a-z_]+"[^>]*><svg class="glifo"/g) ?? [];
    expect(conGlifo).toHaveLength(vista.bandas.length);
  });

  it("el glifo hereda la tinta de su banda: no hay color quemado adentro del SVG", () => {
    expect(html).toContain('stroke="currentColor"');
    expect(html).not.toMatch(/<svg class="glifo"[^>]*>[\s\S]{0,400}?(stroke|fill)="#/);
  });

  it("no depende de ningún emoji ni de una fuente de íconos: la red está apagada", () => {
    // Cualquier punto de código fuera del plano básico sería un emoji o un dingbat de fuente.
    expect(html).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{FE0F}]/u);
    expect(css).not.toMatch(/@font-face/);
  });

  it("cada banda declara su token de color de doc 09 §E.4.1", () => {
    // Con las píldoras del mock el token pinta el **contorno** de la caja (y su fondo), no un filete
    // izquierdo: la banda ya no es una barra a todo el ancho.
    for (const banda of vista.bandas) {
      expect(html).toContain(`banda banda--${banda.clave}`);
      expect(css).toContain(`.banda--${banda.clave}{border-color:`);
    }
  });

  it("los tres slots siguen declarados, y el vacío va ARRIBA para no romper el orden de §E.4.1", () => {
    const slots = html.match(/class="banda(?: vacia| banda--[a-z_]+)?"/g) ?? [];
    expect(slots).toHaveLength(3);
    expect(html.indexOf("banda vacia")).toBeLessThan(html.indexOf("banda banda--"));
  });
});

describe("el troquel y la zona de exclusión (doc 09 §E.6)", () => {
  it("el rótulo va EN la línea de corte, entre dos tramos punteados: no lo tacha nada", () => {
    expect(html).toMatch(
      /<div class="troquel"><span class="corte"><\/span><svg class="tijera"[\s\S]*?<span>PRESENTÁ ESTA PARTE EN LA CAJA<\/span><svg class="tijera"[\s\S]*?<span class="corte"><\/span><\/div>/,
    );
  });

  it("el filete punteado lo dibujan los tramos, no el borde del contenedor del texto", () => {
    expect(css).toContain(`.troquel .corte{flex:1 1 auto;border-top:.6pt dashed ${printInk.instrumentoInk}}`);
    expect(css).not.toMatch(/\.troquel\{[^}]*border-top/);
  });

  it("el troquel, el cupón y el talón viven dentro de la zona de exclusión", () => {
    const zona = html.slice(html.indexOf('class="exclusion"'));
    for (const parte of ['class="troquel"', 'class="zona5"', 'class="talon"']) {
      expect(zona).toContain(parte);
    }
  });

  it("la zona de exclusión es el ancla que el renderizador usa para frenar la marca de agua", () => {
    expect(html).toContain("data-exclusion");
  });
});

describe("el presupuesto vertical (doc 09 §E.2.2)", () => {
  it("la cabecera y el titular tienen medida propia y el detalle es el único con tope", () => {
    expect(css).toContain(`.zona0{flex:0 0 ${PRESUPUESTO_MM.zona0}mm`);
    /*
     * La zona 1 **ya no reserva alto**. Reservaba 52 mm para que el troquel cayera siempre en el
     * mismo lugar con las bandas grandes; con las píldoras del mock ese alto sólo dejaba un hueco
     * entre los vencimientos y el detalle, y el anclaje del troquel lo resuelve `.zona4`.
     */
    expect(css).toContain(".zona1{flex:0 0 auto;padding-top:");
    expect(css).not.toContain(`min-height:${PRESUPUESTO_MM.zona1}mm`);
    expect(css).toContain(`max-height:${PRESUPUESTO_MM.zona3}mm`);
  });

  it("el detalle sigue declarando su guarda: si no entra, no se emite", () => {
    expect(html).toContain('class="zona3" data-desborde="detalle"');
  });

  it("la franja de acento se come el margen superior y el contenido arranca en el margen", () => {
    expect(css).toContain(`margin:0 calc(-1 * var(--m-right)) calc(var(--m-top) - ${PRESUPUESTO_MM.franja}mm)`);
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

  it("el rótulo de la zona 2 no es el comentario del programador que era", () => {
    expect(html).toContain("Detalle del período");
    expect(html).not.toContain("De dónde sale ese número");
    expect(html).not.toContain("Qué cubre");
  });

  it("sin troquel declarado no se dibuja ni la tijera ni el rótulo", () => {
    const base = vistaBoletaDeMuestra();
    const sinCaja = vistaBoletaDeMuestra({
      bloquePago: {
        ...base.bloquePago,
        presentacion: { troquel: null, talon: "COMPROBANTE PARA VOS", instrucciones: ["Transferí y guardá el comprobante."] },
      },
    });
    const hoja = cuerpoBoleta(sinCaja);
    expect(hoja).not.toContain('class="troquel"');
    expect(hoja).not.toContain("EN LA CAJA");
    // Pero la zona de exclusión sigue existiendo: es el ancla de la marca de agua.
    expect(hoja).toContain("data-exclusion");
    expect(hoja).toContain("COMPROBANTE PARA VOS");
    expect(hoja).toContain("Transferí y guardá el comprobante.");
  });

  it("el rótulo del troquel sale del medio de cobro, no de la plantilla", () => {
    const base = vistaBoletaDeMuestra();
    const otro = vistaBoletaDeMuestra({
      bloquePago: { ...base.bloquePago, presentacion: { ...base.bloquePago.presentacion, troquel: "CORTAR POR ACÁ" } },
    });
    expect(cuerpoBoleta(otro)).toContain("CORTAR POR ACÁ");
  });
});

describe("la comparación con el período anterior (doc 10 §I.5.7)", () => {
  /*
   * **La hoja de un medio SIN cupón físico.** La muestra por defecto lleva código de barras, y con un
   * cupón de red el bloque no se imprime: se come ~73 mm del pie y el detalle se queda sin lugar —
   * medido, pedía 208 px y le quedaban 9, y la guarda cortaba la emisión. Así que estos casos se
   * miran sobre la variante que sí lo lleva.
   */
  const sinCupon = () => {
    const base = vistaBoletaDeMuestra();
    return vistaBoletaDeMuestra({
      bloquePago: {
        ...base.bloquePago,
        instrumentos: base.bloquePago.instrumentos.filter(
          (i) => i.tipo !== "simbolo" || i.simbologia === "qrcode",
        ),
        presentacion: { troquel: null, talon: "COMPROBANTE PARA VOS", instrucciones: [] },
      },
    });
  };
  const html = cuerpoBoleta(sinCupon());

  /*
   * **Acá había tres casos que afirmaban una tira de barras, y la tira se sacó.**
   *
   * El motivo está medido: la ordinaria se mueve dentro de su último 10 % —mínimo sobre máximo 0,89
   * con datos reales, 0,92 en esta muestra— y §I.5.7 manda no dibujar por encima de 0,7, porque con
   * el eje en cero (el único permitido) las columnas salen indistinguibles. Se dibujó igual una vez y
   * en el PDF salieron cuatro rectángulos vacíos que se leen como campos de formulario.
   *
   * Estos casos afirman lo contrario de lo que afirmaban los viejos: que **no** hay dibujo, y que la
   * información que la tira prometía está en las filas.
   */
  it("dibuja una barra por período y marca la de esta boleta", () => {
    const puntos = vistaBoletaDeMuestra().evolucion?.puntos.length ?? 0;
    expect(puntos).toBeGreaterThan(1);
    // `barra` y no `col`: el talón del mock también usa `col` para sus columnas, y el contador se
    // llevaba puestas las tres. Es el nombre que el mock le da a la columna de la tira.
    expect(html.match(/class="barra( hoy)?"/g)?.length).toBe(puntos);
    expect(html.match(/class="barra hoy"/g)?.length).toBe(1);
  });

  /*
   * El rótulo del mes **afuera** de la pista. Cuando iba adentro de un contenedor de alto fijo,
   * desbordaba y se superponía con las filas de abajo, dejando el título de la sección tachado. Es
   * el defecto que hizo rechazar la primera versión de la hoja.
   */
  it("el rótulo del mes vive afuera de la pista de alto fijo", () => {
    expect(html).toMatch(/<div class="pista"><div class="caja"[^>]*><\/div><\/div><div class="mes">/);
    expect(css).toContain(`.evolucion .pista{width:100%;height:${ALTO_TIRA_MM}mm`);
  });

  it("dos estados de tinta y ninguno intermedio: un gris medio no sobrevive la fotocopia", () => {
    /*
     * Las barras van **rellenas**, no en contorno: en contorno se leen como campos de formulario
     * vacíos. Los dos estados siguen siendo dos —el gris de filete, que es el más claro de la paleta
     * de papel, contra la tinta plena— y entre ellos no hay ninguno intermedio, que es lo que la
     * regla de doc 10 §I prohíbe porque se cierra en la fotocopia.
     */
    expect(css).toContain(`.evolucion .caja{width:100%;background:${tinta.hairline}}`);
    expect(css).toContain(`.evolucion .barra.hoy .caja{background:${tinta.textPrimary}}`);
    expect(css).not.toContain(".evolucion .caja{width:100%;background:transparent}");
  });

  it("el mes se rotula solo en los extremos de la tira", () => {
    const puntos = sinCupon().evolucion?.puntos ?? [];
    const rotulos = [...html.matchAll(/<div class="mes">([^<]*)<\/div>/g)].map((m2) => m2[1]);
    expect(rotulos).toHaveLength(puntos.length);
    expect(rotulos.filter((r) => r !== "")).toHaveLength(2);
  });

  it("el eje arranca en cero: la barra más alta ocupa la pista entera", () => {
    const alturas = [...html.matchAll(/class="caja" style="height:([\d.]+)mm"/g)].map((m) => Number(m[1]));
    expect(Math.max(...alturas)).toBe(ALTO_TIRA_MM);
    // Y ninguna se dibuja recortada contra el mínimo: la más baja guarda su proporción real.
    const e = vistaBoletaDeMuestra().evolucion;
    if (!e) throw new Error("la muestra tiene que traer evolución");
    const montos = e.puntos.map((p) => Number(p.importe.monto));
    const esperadoMin = (Math.min(...montos) / Math.max(...montos)) * ALTO_TIRA_MM;
    expect(Math.min(...alturas)).toBeCloseTo(esperadoMin, 1);
  });

  it("imprime los dos períodos con su importe y la variación", () => {
    const e = vistaBoletaDeMuestra().evolucion;
    if (!e) throw new Error("la muestra tiene que traer evolución");
    const previo = e.puntos.at(-2);
    const ultimo = e.puntos.at(-1);
    expect(html).toContain(`$ ${previo?.importe.texto}`);
    expect(html).toContain(`$ ${ultimo?.importe.texto}`);
    expect(html).toContain(e.variacionTexto);
    expect(html).toContain("esta boleta");
  });

  it("dice por qué el número no coincide con el total a pagar", () => {
    expect(html).toMatch(/no incluye extraordinarias, saldo anterior ni intereses/);
    expect(html).toMatch(/no coincide con el total a pagar/);
  });

  it("los rótulos de la tarjeta entran en un renglón", () => {
    /*
     * Decían "Cómo cambió tu expensa" y "Variación contra 06/26", y a 64 mm de tarjeta los dos
     * partían en dos renglones. El usuario los acortó: el rótulo no necesita nombrar lo que el barrio
     * cobra —la boleta entera ya lo dice— ni repetir contra qué mes se compara, que está en la fila
     * de arriba.
     */
    expect(html).toContain("Evolución mensual");
    expect(html).toContain("Última variación");
    expect(html).not.toMatch(/Cómo cambió/i);
    expect(html).not.toMatch(/Variación contra/i);
  });

  it("sin evolución no se dibuja nada, y tampoco el aviso del adjunto", () => {
    const hoja = cuerpoBoleta(vistaBoletaDeMuestra({ evolucion: null }));
    expect(hoja).not.toContain('class="evolucion"');
    expect(hoja).not.toContain("Va adjunta la liquidación");
  });

  /*
   * **Reemplaza al caso «sin troquel el pie no se ancla al fondo».**
   *
   * Aquel afirmaba lo contrario: que sin línea de corte el pie siguiera al contenido, para no dejar
   * cinco centímetros de blanco en el medio de la hoja. Con el mock el pie va anclado **siempre** —el
   * aire se junta arriba de las leyendas, donde se lee como margen, y el talón cae en el mismo lugar
   * tenga o no troquel—, así que la clase de la hoja pasó a decir otra cosa: si hay línea de corte,
   * ella es el separador del cupón y el filete de 0,8 pt no se dibuja. Dos líneas a cuatro
   * milímetros se leen como un error de impresión.
   */
  it("con línea de corte, el cupón no dibuja además su filete: la línea de corte ya lo separa", () => {
    const base = vistaBoletaDeMuestra();
    const sinCaja = vistaBoletaDeMuestra({
      bloquePago: { ...base.bloquePago, presentacion: { troquel: null, talon: "COMPROBANTE PARA VOS", instrucciones: [] } },
    });
    // Se mira la muestra por defecto —que SÍ lleva cupón— y no el `html` local de este `describe`,
    // que es justamente el de un medio sin troquel.
    expect(cuerpoBoleta(base)).toContain('class="boleta con-troquel"');
    expect(cuerpoBoleta(sinCaja)).toContain('class="boleta"');
    expect(cuerpoBoleta(sinCaja)).not.toContain("con-troquel");
    expect(css).toContain(`.zona5{background:${tinta.paper};color:${tinta.instrumentoInk};border-top:.8pt solid`);
    expect(css).toContain(".boleta.con-troquel .zona5{border-top:none");
  });

  it("el pie se ancla al fondo de la hoja, tenga o no troquel: el talón cae siempre en el mismo lugar", () => {
    expect(css).toContain(".zona4{flex:0 0 auto;margin-top:auto");
    expect(css).not.toContain("sin-anclaje");
  });
});
