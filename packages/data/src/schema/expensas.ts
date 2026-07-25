/**
 * Esquema de EXPENSAS y liquidación mensual. Ver `docs/diseno/01-alcance-modulos.md` §4.2 y
 * `knowledge/cordoba/REQUISITOS-MODELO-DATOS.md` §4.
 *
 * El cálculo vive en `@admin-barrios/shared/liquidacion` (puro y testeado). Acá está el dato y los
 * invariantes que hace cumplir la base:
 *  - una **extraordinaria** exige respaldo de asamblea (art. 2048);
 *  - un período **emitido no se edita** (se corrige en el siguiente);
 *  - no se emite un período **descuadrado** (lo repartido tiene que ser igual al gasto);
 *  - la **mora** sale de una tasa versionada del barrio; si no hay, se liquida capital y se marca.
 */

import { sql } from "drizzle-orm";
import { boolean, check, date, index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { CLASIFICACIONES_FISCALES, ESTADOS_PERIODO, TIPOS_CONCEPTO } from "@admin-barrios/shared/liquidacion";
import { app } from "./tenancy.ts";
import { barrio, documentoBarrio, coeficienteVersion, unidadFuncional, obligado } from "./dominio.ts";

const comoEnum = (valores: readonly string[]) => [...valores] as [string, ...string[]];

export const tipoConcepto = app.enum("tipo_concepto", comoEnum(TIPOS_CONCEPTO));
export const clasificacionFiscal = app.enum("clasificacion_fiscal", comoEnum(CLASIFICACIONES_FISCALES));
export const estadoPeriodo = app.enum("estado_periodo", comoEnum(ESTADOS_PERIODO));

/**
 * Catálogo de conceptos del barrio (seguridad, mantenimiento, fondo de reserva…).
 * La `clasificacion_fiscal` se guarda aunque el módulo contable esté fuera del MVP.
 */
export const concepto = pgTable(
  "concepto",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    nombre: text("nombre").notNull(),
    tipo: tipoConcepto("tipo").notNull(),
    clasificacionFiscal: clasificacionFiscal("clasificacion_fiscal").notNull().default("no_alcanzado"),
    /** Va a cuenta separada y se muestra aparte en la liquidación (art. 2046 inc. d). */
    esFondoReserva: boolean("es_fondo_reserva").notNull().default(false),
    activo: boolean("activo").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_concepto_barrio_nombre").on(t.barrioId, sql`lower(${t.nombre})`),
    index("idx_concepto_barrio").on(t.barrioId),
  ],
);

/** Tasa de mora **versionada** por barrio (sale del reglamento). Si no hay, no se inventa. */
export const tasaMora = pgTable(
  "tasa_mora",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    /** Mensual, como fracción: 0.03 = 3% mensual. */
    tasaMensual: numeric("tasa_mensual", { precision: 12, scale: 6 }).notNull(),
    vigenteDesde: date("vigente_desde", { mode: "string" }).notNull(),
    vigenteHasta: date("vigente_hasta", { mode: "string" }),
    documentoId: uuid("documento_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_tasa_mora_barrio").on(t.barrioId),
    uniqueIndex("uq_tasa_mora_abierta").on(t.barrioId).where(sql`vigente_hasta is null`),
    check("tasa_mora_positiva_chk", sql`${t.tasaMensual} >= 0`),
    check("tasa_mora_rango_chk", sql`${t.vigenteHasta} is null or ${t.vigenteHasta} >= ${t.vigenteDesde}`),
  ],
);

/** Período mensual de expensas de un barrio. */
export const periodoExpensa = pgTable(
  "periodo_expensa",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    /** `YYYY-MM`. */
    periodo: text("periodo").notNull(),
    estado: estadoPeriodo("estado").notNull().default("borrador"),
    /** Versión de coeficientes con la que se liquidó: queda congelada al emitir. */
    coeficienteVersionId: uuid("coeficiente_version_id").references(() => coeficienteVersion.id, {
      onDelete: "restrict",
    }),
    primerVencimiento: date("primer_vencimiento", { mode: "string" }),
    segundoVencimiento: date("segundo_vencimiento", { mode: "string" }),
    /** Suma de los gastos cargados. La escribe el servicio al liquidar; la base valida que cuadre. */
    totalGastos: numeric("total_gastos", { precision: 14, scale: 2 }),
    emitidaAt: timestamp("emitida_at", { withTimezone: true }),
    emitidaPor: uuid("emitida_por"),
    distribuidaAt: timestamp("distribuida_at", { withTimezone: true }),
    notas: text("notas"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_periodo_barrio").on(t.barrioId, t.periodo),
    index("idx_periodo_barrio").on(t.barrioId),
    check("periodo_formato_chk", sql`${t.periodo} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      "periodo_vencimientos_chk",
      sql`${t.segundoVencimiento} is null or ${t.primerVencimiento} is null or ${t.segundoVencimiento} >= ${t.primerVencimiento}`,
    ),
  ],
);

/** Un gasto cargado en el período, que se va a prorratear. */
export const gastoPeriodo = pgTable(
  "gasto_periodo",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    periodoId: uuid("periodo_id")
      .notNull()
      .references(() => periodoExpensa.id, { onDelete: "cascade" }),
    conceptoId: uuid("concepto_id")
      .notNull()
      .references(() => concepto.id, { onDelete: "restrict" }),
    descripcion: text("descripcion").notNull(),
    monto: numeric("monto", { precision: 14, scale: 2 }).notNull(),
    /** Proveedor como texto hasta que exista el módulo de proveedores (MVP, más adelante). */
    proveedorNombre: text("proveedor_nombre"),
    comprobante: text("comprobante"),
    /** Acta que respalda una extraordinaria (art. 2048). Sin esto, no se puede cargar. */
    actaDocumentoId: uuid("acta_documento_id").references(() => documentoBarrio.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_gasto_periodo").on(t.periodoId),
    index("idx_gasto_barrio").on(t.barrioId),
    check("gasto_monto_chk", sql`${t.monto} >= 0`),
  ],
);

/** Liquidación de una unidad para un período. */
export const liquidacion = pgTable(
  "liquidacion",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    periodoId: uuid("periodo_id")
      .notNull()
      .references(() => periodoExpensa.id, { onDelete: "cascade" }),
    unidadFuncionalId: uuid("unidad_funcional_id")
      .notNull()
      .references(() => unidadFuncional.id, { onDelete: "restrict" }),
    /** A quién se le notifica (el obligado marcado como notificado al momento de liquidar). */
    obligadoId: uuid("obligado_id").references(() => obligado.id, { onDelete: "set null" }),
    coeficienteAplicado: numeric("coeficiente_aplicado", { precision: 18, scale: 9 }).notNull(),
    subtotalOrdinarias: numeric("subtotal_ordinarias", { precision: 14, scale: 2 }).notNull(),
    subtotalExtraordinarias: numeric("subtotal_extraordinarias", { precision: 14, scale: 2 }).notNull(),
    subtotalFondoReserva: numeric("subtotal_fondo_reserva", { precision: 14, scale: 2 }).notNull(),
    saldoAnterior: numeric("saldo_anterior", { precision: 14, scale: 2 }).notNull().default("0.00"),
    /** NULL con `mora_pendiente_definicion` = el barrio no tiene tasa cargada: no se inventa. */
    interesMora: numeric("interes_mora", { precision: 14, scale: 2 }),
    moraPendienteDefinicion: boolean("mora_pendiente_definicion").notNull().default(false),
    tasaMoraAplicada: numeric("tasa_mora_aplicada", { precision: 12, scale: 6 }),
    total: numeric("total", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_liquidacion_periodo_uf").on(t.periodoId, t.unidadFuncionalId),
    index("idx_liquidacion_barrio").on(t.barrioId),
    index("idx_liquidacion_uf").on(t.unidadFuncionalId),
    check(
      "liquidacion_mora_chk",
      sql`(${t.moraPendienteDefinicion} and ${t.interesMora} is null) or (not ${t.moraPendienteDefinicion} and ${t.interesMora} is not null)`,
    ),
  ],
);

/** Cada línea de la liquidación, con su origen: de qué gasto sale y con qué coeficiente. */
export const itemLiquidacion = pgTable(
  "item_liquidacion",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    liquidacionId: uuid("liquidacion_id")
      .notNull()
      .references(() => liquidacion.id, { onDelete: "cascade" }),
    gastoId: uuid("gasto_id")
      .notNull()
      // Cascade: la línea de la liquidación no sobrevive al gasto que la originó (solo puede pasar
      // en borrador; después de emitir, el trigger `periodo_editable` no deja borrar nada).
      .references(() => gastoPeriodo.id, { onDelete: "cascade" }),
    conceptoId: uuid("concepto_id")
      .notNull()
      .references(() => concepto.id, { onDelete: "restrict" }),
    descripcion: text("descripcion").notNull(),
    tipo: tipoConcepto("tipo").notNull(),
    esFondoReserva: boolean("es_fondo_reserva").notNull().default(false),
    /** Monto total del gasto repartido: la base que explica la cifra. */
    baseMonto: numeric("base_monto", { precision: 14, scale: 2 }).notNull(),
    coeficienteAplicado: numeric("coeficiente_aplicado", { precision: 18, scale: 9 }).notNull(),
    monto: numeric("monto", { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    index("idx_item_liquidacion").on(t.liquidacionId),
    index("idx_item_barrio").on(t.barrioId),
  ],
);

export type ConceptoRow = typeof concepto.$inferSelect;
export type PeriodoExpensaRow = typeof periodoExpensa.$inferSelect;
export type GastoPeriodoRow = typeof gastoPeriodo.$inferSelect;
export type LiquidacionRow = typeof liquidacion.$inferSelect;
export type ItemLiquidacionRow = typeof itemLiquidacion.$inferSelect;
export type TasaMoraRow = typeof tasaMora.$inferSelect;
