"use client";

/**
 * Aprobar o rechazar un plan a medida pendiente (P2a-2; maqueta de planes, pantalla 3, «Enviar a
 * aprobación»), desde la ficha de la unidad.
 *
 * Aprobar firma el plan con la deuda de hoy: la quita se recalcula (la mora siguió corriendo desde que
 * se propuso). Si el barrio exige el acta para una quita y todavía no se cargó, el diálogo la pide; sin
 * ella, la base no deja aprobarlo (`0095`). Rechazar lleva motivo.
 */

import { useState } from "react";
import { formatearMonto, type Monto } from "@admin-barrios/shared/dinero";
import { CONTENT_TYPES_COMPROBANTE } from "@admin-barrios/shared/cobros";
import { AvisoEnLinea, RenglonDelResultado, TarjetaDelResultado } from "@admin-barrios/ui";
import { DialogoDeConfirmacion } from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";
import { aprobarPlanAction, rechazarPlanAction } from "../../acciones/planes.ts";
import { AvisoDeFallo, Avisos, CampoArchivo, CampoParrafo, Campos, CampoTexto, ConfirmacionEnLinea, useFormulario } from "../formulario.tsx";
import { useSubidaDeRespaldo } from "../useSubidaDeRespaldo.ts";

const TIPOS_ACEPTADOS = CONTENT_TYPES_COMPROBANTE.join(",");
const pesos = (m: Monto) => `$ ${formatearMonto(m)}`;

export type PlanParaAprobar = {
  readonly id: string;
  readonly barrioId: string;
  readonly unidad: string;
  readonly deuda: Monto;
  /** «septiembre 2026», «junio a octubre 2026». */
  readonly meses: string;
  readonly totalCuotas: Monto;
  readonly quita: Monto;
  readonly quitaInteres: Monto;
  readonly quitaCapital: Monto;
  /**
   * El barrio exige el acta para una quita y todavía no se cargó. Se mira aunque la quita guardada sea
   * cero: al aprobar se recalcula con la deuda de hoy y puede aparecer (code-reviewer, 1).
   */
  readonly faltaActa: boolean;
  readonly actaReferencia: string | null;
};

export function AprobarPlan({ plan, subidaConfigurada }: { readonly plan: PlanParaAprobar; readonly subidaConfigurada: boolean }) {
  const { enviar, pendiente, resultado, campos, previos, confirmacion } = useFormulario(aprobarPlanAction);
  const subida = useSubidaDeRespaldo(plan.barrioId);
  const subiendo = subida.estado.fase === "pidiendoUrl" || subida.estado.fase === "subiendo";
  const conQuita = plan.quita !== "0.00";
  // Sin la referencia del acta (cuando falta) no se manda: la base lo rechazaría igual.
  const [referencia, setReferencia] = useState("");
  // Obligatoria si ya hay quita; si no, se ofrece igual (opcional) por si aparece una al recalcular.
  const actaObligatoria = plan.faltaActa && conQuita;
  const faltaReferencia = actaObligatoria && referencia.trim().length < 3;
  return (
    <DialogoDeConfirmacion
      disparador="Aprobar el plan"
      varianteDisparador="secundario"
      etiquetaDisparador={`Aprobar el plan a medida de ${plan.unidad}`}
      titulo={`Aprobar el plan a medida de ${plan.unidad}`}
      accion={enviar}
      textoConfirmar="Aprobar el plan"
      textoPendiente="Aprobando…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
      confirmarDeshabilitado={subiendo || faltaReferencia}
      motivoDeshabilitado={faltaReferencia ? "Falta la referencia del acta." : subiendo ? "Esperando que termine de subir el acta." : undefined}
      ancho="ancho"
    >
      <input type="hidden" name="planId" value={plan.id} />
      <TarjetaDelResultado
        titulo={conQuita ? "Se perdona" : "Total del plan"}
        resultado={conQuita ? pesos(plan.quita) : pesos(plan.totalCuotas)}
        negativo={conQuita}
        lectura={
          conQuita
            ? "Calculado con la deuda del día en que se propuso. Al aprobarlo se recalcula con la de hoy, porque el interés siguió corriendo."
            : "Cubre toda la deuda: no se perdona nada."
        }
      >
        <RenglonDelResultado etiqueta={`Deuda que entra (${plan.meses})`} valor={pesos(plan.deuda)} />
        <RenglonDelResultado etiqueta="Suma del cronograma" valor={pesos(plan.totalCuotas)} />
        {conQuita ? (
          <>
            <RenglonDelResultado etiqueta="· de interés" valor={pesos(plan.quitaInteres)} />
            <RenglonDelResultado etiqueta="· de capital" valor={pesos(plan.quitaCapital)} />
          </>
        ) : null}
      </TarjetaDelResultado>
      <p>Al aprobarlo, los meses pasan al plan y dejan de generar mora, y la unidad sale del estudio si estaba derivada.</p>
      {plan.faltaActa ? (
        <>
          {actaObligatoria ? (
            <AvisoEnLinea tono="alerta">
              Para perdonar, el barrio exige el acta de aprobación (de la comisión directiva, el directorio o la asamblea). Cargá su
              referencia para aprobar el plan.
            </AvisoEnLinea>
          ) : (
            <AvisoEnLinea tono="info">
              Hoy no se perdona nada, pero al aprobarlo se recalcula con la deuda de hoy: si el interés siguió corriendo puede
              aparecer una quita, y para eso el barrio exige el acta. Si la tenés, cargala.
            </AvisoEnLinea>
          )}
          <Campos>
            <CampoTexto
              nombre="actaReferencia"
              etiqueta="Referencia del acta"
              requerido={actaObligatoria}
              maximo={300}
              ancho
              valorInicial={previos["actaReferencia"]}
              alCambiar={setReferencia}
              errores={campos["actaReferencia"]}
              ayuda="Número y fecha, o dónde se encuentra."
            />
            {subidaConfigurada ? (
              <CampoArchivo
                nombre="actaAdjunto"
                etiqueta="El acta"
                ancho
                aceptar={TIPOS_ACEPTADOS}
                estado={subida.estado}
                onElegirArchivo={subida.elegirArchivo}
                onReintentar={subida.reintentar}
                errores={campos["actaAdjunto"]}
                ayuda="PDF o foto (JPG o PNG). Opcional."
              />
            ) : null}
          </Campos>
        </>
      ) : plan.actaReferencia ? (
        <p>Acta: {plan.actaReferencia}.</p>
      ) : null}
      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {/* F4 tramo 2: la unidad está derivada; aprobar la saca del estudio. */}
        {resultado.estado === "confirmar" && confirmacion ? <ConfirmacionEnLinea error={resultado.error} confirmacion={confirmacion} pendiente={pendiente} /> : null}
      </Avisos>
    </DialogoDeConfirmacion>
  );
}

export function RechazarPlan({ planId, unidad }: { readonly planId: string; readonly unidad: string }) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(rechazarPlanAction);
  return (
    <DialogoDeConfirmacion
      disparador="Rechazar"
      varianteDisparador="sutil"
      etiquetaDisparador={`Rechazar el plan a medida de ${unidad}`}
      titulo={`Rechazar el plan a medida de ${unidad}`}
      accion={enviar}
      textoConfirmar="Rechazar el plan"
      varianteConfirmar="peligro"
      textoPendiente="Rechazando…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
    >
      <input type="hidden" name="planId" value={planId} />
      <p>El plan queda rechazado, con su motivo, y la deuda de la unidad sigue como estaba.</p>
      <Campos>
        <CampoParrafo
          nombre="motivo"
          etiqueta="Motivo"
          requerido
          maximo={500}
          filas={2}
          ancho
          valorInicial={previos["motivo"]}
          errores={campos["motivo"]}
          ayuda="Queda registrado en el plan."
        />
      </Campos>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </DialogoDeConfirmacion>
  );
}
