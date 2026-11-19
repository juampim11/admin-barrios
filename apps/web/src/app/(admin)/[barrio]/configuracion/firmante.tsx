"use client";

/**
 * «Quién firma los convenios por el barrio» (Configuración del barrio, junto a los datos legales; F4
 * tramo 3, BL-053 b, `0100`). Lo usa el PDF del convenio de un plan de pagos, en la frase de las partes y
 * en el bloque de firmas; sin firmante, el convenio sale como antes. El texto que imprime lleva «Texto a
 * validar por el estudio».
 *
 * Ninguna regla vive acá: qué pide cada opción lo dice `guardarFirmanteDelConvenioSchema`, y la base lo
 * vuelve a controlar.
 */

import { useState } from "react";
import { BotonCancelar } from "@admin-barrios/ui/cliente/boton-de-accion";
import { AvisoEnLinea, TextoDeOrigen } from "@admin-barrios/ui";
import { SIN_FIRMANTE, TEXTO_TIPO_DE_FIRMANTE, TIPOS_DE_FIRMANTE, type TipoDeFirmante } from "@admin-barrios/shared/planes";
import { guardarFirmanteDelConvenioAction } from "../../../../acciones/planes.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  Campos,
  CampoSeleccion,
  CampoTexto,
  Formulario,
  useFormulario,
} from "../../../../componentes/formulario.tsx";

export function FormularioDelFirmante({
  barrioId,
  esSociedadAnonima,
  firmante,
}: {
  readonly barrioId: string;
  /** Para avisar (sin bloquear) si se elige «presidente del directorio» en un barrio que no es una S.A. */
  readonly esSociedadAnonima: boolean;
  readonly firmante: { readonly tipo: TipoDeFirmante; readonly nombre: string; readonly cargo: string | null; readonly poder: string | null } | null;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(guardarFirmanteDelConvenioAction);
  const [tipo, setTipo] = useState<string>(previos["tipo"] ?? firmante?.tipo ?? SIN_FIRMANTE);

  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo="Listo: quedó guardado quién firma los convenios.">
        <p>Lo usan los convenios que se armen desde ahora. Los PDF que ya se armaron no cambian.</p>
      </AvisoDeExito>
    );
  }

  return (
    <Formulario accion={enviar} etiqueta="Quién firma los convenios por el barrio">
      <input type="hidden" name="barrioId" value={barrioId} />
      <p>
        <TextoDeOrigen>
          Va en el convenio de cada plan de pagos: en el párrafo de las partes y en las firmas. El texto lleva «Texto a validar por el
          estudio».
        </TextoDeOrigen>
      </p>
      <Campos>
        <CampoSeleccion
          nombre="tipo"
          etiqueta="Quién firma"
          requerido
          sinSeleccion="Elegí"
          opciones={[
            { valor: SIN_FIRMANTE, texto: "Sin cargar (el convenio sale como hasta ahora)" },
            ...TIPOS_DE_FIRMANTE.map((t) => ({ valor: t, texto: TEXTO_TIPO_DE_FIRMANTE[t] })),
          ]}
          valorInicial={tipo}
          alCambiar={setTipo}
          errores={campos["tipo"]}
          ancho
        />
        {tipo !== SIN_FIRMANTE ? (
          <CampoTexto
            nombre="nombre"
            etiqueta="Nombre"
            requerido
            maximo={200}
            errores={campos["nombre"]}
            valorInicial={previos["nombre"] ?? firmante?.nombre ?? ""}
          />
        ) : null}
        {tipo === "administrador_poder" ? (
          <CampoTexto
            nombre="poder"
            etiqueta="Referencia del poder"
            requerido
            maximo={300}
            ancho
            errores={campos["poder"]}
            valorInicial={previos["poder"] ?? firmante?.poder ?? ""}
            ayuda="Número, fecha y escribanía, tal como figuran. Por ejemplo: Esc. N.º 123 del 05/03/2024, Escribanía Pérez."
          />
        ) : null}
        {tipo === "otro" ? (
          <CampoTexto
            nombre="cargo"
            etiqueta="Cargo"
            requerido
            maximo={120}
            errores={campos["cargo"]}
            valorInicial={previos["cargo"] ?? firmante?.cargo ?? ""}
          />
        ) : null}
      </Campos>
      {tipo === "presidente_directorio" && !esSociedadAnonima ? (
        <AvisoEnLinea tono="info">
          El barrio no figura como sociedad anónima: revisá con el estudio si corresponde «presidente del directorio» o si conviene «Otro», con
          el cargo como figura.
        </AvisoEnLinea>
      ) : null}
      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>
      <Acciones>
        <BotonCancelar deshabilitado={pendiente} />
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Guardar
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}
