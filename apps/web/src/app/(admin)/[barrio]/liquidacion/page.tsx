import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarPeriodos } from "@admin-barrios/data/servicios/periodos";
import { formatearFecha, formatearPeriodo } from "@admin-barrios/shared/fechas";
import { IconoBorrador } from "../../../../componentes/iconos.tsx";
import {
  Cifra,
  EncabezadoDePagina,
  MarcoTabla,
  Pagina,
  Panel,
  Tabla,
  Vacio,
  ui,
} from "../../../../componentes/ui.tsx";
import { EstadoDelPeriodo, etiquetaModelo } from "../../../../componentes/etiquetas.tsx";
import { esIdValido } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import estilos from "./liquidacion.module.css";

export const metadata: Metadata = { title: "Liquidación" };

/**
 * Los períodos del barrio, del más nuevo al más viejo.
 *
 * Sin paginado y sin filtros: son doce por año. Lo que sí necesita cada fila es **su denominador**:
 * "50 liquidaciones" no dice nada, "50 de 50 unidades activas" sí — y cuando esos dos números no
 * coinciden en un período ya emitido, eso es un hallazgo que hay que poder ver desde el listado. Por
 * eso la pantalla lee también el barrio: no para autorizar nada, sino para tener contra qué comparar.
 *
 * Las dos lecturas van en **una** transacción.
 */
export default async function Periodos({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
}) {
  const { barrio: barrioId } = await params;
  // Ídem el layout: se renderizan en paralelo, así que el chequeo va en los dos (ver `rutas.ts`).
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    periodos: await listarPeriodos(tx, { barrioId }),
  }));

  if (!datos.barrio) notFound();
  const barrio = datos.barrio;
  const periodos = datos.periodos;

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo="Liquidación"
        bajada={
          periodos.length === 0
            ? undefined
            : `${periodos.length} ${periodos.length === 1 ? "período" : "períodos"} en ${barrio.nombre}, del más nuevo al más viejo.`
        }
      />

      <Panel
        titulo="Períodos"
        origen={
          <>
            Los importes son los que quedaron escritos <strong>al generar el borrador</strong>: si un
            período todavía no se liquidó, la columna dice «sin liquidar» y no cero.
          </>
        }
        sinRelleno
      >
        {periodos.length === 0 ? (
          <Vacio icono={<IconoBorrador />} titulo="Todavía no hay períodos">
            {barrio.tieneCoeficientesVigentes
              ? "El barrio tiene una versión de coeficientes cerrada y vigente: está en condiciones de liquidar su primer período."
              : "Para poder liquidar hace falta una versión de coeficientes cerrada y vigente, y este barrio todavía no la tiene."}
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Períodos de expensa del barrio">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Período
                  </th>
                  <th scope="col">Estado</th>
                  <th scope="col">Vencimientos</th>
                  <th scope="col" className={ui.numerica}>
                    Gastos liquidados
                  </th>
                  <th scope="col" className={ui.numerica}>
                    Cargos
                  </th>
                  <th scope="col" className={ui.numerica}>
                    Descuentos
                  </th>
                  <th scope="col">Liquidaciones</th>
                </tr>
              </thead>
              <tbody>
                {periodos.map((periodo) => (
                  <tr key={periodo.id}>
                    <th scope="row" className={ui.columnaAncla}>
                      <Link href={`/${barrio.id}/liquidacion/${periodo.id}`} className={estilos.mes}>
                        {formatearPeriodo(periodo.periodo)}
                      </Link>
                      <span className={ui.secundaria}> {etiquetaModelo(periodo.modelo)}</span>
                    </th>
                    <td>
                      <EstadoDelPeriodo estado={periodo.estado} editable={periodo.editable} />
                    </td>
                    <td>
                      <span className={estilos.vencimientos}>
                        <span>
                          {periodo.primerVencimiento
                            ? `1.º ${formatearFecha(periodo.primerVencimiento)}`
                            : "—"}
                        </span>
                        <span className={ui.secundaria}>
                          {periodo.segundoVencimiento
                            ? `2.º ${formatearFecha(periodo.segundoVencimiento)}`
                            : "sin segundo vencimiento"}
                        </span>
                      </span>
                    </td>
                    <td className={ui.numerica}>
                      <Cifra monto={periodo.totalGastos} nulo="sin liquidar" />
                    </td>
                    <td className={ui.numerica}>
                      <Cifra monto={periodo.totalCargos} nulo="sin liquidar" signo />
                    </td>
                    <td className={ui.numerica}>
                      <Cifra monto={periodo.totalDescuentos} nulo="sin liquidar" signo />
                    </td>
                    <td>
                      <span className={estilos.cobertura}>
                        <span>
                          <span className="dinero">{periodo.liquidaciones}</span> de{" "}
                          <span className="dinero">{barrio.unidadesActivas}</span>
                        </span>
                        <span className={ui.secundaria}>unidades activas hoy</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>
    </Pagina>
  );
}
