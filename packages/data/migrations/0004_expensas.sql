CREATE TYPE "app"."clasificacion_fiscal" AS ENUM('alcanzado', 'no_alcanzado', 'ingreso_ajeno', 'no_gravado');--> statement-breakpoint
CREATE TYPE "app"."estado_periodo" AS ENUM('borrador', 'revisada', 'emitida', 'distribuida');--> statement-breakpoint
CREATE TYPE "app"."tipo_concepto" AS ENUM('ordinaria', 'extraordinaria');--> statement-breakpoint
CREATE TABLE "concepto" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"nombre" text NOT NULL,
	"tipo" "app"."tipo_concepto" NOT NULL,
	"clasificacion_fiscal" "app"."clasificacion_fiscal" DEFAULT 'no_alcanzado' NOT NULL,
	"es_fondo_reserva" boolean DEFAULT false NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gasto_periodo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"periodo_id" uuid NOT NULL,
	"concepto_id" uuid NOT NULL,
	"descripcion" text NOT NULL,
	"monto" numeric(14, 2) NOT NULL,
	"proveedor_nombre" text,
	"comprobante" text,
	"acta_documento_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gasto_monto_chk" CHECK ("gasto_periodo"."monto" >= 0)
);
--> statement-breakpoint
CREATE TABLE "item_liquidacion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"liquidacion_id" uuid NOT NULL,
	"gasto_id" uuid NOT NULL,
	"concepto_id" uuid NOT NULL,
	"descripcion" text NOT NULL,
	"tipo" "app"."tipo_concepto" NOT NULL,
	"es_fondo_reserva" boolean DEFAULT false NOT NULL,
	"base_monto" numeric(14, 2) NOT NULL,
	"coeficiente_aplicado" numeric(18, 9) NOT NULL,
	"monto" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "liquidacion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"periodo_id" uuid NOT NULL,
	"unidad_funcional_id" uuid NOT NULL,
	"obligado_id" uuid,
	"coeficiente_aplicado" numeric(18, 9) NOT NULL,
	"subtotal_ordinarias" numeric(14, 2) NOT NULL,
	"subtotal_extraordinarias" numeric(14, 2) NOT NULL,
	"subtotal_fondo_reserva" numeric(14, 2) NOT NULL,
	"saldo_anterior" numeric(14, 2) DEFAULT '0.00' NOT NULL,
	"interes_mora" numeric(14, 2),
	"mora_pendiente_definicion" boolean DEFAULT false NOT NULL,
	"tasa_mora_aplicada" numeric(12, 6),
	"total" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "liquidacion_mora_chk" CHECK (("liquidacion"."mora_pendiente_definicion" and "liquidacion"."interes_mora" is null) or (not "liquidacion"."mora_pendiente_definicion" and "liquidacion"."interes_mora" is not null))
);
--> statement-breakpoint
CREATE TABLE "periodo_expensa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"periodo" text NOT NULL,
	"estado" "app"."estado_periodo" DEFAULT 'borrador' NOT NULL,
	"coeficiente_version_id" uuid,
	"primer_vencimiento" date,
	"segundo_vencimiento" date,
	"total_gastos" numeric(14, 2),
	"emitida_at" timestamp with time zone,
	"emitida_por" uuid,
	"distribuida_at" timestamp with time zone,
	"notas" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "periodo_formato_chk" CHECK ("periodo_expensa"."periodo" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "periodo_vencimientos_chk" CHECK ("periodo_expensa"."segundo_vencimiento" is null or "periodo_expensa"."primer_vencimiento" is null or "periodo_expensa"."segundo_vencimiento" >= "periodo_expensa"."primer_vencimiento")
);
--> statement-breakpoint
CREATE TABLE "tasa_mora" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"tasa_mensual" numeric(12, 6) NOT NULL,
	"vigente_desde" date NOT NULL,
	"vigente_hasta" date,
	"documento_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasa_mora_positiva_chk" CHECK ("tasa_mora"."tasa_mensual" >= 0),
	CONSTRAINT "tasa_mora_rango_chk" CHECK ("tasa_mora"."vigente_hasta" is null or "tasa_mora"."vigente_hasta" >= "tasa_mora"."vigente_desde")
);
--> statement-breakpoint
ALTER TABLE "concepto" ADD CONSTRAINT "concepto_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gasto_periodo" ADD CONSTRAINT "gasto_periodo_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gasto_periodo" ADD CONSTRAINT "gasto_periodo_periodo_id_periodo_expensa_id_fk" FOREIGN KEY ("periodo_id") REFERENCES "public"."periodo_expensa"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gasto_periodo" ADD CONSTRAINT "gasto_periodo_concepto_id_concepto_id_fk" FOREIGN KEY ("concepto_id") REFERENCES "public"."concepto"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gasto_periodo" ADD CONSTRAINT "gasto_periodo_acta_documento_id_documento_barrio_id_fk" FOREIGN KEY ("acta_documento_id") REFERENCES "public"."documento_barrio"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ADD CONSTRAINT "item_liquidacion_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ADD CONSTRAINT "item_liquidacion_liquidacion_id_liquidacion_id_fk" FOREIGN KEY ("liquidacion_id") REFERENCES "public"."liquidacion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ADD CONSTRAINT "item_liquidacion_gasto_id_gasto_periodo_id_fk" FOREIGN KEY ("gasto_id") REFERENCES "public"."gasto_periodo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ADD CONSTRAINT "item_liquidacion_concepto_id_concepto_id_fk" FOREIGN KEY ("concepto_id") REFERENCES "public"."concepto"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liquidacion" ADD CONSTRAINT "liquidacion_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liquidacion" ADD CONSTRAINT "liquidacion_periodo_id_periodo_expensa_id_fk" FOREIGN KEY ("periodo_id") REFERENCES "public"."periodo_expensa"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liquidacion" ADD CONSTRAINT "liquidacion_unidad_funcional_id_unidad_funcional_id_fk" FOREIGN KEY ("unidad_funcional_id") REFERENCES "public"."unidad_funcional"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liquidacion" ADD CONSTRAINT "liquidacion_obligado_id_obligado_id_fk" FOREIGN KEY ("obligado_id") REFERENCES "public"."obligado"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periodo_expensa" ADD CONSTRAINT "periodo_expensa_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periodo_expensa" ADD CONSTRAINT "periodo_expensa_coeficiente_version_id_coeficiente_version_id_fk" FOREIGN KEY ("coeficiente_version_id") REFERENCES "public"."coeficiente_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasa_mora" ADD CONSTRAINT "tasa_mora_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_concepto_barrio_nombre" ON "concepto" USING btree ("barrio_id",lower("nombre"));--> statement-breakpoint
CREATE INDEX "idx_concepto_barrio" ON "concepto" USING btree ("barrio_id");--> statement-breakpoint
CREATE INDEX "idx_gasto_periodo" ON "gasto_periodo" USING btree ("periodo_id");--> statement-breakpoint
CREATE INDEX "idx_gasto_barrio" ON "gasto_periodo" USING btree ("barrio_id");--> statement-breakpoint
CREATE INDEX "idx_item_liquidacion" ON "item_liquidacion" USING btree ("liquidacion_id");--> statement-breakpoint
CREATE INDEX "idx_item_barrio" ON "item_liquidacion" USING btree ("barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_liquidacion_periodo_uf" ON "liquidacion" USING btree ("periodo_id","unidad_funcional_id");--> statement-breakpoint
CREATE INDEX "idx_liquidacion_barrio" ON "liquidacion" USING btree ("barrio_id");--> statement-breakpoint
CREATE INDEX "idx_liquidacion_uf" ON "liquidacion" USING btree ("unidad_funcional_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_periodo_barrio" ON "periodo_expensa" USING btree ("barrio_id","periodo");--> statement-breakpoint
CREATE INDEX "idx_periodo_barrio" ON "periodo_expensa" USING btree ("barrio_id");--> statement-breakpoint
CREATE INDEX "idx_tasa_mora_barrio" ON "tasa_mora" USING btree ("barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tasa_mora_abierta" ON "tasa_mora" USING btree ("barrio_id") WHERE vigente_hasta is null;