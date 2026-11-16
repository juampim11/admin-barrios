/**
 * Los textos de la activación del barrio (encargo 17, pantallas 1 a 4 de la maqueta), como funciones
 * puras.
 *
 * No deciden nada del negocio: dicen en palabras lo que resolvieron `estadoDeLaActivacion`, la vista
 * previa de la planilla y la verificación. Están aparte de las pantallas para poder probarlas sin
 * base. Lo único que se compara acá es lo que la administración **tipea para mirar** en «Según el
 * sistema anterior», que no se guarda ni viaja: va en centavos enteros, nunca por `number`.
 */

import { porcentajeDeTasa } from "@admin-barrios/shared/activacion";
import { aCentavos, deCentavos, formatearMonto, normalizarMontoTipeado } from "@admin-barrios/shared/dinero";
import { formatearFecha, nombreDelPeriodo } from "@admin-barrios/shared/fechas";

const pesos = (monto: string): string => `$ ${formatearMonto(monto)}`;
const cuantos = (n: number, uno: string, varios: string): string => `${n} ${n === 1 ? uno : varios}`;

/** Lo que el servicio dice de la deuda anterior, sea la cargada o la de una vista previa. */
export type ResumenDeDeuda = {
  readonly deudas: number;
  readonly unidadesConDeuda: number;
  readonly totalDeuda: string;
  readonly saldosAFavor: number;
  readonly totalAFavor: string;
};

/** «12 deudas de 5 unidades por $ 1.250.000,00». */
export function deudasEnPalabras(r: Pick<ResumenDeDeuda, "deudas" | "unidadesConDeuda" | "totalDeuda">): string {
  return `${cuantos(r.deudas, "deuda", "deudas")} de ${cuantos(r.unidadesConDeuda, "unidad", "unidades")} por ${pesos(r.totalDeuda)}`;
}

/** «2 saldos a favor por $ 18.000,00». */
export function saldosAFavorEnPalabras(r: Pick<ResumenDeDeuda, "saldosAFavor" | "totalAFavor">): string {
  return `${cuantos(r.saldosAFavor, "saldo a favor", "saldos a favor")} por ${pesos(r.totalAFavor)}`;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Los cuatro pasos del tablero
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type EstadoParaLosPasos = ResumenDeDeuda & {
  readonly unidades: number;
  readonly conceptos: number;
  readonly deudaAnterior: "cargada" | "sin_deuda" | null;
};

export type PasoDeActivacion = {
  readonly clave: "padron" | "conceptos" | "deuda" | "activar";
  readonly titulo: string;
  readonly hecho: boolean;
  /** Lo que hay, o lo que falta. Puede ser más de un renglón (las deudas y los saldos a favor). */
  readonly detalle: readonly string[];
};

/** `true` cuando ya se puede ir a «Verificar antes de activar»: los tres pasos anteriores, hechos. */
export function sePuedeVerificar(e: Pick<EstadoParaLosPasos, "unidades" | "conceptos" | "deudaAnterior">): boolean {
  return e.unidades > 0 && e.conceptos > 0 && e.deudaAnterior !== null;
}

export function pasosDeLaActivacion(e: EstadoParaLosPasos): readonly PasoDeActivacion[] {
  const detalleDeDeuda: readonly string[] =
    e.deudaAnterior === null
      ? ["Falta resolver: subí la planilla con lo que cada unidad debe, mes por mes, o decí que el barrio no trae deuda."]
      : e.deudaAnterior === "sin_deuda"
        ? ["El barrio no trae deuda."]
        : [
            // Una planilla puede traer solo saldos a favor: ahí no hay deudas que contar.
            ...(e.deudas > 0 ? [`${deudasEnPalabras(e)}.`] : []),
            ...(e.saldosAFavor > 0 ? [`${saldosAFavorEnPalabras(e)}.`] : []),
          ];
  const listo = sePuedeVerificar(e);
  return [
    {
      clave: "padron",
      titulo: "Padrón",
      hecho: e.unidades > 0,
      detalle: [e.unidades > 0 ? cuantos(e.unidades, "unidad", "unidades") : "Todavía no hay unidades cargadas."],
    },
    {
      clave: "conceptos",
      titulo: "Conceptos",
      hecho: e.conceptos > 0,
      detalle: [e.conceptos > 0 ? cuantos(e.conceptos, "concepto", "conceptos") : "Todavía no hay conceptos cargados."],
    },
    { clave: "deuda", titulo: "Deuda anterior", hecho: e.deudaAnterior !== null, detalle: detalleDeDeuda },
    {
      clave: "activar",
      titulo: "Activar",
      hecho: false,
      detalle: [
        listo
          ? "Compará lo cargado con el sistema anterior y activá el barrio."
          : "Se habilita cuando los tres pasos anteriores estén hechos.",
      ],
    },
  ];
}

/** «Activado el 14/11/2026 por Ana Ejemplo». `null` si el barrio no se activó pasando por acá. */
export function lineaDeActivado(e: { readonly activadoEl: string | null; readonly activadoPor: string | null }): string | null {
  if (!e.activadoEl) return null;
  return `Activado el ${formatearFecha(e.activadoEl.slice(0, 10))}${e.activadoPor ? ` por ${e.activadoPor}` : ""}`;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Los «Listo:»
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Al volver de confirmar la planilla. El texto sale del estado leído de la base, no de la URL. */
export function listoDeLaDeudaAnterior(e: ResumenDeDeuda): string {
  const partes = [
    ...(e.deudas > 0 ? [deudasEnPalabras(e)] : []),
    ...(e.saldosAFavor > 0 ? [saldosAFavorEnPalabras(e)] : []),
  ];
  return `Listo: la deuda anterior quedó cargada, con ${partes.join(" y ")}.`;
}

export const LISTO_SIN_DEUDA = "Listo: quedó dicho que el barrio no trae deuda.";
export const LISTO_ACTIVADO = "Listo: el barrio quedó activado.";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La vista previa de la planilla
// ────────────────────────────────────────────────────────────────────────────────────────────────

export const NADA_SE_GUARDA = "Nada se guarda hasta confirmar. Si un renglón tiene error, no entra ninguno.";

/** El chip de cada renglón sin error: una deuda «Entra»; un saldo a favor, «A favor». */
export function chipDeRenglon(tipo: "deuda" | "a_favor"): { readonly tono: "exito" | "info"; readonly texto: string } {
  return tipo === "deuda" ? { tono: "exito", texto: "Entra" } : { tono: "info", texto: "A favor" };
}

/** «Fila 7» o, para lo que es de la planilla entera (el encabezado, el barrio), «La planilla». */
export const dondeEstaElError = (fila: number): string => (fila <= 1 ? "La planilla" : `Fila ${fila}`);

export function tituloDeErrores(n: number): string {
  return n === 1 ? "La planilla tiene 1 error: no entra ningún renglón." : `La planilla tiene ${n} errores: no entra ningún renglón.`;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Verificar antes de activar
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** `0.030000` → «3 % mensual»; `0.000000` → «0 % mensual (sin interés)». */
export function tasaEnPalabras(fraccion: string): string {
  const porcentaje = porcentajeDeTasa(fraccion);
  return `${porcentaje} % mensual${porcentaje === "0" ? " (sin interés)" : ""}`;
}

export type Comparacion =
  | { readonly estado: "vacio" }
  | { readonly estado: "coincide"; readonly texto: string }
  | { readonly estado: "difiere"; readonly texto: string };

/**
 * Lo que dice el sistema contra lo que la administración tipea del sistema anterior. **Solo para
 * mirar**: no se guarda ni viaja. La comparación es en centavos enteros.
 */
export function compararConElSistemaAnterior(delSistema: string, tipeado: string): Comparacion {
  const canonico = normalizarMontoTipeado(tipeado);
  if (canonico === "") return { estado: "vacio" };
  const diferencia = aCentavos(delSistema) - aCentavos(canonico);
  if (diferencia === 0n) return { estado: "coincide", texto: "Coincide" };
  const absoluta = deCentavos(diferencia < 0n ? -diferencia : diferencia);
  return {
    estado: "difiere",
    texto: `Diferencia de ${pesos(absoluta)}: el sistema tiene ${diferencia > 0n ? "más" : "menos"} que el sistema anterior`,
  };
}

/**
 * Los renglones del diálogo de activación (pantalla 3 de la maqueta). Todo llega resuelto por el
 * servicio; acá solo se dice.
 */
export function consecuenciasDeActivar(e: {
  readonly deudaAnterior: "cargada" | "sin_deuda" | null;
  readonly deudas: number;
  readonly unidadesConDeuda: number;
  readonly totalDeuda: string;
  readonly saldosAFavor: number;
  readonly totalAFavor: string;
  readonly primerPeriodo: string | null;
  /** La tasa elegida para la deuda anterior, en fracción. */
  readonly tasa: string;
}): readonly string[] {
  const mes = e.primerPeriodo ? nombreDelPeriodo(e.primerPeriodo).toLowerCase() : null;
  const cargado =
    e.deudaAnterior === "cargada"
      ? e.deudas > 0
        ? `${e.deudas === 1 ? "Queda cargada" : "Quedan cargadas"} ${deudasEnPalabras(e)}${
            e.saldosAFavor > 0 ? ` y ${cuantos(e.saldosAFavor, "saldo a favor", "saldos a favor")}` : ""
          }.`
        : `${e.saldosAFavor === 1 ? "Queda cargado" : "Quedan cargados"} ${saldosAFavorEnPalabras(e)}, sin deudas.`
      : "El barrio no trae deuda anterior.";
  return [
    cargado,
    ...(mes ? [`El primer mes a devengar es ${mes}.`] : []),
    ...(e.deudaAnterior === "cargada" && e.deudas > 0
      ? [`La deuda anterior devenga interés de cada vencimiento a hoy con una tasa del ${tasaEnPalabras(e.tasa)}. Desde mañana, con los parámetros del barrio.`]
      : []),
    `Hasta que emitas ${mes ?? "el primer mes"} podés volver a subir la planilla. Después, la deuda anterior se corrige solo con un ajuste, que queda registrado.`,
    "La activación es una sola vez y no se deshace.",
  ];
}

/** Qué hacer cuando la planilla ya no se puede reemplazar: el ajuste de hoy, con sus pasos. */
export const COMO_SE_CORRIGE_LA_DEUDA_ANTERIOR =
  "La deuda anterior ya no se reemplaza con otra planilla: se corrige con un ajuste, que queda registrado. Hoy se hace desde «Conceptos del mes» → «Aplicar un concepto», en el mes siguiente: un cargo si faltó deuda, un descuento si sobró, con el motivo.";
