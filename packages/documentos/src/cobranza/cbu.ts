/**
 * CBU argentino: los dos dígitos verificadores.
 *
 * Está acá y no dentro del adapter de demo porque cualquier adapter futuro (débito automático,
 * transferencia) lo necesita, y porque el adapter de demo lo usa **al revés**: para afirmar que su
 * CBU es inválido a propósito y **no puede recibir un peso** (doc 09 §E.15.4).
 */

const PESOS_BLOQUE_1 = [7, 1, 3, 9, 7, 1, 3] as const;
const PESOS_BLOQUE_2 = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3] as const;

function digitoVerificador(digitos: string, pesos: readonly number[]): number {
  // Sin esto, un carácter no numérico da `NaN` en silencio y el verificador sale `NaN`: el CBU
  // "pasaría" cualquier comparación por desigualdad y nadie se enteraría.
  if (digitos.length !== pesos.length || !/^\d+$/.test(digitos)) {
    throw new Error(`el bloque del CBU tiene que ser ${pesos.length} dígitos, y llegó "${digitos}"`);
  }
  const suma = pesos.reduce((acum, peso, i) => acum + peso * Number(digitos[i]), 0);
  return (10 - (suma % 10)) % 10;
}

/** Verificador del bloque 1 (banco + sucursal): posición 8 del CBU. */
export function verificadorBloque1(primerosSiete: string): number {
  return digitoVerificador(primerosSiete, PESOS_BLOQUE_1);
}

/** Verificador del bloque 2 (cuenta): posición 22 del CBU. */
export function verificadorBloque2(treceDigitos: string): number {
  return digitoVerificador(treceDigitos, PESOS_BLOQUE_2);
}

/** `true` si el CBU tiene 22 dígitos y **los dos** verificadores son correctos. */
export function cbuValido(cbu: string): boolean {
  if (!/^\d{22}$/.test(cbu)) return false;
  return (
    Number(cbu[7]) === verificadorBloque1(cbu.slice(0, 7)) &&
    Number(cbu[21]) === verificadorBloque2(cbu.slice(8, 21))
  );
}
