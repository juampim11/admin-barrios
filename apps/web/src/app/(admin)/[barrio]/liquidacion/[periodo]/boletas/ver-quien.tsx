"use client";

/**
 * «Ver quién» recibe la bonificación por pago en término del mes (encargo 16; pantalla 5 de la
 * maqueta). Es una isla porque es un diálogo con acciones adentro; **los datos los resolvió la página
 * en el servidor** (`bonificacionDelMes`) y llegan agrupados (`detalleDeBonificacion`): acá no se
 * evalúa quién está al día ni se calcula ningún importe.
 *
 * Las unidades al día se muestran en un solo renglón («212 unidades — Al día, la reciben»): listarlas
 * una por una taparía lo que se viene a mirar, que son las excepciones y las que no la reciben.
 *
 * Las tres acciones —«Dársela igual», «Quitar» y «Sacar la excepción»— piden un motivo y se abren de
 * a una, debajo de su renglón. Solo se ofrecen si quien mira puede (`puedeExceptuar`, del servicio: la
 * administración del barrio, antes de emitir); la autorización real la hace el servicio.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Chip } from "@admin-barrios/ui";
import { BotonDeAccion } from "@admin-barrios/ui/cliente/boton-de-accion";
import { DialogoDeDetalle } from "@admin-barrios/ui/cliente/dialogo-de-detalle";
import {
  ponerExcepcionDeBonificacionAction,
  sacarExcepcionDeBonificacionAction,
  type ExcepcionDeBonificacionEscrita,
} from "../../../../../../acciones/liquidacion.ts";
import type { ResultadoDeAccion } from "../../../../../../acciones/resultado.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeFalloCompacto,
  Avisos,
  BotonEnviar,
  CampoSeleccion,
  CampoTexto,
  Campos,
  Formulario,
  SoloLectores,
  useFormulario,
} from "../../../../../../componentes/formulario.tsx";
import { MarcoTabla, Panel, Tabla, TiraDeChips, ui } from "../../../../../../componentes/ui.tsx";
import type { DetalleDeBonificacion } from "./textos.ts";

type Accion = (
  previo: ResultadoDeAccion<ExcepcionDeBonificacionEscrita>,
  form: FormData,
) => Promise<ResultadoDeAccion<ExcepcionDeBonificacionEscrita>>;

/** Qué formulario está abierto: el de una unidad de la lista, o ninguno. */
type Abierta = { readonly unidadFuncionalId: string; readonly que: "dar" | "sacar" } | null;

const unidades = (n: number): string => (n === 1 ? "1 unidad" : `${n} unidades`);

export function VerQuienRecibeLaBonificacion({
  periodoId,
  mes,
  frase,
  cuantoTexto,
  emitido,
  puedeExceptuar,
  detalle,
}: {
  readonly periodoId: string;
  /** «noviembre 2026». */
  readonly mes: string;
  /** A qué fecha se miró quién está al día, ya en palabras. */
  readonly frase: string;
  /** «7,5 % de la expensa, hasta $ 20.000,00 por unidad». */
  readonly cuantoTexto: string | null;
  readonly emitido: boolean;
  /** Quien mira puede cargar y sacar excepciones (la administración, antes de emitir). */
  readonly puedeExceptuar: boolean;
  readonly detalle: DetalleDeBonificacion;
}) {
  const [abierta, setAbierta] = useState<Abierta>(null);
  const cerrar = () => setAbierta(null);
  const columnas = puedeExceptuar ? 3 : 2;

  return (
    <DialogoDeDetalle
      disparador="Ver quién"
      etiquetaDisparador="Ver quién recibe la bonificación por pago en término"
      titulo={`Bonificación por pago en término · ${mes}`}
      pie={
        puedeExceptuar
          ? "«Dársela igual» y «Quitar» piden un motivo y quedan en el historial de la unidad."
          : emitido
            ? "El mes está emitido: es lo que quedó en las boletas."
            : "Darle o quitarle la bonificación a una unidad lo decide la administración del barrio, hasta emitir."
      }
    >
      <p>
        {frase}
        {cuantoTexto ? <> Se bonifica {cuantoTexto}.</> : null}
      </p>

      <MarcoTabla etiqueta="Quién recibe la bonificación">
        <Tabla>
          <thead>
            <tr>
              <th scope="col">Unidad</th>
              <th scope="col">Situación</th>
              {puedeExceptuar ? <th scope="col">Acción</th> : null}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">{unidades(detalle.alDia)}</th>
              <td>
                <TiraDeChips>
                  <Chip tono="exito">Al día</Chip>
                  <span>{detalle.alDia === 1 ? "la recibe" : "la reciben"}</span>
                </TiraDeChips>
              </td>
              {puedeExceptuar ? <td /> : null}
            </tr>

            {detalle.excepciones.map((e) => (
              <FilasDeUnidad
                key={e.unidadFuncionalId}
                etiqueta={e.etiqueta}
                columnas={columnas}
                situacion={
                  <>
                    <TiraDeChips>
                      <Chip tono="info">Excepción</Chip>
                      <span>{e.recibe ? "la recibe" : "no la recibe"}</span>
                      {e.importe ? <span className={ui.secundaria}>{e.importe}</span> : null}
                    </TiraDeChips>
                    {e.detalle ? <span className={ui.secundaria}>{e.detalle}</span> : null}
                  </>
                }
                accion={
                  puedeExceptuar ? (
                    <BotonDeAccion
                      variante="sutil"
                      tamano="sm"
                      etiqueta={`Sacar la excepción de ${e.etiqueta}`}
                      onClick={() => setAbierta({ unidadFuncionalId: e.unidadFuncionalId, que: "sacar" })}
                    >
                      Sacar la excepción
                    </BotonDeAccion>
                  ) : null
                }
                formulario={
                  abierta?.unidadFuncionalId === e.unidadFuncionalId && abierta.que === "sacar" ? (
                    <FormularioDeExcepcion
                      accion={sacarExcepcionDeBonificacionAction}
                      periodoId={periodoId}
                      unidadFuncionalId={e.unidadFuncionalId}
                      etiqueta={`Sacar la excepción de ${e.etiqueta}`}
                      explicacion={`${e.etiqueta} vuelve a la regla: la recibe si está al día al emitir.`}
                      textoEnviar="Sacar la excepción"
                      alTerminar={cerrar}
                    />
                  ) : null
                }
              />
            ))}

            {detalle.sinBonificacion.map((u) => (
              <FilasDeUnidad
                key={u.unidadFuncionalId}
                etiqueta={u.etiqueta}
                columnas={columnas}
                situacion={
                  <TiraDeChips>
                    <Chip tono="alerta">{u.debe}</Chip>
                    <span>no la recibe</span>
                    {u.importe ? <span className={ui.secundaria}>{u.importe}</span> : null}
                  </TiraDeChips>
                }
                accion={
                  puedeExceptuar ? (
                    <BotonDeAccion
                      variante="sutil"
                      tamano="sm"
                      etiqueta={`Darle igual la bonificación a ${u.etiqueta}`}
                      onClick={() => setAbierta({ unidadFuncionalId: u.unidadFuncionalId, que: "dar" })}
                    >
                      Dársela igual
                    </BotonDeAccion>
                  ) : null
                }
                formulario={
                  abierta?.unidadFuncionalId === u.unidadFuncionalId && abierta.que === "dar" ? (
                    <FormularioDeExcepcion
                      accion={ponerExcepcionDeBonificacionAction}
                      periodoId={periodoId}
                      unidadFuncionalId={u.unidadFuncionalId}
                      tipo="dar"
                      etiqueta={`Darle igual la bonificación a ${u.etiqueta}`}
                      explicacion={`${u.etiqueta} recibe la bonificación de ${mes} aunque no esté al día.`}
                      textoEnviar="Dársela igual"
                      alTerminar={cerrar}
                    />
                  ) : null
                }
              />
            ))}
          </tbody>
        </Tabla>
      </MarcoTabla>

      {puedeExceptuar && detalle.paraQuitar.length > 0 ? (
        <Panel titulo="Quitársela a una unidad que está al día">
          <FormularioDeExcepcion
            accion={ponerExcepcionDeBonificacionAction}
            periodoId={periodoId}
            tipo="quitar"
            elegirEntre={detalle.paraQuitar}
            etiqueta="Quitarle la bonificación a una unidad que está al día"
            explicacion={`La unidad elegida no recibe la bonificación de ${mes} aunque esté al día.`}
            textoEnviar="Quitar"
          />
        </Panel>
      ) : null}
    </DialogoDeDetalle>
  );
}

/** El renglón de una unidad y, si está abierto, el de su formulario debajo. */
function FilasDeUnidad({
  etiqueta,
  situacion,
  accion,
  formulario,
  columnas,
}: {
  readonly etiqueta: string;
  readonly situacion: ReactNode;
  /** `null` si quien mira no puede cargar excepciones: la columna no existe. */
  readonly accion: ReactNode;
  readonly formulario: ReactNode;
  readonly columnas: number;
}) {
  return (
    <>
      <tr>
        <th scope="row">{etiqueta}</th>
        <td>{situacion}</td>
        {accion ? <td>{accion}</td> : null}
      </tr>
      {formulario ? (
        <tr>
          <td colSpan={columnas}>{formulario}</td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * El motivo de una excepción, y para «Quitar» también la unidad. El esquema (`shared/devengado`) dice
 * qué es un motivo válido; acá no hay validación propia.
 */
function FormularioDeExcepcion({
  accion,
  periodoId,
  unidadFuncionalId,
  tipo,
  elegirEntre,
  etiqueta,
  explicacion,
  textoEnviar,
  alTerminar,
}: {
  readonly accion: Accion;
  readonly periodoId: string;
  /** La unidad del renglón. Sin ella, se elige de `elegirEntre`. */
  readonly unidadFuncionalId?: string;
  /** «dar» o «quitar». Sin tipo es «Sacar la excepción». */
  readonly tipo?: "dar" | "quitar";
  readonly elegirEntre?: DetalleDeBonificacion["paraQuitar"];
  readonly etiqueta: string;
  readonly explicacion: string;
  readonly textoEnviar: string;
  /** Cierra el formulario del renglón: al cancelar y cuando se guardó. */
  readonly alTerminar?: () => void;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(accion);

  const terminar = useRef(alTerminar);
  terminar.current = alTerminar;
  useEffect(() => {
    if (resultado.estado === "ok") terminar.current?.();
  }, [resultado]);

  return (
    <Formulario accion={enviar} etiqueta={etiqueta}>
      <input type="hidden" name="periodoId" value={periodoId} />
      {tipo ? <input type="hidden" name="tipo" value={tipo} /> : null}
      {unidadFuncionalId ? <input type="hidden" name="unidadFuncionalId" value={unidadFuncionalId} /> : null}
      <p className={ui.secundaria}>{explicacion}</p>
      <Campos>
        {elegirEntre ? (
          <CampoSeleccion
            nombre="unidadFuncionalId"
            etiqueta="Unidad"
            requerido
            sinSeleccion="Elegí la unidad…"
            opciones={elegirEntre.map((u) => ({ valor: u.unidadFuncionalId, texto: u.etiqueta }))}
            errores={campos["unidadFuncionalId"]}
            valorInicial={previos["unidadFuncionalId"]}
          />
        ) : null}
        <CampoTexto
          nombre="motivo"
          etiqueta={
            <>
              Motivo<SoloLectores> — {etiqueta}</SoloLectores>
            </>
          }
          requerido
          maximo={500}
          errores={campos["motivo"]}
          valorInicial={previos["motivo"]}
          ayuda="Queda en el historial de la unidad."
        />
      </Campos>
      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFalloCompacto error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>
      <Acciones>
        {alTerminar ? (
          <BotonDeAccion variante="sutil" deshabilitado={pendiente} onClick={alTerminar}>
            Cancelar
          </BotonDeAccion>
        ) : null}
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          {textoEnviar}
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}
