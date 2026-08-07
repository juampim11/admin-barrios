"use client";

/**
 * El botón que hace algo **en la pantalla** en vez de navegar o enviar: cerrar un aviso, descartar
 * una confirmación, abrir un panel.
 *
 * Vive en el estrato de cliente porque un `onClick` no puede cruzar la frontera hacia un componente
 * de servidor (ADR-0003 §4: *"cliente solo lo que envuelve una primitiva… con `"use client"` en el
 * archivo y exportado por subruta propia, para que la frontera se vea en el import"*). La regla no
 * es solo formal: importar esto desde una pantalla declara, en el import, que ahí hay JavaScript.
 *
 * **Se ve idéntico al `Boton` de servidor** porque comparte `clasesDeBoton()`. Si mañana el botón
 * cambia de forma, cambia en los dos: no hay una segunda definición que se olvide.
 */

import type { ReactNode } from "react";
import { clasesDeBoton, type TamanoBoton, type VarianteBoton } from "../boton.tsx";

export function BotonDeAccion({
  onClick,
  variante = "secundario",
  tamano = "base",
  anchoCompleto,
  deshabilitado,
  etiqueta,
  children,
}: {
  readonly onClick: () => void;
  readonly variante?: VarianteBoton;
  readonly tamano?: TamanoBoton;
  readonly anchoCompleto?: boolean;
  /** Solo para una operación en vuelo. Nunca para permisos (doc 06 §c.6.4). */
  readonly deshabilitado?: boolean;
  readonly etiqueta?: string;
  readonly children: ReactNode;
}) {
  return (
    <button
      // `type="button"` explícito: adentro de un `<form>`, el default de HTML es `submit`, y un
      // botón que existe para NO enviar el formulario enviándolo es el peor default posible.
      type="button"
      onClick={onClick}
      disabled={deshabilitado}
      aria-label={etiqueta}
      className={clasesDeBoton({ variante, tamano, anchoCompleto, deshabilitado })}
    >
      {children}
    </button>
  );
}
