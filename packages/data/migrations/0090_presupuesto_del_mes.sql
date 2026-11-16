-- =============================================================================================
-- 0090_presupuesto_del_mes — lo que el barrio espera gastar en un mes, rubro por rubro (encargo 16c).
-- **Solo DDL**: no modifica ni borra ninguna fila.
--
-- El presupuesto **no entra al cálculo del cupón**: solo propone el importe del mes (que se sigue
-- grabando por Configuración → Cuota, `definirCuotaFija`) y después se compara contra lo gastado. Por
-- eso no hay ninguna FK desde `liquidacion` ni desde nada que calcule plata.
--
--   · `presupuesto_rubro`: un importe por período y por rubro. El rubro es el catálogo `concepto`, el
--     mismo con el que ya se cargan los gastos (`gasto_periodo.concepto_id`): así «gastado contra
--     presupuesto» compara la misma cosa.
--   · `presupuesto_margen`: el margen del mes (para imprevistos y para lo que no se cobre a tiempo),
--     uno por período. Total a pedir = la suma de los rubros + el margen.
--
-- Lo carga la administración del barrio (admin_barrio / admin_plataforma) y se cambia solo mientras el
-- mes se prepara: emitido, queda como se presupuestó. Lo leen los roles de gestión, como el resto.
-- =============================================================================================

create table presupuesto_rubro (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  periodo_id uuid not null,
  concepto_id uuid not null,
  monto numeric(14, 2) not null,
  cargado_por uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint presupuesto_rubro_monto_chk check (monto >= 0),
  constraint uq_presupuesto_rubro unique (periodo_id, concepto_id),
  constraint fk_presupuesto_rubro_periodo foreign key (periodo_id, barrio_id)
    references periodo_expensa (id, barrio_id) on delete cascade,
  constraint fk_presupuesto_rubro_concepto foreign key (concepto_id, barrio_id)
    references concepto (id, barrio_id) on delete restrict
);
--> statement-breakpoint
create index idx_presupuesto_rubro_barrio on presupuesto_rubro (barrio_id);
--> statement-breakpoint
comment on table presupuesto_rubro is
  'Lo que el barrio espera gastar en un mes por rubro (el catálogo concepto). No interviene en el cálculo del cupón: propone el importe y se compara contra gasto_periodo.';
--> statement-breakpoint

create table presupuesto_margen (
  periodo_id uuid primary key,
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  monto numeric(14, 2) not null,
  cargado_por uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint presupuesto_margen_monto_chk check (monto >= 0),
  constraint fk_presupuesto_margen_periodo foreign key (periodo_id, barrio_id)
    references periodo_expensa (id, barrio_id) on delete cascade
);
--> statement-breakpoint
create index idx_presupuesto_margen_barrio on presupuesto_margen (barrio_id);
--> statement-breakpoint
comment on table presupuesto_margen is
  'El margen del presupuesto de un mes, para imprevistos y para lo que no se cobre a tiempo. Total a pedir = suma de presupuesto_rubro + este margen.';
--> statement-breakpoint

-- Quién y cuándo lo pone la base, y solo mientras el mes se prepara. `security invoker`: lee el
-- período con los permisos de quien escribe, que es la administración del barrio.
create or replace function app.presupuesto_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
declare
  v_periodo uuid := coalesce(new.periodo_id, old.periodo_id);
  v_estado  text;
  v_origen  text;
begin
  select estado::text, origen into v_estado, v_origen from periodo_expensa where id = v_periodo for share;
  if v_estado is null then
    -- El período se está borrando (cascada): el presupuesto se va con él.
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'el período del presupuesto no existe';
  end if;
  if v_origen <> 'mensual' then
    raise exception 'la deuda anterior a la activación no tiene presupuesto';
  end if;
  if v_estado in ('emitida', 'distribuida') then
    raise exception 'el mes ya se emitió: el presupuesto queda como se cargó';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.periodo_id, new.barrio_id) is distinct from (old.periodo_id, old.barrio_id) then
    raise exception 'un presupuesto no se mueve de mes';
  end if;
  -- Anidado y no con `and`: plpgsql evalúa la expresión entera, y la tabla del margen no tiene rubro.
  if tg_table_name = 'presupuesto_rubro' and tg_op = 'UPDATE' then
    if new.concepto_id is distinct from old.concepto_id then
      raise exception 'el rubro de un presupuesto no se cambia: se saca y se agrega';
    end if;
  end if;
  new.cargado_por := app.current_user_id();
  if new.cargado_por is null then
    raise exception 'el presupuesto se carga con una identidad';
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end; $$;
--> statement-breakpoint
revoke execute on function app.presupuesto_antes() from public;
--> statement-breakpoint
grant execute on function app.presupuesto_antes() to app_request, app_job;
--> statement-breakpoint
create trigger trg_presupuesto_rubro_antes before insert or update or delete on presupuesto_rubro
  for each row execute function app.presupuesto_antes();
--> statement-breakpoint
create trigger trg_presupuesto_margen_antes before insert or update or delete on presupuesto_margen
  for each row execute function app.presupuesto_antes();
--> statement-breakpoint

do $bloque$
declare
  t text;
  admin constant text := 'array[''admin_plataforma'',''admin_barrio'']::app.rol_membership[]';
begin
  foreach t in array array['presupuesto_rubro', 'presupuesto_margen'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    -- Lectura por rol de gestión (`app.readable_tenant_ids()`, `0018`); escritura, la administración.
    execute format('create policy %I on %I for select using (barrio_id in (select app.readable_tenant_ids()))', t || '_sel', t);
    execute format('create policy %I on %I for insert with check (app.has_role_on(barrio_id, %s))', t || '_ins', t, admin);
    execute format('create policy %I on %I for update using (app.has_role_on(barrio_id, %s)) with check (app.has_role_on(barrio_id, %s))', t || '_upd', t, admin, admin);
    execute format('create policy %I on %I for delete using (app.has_role_on(barrio_id, %s))', t || '_del', t, admin);
    execute format('grant select, insert, delete on table %I to app_request', t);
    execute format('grant select on table %I to app_job', t);
  end loop;
end
$bloque$;
--> statement-breakpoint
-- Del presupuesto se cambia el importe; lo demás lo pone la base o no se mueve.
grant update (monto, cargado_por, created_at, updated_at) on table presupuesto_rubro to app_request;
--> statement-breakpoint
grant update (monto, cargado_por, created_at, updated_at) on table presupuesto_margen to app_request;
