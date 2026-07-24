/**
 * admin-barrios — design tokens (primitivos)
 *
 * Dirección visual "Verdemar" (ELEGIDA — Fase 6B, revisión). Ver `docs/diseno/06-direccion-visual.md`.
 * Objetos TS planos = única fuente de verdad. Alimentan web (CSS vars vía generador) y mobile
 * (StyleSheet vía theme.ts). Los tokens SEMÁNTICOS por modo (light/dark) viven en `./semantic.ts`;
 * el acento por barrio en `./barrio-accent.ts`.
 *
 * Regla dura (ADR-0000 §2.1 + doc 06 §g): ninguna pantalla usa hex/px sueltos — si falta un valor,
 * primero se agrega acá (con su par light/dark validado por contraste), después se usa.
 */

// --- Paleta primitiva (marca + acento; los semánticos completos están en semantic.ts) ---
export const palette = {
  teal: { 50: "#ECFDF9", 500: "#14B8A6", 600: "#0D9488", 700: "#0F766E" }, // marca
  amber: { 400: "#FBBF24", 500: "#F59E0B" }, // acento cálido
  slate: {
    0: "#FFFFFF",
    50: "#F4F7F9",
    100: "#EAF0F6",
    200: "#E3E8EE",
    300: "#C9D2DC",
    500: "#6B7686",
    600: "#3A4657",
    900: "#0B1220",
  },
} as const;

// --- Tipografía (decidido: Geist principal; Geist Mono + tabular-nums para toda cifra de dinero) ---
export const font = {
  sans: "Geist, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  // Dinero: SIEMPRE consumido con fontVariantNumeric: 'tabular-nums' (requisito del proyecto).
  numeric: "'Geist Mono', ui-monospace, monospace",
  mono: "'Geist Mono', ui-monospace, monospace",
} as const;

export const fontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  "2xl": 24,
  "3xl": 30,
  "4xl": 36,
} as const;

export const fontWeight = { regular: 400, medium: 500, semibold: 600, bold: 700 } as const;
export const lineHeight = { tight: 1.2, snug: 1.35, normal: 1.55 } as const;

/** `tabular-nums` obligatorio en toda columna/cifra de dinero (montos, saldos, totales, KPIs). */
export const numericFeatures = { fontFamily: font.numeric, fontVariantNumeric: "tabular-nums" } as const;

// --- Espaciado (base-4, px). En web se sirve en rem; en mobile como números. ---
export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 24,
  xl: 32,
  "2xl": 48,
  "3xl": 64,
} as const;

export const radius = { none: 0, sm: 6, md: 10, lg: 14, xl: 20, pill: 999 } as const;

// --- Sombras (look moderno, suave). Variante por modo. ---
export const shadow = {
  sm: "0 1px 2px rgba(11,18,32,.06)",
  md: "0 4px 12px rgba(11,18,32,.08)",
  lg: "0 12px 32px rgba(11,18,32,.12)",
  focus: "0 0 0 3px rgba(13,148,136,.45)", // anillo de foco = primario Verdemar
} as const;

export const shadowDark = {
  sm: "0 1px 2px rgba(0,0,0,.40)",
  md: "0 4px 12px rgba(0,0,0,.48)",
  lg: "0 12px 32px rgba(0,0,0,.55)",
  focus: "0 0 0 3px rgba(45,212,191,.55)",
} as const;
