-- =============================================================================================
-- 0005_expensas_rls — los controles de la liquidación, en la base.
--
-- Fuentes: docs/diseno/01-alcance-modulos.md §4.2 · knowledge/cordoba/REQUISITOS-MODELO-DATOS.md §4.
--
-- Lo que se hace cumplir acá (no en la app, porque acá no hay forma de saltearlo):
--   1. Una EXTRAORDINARIA sin respaldo de asamblea no se carga (art. 2048).
--   2. Un período EMITIDO no se edita: ni sus gastos, ni sus liquidaciones, ni sus líneas.
--   3. No se emite un período DESCUADRADO ni sin liquidar todas las unidades activas.
--   4. Los estados avanzan por el camino previsto y no vuelven atrás una vez emitido.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 0. FKs compuestas (id, barrio_id): mismo blindaje anti-cruce que el padrón (ver 0003).
-- ---------------------------------------------------------------------------------------------
alter table concepto        add constraint uq_concepto_id_barrio  unique (id, barrio_id);
--> statement-breakpoint
alter table periodo_expensa add constraint uq_periodo_id_barrio   unique (id, barrio_id);
--> statement-breakpoint
alter table gasto_periodo   add constraint uq_gasto_id_barrio     unique (id, barrio_id);
--> statement-breakpoint
alter table liquidacion     add constraint uq_liquidacion_id_barrio unique (id, barrio_id);
--> statement-breakpoint

alter table gasto_periodo
  add constraint fk_gasto_periodo_barrio foreign key (periodo_id, barrio_id)
  references periodo_expensa (id, barrio_id) on delete cascade;
--> statement-breakpoint
alter table gasto_periodo
  add constraint fk_gasto_concepto_barrio foreign key (concepto_id, barrio_id)
  references concepto (id, barrio_id) on delete restrict;
--> statement-breakpoint
alter table gasto_periodo
  add constraint fk_gasto_acta_barrio foreign key (acta_documento_id, barrio_id)
  references documento_barrio (id, barrio_id) on delete restrict;
--> statement-breakpoint
alter table liquidacion
  add constraint fk_liquidacion_periodo_barrio foreign key (periodo_id, barrio_id)
  references periodo_expensa (id, barrio_id) on delete cascade;
--> statement-breakpoint
alter table liquidacion
  add constraint fk_liquidacion_uf_barrio foreign key (unidad_funcional_id, barrio_id)
  references unidad_funcional (id, barrio_id) on delete restrict;
--> statement-breakpoint
alter table liquidacion
  add constraint fk_liquidacion_obligado_barrio foreign key (obligado_id, barrio_id)
  references obligado (id, barrio_id) on delete set null;
--> statement-breakpoint
alter table item_liquidacion
  add constraint fk_item_liquidacion_barrio foreign key (liquidacion_id, barrio_id)
  references liquidacion (id, barrio_id) on delete cascade;
--> statement-breakpoint
alter table item_liquidacion
  add constraint fk_item_gasto_barrio foreign key (gasto_id, barrio_id)
  references gasto_periodo (id, barrio_id) on delete cascade;
--> statement-breakpoint
alter table periodo_expensa
  add constraint fk_periodo_coefver_barrio foreign key (coeficiente_version_id, barrio_id)
  references coeficiente_version (id, barrio_id) on delete restrict;
--> statement-breakpoint
alter table tasa_mora
  add constraint fk_tasa_documento_barrio foreign key (documento_id, barrio_id)
  references documento_barrio (id, barrio_id) on delete set null;
--> statement-breakpoint

create trigger trg_periodo_updated before update on periodo_expensa
  for each row execute function app.set_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 1. Una extraordinaria exige el acta que la respalda (art. 2048).
-- ---------------------------------------------------------------------------------------------
create or replace function app.gasto_respaldo_extraordinaria() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare v_tipo app.tipo_concepto;
begin
  select tipo into v_tipo from concepto where id = new.concepto_id;
  if v_tipo = 'extraordinaria' and new.acta_documento_id is null then
    raise exception 'una expensa extraordinaria necesita el acta de asamblea que la respalda (art. 2048)';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_gasto_respaldo before insert or update on gasto_periodo
  for each row execute function app.gasto_respaldo_extraordinaria();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. Un período emitido queda congelado. La corrección va en el período siguiente (nota de
--    crédito/débito), nunca reescribiendo lo que ya se le mandó al propietario.
-- ---------------------------------------------------------------------------------------------
create or replace function app.periodo_editable() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_estado app.estado_periodo;
  v_periodo uuid;
begin
  -- IF/ELSIF y no CASE: plpgsql prepara cada sentencia por separado, así que solo se resuelven los
  -- campos de la tabla que disparó el trigger (un CASE haría fallar a `gasto_periodo` por referirse
  -- a `new.liquidacion_id`, que en esa tabla no existe).
  if tg_table_name = 'item_liquidacion' then
    select periodo_id into v_periodo from liquidacion where id = coalesce(new.liquidacion_id, old.liquidacion_id);
  else
    v_periodo := coalesce(new.periodo_id, old.periodo_id);
  end if;

  select estado into v_estado from periodo_expensa where id = v_periodo;
  if v_estado in ('emitida', 'distribuida') then
    raise exception 'el período ya está % : no se edita (se corrige en el período siguiente)', v_estado;
  end if;
  return coalesce(new, old);
end; $$;
--> statement-breakpoint
create trigger trg_gasto_periodo_editable before insert or update or delete on gasto_periodo
  for each row execute function app.periodo_editable();
--> statement-breakpoint
create trigger trg_liquidacion_editable before insert or update or delete on liquidacion
  for each row execute function app.periodo_editable();
--> statement-breakpoint
create trigger trg_item_liquidacion_editable before insert or update or delete on item_liquidacion
  for each row execute function app.periodo_editable();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3 y 4. Emisión: estados válidos + cuadre obligatorio.
-- ---------------------------------------------------------------------------------------------
create or replace function app.validar_emision(p_periodo uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_barrio        uuid;
  v_gastos        numeric(14,2);
  v_repartido     numeric(14,2);
  v_liquidaciones bigint;
  v_unidades      bigint;
  v_version       uuid;
  v_cerrada       boolean;
begin
  select barrio_id, coeficiente_version_id into v_barrio, v_version
    from periodo_expensa where id = p_periodo;

  -- La versión de coeficientes tiene que existir y estar cerrada: si no cuadra el padrón, no se
  -- puede repartir nada (arts. 2046 inc. c / 2081).
  if v_version is null then
    raise exception 'el período no tiene versión de coeficientes: no se puede emitir';
  end if;
  select cerrada into v_cerrada from coeficiente_version where id = v_version;
  if not coalesce(v_cerrada, false) then
    raise exception 'la versión de coeficientes del período no está cerrada';
  end if;

  select coalesce(sum(monto), 0) into v_gastos from gasto_periodo where periodo_id = p_periodo;
  select coalesce(sum(i.monto), 0) into v_repartido
    from item_liquidacion i join liquidacion l on l.id = i.liquidacion_id
   where l.periodo_id = p_periodo;

  select count(*) into v_liquidaciones from liquidacion where periodo_id = p_periodo;
  select count(*) into v_unidades
    from unidad_funcional where barrio_id = v_barrio and baja_at is null;

  if v_liquidaciones <> v_unidades then
    raise exception 'faltan liquidaciones: % unidades activas y % liquidaciones', v_unidades, v_liquidaciones;
  end if;

  if v_gastos <> v_repartido then
    raise exception 'el período no cuadra: gastos % y repartido % (diferencia %)',
      v_gastos, v_repartido, v_gastos - v_repartido;
  end if;
end; $$;
--> statement-breakpoint

create or replace function app.periodo_transicion() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  if new.estado = old.estado then
    return new;
  end if;

  -- Camino previsto: borrador ⇄ revisada → emitida → distribuida. Después de emitir no se vuelve.
  if not (
       (old.estado = 'borrador'  and new.estado in ('revisada', 'emitida'))
    or (old.estado = 'revisada'  and new.estado in ('borrador', 'emitida'))
    or (old.estado = 'emitida'   and new.estado = 'distribuida')
  ) then
    raise exception 'transición de estado inválida: % → %', old.estado, new.estado;
  end if;

  if new.estado = 'emitida' then
    perform app.validar_emision(new.id);
    new.emitida_at := now();
    new.total_gastos := (select coalesce(sum(monto), 0) from gasto_periodo where periodo_id = new.id);
  elsif new.estado = 'distribuida' then
    new.distribuida_at := now();
  end if;

  return new;
end; $$;
--> statement-breakpoint
create trigger trg_periodo_transicion before update on periodo_expensa
  for each row execute function app.periodo_transicion();
--> statement-breakpoint

-- La tasa de mora vigente del barrio a una fecha. NULL = el barrio no la definió: el sistema
-- liquida el capital y marca "mora pendiente de definición" (nunca inventa una tasa).
create or replace function app.tasa_mora_vigente(p_barrio uuid, p_fecha date default current_date)
  returns numeric
  language sql stable security definer set search_path = public, app
as $$
  select t.tasa_mensual
  from tasa_mora t
  where t.barrio_id = p_barrio
    and t.vigente_desde <= p_fecha
    and (t.vigente_hasta is null or t.vigente_hasta > p_fecha)
  order by t.vigente_desde desc
  limit 1;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. RLS: mismo patrón que el resto del dominio; sin DELETE para el rol de request.
-- ---------------------------------------------------------------------------------------------
do $bloque$
declare
  t text;
  tablas text[] := array[
    'concepto', 'tasa_mora', 'periodo_expensa', 'gasto_periodo', 'liquidacion', 'item_liquidacion'
  ];
begin
  foreach t in array tablas loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);

    execute format(
      'create policy %I on %I for select using (barrio_id in (select app.accessible_tenant_ids()))',
      t || '_sel', t);
    execute format(
      'create policy %I on %I for insert with check (app.has_role_on(barrio_id, array[''admin_plataforma'',''admin_barrio'',''operador'']::app.rol_membership[]))',
      t || '_ins', t);
    execute format(
      'create policy %I on %I for update using (app.has_role_on(barrio_id, array[''admin_plataforma'',''admin_barrio'',''operador'']::app.rol_membership[])) with check (app.has_role_on(barrio_id, array[''admin_plataforma'',''admin_barrio'',''operador'']::app.rol_membership[]))',
      t || '_upd', t);

    execute format('grant select, insert, update on table %I to app_request', t);
    execute format('grant select, insert, update, delete on table %I to app_job', t);

    -- Excepción al "sin DELETE": mientras el período está en borrador hay que poder sacar un gasto
    -- cargado de más y regenerar las liquidaciones. El trigger `periodo_editable` es el que impide
    -- borrar cuando el período ya se emitió, así que el permiso no abre ningún agujero.
    if t in ('gasto_periodo', 'liquidacion', 'item_liquidacion') then
      execute format(
        'create policy %I on %I for delete using (app.has_role_on(barrio_id, array[''admin_plataforma'',''admin_barrio'',''operador'']::app.rol_membership[]))',
        t || '_del', t);
      execute format('grant delete on table %I to app_request', t);
    end if;
  end loop;
end
$bloque$;
--> statement-breakpoint

grant execute on function app.tasa_mora_vigente(uuid, date) to app_request, app_job;
--> statement-breakpoint
grant execute on function app.validar_emision(uuid) to app_request, app_job;
