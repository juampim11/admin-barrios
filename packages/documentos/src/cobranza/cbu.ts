/**
 * CBU argentino: los dos dígitos verificadores.
 *
 * Está acá y no dentro del adapter de demo porque cualquier adapter futuro (débito automático,
 * transferencia) lo necesita, y porque el adapter de demo lo usa **al revés**: para afirmar que su
 * CBU es inválido a propósito y **no puede recibir un peso** (doc 09 §E.15.4).
 */

// La aritmética vive en `@admin-barrios/shared/cuentas` (T3): la usan también el alta del barrio y el
// padrón para validar la cuenta que se carga. Una sola copia en todo el repo.
export { cbuValido, verificadorBloque1, verificadorBloque2 } from "@admin-barrios/shared/cuentas";
