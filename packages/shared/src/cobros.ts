/**
 * Catálogos del módulo de Cobros — espejo TypeScript de los `CHECK` de las migraciones `0032` a
 * `0040`. Mismo criterio que `tenancy.ts` con `ROLES_MEMBERSHIP`/`TIPOS_TENANT`: una sola lista, que
 * alimenta el `pgEnum`-equivalente (acá `text` + `check`, no un enum nativo) y los esquemas Zod.
 *
 * **Por qué `text` + `CHECK` y no un enum nativo de Postgres**, en los tres catálogos de este
 * archivo (`origen_pago`, `estado_conciliacion_pago`, `orden_imputacion_barrio`): un enum nativo que
 * necesite un valor nuevo mañana (un cuarto criterio de imputación, un tercer origen de pago cuando
 * exista el ingreso automático de extractos) obligaría a `ALTER TYPE … ADD VALUE`, y el migrador de
 * este repo (`drizzle-orm/pg-core/dialect.js`) aplica **todas** las migraciones pendientes de una
 * corrida en una sola transacción — un `ADD VALUE` no puede usarse en la misma transacción en la que
 * se creó el tipo, así que separar en dos archivos tampoco alcanza (ver `0039_recibos_reglas.sql`,
 * que documenta el mismo problema para `trabajo.tipo`). `text` + `CHECK` se amplía con un
 * `ALTER TABLE … DROP CONSTRAINT / ADD CONSTRAINT` común y corriente, en la misma transacción que
 * todo lo demás.
 */

import { z } from "zod";

/** De dónde salió el registro del pago. */
export const ORIGENES_PAGO = ["extracto", "manual"] as const;
export type OrigenPago = (typeof ORIGENES_PAGO)[number];
export const origenPagoSchema = z.enum(ORIGENES_PAGO);

/**
 * Si el pago ya se cruzó contra el resumen bancario. **`conciliado` es un valor alcanzable pero
 * nada en esta tanda lo setea**: es el enganche para el motor de conciliación automática, que queda
 * fuera de alcance (ver `HANDOFF.md`). Todo pago nace `pendiente`.
 */
export const ESTADOS_CONCILIACION_PAGO = ["pendiente", "conciliado"] as const;
export type EstadoConciliacionPago = (typeof ESTADOS_CONCILIACION_PAGO)[number];
export const estadoConciliacionPagoSchema = z.enum(ESTADOS_CONCILIACION_PAGO);

/**
 * Cómo un barrio imputa un pago contra sus liquidaciones pendientes, cuando no se hace línea por
 * línea. **`NULL` es un valor legítimo de la columna del barrio** (migración `0036`): un barrio sin
 * este criterio configurado sigue pudiendo cobrar y registrar pagos, y solo se le niega la
 * imputación *automática* — la manual (`imputarPago`) no depende de esto.
 */
export const ORDENES_IMPUTACION_BARRIO = [
  "intereses_primero_capital_antiguo",
  "capital_primero",
  "fifo_estricto",
] as const;
export type OrdenImputacionBarrio = (typeof ORDENES_IMPUTACION_BARRIO)[number];
export const ordenImputacionBarrioSchema = z.enum(ORDENES_IMPUTACION_BARRIO);
