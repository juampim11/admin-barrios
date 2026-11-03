-- =============================================================================================
-- 0062_interes_devengado — el circuito de la deuda: interés por pago fuera de término, interés que
-- se imputa y se condona, y la boleta siguiente que lo cobra (ADR-0009, BL-021).
--
-- EL MODELO, EN CUATRO RENGLONES
--   · El CAPITAL es lo que cada liquidación suma a la deuda (`importe_exigible`).
--   · El INTERÉS es una fila de `interes_devengado`: el interés del capital pendiente de UNA
--     liquidación en un tramo (de su vencimiento, o del tramo anterior, hasta un pago tardío o hasta
--     el corte de la boleta siguiente). Es un débito de la cuenta corriente.
--   · Un pago se imputa a capital (`pago_imputacion`) y a interés (`pago_imputacion_interes`), en el
--     orden de imputación del barrio (T1).
--   · Una CONDONACIÓN (`interes_condonacion`) compensa interés devengado y no pagado. No borra nada.
--
-- Todo es append-only. El interés lo calcula la aplicación (`@admin-barrios/shared/
-- interes-pago-tardio`, sobre el motor de T1); la base garantiza que cada tramo arranque donde
-- terminó el anterior, que su base sea el capital pendiente de ese momento, y los topes.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. `importe_exigible` con saldo calculado excluye también el interés por mora de la boleta: ese
--    interés ya es deuda en `interes_devengado` (lo pendiente de antes y el tramo al corte, que se
--    registra al emitir). Con cualquier otro origen, igual que `0060`: ninguna fila cambia.
--    En Postgres 16 una expresión generada no se altera: se tira la vista que la usa y la columna, y
--    se vuelven a crear (la vista, más abajo, ya con los movimientos de interés).
-- ---------------------------------------------------------------------------------------------
drop view app.v_estado_cuenta_uf;
--> statement-breakpoint
alter table liquidacion drop column importe_exigible;
--> statement-breakpoint
alter table liquidacion add column importe_exigible numeric(14,2)
  generated always as (
    total - case when saldo_anterior_origen = 'calculado' then saldo_anterior + coalesce(interes_mora, 0) else 0 end
  ) stored;
--> statement-breakpoint
comment on column liquidacion.importe_exigible is
  'Lo que esta liquidación suma a la deuda (capital). Con saldo anterior calculado no incluye ni el '
  'saldo anterior ni el interés por mora: los dos ya son deuda (la liquidación vieja y '
  'interes_devengado). Con cualquier otro origen, igual al total (0060, 0062).';
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. El interés devengado.
-- ---------------------------------------------------------------------------------------------
create table interes_devengado (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  unidad_funcional_id uuid not null references unidad_funcional (id) on delete restrict,
  liquidacion_id uuid not null references liquidacion (id) on delete restrict,
  -- Qué cerró el tramo: un pago tardío, o el corte de la boleta siguiente (al emitirla).
  origen text not null,
  pago_id uuid references pago (id) on delete restrict,
  periodo_id uuid references periodo_expensa (id) on delete restrict,
  desde date not null,
  hasta date not null,
  desde_vencimiento boolean not null,
  base numeric(14,2) not null,
  monto numeric(14,2) not null,
  compensatorio numeric(14,2) not null default 0,
  punitorio numeric(14,2) not null default 0,
  interes_calculado numeric(14,2) not null,
  no_cobrado_por_tolerancia boolean not null default false,
  dias integer not null,
  dias_devengados integer not null default 0,
  parametros jsonb,
  creado_por uuid,
  created_at timestamptz not null default now(),
  constraint interes_devengado_origen_chk check (
    (origen = 'pago' and pago_id is not null and periodo_id is null)
    or (origen = 'corte' and periodo_id is not null and pago_id is null)),
  constraint interes_devengado_tramo_chk check (hasta > desde and dias = hasta - desde),
  constraint interes_devengado_montos_chk check (
    base > 0 and monto >= 0 and interes_calculado >= 0 and monto = compensatorio + punitorio),
  constraint interes_devengado_tolerancia_chk check (
    (no_cobrado_por_tolerancia and monto = 0) or (not no_cobrado_por_tolerancia and monto > 0 and monto = interes_calculado))
);
--> statement-breakpoint
create index idx_interes_devengado_liquidacion on interes_devengado (liquidacion_id, hasta);
--> statement-breakpoint
create index idx_interes_devengado_unidad on interes_devengado (unidad_funcional_id);
--> statement-breakpoint
create index idx_interes_devengado_barrio on interes_devengado (barrio_id);
--> statement-breakpoint
create unique index uq_interes_devengado_tramo on interes_devengado (liquidacion_id, desde);
--> statement-breakpoint

-- El capital pendiente de una liquidación: lo que suma a la deuda menos lo imputado a ella.
create or replace function app.capital_pendiente(p_liquidacion uuid) returns numeric
  language sql stable security definer set search_path = public, app
as $$
  select l.importe_exigible - coalesce((
    select sum(pi.monto_imputado) from pago_imputacion pi
     where pi.liquidacion_id = l.id and pi.anulado_at is null), 0)
    from liquidacion l where l.id = p_liquidacion
$$;
--> statement-breakpoint
alter function app.capital_pendiente(uuid) owner to app_job;
--> statement-breakpoint

create or replace function app.interes_devengado_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario  uuid := app.current_user_id();
  v_barrio   uuid;
  v_unidad   uuid;
  v_estado   app.estado_periodo;
  v_vto      date;
  v_ultimo   date;
  v_pendiente numeric(14,2);
begin
  if tg_op <> 'INSERT' then
    raise exception 'el interés devengado no se edita ni se borra: se compensa (imputación o condonación)';
  end if;
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un interés sin autor no se registra';
  end if;

  select l.barrio_id, l.unidad_funcional_id, pe.estado, pe.primer_vencimiento
    into v_barrio, v_unidad, v_estado, v_vto
    from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
   where l.id = new.liquidacion_id for update of l;
  if v_barrio is null or not app.has_role_on(v_barrio,
      array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) then
    raise exception 'la liquidación no existe o no tenés permiso para registrar su interés';
  end if;
  if v_estado not in ('emitida', 'distribuida') or v_vto is null then
    raise exception 'solo devenga interés una liquidación emitida y con vencimiento';
  end if;

  new.barrio_id := v_barrio;
  new.unidad_funcional_id := v_unidad;
  new.creado_por := v_usuario;
  new.created_at := now();

  -- Los tramos van uno detrás del otro, sin huecos ni solapes: el primero arranca en el vencimiento
  -- (y es el único que cuenta la gracia); los siguientes, donde terminó el anterior.
  select max(hasta) into v_ultimo from interes_devengado where liquidacion_id = new.liquidacion_id;
  if new.desde <> coalesce(v_ultimo, v_vto) or new.desde_vencimiento <> (v_ultimo is null) then
    raise exception 'el tramo de interés tiene que empezar donde terminó el anterior (%): no se recalcula hacia atrás',
      coalesce(v_ultimo, v_vto);
  end if;

  -- La base es el capital pendiente de ESE momento: si cambió (otro pago se imputó), el cálculo
  -- quedó viejo y se rechaza.
  v_pendiente := app.capital_pendiente(new.liquidacion_id);
  if new.base <> v_pendiente then
    raise exception 'la base del interés (%) no es el capital pendiente de la liquidación (%): recalculá', new.base, v_pendiente;
  end if;

  if new.origen = 'pago' and not exists (
      select 1 from pago p where p.id = new.pago_id and p.unidad_funcional_id = v_unidad
         and p.anulado_at is null and p.fecha = new.hasta) then
    raise exception 'el pago que cierra el tramo no es de esta unidad, está anulado o no es de la fecha del tramo';
  end if;
  if new.origen = 'corte' and not exists (
      select 1 from periodo_expensa pe where pe.id = new.periodo_id and pe.barrio_id = v_barrio) then
    raise exception 'el período que cierra el tramo no es de este barrio';
  end if;
  return new;
end; $$;
--> statement-breakpoint
alter function app.interes_devengado_antes() owner to app_job;
--> statement-breakpoint
create trigger trg_interes_devengado_antes before insert or update or delete on interes_devengado
  for each row execute function app.interes_devengado_antes();
--> statement-breakpoint

-- El débito en la cuenta corriente.
create or replace function app.interes_devengado_despues() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  if new.monto > 0 then
    insert into saldo_uf (barrio_id, unidad_funcional_id, saldo_actual, fecha_ultimo_movimiento)
    values (new.barrio_id, new.unidad_funcional_id, new.monto, new.hasta)
    on conflict (barrio_id, unidad_funcional_id) do update
       set saldo_actual = saldo_uf.saldo_actual + excluded.saldo_actual,
           fecha_ultimo_movimiento = greatest(coalesce(saldo_uf.fecha_ultimo_movimiento, excluded.fecha_ultimo_movimiento),
                                              excluded.fecha_ultimo_movimiento);
  end if;
  return null;
end; $$;
--> statement-breakpoint
alter function app.interes_devengado_despues() owner to app_job;
--> statement-breakpoint
create trigger trg_interes_devengado_despues after insert on interes_devengado
  for each row execute function app.interes_devengado_despues();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. La imputación de un pago al interés. Hermana de `pago_imputacion`: mismo patrón de anulación,
--    y el remanente del pago se cuenta entre las dos tablas.
-- ---------------------------------------------------------------------------------------------
create table pago_imputacion_interes (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  pago_id uuid not null references pago (id) on delete restrict,
  interes_id uuid not null references interes_devengado (id) on delete restrict,
  monto_imputado numeric(14,2) not null,
  anulado_at timestamptz,
  anulado_por uuid,
  motivo_anulacion text,
  created_at timestamptz not null default now(),
  constraint pago_imputacion_interes_monto_chk check (monto_imputado > 0),
  constraint pago_imputacion_interes_anulacion_chk check (
    (anulado_at is null and anulado_por is null and motivo_anulacion is null)
    or (anulado_at is not null and anulado_por is not null and motivo_anulacion is not null))
);
--> statement-breakpoint
create index idx_pago_imputacion_interes_pago on pago_imputacion_interes (pago_id);
--> statement-breakpoint
create index idx_pago_imputacion_interes_interes on pago_imputacion_interes (interes_id);
--> statement-breakpoint

create or replace function app.pago_imputacion_interes_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_roles constant app.rol_membership[] := array['admin_plataforma','admin_barrio','operador']::app.rol_membership[];
  v_barrio uuid;
  v_unidad uuid;
  v_monto numeric(14,2);
  v_remanente numeric(14,2);
  v_pendiente numeric(14,2);
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: una imputación sin autor no se registra';
  end if;

  if tg_op = 'INSERT' then
    select barrio_id, unidad_funcional_id, monto into v_barrio, v_unidad, v_monto
      from pago where id = new.pago_id and anulado_at is null for update;
    if v_barrio is null or not app.has_role_on(v_barrio, v_roles) then
      raise exception 'el pago no existe, está anulado o no es de este barrio';
    end if;
    perform 1 from interes_devengado d where d.id = new.interes_id and d.unidad_funcional_id = v_unidad for update;
    if not found then
      raise exception 'ese interés no es de la unidad del pago';
    end if;
    new.barrio_id := v_barrio;

    v_pendiente := app.interes_pendiente(new.interes_id);
    if new.monto_imputado > v_pendiente then
      raise exception 'el importe imputado (%) supera el interés pendiente (%): no se sobre-imputa', new.monto_imputado, v_pendiente;
    end if;
    v_remanente := v_monto
      - coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = new.pago_id and anulado_at is null), 0)
      - coalesce((select sum(monto_imputado) from pago_imputacion_interes where pago_id = new.pago_id and anulado_at is null), 0);
    if new.monto_imputado > v_remanente then
      raise exception 'el importe imputado (%) supera lo que le queda sin asignar a este pago (%)', new.monto_imputado, v_remanente;
    end if;

    new.anulado_at := null; new.anulado_por := null; new.motivo_anulacion := null; new.created_at := now();
    update saldo_uf set saldo_actual = saldo_actual - new.monto_imputado, fecha_ultimo_movimiento = current_date
     where barrio_id = v_barrio and unidad_funcional_id = v_unidad;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if not app.has_role_on(new.barrio_id, v_roles) then
      raise exception 'no tenés permiso para modificar imputaciones en este barrio';
    end if;
    if (new.barrio_id, new.pago_id, new.interes_id, new.monto_imputado, new.created_at)
       is distinct from (old.barrio_id, old.pago_id, old.interes_id, old.monto_imputado, old.created_at) then
      raise exception 'una imputación no se edita: se anula (con motivo) y se carga otra';
    end if;
    if old.anulado_at is not null then
      raise exception 'la anulación de una imputación no se revierte ni se reescribe';
    end if;
    if new.anulado_at is not null then
      new.anulado_at := now();
      new.anulado_por := v_usuario;
      update saldo_uf set saldo_actual = saldo_actual + old.monto_imputado, fecha_ultimo_movimiento = current_date
       where barrio_id = old.barrio_id
         and unidad_funcional_id = (select unidad_funcional_id from pago where id = old.pago_id);
    end if;
    return new;
  end if;

  raise exception 'una imputación no se borra: se anula, con motivo';
end; $$;
--> statement-breakpoint
alter function app.pago_imputacion_interes_antes() owner to app_job;
--> statement-breakpoint
create trigger trg_pago_imputacion_interes_antes before insert or update or delete on pago_imputacion_interes
  for each row execute function app.pago_imputacion_interes_antes();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. La condonación del interés. Append-only: no se anula ni se edita (un error se corrige con… no
--    se corrige: lo condonado ya no es deuda; si hay que volver a cobrarlo, es un cargo nuevo).
--    Solo administración: `admin_barrio` o `admin_plataforma`. Queda registrado con qué rol se hizo
--    (legal-ph: el operador del software no es un órgano del barrio).
-- ---------------------------------------------------------------------------------------------
create table interes_condonacion (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  unidad_funcional_id uuid not null references unidad_funcional (id) on delete restrict,
  interes_id uuid not null references interes_devengado (id) on delete restrict,
  monto numeric(14,2) not null,
  motivo text not null,
  detalle text not null,
  respaldo_tipo text,
  respaldo_referencia text,
  respaldo_adjunto text,
  origen text not null,
  pago_id uuid references pago (id) on delete restrict,
  rol_al_condonar text not null,
  creado_por uuid not null,
  created_at timestamptz not null default now(),
  constraint interes_condonacion_monto_chk check (monto > 0),
  constraint interes_condonacion_motivo_chk check (motivo in ('negociacion', 'comision_asamblea', 'error', 'otro')),
  constraint interes_condonacion_detalle_chk check (length(btrim(detalle)) >= 10),
  constraint interes_condonacion_origen_chk check (
    (origen = 'pago' and pago_id is not null) or (origen = 'estado_cuenta' and pago_id is null)),
  constraint interes_condonacion_respaldo_tipo_chk check (
    respaldo_tipo is null or respaldo_tipo in ('reglamento', 'acta_asamblea', 'acta_comision', 'otro')),
  constraint interes_condonacion_respaldo_par_chk check ((respaldo_tipo is null) = (respaldo_referencia is null)),
  constraint interes_condonacion_respaldo_adjunto_chk check (respaldo_adjunto is null or respaldo_tipo is not null),
  constraint interes_condonacion_respaldo_key_chk check (respaldo_adjunto is null or respaldo_adjunto ~
    ('^barrios/' || barrio_id::text || '/parametros/respaldos/[A-Za-z0-9_-]{22,64}\.(pdf|jpg|jpeg|png)$'))
);
--> statement-breakpoint
create index idx_interes_condonacion_interes on interes_condonacion (interes_id);
--> statement-breakpoint
create index idx_interes_condonacion_barrio on interes_condonacion (barrio_id, created_at);
--> statement-breakpoint

create or replace function app.interes_condonacion_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_barrio uuid;
  v_unidad uuid;
  v_pendiente numeric(14,2);
begin
  if tg_op <> 'INSERT' then
    raise exception 'una condonación no se edita ni se borra: queda en el registro';
  end if;
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: una condonación sin autor no se registra';
  end if;
  select d.barrio_id, d.unidad_funcional_id into v_barrio, v_unidad
    from interes_devengado d where d.id = new.interes_id for update;
  if v_barrio is null or not app.has_role_on(v_barrio, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
    raise exception 'condonar interés es de la administración del barrio';
  end if;
  new.barrio_id := v_barrio;
  new.unidad_funcional_id := v_unidad;
  new.creado_por := v_usuario;
  new.created_at := now();
  new.rol_al_condonar := case when app.has_role_on(v_barrio, array['admin_barrio']::app.rol_membership[])
                              then 'admin_barrio' else 'admin_plataforma' end;

  -- Solo lo devengado y no pagado: lo ya imputado no se condona.
  v_pendiente := app.interes_pendiente(new.interes_id);
  if new.monto > v_pendiente then
    raise exception 'se quiere condonar % y el interés pendiente es %: lo pagado no se condona', new.monto, v_pendiente;
  end if;
  if new.pago_id is not null and not exists (
      select 1 from pago p where p.id = new.pago_id and p.unidad_funcional_id = v_unidad) then
    raise exception 'el pago de la condonación no es de esta unidad';
  end if;
  if new.respaldo_adjunto is not null and not exists (
      select 1 from subida_respaldo_solicitada s where s.storage_key = new.respaldo_adjunto and s.nodo_id = v_barrio) then
    raise exception 'el adjunto del respaldo no es uno que se haya subido para este barrio';
  end if;

  update saldo_uf set saldo_actual = saldo_actual - new.monto, fecha_ultimo_movimiento = current_date
   where barrio_id = v_barrio and unidad_funcional_id = v_unidad;
  return new;
end; $$;
--> statement-breakpoint
alter function app.interes_condonacion_antes() owner to app_job;
--> statement-breakpoint
create trigger trg_interes_condonacion_antes before insert or update or delete on interes_condonacion
  for each row execute function app.interes_condonacion_antes();
--> statement-breakpoint
-- El interés pendiente de una fila: lo devengado menos lo imputado y lo condonado.
create or replace function app.interes_pendiente(p_interes uuid) returns numeric
  language sql stable security definer set search_path = public, app
as $$
  select d.monto
         - coalesce((select sum(pii.monto_imputado) from pago_imputacion_interes pii
                      where pii.interes_id = d.id and pii.anulado_at is null), 0)
         - coalesce((select sum(c.monto) from interes_condonacion c where c.interes_id = d.id), 0)
    from interes_devengado d where d.id = p_interes
$$;
--> statement-breakpoint

alter function app.interes_pendiente(uuid) owner to app_job;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 5. RLS y grants de las tres tablas: se leen dentro del barrio; se escriben por la app con la
--    identidad puesta (los triggers deciden quién y cuánto).
-- ---------------------------------------------------------------------------------------------
alter table interes_devengado enable row level security;
--> statement-breakpoint
alter table interes_devengado force row level security;
--> statement-breakpoint
create policy interes_devengado_sel on interes_devengado for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy interes_devengado_ins on interes_devengado for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint
alter table pago_imputacion_interes enable row level security;
--> statement-breakpoint
alter table pago_imputacion_interes force row level security;
--> statement-breakpoint
create policy pago_imputacion_interes_sel on pago_imputacion_interes for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy pago_imputacion_interes_ins on pago_imputacion_interes for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint
create policy pago_imputacion_interes_upd on pago_imputacion_interes for update
  using (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]))
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint
alter table interes_condonacion enable row level security;
--> statement-breakpoint
alter table interes_condonacion force row level security;
--> statement-breakpoint
create policy interes_condonacion_sel on interes_condonacion for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy interes_condonacion_ins on interes_condonacion for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
grant select, insert on table interes_devengado to app_request;
--> statement-breakpoint
grant select, insert, update on table pago_imputacion_interes to app_request;
--> statement-breakpoint
grant select, insert on table interes_condonacion to app_request;
--> statement-breakpoint
grant select on table interes_devengado, pago_imputacion_interes, interes_condonacion to app_job;
--> statement-breakpoint
grant execute on function app.capital_pendiente(uuid), app.interes_pendiente(uuid) to app_request, app_job;
--> statement-breakpoint
revoke execute on function app.interes_devengado_antes(), app.interes_devengado_despues(),
  app.pago_imputacion_interes_antes(), app.interes_condonacion_antes() from public;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 6. La imputación automática, con el interés: «Intereses primero» cubre primero el interés
--    pendiente de la unidad (el más antiguo primero) y después el capital; «Capital primero», al
--    revés. El capital va en el mismo orden que `0057`. Sin filas de interés —todo lo que existía
--    antes de esta migración—, resuelve exactamente igual que antes.
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

  select x.valor #>> '{}' into v_orden
    from app.parametro_resuelto_interno(v_barrio, 'imputacion.orden', v_fecha) x;
  if v_orden is null then
    raise exception 'el barrio no tiene orden de imputación configurado: cargalo antes de imputar este pago';
  end if;

  v_remanente := v_monto
    - coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = p_pago_id and anulado_at is null), 0)
    - coalesce((select sum(monto_imputado) from pago_imputacion_interes where pago_id = p_pago_id and anulado_at is null), 0);
  if v_remanente <= 0 then
    return;
  end if;

  -- Dos pasadas: interés y capital, en el orden del barrio.
  for v_pasada in 1..2 loop
    exit when v_remanente <= 0;
    if (v_pasada = 1) = (v_orden = 'intereses_primero_capital_antiguo') then
      for r in
        select d.id, app.interes_pendiente(d.id) as saldo
          from interes_devengado d
         where d.unidad_funcional_id = v_unidad and d.monto > 0
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
         order by
           case when v_orden = 'intereses_primero_capital_antiguo' and coalesce(l.interes_mora, 0) > 0
                     and l.saldo_anterior_origen <> 'calculado'
                then 0 else 1 end,
           l.created_at asc,
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
alter function app.resolver_imputacion(uuid) owner to app_job;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 7. La vista del estado de cuenta, con los movimientos de interés y una columna nueva al final,
--    `concepto`, para que la pantalla los nombre.
-- ---------------------------------------------------------------------------------------------
create view app.v_estado_cuenta_uf with (security_invoker = true) as
with movimientos as (
  select l.unidad_funcional_id, l.barrio_id, pe.emitida_at::date as fecha, l.id as origen_id,
         'debito'::text as tipo, l.importe_exigible as monto, 'liquidacion'::text as concepto
    from liquidacion l
    join periodo_expensa pe on pe.id = l.periodo_id
   where pe.estado in ('emitida', 'distribuida')
  union all
  select pg.unidad_funcional_id, pg.barrio_id, pg.fecha, pi.id, 'credito', -pi.monto_imputado, 'pago'
    from pago_imputacion pi
    join pago pg on pg.id = pi.pago_id
   where pi.anulado_at is null and pg.anulado_at is null
  union all
  select d.unidad_funcional_id, d.barrio_id, d.hasta, d.id, 'debito', d.monto, 'interes'
    from interes_devengado d
   where d.monto > 0
  union all
  select pg.unidad_funcional_id, pg.barrio_id, pg.fecha, pii.id, 'credito', -pii.monto_imputado, 'pago_interes'
    from pago_imputacion_interes pii
    join pago pg on pg.id = pii.pago_id
   where pii.anulado_at is null and pg.anulado_at is null
  union all
  select c.unidad_funcional_id, c.barrio_id, (c.created_at at time zone b.zona_horaria)::date, c.id, 'credito', -c.monto, 'condonacion'
    from interes_condonacion c
    join barrio b on b.barrio_id = c.barrio_id
)
select unidad_funcional_id, barrio_id, fecha, origen_id, tipo, monto,
       sum(monto) over (partition by unidad_funcional_id order by fecha, origen_id rows unbounded preceding) as saldo_corriente,
       concepto
  from movimientos;
--> statement-breakpoint
grant select on app.v_estado_cuenta_uf to app_request, app_job;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 8. El tope de una imputación a capital: el remanente del pago descuenta también lo imputado a
--    interés. Copia de la versión de `0060`; lo único nuevo está marcado `[0062]`.
-- ---------------------------------------------------------------------------------------------
create or replace function app.pago_imputacion_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario  uuid := app.current_user_id();
  v_roles    constant app.rol_membership[] :=
    array['admin_plataforma','admin_barrio','operador']::app.rol_membership[];
  v_barrio_pago      uuid;
  v_unidad_pago      uuid; -- [0037]
  v_monto_pago       numeric(14,2);
  v_ya_imputado_pago numeric(14,2);
  v_remanente_pago   numeric(14,2);
  v_barrio_liq       uuid;
  v_total_liq        numeric(14,2);
  v_estado_periodo   app.estado_periodo; -- [0037]
  v_ya_imputado_liq  numeric(14,2);
  v_saldo_liq        numeric(14,2);
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: una imputación sin autor no se registra';
  end if;

  if tg_op = 'INSERT' then
    select barrio_id, unidad_funcional_id, monto into v_barrio_pago, v_unidad_pago, v_monto_pago -- [0037]
      from pago where id = new.pago_id for update;

    if v_barrio_pago is null or not app.has_role_on(v_barrio_pago, v_roles) then
      raise exception 'el pago no existe o no es de este barrio';
    end if;
    if exists (select 1 from pago where id = new.pago_id and anulado_at is not null) then
      raise exception 'ese pago está anulado: no se le puede imputar nada';
    end if;

    select l.barrio_id, l.importe_exigible, pe.estado into v_barrio_liq, v_total_liq, v_estado_periodo
      from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
     where l.id = new.liquidacion_id for update of l;
    if v_barrio_liq is null or v_barrio_liq <> v_barrio_pago then
      raise exception 'la liquidación no existe o no es del mismo barrio que el pago';
    end if;
    -- [0037] Solo se imputa contra una liquidación de un período YA EMITIDO: una en borrador puede
    -- desaparecer al regenerar (`generarLiquidaciones` hace `delete from liquidacion` del período
    -- entero), y `fk_pago_imputacion_liquidacion_barrio` es `on delete restrict` — una imputación
    -- viva contra una liquidación en borrador bloquearía esa regeneración con un error de FK que no
    -- explica nada. Una vez emitida, `app.periodo_editable()` ya la vuelve inmutable para siempre.
    if v_estado_periodo not in ('emitida', 'distribuida') then
      raise exception 'esa liquidación todavía no está emitida: no se le puede imputar un pago';
    end if;

    new.barrio_id := v_barrio_pago;

    select coalesce(sum(monto_imputado), 0) into v_ya_imputado_liq
      from pago_imputacion where liquidacion_id = new.liquidacion_id and anulado_at is null;
    v_saldo_liq := v_total_liq - v_ya_imputado_liq;
    if new.monto_imputado > v_saldo_liq then
      raise exception 'el importe imputado (%) supera el saldo pendiente de la liquidación (%): no se '
                      'sobre-imputa', new.monto_imputado, v_saldo_liq;
    end if;

    -- [0062] El remanente del pago se cuenta entre capital e interés.
    select coalesce(sum(monto_imputado), 0)
           + coalesce((select sum(monto_imputado) from pago_imputacion_interes
                        where pago_id = new.pago_id and anulado_at is null), 0)
      into v_ya_imputado_pago
      from pago_imputacion where pago_id = new.pago_id and anulado_at is null;
    v_remanente_pago := v_monto_pago - v_ya_imputado_pago;
    if new.monto_imputado > v_remanente_pago then
      raise exception 'el importe imputado (%) supera lo que le queda sin asignar a este pago (%)',
        new.monto_imputado, v_remanente_pago;
    end if;

    new.anulado_at       := null;
    new.anulado_por      := null;
    new.motivo_anulacion := null;

    -- [0037] Lado del crédito: el saldo de la unidad baja lo que se le acaba de imputar.
    insert into saldo_uf (barrio_id, unidad_funcional_id, saldo_actual, fecha_ultimo_movimiento)
    values (v_barrio_pago, v_unidad_pago, -new.monto_imputado, current_date)
    on conflict (barrio_id, unidad_funcional_id) do update
       set saldo_actual = saldo_uf.saldo_actual - new.monto_imputado,
           fecha_ultimo_movimiento = current_date;
  end if;

  if tg_op = 'UPDATE' then
    if not app.has_role_on(new.barrio_id, v_roles) then
      raise exception 'no tenés permiso para modificar imputaciones en este barrio';
    end if;

    if (new.barrio_id, new.pago_id, new.liquidacion_id, new.monto_imputado)
       is distinct from
       (old.barrio_id, old.pago_id, old.liquidacion_id, old.monto_imputado)
    then
      raise exception 'una imputación no se edita: se anula (con motivo) y se carga otra';
    end if;

    if old.anulado_at is not null and new.anulado_at is null then
      raise exception 'la anulación de una imputación no se revierte';
    end if;

    if old.anulado_at is not null
       and (new.anulado_at, new.anulado_por, new.motivo_anulacion)
           is distinct from (old.anulado_at, old.anulado_por, old.motivo_anulacion) then
      raise exception 'el motivo de la anulación de una imputación no se reescribe: quedó registrado el '
                      '% y es la única explicación de por qué esa imputación se dejó sin efecto',
        old.anulado_at::date;
    end if;

    if new.anulado_at is not null and old.anulado_at is null then
      new.anulado_at  := now();
      new.anulado_por := v_usuario;

      -- [0037] Se anula la imputación: el crédito se revierte, el saldo de la unidad vuelve a subir.
      update saldo_uf
         set saldo_actual = saldo_actual + old.monto_imputado,
             fecha_ultimo_movimiento = current_date
       where barrio_id = old.barrio_id
         and unidad_funcional_id = (select unidad_funcional_id from pago where id = old.pago_id);
    end if;
  end if;

  return new;
end; $$;--> statement-breakpoint
alter function app.pago_imputacion_antes() owner to app_job;
