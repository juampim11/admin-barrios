"use client";

/**
 * «Anular» un pago desde el estado de cuenta (encargo 10, BL-029). Con el patrón de las transiciones
 * de una orden de pago (`ordenes-pago/acciones-transicion.tsx`, «Rechazar»): un `DialogoDeConfirmacion`
 * que dice qué pasa con la plata y pide el motivo, obligatorio.
 *
 * **Ninguna cifra se calcula acá.** El resumen (el importe, cómo se imputó, la condonación que se anula
 * y el saldo antes y después) lo arma el servidor con `resumenDeAnulacion` a partir de las filas del
 * pago, y llega ya formateado. La anulación la hace `anularPago` tal como quedó en el #35.
 *
 * Al anular, vuelve al estado de cuenta con el «Listo:» (`?listo=anulacion`), que la página arma
 * leyendo el pago anulado de la base.
 */

import { anularPagoAction } from "../../../../../acciones/cobros.ts";
import {
  AvisoDeFalloCompacto,
  CampoParrafo,
  useFormulario,
  useVolverAlGuardar,
} from "../../../../../componentes/formulario.tsx";
import {
  DatoDeConsecuencia,
  DialogoDeConfirmacion,
  ListaDeConsecuencias,
} from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";

export function BotonAnularPago({
  pagoId,
  etiqueta,
  titulo,
  lineas,
  saldoAntes,
  saldoDespues,
  volverA,
}: {
  readonly pagoId: string;
  /** Nombre accesible del botón: «Anular el pago de $ X del dd/mm/aaaa». */
  readonly etiqueta: string;
  readonly titulo: string;
  readonly lineas: readonly string[];
  /** Ya formateados por el servidor («$ 12.345,67»). */
  readonly saldoAntes: string;
  readonly saldoDespues: string;
  /** El estado de cuenta con `?listo=anulacion&id=…`. */
  readonly volverA: string;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario<{ readonly pagoId: string }>(anularPagoAction);
  useVolverAlGuardar(resultado, () => volverA);

  // Anulado: mientras la página se recarga, no se ofrece anular de nuevo (code-reviewer).
  if (resultado.estado === "ok") return <span>Anulado</span>;

  return (
    <DialogoDeConfirmacion
      disparador="Anular"
      varianteDisparador="secundario"
      etiquetaDisparador={etiqueta}
      titulo={titulo}
      accion={enviar}
      textoVolver="Cancelar"
      textoConfirmar="Anular el pago"
      varianteConfirmar="peligro"
      textoPendiente="Anulando…"
      pendiente={pendiente}
    >
      <input type="hidden" name="pagoId" value={pagoId} />
      <ListaDeConsecuencias>
        {lineas.map((linea) => (
          <li key={linea}>{linea}</li>
        ))}
        <li>
          Saldo de la unidad: <DatoDeConsecuencia>{saldoAntes}</DatoDeConsecuencia> antes,{" "}
          <DatoDeConsecuencia>{saldoDespues}</DatoDeConsecuencia> después de anular.
        </li>
        <li>No se borra nada y no se deshace: el pago queda anulado con su motivo. Si hacía falta, se registra de nuevo.</li>
      </ListaDeConsecuencias>
      <CampoParrafo
        nombre="motivo"
        etiqueta="Motivo de la anulación"
        requerido
        maximo={500}
        filas={2}
        errores={campos["motivo"]}
        valorInicial={previos["motivo"]}
        ayuda="Queda registrado con el pago, sus imputaciones y su condonación. Contá en una frase por qué se anula."
      />
      <div aria-live="polite">
        {resultado.estado === "falla" ? <AvisoDeFalloCompacto error={resultado.error} /> : null}
      </div>
    </DialogoDeConfirmacion>
  );
}
