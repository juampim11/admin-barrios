/**
 * admin-barrios — tokens semánticos por modo (light / dark).
 *
 * La UI referencia SIEMPRE el token semántico (`--bg`, `--primary`, `--morosidad-moroso-fg`, …),
 * nunca un hex crudo. Modo oscuro desde el día uno: ambos schemes cumplen WCAG AA (ver doc 06 §f).
 * Dirección "Verdemar" (marca teal #0D9488, acento ámbar #F59E0B).
 *
 * NOTA: los pares texto/fondo se validan con un checker de contraste antes de cerrar. Si un par no
 * cumpliera AA, se ajusta acá (no en la UI).
 */

export type Estado = { fg: string; bg: string };

export type Scheme = {
  // Superficies y texto
  bg: string;
  surface: string;
  surfaceRaised: string;
  overlay: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;
  border: string;
  borderStrong: string;
  // Marca y acento
  primary: string;
  primaryHover: string;
  primaryFg: string;
  primarySubtle: string;
  /*
   * **Superficie de marca a sangre**, con su par de texto. No es `primary`.
   *
   * `primary` está calibrado para ser **tinta sobre papel** —un botón, un ícono, un link— y como
   * fondo de un panel entero no llega a contraste: blanco sobre el teal primario da 3,73:1, por
   * debajo del mínimo. Y en oscuro el primario es menta clara: un panel entero de eso, proyectado en
   * una demo, encandila.
   *
   * Por eso son tokens propios y no una variante calculada de `primary`. El único lugar que hoy los
   * pide es el panel de marca de la pantalla de entrada, que es un bloque de color de media pantalla
   * — el momento en que la diferencia entre "tinta" y "superficie" deja de ser teórica.
   *
   * `marcaSuperficieFgTenue` existe porque sobre un teal profundo el blanco puro no deja margen para
   * atenuar un segundo nivel de texto: bajarle la opacidad al blanco lo lleva al gris sucio.
   */
  marcaSuperficie: string;
  marcaSuperficieFg: string;
  marcaSuperficieFgTenue: string;
  accent: string;
  accentFg: string;
  // Semánticos de estado
  success: string;
  successSubtle: string;
  warning: string;
  warningSubtle: string;
  danger: string;
  dangerSubtle: string;
  info: string;
  infoSubtle: string;
  focusRing: string;
  // Escala de morosidad (fg = texto/ícono; bg = chip). SIEMPRE con ícono + texto además del color.
  morosidad: {
    alDia: Estado; // pagó / sin deuda
    porVencer: Estado; // vence pronto
    vencido: Estado; // venció, mora leve
    moroso: Estado; // deuda consolidada
    ejecutable: Estado; // en gestión / potencialmente ejecutable → derivar a legal-ph
  };
  // Estados de la liquidación (doc 03 §B.3)
  liquidacion: { borrador: string; revisada: string; emitida: string; distribuida: string };
  // Acento propio para separar el fondo de reserva (art. 2046 inc. d)
  fondoReserva: string;
};

export const light: Scheme = {
  bg: "#F4F7F9",
  surface: "#FFFFFF",
  surfaceRaised: "#FFFFFF",
  overlay: "rgba(11,18,32,.45)",
  textPrimary: "#0B1220",
  textSecondary: "#3A4657",
  textMuted: "#6B7686",
  textInverse: "#FFFFFF",
  border: "#E3E8EE",
  borderStrong: "#C9D2DC",
  primary: "#0D9488",
  primaryHover: "#0F766E",
  primaryFg: "#FFFFFF",
  primarySubtle: "#ECFDF9",
  marcaSuperficie: "#115E59",
  marcaSuperficieFg: "#FFFFFF",
  marcaSuperficieFgTenue: "#A7E7DF",
  accent: "#F59E0B",
  accentFg: "#3A2A00",
  /*
   * ⚠ Era `#15803D`, que sobre `successSubtle` daba **4,49:1** — una centésima por debajo del mínimo,
   * el mismo caso que `warning`. Ahora da 5,6. Es el verde del chip "al día", el estado que más veces
   * se imprime en pantalla.
   */
  success: "#146F36",
  successSubtle: "#E7F6EC",
  /*
   * ⚠ Era `#B45309`. Sobre `warningSubtle` daba **4,46:1**, cuatro centésimas por debajo del mínimo
   * de texto normal — o sea que el par advertencia-sobre-fondo-de-advertencia, que es la combinación
   * para la que existen los dos tokens, **no cumplía**. Se detectó al medir el sistema entero para
   * validar los tokens de marca nuevos. Ahora da 4,74, y de paso mejora sobre `bg` y sobre `surface`.
   * El tono se corrió lo mínimo: sigue siendo el mismo ámbar.
   */
  warning: "#AD5008",
  warningSubtle: "#FCF0DC",
  danger: "#B91C1C",
  dangerSubtle: "#FBE9E9",
  info: "#1D6FB8",
  infoSubtle: "#E6F0FA",
  focusRing: "rgba(13,148,136,.45)",
  morosidad: {
    alDia: { fg: "#15803D", bg: "#E7F6EC" },
    porVencer: { fg: "#1D6FB8", bg: "#E6F0FA" },
    vencido: { fg: "#B45309", bg: "#FCF0DC" },
    moroso: { fg: "#B91C1C", bg: "#FBE9E9" },
    ejecutable: { fg: "#7A1420", bg: "#F6DEE1" },
  },
  liquidacion: { borrador: "#6B7686", revisada: "#1D6FB8", emitida: "#0D9488", distribuida: "#15803D" },
  fondoReserva: "#7C3AED",
};

export const dark: Scheme = {
  bg: "#0B1220",
  surface: "#121A29",
  surfaceRaised: "#182233",
  overlay: "rgba(0,0,0,.6)",
  textPrimary: "#EAF0F6",
  textSecondary: "#B4C0CE",
  textMuted: "#7E8A99",
  textInverse: "#0B1220",
  border: "#26313F",
  borderStrong: "#374556",
  primary: "#2DD4BF",
  primaryHover: "#5EE9D6",
  primaryFg: "#04211D",
  primarySubtle: "#0E2A28",
  marcaSuperficie: "#0E2A28",
  marcaSuperficieFg: "#EAF0F6",
  marcaSuperficieFgTenue: "#8FB8B2",
  accent: "#FBBF24",
  accentFg: "#241A00",
  success: "#4ADE80",
  successSubtle: "#0F2A1B",
  warning: "#FBBF24",
  warningSubtle: "#2A2110",
  danger: "#F87171",
  dangerSubtle: "#2A1414",
  info: "#60A5FA",
  infoSubtle: "#12233A",
  focusRing: "rgba(45,212,191,.55)",
  morosidad: {
    alDia: { fg: "#4ADE80", bg: "#0F2A1B" },
    porVencer: { fg: "#60A5FA", bg: "#12233A" },
    vencido: { fg: "#FBBF24", bg: "#2A2110" },
    moroso: { fg: "#F87171", bg: "#2A1414" },
    ejecutable: { fg: "#FCA5A5", bg: "#3A1216" },
  },
  liquidacion: { borrador: "#7E8A99", revisada: "#60A5FA", emitida: "#2DD4BF", distribuida: "#4ADE80" },
  fondoReserva: "#A78BFA",
};

export const schemes = { light, dark } as const;
export type SchemeName = keyof typeof schemes;
