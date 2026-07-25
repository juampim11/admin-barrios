-- =============================================================================================
-- 0016_cargos_descuentos_reglas — lo que la base hace cumplir sola sobre cargos y descuentos.
--
-- Diseño: docs/diseno/08-criterios-de-reparto.md Partes II y III.
--
-- Las cuatro ideas que ordenan este archivo:
--   1. **El dinero lo calcula y lo verifica la base, no el request.** Si la base de cálculo viniera
--      del cliente, verificar "5% de X" sería aritmética sobre datos que eligió el atacante.
--   2. **El signo lo pone la clase**, no quien escribe: `monto_resuelto` es columna generada.
--   3. **El cruce de unidades se cierra con una FK de tres columnas**, no con una verificación al
--      emitir: `validar_emision` corre una sola vez; la FK rechaza en el INSERT.
--   4. **El invariante del prorrateo no se afloja**: se le agrega un `where clase_item='prorrateo'`.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. Anti-cruce entre barrios: FKs compuestas, el patrón de 0003/0005.
-- ---------------------------------------------------------------------------------------------
alter table concepto_boleta       add constraint uq_concepto_boleta_id_barrio       unique (id, barrio_id);
--> statement-breakpoint
alter table concepto_boleta_valor add constraint uq_concepto_boleta_valor_id_barrio unique (id, barrio_id);
--> statement-breakpoint
alter table concepto_boleta       add constraint uq_concepto_boleta_id_clase        unique (id, clase);
--> statement-breakpoint
alter table concepto_boleta       add constraint uq_concepto_boleta_id_metodo       unique (id, metodo);
--> statement-breakpoint

alter table concepto_boleta_valor
  add constraint fk_cbv_concepto_barrio foreign key (concepto_boleta_id, barrio_id)
  references concepto_boleta (id, barrio_id) on delete cascade;
--> statement-breakpoint
-- El método viaja al valor por FK: hace que el check de parámetros sea declarativo, sin trigger.
alter table concepto_boleta_valor
  add constraint fk_cbv_concepto_metodo foreign key (concepto_boleta_id, metodo)
  references concepto_boleta (id, metodo) on update cascade;
--> statement-breakpoint

alter table concepto_boleta_unidad
  add constraint fk_cbu_periodo_barrio foreign key (periodo_id, barrio_id)
  references periodo_expensa (id, barrio_id) on delete cascade;
--> statement-breakpoint
alter table concepto_boleta_unidad
  add constraint fk_cbu_uf_barrio foreign key (unidad_funcional_id, barrio_id)
  references unidad_funcional (id, barrio_id) on delete restrict;
--> statement-breakpoint
alter table concepto_boleta_unidad
  add constraint fk_cbu_concepto_barrio foreign key (concepto_boleta_id, barrio_id)
  references concepto_boleta (id, barrio_id) on delete restrict;
--> statement-breakpoint
alter table concepto_boleta_unidad
  add constraint fk_cbu_valor_barrio foreign key (valor_id, barrio_id)
  references concepto_boleta_valor (id, barrio_id) on delete restrict;
--> statement-breakpoint
alter table concepto_boleta_unidad
  add constraint fk_cbu_concepto_clase foreign key (concepto_boleta_id, clase)
  references concepto_boleta (id, clase) on update cascade;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. `monto_resuelto`: el signo lo pone la clase, no el que escribe.
-- ---------------------------------------------------------------------------------------------
alter table concepto_boleta_unidad add column monto_resuelto numeric(14,2)
  generated always as (case when clase = 'descuento' then -importe_resuelto else importe_resuelto end) stored;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. La aritmética la verifica la base. Es el control que convierte "confío en el servicio" en
--    "no hace falta confiar": la base de cálculo la deriva el servicio desde la liquidación, y acá
--    se comprueba que el importe sea exactamente el que corresponde al parámetro congelado.
-- ---------------------------------------------------------------------------------------------
alter table concepto_boleta_unidad add constraint cbu_aritmetica_chk check (
  importe_resuelto is null
  or importe_resuelto = least(
       case metodo
         when 'monto_fijo'        then monto_fijo
         when 'porcentaje'        then round(base_calculada * porcentaje / 100, 2)
         when 'precio_x_cantidad' then round(precio_unitario * cantidad, 2)
       end,
       coalesce(tope, case metodo
         when 'monto_fijo'        then monto_fijo
         when 'porcentaje'        then round(base_calculada * porcentaje / 100, 2)
         when 'precio_x_cantidad' then round(precio_unitario * cantidad, 2)
       end))
);
--> statement-breakpoint
-- Un descuento nunca supera su propia base: si no, se come el fondo de reserva y la extraordinaria
-- por el camino, que son exactamente las dos exclusiones duras del diseño.
alter table concepto_boleta_unidad add constraint cbu_no_supera_base_chk check (
  clase <> 'descuento' or importe_resuelto is null or importe_resuelto <= base_calculada
);
--> statement-breakpoint
-- Un porcentual sin techo escala con la expensa: el 5% que hoy son $9.000 son $90.000 con una obra.
alter table concepto_boleta_valor add constraint cbv_tope_obligatorio_chk check (
  metodo <> 'porcentaje' or tope is not null
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. La línea de la boleta: clase, signo, y la FK de tres columnas contra el cruce de unidades.
-- ---------------------------------------------------------------------------------------------
alter table item_liquidacion drop constraint item_liquidacion_origen_chk;
--> statement-breakpoint
alter table item_liquidacion add constraint item_liquidacion_origen_chk check (
     (clase_item = 'prorrateo'  and gasto_id is not null and coeficiente_aplicado is not null
                                and aplicacion_id is null and tipo is not null)
  or (clase_item = 'cuota_fija' and gasto_id is null and coeficiente_aplicado is null
                                and aplicacion_id is null and tipo is not null)
  or (clase_item in ('cargo','descuento') and gasto_id is null and coeficiente_aplicado is null
                                and aplicacion_id is not null and tipo is null)
);
--> statement-breakpoint
alter table item_liquidacion add constraint item_liquidacion_signo_chk check (
  (clase_item = 'descuento' and monto <= 0) or (clase_item <> 'descuento' and monto >= 0)
);
--> statement-breakpoint
-- `es_cuota_fija` queda deprecada pero coherente: se borra cuando el servicio deje de leerla.
alter table item_liquidacion add constraint item_clase_legacy_chk check (
  es_cuota_fija = (clase_item = 'cuota_fija')
);
--> statement-breakpoint
alter table item_liquidacion add constraint item_aplicacion_trio_chk check (
  num_nonnulls(aplicacion_id, aplicacion_periodo_id, aplicacion_unidad_id) in (0, 3)
);
--> statement-breakpoint

-- Las dos FKs que hacen **estructuralmente imposible** que un cargo caiga en la boleta de otra
-- unidad. Con `MATCH SIMPLE` (el default), una fila con las tres columnas en NULL no se evalúa:
-- las líneas de prorrateo y de cuota fija pasan libres.
alter table item_liquidacion
  add constraint fk_item_liq_trio foreign key (liquidacion_id, aplicacion_periodo_id, aplicacion_unidad_id)
  references liquidacion (id, periodo_id, unidad_funcional_id) on delete cascade;
--> statement-breakpoint
alter table item_liquidacion
  add constraint fk_item_aplicacion_trio foreign key (aplicacion_id, aplicacion_periodo_id, aplicacion_unidad_id)
  references concepto_boleta_unidad (id, periodo_id, unidad_funcional_id) on delete restrict;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. Triggers: identidad, período editable, vigencia y auditoría.
-- ---------------------------------------------------------------------------------------------

-- El valor vigente de un concepto A UNA FECHA. Sin default de fecha a propósito: un job que
-- regenere un período viejo tiene que pasar la fecha del hecho, no agarrar la tarifa de hoy.
create or replace function app.concepto_valor_vigente(p_concepto uuid, p_fecha date) returns uuid
  language sql stable security definer set search_path = public, app
as $$
  select v.id from concepto_boleta_valor v
   where v.concepto_boleta_id = p_concepto
     and v.vigente_desde <= p_fecha
     and (v.vigente_hasta is null or v.vigente_hasta > p_fecha)
   order by v.vigente_desde desc
   limit 1;
$$;
--> statement-breakpoint

-- Cierra la versión anterior DEL MISMO CONCEPTO (no del barrio: copiar el de la cuota fija tal cual
-- dejaría todos los conceptos del barrio compartiendo una sola vigencia).
create or replace function app.concepto_boleta_valor_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  if tg_op = 'INSERT' then
    update concepto_boleta_valor
       set vigente_hasta = new.vigente_desde
     where concepto_boleta_id = new.concepto_boleta_id
       and id <> new.id
       and vigente_hasta is null
       and vigente_desde <= new.vigente_desde;
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_concepto_boleta_valor_antes before insert on concepto_boleta_valor
  for each row execute function app.concepto_boleta_valor_antes();
--> statement-breakpoint

-- La firma la pone la base. Una firma que manda el cliente no es una firma: un descuento es plata
-- que el barrio deja de cobrar, y sin autor verificable no hay control posible.
create or replace function app.cbu_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario uuid;
  v_limite  record;
begin
  v_usuario := app.current_user_id();
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: aplicar un concepto requiere identidad';
  end if;

  if tg_op = 'INSERT' then
    new.aplicado_por := v_usuario;
    new.aplicado_at := now();

    -- Tope por rol: el `operador` aplica lo que existe, pero no cualquier monto. **Falla cerrado**:
    -- si el barrio no cargó límite, el operador no aplica descuentos (los cargos sí: son tarifa).
    if not app.has_role_on(new.barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
      if exists (select 1 from concepto_boleta where id = new.concepto_boleta_id and requiere_admin) then
        raise exception 'este concepto solo lo puede aplicar un administrador del barrio';
      end if;

      if new.clase = 'descuento' then
        select * into v_limite from limite_aplicacion_barrio
         where barrio_id = new.barrio_id and vigente_hasta is null limit 1;
        if v_limite is null then
          raise exception 'el barrio no tiene límite de aplicación cargado: un operador no puede aplicar descuentos';
        end if;
        if new.importe_resuelto is not null and new.importe_resuelto > v_limite.monto_max_operador then
          raise exception 'el importe supera el tope del operador (%): lo tiene que aplicar un administrador',
            v_limite.monto_max_operador;
        end if;
      end if;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    -- No se edita: se anula y se crea otra. Editar destruye la evidencia de qué se aprobó.
    if (new.concepto_boleta_id, new.valor_id, new.unidad_funcional_id, new.periodo_id, new.clase,
        new.porcentaje, new.precio_unitario, new.monto_fijo, new.cantidad, new.tope, new.fecha_hecho)
       is distinct from
       (old.concepto_boleta_id, old.valor_id, old.unidad_funcional_id, old.periodo_id, old.clase,
        old.porcentaje, old.precio_unitario, old.monto_fijo, old.cantidad, old.tope, old.fecha_hecho)
    then
      raise exception 'una aplicación no se edita: se anula (con motivo) y se crea otra';
    end if;
    if old.anulado_at is not null and new.anulado_at is null then
      raise exception 'una anulación no se revierte';
    end if;
    if new.anulado_at is not null and old.anulado_at is null then
      new.anulado_por := v_usuario;
    end if;
    new.aplicado_por := old.aplicado_por;   -- el autor original no se pisa nunca
  end if;

  return new;
end; $$;
--> statement-breakpoint
create trigger trg_cbu_antes before insert or update on concepto_boleta_unidad
  for each row execute function app.cbu_antes();
--> statement-breakpoint
create trigger trg_cbu_editable before insert or update or delete on concepto_boleta_unidad
  for each row execute function app.periodo_editable();
--> statement-breakpoint

-- Auditoría append-only: la escribe la base, nunca la app.
create or replace function app.cbu_evento() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  if tg_op = 'INSERT' then
    insert into concepto_boleta_unidad_evento (barrio_id, aplicacion_id, evento, actor, importe_resuelto, base_calculada, motivo)
    values (new.barrio_id, new.id, 'alta', new.aplicado_por, new.importe_resuelto, new.base_calculada, new.detalle);
  elsif new.anulado_at is not null and old.anulado_at is null then
    insert into concepto_boleta_unidad_evento (barrio_id, aplicacion_id, evento, actor, importe_resuelto, base_calculada, motivo)
    values (new.barrio_id, new.id, 'anulacion', new.anulado_por, new.importe_resuelto, new.base_calculada, new.motivo_anulacion);
  elsif new.importe_resuelto is distinct from old.importe_resuelto then
    insert into concepto_boleta_unidad_evento (barrio_id, aplicacion_id, evento, actor, importe_resuelto, base_calculada, motivo)
    values (new.barrio_id, new.id, 'resolucion', coalesce(app.current_user_id(), new.aplicado_por),
            new.importe_resuelto, new.base_calculada, null);
  end if;
  return null;
end; $$;
--> statement-breakpoint
create trigger trg_cbu_evento after insert or update on concepto_boleta_unidad
  for each row execute function app.cbu_evento();
--> statement-breakpoint

-- La historia no se reescribe.
create or replace function app.solo_append() returns trigger
  language plpgsql as $$
begin
  raise exception 'el registro de eventos es append-only: no se modifica ni se borra';
end; $$;
--> statement-breakpoint
create trigger trg_cbu_evento_append before update or delete on concepto_boleta_unidad_evento
  for each row execute function app.solo_append();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 6. RLS. **Excepción explícita al patrón**: `propietario` y `residente` NO leen ninguna fila de
--    este módulo. Con descuentos por unidad, lo que se filtra ya no es un monto sino el MOTIVO
--    ("jubilado", "eximición social"): dato personal sensible sobre un tercero, y el combustible de
--    conflicto más eficiente que hay en un barrio. Se reabre cuando exista el vínculo
--    usuario→unidad y la RLS pueda filtrar por unidad (doc 08 §Y).
--
--    Y el privilegio va partido: el catálogo y el parámetro los define `admin_barrio`; el
--    `operador` solo aplica lo que ya existe.
-- ---------------------------------------------------------------------------------------------
do $bloque$
declare
  t text;
  roles_lectura constant text := 'array[''admin_plataforma'',''admin_barrio'',''operador'',''contador'',''auditor'']::app.rol_membership[]';
  roles_admin   constant text := 'array[''admin_plataforma'',''admin_barrio'']::app.rol_membership[]';
  roles_aplica  constant text := 'array[''admin_plataforma'',''admin_barrio'',''operador'']::app.rol_membership[]';
  escribe text;
begin
  foreach t in array array['concepto_boleta','concepto_boleta_valor','concepto_boleta_unidad',
                           'concepto_boleta_unidad_evento','limite_aplicacion_barrio'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);

    execute format(
      'create policy %I on %I for select using (barrio_id in (select app.accessible_tenant_ids()) and app.has_role_on(barrio_id, %s))',
      t || '_sel', t, roles_lectura);

    escribe := case when t = 'concepto_boleta_unidad' then roles_aplica else roles_admin end;

    execute format('create policy %I on %I for insert with check (app.has_role_on(barrio_id, %s))',
      t || '_ins', t, escribe);
    execute format('grant select, insert on table %I to app_request', t);
    execute format('grant select, insert, update, delete on table %I to app_job', t);

    -- El registro de eventos no se actualiza ni se borra: ni policy, ni grant.
    if t <> 'concepto_boleta_unidad_evento' then
      execute format(
        'create policy %I on %I for update using (app.has_role_on(barrio_id, %s)) with check (app.has_role_on(barrio_id, %s))',
        t || '_upd', t, escribe, escribe);
      execute format('grant update on table %I to app_request', t);
    end if;

    -- DELETE solo sobre la aplicación, y solo mientras el período esté en borrador (lo garantiza
    -- `app.periodo_editable`): hay que poder sacar un cargo mal cargado antes de emitir.
    if t = 'concepto_boleta_unidad' then
      execute format('create policy %I on %I for delete using (app.has_role_on(barrio_id, %s))',
        t || '_del', t, roles_aplica);
      execute format('grant delete on table %I to app_request', t);
    end if;
  end loop;
end
$bloque$;
--> statement-breakpoint
grant execute on function app.concepto_valor_vigente(uuid, date) to app_request, app_job;
--> statement-breakpoint

-- Totales reportados del período: el desvío entre lo presupuestado y lo bonificado se mira todos los
-- meses, sin que nadie lo pida (doc 08 §L).
alter table periodo_expensa add column total_cargos numeric(14,2);
--> statement-breakpoint
alter table periodo_expensa add column total_descuentos numeric(14,2);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 7. `validar_emision` v3.
--
--    El invariante del prorrateo es **el mismo de siempre** con un `where clase_item = 'prorrateo'`.
--    Lo nuevo: la biyección contra las aplicaciones —que no se puede hacer con un conteo solo, porque
--    un ítem huérfano y una aplicación sin ítem se cancelan— y las verificaciones POR UNIDAD, que son
--    las que atrapan un cargo cargado en la boleta equivocada (el total del barrio no se mueve).
-- ---------------------------------------------------------------------------------------------
create or replace function app.validar_emision(p_periodo uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_barrio        uuid;
  v_modelo        app.modelo_expensa;
  v_esperado      numeric(14,2);
  v_prorrateo     numeric(14,2);
  v_cargos        numeric(14,2);
  v_descuentos    numeric(14,2);
  v_n_items       bigint;
  v_liquidaciones bigint;
  v_unidades      bigint;
  v_version       uuid;
  v_cuota_ver     uuid;
  v_cerrada       boolean;
  v_sin_cuota     bigint;
  v_n_aplic       bigint;
  v_s_aplic       numeric(14,2);
  v_sin_resolver  bigint;
begin
  select barrio_id, modelo, coeficiente_version_id, cuota_fija_version_id
    into v_barrio, v_modelo, v_version, v_cuota_ver
    from periodo_expensa where id = p_periodo;

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

  -- Una sola pasada para las tres clases (medido: 5 ms con 288.000 líneas).
  select coalesce(sum(i.monto) filter (where i.clase_item = 'prorrateo'), 0),
         coalesce(sum(i.monto) filter (where i.clase_item = 'cargo'), 0),
         coalesce(sum(i.monto) filter (where i.clase_item = 'descuento'), 0),
         count(*) filter (where i.clase_item in ('cargo','descuento'))
    into v_prorrateo, v_cargos, v_descuentos, v_n_items
    from liquidacion l join item_liquidacion i on i.liquidacion_id = l.id
   where l.periodo_id = p_periodo;

  -- Lo repartido tiene que ser el gasto. **Idéntico a antes**, con el filtro por clase.
  if v_modelo = 'variable' then
    select coalesce(sum(monto), 0) into v_esperado from gasto_periodo where periodo_id = p_periodo;
  else
    if v_cuota_ver is null then
      raise exception 'el período liquida por cuota fija pero no tiene una versión de cuota asignada';
    end if;
    select count(*) into v_sin_cuota
      from unidad_funcional u
     where u.barrio_id = v_barrio and u.baja_at is null
       and not exists (select 1 from cuota_fija c where c.version_id = v_cuota_ver and c.unidad_funcional_id = u.id);
    if v_sin_cuota > 0 then
      raise exception 'faltan % cuotas fijas: hay unidades activas sin importe asignado', v_sin_cuota;
    end if;
    select coalesce(sum(g.monto), 0) into v_esperado
      from gasto_periodo g join concepto co on co.id = g.concepto_id
     where g.periodo_id = p_periodo and co.tipo = 'extraordinaria';

    -- La cuota fija cuadra contra su propia versión.
    if (select coalesce(sum(i.monto), 0) from liquidacion l join item_liquidacion i on i.liquidacion_id = l.id
         where l.periodo_id = p_periodo and i.clase_item = 'cuota_fija')
       <> (select coalesce(sum(c.importe), 0) from cuota_fija c
            join unidad_funcional u on u.id = c.unidad_funcional_id and u.baja_at is null
           where c.version_id = v_cuota_ver) then
      raise exception 'el período no cuadra: las cuotas fijas cobradas no coinciden con la versión vigente';
    end if;
  end if;

  if v_esperado <> v_prorrateo then
    raise exception 'el período no cuadra (modelo %): esperado % y repartido % (diferencia %)',
      v_modelo, v_esperado, v_prorrateo, v_esperado - v_prorrateo;
  end if;

  -- Cargos y descuentos: biyección 1 a 1 contra sus aplicaciones, en las dos direcciones.
  select count(*), coalesce(sum(monto_resuelto), 0) into v_n_aplic, v_s_aplic
    from concepto_boleta_unidad where periodo_id = p_periodo and anulado_at is null;

  select count(*) into v_sin_resolver
    from concepto_boleta_unidad
   where periodo_id = p_periodo and anulado_at is null and importe_resuelto is null;
  if v_sin_resolver > 0 then
    raise exception 'hay % conceptos aplicados sin resolver: el período no se puede emitir', v_sin_resolver;
  end if;

  if v_n_items <> v_n_aplic then
    raise exception 'el período no cuadra: % líneas de cargo/descuento contra % aplicaciones', v_n_items, v_n_aplic;
  end if;
  if (v_cargos + v_descuentos) <> v_s_aplic then
    raise exception 'el período no cuadra: cargos y descuentos suman % y las aplicaciones %',
      v_cargos + v_descuentos, v_s_aplic;
  end if;

  -- Por UNIDAD, no por barrio: un cargo en la boleta equivocada no mueve el total del período.
  if exists (
    select 1 from liquidacion l
     where l.periodo_id = p_periodo
       and (l.subtotal_cargos <> (select coalesce(sum(i.monto), 0) from item_liquidacion i
                                   where i.liquidacion_id = l.id and i.clase_item = 'cargo')
         or l.subtotal_descuentos <> (select coalesce(sum(i.monto), 0) from item_liquidacion i
                                       where i.liquidacion_id = l.id and i.clase_item = 'descuento'))
  ) then
    raise exception 'el período no cuadra: hay liquidaciones cuyos subtotales no coinciden con sus líneas';
  end if;

  if exists (
    select 1 from liquidacion l
     where l.periodo_id = p_periodo
       and l.total <> (select coalesce(sum(i.monto), 0) from item_liquidacion i where i.liquidacion_id = l.id)
                      + l.saldo_anterior + coalesce(l.interes_mora, 0)
  ) then
    raise exception 'el período no cuadra: hay liquidaciones cuyo total no coincide con sus líneas';
  end if;

  -- Piso de cero: una boleta negativa no es un descuento, es una nota de crédito (otro artefacto).
  if exists (
    select 1 from liquidacion
     where periodo_id = p_periodo
       and subtotal_cuota_fija + subtotal_ordinarias + subtotal_extraordinarias
           + subtotal_fondo_reserva + subtotal_cargos + subtotal_descuentos < 0
  ) then
    raise exception 'hay unidades cuyo neto del período quedaría negativo';
  end if;
end; $$;
