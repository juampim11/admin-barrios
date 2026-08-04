import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerPeriodo, type GastoDelPeriodo } from "@admin-barrios/data/servicios/periodos";
import { listarConceptos } from "@admin-barrios/data/servicios/gastos";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { PanelDesplegable } from "@admin-barrios/ui";
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
  etiquetaTipoConcepto,
} from "../../../../../../componentes/etiquetas.tsx";
import { esIdValido, rutasDelPeriodo, salidasDelPeriodo } from "../../../../../../rutas.ts";
import { conSesion } from "../../../../../../servidor/db.ts";
import { FrentesDelPeriodo } from "../pasos.tsx";
import { BotonQuitarGasto, FormularioDeGasto } from "./formularios.tsx";
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
 * **El formulario va arriba de la tabla y no abajo**, y se abre desde su propio título
 * (`PanelDesplegable`). Arranca cerrado cuando ya hay gastos cargados y abierto cuando no hay
 * ninguno: mismo criterio que en «Cargos y descuentos», para que el gesto sea uno solo en todo el
 * período.
 *
 * **Antes acá había un botón "Nuevo gasto" en el encabezado que anclaba a este mismo panel**, que
 * estaba siempre desplegado unos centímetros más abajo. El usuario lo marcó: *"aparece el botón
 * «Nuevo gasto» que te lleva a la misma pantalla, más abajo"*. Un control que promete abrir algo que
 * ya está abierto es ruido; ahora el disparador **es** el título del panel, así que no se puede
 * desincronizar de lo que hace.
 *
 * **Por qué no es un modal**, que fue lo que el usuario propuso: el ciclo de confirmación de monto
 * inusual vive adentro del formulario y meterlo en un diálogo pide cuatro invariantes nuevas sobre el
 * freno que atrapa el cero de más. Y cargando contra una pila de comprobantes hace falta **ver la
 * lista** —para no duplicar— y el total acumulado —que es la brújula contra el mes anterior—; un
 * overlay tapa las dos. Está argumentado en `docs/producto/relevamiento-liquidacion.md` §8.
 *
 * **Si el período ya no es editable, el formulario no se dibuja.** No deshabilitado: ausente, con una
 * nota que dice por qué. Un formulario gris que rebota al enviar es peor que no estar — hace tipear
 * ocho campos para después decir que no.
 */
export default async function Gastos({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly periodo: string }>;
}) {
  const { barrio: barrioId, periodo: periodoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(periodoId)) notFound();

  // Las dos lecturas van en UNA transacción y secuenciales: `node-postgres` encola las consultas de
  // un mismo client, así que un `Promise.all` no paralelizaría nada — solo daría a entender que sí.
  const datos = await conSesion(async (tx) => {
    const periodo = await leerPeriodo(tx, { periodoId });
    if (!periodo) return { periodo: null, conceptos: [] };
    return { periodo, conceptos: await listarConceptos(tx, { barrioId: periodo.barrioId }) };
  });

  // Afuera de la transacción, que ya cerró (ADR-0002 §3.1). La segunda condición no es autorización
  // —ésa la hizo la RLS— sino coherencia de la URL.
  if (!datos.periodo || datos.periodo.barrioId !== barrioId) notFound();
  const { periodo, conceptos } = datos;

  const rutas = rutasDelPeriodo(barrioId, periodoId);
  const sinActa = periodo.gastos.filter((g) => g.sinRespaldoAsamblea);

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo={
          <span className={estilos.identidad}>
            Gastos de <span className={estilos.mes}>{formatearPeriodo(periodo.periodo)}</span>
            <EstadoDelPeriodo estado={periodo.estado} editable={periodo.editable} />
          </span>
        }
        bajada={
          <>
            {periodo.barrioNombre} · {ESTADO_PERIODO_QUE_SIGNIFICA[periodo.estado]}. Todo lo que se
            cargue acá es lo que después se reparte entre las unidades según su coeficiente.
          </>
        }
      />

      <FrentesDelPeriodo barrioId={barrioId} periodoId={periodoId} />

      <PilaDeNotas>
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
            titulo={`${sinActa.length} de ${periodo.gastos.length} gastos son extraordinarios sin respaldo de asamblea.`}
          >
            No bloquea la emisión —pasa en la operatoria real y el sistema no lo impide— pero
            condiciona el reclamo de la deuda: {sinActa.map((g) => g.descripcion).join(" · ")}.
          </Nota>
        ) : null}
      </PilaDeNotas>

      {periodo.editable ? (
        <PanelDesplegable
          titulo="Cargar un gasto"
          origen="El monto se guarda tal cual se escribe, sin redondear: es el que se va a prorratear y el que después hay que poder conciliar contra la factura."
          // Abierto cuando todavía no hay nada que mirar; cerrado cuando la lista de abajo ya tiene
          // filas, que es cuando la persona viene a ver lo cargado y no a cargar. Mismo criterio en
          // las dos pantallas de carga, para que el gesto sea uno solo en todo el período.
          abiertoPorDefecto={periodo.gastos.length === 0}
        >
          {conceptos.length === 0 ? (
            <Vacio icono={<IconoBorrador />} titulo="Este barrio no tiene conceptos de gasto cargados">
              Un gasto se imputa siempre a un concepto del catálogo del barrio, que es lo que define si
              es ordinario o extraordinario y cómo se encuadra fiscalmente. El alta del catálogo no
              está en esta versión: hoy lo carga el seed.
            </Vacio>
          ) : (
            <FormularioDeGasto
              periodoId={periodoId}
              conceptos={conceptos}
              salidas={salidasDelPeriodo(barrioId, periodoId)}
            />
          )}
        </PanelDesplegable>
      ) : null}

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
            Sin gastos cargados no hay nada que prorratear entre las unidades:{" "}
            {periodo.editable
              ? "el borrador se puede generar igual, pero cada boleta va a salir en cero."
              : "este período se emitió sin gastos."}
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
                    salidas={salidasDelPeriodo(barrioId, periodoId)}
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

      <Nota tono="info" titulo="Lo que sigue">
        Con los gastos cargados, el paso siguiente son los{" "}
        <a href={rutas.cargos}>cargos y descuentos por unidad</a> —el quincho, una bonificación— y
        después la <a href={rutas.revision}>revisión y la emisión</a>.
      </Nota>
    </Pagina>
  );
}

function FilaDeGasto({
  gasto,
  editable,
  salidas,
}: {
  readonly gasto: GastoDelPeriodo;
  readonly editable: boolean;
  readonly salidas: ReturnType<typeof salidasDelPeriodo>;
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
          <BotonQuitarGasto gastoId={gasto.id} descripcion={gasto.descripcion} salidas={salidas} />
        </td>
      ) : null}
    </tr>
  );
}
