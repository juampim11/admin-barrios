-- =============================================================================================
-- 0009_trazabilidad_reglas — que la liquidación se pueda VERIFICAR con una calculadora.
--
-- Hallazgos de `qa-funcional` y `security-engineer` sobre el módulo de PDF (2026-07-24):
--   H-1 la mora no era recomputable (faltaban los días) · H-2 el resto del prorrateo estaba
--   escondido dentro del monto de la última unidad · H-3 el catálogo de conceptos es editable
--   después de emitir, así que un documento regenerado podía cambiar · H-8 la denominación del
--   concepto no estaba congelada, y `figura_juridica` sí se versiona.
-- =============================================================================================

-- RLS y FKs compuestas de los medios de pago (mismo patrón que el resto del dominio).
alter table medio_pago_barrio enable row level security;
--> statement-breakpoint
alter table medio_pago_barrio force row level security;
--> statement-breakpoint
create policy medio_pago_barrio_sel on medio_pago_barrio for select
  using (barrio_id in (select app.accessible_tenant_ids()));
--> statement-breakpoint
create policy medio_pago_barrio_ins on medio_pago_barrio for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint
create policy medio_pago_barrio_upd on medio_pago_barrio for update
  using (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]))
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint
create policy medio_pago_barrio_del on medio_pago_barrio for delete
  using (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
grant select, insert, update, delete on table medio_pago_barrio to app_request;
--> statement-breakpoint
grant select, insert, update, delete on table medio_pago_barrio to app_job;
--> statement-breakpoint

-- El origen del saldo anterior es un valor cerrado: mientras no exista el módulo de cobros, el
-- documento tiene que poder decir que ese número se cargó a mano.
alter table liquidacion add constraint liquidacion_saldo_origen_chk
  check (saldo_anterior_origen in ('sin_movimientos', 'carga_manual', 'cuenta_corriente'));
--> statement-breakpoint

-- Si hay interés cobrado, tienen que estar los días con los que se calculó: sin eso, la cuenta no
-- se puede rehacer y la cifra queda sin origen (regla dura del proyecto).
alter table liquidacion add constraint liquidacion_mora_verificable_chk
  check (interes_mora is null or interes_mora = 0 or dias_atraso is not null);
--> statement-breakpoint

-- El ajuste por redondeo es exactamente la diferencia entre lo cobrado y la cuenta a mano.
alter table item_liquidacion add constraint item_ajuste_redondeo_chk
  check (monto_teorico is null or ajuste_redondeo = monto - monto_teorico);
