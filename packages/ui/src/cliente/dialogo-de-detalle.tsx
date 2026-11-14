"use client";

/**
 * Un diálogo para **mirar el detalle de algo** sin irse de la pantalla: «Ver quién» recibe la
 * bonificación del mes (encargo 16).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * QUÉ ES Y QUÉ NO ES
 *
 * **No es `DialogoDeConfirmacion`.** Aquel es un solo acto: un `<form>` que envuelve el cuerpo y dos
 * botones, y se sale con una decisión. Este es una **lista para leer**, que puede traer varias
 * acciones chicas adentro (cada una con su propio formulario, que pone la isla): por eso acá no hay
 * `<form>` —uno adentro de otro no es HTML válido— ni botón primario, solo «Cerrar».
 *
 * **Se cierra con `Esc`, con «Cerrar» o tocando afuera**: no hay nada a medio decidir que se pierda.
 * Lo que la isla tenga abierto adentro (un motivo a medio escribir) es estado suyo.
 *
 * **Accesibilidad:** la primitiva (`@base-ui/react/dialog`) pone `role="dialog"`, atrapa el foco, lo
 * devuelve al disparador al cerrar y nombra el diálogo con su título. El cuerpo scrollea adentro del
 * diálogo, no la página.
 */

import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { clasesDeBoton, type TamanoBoton, type VarianteBoton } from "../boton.tsx";

export function DialogoDeDetalle({
  disparador,
  varianteDisparador = "secundario",
  tamanoDisparador = "sm",
  etiquetaDisparador,
  titulo,
  textoCerrar = "Cerrar",
  pie,
  children,
}: {
  /** El texto del botón que abre el diálogo («Ver quién»). */
  readonly disparador: ReactNode;
  readonly varianteDisparador?: VarianteBoton;
  readonly tamanoDisparador?: TamanoBoton;
  /** Nombre accesible del disparador cuando el texto visible no alcanza. */
  readonly etiquetaDisparador?: string;
  readonly titulo: ReactNode;
  readonly textoCerrar?: string;
  /** Una aclaración que queda abajo, al lado de «Cerrar». */
  readonly pie?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger
        className={clasesDeBoton({ variante: varianteDisparador, tamano: tamanoDisparador })}
        aria-label={etiquetaDisparador}
      >
        {disparador}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-[var(--overlay)]" />
        <Dialog.Popup
          data-admin-barrios-ui
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] max-w-[48rem] -translate-x-1/2 -translate-y-1/2 flex-col gap-md overflow-auto rounded-xl bg-surface-raised p-lg text-sm text-text-primary shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <Dialog.Title className="text-lg font-semibold text-text-primary">{titulo}</Dialog.Title>
          {children}
          <div className="flex flex-wrap items-center justify-between gap-sm">
            <p className="m-none min-w-0 flex-[1_1_16rem] text-sm text-text-secondary">{pie}</p>
            <Dialog.Close className={clasesDeBoton({ variante: "secundario" })}>{textoCerrar}</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
