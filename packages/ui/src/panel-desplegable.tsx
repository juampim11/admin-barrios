/**
 * Un panel de carga que se abre y se cierra, con el disparador **donde aparece lo que abre**.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO Y NO UN MODAL
 *
 * El usuario pidió consistencia entre las dos pantallas de carga y propuso una ventana emergente.
 * El panel lo evaluó y recomendó esto, por un motivo que pesa más que la prolijidad visual: **el
 * ciclo de confirmación de monto inusual vive adentro del formulario**. Cuando un cargo supera el
 * umbral, `PedidoDeConfirmacion` **reemplaza** al formulario dentro de la misma tarjeta, y de ahí
 * sale "Volver y corregir" con los valores intactos. Ese freno es el que atrapa el cero de más.
 *
 * Metido en un diálogo, ese ciclo pasa a necesitar cuatro invariantes nuevas —que `Esc` no cierre en
 * la mitad (cerrar ahí pierde los valores del intento anterior), que "Volver y corregir" no cierre,
 * que el foco vaya al aviso que apareció y no al primer tabulable, que el scroll no mueva el fondo—.
 * **La forma correcta de no degradarlo es no moverlo.** Este componente no toca una línea de
 * `formulario.tsx`: ese es su criterio de aceptación.
 *
 * Y hay un segundo motivo, operativo: cargando contra una pila de comprobantes, la pregunta cada dos
 * minutos es *"¿la de seguridad ya la cargué?"*. El único chequeo es **mirar la lista**, y el total
 * acumulado es la brújula contra el mes anterior. Un overlay tapa las dos cosas justo cuando hacen
 * falta (relevamiento del 2026-08-04, §5).
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * **Sustrato: `<details>`/`<summary>` nativo.** Cero JavaScript, `aria-expanded` que el navegador ya
 * expone, y `Enter`/`Espacio` que funcionan sin que nadie los programe. `abiertoPorDefecto` lo
 * calcula la pantalla —abierto cuando todavía no hay nada cargado, cerrado cuando la lista de abajo
 * ya tiene filas— y no es estado de cliente.
 *
 * **Nunca se cierra solo.** Ni al guardar, ni al fallar, ni al pedir confirmación: solo lo cierra el
 * gesto de la persona. Un panel que se cierra al terminar se lleva puesto el acuse de lo que pasó.
 */

import type { ReactNode } from "react";
import { IconoChevron } from "./iconos.tsx";
import { IconoMas } from "./iconos.tsx";

export function PanelDesplegable({
  titulo,
  origen,
  abiertoPorDefecto,
  children,
}: {
  readonly titulo: ReactNode;
  /**
   * De dónde sale lo que se carga acá. Va **adentro**, visible al abrir: un disparador cerrado no
   * tiene que cargar con la explicación de algo que todavía no se ve.
   */
  readonly origen?: ReactNode;
  readonly abiertoPorDefecto?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <details
      data-admin-barrios-ui
      open={abiertoPorDefecto}
      className="group rounded-lg border border-border bg-surface shadow-sm"
    >
      <summary className="flex min-h-control-base cursor-pointer list-none items-center gap-sm rounded-lg px-base py-sm text-sm font-semibold text-text-primary marker:content-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 text-marca-aa" aria-hidden>
          <IconoMas />
        </span>
        {titulo}
        {/* Dos señales del estado, nunca solo el color: el chevron gira **y** el cuerpo aparece. */}
        <IconoChevron className="ml-auto shrink-0 text-text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-base border-t border-border px-base py-base">
        {origen ? <p className="text-xs text-text-secondary">{origen}</p> : null}
        {children}
      </div>
    </details>
  );
}
