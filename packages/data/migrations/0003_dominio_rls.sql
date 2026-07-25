-- =============================================================================================
-- 0003_dominio_rls — reglas del padrón que hace cumplir la BASE, no la app: FKs a prueba de
-- cruce entre barrios, vigencias de los 5 ejes, cuadre de coeficientes, y RLS de todo el dominio.
--
-- Fuentes: docs/diseno/03-modelo-datos.md §B · knowledge/cordoba/REQUISITOS-MODELO-DATOS.md §1/§3/§9.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. FKs compuestas (id, barrio_id): hacen IMPOSIBLE mezclar datos de dos barrios.
--    Sin esto, un bug de la app podría colgarle a una unidad del barrio A un obligado del barrio B
--    y la RLS no lo vería (las dos filas serían "accesibles" para un administrador que ve ambos).
-- ---------------------------------------------------------------------------------------------
alter table unidad_funcional    add constraint uq_uf_id_barrio        unique (id, barrio_id);
--> statement-breakpoint
alter table obligado            add constraint uq_obligado_id_barrio  unique (id, barrio_id);
--> statement-breakpoint
alter table coeficiente_version add constraint uq_coefver_id_barrio   unique (id, barrio_id);
--> statement-breakpoint
alter table documento_barrio    add constraint uq_documento_id_barrio unique (id, barrio_id);
--> statement-breakpoint

alter table unidad_contacto
  add constraint fk_contacto_uf_barrio foreign key (unidad_funcional_id, barrio_id)
  references unidad_funcional (id, barrio_id) on delete cascade;
--> statement-breakpoint
alter table unidad_obligado
  add constraint fk_uo_uf_barrio foreign key (unidad_funcional_id, barrio_id)
  references unidad_funcional (id, barrio_id) on delete restrict;
--> statement-breakpoint
alter table unidad_obligado
  add constraint fk_uo_obligado_barrio foreign key (obligado_id, barrio_id)
  references obligado (id, barrio_id) on delete restrict;
--> statement-breakpoint
alter table coeficiente
  add constraint fk_coef_uf_barrio foreign key (unidad_funcional_id, barrio_id)
  references unidad_funcional (id, barrio_id) on delete restrict;
--> statement-breakpoint
alter table coeficiente
  add constraint fk_coef_version_barrio foreign key (version_id, barrio_id)
  references coeficiente_version (id, barrio_id) on delete cascade;
--> statement-breakpoint
alter table barrio_atributo_vigencia
  add constraint fk_vigencia_documento_barrio foreign key (documento_id, barrio_id)
  references documento_barrio (id, barrio_id) on delete set null;
--> statement-breakpoint
alter table coeficiente_version
  add constraint fk_coefver_documento_barrio foreign key (documento_id, barrio_id)
  references documento_barrio (id, barrio_id) on delete set null;
--> statement-breakpoint
alter table mandato_administracion
  add constraint fk_mandato_acta_barrio foreign key (acta_documento_id, barrio_id)
  references documento_barrio (id, barrio_id) on delete set null;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. Un `barrio` solo puede colgar de un nodo de tenancía de tipo 'barrio'.
-- ---------------------------------------------------------------------------------------------
create or replace function app.barrio_nodo_valido() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare v_tipo app.tipo_tenant;
begin
  select tipo into v_tipo from tenant_node where id = new.barrio_id;
  if v_tipo is null then raise exception 'el nodo % no existe', new.barrio_id; end if;
  if v_tipo <> 'barrio' then
    raise exception 'el nodo % es de tipo %, y solo un nodo de tipo barrio puede tener datos de barrio', new.barrio_id, v_tipo;
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_barrio_nodo_valido before insert on barrio
  for each row execute function app.barrio_nodo_valido();
--> statement-breakpoint

-- `updated_at` lo pone la base: si lo pone la app, el día que alguien escriba por fuera se pierde.
create or replace function app.set_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_barrio_updated before update on barrio
  for each row execute function app.set_updated_at();
--> statement-breakpoint
create trigger trg_uf_updated before update on unidad_funcional
  for each row execute function app.set_updated_at();
--> statement-breakpoint
create trigger trg_obligado_updated before update on obligado
  for each row execute function app.set_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Los 5 ejes: la tabla de vigencias es la FUENTE DE VERDAD; la columna del barrio es un cache.
--
--    `app.valor_eje_vigente(barrio, eje, fecha)` es lo que hay que usar para cualquier acto CON
--    FECHA (liquidar un período viejo con la figura que regía entonces). La columna sirve para la
--    lectura caliente del "ahora" y la mantiene el trigger.
-- ---------------------------------------------------------------------------------------------
create or replace function app.validar_valor_eje(p_eje app.eje_barrio, p_valor text) returns void
  language plpgsql as $$
begin
  case p_eje
    when 'figura_juridica'               then perform p_valor::app.figura_juridica;
    when 'adecuado_art_2075'             then perform p_valor::app.adecuacion_2075;
    when 'encuadre_urbanistico'          then perform p_valor::app.encuadre_urbanistico;
    when 'servicios_internos_a_cargo_de' then perform p_valor::app.servicios_internos;
    when 'municipio' then
      if p_valor !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
        raise exception 'municipio inválido: % (esperado slug, ej ''villa-allende'')', p_valor;
      end if;
  end case;
end; $$;
--> statement-breakpoint

create or replace function app.valor_eje_vigente(p_barrio uuid, p_eje app.eje_barrio, p_fecha date default current_date)
  returns text
  language sql stable security definer set search_path = public, app
as $$
  select v.valor
  from barrio_atributo_vigencia v
  where v.barrio_id = p_barrio
    and v.eje = p_eje
    and v.vigente_desde <= p_fecha
    and (v.vigente_hasta is null or v.vigente_hasta > p_fecha)
  order by v.vigente_desde desc
  limit 1;
$$;
--> statement-breakpoint

-- Copia el valor vigente HOY a la columna del barrio (cache derivado).
create or replace function app.sincronizar_eje_barrio(p_barrio uuid, p_eje app.eje_barrio) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare v_valor text;
begin
  v_valor := app.valor_eje_vigente(p_barrio, p_eje, current_date);
  if v_valor is null then return; end if;

  case p_eje
    when 'figura_juridica' then
      update barrio set figura_juridica = v_valor::app.figura_juridica where barrio_id = p_barrio;
    when 'adecuado_art_2075' then
      update barrio set adecuado_art_2075 = v_valor::app.adecuacion_2075 where barrio_id = p_barrio;
    when 'encuadre_urbanistico' then
      update barrio set encuadre_urbanistico = v_valor::app.encuadre_urbanistico where barrio_id = p_barrio;
    when 'servicios_internos_a_cargo_de' then
      update barrio set servicios_internos_a_cargo_de = v_valor::app.servicios_internos where barrio_id = p_barrio;
    when 'municipio' then
      update barrio set municipio = v_valor where barrio_id = p_barrio;
  end case;
end; $$;
--> statement-breakpoint

create or replace function app.vigencia_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  perform app.validar_valor_eje(new.eje, new.valor);

  -- La vigencia anterior se cierra el día en que empieza la nueva. Va ANTES del insert, no después:
  -- el índice único de "una sola vigencia abierta por eje" se verifica al insertar la fila, así que
  -- si se cerrara la anterior en un trigger AFTER, el insert ya habría fallado.
  if tg_op = 'INSERT' then
    update barrio_atributo_vigencia
       set vigente_hasta = new.vigente_desde
     where barrio_id = new.barrio_id
       and eje = new.eje
       and vigente_hasta is null
       and vigente_desde <= new.vigente_desde;
  end if;

  return new;
end; $$;
--> statement-breakpoint
create trigger trg_vigencia_antes before insert or update on barrio_atributo_vigencia
  for each row execute function app.vigencia_antes();
--> statement-breakpoint

create or replace function app.vigencia_despues() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  perform app.sincronizar_eje_barrio(new.barrio_id, new.eje);
  return null;
end; $$;
--> statement-breakpoint
create trigger trg_vigencia_despues after insert on barrio_atributo_vigencia
  for each row execute function app.vigencia_despues();
--> statement-breakpoint

-- Al dar de alta un barrio se siembran las vigencias iniciales con los valores de la fila: así la
-- fuente de verdad histórica nunca nace vacía ni desalineada del cache.
create or replace function app.barrio_sembrar_vigencias() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  insert into barrio_atributo_vigencia (barrio_id, eje, valor, vigente_desde)
  values
    (new.barrio_id, 'figura_juridica',               new.figura_juridica::text,               current_date),
    (new.barrio_id, 'adecuado_art_2075',             new.adecuado_art_2075::text,             current_date),
    (new.barrio_id, 'encuadre_urbanistico',          new.encuadre_urbanistico::text,          current_date),
    (new.barrio_id, 'municipio',                     new.municipio,                           current_date),
    (new.barrio_id, 'servicios_internos_a_cargo_de', new.servicios_internos_a_cargo_de::text, current_date);
  return null;
end; $$;
--> statement-breakpoint
create trigger trg_barrio_sembrar_vigencias after insert on barrio
  for each row execute function app.barrio_sembrar_vigencias();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. Coeficientes: una versión NO se cierra si no cuadra, y una cerrada no se toca más.
--    (arts. 2046 inc. c y 2081: el reglamento fija el criterio, y puede no ser porcentual.)
-- ---------------------------------------------------------------------------------------------
create or replace function app.validar_coeficientes(p_version uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_barrio     uuid;
  v_base       app.base_coeficiente;
  v_suma       numeric(24,9);
  v_con_coef   bigint;
  v_unidades   bigint;
begin
  select barrio_id, base into v_barrio, v_base from coeficiente_version where id = p_version;
  if v_barrio is null then raise exception 'la versión de coeficientes % no existe', p_version; end if;

  select coalesce(sum(valor), 0), count(*) into v_suma, v_con_coef
    from coeficiente where version_id = p_version;

  select count(*) into v_unidades
    from unidad_funcional where barrio_id = v_barrio and baja_at is null;

  if v_unidades = 0 then
    raise exception 'el barrio no tiene unidades activas: no hay nada que prorratear';
  end if;

  -- Todas las unidades activas tienen que tener coeficiente, incluidas las BALDÍAS (art. 2077).
  if v_con_coef <> v_unidades then
    raise exception 'faltan coeficientes: % unidades activas y % coeficientes cargados', v_unidades, v_con_coef;
  end if;

  if v_base = 'parte_indivisa' then
    -- Expresado en fracción de 1 (0.0125 = 1,25%). Si no cierra exacto, no se cierra la versión.
    if v_suma <> 1 then
      raise exception 'los coeficientes no cuadran: suman % y tienen que sumar exactamente 1', v_suma;
    end if;
  else
    -- Superficie/lote/mixto: son pesos relativos, no porcentajes; alcanza con que haya masa positiva.
    if v_suma <= 0 then
      raise exception 'los coeficientes no cuadran: la suma de los pesos es %', v_suma;
    end if;
  end if;
end; $$;
--> statement-breakpoint

create or replace function app.coeficiente_version_cerrar() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if new.cerrada and not old.cerrada then
    perform app.validar_coeficientes(new.id);
    new.cerrada_at := now();
  elsif old.cerrada and not new.cerrada then
    raise exception 'una versión de coeficientes cerrada no se reabre: se crea una versión nueva';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_coefver_cerrar before update on coeficiente_version
  for each row execute function app.coeficiente_version_cerrar();
--> statement-breakpoint

create or replace function app.coeficiente_version_abierta() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare v_cerrada boolean;
begin
  select cerrada into v_cerrada
    from coeficiente_version
   where id = coalesce(new.version_id, old.version_id);
  if v_cerrada then
    raise exception 'la versión de coeficientes está cerrada: no se modifica (creá una versión nueva)';
  end if;
  return coalesce(new, old);
end; $$;
--> statement-breakpoint
-- Solo INSERT/UPDATE: el DELETE queda para mantenimiento (purga de un barrio, corrección de carga)
-- y desde la app es imposible igual, porque `app_request` no tiene privilegio de DELETE.
create trigger trg_coeficiente_version_abierta before insert or update on coeficiente
  for each row execute function app.coeficiente_version_abierta();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. RLS del dominio. Mismo patrón para todas: se lee lo del subárbol accesible; escribe quien
--    tiene rol administrativo/operativo SOBRE ESE BARRIO. Sin policy de DELETE: las bajas son
--    lógicas (`baja_at`, `hasta`, `vigente_hasta`) — el padrón y el dinero no se evaporan.
-- ---------------------------------------------------------------------------------------------
do $bloque$
declare
  t text;
  tablas text[] := array[
    'barrio', 'barrio_atributo_vigencia', 'unidad_funcional', 'unidad_contacto', 'obligado',
    'unidad_obligado', 'coeficiente_version', 'coeficiente', 'documento_barrio', 'mandato_administracion'
  ];
  col text;
begin
  foreach t in array tablas loop
    -- `barrio` guarda su tenant en `barrio_id` igual que el resto (es su propia PK).
    col := 'barrio_id';

    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);

    execute format(
      'create policy %I on %I for select using (%I in (select app.accessible_tenant_ids()))',
      t || '_sel', t, col);

    execute format(
      'create policy %I on %I for insert with check (app.has_role_on(%I, array[''admin_plataforma'',''admin_barrio'',''operador'']::app.rol_membership[]))',
      t || '_ins', t, col);

    execute format(
      'create policy %I on %I for update using (app.has_role_on(%I, array[''admin_plataforma'',''admin_barrio'',''operador'']::app.rol_membership[])) with check (app.has_role_on(%I, array[''admin_plataforma'',''admin_barrio'',''operador'']::app.rol_membership[]))',
      t || '_upd', t, col, col);

    execute format('grant select, insert, update on table %I to app_request', t);
    execute format('grant select, insert, update, delete on table %I to app_job', t);
  end loop;
end
$bloque$;
--> statement-breakpoint

grant execute on function app.valor_eje_vigente(uuid, app.eje_barrio, date) to app_request, app_job;
--> statement-breakpoint
grant execute on function app.validar_coeficientes(uuid) to app_request, app_job;
