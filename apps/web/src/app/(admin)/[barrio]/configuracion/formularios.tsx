"use client";

/**
 * Los tres formularios de las pantallas de configuración: **fijar un valor**, **volver al valor
 * general** y **anular un cambio programado**. Es la única parte de esas pantallas que manda
 * JavaScript al navegador; todo lo demás (la lista, los filtros, el historial) es servidor.
 *
 * No hay una sola regla de negocio acá. Que la fecha no sea pasada, que el motivo alcance, que una
 * tasa tenga respaldo, que «Cobra interés» no quede en Sí con tasa cero, que quien escribe pueda
 * hacerlo: lo decide `app.fijar_parametro()` y vuelve como error traducido. Lo que este archivo
 * decide es **qué campo se dibuja** según el tipo del parámetro, que sale del registro compartido.
 *
 * Lo que dice el formulario sobre el valor de hoy y a quién alcanza el cambio (`rige`, `impacto`)
 * llega **armado desde el servidor**, con lo que leyó de la base: la isla no cuenta barrios.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ParametroFijado } from "@admin-barrios/data/servicios/parametros";
import { BloqueDeImpacto, Segmentado, TextoDeOrigen } from "@admin-barrios/ui";
import { CONTENT_TYPES_COMPROBANTE } from "@admin-barrios/shared/cobros";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import {
  definicionDe,
  ETIQUETA_RESPALDO,
  MOTIVO_MINIMO,
  TIPOS_RESPALDO,
  type ClaveParametro,
} from "@admin-barrios/shared/parametros-mora";
import {
  anularParametroAction,
  fijarParametroAction,
  volverAlValorGeneralAction,
} from "../../../../acciones/parametros.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoArchivo,
  CampoMonto,
  CampoParrafo,
  CampoSeleccion,
  Campos,
  CampoTexto,
  Formulario,
  PedidoDeConfirmacion,
  useFormulario,
} from "../../../../componentes/formulario.tsx";
import { useSubidaDeRespaldo } from "../../../../componentes/useSubidaDeRespaldo.ts";

const TIPOS_ACEPTADOS = CONTENT_TYPES_COMPROBANTE.join(",");

const OPCIONES_RESPALDO = TIPOS_RESPALDO.map((t) => ({ valor: t, texto: ETIQUETA_RESPALDO[t] }));

const AYUDA_FECHA = "Desde hoy en adelante. Lo emitido o imputado antes de esa fecha no cambia.";

const AYUDA_MOTIVO = `Por qué cambia. Al menos ${MOTIVO_MINIMO} caracteres: queda en el historial.`;

/**
 * Cuántas veces respondió el servidor. Es el `key` de los controles que el kit no puede remontar
 * solos después del `form.reset()` de React 19 —hoy, el `Segmentado`, que es de servidor y no
 * escucha el formulario—: al remontar, nacen con el `defaultChecked` que devolvió la acción.
 */
function useGeneracion(resultado: unknown): number {
  const ultimo = useRef(resultado);
  const [generacion, setGeneracion] = useState(0);
  useEffect(() => {
    if (ultimo.current === resultado) return;
    ultimo.current = resultado;
    setGeneracion((g) => g + 1);
  }, [resultado]);
  return generacion;
}

function AcuseDeCambio({ valor, hoy }: { readonly valor: ParametroFijado; readonly hoy: string }) {
  const programado = valor.vigenteDesde > hoy;
  return (
    <AvisoDeExito titulo={programado ? "Listo: el cambio quedó programado." : "Listo: el cambio ya rige."}>
      <p>
        {programado ? "Rige desde el " : "Rige desde hoy, "}
        {formatearFecha(valor.vigenteDesde)}. Quedó en el historial con su motivo
        {programado ? "; hasta esa fecha se puede anular." : "."}
      </p>
    </AvisoDeExito>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Fijar un valor
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * «Cambiar» / «Fijar un valor propio». El mismo formulario sirve a la administración y al barrio:
 * lo que cambia es el `nodoId` y el texto que arma la pantalla.
 */
export function FormularioDeCambio({
  nodoId,
  clave,
  hoy,
  valorActual,
  rige,
  impacto,
  hrefOrdenDeImputacion,
}: {
  readonly nodoId: string;
  readonly clave: ClaveParametro;
  /** La fecha de hoy **de la base**: es contra la que el servicio decide qué es retroactivo. */
  readonly hoy: string;
  /** El valor de hoy, en la forma en que se tipea. `undefined` si no hay ninguno. */
  readonly valorActual: string | undefined;
  /** «Hoy rige X (de dónde sale). …» */
  readonly rige: ReactNode;
  readonly impacto: ReactNode;
  /** A dónde manda la confirmación de «Cobra interés» para cambiar el orden de imputación. */
  readonly hrefOrdenDeImputacion: string;
}) {
  const def = definicionDe(clave);
  const { enviar, pendiente, resultado, campos, previos, confirmacion, volverACorregir } =
    useFormulario<ParametroFijado>(fijarParametroAction);
  const subida = useSubidaDeRespaldo(nodoId);
  const generacion = useGeneracion(resultado);
  const id = useId();

  if (resultado.estado === "ok") return <AcuseDeCambio valor={resultado.valor} hoy={hoy} />;

  const inicial = previos["valor"] ?? valorActual;
  const subiendo = subida.estado.fase === "pidiendoUrl" || subida.estado.fase === "subiendo";

  return (
    <Formulario accion={enviar} etiqueta={`Cambiar «${def.nombre}»`}>
      {confirmacion && resultado.estado === "confirmar" ? (
        <PedidoDeConfirmacion
          onVolver={volverACorregir}
          error={resultado.error}
          confirmacion={confirmacion}
          valores={resultado.valores}
          pendiente={pendiente}
        >
          <p>
            <a href={hrefOrdenDeImputacion}>Ver «Orden de imputación» en esta pantalla</a>
          </p>
        </PedidoDeConfirmacion>
      ) : (
        <>
          <input type="hidden" name="nodoId" value={nodoId} />
          <input type="hidden" name="clave" value={clave} />

          <p>
            <TextoDeOrigen>{rige}</TextoDeOrigen>
          </p>

          <Campos>
            {def.tipo === "sino" ? (
              <Segmentado
                key={generacion}
                id={`${id}-valor`}
                nombre="valor"
                etiqueta="Valor nuevo"
                requerido
                opciones={[
                  { valor: "si", texto: "Sí" },
                  { valor: "no", texto: "No" },
                ]}
                valorInicial={inicial}
                error={campos["valor"]?.join(". ")}
              />
            ) : def.tipo === "tasa" ? (
              <CampoTexto
                nombre="valor"
                etiqueta="Valor nuevo (% mensual)"
                requerido
                modoDeTeclado="decimal"
                maximo={9}
                errores={campos["valor"]}
                valorInicial={inicial}
                ayuda="Porcentaje mensual: 2,5 (o 2.5) es dos coma cinco por ciento."
              />
            ) : def.tipo === "dias" ? (
              <CampoTexto
                nombre="valor"
                etiqueta="Valor nuevo (días corridos)"
                requerido
                modoDeTeclado="numeric"
                maximo={3}
                errores={campos["valor"]}
                valorInicial={inicial}
                ayuda="Un número entero de días."
              />
            ) : def.tipo === "pesos" ? (
              <CampoMonto
                nombre="valor"
                etiqueta="Valor nuevo (pesos)"
                requerido
                errores={campos["valor"]}
                valorInicial={inicial}
                ayuda="En pesos, con hasta dos decimales."
              />
            ) : (
              <CampoSeleccion
                nombre="valor"
                etiqueta="Valor nuevo"
                requerido
                ancho
                opciones={(def.opciones ?? []).map((o) => ({ valor: o.valor, texto: o.texto }))}
                sinSeleccion="Elegí una opción…"
                errores={campos["valor"]}
                valorInicial={inicial}
              />
            )}

            <CampoTexto
              nombre="rigeDesde"
              tipo="date"
              etiqueta="Rige desde"
              requerido
              minimo={hoy}
              errores={campos["rigeDesde"]}
              valorInicial={previos["rigeDesde"] ?? hoy}
              ayuda={AYUDA_FECHA}
            />

            <CampoParrafo
              nombre="motivo"
              etiqueta="Motivo"
              requerido
              ancho
              maximo={500}
              errores={campos["motivo"]}
              valorInicial={previos["motivo"]}
              ayuda={AYUDA_MOTIVO}
            />

            {/*
              El respaldo es obligatorio para las tasas (decisión del titular, T1): una tasa sin
              decir de qué instrumento sale es un número que nadie puede defender ante un reclamo.
              El adjunto es opcional —la referencia alcanza para encontrar el papel—.
            */}
            {def.requiereRespaldo ? (
              <>
                <CampoSeleccion
                  nombre="respaldoTipo"
                  etiqueta="De dónde sale la tasa"
                  requerido
                  opciones={OPCIONES_RESPALDO}
                  sinSeleccion="Elegí el instrumento…"
                  errores={campos["respaldoTipo"]}
                  valorInicial={previos["respaldoTipo"]}
                />
                <CampoTexto
                  nombre="respaldoReferencia"
                  etiqueta="Referencia"
                  requerido
                  maximo={300}
                  errores={campos["respaldoReferencia"]}
                  valorInicial={previos["respaldoReferencia"]}
                  ayuda="Dónde se encuentra: el artículo del reglamento, o el acta con su fecha."
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
                  ayuda="PDF o foto (JPG o PNG). Es lo que se muestra cuando alguien pregunta de dónde salió la tasa."
                />
              </>
            ) : null}
          </Campos>

          <BloqueDeImpacto>{impacto}</BloqueDeImpacto>

          <Avisos>
            {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>

          <Acciones ayuda={subiendo ? "Esperando que termine de subir el adjunto." : undefined}>
            <BotonEnviar pendiente={pendiente} deshabilitado={subiendo} cargando="Guardando…">
              Guardar el cambio
            </BotonEnviar>
          </Acciones>
        </>
      )}
    </Formulario>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Volver al valor general
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** El barrio vuelve a heredar desde una fecha. Los propios programados después se cancelan (lo hace la base). */
export function FormularioVolverAlGeneral({
  barrioId,
  clave,
  hoy,
  aviso,
}: {
  readonly barrioId: string;
  readonly clave: ClaveParametro;
  readonly hoy: string;
  readonly aviso: ReactNode;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario<ParametroFijado>(volverAlValorGeneralAction);

  if (resultado.estado === "ok") return <AcuseDeCambio valor={resultado.valor} hoy={hoy} />;

  return (
    <Formulario accion={enviar} etiqueta={`Volver al valor general en «${definicionDe(clave).nombre}»`}>
      <input type="hidden" name="barrioId" value={barrioId} />
      <input type="hidden" name="clave" value={clave} />

      <p>
        <TextoDeOrigen>{aviso}</TextoDeOrigen>
      </p>

      <Campos>
        <CampoTexto
          nombre="rigeDesde"
          tipo="date"
          etiqueta="Rige desde"
          requerido
          minimo={hoy}
          errores={campos["rigeDesde"]}
          valorInicial={previos["rigeDesde"] ?? hoy}
          ayuda={AYUDA_FECHA}
        />
        <CampoParrafo
          nombre="motivo"
          etiqueta="Motivo"
          requerido
          ancho
          maximo={500}
          errores={campos["motivo"]}
          valorInicial={previos["motivo"]}
          ayuda={`Por qué vuelve al valor general. Al menos ${MOTIVO_MINIMO} caracteres: queda en el historial.`}
        />
      </Campos>

      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>

      <Acciones>
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Volver al valor general
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Anular un cambio programado
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Anula un cambio que todavía no rige. Lo que ya rige no se anula: se fija otro valor. */
export function FormularioDeAnulacion({
  filaId,
  descripcion,
}: {
  readonly filaId: string;
  /** Qué cambio se anula, ya escrito: «3,2 % desde el 01/12/2026». */
  readonly descripcion: ReactNode;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario<{ readonly filaId: string }>(
    anularParametroAction,
  );

  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo="Listo: el cambio programado quedó anulado.">
        <p>Sigue en el historial, marcado como anulado y con su motivo.</p>
      </AvisoDeExito>
    );
  }

  return (
    <Formulario accion={enviar} etiqueta="Anular el cambio programado">
      <input type="hidden" name="filaId" value={filaId} />

      <p>
        <TextoDeOrigen>
          Se anula {descripcion}. No se borra: queda en el historial como anulado, con el motivo.
        </TextoDeOrigen>
      </p>

      <Campos>
        <CampoParrafo
          nombre="motivo"
          etiqueta="Motivo"
          requerido
          ancho
          maximo={500}
          errores={campos["motivo"]}
          valorInicial={previos["motivo"]}
          ayuda={`Por qué se anula. Al menos ${MOTIVO_MINIMO} caracteres.`}
        />
      </Campos>

      <Avisos>
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>

      <Acciones>
        <BotonEnviar tono="peligro" pendiente={pendiente} cargando="Anulando…">
          Anular el cambio programado
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}
