"use client";

/**
 * «Cambiar los vencimientos» del mes (T2, el diálogo de la maqueta). Vienen de la configuración del
 * barrio cuando el mes se abre solo; este cambio vale solo para este mes, con motivo, y se puede hasta
 * emitir (después la base no lo deja: de los vencimientos corre el interés, `0072`).
 */

import { cambiarVencimientosAction } from "../../../../../acciones/liquidacion.ts";
import { AvisoDeFalloCompacto, CampoParrafo, CampoTexto, useFormulario } from "../../../../../componentes/formulario.tsx";
import { DialogoDeConfirmacion } from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";

export function CambiarVencimientos({
  periodoId,
  mes,
  primero,
  segundo,
  corte,
}: {
  readonly periodoId: string;
  /** «noviembre 2026». */
  readonly mes: string;
  readonly primero: string | null;
  readonly segundo: string | null;
  /** Hasta cuándo se puede pagar (`0078`). */
  readonly corte: string | null;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(cambiarVencimientosAction);

  return (
    <DialogoDeConfirmacion
      disparador="Cambiar"
      varianteDisparador="sutil"
      etiquetaDisparador="Cambiar los vencimientos del mes"
      titulo={`Cambiar los vencimientos de ${mes}`}
      accion={enviar}
      textoVolver="Cancelar"
      textoConfirmar="Guardar los vencimientos"
      textoPendiente="Guardando…"
      pendiente={pendiente}
      cerrarCon={resultado.estado === "ok" ? resultado.valor : null}
    >
      <p>
        Vienen de la configuración del barrio. Este cambio vale solo para {mes} y se puede hasta emitir.
      </p>
      <input type="hidden" name="periodoId" value={periodoId} />
      <CampoTexto
        nombre="primerVencimiento"
        tipo="date"
        etiqueta="1.er vencimiento"
        requerido
        errores={campos["primerVencimiento"]}
        valorInicial={previos["primerVencimiento"] ?? primero ?? undefined}
      />
      <CampoTexto
        nombre="segundoVencimiento"
        tipo="date"
        etiqueta="2.º vencimiento (opcional)"
        errores={campos["segundoVencimiento"]}
        valorInicial={previos["segundoVencimiento"] ?? segundo ?? undefined}
        ayuda="Lleva el mismo importe que el primero."
      />
      <CampoTexto
        nombre="fechaCorte"
        tipo="date"
        etiqueta="Se puede pagar hasta (opcional)"
        errores={campos["fechaCorte"]}
        valorInicial={previos["fechaCorte"] ?? corte ?? undefined}
        ayuda="La fecha de corte: no antes del último vencimiento. Vacío: el mes queda sin corte."
      />
      <CampoParrafo
        nombre="motivo"
        etiqueta="Motivo"
        requerido
        maximo={300}
        filas={2}
        errores={campos["motivo"]}
        valorInicial={previos["motivo"]}
        ayuda="Queda registrado en el mes. Por ejemplo: «Feriado largo»."
      />
      <div aria-live="polite">{resultado.estado === "falla" ? <AvisoDeFalloCompacto error={resultado.error} /> : null}</div>
    </DialogoDeConfirmacion>
  );
}
