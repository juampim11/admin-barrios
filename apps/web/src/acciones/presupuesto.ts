"use server";

/**
 * «Presupuesto» del mes (encargo 16c): guardar el presupuesto y copiarlo del mes anterior.
 *
 * Los mismos cuatro pasos que el resto de las acciones (ADR-0002 §4.2): `parse` con el esquema de
 * `@admin-barrios/shared/presupuesto`, `conSesion` (adentro de `ejecutar`), **una** llamada a un
 * servicio y `revalidatePath` + resultado serializable. Quién puede (la administración), que el mes se
 * esté preparando, que el concepto sea del barrio: lo deciden el servicio y la base.
 *
 * **El importe del mes NO se graba acá.** «Usar este importe» va por `definirCuotaFijaAction`
 * (`liquidacion.ts`), el mismo camino y la misma confirmación que Configuración → Cuota: el
 * presupuesto propone, la cuota decide.
 */

import { revalidatePath } from "next/cache";
import { copiarPresupuestoSchema, guardarPresupuestoSchema } from "@admin-barrios/shared/presupuesto";
import { copiarPresupuestoDelMesAnterior, guardarPresupuesto } from "@admin-barrios/data/servicios/presupuesto";
import { ejecutar } from "./ejecutar.ts";
import { erroresDelPresupuesto, presupuestoDelFormulario } from "./presupuesto-formulario.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion } from "./resultado.ts";

/**
 * El presupuesto cambia lo que dicen la pestaña, «Gastos contra presupuesto» y los avisos del mes
 * (el rubro que se pasó), que se ven en el Resumen y en «Liquidación actual».
 */
function revalidarElPresupuesto(): void {
  revalidatePath("/[barrio]/liquidacion/[periodo]", "layout");
  revalidatePath("/liquidacion-actual", "page");
}

/** «Guardar»: deja el presupuesto del mes exactamente como viene en el formulario. */
export async function guardarPresupuestoAction(
  _previo: ResultadoDeAccion<null>,
  form: FormData,
): Promise<ResultadoDeAccion<null>> {
  const valores = valoresDe(form);
  const forma = presupuestoDelFormulario(valores);
  const entrada = guardarPresupuestoSchema.safeParse(forma);
  if (!entrada.success) return { estado: "campos", campos: erroresDelPresupuesto(entrada.error, forma), valores };

  const resultado = await ejecutar(valores, async (tx) => {
    await guardarPresupuesto(tx, entrada.data);
    return null;
  });
  if (resultado.estado === "ok") revalidarElPresupuesto();
  return resultado;
}

/** «Copiar de <mes anterior>»: solo sobre un presupuesto vacío (lo controla el servicio). */
export async function copiarPresupuestoAction(
  _previo: ResultadoDeAccion<{ readonly rubros: number }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly rubros: number }>> {
  const valores = valoresDe(form);
  const entrada = copiarPresupuestoSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => copiarPresupuestoDelMesAnterior(tx, entrada.data));
  if (resultado.estado === "ok") revalidarElPresupuesto();
  return resultado;
}
