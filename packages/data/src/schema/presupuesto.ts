/**
 * El presupuesto del mes (`0090`, encargo 16c): lo que el barrio espera gastar, rubro por rubro, y el
 * margen. **No interviene en el cálculo del cupón**: propone el importe del mes (que se sigue grabando
 * por la cuota, `definirCuotaFija`) y después se compara contra lo gastado (`gasto_periodo`). Por eso
 * nada que calcule plata lo referencia.
 *
 * El rubro es el catálogo `concepto`, el mismo con el que se cargan los gastos. Lo carga la
 * administración y solo mientras el mes se prepara (`app.presupuesto_antes`).
 */
import { sql } from "drizzle-orm";
import { check, index, numeric, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { barrio } from "./dominio.ts";

export const presupuestoRubro = pgTable(
  "presupuesto_rubro",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    periodoId: uuid("periodo_id").notNull(),
    conceptoId: uuid("concepto_id").notNull(),
    monto: numeric("monto", { precision: 14, scale: 2 }).notNull(),
    cargadoPor: uuid("cargado_por").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_presupuesto_rubro").on(t.periodoId, t.conceptoId),
    index("idx_presupuesto_rubro_barrio").on(t.barrioId),
    check("presupuesto_rubro_monto_chk", sql`${t.monto} >= 0`),
  ],
);

export const presupuestoMargen = pgTable(
  "presupuesto_margen",
  {
    periodoId: uuid("periodo_id").primaryKey(),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    monto: numeric("monto", { precision: 14, scale: 2 }).notNull(),
    cargadoPor: uuid("cargado_por").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_presupuesto_margen_barrio").on(t.barrioId), check("presupuesto_margen_monto_chk", sql`${t.monto} >= 0`)],
);
