import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { leerPeriodo } from "@admin-barrios/data/servicios/periodos";
import { listarAplicaciones, type AplicacionDeLista } from "@admin-barrios/data/servicios/cargos";
import { listarConceptosBoleta } from "@admin-barrios/data/servicios/conceptos-boleta";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { formatearDecimal } from "@admin-barrios/shared/dinero";
import { formatearFecha, formatearPeriodo, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { BarraDeFiltros, Boton, Chip, FiltroDeLista, FiltrosDeLista, IconoMas } from "@admin-barrios/ui";
import { IconoBorrador } from "../../../../../../componentes/iconos.tsx";
import {
  Cifra,
  EncabezadoDePagina,
  MarcoTabla,
  Nota,
  Pagina,
  Panel,
  PilaDeNotas,
  Tabla,
  Vacio,
  ui,
} from "../../../../../../componentes/ui.tsx";
import {
  ESTADO_PERIODO_COMO_HECHO,
  ESTADO_PERIODO_QUE_SIGNIFICA,
  EstadoDelPeriodo,
  etiquetaMetodo,
} from "../../../../../../componentes/etiquetas.tsx";
import { esIdValido, hrefDeLista, leerListo, migaDelBarrio, rutasDelPeriodo, salidasDelPeriodo } from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import { FrentesDelPeriodo } from "../pasos.tsx";
import { AnularAplicacion } from "./formularios.tsx";
import estilos from "./cargos.module.css";

export const metadata: Metadata = { title: "Cargos y descuentos" };

const FILTROS_CARGOS = ["todos", "vigentes", "anulados"] as const;
type FiltroCargos = (typeof FILTROS_CARGOS)[number];
const NOMBRE_DEL_FILTRO: Record<FiltroCargos, string> = { todos: "Todos", vigentes: "Vigentes", anulados: "Anulados" };

/** El filtro llega por la URL, o sea del cliente: se valida con Zod. Uno desconocido es «Todos». */
const consultaSchema = z.object({ filtro: z.enum(FILTROS_CARGOS).catch("todos") });

/**
 * **Paso 2 del recorrido: lo que se le cobra —o se le descuenta— a una unidad en particular.**
 *
 * Es la pantalla del quincho alquilado, del invitado de más, de la bonificación al que paga en fecha.
 * No es prorrateo: acá cada renglón va a la boleta de una sola unidad.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTA PANTALLA MUESTRA Y POR QUÉ CADA COLUMNA ESTÁ
 *
 * - **Importe** es `importeResuelto`, que lo escribe `app.resolver_aplicaciones()` al generar el
 *   borrador. Mientras el borrador no se generó, es `null` — y se dice "se conoce al liquidar", no
 *   `$ 0,00`. La diferencia es plata.
 * - **Sin tope** aparece solo cuando difiere del importe: significa que el tope del descuento
 *   **mordió**. Es la única forma de contestar "¿por qué me descontaron menos de lo que decía?".
 * - **Las anuladas se muestran**, con su fecha y su motivo. Ocultarlas dejaría la pantalla contando
 *   una historia distinta de la del registro de eventos, y el motivo de una anulación es justamente lo
 *   que hay que poder mirar cuando alguien pregunta por qué esa plata no se cobró.
 * - **Filtro «Vigentes» / «Anulados»** (encargo 8, T1): links `?filtro=` con su conteo, como en el
 *   padrón. Solo recorta la lista de aplicados; las notas y el resto de la pantalla no cambian. Por
 *   defecto («Todos») las anuladas siguen a la vista, por lo de arriba.
 */
export default async function Cargos({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();

  const crudos = await searchParams;
  const filtro: FiltroCargos = consultaSchema.parse({
    filtro: typeof crudos["filtro"] === "string" ? crudos["filtro"] : undefined,
  }).filtro;
  const listo = leerListo(crudos, "cargo");

  // Las tres lecturas van en UNA transacción y secuenciales: `node-postgres` encola las consultas de
  // un mismo client, así que un `Promise.all` no paralelizaría nada. El padrón del formulario se lee
  // en su página (`cargos/nuevo`, encargo 9, §2); el catálogo sigue acá, que lo muestra abajo.
  const datos = await conSesion(async (tx) => {
    const periodo = await leerPeriodo(tx, { periodoId });
    if (!periodo) return { periodo: null, aplicaciones: [], conceptos: [] };
    return {
      periodo,
      aplicaciones: await listarAplicaciones(tx, { periodoId }),
      conceptos: await listarConceptosBoleta(tx, { barrioId: periodo.barrioId }),
    };
  });

  if (!datos.periodo || datos.periodo.barrioId !== barrioId) notFound();
  const { periodo, aplicaciones, conceptos } = datos;

  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const salidas = salidasDelPeriodo(barrioId, periodoId);

  // «Listo:» de una aplicación recién guardada, con la fila releída bajo RLS (no con lo que dice la URL).
  const recienAplicada = listo?.id ? (aplicaciones.find((a) => a.id === listo.id) ?? null) : null;

  const vigentes = aplicaciones.filter((a) => a.anuladoAt === null);
  const anuladas = aplicaciones.filter((a) => a.anuladoAt !== null);
  const sinResolver = vigentes.filter((a) => a.importeResuelto === null).length;
  const listadas = { todos: [...vigentes, ...anuladas], vigentes, anulados: anuladas }[filtro];
  const hrefFiltro = (f: FiltroCargos): string => hrefDeLista(rutas.cargos, { filtro: f === "todos" ? null : f });

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[
          migaDelBarrio({ id: barrioId, nombre: periodo.barrioNombre }),
          { texto: "Liquidación", href: rutas.periodos },
          { texto: nombreDelPeriodo(periodo.periodo), href: rutas.resumen },
          { texto: "Cargos y descuentos" },
        ]}
        titulo={
          <span className={estilos.identidad}>
            Cargos y descuentos de{" "}
            <span className={estilos.mes}>{formatearPeriodo(periodo.periodo)}</span>
            <EstadoDelPeriodo estado={periodo.estado} editable={periodo.editable} />
          </span>
        }
        bajada={
          <>
            {periodo.barrioNombre} · {ESTADO_PERIODO_QUE_SIGNIFICA[periodo.estado]}. A diferencia de
            los gastos, esto <strong>no se reparte</strong>: cada renglón va a la boleta de una sola
            unidad.
          </>
        }
        acciones={
          periodo.editable ? (
            <Boton href={rutas.nuevoCargo} variante="primario" icono={<IconoMas />}>
              Aplicar a una unidad
            </Boton>
          ) : null
        }
      />

      <FrentesDelPeriodo barrioId={barrioId} periodoId={periodoId} />

      <PilaDeNotas>
        {listo ? (
          <Nota
            tono="exito"
            titulo={
              recienAplicada
                ? `Listo: quedó aplicado «${recienAplicada.nombreConcepto}» (${recienAplicada.clase === "descuento" ? "descuento" : "cargo"}) a ${etiquetaUnidad(recienAplicada.manzana, recienAplicada.lote)}.`
                : "Listo: el cargo quedó aplicado."
            }
          >
            {recienAplicada?.confirmadoPorMontoInusual
              ? "Quedó registrado que se confirmó un importe fuera de lo habitual para esa unidad. "
              : ""}
            {recienAplicada && recienAplicada.importeResuelto === null
              ? "El importe se conoce al generar el borrador: no es cero, es que todavía no hay número."
              : ""}
          </Nota>
        ) : null}

        {!periodo.editable ? (
          <Nota
            tono="info"
            titulo={`Este período ya ${ESTADO_PERIODO_COMO_HECHO[periodo.estado]}: no admite cambios.`}
          >
            Los cargos que están abajo son los que quedaron impresos en las boletas. Si hay que
            corregir alguno, se registra en el período siguiente.
          </Nota>
        ) : null}

        {sinResolver > 0 ? (
          <Nota
            tono="info"
            titulo={`${sinResolver} de ${vigentes.length} ${vigentes.length === 1 ? "cargo" : "cargos"} todavía no ${sinResolver === 1 ? "tiene" : "tienen"} importe.`}
          >
            No es un problema ni un cero: el importe de un cargo se resuelve cuando se{" "}
            <a href={rutas.revision}>genera el borrador</a>, porque un descuento porcentual se calcula
            sobre la expensa de esa unidad, que hasta ese momento no existe.
          </Nota>
        ) : null}
      </PilaDeNotas>


      {aplicaciones.length > 0 ? (
        <BarraDeFiltros>
          <FiltrosDeLista etiqueta="Filtrar los cargos y descuentos aplicados">
            <FiltroDeLista href={hrefFiltro("todos")} activo={filtro === "todos"} cantidad={aplicaciones.length}>
              Todos
            </FiltroDeLista>
            <FiltroDeLista href={hrefFiltro("vigentes")} activo={filtro === "vigentes"} cantidad={vigentes.length}>
              Vigentes
            </FiltroDeLista>
            <FiltroDeLista href={hrefFiltro("anulados")} activo={filtro === "anulados"} cantidad={anuladas.length}>
              Anulados
            </FiltroDeLista>
          </FiltrosDeLista>
        </BarraDeFiltros>
      ) : null}

      <Panel
        titulo="Aplicados en el período"
        origen={
          <>
            Los importes los resuelve el sistema al generar el borrador, con el valor que quedó congelado
            en cada fila — no con el del catálogo de hoy. Las <strong>anuladas</strong> siguen a la
            vista, con su motivo: es la única explicación de por qué esa plata no se cobró.
          </>
        }
        sinRelleno
      >
        {aplicaciones.length === 0 ? (
          <Vacio icono={<IconoBorrador />} titulo="Todavía no se aplicó ningún cargo ni descuento">
            Es lo normal en la mayoría de los meses. Si no hubo quincho, invitados ni bonificaciones,
            este paso se saltea y se pasa derecho a la revisión.
          </Vacio>
        ) : listadas.length === 0 ? (
          <Vacio icono={<IconoBorrador />} titulo={`No hay cargos ni descuentos en el filtro «${NOMBRE_DEL_FILTRO[filtro]}»`}>
            {filtro === "vigentes"
              ? "Todos los aplicados en este período están anulados."
              : "Ninguno de los aplicados en este período está anulado."}{" "}
            Para sacar el filtro, <Link href={hrefFiltro("todos")}>mirá todos</Link>.
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Cargos y descuentos aplicados en el período">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Unidad
                  </th>
                  <th scope="col">Concepto</th>
                  <th scope="col">Fecha del hecho</th>
                  <th scope="col" className={ui.numerica}>
                    Cantidad
                  </th>
                  <th scope="col" className={ui.numerica}>
                    Importe
                  </th>
                  <th scope="col" className={ui.numerica}>
                    Sin tope
                  </th>
                  <th scope="col">Estado</th>
                  {periodo.editable ? <th scope="col">Acciones</th> : null}
                </tr>
              </thead>
              <tbody>
                {listadas.map((a) => (
                  <FilaDeAplicacion
                    key={a.id}
                    aplicacion={a}
                    editable={periodo.editable}
                    salidas={salidas}
                  />
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>

      <Panel
        titulo="Catálogo de conceptos del barrio"
        origen="Lo que se puede aplicar y con qué valor vigente hoy. El alta de conceptos todavía no se hace desde la aplicación."
        sinRelleno
      >
        {conceptos.length === 0 ? (
          <Vacio icono={<IconoBorrador />} titulo="El catálogo está vacío" />
        ) : (
          <MarcoTabla etiqueta="Catálogo de conceptos de boleta del barrio">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Concepto
                  </th>
                  <th scope="col">Método</th>
                  <th scope="col" className={ui.numerica}>
                    Valor vigente hoy
                  </th>
                  <th scope="col" className={ui.numerica}>
                    Tope
                  </th>
                  <th scope="col">Quién lo aplica</th>
                </tr>
              </thead>
              <tbody>
                {conceptos.map((c) => (
                  <tr key={c.id}>
                    <th scope="row" className={ui.columnaAncla}>
                      <span className={estilos.apilado}>
                        <span className={ui.principal}>{c.nombre}</span>
                        <span>
                          <Chip tono={c.clase === "cargo" ? "info" : "exito"}>
                            {c.clase === "cargo" ? "Cargo" : "Descuento"}
                          </Chip>
                        </span>
                      </span>
                    </th>
                    <td>{etiquetaMetodo(c.metodo)}</td>
                    <td className={ui.numerica}>
                      {c.valorVigente ? (
                        <span className={estilos.apilado}>
                          {/*
                            Un porcentaje **no** puede ir por la ranura `nulo` de `Cifra`: esa ranura es
                            para "no hay dato" y se dibuja en gris e itálica. Un `10 %` real pintado como
                            faltante se lee como que el concepto no tiene valor cargado, que es lo
                            contrario de lo que pasa. Se muestra con `formatearDecimal(…, 2)` — los seis
                            decimales que guarda la base son precisión de cálculo, no de lectura.
                          */}
                          {c.valorVigente.porcentaje ? (
                            <span className="dinero">
                              {formatearDecimal(c.valorVigente.porcentaje, 2)} %
                            </span>
                          ) : (
                            <Cifra
                              monto={c.valorVigente.montoFijo ?? c.valorVigente.precioUnitario}
                              nulo="—"
                            />
                          )}
                          <span className={ui.secundaria}>
                            desde {formatearFecha(c.valorVigente.vigenteDesde)}
                          </span>
                        </span>
                      ) : (
                        <span className={ui.secundaria}>sin valor vigente hoy</span>
                      )}
                    </td>
                    <td className={ui.numerica}>
                      <Cifra monto={c.valorVigente?.tope ?? null} nulo="sin tope" />
                    </td>
                    <td>
                      {c.requiereAdmin ? (
                        <Chip tono="alerta">Solo un administrador</Chip>
                      ) : (
                        <span className={ui.secundaria}>Cualquier rol de gestión</span>
                      )}
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

function FilaDeAplicacion({
  aplicacion,
  editable,
  salidas,
}: {
  readonly aplicacion: AplicacionDeLista;
  readonly editable: boolean;
  readonly salidas: ReturnType<typeof salidasDelPeriodo>;
}) {
  const anulada = aplicacion.anuladoAt !== null;
  // El tope mordió: hubo un importe sin tope y quedó distinto del que se va a cobrar. Se declara solo
  // cuando los dos números existen — no se compara contra un `null` haciéndolo pasar por cero.
  const topeMordio =
    aplicacion.importeSinTope !== null &&
    aplicacion.importeResuelto !== null &&
    aplicacion.importeSinTope !== aplicacion.importeResuelto;

  return (
    <tr className={anulada ? estilos.filaAnulada : undefined}>
      <th scope="row" className={ui.columnaAncla}>
        <span className={estilos.apilado}>
          <span className={ui.principal}>{etiquetaUnidad(aplicacion.manzana, aplicacion.lote)}</span>
        </span>
      </th>
      <td>
        <span className={estilos.apilado}>
          <span>{aplicacion.nombreConcepto}</span>
          <span className={ui.secundaria}>{aplicacion.detalle}</span>
        </span>
      </td>
      <td>{formatearFecha(aplicacion.fechaHecho)}</td>
      <td className={ui.numerica}>
        {/*
          `formatearDecimal` y no el string crudo de Postgres. `cantidad` es `numeric(_,3)`, así que la
          base devuelve `"90.000"` para noventa — y en castellano rioplatense el punto es el separador
          de miles: la celda decía **noventa mil jornadas de quincho**. Con la coma decimal la lectura
          es la que corresponde, y los tres decimales son los que el esquema admite (media jornada es
          `2,500`).
        */}
        {aplicacion.cantidad ? (
          formatearDecimal(aplicacion.cantidad, 3)
        ) : (
          <span className={ui.secundaria}>—</span>
        )}
      </td>
      <td className={ui.numerica}>
        {/*
          `montoResuelto` y no `importeResuelto`: es el que lleva el signo, o sea el que suma en la
          boleta. Un descuento tiene que verse negativo — mostrarlo en positivo al lado de un cargo
          convierte la columna en una lista de números sin sentido.
        */}
        <Cifra monto={aplicacion.montoResuelto} nulo="se conoce al liquidar" signo />
      </td>
      <td className={ui.numerica}>
        {topeMordio ? (
          <span className={estilos.apilado}>
            <Cifra monto={aplicacion.importeSinTope} nulo="—" />
            <span className={estilos.topeMordio}>el tope recortó</span>
          </span>
        ) : (
          <span className={ui.secundaria}>—</span>
        )}
      </td>
      <td>
        {anulada ? (
          <span className={estilos.apilado}>
            <span>
              <Chip tono="peligro">Anulado</Chip>
            </span>
            <span className={ui.secundaria}>{aplicacion.motivoAnulacion}</span>
          </span>
        ) : (
          <span className={estilos.apilado}>
            <span>
              <Chip tono="exito">Vigente</Chip>
            </span>
            {/*
              Que alguien haya confirmado un importe inusual es **información de auditoría**, no un
              detalle: es la respuesta a "¿por qué le cobraron esto?" el mes que viene. Ocultarla acá
              obligaría a ir a buscarla a la base.
            */}
            {aplicacion.confirmadoPorMontoInusual ? (
              <span>
                <Chip tono="alerta">Importe confirmado a mano</Chip>
              </span>
            ) : null}
          </span>
        )}
      </td>
      {editable ? (
        <td>
          {anulada ? (
            <span className={ui.secundaria}>—</span>
          ) : (
            <AnularAplicacion
              aplicacionId={aplicacion.id}
              descripcion={`${aplicacion.nombreConcepto} de ${etiquetaUnidad(aplicacion.manzana, aplicacion.lote)}`}
              salidas={salidas}
            />
          )}
        </td>
      ) : null}
    </tr>
  );
}
