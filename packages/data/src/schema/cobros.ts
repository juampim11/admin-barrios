/**
 * Esquema de COBROS: el pago que entra y su imputación contra las liquidaciones pendientes.
 *
 * Diseño: panel `arquitecto-software` + `security-engineer` + `dba-data` (2026-08-16). Las reglas —
 * RLS, triggers, FKs compuestas anti-cruce — viven en `0033_pagos_reglas.sql` y
 * `0035_pago_imputacion_reglas.sql`. Acá está la forma, nada más (mismo criterio que
 * `schema/documentos.ts`).
 *
 * Tres decisiones que conviene retener leyendo esta declaración:
 *
 *  - **`pago.origen` y `pago_imputacion` NO llevan un `flag_antiduplicado`**: el panel lo sacó del
 *    diseño final — `estado_conciliacion` alcanza como hook para el motor de conciliación futuro, y
 *    un flag más solo hubiera sido una segunda forma de decir lo mismo.
 *  - **`pago_imputacion.liquidacion_id` apunta a `liquidacion`, NO a `item_liquidacion`.** El doc de
 *    producto habla de "débitos (liquidaciones)", y `liquidacion.total` ya trae el agregado que hace
 *    falta para calcular el saldo pendiente — imputar contra una línea suelta obligaría a decidir en
 *    qué orden se cobran los ítems de una misma boleta, una pregunta que el negocio no hizo.
 *  - **`origen`, `estado_conciliacion` y (en `dominio.ts`) `barrio.orden_imputacion` son `text` +
 *    `CHECK`, no enums nativos** — ver el docstring de `@admin-barrios/shared/cobros` para el motivo
 *    completo (el migrador de este repo aplica todas las migraciones pendientes en una transacción,
 *    así que un `ALTER TYPE … ADD VALUE` no sirve el día que el catálogo crezca).
 */

import { sql } from "drizzle-orm";
import { check, date, index, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ORIGENES_PAGO, ESTADOS_CONCILIACION_PAGO } from "@admin-barrios/shared/cobros";
import { barrio, obligado, unidadFuncional } from "./dominio.ts";
import { liquidacion } from "./expensas.ts";

const listaSql = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(","));

/**
 * Un pago registrado contra una unidad. Nace `pendiente` de conciliación y puede anularse (nunca
 * editarse): `app.pago_antes()` (`0033`) congela todo salvo la terna `anulado_at/anulado_por/
 * motivo_anulacion`, mismo patrón que `concepto_boleta_unidad` (`0021`).
 *
 * `unidadFuncionalId` y `obligadoId` llevan acá su FK simple; la FK COMPUESTA `(id, barrio_id)` que
 * hace estructuralmente imposible el cruce entre barrios se agrega a mano en `0033`, junto con el
 * `uq_pago_id_barrio` que la hace posible.
 */
export const pago = pgTable(
  "pago",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    unidadFuncionalId: uuid("unidad_funcional_id")
      .notNull()
      .references(() => unidadFuncional.id, { onDelete: "restrict" }),
    /** A cuyo nombre se registra el cobro. `SET NULL`: la baja de un obligado no borra el pago. */
    obligadoId: uuid("obligado_id").references(() => obligado.id, { onDelete: "set null" }),
    monto: numeric("monto", { precision: 14, scale: 2 }).notNull(),
    fecha: date("fecha", { mode: "string" }).notNull(),
    /** `extracto` | `manual`. Ver el docstring de arriba: `text` + `CHECK`, no enum nativo. */
    origen: text("origen").notNull(),
    /** `pendiente` | `conciliado`. `conciliado` es un hook: nada en esta tanda lo setea. */
    estadoConciliacion: text("estado_conciliacion").notNull().default("pendiente"),
    /** Solo en un pago `manual`: quien lo cargó. La escribe la base desde `app.current_user_id()`. */
    usuarioRegistrador: uuid("usuario_registrador"),
    /** Storage key del comprobante. Obligatorio en `manual`, ausente en `extracto`. */
    comprobanteAdjunto: text("comprobante_adjunto"),
    anuladoAt: timestamp("anulado_at", { withTimezone: true }),
    anuladoPor: uuid("anulado_por"),
    motivoAnulacion: text("motivo_anulacion"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Un objeto de storage acredita como comprobante de UN SOLO pago. Sin esto, dos filas de `pago`
    // podrían compartir `comprobante_adjunto` — el mismo PDF sirviendo de prueba para dos cobros
    // distintos — y nada en el resto del esquema lo impediría.
    uniqueIndex("uq_pago_comprobante_adjunto").on(t.comprobanteAdjunto),
    index("idx_pago_barrio").on(t.barrioId),
    index("idx_pago_unidad").on(t.unidadFuncionalId),
    index("idx_pago_barrio_fecha").on(t.barrioId, t.fecha).where(sql`anulado_at is null`),
    // Guard barato para el barrido de conciliación futuro: hoy ya sirve para que la pantalla de
    // pagos pueda filtrar "pendientes de conciliar" con un index scan, no un seq scan.
    index("idx_pago_pendiente_conciliar")
      .on(t.barrioId, t.fecha)
      .where(sql`estado_conciliacion = 'pendiente' and anulado_at is null`),
    check("pago_monto_positivo_chk", sql`${t.monto} > 0`),
    check("pago_origen_chk", sql`${t.origen} in (${listaSql(ORIGENES_PAGO)})`),
    check("pago_estado_conciliacion_chk", sql`${t.estadoConciliacion} in (${listaSql(ESTADOS_CONCILIACION_PAGO)})`),
    check(
      "pago_manual_exige_registrador_chk",
      sql`(${t.origen} = 'manual' and ${t.usuarioRegistrador} is not null and ${t.comprobanteAdjunto} is not null)
          or (${t.origen} = 'extracto' and ${t.usuarioRegistrador} is null)`,
    ),
    // Mismo patrón pareado que `cbu_anulacion_chk` (0016) / `concepto_boleta_unidad` (0021): las tres
    // columnas de la anulación viajan juntas, o ninguna.
    check(
      "pago_anulacion_chk",
      sql`(${t.anuladoAt} is null and ${t.anuladoPor} is null and ${t.motivoAnulacion} is null)
          or (${t.anuladoAt} is not null and ${t.anuladoPor} is not null and ${t.motivoAnulacion} is not null)`,
    ),
    // `\\.` y no `\.`: ver `documentos.ts` — en un template de TypeScript, `\.` es una secuencia de
    // escape inválida que colapsa a `.`, y un `.` en una regex acepta cualquier carácter.
    check(
      "pago_comprobante_storage_key_chk",
      sql`${t.comprobanteAdjunto} is null or ${t.comprobanteAdjunto} ~
          ('^barrios/' || ${t.barrioId}::text || '/pagos/comprobantes/[A-Za-z0-9_-]{22,64}\\.(pdf|jpg|jpeg|png)$')`,
    ),
  ],
);

/**
 * Una imputación: este pago cubre (parcial o totalmente) esta liquidación, por este importe.
 * **Append-only con anulación propia** (no alcanza con anular el `pago`: una imputación mal cargada
 * tiene que poder corregirse sin anular el cobro entero). `barrioId` es redundante a propósito —
 * mismo criterio que `concepto_boleta_unidad`— para poder filtrar por `readable_tenant_ids()`
 * directo, sin pasar por `pago` ni por `liquidacion`.
 */
export const pagoImputacion = pgTable(
  "pago_imputacion",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    pagoId: uuid("pago_id")
      .notNull()
      .references(() => pago.id, { onDelete: "restrict" }),
    liquidacionId: uuid("liquidacion_id")
      .notNull()
      .references(() => liquidacion.id, { onDelete: "restrict" }),
    montoImputado: numeric("monto_imputado", { precision: 14, scale: 2 }).notNull(),
    anuladoAt: timestamp("anulado_at", { withTimezone: true }),
    anuladoPor: uuid("anulado_por"),
    motivoAnulacion: text("motivo_anulacion"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_pago_imputacion_pago").on(t.pagoId),
    index("idx_pago_imputacion_liquidacion").on(t.liquidacionId),
    index("idx_pago_imputacion_barrio").on(t.barrioId),
    // Ninguna liquidación tiene dos imputaciones VIVAS del mismo pago a la vez: si hace falta
    // corregir el monto, se anula esta fila y se crea otra (append-only real).
    uniqueIndex("uq_pago_imputacion_pago_liquidacion")
      .on(t.pagoId, t.liquidacionId)
      .where(sql`anulado_at is null`),
    check("pago_imputacion_monto_positivo_chk", sql`${t.montoImputado} > 0`),
    check(
      "pago_imputacion_anulacion_chk",
      sql`(${t.anuladoAt} is null and ${t.anuladoPor} is null and ${t.motivoAnulacion} is null)
          or (${t.anuladoAt} is not null and ${t.anuladoPor} is not null and ${t.motivoAnulacion} is not null)`,
    ),
  ],
);

/**
 * Saldo acumulado por unidad, mantenido incrementalmente por trigger (migración `0037`) — NO se
 * recalcula sumando la historia entera en cada lectura. Declarada acá para que el tipo TS quede
 * sincronizado con lo físico (mismo criterio que `periodoExpensa.totalCargos`, agregada a mano en
 * `0016`): la tabla la crea `0037_estado_cuenta.sql`, no `drizzle-kit generate`.
 */
export const saldoUf = pgTable(
  "saldo_uf",
  {
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    unidadFuncionalId: uuid("unidad_funcional_id")
      .notNull()
      .references(() => unidadFuncional.id, { onDelete: "restrict" }),
    saldoActual: numeric("saldo_actual", { precision: 14, scale: 2 }).notNull().default("0"),
    fechaUltimoMovimiento: date("fecha_ultimo_movimiento", { mode: "string" }),
  },
  (t) => [
    primaryKey({ columns: [t.barrioId, t.unidadFuncionalId] }),
    index("idx_saldo_uf_barrio").on(t.barrioId),
  ],
);

export type PagoRow = typeof pago.$inferSelect;
export type PagoImputacionRow = typeof pagoImputacion.$inferSelect;
export type SaldoUfRow = typeof saldoUf.$inferSelect;
