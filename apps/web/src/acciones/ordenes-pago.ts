"use server";

/**
 * El circuito de una orden de pago: cargarla, aprobarla, rechazarla, marcarla pagada, anularla, y
 * pedir la URL de subida de su comprobante.
 *
 * Mismos cuatro pasos que `acciones/cobros.ts` (ADR-0002 §4.2): `parse` con un esquema Zod de
 * `@admin-barrios/shared/escrituras`, `conSesion`, **una** llamada a un servicio de
 * `@admin-barrios/data/servicios/*`, y `revalidatePath` + resultado serializable. Casi toda la
 * validación de la transición en sí (lista blanca de estados, gates de rol, cuatro-ojos) vive en
 * `app.orden_pago_transicion()` (`0044_ordenes_pago_reglas.sql`) — estas acciones son la misma capa
 * fina que el servicio que envuelven.
 *
 * **No hay acción `adjuntarComprobanteDeOPAction` ni `adjuntarFacturaDeOPAction` todavía.** Los dos
 * servicios existen y están probados, pero a diferencia de `pago` —donde el comprobante se adjunta EN
 * el alta, `registrarPagoSchema` lo exige— acá son un paso posterior y separado (la orden puede nacer
 * sin ninguno de los dos adjuntos y completarlos después, en cualquier estado salvo reemplazando uno
 * ya adjunto). Cuándo se ofrece ese botón es una decisión de pantalla que todavía no se tomó — se
 * agrega con la pantalla real, no antes. `marcarFacturaNoDisponibleDeOPAction` sí está, porque no
 * depende de esa decisión: es una declaración explícita, no un adjunto.
 *
 * **Los nombres de ruta son provisorios**, misma salvedad que `acciones/proveedores.ts`.
 */

import { revalidatePath } from "next/cache";
import {
  registrarOrdenPagoSchema,
  aprobarOrdenPagoSchema,
  rechazarOrdenPagoSchema,
  marcarOrdenPagadaSchema,
  anularOrdenPagoSchema,
  prepararSubidaDeComprobanteDeOPSchema,
  prepararSubidaDeFacturaDeOPSchema,
  marcarFacturaNoDisponibleDeOPSchema,
} from "@admin-barrios/shared/escrituras";
import {
  registrarOrdenPago,
  aprobarOrdenPago,
  rechazarOrdenPago,
  marcarOrdenPagada,
  anularOrdenPago,
  prepararSubidaDeComprobanteDeOP,
  prepararSubidaDeFacturaDeOP,
  marcarFacturaNoDisponibleDeOP,
  type OrdenPago,
} from "@admin-barrios/data/servicios/ordenes-pago";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion } from "./resultado.ts";
import { urlDeSubidaDeComprobante } from "../servidor/almacenamiento.ts";

const RUTA_GRILLA = "/[barrio]/ordenes-pago";
const RUTA_ORDEN = "/[barrio]/ordenes-pago/[orden]";

function revalidarOrdenesPago(): void {
  // Patrón de ruta, no la URL concreta — mismo motivo que el resto del kit (ninguno de estos
  // esquemas trae `barrioId`/`ordenPagoId` como para armar la URL real, y aunque los trajera, es el
  // mismo criterio que ya explica `acciones/liquidacion.ts`).
  revalidatePath(RUTA_GRILLA, "page");
  revalidatePath(RUTA_ORDEN, "page");
}

/** Carga una orden de pago en `pendiente`. `barrioId` no viaja: se deriva de `periodoId` bajo RLS. */
export async function registrarOrdenPagoAction(
  _previo: ResultadoDeAccion<OrdenPago>,
  form: FormData,
): Promise<ResultadoDeAccion<OrdenPago>> {
  const valores = valoresDe(form);
  const entrada = registrarOrdenPagoSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => registrarOrdenPago(tx, entrada.data));
  if (resultado.estado === "ok") revalidarOrdenesPago();
  return resultado;
}

/** Aprueba la orden. El gate de rol y el control de cuatro-ojos los aplica
 *  `app.orden_pago_transicion()`; `listarOrdenesPago()` ya trae `puedeAprobar` calculado para que la
 *  pantalla ni siquiera ofrezca el botón cuando no corresponde. */
export async function aprobarOrdenPagoAction(
  _previo: ResultadoDeAccion<OrdenPago>,
  form: FormData,
): Promise<ResultadoDeAccion<OrdenPago>> {
  const valores = valoresDe(form);
  const entrada = aprobarOrdenPagoSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => aprobarOrdenPago(tx, entrada.data));
  if (resultado.estado === "ok") revalidarOrdenesPago();
  return resultado;
}

export async function rechazarOrdenPagoAction(
  _previo: ResultadoDeAccion<OrdenPago>,
  form: FormData,
): Promise<ResultadoDeAccion<OrdenPago>> {
  const valores = valoresDe(form);
  const entrada = rechazarOrdenPagoSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => rechazarOrdenPago(tx, entrada.data));
  if (resultado.estado === "ok") revalidarOrdenesPago();
  return resultado;
}

/** Marca la orden como pagada. `medioPago` viaja en el mismo envío — fuera de `pendiente` la columna
 *  está congelada salvo por esta transición puntual. */
export async function marcarPagadaAction(
  _previo: ResultadoDeAccion<OrdenPago>,
  form: FormData,
): Promise<ResultadoDeAccion<OrdenPago>> {
  const valores = valoresDe(form);
  const entrada = marcarOrdenPagadaSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => marcarOrdenPagada(tx, entrada.data));
  if (resultado.estado === "ok") revalidarOrdenesPago();
  return resultado;
}

/** Anula la orden, con motivo obligatorio. Si ya había generado su `gasto_periodo`, el trigger lo
 *  revierte o genera el ajuste correspondiente — ver `0044_ordenes_pago_reglas.sql`. */
export async function anularOrdenPagoAction(
  _previo: ResultadoDeAccion<OrdenPago>,
  form: FormData,
): Promise<ResultadoDeAccion<OrdenPago>> {
  const valores = valoresDe(form);
  const entrada = anularOrdenPagoSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => anularOrdenPago(tx, entrada.data));
  if (resultado.estado === "ok") revalidarOrdenesPago();
  return resultado;
}

/** Lo que necesita el navegador para completar el POST directo contra el storage — mismo contrato
 *  que `SubidaComprobantePreparada` de `acciones/cobros.ts`. */
export type SubidaComprobanteDeOPPreparada = {
  readonly storageKey: string;
  readonly url: string;
  readonly campos: Readonly<Record<string, string>>;
};

/**
 * Pide una URL de subida para el comprobante de una orden de pago. Mismo esqueleto de cuatro pasos
 * con la misma salvedad que `prepararSubidaDeComprobanteAction` (`acciones/cobros.ts`): después de la
 * única llamada a un servicio (`prepararSubidaDeComprobanteDeOP`, que ya escribió el pedido de subida
 * en su propia transacción) hay un paso más — firmar la URL — a través de la única puerta permitida
 * desde una Server Action (`../servidor/almacenamiento.ts`, regla 9). **Sin `revalidatePath`**: pedir
 * una URL no cambia nada que ninguna pantalla muestre todavía.
 */
export async function prepararSubidaDeComprobanteDeOPAction(
  _previo: ResultadoDeAccion<SubidaComprobanteDeOPPreparada>,
  form: FormData,
): Promise<ResultadoDeAccion<SubidaComprobanteDeOPPreparada>> {
  const valores = valoresDe(form);
  const entrada = prepararSubidaDeComprobanteDeOPSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => prepararSubidaDeComprobanteDeOP(tx, entrada.data));
  if (resultado.estado !== "ok") return resultado;

  const subida = await urlDeSubidaDeComprobante(resultado.valor.storageKey, entrada.data.contentType);
  return {
    estado: "ok",
    valor: { storageKey: resultado.valor.storageKey, url: subida.url, campos: subida.campos },
  };
}

/** Mismo esqueleto que `prepararSubidaDeComprobanteDeOPAction`, para la FACTURA de la orden en vez
 *  del comprobante de pago. */
export async function prepararSubidaDeFacturaDeOPAction(
  _previo: ResultadoDeAccion<SubidaComprobanteDeOPPreparada>,
  form: FormData,
): Promise<ResultadoDeAccion<SubidaComprobanteDeOPPreparada>> {
  const valores = valoresDe(form);
  const entrada = prepararSubidaDeFacturaDeOPSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => prepararSubidaDeFacturaDeOP(tx, entrada.data));
  if (resultado.estado !== "ok") return resultado;

  const subida = await urlDeSubidaDeComprobante(resultado.valor.storageKey, entrada.data.contentType);
  return {
    estado: "ok",
    valor: { storageKey: resultado.valor.storageKey, url: subida.url, campos: subida.campos },
  };
}

/** Declara que esta orden nunca va a tener factura del proveedor, con motivo obligatorio. ⚠ Si la
 *  orden ya tenía una factura adjunta, la desvincula — ver el docstring de
 *  `marcarFacturaNoDisponibleDeOP()` en el servicio; la pantalla tiene que confirmarlo antes de
 *  llamar a esta acción cuando corresponda. */
export async function marcarFacturaNoDisponibleDeOPAction(
  _previo: ResultadoDeAccion<OrdenPago>,
  form: FormData,
): Promise<ResultadoDeAccion<OrdenPago>> {
  const valores = valoresDe(form);
  const entrada = marcarFacturaNoDisponibleDeOPSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => marcarFacturaNoDisponibleDeOP(tx, entrada.data));
  if (resultado.estado === "ok") revalidarOrdenesPago();
  return resultado;
}
