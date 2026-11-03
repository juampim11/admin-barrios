"use client";

/**
 * «Editar» desde la ficha de la unidad (diálogo «Editar» de la maqueta aprobada
 * `alta-barrio-padron.html`). Se abre en el lugar (`AccionDesplegable`), como la condonación.
 *
 * Manzana y lote no están: identifican la unidad (lo dice la nota de la maqueta). El CBU y el alias
 * de la unidad van solo en un barrio con una cuenta por unidad, y el saldo inicial solo mientras la
 * unidad no tenga una liquidación emitida (`saldoInicialEditable`, lo calcula el servicio).
 *
 * ⚠ **El saldo inicial viaja siempre**, editable o no: `editarUnidad` reescribe la columna con lo que
 * llega (y un campo ausente lo dejaría en cero). Cuando no se edita, va oculto con el valor actual.
 */

import { ESTADOS_UNIDAD } from "@admin-barrios/shared/barrio";
import { TextoDeOrigen } from "@admin-barrios/ui";
import { editarUnidadAction } from "../../../../../acciones/padron.ts";
import { ESTADO_UNIDAD } from "../../../../../componentes/etiquetas.tsx";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoMonto,
  CampoSeleccion,
  Campos,
  CampoTexto,
  Formulario,
  useFormulario,
} from "../../../../../componentes/formulario.tsx";
import { Cifra, Nota } from "../../../../../componentes/ui.tsx";

export function FormularioEditarUnidad({
  unidadFuncionalId,
  cuentaPorUnidad,
  superficie,
  estado,
  nomenclatura,
  cbu,
  alias,
  saldoInicial,
  saldoInicialEditable,
  mailPrincipal,
}: {
  readonly unidadFuncionalId: string;
  readonly cuentaPorUnidad: boolean;
  /** Ya con coma decimal («605,00»): el esquema acepta las dos formas. */
  readonly superficie: string;
  readonly estado: string;
  readonly nomenclatura: string;
  readonly cbu: string;
  readonly alias: string;
  /** Monto canónico («48200.00»). */
  readonly saldoInicial: string;
  readonly saldoInicialEditable: boolean;
  readonly mailPrincipal: string;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(editarUnidadAction);

  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo="Listo: la unidad quedó actualizada.">
        <p>El cambio queda en el historial de la ficha.</p>
      </AvisoDeExito>
    );
  }

  const inicial = (campo: string, actual: string) => previos[campo] ?? actual;

  return (
    <Formulario accion={enviar} etiqueta="Editar la unidad">
      <input type="hidden" name="unidadFuncionalId" value={unidadFuncionalId} />
      <Campos>
        <CampoTexto
          nombre="superficie"
          etiqueta="Superficie (m²)"
          maximo={12}
          errores={campos["superficie"]}
          valorInicial={inicial("superficie", superficie)}
        />
        <CampoSeleccion
          nombre="estado"
          etiqueta="Estado"
          requerido
          opciones={ESTADOS_UNIDAD.map((e) => ({ valor: e, texto: ESTADO_UNIDAD[e] }))}
          sinSeleccion="Elegí el estado…"
          errores={campos["estado"]}
          valorInicial={inicial("estado", estado)}
        />
        <CampoTexto
          nombre="nomenclatura"
          etiqueta="Nomenclatura catastral"
          maximo={60}
          errores={campos["nomenclatura"]}
          valorInicial={inicial("nomenclatura", nomenclatura)}
        />
        <CampoTexto
          nombre="mailPrincipal"
          etiqueta="Mail principal"
          maximo={120}
          errores={campos["mailPrincipal"]}
          valorInicial={inicial("mailPrincipal", mailPrincipal)}
          ayuda="El de quien recibe la boleta."
        />
        {cuentaPorUnidad ? (
          <>
            <CampoTexto
              nombre="cbu"
              etiqueta="CBU de la unidad"
              modoDeTeclado="numeric"
              maximo={30}
              errores={campos["cbu"]}
              valorInicial={inicial("cbu", cbu)}
              ayuda="La cuenta hija del recaudador. Se valida."
            />
            <CampoTexto nombre="alias" etiqueta="Alias de la unidad" maximo={20} errores={campos["alias"]} valorInicial={inicial("alias", alias)} />
          </>
        ) : null}
        {saldoInicialEditable ? (
          <CampoMonto
            nombre="saldoInicial"
            etiqueta="Saldo inicial"
            errores={campos["saldoInicial"]}
            valorInicial={inicial("saldoInicial", saldoInicial)}
            ayuda="La deuda que trae de antes del sistema. Se puede corregir hasta que se emita su primera liquidación."
          />
        ) : null}
      </Campos>
      {saldoInicialEditable ? null : (
        <>
          <input type="hidden" name="saldoInicial" value={saldoInicial} />
          <p>
            <TextoDeOrigen>
              Saldo inicial: <Cifra monto={saldoInicial} nulo="—" />. Ya no se edita: la unidad tiene una liquidación emitida.
            </TextoDeOrigen>
          </p>
        </>
      )}
      <Nota tono="info">
        Manzana y lote no se editan: identifican la unidad. Si estaban mal cargados, se da de baja y se agrega de nuevo.
      </Nota>
      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>
      <Acciones>
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Guardar
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}
