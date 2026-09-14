"use server";

/**
 * La única escritura del módulo de Cobros en esta tanda: registrar un pago manual.
 *
 * Mismos cuatro pasos que `acciones/liquidacion.ts` (ADR-0002 §4.2): `parse` con un esquema Zod de
 * `@admin-barrios/shared/escrituras`, `conSesion`, **una** llamada a un servicio de
 * `@admin-barrios/data/servicios/*`, y `revalidatePath` + resultado serializable. Ver el comentario
 * de cabecera de `liquidacion.ts` para el porqué de cada uno — no se repite acá.
 *
 * **No hay acción para `encolarEmisionDeRecibo`.** El servicio existe en `servicios/cobros.ts` y está
 * probado del lado del backend, pero `apps/worker/src/main.ts` todavía no tiene un handler para el
 * tipo `emitir_recibo_pago` (su `Record` `HANDLERS` solo tiene `emitir_documentos_periodo`): sin eso,
 * encolar dejaría un trabajo que nunca termina y falla con un mensaje genérico del sistema. La
 * pantalla del estado de cuenta no ofrece esa acción — la explica y la deja deshabilitada, mismo
 * criterio que `puedeEmitir`/`puedeRegistrarPago` pero por un hecho del estado del sistema, no por un
 * permiso. Ver el comentario del botón "Generar recibo" en `cobros/[unidad]/page.tsx`.
 */

import { revalidatePath } from "next/cache";
import { registrarPagoSchema, prepararSubidaDeComprobanteSchema } from "@admin-barrios/shared/escrituras";
import { registrarPago, type PagoEscrito } from "@admin-barrios/data/servicios/pagos";
import { prepararSubidaDeComprobante } from "@admin-barrios/data/servicios/documentos";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion } from "./resultado.ts";
import { urlDeSubidaDeComprobante } from "../servidor/almacenamiento.ts";

const RUTA_GRILLA = "/[barrio]/cobros";
const RUTA_UNIDAD = "/[barrio]/cobros/[unidad]";

/**
 * Registra un pago manual contra una unidad.
 *
 * **`barrioId` no viaja en el formulario.** `registrarPago` lo deriva de `unidadFuncionalId` bajo
 * RLS, mismo criterio que el alta de gasto deriva el barrio del período: un `barrioId` de más sería
 * el aislamiento dependiendo de un valor que manda el cliente (ver el comentario de
 * `registrarPagoSchema` en `packages/shared/src/escrituras.ts`).
 *
 * **No imputa nada.** `registrarPago` solo crea el pago; imputarlo contra una liquidación es un paso
 * aparte y deliberadamente separado (`imputarPago`/`resolverImputacionAutomatica` en
 * `servicios/cobros.ts`), sin pantalla propia en esta tanda.
 */
export async function registrarPagoAction(
  _previo: ResultadoDeAccion<PagoEscrito>,
  form: FormData,
): Promise<ResultadoDeAccion<PagoEscrito>> {
  const valores = valoresDe(form);
  const entrada = registrarPagoSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => registrarPago(tx, entrada.data));
  if (resultado.estado === "ok") {
    // Patrón de ruta, no la URL concreta: ninguno de estos esquemas trae el `barrioId` (se deriva
    // bajo RLS), así que armar la URL exacta no es posible acá. Mismo criterio y mismo motivo que
    // `revalidarElPeriodo()` en `acciones/liquidacion.ts`.
    revalidatePath(RUTA_GRILLA, "page");
    revalidatePath(RUTA_UNIDAD, "page");
  }
  return resultado;
}

/** Lo que necesita el navegador para completar el POST directo contra el storage. */
export type SubidaComprobantePreparada = {
  readonly storageKey: string;
  readonly url: string;
  readonly campos: Readonly<Record<string, string>>;
};

/**
 * Pide una URL de subida para el comprobante de un pago manual. **No es el registro del pago**:
 * es el paso previo — el operador elige el archivo, esto le da adónde mandarlo, y recién con la
 * `storageKey` que devuelve se llama a `registrarPagoAction` (arriba) para dar de alta el pago.
 *
 * Mismo esqueleto de cuatro pasos, con una salvedad explícita: **después** de la única llamada a un
 * servicio de `@admin-barrios/data/servicios/*` (`prepararSubidaDeComprobante`, que ya escribió la
 * auditoría en su propia transacción) hay un paso más, firmar la URL, y no es una segunda llamada a
 * un servicio — es la misma plomería de storage que ya usa la ruta de descarga
 * (`api/comprobantes/[pagoId]/route.ts`), a través de la única puerta permitida desde una Server
 * Action (`../servidor/almacenamiento.ts`, regla 9). **Sin `revalidatePath`**: pedir una URL de
 * subida no cambia nada que ninguna pantalla muestre todavía — el pago recién existe cuando se llama
 * a `registrarPagoAction`, que es quien revalida.
 */
export async function prepararSubidaDeComprobanteAction(
  _previo: ResultadoDeAccion<SubidaComprobantePreparada>,
  form: FormData,
): Promise<ResultadoDeAccion<SubidaComprobantePreparada>> {
  const valores = valoresDe(form);
  const entrada = prepararSubidaDeComprobanteSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => prepararSubidaDeComprobante(tx, entrada.data));
  if (resultado.estado !== "ok") return resultado;

  const subida = await urlDeSubidaDeComprobante(resultado.valor.storageKey, entrada.data.contentType);
  return {
    estado: "ok",
    valor: { storageKey: resultado.valor.storageKey, url: subida.url, campos: subida.campos },
  };
}
