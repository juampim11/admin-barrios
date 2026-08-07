/**
 * Generación de documentos (ADR-0001).
 *
 * **Esta entrada NO exporta el adapter de Chromium a propósito.** `apps/web` puede importar de acá
 * (plantillas, símbolos, cobranza, el modelo de vista); el adapter vive en
 * `@admin-barrios/documentos/chromium` y lo importa solo el worker. La regla se verifica en CI.
 */

// El modelo de vista vive en `shared` (ADR-0001 §3): es el contrato que consumen la web, el mobile
// y la capa de datos, y el que se congela con cada documento emitido. Se re-exporta acá porque es
// la cara pública de este paquete.
export * from "@admin-barrios/shared/documentos";

export * from "./generador.ts";
export * from "./emision.ts";
export * from "./emision-informes.ts";
export * from "./simbolos.ts";
export * from "./lenguaje-prohibido.ts";
export * from "./plantillas/boleta.ts";
export * from "./plantillas/comun.ts";
export * from "./plantillas/informe-mensual.ts";
export * from "./plantillas/listado-mora.ts";
export * from "./cobranza/index.ts";
