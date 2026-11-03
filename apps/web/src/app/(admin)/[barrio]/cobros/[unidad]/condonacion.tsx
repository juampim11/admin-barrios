"use client";

/**
 * «Condonar» desde el estado de cuenta de la unidad (ADR-0009): el interés devengado y no pagado,
 * total o parcial, con motivo, respaldo opcional y una confirmación que dice el importe. Es la isla de
 * la pantalla; el patrón es el de los formularios de la tasa de T1 (`configuracion/formularios.tsx`):
 * se abre en un `AccionDesplegable` y la confirmación reemplaza al formulario en el mismo lugar.
 *
 * Ninguna regla vive acá: el tope (lo pendiente), que lo pagado no se condona y quién puede, lo
 * deciden el servicio y la base.
 */

import { ETIQUETA_MOTIVO_CONDONACION, MOTIVOS_CONDONACION } from "@admin-barrios/shared/escrituras";
import { CONTENT_TYPES_COMPROBANTE } from "@admin-barrios/shared/cobros";
import { ETIQUETA_RESPALDO, TIPOS_RESPALDO } from "@admin-barrios/shared/parametros-mora";
import { TextoDeOrigen } from "@admin-barrios/ui";
import { condonarInteresAction } from "../../../../../acciones/cobros.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoArchivo,
  CampoMonto,
  CampoParrafo,
  CampoSeleccion,
  Campos,
  CampoTexto,
  Formulario,
  PedidoDeConfirmacion,
  useFormulario,
} from "../../../../../componentes/formulario.tsx";
import { useSubidaDeRespaldo } from "../../../../../componentes/useSubidaDeRespaldo.ts";

const TIPOS_ACEPTADOS = CONTENT_TYPES_COMPROBANTE.join(",");

export function FormularioDeCondonacion({
  barrioId,
  unidadFuncionalId,
  pendiente,
  pendienteTexto,
}: {
  readonly barrioId: string;
  readonly unidadFuncionalId: string;
  /** El interés pendiente, como monto (para precargar el campo). */
  readonly pendiente: string;
  /** El mismo importe, ya formateado por el servidor para el texto. */
  readonly pendienteTexto: string;
}) {
  const { enviar, pendiente: enviando, resultado, campos, previos, confirmacion, volverACorregir } =
    useFormulario<{ readonly condonado: string }>(condonarInteresAction);
  const subida = useSubidaDeRespaldo(barrioId);

  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo="Listo: el interés quedó condonado.">
        <p>Se ve en los movimientos de la unidad como «Interés condonado», con su motivo. No se deshace.</p>
      </AvisoDeExito>
    );
  }

  const subiendo = subida.estado.fase === "pidiendoUrl" || subida.estado.fase === "subiendo";

  return (
    <Formulario accion={enviar} etiqueta="Condonar interés de la unidad">
      {confirmacion && resultado.estado === "confirmar" ? (
        <PedidoDeConfirmacion
          onVolver={volverACorregir}
          error={resultado.error}
          confirmacion={confirmacion}
          valores={resultado.valores}
          pendiente={enviando}
        />
      ) : (
        <>
          <input type="hidden" name="unidadFuncionalId" value={unidadFuncionalId} />
          <p>
            <TextoDeOrigen>
              Interés devengado y no pagado: {pendienteTexto}. Lo pagado no se condona. El interés queda
              registrado; la condonación lo compensa con un movimiento propio.
            </TextoDeOrigen>
          </p>
          <Campos>
            <CampoMonto
              nombre="monto"
              etiqueta="Importe a condonar"
              requerido
              errores={campos["monto"]}
              valorInicial={previos["monto"] ?? pendiente}
              ayuda="Todo el pendiente, o una parte."
            />
            <CampoSeleccion
              nombre="motivo"
              etiqueta="Motivo"
              requerido
              opciones={MOTIVOS_CONDONACION.map((m) => ({ valor: m, texto: ETIQUETA_MOTIVO_CONDONACION[m] }))}
              sinSeleccion="Elegí el motivo…"
              errores={campos["motivo"]}
              valorInicial={previos["motivo"]}
            />
            <CampoParrafo
              nombre="detalle"
              etiqueta="Detalle"
              requerido
              ancho
              maximo={500}
              errores={campos["detalle"]}
              valorInicial={previos["detalle"]}
              ayuda="Por qué se condona. Al menos 10 caracteres: queda en el registro."
            />
            <CampoSeleccion
              nombre="respaldoTipo"
              etiqueta="Respaldo (opcional)"
              opciones={TIPOS_RESPALDO.map((t) => ({ valor: t, texto: ETIQUETA_RESPALDO[t] }))}
              sinSeleccion="Sin respaldo"
              errores={campos["respaldoTipo"]}
              valorInicial={previos["respaldoTipo"]}
              ayuda="Si lo resolvió la comisión o la asamblea, conviene el acta."
            />
            <CampoTexto
              nombre="respaldoReferencia"
              etiqueta="Referencia del respaldo"
              maximo={300}
              errores={campos["respaldoReferencia"]}
              valorInicial={previos["respaldoReferencia"]}
              ayuda="Dónde se encuentra: el acta con su fecha, o el artículo."
            />
            <CampoArchivo
              nombre="respaldoAdjunto"
              etiqueta="Adjunto del respaldo"
              ancho
              aceptar={TIPOS_ACEPTADOS}
              estado={subida.estado}
              onElegirArchivo={subida.elegirArchivo}
              onReintentar={subida.reintentar}
              errores={campos["respaldoAdjunto"]}
              ayuda="PDF o foto (JPG o PNG). Opcional."
            />
          </Campos>
          <Avisos>
            {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>
          <Acciones ayuda={subiendo ? "Esperando que termine de subir el adjunto." : "Antes de condonar se muestra el importe para confirmarlo."}>
            <BotonEnviar pendiente={enviando} deshabilitado={subiendo} cargando="Revisando…">
              Condonar
            </BotonEnviar>
          </Acciones>
        </>
      )}
    </Formulario>
  );
}
