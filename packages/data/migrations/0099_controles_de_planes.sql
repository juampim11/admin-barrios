-- =============================================================================================
-- 0099 · Controles de planes y rendiciones (encargo F4 tramo 2, BL-055 a-d). Decisiones del titular
-- del 18/11. Solo estructura: columnas, índices, funciones y triggers; no reescribe datos.
--
--   a. El tope de tasa mensual equivalente de un plan a medida es de la administración
--      (`plan_parametro_administracion.tope_tasa_a_medida`, 10 % por defecto: el del catálogo). Lo aplica
--      el servicio al proponer (`superaElTopeDeTasa`, `shared/planes`).
--   b. Una unidad con un plan vigente o pendiente no se deriva (trigger en `derivacion`).
--   c. Un solo plan abierto (vigente o pendiente) por unidad: índice único parcial.
--   d. Una cuota no se rinde dos veces: no entra si ya está en otra rendición en borrador, ni si una
--      confirmada la dejó sin saldo. Con saldo después de una confirmada, sí (por lo que le falta).
-- Regla del repo: una migración ya aplicada NO se edita; se agrega la siguiente con prefijo mayor.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- a. El tope de tasa equivalente de un plan a medida
-- ---------------------------------------------------------------------------------------------
alter table plan_parametro_administracion add column tope_tasa_a_medida numeric(7,6) not null default 0.100000;
--> statement-breakpoint
alter table plan_parametro_administracion add constraint plan_parametro_admin_tope_chk
  check (tope_tasa_a_medida > 0 and tope_tasa_a_medida <= 1);
--> statement-breakpoint
comment on column plan_parametro_administracion.tope_tasa_a_medida is
  'Tope de la tasa mensual equivalente de un plan a medida que cobra más que la deuda (0099). Sin fila: 0,10.';
--> statement-breakpoint
grant update (tope_tasa_a_medida) on table plan_parametro_administracion to app_request;
--> statement-breakpoint
-- El tope que rige en un barrio (el de su administración; sin fila, 0,10). `security definer` y dueña
-- `app_job`, como `app.orden_plan_del_barrio` (0098): el control no cae al valor por defecto porque una RLS
-- le esconda la fila de la administración (code-reviewer, n2).
create or replace function app.tope_tasa_a_medida_del_barrio(p_barrio uuid) returns numeric
  language sql stable security definer set search_path = public, app, pg_temp
as $$
  select coalesce(
    (select pa.tope_tasa_a_medida from plan_parametro_administracion pa
       join tenant_node n on n.parent_id = pa.administracion_id
      where n.id = p_barrio),
    0.100000);
$$;
--> statement-breakpoint
revoke execute on function app.tope_tasa_a_medida_del_barrio(uuid) from public;
--> statement-breakpoint
alter function app.tope_tasa_a_medida_del_barrio(uuid) owner to app_job;
--> statement-breakpoint
grant execute on function app.tope_tasa_a_medida_del_barrio(uuid) to app_request, app_job;
--> statement-breakpoint
alter table plan_parametro_administracion_historia add column tope_tasa_a_medida numeric(7,6);
--> statement-breakpoint
create or replace function app.plan_parametro_administracion_a_la_historia() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  insert into plan_parametro_administracion_historia (administracion_id, orden_imputacion, tope_tasa_a_medida, cargado_por)
  values (new.administracion_id, new.orden_imputacion, new.tope_tasa_a_medida, new.cargado_por);
  return null;
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- c. Un solo plan abierto por unidad
-- ---------------------------------------------------------------------------------------------
create unique index uq_plan_pago_abierto_por_unidad on plan_pago (unidad_funcional_id) where estado in ('vigente', 'pendiente');
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- b. Con un plan abierto, la unidad no se deriva. `security definer` (dueña `app_job`): el control no
--    puede fallar abierto porque la RLS de quien deriva le esconda el plan. Solo devuelve un booleano.
-- ---------------------------------------------------------------------------------------------
create or replace function app.unidad_con_plan_abierto(p_unidad uuid) returns boolean
  language sql stable security definer set search_path = public, app, pg_temp
as $$
  select exists (select 1 from plan_pago where unidad_funcional_id = p_unidad and estado in ('vigente', 'pendiente'));
$$;
--> statement-breakpoint
revoke execute on function app.unidad_con_plan_abierto(uuid) from public;
--> statement-breakpoint
alter function app.unidad_con_plan_abierto(uuid) owner to app_job;
--> statement-breakpoint
grant execute on function app.unidad_con_plan_abierto(uuid) to app_request, app_job;
--> statement-breakpoint
create or replace function app.derivacion_sin_plan_abierto() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if app.unidad_con_plan_abierto(new.unidad_funcional_id) then
    raise exception 'la unidad tiene un plan de pagos abierto: no se deriva mientras siga';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_derivacion_zz_plan_abierto before insert on derivacion
  for each row execute function app.derivacion_sin_plan_abierto();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- d. La cuota de una rendición (v2): copia ENTERA de la v1 (`0097` §5) con los cambios `[0099]`.
-- ---------------------------------------------------------------------------------------------
create or replace function app.plan_rendicion_cuota_valida() returns trigger
  language plpgsql set search_path = public, app
as $$
declare
  v_estudio uuid;
  c         record;
begin
  if not app.has_role_on(new.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) then
    return new;
  end if;
  select pc.liquidacion_id, pp.estado, pp.modo_cobro, pp.estudio_id into c
    from plan_cuota pc join plan_pago pp on pp.id = pc.plan_id
   where pc.id = new.plan_cuota_id and pc.barrio_id = new.barrio_id;
  if not found then
    raise exception 'esa cuota no existe o no es de este barrio';
  end if;
  select estudio_id into v_estudio from plan_rendicion where id = new.rendicion_id;
  if c.modo_cobro <> 'estudio' or c.estudio_id is distinct from v_estudio then
    raise exception 'esa cuota no la cobra el estudio de esta rendición';
  end if;
  -- [0099] Una cuota no se rinde dos veces: si ya está en otra rendición en borrador, no entra (se
  -- termina o se saca de aquella). Antes que el estado del plan: una cuota que una rendición pagó puede
  -- haber cumplido el plan, y lo que hay que decir es que ya quedó paga.
  if exists (select 1 from plan_rendicion_cuota rc join plan_rendicion r on r.id = rc.rendicion_id
              where rc.plan_cuota_id = new.plan_cuota_id and rc.rendicion_id <> new.rendicion_id and r.estado = 'borrador') then
    raise exception 'esa cuota ya está en otra rendición en borrador';
  end if;
  -- [0099] Y si una confirmada ya la dejó sin saldo, tampoco. Con saldo, sí: se rinde lo que le falta.
  if c.liquidacion_id is not null and app.saldo_de_liquidacion(c.liquidacion_id) <= 0
     and exists (select 1 from plan_rendicion_cuota rc join plan_rendicion r on r.id = rc.rendicion_id
                  where rc.plan_cuota_id = new.plan_cuota_id and r.estado = 'confirmada') then
    raise exception 'esa cuota ya quedó paga por otra rendición';
  end if;
  if c.estado <> 'vigente' then
    raise exception 'esa cuota es de un plan que ya no está vigente';
  end if;
  if c.liquidacion_id is null then
    raise exception 'esa cuota todavía no se emitió: se rinde desde el mes en que vence';
  end if;
  if new.importe > app.saldo_de_liquidacion(c.liquidacion_id) then
    raise exception 'el importe es mayor que lo que le falta pagar a esa cuota';
  end if;
  return new;
end; $$;
