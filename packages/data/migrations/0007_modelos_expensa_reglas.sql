-- =============================================================================================
-- 0007_modelos_expensa_reglas — dos correcciones que vienen de la operatoria real:
--
--   1. Hay barrios que liquidan por **cuota fija mensual** (la fija el directorio o el
--      administrador) y no por los gastos del mes. El modelo se guarda POR PERÍODO, así un barrio
--      puede cambiar de criterio sin perder cómo se liquidó cada mes.
--   2. Una expensa **extraordinaria puede existir sin acta de asamblea**. El sistema deja de
--      bloquearla: la marca (`sin_respaldo_asamblea`) para que se vea en la liquidación y pese
--      donde realmente pesa, que es al reclamar la deuda — no al cargar el gasto.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. FKs compuestas y RLS de las tablas nuevas (mismo patrón que el resto del dominio).
-- ---------------------------------------------------------------------------------------------
alter table cuota_fija_version add constraint uq_cuota_fija_version_id_barrio unique (id, barrio_id);
--> statement-breakpoint
alter table cuota_fija
  add constraint fk_cuota_fija_version_barrio foreign key (version_id, barrio_id)
  references cuota_fija_version (id, barrio_id) on delete cascade;
--> statement-breakpoint
alter table cuota_fija
  add constraint fk_cuota_fija_uf_barrio foreign key (unidad_funcional_id, barrio_id)
  references unidad_funcional (id, barrio_id) on delete restrict;
--> statement-breakpoint
alter table cuota_fija_version
  add constraint fk_cuota_fija_version_doc_barrio foreign key (documento_id, barrio_id)
  references documento_barrio (id, barrio_id) on delete set null;
--> statement-breakpoint
alter table periodo_expensa
  add constraint fk_periodo_cuota_fija_barrio foreign key (cuota_fija_version_id, barrio_id)
  references cuota_fija_version (id, barrio_id) on delete restrict;
--> statement-breakpoint

do $bloque$
declare t text;
begin
  foreach t in array array['cuota_fija_version', 'cuota_fija'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I on %I for select using (barrio_id in (select app.accessible_tenant_ids()))',
      t || '_sel', t);
    execute format(
      'create policy %I on %I for insert with check (app.has_role_on(barrio_id, array[''admin_plataforma'',''admin_barrio'',''operador'']::app.rol_membership[]))',
      t || '_ins', t);
    execute format(
      'create policy %I on %I for update using (app.has_role_on(barrio_id, array[''admin_plataforma'',''admin_barrio'',''operador'']::app.rol_membership[])) with check (app.has_role_on(barrio_id, array[''admin_plataforma'',''admin_barrio'',''operador'']::app.rol_membership[]))',
      t || '_upd', t);
    execute format(
      'create policy %I on %I for delete using (app.has_role_on(barrio_id, array[''admin_plataforma'',''admin_barrio'',''operador'']::app.rol_membership[]))',
      t || '_del', t);
    execute format('grant select, insert, update, delete on table %I to app_request', t);
    execute format('grant select, insert, update, delete on table %I to app_job', t);
  end loop;
end
$bloque$;
--> statement-breakpoint

-- Una sola versión de cuota fija abierta por barrio, con la anterior cerrada automáticamente
-- (mismo criterio que las vigencias de los 5 ejes: cerrar ANTES del insert, no después).
create or replace function app.cuota_fija_version_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  if tg_op = 'INSERT' then
    update cuota_fija_version
       set vigente_hasta = new.vigente_desde
     where barrio_id = new.barrio_id
       and id <> new.id
       and vigente_hasta is null
       and vigente_desde <= new.vigente_desde;
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_cuota_fija_version_antes before insert on cuota_fija_version
  for each row execute function app.cuota_fija_version_antes();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. Extraordinaria sin acta: se marca, NO se bloquea.
--    (Antes esto lanzaba una excepción. La operatoria real muestra que la extraordinaria puede
--    existir sin asamblea previa — una bomba que se rompe no espera a la asamblea.)
-- ---------------------------------------------------------------------------------------------
create or replace function app.gasto_respaldo_extraordinaria() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare v_tipo app.tipo_concepto;
begin
  select tipo into v_tipo from concepto where id = new.concepto_id;
  -- La marca la pone la base, no la app: así vale para cualquier vía de carga (UI, importación, job).
  new.sin_respaldo_asamblea := (v_tipo = 'extraordinaria' and new.acta_documento_id is null);
  return new;
end; $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Emisión: el cuadre depende del MODELO del período.
--      variable → lo repartido tiene que ser igual a los gastos del mes.
--      fija     → lo repartido tiene que ser igual a (cuotas fijas + gastos extraordinarios).
-- ---------------------------------------------------------------------------------------------
create or replace function app.validar_emision(p_periodo uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_barrio        uuid;
  v_modelo        app.modelo_expensa;
  v_esperado      numeric(14,2);
  v_repartido     numeric(14,2);
  v_liquidaciones bigint;
  v_unidades      bigint;
  v_version       uuid;
  v_cuota_ver     uuid;
  v_cerrada       boolean;
  v_sin_cuota     bigint;
begin
  select barrio_id, modelo, coeficiente_version_id, cuota_fija_version_id
    into v_barrio, v_modelo, v_version, v_cuota_ver
    from periodo_expensa where id = p_periodo;

  -- Los coeficientes hacen falta en los dos modelos: en el fijo, para prorratear extraordinarias.
  if v_version is null then
    raise exception 'el período no tiene versión de coeficientes: no se puede emitir';
  end if;
  select cerrada into v_cerrada from coeficiente_version where id = v_version;
  if not coalesce(v_cerrada, false) then
    raise exception 'la versión de coeficientes del período no está cerrada';
  end if;

  select count(*) into v_unidades
    from unidad_funcional where barrio_id = v_barrio and baja_at is null;
  select count(*) into v_liquidaciones from liquidacion where periodo_id = p_periodo;
  if v_liquidaciones <> v_unidades then
    raise exception 'faltan liquidaciones: % unidades activas y % liquidaciones', v_unidades, v_liquidaciones;
  end if;

  select coalesce(sum(i.monto), 0) into v_repartido
    from item_liquidacion i join liquidacion l on l.id = i.liquidacion_id
   where l.periodo_id = p_periodo;

  if v_modelo = 'variable' then
    select coalesce(sum(monto), 0) into v_esperado from gasto_periodo where periodo_id = p_periodo;
  else
    if v_cuota_ver is null then
      raise exception 'el período liquida por cuota fija pero no tiene una versión de cuota asignada';
    end if;

    -- Toda unidad activa necesita su cuota: si falta una, se estaría cobrando de menos sin verlo.
    select count(*) into v_sin_cuota
      from unidad_funcional u
     where u.barrio_id = v_barrio and u.baja_at is null
       and not exists (select 1 from cuota_fija c where c.version_id = v_cuota_ver and c.unidad_funcional_id = u.id);
    if v_sin_cuota > 0 then
      raise exception 'faltan % cuotas fijas: hay unidades activas sin importe asignado', v_sin_cuota;
    end if;

    select coalesce(sum(c.importe), 0)
      into v_esperado
      from cuota_fija c
      join unidad_funcional u on u.id = c.unidad_funcional_id and u.baja_at is null
     where c.version_id = v_cuota_ver;

    -- En el modelo fijo solo las EXTRAORDINARIAS se cobran aparte de la cuota.
    v_esperado := v_esperado + coalesce((
      select sum(g.monto) from gasto_periodo g join concepto co on co.id = g.concepto_id
       where g.periodo_id = p_periodo and co.tipo = 'extraordinaria'
    ), 0);
  end if;

  if v_esperado <> v_repartido then
    raise exception 'el período no cuadra (modelo %): esperado % y repartido % (diferencia %)',
      v_modelo, v_esperado, v_repartido, v_esperado - v_repartido;
  end if;
end; $$;
--> statement-breakpoint

-- Una línea de liquidación es de cuota fija (sin gasto ni coeficiente) o de un gasto prorrateado
-- (con los dos). Nunca una mezcla.
alter table item_liquidacion add constraint item_liquidacion_origen_chk check (
  (es_cuota_fija and gasto_id is null and coeficiente_aplicado is null)
  or (not es_cuota_fija and gasto_id is not null and coeficiente_aplicado is not null)
);
