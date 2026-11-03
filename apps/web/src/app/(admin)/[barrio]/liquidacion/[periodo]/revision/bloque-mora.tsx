/**
 * El bloque «Interés por mora» de la revisión — pantalla 3 de la maqueta T1 (ADR-0006).
 *
 * Reemplaza al aviso de "mora pendiente de definición": dice **con qué parámetros se calculó** el
 * interés de este período (lo que quedó guardado en la liquidación al generar el borrador, no lo que
 * rige hoy), de dónde sale cada uno —propio del barrio o heredado de la configuración general— y desde
 * cuándo rige, con el respaldo de las tasas. Con «Cobra interés por mora: No», lo dice así: es una
 * decisión con fecha, no un hueco.
 *
 * Server component: compone piezas del kit y no calcula nada. Las cifras salen de
 * `leerMoraDelPeriodo()`, que las suma en SQL sobre el período entero.
 */

import Link from "next/link";
import type { MoraDelPeriodo } from "@admin-barrios/data/servicios/liquidaciones";
import {
  ETIQUETA_RESPALDO,
  textoDeValor,
  type ClaveParametro,
  type ValorUsado,
} from "@admin-barrios/shared/parametros-mora";
import { formatearFecha, formatearPeriodo } from "@admin-barrios/shared/fechas";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { Chip, Cifra, Definicion, Definiciones, Nota, Panel } from "../../../../../../componentes/ui.tsx";

function Origen({ valor }: { readonly valor: ValorUsado }) {
  const desde =
    valor.carga === "inicial" ? "valor inicial" : valor.carga === "migrado" ? "valor migrado" : `rige desde el ${formatearFecha(valor.vigenteDesde)}`;
  return (
    <>
      {" "}
      <Chip tono={valor.origen === "barrio" ? "marca" : "neutro"}>
        {valor.origen === "barrio" ? "Propio del barrio" : "Heredado"}
      </Chip>{" "}
      <span>{desde}</span>
      {valor.respaldo ? (
        <span>
          {" · "}
          {ETIQUETA_RESPALDO[valor.respaldo.tipo]}: {valor.respaldo.referencia}
        </span>
      ) : null}
    </>
  );
}

function textoDe(clave: ClaveParametro, v: ValorUsado | undefined): string {
  if (!v) return "sin definir";
  if (clave === "interes.tolerancia") return `$ ${formatearMonto(String(v.valor))}`;
  return textoDeValor(clave, v.valor);
}

export function BloqueDeMora({
  barrioId,
  mora,
  condonado,
  periodo,
}: {
  readonly barrioId: string;
  readonly mora: MoraDelPeriodo;
  /** El interés condonado en el barrio en el mes del período (ADR-0009). */
  readonly condonado: { readonly total: string; readonly condonaciones: number };
  readonly periodo: string;
}) {
  const enlace = <Link href={`/${barrioId}/configuracion`}>Ver la configuración del barrio</Link>;

  if (mora.parametros === null) {
    // Liquidaciones anteriores a la configuración de mora: lo usado está en cada fila (tasa aplicada).
    return mora.pendiente > 0 ? (
      <Nota tono="alerta" titulo={`${mora.pendiente} de ${mora.unidades} unidades quedaron con la mora pendiente de definición.`}>
        Al liquidarlas no había un valor vigente para algún parámetro de mora, y el sistema no inventa
        uno: salieron sin interés calculado y la boleta lo dice. {enlace}.
      </Nota>
    ) : null;
  }

  const v = mora.parametros.valores;
  const cobra = v["interes.cobra"];

  if (mora.noSeCobra === mora.unidades) {
    return (
      <Panel titulo="Interés por mora" origen="con qué se calculó este período y de dónde sale">
        <Definiciones>
          <Definicion termino="Interés por mora">
            <Chip tono="neutro">No se cobra</Chip> «Cobra interés por mora: No»
            {cobra ? <Origen valor={cobra} /> : null}
          </Definicion>
        </Definiciones>
        <p>
          Ninguna liquidación del período calcula interés, y la boleta lo dice. {enlace}.
        </p>
      </Panel>
    );
  }

  const fila = (clave: ClaveParametro, termino: string, sufijo = "") => {
    const valor = v[clave];
    return (
      <Definicion termino={termino}>
        <span className="dinero">
          {textoDe(clave, valor)}
          {sufijo}
        </span>
        {valor ? <Origen valor={valor} /> : null}
      </Definicion>
    );
  };

  const tramos = mora.parametros.tramos;
  const cambiaEnLaVentana = tramos.length > 1;

  return (
    <Panel
      titulo="Interés por mora"
      origen={
        mora.parametros.ventana
          ? `con qué se calculó: días de atraso del ${formatearFecha(mora.parametros.ventana.desde)} al ${formatearFecha(mora.parametros.ventana.hasta)}`
          : `con qué se calculó: valores vigentes al ${formatearFecha(mora.parametros.fechaReferencia)}`
      }
    >
      <Definiciones>
        {fila("interes.tasa_compensatoria", "Tasa compensatoria", " mensual")}
        {fila("interes.tasa_punitoria", "Tasa punitoria", " mensual")}
        <Definicion termino="Gracia">
          <span className="dinero">{textoDe("interes.gracia_dias", v["interes.gracia_dias"])}</span>,{" "}
          {textoDe("interes.forma_gracia", v["interes.forma_gracia"]).toLowerCase()}
          {v["interes.gracia_dias"] ? <Origen valor={v["interes.gracia_dias"]} /> : null}
        </Definicion>
        {fila("interes.tolerancia", "Tolerancia de saldado")}
        {fila("imputacion.orden", "Orden de imputación")}
        <Definicion termino="Unidades con interés">
          <span className="dinero">
            {mora.conInteres} de {mora.unidades}
          </span>
        </Definicion>
        <Definicion termino="Interés compensatorio">
          <Cifra monto={mora.totalCompensatorio} nulo="—" />
        </Definicion>
        <Definicion termino="Interés punitorio">
          <Cifra monto={mora.totalPunitorio} nulo="—" />
        </Definicion>
        {mora.arrastre ? (
          <>
            <Definicion termino="Saldo anterior arrastrado (capital)">
              <Cifra monto={mora.arrastre.capital} nulo="—" />
            </Definicion>
            <Definicion termino="Interés que quedó pendiente">
              <Cifra monto={mora.arrastre.interesPendiente} nulo="—" />{" "}
              <span className="dinero">de pagos fuera de término y de meses anteriores</span>
            </Definicion>
            <Definicion termino="Interés al corte">
              <Cifra monto={mora.arrastre.interesNuevo} nulo="—" />{" "}
              <span className="dinero">del capital impago, hasta el {formatearFecha(mora.parametros.fechaReferencia)}</span>
            </Definicion>
          </>
        ) : null}
        <Definicion termino={<strong>Interés del período</strong>}>
          <strong>
            <Cifra monto={mora.totalInteres} nulo="—" />
          </strong>
        </Definicion>
        <Definicion termino={`Interés condonado en ${formatearPeriodo(periodo)}`}>
          <Cifra monto={condonado.total} nulo="—" />{" "}
          <span className="dinero">
            {condonado.condonaciones === 0
              ? "ninguna condonación"
              : `${condonado.condonaciones} ${condonado.condonaciones === 1 ? "condonación" : "condonaciones"} en el barrio`}
          </span>
        </Definicion>
      </Definiciones>
      {cambiaEnLaVentana ? (
        <Nota tono="info" titulo="Los parámetros cambiaron dentro de los días de atraso.">
          Cada día devengó con lo que regía ese día:{" "}
          {tramos
            .map((t) =>
              t.cobra
                ? `desde el ${formatearFecha(t.desde)}, ${textoDeValor("interes.tasa_compensatoria", t.tasaCompensatoria)} compensatoria y ${textoDeValor("interes.tasa_punitoria", t.tasaPunitoria)} punitoria`
                : `desde el ${formatearFecha(t.desde)}, sin interés`,
            )
            .join("; ")}
          .
        </Nota>
      ) : null}
      {mora.noSeCobra > 0 ? (
        <p>
          {mora.noSeCobra} de {mora.unidades} unidades no calcularon interés: «Cobra interés por mora: No».
        </p>
      ) : null}
      <p>
        Lo que se ve acá quedó guardado al generar el borrador: si la configuración cambia después, este
        período no cambia. {enlace}.
      </p>
    </Panel>
  );
}
