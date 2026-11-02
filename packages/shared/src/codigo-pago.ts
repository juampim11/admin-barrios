/**
 * El código de pago de una unidad funcional (BL-012).
 *
 * Cada UF tiene un **número** estable dentro de su barrio (`unidad_funcional.codigo_pago_numero`,
 * migración `0059`): no cambia aunque cambie el titular, ni aunque cambie el formato. Lo que se imprime
 * es ese número con el **formato del barrio** —largo, prefijo y separador— más un **dígito
 * verificador**. Así el formato se puede alinear después con el identificador de cliente de una red de
 * cobranza (p. ej. SIRO) cambiando la configuración del barrio, **sin migrar datos**: el número no se
 * toca, solo cómo se escribe.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ DAMM Y NO MÓDULO 11
 *
 * El algoritmo de Damm detecta **todo** error en un solo dígito y **toda** transposición de dos
 * dígitos contiguos, y el verificador es siempre un dígito 0-9. Módulo 11 da "10" en uno de cada
 * once números —hay que imprimir una X o saltear el número— y Luhn no detecta la transposición 09↔90.
 * El código es numérico de punta a punta, que es lo que acepta el concepto de una transferencia y un
 * teclado de cajero.
 */

import { z } from "zod";

/** La tabla del cuasigrupo de orden 10 de Damm (totalmente antisimétrica, diagonal en cero). */
const DAMM: readonly (readonly number[])[] = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

function interino(digitos: string): number {
  if (!/^\d+$/.test(digitos)) throw new Error(`solo dígitos: "${digitos}"`);
  let e = 0;
  for (const c of digitos) e = DAMM[e]![c.charCodeAt(0) - 48]!;
  return e;
}

/** El dígito verificador de Damm de una cadena de dígitos. */
export function digitoVerificador(digitos: string): number {
  return interino(digitos);
}

/** `true` si los dígitos —con el verificador al final— son consistentes. */
export function verificadorValido(digitosConVerificador: string): boolean {
  return /^\d{2,}$/.test(digitosConVerificador) && interino(digitosConVerificador) === 0;
}

/** Cómo escribe un barrio su código de pago. Espejo de las columnas `barrio.codigo_pago_*` (`0059`). */
export const formatoCodigoPagoSchema = z.object({
  /** Dígitos del número, sin prefijo ni verificador. Se completa con ceros a la izquierda. */
  largo: z.number().int().min(3).max(12),
  /** Dígitos fijos adelante (p. ej. el número de cliente en la red). Vacío = sin prefijo. */
  prefijo: z.string().regex(/^\d{0,6}$/, "el prefijo son hasta seis dígitos"),
  /** Entre el número y el verificador: `"-"` o nada. */
  separador: z.enum(["-", ""]),
});
export type FormatoCodigoPago = z.infer<typeof formatoCodigoPagoSchema>;

export const FORMATO_CODIGO_PAGO_INICIAL: FormatoCodigoPago = { largo: 6, prefijo: "", separador: "-" };

/**
 * El código impreso de la UF número `numero`: `prefijo + número con ceros + separador + verificador`.
 * El verificador se calcula sobre **prefijo + número**, así un error en cualquier dígito impreso se
 * detecta. Lanza si el número no entra en el largo del barrio: se agranda el largo, no se trunca.
 */
export function codigoDePago(numero: number, formato: FormatoCodigoPago): string {
  const f = formatoCodigoPagoSchema.parse(formato);
  if (!Number.isSafeInteger(numero) || numero < 1) throw new Error(`número de código de pago inválido: ${numero}`);
  const cuerpo = String(numero);
  if (cuerpo.length > f.largo) {
    throw new Error(`el número ${numero} no entra en ${f.largo} dígitos: hay que agrandar el largo del código del barrio`);
  }
  const digitos = `${f.prefijo}${cuerpo.padStart(f.largo, "0")}`;
  return `${digitos}${f.separador}${digitoVerificador(digitos)}`;
}

/**
 * Lee un código tipeado (de un extracto, del concepto de una transferencia) con el formato del
 * barrio: devuelve el número de la UF, o `null` si no tiene la forma o el verificador no da. Acepta
 * el código con o sin separador y con espacios alrededor.
 */
export function leerCodigoDePago(texto: string, formato: FormatoCodigoPago): number | null {
  const f = formatoCodigoPagoSchema.parse(formato);
  const limpio = texto.trim().replace(/[\s-]/g, "");
  if (limpio.length !== f.prefijo.length + f.largo + 1 || !verificadorValido(limpio)) return null;
  if (!limpio.startsWith(f.prefijo)) return null;
  const numero = Number.parseInt(limpio.slice(f.prefijo.length, f.prefijo.length + f.largo), 10);
  return numero >= 1 ? numero : null;
}
