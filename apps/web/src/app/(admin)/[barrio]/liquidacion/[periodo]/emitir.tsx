"use client";

/**
 * «Emitir N boletas» (T2, D1; el diálogo de la maqueta). Emitir calcula, valida y firma en un acto:
 * el diálogo muestra lo de la última vista previa —cuántas boletas, el total con el interés a hoy y
 * los vencimientos— y manda su huella. Si al emitir las cifras ya no son esas (entró un pago, un gasto,
 * un cargo), el servidor no emite y dice qué cambió: el diálogo lo muestra y pide la casilla
 * «Revisé las cifras y confirmo la emisión». Al confirmar se manda la huella de las cifras nuevas, así
 * que si vuelven a cambiar se pregunta otra vez.
 *
 * Ninguna cifra se calcula acá: llegan del servidor ya formateadas.
 */

import { emitirMesAction } from "../../../../../acciones/liquidacion.ts";
import {
  CAMPO_CIFRAS_CONFIRMADAS,
  CAMPO_CODIGO_CONFIRMADO,
  CAMPO_CONFIRMO,
  VALOR_CONFIRMO,
} from "../../../../../acciones/confirmacion.ts";
import { AvisoDeFalloCompacto, Casilla, useFormulario, useVolverAlGuardar } from "../../../../../componentes/formulario.tsx";
import { DialogoDeConfirmacion, DatoDeConsecuencia, ListaDeConsecuencias } from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";

export function BotonEmitirMes({
  periodoId,
  huellaVista,
  vistaCalculadaEl,
  boletas,
  total,
  titulo,
  fechaDeHoy,
  vencimientos,
  volverA,
}: {
  readonly periodoId: string;
  readonly huellaVista: string;
  readonly vistaCalculadaEl: string;
  readonly boletas: number;
  /** Ya formateado: «$ 61.297.311,58». */
  readonly total: string;
  readonly titulo: string;
  /** «04/11/2026»: el día del interés. */
  readonly fechaDeHoy: string;
  /** «vence el 10/12/2026 y el 20/12/2026». */
  readonly vencimientos: string;
  /** Envío: lo de después de emitir. */
  readonly volverA: string;
}) {
  const { enviar, pendiente, resultado, confirmacion } = useFormulario(emitirMesAction);
  useVolverAlGuardar(resultado, () => volverA);
  const textoDelBoton = `Emitir ${boletas} ${boletas === 1 ? "boleta" : "boletas"}`;

  if (resultado.estado === "ok") return <span>Emitido</span>;
  const cambio = resultado.estado === "confirmar" && confirmacion ? resultado : null;

  return (
    <DialogoDeConfirmacion
      disparador={textoDelBoton}
      varianteDisparador="primario"
      tamanoDisparador="base"
      titulo={titulo}
      accion={enviar}
      textoVolver="Cancelar"
      textoConfirmar={cambio ? "Emitir con las cifras de ahora" : textoDelBoton}
      textoPendiente="Emitiendo…"
      pendiente={pendiente}
    >
      <input type="hidden" name="periodoId" value={periodoId} />
      <input type="hidden" name="huellaVista" value={huellaVista} />
      <input type="hidden" name="vistaCalculadaEl" value={vistaCalculadaEl} />
      <ListaDeConsecuencias>
        <li>
          Se calculan y firman <DatoDeConsecuencia>{boletas}</DatoDeConsecuencia> boletas por{" "}
          <DatoDeConsecuencia>{total}</DatoDeConsecuencia>, con el interés a hoy, {fechaDeHoy}.
        </li>
        <li>{vencimientos.charAt(0).toUpperCase() + vencimientos.slice(1)}.</li>
        <li>Lo emitido no se deshace: un error se corrige con un ajuste en el mes siguiente.</li>
        <li>Después se arman solos los PDF, el informe y el paquete. El envío lo hacés vos.</li>
      </ListaDeConsecuencias>
      {cambio ? (
        <>
          <p role="status">{cambio.error.mensaje}</p>
          <input type="hidden" name={CAMPO_CODIGO_CONFIRMADO} value={cambio.error.codigo} />
          {cambio.error.datos["cifras"] !== undefined ? (
            <input type="hidden" name={CAMPO_CIFRAS_CONFIRMADAS} value={cambio.error.datos["cifras"]} />
          ) : null}
          <Casilla nombre={CAMPO_CONFIRMO} valor={VALOR_CONFIRMO}>
            {confirmacion?.leyendaDeLaCasilla ?? "Revisé las cifras y confirmo la emisión."}
          </Casilla>
        </>
      ) : null}
      <div aria-live="polite">{resultado.estado === "falla" ? <AvisoDeFalloCompacto error={resultado.error} /> : null}</div>
    </DialogoDeConfirmacion>
  );
}
