/**
 * Entrada pública de `@admin-barrios/data`.
 *
 * **`client.ts` NO se exporta desde acá, a propósito** (ADR-0002 §3.2, cerrojo 2). Vive detrás de su
 * propia subruta, `@admin-barrios/data/client`, por el mismo mecanismo con el que el adapter de
 * Chromium vive detrás de `@admin-barrios/documentos/chromium`: una pieza peligrosa que se importa
 * escribiéndola, no por arrastre de un `export *`.
 *
 * Quién puede importar esa subruta: los scripts de mantenimiento, el worker y los tests. Desde
 * `apps/web` la importa **un solo archivo** (`src/servidor/db.ts`), y el test de arquitectura falla
 * si aparece en cualquier otro.
 */

export * as schema from "./schema/index.ts";
export * from "./servicios/liquidacion.ts";
export * from "./servicios/vista-boleta.ts";
