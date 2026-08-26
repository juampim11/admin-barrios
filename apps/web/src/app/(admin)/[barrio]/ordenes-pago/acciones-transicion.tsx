"use client";

/**
 * Las cuatro transiciones de una orden de pago, compartidas entre la grilla (`page.tsx`) y el detalle
 * (`[orden]/page.tsx`) — un solo lugar donde se arman, para que las dos pantallas no diverjan.
 *
 * **Aprobar/Rechazar son un botón directo**: no piden nada más que el id, así que un formulario de un
 * solo campo oculto alcanza — mismo patrón que `BotonQuitarGasto`.
 *
 * **Marcar pagada y Anular van adentro de un `<details>`**, no detrás de un botón directo, por el
 * mismo motivo que `AnularAplicacion` (`liquidacion/[periodo]/cargos/formularios.tsx`): las dos piden
 * un dato más (medio de pago, motivo) y Anular además es irreversible. El despliegue es el paso
 * deliberado que separa el click accidental del acto. Es `<details>` nativo — se abre con teclado, no
 * atrapa el foco, funciona sin JavaScript — y **no un modal**: el prototipo clickeable aprobado
 * (`/design`, 2026-08-21) usaba un overlay, pero `packages/ui` no tiene ningún componente de diálogo
 * y agregar uno para esto sería scope nuevo sin pedir — se calca el patrón que el repo ya tiene.
 *
 * **Cada botón está ausente si el flag `puedeXxx` correspondiente es `false`, nunca deshabilitado**
 * (doc 06 §c.6.4): los cuatro flags los calcula `listarOrdenesPago()` con la misma condición exacta
 * que `app.orden_pago_transicion()` (`0044`), así que la pantalla nunca ofrece un botón que la base
 * vaya a rechazar.
 */

import {
  anularOrdenPagoAction,
  aprobarOrdenPagoAction,
  marcarPagadaAction,
  rechazarOrdenPagoAction,
} from "../../../../acciones/ordenes-pago.ts";
import {
  AvisoDeFalloCompacto,
  BotonEnviar,
  CampoParrafo,
  CampoSeleccion,
  SoloLectores,
  useFormulario,
  type Opcion,
  type Salidas,
} from "../../../../componentes/formulario.tsx";
import { MEDIO_PAGO_OP } from "../../../../componentes/etiquetas.tsx";
import estilos from "./ordenes-pago.module.css";

const OPCIONES_MEDIO_PAGO: readonly Opcion[] = Object.entries(MEDIO_PAGO_OP).map(([valor, texto]) => ({
  valor,
  texto,
}));

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Aprobar / Rechazar
// ────────────────────────────────────────────────────────────────────────────────────────────────

export function BotonAprobar({
  ordenPagoId,
  salidas,
}: {
  readonly ordenPagoId: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado } = useFormulario(aprobarOrdenPagoAction);
  return (
    <form action={enviar} className={estilos.formularioEnLinea}>
      <input type="hidden" name="ordenPagoId" value={ordenPagoId} />
      <BotonEnviar tono="primario" pendiente={pendiente} cargando="Aprobando…">
        Aprobar
      </BotonEnviar>
      <div aria-live="polite">
        {resultado.estado === "falla" ? (
          <AvisoDeFalloCompacto error={resultado.error} salidas={salidas} />
        ) : null}
      </div>
    </form>
  );
}

export function BotonRechazar({
  ordenPagoId,
  salidas,
}: {
  readonly ordenPagoId: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado } = useFormulario(rechazarOrdenPagoAction);
  return (
    <form action={enviar} className={estilos.formularioEnLinea}>
      <input type="hidden" name="ordenPagoId" value={ordenPagoId} />
      <BotonEnviar tono="secundario" pendiente={pendiente} cargando="Rechazando…">
        Rechazar
      </BotonEnviar>
      <div aria-live="polite">
        {resultado.estado === "falla" ? (
          <AvisoDeFalloCompacto error={resultado.error} salidas={salidas} />
        ) : null}
      </div>
    </form>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Marcar pagada
// ────────────────────────────────────────────────────────────────────────────────────────────────

export function AccionMarcarPagada({
  ordenPagoId,
  salidas,
}: {
  readonly ordenPagoId: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos } = useFormulario(marcarPagadaAction);

  return (
    <details className={estilos.accionDespliegue}>
      <summary>
        Marcar pagada
        <SoloLectores> la orden</SoloLectores>
      </summary>
      <form action={enviar} className={estilos.accionCuerpo}>
        <input type="hidden" name="ordenPagoId" value={ordenPagoId} />
        <CampoSeleccion
          nombre="medioPago"
          etiqueta="Medio de pago"
          requerido
          opciones={OPCIONES_MEDIO_PAGO}
          sinSeleccion="Elegí cómo se pagó…"
          errores={campos["medioPago"]}
          ayuda="Cómo se ejecutó este pago puntual."
        />
        <div aria-live="polite">
          {resultado.estado === "falla" ? (
            <AvisoDeFalloCompacto error={resultado.error} salidas={salidas} />
          ) : null}
        </div>
        <BotonEnviar tono="primario" pendiente={pendiente} cargando="Confirmando…">
          Confirmar pago
        </BotonEnviar>
      </form>
    </details>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Anular
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Calco de `AnularAplicacion` (`liquidacion/[periodo]/cargos/formularios.tsx`): el motivo es
 *  obligatorio y la anulación es irreversible — el mismo `<details>` deliberado. */
export function AccionAnular({
  ordenPagoId,
  salidas,
}: {
  readonly ordenPagoId: string;
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos } = useFormulario(anularOrdenPagoAction);

  return (
    <details className={estilos.accionDespliegue}>
      <summary>
        Anular
        <SoloLectores> la orden</SoloLectores>
      </summary>
      <form action={enviar} className={estilos.accionCuerpo}>
        <input type="hidden" name="ordenPagoId" value={ordenPagoId} />
        <p className={estilos.accionAviso}>
          Anular <strong>no se deshace</strong>. Si la orden ya generó su gasto del período, el
          sistema lo revierte o genera el ajuste correspondiente — nunca se edita el gasto ya
          liquidado.
        </p>
        <CampoParrafo
          nombre="motivo"
          etiqueta="Motivo de la anulación"
          requerido
          maximo={500}
          filas={2}
          errores={campos["motivo"]}
          ayuda="Mínimo cinco caracteres. Contá en una frase por qué se anula."
        />
        <div aria-live="polite">
          {resultado.estado === "falla" ? (
            <AvisoDeFalloCompacto error={resultado.error} salidas={salidas} />
          ) : null}
        </div>
        <BotonEnviar tono="peligro" pendiente={pendiente} cargando="Anulando…">
          Anular definitivamente
        </BotonEnviar>
      </form>
    </details>
  );
}
