-- =============================================================================================
-- 0046_subida_comprobante_op — generaliza `subida_comprobante_solicitada` para que también sirva
-- de auditoría del comprobante de una orden de pago, en vez de nacer una tabla gemela.
--
-- Mismo precedente que `0039` generalizó `descarga_documento` con una tercera referencia: conserva
-- la integridad referencial real de cada caso (`unique/CHECK "exactamente una"`) sin duplicar la
-- tabla de auditoría entera. Hallazgo de `arquitecto-software`, panel de Proveedores/OP, 2026-08-21.
--
-- `unidad_funcional_id` deja de ser `NOT NULL` — toda fila existente ya trae esa columna con valor
-- (la única referencia que existía hasta acá), así que el `CHECK` de "exactamente una" la sigue
-- aceptando sin tocar ni una fila. `orden_pago_id` nace nullable y sin filas que lo usen todavía.
-- =============================================================================================
ALTER TABLE "subida_comprobante_solicitada" DROP CONSTRAINT "subida_comprobante_storage_key_chk";--> statement-breakpoint
ALTER TABLE "subida_comprobante_solicitada" ALTER COLUMN "unidad_funcional_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subida_comprobante_solicitada" ADD COLUMN "orden_pago_id" uuid;--> statement-breakpoint
ALTER TABLE "subida_comprobante_solicitada" ADD CONSTRAINT "subida_comprobante_solicitada_orden_pago_id_orden_pago_id_fk" FOREIGN KEY ("orden_pago_id") REFERENCES "public"."orden_pago"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- FK compuesta anti-cruce, simétrica a `fk_subida_comprobante_uf_barrio` (`0041`): un `barrio_id`
-- que no sea el de la orden de pago ni siquiera llega a insertarse.
ALTER TABLE "subida_comprobante_solicitada"
  ADD CONSTRAINT "fk_subida_comprobante_op_barrio" FOREIGN KEY ("orden_pago_id", "barrio_id")
  REFERENCES "public"."orden_pago"("id", "barrio_id");--> statement-breakpoint
CREATE INDEX "idx_subida_comprobante_orden_pago" ON "subida_comprobante_solicitada" USING btree ("orden_pago_id");--> statement-breakpoint
ALTER TABLE "subida_comprobante_solicitada" ADD CONSTRAINT "subida_comprobante_referencia_unica_chk" CHECK (("subida_comprobante_solicitada"."unidad_funcional_id" is not null)::int + ("subida_comprobante_solicitada"."orden_pago_id" is not null)::int = 1);--> statement-breakpoint
ALTER TABLE "subida_comprobante_solicitada" ADD CONSTRAINT "subida_comprobante_storage_key_chk" CHECK (("subida_comprobante_solicitada"."unidad_funcional_id" is not null and "subida_comprobante_solicitada"."storage_key" ~
            ('^barrios/' || "subida_comprobante_solicitada"."barrio_id"::text || '/pagos/comprobantes/[A-Za-z0-9_-]{22,64}\.(pdf|jpg|jpeg|png)$'))
          or
          ("subida_comprobante_solicitada"."orden_pago_id" is not null and "subida_comprobante_solicitada"."storage_key" ~
            ('^barrios/' || "subida_comprobante_solicitada"."barrio_id"::text || '/ordenes-pago/' || "subida_comprobante_solicitada"."orden_pago_id"::text ||
             '/[A-Za-z0-9_-]{22,64}\.(pdf|jpg|jpeg|png)$')));