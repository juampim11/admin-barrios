/**
 * «Cómo se devenga» en Configuración del barrio (encargo 16, pantalla 1 de la maqueta): de dónde sale
 * lo que se le pide cada mes a cada unidad.
 *
 * Es de servidor y no decide nada: qué rige, desde qué mes se puede cambiar, qué está programado y
 * quién puede editar lo resolvió `leerComoSeDevenga`. Acá se **dice**. El único JavaScript es el
 * formulario (`como-se-devenga.tsx`), y solo se dibuja para quien puede cambiarlo: a los demás se les
 * muestra lo mismo como lectura (ADR-0003 §6.4).
 *
 * **Va como grupo con ancla (`#como-se-devenga`) dentro de Configuración del barrio y no en una ruta
 * propia**: es configuración del barrio con vigencia e historial, igual que los vencimientos y la
 * mora, y desde la cuota se llega por el ancla.
 */

import type { PanelDeDevengado } from "@admin-barrios/data/servicios/devengado";
import { GrupoDeParametros } from "@admin-barrios/ui";
import { TEXTO_CUPON, TEXTO_ORIGEN, TEXTO_REPARTO } from "@admin-barrios/shared/devengado";
import { formatearFecha, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { Definicion, Definiciones, Desplegable, MarcoTabla, Nota, Panel, PilaDeNotas, Tabla, ui } from "../../../../componentes/ui.tsx";
import { rutaDeCuota } from "../../../../rutas.ts";
import { FormularioDeComoSeDevenga } from "./como-se-devenga.tsx";
import { resumenCorto, textoDeBonificacion, textoDelCambio } from "./devengado-textos.ts";

/** El ancla del grupo, para llegar desde la cuota del barrio. */
export const ANCLA_COMO_SE_DEVENGA = "como-se-devenga";

export function ComoSeDevengaDelBarrio({ panel }: { readonly panel: PanelDeDevengado }) {
  const { vigente } = panel;
  // A la isla va solo lo que el formulario muestra: los cuatro puntos, sin las marcas de qué se cargó.
  const paraElFormulario = {
    origen: vigente.origen,
    reparto: vigente.reparto,
    cuponCobra: vigente.cuponCobra,
    bonificacion: vigente.bonificacion,
  };

  return (
    <GrupoDeParametros id={ANCLA_COMO_SE_DEVENGA} titulo="Cómo se devenga">
      <p className={ui.secundaria}>
        De dónde sale lo que se le pide cada mes a cada unidad. Se define una vez; un cambio rige desde el mes que elijas y
        no toca lo ya emitido.
      </p>

      <PilaDeNotas>
        {vigente.cargado ? null : (
          <Nota tono="info" titulo="Este barrio todavía no lo configuró.">
            Hoy rige el comportamiento de siempre, que es lo que se ve acá abajo. Al guardar queda escrito, con el mes desde
            el que rige.
          </Nota>
        )}
        {panel.programados.map((programado) => (
          <Nota key={programado.rigeDesde} tono="info" titulo={`Desde ${nombreDelPeriodo(programado.rigeDesde).toLowerCase()}:`}>
            {resumenCorto(programado.config)}
          </Nota>
        ))}
      </PilaDeNotas>

      {panel.puedeEditar ? (
        <FormularioDeComoSeDevenga
          barrioId={panel.barrio.id}
          vigente={paraElFormulario}
          primerMesEditable={panel.primerMesEditable}
          ultimoMesEmitido={panel.ultimoMesEmitido}
          unidades={panel.barrio.unidades}
          referencia={panel.referencia}
          rutaDeLaCuota={rutaDeCuota(panel.barrio.id)}
        />
      ) : (
        <Panel
          titulo={`Lo que rige desde ${nombreDelPeriodo(panel.primerMesEditable).toLowerCase()}`}
          origen="Lo define la administración del barrio."
        >
          <Definiciones>
            <Definicion termino="De dónde sale el importe del mes">{TEXTO_ORIGEN[vigente.origen].titulo}</Definicion>
            <Definicion termino="Cómo se reparte entre las unidades">{TEXTO_REPARTO[vigente.reparto].titulo}</Definicion>
            <Definicion termino="Bonificación por pago en término">{textoDeBonificacion(vigente.bonificacion)}</Definicion>
            <Definicion termino="Qué cobra el cupón del mes">{TEXTO_CUPON[vigente.cuponCobra].titulo}</Definicion>
          </Definiciones>
        </Panel>
      )}

      {panel.historial.length > 0 ? (
        <Desplegable resumen={`Historial de cambios (${panel.historial.length})`}>
          <MarcoTabla etiqueta="Historial de cómo se devenga">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col">Rige desde</th>
                  <th scope="col">Qué cambió</th>
                  <th scope="col">Motivo</th>
                  <th scope="col">Quién</th>
                  <th scope="col">Cuándo</th>
                </tr>
              </thead>
              <tbody>
                {panel.historial.map((fila, i) => (
                  // Solo se agregan filas y el orden es el de carga: el índice es estable.
                  <tr key={i}>
                    <td>{nombreDelPeriodo(fila.rigeDesde)}</td>
                    <td>{textoDelCambio(fila, panel.historial)}</td>
                    <td>{fila.motivo || "—"}</td>
                    <td>{fila.cargoNombre ?? "—"}</td>
                    <td>{formatearFecha(fila.cargadoEl)}</td>
                  </tr>
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        </Desplegable>
      ) : null}
    </GrupoDeParametros>
  );
}
