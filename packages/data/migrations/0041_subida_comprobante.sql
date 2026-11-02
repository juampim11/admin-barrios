-- =============================================================================================
-- 0041_subida_comprobante — la tabla de auditoría de `prepararSubidaDeComprobante()` (panel
-- `arquitecto-software` + `security-engineer`, 2026-08-18) y el `unique` que falta en `pago`.
--
-- **Nota sobre lo que NO quedó en este archivo, y por qué.** `drizzle-kit generate` propuso, además
-- de la tabla nueva, volver a agregar `descarga_documento.pago_id`/`recibo_emitido_id` (columna,
-- FKs e índices) — porque `0039_recibos_reglas.sql` las agregó A MANO (es una migración de reglas,
-- no generada) y nunca se corrió un `generate` después para que el snapshot las capturara.
-- `0039_snapshot.json` y `0040_snapshot.json` quedaron desactualizados frente al esquema real desde
-- entonces; recién se nota ahora, con el primer `generate` posterior. Mismo patrón que ya
-- documentan `0036_orden_imputacion_barrio.sql` y `0037_estado_cuenta.sql` para el motivo inverso
-- (migración de reglas que el generador no puede proponer solo): acá el generador propuso de más, y
-- se saca a mano lo que ya existe en toda base que corrió `0039`. El snapshot `0041` que deja este
-- `generate` sí es correcto — describe el estado real, columnas incluidas — así que no hace falta
-- tocarlo, solo el SQL a ejecutar.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. La tabla (generada) + el índice que faltaba en `pago` (panel, punto 4: migración propia, sin
--    tocar `0032_pago.sql` ya aplicada).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "subida_comprobante_solicitada" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barrio_id" uuid NOT NULL,
	"unidad_funcional_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"solicitado_por" uuid NOT NULL,
	"solicitado_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subida_comprobante_content_type_chk" CHECK ("subida_comprobante_solicitada"."content_type" in ('application/pdf','image/jpeg','image/png')),
	CONSTRAINT "subida_comprobante_storage_key_chk" CHECK ("subida_comprobante_solicitada"."storage_key" ~
          ('^barrios/' || "subida_comprobante_solicitada"."barrio_id"::text || '/pagos/comprobantes/[A-Za-z0-9_-]{22,64}\.(pdf|jpg|jpeg|png)$'))
);
--> statement-breakpoint
ALTER TABLE "subida_comprobante_solicitada" ADD CONSTRAINT "subida_comprobante_solicitada_barrio_id_barrio_barrio_id_fk" FOREIGN KEY ("barrio_id") REFERENCES "public"."barrio"("barrio_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subida_comprobante_solicitada" ADD CONSTRAINT "subida_comprobante_solicitada_unidad_funcional_id_unidad_funcional_id_fk" FOREIGN KEY ("unidad_funcional_id") REFERENCES "public"."unidad_funcional"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_subida_comprobante_storage_key" ON "subida_comprobante_solicitada" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "idx_subida_comprobante_barrio" ON "subida_comprobante_solicitada" USING btree ("barrio_id");--> statement-breakpoint
CREATE INDEX "idx_subida_comprobante_unidad" ON "subida_comprobante_solicitada" USING btree ("unidad_funcional_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pago_comprobante_adjunto" ON "pago" USING btree ("comprobante_adjunto");--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. FK compuesta anti-cruce (patrón de `fk_pago_uf_barrio`, `0034`): el `barrio_id` de la fila
--    tiene que ser el de la propia unidad, estructuralmente — no solo porque el servicio lo haya
--    leído bien. `unidad_funcional` ya tiene `uq_uf_id_barrio unique (id, barrio_id)` desde `0003`.
-- ---------------------------------------------------------------------------------------------
alter table subida_comprobante_solicitada
  add constraint fk_subida_comprobante_uf_barrio foreign key (unidad_funcional_id, barrio_id)
  references unidad_funcional (id, barrio_id) on delete restrict;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. El trigger: la identidad de quien pide la subida la pone la base, nunca el cliente — mismo
--    criterio que `descarga_documento.solicitado_por` (`0027`/`0039`). Sin `security definer`: no
--    lee ninguna otra tabla, mismo motivo que `app.pago_antes()` (`0034`).
-- ---------------------------------------------------------------------------------------------
create or replace function app.subida_comprobante_antes_insert() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: una subida de comprobante sin autor no se registra'
      using errcode = 'P0001';
  end if;

  new.solicitado_por := v_usuario;
  new.solicitado_at  := now();
  return new;
end; $$;--> statement-breakpoint

create trigger trg_subida_comprobante_antes_insert before insert on subida_comprobante_solicitada
  for each row execute function app.subida_comprobante_antes_insert();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. RLS. Lectura por `readable_tenant_ids()` (conjunto — 0018), igual que `pago`/`descarga_documento`.
--    Escritura para los mismos tres roles que pueden registrar un pago (`pago_ins`, `0034`): quien
--    no puede cargar un pago manual tampoco tiene por qué poder pedir una URL de subida para uno.
--    Sin policy de UPDATE ni DELETE: es una traza append-only, igual que `descarga_documento`.
-- ---------------------------------------------------------------------------------------------
alter table subida_comprobante_solicitada enable row level security;
--> statement-breakpoint
alter table subida_comprobante_solicitada force row level security;
--> statement-breakpoint

create policy subida_comprobante_sel on subida_comprobante_solicitada for select
  using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint

create policy subida_comprobante_ins on subida_comprobante_solicitada for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

grant select, insert on table subida_comprobante_solicitada to app_request;
--> statement-breakpoint
grant select, insert, update, delete on table subida_comprobante_solicitada to app_job;
