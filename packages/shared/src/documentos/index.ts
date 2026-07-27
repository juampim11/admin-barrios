/**
 * Modelos de vista de los documentos que emite el sistema (ADR-0001 §4.1).
 *
 * **Puro**: sin HTML, sin PDF, sin Chromium, sin base de datos. Vive en `shared` (y no en
 * `packages/documentos`) porque es el contrato que consumen la web, el mobile y la capa de datos —
 * y el que se congela con cada documento emitido. Cambiar el motor no lo toca.
 */

export * from "./primitivas.ts";
export * from "./acento-impreso.ts";
export * from "./bloque-pago.ts";
export * from "./vista-boleta.ts";
