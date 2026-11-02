"use server";

/**
 * Los parámetros de mora e imputación (ADR-0006): fijar un valor, volver al valor general, anular un
 * cambio programado, y pedir la URL de subida del adjunto de un respaldo.
 *
 * Los mismos cuatro pasos que el resto de las acciones (ADR-0002 §4.2): `parse` con el esquema de
 * `@admin-barrios/shared/parametros-mora`, `conSesion`, **una** llamada a
 * `@admin-barrios/data/servicios/parametros`, y `revalidatePath` + resultado serializable. Todo lo que
 * importa de verdad —que no sea retroactivo, que la tasa tenga respaldo, que quien escribe pueda
 * hacerlo, que «Cobra interés» no quede en Sí con tasa cero— lo decide `app.fijar_parametro()` en la
 * base; acá no hay una sola de esas reglas.
 *
 * **Se revalidan las dos pantallas de configuración y el tablero**, siempre las tres: un cambio en la
 * general cambia lo que hereda cada barrio, uno del barrio cambia el «N barrios con valor propio» de
 * la general, y el tablero muestra la tasa vigente. Patrón de ruta, no URL concreta — mismo criterio
 * que `acciones/liquidacion.ts`.
 */

import { revalidatePath } from "next/cache";
import {
  anularParametroSchema,
  fijarParametroSchema,
  prepararSubidaDeRespaldoSchema,
  volverAlValorGeneralSchema,
  type FijarParametro,
} from "@admin-barrios/shared/parametros-mora";
import {
  anularParametroProgramado,
  fijarParametro,
  prepararSubidaDeRespaldo,
  volverAlValorGeneral,
  type ParametroFijado,
} from "@admin-barrios/data/servicios/parametros";
import { conConfirmacion } from "./confirmacion.ts";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion, type ValoresDeFormulario } from "./resultado.ts";
import { urlDeSubidaDeComprobante } from "../servidor/almacenamiento.ts";

function revalidarConfiguracion(): void {
  revalidatePath("/[barrio]/configuracion", "page");
  revalidatePath("/[barrio]/configuracion/general", "page");
  revalidatePath("/[barrio]/tablero", "page");
}

/**
 * Fija un valor en la administración o en un barrio, desde hoy o desde una fecha futura.
 *
 * Al pasar «Cobra interés por mora» a Sí, el servicio rechaza con
 * `activar_interes_requiere_confirmacion` diciendo qué orden de imputación rige; la confirmación
 * está registrada en `confirmacion.ts` y el reintento llega con `confirmarActivarInteres`.
 */
export async function fijarParametroAction(
  _previo: ResultadoDeAccion<ParametroFijado>,
  form: FormData,
): Promise<ResultadoDeAccion<ParametroFijado>> {
  const valores = valoresDe(form);
  const crudo = conConfirmacion(valores);
  const entrada = fijarParametroSchema.safeParse(crudo);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  /*
   * Al servicio va la **entrada** del esquema, no su salida: `fijarParametro()` vuelve a hacer el
   * `parse` (es su guardia) y el esquema convierte `valor` de texto a la forma de la base. Pasarle
   * lo ya convertido —un `true`, una fracción— haría fallar ese segundo `parse`.
   */
  const paraElServicio: FijarParametro = {
    nodoId: entrada.data.nodoId,
    clave: entrada.data.clave,
    valor: crudo["valor"] ?? "",
    rigeDesde: entrada.data.rigeDesde,
    motivo: entrada.data.motivo,
    respaldoTipo: entrada.data.respaldoTipo,
    respaldoReferencia: entrada.data.respaldoReferencia,
    respaldoAdjunto: entrada.data.respaldoAdjunto,
    confirmarActivarInteres: entrada.data.confirmarActivarInteres,
  };

  const resultado = await ejecutar(valores, (tx) => fijarParametro(tx, paraElServicio));
  if (resultado.estado === "ok") revalidarConfiguracion();
  return resultado;
}

/** «Volver al valor general»: el barrio vuelve a heredar desde una fecha (y se cancelan sus propios programados después). */
export async function volverAlValorGeneralAction(
  _previo: ResultadoDeAccion<ParametroFijado>,
  form: FormData,
): Promise<ResultadoDeAccion<ParametroFijado>> {
  const valores = valoresDe(form);
  const entrada = volverAlValorGeneralSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => volverAlValorGeneral(tx, entrada.data));
  if (resultado.estado === "ok") revalidarConfiguracion();
  return resultado;
}

/** Anula un cambio que todavía no rige. Lo que ya rige no se anula: se fija otro valor. */
export async function anularParametroAction(
  _previo: ResultadoDeAccion<{ readonly filaId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly filaId: string }>> {
  const valores = valoresDe(form);
  const entrada = anularParametroSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => anularParametroProgramado(tx, entrada.data));
  if (resultado.estado === "ok") revalidarConfiguracion();
  return resultado;
}

/** Lo que necesita el navegador para el POST directo contra el storage — mismo contrato que las otras subidas. */
export type SubidaDeRespaldoPreparada = {
  readonly storageKey: string;
  readonly url: string;
  readonly campos: Readonly<Record<string, string>>;
};

/**
 * Pide una URL de subida para el adjunto de un respaldo. Mismo esqueleto que
 * `prepararSubidaDeComprobanteDeOPAction`: el servicio registra el pedido (y decide si quien pide
 * puede editar los parámetros de ese nodo) y después se firma la URL por la única puerta permitida
 * (`../servidor/almacenamiento.ts`, regla 9). La clave puede colgar de `administraciones/…`:
 * `revisarClave()` la admite solo para respaldos. **Sin `revalidatePath`**: pedir una URL no cambia
 * nada que una pantalla muestre.
 */
export async function prepararSubidaDeRespaldoAction(
  _previo: ResultadoDeAccion<SubidaDeRespaldoPreparada>,
  form: FormData,
): Promise<ResultadoDeAccion<SubidaDeRespaldoPreparada>> {
  const valores = valoresDe(form);
  const entrada = prepararSubidaDeRespaldoSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => prepararSubidaDeRespaldo(tx, entrada.data));
  if (resultado.estado !== "ok") return resultado;

  const subida = await urlDeSubidaDeComprobante(resultado.valor.storageKey, entrada.data.contentType);
  return {
    estado: "ok",
    valor: { storageKey: resultado.valor.storageKey, url: subida.url, campos: subida.campos },
  };
}
