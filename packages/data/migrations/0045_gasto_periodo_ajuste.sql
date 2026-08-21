-- =============================================================================================
-- 0045_gasto_periodo_ajuste — `gasto_periodo` aprende a llevar la marca de qué orden de pago la
-- produjo, y a admitir un monto negativo SOLO cuando esa marca está completa: el ajuste que revierte
-- el cargo de una orden de pago anulada después de que su período de origen ya se emitió
-- (`app.orden_pago_transicion()`, `0044`).
--
-- Expand puro: toda fila existente tiene `orden_pago_id`/`gasto_periodo_origen_id` en `NULL` y
-- `monto >= 0` — el `OR` del `CHECK` la sigue aceptando tal cual. Un `monto < 0` de acá en más solo
-- es legal si trae las dos referencias (qué OP lo generó, qué gasto original corrige); nadie puede
-- colar un gasto negativo a mano. `app.validar_emision()` y el motor de liquidación ya hacen
-- `sum(monto)`: un negativo se neta solo, sin tocar esa lógica.
--
-- Las dos FKs se agregan a mano (no las genera `drizzle-kit`): `orden_pago_id` cruzaría con
-- `schema/proveedores.ts`, que a su vez importa `periodoExpensa`/`concepto` de este mismo archivo
-- (`schema/expensas.ts`) — declararla en el schema TS sería un ciclo de imports entre los dos
-- archivos. Mismo criterio que la FK compuesta de `pago` (`0034`): declarada a mano en la migración
-- de reglas, no en la tabla base.
-- =============================================================================================
ALTER TABLE "gasto_periodo" DROP CONSTRAINT "gasto_monto_chk";--> statement-breakpoint
ALTER TABLE "gasto_periodo" ADD COLUMN "orden_pago_id" uuid;--> statement-breakpoint
ALTER TABLE "gasto_periodo" ADD COLUMN "gasto_periodo_origen_id" uuid;--> statement-breakpoint
ALTER TABLE "gasto_periodo"
  ADD CONSTRAINT "gasto_periodo_orden_pago_id_orden_pago_id_fk"
  FOREIGN KEY ("orden_pago_id") REFERENCES "public"."orden_pago"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "gasto_periodo"
  ADD CONSTRAINT "gasto_periodo_gasto_periodo_origen_id_gasto_periodo_id_fk"
  FOREIGN KEY ("gasto_periodo_origen_id") REFERENCES "public"."gasto_periodo"("id") ON DELETE restrict;--> statement-breakpoint
CREATE INDEX "idx_gasto_periodo_orden_pago" ON "gasto_periodo" USING btree ("orden_pago_id") WHERE orden_pago_id is not null;--> statement-breakpoint
ALTER TABLE "gasto_periodo" ADD CONSTRAINT "gasto_monto_chk" CHECK ("gasto_periodo"."monto" >= 0 or ("gasto_periodo"."orden_pago_id" is not null and "gasto_periodo"."gasto_periodo_origen_id" is not null and "gasto_periodo"."monto" < 0));