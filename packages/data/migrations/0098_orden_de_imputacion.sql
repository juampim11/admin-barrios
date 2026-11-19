-- =============================================================================================
-- 0098 · Orden de imputación configurable entre la cuota del plan y la expensa (encargo F4 tramo 1,
-- BL-055 e). Decisión del titular del 18/11.
--
-- Cuando un pago no dice a qué va y la unidad debe cuotas de un plan y expensas, el orden es un
-- parámetro de la administración (valor general) que cada barrio puede reemplazar, con cuatro valores:
--   · `mas_vieja_primero` (el general por defecto): cuotas y expensas juntas, por vencimiento; a
--     igual vencimiento (el mismo día), primero la cuota;
--   · `cuota_primero` y `expensa_primero`: como hasta ahora;
--   · `a_eleccion`: lo elige quien registra el pago a mano (`pago.orden_plan_elegido`). Un pago que
--     entra sin intervención (extracto, importación) usa la más vieja y queda «para revisar»
--     (`pago.imputacion_para_revisar`).
--
-- Partes:
--   1. `plan_parametro_administracion` (+ su historia): el valor general. Sin fila, rige
--      `mas_vieja_primero`: no se siembra ninguna fila (cero DML).
--   2. `plan_parametro_barrio.orden_imputacion` pasa a admitir NULL = «Como la administración». Los
--      barrios que ya tenían valor lo conservan tal cual: la columna no se reescribe (el mapeo
--      aprobado es la identidad, `cuota_primero` → `cuota_primero`, `expensa_primero` →
--      `expensa_primero`, y no necesita un UPDATE).
--   3. `pago`: el orden que eligió quien registró y la marca «para revisar». Los pone la base: la
--      elección solo en un pago manual y solo al darlo de alta; la marca, solo la imputación
--      automática (`app_job`).
--   4. `app.resolver_imputacion` v5: copia ENTERA de la v4 (`0097` §4) con los cambios marcados
--      `[0098]`. La pasada de interés no cambia (sigue `imputacion.orden`) y la cuota que cobra el
--      estudio sigue sin imputarse con un pago común.
-- Regla del repo: una migración ya aplicada NO se edita; se agrega la siguiente con prefijo mayor.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. El valor general de la administración
-- ---------------------------------------------------------------------------------------------
create table plan_parametro_administracion (
  administracion_id uuid primary key references tenant_node (id) on delete restrict,
  orden_imputacion text not null default 'mas_vieja_primero',
  cargado_por uuid not null,
  updated_at timestamptz not null default now(),
  constraint plan_parametro_admin_orden_chk
    check (orden_imputacion in ('mas_vieja_primero', 'cuota_primero', 'expensa_primero', 'a_eleccion'))
);
--> statement-breakpoint
comment on table plan_parametro_administracion is
  'Las reglas generales de los planes de una administración (0098). Sin fila: orden «la más vieja primero».';
--> statement-breakpoint
-- Quién y cuándo los pone la base (`app.plan_config_antes`, la rama de los parámetros); que el nodo sea
-- una administración, este trigger.
create or replace function app.plan_parametro_administracion_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if tg_op = 'UPDATE' then
    new.administracion_id := old.administracion_id;
  end if;
  if not exists (select 1 from tenant_node where id = new.administracion_id and tipo = 'administrador') then
    raise exception 'las reglas generales de los planes son de una administración';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_plan_parametro_admin_antes before insert or update on plan_parametro_administracion
  for each row execute function app.plan_config_antes();
--> statement-breakpoint
create trigger trg_plan_parametro_admin_nodo before insert or update on plan_parametro_administracion
  for each row execute function app.plan_parametro_administracion_antes();
--> statement-breakpoint

-- La historia (mismo criterio que `plan_parametro_barrio_historia`, `0094`): solo agregar, la escribe un
-- trigger con quién y cuándo.
create table plan_parametro_administracion_historia (
  id uuid primary key default gen_random_uuid(),
  administracion_id uuid not null references tenant_node (id) on delete restrict,
  orden_imputacion text not null,
  cargado_por uuid not null,
  registrado_at timestamptz not null default clock_timestamp()
);
--> statement-breakpoint
create index idx_plan_parametro_admin_historia on plan_parametro_administracion_historia (administracion_id, registrado_at);
--> statement-breakpoint
create or replace function app.plan_parametro_administracion_a_la_historia() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  insert into plan_parametro_administracion_historia (administracion_id, orden_imputacion, cargado_por)
  values (new.administracion_id, new.orden_imputacion, new.cargado_por);
  return null;
end; $$;
--> statement-breakpoint
revoke execute on function app.plan_parametro_administracion_a_la_historia() from public;
--> statement-breakpoint
alter function app.plan_parametro_administracion_a_la_historia() owner to app_job;
--> statement-breakpoint
grant insert on table plan_parametro_administracion_historia to app_job;
--> statement-breakpoint
create trigger trg_plan_parametro_admin_historia after insert or update on plan_parametro_administracion
  for each row execute function app.plan_parametro_administracion_a_la_historia();
--> statement-breakpoint
create trigger trg_plan_parametro_admin_historia_solo_agregar before update or delete on plan_parametro_administracion_historia
  for each row execute function app.plan_solo_agregar();
--> statement-breakpoint

-- RLS: la lee quien lee la administración o un barrio suyo (de ahí hereda); la escribe quien la
-- administra (mismo criterio que `plan_catalogo`, `0093`).
alter table plan_parametro_administracion enable row level security;
--> statement-breakpoint
alter table plan_parametro_administracion force row level security;
--> statement-breakpoint
create policy plan_parametro_admin_sel on plan_parametro_administracion for select
  using (administracion_id in (select app.readable_tenant_ids()) or administracion_id in (select app.readable_admin_ancestros()));
--> statement-breakpoint
create policy plan_parametro_admin_ins on plan_parametro_administracion for insert
  with check (administracion_id in (select app.administraciones_administradas()));
--> statement-breakpoint
create policy plan_parametro_admin_upd on plan_parametro_administracion for update
  using (administracion_id in (select app.administraciones_administradas()))
  with check (administracion_id in (select app.administraciones_administradas()));
--> statement-breakpoint
grant select, insert on table plan_parametro_administracion to app_request;
--> statement-breakpoint
grant update (orden_imputacion) on table plan_parametro_administracion to app_request;
--> statement-breakpoint
grant select on table plan_parametro_administracion to app_job;
--> statement-breakpoint
alter table plan_parametro_administracion_historia enable row level security;
--> statement-breakpoint
alter table plan_parametro_administracion_historia force row level security;
--> statement-breakpoint
create policy plan_parametro_admin_historia_sel on plan_parametro_administracion_historia for select
  using (administracion_id in (select app.readable_tenant_ids()) or administracion_id in (select app.readable_admin_ancestros()));
--> statement-breakpoint
grant select on table plan_parametro_administracion_historia to app_request;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. El reemplazo del barrio: NULL = «Como la administración». Los valores que ya estaban no se tocan.
-- ---------------------------------------------------------------------------------------------
alter table plan_parametro_barrio alter column orden_imputacion drop default;
--> statement-breakpoint
alter table plan_parametro_barrio alter column orden_imputacion drop not null;
--> statement-breakpoint
alter table plan_parametro_barrio drop constraint plan_parametro_orden_chk;
--> statement-breakpoint
alter table plan_parametro_barrio add constraint plan_parametro_orden_chk
  check (orden_imputacion is null or orden_imputacion in ('mas_vieja_primero', 'cuota_primero', 'expensa_primero', 'a_eleccion'));
--> statement-breakpoint
comment on column plan_parametro_barrio.orden_imputacion is
  'Qué va primero entre la cuota del plan y la expensa (0098). NULL: como la administración.';
--> statement-breakpoint
alter table plan_parametro_barrio_historia alter column orden_imputacion drop not null;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. El pago: la elección de quien registra y la marca «para revisar»
-- ---------------------------------------------------------------------------------------------
alter table pago add column orden_plan_elegido text;
--> statement-breakpoint
alter table pago add constraint pago_orden_plan_elegido_chk
  check (orden_plan_elegido is null or orden_plan_elegido in ('mas_vieja_primero', 'cuota_primero', 'expensa_primero'));
--> statement-breakpoint
alter table pago add column imputacion_para_revisar boolean not null default false;
--> statement-breakpoint
comment on column pago.orden_plan_elegido is
  'Con el orden «a elección de quien registra», el que eligió al cargar el pago a mano (0098).';
--> statement-breakpoint
comment on column pago.imputacion_para_revisar is
  'El pago entró sin intervención en un barrio «a elección»: se imputó la más vieja primero (0098).';
--> statement-breakpoint
-- El orden que rige en un barrio: el suyo; si no tiene (NULL o sin fila), el de su administración; si
-- tampoco, la más vieja. Una sola definición, para la imputación y para el trigger de abajo. `security
-- definer`: la imputación no puede caer a otro orden porque una RLS le esconda la fila de la administración.
create or replace function app.orden_plan_del_barrio(p_barrio uuid) returns text
  language sql stable security definer set search_path = public, app, pg_temp
as $$
  select coalesce(
    (select orden_imputacion from plan_parametro_barrio where barrio_id = p_barrio),
    (select pa.orden_imputacion from plan_parametro_administracion pa
       join tenant_node n on n.parent_id = pa.administracion_id
      where n.id = p_barrio),
    'mas_vieja_primero');
$$;
--> statement-breakpoint
revoke execute on function app.orden_plan_del_barrio(uuid) from public;
--> statement-breakpoint
-- Como las otras `security definer` (0093, 0097): dueña `app_job` (BYPASSRLS), también en un Postgres
-- administrado donde quien migra no es superusuario (code-reviewer, m4).
alter function app.orden_plan_del_barrio(uuid) owner to app_job;
--> statement-breakpoint
grant execute on function app.orden_plan_del_barrio(uuid) to app_request, app_job;
--> statement-breakpoint
-- `app_request` tiene update sobre `pago` (la anulación): estas dos columnas las cuida la base.
create or replace function app.pago_orden_plan_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if tg_op = 'INSERT' then
    if new.orden_plan_elegido is not null and new.origen <> 'manual' then
      raise exception 'el orden de imputación lo elige quien registra un pago a mano';
    end if;
    -- Fuera de un barrio «a elección» la imputación no mira la elección: no se guarda, para que la fila no
    -- diga «eligió X» cuando se imputó con otro orden (code-reviewer, m3).
    if new.orden_plan_elegido is not null and app.orden_plan_del_barrio(new.barrio_id) <> 'a_eleccion' then
      new.orden_plan_elegido := null;
    end if;
    -- La marca la pone solo la imputación automática.
    new.imputacion_para_revisar := false;
  else
    if new.orden_plan_elegido is distinct from old.orden_plan_elegido then
      raise exception 'un pago no se edita: se anula (con motivo) y se carga de nuevo';
    end if;
    if new.imputacion_para_revisar is distinct from old.imputacion_para_revisar and current_user::text <> 'app_job' then
      raise exception 'la marca «para revisar» la pone la imputación automática';
    end if;
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_pago_zz_orden_plan before insert or update on pago
  for each row execute function app.pago_orden_plan_antes();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. La imputación automática (v5): copia ENTERA de la v4 (`0097` §4) con los cambios `[0098]`.
-- ---------------------------------------------------------------------------------------------
create or replace function app.resolver_imputacion(p_pago_id uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_barrio      uuid;
  v_unidad      uuid;
  v_monto       numeric(14,2);
  v_fecha       date;
  v_anulado     timestamptz;
  v_orden       text;
  v_plan_orden  text; -- [0093]
  v_remanente   numeric(14,2);
  v_a_imputar   numeric(14,2);
  v_pasada      int;
  r             record;
begin
  select barrio_id, unidad_funcional_id, monto, fecha, anulado_at
    into v_barrio, v_unidad, v_monto, v_fecha, v_anulado
    from pago where id = p_pago_id for update;

  if v_barrio is null or not app.has_role_on(v_barrio,
      array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) then
    raise exception 'el pago no existe o no es de este barrio';
  end if;
  if v_anulado is not null then
    raise exception 'ese pago está anulado: no se le puede imputar nada';
  end if;
  -- [0093] El pago de un plan lo imputa solo su plan (la firma o la caída), con el monto que calculan.
  if exists (select 1 from pago where id = p_pago_id and origen = 'plan') then
    raise exception 'el pago de un plan lo imputa solo su plan';
  end if;

  select x.valor #>> '{}' into v_orden
    from app.parametro_resuelto_interno(v_barrio, 'imputacion.orden', v_fecha) x;
  if v_orden is null then
    raise exception 'el barrio no tiene orden de imputación configurado: cargalo antes de imputar este pago';
  end if;
  -- [0098] El del barrio; si no tiene (NULL o sin fila), el de su administración; si tampoco, la más vieja.
  v_plan_orden := app.orden_plan_del_barrio(v_barrio);

  v_remanente := v_monto
    - coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = p_pago_id and anulado_at is null), 0)
    - coalesce((select sum(monto_imputado) from pago_imputacion_interes where pago_id = p_pago_id and anulado_at is null), 0);
  if v_remanente <= 0 then
    return;
  end if;

  -- [0098] «A elección de quien registra»: el que eligió al cargar el pago. Si no eligió nadie (entró
  -- solo: extracto, importación), la más vieja primero, y el pago queda «para revisar» — solo si es de
  -- extracto o manual (no la reimputación de una rendición ni un saldo de activación) y si la elección
  -- importaba: la unidad debía a la vez una cuota del plan imputable y una expensa (code-reviewer, m1).
  if v_plan_orden = 'a_eleccion' then
    v_plan_orden := (select orden_plan_elegido from pago where id = p_pago_id);
    if v_plan_orden is null then
      v_plan_orden := 'mas_vieja_primero';
      if (select origen from pago where id = p_pago_id) in ('extracto', 'manual')
         and exists (select 1 from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
                      where l.unidad_funcional_id = v_unidad and pe.estado in ('emitida', 'distribuida')
                        and pe.origen = 'plan' and not app.es_cuota_del_estudio(l.id)
                        and app.saldo_de_liquidacion(l.id) > 0)
         and exists (select 1 from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
                      where l.unidad_funcional_id = v_unidad and pe.estado in ('emitida', 'distribuida')
                        and pe.origen <> 'plan' and app.saldo_de_liquidacion(l.id) > 0) then
        update pago set imputacion_para_revisar = true where id = p_pago_id and not imputacion_para_revisar;
      end if;
    end if;
  end if;

  for v_pasada in 1..2 loop
    exit when v_remanente <= 0;
    if (v_pasada = 1) = (v_orden = 'intereses_primero_capital_antiguo') then
      for r in
        select d.id, app.interes_pendiente(d.id) as saldo
          from interes_devengado d
         where d.unidad_funcional_id = v_unidad and d.monto > 0
           -- [0097] El interés de una cuota que cobra el estudio no es del barrio.
           and not app.es_cuota_del_estudio(d.liquidacion_id)
         order by d.hasta asc, d.created_at asc, d.id asc
      loop
        exit when v_remanente <= 0;
        continue when r.saldo <= 0;
        v_a_imputar := least(v_remanente, r.saldo);
        insert into pago_imputacion_interes (pago_id, interes_id, monto_imputado) values (p_pago_id, r.id, v_a_imputar);
        v_remanente := v_remanente - v_a_imputar;
      end loop;
    else
      for r in
        select l.id,
               l.importe_exigible - coalesce((
                 select sum(pi.monto_imputado) from pago_imputacion pi
                  where pi.liquidacion_id = l.id and pi.anulado_at is null
               ), 0) as saldo
          from liquidacion l
          join periodo_expensa pe on pe.id = l.periodo_id
         where l.unidad_funcional_id = v_unidad
           and pe.estado in ('emitida', 'distribuida')
           -- [0097] Una cuota que cobra el estudio solo se imputa por la rendición, nunca con un pago
           -- común al barrio, aunque el orden sea «cuota primero».
           and not (pe.origen = 'plan' and app.es_cuota_del_estudio(l.id))
         order by
           case when v_orden = 'intereses_primero_capital_antiguo' and coalesce(l.interes_mora, 0) > 0
                     and l.saldo_anterior_origen <> 'calculado'
                then 0 else 1 end,
           -- [0093] La cuota del plan, antes o después del resto según el barrio. [0098] Con «la más
           -- vieja primero», cuotas y expensas van juntas (el mismo grupo) y las ordena el vencimiento.
           case when pe.origen = 'plan' then (case v_plan_orden when 'cuota_primero' then 0 when 'expensa_primero' then 2 else 1 end) else 1 end,
           coalesce(l.vencimiento, pe.primer_vencimiento, (pe.periodo || '-01')::date) asc,
           -- [0098] A igual vencimiento, la cuota primero. Con «cuota primero» y «expensa primero» no
           -- cambia nada: la clave de arriba ya separó las cuotas de las expensas.
           case when pe.origen = 'plan' then 0 else 1 end,
           pe.periodo asc,
           l.id asc
      loop
        exit when v_remanente <= 0;
        continue when r.saldo <= 0;
        v_a_imputar := least(v_remanente, r.saldo);
        insert into pago_imputacion (pago_id, liquidacion_id, monto_imputado) values (p_pago_id, r.id, v_a_imputar);
        v_remanente := v_remanente - v_a_imputar;
      end loop;
    end if;
  end loop;
end; $$;
--> statement-breakpoint
-- La grilla de Cobros cuenta, por unidad, los pagos vivos «para revisar»: casi nunca hay, el índice es chico.
create index idx_pago_para_revisar on pago (unidad_funcional_id) where imputacion_para_revisar and anulado_at is null;
