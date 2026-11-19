-- =============================================================================================
-- 0100 · Anular una rendición, firmante del convenio y cuatro ojos (encargo F4 tramo 3, BL-053).
-- Decisiones del titular del 18/11; la reapertura del plan cumplido, ratificada por la coordinación.
-- Solo estructura: columnas, constraints, funciones y triggers; no reescribe datos.
--
--   a. Una rendición confirmada se anula con motivo (`app.plan_rendicion_anular`): el contraasiento
--      anula los pagos `rendicion` que creó (y sus imputaciones, como `anularPago`), sin borrar nada; las
--      cuotas vuelven a su saldo anterior. Un plan que esa rendición había cumplido vuelve a «vigente»
--      (evento `reabierto`); uno caído queda caído (sus pagos ya se habían reimputado a la deuda original,
--      que vuelve a deber). La rendición queda «anulada», con quién, cuándo y por qué, y no cambia más.
--   b. Quién firma los convenios por el barrio (`plan_parametro_barrio.firmante_*`).
--   c. Cuatro ojos: con `plan_parametro_barrio.rendicion_cuatro_ojos`, quien cargó la rendición (la creó o
--      cargó la última cuota o ingreso) no la confirma.
-- Regla del repo: una migración ya aplicada NO se edita; se agrega la siguiente con prefijo mayor.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. La rendición anulada
-- ---------------------------------------------------------------------------------------------
alter table plan_rendicion add column anulada_por uuid;
--> statement-breakpoint
alter table plan_rendicion add column anulada_at timestamptz;
--> statement-breakpoint
alter table plan_rendicion add column motivo_anulacion text;
--> statement-breakpoint
alter table plan_rendicion drop constraint plan_rendicion_estado_chk;
--> statement-breakpoint
alter table plan_rendicion add constraint plan_rendicion_estado_chk check (estado in ('borrador', 'confirmada', 'anulada'));
--> statement-breakpoint
-- Una anulada se confirmó antes: conserva quién y cuándo.
alter table plan_rendicion drop constraint plan_rendicion_confirmada_chk;
--> statement-breakpoint
alter table plan_rendicion add constraint plan_rendicion_confirmada_chk
  check ((estado in ('confirmada', 'anulada')) = (confirmada_at is not null and confirmada_por is not null));
--> statement-breakpoint
alter table plan_rendicion add constraint plan_rendicion_anulada_chk
  check ((estado = 'anulada') = (anulada_at is not null and anulada_por is not null and motivo_anulacion is not null));
--> statement-breakpoint
alter table plan_rendicion add constraint plan_rendicion_motivo_anulacion_chk
  check (motivo_anulacion is null or length(btrim(motivo_anulacion)) between 5 and 1000);
--> statement-breakpoint
alter table plan_evento drop constraint plan_evento_tipo_chk;
--> statement-breakpoint
alter table plan_evento add constraint plan_evento_tipo_chk
  check (tipo in ('propuesto', 'firmado', 'cuota_emitida', 'rechazado', 'retirado', 'cumplido', 'caido', 'acta_cargada',
                  'documento_agregado', 'rendicion_confirmada', 'rendicion_anulada', 'reabierto'));
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. Las reglas de la rendición en el barrio: el firmante del convenio y los cuatro ojos
-- ---------------------------------------------------------------------------------------------
alter table plan_parametro_barrio add column rendicion_cuatro_ojos boolean not null default false;
--> statement-breakpoint
comment on column plan_parametro_barrio.rendicion_cuatro_ojos is
  'La rendición la confirma otra persona: quien la cargó no la confirma (0100).';
--> statement-breakpoint
alter table plan_parametro_barrio add column firmante_tipo text;
--> statement-breakpoint
alter table plan_parametro_barrio add column firmante_nombre text;
--> statement-breakpoint
alter table plan_parametro_barrio add column firmante_cargo text;
--> statement-breakpoint
alter table plan_parametro_barrio add column firmante_poder text;
--> statement-breakpoint
-- Sin firmante, todo vacío. Con firmante: el nombre siempre; el poder solo (y siempre) con el administrador
-- con poder delegado; el cargo solo (y siempre) con «Otro».
alter table plan_parametro_barrio add constraint plan_parametro_firmante_chk check (
     (firmante_tipo is null and firmante_nombre is null and firmante_cargo is null and firmante_poder is null)
  or (firmante_tipo in ('presidente_directorio', 'administrador_poder', 'otro')
      and length(btrim(coalesce(firmante_nombre, ''))) between 1 and 200
      and (firmante_tipo = 'administrador_poder') = (length(btrim(coalesce(firmante_poder, ''))) between 1 and 300)
      and (firmante_tipo = 'otro') = (length(btrim(coalesce(firmante_cargo, ''))) between 1 and 120)));
--> statement-breakpoint
comment on column plan_parametro_barrio.firmante_tipo is
  'Quién firma los convenios por el barrio (0100): presidente_directorio, administrador_poder u otro. NULL: como antes.';
--> statement-breakpoint
grant update (rendicion_cuatro_ojos, firmante_tipo, firmante_nombre, firmante_cargo, firmante_poder)
  on table plan_parametro_barrio to app_request;
--> statement-breakpoint
-- Los cuatro ojos son un control sobre la administración, que es quien los cambia: a la historia.
alter table plan_parametro_barrio_historia add column rendicion_cuatro_ojos boolean;
--> statement-breakpoint
create or replace function app.plan_parametro_a_la_historia() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  insert into plan_parametro_barrio_historia (barrio_id, cuotas_para_caer, orden_imputacion, financia_mora, quita_requiere_acta,
                                              rendicion_cuatro_ojos, cargado_por)
  values (new.barrio_id, new.cuotas_para_caer, new.orden_imputacion, new.financia_mora, new.quita_requiere_acta,
          new.rendicion_cuatro_ojos, new.cargado_por);
  return null;
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. Las reglas de la rendición (v2): copia ENTERA de la v1 (`0097` §6) con los cambios `[0100]`.
-- ---------------------------------------------------------------------------------------------
create or replace function app.plan_rendicion_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
declare
  v_ultimo uuid;
begin
  if tg_op = 'INSERT' then
    new.estado := 'borrador';
    new.confirmada_por := null;
    new.confirmada_at := null;
    -- [0100]
    new.anulada_por := null;
    new.anulada_at := null;
    new.motivo_anulacion := null;
    new.creado_por := app.current_user_id();
    new.created_at := now();
    if not app.has_role_on(new.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) then
      return new; -- la frena la RLS
    end if;
    if not exists (select 1 from estudio_administracion ea
                    where ea.estudio_id = new.estudio_id
                      and ea.administracion_id = (select tb.parent_id from tenant_node tb where tb.id = new.barrio_id)) then
      raise exception 'ese estudio no existe o no trabaja con la administración de este barrio';
    end if;
    return new;
  end if;
  -- [0100] Una anulada no cambia más.
  if old.estado = 'anulada' then
    raise exception 'la rendición está anulada: no se modifica';
  end if;
  -- [0100] Confirmada, lo único que puede pasarle es anularse, y solo por `app.plan_rendicion_anular`
  -- (`app_job`): cambian el estado y los tres datos de la anulación, nada más.
  if old.estado = 'confirmada' then
    if new.estado = 'anulada' and current_user::text = 'app_job'
       and (new.id, new.barrio_id, new.estudio_id, new.periodo, new.creado_por, new.created_at, new.documento_clave,
            new.documento_sha256, new.documento_bytes, new.documento_nombre, new.confirmada_por, new.confirmada_at)
           is not distinct from
           (old.id, old.barrio_id, old.estudio_id, old.periodo, old.creado_por, old.created_at, old.documento_clave,
            old.documento_sha256, old.documento_bytes, old.documento_nombre, old.confirmada_por, old.confirmada_at) then
      return new;
    end if;
    raise exception 'la rendición ya está confirmada: no se modifica';
  end if;
  -- UPDATE: lo confirmado no cambia; en borrador cambian el período y el PDF. El estado lo cambia solo
  -- la confirmación (`app_job`).
  if new.id <> old.id or new.barrio_id <> old.barrio_id or new.estudio_id <> old.estudio_id
     or new.creado_por <> old.creado_por or new.created_at <> old.created_at then
    raise exception 'de una rendición solo cambian el período y el PDF';
  end if;
  -- [0100] Un borrador no se anula: se corrige (se quitan cuotas o ingresos).
  if new.estado = 'anulada' or (new.anulada_por, new.anulada_at, new.motivo_anulacion) is distinct from (old.anulada_por, old.anulada_at, old.motivo_anulacion) then
    raise exception 'una rendición en borrador no se anula: se corrige';
  end if;
  if (new.estado, new.confirmada_por, new.confirmada_at) is distinct from (old.estado, old.confirmada_por, old.confirmada_at)
     and current_user::text <> 'app_job' then
    raise exception 'la rendición se confirma con «Confirmar la rendición»' using errcode = '42501';
  end if;
  if new.estado = 'confirmada' then
    -- Defensa en profundidad: se confirma solo con los pagos ya creados por la suma de sus cuotas.
    if coalesce((select sum(importe) from plan_rendicion_pago where rendicion_id = new.id), 0)
       <> coalesce((select sum(importe) from plan_rendicion_cuota where rendicion_id = new.id), -1) then
      raise exception 'la rendición se confirma con los pagos de todas sus cuotas';
    end if;
    -- El mismo PDF firmado no respalda dos rendiciones confirmadas del barrio.
    if exists (select 1 from plan_rendicion r where r.barrio_id = new.barrio_id and r.id <> new.id
                  and r.estado = 'confirmada' and r.documento_sha256 = new.documento_sha256) then
      raise exception 'ese PDF ya respalda otra rendición confirmada del barrio';
    end if;
    -- [0100] Cuatro ojos: si el barrio lo pide, quien la cargó (la creó, o cargó la última cuota o ingreso)
    -- no la confirma. `app.current_user_id()` es la persona que confirma (la sesión), no `app_job`.
    if coalesce((select rendicion_cuatro_ojos from plan_parametro_barrio where barrio_id = new.barrio_id), false) then
      select x.cargado_por into v_ultimo
        from (select cargado_por, created_at, id from plan_rendicion_cuota where rendicion_id = new.id
              union all
              select cargado_por, created_at, id from plan_rendicion_ingreso where rendicion_id = new.id) x
       order by x.created_at desc, x.id desc limit 1;
      if app.current_user_id() = new.creado_por or app.current_user_id() is not distinct from v_ultimo then
        raise exception 'la confirma otra persona de la administración';
      end if;
    end if;
  end if;
  return new;
end; $$;
--> statement-breakpoint

-- Las cuotas y los ingresos (v2): copia ENTERA de la v1 (`0097` §6); `[0100]`, el mensaje de una anulada.
create or replace function app.plan_rendicion_hijo_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
declare
  v_rendicion uuid := case when tg_op = 'DELETE' then old.rendicion_id else new.rendicion_id end;
  v_estado    text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'una cuota o un ingreso de la rendición no se edita: se quita y se carga de nuevo';
  end if;
  -- Primero el rol (la carga la administración): sin él, el candado de abajo no ve la fila y el mensaje
  -- sería otro.
  if not app.has_role_on(case when tg_op = 'DELETE' then old.barrio_id else new.barrio_id end,
                         array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) then
    raise exception 'la rendición la carga la administración del barrio' using errcode = '42501';
  end if;
  select estado into v_estado from plan_rendicion where id = v_rendicion for share;
  if v_estado = 'anulada' then
    raise exception 'la rendición está anulada: no se modifica';
  end if;
  if v_estado is distinct from 'borrador' then
    raise exception 'la rendición ya está confirmada (o no existe): no se modifica';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  new.cargado_por := app.current_user_id();
  return new;
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. Anular una rendición confirmada. Una sola transacción, con los candados de la confirmación (la
--    rendición con el rol en el `where`, el barrio, las unidades por id). `security definer`, dueña
--    `app_job`: anula pagos de rendición e imputaciones (que el camino normal no deja) y reabre planes.
--    La identidad es la de la sesión (`app.current_user_id()`): queda como quien anuló.
-- ---------------------------------------------------------------------------------------------
create or replace function app.plan_rendicion_anular(p_rendicion uuid, p_motivo text) returns integer
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
declare
  v_r       plan_rendicion;
  v_motivo  text := btrim(coalesce(p_motivo, ''));
  v_usuario uuid := app.current_user_id();
  v_n       integer;
  u         record;
  p         record;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión';
  end if;
  select * into v_r from plan_rendicion
   where id = p_rendicion
     and app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[])
     for update;
  if v_r.id is null then
    raise exception 'la rendición no existe o no es de un barrio que administres' using errcode = '42501';
  end if;
  if v_r.estado = 'anulada' then
    raise exception 'la rendición ya está anulada';
  end if;
  if v_r.estado <> 'confirmada' then
    raise exception 'la rendición está en borrador: se corrige sin anularla';
  end if;
  if length(v_motivo) < 5 then
    raise exception 'la anulación de una rendición necesita un motivo';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('deuda-anterior:' || v_r.barrio_id::text, 0));
  for u in
    select distinct pg.unidad_funcional_id from plan_rendicion_pago rp join pago pg on pg.id = rp.pago_id
     where rp.rendicion_id = p_rendicion order by pg.unidad_funcional_id
  loop
    perform app.serializar_cobros_de_unidad(u.unidad_funcional_id);
  end loop;

  -- Si el plan había caído, los pagos se reimputaron a la deuda de la unidad. Si esa deuda está ahora en otro
  -- plan vigente o cumplido (que la canceló al firmarse), reabrirla rompería ese plan: es lo que el bloqueo
  -- normal de una anulación (`app.plan_bloqueo_anulacion`) rechaza, y acá también (code-reviewer, M1).
  if exists (select 1 from plan_rendicion_pago rp
               join plan_cuota pc on pc.id = rp.plan_cuota_id
               join pago_imputacion pi on pi.pago_id = rp.pago_id and pi.anulado_at is null
               join plan_liquidacion pl on pl.liquidacion_id = pi.liquidacion_id
               join plan_pago pp on pp.id = pl.plan_id and pp.estado in ('vigente', 'cumplido') and pp.id <> pc.plan_id
              where rp.rendicion_id = p_rendicion)
     or exists (select 1 from plan_rendicion_pago rp
                  join plan_cuota pc on pc.id = rp.plan_cuota_id
                  join pago_imputacion_interes pii on pii.pago_id = rp.pago_id and pii.anulado_at is null
                  join interes_devengado d on d.id = pii.interes_id
                  join plan_liquidacion pl on pl.liquidacion_id = d.liquidacion_id
                  join plan_pago pp on pp.id = pl.plan_id and pp.estado in ('vigente', 'cumplido') and pp.id <> pc.plan_id
                 where rp.rendicion_id = p_rendicion) then
    raise exception 'la deuda que cubrió la rendición está ahora en otro plan vigente o cumplido: no se anula';
  end if;

  -- El contraasiento: lo mismo que `anularPago` (las imputaciones vivas a capital y a interés, y el pago),
  -- con el mismo motivo. Si el plan había caído, las imputaciones vivas son las de la deuda original: esa
  -- deuda vuelve a deber.
  update pago_imputacion set anulado_at = now(), anulado_por = v_usuario, motivo_anulacion = v_motivo
   where pago_id in (select pago_id from plan_rendicion_pago where rendicion_id = p_rendicion) and anulado_at is null;
  update pago_imputacion_interes set anulado_at = now(), anulado_por = v_usuario, motivo_anulacion = v_motivo
   where pago_id in (select pago_id from plan_rendicion_pago where rendicion_id = p_rendicion) and anulado_at is null;
  update pago set anulado_at = now(), anulado_por = v_usuario, motivo_anulacion = v_motivo
   where id in (select pago_id from plan_rendicion_pago where rendicion_id = p_rendicion) and anulado_at is null;
  get diagnostics v_n = row_count;

  -- Un plan que esta rendición había cumplido y ahora vuelve a deber: otra vez vigente (ratificado por la
  -- coordinación, F4 tramo 3). Si la unidad ya tiene otro plan abierto, no se reabre: se frena todo.
  for p in
    select distinct pp.id, pp.barrio_id, pp.unidad_funcional_id
      from plan_rendicion_cuota rc join plan_cuota pc on pc.id = rc.plan_cuota_id join plan_pago pp on pp.id = pc.plan_id
     where rc.rendicion_id = p_rendicion and pp.estado = 'cumplido'
       and exists (select 1 from plan_cuota c where c.plan_id = pp.id
                    and (c.liquidacion_id is null or app.saldo_de_liquidacion(c.liquidacion_id) > 0))
  loop
    if exists (select 1 from plan_pago o where o.unidad_funcional_id = p.unidad_funcional_id and o.id <> p.id
                  and o.estado in ('vigente', 'pendiente')) then
      raise exception 'la rendición cumplió un plan de una unidad que ya tiene otro plan abierto: resolvé ese plan antes de anular';
    end if;
    update plan_pago set estado = 'vigente', cerrado_at = null where id = p.id;
    insert into plan_evento (plan_id, barrio_id, tipo, detalle)
    values (p.id, p.barrio_id, 'reabierto', jsonb_build_object('rendicionId', p_rendicion, 'motivo', v_motivo));
  end loop;

  update plan_rendicion set estado = 'anulada', anulada_por = v_usuario, anulada_at = now(), motivo_anulacion = v_motivo
   where id = p_rendicion;

  insert into plan_evento (plan_id, barrio_id, tipo, detalle)
  select pc.plan_id, v_r.barrio_id, 'rendicion_anulada',
         jsonb_build_object('rendicionId', p_rendicion, 'periodo', v_r.periodo, 'motivo', v_motivo,
                            'importe', sum(rc.importe), 'cuotas', jsonb_agg(pc.numero order by pc.numero))
    from plan_rendicion_cuota rc join plan_cuota pc on pc.id = rc.plan_cuota_id
   where rc.rendicion_id = p_rendicion
   group by pc.plan_id;
  return v_n;
end; $$;
--> statement-breakpoint
revoke execute on function app.plan_rendicion_anular(uuid, text) from public;
--> statement-breakpoint
alter function app.plan_rendicion_anular(uuid, text) owner to app_job;
--> statement-breakpoint
grant execute on function app.plan_rendicion_anular(uuid, text) to app_request;
