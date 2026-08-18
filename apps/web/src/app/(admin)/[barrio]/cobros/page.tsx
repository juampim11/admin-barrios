import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarSaldosUF, type SaldoUF } from "@admin-barrios/data/servicios/cobros";
import { sumarMontos } from "@admin-barrios/shared/dinero";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { Boton, IconoMas } from "@admin-barrios/ui";
import { IconoBorrador } from "../../../../componentes/iconos.tsx";
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
import { esIdValido, rutaDeUnidad, rutasDeCobros } from "../../../../rutas.ts";
import { conSesion } from "../../../../servidor/db.ts";
import estilos from "./cobros.module.css";

export const metadata: Metadata = { title: "Cobros" };

/**
 * La grilla de cobros: cuánto debe cada unidad del barrio, de un vistazo.
 *
 * Lee `listarSaldosUF`, que a propósito consulta `saldo_uf` (mantenida incremental por trigger) y no
 * `app.v_estado_cuenta_uf` — esa vista reordena el historial completo y está pensada para el detalle
 * de UNA unidad (`cobros/[unidad]/page.tsx`), no para "todas las unidades del barrio" (ver el
 * docstring de `listarSaldosUF` en `servicios/cobros.ts`).
 *
 * **Sin paginado, a propósito.** El mismo servicio ya trae el barrio entero sin cortar —lo necesita
 * para que "unidades con deuda" sea un conteo real y no el de una página— y es la misma cifra con la
 * que ya convive `padron/page.tsx` en su versión sin paginar sobre `unidad_funcional`. No hay PII acá
 * (solo unidad y saldo), así que el argumento que sí justifica paginar el padrón no aplica.
 *
 * **Botón "Registrar pago" ausente y no apagado si `!puedeRegistrarPago`** (doc 06 §c.6.4): a un rol
 * de solo lectura no se le muestra un botón que la base va a rechazar.
 */
export default async function Cobros({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
}) {
  const { barrio: barrioId } = await params;
  // Ídem el layout: se renderizan en paralelo, así que el chequeo va en los dos (ver `rutas.ts`).
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    saldos: await listarSaldosUF(tx, { barrioId }),
  }));

  // `notFound()` afuera de la transacción, que ya cerró (ADR-0002 §3.1).
  if (!datos.barrio) notFound();
  const barrio = datos.barrio;
  const { puedeRegistrarPago, saldos } = datos.saldos;

  const conDeuda = saldos.filter((s) => s.saldoActual !== "0.00");
  const alDia = saldos.filter((s) => s.saldoActual === "0.00");
  const sinMovimientos = saldos.filter((s) => s.fechaUltimoMovimiento === null);
  const deudaTotal = sumarMontos(...conDeuda.map((s) => s.saldoActual));

  const rutas = rutasDeCobros(barrio.id);

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo="Cobros"
        bajada={
          saldos.length === 0
            ? undefined
            : `El saldo de cada una de las ${saldos.length} unidades de ${barrio.nombre}, según los pagos y liquidaciones registrados.`
        }
        acciones={
          puedeRegistrarPago ? (
            <Boton href={rutas.nuevo} variante="primario" icono={<IconoMas />}>
              Registrar pago
            </Boton>
          ) : null
        }
      />

      <Panel
        titulo="Resumen del barrio"
        origen={`${saldos.length} unidades. "Con deuda" es saldo distinto de $ 0,00; el signo lo trae la cuenta corriente, no esta pantalla.`}
      >
        <div className={estilos.kpis}>
          <Dato etiqueta="Deuda total" grande enCaja origen="suma de los saldos distintos de cero">
            <Cifra monto={deudaTotal} nulo="—" />
          </Dato>
          <Dato etiqueta="Unidades con deuda" grande enCaja origen={`de ${saldos.length} unidades del barrio`}>
            {conDeuda.length}
          </Dato>
          <Dato
            etiqueta="Sin movimientos"
            grande
            enCaja
            origen="todavía no tienen ni un pago ni una liquidación registrada"
          >
            {sinMovimientos.length}
          </Dato>
        </div>
      </Panel>

      <Panel
        titulo="Con saldo pendiente"
        origen="Orden por manzana y lote. Cada fila lleva al estado de cuenta completo de la unidad."
        sinRelleno
      >
        {conDeuda.length === 0 ? (
          <Vacio icono={<IconoBorrador />} titulo="Ninguna unidad tiene saldo pendiente">
            Todas las unidades de {barrio.nombre} están al día o todavía no tuvieron ningún movimiento.
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Unidades con saldo pendiente">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Unidad
                  </th>
                  <th scope="col">Último movimiento</th>
                  <th scope="col" className={ui.numerica}>
                    Saldo
                  </th>
                </tr>
              </thead>
              <tbody>
                {conDeuda.map((saldo) => (
                  <FilaDeSaldo key={saldo.unidadFuncionalId} saldo={saldo} barrioId={barrio.id} />
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Panel>

      <Desplegable resumen={`Al día o sin movimientos (${alDia.length})`}>
        {alDia.length === 0 ? (
          <Vacio titulo="No hay ninguna unidad al día o sin movimientos.">
            Todas las unidades del barrio tienen saldo pendiente.
          </Vacio>
        ) : (
          <MarcoTabla etiqueta="Unidades al día o sin movimientos">
            <Tabla>
              <thead>
                <tr>
                  <th scope="col" className={ui.columnaAncla}>
                    Unidad
                  </th>
                  <th scope="col">Último movimiento</th>
                  <th scope="col" className={ui.numerica}>
                    Saldo
                  </th>
                </tr>
              </thead>
              <tbody>
                {alDia.map((saldo) => (
                  <FilaDeSaldo key={saldo.unidadFuncionalId} saldo={saldo} barrioId={barrio.id} />
                ))}
              </tbody>
            </Tabla>
          </MarcoTabla>
        )}
      </Desplegable>
    </Pagina>
  );
}

function FilaDeSaldo({ saldo, barrioId }: { readonly saldo: SaldoUF; readonly barrioId: string }) {
  return (
    <tr>
      <th scope="row" className={ui.columnaAncla}>
        <Link href={rutaDeUnidad(barrioId, saldo.unidadFuncionalId)} className={estilos.unidad}>
          {saldo.etiqueta}
        </Link>
      </th>
      <td>
        {saldo.fechaUltimoMovimiento ? (
          formatearFecha(saldo.fechaUltimoMovimiento)
        ) : (
          <span className={ui.secundaria}>sin movimientos</span>
        )}
      </td>
      <td className={ui.numerica}>
        <Cifra monto={saldo.saldoActual} nulo="—" />
      </td>
    </tr>
  );
}
