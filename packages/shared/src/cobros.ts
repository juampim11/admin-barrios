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

/**
 * Los tipos de archivo que acepta el comprobante adjunto de un pago manual. Espejo de
 * `SUFIJO_PATRON_CLAVE_COMPROBANTE` (`packages/almacenamiento`): un comprobante puede ser el PDF de
 * una transferencia o la foto de un depósito. **`eq` exacto en el POST presignado de S3/MinIO**, no
 * `starts-with`: sin eso, alguien podría declarar `image/jpeg` y subir cualquier cosa con ese
 * encabezado.
 */
export const CONTENT_TYPES_COMPROBANTE = ["application/pdf", "image/jpeg", "image/png"] as const;
export type ContentTypeComprobante = (typeof CONTENT_TYPES_COMPROBANTE)[number];
export const contentTypeComprobanteSchema = z.enum(CONTENT_TYPES_COMPROBANTE);

/**
 * Tamaño máximo de un comprobante subido a mano: 10 MB. **Lo hace cumplir el `content-length-range`
 * del POST presignado de S3/MinIO** (`prepararSubidaDeComprobante` en
 * `packages/data/src/servicios/documentos.ts`), no el navegador — un límite de solo cliente es un
 * dato, no un candado, y cualquiera puede editar el HTML antes de enviar.
 *
 * Vive acá y no en `packages/almacenamiento` porque el **cliente también lo necesita**, para el
 * mismo motivo que ya usa `ORIGENES_PAGO`/`ESTADOS_CONCILIACION_PAGO`: mostrar el rechazo en el
 * formulario antes de intentar una subida que el servidor va a rebotar igual, en vez de esperar el
 * viaje de ida y vuelta contra S3.
 */
export const TAMANO_MAXIMO_COMPROBANTE_BYTES = 10 * 1024 * 1024;
