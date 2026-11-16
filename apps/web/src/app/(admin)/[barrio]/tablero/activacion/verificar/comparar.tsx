"use client";

/**
 * «Según el sistema anterior» (encargo 17, pantalla 3 de la maqueta): un campo donde la
 * administración escribe la cifra que tiene en su sistema anterior, **solo para comparar**.
 *
 * ⚠ **No se guarda ni viaja al servidor.** No está adentro de ningún formulario y no llama a ninguna
 * acción: lo tipeado vive en el estado de esta isla y se pierde al salir de la pantalla. Es una ayuda
 * para mirar, no un dato del barrio.
 *
 * La comparación la hace `compararConElSistemaAnterior` (`../textos.ts`), en centavos enteros.
 */

import { useState } from "react";
import { CampoMonto } from "../../../../../../componentes/formulario.tsx";
import { IconoCorrecto, IconoFaltante } from "../../../../../../componentes/iconos.tsx";
import { compararConElSistemaAnterior } from "../textos.ts";
import estilos from "../activacion.module.css";

export function CompararConElSistemaAnterior({
  nombre,
  delSistema,
  queSeCompara,
}: {
  /** Distingue los dos campos de la pantalla. No es el nombre de un dato que se envíe. */
  readonly nombre: string;
  /** La cifra del sistema, canónica («1250000.00»). */
  readonly delSistema: string;
  /** «el capital adeudado», «el interés»: para la ayuda del campo. */
  readonly queSeCompara: string;
}) {
  const [tipeado, setTipeado] = useState("");
  const comparacion = compararConElSistemaAnterior(delSistema, tipeado);

  return (
    <>
      {/* El campo de importe avisa el canónico («1250000.00») mientras se escribe. */}
      <CampoMonto
        nombre={nombre}
        etiqueta="Según el sistema anterior"
        alCambiar={setTipeado}
        ayuda={`Escribí ${queSeCompara} que te da el sistema anterior, para comparar. No se guarda.`}
      />
      <p
        className={`${estilos.resultadoDeComparar} ${comparacion.estado === "coincide" ? estilos.pasoHecho : estilos.pasoPendiente}`}
        aria-live="polite"
      >
        {comparacion.estado === "vacio" ? null : (
          <>
            <span className={estilos.resultadoIcono} aria-hidden>
              {comparacion.estado === "coincide" ? <IconoCorrecto /> : <IconoFaltante />}
            </span>
            {comparacion.texto}
          </>
        )}
      </p>
    </>
  );
}
