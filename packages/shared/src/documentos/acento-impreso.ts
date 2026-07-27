/**
 * El color de acento del barrio, listo para el papel (doc 09 §E.9.3).
 *
 * Dos problemas concretos que resuelve, y ninguno es estético:
 *
 *  1. **El color lo elige el cliente y va a elegir mal.** Un `#FFFF00` da 1,07:1 contra el papel
 *     blanco: la franja superior se lee como un error de impresión, y el nombre del barrio en
 *     blanco encima directamente no se lee. Se conservan matiz y saturación y se baja la
 *     luminosidad hasta 4,5:1 — el cliente elige el matiz, la legibilidad la fija el sistema.
 *  2. **`hsl()` moderno no lo parsea el motor.** `barrio-accent.ts` devuelve `hsl(H S% L%)`, que es
 *     la sintaxis de pantalla; en el documento todo color viaja como `#rrggbb`.
 *
 * Un solo umbral cubre los dos usos: como el contraste es simétrico, exigir **≥ 4,5:1 contra
 * blanco** garantiza a la vez la franja (que solo necesitaría 3:1) y el texto blanco encima.
 */

/** Gris neutro cuando el barrio no declaró color. **Nunca cae a la marca del producto** (§E.9.3). */
export const ACENTO_NEUTRO = "#3a4657";

/** Piso de contraste contra el papel blanco. */
export const CONTRASTE_MINIMO = 4.5;

type Rgb = readonly [number, number, number];

function aRgb(hex: string): Rgb {
  const limpio = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(limpio)) throw new Error(`color inválido: ${hex} (esperado #rrggbb)`);
  return [
    Number.parseInt(limpio.slice(0, 2), 16),
    Number.parseInt(limpio.slice(2, 4), 16),
    Number.parseInt(limpio.slice(4, 6), 16),
  ];
}

function aHex([r, g, b]: Rgb): string {
  const dosDigitos = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  return `#${dosDigitos(r)}${dosDigitos(g)}${dosDigitos(b)}`;
}

/** Luminancia relativa WCAG 2.x. */
function luminancia([r, g, b]: Rgb): number {
  const canal = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

/** Contraste del color contra el papel blanco (`#ffffff`). */
export function contrasteContraBlanco(hex: string): number {
  return 1.05 / (luminancia(aRgb(hex)) + 0.05);
}

function aHsl([r, g, b]: Rgb): { h: number; s: number; l: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0)) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function deHsl(h: number, s: number, l: number): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const canal = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const hn = h / 360;
  return [canal(hn + 1 / 3) * 255, canal(hn) * 255, canal(hn - 1 / 3) * 255];
}

/**
 * Devuelve el acento tal como se imprime.
 *
 * - `null` (el barrio no declaró color) → gris neutro. **No se inventa la marca del producto.**
 * - contraste ≥ 4,5:1 → se usa **tal cual**: es la marca del cliente, no se toca sin necesidad.
 * - contraste < 4,5:1 → se conservan H y S y se baja L hasta alcanzar el piso.
 *
 * **No rechaza ningún color**: rechazar la marca de un cliente es una conversación que no se gana.
 */
export function acentoImpreso(hexDeclarado: string | null): string {
  if (hexDeclarado === null) return ACENTO_NEUTRO;
  const rgb = aRgb(hexDeclarado);
  const normalizado = aHex(rgb);
  if (contrasteContraBlanco(normalizado) >= CONTRASTE_MINIMO) return normalizado;

  const { h, s } = aHsl(rgb);
  // Búsqueda binaria sobre la luminosidad: monótona (menos L ⇒ más contraste contra blanco).
  let bajo = 0;
  let alto = aHsl(rgb).l;
  for (let i = 0; i < 24; i++) {
    const medio = (bajo + alto) / 2;
    if (contrasteContraBlanco(aHex(deHsl(h, s, medio))) >= CONTRASTE_MINIMO) bajo = medio;
    else alto = medio;
  }
  const candidato = aHex(deHsl(h, s, bajo));
  // Defensa en profundidad: si el redondeo a 8 bits dejó el color un pelo por debajo del piso, se
  // devuelve el neutro antes que un acento que no cumple lo que este módulo promete.
  return contrasteContraBlanco(candidato) >= CONTRASTE_MINIMO ? candidato : ACENTO_NEUTRO;
}
