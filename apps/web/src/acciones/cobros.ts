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
 * probado del lado del backend, y el worker ya tiene el handler de `emitir_recibo_pago`; lo que falta
 * es esta acción y su botón, que son producto nuevo (quedaron fuera de BL-024, que era pulido). La
 * pantalla del estado de cuenta no ofrece esa acción — la explica y la deja deshabilitada, mismo
 * criterio que `puedeEmitir`/`puedeRegistrarPago` pero por un hecho del estado del sistema, no por un
 * permiso. Ver el comentario del botón "Generar recibo" en `cobros/[unidad]/page.tsx`.
 */

import { revalidatePath } from "next/cache";
import {
  anularPagoSchema,
  condonarInteresSchema,
  noCobrarInteresSchema,
  opcionesDelPagoSchema,
  registrarPagoSchema,
  prepararSubidaDeComprobanteSchema,
} from "@admin-barrios/shared/escrituras";
import { consultaInteresDelPagoSchema } from "@admin-barrios/shared/consultas";
import {
  condonarInteres,
  interesQueSePuedeNoCobrar,
  registrarEImputarPago,
  type PagoRegistradoEImputado,
} from "@admin-barrios/data/servicios/deuda";
import { prepararSubidaDeComprobante } from "@admin-barrios/data/servicios/documentos";
import { anularPago } from "@admin-barrios/data/servicios/pagos";
import { CAMPO_CIFRAS_CONFIRMADAS, conConfirmacion } from "./confirmacion.ts";
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
  // Los CRUDOS vuelven a pantalla; el merge con la confirmación alimenta **solo** al `parse`, mismo
  // patrón que `acciones/liquidacion.ts`. Sin el merge, `confirmarPagoConInteres` —que no viaja
  // oculto— nunca llegaba al servicio y la pantalla pedía la confirmación sin fin (BL-024).
  const valores = valoresDe(form);
  const confirmados = conConfirmacion(valores);
  const entrada = registrarPagoSchema.safeParse(confirmados);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const opciones = opcionesDelPagoSchema.safeParse(confirmados);
  if (!opciones.success) return camposInvalidos(opciones.error, valores);
  let noCobrarInteres = null;
  // Los dos renglones de «No cobrar interés» (encargo 11, BL-030 j). Con la casilla marcada y los dos
  // renglones destildados no hay nada que condonar: se pide marcar uno, en vez de registrar un «no
  // cobrar» que no condona nada.
  const condonar = { delPago: opciones.data.noCobrarInteresDelPago, anterior: opciones.data.noCobrarInteresAnterior };
  if (opciones.data.noCobrarInteres) {
    const datos = noCobrarInteresSchema.safeParse(confirmados);
    if (!datos.success) return camposInvalidos(datos.error, valores);
    if (!condonar.delPago && !condonar.anterior) {
      return {
        estado: "campos",
        campos: { noCobrarInteresDelPago: ["Marcá qué interés no se cobra: el de este atraso, el anterior o los dos."] },
        valores,
      };
    }
    noCobrarInteres = datos.data;
  }

  const resultado = await ejecutar(valores, (tx) =>
    registrarEImputarPago(tx, {
      pago: entrada.data,
      confirmarPagoConInteres: opciones.data.confirmarPagoConInteres,
      noCobrarInteres,
      condonar,
      // Desde la pantalla siempre se compara: sin cifras mostradas («»), no coincide y se vuelve a pedir.
      cifrasConfirmadas: valores[CAMPO_CIFRAS_CONFIRMADAS] ?? "",
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
  _previo: ResultadoDeAccion<{ readonly condonado: string; readonly condonacionId: string | null }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly condonado: string; readonly condonacionId: string | null }>> {
  // Mismo patrón que arriba: `confirmarCondonacion` llega solo por el merge, nunca oculto (BL-024).
  const valores = valoresDe(form);
  const entrada = condonarInteresSchema.safeParse(conConfirmacion(valores));
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, (tx) => condonarInteres(tx, entrada.data));
  if (resultado.estado === "ok") {
    revalidatePath(RUTA_GRILLA, "page");
    revalidatePath(RUTA_UNIDAD, "page");
  }
  return resultado;
}

/**
 * Anula un pago desde el estado de cuenta de la unidad (encargo 10, BL-029), con motivo obligatorio.
 *
 * Es `anularPago` **tal como quedó en el #35**: anula el pago, sus imputaciones a capital y a interés
 * y la condonación que se registró con él, con el mismo motivo y sin borrar nada. Quién puede lo
 * decide la base (las políticas de `pago` y de sus imputaciones); la pantalla solo ofrece el botón a
 * quien registra pagos, que son los mismos roles.
 */
export async function anularPagoAction(
  _previo: ResultadoDeAccion<{ readonly pagoId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly pagoId: string }>> {
  const valores = valoresDe(form);
  const entrada = anularPagoSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, async (tx) => {
    await anularPago(tx, entrada.data);
    return { pagoId: entrada.data.pagoId };
  });
  if (resultado.estado === "ok") {
    revalidatePath(RUTA_GRILLA, "page");
    revalidatePath(RUTA_UNIDAD, "page");
  }
  return resultado;
}

/**
 * Los importes de los dos renglones de «No cobrar interés» (encargo 11, BL-030 j): el interés de este
 * atraso y el anterior que la unidad todavía debe, para un pago de esa unidad en esa fecha. **Solo
 * lee**: el formulario lo pide al elegir la unidad y la fecha, para mostrar cada renglón con su
 * importe antes de enviar. Sin `revalidatePath`: no cambia nada. Las cifras que valen son las que el
 * servidor vuelve a calcular al registrar, y la confirmación las muestra de nuevo.
 */
export async function interesQueSePuedeNoCobrarAction(
  _previo: ResultadoDeAccion<{ readonly delPago: string; readonly anterior: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly delPago: string; readonly anterior: string }>> {
  const valores = valoresDe(form);
  const entrada = consultaInteresDelPagoSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  return ejecutar(valores, (tx) => interesQueSePuedeNoCobrar(tx, entrada.data));
}
