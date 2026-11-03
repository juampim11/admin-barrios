-- =============================================================================================
-- 0060_importe_exigible_liquidacion — el saldo anterior que sale de la cuenta corriente no se
-- cobra dos veces.
--
-- `liquidacion.total` es lo que la boleta dice "a pagar": lo del período, más el saldo anterior,
-- más el interés por mora. Hasta acá el saldo anterior entraba siempre **de afuera** del sistema
-- (`carga_manual`: deuda traída de antes, que no está en ninguna liquidación) y por eso la cuenta
-- corriente (`0037`) podía debitar el `total` entero sin contar nada dos veces.
--
-- Con el saldo anterior **calculado** desde la propia cuenta corriente (`saldo_anterior_origen =
-- calculado`, el valor que dejó previsto `0040`), esa deuda **ya es un débito**: es la
-- liquidación vieja, todavía sin pagar. Debitar el `total` la sumaría otra vez, y la unidad que no
-- pagó un mes aparecería debiendo el doble.
--
-- `importe_exigible` es lo que esta liquidación agrega a la deuda: el `total` menos el saldo
-- anterior **cuando ese saldo es calculado**. Con cualquier otro origen es idéntico al `total`, así
-- que **ninguna fila existente cambia de valor** (no hay ninguna `calculado`: `0040` no rellenó
-- nada y ningún camino las escribía). Lo usan los cuatro lugares que tratan una liquidación como
-- deuda: la vista del estado de cuenta, el débito al emitir, el tope de una imputación y la
-- imputación automática. Lo que se imprime y se manda (la boleta, el envío) sigue siendo el `total`.
--
-- Las cuatro definiciones se copian enteras de su última versión (`0037` y `0057`) y lo único que
-- cambia es `l.total` → `l.importe_exigible`.
-- =============================================================================================

alter table liquidacion add column importe_exigible numeric(14,2)
  generated always as (total - case when saldo_anterior_origen = 'calculado' then saldo_anterior else 0 end) stored;
--> statement-breakpoint

comment on column liquidacion.importe_exigible is
  'Lo que esta liquidación suma a la deuda de la unidad: el total menos el saldo anterior cuando ese '
  'saldo salió de la cuenta corriente (calculado), porque ahí ya es un débito de otra liquidación. '
  'Con cualquier otro origen, igual al total (0060).';
--> statement-breakpoint

-- 1. La vista de detalle del estado de cuenta (`0037`).
create or replace view app.v_estado_cuenta_uf with (security_invoker = true) as
with movimientos as (
  select l.unidad_funcional_id, l.barrio_id,
         pe.emitida_at::date as fecha,
         l.id as origen_id,
         'debito'::text as tipo,
         l.importe_exigible as monto
    from liquidacion l
    join periodo_expensa pe on pe.id = l.periodo_id
   where pe.estado in ('emitida', 'distribuida')
  union all
  select pg.unidad_funcional_id, pg.barrio_id,
         pg.fecha,
         pi.id as origen_id,
         'credito'::text as tipo,
         -pi.monto_imputado as monto
    from pago_imputacion pi
    join pago pg on pg.id = pi.pago_id
   where pi.anulado_at is null and pg.anulado_at is null
)
select unidad_funcional_id, barrio_id, fecha, origen_id, tipo, monto,
       sum(monto) over (
         partition by unidad_funcional_id
         order by fecha, origen_id
         rows unbounded preceding
       ) as saldo_corriente
  from movimientos;
--> statement-breakpoint

-- 2. El débito al emitir (`0037`).
create or replace function app.saldo_uf_por_emision() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  if new.estado = 'emitida' and old.estado is distinct from 'emitida' then
    insert into saldo_uf (barrio_id, unidad_funcional_id, saldo_actual, fecha_ultimo_movimiento)
    select l.barrio_id, l.unidad_funcional_id, l.importe_exigible, new.emitida_at::date
      from liquidacion l where l.periodo_id = new.id
    on conflict (barrio_id, unidad_funcional_id) do update
       set saldo_actual = saldo_uf.saldo_actual + excluded.saldo_actual,
           fecha_ultimo_movimiento = greatest(
             coalesce(saldo_uf.fecha_ultimo_movimiento, excluded.fecha_ultimo_movimiento),
             excluded.fecha_ultimo_movimiento);
  end if;
  return new;
end; $$;--> statement-breakpoint

-- 3. El tope de una imputación: no se imputa más de lo que la liquidación agrega a la deuda (`0037`).
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

    select coalesce(sum(monto_imputado), 0) into v_ya_imputado_pago
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

-- 4. La imputación automática (`0057`).
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
           l.importe_exigible - coalesce((
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
