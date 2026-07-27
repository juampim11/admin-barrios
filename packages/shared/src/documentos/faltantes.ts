/**
 * Datos que el documento **pide y el sistema todavía no tiene**.
 *
 * La regla dura del proyecto es que toda cifra de dinero se explica con su origen (CLAUDE.md §1.4).
 * Su corolario, que es el que resuelve este archivo: **cuando el origen no existe, no se inventa el
 * número**. Un cero, un guion o un renglón ausente son tres formas de mentir con distinto disimulo —
 * el cero afirma que no hay nada, el guion no dice quién tendría que cargarlo, y el renglón ausente
 * hace que nadie note el hueco.
 *
 * Un `DatoFaltante` es lo contrario: ocupa el lugar del dato, **dice qué falta y quién lo carga**, y
 * viaja congelado con el documento. El día que el dato exista se sabe exactamente qué documentos se
 * emitieron sin él.
 *
 * `VistaBoleta.faltantes` (ADR-0001 §4.1) resuelve el mismo problema **a nivel documento** y no se
 * imprime. Esto es el nivel de abajo: el hueco **en el renglón**, y sí se imprime.
 */

import { z } from "zod";
import { cifraSchema } from "./primitivas.ts";
import { fechaImpresaSchema } from "./primitivas.ts";

/**
 * El lugar de un dato que no está.
 *
 * `motivo` se imprime tal cual en el renglón, así que se redacta en criollo y **en positivo**: dice
 * qué hace falta cargar, no que el sistema falló. Pasa por el filtro de lenguaje prohibido
 * (doc 07 §E) como cualquier otro texto impreso.
 */
export const datoFaltanteSchema = z
  .object({
    faltante: z.literal(true),
    motivo: z.string().min(1),
    /** Quién carga el dato, si se sabe: "la administración", "el estudio jurídico". */
    aCargoDe: z.string().min(1).nullable(),
  })
  .readonly();
export type DatoFaltante = z.infer<typeof datoFaltanteSchema>;

/** Única forma correcta de armar un `DatoFaltante`. */
export function faltante(motivo: string, aCargoDe: string | null = null): DatoFaltante {
  return { faltante: true, motivo, aCargoDe };
}

/** `true` si el valor es el hueco y no el dato. Estrecha el tipo. */
export function esFaltante(valor: unknown): valor is DatoFaltante {
  return typeof valor === "object" && valor !== null && (valor as { faltante?: unknown }).faltante === true;
}

/**
 * Envuelve cualquier schema para que acepte además el hueco.
 *
 * Se usa **en el tipo y no en la plantilla**: que un campo sea `Cifra | DatoFaltante` obliga a quien
 * lo imprime a resolver los dos casos, y hace imposible que un hueco se cuele como `0,00`.
 */
export function oFaltante<T extends z.ZodTypeAny>(schema: T) {
  return z.union([schema, datoFaltanteSchema]);
}

export const cifraOFaltanteSchema = oFaltante(cifraSchema);
export type CifraOFaltante = z.infer<typeof cifraOFaltanteSchema>;

export const fechaOFaltanteSchema = oFaltante(fechaImpresaSchema);
export type FechaOFaltante = z.infer<typeof fechaOFaltanteSchema>;

export const textoOFaltanteSchema = oFaltante(z.string().min(1));
export type TextoOFaltante = z.infer<typeof textoOFaltanteSchema>;

export const enteroOFaltanteSchema = oFaltante(z.number().int().nonnegative());
export type EnteroOFaltante = z.infer<typeof enteroOFaltanteSchema>;

/**
 * El monto de una cifra, o `null` si es un hueco.
 *
 * Es el único puente permitido hacia la aritmética: **un hueco no participa de ninguna suma**. Los
 * invariantes que verifican que el dinero cierra usan esto y, cuando devuelve `null`, se **abstienen**
 * en vez de tratar el hueco como cero — que es exactamente el error que este módulo existe para
 * hacer imposible.
 */
export function montoSiHay(valor: CifraOFaltante): string | null {
  return esFaltante(valor) ? null : valor.monto;
}

/**
 * Los motivos de todos los huecos de una estructura, para el resumen al pie del documento.
 *
 * Recorre en profundidad y **deduplica**: un mismo motivo repetido en cuarenta filas ("el sistema no
 * guarda la fecha de derivación") es un solo hueco, no cuarenta.
 */
export function motivosFaltantes(valor: unknown): string[] {
  const vistos = new Set<string>();
  const recorrer = (x: unknown): void => {
    if (esFaltante(x)) {
      vistos.add(x.aCargoDe === null ? x.motivo : `${x.motivo} — lo carga ${x.aCargoDe}`);
      return;
    }
    if (Array.isArray(x)) {
      for (const item of x) recorrer(item);
      return;
    }
    if (typeof x === "object" && x !== null) {
      for (const item of Object.values(x)) recorrer(item);
    }
  };
  recorrer(valor);
  return [...vistos];
}
