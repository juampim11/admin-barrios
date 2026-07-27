/**
 * Los criterios de aceptación del vocabulario gráfico (doc 10 §I.10).
 *
 * Ocho de los nueve se verifican acá, sin navegador: son afirmaciones sobre la **geometría** y sobre
 * el **markup**, y las dos salen de funciones puras. El noveno —que el documento fotocopiado en blanco
 * y negro diga exactamente lo mismo— es manual por definición y se hace una vez por versión de
 * plantilla, rasterizando el PDF a escala de grises.
 *
 * El criterio 6 (paginación) vive en el proyecto `pdf`: sin navegador no hay páginas que contar.
 */

import { describe, expect, it } from "vitest";
import { chartPrint, printInk } from "@admin-barrios/design-tokens";
import { parsearVistaBoleta, parsearVistaInformeMensual, parsearVistaListadoMora } from "@admin-barrios/shared/documentos";
import {
  ANCHO_UTIL_PISTA,
  anchoDeRelleno,
  celdaBarra,
  estilosGraficos,
  geometriaDeTira,
  llevaColumnaDeBarras,
  sePuedeDibujarTira,
  tiraDePeriodos,
} from "./graficos.ts";
import { cuerpoInformeMensual } from "./informe-mensual.ts";
import { cuerpoListadoMora } from "./listado-mora.ts";
import { cuerpoBoleta } from "./boleta.ts";
import { vistaBoletaDeMuestra } from "../fixtures/boleta-muestra.ts";
import { informeMuestra, listadoNominadoMuestra } from "../fixtures/informes-muestra.ts";

const punto = (periodo: string, texto: string | null) => ({
  periodo,
  etiqueta: `${periodo.slice(5)}/${periodo.slice(0, 4)}`,
  texto,
  unidades: null,
});
const serie = (...textos: (string | null)[]) => ({
  puntos: textos.map((t, i) => punto(`2026-${String(i + 1).padStart(2, "0")}`, t)),
});

/** Cuántas veces aparece un fragmento. Sirve para contar rectángulos dibujados. */
const veces = (html: string, fragmento: string) => html.split(fragmento).length - 1;

// --- Criterio 1 · la escala ---------------------------------------------------------------------

describe("criterio 1 · la escala va de 0 al TOTAL del cuadro, nunca al máximo de la serie", () => {
  it("la fila que vale el total llena la pista exactamente", () => {
    expect(anchoDeRelleno("1.000,00", "1.000,00")).toBe(ANCHO_UTIL_PISTA);
  });

  it("la fila que vale la mitad llena la mitad", () => {
    expect(anchoDeRelleno("500,00", "1.000,00")).toBeCloseTo(ANCHO_UTIL_PISTA / 2, 1);
  });

  it("**con un máximo del 58 %, ninguna barra llega al borde**", () => {
    // Es el cuadro real del barrio piloto: seguridad 58,49 % y diez rubros detrás. Con escala
    // 0→máximo, seguridad llenaría la pista entera y espacios verdes (11,37 %) se dibujaría al 19 %.
    const total = "180.429.036,45";
    const filas = ["105.541.706,40", "20.522.778,17", "12.923.793,36", "10.239.584,90", "8.454.625,41"];
    const anchos = filas.map((f) => anchoDeRelleno(f, total));
    expect(Math.max(...anchos)).toBeLessThan(ANCHO_UTIL_PISTA);
    expect(anchos[0]).toBeCloseTo(ANCHO_UTIL_PISTA * 0.5849, 1);
  });

  it("una fila mayor que el total no se sale de la pista", () => {
    // Puede pasar en modo agregado, donde las celdas se redondean y su suma se corre del total.
    expect(anchoDeRelleno("2.000,00", "1.000,00")).toBe(ANCHO_UTIL_PISTA);
  });
});

// --- Criterio 2 · el valor publicado -------------------------------------------------------------

describe("criterio 2 · la barra se dibuja desde el texto publicado (§I.8.2)", () => {
  it("la longitud es una función pura del texto impreso: mismo texto, misma barra", () => {
    expect(celdaBarra("41.054.000,00", "101.892.000,00")).toBe(celdaBarra("41.054.000,00", "101.892.000,00"));
  });

  it("dibujar desde el valor exacto en vez del publicado **sí cambia la barra**", () => {
    // El caso que esto atrapa: la celda publica el importe redondeado y la barra se dibuja desde el
    // valor con centavos, así que el dibujo lleva la precisión que el número perdió a propósito —
    // recuperable con una regla, porque la pista es la escala.
    expect(anchoDeRelleno("4.000,00", "10.000,00")).not.toBe(anchoDeRelleno("4.049,00", "10.000,00"));
  });

  it("a escala de millones el redondeo a centésimas de punto absorbe la fuga, y aun así no se confía", () => {
    // $ 371 sobre $ 101 millones son 0,0002 pt: la barra sale igual la dibujes como la dibujes. La
    // regla no depende de eso — con otro redondeo o con un barrio más chico la fuga vuelve, y una
    // defensa que funciona por el tamaño de los números de un cliente no es una defensa.
    expect(anchoDeRelleno("41.054.000,00", "101.892.000,00")).toBe(anchoDeRelleno("41.054.371,88", "101.892.000,00"));
  });

  it("la geometría no acepta un monto de dominio, ni por descuido", () => {
    expect(() => anchoDeRelleno("1234.56", "10000.00")).toThrow(/texto impreso/);
  });
});

// --- Criterio 3 · el cero y el mínimo ------------------------------------------------------------

describe("criterio 3 · ausencia de tinta es el cero, y la tinta mínima es «mayor que cero»", () => {
  it("una fila en cero dibuja la pista y **cero** rectángulos de relleno", () => {
    const html = celdaBarra("0,00", "1.000,00");
    expect(html).toContain("g-pista");
    expect(veces(html, "<i ")).toBe(0);
  });

  it("una fila con un valor positivo minúsculo dibuja UN rectángulo de al menos 1,5 pt", () => {
    const html = celdaBarra("4,00", "1.000,00"); // 0,4 % del total
    expect(veces(html, "<i ")).toBe(1);
    expect(anchoDeRelleno("4,00", "1.000,00")).toBe(chartPrint.minInk);
  });

  it("una fila que no pertenece al todo **no lleva ni pista**", () => {
    // Corrección deliberada a la letra de §I.6.1: una pista vacía ya significa cero (caso 2), y un
    // mismo dibujo no puede decir dos cosas.
    expect(celdaBarra(null, "1.000,00")).toBe("");
  });
});

// --- Criterio 4 · negativos ----------------------------------------------------------------------

describe("criterio 4 · un negativo apaga el cuadro entero y la tira lo dibuja hacia abajo", () => {
  it("un cuadro con un renglón negativo se renderiza sin ninguna barra", () => {
    // Es el cuadro de ingresos del informe real: cuota de lista 102,93 % y bonificación −7,72 %. Los
    // renglones no son partes de un todo, y una barra de participación afirmaría que lo son.
    expect(llevaColumnaDeBarras(["102,93", "-7,72", "3,00", "1,79"])).toBe(false);
  });

  it("con menos de tres filas mayores que cero tampoco se dibuja", () => {
    expect(llevaColumnaDeBarras(["1.000,00", "500,00"])).toBe(false);
    expect(llevaColumnaDeBarras(["1.000,00", "500,00", "0,00"])).toBe(false);
    expect(llevaColumnaDeBarras(["1.000,00", "500,00", "1,00"])).toBe(true);
  });

  it("una tira con un período negativo dibuja la línea de base y una columna por debajo", () => {
    const geo = geometriaDeTira(["1.000,00", "-500,00", "2.000,00"]);
    expect(geo.base).toBeGreaterThan(0);
    expect(geo.base).toBeLessThan(geo.alto);
    const negativa = geo.columnas[1];
    expect(negativa?.y).toBe(geo.base); // arranca en el cero y baja
    expect(negativa?.alto).toBeGreaterThan(0);
  });

  it("con toda la serie positiva la línea de base sigue estando, al pie", () => {
    const geo = geometriaDeTira(["1.000,00", "2.000,00", "3.000,00"]);
    expect(geo.base).toBe(chartPrint.stripHeight);
  });

  it("un período sin informe no se interpola: reserva su lugar y no dibuja nada", () => {
    const geo = geometriaDeTira(["1.000,00", null, "3.000,00"]);
    expect(geo.columnas[1]?.alto).toBe(0);
    expect(geo.columnas[2]?.x).toBeGreaterThan(geo.columnas[1]?.x ?? 0);
  });
});

// --- Criterio 5 · el umbral de la tira -----------------------------------------------------------

describe("criterio 5 · con menos de tres períodos hay un delta, no una tendencia", () => {
  it("con 1 y con 2 períodos no se dibuja ninguna tira", () => {
    expect(sePuedeDibujarTira(serie("1.000,00"))).toBe(false);
    expect(sePuedeDibujarTira(serie("1.000,00", "2.000,00"))).toBe(false);
    for (const s of [serie("1.000,00"), serie("1.000,00", "2.000,00")]) {
      expect(tiraDePeriodos(s, { rotulo: null })).not.toContain('class="g-tira"');
    }
  });

  it("con 1 período el texto de reemplazo lo dice, y no inventa un delta contra nada", () => {
    expect(tiraDePeriodos(serie("1.000,00"), { rotulo: null })).toContain("primer período liquidado");
  });

  it("con 2 períodos muestra los dos puntos publicados, sin calcular la diferencia", () => {
    const html = tiraDePeriodos(serie("1.000,00", "2.000,00"), { rotulo: null });
    expect(html).toContain("1.000,00");
    expect(html).toContain("2.000,00");
    expect(html).not.toContain('class="g-tira"');
  });

  it("con 3 la tira aparece, con su línea de base y tres columnas", () => {
    const html = tiraDePeriodos(serie("1.000,00", "2.000,00", "3.000,00"), { rotulo: null });
    expect(html).toContain('class="g-tira"');
    expect(veces(html, "<i ")).toBe(3);
    expect(veces(html, "<b ")).toBe(1);
  });

  it("sin serie no hay nada: el documento se comporta como antes de que existiera la forma", () => {
    expect(tiraDePeriodos(null, { rotulo: "Historia" })).toBe("");
  });

  it("no rotula un número por columna: sólo los dos extremos y el último valor", () => {
    const html = tiraDePeriodos(serie("1.000,00", "2.000,00", "3.000,00"), { rotulo: "Historia" });
    expect(veces(html, "1.000,00")).toBe(0); // el primero se rotula por período, no por valor
    expect(veces(html, "2.000,00")).toBe(0);
    expect(veces(html, "3.000,00")).toBe(1); // el último, una sola vez
  });
});

// --- Criterio 7 · privacidad ---------------------------------------------------------------------

describe("criterio 7 · dónde no hay gráficos, y punto (§I.8.4)", () => {
  const html = cuerpoListadoMora(parsearVistaListadoMora(listadoNominadoMuestra()));

  it("en modo nominado no hay **ni un** elemento dibujado en el detalle por unidad", () => {
    // Una barra por vecino convertiría el listado en un ranking visual de personas, y eso cambiaría
    // la naturaleza del documento sin que nadie lo haya decidido.
    const detalle = html.slice(html.indexOf("Detalle por unidad"));
    expect(detalle).not.toContain("g-pista");
    expect(detalle).not.toContain("g-tira");
  });

  it("el listado no dibuja **ninguna** tira: G-5 se descartó (doc 10 §I.4, descarte 9)", () => {
    // La serie real del total de mora del barrio piloto va de 83 a 102 millones y, con el eje desde
    // cero que este producto exige, dibujaba columnas indistinguibles. Se sacaron el dibujo y
    // el campo que lo alimentaba: el modelo de vista es `.strict()`, así que además de no dibujarse,
    // la serie ya no entra ni por descuido — y con ella se fueron sus dos defensas de privacidad,
    // que habría que reponer si algún día vuelve.
    expect(html).not.toContain("g-tira");
    expect(() =>
      parsearVistaListadoMora({ ...(listadoNominadoMuestra() as object), serieMora: null }),
    ).toThrow(/serieMora/);
  });
});

// --- Criterio 8 · la tinta -----------------------------------------------------------------------

describe("criterio 8 · dos tintas, ninguna nueva, y nada que una fotocopia pueda degradar", () => {
  const css = estilosGraficos();

  it("no usa ningún color fuera de las tintas del papel", () => {
    const permitidos = new Set(
      [printInk.textPrimary, printInk.hairline, printInk.textSecondary].map((c) => c.toUpperCase()),
    );
    const usados = [...css.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toUpperCase());
    expect([...new Set(usados)].filter((c) => !permitidos.has(c))).toEqual([]);
  });

  it("`textMuted` sigue prohibido en el papel, también en una forma", () => {
    expect(css).not.toContain("#6B7686");
  });

  it("**ninguna trama, ningún gradiente, ninguna opacidad**", () => {
    // La cláusula de `background-image` es la que atrapa una trama disfrazada de gradiente repetido:
    // a 1 mm de alto, una trama hace moiré con la de la impresora y se rellena en la fotocopia. Ya se
    // midió en este producto con la píldora `pendiente` y hubo que abandonarla.
    expect(css).not.toMatch(/background-image|linear-gradient|repeating-|opacity/);
  });

  it("el relleno lleva la tinta fuerte y la referencia el filete de 0,4 pt", () => {
    expect(css).toContain(`background:${printInk.textPrimary}`);
    expect(css).toContain(`border:${chartPrint.rule}pt solid ${printInk.hairline}`);
  });

  it("no dibuja con SVG: las dos formas son rectángulos", () => {
    const html = tiraDePeriodos(serie("1.000,00", "2.000,00", "3.000,00"), { rotulo: "x" }) + celdaBarra("1,00", "2,00");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<path");
  });

  it("nada se pide por red: en el markup de una forma no hay una sola URL", () => {
    const html = tiraDePeriodos(serie("1.000,00", "2.000,00", "3.000,00"), { rotulo: "x" }) + celdaBarra("1,00", "2,00");
    expect(html).not.toMatch(/url\(|https?:|src=/);
    expect(css).not.toMatch(/url\(|https?:/);
  });
});

// --- Dónde entra cada instancia ------------------------------------------------------------------

describe("G-1 · la composición del gasto en el informe", () => {
  const html = cuerpoInformeMensual(parsearVistaInformeMensual(informeMuestra()));

  it("dibuja una barra por grupo de gasto, y ninguna en el cuadro de ingresos", () => {
    // El fixture tiene 4 grupos de gasto y 1 de ingreso: aunque tuviera cuatro, el cuadro de ingresos
    // no lleva barras — es el descarte 6 de §I.4.
    const gastos = html.slice(html.indexOf("Gastos del período"));
    const ingresos = html.slice(html.indexOf("Ingresos del período"), html.indexOf("Gastos del período"));
    expect(veces(gastos, "g-pista")).toBe(4);
    expect(veces(ingresos, "g-pista")).toBe(0);
  });

  it("las líneas desagregadas no llevan barra: son otro nivel, con otro denominador", () => {
    expect(html).toContain('<tr class="desagregado"><td>Vigilancia contratada');
    const fila = html.slice(html.indexOf("Vigilancia contratada"));
    expect(fila.slice(0, fila.indexOf("</tr>"))).not.toContain("g-pista");
  });
});

describe("las dos tiras que quedaron, y la que no", () => {
  it("el informe dibuja la del resultado y la de la deuda, y **ninguna en los denominadores**", () => {
    // G-4, la cobranza del período, se descartó con la pieza generada delante (doc 10 §I.4,
    // descarte 9): 101,92 % a 94,05 % con el eje desde cero son cuatro columnas del mismo alto.
    const html = cuerpoInformeMensual(
      parsearVistaInformeMensual({
        ...(informeMuestra() as object),
        series: {
          resultado: { puntos: [punto("2026-03", "300.000,00"), punto("2026-04", "900.000,00"), punto("2026-05", "1.200.000,00")] },
          deudaProveedores: { puntos: [punto("2026-03", "1.200.000,00"), punto("2026-04", "1.500.000,00"), punto("2026-05", "2.000.000,00")] },
        },
      }),
    );
    expect(veces(html, 'class="g-tira"')).toBe(2);
    expect(html.slice(html.indexOf("D · Los denominadores"))).not.toContain("g-tira");
  });

  it("la serie de la cobranza ya no entra al modelo de vista, ni con `null`", () => {
    const base = informeMuestra() as Record<string, unknown>;
    expect(() =>
      parsearVistaInformeMensual({
        ...base,
        series: { resultado: null, deudaProveedores: null, cobranza: null },
      }),
    ).toThrow(/cobranza/);
  });
});

describe("G-8 · la composición del «qué cubre» en la boleta", () => {
  const html = cuerpoBoleta(vistaBoletaDeMuestra());

  it("dibuja una barra por concepto ordinario y ninguna en las otras clases", () => {
    // El fixture: cinco líneas ordinarias, una de fondo de reserva y una extraordinaria.
    expect(veces(html, "g-pista")).toBe(5);
  });

  it("la barra vive en la zona 3 y **nunca** en la 1 ni en la 2", () => {
    const zona3 = html.slice(html.indexOf('class="zona3"'));
    expect(veces(zona3, "g-pista")).toBe(5);
  });

  it("sin el total de ordinarias declarado, la boleta sale sin barras", () => {
    const vista = vistaBoletaDeMuestra();
    const sinTotal = parsearVistaBoleta({ ...vista, detalle: { ...vista.detalle, totalOrdinarias: null } });
    expect(cuerpoBoleta(sinTotal)).not.toContain("g-pista");
  });
});
