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
import {
  condonarInteresSchema,
  noCobrarInteresSchema,
  opcionesDelPagoSchema,
  registrarPagoSchema,
  prepararSubidaDeComprobanteSchema,
} from "@admin-barrios/shared/escrituras";
import {
  condonarInteres,
  registrarEImputarPago,
  type PagoRegistradoEImputado,
} from "@admin-barrios/data/servicios/deuda";
import { prepararSubidaDeComprobante } from "@admin-barrios/data/servicios/documentos";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion, traducirFallo } from "./resultado.ts";
import { urlDeSubidaDeComprobante, exigirSubidaConfigurada } from "../servidor/almacenamiento.ts";

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
 * **Lo imputa en el mismo acto** (ADR-0009), en el orden del barrio. Si el pago es fuera de término y
 * devengó interés, el servicio primero pide confirmación con las cifras (cuánto interés, cuántos días,
 * cómo se reparte); y si se marcó «No cobrar interés de este pago», ese interés se condona entero con
 * el motivo que se cargó y el pago va a capital.
 */
export async function registrarPagoAction(
  _previo: ResultadoDeAccion<PagoRegistradoEImputado>,
  form: FormData,
): Promise<ResultadoDeAccion<PagoRegistradoEImputado>> {
  const valores = valoresDe(form);
  const entrada = registrarPagoSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const opciones = opcionesDelPagoSchema.safeParse(valores);
  if (!opciones.success) return camposInvalidos(opciones.error, valores);
  let noCobrarInteres = null;
  if (opciones.data.noCobrarInteres) {
    const datos = noCobrarInteresSchema.safeParse(valores);
    if (!datos.success) return camposInvalidos(datos.error, valores);
    noCobrarInteres = datos.data;
  }

  const resultado = await ejecutar(valores, (tx) =>
    registrarEImputarPago(tx, {
      pago: entrada.data,
      confirmarPagoConInteres: opciones.data.confirmarPagoConInteres,
      noCobrarInteres,
    }),
  );
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

  // Antes de registrar el pedido: sin credencial no se deja una solicitud huérfana (BL-019).
  try {
    exigirSubidaConfigurada();
  } catch (e) {
    return { estado: "falla", error: traducirFallo(e), valores };
  }
  const resultado = await ejecutar(valores, (tx) => prepararSubidaDeComprobante(tx, entrada.data));
  if (resultado.estado !== "ok") return resultado;

  let subida: Awaited<ReturnType<typeof urlDeSubidaDeComprobante>>;
  try {
    subida = await urlDeSubidaDeComprobante(resultado.valor.storageKey, entrada.data.contentType);
  } catch (e) {
    // Configuración del entorno (BL-019) u otro fallo del storage: una `falla` con su mensaje, no un throw.
    return { estado: "falla", error: traducirFallo(e), valores };
  }
  return {
    estado: "ok",
    valor: { storageKey: resultado.valor.storageKey, url: subida.url, campos: subida.campos },
  };
}

/**
 * Condona interés pendiente de una unidad, desde su estado de cuenta (ADR-0009). Pide confirmación con
 * el importe (`condonacion_requiere_confirmacion`); solo la administración del barrio puede, y lo decide
 * la base.
 */
export async function condonarInteresAction(
  _previo: ResultadoDeAccion<{ readonly condonado: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly condonado: string }>> {
  const valores = valoresDe(form);
  const entrada = condonarInteresSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, (tx) => condonarInteres(tx, entrada.data));
  if (resultado.estado === "ok") {
    revalidatePath(RUTA_GRILLA, "page");
    revalidatePath(RUTA_UNIDAD, "page");
  }
  return resultado;
}
