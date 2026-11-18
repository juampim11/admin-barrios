-- =============================================================================================
-- 0097 · Planes de pago: la cuota que cobra el estudio y la rendición manual (encargo P2b, BL-051).
-- Solo estructura: tablas nuevas, constraints, funciones y triggers. No borra ni reescribe datos.
--
--   1. **Un pago común al barrio nunca se imputa a una cuota de un plan que cobra el estudio**, aunque
--      el orden sea «cuota primero». Esas cuotas solo se imputan por la rendición:
--        · `app.resolver_imputacion` v4 las salta (y su interés);
--        · un trigger en `pago_imputacion` / `pago_imputacion_interes` rechaza cualquier imputación a
--          una de esas cuotas que no escriba `app_job` con un pago `rendicion` o `plan` (la confirmación
--          de la rendición y la caída del plan). Cubre la imputación manual.
--   2. `pago.origen` admite `rendicion`: el pago que deja cada ingreso de una rendición confirmada. Lo
--      inserta solo `app.plan_rendicion_confirmar` (dueña `app_job`); no se anula por el camino normal,
--      ni él ni sus imputaciones (security-engineer, bloqueante: si no, la cuota reabría saldo y se podía
--      rendir dos veces). Anular una rendición queda para más adelante, como una función propia.
--   3. La rendición manual del estudio (pantalla 5), por barrio. En la v1 la carga la administración:
--        · `plan_rendicion`: el informe, con el período y el PDF firmado por el estudio (clave, SHA-256
--          calculado por el servidor leyendo el objeto, bytes y nombre);
--        · `plan_rendicion_cuota`: las cuotas que cobró el estudio, con el importe (pago parcial
--          permitido), la fecha y el medio con que le pagó el vecino (solo un dato);
--        · `plan_rendicion_ingreso`: cómo le llegó la plata al barrio (transferencia o depósito, fecha,
--          importe, cuenta del barrio y comprobante con su SHA-256);
--        · `plan_rendicion_pago`: qué pago dejó cada pedazo de ingreso en cada cuota (la traza).
--      Se confirma solo si la suma de las cuotas es igual a la de los ingresos. Los honorarios del
--      estudio nunca entran: no hay dónde cargarlos.
--   4. Un plan con una rendición en borrador no cae: la plata que el estudio ya cobró no tendría por
--      dónde entrar (security-engineer).
-- Regla del repo: una migración ya aplicada NO se edita; se agrega la siguiente con prefijo mayor.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. ¿Es una cuota que cobra el estudio? (security definer: el control no puede fallar abierto por la
--    RLS de quien pregunta). Solo devuelve un booleano sobre un uuid.
-- ---------------------------------------------------------------------------------------------
create or replace function app.es_cuota_del_estudio(p_liquidacion uuid) returns boolean
  language sql stable security definer set search_path = public, app, pg_temp
as $$
  select exists (select 1 from plan_cuota pc join plan_pago pp on pp.id = pc.plan_id
                  where pc.liquidacion_id = p_liquidacion and pp.modo_cobro = 'estudio');
$$;
--> statement-breakpoint
create or replace function app.es_pago_de_rendicion(p_pago uuid) returns boolean
  language sql stable security definer set search_path = public, app, pg_temp
as $$
  select exists (select 1 from pago where id = p_pago and origen = 'rendicion');
$$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. El pago de una rendición
-- ---------------------------------------------------------------------------------------------
alter table pago drop constraint pago_origen_chk;
--> statement-breakpoint
alter table pago add constraint pago_origen_chk check (origen in ('extracto', 'manual', 'activacion', 'plan', 'rendicion'));
--> statement-breakpoint
alter table pago drop constraint pago_manual_exige_registrador_chk;
--> statement-breakpoint
-- El de una rendición no lleva comprobante propio: el comprobante es del ingreso, que puede dejar varios
-- pagos (uno por cuota), y un objeto acredita un solo pago (`uq_pago_comprobante_adjunto`).
alter table pago add constraint pago_manual_exige_registrador_chk check (
     (origen = 'manual' and usuario_registrador is not null and comprobante_adjunto is not null)
  or (origen = 'extracto' and usuario_registrador is null)
  or (origen in ('activacion', 'plan', 'rendicion') and usuario_registrador is not null and comprobante_adjunto is null)
);
--> statement-breakpoint
create or replace function app.pago_de_rendicion_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if new.origen = 'rendicion' then
    if current_user::text <> 'app_job' then
      raise exception 'un pago de rendición lo registra la confirmación de la rendición, no se carga a mano' using errcode = '42501';
    end if;
    new.usuario_registrador := app.current_user_id();
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_pago_zz_rendicion before insert on pago for each row execute function app.pago_de_rendicion_antes();
--> statement-breakpoint

-- Al terminar la transacción: un pago de rendición quedó imputado entero (no hay pedazo suelto).
create or replace function app.pago_de_rendicion_cerrado() returns trigger
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
declare v_pago pago;
begin
  select * into v_pago from pago where id = new.id;
  if v_pago.id is null or v_pago.origen <> 'rendicion' or v_pago.anulado_at is not null then
    return null;
  end if;
  if v_pago.monto <> coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = v_pago.id and anulado_at is null), 0) then
    raise exception 'el pago de una rendición se imputa entero a su cuota en la misma operación';
  end if;
  return null;
end; $$;
--> statement-breakpoint
create constraint trigger trg_pago_zz_rendicion_cerrado after insert on pago deferrable initially deferred
  for each row when (new.origen = 'rendicion') execute function app.pago_de_rendicion_cerrado();
--> statement-breakpoint

-- Ni el pago de una rendición ni sus imputaciones se anulan por el camino normal (siempre, no solo con
-- el plan vigente). La caída del plan las anula como `app_job` y las vuelve a imputar a la deuda original.
create or replace function app.rendicion_bloqueo_anulacion() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if not (new.anulado_at is not null and old.anulado_at is null) or current_user::text = 'app_job' then
    return new;
  end if;
  -- Por separado: plpgsql resuelve `old.origen` aunque la otra mitad del `or` ya decida.
  if tg_table_name = 'pago' then
    if old.origen = 'rendicion' then
      raise exception 'el pago de una rendición confirmada no se anula: la rendición queda como se confirmó' using errcode = '42501';
    end if;
  elsif app.es_pago_de_rendicion(old.pago_id) then
    raise exception 'el pago de una rendición confirmada no se anula: la rendición queda como se confirmó' using errcode = '42501';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_pago_zz_rendicion_bloqueo before update on pago
  for each row execute function app.rendicion_bloqueo_anulacion();
--> statement-breakpoint
create trigger trg_pago_imputacion_zz_rendicion_bloqueo before update on pago_imputacion
  for each row execute function app.rendicion_bloqueo_anulacion();
--> statement-breakpoint
create trigger trg_pago_imputacion_interes_zz_rendicion_bloqueo before update on pago_imputacion_interes
  for each row execute function app.rendicion_bloqueo_anulacion();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. La cuota del estudio solo se imputa por la rendición
--
-- `security invoker` a propósito: `current_user` tiene que ser el de quien imputa (`app_job` dentro de
-- la confirmación y de la caída), y la lectura va por `app.es_cuota_del_estudio`, que es definer y no
-- depende de la RLS de quien llama. Para cualquier otro rol, una cuota del estudio se rechaza siempre.
-- ---------------------------------------------------------------------------------------------
create or replace function app.imputacion_a_cuota_del_estudio() returns trigger
  language plpgsql security invoker set search_path = public, app, pg_temp
as $$
declare
  v_liq uuid;
begin
  if tg_table_name = 'pago_imputacion' then
    v_liq := new.liquidacion_id;
  else
    v_liq := (select app.liquidacion_del_interes(new.interes_id));
  end if;
  if v_liq is null or not app.es_cuota_del_estudio(v_liq) then
    return new;
  end if;
  if current_user::text = 'app_job'
     and exists (select 1 from pago where id = new.pago_id and origen in ('rendicion', 'plan')) then
    return new;
  end if;
  raise exception 'esa cuota del plan la cobra el estudio: solo se imputa por la rendición' using errcode = '42501';
end; $$;
--> statement-breakpoint
create or replace function app.liquidacion_del_interes(p_interes uuid) returns uuid
  language sql stable security definer set search_path = public, app, pg_temp
as $$
  select liquidacion_id from interes_devengado where id = p_interes;
$$;
--> statement-breakpoint
create trigger trg_pago_imputacion_zz_cuota_del_estudio before insert on pago_imputacion
  for each row execute function app.imputacion_a_cuota_del_estudio();
--> statement-breakpoint
create trigger trg_pago_imputacion_interes_zz_cuota_del_estudio before insert on pago_imputacion_interes
  for each row execute function app.imputacion_a_cuota_del_estudio();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. La imputación automática (v4): copia ENTERA de la v3 (`0093` §11) con dos cambios marcados
--    `[0097]`: no se imputa a una cuota que cobra el estudio ni a su interés. Acepta pagos `rendicion`
--    (la caída los vuelve a imputar a la deuda original; security-engineer, bloqueante).
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
  -- [0093]
  v_plan_orden := coalesce((select orden_imputacion from plan_parametro_barrio where barrio_id = v_barrio), 'cuota_primero');

  v_remanente := v_monto
    - coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = p_pago_id and anulado_at is null), 0)
    - coalesce((select sum(monto_imputado) from pago_imputacion_interes where pago_id = p_pago_id and anulado_at is null), 0);
  if v_remanente <= 0 then
    return;
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
           -- [0093] La cuota del plan, antes o después del resto según el barrio.
           case when pe.origen = 'plan' then (case when v_plan_orden = 'cuota_primero' then 0 else 2 end) else 1 end,
           coalesce(l.vencimiento, pe.primer_vencimiento, (pe.periodo || '-01')::date) asc,
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


-- ---------------------------------------------------------------------------------------------
-- 4b. Las cuotas de plan que van en la boleta de un mes (una sola fuente: la boleta y la pantalla del
--     mes). Las del plan vigente que vencen en el mes del período:
--       · en borrador, con el importe del cronograma (la cuota todavía no se emitió);
--       · emitido, solo si el plan se firmó ANTES de emitir el mes (si no, la boleta emitida no la
--         traía) y con lo que le falta pagar; si ya no le falta nada, no va.
--     `security invoker`: la leen las RLS de quien arma la boleta (code-reviewer).
-- ---------------------------------------------------------------------------------------------
create or replace function app.cuotas_del_plan_en_boleta(p_periodo uuid)
  returns table (unidad_funcional_id uuid, plan_cuota_id uuid, numero integer, cuotas integer, vencimiento date,
                 importe numeric(14,2), modo_cobro text, estudio_id uuid)
  language sql stable security invoker set search_path = public, app, pg_temp
as $$
  select pp.unidad_funcional_id, pc.id, pc.numero::integer,
         (select count(*) from plan_cuota x where x.plan_id = pp.id and x.numero > 0)::integer,
         pc.vencimiento,
         (case when pc.liquidacion_id is null then pc.importe else app.saldo_de_liquidacion(pc.liquidacion_id) end)::numeric(14,2),
         pp.modo_cobro, pp.estudio_id
    from periodo_expensa pe
    join plan_cuota pc on pc.barrio_id = pe.barrio_id and to_char(pc.vencimiento, 'YYYY-MM') = pe.periodo
    join plan_pago pp on pp.id = pc.plan_id and pp.estado = 'vigente'
   where pe.id = p_periodo and pe.origen = 'mensual'
     and (pe.estado in ('borrador', 'revisada')
          or (pc.liquidacion_id is not null
              and exists (select 1 from plan_evento e where e.plan_id = pp.id and e.tipo = 'firmado' and e.registrado_at <= pe.emitida_at)
              and app.saldo_de_liquidacion(pc.liquidacion_id) > 0))
   order by pp.unidad_funcional_id, pc.vencimiento, pc.numero;
$$;
--> statement-breakpoint
revoke execute on function app.cuotas_del_plan_en_boleta(uuid) from public;
--> statement-breakpoint
grant execute on function app.cuotas_del_plan_en_boleta(uuid) to app_request, app_job;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 5. La rendición
-- ---------------------------------------------------------------------------------------------
create table plan_rendicion (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  estudio_id uuid not null references estudio_juridico (id) on delete restrict,
  -- El mes que rinde el estudio, `YYYY-MM`.
  periodo text not null,
  estado text not null default 'borrador',
  -- La rendición firmada por el estudio (PDF). Hace falta para confirmar.
  documento_clave text,
  documento_sha256 char(64),
  documento_bytes integer,
  documento_nombre text,
  creado_por uuid not null,
  created_at timestamptz not null default now(),
  confirmada_por uuid,
  confirmada_at timestamptz,
  constraint uq_plan_rendicion_id_barrio unique (id, barrio_id),
  constraint uq_plan_rendicion_documento unique (documento_clave),
  constraint plan_rendicion_periodo_chk check (periodo ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  constraint plan_rendicion_estado_chk check (estado in ('borrador', 'confirmada')),
  constraint plan_rendicion_confirmada_chk check ((estado = 'confirmada') = (confirmada_at is not null and confirmada_por is not null)),
  constraint plan_rendicion_documento_chk check (
    (documento_clave is null and documento_sha256 is null and documento_bytes is null and documento_nombre is null)
    or (documento_clave is not null and documento_sha256 is not null and documento_bytes is not null)),
  constraint plan_rendicion_documento_clave_chk check (documento_clave is null or documento_clave ~
    ('^barrios/' || barrio_id::text || '/rendiciones/' || id::text || '/[A-Za-z0-9_-]{22,64}\.pdf$')),
  constraint plan_rendicion_documento_sha_chk check (documento_sha256 is null or (documento_sha256 ~ '^[0-9a-f]{64}$' and documento_bytes > 0)),
  constraint plan_rendicion_documento_nombre_chk check (documento_nombre is null
    or (length(documento_nombre) between 1 and 200 and documento_nombre !~ '[/\\[:cntrl:]]')),
  constraint plan_rendicion_confirmada_con_pdf_chk check (estado = 'borrador' or documento_clave is not null)
);
--> statement-breakpoint
create index idx_plan_rendicion_barrio on plan_rendicion (barrio_id, estado, periodo);
--> statement-breakpoint

create table plan_rendicion_cuota (
  id uuid primary key default gen_random_uuid(),
  rendicion_id uuid not null,
  barrio_id uuid not null,
  plan_cuota_id uuid not null references plan_cuota (id) on delete restrict,
  importe numeric(14,2) not null,
  -- Cuándo y cómo le pagó el vecino al estudio: solo un dato, es entre ellos.
  fecha_cobro date not null,
  medio_vecino text not null,
  -- Quién la cargó (security-engineer): la escribe la base, no quien llama.
  cargado_por uuid not null default app.current_user_id(),
  created_at timestamptz not null default now(),
  constraint fk_plan_rendicion_cuota_rendicion foreign key (rendicion_id, barrio_id) references plan_rendicion (id, barrio_id) on delete restrict,
  constraint uq_plan_rendicion_cuota unique (rendicion_id, plan_cuota_id),
  constraint plan_rendicion_cuota_importe_chk check (importe > 0),
  constraint plan_rendicion_cuota_medio_chk check (medio_vecino in ('efectivo', 'cheque', 'transferencia', 'deposito', 'otro'))
);
--> statement-breakpoint
create index idx_plan_rendicion_cuota_cuota on plan_rendicion_cuota (plan_cuota_id);
--> statement-breakpoint
create index idx_plan_rendicion_cuota_barrio on plan_rendicion_cuota (barrio_id);
--> statement-breakpoint

create table plan_rendicion_ingreso (
  id uuid primary key default gen_random_uuid(),
  rendicion_id uuid not null,
  barrio_id uuid not null,
  fecha date not null,
  medio text not null,
  importe numeric(14,2) not null,
  -- La cuenta del barrio donde entró (copia del CBU al cargarlo): nunca la del vecino.
  cuenta_cbu text not null,
  comprobante_clave text not null,
  comprobante_sha256 char(64) not null,
  comprobante_bytes integer not null,
  comprobante_nombre text,
  cargado_por uuid not null default app.current_user_id(),
  created_at timestamptz not null default now(),
  constraint fk_plan_rendicion_ingreso_rendicion foreign key (rendicion_id, barrio_id) references plan_rendicion (id, barrio_id) on delete restrict,
  constraint uq_plan_rendicion_ingreso_comprobante unique (comprobante_clave),
  -- El mismo archivo no acredita dos ingresos (security-engineer, alta): subido dos veces cae en dos
  -- claves, pero tiene el mismo SHA-256. Sin vínculo con el extracto, es la defensa contra contar dos
  -- veces una transferencia.
  constraint uq_plan_rendicion_ingreso_sha unique (barrio_id, comprobante_sha256),
  constraint plan_rendicion_ingreso_medio_chk check (medio in ('transferencia', 'deposito')),
  constraint plan_rendicion_ingreso_importe_chk check (importe > 0),
  constraint plan_rendicion_ingreso_cbu_chk check (cuenta_cbu ~ '^\d{22}$'),
  constraint plan_rendicion_ingreso_clave_chk check (comprobante_clave ~
    ('^barrios/' || barrio_id::text || '/rendiciones/' || rendicion_id::text || '/[A-Za-z0-9_-]{22,64}\.(pdf|jpg|jpeg|png)$')),
  constraint plan_rendicion_ingreso_sha_chk check (comprobante_sha256 ~ '^[0-9a-f]{64}$' and comprobante_bytes > 0),
  constraint plan_rendicion_ingreso_nombre_chk check (comprobante_nombre is null
    or (length(comprobante_nombre) between 1 and 200 and comprobante_nombre !~ '[/\\[:cntrl:]]'))
);
--> statement-breakpoint
create index idx_plan_rendicion_ingreso_rendicion on plan_rendicion_ingreso (rendicion_id);
--> statement-breakpoint
create index idx_plan_rendicion_ingreso_barrio on plan_rendicion_ingreso (barrio_id);
--> statement-breakpoint

-- La traza: qué pago dejó cada pedazo de un ingreso en cada cuota. La escribe solo la confirmación.
create table plan_rendicion_pago (
  pago_id uuid primary key,
  rendicion_id uuid not null,
  barrio_id uuid not null,
  ingreso_id uuid not null references plan_rendicion_ingreso (id) on delete restrict,
  plan_cuota_id uuid not null references plan_cuota (id) on delete restrict,
  importe numeric(14,2) not null,
  constraint fk_plan_rendicion_pago_rendicion foreign key (rendicion_id, barrio_id) references plan_rendicion (id, barrio_id) on delete restrict,
  constraint fk_plan_rendicion_pago_pago foreign key (pago_id, barrio_id) references pago (id, barrio_id) on delete restrict,
  constraint plan_rendicion_pago_importe_chk check (importe > 0)
);
--> statement-breakpoint
create index idx_plan_rendicion_pago_rendicion on plan_rendicion_pago (rendicion_id);
--> statement-breakpoint
create index idx_plan_rendicion_pago_cuota on plan_rendicion_pago (plan_cuota_id);
--> statement-breakpoint

alter table plan_evento drop constraint plan_evento_tipo_chk;
--> statement-breakpoint
alter table plan_evento add constraint plan_evento_tipo_chk
  check (tipo in ('propuesto', 'firmado', 'cuota_emitida', 'rechazado', 'retirado', 'cumplido', 'caido', 'acta_cargada',
                  'documento_agregado', 'rendicion_confirmada'));
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 6. Las reglas de la rendición (triggers)
-- ---------------------------------------------------------------------------------------------

-- El alta: quién la crea, y que el estudio trabaje con la administración del barrio. Mismo mensaje si el
-- estudio no existe o no está vinculado (sin oráculo, como `0095`).
create or replace function app.plan_rendicion_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if tg_op = 'INSERT' then
    new.estado := 'borrador';
    new.confirmada_por := null;
    new.confirmada_at := null;
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
  -- UPDATE: lo confirmado no cambia; en borrador cambian el período y el PDF. El estado lo cambia solo
  -- la confirmación (`app_job`).
  if old.estado <> 'borrador' then
    raise exception 'la rendición ya está confirmada: no se modifica';
  end if;
  if new.id <> old.id or new.barrio_id <> old.barrio_id or new.estudio_id <> old.estudio_id
     or new.creado_por <> old.creado_por or new.created_at <> old.created_at then
    raise exception 'de una rendición solo cambian el período y el PDF';
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
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_plan_rendicion_antes before insert or update on plan_rendicion
  for each row execute function app.plan_rendicion_antes();
--> statement-breakpoint

-- Las cuotas y los ingresos se cargan y se quitan mientras la rendición está en borrador; confirmada,
-- nada cambia (tampoco para `app_job`).
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
create trigger trg_plan_rendicion_cuota_antes before insert or update or delete on plan_rendicion_cuota
  for each row execute function app.plan_rendicion_hijo_antes();
--> statement-breakpoint
create trigger trg_plan_rendicion_ingreso_antes before insert or update or delete on plan_rendicion_ingreso
  for each row execute function app.plan_rendicion_hijo_antes();
--> statement-breakpoint

-- Una cuota de la rendición: de un plan vigente que cobra el mismo estudio, del mismo barrio, ya
-- emitida y con saldo. Contra el oráculo: sin rol, la frena la RLS; una cuota que no es del barrio da el
-- mismo mensaje que una que no existe; recién después, el resto (security-engineer).
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
--> statement-breakpoint
create trigger trg_plan_rendicion_cuota_valida before insert on plan_rendicion_cuota
  for each row execute function app.plan_rendicion_cuota_valida();
--> statement-breakpoint

-- El ingreso entra a la cuenta del barrio: el CBU es el del barrio, no uno que se tipea.
create or replace function app.plan_rendicion_ingreso_valido() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if not app.has_role_on(new.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) then
    return new;
  end if;
  if not exists (select 1 from barrio b where b.barrio_id = new.barrio_id and b.cuenta_cbu = new.cuenta_cbu) then
    raise exception 'el ingreso tiene que ser a la cuenta del barrio';
  end if;
  if new.fecha > (select (now() at time zone b.zona_horaria)::date from barrio b where b.barrio_id = new.barrio_id) then
    raise exception 'la fecha del ingreso no puede ser futura';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_plan_rendicion_ingreso_valido before insert on plan_rendicion_ingreso
  for each row execute function app.plan_rendicion_ingreso_valido();
--> statement-breakpoint

-- La traza solo se agrega (la escribe la confirmación).
create or replace function app.plan_rendicion_pago_solo_agregar() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  raise exception 'la traza de una rendición no se modifica ni se borra';
end; $$;
--> statement-breakpoint
create trigger trg_plan_rendicion_pago_solo_agregar before update or delete on plan_rendicion_pago
  for each row execute function app.plan_rendicion_pago_solo_agregar();
--> statement-breakpoint
create trigger trg_plan_rendicion_pago_sin_truncate before truncate on plan_rendicion_pago
  for each statement execute function app.plan_rendicion_pago_solo_agregar();
--> statement-breakpoint

-- Un plan con una rendición en borrador no cae (security-engineer): el estudio ya cobró esas cuotas y,
-- caído el plan, la confirmación no tendría saldo donde imputarlas. Se confirma o se quita antes.
create or replace function app.plan_no_cae_con_rendicion() returns trigger
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
begin
  if new.estado = 'caido' and old.estado is distinct from 'caido'
     and exists (select 1 from plan_rendicion_cuota rc join plan_cuota pc on pc.id = rc.plan_cuota_id
                   join plan_rendicion r on r.id = rc.rendicion_id
                  where pc.plan_id = new.id and r.estado = 'borrador') then
    raise exception 'el plan tiene cuotas en una rendición en borrador: confirmá la rendición o quitá esas cuotas antes de declararlo caído';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_plan_pago_zz_no_cae_con_rendicion before update on plan_pago
  for each row execute function app.plan_no_cae_con_rendicion();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 7. Confirmar la rendición
--
-- Una sola transacción, con candados en orden: la rendición (con el rol en el `where`), el barrio
-- (`deuda-anterior`, como la firma), las unidades por id y las cuotas. Reparte los ingresos (por fecha)
-- entre las cuotas (por unidad y número): cada pedazo (ingreso, cuota) es un `pago` de origen
-- `rendicion` con la fecha del ingreso, imputado directo a la cuota. La cuota queda «Pagada · rendición»
-- (o con pago parcial) y, si era la última, el plan se cumple solo (`trg_plan_cumplir`).
-- ---------------------------------------------------------------------------------------------
create or replace function app.plan_rendicion_confirmar(p_rendicion uuid) returns integer
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
declare
  v_r          plan_rendicion;
  v_hoy        date;
  v_cuotas     numeric(14,2);
  v_ingresos   numeric(14,2);
  v_n          integer := 0;
  v_pago       uuid;
  v_parte      numeric(14,2);
  v_ing_id     uuid[];
  v_ing_resto  numeric(14,2)[];
  v_ing_fecha  date[];
  v_k          integer := 1;
  v_falta      numeric(14,2);
  u            record;
  c            record;
begin
  select * into v_r from plan_rendicion
   where id = p_rendicion
     and app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[])
     for update;
  if v_r.id is null then
    raise exception 'la rendición no existe o no es de un barrio que administres' using errcode = '42501';
  end if;
  if v_r.estado <> 'borrador' then
    raise exception 'la rendición ya está confirmada';
  end if;
  if v_r.documento_clave is null then
    raise exception 'falta la rendición firmada por el estudio (PDF)';
  end if;
  select coalesce(sum(importe), 0) into v_cuotas from plan_rendicion_cuota where rendicion_id = p_rendicion;
  select coalesce(sum(importe), 0) into v_ingresos from plan_rendicion_ingreso where rendicion_id = p_rendicion;
  if v_cuotas = 0 or v_ingresos = 0 then
    raise exception 'la rendición necesita al menos una cuota y un ingreso';
  end if;
  if v_cuotas <> v_ingresos then
    raise exception 'las cuotas suman % y los ingresos %: se confirma cuando cuadra', v_cuotas, v_ingresos;
  end if;
  select (now() at time zone b.zona_horaria)::date into v_hoy from barrio b where b.barrio_id = v_r.barrio_id;
  if exists (select 1 from plan_rendicion_ingreso where rendicion_id = p_rendicion and fecha > v_hoy) then
    raise exception 'un ingreso tiene fecha futura';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('deuda-anterior:' || v_r.barrio_id::text, 0));
  for u in
    select distinct pp.unidad_funcional_id from plan_rendicion_cuota rc
      join plan_cuota pc on pc.id = rc.plan_cuota_id join plan_pago pp on pp.id = pc.plan_id
     where rc.rendicion_id = p_rendicion order by pp.unidad_funcional_id
  loop
    perform app.serializar_cobros_de_unidad(u.unidad_funcional_id);
  end loop;
  perform 1 from plan_cuota pc where pc.id in (select plan_cuota_id from plan_rendicion_cuota where rendicion_id = p_rendicion)
     order by pc.id for update;

  -- Se revalida cada cuota con su estado de ahora (otra rendición pudo cubrirla, el plan pudo caer).
  for c in
    select rc.plan_cuota_id, rc.importe, pc.liquidacion_id, pc.plan_id, pp.estado, pp.modo_cobro, pp.estudio_id
      from plan_rendicion_cuota rc join plan_cuota pc on pc.id = rc.plan_cuota_id join plan_pago pp on pp.id = pc.plan_id
     where rc.rendicion_id = p_rendicion and pc.barrio_id = v_r.barrio_id
  loop
    if c.modo_cobro <> 'estudio' or c.estudio_id is distinct from v_r.estudio_id then
      raise exception 'una cuota de la rendición no la cobra este estudio';
    end if;
    if c.estado <> 'vigente' then
      raise exception 'una cuota de la rendición es de un plan que ya no está vigente (se cumplió o cayó): quitala para confirmar';
    end if;
    if c.liquidacion_id is null or c.importe > app.saldo_de_liquidacion(c.liquidacion_id) then
      raise exception 'una cuota de la rendición ya no tiene ese saldo (otra rendición la cubrió): revisá el importe';
    end if;
  end loop;
  if (select count(*) from plan_rendicion_cuota rc join plan_cuota pc on pc.id = rc.plan_cuota_id
       where rc.rendicion_id = p_rendicion and pc.barrio_id = v_r.barrio_id)
     <> (select count(*) from plan_rendicion_cuota where rendicion_id = p_rendicion) then
    raise exception 'una cuota de la rendición no es de este barrio';
  end if;

  select array_agg(id order by fecha, id), array_agg(importe order by fecha, id), array_agg(fecha order by fecha, id)
    into v_ing_id, v_ing_resto, v_ing_fecha
    from plan_rendicion_ingreso where rendicion_id = p_rendicion;

  for c in
    select rc.plan_cuota_id, rc.importe, pc.liquidacion_id, pc.plan_id, pc.numero, pp.unidad_funcional_id
      from plan_rendicion_cuota rc join plan_cuota pc on pc.id = rc.plan_cuota_id join plan_pago pp on pp.id = pc.plan_id
     where rc.rendicion_id = p_rendicion
     order by pp.unidad_funcional_id, pc.plan_id, pc.numero
  loop
    v_falta := c.importe;
    while v_falta > 0 loop
      while v_ing_resto[v_k] = 0 loop
        v_k := v_k + 1;
      end loop;
      v_parte := least(v_falta, v_ing_resto[v_k]);
      insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen)
      values (v_r.barrio_id, c.unidad_funcional_id, v_parte, v_ing_fecha[v_k], 'rendicion')
      returning id into v_pago;
      insert into pago_imputacion (pago_id, liquidacion_id, monto_imputado) values (v_pago, c.liquidacion_id, v_parte);
      insert into plan_rendicion_pago (pago_id, rendicion_id, barrio_id, ingreso_id, plan_cuota_id, importe)
      values (v_pago, p_rendicion, v_r.barrio_id, v_ing_id[v_k], c.plan_cuota_id, v_parte);
      v_ing_resto[v_k] := v_ing_resto[v_k] - v_parte;
      v_falta := v_falta - v_parte;
      v_n := v_n + 1;
    end loop;
  end loop;

  update plan_rendicion set estado = 'confirmada', confirmada_por = app.current_user_id(), confirmada_at = now()
   where id = p_rendicion;

  insert into plan_evento (plan_id, barrio_id, tipo, detalle)
  select pc.plan_id, v_r.barrio_id, 'rendicion_confirmada',
         jsonb_build_object('rendicionId', p_rendicion, 'periodo', v_r.periodo, 'sha256', v_r.documento_sha256,
                            'importe', sum(rc.importe), 'cuotas', jsonb_agg(pc.numero order by pc.numero))
    from plan_rendicion_cuota rc join plan_cuota pc on pc.id = rc.plan_cuota_id
   where rc.rendicion_id = p_rendicion
   group by pc.plan_id;
  return v_n;
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 8. Dueños, permisos y RLS
-- ---------------------------------------------------------------------------------------------
-- Las definer, dueñas `app_job` (BYPASSRLS): leen todo sin depender de la identidad ni de la RLS de quien
-- llama, también en un Postgres administrado donde quien migra no es superusuario (security-engineer;
-- la trampa de `0017` §7).
do $bloque$
declare f text;
begin
  foreach f in array array['plan_rendicion_confirmar(uuid)', 'es_cuota_del_estudio(uuid)', 'es_pago_de_rendicion(uuid)',
                           'liquidacion_del_interes(uuid)', 'pago_de_rendicion_cerrado()', 'plan_no_cae_con_rendicion()'] loop
    execute format('alter function app.%s owner to app_job', f);
  end loop;
end
$bloque$;
--> statement-breakpoint
do $bloque$
declare f text;
begin
  foreach f in array array['es_cuota_del_estudio(uuid)', 'es_pago_de_rendicion(uuid)', 'liquidacion_del_interes(uuid)',
                           'pago_de_rendicion_cerrado()', 'plan_no_cae_con_rendicion()', 'plan_rendicion_confirmar(uuid)',
                           'pago_de_rendicion_antes()', 'rendicion_bloqueo_anulacion()', 'imputacion_a_cuota_del_estudio()',
                           'plan_rendicion_antes()', 'plan_rendicion_hijo_antes()', 'plan_rendicion_cuota_valida()',
                           'plan_rendicion_ingreso_valido()', 'plan_rendicion_pago_solo_agregar()'] loop
    execute format('revoke execute on function app.%s from public', f);
    execute format('grant execute on function app.%s to app_request, app_job', f);
  end loop;
end
$bloque$;
--> statement-breakpoint
-- Lo que la confirmación (dueña `app_job`) lee y escribe.
grant select, update on table plan_rendicion to app_job;
--> statement-breakpoint
grant select on table plan_rendicion_cuota, plan_rendicion_ingreso to app_job;
--> statement-breakpoint
grant select, insert on table plan_rendicion_pago to app_job;
--> statement-breakpoint
grant select on table estudio_administracion, tenant_node, interes_devengado to app_job;
--> statement-breakpoint

do $bloque$
declare t text;
begin
  foreach t in array array['plan_rendicion', 'plan_rendicion_cuota', 'plan_rendicion_ingreso', 'plan_rendicion_pago'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy %I on %I for select using (barrio_id in (select app.readable_tenant_ids()))', t || '_sel', t);
  end loop;
  foreach t in array array['plan_rendicion', 'plan_rendicion_cuota', 'plan_rendicion_ingreso', 'plan_rendicion_pago'] loop
    execute format('create policy %I on %I for insert with check (app.has_role_on(barrio_id, array[''admin_plataforma'', ''admin_barrio'']::app.rol_membership[]))', t || '_ins', t);
  end loop;
  execute 'create policy plan_rendicion_upd on plan_rendicion for update
             using (app.has_role_on(barrio_id, array[''admin_plataforma'', ''admin_barrio'']::app.rol_membership[]))
             with check (app.has_role_on(barrio_id, array[''admin_plataforma'', ''admin_barrio'']::app.rol_membership[]))';
  foreach t in array array['plan_rendicion_cuota', 'plan_rendicion_ingreso'] loop
    execute format('create policy %I on %I for delete using (app.has_role_on(barrio_id, array[''admin_plataforma'', ''admin_barrio'']::app.rol_membership[]))', t || '_del', t);
  end loop;
end
$bloque$;
--> statement-breakpoint
grant select, insert on table plan_rendicion to app_request;
--> statement-breakpoint
grant update (periodo, documento_clave, documento_sha256, documento_bytes, documento_nombre) on table plan_rendicion to app_request;
--> statement-breakpoint
grant select, insert, delete on table plan_rendicion_cuota, plan_rendicion_ingreso to app_request;
--> statement-breakpoint
grant select on table plan_rendicion_pago to app_request;
