"use server";

/**
 * Las tres escrituras de la distribución: emitir el informe, armar el paquete y mandar los correos.
 *
 * Las tres son **encolados**: no hacen el trabajo, lo piden. Quien lo hace es el worker, que es el
 * único proceso con credenciales SMTP y el único que puede leer objetos del storage. Por eso las
 * tres devuelven un `Trabajo` y la pantalla lo sigue con el mismo polling que ya usa la emisión de
 * documentos.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LAS PRECONDICIONES NO ESTÁN ACÁ, Y ESO NO ES UN OLVIDO
 *
 * Ni el gate de rol de la distribución, ni "tiene que haber boletas", ni "tiene que estar el
 * informe", ni "primero se empaqueta". Todo eso vive en `app.trabajo_antes_insert()` (`0053`), que
 * es el único lugar que no se puede saltear: **una Server Action es un endpoint POST público**
 * identificado por un id opaco, y el rol de request puede insertar en `trabajo` directo. Un chequeo
 * escrito acá sería un chequeo que la próxima ruta se olvida (`security-engineer`, B-5).
 *
 * Lo que la pantalla sí hace es **no ofrecer** lo que la base va a rechazar (mismo criterio que la
 * pantalla de documentos): eso es honestidad de la UI, no control de acceso.
 */

import { revalidatePath } from "next/cache";
import { generarBorradorSchema } from "@admin-barrios/shared/escrituras";
import { encolarTrabajoDelPeriodo, type Trabajo } from "@admin-barrios/data/servicios/trabajos";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion } from "./resultado.ts";

const RUTA_DISTRIBUCION = "/[barrio]/liquidacion/[periodo]/distribucion";
/** Emitir el informe agrega un documento, y esa lista la dibuja la pantalla de documentos. */
const RUTA_DOCUMENTOS = "/[barrio]/liquidacion/[periodo]/documentos";
/** Distribuir puede sellar el período como `distribuida`, y eso lo muestran el resumen y la lista. */
const RUTA_PERIODO = "/[barrio]/liquidacion/[periodo]";
const RUTA_PERIODOS = "/[barrio]/liquidacion";

/**
 * Reusa `generarBorradorSchema` —`{ periodoId }`— en vez de declarar tres esquemas idénticos. Es el
 * mismo criterio con el que `emitirPeriodoSchema` existe aparte pese a tener la misma forma: allá
 * son operaciones de dominio distintas que **pueden divergir**; acá las tres son literalmente "este
 * período", y tres copias del mismo objeto de un campo serían tres lugares donde desincronizar la
 * validación de un id.
 */
const entradaDelPeriodo = generarBorradorSchema;

/** Emite el informe mensual del período: el segundo adjunto que recibe cada vecino. */
export async function emitirInformeAction(
  _previo: ResultadoDeAccion<Trabajo>,
  form: FormData,
): Promise<ResultadoDeAccion<Trabajo>> {
  const valores = valoresDe(form);
  const entrada = entradaDelPeriodo.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) =>
    encolarTrabajoDelPeriodo(tx, { periodoId: entrada.data.periodoId, tipo: "emitir_informe_periodo" }),
  );
  if (resultado.estado === "ok") {
    revalidatePath(RUTA_DISTRIBUCION, "page");
    revalidatePath(RUTA_DOCUMENTOS, "page");
  }
  return resultado;
}

/** Arma el ZIP con las boletas del período: la copia que queda archivada de lo que se envió. */
export async function armarPaqueteAction(
  _previo: ResultadoDeAccion<Trabajo>,
  form: FormData,
): Promise<ResultadoDeAccion<Trabajo>> {
  const valores = valoresDe(form);
  const entrada = entradaDelPeriodo.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) =>
    encolarTrabajoDelPeriodo(tx, { periodoId: entrada.data.periodoId, tipo: "armar_paquete_periodo" }),
  );
  if (resultado.estado === "ok") revalidatePath(RUTA_DISTRIBUCION, "page");
  return resultado;
}

/**
 * Manda los correos: uno por unidad, con su boleta y el informe del barrio.
 *
 * **Es la única escritura del sistema que no se puede deshacer.** Un PDF se regenera, un ZIP se
 * rearma, una URL firmada vence; un email que salió está en la bandeja de un vecino para siempre. La
 * pantalla pide una confirmación explícita antes de llamar acá, y el registro por destinatario
 * (`envio_liquidacion`) nace **antes** de que salga el primer mensaje.
 */
export async function distribuirAction(
  _previo: ResultadoDeAccion<Trabajo>,
  form: FormData,
): Promise<ResultadoDeAccion<Trabajo>> {
  const valores = valoresDe(form);
  const entrada = entradaDelPeriodo.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) =>
    encolarTrabajoDelPeriodo(tx, { periodoId: entrada.data.periodoId, tipo: "distribuir_liquidaciones" }),
  );
  if (resultado.estado === "ok") {
    revalidatePath(RUTA_DISTRIBUCION, "page");
    revalidatePath(RUTA_PERIODO, "page");
    revalidatePath(RUTA_PERIODOS, "page");
  }
  return resultado;
}
