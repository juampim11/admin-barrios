CREATE TYPE "app"."modelo_expensa" AS ENUM('variable', 'fija');--> statement-breakpoint
CREATE TABLE "cuota_fija" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"unidad_funcional_id" uuid NOT NULL,
	"importe" numeric(14, 2) NOT NULL,
	CONSTRAINT "cuota_fija_importe_chk" CHECK ("cuota_fija"."importe" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cuota_fija_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"descripcion" text,
	"vigente_desde" date NOT NULL,
	"vigente_hasta" date,
	"documento_id" uuid,
	"aprobada_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cuota_fija_version_rango_chk" CHECK ("cuota_fija_version"."vigente_hasta" is null or "cuota_fija_version"."vigente_hasta" >= "cuota_fija_version"."vigente_desde")
);
--> statement-breakpoint
ALTER TABLE "item_liquidacion" ALTER COLUMN "gasto_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ALTER COLUMN "concepto_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ALTER COLUMN "coeficiente_aplicado" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gasto_periodo" ADD COLUMN "sin_respaldo_asamblea" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gasto_periodo" ADD COLUMN "motivo_sin_respaldo" text;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ADD COLUMN "es_cuota_fija" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "liquidacion" ADD COLUMN "subtotal_cuota_fija" numeric(14, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "periodo_expensa" ADD COLUMN "modelo" "app"."modelo_expensa" DEFAULT 'variable' NOT NULL;--> statement-breakpoint
ALTER TABLE "periodo_expensa" ADD COLUMN "cuota_fija_version_id" uuid;--> statement-breakpoint
ALTER TABLE "cuota_fija" ADD CONSTRAINT "cuota_fija_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cuota_fija" ADD CONSTRAINT "cuota_fija_version_id_cuota_fija_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."cuota_fija_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cuota_fija" ADD CONSTRAINT "cuota_fija_unidad_funcional_id_unidad_funcional_id_fk" FOREIGN KEY ("unidad_funcional_id") REFERENCES "public"."unidad_funcional"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cuota_fija_version" ADD CONSTRAINT "cuota_fija_version_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cuota_fija_version_uf" ON "cuota_fija" USING btree ("version_id","unidad_funcional_id");--> statement-breakpoint
CREATE INDEX "idx_cuota_fija_barrio" ON "cuota_fija" USING btree ("barrio_id");--> statement-breakpoint
CREATE INDEX "idx_cuota_fija_version_barrio" ON "cuota_fija_version" USING btree ("barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cuota_fija_version_abierta" ON "cuota_fija_version" USING btree ("barrio_id") WHERE vigente_hasta is null;--> statement-breakpoint
ALTER TABLE "periodo_expensa" ADD CONSTRAINT "periodo_expensa_cuota_fija_version_id_cuota_fija_version_id_fk" FOREIGN KEY ("cuota_fija_version_id") REFERENCES "public"."cuota_fija_version"("id") ON DELETE restrict ON UPDATE no action;