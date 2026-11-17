"use client";

/**
 * Las islas de «Configuración general › Estudios jurídicos» (encargo E-a; maqueta de mora, pantalla 4):
 * agregar un estudio (buscar primero, después vincular o dar de alta), editar el vínculo, darlo de baja y
 * el criterio general para proponer derivaciones.
 *
 * Sin regla de negocio: que el correo o el CUIT coincidan **exacto**, que el CUIT sea válido, que el
 * aviso de la boleta no amenace con medidas no decididas, que no se dé de baja un estudio con unidades
 * derivadas — lo deciden los esquemas de `@admin-barrios/shared/mora`, el servicio y la base. Acá se
 * muestran sus mensajes tal cual.
 */

import { useEffect, useRef, useState } from "react";
import type { ResultadoDeAccion } from "../../../../acciones/resultado.ts";
import { AvisoEnLinea } from "@admin-barrios/ui";
import { DialogoDeConfirmacion } from "@admin-barrios/ui/cliente/dialogo-de-confirmacion";
import { DialogoDeDetalle } from "@admin-barrios/ui/cliente/dialogo-de-detalle";
import {
  agregarEstudioAction,
  bajaEstudioAction,
  buscarEstudioAction,
  editarVinculoAction,
  guardarCriterioAdministracionAction,
  vincularEstudioAction,
} from "../../../../acciones/mora.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  Campos,
  CampoMonto,
  CampoParrafo,
  CampoSeleccion,
  CampoTexto,
  Formulario,
  useFormulario,
  type Opcion,
} from "../../../../componentes/formulario.tsx";

/** Lo que el diálogo de agregar sabe de la administración. */
type Administracion = { readonly id: string; readonly nombre: string };

/** Lo que se edita de un estudio: su nombre y el vínculo con esta administración. */
export type EstudioParaEditar = {
  readonly id: string;
  readonly nombre: string;
  readonly correoAvisos: string;
  readonly telefonoBoleta: string | null;
  readonly preferenciaAviso: string;
};

const PARECE_CORREO = /@/;

/** Avisa una vez por cada resultado `ok` (el diálogo se cierra con eso). */
function useAlTerminar(resultado: ResultadoDeAccion<unknown>, alTerminar: () => void): void {
  const ref = useRef(alTerminar);
  ref.current = alTerminar;
  useEffect(() => {
    if (resultado.estado === "ok") ref.current();
  }, [resultado]);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Agregar un estudio
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * «Agregar un estudio». Primero se busca por correo o CUIT **exacto**: un estudio no le pertenece a una
 * administración, es una cuenta propia, y si ya usa el sistema con otra se **vincula** a esta en vez de
 * crear un duplicado. Si no aparece, se da de alta con nombre y CUIT.
 */
export function AgregarEstudio({
  administracion,
  preferencias,
}: {
  readonly administracion: Administracion;
  /** `TEXTO_PREFERENCIA_AVISO`, armado en el servidor. */
  readonly preferencias: readonly Opcion[];
}) {
  // Cada alta o vínculo que sale bien cierra el diálogo: un objeto nuevo por vez.
  const [listo, setListo] = useState<object | null>(null);
  return (
    <DialogoDeDetalle
      disparador="Agregar un estudio"
      varianteDisparador="primario"
      tamanoDisparador="base"
      titulo="Agregar un estudio jurídico"
      textoCerrar="Cancelar"
      cerrarCon={listo}
    >
      <PasosDeAgregar administracion={administracion} preferencias={preferencias} alTerminar={() => setListo({})} />
    </DialogoDeDetalle>
  );
}

function PasosDeAgregar({
  administracion,
  preferencias,
  alTerminar,
}: {
  readonly administracion: Administracion;
  readonly preferencias: readonly Opcion[];
  readonly alTerminar: () => void;
}) {
  const busqueda = useFormulario(buscarEstudioAction);
  const encontrado = busqueda.resultado.estado === "ok" ? busqueda.resultado.valor : null;

  return (
    <>
      <Formulario accion={busqueda.enviar} etiqueta="Buscar el estudio">
        <input type="hidden" name="administracionId" value={administracion.id} />
        <Campos>
          <CampoTexto
            nombre="dato"
            etiqueta="Correo o CUIT del estudio"
            ayuda="Se busca exacto. Si el estudio ya usa el sistema con otra administración, se vincula a esta."
            requerido
            maximo={160}
            valorInicial={busqueda.previos["dato"] ?? encontrado?.dato}
            errores={busqueda.campos["dato"]}
            ancho
          />
        </Campos>
        <Acciones>
          <BotonEnviar tono="secundario" pendiente={busqueda.pendiente} cargando="Buscando…">
            Buscar
          </BotonEnviar>
        </Acciones>
        <Avisos>{busqueda.resultado.estado === "falla" ? <AvisoDeFallo error={busqueda.resultado.error} /> : null}</Avisos>
      </Formulario>

      {encontrado === null ? null : encontrado.estudio?.vinculado ? (
        <AvisoEnLinea tono="info">
          {encontrado.estudio.nombre} ya trabaja con {administracion.nombre}. Si hay que cambiar sus datos, hacelo desde la
          lista con «Editar».
        </AvisoEnLinea>
      ) : encontrado.estudio ? (
        // `key`: si se busca otro, el formulario arranca de cero.
        <Vincular
          key={encontrado.estudio.id}
          administracion={administracion}
          estudio={encontrado.estudio}
          dato={encontrado.dato}
          preferencias={preferencias}
          alTerminar={alTerminar}
        />
      ) : (
        <AltaNueva
          key={encontrado.dato}
          administracion={administracion}
          dato={encontrado.dato}
          preferencias={preferencias}
          alTerminar={alTerminar}
        />
      )}
    </>
  );
}

/** Los datos del vínculo: correo de avisos, teléfono de la boleta y cuándo avisar. Los mismos en los tres formularios. */
function CamposDelVinculo({
  previos,
  campos,
  inicial,
  preferencias,
}: {
  readonly previos: Readonly<Record<string, string>>;
  readonly campos: Readonly<Record<string, readonly string[] | undefined>>;
  readonly inicial: {
    readonly correoAvisos?: string | undefined;
    readonly telefonoBoleta?: string | undefined;
    readonly preferenciaAviso?: string | undefined;
  };
  readonly preferencias: readonly Opcion[];
}) {
  return (
    <>
      <CampoTexto
        nombre="correoAvisos"
        etiqueta="Correo para los avisos de esta administración"
        requerido
        maximo={160}
        valorInicial={previos["correoAvisos"] ?? inicial.correoAvisos}
        errores={campos["correoAvisos"]}
      />
      <CampoTexto
        nombre="telefonoBoleta"
        etiqueta="Teléfono para la boleta"
        ayuda="El que lee el titular en el aviso de la boleta de una unidad derivada."
        maximo={40}
        valorInicial={previos["telefonoBoleta"] ?? inicial.telefonoBoleta}
        errores={campos["telefonoBoleta"]}
      />
      <CampoSeleccion
        nombre="preferenciaAviso"
        etiqueta="Avisos"
        requerido
        sinSeleccion="Elegí cuándo avisarle"
        opciones={preferencias}
        valorInicial={previos["preferenciaAviso"] ?? inicial.preferenciaAviso ?? "cada_derivacion"}
        errores={campos["preferenciaAviso"]}
        ayuda="Los avisos por correo todavía no se mandan; lo que elijas queda guardado."
      />
    </>
  );
}

/** Los usuarios del estudio: todavía no se invitan (E-b). Se dice, no se simula un campo que no hace nada. */
function UsuariosDelEstudio() {
  return (
    <AvisoEnLinea tono="info">
      Usuarios del estudio: todavía no se pueden invitar. Por ahora el estudio no entra al sistema.
    </AvisoEnLinea>
  );
}

function Vincular({
  administracion,
  estudio,
  dato,
  preferencias,
  alTerminar,
}: {
  readonly administracion: Administracion;
  readonly estudio: { readonly id: string; readonly nombre: string };
  readonly dato: string;
  readonly preferencias: readonly Opcion[];
  readonly alTerminar: () => void;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(vincularEstudioAction);
  useAlTerminar(resultado, alTerminar);
  return (
    <Formulario accion={enviar} etiqueta={`Vincular ${estudio.nombre}`}>
      <AvisoEnLinea tono="exito">
        {/* Neutro a propósito: el servicio no distingue si fue de otra administración o de esta y está de baja. */}
        <strong>{estudio.nombre}</strong> ya está en el sistema. Se va a vincular a {administracion.nombre}; no ve nada de
        acá hasta que le derives una unidad.
      </AvisoEnLinea>
      <input type="hidden" name="administracionId" value={administracion.id} />
      <input type="hidden" name="estudioId" value={estudio.id} />
      <Campos>
        {/* El nombre es del vínculo: cada administración lo ve como lo carga. Viene el que dio la búsqueda. */}
        <CampoTexto
          nombre="nombre"
          etiqueta="Nombre"
          requerido
          maximo={160}
          valorInicial={previos["nombre"] ?? estudio.nombre}
          errores={campos["nombre"]}
          ayuda="Así lo vas a ver en esta administración."
          ancho
        />
        <CamposDelVinculo
          previos={previos}
          campos={campos}
          inicial={{ correoAvisos: PARECE_CORREO.test(dato) ? dato : undefined }}
          preferencias={preferencias}
        />
      </Campos>
      <UsuariosDelEstudio />
      <Acciones>
        <BotonEnviar pendiente={pendiente} cargando="Vinculando…">
          Vincular
        </BotonEnviar>
      </Acciones>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </Formulario>
  );
}

function AltaNueva({
  administracion,
  dato,
  preferencias,
  alTerminar,
}: {
  readonly administracion: Administracion;
  readonly dato: string;
  readonly preferencias: readonly Opcion[];
  readonly alTerminar: () => void;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(agregarEstudioAction);
  useAlTerminar(resultado, alTerminar);
  const esCorreo = PARECE_CORREO.test(dato);
  return (
    <Formulario accion={enviar} etiqueta="Dar de alta un estudio">
      <AvisoEnLinea tono="info">
        No hay ningún estudio con ese {esCorreo ? "correo" : "CUIT"} en el sistema: se da de alta y queda vinculado a{" "}
        {administracion.nombre}.
      </AvisoEnLinea>
      <input type="hidden" name="administracionId" value={administracion.id} />
      <Campos>
        <CampoTexto nombre="nombre" etiqueta="Nombre" requerido maximo={160} valorInicial={previos["nombre"]} errores={campos["nombre"]} />
        <CampoTexto
          nombre="cuit"
          etiqueta="CUIT"
          requerido
          maximo={13}
          valorInicial={previos["cuit"] ?? (esCorreo ? undefined : dato)}
          errores={campos["cuit"]}
        />
        <CamposDelVinculo
          previos={previos}
          campos={campos}
          inicial={{ correoAvisos: esCorreo ? dato : undefined }}
          preferencias={preferencias}
        />
      </Campos>
      <UsuariosDelEstudio />
      <Acciones>
        <BotonEnviar pendiente={pendiente} cargando="Agregando…">
          Agregar
        </BotonEnviar>
      </Acciones>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </Formulario>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Editar y dar de baja
// ────────────────────────────────────────────────────────────────────────────────────────────────

export function EditarEstudio({
  administracionId,
  estudio,
  preferencias,
}: {
  readonly administracionId: string;
  readonly estudio: EstudioParaEditar;
  readonly preferencias: readonly Opcion[];
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(editarVinculoAction);
  return (
    <DialogoDeConfirmacion
      disparador="Editar"
      etiquetaDisparador={`Editar ${estudio.nombre}`}
      titulo={`Editar ${estudio.nombre}`}
      accion={enviar}
      textoConfirmar="Guardar"
      textoPendiente="Guardando…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
    >
      <input type="hidden" name="administracionId" value={administracionId} />
      <input type="hidden" name="estudioId" value={estudio.id} />
      <Campos>
        <CampoTexto
          nombre="nombre"
          etiqueta="Nombre"
          requerido
          maximo={160}
          valorInicial={previos["nombre"] ?? estudio.nombre}
          errores={campos["nombre"]}
          ayuda="Así lo vas a ver en esta administración."
          ancho
        />
        <CamposDelVinculo
          previos={previos}
          campos={campos}
          inicial={{
            correoAvisos: estudio.correoAvisos,
            telefonoBoleta: estudio.telefonoBoleta ?? undefined,
            preferenciaAviso: estudio.preferenciaAviso,
          }}
          preferencias={preferencias}
        />
      </Campos>
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </DialogoDeConfirmacion>
  );
}

export function DarDeBajaEstudio({
  administracionId,
  administracion,
  estudio,
  derivadas,
}: {
  readonly administracionId: string;
  readonly administracion: string;
  readonly estudio: { readonly id: string; readonly nombre: string };
  readonly derivadas: number;
}) {
  const { enviar, pendiente, resultado } = useFormulario(bajaEstudioAction);
  return (
    <DialogoDeConfirmacion
      disparador="Dar de baja"
      varianteDisparador="sutil"
      etiquetaDisparador={`Dar de baja ${estudio.nombre}`}
      titulo={`Dar de baja ${estudio.nombre}`}
      accion={enviar}
      textoConfirmar="Dar de baja"
      varianteConfirmar="peligro"
      textoPendiente="Dando de baja…"
      pendiente={pendiente}
      textoVolver="Cancelar"
      cerrarCon={resultado.estado === "ok" ? resultado : null}
    >
      <input type="hidden" name="administracionId" value={administracionId} />
      <input type="hidden" name="estudioId" value={estudio.id} />
      <p>
        {estudio.nombre} deja de trabajar con {administracion}: no se le pueden derivar unidades nuevas. Lo que ya hizo
        queda en la historia.
      </p>
      {derivadas > 0 ? (
        <AvisoEnLinea tono="alerta">
          Tiene {derivadas === 1 ? "1 unidad derivada" : `${derivadas} unidades derivadas`}. No se puede dar de baja un
          estudio con unidades derivadas: primero se retiran o se pasan a otro.
        </AvisoEnLinea>
      ) : null}
      <Avisos>{resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}</Avisos>
    </DialogoDeConfirmacion>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El criterio general
// ────────────────────────────────────────────────────────────────────────────────────────────────

export function FormularioDeCriterio({
  administracionId,
  criterio,
}: {
  readonly administracionId: string;
  readonly criterio: {
    readonly meses: number;
    readonly montoMinimo: string;
    readonly pedirIntimacion: boolean;
    readonly leyendaBoleta: string;
  };
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(guardarCriterioAdministracionAction);
  const sueltos = campos[""] ?? [];
  return (
    <Formulario accion={enviar} etiqueta="Criterio general para proponer derivaciones">
      <input type="hidden" name="administracionId" value={administracionId} />
      <Campos>
        <CampoTexto
          nombre="meses"
          etiqueta="Meses de deuda (más de)"
          requerido
          modoDeTeclado="numeric"
          maximo={3}
          valorInicial={previos["meses"] ?? String(criterio.meses)}
          errores={campos["meses"]}
          ayuda="Se propone derivar con más de estos meses de deuda vencida."
        />
        <CampoMonto
          nombre="montoMinimo"
          etiqueta="Monto mínimo de deuda"
          requerido
          valorInicial={previos["montoMinimo"] ?? criterio.montoMinimo}
          errores={campos["montoMinimo"]}
          ayuda="Capital vencido más interés a hoy. Debajo de esto no se propone, aunque se puede derivar a mano."
        />
        <CampoSeleccion
          nombre="pedirIntimacion"
          etiqueta="Intimación previa"
          requerido
          sinSeleccion="Elegí"
          opciones={[
            { valor: "si", texto: "Avisar si falta" },
            { valor: "no", texto: "No pedir" },
          ]}
          valorInicial={previos["pedirIntimacion"] ?? (criterio.pedirIntimacion ? "si" : "no")}
          errores={campos["pedirIntimacion"]}
          ayuda="Avisa al derivar si la unidad no tiene una intimación registrada; no lo impide."
        />
        <CampoParrafo
          nombre="leyendaBoleta"
          etiqueta="Aviso en la boleta de una unidad derivada (texto base)"
          requerido
          maximo={600}
          filas={4}
          valorInicial={previos["leyendaBoleta"] ?? criterio.leyendaBoleta}
          errores={campos["leyendaBoleta"]}
          ayuda="Texto base a revisar con el estudio. Escribí {estudio} y {telefono} tal cual (sin tilde): se reemplazan por los del estudio. No puede amenazar con medidas no decididas (embargo, corte de servicios, prohibir el ingreso)."
          ancho
        />
      </Campos>
      <Acciones ayuda="Vale para todos los barrios, salvo los que tengan uno propio.">
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Guardar el criterio
        </BotonEnviar>
      </Acciones>
      <Avisos>
        {resultado.estado === "ok" ? <AvisoDeExito titulo="Listo: el criterio general quedó guardado." /> : null}
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {sueltos.length > 0 ? <AvisoDeCamposSueltos mensajes={sueltos} /> : null}
      </Avisos>
    </Formulario>
  );
}
