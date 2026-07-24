-- =============================================================================================
-- 0001_tenancy_rls — aislamiento multi-tenant: funciones app.*, trigger de path, roles y RLS.
--
-- Fuente de diseño: docs/diseno/03-modelo-datos.md §A · ADR-0000 §3.1.
-- Lo que Drizzle no modela (funciones, triggers, policies, roles) va acá, en SQL plano versionado.
--
-- Regla del repo: una migración ya aplicada NO se edita; se agrega la siguiente con prefijo mayor.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. Identidad del usuario — la misma política sirve en Supabase y en Postgres puro (ADR §3.1).
--    En Supabase ya existe auth.uid(); en Postgres puro se instala un stub que devuelve NULL y la
--    identidad la aporta la app con `set_config('app.user_id', …, true)` por transacción.
-- ---------------------------------------------------------------------------------------------
do $bloque$
begin
  if to_regprocedure('auth.uid()') is null then
    create schema if not exists auth;
    execute $f$
      create function auth.uid() returns uuid language sql stable as $cuerpo$ select null::uuid $cuerpo$
    $f$;
    execute 'grant usage on schema auth to public';
  end if;
end
$bloque$;
--> statement-breakpoint

create or replace function app.current_user_id() returns uuid
  language sql stable
  set search_path = public, app, auth
as $$
  select coalesce(nullif(current_setting('app.user_id', true), '')::uuid, auth.uid())
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. Subárbol accesible y permiso por rol.
--    STABLE  => Postgres las evalúa una vez por query, no una vez por fila.
--    SECURITY DEFINER => leen membership/tenant_node (que tienen RLS) sin recursión de políticas,
--    con search_path fijo (si no, un search_path del cliente podría secuestrar la resolución).
-- ---------------------------------------------------------------------------------------------
create or replace function app.accessible_tenant_ids() returns setof uuid
  language sql stable security definer
  set search_path = public, app
as $$
  select distinct d.id
  from membership m
  join tenant_node n on n.id = m.tenant_node_id
  join tenant_node d on d.path = n.path or d.path like n.path || '.%'   -- el nodo y su subárbol
  where m.user_id = app.current_user_id()
    and m.activo
    and n.deleted_at is null
    and d.deleted_at is null;
$$;
--> statement-breakpoint

create or replace function app.has_role_on(target_node uuid, roles app.rol_membership[]) returns boolean
  language sql stable security definer
  set search_path = public, app
as $$
  select exists (
    select 1
    from membership m
    join tenant_node mn on mn.id = m.tenant_node_id
    join tenant_node tn on tn.id = target_node
    where m.user_id = app.current_user_id()
      and m.activo
      and m.rol = any(roles)
      and mn.deleted_at is null
      and tn.deleted_at is null
      and (tn.path = mn.path or tn.path like mn.path || '.%')
  );
$$;
--> statement-breakpoint

-- Una función SECURITY DEFINER no debe quedar ejecutable por cualquiera por defecto.
revoke execute on function app.accessible_tenant_ids() from public;
--> statement-breakpoint
revoke execute on function app.has_role_on(uuid, app.rol_membership[]) from public;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Materialized path mantenido por la BASE, no por la app.
--    Si lo calculara la app, un INSERT por fuera (job, migración, consola) lo corrompería y el
--    aislamiento se rompería en silencio (doc 03 §A.2).
-- ---------------------------------------------------------------------------------------------
create or replace function app.tenant_node_set_path() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_parent_path text;
begin
  if new.parent_id is null then
    new.path := new.nid::text;
  else
    select path into v_parent_path from tenant_node where id = new.parent_id;
    if v_parent_path is null then
      raise exception 'parent_id % inexistente', new.parent_id;
    end if;
    new.path := v_parent_path || '.' || new.nid::text;
  end if;
  return new;
end;
$$;
--> statement-breakpoint

create trigger trg_tenant_node_path
  before insert on tenant_node
  for each row execute function app.tenant_node_set_path();
--> statement-breakpoint

-- Re-parentar un nodo reescribe el path de todo su subárbol; el `id` (uuid) NO cambia, así que la
-- RLS del dominio (por `barrio_id`) sigue siendo correcta sin tocar una fila de negocio (§A.9.1).
create or replace function app.tenant_node_repath() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_parent_path text;
  v_nuevo_path  text;
begin
  if new.parent_id is distinct from old.parent_id then
    if new.parent_id is null then
      v_nuevo_path := new.nid::text;
    else
      select path into v_parent_path from tenant_node where id = new.parent_id;
      if v_parent_path is null then
        raise exception 'parent_id % inexistente', new.parent_id;
      end if;
      v_nuevo_path := v_parent_path || '.' || new.nid::text;
    end if;

    if v_nuevo_path = old.path or v_nuevo_path like old.path || '.%' then
      raise exception 'no se puede colgar un nodo de su propio subárbol (ciclo)';
    end if;

    new.path := v_nuevo_path;

    update tenant_node
       set path = v_nuevo_path || substring(path from length(old.path) + 1)
     where path like old.path || '.%';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
--> statement-breakpoint

create trigger trg_tenant_node_repath
  before update on tenant_node
  for each row execute function app.tenant_node_repath();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. Roles de base (equivalente neutral al service_role de Supabase, ADR §4).
--    Sin contraseñas acá: se asignan por entorno (nunca un secreto en el repo).
-- ---------------------------------------------------------------------------------------------
do $bloque$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_request') then
    create role app_request nologin;     -- sujeto a RLS; lo usan las conexiones de request
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_job') then
    create role app_job login bypassrls; -- jobs server-side. NUNCA se expone al cliente.
  end if;
end
$bloque$;
--> statement-breakpoint

grant usage on schema public, app to app_request, app_job;
--> statement-breakpoint
grant select, insert, update on table tenant_node, membership, tenant_grant to app_request;
--> statement-breakpoint
grant select, insert, update, delete on table tenant_node, membership, tenant_grant to app_job;
--> statement-breakpoint
grant execute on function app.current_user_id() to app_request, app_job;
--> statement-breakpoint
grant execute on function app.accessible_tenant_ids() to app_request, app_job;
--> statement-breakpoint
grant execute on function app.has_role_on(uuid, app.rol_membership[]) to app_request, app_job;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. RLS. `force` para que ni el dueño de la tabla la saltee (los superusuarios sí la saltean
--    siempre: por eso ninguna conexión de aplicación usa un superusuario).
-- ---------------------------------------------------------------------------------------------
alter table tenant_node enable row level security;
--> statement-breakpoint
alter table tenant_node force row level security;
--> statement-breakpoint
alter table membership enable row level security;
--> statement-breakpoint
alter table membership force row level security;
--> statement-breakpoint
alter table tenant_grant enable row level security;
--> statement-breakpoint
alter table tenant_grant force row level security;
--> statement-breakpoint

-- tenant_node: se ve el subárbol propio; se crea/edita solo con rol administrativo sobre el padre.
--
-- La segunda condición NO amplía el acceso (si se ve el padre, el hijo ya está en su subárbol): está
-- para que funcione `insert ... returning`. `accessible_tenant_ids()` es STABLE y se evalúa con la
-- foto de datos previa a la sentencia, así que la fila recién insertada todavía "no existe" para
-- ella; mirando al padre, la lectura del RETURNING pasa. Sin esto, toda alta de nodo que devuelva
-- la fila creada falla con "new row violates row-level security policy".
create policy tenant_node_sel on tenant_node for select
  using (
    id in (select app.accessible_tenant_ids())
    or (
      deleted_at is null                 -- un tenant dado de baja no reaparece por la puerta del padre
      and parent_id is not null
      and parent_id in (select app.accessible_tenant_ids())
    )
  );
--> statement-breakpoint
create policy tenant_node_ins on tenant_node for insert
  with check (
    parent_id is not null
    and app.has_role_on(parent_id, array['admin_plataforma','admin_barrio']::app.rol_membership[])
  );
--> statement-breakpoint
create policy tenant_node_upd on tenant_node for update
  using (app.has_role_on(id, array['admin_plataforma','admin_barrio']::app.rol_membership[]))
  with check (app.has_role_on(id, array['admin_plataforma','admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
-- Sin policy de DELETE a propósito: un tenant con datos financieros se da de baja con `deleted_at`.

-- membership: se ven las del subárbol accesible; las otorga quien administra ese nodo.
create policy membership_sel on membership for select
  using (tenant_node_id in (select app.accessible_tenant_ids()));
--> statement-breakpoint
create policy membership_ins on membership for insert
  with check (app.has_role_on(tenant_node_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
create policy membership_upd on membership for update
  using (app.has_role_on(tenant_node_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]))
  with check (app.has_role_on(tenant_node_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]));
--> statement-breakpoint

-- tenant_grant: excepción de aislamiento auditada (art. 2084). La ven las dos puntas; solo la
-- otorga quien administra el tenant de ORIGEN (el que cede la visibilidad).
create policy tenant_grant_sel on tenant_grant for select
  using (
    origen_id in (select app.accessible_tenant_ids())
    or destino_id in (select app.accessible_tenant_ids())
  );
--> statement-breakpoint
create policy tenant_grant_ins on tenant_grant for insert
  with check (app.has_role_on(origen_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
create policy tenant_grant_upd on tenant_grant for update
  using (app.has_role_on(origen_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]))
  with check (app.has_role_on(origen_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]));
