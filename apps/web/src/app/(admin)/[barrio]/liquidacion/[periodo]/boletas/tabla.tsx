"use client";

/**
 * La tabla de Boletas con sus filtros y la boleta de ejemplo (T2; ensayo, 2026-11-05).
 *
 * **Es una isla y no una tabla server, a propósito.** La vista previa es la emisión entera: los
 * filtros por link volvían a pedir la página y la recalculaban cada vez (unos segundos en un barrio
 * grande). Acá se calcula una vez en el servidor y «Todas», «Con interés» y «Con cargos» —y elegir la
 * unidad del ejemplo— filtran lo que ya está en la pantalla. No es `TablaInteractiva`: no hay orden,
 * búsqueda ni selección (ADR-0003 §8), solo un filtro sobre un arreglo.
 */

import { useState } from "react";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { BoletaDeEjemplo, ElegirEnLaLista, FiltroDeListaBoton, FiltrosDeLista } from "@admin-barrios/ui";
import { MarcoTabla, Panel, Tabla, ui } from "../../../../../../componentes/ui.tsx";
import estilos from "./boletas.module.css";

export type FilaDeBoleta = {
  readonly unidadFuncionalId: string;
  readonly etiqueta: string;
  readonly expensa: string;
  readonly cargos: string;
  readonly saldoAnterior: string;
  readonly interes: string;
  readonly total: string;
};

type Filtro = "todas" | "interes" | "cargos";

const pesos = (m: string) => `$ ${formatearMonto(m)}`;
const oGuion = (m: string) => (m === "0.00" ? "—" : pesos(m));

export function TablaDeBoletas({
  boletas,
  etiquetaTabla,
  tituloBoleta,
  origenBoleta,
  conceptoExpensa,
  conceptoTotal,
  unidadInicial,
}: {
  readonly boletas: readonly FilaDeBoleta[];
  readonly etiquetaTabla: string;
  /** El nombre del barrio, arriba de la boleta. */
  readonly tituloBoleta: string;
  readonly origenBoleta: string;
  /** «Cuota del mes» o «Expensa del mes», según el modelo. */
  readonly conceptoExpensa: string;
  /** «Total al 10/12/2026», o «Total». */
  readonly conceptoTotal: string;
  readonly unidadInicial: string | null;
}) {
  const [filtro, setFiltro] = useState<Filtro>("todas");
  const [unidad, setUnidad] = useState<string | null>(unidadInicial);
  const conInteres = boletas.filter((b) => b.interes !== "0.00");
  const conCargos = boletas.filter((b) => b.cargos !== "0.00");
  const visibles = filtro === "interes" ? conInteres : filtro === "cargos" ? conCargos : boletas;
  const ejemplo = boletas.find((b) => b.unidadFuncionalId === unidad) ?? visibles[0] ?? null;

  return (
    <>
      <FiltrosDeLista etiqueta="Qué boletas ver">
        <FiltroDeListaBoton activo={filtro === "todas"} cantidad={boletas.length} alElegir={() => setFiltro("todas")}>
          Todas
        </FiltroDeListaBoton>
        <FiltroDeListaBoton activo={filtro === "interes"} cantidad={conInteres.length} alElegir={() => setFiltro("interes")}>
          Con interés
        </FiltroDeListaBoton>
        <FiltroDeListaBoton activo={filtro === "cargos"} cantidad={conCargos.length} alElegir={() => setFiltro("cargos")}>
          Con cargos
        </FiltroDeListaBoton>
      </FiltrosDeLista>

      <div className={estilos.dos}>
        <MarcoTabla etiqueta={etiquetaTabla}>
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Unidad
                </th>
                <th scope="col" className={ui.numerica}>
                  Expensa
                </th>
                <th scope="col" className={ui.numerica}>
                  Cargos
                </th>
                <th scope="col" className={ui.numerica}>
                  Interés
                </th>
                <th scope="col" className={ui.numerica}>
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((b) => (
                <tr key={b.unidadFuncionalId}>
                  <th scope="row" className={ui.columnaAncla}>
                    <ElegirEnLaLista
                      elegido={ejemplo?.unidadFuncionalId === b.unidadFuncionalId}
                      alElegir={() => setUnidad(b.unidadFuncionalId)}
                    >
                      {b.etiqueta}
                    </ElegirEnLaLista>
                  </th>
                  <td className={ui.numerica}>{pesos(b.expensa)}</td>
                  <td className={ui.numerica}>{oGuion(b.cargos)}</td>
                  <td className={ui.numerica}>{oGuion(b.interes)}</td>
                  <td className={ui.numerica}>{pesos(b.total)}</td>
                </tr>
              ))}
            </tbody>
          </Tabla>
        </MarcoTabla>

        {ejemplo ? (
          <Panel titulo={`Boleta de ${ejemplo.etiqueta}`} origen={origenBoleta}>
            <BoletaDeEjemplo
              titulo={tituloBoleta}
              renglones={[
                { concepto: conceptoExpensa, importe: pesos(ejemplo.expensa) },
                ...(ejemplo.cargos !== "0.00" ? [{ concepto: "Cargos y descuentos", importe: pesos(ejemplo.cargos) }] : []),
                { concepto: "Saldo anterior", importe: pesos(ejemplo.saldoAnterior) },
                ...(ejemplo.interes !== "0.00" ? [{ concepto: "Interés por mora", importe: pesos(ejemplo.interes) }] : []),
              ]}
              total={{ concepto: conceptoTotal, importe: pesos(ejemplo.total) }}
            />
          </Panel>
        ) : null}
      </div>
    </>
  );
}
