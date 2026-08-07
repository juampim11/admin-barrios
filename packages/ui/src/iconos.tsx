import type { SVGProps } from "react";

type Props = Omit<SVGProps<SVGSVGElement>, "children">;

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

export function IconoChevron(props: Props) {
  return (
    <svg {...base(props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function IconoCheck(props: Props) {
  return (
    <svg {...base(props)}>
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}

export function IconoFlecha({ direccion, ...props }: Props & { readonly direccion: "izquierda" | "derecha" }) {
  return (
    <svg {...base(props)}>
      {direccion === "izquierda" ? (
        <>
          <path d="M19 12H5" />
          <path d="m11 18-6-6 6-6" />
        </>
      ) : (
        <>
          <path d="M5 12h14" />
          <path d="m13 6 6 6-6 6" />
        </>
      )}
    </svg>
  );
}

export function IconoTablero(props: Props) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="3" width="7" height="8" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="3" y="15" width="7" height="6" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
    </svg>
  );
}

export function IconoPadron(props: Props) {
  return (
    <svg {...base(props)}>
      <path d="M4 20v-1.5A3.5 3.5 0 0 1 7.5 15h2A3.5 3.5 0 0 1 13 18.5V20" />
      <circle cx="8.5" cy="8.5" r="3" />
      <path d="M16 20v-1.2a3.3 3.3 0 0 0-2.2-3.1" />
      <path d="M15.5 5.6a3 3 0 0 1 0 5.8" />
    </svg>
  );
}

export function IconoLiquidacion(props: Props) {
  return (
    <svg {...base(props)}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M14 3v5h5" />
      <path d="M9.5 12.5h5" />
      <path d="M9.5 16.5h3" />
    </svg>
  );
}

export function IconoMas(props: Props) {
  return (
    <svg {...base(props)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

/**
 * Círculo con signo de admiración: **contexto**, no fallo.
 *
 * Es el que acompaña a la declaración de entorno de la pantalla de entrada. Va con el trazo del
 * sistema y no con un glifo tipográfico a propósito: un `ⓘ` sale de la fuente y cambia de forma —o
 * desaparece— según qué familia resuelva el navegador.
 */
export function IconoInfo(props: Props) {
  return (
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 7.2v5.6" />
      <path d="M12 16.6v.1" />
    </svg>
  );
}

/**
 * El isotipo del producto: un techo sobre una planta con puerta.
 *
 * Es la marca de `admin-barrios`, **no** la de ningún barrio administrado — en la pantalla de entrada
 * todavía no se sabe de cuál se trata, y ponerlo sería exactamente el error que ADR-0001 §1 prohíbe.
 * Hereda `currentColor`, así que sirve tanto sobre el panel de marca como sobre fondo claro.
 */
export function Isotipo(props: Props) {
  return (
    <svg {...base({ viewBox: "0 0 30 30", strokeWidth: 2.1, ...props })}>
      <path d="M4 13.5 15 5l11 8.5" />
      <path d="M7 13v12h16V13" />
      <path d="M12 25v-6h6v6" />
    </svg>
  );
}

export function IconoHerramienta(props: Props) {
  return (
    <svg {...base(props)}>
      <path d="M14.5 6.2a4 4 0 0 1 5.3 5.3l-8.3 8.3a2.4 2.4 0 0 1-3.4-3.4l8.3-8.3Z" />
      <path d="M4.2 4.2 8 8" />
      <path d="M8 4.2 4.2 8" />
    </svg>
  );
}
