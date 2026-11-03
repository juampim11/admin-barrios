/**
 * Topes de las pruebas de volumen (BL-016), **en un solo lugar**. Corren en su propio paso del gate
 * (`pnpm test:volumen`, proyecto `volumen` de `vitest.config.ts`): un proceso, un archivo por vez, sin
 * otras pruebas en paralelo contra la misma Postgres — así cada tope mide la operación y no la carga
 * de la máquina (ADR-0005 de aclade-cobranzas, que este paso sigue).
 *
 * Cada tope es lo medido en 3 corridas del paso solo, con un margen de 2 a 3 veces
 * (`docs/devops/tiempos-del-gate.md`). **Un tope que se pasa señala la operación**: antes de subirlo
 * se mira el plan de la consulta o el armado del lote.
 */
export const TOPES = {
  /** Generar la liquidación de un barrio de 700 UF (el borrador entero, con sus líneas). Medido: 3,5 / 9,8 / 4,6 s. */
  liquidacionMs: 25_000,
  /** Emitir ese período (validación de la emisión y débito en la cuenta corriente). Medido: 0,14 / 0,66 / 0,15 s. */
  emisionPeriodoMs: 2_000,
  /** Las cuatro lecturas de la pantalla del período de 700 UF (primera página de 500). Medido: 71 / 376 / 316 ms. */
  pantallaPeriodoMs: 1_000,
  /**
   * T3: la vista previa de la planilla del padrón de 700 UF (lectura, plan contra el padrón, códigos
   * previstos). No escribe nada. Medido en local: 122 / 144 / 194 ms.
   */
  padronPreviaMs: 2_000,
  /**
   * T3: confirmar esa importación (700 altas en lote, 770 titulares, contactos, historial y la versión
   * de partes iguales). Medido en local: 10,9 s → 3,6 s al pasar a `security definer` el trigger que
   * numera el código de pago (`0065` §6: evaluaba la RLS dos veces por fila).
   */
  padronConfirmarMs: 15_000,
  /** Las 700 boletas en PDF, en lotes de 50 como el worker. Medido: 140 / 108 / 136 s. */
  boletasMs: 360_000,
  /**
   * Pico de memoria residente del proceso de Node mientras emite las 700 boletas. Medido: 375 / 364 /
   * 374 MB. Queda por debajo del presupuesto de 1 GB del contenedor del worker (ADR-0001 §3.2).
   */
  boletasPicoRssMb: 900,
} as const;
