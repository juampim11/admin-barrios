"use client";

/**
 * «Editar» desde la ficha de la unidad (diálogo «Editar» de la maqueta aprobada
 * `alta-barrio-padron.html`). Se abre en el lugar (`AccionDesplegable`), como la condonación.
 *
 * Manzana y lote no están: identifican la unidad (lo dice la nota de la maqueta). El CBU y el alias
 * de la unidad van solo en un barrio con una cuenta por unidad.
 *
 * **El saldo inicial ya no se edita acá** (encargo 17): la deuda de antes del sistema se trae mes por
 * mes al activar el barrio, no como un saldo de la unidad.
 *
 * ⚠ **Pero el valor actual viaja siempre, oculto**: `editarUnidad` reescribe la columna con lo que
 * llega (y un campo ausente lo dejaría en cero). Una unidad que ya tenía un saldo inicial lo conserva.
 */

import { ESTADOS_UNIDAD } from "@admin-barrios/shared/barrio";
import { BotonCancelar } from "@admin-barrios/ui/cliente/boton-de-accion";
import { editarUnidadAction } from "../../../../../acciones/padron.ts";
import { ESTADO_UNIDAD } from "../../../../../componentes/etiquetas.tsx";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoSeleccion,
  Campos,
  CampoTexto,
  Formulario,
  useFormulario,
} from "../../../../../componentes/formulario.tsx";
import { Nota } from "../../../../../componentes/ui.tsx";
import { CamposDelResidente, CamposDeNumeroDeAccion, type ValoresInformativos } from "../campos-informativos.tsx";

export function FormularioEditarUnidad({
  unidadFuncionalId,
  cuentaPorUnidad,
  superficie,
  estado,
  nomenclatura,
  cbu,
  alias,
  saldoInicial,
  mailPrincipal,
  numeroAccion,
  residente,
}: {
  readonly unidadFuncionalId: string;
  readonly cuentaPorUnidad: boolean;
  /** Ya con coma decimal («605,00»): el esquema acepta las dos formas. */
  readonly superficie: string;
  readonly estado: string;
  readonly nomenclatura: string;
  readonly cbu: string;
  readonly alias: string;
  /** Monto canónico («48200.00»). No se edita: viaja oculto para que guardar no lo pise. */
  readonly saldoInicial: string;
  readonly mailPrincipal: string;
  /** `""` si no tiene. Vacío al guardar = se borra (`0078`). */
  readonly numeroAccion: string;
  /** El residente informativo actual, campo por campo (`""` = sin cargar). */
  readonly residente: { readonly nombre: string; readonly caracter: string; readonly telefono: string; readonly mail: string };
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
  const actuales: ValoresInformativos = {
    numeroAccion,
    residenteNombre: residente.nombre,
    residenteCaracter: residente.caracter,
    residenteTelefono: residente.telefono,
    residenteMail: residente.mail,
  };

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
        <CamposDeNumeroDeAccion errores={campos["numeroAccion"]} valorInicial={inicial("numeroAccion", numeroAccion)} />
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
        <CamposDelResidente campos={campos} inicial={(c) => inicial(c, actuales[c])} />
      </Campos>
      {/* El valor que ya tiene la unidad, tal cual: `editarUnidad` reescribe la columna con lo que llega. */}
      <input type="hidden" name="saldoInicial" value={saldoInicial} />
      <Nota tono="info">
        Manzana y lote no se editan: identifican la unidad. Si estaban mal cargados, se da de baja y se agrega de nuevo.
      </Nota>
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
