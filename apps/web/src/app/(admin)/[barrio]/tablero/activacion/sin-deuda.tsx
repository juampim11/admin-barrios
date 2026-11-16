"use client";

/**
 * «El barrio no trae deuda» (encargo 17, paso 3 del tablero): una confirmación simple, con el diálogo
 * de siempre. Ninguna regla vive acá: quién puede y qué pasa con una planilla ya cargada lo decide
 * `declararSinDeudaAnterior`. Al confirmar, vuelve al tablero con el «Listo:».
 */

import { DialogoDeConfirmacion, ListaDeConsecuencias } from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";
import { declararSinDeudaAnteriorAction } from "../../../../../acciones/activacion.ts";
import { AvisoDeFalloCompacto, useFormulario, useVolverAlGuardar } from "../../../../../componentes/formulario.tsx";

export function BotonSinDeudaAnterior({
  barrioId,
  hayPlanillaCargada,
  volverA,
}: {
  readonly barrioId: string;
  /** Si ya hay una planilla cargada: confirmar la descarta, y el diálogo lo dice. */
  readonly hayPlanillaCargada: boolean;
  /** El tablero con `?listo=sin_deuda_anterior`. */
  readonly volverA: string;
}) {
  const { enviar, pendiente, resultado } = useFormulario(declararSinDeudaAnteriorAction);
  useVolverAlGuardar(resultado, () => volverA);

  return (
    <DialogoDeConfirmacion
      disparador="El barrio no trae deuda"
      varianteDisparador="sutil"
      tamanoDisparador="base"
      titulo="¿El barrio no trae deuda de antes?"
      accion={enviar}
      textoVolver="Cancelar"
      textoConfirmar="Confirmar: no trae deuda"
      textoPendiente="Guardando…"
      pendiente={pendiente}
      cerrarCon={resultado.estado === "ok" ? resultado : null}
    >
      <input type="hidden" name="barrioId" value={barrioId} />
      <ListaDeConsecuencias>
        <li>Queda dicho que ninguna unidad debe meses anteriores ni tiene saldo a favor al activar.</li>
        {hayPlanillaCargada ? <li>La planilla de deuda que ya estaba cargada se descarta.</li> : null}
        <li>Hasta que el barrio emita su primer mes, se puede cambiar subiendo una planilla.</li>
      </ListaDeConsecuencias>
      <div aria-live="polite">{resultado.estado === "falla" ? <AvisoDeFalloCompacto error={resultado.error} /> : null}</div>
    </DialogoDeConfirmacion>
  );
}
