"use client";

/**
 * El formulario de «Cómo se devenga» (Configuración del barrio; encargo 16, pantalla 1 de la maqueta):
 * de dónde sale el importe del mes, cómo se reparte, la bonificación por pago en término y qué cobra
 * el cupón. Los cuatro puntos se guardan juntos, desde un mes y con motivo.
 *
 * Solo se dibuja para quien puede cambiarlo (`puedeEditar`, que resuelve el servicio); a los demás la
 * página les muestra lo mismo como lectura, sin JavaScript.
 *
 * **Ninguna regla vive acá.** Qué valores valen, que un porcentaje lleve tope y que el motivo tenga
 * un mínimo lo dice `cambiarComoSeDevengaSchema`; que el mes no esté emitido, la base. Lo único que
 * decide esta isla es **qué campos se dibujan** (con «Este barrio no bonifica» no hay cuánto) y qué
 * renglón de ejemplo corresponde a lo elegido, con cifras que ya vienen resueltas del servidor.
 *
 * Los campos son no controlados, como todo el kit: los `useState` de acá son copias para mirar. Por
 * eso el cuerpo se **remonta** cuando se guardó bien o cuando llega del servidor una configuración
 * distinta: nace de nuevo con lo que rige, y las copias no quedan viejas.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import {
  COBROS_DEL_CUPON,
  FORMAS_BONIFICACION,
  MODOS_BONIFICACION,
  ORIGENES_DEVENGADO,
  REPARTOS_DEVENGADO,
  TEXTO_CUPON,
  TEXTO_ESTAR_AL_DIA,
  TEXTO_FORMA_BONIFICACION,
  TEXTO_MODO_BONIFICACION,
  TEXTO_ORIGEN,
  TEXTO_REPARTO,
  type ComoSeDevenga,
  type FormaBonificacion,
  type ModoBonificacion,
  type OrigenDevengado,
  type RepartoDevengado,
} from "@admin-barrios/shared/devengado";
import { nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { cambiarComoSeDevengaAction } from "../../../../acciones/parametros.ts";
import type { ErroresPorCampo, ResultadoDeAccion, ValoresDeFormulario } from "../../../../acciones/resultado.ts";
import {
  Acciones,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  Avisos,
  BotonEnviar,
  CampoOpciones,
  CampoParrafo,
  CampoSeleccion,
  CampoTexto,
  Campos,
  Formulario,
  SoloLectores,
  useFormulario,
} from "../../../../componentes/formulario.tsx";
import { Nota, Panel, ui } from "../../../../componentes/ui.tsx";
import { ejemploDeReparto } from "./devengado-textos.ts";

type Propiedades = {
  readonly barrioId: string;
  /** Lo que rige en el primer mes que se puede elegir: es lo que el formulario muestra para cambiar. */
  readonly vigente: ComoSeDevenga;
  /** `YYYY-MM`: el primer mes que se puede elegir. */
  readonly primerMesEditable: string;
  /** `YYYY-MM`, o `null` si el barrio todavía no emitió ningún mes. */
  readonly ultimoMesEmitido: string | null;
  /** Unidades activas del barrio, para el renglón de ejemplo. */
  readonly unidades: number;
  /** Lo que hoy se cobra, si el barrio define el importe. Viene resuelto del servicio. */
  readonly referencia: { readonly importePorUnidad: string | null; readonly totalDelMes: string | null };
  /** La pantalla de la cuota del barrio, a donde manda el renglón de ejemplo. */
  readonly rutaDeLaCuota: string;
};

const mesEnPalabras = (mes: string): string => nombreDelPeriodo(mes).toLowerCase();

/** El nombre del grupo para quien escucha la pantalla: a la vista ya lo dice el título del panel. */
const elegi = (que: string) => (
  <>
    Elegí una<SoloLectores>: {que}</SoloLectores>
  </>
);

export function FormularioDeComoSeDevenga(p: Propiedades) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(cambiarComoSeDevengaAction);

  // Cada guardado que salió bien remonta el cuerpo: vuelve a nacer con lo que rige ahora.
  const [guardados, setGuardados] = useState(0);
  useEffect(() => {
    if (resultado.estado === "ok") setGuardados((n) => n + 1);
  }, [resultado]);
  const firma = `${guardados}|${p.primerMesEditable}|${JSON.stringify(p.vigente)}`;

  return (
    <Formulario accion={enviar} etiqueta="Cambiar cómo se devenga">
      <input type="hidden" name="barrioId" value={p.barrioId} />
      <Cuerpo key={firma} {...p} campos={campos} previos={previos} resultado={resultado} />
      <Avisos>
        {resultado.estado === "ok" ? (
          resultado.valor.cambios === 0 ? (
            <Nota tono="neutro" titulo="No había nada que cambiar.">
              Lo guardado para {mesEnPalabras(resultado.valor.rigeDesde)} ya era eso: no se agregó nada al historial.
            </Nota>
          ) : (
            <AvisoDeExito titulo={`Listo: quedó guardado desde ${mesEnPalabras(resultado.valor.rigeDesde)}.`}>
              <p>Rige desde ese mes y no toca lo ya emitido. El cambio quedó en el historial, con su motivo.</p>
            </AvisoDeExito>
          )
        ) : null}
        {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} /> : null}
        {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
      </Avisos>
      <Acciones ayuda="Un cambio rige desde el mes elegido y no toca lo ya emitido.">
        <BotonEnviar pendiente={pendiente} cargando="Guardando…">
          Guardar
        </BotonEnviar>
      </Acciones>
    </Formulario>
  );
}

function Cuerpo({
  vigente,
  primerMesEditable,
  ultimoMesEmitido,
  unidades,
  referencia,
  rutaDeLaCuota,
  campos,
  previos,
  resultado,
}: Propiedades & {
  readonly campos: ErroresPorCampo;
  readonly previos: ValoresDeFormulario;
  readonly resultado: ResultadoDeAccion<unknown>;
}) {
  const cuanto = vigente.bonificacion.cuanto;
  const [origen, setOrigen] = useState<OrigenDevengado>((previos["origen"] as OrigenDevengado | undefined) ?? vigente.origen);
  const [reparto, setReparto] = useState<RepartoDevengado>((previos["reparto"] as RepartoDevengado | undefined) ?? vigente.reparto);
  const [modo, setModo] = useState<ModoBonificacion | "">(
    (previos["bonificacionModo"] as ModoBonificacion | undefined) ?? vigente.bonificacion.modo,
  );
  const [forma, setForma] = useState<FormaBonificacion | "">(
    (previos["bonificacionForma"] as FormaBonificacion | undefined) ?? cuanto?.forma ?? "",
  );

  /**
   * Un rechazo del servicio que dice a qué campo se refiere (`datos.campo`: el mes ya emitido, la
   * bonificación sin valor) se muestra también en ese campo, además del aviso de abajo.
   */
  const erroresDe = (campo: string): readonly string[] | undefined =>
    campos[campo] ??
    (resultado.estado === "falla" && resultado.error.datos["campo"] === campo ? [resultado.error.mensaje] : undefined);

  // Lo guardado, como lo tipea una persona: es la forma que espera el esquema («7,5», «15.000,00»).
  const valorGuardado =
    cuanto === null || cuanto.forma !== forma
      ? undefined
      : cuanto.forma === "porcentaje"
        ? cuanto.valor.replace(".", ",")
        : formatearMonto(cuanto.valor);
  const valorPrevio = previos["bonificacionForma"] === forma ? previos["bonificacionValor"] : undefined;

  const ejemplo = ejemploDeReparto({ origen, reparto, unidades, referencia });
  // Con el importe definido por la administración, el reparto decide **qué** se carga en la cuota.
  const cambiaLaCuota = origen === "administracion" && (vigente.origen !== "administracion" || reparto !== vigente.reparto);

  return (
    <>
      <Panel titulo="1 · De dónde sale el importe del mes">
        <CampoOpciones
          nombre="origen"
          etiqueta={elegi("de dónde sale el importe del mes")}
          requerido
          enFila
          opciones={ORIGENES_DEVENGADO.map((o) => ({ valor: o, titulo: TEXTO_ORIGEN[o].titulo, detalle: TEXTO_ORIGEN[o].detalle }))}
          valorInicial={previos["origen"] ?? vigente.origen}
          errores={erroresDe("origen")}
          alCambiar={(v) => setOrigen(v as OrigenDevengado)}
        />
      </Panel>

      <Panel titulo="2 · Cómo se reparte entre las unidades">
        <CampoOpciones
          nombre="reparto"
          etiqueta={elegi("cómo se reparte entre las unidades")}
          requerido
          enFila
          opciones={REPARTOS_DEVENGADO.map((r) => ({ valor: r, titulo: TEXTO_REPARTO[r].titulo, detalle: TEXTO_REPARTO[r].detalle }))}
          valorInicial={previos["reparto"] ?? vigente.reparto}
          errores={erroresDe("reparto")}
          alCambiar={(v) => setReparto(v as RepartoDevengado)}
        />
        <p className={ui.secundaria} aria-live="polite">
          Con lo elegido: {ejemplo.texto}
          {ejemplo.cargarEnCuota ? (
            <>
              {" "}
              <Link href={rutaDeLaCuota}>Ir a la cuota del barrio</Link>.
            </>
          ) : null}
        </p>
        {cambiaLaCuota ? (
          <Nota tono="alerta" titulo="Con este cambio, el importe se carga en Configuración → Cuota.">
            {reparto === "coeficiente"
              ? "Repartido por coeficiente, lo que se carga es el total del mes."
              : "Igual para todas, lo que se carga es el importe por unidad."}{" "}
            Cargalo desde el mismo mes: acá no se carga ningún importe.
          </Nota>
        ) : null}
      </Panel>

      <Panel titulo="3 · Bonificación por pago en término">
        <Campos>
          <CampoSeleccion
            nombre="bonificacionModo"
            etiqueta="Se aplica"
            requerido
            sinSeleccion="Elegí cómo se aplica…"
            opciones={MODOS_BONIFICACION.map((m) => ({ valor: m, texto: TEXTO_MODO_BONIFICACION[m] }))}
            valorInicial={previos["bonificacionModo"] ?? vigente.bonificacion.modo}
            errores={erroresDe("bonificacionModo")}
            alCambiar={(v) => setModo(v as ModoBonificacion | "")}
          />
          {modo === "no" ? null : (
            <>
              <CampoSeleccion
                nombre="bonificacionForma"
                etiqueta="Cuánto"
                requerido={modo === "sola"}
                sinSeleccion="Elegí la forma…"
                opciones={FORMAS_BONIFICACION.map((f) => ({ valor: f, texto: TEXTO_FORMA_BONIFICACION[f] }))}
                valorInicial={previos["bonificacionForma"] ?? cuanto?.forma}
                errores={erroresDe("bonificacionForma")}
                alCambiar={(v) => setForma(v as FormaBonificacion | "")}
                ayuda={modo === "a_mano" ? "A mano se puede dejar sin completar: cada descuento se carga en su unidad." : undefined}
              />
              {/* `key`: al cambiar de forma el campo nace vacío; un 7,5 no pasa a ser un importe. */}
              <CampoTexto
                key={`valor-${forma}`}
                nombre="bonificacionValor"
                etiqueta={forma === "importe" ? "Valor ($)" : forma === "porcentaje" ? "Valor (%)" : "Valor"}
                requerido={modo === "sola"}
                maximo={20}
                errores={erroresDe("bonificacionValor")}
                valorInicial={valorPrevio ?? valorGuardado}
                ayuda={
                  forma === "importe"
                    ? "El importe que se bonifica a cada unidad, por ejemplo 15.000,00."
                    : "El porcentaje de la expensa, por ejemplo 7,5."
                }
              />
              {forma === "porcentaje" ? (
                <CampoTexto
                  nombre="bonificacionTope"
                  etiqueta="Tope por unidad ($)"
                  requerido
                  maximo={20}
                  errores={erroresDe("bonificacionTope")}
                  valorInicial={previos["bonificacionTope"] ?? (cuanto?.tope ? formatearMonto(cuanto.tope) : undefined)}
                  ayuda="Lo máximo que se le bonifica a una unidad en un mes. Un porcentaje siempre lleva un máximo en pesos."
                />
              ) : null}
            </>
          )}
        </Campos>
        {modo === "no" ? null : (
          <p className={ui.secundaria}>
            {TEXTO_ESTAR_AL_DIA} La administración puede dársela o quitársela a una unidad puntual, con motivo.
          </p>
        )}
      </Panel>

      <Panel titulo="4 · Qué cobra el cupón del mes">
        <CampoOpciones
          nombre="cuponCobra"
          etiqueta={elegi("qué cobra el cupón del mes")}
          requerido
          enFila
          opciones={COBROS_DEL_CUPON.map((c) => ({ valor: c, titulo: TEXTO_CUPON[c].titulo, detalle: TEXTO_CUPON[c].detalle }))}
          valorInicial={previos["cuponCobra"] ?? vigente.cuponCobra}
          errores={erroresDe("cuponCobra")}
        />
      </Panel>

      <Panel titulo="Desde qué mes rige">
        <Campos>
          <CampoTexto
            nombre="rigeDesde"
            tipo="month"
            etiqueta="Rige desde"
            requerido
            minimo={primerMesEditable}
            errores={erroresDe("rigeDesde")}
            valorInicial={previos["rigeDesde"] ?? primerMesEditable}
            ayuda={
              ultimoMesEmitido
                ? `El último mes emitido es ${mesEnPalabras(ultimoMesEmitido)}: se puede elegir desde ${mesEnPalabras(primerMesEditable)}.`
                : `Todavía no se emitió ningún mes: se puede elegir desde ${mesEnPalabras(primerMesEditable)}.`
            }
          />
          <CampoParrafo
            nombre="motivo"
            etiqueta="Motivo"
            requerido
            maximo={500}
            filas={2}
            errores={erroresDe("motivo")}
            valorInicial={previos["motivo"]}
            ayuda="Al menos 15 caracteres. Queda en el historial."
          />
        </Campos>
      </Panel>
    </>
  );
}
