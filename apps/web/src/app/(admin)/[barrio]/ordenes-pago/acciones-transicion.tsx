"use client";

/**
 * Las cuatro transiciones de una orden de pago, compartidas entre la grilla (`page.tsx`) y el detalle
 * (`[orden]/page.tsx`) — un solo lugar donde se arman, para que las dos pantallas no diverjan.
 *
 * **Aprobar/Rechazar abren un diálogo de confirmación** (`DialogoDeConfirmacion`, encargo 8 T1 §6):
 * aprobar suma un gasto al período de la orden y el diálogo dice en qué mes, cuánto y a quién;
 * rechazar pide el motivo (`0067`).
 *
 * **Marcar pagada y Anular van adentro de un `<details>`**, no detrás de un botón directo, por el
 * mismo motivo que `AnularAplicacion` (`liquidacion/[periodo]/cargos/formularios.tsx`): las dos piden
 * un dato más (medio de pago, motivo) y Anular además es irreversible. El despliegue es el paso
 * deliberado que separa el click accidental del acto. Es `<details>` nativo — se abre con teclado, no
 * atrapa el foco, funciona sin JavaScript. Llevan «Cancelar» (`BotonCancelar`), que lo cierra sin
 * guardar (encargo 8, T1 §2).
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
import { Cifra } from "../../../../componentes/ui.tsx";
import { BarraDeAcciones } from "@admin-barrios/ui";
import { BotonCancelar } from "@admin-barrios/ui/cliente/boton-de-accion";
import {
  DatoDeConsecuencia,
  DialogoDeConfirmacion,
  ListaDeConsecuencias,
} from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";
import estilos from "./ordenes-pago.module.css";

const OPCIONES_MEDIO_PAGO: readonly Opcion[] = Object.entries(MEDIO_PAGO_OP).map(([valor, texto]) => ({
  valor,
  texto,
}));

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Aprobar / Rechazar
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que la pantalla ya leyó de la orden y el diálogo repite antes de confirmar. Lo arma el servidor
 * (`page.tsx`): el nombre del proveedor y el del período salen de los catálogos del barrio, el monto
 * de la propia fila. Nada se calcula acá.
 */
export type OrdenParaConfirmar = {
  readonly ordenPagoId: string;
  readonly proveedor: string;
  readonly monto: string;
  /** «Noviembre 2026» (`nombreDelPeriodo`), o `null` si el período no se pudo leer. */
  readonly periodo: string | null;
};

/**
 * Aprobar, con confirmación (encargo 8, T1 §6). Aprobar es decidir gastar: la base genera en ese
 * momento el gasto en el período de la orden (`app.orden_pago_transicion()`, `0044`/`0067`), así que
 * el diálogo dice **en qué mes suma**, cuánto y a nombre de quién.
 */
export function BotonAprobar({ orden, salidas }: { readonly orden: OrdenParaConfirmar; readonly salidas: Salidas }) {
  const { enviar, pendiente, resultado } = useFormulario(aprobarOrdenPagoAction);
  return (
    <DialogoDeConfirmacion
      disparador="Aprobar"
      varianteDisparador="primario"
      etiquetaDisparador={`Aprobar la orden de ${orden.proveedor}`}
      titulo="Aprobar la orden de pago"
      accion={enviar}
      textoConfirmar="Aprobar la orden"
      textoPendiente="Aprobando…"
      pendiente={pendiente}
      cerrarCon={resultado.estado === "ok" ? resultado : null}
    >
      <input type="hidden" name="ordenPagoId" value={orden.ordenPagoId} />
      <ListaDeConsecuencias>
        <li>
          Se suma un gasto de{" "}
          <DatoDeConsecuencia>
            <Cifra monto={orden.monto} nulo="—" />
          </DatoDeConsecuencia>{" "}
          a nombre de <strong>{orden.proveedor}</strong>{" "}
          {orden.periodo ? (
            <>
              en el período <strong>{orden.periodo}</strong>.
            </>
          ) : (
            "en el período de la orden."
          )}
        </li>
        <li>Si ese período ya no se puede editar, la orden no se aprueba y no se suma nada.</li>
        <li>Una orden aprobada ya no se rechaza: si después no corresponde, se anula con su motivo.</li>
      </ListaDeConsecuencias>
      <div aria-live="polite">
        {resultado.estado === "falla" ? <AvisoDeFalloCompacto error={resultado.error} salidas={salidas} /> : null}
      </div>
    </DialogoDeConfirmacion>
  );
}

/**
 * Rechazar, con motivo obligatorio (migración `0067`: `rechazarOrdenPagoSchema` exige `motivo`). El
 * motivo se pide en el diálogo y queda en el detalle de la orden. Rechazar no mueve plata, y lo dice.
 */
export function BotonRechazar({ orden, salidas }: { readonly orden: OrdenParaConfirmar; readonly salidas: Salidas }) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(rechazarOrdenPagoAction);
  return (
    <DialogoDeConfirmacion
      disparador="Rechazar"
      varianteDisparador="secundario"
      etiquetaDisparador={`Rechazar la orden de ${orden.proveedor}`}
      titulo="Rechazar la orden de pago"
      accion={enviar}
      textoVolver="Cancelar"
      textoConfirmar="Rechazar la orden"
      varianteConfirmar="peligro"
      textoPendiente="Rechazando…"
      pendiente={pendiente}
      cerrarCon={resultado.estado === "ok" ? resultado : null}
    >
      <input type="hidden" name="ordenPagoId" value={orden.ordenPagoId} />
      <ListaDeConsecuencias>
        <li>
          La orden de <strong>{orden.proveedor}</strong> por{" "}
          <DatoDeConsecuencia>
            <Cifra monto={orden.monto} nulo="—" />
          </DatoDeConsecuencia>{" "}
          no se paga y no suma ningún gasto{" "}
          {orden.periodo ? (
            <>
              al período <strong>{orden.periodo}</strong>.
            </>
          ) : (
            "al período."
          )}
        </li>
        <li>No se deshace: si hacía falta, se carga una orden nueva.</li>
      </ListaDeConsecuencias>
      <CampoParrafo
        nombre="motivo"
        etiqueta="Motivo del rechazo"
        requerido
        maximo={500}
        filas={2}
        errores={campos["motivo"]}
        valorInicial={previos["motivo"]}
        ayuda="Queda en el detalle de la orden. Contá en una frase por qué no se paga."
      />
      <div aria-live="polite">
        {resultado.estado === "falla" ? <AvisoDeFalloCompacto error={resultado.error} salidas={salidas} /> : null}
      </div>
    </DialogoDeConfirmacion>
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
        <BarraDeAcciones alineacion="derecha">
          <BotonCancelar deshabilitado={pendiente} />
          <BotonEnviar tono="primario" pendiente={pendiente} cargando="Confirmando…">
            Confirmar pago
          </BotonEnviar>
        </BarraDeAcciones>
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
        <BarraDeAcciones alineacion="derecha">
          <BotonCancelar deshabilitado={pendiente} />
          <BotonEnviar tono="peligro" pendiente={pendiente} cargando="Anulando…">
            Anular definitivamente
          </BotonEnviar>
        </BarraDeAcciones>
      </form>
    </details>
  );
}
