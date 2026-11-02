-- =============================================================================================
-- 0057_parametros_mora_reglas — reglas, permisos y migración de datos de la mora configurable
-- (tanda T1, ADR-0006). Panel: `arquitecto-software`, `dba-data`, `legal-ph` (2026-11-02), con las
-- decisiones del titular del mismo día.
--
-- Orden del archivo:
--   1. el registro de claves (espejo de `@admin-barrios/shared/parametros-mora`);
--   2. validación por clave y los triggers de las tablas (append-only);
--   3. la siembra de una administración nueva;
--   4. resolución (`app.parametro_resuelto*`, `app.parametros_cambios`);
--   5. escritura (`app.fijar_parametro`, `app.anular_parametro_programado`);
--   6. RLS y grants;
--   7. MIGRACIÓN DE DATOS: administraciones existentes, `tasa_mora`, `barrio.orden_imputacion`;
--   8. `app.resolver_imputacion` lee el parámetro a la fecha del pago.
-- Lo viejo (`tasa_mora`, `app.tasa_mora_vigente`, `barrio.orden_imputacion`) se va en `0058`.
--
-- ⚠ **Sin `ENABLE ALWAYS` en los triggers de append-only** (desvío consciente del sistema del que se
-- portó el modelo; panel `dba-data`). `session_replication_role` es SUSET: ni `app_request` ni
-- `app_job` lo pueden activar, y ninguno de los dos tiene grant de update/delete sobre estas
-- tablas. ALWAYS solo frenaría al superusuario en modo réplica, que es exactamente lo que usa la
-- limpieza de los tests (`ataques-escritura.test.ts`, `borrarArbol`).
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. El registro. `valor_inicial` es lo que recibe una administración NUEVA (decisión del titular):
--    «Cobra interés: No», 5 días de gracia, «corre el inicio», $ 100 de tolerancia, «Intereses
--    primero». Las administraciones que ya existían NO reciben esto: se migran con su comportamiento
--    actual (sección 7).
-- ---------------------------------------------------------------------------------------------
insert into parametro_registro (clave, valor_inicial, requiere_respaldo) values
  ('interes.cobra',              'false',                                  false),
  ('interes.tasa_compensatoria', '"0"',                                    true),
  ('interes.tasa_punitoria',     '"0"',                                    true),
  ('interes.gracia_dias',        '5',                                      false),
  ('interes.forma_gracia',       '"corre_inicio"',                         false),
  ('interes.tolerancia',         '"100.00"',                               false),
  ('imputacion.orden',           '"intereses_primero_capital_antiguo"',    false);
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. Validación por clave (el guardia; el Zod de `shared` es la experiencia de usuario) y triggers.
-- ---------------------------------------------------------------------------------------------
create or replace function app.validar_parametro(p_clave text, p_valor jsonb) returns void
  language plpgsql immutable set search_path = public, app
as $$
begin
  case p_clave
    when 'interes.cobra' then
      if jsonb_typeof(p_valor) <> 'boolean' then
        raise exception 'valor de parámetro inválido: «Cobra interés» es sí o no';
      end if;
    when 'interes.tasa_compensatoria', 'interes.tasa_punitoria' then
      if jsonb_typeof(p_valor) <> 'string' or (p_valor #>> '{}') !~ '^(0(\.[0-9]{1,6})?|1(\.0{1,6})?)$' then
        raise exception 'valor de parámetro inválido: la tasa es una fracción entre 0 y 1, con hasta seis decimales';
      end if;
    when 'interes.gracia_dias' then
      if jsonb_typeof(p_valor) <> 'number' or (p_valor #>> '{}') !~ '^[0-9]{1,3}$' or (p_valor #>> '{}')::int > 365 then
        raise exception 'valor de parámetro inválido: los días de gracia son un entero entre 0 y 365';
      end if;
    when 'interes.forma_gracia' then
      if p_valor not in ('"corre_inicio"'::jsonb, '"escalon"'::jsonb) then
        raise exception 'valor de parámetro inválido: la forma de la gracia es «corre el inicio» o «escalón»';
      end if;
    when 'interes.tolerancia' then
      if jsonb_typeof(p_valor) <> 'string' or (p_valor #>> '{}') !~ '^[0-9]{1,12}\.[0-9]{2}$' then
        raise exception 'valor de parámetro inválido: la tolerancia es un importe en pesos, con dos decimales';
      end if;
    when 'imputacion.orden' then
      if p_valor not in ('"intereses_primero_capital_antiguo"'::jsonb, '"capital_primero"'::jsonb) then
        raise exception 'valor de parámetro inválido: el orden de imputación es «intereses primero» o «capital primero»';
      end if;
    else
      raise exception 'valor de parámetro inválido: el parámetro % no existe', p_clave;
  end case;
end; $$;
--> statement-breakpoint

create or replace function app.parametro_valor_antes_insert() returns trigger
  language plpgsql set search_path = public, app
as $$
declare
  v_tipo   app.tipo_tenant;
  v_padre  uuid;
  v_tipo_p app.tipo_tenant;
begin
  select tipo, parent_id into v_tipo, v_padre from tenant_node where id = new.nodo_id;
  if v_tipo is null or v_tipo not in ('administrador', 'barrio') then
    raise exception 'un parámetro se fija en una administración o en un barrio';
  end if;
  if v_tipo = 'barrio' then
    select tipo into v_tipo_p from tenant_node where id = v_padre;
    if v_tipo_p is distinct from 'administrador' then
      raise exception 'el barrio no cuelga de una administración: no tiene de quién heredar';
    end if;
  end if;
  -- Las reglas de negocio TAMBIÉN en la tabla, no solo en `fijar_parametro` (revisión de
  -- `security-engineer`, M1): `app_job` tiene insert directo, y un job con un bug —o comprometido— no
  -- puede escribir un valor retroactivo ni sin firma. La migración y el seed corren con el dueño del
  -- esquema y cargan historia (`inicial`/`migrado`); los roles de la aplicación, nunca.
  if current_user in ('app_job', 'app_request') then
    if new.carga <> 'usuario' or new.creado_por is distinct from app.current_user_id() then
      raise exception 'un parámetro lo carga una persona con sesión: no se escribe a mano';
    end if;
    if new.vigente_desde < current_date then
      raise exception 'un cambio de parámetro rige desde hoy o una fecha futura: nunca hacia atrás';
    end if;
  end if;
  -- Un JSON `null` es "vuelve a heredar" (SQL NULL).
  if new.valor = 'null'::jsonb then new.valor := null; end if;
  if new.valor is null and v_tipo = 'administrador' then
    raise exception 'en la administración el parámetro necesita un valor';
  end if;
  if new.valor is not null then perform app.validar_parametro(new.clave, new.valor); end if;
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_parametro_valor_antes_insert before insert on parametro_valor
  for each row execute function app.parametro_valor_antes_insert();
--> statement-breakpoint

create or replace function app.parametro_solo_agregar() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  raise exception 'los parámetros no se editan ni se borran: se fija un valor nuevo o se anula uno programado';
end; $$;
--> statement-breakpoint

create trigger trg_parametro_valor_solo_agregar before update or delete on parametro_valor
  for each row execute function app.parametro_solo_agregar();
--> statement-breakpoint
create trigger trg_parametro_valor_sin_truncate before truncate on parametro_valor
  for each statement execute function app.parametro_solo_agregar();
--> statement-breakpoint
-- Una anulación hereda el nodo de SU fila (no se confía en el que venga) y solo cae sobre lo que todavía
-- no rige, la escriba quien la escriba (revisión de `security-engineer`, M1).
create or replace function app.parametro_anulacion_antes_insert() returns trigger
  language plpgsql set search_path = public, app
as $$
declare
  v_nodo  uuid;
  v_desde date;
begin
  select nodo_id, vigente_desde into v_nodo, v_desde from parametro_valor where id = new.fila_id;
  if v_nodo is null then
    raise exception 'ese cambio programado no existe';
  end if;
  if v_desde <= current_date then
    raise exception 'ese cambio ya rige: no se anula; se fija un valor nuevo desde hoy';
  end if;
  new.nodo_id := v_nodo;
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_parametro_anulacion_antes_insert before insert on parametro_anulacion
  for each row execute function app.parametro_anulacion_antes_insert();
--> statement-breakpoint

create trigger trg_parametro_anulacion_solo_agregar before update or delete on parametro_anulacion
  for each row execute function app.parametro_solo_agregar();
--> statement-breakpoint
create trigger trg_parametro_anulacion_sin_truncate before truncate on parametro_anulacion
  for each statement execute function app.parametro_solo_agregar();
--> statement-breakpoint

-- La identidad de quien pide la subida la pone la base (mismo criterio que `0041`).
create or replace function app.subida_respaldo_antes_insert() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  new.solicitado_por := app.current_user_id();
  if new.solicitado_por is null then
    raise exception 'no hay usuario en la sesión';
  end if;
  new.solicitado_at := now();
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_subida_respaldo_antes_insert before insert on subida_respaldo_solicitada
  for each row execute function app.subida_respaldo_antes_insert();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. Una administración nueva nace con los valores iniciales del registro, desde el 2000-01-01.
--    Producción no corre el seed: si esto no fuera un trigger, una administración dada de alta a
--    mano quedaría sin valores y la liquidación no tendría con qué calcular.
-- ---------------------------------------------------------------------------------------------
create or replace function app.tenant_node_parametros_iniciales() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  insert into parametro_valor (nodo_id, clave, valor, vigente_desde, motivo, carga)
  select new.id, r.clave, r.valor_inicial, date '2000-01-01', 'Valor inicial del producto', 'inicial'
    from parametro_registro r;
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_tenant_node_parametros_iniciales after insert on tenant_node
  for each row when (new.tipo = 'administrador')
  execute function app.tenant_node_parametros_iniciales();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. Resolución.
--
-- `app.parametro_resuelto_interno(nodo, clave, fecha)`: si el nodo es un barrio, su última fila
-- vigente a la fecha (sin anular); si no tiene, o la última dice "vuelve a heredar" (NULL), la de su
-- administración. Si el nodo es la administración, solo la suya. Sin fila → cero filas: **quien
-- llama decide** si eso es un error (la imputación automática falla cerrada; la pantalla dice "sin
-- definir"). No mira permisos: no se le da execute a `app_request`.
-- ---------------------------------------------------------------------------------------------
create or replace function app.parametro_resuelto_interno(p_nodo uuid, p_clave text, p_fecha date)
  returns table (valor jsonb, origen text, fila_id uuid, vigente_desde date, carga text, motivo text,
                 respaldo_tipo text, respaldo_referencia text, respaldo_adjunto text)
  language plpgsql stable security definer set search_path = public, app
as $$
declare
  v_tipo  app.tipo_tenant;
  v_padre uuid;
  f       parametro_valor;
begin
  select n.tipo, n.parent_id into v_tipo, v_padre from tenant_node n where n.id = p_nodo;
  if v_tipo = 'barrio' then
    select x.* into f from parametro_valor x
     where x.nodo_id = p_nodo and x.clave = p_clave and x.vigente_desde <= p_fecha
       and not exists (select 1 from parametro_anulacion a where a.fila_id = x.id)
     order by x.vigente_desde desc, x.orden desc limit 1;
    if f.id is not null and f.valor is not null then
      return query select f.valor, 'barrio'::text, f.id, f.vigente_desde, f.carga, f.motivo,
                          f.respaldo_tipo, f.respaldo_referencia, f.respaldo_adjunto;
      return;
    end if;
    p_nodo := v_padre;
  elsif v_tipo is distinct from 'administrador' then
    return;
  end if;
  select x.* into f from parametro_valor x
   where x.nodo_id = p_nodo and x.clave = p_clave and x.vigente_desde <= p_fecha
     and not exists (select 1 from parametro_anulacion a where a.fila_id = x.id)
   order by x.vigente_desde desc, x.orden desc limit 1;
  if f.id is not null then
    return query select f.valor, 'administracion'::text, f.id, f.vigente_desde, f.carga, f.motivo,
                        f.respaldo_tipo, f.respaldo_referencia, f.respaldo_adjunto;
  end if;
end; $$;
--> statement-breakpoint

-- Las administraciones de los barrios que el usuario puede leer. Hace falta porque quien es miembro
-- SOLO del barrio no tiene a la administración en su subárbol (`readable_tenant_ids`, `0018`), y sin
-- esto no vería de dónde hereda (panel `dba-data`). Abre las filas de PARÁMETROS de ese nodo, nada más.
create or replace function app.readable_admin_ancestros() returns setof uuid
  language sql stable security definer set search_path = public, app
as $$
  select distinct n.parent_id
    from tenant_node n
   where n.id in (select app.readable_tenant_ids())
     and n.tipo = 'barrio'
     and n.parent_id is not null;
$$;
--> statement-breakpoint

create or replace function app.puede_leer_parametros(p_nodo uuid) returns boolean
  language sql stable security definer set search_path = public, app
as $$
  select p_nodo in (select app.readable_tenant_ids()) or p_nodo in (select app.readable_admin_ancestros());
$$;
--> statement-breakpoint

-- La versión pública: la misma resolución, con la guarda de lectura. Mensaje uniforme para ajeno e
-- inexistente.
create or replace function app.parametro_resuelto(p_nodo uuid, p_clave text, p_fecha date)
  returns table (valor jsonb, origen text, fila_id uuid, vigente_desde date, carga text, motivo text,
                 respaldo_tipo text, respaldo_referencia text, respaldo_adjunto text)
  language plpgsql stable security definer set search_path = public, app
as $$
begin
  if not app.puede_leer_parametros(p_nodo) then
    raise exception 'el barrio o la administración no existe, o no tenés acceso';
  end if;
  return query select * from app.parametro_resuelto_interno(p_nodo, p_clave, p_fecha);
end; $$;
--> statement-breakpoint

-- Las fechas en que cambia algo que pesa día a día en el interés (cobra, tasas) para un barrio,
-- dentro de `(p_desde, p_hasta]`: las del barrio y las de su administración. Son los cortes de los
-- tramos de `calcularInteresMora`.
create or replace function app.parametros_cambios(p_barrio uuid, p_desde date, p_hasta date)
  returns setof date
  language plpgsql stable security definer set search_path = public, app
as $$
begin
  if not app.puede_leer_parametros(p_barrio) then
    raise exception 'el barrio o la administración no existe, o no tenés acceso';
  end if;
  return query
    select distinct x.vigente_desde
      from parametro_valor x
     where x.nodo_id in (p_barrio, (select n.parent_id from tenant_node n where n.id = p_barrio))
       and x.clave in ('interes.cobra', 'interes.tasa_compensatoria', 'interes.tasa_punitoria')
       and x.vigente_desde > p_desde and x.vigente_desde <= p_hasta
       and not exists (select 1 from parametro_anulacion a where a.fila_id = x.id)
     order by 1;
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 5. Escritura. Solo por estas dos funciones: la tabla no tiene grant de insert para `app_request`.
--
-- Quién: `admin_plataforma` o `admin_barrio` con alcance sobre el nodo (panel de arquitectura). El
-- `operador` queda afuera aunque escribía en `tasa_mora`: es un parámetro de dinero, mismo
-- criterio que el candado de `orden_imputacion` en `0047`/`0050`. Un `admin_barrio` con membresía
-- solo en el barrio edita su barrio y ve la configuración general sin poder tocarla.
-- ---------------------------------------------------------------------------------------------
create or replace function app.puede_editar_parametros(p_nodo uuid) returns boolean
  language sql stable security definer set search_path = public, app
as $$
  select app.has_role_on(p_nodo, array['admin_plataforma','admin_barrio']::app.rol_membership[]);
$$;
--> statement-breakpoint

create or replace function app.candado_parametro(p_nodo uuid, p_clave text) returns void
  language sql security definer set search_path = public, app
as $$
  -- Por (administración, FAMILIA de la clave): fijar en la general y en un barrio de la misma
  -- administración se serializan, y todas las `interes.*` comparten candado — así «Cobra: Sí» no se
  -- cruza con un cambio concurrente de la tasa que verifica (revisión de `security-engineer`, B2).
  select pg_advisory_xact_lock(hashtextextended(
    coalesce((select case when n.tipo = 'barrio' then n.parent_id else n.id end from tenant_node n where n.id = p_nodo), p_nodo)::text
    || '/parametro/' || split_part(p_clave, '.', 1), 0));
$$;
--> statement-breakpoint

create or replace function app.fijar_parametro(
  p_nodo uuid, p_clave text, p_valor jsonb, p_desde date, p_motivo text,
  p_respaldo_tipo text default null, p_respaldo_referencia text default null, p_respaldo_adjunto text default null
) returns uuid
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_tipo    app.tipo_tenant;
  v_valor   jsonb := case when p_valor = 'null'::jsonb then null else p_valor end;
  v_reg     parametro_registro;
  v_tasa    jsonb;
  v_id      uuid;
  v_motivo  text := btrim(coalesce(p_motivo, ''));
  r         record;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión';
  end if;
  select n.tipo into v_tipo from tenant_node n where n.id = p_nodo and n.deleted_at is null;
  if v_tipo is null or v_tipo not in ('administrador', 'barrio') or not app.puede_editar_parametros(p_nodo) then
    raise exception 'solo la administración cambia los parámetros de mora';
  end if;
  select * into v_reg from parametro_registro where clave = p_clave;
  if v_reg.clave is null then
    raise exception 'valor de parámetro inválido: el parámetro % no existe', p_clave;
  end if;
  if p_desde is null or p_desde < current_date then
    raise exception 'un cambio de parámetro rige desde hoy o una fecha futura: nunca hacia atrás';
  end if;
  if length(v_motivo) < 15 then
    raise exception 'el cambio de parámetro necesita un motivo de al menos 15 caracteres';
  end if;
  if v_valor is null and v_tipo = 'administrador' then
    raise exception 'en la administración el parámetro necesita un valor';
  end if;
  if v_reg.requiere_respaldo and v_valor is not null
     and (nullif(btrim(coalesce(p_respaldo_tipo, '')), '') is null or nullif(btrim(coalesce(p_respaldo_referencia, '')), '') is null) then
    raise exception 'una tasa necesita su respaldo: de qué instrumento sale y su referencia';
  end if;
  if p_respaldo_adjunto is not null and not exists (
    select 1 from subida_respaldo_solicitada s where s.storage_key = p_respaldo_adjunto and s.nodo_id = p_nodo
  ) then
    raise exception 'el adjunto del respaldo no es uno que se haya subido para este lugar';
  end if;

  perform app.candado_parametro(p_nodo, p_clave);

  -- «Cobra: Sí» sin tasa es un interés que no calcula nada y que la pantalla diría que se cobra.
  if p_clave = 'interes.cobra' and v_valor = 'true'::jsonb then
    select x.valor into v_tasa from app.parametro_resuelto_interno(p_nodo, 'interes.tasa_compensatoria', p_desde) x;
    if v_tasa is null or (v_tasa #>> '{}')::numeric <= 0 then
      raise exception 'antes de cobrar interés hay que cargar la tasa compensatoria';
    end if;
  end if;

  insert into parametro_valor (nodo_id, clave, valor, vigente_desde, motivo, carga,
                               respaldo_tipo, respaldo_referencia, respaldo_adjunto, creado_por)
  values (p_nodo, p_clave, v_valor, p_desde, v_motivo, 'usuario',
          case when v_valor is null then null else nullif(btrim(coalesce(p_respaldo_tipo, '')), '') end,
          case when v_valor is null then null else nullif(btrim(coalesce(p_respaldo_referencia, '')), '') end,
          case when v_valor is null then null else p_respaldo_adjunto end,
          v_usuario)
  returning id into v_id;

  -- Una tasa compensatoria que queda en cero (o sin valor, al volver a heredar) mientras se cobra
  -- interés es «Cobra: Sí» que no calcula nada y que la pantalla diría que se cobra (revisión de
  -- código, hallazgo 2). Se mira el nodo y, si es la administración, cada barrio que hereda de ella.
  if p_clave = 'interes.tasa_compensatoria' then
    for r in
      select n.id from tenant_node n
       where n.id = p_nodo or (v_tipo = 'administrador' and n.parent_id = p_nodo and n.tipo = 'barrio' and n.deleted_at is null)
    loop
      if (select x.valor from app.parametro_resuelto_interno(r.id, 'interes.cobra', p_desde) x) = 'true'::jsonb
         and coalesce((select (x.valor #>> '{}')::numeric from app.parametro_resuelto_interno(r.id, 'interes.tasa_compensatoria', p_desde) x), 0) <= 0
      then
        raise exception 'mientras se cobre interés, la tasa compensatoria no puede quedar en cero';
      end if;
    end loop;
  end if;

  -- "Volver al valor general" cancela también los valores propios programados para DESPUÉS: si no,
  -- el programado seguiría rigiendo desde su fecha. Se anula con su motivo (queda auditado).
  if v_valor is null then
    for r in
      select x.id from parametro_valor x
       where x.nodo_id = p_nodo and x.clave = p_clave and x.vigente_desde > p_desde and x.valor is not null
         and not exists (select 1 from parametro_anulacion a where a.fila_id = x.id)
    loop
      insert into parametro_anulacion (fila_id, nodo_id, motivo, anulado_por) values (r.id, p_nodo, v_motivo, v_usuario);
    end loop;
  end if;
  return v_id;
end; $$;
--> statement-breakpoint

create or replace function app.anular_parametro_programado(p_fila uuid, p_motivo text) returns uuid
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  f         parametro_valor;
  v_id      uuid;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión';
  end if;
  select * into f from parametro_valor where id = p_fila;
  if f.id is null or not app.puede_editar_parametros(f.nodo_id) then
    raise exception 'solo la administración cambia los parámetros de mora';
  end if;
  if length(btrim(coalesce(p_motivo, ''))) < 15 then
    raise exception 'el cambio de parámetro necesita un motivo de al menos 15 caracteres';
  end if;
  perform app.candado_parametro(f.nodo_id, f.clave);
  if f.vigente_desde <= current_date then
    raise exception 'ese cambio ya rige: no se anula; se fija un valor nuevo desde hoy';
  end if;
  if exists (select 1 from parametro_anulacion a where a.fila_id = f.id) then
    raise exception 'ese cambio programado ya estaba anulado';
  end if;
  -- Una liquidación EMITIDA cuya fecha de referencia ya cae dentro de la vigencia de esta fila la usó
  -- (o pudo usarla en un tramo): anularla dejaría la trazabilidad de esa cifra citando una fila anulada
  -- (regla dura 4; revisión de `security-engineer`, M2). Se fija otro valor en vez de anular.
  if exists (
    select 1 from liquidacion l
      join periodo_expensa pe on pe.id = l.periodo_id
      join tenant_node n on n.id = l.barrio_id
     where pe.estado in ('emitida', 'distribuida')
       and (l.barrio_id = f.nodo_id or n.parent_id = f.nodo_id)
       and l.parametros_mora is not null
       and (l.parametros_mora ->> 'fechaReferencia')::date >= f.vigente_desde
  ) then
    raise exception 'ese cambio ya se usó en una liquidación emitida: no se anula; se fija un valor nuevo';
  end if;
  insert into parametro_anulacion (fila_id, nodo_id, motivo, anulado_por)
  values (f.id, f.nodo_id, btrim(p_motivo), v_usuario) returning id into v_id;
  return v_id;
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 6. RLS y grants. Lectura: el nodo legible o la administración de un barrio legible. Escritura:
--    ninguna directa para `app_request` (solo `execute` sobre las funciones de la sección 5).
-- ---------------------------------------------------------------------------------------------
alter table parametro_registro enable row level security;
--> statement-breakpoint
alter table parametro_registro force row level security;
--> statement-breakpoint
-- El catálogo no tiene datos de nadie, pero tampoco se abre con `true`: la única policy permisiva
-- con `true` de todo el esquema es la del elenco de la demo, y hay un test que lo vigila
-- (`usuario-demo.test.ts`). Lo lee cualquiera con sesión.
create policy parametro_registro_sel on parametro_registro for select using (app.current_user_id() is not null);
--> statement-breakpoint
grant select on table parametro_registro to app_request, app_job;
--> statement-breakpoint

alter table parametro_valor enable row level security;
--> statement-breakpoint
alter table parametro_valor force row level security;
--> statement-breakpoint
create policy parametro_valor_sel on parametro_valor for select
  using (nodo_id in (select app.readable_tenant_ids()) or nodo_id in (select app.readable_admin_ancestros()));
--> statement-breakpoint
grant select on table parametro_valor to app_request;
--> statement-breakpoint
grant select, insert on table parametro_valor to app_job;
--> statement-breakpoint

alter table parametro_anulacion enable row level security;
--> statement-breakpoint
alter table parametro_anulacion force row level security;
--> statement-breakpoint
create policy parametro_anulacion_sel on parametro_anulacion for select
  using (nodo_id in (select app.readable_tenant_ids()) or nodo_id in (select app.readable_admin_ancestros()));
--> statement-breakpoint
grant select on table parametro_anulacion to app_request;
--> statement-breakpoint
grant select, insert on table parametro_anulacion to app_job;
--> statement-breakpoint

alter table subida_respaldo_solicitada enable row level security;
--> statement-breakpoint
alter table subida_respaldo_solicitada force row level security;
--> statement-breakpoint
create policy subida_respaldo_sel on subida_respaldo_solicitada for select
  using (nodo_id in (select app.readable_tenant_ids()) or nodo_id in (select app.readable_admin_ancestros()));
--> statement-breakpoint
create policy subida_respaldo_ins on subida_respaldo_solicitada for insert
  with check (
    app.puede_editar_parametros(nodo_id)
    and exists (select 1 from tenant_node n where n.id = nodo_id and n.tipo in ('administrador', 'barrio'))
  );
--> statement-breakpoint
grant select, insert on table subida_respaldo_solicitada to app_request;
--> statement-breakpoint
grant select on table subida_respaldo_solicitada to app_job;
--> statement-breakpoint

-- Las funciones de escritura las corre `app_job` (BYPASSRLS, con grant de insert): mismo patrón que
-- `app.resolver_imputacion` (`0036`). La guarda de permisos está ADENTRO, contra `current_user_id()`.
alter function app.fijar_parametro(uuid, text, jsonb, date, text, text, text, text) owner to app_job;
--> statement-breakpoint
alter function app.anular_parametro_programado(uuid, text) owner to app_job;
--> statement-breakpoint

do $bloque$
declare
  f text;
begin
  foreach f in array array[
    'app.validar_parametro(text, jsonb)',
    'app.parametro_valor_antes_insert()',
    'app.parametro_solo_agregar()',
    'app.parametro_anulacion_antes_insert()',
    'app.subida_respaldo_antes_insert()',
    'app.tenant_node_parametros_iniciales()',
    'app.parametro_resuelto_interno(uuid, text, date)',
    'app.readable_admin_ancestros()',
    'app.puede_leer_parametros(uuid)',
    'app.parametro_resuelto(uuid, text, date)',
    'app.parametros_cambios(uuid, date, date)',
    'app.puede_editar_parametros(uuid)',
    'app.candado_parametro(uuid, text)',
    'app.fijar_parametro(uuid, text, jsonb, date, text, text, text, text)',
    'app.anular_parametro_programado(uuid, text)'
  ] loop
    execute format('revoke execute on function %s from public', f);
  end loop;
end
$bloque$;
--> statement-breakpoint

grant execute on function app.validar_parametro(text, jsonb) to app_request, app_job;
--> statement-breakpoint
grant execute on function app.readable_admin_ancestros() to app_request, app_job;
--> statement-breakpoint
grant execute on function app.puede_leer_parametros(uuid) to app_request, app_job;
--> statement-breakpoint
grant execute on function app.parametro_resuelto(uuid, text, date) to app_request, app_job;
--> statement-breakpoint
grant execute on function app.parametros_cambios(uuid, date, date) to app_request, app_job;
--> statement-breakpoint
grant execute on function app.puede_editar_parametros(uuid) to app_request, app_job;
--> statement-breakpoint
grant execute on function app.fijar_parametro(uuid, text, jsonb, date, text, text, text, text) to app_request;
--> statement-breakpoint
grant execute on function app.anular_parametro_programado(uuid, text) to app_request;
--> statement-breakpoint
-- La interna, la del candado y las de trigger: solo para quien ya pasó una guarda (`app_job`, dueño
-- de las funciones de escritura y de `resolver_imputacion`).
grant execute on function app.parametro_resuelto_interno(uuid, text, date) to app_job;
--> statement-breakpoint
grant execute on function app.candado_parametro(uuid, text) to app_job;
--> statement-breakpoint
grant execute on function app.puede_editar_parametros(uuid) to app_job;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 7. MIGRACIÓN DE DATOS. Lo que existe se migra **con su comportamiento actual** (decisión del
--    titular); los valores iniciales del registro son solo para administraciones NUEVAS.
-- ---------------------------------------------------------------------------------------------

-- 7.0 Prechequeo: frena si `tasa_mora` tiene datos que la función vieja resolvía de forma no
--     determinística (dos versiones del mismo barrio desde el mismo día) o una tasa imposible
--     (más de 100 % mensual). Corregir a mano y volver a correr: no se adivina cuál valía.
do $bloque$
declare
  n_empates int;
  n_imposibles int;
begin
  select count(*) into n_empates from (
    select barrio_id, vigente_desde from tasa_mora group by 1, 2 having count(*) > 1
  ) e;
  select count(*) into n_imposibles from tasa_mora where tasa_mensual < 0 or tasa_mensual > 1;
  if n_empates > 0 or n_imposibles > 0 then
    raise exception 'migración de tasa_mora frenada: % empates de vigencia y % tasas imposibles. Corregir y volver a correr.',
      n_empates, n_imposibles;
  end if;
end
$bloque$;
--> statement-breakpoint

-- 7.1 Administraciones existentes: el comportamiento de hoy, como «Valor migrado» desde el
--     2000-01-01. Hoy un barrio sin tasa no cobra interés y uno con tasa no tiene gracia ni
--     tolerancia ni punitoria. **`imputacion.orden` NO se siembra**: hoy un barrio sin
--     `orden_imputacion` no imputa automáticamente (falla cerrado), y así sigue hasta que la
--     administración lo fije.
insert into parametro_valor (nodo_id, clave, valor, vigente_desde, motivo, carga)
select n.id, v.clave, v.valor, date '2000-01-01', 'Valor migrado: el comportamiento anterior a la configuración de mora', 'migrado'
  from tenant_node n
 cross join (values
   ('interes.cobra', 'false'::jsonb),
   ('interes.tasa_compensatoria', '"0"'::jsonb),
   ('interes.tasa_punitoria', '"0"'::jsonb),
   ('interes.gracia_dias', '0'::jsonb),
   ('interes.forma_gracia', '"corre_inicio"'::jsonb),
   ('interes.tolerancia', '"0.00"'::jsonb)
 ) as v(clave, valor)
 where n.tipo = 'administrador';
--> statement-breakpoint

-- 7.2 `tasa_mora` → filas propias de cada barrio. Se evalúa la FUNCIÓN VIEJA en cada punto de
--     quiebre (cada `vigente_desde` y cada `vigente_hasta`, que es exclusivo): equivalente por
--     construcción, huecos y solapes incluidos (panel `dba-data`). Donde la vieja devolvía una tasa,
--     el barrio queda con «Cobra: Sí» y esa tasa; donde devolvía NULL, vuelve a heredar (que en una
--     administración migrada es «Cobra: No»). El respaldo, si la versión tenía documento.
with quiebres as (
  select barrio_id, vigente_desde as d from tasa_mora
  union
  select barrio_id, vigente_hasta from tasa_mora where vigente_hasta is not null
),
evaluados as (
  select q.barrio_id, q.d, app.tasa_mora_vigente(q.barrio_id, q.d) as t
    from quiebres q
),
cambios as (
  select e.*, lag(e.t) over (partition by e.barrio_id order by e.d) as previa,
         row_number() over (partition by e.barrio_id order by e.d) as rn
    from evaluados e
),
filas as (
  select c.barrio_id, c.d, c.t,
         (select db.tipo::text from tasa_mora tm join documento_barrio db on db.id = tm.documento_id
           where tm.barrio_id = c.barrio_id and tm.vigente_desde = c.d limit 1) as doc_tipo,
         (select db.titulo from tasa_mora tm join documento_barrio db on db.id = tm.documento_id
           where tm.barrio_id = c.barrio_id and tm.vigente_desde = c.d limit 1) as doc_titulo
    from cambios c
   where (c.rn = 1 and c.t is not null) or (c.rn > 1 and c.t is distinct from c.previa)
)
insert into parametro_valor (nodo_id, clave, valor, vigente_desde, motivo, carga, respaldo_tipo, respaldo_referencia)
select f.barrio_id, x.clave, x.valor, greatest(f.d, date '2000-01-01'),
       'Valor migrado de la tasa de mora del barrio', 'migrado',
       case when x.clave = 'interes.tasa_compensatoria' and f.t is not null and f.doc_titulo is not null
            then case f.doc_tipo when 'reglamento' then 'reglamento' when 'acta_asamblea' then 'acta_asamblea' else 'otro' end end,
       case when x.clave = 'interes.tasa_compensatoria' and f.t is not null and f.doc_titulo is not null
            then left(f.doc_titulo, 300) end
  from filas f
 cross join lateral (values
   ('interes.cobra', case when f.t is null then null else 'true'::jsonb end),
   ('interes.tasa_compensatoria', case when f.t is null then null else to_jsonb(trim_scale(f.t)::text) end)
 ) as x(clave, valor)
 order by f.barrio_id, f.d;
--> statement-breakpoint

-- 7.3 `barrio.orden_imputacion` → fila propia del barrio desde el 2000-01-01 (la columna no tenía
--     historia: cualquier `pago.fecha` resuelve igual que hoy). `fifo_estricto` pasa a
--     `capital_primero`, que es exactamente lo que ya hacía (comentario de `0036`).
insert into parametro_valor (nodo_id, clave, valor, vigente_desde, motivo, carga)
select b.barrio_id, 'imputacion.orden',
       to_jsonb(case b.orden_imputacion when 'fifo_estricto' then 'capital_primero' else b.orden_imputacion end),
       date '2000-01-01', 'Valor migrado del orden de imputación del barrio', 'migrado'
  from barrio b
 where b.orden_imputacion is not null;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 8. `app.resolver_imputacion` lee el orden VIGENTE A LA FECHA DEL PAGO (`pago.fecha`, la fecha del
--    hecho y no la de carga: re-imputar más tarde da lo mismo). Sin valor, sigue fallando cerrado
--    con el mismo mensaje. El resto, idéntico a `0036`.
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
  v_ya_imputado numeric(14,2);
  v_remanente   numeric(14,2);
  v_a_imputar   numeric(14,2);
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

  select coalesce(sum(monto_imputado), 0) into v_ya_imputado
    from pago_imputacion where pago_id = p_pago_id and anulado_at is null;
  v_remanente := v_monto - v_ya_imputado;
  if v_remanente <= 0 then
    return;
  end if;

  for r in
    select l.id,
           l.total - coalesce((
             select sum(pi.monto_imputado) from pago_imputacion pi
              where pi.liquidacion_id = l.id and pi.anulado_at is null
           ), 0) as saldo,
           l.interes_mora, l.created_at
      from liquidacion l
      join periodo_expensa pe on pe.id = l.periodo_id
     where l.unidad_funcional_id = v_unidad
       and pe.estado in ('emitida', 'distribuida')
     order by
       case when v_orden = 'intereses_primero_capital_antiguo' and coalesce(l.interes_mora, 0) > 0
            then 0 else 1 end,
       l.created_at asc,
       l.id asc
  loop
    exit when v_remanente <= 0;
    if r.saldo <= 0 then
      continue;
    end if;
    v_a_imputar := least(v_remanente, r.saldo);
    insert into pago_imputacion (pago_id, liquidacion_id, monto_imputado)
      values (p_pago_id, r.id, v_a_imputar);
    v_remanente := v_remanente - v_a_imputar;
  end loop;
end; $$;
--> statement-breakpoint

alter function app.resolver_imputacion(uuid) owner to app_job;
