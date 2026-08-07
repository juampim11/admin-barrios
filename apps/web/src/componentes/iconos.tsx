/**
 * Los íconos del producto, en SVG inline.
 *
 * **Por qué inline y no una librería:** el presupuesto de recursos (§1 y §2.h) pide no arrastrar
 * payload que no se usa, y estas ocho formas pesan menos que el `import` de cualquier paquete de
 * íconos. Además no hay red: nada de CDN (regla del proyecto).
 *
 * **Por qué existen:** WCAG AA (doc 06 §f.2) prohíbe que el color sea el único portador de
 * información. Un chip de estado tiene que distinguirse en una captura en escala de grises, y eso
 * solo lo da la **forma**. Por eso cada estado del período tiene un ícono con silueta distinta —
 * círculo punteado, tilde, candado, sobre— y no cinco variantes del mismo círculo.
 *
 * Todos son decorativos (`aria-hidden`): **el texto que va al lado es el que se lee**. Un ícono con
 * `aria-label` acá duplicaría el anuncio del lector de pantalla.
 */

import type { SVGProps } from "react";

type Props = Omit<SVGProps<SVGSVGElement>, "children">;

/** Atributos comunes: hereda el color del texto y escala con la tipografía (`1em`). */
function base(props: Props): SVGProps<SVGSVGElement> {
  return {
    width: "1em",
    height: "1em",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
    ...props,
  };
}

/** Borrador: círculo punteado — se está armando, todavía no es nada firme. */
export function IconoBorrador(props: Props) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
    </svg>
  );
}

/** Revisada: tilde en círculo — alguien la miró y la dio por buena. */
export function IconoRevisada(props: Props) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5" />
    </svg>
  );
}

/** Emitida: candado — a partir de acá no se edita (doc 01 §4.2). */
export function IconoEmitida(props: Props) {
  return (
    <svg {...base(props)}>
      <rect x="4" y="10.5" width="16" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  );
}

/** Distribuida: sobre — salió del sistema hacia los obligados. */
export function IconoDistribuida(props: Props) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 6.5 8.5 6.5 8.5-6.5" />
    </svg>
  );
}

/** Advertencia: triángulo. Algo que no bloquea pero condiciona. */
export function IconoAlerta(props: Props) {
  return (
    <svg {...base(props)}>
      <path d="M12 3.8 2.8 19.5h18.4L12 3.8Z" />
      <path d="M12 9.8v4.2" />
      <path d="M12 17.2h.01" />
    </svg>
  );
}

/** Información neutra. */
export function IconoInfo(props: Props) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

/** Todo en orden. */
export function IconoCorrecto(props: Props) {
  return (
    <svg {...base(props)}>
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}

/** Falta algo. Se usa junto con texto: nunca es la única señal. */
export function IconoFaltante(props: Props) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6" />
      <path d="m15 9-6 6" />
    </svg>
  );
}

/** Andamio de desarrollo (pantalla de ingreso). */
export function IconoHerramienta(props: Props) {
  return (
    <svg {...base(props)}>
      <path d="M14.5 6.2a4 4 0 0 1 5.3 5.3l-8.3 8.3a2.4 2.4 0 0 1-3.4-3.4l8.3-8.3Z" />
      <path d="M4.2 4.2 8 8" />
      <path d="M8 4.2 4.2 8" />
    </svg>
  );
}

/** Barrio / conjunto. */
export function IconoBarrio(props: Props) {
  return (
    <svg {...base(props)}>
      <path d="M3 20.5h18" />
      <path d="M5 20.5V10l5-3.5 5 3.5v10.5" />
      <path d="M15 20.5V13h4v7.5" />
      <path d="M9 20.5v-4h2v4" />
    </svg>
  );
}

/** Flecha de navegación (paginado, volver). `direccion` evita duplicar el path. */
export function IconoFlecha({ direccion, ...props }: Props & { direccion: "izquierda" | "derecha" }) {
  return (
    <svg {...base(props)} style={{ transform: direccion === "izquierda" ? "rotate(180deg)" : undefined }}>
      <path d="M9 5.5 15.5 12 9 18.5" />
    </svg>
  );
}
