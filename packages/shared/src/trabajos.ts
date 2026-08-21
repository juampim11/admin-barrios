/**
 * Constantes del ciclo de vida de un `trabajo` (la cola de emisión: `emitir_documentos_periodo`,
 * `emitir_recibo_pago`). Viven acá, no en `apps/worker`, por el mismo motivo que
 * `TAMANO_MAXIMO_COMPROBANTE_BYTES` vive en `cobros.ts`: un límite que dos lados necesitan conocer
 * — el worker, que lo hace cumplir, y una futura pantalla que quiera explicar "se agotaron los
 * reintentos" sin adivinar el número.
 */

/**
 * Cuántas veces se puede reintentar un `trabajo` antes de dejar de tomarlo.
 *
 * Sin este techo, un trabajo cuyo render falla siempre (un dato corrupto, un recurso que nunca
 * carga) se puede reencolar a mano indefinidamente — y cada intento de `emitir_recibo_pago` quema
 * un número de la secuencia legal del barrio (`recibo_secuencia`, ver la migración `0042`), aunque
 * nunca complete un recibo. No evita el hueco puntual de un intento que falla; evita que un mismo
 * pago problemático se coma la numeración del barrio entero.
 *
 * 5 es generoso para un fallo transitorio (una red caída, un timeout de storage) y bajo para un
 * fallo persistente (un dato que nunca va a renderizar): con 5 intentos fallidos seguidos, seguir
 * reintentando sin cambiar nada no es un reintento, es un bucle.
 */
export const MAX_INTENTOS_TRABAJO = 5;
