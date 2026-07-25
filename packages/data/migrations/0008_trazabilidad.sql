CREATE TABLE "medio_pago_barrio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"detalle" text NOT NULL,
	"titular" text,
	"entidad" text,
	"instrucciones" text,
	"orden" integer DEFAULT 0 NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medio_pago_tipo_chk" CHECK ("medio_pago_barrio"."tipo" in ('cbu','alias','cuenta','efectivo','otro')),
	CONSTRAINT "medio_pago_cbu_chk" CHECK ("medio_pago_barrio"."tipo" <> 'cbu' or "medio_pago_barrio"."detalle" ~ '^[0-9]{22}$')
);
--> statement-breakpoint
ALTER TABLE "item_liquidacion" ADD COLUMN "clasificacion_fiscal" "app"."clasificacion_fiscal";--> statement-breakpoint
ALTER TABLE "item_liquidacion" ADD COLUMN "sin_respaldo_asamblea" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ADD COLUMN "acta_titulo" text;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ADD COLUMN "monto_teorico" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "item_liquidacion" ADD COLUMN "ajuste_redondeo" numeric(14, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "liquidacion" ADD COLUMN "numero_comprobante" text;--> statement-breakpoint
ALTER TABLE "liquidacion" ADD COLUMN "saldo_anterior_origen" text DEFAULT 'sin_movimientos' NOT NULL;--> statement-breakpoint
ALTER TABLE "liquidacion" ADD COLUMN "dias_atraso" integer;--> statement-breakpoint
ALTER TABLE "liquidacion" ADD COLUMN "fecha_corte_mora" date;--> statement-breakpoint
ALTER TABLE "periodo_expensa" ADD COLUMN "denominacion_concepto" text;--> statement-breakpoint
ALTER TABLE "medio_pago_barrio" ADD CONSTRAINT "medio_pago_barrio_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_medio_pago_barrio" ON "medio_pago_barrio" USING btree ("barrio_id");