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
import {
  anularAplicacionSchema,
  anularGastoSchema,
  aplicarConceptoAUnidadSchema,
  generarBorradorSchema,
  registrarGastoSchema,
  definirCuotaFijaSchema,
  emitirMesSchema,
  cambiarVencimientosSchema,
} from "@admin-barrios/shared/escrituras";
import { ponerExcepcionDeBonificacionSchema, sacarExcepcionDeBonificacionSchema } from "@admin-barrios/shared/devengado";
import { aplicarPlanillaDeUsosSchema } from "@admin-barrios/shared/conceptos";
import { aplicarPlanillaDeUsos, type PlanillaDeUsosAplicada } from "@admin-barrios/data/servicios/conceptos-del-mes";
import { cambiarVencimientos, emitirMes, type MesEmitido } from "@admin-barrios/data/servicios/circuito-del-mes";
import { ponerExcepcionDeBonificacion, sacarExcepcionDeBonificacion } from "@admin-barrios/data/servicios/devengado";
import { definirCuotaFija, type CuotaFijaEscrita } from "@admin-barrios/data/servicios/cuota-fija";
import { borrarGasto, registrarGasto, type GastoEscrito } from "@admin-barrios/data/servicios/gastos";
import {
  anularAplicacion,
  aplicarConceptoAUnidad,
  type AplicacionEscrita,
} from "@admin-barrios/data/servicios/cargos";
import {
  encolarEmisionDeDocumentos,
  exigirQueNingunOtroPasoCorra,
  type Trabajo,
} from "@admin-barrios/data/servicios/trabajos";
import { CAMPO_CIFRAS_CONFIRMADAS, conConfirmacion } from "./confirmacion.ts";
import { ejecutar } from "./ejecutar.ts";
import { camposInvalidos, valoresDe, type ResultadoDeAccion } from "./resultado.ts";

const RUTA_MES = "/[barrio]/liquidacion/[periodo]";
const RUTA_MESES = "/[barrio]/liquidacion/meses";
const RUTA_CUOTA = "/[barrio]/configuracion/cuota";

/**
 * Todo lo que muestra el mes queda viejo apenas se escribe cualquier cosa del período: todas sus
 * pestañas (el `layout` del segmento del mes las cubre a todas), los meses anteriores, «Liquidación
 * actual» y el Inicio, que muestran su estado (T2).
 */
function revalidarElPeriodo(): void {
  revalidatePath(RUTA_MES, "layout");
  revalidatePath(RUTA_MESES, "page");
  revalidatePath("/liquidacion-actual", "page");
  revalidatePath("/", "page");
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

/**
 * Las filas de la planilla, que viajan en un campo oculto como texto: son las que leyó el servidor
 * del archivo al armar la vista previa (`api/usos/planilla`). Si el campo no es una lista, va tal cual
 * al esquema, que lo rechaza: acá no se valida nada.
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
 * Aplica la planilla de usos del mes (encargo 16b): **entera o nada**. El servicio vuelve a validar
 * cada fila contra la base —la vista previa que se mostró no autoriza nada— y con un solo error no
 * carga ninguna.
 *
 * Si los cargos de una unidad superan lo habitual, la base rechaza con `cargo_requiere_confirmacion`
 * y se reintenta con la confirmación (`conConfirmacion`, igual que al aplicar un concepto a mano). El
 * tope de un operador no se levanta con eso.
 */
export async function aplicarPlanillaDeUsosAction(
  _previo: ResultadoDeAccion<PlanillaDeUsosAplicada>,
  form: FormData,
): Promise<ResultadoDeAccion<PlanillaDeUsosAplicada>> {
  // Los CRUDOS vuelven a pantalla; el merge con la confirmación alimenta **solo** al `parse`.
  const valores = valoresDe(form);
  const entrada = aplicarPlanillaDeUsosSchema.safeParse({ ...conConfirmacion(valores), filas: filasDe(valores["filas"]) });
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => aplicarPlanillaDeUsos(tx, entrada.data));
  if (resultado.estado === "ok") revalidarElPeriodo();
  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 8 · Generar los documentos
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Encola la generación de los PDF del período. **Devuelve enseguida: no espera al worker.**
 *
 * Emitir el período y generar sus documentos son dos cosas distintas y separarlas no es cosmético
 * (ADR-0002 §6.1): emitir es un `UPDATE` sub-segundo que la base valida entera, y generar son ~14
 * segundos de cómputo y medio giga de memoria para un barrio de 200 unidades. Que el estado del
 * período —lo que la base considera verdad— no dependa de que un proceso externo termine bien es lo
 * que hace que un worker caído deje un período **emitido sin documentos**, que es un estado
 * recuperable y visible, en vez de un período a medias.
 *
 * Si ya hay un trabajo en curso, la base rebota por `uq_trabajo_pendiente` y el código de error es
 * `trabajo_ya_encolado`: la pantalla lo muestra como "ya se están generando", que es lo que la
 * persona quería saber, y no como un error.
 */
export async function generarDocumentosAction(
  _previo: ResultadoDeAccion<Trabajo>,
  form: FormData,
): Promise<ResultadoDeAccion<Trabajo>> {
  const valores = valoresDe(form);
  const entrada = generarBorradorSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  // La espera de Envío, también en el servidor (encargo 14, BL-035 b): si otro paso corre, este espera.
  const resultado = await ejecutar(valores, async (tx) => {
    await exigirQueNingunOtroPasoCorra(tx, { periodoId: entrada.data.periodoId, tipo: "emitir_documentos_periodo" });
    return encolarEmisionDeDocumentos(tx, { periodoId: entrada.data.periodoId });
  });
  if (resultado.estado === "ok") revalidarElPeriodo();
  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 9 · Definir la cuota fija del barrio
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Define la cuota que rige desde una fecha, en un barrio de cuota fija.
 *
 * **Es la única escritura del recorrido que no cuelga de un período**, y por eso lleva `barrioId` en
 * el formulario: no hay fila de la que derivarlo, igual que en el alta de período. No autoriza nada
 * —quién puede definir la cuota lo decide la policy de `insert` de `cuota_fija_version`, que exige
 * rol de gestión.
 *
 * **El importe de cada unidad lo calcula el servicio, no la pantalla.** El formulario manda el
 * porcentaje y el redondeo; la aritmética la hace `ajustarCuota` en el servidor, con centavos y
 * `bigint`. Que la pantalla muestre una vista previa antes de confirmar no la convierte en la
 * autoridad: llama a **la misma función pura**, así que si difirieran sería porque son la misma línea
 * de código ejecutándose dos veces (doc 08 §AC punto 1: nunca dos aritméticas distintas).
 */
export async function definirCuotaFijaAction(
  _previo: ResultadoDeAccion<CuotaFijaEscrita>,
  form: FormData,
): Promise<ResultadoDeAccion<CuotaFijaEscrita>> {
  // Los CRUDOS vuelven a pantalla; el merge con la confirmación alimenta **solo** al `parse`, igual
  // que en el alta de período: si volviera mergeado, `confirmarCuotaEnCero` quedaría pegado como
  // campo oculto y la casilla pasaría a ser decorativa desde el segundo intento.
  const valores = valoresDe(form);
  const entrada = definirCuotaFijaSchema.safeParse(conConfirmacion(valores));
  if (!entrada.success) return camposInvalidos(entrada.error, valores);

  const resultado = await ejecutar(valores, (tx) => definirCuotaFija(tx, entrada.data));
  if (resultado.estado === "ok") {
    revalidatePath(RUTA_CUOTA, "page");
    // La cuota cambia lo que dice el resumen del período (el total a devengar, la alerta de
    // suficiencia) aunque no se haya tocado el período: por eso se revalida el recorrido entero.
    revalidarElPeriodo();
  }
  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// T2 · El circuito del mes (ADR-0011): emitir calcula, y los vencimientos del mes
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Emite el mes en un solo acto (D1): calcula, valida y firma. **Irreversible.**
 *
 * La pantalla manda la huella de la última vista previa que mostró. Si lo calculado al emitir no
 * coincide, el servicio no emite y pide confirmar la diferencia (`emision_con_cambios`); al confirmar,
 * la huella que se compara es la de las cifras nuevas que se mostraron (`cifras`), así que si vuelven
 * a cambiar se pregunta otra vez.
 */
export async function emitirMesAction(
  _previo: ResultadoDeAccion<MesEmitido>,
  form: FormData,
): Promise<ResultadoDeAccion<MesEmitido>> {
  const valores = valoresDe(form);
  const confirmados = conConfirmacion(valores);
  const entrada = emitirMesSchema.safeParse(confirmados);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const confirmadas = valores[CAMPO_CIFRAS_CONFIRMADAS];
  const huellaVista = entrada.data.confirmarCambios && confirmadas ? confirmadas : entrada.data.huellaVista;

  const resultado = await ejecutar(valores, (tx) =>
    emitirMes(tx, {
      periodoId: entrada.data.periodoId,
      // Desde la pantalla siempre se compara: sin huella, una que nunca coincide, y se muestra la
      // diferencia. (Un `""` no servía: el esquema lo lee como «sin huella» y no comparaba.)
      huellaVista: huellaVista ?? HUELLA_QUE_NUNCA_COINCIDE,
      vistaCalculadaEl: entrada.data.vistaCalculadaEl,
      confirmarCambios: false,
    }),
  );
  if (resultado.estado === "ok") {
    revalidarElPeriodo();
    // A Envío desde el servidor: el botón que emitió deja de existir en la cabecera nueva (el mes ya
    // está emitido) y no alcanzaría a navegar por su cuenta (code-reviewer, T2).
    redirect(`/${resultado.valor.barrioId}/liquidacion/${resultado.valor.periodoId}/envio`);
  }
  return resultado;
}

/** Una huella con el formato de `huellaDe` que ninguna emisión puede dar (cero boletas y cero pesos). */
const HUELLA_QUE_NUNCA_COINCIDE = `0|0.00|${"0".repeat(32)}`;

/** Cambia los vencimientos del mes, con motivo, hasta emitir (el diálogo de la maqueta). */
export async function cambiarVencimientosAction(
  _previo: ResultadoDeAccion<{ readonly periodoId: string }>,
  form: FormData,
): Promise<ResultadoDeAccion<{ readonly periodoId: string }>> {
  const valores = valoresDe(form);
  const entrada = cambiarVencimientosSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, async (tx) => {
    await cambiarVencimientos(tx, entrada.data);
    return { periodoId: entrada.data.periodoId };
  });
  if (resultado.estado === "ok") revalidarElPeriodo();
  return resultado;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La bonificación por pago en término del mes: sus excepciones (encargo 16)
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** La unidad a la que se le cargó o se le sacó la excepción: con eso la pantalla cierra el formulario. */
export type ExcepcionDeBonificacionEscrita = { readonly unidadFuncionalId: string };

/**
 * «Dársela igual» o «Quitar»: la excepción de una unidad para un mes, con motivo. Que el mes no esté
 * emitido, que la bonificación se aplique sola y que quien la carga administre el barrio lo decide el
 * servicio. La vista previa del mes cambia con esto: se revalida el período entero.
 */
export async function ponerExcepcionDeBonificacionAction(
  _previo: ResultadoDeAccion<ExcepcionDeBonificacionEscrita>,
  form: FormData,
): Promise<ResultadoDeAccion<ExcepcionDeBonificacionEscrita>> {
  const valores = valoresDe(form);
  const entrada = ponerExcepcionDeBonificacionSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, async (tx) => {
    await ponerExcepcionDeBonificacion(tx, entrada.data);
    return { unidadFuncionalId: entrada.data.unidadFuncionalId };
  });
  if (resultado.estado === "ok") revalidarElPeriodo();
  return resultado;
}

/** «Sacar la excepción»: la unidad vuelve a la regla. También lleva motivo y queda en su historial. */
export async function sacarExcepcionDeBonificacionAction(
  _previo: ResultadoDeAccion<ExcepcionDeBonificacionEscrita>,
  form: FormData,
): Promise<ResultadoDeAccion<ExcepcionDeBonificacionEscrita>> {
  const valores = valoresDe(form);
  const entrada = sacarExcepcionDeBonificacionSchema.safeParse(valores);
  if (!entrada.success) return camposInvalidos(entrada.error, valores);
  const resultado = await ejecutar(valores, async (tx) => {
    await sacarExcepcionDeBonificacion(tx, entrada.data);
    return { unidadFuncionalId: entrada.data.unidadFuncionalId };
  });
  if (resultado.estado === "ok") revalidarElPeriodo();
  return resultado;
}
