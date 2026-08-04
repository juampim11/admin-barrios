/**
 * El recorrido de un período: los cuatro pasos, como **navegación** y no como cartel de progreso.
 *
 * Es la pieza 7 del inventario (ADR-0003 §4): *"envoltura visual sobre rutas — no wizard cliente"*.
 * Cada paso es un enlace a su ruta; no hay estado de wizard en el cliente, y por lo tanto no hay
 * forma de que la pantalla y la máquina de estados de la base se contradigan.
 *
 * **Por qué se rehizo.** El usuario, mirando el resumen: *"no es intuitiva la navegación… es como
 * que el workflow no termina siendo intuitivo para navegar"*. La versión anterior dibujaba cuatro
 * cajas planas con un número adelante: se leían como un **indicador de avance**, que es algo que se
 * mira, no como una barra de secciones, que es algo que se toca. Nadie hace clic en un cartel.
 *
 * Lo que lo convierte en navegación, y cada cosa hace falta:
 *
 * 1. **Afordancia de clic**: fondo al pasar el mouse, y el cursor de enlace.
 * 2. **Estado de cada paso**: `hecho` lleva tilde, `pendiente` lleva su número, `activo` va marcado
 *    con fondo, borde y `aria-current="step"`. Tres señales, nunca solo el color (doc 06 §f.2).
 * 3. **Una flecha entre paso y paso**, que es lo que dice "esto es un camino" sin escribirlo.
 *
 * El estado de cada paso lo decide **la pantalla**, que es la que conoce el período; acá no se
 * deduce nada.
 */

import type { ReactNode } from "react";
import { IconoCheck } from "./iconos.tsx";

export type EstadoDePaso = "hecho" | "activo" | "pendiente";

export function Pasos({ etiqueta, children }: { readonly etiqueta: string; readonly children: ReactNode }) {
  return (
    <nav data-admin-barrios-ui aria-label={etiqueta} className="overflow-x-auto [overscroll-behavior-x:contain]">
      <ol className="flex min-w-max items-stretch gap-xs">{children}</ol>
    </nav>
  );
}

export function Paso({
  href,
  numero,
  estado,
  titulo,
  detalle,
  ultimo,
}: {
  readonly href: string;
  readonly numero: number;
  readonly estado: EstadoDePaso;
  readonly titulo: ReactNode;
  readonly detalle: ReactNode;
  /** El último no lleva flecha: no hay a dónde seguir. */
  readonly ultimo?: boolean;
}) {
  const activo = estado === "activo";
  return (
    <li className="flex flex-1 items-center gap-xs">
      <a
        href={href}
        aria-current={activo ? "step" : undefined}
        className={[
          "flex flex-1 items-center gap-sm rounded-md border px-sm py-sm no-underline transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
          activo
            ? "border-primary bg-primary-subtle"
            : "border-border bg-surface hover:border-primary hover:bg-primary-subtle",
        ].join(" ")}
      >
        <span
          className={[
            "grid h-control-sm w-control-sm shrink-0 place-items-center rounded-pill border text-sm font-semibold",
            estado === "hecho"
              ? "border-success bg-success/15 text-text-primary"
              : activo
                ? "border-marca-aa bg-marca-aa text-primary-fg"
                : "border-border-strong bg-bg text-text-secondary",
          ].join(" ")}
          aria-hidden
        >
          {estado === "hecho" ? <IconoCheck /> : numero}
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className={`text-sm ${activo ? "font-semibold text-text-primary" : "text-text-primary"}`}>
            {titulo}
          </span>
          <span className="text-xs text-text-secondary">{detalle}</span>
        </span>
      </a>
      {ultimo ? null : (
        <span className="shrink-0 text-text-muted" aria-hidden>
          ›
        </span>
      )}
    </li>
  );
}
