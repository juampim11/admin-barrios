import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerPeriodo } from "@admin-barrios/data/servicios/periodos";
import { listarAplicaciones, type AplicacionDeLista } from "@admin-barrios/data/servicios/cargos";
import { listarConceptosBoleta } from "@admin-barrios/data/servicios/conceptos-boleta";
import { listarPadron } from "@admin-barrios/data/servicios/padron";
import { formatearDecimal } from "@admin-barrios/shared/dinero";
import { formatearFecha, formatearPeriodo } from "@admin-barrios/shared/fechas";
import { IconoBorrador } from "../../../../../../componentes/iconos.tsx";
import {
  Cifra,
  Chip,
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
import { esIdValido, rutasDelPeriodo, salidasDelPeriodo } from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import { FrentesDelPeriodo } from "../pasos.tsx";
import { AnularAplicacion, FormularioDeAplicacion } from "./formularios.tsx";
import estilos from "./cargos.module.css";

export const metadata: Metadata = { title: "Cargos y descuentos" };

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
 */
export default async function Cargos({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();

  // Las cuatro lecturas van en UNA transacción y secuenciales: `node-postgres` encola las consultas
  // de un mismo client, así que un `Promise.all` no paralelizaría nada.
  const datos = await conSesion(async (tx) => {
    const periodo = await leerPeriodo(tx, { periodoId });
    if (!periodo) return { periodo: null, aplicaciones: [], conceptos: [], unidades: [] };
    return {
      periodo,
      aplicaciones: await listarAplicaciones(tx, { periodoId }),
      conceptos: await listarConceptosBoleta(tx, { barrioId: periodo.barrioId }),
      // El padrón entero: son decenas de unidades y el desplegable las necesita todas. Si un barrio
      // creciera hasta no entrar en el techo del esquema (500), este desplegable deja de ser el
      // control adecuado y hay que cambiarlo por una búsqueda — queda anotado, no disimulado.
      unidades: (await listarPadron(tx, { barrioId: periodo.barrioId, limite: 500 })).unidades,
    };
  });

  if (!datos.periodo || datos.periodo.barrioId !== barrioId) notFound();
  const { periodo, aplicaciones, conceptos } = datos;

  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const salidas = salidasDelPeriodo(barrioId, periodoId);

  const unidades = datos.unidades
    .filter((u) => !u.dadaDeBaja)
    .map((u) => ({
      id: u.id,
      etiqueta: u.etiqueta,
      destinatario: u.obligados.find((o) => o.esNotificado)?.nombre ?? u.obligados[0]?.nombre ?? null,
    }));

  const vigentes = aplicaciones.filter((a) => a.anuladoAt === null);
  const anuladas = aplicaciones.filter((a) => a.anuladoAt !== null);
  const sinResolver = vigentes.filter((a) => a.importeResuelto === null).length;

  return (
    <Pagina>
      <EncabezadoDePagina
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
      />

      <FrentesDelPeriodo barrioId={barrioId} periodoId={periodoId} />

      <PilaDeNotas>
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
            titulo={`${sinResolver} de ${vigentes.length} cargos todavía no tienen importe.`}
          >
            No es un problema ni un cero: el importe de un cargo se resuelve cuando se{" "}
            <a href={rutas.revision}>genera el borrador</a>, porque un descuento porcentual se calcula
            sobre la expensa de esa unidad, que hasta ese momento no existe.
          </Nota>
        ) : null}
      </PilaDeNotas>

      {periodo.editable ? (
        <Panel
          titulo="Aplicar a una unidad"
          origen="El precio, el porcentaje y el tope los pone el catálogo del barrio, congelados al valor vigente a la fecha del hecho. Este formulario no manda ni un importe."
        >
          {conceptos.length === 0 || unidades.length === 0 ? (
            <Vacio
              icono={<IconoBorrador />}
              titulo={
                conceptos.length === 0
                  ? "Este barrio no tiene conceptos de boleta cargados"
                  : "Este barrio no tiene unidades activas en el padrón"
              }
            >
              {conceptos.length === 0
                ? "Un cargo se aplica siempre desde un concepto del catálogo, que es lo que define el precio, el encuadre fiscal y quién financia el descuento. El alta del catálogo no está en esta versión."
                : "Sin unidades no hay a quién cobrarle. Eso se resuelve en el padrón del barrio."}
            </Vacio>
          ) : (
            <FormularioDeAplicacion
              periodoId={periodoId}
              unidades={unidades}
              conceptos={conceptos}
              salidas={salidas}
            />
          )}
        </Panel>
      ) : null}

      <Panel
        titulo="Aplicados en el período"
        origen={
          <>
            Los importes los resuelve la base al generar el borrador, con el valor que quedó congelado
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
                {[...vigentes, ...anuladas].map((a) => (
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
        origen="Lo que se puede aplicar y con qué valor vigente hoy. El alta de conceptos no está en esta versión: hoy lo carga el seed."
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
          <span className={ui.principal}>
            Mz {aplicacion.manzana} · Lote {aplicacion.lote}
          </span>
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
              descripcion={`${aplicacion.nombreConcepto} de Mz ${aplicacion.manzana} lote ${aplicacion.lote}`}
              salidas={salidas}
            />
          )}
        </td>
      ) : null}
    </tr>
  );
}
