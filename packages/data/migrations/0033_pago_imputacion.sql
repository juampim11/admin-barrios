CREATE TABLE "pago_imputacion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"pago_id" uuid NOT NULL,
	"liquidacion_id" uuid NOT NULL,
	"monto_imputado" numeric(14, 2) NOT NULL,
	"anulado_at" timestamp with time zone,
	"anulado_por" uuid,
	"motivo_anulacion" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pago_imputacion_monto_positivo_chk" CHECK ("pago_imputacion"."monto_imputado" > 0),
	CONSTRAINT "pago_imputacion_anulacion_chk" CHECK (("pago_imputacion"."anulado_at" is null and "pago_imputacion"."anulado_por" is null and "pago_imputacion"."motivo_anulacion" is null)
          or ("pago_imputacion"."anulado_at" is not null and "pago_imputacion"."anulado_por" is not null and "pago_imputacion"."motivo_anulacion" is not null))
);
--> statement-breakpoint
ALTER TABLE "pago_imputacion" ADD CONSTRAINT "pago_imputacion_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pago_imputacion" ADD CONSTRAINT "pago_imputacion_pago_id_pago_id_fk" FOREIGN KEY ("pago_id") REFERENCES "public"."pago"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pago_imputacion" ADD CONSTRAINT "pago_imputacion_liquidacion_id_liquidacion_id_fk" FOREIGN KEY ("liquidacion_id") REFERENCES "public"."liquidacion"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pago_imputacion_pago" ON "pago_imputacion" USING btree ("pago_id");--> statement-breakpoint
CREATE INDEX "idx_pago_imputacion_liquidacion" ON "pago_imputacion" USING btree ("liquidacion_id");--> statement-breakpoint
CREATE INDEX "idx_pago_imputacion_barrio" ON "pago_imputacion" USING btree ("barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pago_imputacion_pago_liquidacion" ON "pago_imputacion" USING btree ("pago_id","liquidacion_id") WHERE anulado_at is null;