-- =============================================================================================
-- 0037_estado_cuenta — el estado de cuenta de una unidad, y el saldo mantenido incremental.
--
-- Dos piezas, dos usos distintos:
--
--  1. `app.v_estado_cuenta_uf` — el detalle completo (cada débito, cada crédito, el saldo corriente
--     línea por línea) de UNA unidad. Sirve para "por qué debo esto" — la pregunta del propietario.
--  2. `saldo_uf` — el saldo YA SUMADO de CADA unidad, mantenido por trigger. Sirve para la grilla
--     "todas las unidades del barrio, con su saldo" — la pregunta del administrador. Medido por
--     `dba-data` contra un barrio de 510 UF: la vista con `window function` resuelve una unidad
--     rápido, pero recorrerla 510 veces (o una vez con `partition by` sobre todo el barrio) cuesta
--     350 ms con sort a disco, y ese costo **crece con los años** — cada período nuevo agranda el
--     historial completo que hay que reordenar. `saldo_uf` no reordena nada: cada movimiento lo
--     suma o lo resta una vez, en el momento en que ocurre.
--
-- **`security_invoker = true` en la vista es OBLIGATORIO, no una opción.** Sin esto, la vista corre
-- con los privilegios de quien la creó (el dueño del esquema — superusuario en dev/CI), y
-- `force row level security` de `liquidacion`/`pago`/`pago_imputacion` NO se aplica a través de una
-- vista propiedad de ese dueño: filtraría el estado de cuenta de TODOS los barrios a quien sea que
-- la consulte. Hallazgo bloqueante del panel (`security-engineer`, `dba-data`, 2026-08-16).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. La vista de detalle. Débitos: `liquidacion.total`, con fecha `periodo_expensa.emitida_at` —
--    SOLO de períodos ya emitidos (`emitida`/`distribuida`): una liquidación de un período todavía
--    en borrador puede cambiar o desaparecer al regenerar, y no es deuda exigible todavía. Créditos:
--    `pago_imputacion.monto_imputado`, en negativo, filtrando pago e imputación no anulados.
-- ---------------------------------------------------------------------------------------------
create view app.v_estado_cuenta_uf with (security_invoker = true) as
with movimientos as (
  select l.unidad_funcional_id, l.barrio_id,
         pe.emitida_at::date as fecha,
         l.id as origen_id,
         'debito'::text as tipo,
         l.total as monto
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

comment on view app.v_estado_cuenta_uf is
  'Estado de cuenta detallado de una unidad: cada débito (liquidación emitida) y cada crédito (pago '
  'imputado), con saldo corriente. security_invoker=true es obligatorio — ver el encabezado de '
  '0037_estado_cuenta.sql. No usar para la grilla de TODAS las unidades de un barrio: para eso está '
  'saldo_uf, que no reordena el historial completo en cada consulta.';
--> statement-breakpoint

grant select on app.v_estado_cuenta_uf to app_request, app_job;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. `saldo_uf` — el saldo acumulado por unidad, mantenido por trigger. Nace en cero: una unidad sin
--    movimientos no tiene fila hasta que ocurre el primero (débito o crédito), y eso es correcto —
--    "sin fila" y "saldo cero" son el mismo hecho acá.
-- ---------------------------------------------------------------------------------------------
create table saldo_uf (
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  unidad_funcional_id uuid not null references unidad_funcional (id) on delete restrict,
  saldo_actual numeric(14,2) not null default 0,
  fecha_ultimo_movimiento date,
  primary key (barrio_id, unidad_funcional_id)
);
--> statement-breakpoint

create index idx_saldo_uf_barrio on saldo_uf (barrio_id);
--> statement-breakpoint

-- El lado del DÉBITO: al emitir un período, se suma el total de cada liquidación al saldo de su
-- unidad. Trigger nuevo y chico sobre `periodo_expensa`, en vez de tocar `app.periodo_transicion()`
-- (la máquina de estados central, migración 0013 y sucesivas): agregar un `after update` adicional
-- es aditivo y no le cambia el comportamiento a nada que ya dependa de esa función.
create or replace function app.saldo_uf_por_emision() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  if new.estado = 'emitida' and old.estado is distinct from 'emitida' then
    insert into saldo_uf (barrio_id, unidad_funcional_id, saldo_actual, fecha_ultimo_movimiento)
    select l.barrio_id, l.unidad_funcional_id, l.total, new.emitida_at::date
      from liquidacion l where l.periodo_id = new.id
    on conflict (barrio_id, unidad_funcional_id) do update
       set saldo_actual = saldo_uf.saldo_actual + excluded.saldo_actual,
           fecha_ultimo_movimiento = greatest(
             coalesce(saldo_uf.fecha_ultimo_movimiento, excluded.fecha_ultimo_movimiento),
             excluded.fecha_ultimo_movimiento);
  end if;
  return new;
end; $$;--> statement-breakpoint

alter function app.saldo_uf_por_emision() owner to app_job;
--> statement-breakpoint

create trigger trg_saldo_uf_por_emision after update on periodo_expensa
  for each row execute function app.saldo_uf_por_emision();
--> statement-breakpoint

-- El lado del CRÉDITO: se agrega DENTRO de `app.pago_imputacion_antes()` (0035), en el mismo `for
-- update` que ya toma esa función — no hace falta un lock nuevo, el de la liquidación ya serializa
-- a los escritores concurrentes de la misma unidad lo suficiente para que este `update` incremental
-- no se pise (y si dos pagos DISTINTOS de la MISMA unidad se imputan a la vez contra liquidaciones
-- DISTINTAS, el `update saldo_uf set saldo_actual = saldo_actual + …` es atómico por fila: Postgres
-- serializa dos `UPDATE` concurrentes sobre la misma fila sin ayuda extra).
--
-- Se reescribe la función entera (mismo criterio que 0021/0023): un cuerpo que se lee de arriba
-- abajo vale más que un parche a tres migraciones de distancia. Lo nuevo son los dos bloques
-- marcados `-- [0037]`; el resto es idéntico a 0035.
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

    select l.barrio_id, l.total, pe.estado into v_barrio_liq, v_total_liq, v_estado_periodo
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

alter function app.pago_imputacion_antes() owner to app_job;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. RLS de `saldo_uf`. Solo lectura para `app_request`: la escritura la hacen los dos triggers de
--    arriba, `security definer` con dueño `app_job` (BYPASSRLS) — nunca un `insert`/`update` directo
--    del rol de request.
-- ---------------------------------------------------------------------------------------------
alter table saldo_uf enable row level security;
--> statement-breakpoint
alter table saldo_uf force row level security;
--> statement-breakpoint

create policy saldo_uf_sel on saldo_uf for select
  using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint

grant select on table saldo_uf to app_request;
--> statement-breakpoint
grant select, insert, update on table saldo_uf to app_job;
