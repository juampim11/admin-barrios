-- =============================================================================================
-- 0038_recibos — las tablas del recibo de pago, generadas desde `schema/documentos.ts`.
--
-- Mismo problema documentado en `0026` y `0032`: `0036_orden_imputacion_barrio.sql` y
-- `0037_estado_cuenta.sql` se escribieron a mano (agregaron `barrio.orden_imputacion` y crearon
-- `saldo_uf`) y su snapshot nunca se actualizó, así que `drizzle-kit generate` volvía a proponerlos
-- como si faltaran. Se sacan de acá por la misma razón: ya están aplicados, y agregarlos de nuevo
-- rompería cualquier base real. La conversión de `trabajo.tipo` (enum → `text`) tampoco va acá A
-- PROPÓSITO, aunque el generador la haya detectado: necesita `USING tipo::text` y el `DROP TYPE`
-- después de migrar los datos, no antes — eso se escribe a mano en `0039_recibos_reglas.sql`.
--
-- Las reglas — el trigger que asigna `numero_recibo` bajo lock de `recibo_secuencia`, la RLS, y la
-- conversión de `trabajo.tipo` y de `descarga_documento` — van en `0039_recibos_reglas.sql`.
-- =============================================================================================
CREATE TABLE "recibo_emitido" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"pago_id" uuid NOT NULL,
	"numero_recibo" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" char(64) NOT NULL,
	"bytes" integer NOT NULL,
	"vista" jsonb NOT NULL,
	"vista_version" text NOT NULL,
	"motor" text NOT NULL,
	"plantilla_hash" char(64) NOT NULL,
	"emitido_at" timestamp with time zone DEFAULT now() NOT NULL,
	"emitido_por" uuid NOT NULL,
	CONSTRAINT "recibo_storage_key_chk" CHECK ("recibo_emitido"."storage_key" ~ ('^barrios/' || "recibo_emitido"."barrio_id"::text || '/pagos/' || "recibo_emitido"."pago_id"::text ||
          '/recibos/[A-Za-z0-9_-]{22,64}\.pdf$'))
);
--> statement-breakpoint
CREATE TABLE "recibo_secuencia" (
	"barrio_id" uuid PRIMARY KEY NOT NULL,
	"ultimo_numero" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recibo_emitido" ADD CONSTRAINT "recibo_emitido_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recibo_emitido" ADD CONSTRAINT "recibo_emitido_pago_id_pago_id_fk" FOREIGN KEY ("pago_id") REFERENCES "public"."pago"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recibo_secuencia" ADD CONSTRAINT "recibo_secuencia_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_recibo_barrio_numero" ON "recibo_emitido" USING btree ("barrio_id","numero_recibo");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_recibo_storage_key" ON "recibo_emitido" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "idx_recibo_pago" ON "recibo_emitido" USING btree ("pago_id");--> statement-breakpoint
CREATE INDEX "idx_recibo_barrio" ON "recibo_emitido" USING btree ("barrio_id");
