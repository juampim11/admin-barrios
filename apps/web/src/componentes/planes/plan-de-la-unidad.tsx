/**
 * La pestaña «Plan de pagos» de la ficha de la unidad (P2a-1; maqueta de planes, pantalla 4): la tabla
 * de cuotas con cómo está cada una hoy, y «El plan» (de dónde salió, qué entró, cuánto se pagó). Los
 * planes anteriores (cumplidos, caídos, rechazados) van abajo, uno por renglón.
 *
 * Servidor, salvo una isla: [P2a-3] «Documentos del plan» (armar el PDF y subir el firmado,
 * `DocumentosDelPlanIsla`). Todas las cifras salen de `planesDeUnidad`; los documentos, de
 * `documentosDelPlan`.
 */
import type { PlanDeUnidad } from "@admin-barrios/data/servicios/planes";
import type { DocumentosDelPlan } from "@admin-barrios/data/servicios/planes-documentos";
import { TEXTO_CLASE_DOCUMENTO_PLAN } from "@admin-barrios/shared/planes-documentos";
import { formatearMonto } from "@admin-barrios/shared/dinero";
import { formatearFecha, formatearFechaHora } from "@admin-barrios/shared/fechas";
import { Chip } from "@admin-barrios/ui";
import { Definicion, Definiciones, MarcoTabla, Panel, Tabla, Vacio, ui } from "../ui.tsx";
import { rutaDelDocumentoDelPlan } from "../../rutas.ts";
import { DocumentosDelPlanIsla } from "./documentos-del-plan.tsx";
import {
  descripcionDelPlan,
  nombreDelPlan,
  numeroDeCuota,
  rangoDeMeses,
  TEXTO_ESTADO_DE_CUOTA,
  TEXTO_CUOTA_PROPUESTA,
  TEXTO_ESTADO_DEL_PLAN,
  TONO_ESTADO_DE_CUOTA,
} from "./textos.ts";

const pesos = (m: string) => `$ ${formatearMonto(m)}`;

/** [P2a-3] Los documentos del plan actual, para su panel. */
export type DocumentosParaLaFicha = {
  readonly datos: DocumentosDelPlan;
  readonly subidaConfigurada: boolean;
  readonly rutaDeLosModelos: string;
};

export function PlanDeLaUnidad({
  planes,
  documentos = null,
}: {
  readonly planes: readonly PlanDeUnidad[];
  readonly documentos?: DocumentosParaLaFicha | null;
}) {
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
                    {actual.estado === "pendiente" ? (
                      <Chip tono="neutro">{TEXTO_CUOTA_PROPUESTA}</Chip>
                    ) : (
                      <Chip tono={TONO_ESTADO_DE_CUOTA[c.estado]}>{TEXTO_ESTADO_DE_CUOTA[c.estado]}</Chip>
                    )}
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
          {actual.actaReferencia ? (
            <Definicion termino="Acta del barrio">
              {actual.actaReferencia}
              {actual.actaAdjunta ? " · con el acta adjunta" : ""}
            </Definicion>
          ) : actual.pideActa && actual.estado === "pendiente" ? (
            <Definicion termino="Acta del barrio">Falta: el barrio la exige para aprobar la quita.</Definicion>
          ) : null}
        </Definiciones>
      </Panel>

      {documentos && (documentos.datos.puedeAgregar || documentos.datos.documentos.length > 0) ? (
        <Panel
          titulo="Documentos del plan"
          origen="El PDF del acuerdo lo arma el sistema con las cifras del plan. Cada documento queda guardado tal cual se armó o se subió: ninguno reemplaza a otro, y su código de control permite comprobar que no se modificó."
        >
          <DocumentosDelPlanIsla
            planId={actual.id}
            estadoPlan={actual.estado}
            documentos={documentos.datos}
            subidaConfigurada={documentos.subidaConfigurada}
            rutaDeLosModelos={documentos.rutaDeLosModelos}
          />
          {documentos.datos.documentos.length > 0 ? (
            <MarcoTabla etiqueta="Documentos del plan">
              <Tabla>
                <thead>
                  <tr>
                    <th scope="col" className={ui.columnaAncla}>
                      Documento
                    </th>
                    <th scope="col">Cuándo y quién</th>
                    <th scope="col">Código de control</th>
                    <th scope="col">
                      <span className={ui.soloLectores}>Ver</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {documentos.datos.documentos.map((d) => (
                    <tr key={d.id}>
                      <th scope="row" className={ui.columnaAncla}>
                        <span className={ui.principal}>{TEXTO_CLASE_DOCUMENTO_PLAN[d.clase]}</span>
                        <br />
                        <span className={ui.secundaria}>
                          {d.nombre ? `${d.nombre} · ` : ""}con el plan {TEXTO_ESTADO_DEL_PLAN[d.estadoPlan].toLowerCase()}
                        </span>
                      </th>
                      <td>
                        {formatearFechaHora(d.registradoEl)}
                        <br />
                        <span className={ui.secundaria}>{d.registradoPor}</span>
                      </td>
                      <td>
                        {/* Entero, para que se lea y se compare (con `title` solo, no lo alcanza el teclado ni un lector de pantalla). */}
                        <span className={ui.secundaria}>{d.sha256}</span>
                      </td>
                      <td>
                        <a
                          href={rutaDelDocumentoDelPlan(d.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Ver ${TEXTO_CLASE_DOCUMENTO_PLAN[d.clase].toLowerCase()} del ${formatearFechaHora(d.registradoEl)} (se abre en otra pestaña)`}
                        >
                          Ver
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Tabla>
            </MarcoTabla>
          ) : null}
        </Panel>
      ) : null}

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
