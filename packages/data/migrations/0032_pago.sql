-- =============================================================================================
-- 0032_pago — la tabla del pago, generada desde `packages/data/src/schema/cobros.ts`.
--
-- Mismo problema documentado en `0026_documentos_y_cola.sql`: `0028_ajuste_de_la_cuota.sql` y
-- `0031_medio_cobranza_del_barrio.sql` se escribieron a mano y su snapshot nunca se actualizó, así
-- que `drizzle-kit generate` volvía a proponer esas columnas como si faltaran. Ya están aplicadas
-- desde sus fechas originales; se sacan de acá porque agregarlas de nuevo rompería cualquier base
-- real. El snapshot de esta migración sí las incluye: el generador vuelve a estar sincronizado.
--
-- Las reglas — trigger de identidad/inmutabilidad, RLS, FK compuesta anti-cruce — van en
-- `0033_pagos_reglas.sql`. Acá está la forma, nada más.
-- =============================================================================================
CREATE TABLE "pago" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"unidad_funcional_id" uuid NOT NULL,
	"obligado_id" uuid,
	"monto" numeric(14, 2) NOT NULL,
	"fecha" date NOT NULL,
	"origen" text NOT NULL,
	"estado_conciliacion" text DEFAULT 'pendiente' NOT NULL,
	"usuario_registrador" uuid,
	"comprobante_adjunto" text,
	"anulado_at" timestamp with time zone,
	"anulado_por" uuid,
	"motivo_anulacion" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pago_monto_positivo_chk" CHECK ("pago"."monto" > 0),
	CONSTRAINT "pago_origen_chk" CHECK ("pago"."origen" in ('extracto','manual')),
	CONSTRAINT "pago_estado_conciliacion_chk" CHECK ("pago"."estado_conciliacion" in ('pendiente','conciliado')),
	CONSTRAINT "pago_manual_exige_registrador_chk" CHECK (("pago"."origen" = 'manual' and "pago"."usuario_registrador" is not null and "pago"."comprobante_adjunto" is not null)
          or ("pago"."origen" = 'extracto' and "pago"."usuario_registrador" is null)),
	CONSTRAINT "pago_anulacion_chk" CHECK (("pago"."anulado_at" is null and "pago"."anulado_por" is null and "pago"."motivo_anulacion" is null)
          or ("pago"."anulado_at" is not null and "pago"."anulado_por" is not null and "pago"."motivo_anulacion" is not null)),
	CONSTRAINT "pago_comprobante_storage_key_chk" CHECK ("pago"."comprobante_adjunto" is null or "pago"."comprobante_adjunto" ~
          ('^barrios/' || "pago"."barrio_id"::text || '/pagos/comprobantes/[A-Za-z0-9_-]{22,64}\.(pdf|jpg|jpeg|png)$'))
);
--> statement-breakpoint
ALTER TABLE "pago" ADD CONSTRAINT "pago_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pago" ADD CONSTRAINT "pago_unidad_funcional_id_unidad_funcional_id_fk" FOREIGN KEY ("unidad_funcional_id") REFERENCES "public"."unidad_funcional"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pago" ADD CONSTRAINT "pago_obligado_id_obligado_id_fk" FOREIGN KEY ("obligado_id") REFERENCES "public"."obligado"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pago_barrio" ON "pago" USING btree ("barrio_id");--> statement-breakpoint
CREATE INDEX "idx_pago_unidad" ON "pago" USING btree ("unidad_funcional_id");--> statement-breakpoint
CREATE INDEX "idx_pago_barrio_fecha" ON "pago" USING btree ("barrio_id","fecha") WHERE anulado_at is null;--> statement-breakpoint
CREATE INDEX "idx_pago_pendiente_conciliar" ON "pago" USING btree ("barrio_id","fecha") WHERE estado_conciliacion = 'pendiente' and anulado_at is null;