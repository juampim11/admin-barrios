"use client";

/**
 * «Cambiar los vencimientos» del barrio (Configuración, «Datos del barrio»; `0078`, encargo 15). Es
 * la única parte de ese panel que manda JavaScript, y solo se dibuja para quien puede editar el
 * padrón (`puedeEditarPadron`): la autorización real la hace el servicio.
 *
 * Ninguna regla vive acá: los rangos (día 1 a 28, hasta 60 días de segundo vencimiento, hasta 180
 * de corte) los dice `vencimientosDelBarrioSchema`, y un campo vacío es «no usa» porque así lo lee
 * el esquema.
 */

import { BotonCancelar } from "@admin-barrios/ui/cliente/boton-de-accion";
import { TextoDeOrigen } from "@admin-barrios/ui";
import { cambiarVencimientosDelBarrioAction } from "../../../../acciones/padron.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  Campos,
  CampoTexto,
  Formulario,
  useFormulario,
} from "../../../../componentes/formulario.tsx";

const texto = (n: number | null): string => (n === null ? "" : String(n));

export function FormularioDeVencimientos({
  barrioId,
  diaVencimiento,
  diasSegundoVencimiento,
  diasCorte,
}: {
  readonly barrioId: string;
  readonly diaVencimiento: number | null;
  readonly diasSegundoVencimiento: number | null;
  readonly diasCorte: number | null;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(cambiarVencimientosDelBarrioAction);

  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo="Listo: los vencimientos del barrio quedaron guardados.">
        <p>Rigen para los meses que se abran desde ahora. El cambio queda registrado, con el valor anterior.</p>
      </AvisoDeExito>
    );
  }

  return (
    <Formulario accion={enviar} etiqueta="Cambiar los vencimientos del barrio">
      <input type="hidden" name="barrioId" value={barrioId} />
      <p>
        <TextoDeOrigen>
          Rigen para los meses que se abran desde ahora. Un mes que ya está abierto se cambia en sus propios
          vencimientos, desde Liquidación. El segundo vencimiento lleva el mismo importe que el primero.
        </TextoDeOrigen>
      </p>
      <Campos>
        <CampoTexto
          nombre="diaVencimiento"
          etiqueta="Día del primer vencimiento"
          requerido
          maximo={2}
          modoDeTeclado="numeric"
          errores={campos["diaVencimiento"]}
          valorInicial={previos["diaVencimiento"] ?? texto(diaVencimiento)}
          ayuda="Del 1 al 28: así existe en todos los meses."
        />
        <CampoTexto
          nombre="diasSegundoVencimiento"
          etiqueta="Días hasta el segundo vencimiento"
          maximo={2}
          modoDeTeclado="numeric"
          errores={campos["diasSegundoVencimiento"]}
          valorInicial={previos["diasSegundoVencimiento"] ?? texto(diasSegundoVencimiento)}
          ayuda="Días corridos después del primero. Vacío: no usa segundo vencimiento."
        />
        <CampoTexto
          nombre="diasCorte"
          etiqueta="Días de corte"
          maximo={3}
          modoDeTeclado="numeric"
          errores={campos["diasCorte"]}
          valorInicial={previos["diasCorte"] ?? texto(diasCorte)}
          ayuda="Hasta cuántos días después del último vencimiento se puede pagar. Vacío: sin corte."
        />
      </Campos>
      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>
      <Acciones>
        <BotonCancelar deshabilitado={pendiente} />
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Guardar los vencimientos
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}
