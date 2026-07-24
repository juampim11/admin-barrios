/**
 * admin-barrios — acento por barrio (identidad de tenant).
 *
 * Refuerzo VISUAL del barrio activo (aislamiento multi-tenant). Ver doc 06 §b.5 y §c.5.
 *
 * Regla de uso (aprobada, revisión 6B) — sutil y acotado:
 *  - Se aplica SOLO a la línea/borde del selector de barrio y a un tinte leve del header.
 *  - NUNCA en botones, CTAs, links de acción, chips de estado ni data-viz.
 *  - NUNCA reemplaza la marca (teal) ni los colores semánticos.
 *  - Contraste AA garantizado (S/L fijas por modo; solo varía el hue).
 *
 * El hue se restringe a una banda que EXCLUYE los matices de la marca y de los semánticos:
 *   rojo (~0/360°, mora/peligro) · ámbar (~38°, alerta/acento) · verde (~140°, éxito) ·
 *   teal (~173°, marca) · info (~210°). Banda permitida: 230°–335° (azul-violeta → magenta → rosa).
 */

/** Banda de matiz permitida (grados), lejos de marca y semánticos. */
export const BANDA_PERMITIDA: readonly [number, number] = [230, 335];

/** Hash determinístico y estable (FNV-1a, 32-bit) — mismo `id` ⇒ mismo color, siempre. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Matiz estable del barrio, dentro de la banda segura. */
export function hueDeBarrio(id: string): number {
  const [lo, hi] = BANDA_PERMITIDA;
  return lo + (fnv1a(id) % (hi - lo));
}

/**
 * Color de acento del barrio. S y L fijas por modo ⇒ contraste predecible y AA contra el header;
 * solo el hue cambia por barrio.
 */
export function acentoBarrio(id: string, mode: "light" | "dark"): string {
  const h = hueDeBarrio(id);
  const s = mode === "dark" ? 55 : 60;
  const l = mode === "dark" ? 62 : 42;
  return `hsl(${h} ${s}% ${l}%)`;
}
