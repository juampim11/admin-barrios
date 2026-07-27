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

/**
 * Escala **de papel**, en puntos (doc 09 §E.5.2). Es una escala hermana de `fontSize`, no la misma:
 * los tokens de arriba están en **px** para pantalla, y `fontSize.base = 16` leído como pt daría un
 * cuerpo de texto de 5,6 mm. Misma jerarquía de nombres, otra unidad y otro destino.
 *
 * Los tamaños no salen del gusto: salen de la lectura en teléfono (§E.5.1). A4 mide 595 pt de ancho
 * y el viewport típico 390 px, así que el factor de ajuste al ancho es `printFitWidthFactor`. Con el
 * piso de legibilidad sin zoom en ~9 px, nada de la zona 1 puede bajar de `printMinLegibleZona1`.
 */
export const fontSizePrint = {
  micro: 7, // SOLO pie legal del dorso
  xs: 8, // piso duro del FRENTE
  sm: 9, // filas del detalle
  base: 10, // cuerpo
  lg: 12, // subtotales y etiquetas de zona
  xl: 14, // PISO de la capa "sin zoom" (ajuste al ancho en teléfono)
  "2xl": 18, // vencimiento e importes del bloque de pago
  // La cifra que **titula** un documento que nadie paga: el resultado del período del informe
  // mensual, el total de saldos pendientes del listado. `4xl` queda exclusivo del TOTAL A PAGAR de
  // la boleta — la única cifra del producto que alguien paga, y no hay una segunda.
  "3xl": 24,
  "4xl": 32, // TOTAL A PAGAR (boleta, y nada más)
} as const;

/** A4 (595 pt) ajustado al ancho en un teléfono de 390 px: 390 / 595 (doc 09 §E.5.1). */
export const printFitWidthFactor = 0.655;

/**
 * Piso en pt de la capa **"sin zoom"** de cualquier documento de la familia: 14 × 0,655 ≈ 9,2 px, el
 * mínimo legible sin zoom en un teléfono (doc 09 §E.5.1).
 *
 * El piso está atado al **rol**, no a una zona de la boleta: en la boleta la capa sin zoom es la
 * zona 1 (total, vencimiento); en el informe mensual son el período/corte y el resultado; en el
 * listado, el total y la fecha de corte. Todo lo demás baja libre hasta el piso general de 8 pt.
 */
export const printMinLegibleTitular = 14;

/** @deprecated Nombre viejo, atado a la zona 1 de la boleta. Usar `printMinLegibleTitular`. */
export const printMinLegibleZona1 = printMinLegibleTitular;

/**
 * Márgenes de los A4 **multipágina que se archivan** (informe mensual, listado de saldos).
 *
 * Corrige a doc 09 §E.2.2 para esta familia y sólo para ella: la boleta se queda en 14/14 porque no
 * se archiva —se corta y se entrega—, y además su código de barras necesita los 182 mm enteros. Estos
 * documentos van a una carpeta: una perforadora de dos agujeros muerde a ~12 mm del borde izquierdo,
 * y con margen de 14 los agujeros se comen la primera columna.
 *
 * **No se espejan por paridad.** Se imprimen a doble faz y ninguna cara del par vale más que la otra.
 */
export const printMargenesArchivo = { top: 12, right: 14, bottom: 12, left: 18 } as const;

/** Ancho útil de los multipágina de la familia: 210 − 18 − 14. (La boleta usa 182.) */
export const ANCHO_UTIL_ARCHIVO_MM = 178;

/**
 * Patrones de papel de la familia. Existen porque estos documentos **se fotocopian**, y ahí es donde
 * se decide si una señal sobrevive.
 */
export const printPatron = {
  /**
   * "Acá va un dato que la administración todavía no carga": fondo muy claro + subrayado punteado.
   *
   * **La primera versión era una trama a 45°** —la convención de dibujo técnico para "superficie
   * reservada a propósito"— y hubo que abandonarla por evidencia, no por gusto: en el PDF real el
   * rasterizador del motor la resolvía **como un gris sólido en unas celdas y la perdía del todo en
   * otras, en la misma hoja**. Con cualquier paso probado (1,4 mm y 2,2 mm) el resultado era el
   * mismo. Una marca que aparece en la mitad de los renglones no es una convención: es ruido, y peor
   * que no tener marca, porque sugiere que las celdas marcadas y las no marcadas dicen cosas
   * distintas.
   *
   * El fondo es `slate.100` y no un gris medio, que es lo que la trama venía a evitar: a este valor
   * la celda se lee como "reservada" y **no** como tachada o censurada, y tras una fotocopia queda
   * un recuadro tenue con su subrayado punteado — que es la parte que sobrevive con seguridad.
   */
  pendienteFondo: palette.slate[100],
  pendienteSubrayado: palette.slate[300],
  /**
   * Filete del renglón que **concluye** algo (la diferencia sin explicar), en pt. 0,8 y no 0,6:
   * después de una fotocopia, 0,4 y 0,6 son la misma línea; 0,4 y 0,8 se distinguen.
   */
  conclusionFilete: 0.8,
  /**
   * Cada cuántas filas el separador sube de `hairlineSoft` a `hairline`. Reemplaza al zebra
   * striping, que está prohibido: un fondo al 8 % fotocopiado sale sucio y al 4 % desaparece.
   */
  filaGrupoCada: 5,
} as const;

/** Alto de fila de las tablas largas de la familia, en mm. */
export const printFila = {
  simple: 5.0,
  conSegundaLinea: 8.4,
  encabezadoRepetido: 8.0,
  pieRepetido: 6.0,
} as const;

/**
 * Tintas del papel (doc 09 §E.5.3). **`textMuted` no está y no se agrega**: da ~4,6:1 sobre blanco
 * y por debajo de 10 pt, o tras una fotocopia, deja de leerse. En papel la jerarquía la hacen el
 * tamaño y el peso, no el gris.
 *
 * `instrumentoInk` es el **único hex crudo permitido del producto**: el bloque de pago se imprime en
 * negro puro sobre blanco puro porque `textPrimary` (`#0B1220`) es azulado y una impresora lo puede
 * resolver como negro compuesto (CMY), bajando el contraste del código justo lo suficiente para que
 * la caja no lo lea.
 */
export const printInk = {
  textPrimary: palette.slate[900], // ~18:1 sobre blanco
  textSecondary: palette.slate[600], // ~10,3:1 sobre blanco
  hairline: palette.slate[300], // filetes de 0,4 pt
  hairlineSoft: palette.slate[100], // separadores de fila del detalle
  paper: palette.slate[0],
  instrumentoInk: "#000000",
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
