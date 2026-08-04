import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarPeriodos } from "@admin-barrios/data/servicios/periodos";
import { formatearFecha, formatearPeriodo } from "@admin-barrios/shared/fechas";
import { BarraDeAcciones, Boton, IconoFlecha, IconoMas } from "@admin-barrios/ui";
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
        acciones={
          <Boton href={`/${barrio.id}/liquidacion/nuevo`} variante="primario" icono={<IconoMas />}>
            Nuevo período
          </Boton>
        }
      />

      <EnCurso barrioId={barrio.id} periodos={periodos} />

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
              : "Para poder liquidar hace falta una versión de coeficientes cerrada y vigente, y este barrio todavía no la tiene."}{" "}
            <Link href={`/${barrio.id}/liquidacion/nuevo`}>Crear el primer período</Link>.
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
                  {/*
                    La columna existe por la observación A-2: abrir un período se hacía clickeando el
                    número del mes, y la fila entera "parecía inerte". El enlace del mes sigue —quien
                    ya lo aprendió no pierde el gesto—, pero ahora la acción está **nombrada** y tiene
                    su lugar fijo a la derecha, que es donde se la busca.
                  */}
                  <th scope="col">Abrir</th>
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
                    <td>
                      <Boton
                        href={`/${barrio.id}/liquidacion/${periodo.id}`}
                        tamano="sm"
                        iconoAlFinal={<IconoFlecha direccion="derecha" />}
                        etiqueta={`Abrir el período ${formatearPeriodo(periodo.periodo)}`}
                      >
                        Abrir
                      </Boton>
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

/**
 * La tarjeta del período en curso, arriba de la lista (doc 06 §c.6.5 + observación A-2).
 *
 * **Qué es "en curso": el más nuevo que todavía se puede tocar.** `editable` no lo decide esta
 * pantalla ni este componente: lo escribe el trigger `app.periodo_editable` en la base, y acá se lee.
 * Si el último mes ya se emitió, no hay nada en curso y la tarjeta no se dibuja — no se inventa un
 * "próximo período" que no existe.
 *
 * **Por qué "continuar" lleva al resumen y no al paso donde quedó.** Deducir el paso a partir de los
 * datos —hay gastos pero no liquidaciones, entonces va a revisión— es una regla de negocio, y una
 * regla de negocio escrita en un componente es lo que ADR-0002 §5.2 prohíbe y ningún test detecta.
 * El resumen es la casa del mes y tiene el recorrido completo a la vista: se llega al paso que
 * corresponda en un clic, y quien decide cuál es sigue siendo la persona que sabe.
 */
function EnCurso({
  barrioId,
  periodos,
}: {
  readonly barrioId: string;
  readonly periodos: Awaited<ReturnType<typeof listarPeriodos>>;
}) {
  const enCurso = periodos.find((p) => p.editable);
  if (!enCurso) return null;

  return (
    <Panel
      titulo="El mes que está abierto"
      origen="El período más nuevo que todavía admite cambios. Lo define el estado en la base, no esta pantalla."
    >
      <p>
        <span className={estilos.mes}>{formatearPeriodo(enCurso.periodo)}</span>{" "}
        <EstadoDelPeriodo estado={enCurso.estado} editable={enCurso.editable} />
      </p>
      <p>
        <Cifra monto={enCurso.totalGastos} nulo="Todavía sin liquidar" /> repartidos entre{" "}
        <span className="dinero">{enCurso.liquidaciones}</span> unidades.
      </p>
      <BarraDeAcciones>
        <Boton
          href={`/${barrioId}/liquidacion/${enCurso.id}`}
          variante="primario"
          iconoAlFinal={<IconoFlecha direccion="derecha" />}
        >
          Continuar liquidación
        </Boton>
        <Boton href={`/${barrioId}/liquidacion/${enCurso.id}/gastos`}>Cargar gastos</Boton>
      </BarraDeAcciones>
    </Panel>
  );
}
