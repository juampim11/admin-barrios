/**
 * **Los pares de color del sistema cumplen contraste. En claro y en oscuro.**
 *
 * Hasta acá el sistema de diseño *afirmaba* accesibilidad y no la verificaba en ningún lado. Al
 * medirlo entero —recién, para validar los tokens de marca nuevos— apareció que `warning` sobre
 * `warningSubtle` daba **4,46:1**: cuatro centésimas por debajo del mínimo, justo en el par para el
 * que esos dos tokens existen. Un defecto de ese tamaño no se ve a ojo y no lo iba a encontrar nadie.
 *
 * Por eso el test mide **pares declarados**, no todos contra todos: un par que nadie usa no es un
 * defecto, y un test que se queja de combinaciones imposibles se termina apagando. Cada entrada de
 * la tabla es una combinación que el sistema **usa de verdad** en alguna pantalla.
 *
 * Umbral: **4,5:1**, el mínimo de AA para texto normal. No se usa el 3:1 de texto grande ni para los
 * rótulos: la mitad de estos pares terminan en un renglón de 12 px, y afinar el umbral por pieza es
 * exactamente cómo un sistema de diseño se degrada de a poco.
 */

import { describe, expect, it } from "vitest";
import { dark, light, type Scheme } from "./semantic.ts";

/** Luminancia relativa de un `#rrggbb`, según la definición de WCAG 2.1. */
function luminancia(hex: string): number {
  const n = hex.replace("#", "");
  const canales = [0, 2, 4].map((i) => Number.parseInt(n.slice(i, i + 2), 16) / 255);
  const lineal = canales.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (lineal[0] ?? 0) + 0.7152 * (lineal[1] ?? 0) + 0.0722 * (lineal[2] ?? 0);
}

/** Relación de contraste entre dos colores, de 1 (idénticos) a 21 (blanco contra negro). */
export function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)];
  const [alto, bajo] = x > y ? [x, y] : [y, x];
  return (alto + 0.05) / (bajo + 0.05);
}

const MINIMO_AA = 4.5;

/** Cada par es `[qué se pinta, sobre qué, por qué existe]`. */
const PARES: readonly (readonly [keyof Scheme & string, keyof Scheme & string, string])[] = [
  ["textPrimary", "bg", "el texto de cualquier pantalla"],
  ["textPrimary", "surface", "el texto adentro de una tarjeta"],
  ["textSecondary", "surface", "bajadas y aclaraciones"],
  ["textMuted", "surface", "rótulos y textos de apoyo"],
  ["primaryHover", "primarySubtle", "un chip o una etiqueta en el color de marca"],
  ["warning", "warningSubtle", "la banda de advertencia — el par que estaba por debajo"],
  ["danger", "dangerSubtle", "el aviso de error"],
  ["success", "successSubtle", "el estado al día"],
  ["info", "infoSubtle", "el aviso informativo"],
  // Los tokens de marca: el panel de la pantalla de entrada es medio monitor de color plano.
  ["marcaSuperficieFg", "marcaSuperficie", "el título sobre el panel de marca"],
  ["marcaSuperficieFgTenue", "marcaSuperficie", "el segundo nivel de texto del panel de marca"],
];

describe.each([
  ["claro", light],
  ["oscuro", dark],
])("los pares de color cumplen contraste AA — esquema %s", (_nombre, esquema) => {
  it.each(PARES)("%s sobre %s (%s)", (frente, fondo, _porque) => {
    const valorFrente = esquema[frente];
    const valorFondo = esquema[fondo];
    expect(typeof valorFrente).toBe("string");
    expect(typeof valorFondo).toBe("string");
    expect(contraste(valorFrente as string, valorFondo as string)).toBeGreaterThanOrEqual(MINIMO_AA);
  });
});

/*
 * ⚠ **DEUDA MEDIDA, NO IGNORADA: el texto de un botón primario da 3,74:1 y el mínimo es 4,5.**
 *
 * Salió de correr esta misma medición por primera vez. **No se arregla acá**, y el motivo no es
 * pereza: `primary` es el teal de la dirección visual "Verdemar", ratificada por el usuario, y
 * oscurecerlo cambia **todos los botones de la aplicación**. Es una decisión de identidad visual, no
 * de accesibilidad, y se toma con el usuario mirando la pantalla — no adentro de un test.
 *
 * Dato para cuando se decida: `primaryHover` (#0F766E), que **ya está en la paleta**, da 5,47 con
 * blanco. O sea que el arreglo probablemente sea correr la escala un escalón, no inventar un color.
 *
 * Mientras tanto, este test hace lo único que corresponde: **clava el valor medido**, así el defecto
 * no puede empeorar en silencio ni desaparecer del radar. Si alguien mejora el color, el test falla
 * y obliga a venir a borrar esta deuda — que es exactamente lo que tiene que pasar.
 */
describe("deuda conocida: el botón primario no llega al mínimo de contraste", () => {
  it("está medido, y no puede empeorar sin que el gate lo diga", () => {
    const medido = contraste(light.primaryFg, light.primary);
    expect(medido).toBeLessThan(MINIMO_AA); // ← si esto falla, alguien lo arregló: borrar esta deuda
    expect(medido).toBeGreaterThanOrEqual(3.7); // ← si esto falla, alguien lo empeoró
  });

  it("en oscuro sí cumple, así que la deuda es solo del esquema claro", () => {
    expect(contraste(dark.primaryFg, dark.primary)).toBeGreaterThanOrEqual(MINIMO_AA);
  });
});

describe("por qué `marcaSuperficie` existe y no alcanzaba con `primary`", () => {
  /*
   * Este test no cuida un color: cuida una decisión, y falla si alguien la deshace. `primary` está
   * calibrado como **tinta**, no como superficie. Si un día alguien "simplifica" pintando el panel de
   * marca con `primary`, esta afirmación deja de ser cierta y hay que venir a leer el porqué.
   */
  it("el primario NO sirve de fondo para texto: por eso hizo falta un token propio", () => {
    expect(contraste(light.primaryFg, light.primary)).toBeLessThan(MINIMO_AA);
    expect(contraste(light.marcaSuperficieFg, light.marcaSuperficie)).toBeGreaterThanOrEqual(MINIMO_AA);
  });

  it("en oscuro la superficie de marca es tenue, no el primario menta", () => {
    // Un panel entero del primario oscuro (menta clara) proyectado en una demo encandila. La
    // superficie de marca oscura es el subtle, y sobre ella el texto va claro.
    expect(luminancia(dark.marcaSuperficie)).toBeLessThan(luminancia(dark.primary));
  });
});
