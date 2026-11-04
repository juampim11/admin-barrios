import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerPeriodo, type GastoDelPeriodo } from "@admin-barrios/data/servicios/periodos";
import { restarMontos } from "@admin-barrios/shared/dinero";
import { formatearPeriodo, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { Boton, Chip, IconoMas } from "@admin-barrios/ui";
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
  etiquetaTipoConcepto,
} from "../../../../../../componentes/etiquetas.tsx";
import {
  esIdValido,
  leerListo,
  migaDelBarrio,
  rutaDeOrdenPago,
  rutasDelPeriodo,
  salidasDelPeriodo,
} from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import { FrentesDelPeriodo } from "../pasos.tsx";
import { BotonQuitarGasto, type ContextoDeQuitar } from "./formularios.tsx";
import estilos from "./gastos.module.css";

export const metadata: Metadata = { title: "Gastos del período" };

/**
 * **Paso 1 del recorrido: qué se gastó este mes.**
 *
 * La pantalla contesta tres preguntas en este orden, que es el orden en que se trabaja:
 *
 * 1. ¿se puede seguir cargando? — lo dice el estado del período, y lo decide el trigger
 *    `app.periodo_editable`, no esta pantalla;
 * 2. ¿qué hay cargado y cuánto suma? — con el total recalculado ahora, auditable sumando la columna;
 * 3. ¿qué quedó marcado? — las extraordinarias sin respaldo de asamblea, arriba y no escondidas en
 *    una fila de la tabla.
 *
 * **La carga va en su página (`gastos/nuevo`), con un botón en la cabecera** (encargo 9, PR 1 §2:
 * todas las altas con el patrón lista + botón, como «Nueva orden de pago»). Antes era un panel
 * desplegable arriba de la tabla. Lo que el desplegable daba —ver lo último cargado y el total
 * mientras se carga contra una pila de comprobantes (`docs/producto/relevamiento-liquidacion.md` §8)—
 * lo trae la página de carga en un panel propio. Al guardar se vuelve acá con «Listo:».
 *
 * **Por qué no es un modal**, que fue lo que el usuario propuso alguna vez: el ciclo de confirmación
 * de monto inusual vive adentro del formulario y meterlo en un diálogo pide cuatro invariantes nuevas
 * sobre el freno que atrapa el cero de más.
 *
 * **Si el período ya no es editable, el botón no se dibuja.** No deshabilitado: ausente, con una
 * nota que dice por qué. Un formulario gris que rebota al enviar es peor que no estar — hace tipear
 * ocho campos para después decir que no.
 */
export default async function Gastos({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  const listo = leerListo(await searchParams, "gasto");
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();

  // Los conceptos ya no se leen acá: el formulario de carga vive en `gastos/nuevo` (encargo 9, §2).
  const periodo = await conSesion((tx) => leerPeriodo(tx, { periodoId }));

  // Afuera de la transacción, que ya cerró (ADR-0002 §3.1). La segunda condición no es autorización
  // —ésa la hizo la RLS— sino coherencia de la URL.
  if (!periodo || periodo.barrioId !== barrioId) notFound();

  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const sinActa = periodo.gastos.filter((g) => g.sinRespaldoAsamblea);
  // «Listo:» de una carga recién guardada, con la fila releída de la base (no con lo que dice la URL).
  const recienCargado = listo?.id ? (periodo.gastos.find((g) => g.id === listo.id) ?? null) : null;

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[
          migaDelBarrio({ id: barrioId, nombre: periodo.barrioNombre }),
          { texto: "Liquidación", href: rutas.periodos },
          { texto: nombreDelPeriodo(periodo.periodo), href: rutas.resumen },
          { texto: "Gastos" },
        ]}
        titulo={
          <span className={estilos.identidad}>
            Gastos de <span className={estilos.mes}>{formatearPeriodo(periodo.periodo)}</span>
            <EstadoDelPeriodo estado={periodo.estado} editable={periodo.editable} />
          </span>
        }
        bajada={
          <>
            {periodo.barrioNombre} · {ESTADO_PERIODO_QUE_SIGNIFICA[periodo.estado]}.{" "}
            {/* Depende del modelo (CLAUDE.md §1.6): en cuota fija el gasto no se reparte, se compara. */}
            {periodo.modelo === "fija"
              ? "Lo que se cargue acá es el gasto del mes. Con cuota fija, los gastos ordinarios no cambian lo que paga cada unidad: se comparan contra lo que se factura. Los extraordinarios sí se reparten entre las unidades según su coeficiente."
              : "Todo lo que se cargue acá es lo que después se reparte entre las unidades según su coeficiente."}
          </>
        }
        acciones={
          periodo.editable ? (
            <Boton href={rutas.nuevoGasto} variante="primario" icono={<IconoMas />}>
              Cargar un gasto
            </Boton>
          ) : null
        }
      />

      <FrentesDelPeriodo barrioId={barrioId} periodoId={periodoId} />

      <PilaDeNotas>
        {listo ? (
          <Nota
            tono="exito"
            titulo={recienCargado ? `Listo: «${recienCargado.descripcion}» quedó cargado en el período.` : "Listo: el gasto quedó cargado en el período."}
          >
            {/* El aviso de las extraordinarias sin acta ya está acá abajo, en la misma pila: no se repite. */}
            {recienCargado?.sinRespaldoAsamblea ? "Quedó marcado como extraordinario sin respaldo de asamblea (ver el aviso de abajo)." : null}
          </Nota>
        ) : null}

        {!periodo.editable ? (
          <Nota
            tono="info"
            titulo={`Este período ya ${ESTADO_PERIODO_COMO_HECHO[periodo.estado]}: no se le cargan más gastos.`}
          >
            Los que están abajo son los que quedaron. Si hace falta corregir algo de un período
            emitido, se registra en el período siguiente — la emisión es irreversible y el período
            queda inmutable.
          </Nota>
        ) : null}

        {sinActa.length > 0 ? (
          <Nota
            tono="alerta"
            titulo={`${sinActa.length} de ${periodo.gastos.length} ${periodo.gastos.length === 1 ? "gasto" : "gastos"} ${sinActa.length === 1 ? "es extraordinario" : "son extraordinarios"} sin respaldo de asamblea.`}
          >
            No bloquea la emisión —pasa en la operatoria real y el sistema no lo impide— pero
            condiciona el reclamo de la deuda: {sinActa.map((g) => g.descripcion).join(" · ")}.
          </Nota>
        ) : null}
      </PilaDeNotas>


      <Panel
        titulo="Gastos cargados"
        origen={
          <>
            El total es la suma de estas filas, recalculada ahora — se puede auditar sumando la
            columna a mano. Las <strong>extraordinarias</strong> (art. 2048) van marcadas: son las que
            necesitan respaldo de asamblea.
          </>
        }
        sinRelleno
      >
        {periodo.gastos.length === 0 ? (
          <Vacio icono={<IconoBorrador />} titulo="Todavía no se cargó ningún gasto">
            {periodo.modelo === "fija"
              ? periodo.editable
                ? "Con cuota fija el borrador se puede generar igual: cada unidad paga su cuota. Los gastos se cargan para compararlos contra lo que se factura, y los extraordinarios para repartirlos."
                : "Este período se emitió sin gastos."
              : periodo.editable
                ? "Sin gastos cargados no hay nada que repartir entre las unidades: el borrador se puede generar igual, pero cada boleta va a salir en cero."
                : "Este período se emitió sin gastos."}
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Gastos cargados en el período">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Gasto
                  </th>
                  <th scope="col">Concepto</th>
                  <th scope="col">Proveedor</th>
                  <th scope="col">Comprobante</th>
                  <th scope="col" className={ui.numerica}>
                    Monto
                  </th>
                  {periodo.editable ? <th scope="col">Acciones</th> : null}
                </tr>
              </thead>
              <tbody>
                {periodo.gastos.map((gasto) => (
                  <FilaDeGasto
                    key={gasto.id}
                    gasto={gasto}
                    editable={periodo.editable}
                    barrioId={barrioId}
                    salidas={salidasDelPeriodo(barrioId, periodoId)}
                    contexto={{
                      periodo: nombreDelPeriodo(periodo.periodo),
                      // En cuota fija solo se reparten las extraordinarias (`shared/liquidacion.ts`).
                      seReparte: periodo.modelo !== "fija" || gasto.conceptoTipo === "extraordinaria",
                      totalAntes: periodo.totalGastosCargados,
                      totalDespues: restarMontos(periodo.totalGastosCargados, gasto.monto),
                    }}
                  />
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={4} className={ui.columnaAncla}>
                    Total cargado · {periodo.gastos.length}{" "}
                    {periodo.gastos.length === 1 ? "gasto" : "gastos"}
                  </th>
                  <td className={ui.numerica}>
                    <Cifra monto={periodo.totalGastosCargados} nulo="—" />
                  </td>
                  {periodo.editable ? <td /> : null}
                </tr>
              </tfoot>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>

      {/*
        Dos salidas nombradas, no una — y la pregunta hace el trabajo: quien no sabe qué es un cargo,
        al leer "¿hubo quincho?" ya sabe si le toca. Sin "el paso siguiente": los frentes no tienen
        orden entre sí, y un cargo se aplica el día 1 o el 28.
      */}
      <Nota tono="info" titulo="Lo que sigue">
        <p>
          ¿Hubo quincho, invitados de más o alguna bonificación este mes? Eso se cobra o se descuenta a{" "}
          <strong>una</strong> unidad, en <a href={rutas.cargos}>cargos y descuentos</a>.
        </p>
        <p>
          Si no hubo nada de eso —que es lo normal—, lo que queda es la{" "}
          <a href={rutas.revision}>revisión y la emisión</a>.
        </p>
      </Nota>
    </Pagina>
  );
}

function FilaDeGasto({
  gasto,
  editable,
  salidas,
  barrioId,
  contexto,
}: {
  readonly gasto: GastoDelPeriodo;
  readonly barrioId: string;
  readonly editable: boolean;
  readonly salidas: ReturnType<typeof salidasDelPeriodo>;
  /** Lo que el diálogo de «Quitar» dice de la plata, leído y restado acá, en el servidor. */
  readonly contexto: ContextoDeQuitar;
}) {
  return (
    <tr>
      <th scope="row" className={ui.columnaAncla}>
        <span className={estilos.gasto}>
          <span className={ui.principal}>{gasto.descripcion}</span>
          {gasto.sinRespaldoAsamblea ? (
            <span>
              <Chip tono="alerta">Sin respaldo de asamblea</Chip>
            </span>
          ) : gasto.actaTitulo ? (
            <span className={ui.secundaria}>Acta: {gasto.actaTitulo}</span>
          ) : null}
          {gasto.motivoSinRespaldo ? (
            <span className={ui.secundaria}>{gasto.motivoSinRespaldo}</span>
          ) : null}
        </span>
      </th>
      <td>
        <span className={estilos.gasto}>
          <span>{gasto.conceptoNombre}</span>
          <span className={ui.secundaria}>
            {etiquetaTipoConcepto(gasto.conceptoTipo)}
            {gasto.esFondoReserva ? (
              <span className={estilos.marcaFondoReserva}> · fondo de reserva</span>
            ) : null}
          </span>
        </span>
      </td>
      <td>{gasto.proveedorNombre ?? <span className={ui.secundaria}>—</span>}</td>
      <td className={ui.mono}>{gasto.comprobante ?? <span className={ui.secundaria}>—</span>}</td>
      <td className={ui.numerica}>
        <Cifra monto={gasto.monto} nulo="—" />
      </td>
      {editable ? (
        <td>
          {gasto.ordenPagoId ? (
            // Un gasto de una orden de pago no se quita desde acá: se anula la orden (P3, `0066`).
            <span className={ui.secundaria}>
              De la{" "}
              <Link href={rutaDeOrdenPago(barrioId, gasto.ordenPagoId)}>
                orden de pago de {gasto.proveedorNombre ?? "un proveedor"}
              </Link>
            </span>
          ) : (
            <BotonQuitarGasto
              gastoId={gasto.id}
              descripcion={gasto.descripcion}
              monto={gasto.monto}
              contexto={contexto}
              salidas={salidas}
            />
          )}
        </td>
      ) : null}
    </tr>
  );
}
