"use client";

/**
 * «Activar el barrio» (encargo 17; el diálogo de la pantalla 3 de la maqueta): una confirmación con
 * el resumen de lo que queda cargado, el primer mes a devengar y la tasa elegida para la deuda
 * anterior. Con el patrón de «Anular» un pago y de «Emitir»: `DialogoDeConfirmacion` + una acción.
 *
 * **Ninguna cifra ni regla se resuelve acá.** Los renglones llegan armados por el servidor
 * (`consecuenciasDeActivar`) con lo que dijo `estadoDeLaActivacion`. Que la activación sea una sola
 * vez, de la administración, y que una tasa distinta de la vigente lleve motivo lo controla la base;
 * si falta el motivo, el rechazo vuelve puesto en el campo.
 *
 * Al activar, vuelve al tablero con «Listo: el barrio quedó activado».
 */

import { DialogoDeConfirmacion, ListaDeConsecuencias } from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";
import { activarBarrioAction } from "../../../../../../acciones/activacion.ts";
import { AvisoDeFalloCompacto, CampoParrafo, useFormulario, useVolverAlGuardar } from "../../../../../../componentes/formulario.tsx";

export function BotonActivarBarrio({
  barrioId,
  tasa,
  pideMotivo,
  consecuencias,
  volverA,
}: {
  readonly barrioId: string;
  /** La tasa mensual para la deuda anterior, como porcentaje («3» o «3,5»): así la espera el esquema. */
  readonly tasa: string;
  /** Si la tasa elegida no es la vigente del barrio: la base exige el motivo. */
  readonly pideMotivo: boolean;
  /** Los renglones del resumen, ya escritos por el servidor. */
  readonly consecuencias: readonly string[];
  /** El tablero con `?listo=barrio_activado`. */
  readonly volverA: string;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(activarBarrioAction);
  useVolverAlGuardar(resultado, () => volverA);

  // Activado: mientras se vuelve al tablero, no se ofrece activar de nuevo.
  if (resultado.estado === "ok") return <span>Activado</span>;
  const sueltos = [...(campos["tasa"] ?? []), ...(campos["barrioId"] ?? []), ...(campos[""] ?? [])];

  return (
    <DialogoDeConfirmacion
      disparador="Activar el barrio"
      varianteDisparador="primario"
      tamanoDisparador="base"
      titulo="¿Activar el barrio?"
      accion={enviar}
      textoVolver="Cancelar"
      textoConfirmar="Activar el barrio"
      textoPendiente="Activando…"
      pendiente={pendiente}
    >
      <input type="hidden" name="barrioId" value={barrioId} />
      <input type="hidden" name="tasa" value={tasa} />
      <ListaDeConsecuencias>
        {consecuencias.map((linea) => (
          <li key={linea}>{linea}</li>
        ))}
      </ListaDeConsecuencias>
      {pideMotivo ? (
        <CampoParrafo
          nombre="motivo"
          etiqueta="Motivo de la tasa"
          requerido
          maximo={500}
          filas={2}
          errores={campos["motivo"]}
          valorInicial={previos["motivo"]}
          ayuda="La tasa elegida no es la vigente del barrio. Contá en una frase por qué: queda registrado con la activación."
        />
      ) : null}
      <div aria-live="polite">
        {resultado.estado === "falla" ? <AvisoDeFalloCompacto error={resultado.error} /> : null}
        {sueltos.length > 0 ? <p role="alert">{sueltos.join(". ")}</p> : null}
        {/* Sin el campo a la vista, un rechazo por el motivo no puede quedar mudo. */}
        {!pideMotivo && campos["motivo"] ? <p role="alert">{campos["motivo"].join(". ")}</p> : null}
      </div>
    </DialogoDeConfirmacion>
  );
}
