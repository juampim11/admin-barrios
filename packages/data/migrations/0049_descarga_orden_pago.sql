-- =============================================================================================
-- 0049_descarga_orden_pago — generaliza `descarga_documento` para poder auditar la descarga del
-- comprobante de pago Y de la factura de una orden de pago (gap encontrado diseñando las
-- pantallas: sin esto, un adjunto se puede subir pero nunca se puede volver a ver).
--
-- **Generalizada, no gemela** — mismo precedente que `0039` (que agregó `pago_id`/`recibo_emitido_id`
-- a la misma tabla en vez de nacer `descarga_pago`): una `orden_pago_id` sirve para las DOS
-- descargas posibles de una orden (comprobante o factura) — cuál de las dos storage keys se pidió lo
-- decide la ruta que llama (`api/ordenes-pago/[ordenId]/comprobante|factura`), no una columna nueva.
--
-- El `CHECK` de "exactamente una referencia" (`descarga_referencia_unica_chk`, `0039`) no vive en
-- `schema/documentos.ts` — nunca vivió, es una constraint agregada a mano en la migración de reglas
-- correspondiente — así que se recrea acá con `num_nonnulls` sobre las cuatro columnas.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. La columna, su FK y su índice — generado por drizzle-kit desde `schema/documentos.ts`.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "descarga_documento" ADD COLUMN "orden_pago_id" uuid;--> statement-breakpoint
ALTER TABLE "descarga_documento" ADD CONSTRAINT "descarga_documento_orden_pago_id_orden_pago_id_fk" FOREIGN KEY ("orden_pago_id") REFERENCES "public"."orden_pago"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_descarga_orden_pago" ON "descarga_documento" USING btree ("orden_pago_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. El CHECK de "exactamente una referencia" — de tres a cuatro.
-- ---------------------------------------------------------------------------------------------
alter table descarga_documento drop constraint descarga_referencia_unica_chk;
--> statement-breakpoint

alter table descarga_documento add constraint descarga_referencia_unica_chk
  check (num_nonnulls(documento_id, pago_id, recibo_emitido_id, orden_pago_id) = 1);
