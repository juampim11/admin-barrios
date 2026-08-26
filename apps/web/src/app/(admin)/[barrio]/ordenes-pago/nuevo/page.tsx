import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { leerBarrio } from "@admin-barrios/data/servicios/barrios";
import { listarConceptos } from "@admin-barrios/data/servicios/gastos";
import { listarOrdenesPago } from "@admin-barrios/data/servicios/ordenes-pago";
import { listarPeriodos } from "@admin-barrios/data/servicios/periodos";
import { listarProveedores } from "@admin-barrios/data/servicios/proveedores";
import { EncabezadoDePagina, Nota, Pagina } from "../../../../../componentes/ui.tsx";
import { esIdValido, salidasDeOrdenesPago } from "../../../../../rutas.ts";
import { conSesion } from "../../../../../servidor/db.ts";
import { FormularioDeOrdenPago } from "./formulario.tsx";

export const metadata: Metadata = { title: "Nueva orden de pago" };

/**
 * El alta de una orden de pago, en `pendiente`.
 *
 * **Cuatro lecturas en una transacción**: proveedores y conceptos activos para los desplegables,
 * períodos para elegir dónde se va a asentar el gasto si se aprueba, y las órdenes ya cargadas para
 * el conteo de "órdenes previas" del panel de contexto (mismo criterio que el `saldos.find()` de
 * `cobros/nuevo/formulario.tsx`: una lectura que ya existe, sin agregar un servicio nuevo).
 *
 * **El comprobante y la factura no se piden acá.** `registrarOrdenPagoSchema` no los exige: los dos
 * se adjuntan después, desde el detalle, en cualquier estado. A diferencia de `pago` —donde el
 * comprobante prueba que la plata ya entró y por eso `registrarPagoSchema` lo exige en el alta— acá
 * la orden se carga ANTES de que se pague nada; pedir un comprobante en este paso no tendría sentido.
 */
export default async function NuevaOrdenDePago({
  params,
}: {
  readonly params: Promise<{ readonly barrio: string }>;
}) {
  const { barrio: barrioId } = await params;
  if (!esIdValido(barrioId)) notFound();

  const datos = await conSesion(async (tx) => ({
    barrio: await leerBarrio(tx, { barrioId }),
    proveedores: await listarProveedores(tx, { barrioId }),
    conceptos: await listarConceptos(tx, { barrioId }),
    periodos: await listarPeriodos(tx, { barrioId }),
    ordenes: await listarOrdenesPago(tx, { barrioId }),
  }));

  if (!datos.barrio) notFound();
  const barrio = datos.barrio;
  const { proveedores, conceptos, periodos, ordenes } = datos;

  return (
    <Pagina>
      <EncabezadoDePagina
        titulo="Nueva orden de pago"
        bajada={`${barrio.nombre}. Queda en «pendiente» hasta que alguien con el rol para aprobar la revise.`}
      />

      {proveedores.length === 0 || conceptos.length === 0 || periodos.length === 0 ? (
        <Nota tono="info" titulo="Falta catálogo para poder cargar una orden.">
          {proveedores.length === 0 ? "No hay ningún proveedor cargado. " : ""}
          {conceptos.length === 0 ? "No hay ningún concepto de gasto cargado. " : ""}
          {periodos.length === 0 ? "El barrio todavía no tiene ningún período de expensa." : ""}
        </Nota>
      ) : (
        <FormularioDeOrdenPago
          proveedores={proveedores}
          conceptos={conceptos}
          periodos={periodos}
          ordenes={ordenes}
          salidas={salidasDeOrdenesPago(barrio.id)}
        />
      )}
    </Pagina>
  );
}
