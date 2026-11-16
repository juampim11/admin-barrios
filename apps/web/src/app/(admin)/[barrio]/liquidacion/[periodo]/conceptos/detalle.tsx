"use client";

/**
 * «Ver» el detalle de un concepto del mes, unidad por unidad (encargo 16b; pantalla 4 de la maqueta).
 * Es una isla porque es un diálogo, con una acción adentro; **los datos los resolvió la página en el
 * servidor** (`conceptosDelMes`) y llegan ya en palabras: acá no se calcula ningún importe ni se
 * decide a quién va nada.
 *
 * De cada unidad se ve el importe, el detalle que sale en la boleta y, si vino de una planilla, cada
 * uso con su fecha.
 *
 * **«Anular» solo está en lo aplicado a mano** y solo si quien mira puede cargar (`puedeAnular`, que
 * la página arma con lo que dice el servicio; la autorización real la hace el servicio). Lo que entra
 * solo lo decide su regla, y lo de una planilla se corrige con la planilla. Anular pide un motivo, no
 * se deshace, y se abre de a una, debajo de su renglón.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { BotonDeAccion } from "@admin-barrios/ui/cliente/boton-de-accion";
import { DialogoDeDetalle } from "@admin-barrios/ui/cliente/dialogo-de-detalle";
import { anularAplicacionAction } from "../../../../../../acciones/liquidacion.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeFalloCompacto,
  Avisos,
  BotonEnviar,
  CampoTexto,
  Campos,
  Formulario,
  SoloLectores,
  useFormulario,
} from "../../../../../../componentes/formulario.tsx";
import { MarcoTabla, Tabla, ui } from "../../../../../../componentes/ui.tsx";
import { SE_CALCULA_AL_EMITIR, usoConFecha, type OrigenDelConcepto } from "./textos.ts";
import estilos from "./conceptos.module.css";

export type AplicacionParaVer = {
  /** `null` cuando todavía no existe: un concepto que se aplica solo, antes de calcular el mes. */
  readonly aplicacionId: string | null;
  readonly unidadFuncionalId: string;
  readonly unidad: string;
  /** Ya en palabras («$ 12.000,00», «-$ 3.500,00»). `null` = se calcula al emitir. */
  readonly importe: string | null;
  readonly detalle: string | null;
  readonly usos: readonly { readonly fecha: string; readonly cantidad: string }[];
};

export function DetalleDelConcepto({
  mes,
  nombre,
  origen,
  resumen,
  deDonde,
  puedeAnular,
  rutaBoletas,
  aplicaciones,
}: {
  /** «noviembre 2026». */
  readonly mes: string;
  readonly nombre: string;
  readonly origen: OrigenDelConcepto;
  /** A quién va, cuántas unidades y cuánto suma, en un renglón. */
  readonly resumen: string;
  readonly deDonde: string;
  readonly puedeAnular: boolean;
  /** La pestaña Boletas, donde se le da o se le quita la bonificación a una unidad. */
  readonly rutaBoletas: string;
  readonly aplicaciones: readonly AplicacionParaVer[];
}) {
  const [abierta, setAbierta] = useState<string | null>(null);
  const cerrar = () => setAbierta(null);
  const conUsos = aplicaciones.some((a) => a.usos.length > 0);
  const columnas = 3 + (conUsos ? 1 : 0) + (puedeAnular ? 1 : 0);

  return (
    <DialogoDeDetalle
      disparador="Ver"
      etiquetaDisparador={`Ver el detalle de ${nombre} por unidad`}
      titulo={`${nombre} · ${mes}`}
      pie={
        origen === "bonificacion" ? (
          <>
            Para dársela o quitársela a una unidad, andá a <a href={rutaBoletas}>Boletas</a> y abrí «Ver quién».
          </>
        ) : puedeAnular ? (
          "Lo aplicado no se edita: se anula con un motivo y se aplica de nuevo."
        ) : origen === "sola" ? (
          "Se aplica solo: a quién va se cambia en Conceptos del barrio."
        ) : origen === "planilla" ? (
          "Entró por planilla: cada uso queda con la planilla de la que vino."
        ) : undefined
      }
    >
      <p>
        {resumen}
        <br />
        <span className={ui.secundaria}>{deDonde}</span>
      </p>

      <MarcoTabla etiqueta={`${nombre}, unidad por unidad`}>
        <Tabla>
          <thead>
            <tr>
              <th scope="col">Unidad</th>
              <th scope="col" className={ui.numerica}>
                Importe
              </th>
              <th scope="col">Detalle</th>
              {conUsos ? <th scope="col">Usos</th> : null}
              {puedeAnular ? <th scope="col">Acción</th> : null}
            </tr>
          </thead>
          <tbody>
            {aplicaciones.map((a) => {
              const clave = a.aplicacionId ?? a.unidadFuncionalId;
              return (
                <FilasDeUnidad
                  key={clave}
                  aplicacion={a}
                  conUsos={conUsos}
                  columnas={columnas}
                  accion={
                    puedeAnular && a.aplicacionId ? (
                      <BotonDeAccion
                        variante="sutil"
                        tamano="sm"
                        etiqueta={`Anular ${nombre} de ${a.unidad}`}
                        onClick={() => setAbierta(clave)}
                      >
                        Anular
                      </BotonDeAccion>
                    ) : null
                  }
                  formulario={
                    puedeAnular && a.aplicacionId && abierta === clave ? (
                      <FormularioDeAnulacion
                        // El mes no viaja: el servicio lo deriva de la aplicación, bajo RLS.
                        aplicacionId={a.aplicacionId}
                        descripcion={`${nombre} de ${a.unidad}`}
                        alTerminar={cerrar}
                      />
                    ) : null
                  }
                  mostrarAccion={puedeAnular}
                />
              );
            })}
          </tbody>
        </Tabla>
      </MarcoTabla>
    </DialogoDeDetalle>
  );
}

/** El renglón de una unidad y, si está abierto, el de su formulario debajo. */
function FilasDeUnidad({
  aplicacion: a,
  conUsos,
  columnas,
  accion,
  formulario,
  mostrarAccion,
}: {
  readonly aplicacion: AplicacionParaVer;
  readonly conUsos: boolean;
  readonly columnas: number;
  readonly accion: ReactNode;
  readonly formulario: ReactNode;
  readonly mostrarAccion: boolean;
}) {
  return (
    <>
      <tr>
        <th scope="row">{a.unidad}</th>
        <td className={ui.numerica}>
          {a.importe === null ? <span className={ui.secundaria}>{SE_CALCULA_AL_EMITIR}</span> : <span className="dinero">{a.importe}</span>}
        </td>
        <td>{a.detalle ?? <span className={ui.secundaria}>—</span>}</td>
        {conUsos ? (
          <td>
            {a.usos.length === 0 ? (
              <span className={ui.secundaria}>—</span>
            ) : (
              <span className={estilos.apilado}>
                {a.usos.map((u, i) => (
                  // Los usos solo se agregan y vienen en orden de fecha: el índice es estable.
                  <span key={i}>{usoConFecha(u, null)}</span>
                ))}
              </span>
            )}
          </td>
        ) : null}
        {mostrarAccion ? <td>{accion}</td> : null}
      </tr>
      {formulario ? (
        <tr>
          <td colSpan={columnas}>{formulario}</td>
        </tr>
      ) : null}
    </>
  );
}

/** El motivo de la anulación. Qué es un motivo válido lo dice `anularAplicacionSchema`. */
function FormularioDeAnulacion({
  aplicacionId,
  descripcion,
  alTerminar,
}: {
  readonly aplicacionId: string;
  readonly descripcion: string;
  readonly alTerminar: () => void;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(anularAplicacionAction);

  const terminar = useRef(alTerminar);
  terminar.current = alTerminar;
  useEffect(() => {
    if (resultado.estado === "ok") terminar.current();
  }, [resultado]);

  return (
    <Formulario accion={enviar} etiqueta={`Anular ${descripcion}`}>
      <input type="hidden" name="aplicacionId" value={aplicacionId} />
      <p className={ui.secundaria}>
        Anular <strong>no se deshace</strong>: si hay que cobrar otra cosa, se anula y se aplica de nuevo. El motivo queda
        guardado como explicación de por qué no se cobró.
      </p>
      <Campos>
        <CampoTexto
          nombre="motivo"
          etiqueta={
            <>
              Motivo<SoloLectores> de anular {descripcion}</SoloLectores>
            </>
          }
          requerido
          maximo={500}
          ancho
          errores={campos["motivo"]}
          valorInicial={previos["motivo"]}
          ayuda="Contá en una frase por qué se anula."
        />
      </Campos>
      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFalloCompacto error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>
      <Acciones>
        <BotonDeAccion variante="sutil" deshabilitado={pendiente} onClick={alTerminar}>
          Cancelar
        </BotonDeAccion>
        <BotonEnviar tono="peligro" pendiente={pendiente} cargando="Anulando…">
          Anular definitivamente
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}
