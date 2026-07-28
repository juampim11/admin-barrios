"use client";

/**
 * El alta de un período.
 *
 * **Cuatro campos, y tres que no están.** No hay `estado` —un período nace en `borrador` por trigger
 * (`app.periodo_nace_en_borrador`), y ofrecer el campo sería dibujar un control que la base pisa—, no
 * hay `modelo` —queda en `variable`, porque la cuota fija necesita una versión de cuotas cargada que
 * en este incremento no tiene pantalla (ADR-0002 §8): ofrecerlo dejaría crear períodos que después no
 * se pueden liquidar— y no hay versión de coeficientes, que la fija el borrador con la versión cerrada
 * y vigente del barrio.
 *
 * **Los vencimientos no tienen valor por omisión, y eso es a propósito.** En la operatoria real se
 * cargan después, cuando el barrio decide la fecha, y un período sin vencimiento se puede liquidar
 * igual. Poner "el 10 del mes que viene" por default sería que el sistema decida una fecha que
 * después sale impresa en la boleta de doscientas familias.
 */

import { crearPeriodoAction } from "../../../../../acciones/liquidacion.ts";
import {
  Acciones,
  Avisos,
  AvisoDeCamposSueltos,
  AvisoDeFallo,
  BotonEnviar,
  CampoParrafo,
  CampoTexto,
  Campos,
  Formulario,
  PedidoDeConfirmacion,
  useFormulario,
  type Salidas,
} from "../../../../../componentes/formulario.tsx";

export function FormularioDePeriodo({
  barrioId,
  salidas,
}: {
  readonly barrioId: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos, previos, confirmacion } =
    useFormulario(crearPeriodoAction);

  return (
    <Formulario accion={enviar} etiqueta="Crear un período de expensas">
      {confirmacion && resultado.estado === "confirmar" ? (
        <PedidoDeConfirmacion
          error={resultado.error}
          confirmacion={confirmacion}
          valores={resultado.valores}
          pendiente={pendiente}
        />
      ) : (
        <>
          {/*
            El barrio va acá porque un alta no tiene ninguna fila de la que derivarlo. No autoriza
            nada: quién puede crear períodos en ese barrio lo decide la policy de `insert` de
            `periodo_expensa`, que exige rol de gestión (ADR-0002 §3.4).

            Va **adentro de esta rama** y no afuera: en el pedido de confirmación lo reemite
            `PedidoDeConfirmacion` desde los valores, y con los dos presentes había dos campos con el
            mismo nombre. `valoresDe` se queda con el último, así que ganaba el del intento anterior
            en vez del que acaba de renderizar el servidor — lo contrario de lo que este comentario
            promete.
          */}
          <input type="hidden" name="barrioId" value={barrioId} />
          <Campos>
            <CampoTexto
              nombre="periodo"
              tipo="month"
              etiqueta="Mes que se liquida"
              requerido
              errores={campos["periodo"]}
              valorInicial={previos["periodo"]}
              ayuda="El mes al que corresponden los gastos, no el mes en que se cobra. Es lo que sale impreso en la boleta y lo que ordena el listado."
            />
            <CampoTexto
              nombre="primerVencimiento"
              tipo="date"
              etiqueta="Primer vencimiento"
              errores={campos["primerVencimiento"]}
              valorInicial={previos["primerVencimiento"]}
              ayuda="Se puede dejar vacío y cargarlo después: un período sin vencimiento se liquida igual."
            />
            <CampoTexto
              nombre="segundoVencimiento"
              tipo="date"
              etiqueta="Segundo vencimiento"
              errores={campos["segundoVencimiento"]}
              valorInicial={previos["segundoVencimiento"]}
              ayuda="El de recargo, si el barrio lo usa. No puede ser anterior al primero."
            />
            <CampoParrafo
              nombre="notas"
              etiqueta="Notas internas"
              maximo={2000}
              ancho
              errores={campos["notas"]}
              valorInicial={previos["notas"]}
              ayuda="Para el equipo de administración. No sale en la boleta."
            />
          </Campos>

          <Avisos>
            {resultado.estado === "falla" ? (
              <AvisoDeFallo error={resultado.error} salidas={salidas} />
            ) : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>

          <Acciones ayuda="El período nace en borrador: se puede editar, cargar gastos y regenerar el cálculo tantas veces como haga falta hasta que se emita.">
            <BotonEnviar pendiente={pendiente} cargando="Creando el período…">
              Crear el período
            </BotonEnviar>
          </Acciones>
        </>
      )}
    </Formulario>
  );
}
