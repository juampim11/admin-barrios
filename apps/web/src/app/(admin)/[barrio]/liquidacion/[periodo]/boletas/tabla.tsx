"use client";

/**
 * La tabla de Boletas con sus filtros y la boleta de ejemplo (T2; ensayo, 2026-11-05).
 *
 * **Es una isla y no una tabla server, a propósito.** La vista previa es la emisión entera: los
 * filtros por link volvían a pedir la página y la recalculaban cada vez (unos segundos en un barrio
 * grande). Acá se calcula una vez en el servidor y «Todas», «Con interés» y «Con cargos» —y elegir la
 * unidad del ejemplo— filtran lo que ya está en la pantalla. No es `TablaInteractiva`: no hay orden,
 * búsqueda ni selección (ADR-0003 §8), solo un filtro sobre un arreglo.
 *
 * **Dos formas, según qué cobra el cupón** (encargo 16; maqueta, pantalla 5). Si el barrio configuró
 * que el cupón cobra **solo el mes**, hay un renglón por unidad con lo «fuera de lo común» en marcas
 * y el total del cupón; la deuda anterior figura como referencia y no suma. Si no lo configuró, o
 * cobra el mes más la deuda, la tabla es la de siempre: un barrio que no tocó nada ve lo mismo.
 */

import { useState } from "react";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { BoletaDeEjemplo, Chip, ElegirEnLaLista, FiltroDeListaBoton, FiltrosDeLista, type Tono } from "@admin-barrios/ui";
import { MarcoTabla, Panel, Tabla, TiraDeChips, ui } from "../../../../../../componentes/ui.tsx";
import { marcasDeLaBoleta, TEXTO_DE_MARCA, type MarcaDeBoleta } from "./textos.ts";
import estilos from "./boletas.module.css";

export type FilaDeBoleta = {
  readonly unidadFuncionalId: string;
  readonly etiqueta: string;
  readonly expensa: string;
  readonly cargos: string;
  readonly saldoAnterior: string;
  readonly interes: string;
  readonly total: string;
  /** Lo que cobra el cupón: con «solo el mes», lo devengado en el mes; si no, el total. */
  readonly cupon: string;
  /** Recibió la bonificación por pago en término que el barrio aplica sola. */
  readonly bonificada: boolean;
  /** Cargos y descuentos sin la bonificación de la regla del barrio. */
  readonly otrosCargos: string;
  /** La bonificación que no recibió (no estaba al día, o se le quitó). `null` si no hay. */
  readonly bonificacionNoAplicada: string | null;
};

type Filtro = "todas" | "interes" | "cargos" | "deuda" | "sin_bonificacion";

const TONO_DE_MARCA: Record<MarcaDeBoleta, Tono> = { sin_bonificacion: "alerta", con_cargos: "info", deuda: "neutro" };

/** Las marcas de una boleta, o «—» si no tiene nada fuera de lo común. */
function Marcas({ marcas }: { readonly marcas: readonly MarcaDeBoleta[] }) {
  if (marcas.length === 0) return <span className={ui.secundaria}>—</span>;
  return (
    <TiraDeChips>
      {marcas.map((m) => (
        <Chip key={m} tono={TONO_DE_MARCA[m]}>
          {TEXTO_DE_MARCA[m]}
        </Chip>
      ))}
    </TiraDeChips>
  );
}

const pesos = (m: string) => `$ ${formatearMonto(m)}`;
const oGuion = (m: string) => (m === "0.00" ? "—" : pesos(m));

export function TablaDeBoletas({
  boletas,
  pdfPorUnidad,
  etiquetaTabla,
  tituloBoleta,
  origenBoleta,
  conceptoExpensa,
  conceptoTotal,
  unidadInicial,
  cuponCobra,
  bonificacionSola,
}: {
  readonly boletas: readonly FilaDeBoleta[];
  /** Qué cobra el cupón este mes. `null` = el barrio no lo configuró: la tabla de siempre. */
  readonly cuponCobra: "solo_mes" | "mes_mas_deuda" | null;
  /** La bonificación por pago en término se aplica sola este mes: hay unidades «Sin bonificación». */
  readonly bonificacionSola: boolean;
  /**
   * Mes emitido: el documento de la boleta de cada unidad, para bajar su PDF por `/api/documentos/[id]`
   * (lee bajo RLS, registra la descarga y redirige a una URL firmada de corta duración). `null` en la
   * vista previa, que no tiene PDF (encargo 14).
   */
  readonly pdfPorUnidad: Readonly<Record<string, string>> | null;
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
  const soloMes = cuponCobra === "solo_mes";
  const marcadas = boletas.map((b) => ({ b, marcas: marcasDeLaBoleta(b) }));
  const con = (m: MarcaDeBoleta) => marcadas.filter((x) => x.marcas.includes(m)).map((x) => x.b);
  const conInteres = boletas.filter((b) => b.interes !== "0.00");
  // Con «solo el mes» el filtro cuenta lo mismo que la marca (sin las bonificadas: ver `marcasDeLaBoleta`).
  const conCargos = soloMes ? con("con_cargos") : boletas.filter((b) => b.cargos !== "0.00");
  const conDeuda = con("deuda");
  const sinBonificacion = con("sin_bonificacion");
  const visibles =
    filtro === "interes"
      ? conInteres
      : filtro === "cargos"
        ? conCargos
        : filtro === "deuda"
          ? conDeuda
          : filtro === "sin_bonificacion"
            ? sinBonificacion
            : boletas;
  const marcasDe = new Map(marcadas.map((x) => [x.b.unidadFuncionalId, x.marcas]));
  // En la tabla de siempre las columnas ya dicen los cargos y el interés: solo se marca la bonificación.
  const marcasVisibles = (b: FilaDeBoleta): readonly MarcaDeBoleta[] =>
    (marcasDe.get(b.unidadFuncionalId) ?? []).filter((m) => soloMes || m === "sin_bonificacion");
  const ejemplo = boletas.find((b) => b.unidadFuncionalId === unidad) ?? visibles[0] ?? null;

  return (
    <>
      <FiltrosDeLista etiqueta="Qué boletas ver">
        <FiltroDeListaBoton activo={filtro === "todas"} cantidad={boletas.length} alElegir={() => setFiltro("todas")}>
          Todas
        </FiltroDeListaBoton>
        {soloMes ? (
          <FiltroDeListaBoton activo={filtro === "deuda"} cantidad={conDeuda.length} alElegir={() => setFiltro("deuda")}>
            Con deuda
          </FiltroDeListaBoton>
        ) : (
          <FiltroDeListaBoton activo={filtro === "interes"} cantidad={conInteres.length} alElegir={() => setFiltro("interes")}>
            Con interés
          </FiltroDeListaBoton>
        )}
        <FiltroDeListaBoton activo={filtro === "cargos"} cantidad={conCargos.length} alElegir={() => setFiltro("cargos")}>
          Con cargos
        </FiltroDeListaBoton>
        {bonificacionSola ? (
          <FiltroDeListaBoton
            activo={filtro === "sin_bonificacion"}
            cantidad={sinBonificacion.length}
            alElegir={() => setFiltro("sin_bonificacion")}
          >
            Sin bonificación
          </FiltroDeListaBoton>
        ) : null}
      </FiltrosDeLista>

      <div className={estilos.dos}>
        <MarcoTabla etiqueta={etiquetaTabla}>
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Unidad
                </th>
                {soloMes ? null : (
                  <>
                    <th scope="col" className={ui.numerica}>
                      Expensa
                    </th>
                    <th scope="col" className={ui.numerica}>
                      Cargos
                    </th>
                    <th scope="col" className={ui.numerica}>
                      Interés
                    </th>
                  </>
                )}
                {soloMes || bonificacionSola ? <th scope="col">Fuera de lo común</th> : null}
                <th scope="col" className={ui.numerica}>
                  Total
                </th>
                {pdfPorUnidad ? <th scope="col">PDF</th> : null}
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
                  {soloMes ? null : (
                    <>
                      <td className={ui.numerica}>{pesos(b.expensa)}</td>
                      <td className={ui.numerica}>{oGuion(b.cargos)}</td>
                      <td className={ui.numerica}>{oGuion(b.interes)}</td>
                    </>
                  )}
                  {soloMes || bonificacionSola ? (
                    <td>
                      <Marcas marcas={marcasVisibles(b)} />
                    </td>
                  ) : null}
                  {/* Con «solo el mes», el total del renglón es lo que cobra el cupón. */}
                  <td className={ui.numerica}>{pesos(soloMes ? b.cupon : b.total)}</td>
                  {pdfPorUnidad ? (
                    <td>
                      {pdfPorUnidad[b.unidadFuncionalId] ? (
                        <a href={`/api/documentos/${pdfPorUnidad[b.unidadFuncionalId]}`} download>
                          Bajar
                        </a>
                      ) : (
                        <span className={ui.secundaria}>Todavía no</span>
                      )}
                    </td>
                  ) : null}
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
                // Con «solo el mes», la deuda anterior no es un renglón que sume: va abajo, como referencia.
                ...(soloMes
                  ? []
                  : [
                      { concepto: "Saldo anterior", importe: pesos(ejemplo.saldoAnterior) },
                      ...(ejemplo.interes !== "0.00" ? [{ concepto: "Interés por mora", importe: pesos(ejemplo.interes) }] : []),
                    ]),
              ]}
              total={{ concepto: conceptoTotal, importe: pesos(soloMes ? ejemplo.cupon : ejemplo.total) }}
            />
            {soloMes && (marcasDe.get(ejemplo.unidadFuncionalId) ?? []).includes("deuda") ? (
              <p className={ui.secundaria}>
                Deuda de meses anteriores: {pesos(ejemplo.saldoAnterior)}
                {ejemplo.interes !== "0.00" ? `, más ${pesos(ejemplo.interes)} de interés` : ""}. Figura como referencia: no suma
                al total de este cupón.
              </p>
            ) : null}
            {ejemplo.bonificacionNoAplicada !== null ? (
              <p className={ui.secundaria}>
                No recibió la bonificación por pago en término ({pesos(ejemplo.bonificacionNoAplicada)}).
              </p>
            ) : null}
          </Panel>
        ) : null}
      </div>
    </>
  );
}
