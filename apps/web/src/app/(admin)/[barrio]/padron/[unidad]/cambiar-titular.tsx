"use client";

/**
 * «Cambiar titular» desde la ficha de la unidad (diálogo de la maqueta aprobada
 * `alta-barrio-padron.html`). Se abre en el lugar, como la condonación; si el documento ya es de
 * otra persona del barrio, la confirmación («¿Es la misma persona?») reemplaza al formulario.
 *
 * El aviso de la deuda es el de la maqueta, **sin invocar la ley**: que la deuda siga con la unidad
 * es lo que hace el sistema (ADR-0010 §4); el encuadre por figura jurídica es de `legal-ph` y no se
 * afirma en pantalla.
 *
 * Ninguna regla vive acá: que la fecha no sea futura ni anterior a los titulares actuales, y quién
 * puede, lo deciden el servicio y la base.
 */

import { TIPOS_OBLIGADO } from "@admin-barrios/shared/barrio";
import { CONTENT_TYPES_COMPROBANTE } from "@admin-barrios/shared/cobros";
import { aCentavos, formatearMonto } from "@admin-barrios/shared/dinero";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import {
  ETIQUETA_MOTIVO_CAMBIO_TITULAR,
  ETIQUETA_RESPALDO_TITULAR,
  MOTIVOS_CAMBIO_TITULAR,
  TIPOS_RESPALDO_TITULAR,
} from "@admin-barrios/shared/escrituras";
import { cambiarTitularAction } from "../../../../../acciones/padron.ts";
import { TIPO_OBLIGADO } from "../../../../../componentes/etiquetas.tsx";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoArchivo,
  CampoParrafo,
  CampoSeleccion,
  Campos,
  CampoTexto,
  Formulario,
  PedidoDeConfirmacion,
  useFormulario,
} from "../../../../../componentes/formulario.tsx";
import { useSubidaDeRespaldo } from "../../../../../componentes/useSubidaDeRespaldo.ts";
import { Nota } from "../../../../../componentes/ui.tsx";

const TIPOS_ACEPTADOS = CONTENT_TYPES_COMPROBANTE.join(",");

/** Lo que dice la pantalla sobre la deuda. Solo lee el signo del saldo que trajo el servidor. */
function AvisoDeDeuda({ deuda }: { readonly deuda: string }) {
  if (aCentavos(deuda) > 0n) {
    return (
      <Nota tono="alerta">
        La unidad debe <strong className="dinero">$ {formatearMonto(deuda)}</strong>. La deuda <strong>sigue con la unidad</strong>: la
        boleta siguiente le llega al nuevo titular con ese saldo.
      </Nota>
    );
  }
  return (
    <Nota tono="info">
      La unidad no tiene deuda a hoy. Su saldo sigue con la unidad, no con el titular: la boleta siguiente le llega al nuevo titular.
    </Nota>
  );
}

export function FormularioCambiarTitular({
  barrioId,
  unidadFuncionalId,
  etiqueta,
  hoy,
  deuda,
}: {
  readonly barrioId: string;
  readonly unidadFuncionalId: string;
  readonly etiqueta: string;
  /** Hoy en la zona del barrio (`AAAA-MM-DD`): el valor inicial de «Desde». */
  readonly hoy: string;
  /** El saldo de la cuenta corriente de la unidad, monto canónico. */
  readonly deuda: string;
}) {
  const { enviar, pendiente, resultado, campos, previos, confirmacion, volverACorregir } =
    useFormulario(cambiarTitularAction);
  const subida = useSubidaDeRespaldo(barrioId);

  if (resultado.estado === "ok") {
    const { cerrados } = resultado.valor;
    return (
      <AvisoDeExito titulo={`Listo: ${etiqueta} tiene titular nuevo.`}>
        <p>
          {cerrados === 0
            ? "No tenía titulares vigentes."
            : cerrados === 1
              ? "El titular anterior quedó en «Titulares anteriores», hasta el día previo al cambio."
              : `Los ${cerrados} titulares anteriores quedaron en «Titulares anteriores», hasta el día previo al cambio.`}{" "}
          La deuda sigue con la unidad.
        </p>
      </AvisoDeExito>
    );
  }

  const subiendo = subida.estado.fase === "pidiendoUrl" || subida.estado.fase === "subiendo";

  return (
    <Formulario accion={enviar} etiqueta={`Cambiar titular de ${etiqueta}`}>
      {confirmacion && resultado.estado === "confirmar" ? (
        <PedidoDeConfirmacion
          onVolver={volverACorregir}
          error={resultado.error}
          confirmacion={confirmacion}
          valores={resultado.valores}
          pendiente={pendiente}
        />
      ) : (
        <>
          <input type="hidden" name="unidadFuncionalId" value={unidadFuncionalId} />
          <Campos>
            <CampoTexto
              nombre="desde"
              tipo="date"
              etiqueta="Desde"
              requerido
              errores={campos["desde"]}
              valorInicial={previos["desde"] ?? hoy}
              ayuda={`Los titulares actuales quedan en el historial hasta el día anterior. Hoy es ${formatearFecha(hoy)}.`}
            />
            <CampoTexto
              nombre="titular.nombre"
              etiqueta="Nuevo titular"
              requerido
              maximo={200}
              errores={campos["titular.nombre"]}
              valorInicial={previos["titular.nombre"]}
              ayuda="Nombre o razón social."
            />
            <CampoTexto
              nombre="titular.documento"
              etiqueta="CUIT, CUIL o DNI"
              maximo={20}
              errores={campos["titular.documento"]}
              valorInicial={previos["titular.documento"]}
            />
            <CampoTexto
              nombre="titular.mail"
              etiqueta="Mail"
              maximo={120}
              errores={campos["titular.mail"]}
              valorInicial={previos["titular.mail"]}
            />
            <CampoSeleccion
              nombre="titular.caracter"
              etiqueta="Carácter"
              requerido
              opciones={TIPOS_OBLIGADO.map((t) => ({ valor: t, texto: TIPO_OBLIGADO[t] }))}
              sinSeleccion="Elegí el carácter…"
              errores={campos["titular.caracter"]}
              valorInicial={previos["titular.caracter"] ?? "propietario"}
            />
            <CampoSeleccion
              nombre="motivo"
              etiqueta="Motivo"
              requerido
              opciones={MOTIVOS_CAMBIO_TITULAR.map((m) => ({ valor: m, texto: ETIQUETA_MOTIVO_CAMBIO_TITULAR[m] }))}
              sinSeleccion="Elegí el motivo…"
              errores={campos["motivo"]}
              valorInicial={previos["motivo"]}
            />
            <CampoParrafo
              nombre="detalle"
              etiqueta="Detalle"
              ancho
              maximo={500}
              errores={campos["detalle"]}
              valorInicial={previos["detalle"]}
            />
            <CampoSeleccion
              nombre="respaldoTipo"
              etiqueta="Respaldo"
              opciones={TIPOS_RESPALDO_TITULAR.map((t) => ({ valor: t, texto: ETIQUETA_RESPALDO_TITULAR[t] }))}
              sinSeleccion="Sin respaldo"
              errores={campos["respaldoTipo"]}
              valorInicial={previos["respaldoTipo"]}
              ayuda="Opcional: escritura, boleto o nota."
            />
            <CampoTexto
              nombre="respaldoReferencia"
              etiqueta="Referencia del respaldo"
              maximo={300}
              errores={campos["respaldoReferencia"]}
              valorInicial={previos["respaldoReferencia"]}
              ayuda="Dónde se encuentra: escribano, fecha o número."
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
          <AvisoDeDeuda deuda={deuda} />
          <Avisos>
            {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
            {campos[""] || campos["titular"] ? <AvisoDeCamposSueltos mensajes={[...(campos[""] ?? []), ...(campos["titular"] ?? [])]} /> : null}
          </Avisos>
          <Acciones ayuda={subiendo ? "Esperando que termine de subir el adjunto." : undefined}>
            <BotonEnviar pendiente={pendiente} deshabilitado={subiendo} cargando="Cambiando…">
              Cambiar titular
            </BotonEnviar>
          </Acciones>
        </>
      )}
    </Formulario>
  );
}
