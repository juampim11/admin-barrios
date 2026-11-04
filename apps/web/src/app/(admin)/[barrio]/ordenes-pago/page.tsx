import { etiquetaDelMesDelServicio, formatearFechaHora, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { z } from "zod";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarConceptos } from "@admin-barrios/data/servicios/gastos";
import { listarPeriodos } from "@admin-barrios/data/servicios/periodos";
import { listarProveedores } from "@admin-barrios/data/servicios/proveedores";
import { listarOrdenesPago, type OrdenPago } from "@admin-barrios/data/servicios/ordenes-pago";
import { sumarMontos } from "@admin-barrios/shared/dinero";
import { ESTADOS_ORDEN_PAGO, type EstadoOrdenPago } from "@admin-barrios/shared/proveedores";
import {
  BarraDeFiltros,
  Boton,
  CifraDeLaFila,
  FilaDeCifras,
  FiltroDeLista,
  FiltrosDeLista,
  IconoMas,
  IconoProveedores,
} from "@admin-barrios/ui";
import { IconoBorrador } from "../../../../componentes/iconos.tsx";
import { ESTADO_ORDEN_PAGO, ESTADO_ORDEN_PAGO_QUE_SIGNIFICA, EstadoDeLaOrdenPago } from "../../../../componentes/etiquetas.tsx";
import {
  Cifra,
  Desplegable,
  EncabezadoDePagina,
  MarcoTabla,
  Pagina,
  Panel,
  Tabla,
  Vacio,
  ui,
} from "../../../../componentes/ui.tsx";
import { esIdValido, hrefDeLista, migaDelBarrio, rutaDeOrdenPago, rutasDeOrdenesPago, salidasDeOrdenesPago } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import { AccionAnular, AccionMarcarPagada, BotonAprobar, BotonRechazar } from "./acciones-transicion.tsx";
import estilos from "./ordenes-pago.module.css";

export const metadata: Metadata = { title: "Órdenes de pago" };

type FiltroOrdenes = "todas" | EstadoOrdenPago;

/** Filtro por la URL, o sea del cliente: se valida con Zod. Un estado desconocido es «Todas». */
const consultaSchema = z.object({
  filtro: z.enum(["todas", ...ESTADOS_ORDEN_PAGO]).catch("todas"),
});

/** El orden del circuito, que es en el que se leen los filtros: primero lo que pide una decisión. */
const ESTADOS_EN_FILTROS: readonly EstadoOrdenPago[] = ["pendiente", "aprobada", "pagada", "rechazada", "anulada", "conciliada"];

/** El rótulo del filtro: el del estado, en plural («Pendientes»). */
const FILTRO_EN_PLURAL: Record<EstadoOrdenPago, string> = {
  pendiente: "Pendientes",
  aprobada: "Aprobadas",
  pagada: "Pagadas",
  rechazada: "Rechazadas",
  anulada: "Anuladas",
  conciliada: "Conciliadas",
};

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
 *
 * **Filtro por estado** (encargo 8, T1): links `?filtro=<estado>` con su conteo, resueltos acá, como
 * en el padrón. «Todas» es la vista de siempre (cola + resto); un estado puntual muestra una sola
 * tabla con las órdenes de ese estado y las mismas acciones que tendrían en la vista completa. Los
 * conteos salen de la misma lista que ya se lee (no está paginada).
 */
export default async function OrdenesPago({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const crudos = await searchParams;
  const filtro: FiltroOrdenes = consultaSchema.parse({
    filtro: typeof crudos["filtro"] === "string" ? crudos["filtro"] : undefined,
  }).filtro;

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    ordenes: await listarOrdenesPago(tx, { barrioId }),
    proveedores: await listarProveedores(tx, { barrioId }),
    conceptos: await listarConceptos(tx, { barrioId }),
    periodos: await listarPeriodos(tx, { barrioId }),
  }));

  if (!datos.barrio) notFound();
  const barrio = datos.barrio;
  const { ordenes, proveedores, conceptos, periodos } = datos;

  const nombreProveedor = new Map(proveedores.map((p) => [p.id, p.razonSocial]));
  const nombreConcepto = new Map(conceptos.map((c) => [c.id, c.nombre]));
  const nombrePeriodo = new Map(periodos.map((p) => [p.id, nombreDelPeriodo(p.periodo)]));
  // Lo que el diálogo de aprobar/rechazar repite antes de confirmar: todo leído acá, nada calculado.
  const paraConfirmar = (orden: OrdenPago) => ({
    ordenPagoId: orden.id,
    proveedor: nombreProveedor.get(orden.proveedorId) ?? "un proveedor",
    monto: orden.monto,
    periodo: nombrePeriodo.get(orden.periodoId) ?? null,
  });

  const pendientes = ordenes.filter((o) => o.estado === "pendiente");
  const resto = ordenes.filter((o) => o.estado !== "pendiente");
  const aprobadasSinPagar = ordenes.filter((o) => o.estado === "aprobada");
  const montoPendiente =
    pendientes.length === 0 ? null : sumarMontos(...pendientes.map((o) => o.monto));

  const rutas = rutasDeOrdenesPago(barrio.id);
  const salidas = salidasDeOrdenesPago(barrio.id);

  const cantidadPorEstado = (estado: EstadoOrdenPago): number => ordenes.filter((o) => o.estado === estado).length;
  const filtradas = filtro === "todas" ? ordenes : ordenes.filter((o) => o.estado === filtro);

  // Las acciones de una fila dependen solo de su estado y de sus permisos: las mismas en la vista
  // completa que en la filtrada.
  const accionesDe = (orden: OrdenPago) =>
    orden.estado === "pendiente" ? (
      orden.puedeAprobar || orden.puedeRechazar ? (
        <>
          {orden.puedeAprobar ? <BotonAprobar orden={paraConfirmar(orden)} salidas={salidas} /> : null}
          {orden.puedeRechazar ? <BotonRechazar orden={paraConfirmar(orden)} salidas={salidas} /> : null}
        </>
      ) : (
        <span className={estilos.sinAccion}>Reservado a quien administra el barrio</span>
      )
    ) : orden.puedeMarcarPagada || orden.puedeAnular ? (
      <>
        {orden.puedeMarcarPagada ? <AccionMarcarPagada ordenPagoId={orden.id} salidas={salidas} /> : null}
        {orden.puedeAnular ? <AccionAnular ordenPagoId={orden.id} salidas={salidas} /> : null}
      </>
    ) : (
      <span className={estilos.sinAccion}>—</span>
    );

  const tablaDe = (lista: readonly OrdenPago[], etiqueta: string) => (
    <MarcoTabla etiqueta={etiqueta}>
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
          {lista.map((orden) => (
            <FilaDeOrden
              key={orden.id}
              orden={orden}
              barrioId={barrio.id}
              proveedor={nombreProveedor.get(orden.proveedorId) ?? "—"}
              concepto={nombreConcepto.get(orden.conceptoId) ?? "—"}
            >
              {accionesDe(orden)}
            </FilaDeOrden>
          ))}
        </tbody>
      </Tabla>
    </MarcoTabla>
  );

  return (
    <Pagina>
      <EncabezadoDePagina
        migas={[migaDelBarrio(barrio), { texto: "Órdenes de pago" }]}
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
        <FilaDeCifras>
          <CifraDeLaFila etiqueta="Pendientes" origen="esperando aprobar o rechazar">
            {pendientes.length}
          </CifraDeLaFila>
          <CifraDeLaFila etiqueta="Monto pendiente" origen="suma de las órdenes en cola">
            <Cifra monto={montoPendiente} nulo="—" />
          </CifraDeLaFila>
          <CifraDeLaFila etiqueta="Aprobadas sin pagar" origen="ya cuentan como gasto del período">
            {aprobadasSinPagar.length}
          </CifraDeLaFila>
        </FilaDeCifras>
      </Panel>

      <BarraDeFiltros>
        <FiltrosDeLista etiqueta="Filtrar las órdenes por estado">
          <FiltroDeLista href={rutas.grilla} activo={filtro === "todas"} cantidad={ordenes.length}>
            Todas
          </FiltroDeLista>
          {ESTADOS_EN_FILTROS.map((estado) => (
            <FiltroDeLista
              key={estado}
              href={hrefDeLista(rutas.grilla, { filtro: estado })}
              activo={filtro === estado}
              cantidad={cantidadPorEstado(estado)}
            >
              {FILTRO_EN_PLURAL[estado]}
            </FiltroDeLista>
          ))}
        </FiltrosDeLista>
      </BarraDeFiltros>

      {filtro === "todas" ? (
        <>
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
              tablaDe(pendientes, "Órdenes de pago pendientes de decisión")
            )}
          </Panel>

          <Desplegable resumen={`Resto de las órdenes (${resto.length})`}>
            {resto.length === 0 ? (
              <Vacio titulo="Todavía no hay ninguna orden resuelta.">
                Las aprobadas, rechazadas, pagadas, anuladas o conciliadas van a aparecer acá.
              </Vacio>
            ) : (
              tablaDe(resto, "Resto de las órdenes de pago")
            )}
          </Desplegable>
        </>
      ) : (
        <Panel
          titulo={`${FILTRO_EN_PLURAL[filtro]} (${filtradas.length})`}
          origen={`Solo las órdenes en estado «${ESTADO_ORDEN_PAGO[filtro]}»: ${ESTADO_ORDEN_PAGO_QUE_SIGNIFICA[filtro]}. Más nueva primero.`}
          sinRelleno
        >
          {filtradas.length === 0 ? (
            <Vacio icono={<IconoBorrador />} titulo={`No hay órdenes en el filtro «${FILTRO_EN_PLURAL[filtro]}»`}>
              Ninguna orden de {barrio.nombre} está en estado «{ESTADO_ORDEN_PAGO[filtro]}». Para sacar el filtro,{" "}
              <Link href={rutas.grilla}>mirá todas las órdenes</Link>.
            </Vacio>
          ) : (
            tablaDe(filtradas, `Órdenes de pago en estado ${ESTADO_ORDEN_PAGO[filtro]}`)
          )}
        </Panel>
      )}
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
          {orden.mesServicio ? ` · ${etiquetaDelMesDelServicio(orden.mesServicio)}` : ""}
        </span>
      </td>
      <td className={ui.numerica}>
        <Cifra monto={orden.monto} nulo="—" />
      </td>
      <td className={ui.secundaria}>{formatearFechaHora(orden.creadaAt)}</td>
      <td>
        <EstadoDeLaOrdenPago estado={orden.estado} />
      </td>
      <td>
        <div className={estilos.accionesFila}>{children}</div>
      </td>
    </tr>
  );
}
