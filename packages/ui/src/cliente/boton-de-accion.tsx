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

import { useRef, type ReactNode } from "react";
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

/**
 * «Cancelar» adentro de algo que se despliega (`AccionDesplegable`, `PanelDesplegable` o un
 * `<details>` propio de una pantalla): **cierra sin guardar** (encargo 8, T1 §2).
 *
 * Hace tres cosas, todas en el navegador y ninguna en el servidor: vuelve el formulario a sus
 * valores iniciales (`form.reset()`), cierra el `<details>` más cercano y devuelve el foco a su
 * `<summary>` —el disparador—, para que quien navega con teclado no quede en el `<body>`.
 *
 * Por qué busca el `<details>` en el DOM en vez de recibir un estado: los desplegables del kit son de
 * servidor (`<details>` nativo, cero JavaScript) y no tienen estado que pasar. El botón es la única
 * pieza con JavaScript, y va adentro del formulario —que ya es una isla—, al lado del botón que
 * guarda, que es donde lo ponen las maquetas.
 *
 * `alCancelar` es para cuando lo que se abrió no es un `<details>` sino estado de la isla (la fila de
 * corrección de un proveedor): ahí la isla se cierra a sí misma.
 */
export function BotonCancelar({
  texto = "Cancelar",
  tamano = "base",
  deshabilitado,
  alCancelar,
}: {
  readonly texto?: string;
  readonly tamano?: TamanoBoton;
  /** Solo con un envío en vuelo: cancelar ahí no cancela nada, el pedido ya salió. */
  readonly deshabilitado?: boolean;
  readonly alCancelar?: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      disabled={deshabilitado}
      className={clasesDeBoton({ variante: "sutil", tamano, deshabilitado })}
      onClick={() => {
        const boton = ref.current;
        boton?.form?.reset();
        const desplegable = boton?.closest("details");
        if (desplegable) {
          desplegable.open = false;
          desplegable.querySelector("summary")?.focus();
        }
        alCancelar?.();
      }}
    >
      {texto}
    </button>
  );
}
