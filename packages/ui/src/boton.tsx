/**
 * El botón del sistema (pieza 12 del inventario de ADR-0003 §4).
 *
 * **Es un componente de servidor.** No tiene estado, no escucha eventos: o es un `<button>` que
 * envía un formulario, o es un `<a>` que navega. Las pantallas de lectura siguen costando cero
 * JavaScript (ADR-0003 §1.2), y el teclado funciona porque son los elementos nativos.
 *
 * **Por qué `<a>` y no `next/link`:** el kit no puede alcanzar Next (cerrojo UI-2 del gate). No es
 * una limitación que se sufra: estas pantallas se renderizan enteras en el servidor, así que una
 * navegación dura y una blanda muestran lo mismo. Si alguna pantalla necesitara la transición
 * cliente, envuelve el botón desde `apps/web` — no se rompe el cerrojo por comodidad.
 */

import type { ReactNode } from "react";

/**
 * `primario` es la acción de la pantalla —hay **una** por vista—; `secundario` acompaña;
 * `sutil` es para lo que no compite (volver, cancelar, ver detalle); `peligro` es destructivo y se
 * reserva para lo que no tiene deshacer.
 */
export type VarianteBoton = "primario" | "secundario" | "sutil" | "peligro";

/** `base` es el objetivo táctil de 44px (doc 06 §f.6). `sm` solo donde hay varios controles juntos. */
export type TamanoBoton = "base" | "sm";

const VARIANTE: Record<VarianteBoton, string> = {
  /**
   * El fondo es `marca-aa` —o sea `--primary-hover`— y **no** `--primary`, que es la trampa que este
   * proyecto ya pagó una vez y dejó escrita en `globals.css`: `--primary` (#0D9488) da **3,73:1**
   * sobre blanco. Alcanza para un borde o un ícono (componentes de UI, piso 3:1) pero **no** como
   * fondo de un botón con texto blanco encima, que es la misma cuenta al revés. `--primary-hover`
   * da 5,48:1 y ya es un token: esto no agrega un color nuevo (doc 06 §g.2).
   *
   * Es exactamente lo que hace `.botonPrimario` del kit de formularios. Se copia la decisión a
   * propósito: dos botones primarios con distinto criterio de contraste es peor que uno solo.
   */
  primario: "border-marca-aa bg-marca-aa text-primary-fg hover:bg-primary hover:border-primary",
  secundario: "border-border-strong bg-surface text-text-primary hover:border-primary hover:text-marca-aa",
  sutil: "border-transparent bg-transparent text-marca-aa hover:bg-primary-subtle",
  peligro: "border-danger bg-danger-subtle text-text-primary hover:border-danger hover:bg-danger/15",
};

const TAMANO: Record<TamanoBoton, string> = {
  base: "min-h-control-base px-base text-sm",
  sm: "min-h-control-sm px-sm text-xs",
};

/**
 * El foco se pinta con `focus-visible` y **nunca** se apaga: es la regla f.3 de doc 06, y con
 * `outline` (no `box-shadow`) para que sobreviva al modo de alto contraste de Windows.
 */
const BASE = [
  "inline-flex items-center justify-center gap-xs whitespace-nowrap rounded-sm border",
  "font-medium leading-snug no-underline transition-colors",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
].join(" ");

/**
 * Las clases de un botón, sin el elemento.
 *
 * Existe para que la variante de cliente (`@admin-barrios/ui/cliente/boton-de-accion`) sea el mismo
 * botón y no uno parecido: un `onClick` no puede vivir en un componente de servidor, pero tampoco
 * justifica un segundo juego de estilos que se despinte con el tiempo. Un solo lugar decide cómo se
 * ve un botón; hay dos lugares que lo renderizan, por la frontera servidor/cliente y por nada más.
 */
export function clasesDeBoton({
  variante = "secundario",
  tamano = "base",
  anchoCompleto,
  deshabilitado,
}: {
  // Con `exactOptionalPropertyTypes` el `| undefined` es necesario: quien llama viene de props ya
  // desestructuradas, donde "no lo pasaron" es un `undefined` real y no una propiedad ausente.
  readonly variante?: VarianteBoton | undefined;
  readonly tamano?: TamanoBoton | undefined;
  readonly anchoCompleto?: boolean | undefined;
  readonly deshabilitado?: boolean | undefined;
}): string {
  return [
    BASE,
    VARIANTE[variante],
    TAMANO[tamano],
    anchoCompleto ? "w-full" : "",
    deshabilitado ? "cursor-not-allowed opacity-60" : "cursor-pointer",
  ]
    .filter(Boolean)
    .join(" ");
}

export function Boton({
  variante = "secundario",
  tamano = "base",
  href,
  tipo = "button",
  icono,
  iconoAlFinal,
  anchoCompleto,
  nombre,
  valor,
  deshabilitado,
  etiqueta,
  rel,
  children,
}: {
  readonly variante?: VarianteBoton;
  readonly tamano?: TamanoBoton;
  /** Con `href` el botón es un enlace. Sin él, es un `<button>`. */
  readonly href?: string;
  readonly tipo?: "button" | "submit";
  readonly icono?: ReactNode;
  readonly iconoAlFinal?: ReactNode;
  readonly anchoCompleto?: boolean;
  readonly nombre?: string;
  readonly valor?: string;
  /**
   * **Solo para un envío en vuelo.** Nunca para permisos: a un rol que no puede hacer algo no se le
   * muestra el botón apagado, no se le muestra el botón (doc 06 §c.6.4). Un botón deshabilitado es
   * una promesa que la pantalla no puede cumplir y que además no explica quién sí puede.
   */
  readonly deshabilitado?: boolean;
  /** Para cuando el texto visible no alcanza como nombre accesible. */
  readonly etiqueta?: string;
  readonly rel?: string;
  readonly children: ReactNode;
}) {
  const clase = clasesDeBoton({ variante, tamano, anchoCompleto, deshabilitado });

  const contenido = (
    <>
      {icono ? (
        <span className="shrink-0 text-[1.1em]" aria-hidden>
          {icono}
        </span>
      ) : null}
      {children}
      {iconoAlFinal ? (
        <span className="shrink-0 text-[1.1em]" aria-hidden>
          {iconoAlFinal}
        </span>
      ) : null}
    </>
  );

  // Un enlace no se puede "deshabilitar": un `<a href>` con opacidad al 60 % parece apagado y
  // navega igual. Si no se puede ir, no hay enlace — se dibuja el texto y se acabó, que es la misma
  // regla de doc 06 §c.6.4 aplicada a la navegación.
  if (href !== undefined && !deshabilitado) {
    return (
      <a href={href} className={clase} aria-label={etiqueta} rel={rel}>
        {contenido}
      </a>
    );
  }
  if (href !== undefined) {
    return (
      <span className={clase} aria-disabled="true" aria-label={etiqueta}>
        {contenido}
      </span>
    );
  }

  return (
    <button
      type={tipo}
      className={clase}
      name={nombre}
      value={valor}
      disabled={deshabilitado}
      aria-label={etiqueta}
    >
      {contenido}
    </button>
  );
}

/** Una fila de botones que envuelve bien en pantallas angostas (doc 06 §e.7). */
export function BarraDeAcciones({
  alineacion = "izquierda",
  children,
}: {
  readonly alineacion?: "izquierda" | "derecha" | "entre";
  readonly children: ReactNode;
}) {
  const justificado =
    alineacion === "derecha" ? "justify-end" : alineacion === "entre" ? "justify-between" : "justify-start";
  return <div className={`flex flex-wrap items-center gap-sm ${justificado}`}>{children}</div>;
}
