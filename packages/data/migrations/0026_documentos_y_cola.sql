-- =============================================================================================
-- 0026_documentos_y_cola — las tres tablas de la emisión de documentos.
--
-- Generada con `drizzle-kit generate` desde `packages/data/src/schema/documentos.ts`, y después
-- editada a mano para sacarle tres `ALTER TABLE` que NO son de esta tanda: `drizzle-kit` los
-- incluyó porque `0025_tope_de_cargos.sql` se escribió a mano y **su snapshot nunca se actualizó**,
-- así que el generador creía que esas columnas faltaban. Ya están aplicadas desde el 2026-07-28 y
-- volver a agregarlas rompería la migración en cualquier base real. El snapshot de esta migración
-- (`meta/0026_snapshot.json`) sí las incluye: a partir de acá el generador vuelve a estar sincronizado.
--
-- Las reglas —RLS, grants, triggers, la derivación del barrio y el gate de rol por tipo de
-- documento— van en `0027_documentos_y_cola_reglas.sql`. Acá está la forma, nada más.
--
-- Diseño: ADR-0002 §6 y ADR-0001 §5 y §6. Tres divergencias respecto del texto de los ADR, con su
-- fundamento, en el docstring de `packages/data/src/schema/documentos.ts`.
-- =============================================================================================
CREATE TYPE "app"."estado_trabajo" AS ENUM('encolado', 'corriendo', 'terminado', 'fallado');--> statement-breakpoint
CREATE TYPE "app"."tipo_documento" AS ENUM('boleta_unidad', 'informe_mensual', 'listado_saldos_pendientes');--> statement-breakpoint
CREATE TYPE "app"."tipo_trabajo" AS ENUM('emitir_documentos_periodo');--> statement-breakpoint
CREATE TABLE "descarga_documento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"documento_id" uuid NOT NULL,
	"solicitado_por" uuid NOT NULL,
	"url_firmada_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ttl_segundos" integer NOT NULL,
	CONSTRAINT "descarga_ttl_chk" CHECK ("descarga_documento"."ttl_segundos" > 0 and "descarga_documento"."ttl_segundos" <= 600)
);
--> statement-breakpoint
CREATE TABLE "documento_emitido" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"periodo_id" uuid NOT NULL,
	"tipo" "app"."tipo_documento" NOT NULL,
	"liquidacion_id" uuid,
	"storage_key" text NOT NULL,
	"sha256" char(64) NOT NULL,
	"bytes" integer NOT NULL,
	"vista" jsonb NOT NULL,
	"vista_version" text NOT NULL,
	"motor" text NOT NULL,
	"plantilla_hash" char(64) NOT NULL,
	"medio_cobranza" text NOT NULL,
	"emitido_at" timestamp with time zone DEFAULT now() NOT NULL,
	"emitido_por" uuid NOT NULL,
	CONSTRAINT "documento_emitido_liquidacion_chk" CHECK (("documento_emitido"."tipo" = 'boleta_unidad' and "documento_emitido"."liquidacion_id" is not null)
          or ("documento_emitido"."tipo" <> 'boleta_unidad' and "documento_emitido"."liquidacion_id" is null)),
	CONSTRAINT "documento_storage_key_chk" CHECK ("documento_emitido"."storage_key" ~ ('^barrios/' || "documento_emitido"."barrio_id"::text || '/periodos/[0-9a-f-]{36}/(boletas|informes|listados)/[A-Za-z0-9_-]{22,64}\.pdf$'))
);
--> statement-breakpoint
CREATE TABLE "trabajo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"tipo" "app"."tipo_trabajo" NOT NULL,
	"referencia_id" uuid NOT NULL,
	"estado" "app"."estado_trabajo" DEFAULT 'encolado' NOT NULL,
	"hechos" integer DEFAULT 0 NOT NULL,
	"total" integer,
	"intento" smallint DEFAULT 0 NOT NULL,
	"solicitado_por" uuid NOT NULL,
	"solicitado_at" timestamp with time zone DEFAULT now() NOT NULL,
	"iniciado_at" timestamp with time zone,
	"terminado_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "descarga_documento" ADD CONSTRAINT "descarga_documento_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "descarga_documento" ADD CONSTRAINT "descarga_documento_documento_id_documento_emitido_id_fk" FOREIGN KEY ("documento_id") REFERENCES "public"."documento_emitido"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento_emitido" ADD CONSTRAINT "documento_emitido_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento_emitido" ADD CONSTRAINT "documento_emitido_periodo_id_periodo_expensa_id_fk" FOREIGN KEY ("periodo_id") REFERENCES "public"."periodo_expensa"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documento_emitido" ADD CONSTRAINT "documento_emitido_liquidacion_id_liquidacion_id_fk" FOREIGN KEY ("liquidacion_id") REFERENCES "public"."liquidacion"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trabajo" ADD CONSTRAINT "trabajo_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_descarga_documento" ON "descarga_documento" USING btree ("documento_id");--> statement-breakpoint
CREATE INDEX "idx_descarga_barrio_fecha" ON "descarga_documento" USING btree ("barrio_id","url_firmada_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_documento_storage_key" ON "documento_emitido" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "idx_doc_emi_liquidacion" ON "documento_emitido" USING btree ("liquidacion_id");--> statement-breakpoint
CREATE INDEX "idx_doc_emi_periodo_tipo" ON "documento_emitido" USING btree ("periodo_id","tipo");--> statement-breakpoint
CREATE INDEX "idx_doc_emi_barrio" ON "documento_emitido" USING btree ("barrio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_trabajo_pendiente" ON "trabajo" USING btree ("referencia_id","tipo") WHERE estado in ('encolado', 'corriendo');--> statement-breakpoint
CREATE INDEX "idx_trabajo_encolado" ON "trabajo" USING btree ("solicitado_at") WHERE estado = 'encolado';--> statement-breakpoint
CREATE INDEX "idx_trabajo_barrio" ON "trabajo" USING btree ("barrio_id");--> statement-breakpoint
CREATE INDEX "idx_trabajo_referencia" ON "trabajo" USING btree ("referencia_id");
