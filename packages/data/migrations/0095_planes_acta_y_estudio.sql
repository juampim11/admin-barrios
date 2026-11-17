-- 0095 · Planes de pago: el acta de la quita y el estudio del catálogo (encargo P2a-2). Solo estructura:
-- columnas nuevas (nulas), constraints, funciones y triggers. No borra ni reescribe datos.
--
--   1. El acta de un plan a medida (`plan_pago.acta_referencia` y `acta_adjunto`): de dónde sale la
--      aprobación del órgano del barrio. Se carga al proponer o después, con el plan pendiente
--      (`app.plan_cargar_acta`). El adjunto es una subida de respaldo del barrio (la de la condonación y
--      los parámetros: `subida_respaldo_solicitada`).
--   2. Si el barrio exige el acta para una quita (`plan_parametro_barrio.quita_requiere_acta`, `0094`),
--      un plan con quita no se firma sin ella: lo frena la base, al pasar a vigente. La quita que cuenta es
--      la de la firma (la recalcula `app.plan_firmar` con la deuda de ese día).
--   3. El estudio de un plan del catálogo tiene que trabajar con la administración (vínculo activo) y en
--      cada barrio del plan. Hasta P2a-1 lo controlaba solo el servicio; ahora también la base, al guardar
--      el plan, al agregarle un barrio y al sacar el estudio de un barrio o darlo de baja.

-- ---------------------------------------------------------------------------------------------
-- 1. El acta
-- ---------------------------------------------------------------------------------------------
alter table plan_pago add column acta_referencia text;
--> statement-breakpoint
alter table plan_pago add column acta_adjunto text;
--> statement-breakpoint
alter table plan_pago add constraint plan_pago_acta_chk check (
  (acta_referencia is null or (tipo = 'a_medida' and length(acta_referencia) between 3 and 300 and acta_referencia = btrim(acta_referencia)))
  and (acta_adjunto is null or acta_referencia is not null)
);
--> statement-breakpoint
-- Mismo formato que la subida de respaldo de un barrio (`0056`): cuelga del propio barrio.
alter table plan_pago add constraint plan_pago_acta_adjunto_chk check (
  acta_adjunto is null or acta_adjunto ~ ('^barrios/' || barrio_id::text || '/parametros/respaldos/[A-Za-z0-9_-]{22,64}\.(pdf|jpg|jpeg|png)$')
);
--> statement-breakpoint
comment on column plan_pago.acta_referencia is
  'El acta del órgano del barrio que aprueba la quita (número y fecha, o dónde se encuentra). Solo planes a medida.';
--> statement-breakpoint
comment on column plan_pago.acta_adjunto is
  'Storage key del acta: una subida de respaldo del mismo barrio (subida_respaldo_solicitada).';
--> statement-breakpoint
alter table plan_evento drop constraint plan_evento_tipo_chk;
--> statement-breakpoint
alter table plan_evento add constraint plan_evento_tipo_chk
  check (tipo in ('propuesto', 'firmado', 'cuota_emitida', 'rechazado', 'retirado', 'cumplido', 'caido', 'acta_cargada'));
--> statement-breakpoint

-- El adjunto que se carga al proponer: tiene que ser una subida hecha para ese barrio. Corre como
-- `app_job` (BYPASSRLS) para ver la subida aunque la haya pedido otra persona del barrio.
create or replace function app.plan_pago_acta_valida() returns trigger
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
begin
  if new.acta_adjunto is not null and not exists (
    select 1 from subida_respaldo_solicitada s where s.storage_key = new.acta_adjunto and s.nodo_id = new.barrio_id
  ) then
    raise exception 'el acta adjunta no es una que se haya subido para este barrio';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_plan_pago_acta_valida before insert on plan_pago
  for each row execute function app.plan_pago_acta_valida();
--> statement-breakpoint

-- Cargar el acta de un plan pendiente (la administración, con el plan todavía sin aprobar).
create or replace function app.plan_cargar_acta(p_plan uuid, p_referencia text, p_adjunto text) returns void
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
declare v_plan plan_pago;
begin
  select * into v_plan from plan_pago where id = p_plan for update;
  if v_plan.id is null or not app.has_role_on(v_plan.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) then
    raise exception 'el plan no existe o no es de un barrio que administres' using errcode = '42501';
  end if;
  if v_plan.estado <> 'pendiente' or v_plan.tipo <> 'a_medida' then
    raise exception 'el acta se carga en un plan a medida pendiente';
  end if;
  if p_referencia is null or length(btrim(p_referencia)) not between 3 and 300 then
    raise exception 'el acta necesita su referencia: número y fecha, o dónde se encuentra';
  end if;
  if p_adjunto is not null and not exists (
    select 1 from subida_respaldo_solicitada s where s.storage_key = p_adjunto and s.nodo_id = v_plan.barrio_id
  ) then
    raise exception 'el acta adjunta no es una que se haya subido para este barrio';
  end if;
  -- Un acta nueva reemplaza a la anterior entera (referencia y adjunto). El evento guarda las dos: si se
  -- cambia el acta de una quita antes de aprobarla, queda escrito qué decía (revisión de seguridad).
  update plan_pago set acta_referencia = btrim(p_referencia), acta_adjunto = p_adjunto where id = p_plan;
  insert into plan_evento (plan_id, barrio_id, tipo, detalle)
  values (p_plan, v_plan.barrio_id, 'acta_cargada',
          jsonb_build_object('referencia', btrim(p_referencia), 'adjunto', p_adjunto,
                             'referenciaAnterior', v_plan.acta_referencia, 'adjuntoAnterior', v_plan.acta_adjunto));
end; $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. Sin acta no se firma una quita, si el barrio la exige
-- ---------------------------------------------------------------------------------------------
-- El acta con la que se firmó queda en el plan: después de firmado ya no cambia (`app.plan_cargar_acta`
-- exige el plan pendiente y `app.plan_pago_antes` frena cualquier otro update).
create or replace function app.plan_pago_quita_con_acta() returns trigger
  language plpgsql set search_path = public, app, pg_temp
as $$
begin
  if old.estado = 'pendiente' and new.estado = 'vigente' and new.tipo = 'a_medida'
     and new.quita_interes + new.quita_capital > 0 and new.acta_referencia is null
     and coalesce((select quita_requiere_acta from plan_parametro_barrio where barrio_id = new.barrio_id), false) then
    raise exception 'el plan tiene quita y el barrio exige el acta para aprobarla';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_plan_pago_quita_con_acta before update of estado on plan_pago
  for each row execute function app.plan_pago_quita_con_acta();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. El estudio de un plan del catálogo: de la administración y de cada barrio del plan
-- ---------------------------------------------------------------------------------------------
create or replace function app.plan_catalogo_estudio_valido() returns trigger
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
begin
  -- Sin estudio, o dado de baja: nada que controlar. Y si quien escribe no administra esa administración,
  -- que la frene la RLS con su mensaje y no este control con el suyo (no es un oráculo sobre otra).
  if new.estudio_id is null or not new.activo or new.administracion_id not in (select app.administraciones_administradas()) then
    return new;
  end if;
  if not exists (select 1 from estudio_administracion ea
                  where ea.estudio_id = new.estudio_id and ea.administracion_id = new.administracion_id and ea.activo) then
    raise exception 'el estudio del plan no trabaja con la administración';
  end if;
  -- Al cambiar el estudio (o reactivar el plan) con barrios ya cargados: tiene que trabajar en todos.
  if tg_op = 'UPDATE' and exists (
    select 1 from plan_catalogo_barrio cb
     where cb.catalogo_id = new.id
       and not exists (select 1 from estudio_barrio eb where eb.estudio_id = new.estudio_id and eb.barrio_id = cb.barrio_id)
  ) then
    raise exception 'el estudio del plan no trabaja en uno de sus barrios';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_plan_catalogo_estudio before insert or update of estudio_id, administracion_id, activo on plan_catalogo
  for each row execute function app.plan_catalogo_estudio_valido();
--> statement-breakpoint

create or replace function app.plan_catalogo_barrio_estudio() returns trigger
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
declare v_estudio uuid;
begin
  -- Solo los planes de una administración que administra quien escribe (no es un oráculo sobre otra).
  select estudio_id into v_estudio from plan_catalogo
   where id = new.catalogo_id and administracion_id in (select app.administraciones_administradas());
  if v_estudio is not null and not exists (
    select 1 from estudio_barrio eb where eb.estudio_id = v_estudio and eb.barrio_id = new.barrio_id
  ) then
    raise exception 'el estudio del plan no trabaja en uno de sus barrios';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_plan_catalogo_barrio_estudio before insert on plan_catalogo_barrio
  for each row execute function app.plan_catalogo_barrio_estudio();
--> statement-breakpoint

-- Sacar un estudio de un barrio (o darlo de baja con la administración, que lo saca de sus barrios)
-- no puede dejar un plan del catálogo activo con un estudio que ya no trabaja ahí.
create or replace function app.estudio_barrio_sin_planes() returns trigger
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
begin
  if exists (select 1 from plan_catalogo c join plan_catalogo_barrio cb on cb.catalogo_id = c.id
              where c.estudio_id = old.estudio_id and cb.barrio_id = old.barrio_id and c.activo) then
    raise exception 'el estudio está en un plan del catálogo de este barrio';
  end if;
  return old;
end; $$;
--> statement-breakpoint
create trigger trg_estudio_barrio_sin_planes before delete on estudio_barrio
  for each row execute function app.estudio_barrio_sin_planes();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Dueños y permisos (forma de `0093` §12). Todas con `pg_temp` al final del `search_path` (estándar de
-- `0069`): sin eso, una tabla temporal con el nombre de una de las que leen engañaría los controles.
-- ---------------------------------------------------------------------------------------------
do $bloque$
declare f text;
begin
  -- Dueño `app_job` (BYPASSRLS): los controles ven todo el catálogo y todos los vínculos, no solo lo que
  -- puede leer quien edita (si no, un plan que no ve se le escaparía al control).
  foreach f in array array['plan_cargar_acta(uuid, text, text)', 'plan_pago_acta_valida()', 'plan_catalogo_estudio_valido()',
                           'plan_catalogo_barrio_estudio()', 'estudio_barrio_sin_planes()'] loop
    execute format('alter function app.%s owner to app_job', f);
    execute format('revoke execute on function app.%s from public', f);
    execute format('grant execute on function app.%s to app_request, app_job', f);
  end loop;
  foreach f in array array['plan_pago_quita_con_acta()'] loop
    execute format('revoke execute on function app.%s from public', f);
    execute format('grant execute on function app.%s to app_request, app_job', f);
  end loop;
end
$bloque$;
