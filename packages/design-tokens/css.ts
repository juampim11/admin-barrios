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

/**
 * Sink de Tailwind v4 para `packages/ui`.
 *
 * Los valores especificos referencian variables CSS ya emitidas por `generarCssVars()`. La unica
 * excepcion deliberada es el apagado de familias default (`initial`): sin eso, `bg-red-500` vuelve
 * a introducir una paleta paralela.
 */
export function generarTailwindTheme(): string {
  const colores = [
    "bg",
    "surface",
    "surface-raised",
    "text-primary",
    "text-secondary",
    "text-muted",
    "text-inverse",
    "border",
    "border-strong",
    "primary",
    "primary-hover",
    "primary-fg",
    "primary-subtle",
    "accent",
    "accent-fg",
    "success",
    "success-subtle",
    "warning",
    "warning-subtle",
    "danger",
    "danger-subtle",
    "info",
    "info-subtle",
    "focus-ring",
    "marca-aa",
  ] as const;

  const espacios = ["none", "xs", "sm", "md", "base", "lg", "xl", "2xl", "3xl"] as const;
  const radios = ["none", "sm", "md", "lg", "xl", "pill"] as const;
  const pesos = ["regular", "medium", "semibold", "bold"] as const;
  const tamanios = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl"] as const;
  const lineas = ["tight", "snug", "normal"] as const;
  const sombras = ["sm", "md", "lg", "focus"] as const;

  return `/* ARCHIVO GENERADO por @admin-barrios/design-tokens (pnpm tokens:css). No editar a mano. */

@theme {
  --color-*: initial;
  --font-*: initial;
  --breakpoint-*: initial;
${colores.map((c) => `  --color-${c}: var(--${c});`).join("\n")}
  --font-ab-sans: var(--font-sans);
  --font-ab-numeric: var(--font-numeric);
  --font-ab-mono: var(--font-mono);
${espacios.map((s) => `  --spacing-${s}: var(--space-${s});`).join("\n")}
${radios.map((r) => `  --radius-${r}: var(--radius-${r});`).join("\n")}
${pesos.map((p) => `  --font-weight-${p}: var(--font-weight-${p});`).join("\n")}
${tamanios.map((s) => `  --text-${s}: var(--font-size-${s});`).join("\n")}
${lineas.map((l) => `  --leading-${l}: var(--line-height-${l});`).join("\n")}
${sombras.map((s) => `  --shadow-${s}: var(--shadow-${s});`).join("\n")}
}
`;
}
