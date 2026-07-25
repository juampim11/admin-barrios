CREATE TYPE "app"."adecuacion_2075" AS ENUM('si', 'no', 'en_tramite', 'no_aplica');--> statement-breakpoint
CREATE TYPE "app"."base_coeficiente" AS ENUM('parte_indivisa', 'superficie', 'lote', 'mixto');--> statement-breakpoint
CREATE TYPE "app"."eje_barrio" AS ENUM('figura_juridica', 'adecuado_art_2075', 'encuadre_urbanistico', 'municipio', 'servicios_internos_a_cargo_de');--> statement-breakpoint
CREATE TYPE "app"."encuadre_urbanistico" AS ENUM('ure', 'loteo_abierto', 'cierre_calles', 'sin_encuadre');--> statement-breakpoint
CREATE TYPE "app"."estado_unidad" AS ENUM('baldio', 'en_construccion', 'construido');--> statement-breakpoint
CREATE TYPE "app"."figura_juridica" AS ENUM('sa', 'asociacion_civil', 'ph_especial', 'fideicomiso', 'geodesia');--> statement-breakpoint
CREATE TYPE "app"."servicios_internos" AS ENUM('municipio', 'urbanizacion', 'mixto');--> statement-breakpoint
CREATE TYPE "app"."tipo_documento_barrio" AS ENUM('reglamento', 'estatuto', 'instrumento_municipal', 'acta_asamblea', 'acta_designacion_administrador', 'constancia_adecuacion', 'pacto_ejecutividad', 'otro');--> statement-breakpoint
CREATE TYPE "app"."tipo_obligado" AS ENUM('propietario', 'poseedor', 'usufructuario', 'tenedor');--> statement-breakpoint
CREATE TYPE "app"."titularidad_espacios_comunes" AS ENUM('ente', 'propietarios', 'mixto');--> statement-breakpoint
CREATE TABLE "barrio" (
	"barrio_id" uuid PRIMARY KEY NOT NULL,
	"jurisdiccion" text DEFAULT 'cordoba' NOT NULL,
	"figura_juridica" "app"."figura_juridica" NOT NULL,
	"adecuado_art_2075" "app"."adecuacion_2075" NOT NULL,
	"encuadre_urbanistico" "app"."encuadre_urbanistico" NOT NULL,
	"municipio" text NOT NULL,
	"servicios_internos_a_cargo_de" "app"."servicios_internos" NOT NULL,
	"titularidad_espacios_comunes" "app"."titularidad_espacios_comunes",
	"denominacion_concepto" text,
	"reglamento_inscripto" boolean,
	"pacto_ejecutividad" boolean,
	"tiene_espacios_comunes_exclusivos" boolean,
	"tiene_consejo" boolean DEFAULT false NOT NULL,
	"tiene_fondo_reserva" boolean DEFAULT false NOT NULL,
	"cuit" text,
	"domicilio_sede" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "barrio_cuit_chk" CHECK ("barrio"."cuit" is null or "barrio"."cuit" ~ '^[0-9]{11}$'),
	CONSTRAINT "barrio_municipio_chk" CHECK ("barrio"."municipio" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "barrio_atributo_vigencia" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"eje" "app"."eje_barrio" NOT NULL,
	"valor" text NOT NULL,
	"vigente_desde" date NOT NULL,
	"vigente_hasta" date,
	"documento_id" uuid,
	"registrado_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vigencia_rango_chk" CHECK ("barrio_atributo_vigencia"."vigente_hasta" is null or "barrio_atributo_vigencia"."vigente_hasta" >= "barrio_atributo_vigencia"."vigente_desde")
);
--> statement-breakpoint
CREATE TABLE "coeficiente" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"unidad_funcional_id" uuid NOT NULL,
	"valor" numeric(18, 9) NOT NULL,
	CONSTRAINT "coeficiente_positivo_chk" CHECK ("coeficiente"."valor" > 0)
);
--> statement-breakpoint
CREATE TABLE "coeficiente_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"base" "app"."base_coeficiente" NOT NULL,
	"descripcion" text,
	"vigente_desde" date NOT NULL,
	"vigente_hasta" date,
	"documento_id" uuid,
	"cerrada" boolean DEFAULT false NOT NULL,
	"cerrada_at" timestamp with time zone,
	"cerrada_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coef_version_rango_chk" CHECK ("coeficiente_version"."vigente_hasta" is null or "coeficiente_version"."vigente_hasta" >= "coeficiente_version"."vigente_desde")
);
--> statement-breakpoint
CREATE TABLE "documento_barrio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"tipo" "app"."tipo_documento_barrio" NOT NULL,
	"titulo" text NOT NULL,
	"storage_key" text,
	"fecha_documento" date,
	"inscripto" boolean,
	"notas" text,
	"subido_por" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandato_administracion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"administrador_id" uuid NOT NULL,
	"desde" date NOT NULL,
	"hasta" date,
	"acta_documento_id" uuid,
	"notas" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mandato_rango_chk" CHECK ("mandato_administracion"."hasta" is null or "mandato_administracion"."hasta" >= "mandato_administracion"."desde")
);
--> statement-breakpoint
CREATE TABLE "obligado" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"nombre" text NOT NULL,
	"es_persona_juridica" boolean DEFAULT false NOT NULL,
	"tipo_documento" text,
	"numero_documento" text,
	"cuit_cuil" text,
	"email" text,
	"telefono" text,
	"domicilio_notificaciones" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "obligado_cuit_chk" CHECK ("obligado"."cuit_cuil" is null or "obligado"."cuit_cuil" ~ '^[0-9]{11}$')
);
--> statement-breakpoint
CREATE TABLE "unidad_contacto" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"unidad_funcional_id" uuid NOT NULL,
	"email" text NOT NULL,
	"nombre" text,
	"principal" boolean DEFAULT false NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacto_email_chk" CHECK ("unidad_contacto"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);
--> statement-breakpoint
CREATE TABLE "unidad_funcional" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"manzana" text NOT NULL,
	"lote" text NOT NULL,
	"nomenclatura_catastral" text,
	"estado_unidad" "app"."estado_unidad" NOT NULL,
	"superficie_m2" numeric(12, 2),
	"baja_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unidad_obligado" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"unidad_funcional_id" uuid NOT NULL,
	"obligado_id" uuid NOT NULL,
	"tipo" "app"."tipo_obligado" NOT NULL,
	"desde" date NOT NULL,
	"hasta" date,
	"es_notificado" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unidad_obligado_rango_chk" CHECK ("unidad_obligado"."hasta" is null or "unidad_obligado"."hasta" >= "unidad_obligado"."desde")
);
--> statement-breakpoint
ALTER TABLE "barrio" ADD CONSTRAINT "barrio_barrio_id_tenant_node_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."tenant_node"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barrio_atributo_vigencia" ADD CONSTRAINT "barrio_atributo_vigencia_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coeficiente" ADD CONSTRAINT "coeficiente_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coeficiente" ADD CONSTRAINT "coeficiente_version_id_coeficiente_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."coeficiente_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coeficiente" ADD CONSTRAINT "coeficiente_unidad_funcional_id_unidad_funcional_id_fk" FOREIGN KEY ("unidad_funcional_id") REFERENCES "public"."unidad_funcional"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coeficiente_version" ADD CONSTRAINT "coeficiente_version_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento_barrio" ADD CONSTRAINT "documento_barrio_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandato_administracion" ADD CONSTRAINT "mandato_administracion_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandato_administracion" ADD CONSTRAINT "mandato_administracion_administrador_id_tenant_node_id_fk" FOREIGN KEY ("administrador_id") REFERENCES "public"."tenant_node"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandato_administracion" ADD CONSTRAINT "mandato_administracion_acta_documento_id_documento_barrio_id_fk" FOREIGN KEY ("acta_documento_id") REFERENCES "public"."documento_barrio"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligado" ADD CONSTRAINT "obligado_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unidad_contacto" ADD CONSTRAINT "unidad_contacto_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unidad_contacto" ADD CONSTRAINT "unidad_contacto_unidad_funcional_id_unidad_funcional_id_fk" FOREIGN KEY ("unidad_funcional_id") REFERENCES "public"."unidad_funcional"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unidad_funcional" ADD CONSTRAINT "unidad_funcional_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unidad_obligado" ADD CONSTRAINT "unidad_obligado_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unidad_obligado" ADD CONSTRAINT "unidad_obligado_unidad_funcional_id_unidad_funcional_id_fk" FOREIGN KEY ("unidad_funcional_id") REFERENCES "public"."unidad_funcional"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unidad_obligado" ADD CONSTRAINT "unidad_obligado_obligado_id_obligado_id_fk" FOREIGN KEY ("obligado_id") REFERENCES "public"."obligado"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_barrio_municipio" ON "barrio" USING btree ("municipio");--> statement-breakpoint
CREATE INDEX "idx_vigencia_barrio_eje" ON "barrio_atributo_vigencia" USING btree ("barrio_id","eje");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_vigencia_abierta" ON "barrio_atributo_vigencia" USING btree ("barrio_id","eje") WHERE vigente_hasta is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_coeficiente_version_uf" ON "coeficiente" USING btree ("version_id","unidad_funcional_id");--> statement-breakpoint
CREATE INDEX "idx_coeficiente_barrio" ON "coeficiente" USING btree ("barrio_id");--> statement-breakpoint
CREATE INDEX "idx_coef_version_barrio" ON "coeficiente_version" USING btree ("barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_coef_version_vigente" ON "coeficiente_version" USING btree ("barrio_id") WHERE cerrada and vigente_hasta is null;--> statement-breakpoint
CREATE INDEX "idx_documento_barrio" ON "documento_barrio" USING btree ("barrio_id","tipo");--> statement-breakpoint
CREATE INDEX "idx_mandato_barrio" ON "mandato_administracion" USING btree ("barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mandato_vigente" ON "mandato_administracion" USING btree ("barrio_id") WHERE hasta is null;--> statement-breakpoint
CREATE INDEX "idx_obligado_barrio" ON "obligado" USING btree ("barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_obligado_barrio_cuit" ON "obligado" USING btree ("barrio_id","cuit_cuil") WHERE cuit_cuil is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_contacto_uf_email" ON "unidad_contacto" USING btree ("unidad_funcional_id",lower("email"));--> statement-breakpoint
CREATE INDEX "idx_contacto_barrio" ON "unidad_contacto" USING btree ("barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_uf_barrio_manzana_lote" ON "unidad_funcional" USING btree ("barrio_id","manzana","lote");--> statement-breakpoint
CREATE INDEX "idx_uf_barrio" ON "unidad_funcional" USING btree ("barrio_id");--> statement-breakpoint
CREATE INDEX "idx_uf_barrio_activas" ON "unidad_funcional" USING btree ("barrio_id") WHERE baja_at is null;--> statement-breakpoint
CREATE INDEX "idx_unidad_obligado_uf" ON "unidad_obligado" USING btree ("unidad_funcional_id");--> statement-breakpoint
CREATE INDEX "idx_unidad_obligado_barrio" ON "unidad_obligado" USING btree ("barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_unidad_obligado_vigente" ON "unidad_obligado" USING btree ("unidad_funcional_id","obligado_id","tipo") WHERE hasta is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_unidad_notificado" ON "unidad_obligado" USING btree ("unidad_funcional_id") WHERE hasta is null and es_notificado;