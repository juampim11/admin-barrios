-- =============================================================================================
-- 0065_alta_barrio_padron — el alta de barrio y el padrón editable desde la pantalla (T3, BL-009).
--
-- Solo esquema: no cambia ni una fila existente. Lo que agrega:
--
--   1. Los cuatro datos legales del barrio aceptan «A confirmar» (NULL): adecuación al art. 2075,
--      encuadre urbanístico, servicios internos y reglamento inscripto (este ya era NULL). Un barrio
--      se puede dar de alta sin tenerlos, y Configuración del barrio los muestra como pendientes. La
--      siembra de vigencias deja de escribir una vigencia para un eje sin valor.
--   2. El barrio guarda lo que pide el alta: razón social, día de vencimiento, primer período, modelo
--      de liquidación y cómo se identifica el pago («una cuenta para todo el barrio» o «una cuenta por
--      unidad», con recaudador y cuenta padre).
--   3. La unidad guarda su cuenta propia (CBU y alias, validados y sin repetirse entre las unidades de
--      la administración), su saldo inicial (se carga una vez) y el motivo de su baja.
--   4. `padron_evento`: el historial del padrón (alta, edición, cambio de titular, baja, saldo
--      inicial, versión de coeficientes). Append-only, y **solo lo escriben `admin_plataforma` y
--      `admin_barrio`**: cada operación del padrón escribe su evento en la misma transacción, así que
--      la regla de quién escribe la hace cumplir la base.
--
-- Las policies de `unidad_funcional`, `obligado` y el resto de 0003 NO se tocan: un test de RLS que
-- ya existe fija que un `operador` puede dar de alta una unidad (codigo-pago.test.ts), y cerrarlo
-- obligaría a cambiar su resultado esperado (motivo para frenar «a» del encargo T3). Las operaciones
-- nuevas del padrón pasan todas por `padron_evento`, que sí es solo de la administración.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. «A confirmar»
-- ---------------------------------------------------------------------------------------------
alter table barrio alter column adecuado_art_2075 drop not null;
--> statement-breakpoint
alter table barrio alter column encuadre_urbanistico drop not null;
--> statement-breakpoint
alter table barrio alter column servicios_internos_a_cargo_de drop not null;
--> statement-breakpoint

-- La siembra de vigencias (0003) escribía las cinco; un eje «A confirmar» no tiene valor que
-- versionar. Cuando se complete desde Configuración, la vigencia nace con su fecha.
create or replace function app.barrio_sembrar_vigencias() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  insert into barrio_atributo_vigencia (barrio_id, eje, valor, vigente_desde)
  select new.barrio_id, x.eje::app.eje_barrio, x.valor, current_date
    from (values
      ('figura_juridica',               new.figura_juridica::text),
      ('adecuado_art_2075',             new.adecuado_art_2075::text),
      ('encuadre_urbanistico',          new.encuadre_urbanistico::text),
      ('municipio',                     new.municipio),
      ('servicios_internos_a_cargo_de', new.servicios_internos_a_cargo_de::text)
    ) as x(eje, valor)
   where x.valor is not null;
  return null;
end; $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. CBU y alias: la misma regla en la base que en la pantalla (`@admin-barrios/shared/cuentas`).
-- ---------------------------------------------------------------------------------------------
create or replace function app.cbu_valido(p_cbu text) returns boolean
  language sql immutable strict
as $$
  select p_cbu ~ '^[0-9]{22}$'
     and substr(p_cbu, 8, 1)::int = (10 - ((
           7 * substr(p_cbu, 1, 1)::int + 1 * substr(p_cbu, 2, 1)::int + 3 * substr(p_cbu, 3, 1)::int
         + 9 * substr(p_cbu, 4, 1)::int + 7 * substr(p_cbu, 5, 1)::int + 1 * substr(p_cbu, 6, 1)::int
         + 3 * substr(p_cbu, 7, 1)::int) % 10)) % 10
     and substr(p_cbu, 22, 1)::int = (10 - ((
           3 * substr(p_cbu, 9, 1)::int  + 9 * substr(p_cbu, 10, 1)::int + 7 * substr(p_cbu, 11, 1)::int
         + 1 * substr(p_cbu, 12, 1)::int + 3 * substr(p_cbu, 13, 1)::int + 9 * substr(p_cbu, 14, 1)::int
         + 7 * substr(p_cbu, 15, 1)::int + 1 * substr(p_cbu, 16, 1)::int + 3 * substr(p_cbu, 17, 1)::int
         + 9 * substr(p_cbu, 18, 1)::int + 7 * substr(p_cbu, 19, 1)::int + 1 * substr(p_cbu, 20, 1)::int
         + 3 * substr(p_cbu, 21, 1)::int) % 10)) % 10
$$;
--> statement-breakpoint
grant execute on function app.cbu_valido(text) to app_request, app_job;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. El barrio
-- ---------------------------------------------------------------------------------------------
alter table barrio
  add column razon_social text,
  add column dia_vencimiento smallint,
  add column primer_periodo text,
  add column modelo_liquidacion app.modelo_expensa,
  add column identificacion_pago text,
  add column recaudador text,
  add column cuenta_cbu text,
  add column cuenta_alias text;
--> statement-breakpoint
alter table barrio add constraint barrio_razon_social_chk
  check (razon_social is null or length(btrim(razon_social)) between 1 and 200);
--> statement-breakpoint
alter table barrio add constraint barrio_dia_vencimiento_chk check (dia_vencimiento between 1 and 28);
--> statement-breakpoint
alter table barrio add constraint barrio_primer_periodo_chk check (primer_periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
--> statement-breakpoint
alter table barrio add constraint barrio_identificacion_pago_chk
  check (identificacion_pago in ('cuenta_unica', 'cuenta_por_unidad'));
--> statement-breakpoint
alter table barrio add constraint barrio_cuenta_cbu_chk check (cuenta_cbu is null or app.cbu_valido(cuenta_cbu));
--> statement-breakpoint
alter table barrio add constraint barrio_cuenta_alias_chk check (cuenta_alias ~ '^[A-Za-z0-9.-]{6,20}$');
--> statement-breakpoint
alter table barrio add constraint barrio_recaudador_chk check (recaudador is null or length(btrim(recaudador)) between 1 and 80);
--> statement-breakpoint
-- Con una forma de identificar el pago elegida, hay una cuenta: la del barrio o la padre del recaudador.
alter table barrio add constraint barrio_identificacion_con_cuenta_chk
  check (identificacion_pago is null or cuenta_cbu is not null);
--> statement-breakpoint
-- El recaudador solo tiene sentido con cuentas por unidad.
alter table barrio add constraint barrio_recaudador_solo_por_unidad_chk
  check (recaudador is null or identificacion_pago = 'cuenta_por_unidad');
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. La unidad
-- ---------------------------------------------------------------------------------------------
alter table unidad_funcional
  add column cbu text,
  add column alias text,
  add column saldo_inicial numeric(14, 2) not null default 0,
  add column baja_motivo text,
  add column baja_detalle text,
  add column baja_por uuid;
--> statement-breakpoint
alter table unidad_funcional add constraint uf_cbu_chk check (cbu is null or app.cbu_valido(cbu));
--> statement-breakpoint
alter table unidad_funcional add constraint uf_alias_chk check (alias ~ '^[A-Za-z0-9.-]{6,20}$');
--> statement-breakpoint
alter table unidad_funcional add constraint uf_saldo_inicial_chk check (saldo_inicial >= 0);
--> statement-breakpoint
alter table unidad_funcional add constraint uf_baja_motivo_chk
  check (baja_motivo in ('unificacion', 'subdivision', 'carga_por_error', 'otro'));
--> statement-breakpoint
alter table unidad_funcional add constraint uf_baja_con_fecha_chk check (baja_motivo is null or baja_at is not null);
--> statement-breakpoint

-- Manzana y lote identifican la unidad sin importar mayúsculas ni espacios de los costados: «Mza A ·
-- Lote 1» y «Mza a · Lote 1» son la misma (la planilla ya las compara así). Tester, T3.
create unique index uq_uf_barrio_manzana_lote_ci on unidad_funcional (barrio_id, upper(btrim(manzana)), upper(btrim(lote)));
--> statement-breakpoint

-- Para la conciliación (T2): la cuenta de la unidad es la señal más fuerte para saber de quién es un
-- pago. Se busca por igualdad exacta.
create index idx_uf_cbu on unidad_funcional (cbu) where cbu is not null;
--> statement-breakpoint
create index idx_uf_alias on unidad_funcional (lower(alias)) where alias is not null;
--> statement-breakpoint

-- Una cuenta, una unidad, en toda la administración. Un índice único no alcanza a "la misma
-- administración" (cruza barrios), así que lo hace un trigger con lock por cuenta. Es `security
-- definer` porque tiene que ver las unidades de los barrios hermanos; el mensaje no dice cuál es la
-- otra unidad ni de qué barrio (no es un oráculo de datos ajenos: solo cuentas de SU administración).
create or replace function app.uf_cuenta_unica() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_raiz text;
begin
  if new.cbu is null and new.alias is null then return new; end if;
  if tg_op = 'UPDATE' and new.cbu is not distinct from old.cbu and new.alias is not distinct from old.alias then
    return new;
  end if;
  -- Este trigger mira las cuentas de los barrios hermanos: sin esta guarda, cualquiera que pueda
  -- escribir una unidad (un `operador`) podría preguntar si una cuenta existe en otro barrio de la
  -- administración (panel `security-engineer`, G3). La cuenta de una unidad la carga la
  -- administración. Las cargas sin identidad (seed, mantenimiento) no pasan por la RLS de todos modos.
  if app.current_user_id() is not null
     and not app.has_role_on(new.barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
    raise exception 'el padrón lo modifica la administración del barrio (admin_barrio o admin_plataforma)'
      using errcode = '42501';
  end if;

  select split_part(path, '.', 1) into v_raiz from tenant_node where id = new.barrio_id;

  if new.cbu is not null then
    perform pg_advisory_xact_lock(hashtext('uf-cuenta:' || v_raiz || ':' || new.cbu));
    if exists (
      select 1 from unidad_funcional u join tenant_node n on n.id = u.barrio_id
       where u.cbu = new.cbu and u.id <> new.id and split_part(n.path, '.', 1) = v_raiz
    ) or exists (
      select 1 from barrio b join tenant_node n on n.id = b.barrio_id
       where b.cuenta_cbu = new.cbu and split_part(n.path, '.', 1) = v_raiz
    ) then
      raise exception 'el CBU % ya lo usa otra unidad o un barrio de la administración: cada unidad tiene su propia cuenta', new.cbu
        using errcode = '23505';
    end if;
  end if;

  if new.alias is not null then
    perform pg_advisory_xact_lock(hashtext('uf-alias:' || v_raiz || ':' || lower(new.alias)));
    if exists (
      select 1 from unidad_funcional u join tenant_node n on n.id = u.barrio_id
       where lower(u.alias) = lower(new.alias) and u.id <> new.id and split_part(n.path, '.', 1) = v_raiz
    ) or exists (
      select 1 from barrio b join tenant_node n on n.id = b.barrio_id
       where lower(b.cuenta_alias) = lower(new.alias) and split_part(n.path, '.', 1) = v_raiz
    ) then
      raise exception 'el alias % ya lo usa otra unidad o un barrio de la administración: cada unidad tiene su propia cuenta', new.alias
        using errcode = '23505';
    end if;
  end if;
  return new;
end; $$;
--> statement-breakpoint
alter function app.uf_cuenta_unica() owner to app_job;
--> statement-breakpoint
revoke execute on function app.uf_cuenta_unica() from public;
--> statement-breakpoint
create trigger trg_uf_cuenta_unica before insert or update of cbu, alias on unidad_funcional
  for each row execute function app.uf_cuenta_unica();
--> statement-breakpoint

-- El saldo inicial es la deuda que la unidad trae de antes del sistema y se carga UNA vez: en cuanto
-- una boleta emitida lo imprimió, ya es deuda de la cuenta corriente y cambiarlo la descuadraría.
create or replace function app.uf_saldo_inicial_una_vez() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  -- Solo la administración (como la cuenta de la unidad): sin esta guarda, un operador podría
  -- cambiar el saldo inicial o dar de baja una unidad por SQL directo, sin evento en el historial
  -- (tester, T3). Las cargas sin identidad (seed, mantenimiento) no pasan por acá con un usuario.
  if app.current_user_id() is not null
     and (new.saldo_inicial is distinct from old.saldo_inicial
          or new.baja_at is distinct from old.baja_at
          or new.baja_motivo is distinct from old.baja_motivo)
     and not app.has_role_on(new.barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
    raise exception 'el padrón lo modifica la administración del barrio (admin_barrio o admin_plataforma)'
      using errcode = '42501';
  end if;
  if new.saldo_inicial is distinct from old.saldo_inicial and exists (
    select 1 from liquidacion l join periodo_expensa p on p.id = l.periodo_id
     where l.unidad_funcional_id = old.id and p.estado not in ('borrador', 'revisada')
  ) then
    raise exception 'el saldo inicial de la unidad ya se usó en una boleta emitida: no se cambia (es deuda de la cuenta corriente)'
      using errcode = '23514';
  end if;
  return new;
end; $$;
--> statement-breakpoint
alter function app.uf_saldo_inicial_una_vez() owner to app_job;
--> statement-breakpoint
revoke execute on function app.uf_saldo_inicial_una_vez() from public;
--> statement-breakpoint
create trigger trg_uf_saldo_inicial_una_vez before update of saldo_inicial, baja_at, baja_motivo on unidad_funcional
  for each row execute function app.uf_saldo_inicial_una_vez();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. `padron_evento` — el historial del padrón
-- ---------------------------------------------------------------------------------------------
create table padron_evento (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  unidad_funcional_id uuid,
  tipo text not null,
  -- La fecha desde la que rige lo que se registró (un cambio de titular); la del registro es `created_at`.
  vigente_desde date,
  motivo text,
  detalle text,
  datos jsonb not null default '{}'::jsonb,
  archivo text,
  respaldo_tipo text,
  respaldo_referencia text,
  respaldo_adjunto text,
  rol text not null,
  creado_por uuid not null,
  created_at timestamptz not null default now(),
  constraint padron_evento_tipo_chk check (tipo in (
    'alta_barrio', 'alta', 'alta_planilla', 'edicion', 'correccion_planilla', 'cambio_titular', 'baja',
    'version_coeficientes', 'exportacion'
  )),
  -- `exportacion`: quién bajó el padrón con sus datos personales y cuándo (panel `security-engineer`, G2).
  constraint padron_evento_unidad_chk check ((unidad_funcional_id is null) = (tipo in ('alta_barrio', 'version_coeficientes', 'exportacion'))),
  constraint padron_evento_motivo_chk check (motivo is null or length(motivo) <= 60),
  constraint padron_evento_detalle_chk check (detalle is null or length(detalle) <= 1000),
  constraint padron_evento_archivo_chk check (archivo is null or length(archivo) <= 200),
  constraint padron_evento_respaldo_chk check (
    (respaldo_tipo is null and respaldo_referencia is null and respaldo_adjunto is null) or respaldo_tipo is not null
  ),
  constraint fk_padron_evento_uf_barrio foreign key (unidad_funcional_id, barrio_id)
    references unidad_funcional (id, barrio_id) on delete restrict
);
--> statement-breakpoint
create index idx_padron_evento_unidad on padron_evento (unidad_funcional_id, created_at) where unidad_funcional_id is not null;
--> statement-breakpoint
create index idx_padron_evento_barrio on padron_evento (barrio_id, created_at);
--> statement-breakpoint

-- Quién y cuándo los pone la base, no la app. El rol queda registrado (como en la condonación,
-- ADR-0009: el operador del software no es un órgano del barrio). Append-only.
create or replace function app.padron_evento_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'el historial del padrón no se edita ni se borra';
  end if;
  new.creado_por := app.current_user_id();
  if new.creado_por is null then
    raise exception 'el historial del padrón se escribe con una identidad';
  end if;
  new.created_at := now();
  new.rol := case
    when app.has_role_on(new.barrio_id, array['admin_plataforma']::app.rol_membership[]) then 'admin_plataforma'
    when app.has_role_on(new.barrio_id, array['admin_barrio']::app.rol_membership[]) then 'admin_barrio'
    else null end;
  if new.rol is null then
    raise exception 'el padrón lo modifica la administración del barrio (admin_barrio o admin_plataforma)'
      using errcode = '42501';
  end if;
  -- El adjunto: una subida pedida para ESTE barrio (el mismo registro que la tasa y la condonación).
  if new.respaldo_adjunto is not null and not exists (
      select 1 from subida_respaldo_solicitada s where s.storage_key = new.respaldo_adjunto and s.nodo_id = new.barrio_id) then
    raise exception 'el adjunto del respaldo no es una subida de este barrio';
  end if;
  return new;
end; $$;
--> statement-breakpoint
alter function app.padron_evento_antes() owner to app_job;
--> statement-breakpoint
revoke execute on function app.padron_evento_antes() from public;
--> statement-breakpoint
create trigger trg_padron_evento_antes before insert or update or delete on padron_evento
  for each row execute function app.padron_evento_antes();
--> statement-breakpoint

alter table padron_evento enable row level security;
--> statement-breakpoint
alter table padron_evento force row level security;
--> statement-breakpoint
create policy padron_evento_sel on padron_evento for select
  using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy padron_evento_ins on padron_evento for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
grant select, insert on table padron_evento to app_request;
--> statement-breakpoint
grant select, insert on table padron_evento to app_job;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 6. El código de pago de 700 unidades por planilla (paso de volumen de T3)
--
-- `app.uf_codigo_pago_antes_insert` (0059) actualiza la secuencia y lee el largo del barrio en cada
-- fila, y con la identidad de la persona cada una de esas dos lecturas evaluaba la RLS (medido: 7 de
-- los 10 s de importar 700 unidades). El trigger NUMERA, no autoriza: la autorización es la RLS del
-- `insert` en `unidad_funcional`, que se verifica igual sobre la fila nueva y, si falla, deshace la
-- sentencia entera (también el avance de la secuencia). Pasa a `security definer` con dueño
-- `app_job`, como el resto de los triggers internos del esquema.
-- ---------------------------------------------------------------------------------------------
alter function app.uf_codigo_pago_antes_insert() security definer;
--> statement-breakpoint
alter function app.uf_codigo_pago_antes_insert() owner to app_job;
