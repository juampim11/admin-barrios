/**
 * Esquema de PROVEEDORES / ÓRDENES DE PAGO: el circuito de aprobación de un pago a un tercero, y su
 * efecto contable sobre `gasto_periodo`.
 *
 * Diseño: boceto propio + panel `arquitecto-software` + `dba-data` + `security-engineer` +
 * `administrador-consorcios` + `legal-ph` (2026-08-21). Las reglas — RLS, el trigger de transición
 * (congelamiento, gates de rol, cuatro-ojos, generación/reversión de `gasto_periodo`), FKs compuestas
 * anti-cruce — viven en `0045_ordenes_pago_reglas.sql`. Acá está la forma, nada más (mismo criterio
 * que `schema/cobros.ts`).
 *
 * Tres decisiones que conviene retener leyendo esta declaración:
 *
 *  - **`gasto_periodo_id` NO vive acá.** La FK va del lado de `gasto_periodo`
 *    (`orden_pago_id`/`gasto_periodo_origen_id`, `schema/expensas.ts`) — mismo patrón que
 *    `pago`→`pago_imputacion`: el productor nunca apunta a lo que produjo. Una orden de pago puede
 *    producir DOS filas de `gasto_periodo` en su vida (el cargo original en `aprobada`, y un ajuste
 *    si se anula después de que el período de origen ya se emitió) — una columna 1:1 del lado de
 *    `orden_pago` no podía representar eso. Hallazgo de `arquitecto-software`/`dba-data` en panel.
 *  - **`monto > 0`, no `>= 0`** — a diferencia de `gasto_periodo.monto`: una orden de pago es un
 *    documento de un solo hecho económico (como `pago`), no una línea informativa que admita $0.
 *  - **`estado` es `text` + `CHECK`, no enum nativo** — mismo motivo que `pago.origen`/`trabajo.tipo`:
 *    el migrador de este repo aplica todas las migraciones pendientes de una corrida en una sola
 *    transacción, y `ALTER TYPE … ADD VALUE` no sirve el día que el catálogo de estados crezca.
 *
 * **`rechazada` vs `anulada` — decisión de `administrador-consorcios` (2026-08-20), no una
 * preferencia de vocabulario.** `rechazada` sale de `pendiente` y nunca tuvo efecto contable.
 * `anulada` sale de `aprobada`/`pagada` y SIEMPRE tiene algo que revertir (ya generó su
 * `gasto_periodo`) — por eso lleva `motivo_anulacion` obligatorio y `rechazada` no. Tampoco hay
 * `aprobada → pendiente`: la corrección post-aprobación es anular (con motivo) y cargar una orden
 * nueva, nunca reescribir el monto en el lugar — un monto que cambia sin dejar rastro del valor
 * anterior no es trazable (CLAUDE.md §1.4).
 */

import { sql } from "drizzle-orm";
import { boolean, check, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ESTADOS_ORDEN_PAGO, MEDIOS_PAGO_OP } from "@admin-barrios/shared/proveedores";
import { barrio } from "./dominio.ts";
import { concepto, periodoExpensa } from "./expensas.ts";

const listaSql = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(","));

/** El catálogo de proveedores del barrio. Un CUIT/CBU/alias es dato del proveedor, no de cada pago. */
export const proveedor = pgTable(
  "proveedor",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    razonSocial: text("razon_social").notNull(),
    cuit: text("cuit"),
    /** Dato, sin cálculo — mismo principio que `concepto.clasificacionFiscal`: nadie lo asume. */
    condicionFiscal: text("condicion_fiscal"),
    contacto: text("contacto"),
    /** Un solo CBU/alias por proveedor (doc 01 §4.6) — no una lista de medios como `medio_pago_barrio`,
     *  que además va en la dirección contraria (cobro del barrio, no pago a un tercero). */
    cbu: text("cbu"),
    alias: text("alias"),
    activo: boolean("activo").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_proveedor_barrio_razon_social").on(t.barrioId, sql`lower(${t.razonSocial})`),
    // Para las FKs compuestas anti-cruce de `orden_pago` (`0045`).
    uniqueIndex("uq_proveedor_id_barrio").on(t.id, t.barrioId),
    index("idx_proveedor_barrio").on(t.barrioId),
    // Mismo `check` de formato que `medio_pago_cbu_chk` (`schema/dominio.ts`) — el patrón se reusa,
    // la tabla no: `medio_pago_barrio` es el medio de COBRO del barrio, dirección contraria.
    check("proveedor_cbu_chk", sql`${t.cbu} is null or ${t.cbu} ~ '^[0-9]{22}$'`),
  ],
);

export type ProveedorRow = typeof proveedor.$inferSelect;

/**
 * El circuito de aprobación de un pago a un proveedor. Nace `pendiente`; `app.orden_pago_transicion()`
 * (`0045`) valida las seis transiciones de la lista blanca y congela toda columna de negocio en
 * cuanto sale de `pendiente`.
 */
export const ordenPago = pgTable(
  "orden_pago",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    proveedorId: uuid("proveedor_id")
      .notNull()
      .references(() => proveedor.id, { onDelete: "restrict" }),
    /**
     * El período de GASTO al que se imputa. `restrict`, no `cascade` como `gasto_periodo.periodoId`:
     * una orden de pago es un documento primario (tiene `numeroFactura`, existe con independencia del
     * período), no un cómputo derivado que se regenera con el período — mismo criterio que ya usa
     * `concepto`/`unidadFuncional` frente a `liquidacion`/`itemLiquidacion` (panel, 2026-08-21).
     */
    periodoId: uuid("periodo_id")
      .notNull()
      .references(() => periodoExpensa.id, { onDelete: "restrict" }),
    conceptoId: uuid("concepto_id")
      .notNull()
      .references(() => concepto.id, { onDelete: "restrict" }),
    numeroFactura: text("numero_factura"),
    descripcion: text("descripcion").notNull(),
    monto: numeric("monto", { precision: 14, scale: 2 }).notNull(),
    /** Cómo se ejecutó ESTE pago — no confundir con `proveedor.cbu`, que es solo dato de contacto. */
    medioPago: text("medio_pago"),
    comprobanteAdjunto: text("comprobante_adjunto"),
    estado: text("estado").notNull().default("pendiente"),
    /** Quién cargó la orden. La escribe la base desde `app.current_user_id()`, nunca el cliente —
     *  es además la columna que sostiene el control de "cuatro ojos" al aprobar. */
    creadaPor: uuid("creada_por").notNull(),
    creadaAt: timestamp("creada_at", { withTimezone: true }).notNull().defaultNow(),
    aprobadaAt: timestamp("aprobada_at", { withTimezone: true }),
    aprobadaPor: uuid("aprobada_por"),
    rechazadaAt: timestamp("rechazada_at", { withTimezone: true }),
    rechazadaPor: uuid("rechazada_por"),
    pagadaAt: timestamp("pagada_at", { withTimezone: true }),
    pagadaPor: uuid("pagada_por"),
    anuladaAt: timestamp("anulada_at", { withTimezone: true }),
    anuladaPor: uuid("anulada_por"),
    motivoAnulacion: text("motivo_anulacion"),
    /** Sin transición propia con lógica en `0045` más allá del cambio de estado — se agrega por
     *  simetría con el resto de las firmas (`aprobada`/`rechazada`/`pagada`/`anulada`), no porque el
     *  panel lo haya pedido explícitamente. */
    conciliadaAt: timestamp("conciliada_at", { withTimezone: true }),
    conciliadaPor: uuid("conciliada_por"),
  },
  (t) => [
    // Para las FKs compuestas anti-cruce de `subida_comprobante_solicitada` (`0047`).
    uniqueIndex("uq_orden_pago_id_barrio").on(t.id, t.barrioId),
    index("idx_orden_pago_barrio").on(t.barrioId),
    index("idx_orden_pago_proveedor").on(t.proveedorId),
    index("idx_orden_pago_periodo").on(t.periodoId),
    // Índice parcial para la cola de aprobación — selectividad mala sobre `estado` entero (6 valores),
    // buena sobre el subconjunto `pendiente` (`dba-data`, panel).
    index("idx_orden_pago_pendientes").on(t.barrioId, t.creadaAt).where(sql`estado = 'pendiente'`),
    check("orden_pago_monto_chk", sql`${t.monto} > 0`),
    check("orden_pago_estado_chk", sql`${t.estado} in (${listaSql(ESTADOS_ORDEN_PAGO)})`),
    check(
      "orden_pago_medio_pago_chk",
      sql`${t.medioPago} is null or ${t.medioPago} in (${listaSql(MEDIOS_PAGO_OP)})`,
    ),
    // `\\.` y no `\.`: en un template de TypeScript, `\.` es una secuencia de escape inválida que
    // colapsa a `.`, y un `.` en una regex acepta cualquier carácter (mismo motivo que `cobros.ts`).
    check(
      "orden_pago_comprobante_storage_key_chk",
      sql`${t.comprobanteAdjunto} is null or ${t.comprobanteAdjunto} ~
          ('^barrios/' || ${t.barrioId}::text || '/ordenes-pago/' || ${t.id}::text ||
           '/[A-Za-z0-9_-]{22,64}\\.(pdf|jpg|jpeg|png)$')`,
    ),
    // Todo-o-nada por transición — mismo patrón pareado que `pago_anulacion_chk` (`schema/cobros.ts`).
    check(
      "orden_pago_aprobacion_chk",
      sql`(${t.aprobadaAt} is null and ${t.aprobadaPor} is null)
          or (${t.aprobadaAt} is not null and ${t.aprobadaPor} is not null)`,
    ),
    check(
      "orden_pago_rechazo_chk",
      sql`(${t.rechazadaAt} is null and ${t.rechazadaPor} is null)
          or (${t.rechazadaAt} is not null and ${t.rechazadaPor} is not null)`,
    ),
    check(
      "orden_pago_pago_chk",
      sql`(${t.pagadaAt} is null and ${t.pagadaPor} is null)
          or (${t.pagadaAt} is not null and ${t.pagadaPor} is not null)`,
    ),
    check(
      "orden_pago_anulacion_chk",
      sql`(${t.anuladaAt} is null and ${t.anuladaPor} is null and ${t.motivoAnulacion} is null)
          or (${t.anuladaAt} is not null and ${t.anuladaPor} is not null and ${t.motivoAnulacion} is not null)`,
    ),
    check(
      "orden_pago_conciliacion_chk",
      sql`(${t.conciliadaAt} is null and ${t.conciliadaPor} is null)
          or (${t.conciliadaAt} is not null and ${t.conciliadaPor} is not null)`,
    ),
  ],
);

export type OrdenPagoRow = typeof ordenPago.$inferSelect;
