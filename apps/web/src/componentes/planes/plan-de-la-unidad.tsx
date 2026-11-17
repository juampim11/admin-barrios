/**
 * La pestaña «Plan de pagos» de la ficha de la unidad (P2a-1; maqueta de planes, pantalla 4): la tabla
 * de cuotas con cómo está cada una hoy, y «El plan» (de dónde salió, qué entró, cuánto se pagó). Los
 * planes anteriores (cumplidos, caídos, rechazados) van abajo, uno por renglón.
 *
 * Servidor de punta a punta: cero JavaScript. Todas las cifras salen de `planesDeUnidad`.
 */
import type { PlanDeUnidad } from "@admin-barrios/data/servicios/planes";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { Chip } from "@admin-barrios/ui";
import { Definicion, Definiciones, MarcoTabla, Panel, Tabla, Vacio, ui } from "../ui.tsx";
import {
  descripcionDelPlan,
  nombreDelPlan,
  numeroDeCuota,
  rangoDeMeses,
  TEXTO_ESTADO_DE_CUOTA,
  TEXTO_ESTADO_DEL_PLAN,
  TONO_ESTADO_DE_CUOTA,
} from "./textos.ts";

const pesos = (m: string) => `$ ${formatearMonto(m)}`;

export function PlanDeLaUnidad({ planes }: { readonly planes: readonly PlanDeUnidad[] }) {
  const [actual, ...anteriores] = planes;
  if (!actual) {
    return (
      <Vacio titulo="Esta unidad no tiene planes de pago">La deuda sigue en la boleta, mes por mes.</Vacio>
    );
  }
  const cantidad = actual.cuotas.filter((c) => c.numero > 0).length;
  return (
    <>
      <Panel
        titulo={`${nombreDelPlan(actual)} · ${TEXTO_ESTADO_DEL_PLAN[actual.estado]}`}
        origen={descripcionDelPlan(actual)}
      >
        <MarcoTabla etiqueta="Cuotas del plan">
          <Tabla>
            <thead>
              <tr>
                <th scope="col" className={ui.columnaAncla}>
                  Cuota
                </th>
                <th scope="col">Vence</th>
                <th scope="col" className={ui.numerica}>
                  Importe
                </th>
                <th scope="col" className={ui.numerica}>
                  Pagado
                </th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {actual.cuotas.map((c) => (
                <tr key={c.numero}>
                  <th scope="row" className={ui.columnaAncla}>
                    {numeroDeCuota(c, cantidad)}
                  </th>
                  <td>{formatearFecha(c.vencimiento)}</td>
                  <td className={ui.numerica}>{formatearMonto(c.importe)}</td>
                  <td className={ui.numerica}>{c.pagado === null ? "—" : formatearMonto(c.pagado)}</td>
                  <td>
                    <Chip tono={TONO_ESTADO_DE_CUOTA[c.estado]}>{TEXTO_ESTADO_DE_CUOTA[c.estado]}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </Tabla>
        </MarcoTabla>
      </Panel>

      <Panel
        titulo="El plan"
        origen={
          actual.fechaFirma
            ? `Firmado el ${formatearFecha(actual.fechaFirma)}${actual.firmadoPor ? ` · lo registró ${actual.firmadoPor}` : ""}.`
            : "Todavía no se firmó."
        }
      >
        <Definiciones>
          <Definicion termino="Deuda que entró">
            {pesos(actual.deuda)} ({rangoDeMeses(actual.meses)}): capital {pesos(actual.deudaCapital)} y mora a la firma{" "}
            {pesos(actual.deudaInteres)}
          </Definicion>
          {actual.quita !== "0.00" ? <Definicion termino="Se perdonó">{pesos(actual.quita)}</Definicion> : null}
          <Definicion termino="Total del plan">
            {pesos(actual.totalCuotas)}
            {actual.tasaPorcentaje ? ` · francés al ${actual.tasaPorcentaje} % mensual` : ""}
          </Definicion>
          <Definicion termino="Pagado">{pesos(actual.pagado)}</Definicion>
          <Definicion termino="Firma">
            {actual.fechaFirma ? `${formatearFecha(actual.fechaFirma)}${actual.firmadoPor ? ` · lo registró ${actual.firmadoPor}` : ""}` : "Todavía no se firmó"}
          </Definicion>
          <Definicion termino="Cae con">
            {actual.cuotasParaCaer === 1 ? "1 cuota impaga vencida" : `${actual.cuotasParaCaer} cuotas impagas vencidas`} · la
            declara la administración
          </Definicion>
          {actual.cargoCaida !== null ? (
            <Definicion termino="Cargo de la caída">
              {pesos(actual.cargoCaida)} de mora, del {actual.fechaFirma ? formatearFecha(actual.fechaFirma) : "—"} al{" "}
              {actual.cerradoEl ? formatearFecha(actual.cerradoEl) : "—"}
            </Definicion>
          ) : null}
          {actual.motivo ? <Definicion termino="Motivo del acuerdo">{actual.motivo}</Definicion> : null}
        </Definiciones>
      </Panel>

      {anteriores.length > 0 ? (
        <Panel titulo="Planes anteriores">
          <MarcoTabla etiqueta="Planes anteriores de la unidad">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Plan
                  </th>
                  <th scope="col">Estado</th>
                  <th scope="col" className={ui.numerica}>
                    Deuda que entró
                  </th>
                  <th scope="col" className={ui.numerica}>
                    Pagado
                  </th>
                </tr>
              </thead>
              <tbody>
                {anteriores.map((p) => (
                  <tr key={p.id}>
                    <th scope="row" className={ui.columnaAncla}>
                      <span className={ui.principal}>{nombreDelPlan(p)}</span>
                      <br />
                      <span className={ui.secundaria}>{p.fechaFirma ? `Firmado el ${formatearFecha(p.fechaFirma)}` : "Sin firmar"}</span>
                    </th>
                    <td>{TEXTO_ESTADO_DEL_PLAN[p.estado]}</td>
                    <td className={ui.numerica}>{formatearMonto(p.deuda)}</td>
                    <td className={ui.numerica}>{formatearMonto(p.pagado)}</td>
                  </tr>
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        </Panel>
      ) : null}
    </>
  );
}
