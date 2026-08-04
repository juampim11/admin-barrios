/**
 * La barra de frentes de un período: **navegación, y nada más**.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ NO TIENE NÚMEROS NI ESTADO
 *
 * Antes esto era un recorrido de cuatro cajas numeradas con tilde de "hecho". Hacía **dos trabajos a
 * la vez** —decir dónde se puede ir y decir cómo viene el mes— y no puede hacer los dos: el mismo
 * componente aparecía como navegación en las cuatro pantallas de trabajo y como tablero de estado en
 * el resumen. El usuario lo vio apenas se rehízo el resumen: *"cuando voy a cualquiera de las 4
 * opciones, siguen apareciendo los menú arriba con acciones clickeables"*. Dos idiomas para lo mismo,
 * en el mismo flujo.
 *
 * El reparto quedó así, y cada pieza hace una sola cosa:
 *
 * - **Cómo viene el mes** lo dice la **ficha de cierre**, y solo en el resumen. Ahí viven los estados,
 *   los bloqueos y la acción principal.
 * - **A dónde se puede ir** lo dice esta barra, en las pantallas de trabajo. Sin números, sin tildes
 *   y sin flechas: numerarlos afirma una precedencia que no existe —el cargo del quincho se carga
 *   tres semanas antes que la factura de energía— y fue el origen de todo el problema
 *   (`docs/producto/relevamiento-liquidacion.md`).
 *
 * Lo único que marca es **dónde estás**, con fondo, borde y `aria-current="page"`: tres señales,
 * nunca solo el color (doc 06 §f.2).
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import type { ReactNode } from "react";

export function BarraDeFrentes({ etiqueta, children }: { readonly etiqueta: string; readonly children: ReactNode }) {
  return (
    <nav data-admin-barrios-ui aria-label={etiqueta} className="overflow-x-auto [overscroll-behavior-x:contain]">
      <ul className="flex min-w-max items-stretch gap-xs">{children}</ul>
    </nav>
  );
}

export function FrenteEnBarra({
  href,
  activo,
  titulo,
  detalle,
}: {
  readonly href: string;
  readonly activo: boolean;
  readonly titulo: ReactNode;
  readonly detalle: ReactNode;
}) {
  return (
    <li className="flex">
      <a
        href={href}
        aria-current={activo ? "page" : undefined}
        className={[
          "flex min-h-control-base flex-col justify-center rounded-md border px-base py-xs no-underline leading-tight transition-colors",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
          activo
            ? "border-primary bg-primary-subtle"
            : "border-border bg-surface hover:border-primary hover:bg-primary-subtle",
        ].join(" ")}
      >
        <span className={`text-sm ${activo ? "font-semibold text-text-primary" : "text-text-primary"}`}>{titulo}</span>
        <span className="text-xs text-text-secondary">{detalle}</span>
      </a>
    </li>
  );
}
