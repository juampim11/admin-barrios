import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarConceptos } from "@admin-barrios/data/servicios/gastos";
import { listarOrdenesPago } from "@admin-barrios/data/servicios/ordenes-pago";
import { listarPeriodos } from "@admin-barrios/data/servicios/periodos";
import { listarProveedores } from "@admin-barrios/data/servicios/proveedores";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import type { EstadoOrdenPago } from "@admin-barrios/shared/proveedores";
import { Boton } from "@admin-barrios/ui";
import {
  ESTADO_ORDEN_PAGO,
  ESTADO_ORDEN_PAGO_QUE_SIGNIFICA,
  EstadoDeLaOrdenPago,
  etiquetaMedioPagoOP,
  ICONO_ORDEN_PAGO,
  SIGUIENTES_ESTADOS_ORDEN_PAGO,
} from "../../../../../componentes/etiquetas.tsx";
import { Cifra, Definicion, Definiciones, EncabezadoDePagina, Pagina, Panel } from "../../../../../componentes/ui.tsx";
import { esIdValido, rutasDeOrdenesPago, salidasDeOrdenesPago } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { AccionAnular, AccionMarcarPagada, BotonAprobar, BotonRechazar } from "../acciones-transicion.tsx";
import { Adjuntos } from "./adjuntos.tsx";
import estilos from "./orden.module.css";

export const metadata: Metadata = { title: "Orden de pago" };

/**
 * El detalle de una orden de pago — variante «Con línea de tiempo» (prototipo aprobado, `/design`,
 * 2026-08-21).
 *
 * **Reusa `listarOrdenesPago()` + `.find(id)`, no un `leerOrdenPago()` nuevo.** Mismo criterio que
 * `cobros/[unidad]/page.tsx` con `listarSaldosUF()` + `.find()`: los flags `puedeXxx` son idénticos
 * entre la lista y el detalle, y el volumen no justifica una consulta aparte.
 *
 * **El circuito del panel "Línea de tiempo" es estructural, no un historial de fechas reales.**
 * `orden_pago` sí guarda `aprobada_at`/`aprobada_por`/etc. en la base (`0044`), pero el contrato de
 * `listarOrdenesPago()` no las expone hoy — extenderlo es un cambio de servicio que no se pidió en
 * este alcance. La pantalla no inventa fechas: dibuja el estado actual y hacia dónde puede seguir
 * según la lista blanca real de `app.orden_pago_transicion()` (`SIGUIENTES_ESTADOS_ORDEN_PAGO`).
 */
export default async function DetalleOrdenPago({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string; readonly orden: string }>;
}) {
  const { barrio: barrioId, orden: ordenPagoId } = await params;
  if (!esIdValido(barrioId) || !esIdValido(ordenPagoId)) notFound();

  const datos = await conSesion(async (tx) => {
    const barrio = await leerBarrio(tx, { barrioId });
    if (!barrio) return { barrio: null, orden: null, proveedorNombre: null, conceptoNombre: null, periodoLabel: null };

    const [ordenes, proveedores, conceptos, periodos] = await Promise.all([
      listarOrdenesPago(tx, { barrioId }),
      listarProveedores(tx, { barrioId }),
      listarConceptos(tx, { barrioId }),
      listarPeriodos(tx, { barrioId }),
    ]);
    const orden = ordenes.find((o) => o.id === ordenPagoId) ?? null;
    const proveedor = orden ? proveedores.find((p) => p.id === orden.proveedorId) : undefined;
    const concepto = orden ? conceptos.find((c) => c.id === orden.conceptoId) : undefined;
    const periodo = orden ? periodos.find((p) => p.id === orden.periodoId) : undefined;

    return {
      barrio,
      orden,
      proveedorNombre: proveedor?.razonSocial ?? null,
      conceptoNombre: concepto?.nombre ?? null,
      periodoLabel: periodo ? `${formatearPeriodo(periodo.periodo)}${periodo.editable ? "" : " (no editable)"}` : null,
    };
  });

  if (!datos.barrio || !datos.orden) notFound();
  const barrio = datos.barrio;
  const orden = datos.orden;
  const rutas = rutasDeOrdenesPago(barrio.id);
  const salidas = salidasDeOrdenesPago(barrio.id);

  const siguientes = SIGUIENTES_ESTADOS_ORDEN_PAGO[orden.estado];
  const hayAlgunaAccion = orden.puedeAprobar || orden.puedeRechazar || orden.puedeMarcarPagada || orden.puedeAnular;

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo={
          <span className={estilos.identidad}>
            {datos.proveedorNombre ?? "Orden de pago"}
            <EstadoDeLaOrdenPago estado={orden.estado} />
          </span>
        }
        bajada={`${barrio.nombre} · ${ESTADO_ORDEN_PAGO_QUE_SIGNIFICA[orden.estado]}.`}
        acciones={
          <Boton href={rutas.grilla} variante="secundario">
            Volver a órdenes de pago
          </Boton>
        }
      />

      <div className={estilos.layout}>
        <div className={estilos.principal}>
          <Panel titulo="Datos de la orden" origen={`Cargada el ${orden.creadaAt.slice(0, 16).replace("T", " ")}.`}>
            <Definiciones>
              <Definicion termino="Proveedor">{datos.proveedorNombre ?? "—"}</Definicion>
              <Definicion termino="Concepto">{datos.conceptoNombre ?? "—"}</Definicion>
              <Definicion termino="Período">{datos.periodoLabel ?? "—"}</Definicion>
              <Definicion termino="N.º de factura">{orden.numeroFactura ?? "—"}</Definicion>
              {orden.medioPago ? (
                <Definicion termino="Medio de pago">{etiquetaMedioPagoOP(orden.medioPago)}</Definicion>
              ) : null}
              <Definicion termino="Monto">
                <span className={estilos.monto}>
                  <Cifra monto={orden.monto} nulo="—" />
                </span>
              </Definicion>
              <Definicion termino="Descripción">{orden.descripcion}</Definicion>
            </Definiciones>
          </Panel>

          <Adjuntos orden={orden} salidas={salidas} />
        </div>

        <div className={estilos.contexto}>
          <Panel titulo="Circuito de esta orden">
            <div className={estilos.timeline}>
              <NodoDeTimeline estado={orden.estado} actual />
              {siguientes.map((e) => (
                <NodoDeTimeline key={e} estado={e} posible />
              ))}
            </div>
          </Panel>

          <Panel titulo="Acciones disponibles">
            {hayAlgunaAccion ? (
              <div className={estilos.accionesLista}>
                {orden.puedeAprobar ? <BotonAprobar ordenPagoId={orden.id} salidas={salidas} /> : null}
                {orden.puedeRechazar ? <BotonRechazar ordenPagoId={orden.id} salidas={salidas} /> : null}
                {orden.puedeMarcarPagada ? (
                  <AccionMarcarPagada ordenPagoId={orden.id} salidas={salidas} />
                ) : null}
                {orden.puedeAnular ? <AccionAnular ordenPagoId={orden.id} salidas={salidas} /> : null}
              </div>
            ) : (
              <p className={estilos.sinAcciones}>No hay ninguna acción disponible para tu rol en este estado.</p>
            )}
          </Panel>
        </div>
      </div>
    </Pagina>
  );
}

function NodoDeTimeline({
  estado,
  actual,
  posible,
}: {
  readonly estado: EstadoOrdenPago;
  readonly actual?: boolean;
  readonly posible?: boolean;
}) {
  const Icono = ICONO_ORDEN_PAGO[estado];
  return (
    <div className={estilos.nodo}>
      <div className={estilos.riel}>
        <div className={`${estilos.punto} ${actual ? estilos.puntoActual : estilos.puntoPosible}`}>
          <Icono />
        </div>
      </div>
      <div className={estilos.cuerpoNodo}>
        <div className={actual ? estilos.etiquetaActual : estilos.etiqueta}>
          {ESTADO_ORDEN_PAGO[estado]}
          {posible ? " (posible)" : ""}
        </div>
        <div className={estilos.nota}>{ESTADO_ORDEN_PAGO_QUE_SIGNIFICA[estado]}</div>
      </div>
    </div>
  );
}
