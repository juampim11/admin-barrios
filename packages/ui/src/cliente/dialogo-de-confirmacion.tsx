"use client";

/**
 * El diálogo que pide confirmar una acción de plata **antes** de mandarla: aprobar o rechazar una
 * orden de pago, quitar un gasto, desactivar un proveedor (encargo 8, T1 §6).
 *
 * Calca el `.velo/.dialogo` de las maquetas aprobadas (`conciliacion-extracto.html`,
 * `alta-barrio-padron.html`): un título, un cuerpo con las cifras en una lista, y abajo a la derecha
 * la salida («Volver» / «Cancelar») y la acción primaria, en ese orden.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * QUÉ ES Y QUÉ NO ES
 *
 * **No es `PedidoDeConfirmacion`.** Aquel nace de un rechazo del servidor (la base dice «esto necesita
 * que lo confirmes» y manda las cifras en el error). Este se abre **antes** de enviar nada, para
 * acciones que el servidor acepta sin preguntar pero que mueven plata. Las cifras del cuerpo las pone
 * la pantalla con lo que ya leyó del servidor —nunca un número inventado ni calculado acá—: el kit no
 * sabe qué es una orden ni un gasto, recibe el cuerpo armado.
 *
 * **El formulario vive adentro del diálogo.** El `<form>` envuelve el cuerpo y los dos botones, así
 * que un campo que haga falta (el motivo de un rechazo) viaja en el mismo `FormData` sin trucos de
 * `form=`. La acción la pone la isla (`useFormulario().enviar`): acá no hay validación propia.
 *
 * **Nunca se cierra solo en la mitad.** Mientras el envío está en vuelo, ni `Esc` ni «Volver» lo
 * cierran —el `FormData` ya viajó, y cerrar ahí lee como un cancelar que no cancela—. Si el servidor
 * rechaza, queda abierto con el aviso adentro. Se cierra cuando `cerrarCon` cambia a un valor no nulo
 * (la isla le pasa el resultado `ok`), o por el gesto de la persona.
 *
 * **Accesibilidad:** la primitiva (`@base-ui/react/alert-dialog`) pone `role="alertdialog"`, atrapa el
 * foco, lo devuelve al disparador al cerrar y nombra el diálogo con su título. Un clic en el velo no lo
 * cierra (es un diálogo de alerta: se sale con una decisión). El foco entra al primer control: el campo
 * si lo hay, y si no «Volver» — el default seguro.
 */

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useEffect, useState, type ReactNode } from "react";
import { clasesDeBoton, type TamanoBoton, type VarianteBoton } from "../boton.tsx";

export function DialogoDeConfirmacion({
  disparador,
  varianteDisparador = "secundario",
  tamanoDisparador = "sm",
  etiquetaDisparador,
  titulo,
  accion,
  textoConfirmar,
  varianteConfirmar = "primario",
  textoPendiente,
  pendiente,
  textoVolver = "Volver",
  cerrarCon,
  children,
}: {
  /** El texto del botón que abre el diálogo («Aprobar», «Quitar»). */
  readonly disparador: ReactNode;
  readonly varianteDisparador?: VarianteBoton;
  readonly tamanoDisparador?: TamanoBoton;
  /** Nombre accesible del disparador cuando el texto visible no alcanza («Quitar el gasto Luz»). */
  readonly etiquetaDisparador?: string;
  readonly titulo: ReactNode;
  /** La acción del formulario: `useFormulario().enviar` de la isla. */
  readonly accion: (form: FormData) => void;
  readonly textoConfirmar: ReactNode;
  readonly varianteConfirmar?: VarianteBoton;
  /** El verbo en gerundio mientras el envío corre («Aprobando…»). */
  readonly textoPendiente: string;
  readonly pendiente: boolean;
  readonly textoVolver?: string;
  /** Cuando cambia a un valor no nulo, el diálogo se cierra (la isla pasa el resultado `ok`). */
  readonly cerrarCon?: unknown;
  /** Los campos ocultos, la lista de consecuencias, algún campo y el aviso de falla. */
  readonly children: ReactNode;
}) {
  const [abierto, setAbierto] = useState(false);

  useEffect(() => {
    if (cerrarCon != null) setAbierto(false);
  }, [cerrarCon]);

  return (
    <AlertDialog.Root
      open={abierto}
      onOpenChange={(siguiente) => {
        // Con el envío en vuelo no se cierra: el pedido ya salió.
        if (!siguiente && pendiente) return;
        setAbierto(siguiente);
      }}
    >
      <AlertDialog.Trigger
        className={clasesDeBoton({ variante: varianteDisparador, tamano: tamanoDisparador })}
        aria-label={etiquetaDisparador}
      >
        {disparador}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-[var(--overlay)]" />
        <AlertDialog.Popup
          data-admin-barrios-ui
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-[35rem] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl bg-surface-raised p-lg text-text-primary shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <AlertDialog.Title className="text-lg font-semibold text-text-primary">{titulo}</AlertDialog.Title>
          <form action={accion} noValidate className="mt-sm flex flex-col gap-md text-sm">
            {children}
            <div className="mt-sm flex flex-wrap items-center justify-end gap-sm">
              <AlertDialog.Close
                className={clasesDeBoton({ variante: "secundario", deshabilitado: pendiente })}
                disabled={pendiente}
              >
                {textoVolver}
              </AlertDialog.Close>
              <button
                type="submit"
                disabled={pendiente}
                aria-busy={pendiente}
                className={clasesDeBoton({ variante: varianteConfirmar, deshabilitado: pendiente })}
              >
                {pendiente ? textoPendiente : textoConfirmar}
              </button>
            </div>
          </form>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/**
 * Lo que pasa con la plata, en una lista: un renglón por consecuencia (maqueta: «Se registran 41 pagos
 * por $ 3.802.150,00…»). Los `<li>` y las cifras ya formateadas los pone la pantalla.
 */
export function ListaDeConsecuencias({ children }: { readonly children: ReactNode }) {
  return <ul className="m-none flex list-disc flex-col gap-xs pl-lg text-sm text-text-primary">{children}</ul>;
}

/** Una cifra dentro de una consecuencia, ya formateada: en negrita y en la tipografía de las cifras. */
export function DatoDeConsecuencia({ children }: { readonly children: ReactNode }) {
  return <strong className="font-ab-numeric font-semibold">{children}</strong>;
}
