/**
 * Generador de variables CSS a partir de los tokens (ADR-0000 §2.1, doc 06 §g).
 *
 * Los tokens TS son la ÚNICA fuente de verdad: este módulo los vuelca a `:root { --bg: … }` para que
 * los CSS Modules de la web usen `var(--bg)`. Mobile consume los mismos objetos sin pasar por acá.
 * El archivo resultante se genera (no se edita a mano): `pnpm tokens:css`.
 */

import { font, fontSize, fontWeight, lineHeight, radius, shadow, shadowDark, spacing } from "./tokens.ts";
import { dark, light, type Scheme } from "./semantic.ts";

const aKebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();

/** Aplana un objeto de tokens a pares `--nombre: valor`, prefijando las claves anidadas. */
function aplanar(obj: Record<string, unknown>, prefijo = ""): Array<[string, string]> {
  const salida: Array<[string, string]> = [];
  for (const [clave, valor] of Object.entries(obj)) {
    const nombre = prefijo ? `${prefijo}-${aKebab(clave)}` : aKebab(clave);
    if (valor && typeof valor === "object") {
      salida.push(...aplanar(valor as Record<string, unknown>, nombre));
    } else if (typeof valor === "number") {
      // px → rem para respetar el tamaño de fuente del sistema (accesibilidad, doc 06 §f).
      salida.push([nombre, nombre.startsWith("line-height") || nombre.startsWith("font-weight") ? String(valor) : `${valor / 16}rem`]);
    } else {
      salida.push([nombre, String(valor)]);
    }
  }
  return salida;
}

const bloque = (pares: Array<[string, string]>, sangria = "  "): string =>
  pares.map(([n, v]) => `${sangria}--${n}: ${v};`).join("\n");

/** Variables semánticas de un modo (light/dark). */
export function varsDeScheme(scheme: Scheme): Array<[string, string]> {
  return aplanar(scheme as unknown as Record<string, unknown>);
}

/** Variables primitivas (no dependen del modo, salvo las sombras). */
export function varsPrimitivas(): Array<[string, string]> {
  return [
    ...aplanar({ font } as Record<string, unknown>),
    ...aplanar({ fontSize } as Record<string, unknown>),
    ...aplanar({ fontWeight } as Record<string, unknown>),
    ...aplanar({ lineHeight } as Record<string, unknown>),
    ...aplanar({ space: spacing } as Record<string, unknown>),
    ...aplanar({ radius } as Record<string, unknown>),
  ];
}

/**
 * CSS completo: light por defecto, dark por `prefers-color-scheme` **y** por `[data-theme]`
 * (el selector manual de tema tiene que poder ganarle a la preferencia del sistema, en ambos sentidos).
 */
export function generarCssVars(): string {
  return `/* ARCHIVO GENERADO por @admin-barrios/design-tokens (pnpm tokens:css). No editar a mano. */

:root {
  color-scheme: light dark;
${bloque(varsPrimitivas())}
${bloque(varsDeScheme(light))}
${bloque(aplanar({ shadow } as Record<string, unknown>))}
}

@media (prefers-color-scheme: dark) {
  :root {
${bloque(varsDeScheme(dark), "    ")}
${bloque(aplanar({ shadow: shadowDark } as Record<string, unknown>), "    ")}
  }
}

:root[data-theme="light"] {
${bloque(varsDeScheme(light))}
${bloque(aplanar({ shadow } as Record<string, unknown>))}
}

:root[data-theme="dark"] {
${bloque(varsDeScheme(dark))}
${bloque(aplanar({ shadow: shadowDark } as Record<string, unknown>))}
}
`;
}
