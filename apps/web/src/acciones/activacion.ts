"use server";

/**
 * Activar un barrio que ya venía funcionando (encargo 17, Etapa 1.4): cargar la planilla de deuda
 * anterior, decir que el barrio no trae deuda, y activarlo.
 *
 * Los mismos cuatro pasos que el resto de las acciones (ADR-0002 §4.2): `parse` con el esquema de
 * `@admin-barrios/shared`, `conSesion`, **una** llamada a un servicio y `revalidatePath` + resultado
 * serializable. Quién puede (la administración del barrio), que la planilla entre entera o no entre,
 * que se reemplace solo mientras el barrio no emitió, que la activación sea una sola vez y que una
 * tasa distinta de la vigente lleve motivo: todo eso lo deciden el servicio y la base. Acá no hay
 * ninguna de esas reglas.
 *
 * La vista previa de la planilla **no pasa por acá**: sube por `app/api/activacion/deuda/route.ts`
 * (el archivo puede pesar 5 MB y el tope de una acción es 1 MB).
 */

import { revalidatePath } from "next/cache";
import { activarBarrioSchema, cargarDeudaAnteriorSchema } from "@admin-barrios/shared/activacion";
import { consultaBarrioSchema } from "@admin-barrios/shared/consultas";
import {
  activarBarrio,
  cargarDeudaAnterior,
  declararSinDeudaAnterior,
  type BarrioActivado,
  type DeudaAnteriorCargada,
} from "@admin-barrios/data/servicios/activacion";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion } from "./resultado.ts";

/**
 * Lo que queda viejo: el tablero con sus pasos y las dos pantallas de la activación (un `layout` del
 * segmento las alcanza a las tres), el mes —que deja de avisar que el barrio está sin activar— y los
 * cobros, donde aparece la deuda mes por mes y el saldo a favor.
 */
function revalidarLaActivacion(): void {
  revalidatePath("/[barrio]/tablero", "layout");
  revalidatePath("/[barrio]/liquidacion/[periodo]", "layout");
  revalidatePath("/[barrio]/cobros", "layout");
  revalidatePath("/liquidacion-actual", "page");
}

/**
 * Las filas de la planilla, que viajan en un campo oculto como texto: son las que leyó el servidor
 * del archivo al armar la vista previa (`api/activacion/deuda`). Si el campo no es una lista, va tal
 * cual al esquema, que lo rechaza: acá no se valida nada.
 */
function filasDe(texto: string | undefined): unknown {
  if (texto === undefined) return undefined;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

/**
 * «Confirmar la carga»: la planilla de deuda anterior, **entera o nada**. El servicio vuelve a
 * validar cada fila contra la base —la vista previa que se mostró no autoriza nada— y con un solo
 * error no carga ninguna. Si ya había una carga, la descarta y la reemplaza.
 */
export async function cargarDeudaAnteriorAction(
  _previo: ResultadoDeAccion<DeudaAnteriorCargada>,
  form: FormData,
): Promise<ResultadoDeAccion<DeudaAnteriorCargada>> {
  const valores = valoresDe(form);
  const entrada = cargarDeudaAnteriorSchema.safeParse({ ...valores, filas: filasDe(valores["filas"]) });
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => cargarDeudaAnterior(tx, entrada.data));
  if (resultado.estado === "ok") revalidarLaActivacion();
  return resultado;
}

/** «El barrio no trae deuda»: lo deja dicho (y descarta una planilla anterior, si la había). */
export async function declararSinDeudaAnteriorAction(
  _previo: ResultadoDeAccion<DeudaAnteriorCargada>,
  form: FormData,
): Promise<ResultadoDeAccion<DeudaAnteriorCargada>> {
  const valores = valoresDe(form);
  const entrada = consultaBarrioSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => declararSinDeudaAnterior(tx, entrada.data));
  if (resultado.estado === "ok") revalidarLaActivacion();
  return resultado;
}

/**
 * «Activar el barrio»: una sola vez. La tasa para la deuda anterior viaja **como la escribió la
 * persona** (porcentaje mensual: «3» o «3,5»).
 *
 * ⚠ **Al servicio va lo tipeado, no `entrada.data`.** `activarBarrioSchema` transforma el porcentaje
 * a fracción («3» → «0.030000») y `activarBarrio` parsea de nuevo con el mismo esquema: pasarle lo ya
 * transformado leería «0.030000» como un 0,03 % mensual. El `safeParse` de acá existe para poner el
 * error en su campo antes de abrir la sesión.
 *
 * Si la tasa no es la vigente del barrio y falta el motivo, la base rechaza con `dato_invalido` y
 * `datos.campo = "motivo"`: ese rechazo se muestra **en el campo**, que es donde se corrige.
 */
export async function activarBarrioAction(
  _previo: ResultadoDeAccion<BarrioActivado>,
  form: FormData,
): Promise<ResultadoDeAccion<BarrioActivado>> {
  const valores = valoresDe(form);
  const tipeado = { barrioId: valores["barrioId"] ?? "", tasa: valores["tasa"] ?? "", motivo: valores["motivo"] ?? "" };
  const entrada = activarBarrioSchema.safeParse(tipeado);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => activarBarrio(tx, tipeado));
  if (resultado.estado === "ok") revalidarLaActivacion();
  if (resultado.estado === "falla" && resultado.error.codigo === "dato_invalido" && resultado.error.datos["campo"] === "motivo") {
    return { estado: "campos", campos: { motivo: [resultado.error.mensaje] }, valores };
  }
  return resultado;
}
