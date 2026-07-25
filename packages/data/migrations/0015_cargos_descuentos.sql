CREATE TYPE "app"."clase_item" AS ENUM('prorrateo', 'cuota_fija', 'cargo', 'descuento');--> statement-breakpoint
CREATE TYPE "app"."base_calculo_concepto" AS ENUM('expensa_ordinaria', 'sin_base');--> statement-breakpoint
CREATE TYPE "app"."clase_concepto_boleta" AS ENUM('cargo', 'descuento');--> statement-breakpoint
CREATE TYPE "app"."financiamiento_descuento" AS ENUM('partida_presupuestada', 'absorbe_barrio', 'fondo_reserva');--> statement-breakpoint
CREATE TYPE "app"."metodo_concepto_boleta" AS ENUM('monto_fijo', 'porcentaje', 'precio_x_cantidad');--> statement-breakpoint
CREATE TABLE "concepto_boleta" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"nombre" text NOT NULL,
	"clase" "app"."clase_concepto_boleta" NOT NULL,
	"metodo" "app"."metodo_concepto_boleta" NOT NULL,
	"base_calculo" "app"."base_calculo_concepto" DEFAULT 'sin_base' NOT NULL,
	"clasificacion_fiscal" "app"."clasificacion_fiscal" NOT NULL,
	"financiamiento" "app"."financiamiento_descuento",
	"requiere_admin" boolean DEFAULT false NOT NULL,
	"orden_impresion" integer DEFAULT 0 NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concepto_boleta_base_chk" CHECK (("concepto_boleta"."metodo" = 'porcentaje') = ("concepto_boleta"."base_calculo" <> 'sin_base')),
	CONSTRAINT "concepto_boleta_metodo_chk" CHECK ("concepto_boleta"."clase" = 'cargo' or "concepto_boleta"."metodo" <> 'precio_x_cantidad'),
	CONSTRAINT "concepto_boleta_financiamiento_chk" CHECK (("concepto_boleta"."clase" = 'descuento') = ("concepto_boleta"."financiamiento" is not null))
);
--> statement-breakpoint
CREATE TABLE "concepto_boleta_unidad" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"periodo_id" uuid NOT NULL,
	"unidad_funcional_id" uuid NOT NULL,
	"concepto_boleta_id" uuid NOT NULL,
	"valor_id" uuid NOT NULL,
	"clase" "app"."clase_concepto_boleta" NOT NULL,
	"metodo" "app"."metodo_concepto_boleta" NOT NULL,
	"nombre_concepto" text NOT NULL,
	"base_calculo" "app"."base_calculo_concepto" NOT NULL,
	"clasificacion_fiscal" "app"."clasificacion_fiscal" NOT NULL,
	"monto_fijo" numeric(14, 2),
	"porcentaje" numeric(9, 6),
	"precio_unitario" numeric(14, 2),
	"cantidad" numeric(12, 3),
	"tope" numeric(14, 2),
	"base_calculada" numeric(14, 2),
	"importe_resuelto" numeric(14, 2),
	"importe_sin_tope" numeric(14, 2),
	"fecha_hecho" date NOT NULL,
	"detalle" text NOT NULL,
	"aplicado_por" uuid NOT NULL,
	"aplicado_at" timestamp with time zone DEFAULT now() NOT NULL,
	"origen_evaluacion" text,
	"anulado_at" timestamp with time zone,
	"anulado_por" uuid,
	"motivo_anulacion" text,
	CONSTRAINT "cbu_importe_chk" CHECK ("concepto_boleta_unidad"."importe_resuelto" is null or "concepto_boleta_unidad"."importe_resuelto" >= 0),
	CONSTRAINT "cbu_resolucion_chk" CHECK (("concepto_boleta_unidad"."base_calculada" is null) or ("concepto_boleta_unidad"."importe_resuelto" is not null)),
	CONSTRAINT "cbu_cantidad_chk" CHECK ("concepto_boleta_unidad"."cantidad" is null or ("concepto_boleta_unidad"."cantidad" > 0 and "concepto_boleta_unidad"."cantidad" <= 100)),
	CONSTRAINT "cbu_anulacion_chk" CHECK (("concepto_boleta_unidad"."anulado_at" is null and "concepto_boleta_unidad"."anulado_por" is null and "concepto_boleta_unidad"."motivo_anulacion" is null)
          or ("concepto_boleta_unidad"."anulado_at" is not null and "concepto_boleta_unidad"."anulado_por" is not null and "concepto_boleta_unidad"."motivo_anulacion" is not null))
);
--> statement-breakpoint
CREATE TABLE "concepto_boleta_unidad_evento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"aplicacion_id" uuid NOT NULL,
	"evento" text NOT NULL,
	"actor" uuid NOT NULL,
	"ocurrido_at" timestamp with time zone DEFAULT now() NOT NULL,
	"importe_resuelto" numeric(14, 2),
	"base_calculada" numeric(14, 2),
	"motivo" text,
	CONSTRAINT "cbu_evento_tipo_chk" CHECK ("concepto_boleta_unidad_evento"."evento" in ('alta', 'resolucion', 'anulacion'))
);
--> statement-breakpoint
CREATE TABLE "concepto_boleta_valor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"concepto_boleta_id" uuid NOT NULL,
	"metodo" "app"."metodo_concepto_boleta" NOT NULL,
	"monto_fijo" numeric(14, 2),
	"porcentaje" numeric(9, 6),
	"precio_unitario" numeric(14, 2),
	"tope" numeric(14, 2),
	"vigente_desde" date NOT NULL,
	"vigente_hasta" date,
	"documento_id" uuid,
	"aprobada_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concepto_boleta_valor_rango_chk" CHECK ("concepto_boleta_valor"."vigente_hasta" is null or "concepto_boleta_valor"."vigente_hasta" >= "concepto_boleta_valor"."vigente_desde"),
	CONSTRAINT "concepto_boleta_valor_porcentaje_chk" CHECK ("concepto_boleta_valor"."metodo" <> 'porcentaje' or ("concepto_boleta_valor"."porcentaje" >= 0.01 and "concepto_boleta_valor"."porcentaje" <= 100)),
	CONSTRAINT "concepto_boleta_valor_tope_chk" CHECK ("concepto_boleta_valor"."tope" is null or "concepto_boleta_valor"."tope" > 0),
	CONSTRAINT "concepto_boleta_valor_monto_chk" CHECK ("concepto_boleta_valor"."monto_fijo" is null or "concepto_boleta_valor"."monto_fijo" >= 0),
	CONSTRAINT "concepto_boleta_valor_precio_chk" CHECK ("concepto_boleta_valor"."precio_unitario" is null or "concepto_boleta_valor"."precio_unitario" >= 0),
	CONSTRAINT "concepto_boleta_valor_parametro_chk" CHECK (case "concepto_boleta_valor"."metodo"
            when 'monto_fijo'        then "concepto_boleta_valor"."monto_fijo" is not null and "concepto_boleta_valor"."porcentaje" is null and "concepto_boleta_valor"."precio_unitario" is null
            when 'porcentaje'        then "concepto_boleta_valor"."porcentaje" is not null and "concepto_boleta_valor"."monto_fijo" is null and "concepto_boleta_valor"."precio_unitario" is null
            when 'precio_x_cantidad' then "concepto_boleta_valor"."precio_unitario" is not null and "concepto_boleta_valor"."monto_fijo" is null and "concepto_boleta_valor"."porcentaje" is null
          end)
);
--> statement-breakpoint
CREATE TABLE "limite_aplicacion_barrio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"monto_max_operador" numeric(14, 2) NOT NULL,
	"porcentaje_max_operador" numeric(9, 6) NOT NULL,
	"vigente_desde" date NOT NULL,
	"vigente_hasta" date,
	"aprobado_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "limite_monto_chk" CHECK ("limite_aplicacion_barrio"."monto_max_operador" >= 0),
	CONSTRAINT "limite_porcentaje_chk" CHECK ("limite_aplicacion_barrio"."porcentaje_max_operador" >= 0 and "limite_aplicacion_barrio"."porcentaje_max_operador" <= 100)
);
--> statement-breakpoint
DROP INDEX "idx_item_liquidacion";--> statement-breakpoint
ALTER TABLE "item_liquidacion" ALTER COLUMN "tipo" DROP NOT NULL;--> statement-breakpoint
-- Backfill sin un solo UPDATE: `ADD COLUMN` es DDL y NO dispara triggers de fila, así que el
-- período ya emitido del seed (que `app.periodo_editable` protege) no se entera. Se agrega como
-- columna generada, se le quita la expresión y queda como una columna normal, ya poblada.
-- Un UPDATE de backfill habría fallado contra el período emitido, y `session_replication_role`
-- no es una salida: es un GUC de superusuario que funciona en local y falla en un Postgres
-- administrado (RDS/Neon/Supabase).
ALTER TABLE "item_liquidacion" ADD COLUMN "clase_item" "app"."clase_item"
  GENERATED ALWAYS AS (CASE WHEN "es_cuota_fija" THEN 'cuota_fija'::"app"."clase_item"
                            ELSE 'prorrateo'::"app"."clase_item" END) STORED;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ALTER COLUMN "clase_item" DROP EXPRESSION;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ALTER COLUMN "clase_item" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ALTER COLUMN "clase_item" SET DEFAULT 'prorrateo';--> statement-breakpoint
ALTER TABLE "item_liquidacion" ADD COLUMN "aplicacion_id" uuid;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ADD COLUMN "aplicacion_periodo_id" uuid;--> statement-breakpoint
ALTER TABLE "item_liquidacion" ADD COLUMN "aplicacion_unidad_id" uuid;--> statement-breakpoint
ALTER TABLE "liquidacion" ADD COLUMN "subtotal_cargos" numeric(14, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "liquidacion" ADD COLUMN "subtotal_descuentos" numeric(14, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "concepto_boleta" ADD CONSTRAINT "concepto_boleta_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepto_boleta_unidad" ADD CONSTRAINT "concepto_boleta_unidad_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepto_boleta_unidad" ADD CONSTRAINT "concepto_boleta_unidad_periodo_id_periodo_expensa_id_fk" FOREIGN KEY ("periodo_id") REFERENCES "public"."periodo_expensa"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepto_boleta_unidad" ADD CONSTRAINT "concepto_boleta_unidad_unidad_funcional_id_unidad_funcional_id_fk" FOREIGN KEY ("unidad_funcional_id") REFERENCES "public"."unidad_funcional"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepto_boleta_unidad" ADD CONSTRAINT "concepto_boleta_unidad_concepto_boleta_id_concepto_boleta_id_fk" FOREIGN KEY ("concepto_boleta_id") REFERENCES "public"."concepto_boleta"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepto_boleta_unidad" ADD CONSTRAINT "concepto_boleta_unidad_valor_id_concepto_boleta_valor_id_fk" FOREIGN KEY ("valor_id") REFERENCES "public"."concepto_boleta_valor"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepto_boleta_unidad_evento" ADD CONSTRAINT "concepto_boleta_unidad_evento_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepto_boleta_unidad_evento" ADD CONSTRAINT "concepto_boleta_unidad_evento_aplicacion_id_concepto_boleta_unidad_id_fk" FOREIGN KEY ("aplicacion_id") REFERENCES "public"."concepto_boleta_unidad"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepto_boleta_valor" ADD CONSTRAINT "concepto_boleta_valor_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepto_boleta_valor" ADD CONSTRAINT "concepto_boleta_valor_concepto_boleta_id_concepto_boleta_id_fk" FOREIGN KEY ("concepto_boleta_id") REFERENCES "public"."concepto_boleta"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limite_aplicacion_barrio" ADD CONSTRAINT "limite_aplicacion_barrio_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_concepto_boleta_barrio" ON "concepto_boleta" USING btree ("barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_concepto_boleta_barrio_nombre" ON "concepto_boleta" USING btree ("barrio_id",lower("nombre"));--> statement-breakpoint
CREATE INDEX "idx_cbu_barrio" ON "concepto_boleta_unidad" USING btree ("barrio_id");--> statement-breakpoint
CREATE INDEX "idx_cbu_periodo_uf" ON "concepto_boleta_unidad" USING btree ("periodo_id","unidad_funcional_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cbu_id_periodo_uf" ON "concepto_boleta_unidad" USING btree ("id","periodo_id","unidad_funcional_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cbu_id_barrio" ON "concepto_boleta_unidad" USING btree ("id","barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cbu_descuento_unico" ON "concepto_boleta_unidad" USING btree ("periodo_id","unidad_funcional_id","concepto_boleta_id") WHERE clase = 'descuento' and anulado_at is null;--> statement-breakpoint
CREATE INDEX "idx_cbu_evento_aplicacion" ON "concepto_boleta_unidad_evento" USING btree ("aplicacion_id");--> statement-breakpoint
CREATE INDEX "idx_cbu_evento_barrio" ON "concepto_boleta_unidad_evento" USING btree ("barrio_id");--> statement-breakpoint
CREATE INDEX "idx_concepto_boleta_valor_barrio" ON "concepto_boleta_valor" USING btree ("barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_concepto_boleta_valor_abierta" ON "concepto_boleta_valor" USING btree ("concepto_boleta_id") WHERE vigente_hasta is null;--> statement-breakpoint
CREATE INDEX "idx_concepto_boleta_valor_vigencia" ON "concepto_boleta_valor" USING btree ("concepto_boleta_id",vigente_desde desc);--> statement-breakpoint
CREATE INDEX "idx_limite_aplicacion_barrio" ON "limite_aplicacion_barrio" USING btree ("barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_limite_aplicacion_abierto" ON "limite_aplicacion_barrio" USING btree ("barrio_id") WHERE vigente_hasta is null;--> statement-breakpoint
CREATE INDEX "idx_item_liquidacion_clase" ON "item_liquidacion" USING btree ("liquidacion_id","clase_item");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_item_aplicacion" ON "item_liquidacion" USING btree ("aplicacion_id") WHERE aplicacion_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_liquidacion_id_periodo_uf" ON "liquidacion" USING btree ("id","periodo_id","unidad_funcional_id");