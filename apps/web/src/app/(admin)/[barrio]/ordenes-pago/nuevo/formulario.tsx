"use client";

/**
 * El alta de una orden de pago, contra un proveedor, un período y un concepto del catálogo.
 *
 * **El panel de contexto (derecha) no hace un fetch nuevo.** `proveedores` y `ordenes` son las mismas
 * listas que ya trajo el servidor; cuando cambia el proveedor elegido, el panel busca en esos mismos
 * arrays lo que ya estaba ahí — mismo patrón que `cobros/nuevo/formulario.tsx` con `saldos.find()`.
 *
 * **"Órdenes previas" cuenta TODAS las órdenes del proveedor, sin ventana de tiempo.** El prototipo
 * aprobado decía "en los últimos 6 meses", pero no hay una utilidad de fechas en `shared/fechas` para
 * ese recorte y no vale la pena escribir una a mano para un dato de contexto — se cuenta el total y se
 * dice con la palabra que corresponde ("cargadas hasta hoy"), sin inventar una ventana que no se
 * puede calcular con precisión.
 */

import { useState } from "react";
import type { ConceptoDeGasto } from "@admin-barrios/data/servicios/gastos";
import type { OrdenPago } from "@admin-barrios/data/servicios/ordenes-pago";
import type { PeriodoDeLista } from "@admin-barrios/data/servicios/periodos";
import type { Proveedor } from "@admin-barrios/data/servicios/proveedores";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import { registrarOrdenPagoAction } from "../../../../../acciones/ordenes-pago.ts";
import {
  Acciones,
  Avisos,
  AvisoDeCamposSueltos,
  AvisoDeExito,
  AvisoDeFallo,
  BotonEnviar,
  CampoMonto,
  CampoSeleccion,
  CampoTexto,
  Campos,
  Formulario,
  useFormulario,
  type Opcion,
  type Salidas,
} from "../../../../../componentes/formulario.tsx";
import { ESTADO_PERIODO } from "../../../../../componentes/etiquetas.tsx";
import { Dato, Panel } from "../../../../../componentes/ui.tsx";
import estilos from "./nuevo.module.css";

export function FormularioDeOrdenPago({
  proveedores,
  conceptos,
  periodos,
  ordenes,
  salidas,
}: {
  readonly proveedores: readonly Proveedor[];
  readonly conceptos: readonly ConceptoDeGasto[];
  readonly periodos: readonly PeriodoDeLista[];
  readonly ordenes: readonly OrdenPago[];
  readonly salidas: Salidas;
}) {
  const { enviar, pendiente, resultado, campos, previos } = useFormulario(registrarOrdenPagoAction);

  const opcionesProveedor: readonly Opcion[] = proveedores.map((p) => ({
    valor: p.id,
    texto: p.razonSocial,
    deshabilitada: !p.activo,
  }));

  const opcionesPeriodo: readonly Opcion[] = periodos.map((p) => ({
    valor: p.id,
    texto: `${formatearPeriodo(p.periodo)} (${p.editable ? "en " + ESTADO_PERIODO[p.estado].toLowerCase() : "no editable"})`,
    deshabilitada: !p.editable,
  }));

  const opcionesConcepto: readonly Opcion[] = conceptos.map((c) => ({
    valor: c.id,
    texto: `${c.nombre}${c.activo ? "" : " (inactivo)"}`,
    deshabilitada: !c.activo,
  }));

  const inicial = previos["proveedorId"] ?? "";
  const [proveedorId, setProveedorId] = useState(inicial);
  const elegido = proveedores.find((p) => p.id === proveedorId) ?? null;
  const ordenesPrevias = elegido ? ordenes.filter((o) => o.proveedorId === elegido.id).length : 0;

  if (resultado.estado === "ok") {
    return (
      <AvisoDeExito titulo="La orden de pago quedó registrada, en «pendiente».">
        Va a aparecer en la cola de aprobación. El comprobante y la factura se adjuntan después, desde
        su detalle.
      </AvisoDeExito>
    );
  }

  return (
    <div className={estilos.layout}>
      <Panel
        titulo="Datos de la orden"
        origen="Queda en «pendiente» hasta que alguien con el rol para aprobar la revise."
      >
        <Formulario accion={enviar} etiqueta="Registrar una orden de pago">
          <Campos>
            <CampoSeleccion
              nombre="proveedorId"
              etiqueta="Proveedor"
              requerido
              ancho
              opciones={opcionesProveedor}
              sinSeleccion="Elegí el proveedor…"
              errores={campos["proveedorId"]}
              valorInicial={inicial || undefined}
              alCambiar={setProveedorId}
            />
            <CampoSeleccion
              nombre="periodoId"
              etiqueta="Período"
              requerido
              opciones={opcionesPeriodo}
              sinSeleccion="Elegí el período…"
              errores={campos["periodoId"]}
              valorInicial={previos["periodoId"]}
              ayuda="El gasto se asienta acá si se aprueba, y solo si el período sigue editable."
            />
            <CampoSeleccion
              nombre="conceptoId"
              etiqueta="Concepto"
              requerido
              opciones={opcionesConcepto}
              sinSeleccion="Elegí el concepto…"
              errores={campos["conceptoId"]}
              valorInicial={previos["conceptoId"]}
            />
            <CampoTexto
              nombre="numeroFactura"
              etiqueta="N.º de factura"
              maximo={100}
              errores={campos["numeroFactura"]}
              valorInicial={previos["numeroFactura"]}
              ayuda="Solo el número de referencia — el documento en sí se adjunta después, desde el detalle."
            />
            <CampoMonto
              nombre="monto"
              etiqueta="Monto"
              requerido
              errores={campos["monto"]}
              valorInicial={previos["monto"]}
            />
            <CampoTexto
              nombre="descripcion"
              etiqueta="Descripción"
              requerido
              maximo={300}
              ancho
              errores={campos["descripcion"]}
              valorInicial={previos["descripcion"]}
              ayuda="Qué se está pagando y por qué."
            />
          </Campos>

          <Avisos>
            {resultado.estado === "falla" ? <AvisoDeFallo error={resultado.error} salidas={salidas} /> : null}
            {campos[""] ? <AvisoDeCamposSueltos mensajes={campos[""]} /> : null}
          </Avisos>

          <Acciones ayuda="El comprobante y la factura del proveedor se adjuntan después, desde el detalle de la orden — no hace falta tenerlos a mano para cargarla.">
            <BotonEnviar pendiente={pendiente} cargando="Registrando…">
              Registrar orden de pago
            </BotonEnviar>
          </Acciones>
        </Formulario>
      </Panel>

      <div className={estilos.contexto}>
        <Panel titulo="Proveedor elegido">
          {elegido ? (
            <>
              <Dato etiqueta="Razón social" grande>
                {elegido.razonSocial}
              </Dato>
              <Dato etiqueta="CBU / alias">
                {elegido.cbu || elegido.alias ? (
                  <>
                    {elegido.cbu ?? "sin CBU cargado"} / {elegido.alias ?? "sin alias"}
                  </>
                ) : (
                  "sin datos de pago cargados"
                )}
              </Dato>
              <Dato etiqueta="Órdenes previas" origen="cargadas hasta hoy, cualquier estado">
                {ordenesPrevias}
              </Dato>
            </>
          ) : (
            <p className={estilos.sinEleccion}>Elegí un proveedor para ver sus datos de pago.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}
