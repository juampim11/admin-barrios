"use client";

/**
 * Los dos formularios de la pantalla de gastos: cargar uno, y quitar uno ya cargado.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTA PANTALLA TIENE QUE DECIR Y ES FÁCIL NO DECIR
 *
 * **Una extraordinaria sin acta se carga igual, y vuelve marcada.** No es un caso raro: una bomba que
 * se rompe no espera a la asamblea (doc 08 §A.0 punto 2). El sistema no lo impide y la pantalla
 * tampoco — lo que hace es avisarlo **en el acto**, con `sinRespaldoAsamblea` releído de lo que
 * escribió el trigger `app.gasto_respaldo_extraordinaria`, no de lo que la pantalla supone. Que el
 * aviso llegue al segundo y no tres pasos después, en la revisión, es la diferencia entre corregirlo
 * ahora y descubrirlo cuando ya salió la boleta.
 *
 * **No hay campo de acta**, y es una decisión de alcance, no un olvido: la subida de documentos no
 * entra en este incremento (ADR-0002 §8) y `acta_documento_id` sigue viniendo del seed. Dibujar un
 * selector de actas vacío sería peor que no tenerlo — parecería que se puede y no se puede.
 *
 * **Un gasto no se corrige desde acá: se quita y se carga de nuevo.** Existe `corregirGasto` en el
 * servicio, pero no puede cambiar el concepto —cambiar el concepto cambia el tipo, el encuadre fiscal
 * y si es fondo de reserva, o sea que es otro gasto—, así que una edición parcial dejaría un
 * formulario que promete más de lo que hace. Mientras el período está en borrador, borrar y volver a
 * cargar es barato y no destruye ninguna evidencia: ese gasto todavía no llegó a la boleta de nadie.
 */

import { useActionState } from "react";
import type { ConceptoDeGasto } from "@admin-barrios/data/servicios/gastos";
import { borrarGastoAction, registrarGastoAction } from "../../../../../../acciones/liquidacion.ts";
import { confirmacionDe } from "../../../../../../acciones/confirmacion.ts";
import { INICIAL } from "../../../../../../acciones/resultado.ts";
import {
  Acciones,
  Avisos,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  AvisoDeFalloCompacto,
  AvisoDeMarca,
  BotonEnviar,
  CampoMonto,
  CampoSeleccion,
  CampoTexto,
  Campos,
  Formulario,
  PedidoDeConfirmacion,
  SoloLectores,
  useFocoEnElPrimerError,
  type Opcion,
  type Salidas,
} from "../../../../../../componentes/formulario.tsx";
import { etiquetaTipoConcepto } from "../../../../../../componentes/etiquetas.tsx";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Cargar un gasto
// ────────────────────────────────────────────────────────────────────────────────────────────────

export function FormularioDeGasto({
  periodoId,
  conceptos,
  salidas,
}: {
  readonly periodoId: string;
  readonly conceptos: readonly ConceptoDeGasto[];
  readonly salidas: Salidas;
}) {
  const [resultado, enviar, pendiente] = useActionState(registrarGastoAction, INICIAL);
  useFocoEnElPrimerError(resultado);

  const campos = resultado.estado === "campos" ? resultado.campos : {};
  const previos = resultado.estado === "inicial" || resultado.estado === "ok" ? {} : resultado.valores;
  const confirmacion = resultado.estado === "confirmar" ? confirmacionDe(resultado.error.codigo) : null;

  /*
   * Los conceptos, agrupados por tipo. Los **inactivos van deshabilitados y no ocultos**: el servicio
   * los devuelve a propósito porque un período viejo puede tener gastos de un concepto que después se
   * desactivó, y esconderlos acá haría creer que nunca existieron. Deshabilitado dice las dos cosas:
   * existe, y no se puede usar hoy.
   */
  const opciones: readonly Opcion[] = conceptos.map((c) => ({
    valor: c.id,
    texto: `${c.nombre}${c.esFondoReserva ? " · fondo de reserva" : ""}${c.activo ? "" : " (inactivo)"}`,
    grupo: etiquetaTipoConcepto(c.tipo),
    deshabilitada: !c.activo,
  }));

  return (
    <Formulario accion={enviar} etiqueta="Cargar un gasto en el período">
      <input type="hidden" name="periodoId" value={periodoId} />

      {confirmacion && resultado.estado === "confirmar" ? (
        <PedidoDeConfirmacion
          error={resultado.error}
          confirmacion={confirmacion}
          valores={resultado.valores}
          pendiente={pendiente}
        />
      ) : (
        <>
          <Campos>
            <CampoSeleccion
              nombre="conceptoId"
              etiqueta="Concepto"
              requerido
              opciones={opciones}
              sinSeleccion="Elegí a qué concepto imputarlo…"
              errores={campos["conceptoId"]}
              valorInicial={previos["conceptoId"]}
              ayuda="Decide si el gasto es ordinario o extraordinario, cómo se encuadra fiscalmente y si va al fondo de reserva. No se puede cambiar después: si te equivocás, quitá el gasto y cargalo de nuevo."
            />
            <CampoMonto
              nombre="monto"
              etiqueta="Monto del gasto (en pesos)"
              requerido
              errores={campos["monto"]}
              valorInicial={previos["monto"]}
              ayuda="Con punto y dos decimales, como en la factura: 1234.56. Va a prorratearse entre las unidades según su coeficiente."
            />
            <CampoTexto
              nombre="descripcion"
              etiqueta="Descripción"
              requerido
              maximo={300}
              ancho
              errores={campos["descripcion"]}
              valorInicial={previos["descripcion"]}
              ayuda="Qué se pagó, en las palabras con las que lo va a buscar quien audite el mes dentro de un año."
            />
            <CampoTexto
              nombre="proveedorNombre"
              etiqueta="Proveedor"
              maximo={200}
              errores={campos["proveedorNombre"]}
              valorInicial={previos["proveedorNombre"]}
              ayuda="A quién se le pagó."
            />
            <CampoTexto
              nombre="comprobante"
              etiqueta="Comprobante"
              maximo={100}
              errores={campos["comprobante"]}
              valorInicial={previos["comprobante"]}
              ayuda="Número de factura o recibo. Es lo que conecta esta fila con el papel."
            />
          </Campos>

          <Avisos>
            {resultado.estado === "ok" ? <AcuseDeGasto gasto={resultado.valor} /> : null}
            {resultado.estado === "falla" ? (
              <AvisoDeFallo error={resultado.error} salidas={salidas} />
            ) : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>

          <Acciones ayuda="No se sube el acta desde acá: la carga de documentos no está en esta versión. Un gasto extraordinario sin acta se carga igual y queda marcado.">
            <BotonEnviar pendiente={pendiente} cargando="Cargando el gasto…">
              Cargar el gasto
            </BotonEnviar>
          </Acciones>
        </>
      )}
    </Formulario>
  );
}

/**
 * El acuse del alta.
 *
 * `sinRespaldoAsamblea` **no lo decide esta pantalla**: lo escribió el trigger de la base al insertar
 * y el servicio lo devolvió releído. Por eso el aviso se puede afirmar en presente ("quedó marcado")
 * en vez de anticipar lo que probablemente pase.
 */
function AcuseDeGasto({ gasto }: { readonly gasto: { readonly sinRespaldoAsamblea: boolean } }) {
  if (!gasto.sinRespaldoAsamblea) {
    return <AvisoDeExito titulo="El gasto quedó cargado en el período." />;
  }
  return (
    <AvisoDeMarca titulo="El gasto quedó cargado, y marcado como extraordinario sin respaldo de asamblea.">
      No bloquea nada: se puede seguir cargando, generar el borrador y emitir. Lo que condiciona es el{" "}
      <strong>reclamo de la deuda</strong>, porque una extraordinaria sin acta es más difícil de
      exigir. Va a aparecer marcado en el resumen del período y en la revisión, hasta que se le
      asocie el acta.
    </AvisoDeMarca>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Quitar un gasto
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Quitar una fila. Un formulario por fila, con su propio estado.
 *
 * **Por qué uno por fila y no uno compartido para toda la tabla:** el error tiene que aparecer donde
 * está la fila. Un aviso arriba de una tabla de veinte gastos que dice "no se pudo quitar" obliga a
 * reconstruir de cuál se estaba hablando, y el estado "esperando" compartido apagaría los veinte
 * botones cuando solo uno está trabajando.
 *
 * **No lleva confirmación**, y es deliberado. El período está en borrador y ese gasto todavía no
 * llegó a la boleta de nadie: volver a cargarlo cuesta treinta segundos. Ponerle un diálogo a algo
 * reversible enseña a apretar "sí" sin leer, y esa costumbre después llega al botón de emitir, que es
 * donde de verdad no hay vuelta atrás.
 */
export function BotonQuitarGasto({
  gastoId,
  descripcion,
  salidas,
}: {
  readonly gastoId: string;
  readonly descripcion: string;
  readonly salidas: Salidas;
}) {
  const [resultado, enviar, pendiente] = useActionState(borrarGastoAction, INICIAL);

  return (
    <form action={enviar}>
      <input type="hidden" name="gastoId" value={gastoId} />
      <BotonEnviar tono="peligro" pendiente={pendiente} cargando="Quitando…">
        Quitar
        {/* El nombre del gasto va al lector de pantalla: veinte botones que dicen solo "Quitar" son
            veinte botones indistinguibles cuando se navega por la lista de controles. */}
        <SoloLectores> el gasto {descripcion}</SoloLectores>
      </BotonEnviar>
      <div aria-live="polite">
        {resultado.estado === "falla" ? (
          <AvisoDeFalloCompacto error={resultado.error} salidas={salidas} />
        ) : null}
        {resultado.estado === "campos" ? (
          <AvisoDeCamposSueltos mensajes={Object.values(resultado.campos).flatMap((m) => m ?? [])} />
        ) : null}
      </div>
    </form>
  );
}
