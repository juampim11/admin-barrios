-- =============================================================================================
-- 0043_proveedores_y_ordenes_pago — las tablas, generadas desde
-- `packages/data/src/schema/proveedores.ts`.
--
-- Diseño: boceto propio + panel `arquitecto-software` + `dba-data` + `security-engineer` +
-- `administrador-consorcios` + `legal-ph` (2026-08-21). Doc 01 §4.6.
--
-- Las reglas — trigger de transición (congelamiento, gates de rol, cuatro-ojos, generación/reversión
-- de `gasto_periodo`), RLS, FKs compuestas anti-cruce — van en `0044_ordenes_pago_reglas.sql`. Acá
-- está la forma, nada más (mismo criterio que `0032_pago.sql`/`0033_pago_imputacion.sql`).
-- =============================================================================================
CREATE TABLE "orden_pago" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"proveedor_id" uuid NOT NULL,
	"periodo_id" uuid NOT NULL,
	"concepto_id" uuid NOT NULL,
	"numero_factura" text,
	"descripcion" text NOT NULL,
	"monto" numeric(14, 2) NOT NULL,
	"medio_pago" text,
	"comprobante_adjunto" text,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"creada_por" uuid NOT NULL,
	"creada_at" timestamp with time zone DEFAULT now() NOT NULL,
	"aprobada_at" timestamp with time zone,
	"aprobada_por" uuid,
	"rechazada_at" timestamp with time zone,
	"rechazada_por" uuid,
	"pagada_at" timestamp with time zone,
	"pagada_por" uuid,
	"anulada_at" timestamp with time zone,
	"anulada_por" uuid,
	"motivo_anulacion" text,
	"conciliada_at" timestamp with time zone,
	"conciliada_por" uuid,
	CONSTRAINT "orden_pago_monto_chk" CHECK ("orden_pago"."monto" > 0),
	CONSTRAINT "orden_pago_estado_chk" CHECK ("orden_pago"."estado" in ('pendiente','aprobada','rechazada','pagada','anulada','conciliada')),
	CONSTRAINT "orden_pago_medio_pago_chk" CHECK ("orden_pago"."medio_pago" is null or "orden_pago"."medio_pago" in ('transferencia','cheque','efectivo','otro')),
	CONSTRAINT "orden_pago_comprobante_storage_key_chk" CHECK ("orden_pago"."comprobante_adjunto" is null or "orden_pago"."comprobante_adjunto" ~
          ('^barrios/' || "orden_pago"."barrio_id"::text || '/ordenes-pago/' || "orden_pago"."id"::text ||
           '/[A-Za-z0-9_-]{22,64}\.(pdf|jpg|jpeg|png)$')),
	CONSTRAINT "orden_pago_aprobacion_chk" CHECK (("orden_pago"."aprobada_at" is null and "orden_pago"."aprobada_por" is null)
          or ("orden_pago"."aprobada_at" is not null and "orden_pago"."aprobada_por" is not null)),
	CONSTRAINT "orden_pago_rechazo_chk" CHECK (("orden_pago"."rechazada_at" is null and "orden_pago"."rechazada_por" is null)
          or ("orden_pago"."rechazada_at" is not null and "orden_pago"."rechazada_por" is not null)),
	CONSTRAINT "orden_pago_pago_chk" CHECK (("orden_pago"."pagada_at" is null and "orden_pago"."pagada_por" is null)
          or ("orden_pago"."pagada_at" is not null and "orden_pago"."pagada_por" is not null)),
	CONSTRAINT "orden_pago_anulacion_chk" CHECK (("orden_pago"."anulada_at" is null and "orden_pago"."anulada_por" is null and "orden_pago"."motivo_anulacion" is null)
          or ("orden_pago"."anulada_at" is not null and "orden_pago"."anulada_por" is not null and "orden_pago"."motivo_anulacion" is not null)),
	CONSTRAINT "orden_pago_conciliacion_chk" CHECK (("orden_pago"."conciliada_at" is null and "orden_pago"."conciliada_por" is null)
          or ("orden_pago"."conciliada_at" is not null and "orden_pago"."conciliada_por" is not null))
);
--> statement-breakpoint
CREATE TABLE "proveedor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"razon_social" text NOT NULL,
	"cuit" text,
	"condicion_fiscal" text,
	"contacto" text,
	"cbu" text,
	"alias" text,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proveedor_cbu_chk" CHECK ("proveedor"."cbu" is null or "proveedor"."cbu" ~ '^[0-9]{22}$')
);
--> statement-breakpoint
ALTER TABLE "orden_pago" ADD CONSTRAINT "orden_pago_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orden_pago" ADD CONSTRAINT "orden_pago_proveedor_id_proveedor_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedor"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orden_pago" ADD CONSTRAINT "orden_pago_periodo_id_periodo_expensa_id_fk" FOREIGN KEY ("periodo_id") REFERENCES "public"."periodo_expensa"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orden_pago" ADD CONSTRAINT "orden_pago_concepto_id_concepto_id_fk" FOREIGN KEY ("concepto_id") REFERENCES "public"."concepto"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proveedor" ADD CONSTRAINT "proveedor_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_orden_pago_id_barrio" ON "orden_pago" USING btree ("id","barrio_id");--> statement-breakpoint
CREATE INDEX "idx_orden_pago_barrio" ON "orden_pago" USING btree ("barrio_id");--> statement-breakpoint
CREATE INDEX "idx_orden_pago_proveedor" ON "orden_pago" USING btree ("proveedor_id");--> statement-breakpoint
CREATE INDEX "idx_orden_pago_periodo" ON "orden_pago" USING btree ("periodo_id");--> statement-breakpoint
CREATE INDEX "idx_orden_pago_pendientes" ON "orden_pago" USING btree ("barrio_id","creada_at") WHERE estado = 'pendiente';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proveedor_barrio_razon_social" ON "proveedor" USING btree ("barrio_id",lower("razon_social"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_proveedor_id_barrio" ON "proveedor" USING btree ("id","barrio_id");--> statement-breakpoint
CREATE INDEX "idx_proveedor_barrio" ON "proveedor" USING btree ("barrio_id");