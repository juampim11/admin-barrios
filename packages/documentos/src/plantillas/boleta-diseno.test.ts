/**
 * El diseño de doc 09 §E, verificado donde se puede verificar sin abrir un navegador: **en el CSS y
 * en el markup**. No mide píxeles (eso es el proyecto `pdf`); afirma las reglas que, si se rompen,
 * producen una hoja que se ve bien en la pantalla de quien la escribió y mal en la mano del vecino.
 */

import { describe, expect, it } from "vitest";
import { fontSizePrint, printInk, printMinLegibleZona1 } from "@admin-barrios/design-tokens";
import { cuerpoBoleta, cuerpoDelTotal, estilosBoleta, PRESUPUESTO_MM } from "./boleta.ts";
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
    const permitidos = new Set(
      [...Object.values(printInk), "#15803D", "#B45309", "#0D9488", "#1D6FB8"].map((c) => c.toUpperCase()),
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
    for (const zona of ["titular-total", "titular-vence", "titular-donde"]) {
      expect(html).toContain(`data-desborde="${zona}"`);
    }
    expect(css).toContain(".titular > div{min-width:0;overflow:hidden}");
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
    for (const banda of vista.bandas) {
      expect(html).toContain(`banda banda--${banda.clave}`);
      expect(css).toContain(`.banda--${banda.clave}{border-left-color:`);
    }
  });

  it("los tres slots siguen reservados, y el vacío va ARRIBA para no dejar un hueco al pie", () => {
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
    expect(css).toContain(`.zona1{flex:0 0 auto;min-height:${PRESUPUESTO_MM.zona1}mm`);
    expect(css).toContain(`max-height:${PRESUPUESTO_MM.zona3}mm`);
  });

  it("el detalle sigue declarando su guarda: si no entra, no se emite", () => {
    expect(html).toContain('class="zona3" data-desborde="detalle"');
  });

  it("la franja de acento se come el margen superior y el contenido arranca en el margen", () => {
    expect(css).toContain(`margin:0 calc(-1 * var(--m-right)) calc(var(--m-top) - ${PRESUPUESTO_MM.franja}mm)`);
  });
});
