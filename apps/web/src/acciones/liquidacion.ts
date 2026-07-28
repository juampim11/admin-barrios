"use server";

/**
 * Las siete escrituras del recorrido: crear el período, cargar y borrar gastos, aplicar y anular un
 * cargo o un descuento, generar el borrador y emitir.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LA REGLA DURA (ADR-0002 §4.2): CUATRO PASOS Y NINGUNO MÁS
 *
 * 1. `parse` con un esquema Zod de `@admin-barrios/shared/escrituras`;
 * 2. `conSesion`;
 * 3. **una** llamada a un servicio de `@admin-barrios/data/servicios/*`;
 * 4. `revalidatePath` y devolver un resultado serializable.
 *
 * Los pasos 2 y 3 están en `ejecutar.ts`, escritos una sola vez. Lo que **no** hace ninguna de estas
 * funciones, y son violaciones si aparecen: calcular un importe, decidir si el período se puede
 * editar (lo decide el trigger `app.periodo_editable`), filtrar por `barrio_id` (lo decide la RLS), y
 * confiar en que solo la propia UI las llama — **una Server Action es un endpoint POST público**
 * identificado por un id opaco, y la autorización es siempre sesión + Zod + la base.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * `revalidatePath` VA CON EL **PATRÓN DE RUTA**, NO CON LA URL CONCRETA
 *
 * `revalidatePath("/[barrio]/liquidacion/[periodo]/gastos", "page")` y no
 * `revalidatePath(\`/\${barrioId}/liquidacion/\${periodoId}/gastos\`)`.
 *
 * El motivo es concreto: para armar la URL concreta haría falta el `barrioId`, y **ninguno de estos
 * esquemas lo tiene** salvo el alta del período. Los servicios derivan el barrio de la propia fila
 * bajo RLS a propósito (ADR-0002 §3.4), así que agregar un campo `barrioId` al formulario "solo para
 * la ruta" pondría en el request exactamente el dato que el aislamiento existe para no depender de
 * él — y el próximo que toque el archivo lo va a usar para filtrar. El patrón invalida un poco de
 * más (la caché de cliente de todas las rutas con esa forma) y no cuesta nada: estas páginas leen
 * cookies, así que ya son dinámicas y no están en la caché de servidor.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LOS `redirect()` VAN AFUERA DE TODO `try` Y DESPUÉS DE QUE LA TRANSACCIÓN CERRÓ
 *
 * Funcionan lanzando: adentro de `conSesion` dispararían un `ROLLBACK` y la escritura ya hecha se
 * perdería **en silencio**, sin error y sin log. Acá el único que hay está al final de
 * `crearPeriodoAction`, después de que `ejecutar` devolvió.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  anularAplicacionSchema,
  anularGastoSchema,
  aplicarConceptoAUnidadSchema,
  crearPeriodoSchema,
  emitirPeriodoSchema,
  generarBorradorSchema,
  registrarGastoSchema,
} from "@admin-barrios/shared/escrituras";
import { crearPeriodo } from "@admin-barrios/data/servicios/periodos";
import { borrarGasto, registrarGasto, type GastoEscrito } from "@admin-barrios/data/servicios/gastos";
import {
  anularAplicacion,
  aplicarConceptoAUnidad,
  type AplicacionEscrita,
} from "@admin-barrios/data/servicios/cargos";
import {
  emitirPeriodo,
  generarLiquidaciones,
  type PeriodoEmitido,
  type ResumenLiquidacion,
} from "@admin-barrios/data/servicios/liquidacion";
import { conConfirmacion } from "./confirmacion.ts";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion } from "./resultado.ts";

const RUTA_PERIODOS = "/[barrio]/liquidacion";
const RUTA_PERIODO = "/[barrio]/liquidacion/[periodo]";
const RUTA_GASTOS = "/[barrio]/liquidacion/[periodo]/gastos";
const RUTA_CARGOS = "/[barrio]/liquidacion/[periodo]/cargos";
const RUTA_REVISION = "/[barrio]/liquidacion/[periodo]/revision";

/** Las cinco pantallas del recorrido quedan viejas apenas se escribe cualquier cosa del período. */
function revalidarElPeriodo(): void {
  for (const ruta of [RUTA_PERIODOS, RUTA_PERIODO, RUTA_GASTOS, RUTA_CARGOS, RUTA_REVISION]) {
    revalidatePath(ruta, "page");
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 1 · Crear el período
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Crea el período y **manda derecho a cargar los gastos**, que es el paso siguiente del recorrido.
 *
 * El `redirect` reemplaza al aviso de éxito a propósito: un período recién creado está vacío, y
 * dejar a la persona en el formulario mirando un cartel verde la obliga a buscar sola dónde sigue.
 * El aviso lo da la pantalla de destino, con el `?creado=1`.
 */
export async function crearPeriodoAction(
  _previo: ResultadoDeAccion<never>,
  form: FormData,
): Promise<ResultadoDeAccion<never>> {
  // Los CRUDOS vuelven a pantalla; el merge con la confirmación alimenta **solo** al `parse`. Si
  // volviera el objeto mergeado, `confirmarMontoInusual` quedaría pegado como campo oculto y la
  // casilla pasaría a ser decorativa desde el segundo pedido (ver `ejecutar.ts`).
  const valores = valoresDe(form);
  const entrada = crearPeriodoSchema.safeParse(conConfirmacion(valores));
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => crearPeriodo(tx, entrada.data));
  if (resultado.estado !== "ok") return resultado;

  revalidarElPeriodo();
  // Afuera de `ejecutar`, o sea con la transacción ya cerrada: si lanzara adentro, el `insert` se
  // iría con el `ROLLBACK` y la pantalla mostraría un período que no existe.
  redirect(`/${entrada.data.barrioId}/liquidacion/${resultado.valor.id}/gastos?creado=1`);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 2 · Los gastos del mes
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Carga un gasto.
 *
 * Devuelve `sinRespaldoAsamblea` **releído de lo que escribió la base** —lo pone el trigger
 * `app.gasto_respaldo_extraordinaria`, no esta acción—, y la pantalla lo avisa en el acto sin
 * bloquear nada. Una extraordinaria sin acta se carga igual: una bomba que se rompe no espera a la
 * asamblea (doc 08 §A.0). Lo que el sistema no hace es fingir que hay respaldo.
 */
export async function registrarGastoAction(
  _previo: ResultadoDeAccion<GastoEscrito>,
  form: FormData,
): Promise<ResultadoDeAccion<GastoEscrito>> {
  // Los CRUDOS vuelven a pantalla; el merge con la confirmación alimenta **solo** al `parse`. Si
  // volviera el objeto mergeado, `confirmarMontoInusual` quedaría pegado como campo oculto y la
  // casilla pasaría a ser decorativa desde el segundo pedido (ver `ejecutar.ts`).
  const valores = valoresDe(form);
  const entrada = registrarGastoSchema.safeParse(conConfirmacion(valores));
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => registrarGasto(tx, entrada.data));
  if (resultado.estado === "ok") revalidarElPeriodo();
  return resultado;
}

/**
 * Borra un gasto.
 *
 * **Borrar y no anular, y la diferencia importa.** Un gasto de un período en borrador todavía no
 * llegó a la boleta de nadie: no hay evidencia que preservar, y el registro append-only de las
 * anulaciones está para lo que sí se cobró. Si el período ya no es editable, la base rechaza — la
 * pantalla no lo decide.
 */
export async function borrarGastoAction(
  _previo: ResultadoDeAccion<{ readonly gastoId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly gastoId: string }>> {
  const valores = valoresDe(form);
  const entrada = anularGastoSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    await borrarGasto(tx, entrada.data);
    return { gastoId: entrada.data.gastoId };
  });
  if (resultado.estado === "ok") revalidarElPeriodo();
  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 3 · Cargos y descuentos de una unidad
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Aplica un concepto del catálogo a una unidad.
 *
 * **Lo que devuelve no es lo que se mandó: es lo que la base congeló.** El nombre, la clase, el
 * método, el tope y el `importeEstimado` los escribe `app.cbu_antes()` copiándolos del catálogo y del
 * valor vigente **a la fecha del hecho**. La pantalla muestra eso y nada más.
 *
 * Y `importeEstimado` viene en `null` cuando el método es `porcentaje`: ese importe sale de la base de
 * cálculo de la liquidación de esa unidad, que todavía no existe. `null` **no es cero** y la pantalla
 * no lo estima por su cuenta — dos aritméticas distintas terminan siempre en un vecino reclamando
 * (doc 08 §AC punto 1).
 */
export async function aplicarConceptoAction(
  _previo: ResultadoDeAccion<AplicacionEscrita>,
  form: FormData,
): Promise<ResultadoDeAccion<AplicacionEscrita>> {
  // Los CRUDOS vuelven a pantalla; el merge con la confirmación alimenta **solo** al `parse`. Si
  // volviera el objeto mergeado, `confirmarMontoInusual` quedaría pegado como campo oculto y la
  // casilla pasaría a ser decorativa desde el segundo pedido (ver `ejecutar.ts`).
  const valores = valoresDe(form);
  const entrada = aplicarConceptoAUnidadSchema.safeParse(conConfirmacion(valores));
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => aplicarConceptoAUnidad(tx, entrada.data));
  if (resultado.estado === "ok") revalidarElPeriodo();
  return resultado;
}

/**
 * Anula una aplicación, con motivo. **Es el único camino para sacar un cargo: no se edita.**
 *
 * Editar destruiría la evidencia de qué se aprobó, así que la operación es irreversible y el motivo
 * queda en el registro append-only como única explicación de por qué esa plata no se cobró. El mínimo
 * de cinco caracteres lo pone `anularAplicacionSchema` y no es ceremonia: un motivo `"x"` deja el
 * asiento sin explicación para siempre.
 */
export async function anularAplicacionAction(
  _previo: ResultadoDeAccion<{ readonly aplicacionId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly aplicacionId: string }>> {
  const valores = valoresDe(form);
  const entrada = anularAplicacionSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, async (tx) => {
    await anularAplicacion(tx, entrada.data);
    return { aplicacionId: entrada.data.aplicacionId };
  });
  if (resultado.estado === "ok") revalidarElPeriodo();
  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 4 · Generar el borrador y emitir
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Genera (o regenera) las liquidaciones del período.
 *
 * **Repetirlo es seguro y por eso no lleva confirmación**: el servicio borra las liquidaciones
 * previas y vuelve a calcular. Si el período ya está emitido, la base rechaza. Ponerle ceremonia a
 * algo repetible enseña a apretar "sí" sin leer, y después esa costumbre llega al botón de emitir.
 *
 * `saldosAnteriores` no se manda: hoy entra por parámetro desde un script porque el módulo de cobros
 * no existe (ADR-0002 §8), y `generarBorradorSchema` no lo tiene justamente para que ninguna pantalla
 * pueda ofrecer tipear a mano la deuda de un vecino.
 */
export async function generarBorradorAction(
  _previo: ResultadoDeAccion<ResumenLiquidacion>,
  form: FormData,
): Promise<ResultadoDeAccion<ResumenLiquidacion>> {
  const valores = valoresDe(form);
  const entrada = generarBorradorSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => generarLiquidaciones(tx, entrada.data));
  if (resultado.estado === "ok") revalidarElPeriodo();
  return resultado;
}

/**
 * La casilla de acuse de la emisión.
 *
 * **No es una regla de negocio y no está duplicando ninguna**: quién puede emitir, en qué estado y
 * con qué condiciones lo decide `app.validar_emision` en la base, y esta acción no lo consulta ni lo
 * replica. Lo único que exige es que la persona haya marcado que entendió que no se deshace — una
 * condición de la **interfaz**, sobre un campo que no existe en el dominio y que ningún esquema de
 * `shared` conoce.
 *
 * Se valida en el servidor y no solo con el `required` del HTML porque el `required` del HTML no es
 * una validación: es una sugerencia que cualquier POST se saltea.
 */
const emitirDesdeLaPantallaSchema = emitirPeriodoSchema.extend({
  entiendo: z.literal("si", {
    errorMap: () => ({
      message:
        "Marcá la casilla: una vez emitido, el período queda inmutable y no hay forma de volver atrás.",
    }),
  }),
});

/**
 * Emite el período. **Irreversible.**
 *
 * La firma de quién emitió la pone la base desde `app.current_user_id()`, no el request: si viniera
 * por parámetro, cualquiera podría firmar con el nombre de otro. Por eso `emitirPeriodo` no recibe
 * usuario y hay que llamarla adentro de `conSesion`, que es lo que hace `ejecutar`.
 *
 * Devuelve `emitidaAt` y `emitidaPor` para que la pantalla muestre la firma **sin volver a
 * consultar**: el dato que se muestra es el que la base acaba de escribir, no una relectura que
 * podría traer otra cosa.
 */
export async function emitirPeriodoAction(
  _previo: ResultadoDeAccion<PeriodoEmitido>,
  form: FormData,
): Promise<ResultadoDeAccion<PeriodoEmitido>> {
  const valores = valoresDe(form);
  const entrada = emitirDesdeLaPantallaSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) =>
    emitirPeriodo(tx, { periodoId: entrada.data.periodoId }),
  );
  if (resultado.estado === "ok") revalidarElPeriodo();
  return resultado;
}
