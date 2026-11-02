import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarConceptos } from "@admin-barrios/data/servicios/gastos";
import { listarProveedores } from "@admin-barrios/data/servicios/proveedores";
import { listarOrdenesPago, type OrdenPago } from "@admin-barrios/data/servicios/ordenes-pago";
import { sumarMontos } from "@admin-barrios/shared/dinero";
import { Boton, IconoMas, IconoProveedores } from "@admin-barrios/ui";
import { IconoBorrador } from "../../../../componentes/iconos.tsx";
import { EstadoDeLaOrdenPago } from "../../../../componentes/etiquetas.tsx";
import {
  Cifra,
  Dato,
  Desplegable,
  EncabezadoDePagina,
  MarcoTabla,
  Pagina,
  Panel,
  Tabla,
  Vacio,
  ui,
} from "../../../../componentes/ui.tsx";
import { esIdValido, rutaDeOrdenPago, rutasDeOrdenesPago, salidasDeOrdenesPago } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import { AccionAnular, AccionMarcarPagada, BotonAprobar, BotonRechazar } from "./acciones-transicion.tsx";
import estilos from "./ordenes-pago.module.css";

export const metadata: Metadata = { title: "Órdenes de pago" };

/**
 * La grilla de Órdenes de pago — variante «Cola de aprobación» (prototipo aprobado, `/design`,
 * 2026-08-21): lo que pide una decisión va arriba y siempre visible; lo ya resuelto queda un clic más
 * lejos, en un desplegable.
 *
 * **Los nombres de proveedor y concepto se resuelven en esta página, no en el servicio.** El contrato
 * de `listarOrdenesPago()` está cerrado y verde tal cual quedó de la migración 0043-0049: solo trae
 * los ids. Mismo criterio que `cobros/nuevo/formulario.tsx` con `saldos.find()` — un `Map` armado acá
 * con `listarProveedores()`/`listarConceptos()`, las mismas consultas que ya usan sus propias
 * pantallas, sin agregar una lectura nueva al contrato del servicio ni un join que nadie pidió.
 *
 * **Sin columna "N.º de orden".** El prototipo mostraba `#1042`, pero `orden_pago.id` es un uuid: no
 * hay un correlativo real en el dominio. La columna "Cargada" (fecha) cumple el rol de trazabilidad
 * que la regla dura del proyecto pide para toda cifra de dinero.
 *
 * **"Nueva orden de pago" va sin gate de rol**, a diferencia de "Registrar pago" en `cobros/page.tsx`:
 * ese botón se gatea porque `listarSaldosUF()` calcula `puedeRegistrarPago` — acá no hay un flag
 * equivalente en el contrato cerrado, y el precedente real para un alta sin flag es
 * `gastos/page.tsx`/`cargos/page.tsx` (el panel de carga se ofrece sin consultar el rol; la RLS de
 * `insert` es la que de verdad decide).
 */
export default async function OrdenesPago({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    ordenes: await listarOrdenesPago(tx, { barrioId }),
    proveedores: await listarProveedores(tx, { barrioId }),
    conceptos: await listarConceptos(tx, { barrioId }),
  }));

  if (!datos.barrio) notFound();
  const barrio = datos.barrio;
  const { ordenes, proveedores, conceptos } = datos;

  const nombreProveedor = new Map(proveedores.map((p) => [p.id, p.razonSocial]));
  const nombreConcepto = new Map(conceptos.map((c) => [c.id, c.nombre]));

  const pendientes = ordenes.filter((o) => o.estado === "pendiente");
  const resto = ordenes.filter((o) => o.estado !== "pendiente");
  const aprobadasSinPagar = ordenes.filter((o) => o.estado === "aprobada");
  const montoPendiente =
    pendientes.length === 0 ? null : sumarMontos(...pendientes.map((o) => o.monto));

  const rutas = rutasDeOrdenesPago(barrio.id);
  const salidas = salidasDeOrdenesPago(barrio.id);

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo="Órdenes de pago"
        bajada={`${barrio.nombre}. Lo que pide una decisión va arriba; lo ya resuelto queda en «Resto de las órdenes».`}
        acciones={
          <>
            <Boton href={rutas.proveedores} variante="secundario" icono={<IconoProveedores />}>
              Proveedores
            </Boton>
            <Boton href={rutas.nuevo} variante="primario" icono={<IconoMas />}>
              Nueva orden de pago
            </Boton>
          </>
        }
      />

      <Panel
        titulo="Resumen del barrio"
        origen={`${ordenes.length} órdenes en total. "Monto pendiente" es la suma de las que esperan una decisión.`}
      >
        <div className={estilos.kpis}>
          <Dato etiqueta="Pendientes" grande enCaja origen="esperando aprobar o rechazar">
            {pendientes.length}
          </Dato>
          <Dato etiqueta="Monto pendiente" grande enCaja origen="suma de las órdenes en cola">
            <Cifra monto={montoPendiente} nulo="—" />
          </Dato>
          <Dato etiqueta="Aprobadas sin pagar" grande enCaja origen="ya cuentan en el prorrateo del período">
            {aprobadasSinPagar.length}
          </Dato>
        </div>
      </Panel>

      <Panel
        titulo={`Cola de aprobación (${pendientes.length})`}
        origen="Las que esperan una decisión, más nueva primero."
        sinRelleno
      >
        {pendientes.length === 0 ? (
          <Vacio icono={<IconoBorrador />} titulo="Ninguna orden está esperando una decisión">
            Las que se carguen van a aparecer acá hasta que se aprueben o se rechacen.
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Órdenes de pago pendientes de decisión">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Proveedor
                  </th>
                  <th scope="col">Concepto</th>
                  <th scope="col" className={ui.numerica}>
                    Monto
                  </th>
                  <th scope="col">Cargada</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {pendientes.map((orden) => (
                  <FilaDeOrden
                    key={orden.id}
                    orden={orden}
                    barrioId={barrio.id}
                    proveedor={nombreProveedor.get(orden.proveedorId) ?? "—"}
                    concepto={nombreConcepto.get(orden.conceptoId) ?? "—"}
                  >
                    {orden.puedeAprobar || orden.puedeRechazar ? (
                      <>
                        {orden.puedeAprobar ? <BotonAprobar ordenPagoId={orden.id} salidas={salidas} /> : null}
                        {orden.puedeRechazar ? <BotonRechazar ordenPagoId={orden.id} salidas={salidas} /> : null}
                      </>
                    ) : (
                      <span className={estilos.sinAccion}>Reservado a quien administra el barrio</span>
                    )}
                  </FilaDeOrden>
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>

      <Desplegable resumen={`Resto de las órdenes (${resto.length})`}>
        {resto.length === 0 ? (
          <Vacio titulo="Todavía no hay ninguna orden resuelta.">
            Las aprobadas, rechazadas, pagadas, anuladas o conciliadas van a aparecer acá.
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Resto de las órdenes de pago">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Proveedor
                  </th>
                  <th scope="col">Concepto</th>
                  <th scope="col" className={ui.numerica}>
                    Monto
                  </th>
                  <th scope="col">Cargada</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {resto.map((orden) => (
                  <FilaDeOrden
                    key={orden.id}
                    orden={orden}
                    barrioId={barrio.id}
                    proveedor={nombreProveedor.get(orden.proveedorId) ?? "—"}
                    concepto={nombreConcepto.get(orden.conceptoId) ?? "—"}
                  >
                    {orden.puedeMarcarPagada || orden.puedeAnular ? (
                      <>
                        {orden.puedeMarcarPagada ? (
                          <AccionMarcarPagada ordenPagoId={orden.id} salidas={salidas} />
                        ) : null}
                        {orden.puedeAnular ? <AccionAnular ordenPagoId={orden.id} salidas={salidas} /> : null}
                      </>
                    ) : (
                      <span className={estilos.sinAccion}>—</span>
                    )}
                  </FilaDeOrden>
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Desplegable>
    </Pagina>
  );
}

function FilaDeOrden({
  orden,
  barrioId,
  proveedor,
  concepto,
  children,
}: {
  readonly orden: OrdenPago;
  readonly barrioId: string;
  readonly proveedor: string;
  readonly concepto: string;
  readonly children: ReactNode;
}) {
  return (
    <tr>
      <th scope="row" className={ui.columnaAncla}>
        <Link href={rutaDeOrdenPago(barrioId, orden.id)} className={ui.principal}>
          {proveedor}
        </Link>
      </th>
      <td>
        <span className={ui.secundaria}>
          {concepto}
          {orden.descripcion ? ` · ${orden.descripcion}` : ""}
        </span>
      </td>
      <td className={ui.numerica}>
        <Cifra monto={orden.monto} nulo="—" />
      </td>
      <td className={ui.secundaria}>{orden.creadaAt.slice(0, 16).replace("T", " ")}</td>
      <td>
        <EstadoDeLaOrdenPago estado={orden.estado} />
      </td>
      <td>
        <div className={estilos.accionesFila}>{children}</div>
      </td>
    </tr>
  );
}
