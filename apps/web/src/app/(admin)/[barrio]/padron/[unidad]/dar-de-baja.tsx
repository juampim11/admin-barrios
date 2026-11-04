"use client";

/**
 * «Dar de baja» desde la ficha de la unidad (diálogo de la maqueta aprobada
 * `alta-barrio-padron.html`). Se abre en el lugar, como la condonación.
 *
 * La lista de consecuencias es la de la maqueta; el período sale del servidor
 * (`leerBarrioDelPadron().proximoPeriodo`), no se calcula acá. Que la deuda quede y que el código no
 * se reutilice lo garantizan el servicio y la base (`0059`, `0065`).
 */

import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { ETIQUETA_MOTIVO_BAJA, MOTIVOS_BAJA } from "@admin-barrios/shared/escrituras";
import { BotonCancelar } from "@admin-barrios/ui/cliente/boton-de-accion";
import { darDeBajaAction } from "../../../../../acciones/padron.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoParrafo,
  CampoSeleccion,
  Campos,
  Formulario,
  useFormulario,
} from "../../../../../componentes/formulario.tsx";
import estilos from "./ficha.module.css";

export function FormularioDarDeBaja({
  unidadFuncionalId,
  etiqueta,
  proximoPeriodo,
}: {
  readonly unidadFuncionalId: string;
  readonly etiqueta: string;
  /** `AAAA-MM`: el período desde el que no recibe boleta. */
  readonly proximoPeriodo: string;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(darDeBajaAction);

  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo={`Listo: ${etiqueta} quedó dada de baja.`}>
        <p>
          No recibe boleta desde el período {formatearPeriodo(resultado.valor.sinBoletaDesde)}. Su historia, sus pagos y su deuda
          quedan en la ficha.
        </p>
      </AvisoDeExito>
    );
  }

  return (
    <Formulario accion={enviar} etiqueta={`Dar de baja ${etiqueta}`}>
      <input type="hidden" name="unidadFuncionalId" value={unidadFuncionalId} />
      <Campos>
        <CampoSeleccion
          nombre="motivo"
          etiqueta="Motivo"
          requerido
          opciones={MOTIVOS_BAJA.map((m) => ({ valor: m, texto: ETIQUETA_MOTIVO_BAJA[m] }))}
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
          ayuda="Por ejemplo: se unificó con Mza 1 · Lote 5 (plano del 10/10/2026). Al menos 10 caracteres: queda en el historial."
        />
      </Campos>
      <ul className={estilos.consecuencias}>
        <li>No recibe boleta desde el período {formatearPeriodo(proximoPeriodo)}.</li>
        <li>Su historia, sus pagos y su deuda quedan; la deuda se sigue pudiendo cobrar.</li>
        <li>Su código de pago no se reutiliza.</li>
      </ul>
      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>
      <Acciones>
        <BotonCancelar deshabilitado={pendiente} />
        <BotonEnviar tono="peligro" pendiente={pendiente} cargando="Dando de baja…">
          Dar de baja
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}
