-- =============================================================================================
-- 0086_activacion_del_barrio — activar un barrio que ya venía funcionando, con su deuda mes por
-- mes (encargo 17, Etapa 1.4). **Solo DDL**: no modifica ni borra ninguna fila.
--
--   1. `barrio.activacion` (sin_activar | activo), quién activó, cuándo y con qué tasa para la deuda
--      anterior. Los barrios que ya existen quedan `activo` (la columna se agrega con ese default) y
--      después el default pasa a `sin_activar`: un barrio nuevo nace sin activar.
--   2. `periodo_expensa.origen` (mensual | historico): la deuda anterior son períodos históricos,
--      anteriores al primer mes a devengar. No es una tabla aparte: es deuda de la cuenta corriente,
--      y la imputación, el interés y el estado de cuenta ya saben leerla.
--   3. `liquidacion.vencimiento`: solo en lo histórico (un mes puede traer la expensa con un
--      vencimiento y una extraordinaria con otro). Se lee `coalesce(l.vencimiento, pe.primer_vencimiento)`.
--   4. `item_liquidacion`: la línea `historico` (una por concepto del catálogo del barrio).
--   5. Funciones copiadas ENTERAS con su único cambio marcado `[0086]`: `app.interes_devengado_antes`
--      (de `0064`), `app.saldo_uf_por_emision` (de `0060`), `app.v_estado_cuenta_uf` (de `0068`) y
--      `app.pago_antes` (de `0070`).
--   6. `app.cargar_deuda_historica`: la ÚNICA puerta por la que entra la deuda anterior.
--
-- Quién puede qué: los triggers de guarda NO son `security definer`, así que `current_user` es el rol
-- que ejecuta la sentencia. Adentro de `app.cargar_deuda_historica` (definer, dueño `app_job`) es
-- `app_job`; desde un pedido de la aplicación es `app_request`. Así, un período histórico, una
-- liquidación con vencimiento propio o un pago de origen `activacion` solo los escribe esa función,
-- que a su vez exige que quien la llama sea la administración del barrio.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. El estado del barrio
-- ---------------------------------------------------------------------------------------------
alter table barrio add column activacion text not null default 'activo';
--> statement-breakpoint
alter table barrio alter column activacion set default 'sin_activar';
--> statement-breakpoint
alter table barrio add constraint barrio_activacion_chk check (activacion in ('sin_activar', 'activo'));
--> statement-breakpoint
alter table barrio
  add column activado_at timestamptz,
  add column activado_por uuid,
  add column activacion_fecha date,
  add column deuda_anterior_estado text,
  add column deuda_anterior_tasa numeric(12, 6),
  add column deuda_anterior_tasa_vigente numeric(12, 6),
  add column deuda_anterior_tasa_motivo text;
--> statement-breakpoint
alter table barrio add constraint barrio_deuda_anterior_estado_chk
  check (deuda_anterior_estado is null or deuda_anterior_estado in ('cargada', 'sin_deuda'));
--> statement-breakpoint
alter table barrio add constraint barrio_deuda_anterior_tasa_chk
  check ((deuda_anterior_tasa is null or (deuda_anterior_tasa >= 0 and deuda_anterior_tasa <= 1))
     and (deuda_anterior_tasa_motivo is null or length(btrim(deuda_anterior_tasa_motivo)) between 1 and 500));
--> statement-breakpoint
-- La firma de la activación va completa o no va. Un barrio `activo` sin firma es uno anterior a esta
-- migración (o uno cargado sin identidad): nunca pasó por la activación y no trae deuda histórica.
alter table barrio add constraint barrio_activacion_firma_chk
  check (num_nonnulls(activado_at, activado_por, activacion_fecha, deuda_anterior_tasa, deuda_anterior_tasa_vigente) in (0, 5)
     and (activado_at is null or activacion = 'activo'));
--> statement-breakpoint
comment on column barrio.activacion is
  'sin_activar: el barrio todavía no emite (se está trayendo lo que venía de antes). activo: opera. Se activa una sola vez.';
--> statement-breakpoint
comment on column barrio.activacion_fecha is
  'El día de la activación, en la hora del barrio. La deuda anterior devenga con deuda_anterior_tasa hasta este día inclusive; desde el siguiente, con los parámetros normales.';
--> statement-breakpoint
comment on column barrio.deuda_anterior_estado is
  'cargada: se subió la planilla de deuda. sin_deuda: la administración dijo que el barrio no trae deuda. NULL: todavía no se resolvió. Lo escribe solo app.cargar_deuda_historica.';
--> statement-breakpoint
comment on column barrio.deuda_anterior_tasa is
  'Tasa mensual (fracción: 0.03 = 3 %) con que devenga la deuda anterior desde cada vencimiento hasta la activación. Se elige una sola vez, al activar. No es un parámetro con vigencia: es un dato de la activación.';
--> statement-breakpoint
comment on column barrio.deuda_anterior_tasa_vigente is
  'La tasa vigente del barrio el día de la activación (compensatoria + punitoria, o 0 si no cobra interés): contra qué se compara la elegida. La calcula la base.';
--> statement-breakpoint

create or replace function app.barrio_activacion_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_hoy     date;
  v_vigente numeric(12, 6);
begin
  if tg_op = 'INSERT' then
    -- Un barrio que da de alta una persona nace sin activar, diga lo que diga el pedido. Las cargas
    -- sin identidad (fixtures de test, mantenimiento) pueden nacer activas: no pasan por una pantalla.
    if v_usuario is not null then
      new.activacion := 'sin_activar';
    end if;
    new.activado_at := null;
    new.activado_por := null;
    new.activacion_fecha := null;
    new.deuda_anterior_estado := null;
    new.deuda_anterior_tasa := null;
    new.deuda_anterior_tasa_vigente := null;
    new.deuda_anterior_tasa_motivo := null;
    return new;
  end if;

  -- Si el barrio trae deuda o no, lo escribe la carga de la planilla y nadie más.
  if new.deuda_anterior_estado is distinct from old.deuda_anterior_estado and current_user::text <> 'app_job' then
    raise exception 'la deuda anterior del barrio se carga con la planilla de deuda' using errcode = '42501';
  end if;

  -- El primer mes a devengar no puede quedar adentro de la deuda anterior ya cargada.
  if new.primer_periodo is distinct from old.primer_periodo and exists (
      select 1 from periodo_expensa pe
       where pe.barrio_id = new.barrio_id and pe.origen = 'historico'
         and (new.primer_periodo is null or pe.periodo >= new.primer_periodo)) then
    raise exception 'el primer mes a devengar no puede ser anterior a la deuda que ya se cargó: volvé a subir la planilla'
      using errcode = '23514';
  end if;

  if (new.activacion, new.activado_at, new.activado_por, new.activacion_fecha,
      new.deuda_anterior_tasa, new.deuda_anterior_tasa_vigente, new.deuda_anterior_tasa_motivo)
     is not distinct from
     (old.activacion, old.activado_at, old.activado_por, old.activacion_fecha,
      old.deuda_anterior_tasa, old.deuda_anterior_tasa_vigente, old.deuda_anterior_tasa_motivo) then
    return new;
  end if;

  if old.activacion = 'activo' then
    raise exception 'el barrio ya está activado: la activación no se cambia' using errcode = '23514';
  end if;
  if new.activacion <> 'activo' then
    raise exception 'los datos de la activación se escriben al activar el barrio' using errcode = '23514';
  end if;
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: activar un barrio requiere identidad';
  end if;
  if not app.has_role_on(new.barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
    raise exception 'el barrio lo activa su administración (admin_barrio o admin_plataforma)' using errcode = '42501';
  end if;
  if new.primer_periodo is null then
    raise exception 'el barrio no tiene primer mes a devengar: cargalo antes de activar';
  end if;
  if not exists (select 1 from unidad_funcional u where u.barrio_id = new.barrio_id and u.baja_at is null) then
    raise exception 'el barrio no tiene unidades en el padrón: cargalo antes de activar';
  end if;
  if old.deuda_anterior_estado is null then
    raise exception 'falta la deuda anterior: subí la planilla de deuda o indicá que el barrio no trae deuda';
  end if;
  if new.deuda_anterior_tasa is null then
    raise exception 'falta la tasa para la deuda anterior';
  end if;

  v_hoy := (now() at time zone new.zona_horaria)::date;
  -- La tasa vigente la calcula la base, no la manda el pedido: compensatoria más punitoria, o cero
  -- si el barrio no cobra interés (o todavía no lo configuró).
  -- `app.parametro_resuelto` (la variante pública): este trigger corre con los permisos de quien
  -- activa, que es la administración del barrio y puede leer sus parámetros.
  select case
           when (select x.valor from app.parametro_resuelto(new.barrio_id, 'interes.cobra', v_hoy) x) = 'true'::jsonb
           then coalesce((select (x.valor #>> '{}')::numeric
                            from app.parametro_resuelto(new.barrio_id, 'interes.tasa_compensatoria', v_hoy) x), 0)
              + coalesce((select (x.valor #>> '{}')::numeric
                            from app.parametro_resuelto(new.barrio_id, 'interes.tasa_punitoria', v_hoy) x), 0)
           else 0
         end
    into v_vigente;
  new.deuda_anterior_tasa_vigente := v_vigente;
  if new.deuda_anterior_tasa is distinct from v_vigente
     and (new.deuda_anterior_tasa_motivo is null or length(btrim(new.deuda_anterior_tasa_motivo)) < 3) then
    raise exception 'la tasa para la deuda anterior no es la vigente del barrio (%): cambiarla pide un motivo', v_vigente;
  end if;
  if new.deuda_anterior_tasa is not distinct from v_vigente then
    new.deuda_anterior_tasa_motivo := null;
  end if;

  new.activado_at := now();
  new.activado_por := v_usuario;
  new.activacion_fecha := v_hoy;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_barrio_activacion before insert or update on barrio
  for each row execute function app.barrio_activacion_antes();
--> statement-breakpoint
-- `barrio` tiene el `update` por columnas desde `0047`: de la activación, un pedido de la aplicación
-- solo puede escribir el estado, la tasa y su motivo. La firma (`activado_*`, `activacion_fecha`), la
-- tasa vigente y `deuda_anterior_estado` no se le conceden: las escribe la base.
grant update (activacion, deuda_anterior_tasa, deuda_anterior_tasa_motivo) on table barrio to app_request;
--> statement-breakpoint

-- La activación queda en el historial del barrio, firmada por la base.
create or replace function app.barrio_activacion_evento() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if old.activacion = 'sin_activar' and new.activacion = 'activo' then
    insert into padron_evento (barrio_id, unidad_funcional_id, tipo, detalle, motivo, datos)
    values (new.barrio_id, null, 'configuracion_barrio',
            'Se activa el barrio. Primer mes a devengar: ' || new.primer_periodo
              || '. Tasa mensual para la deuda anterior: ' || (new.deuda_anterior_tasa * 100)::numeric(8, 4)::text || ' %'
              || case when new.deuda_anterior_tasa_motivo is not null
                      then ' (la vigente era ' || (new.deuda_anterior_tasa_vigente * 100)::numeric(8, 4)::text || ' %)' else '' end
              || '.',
            left(new.deuda_anterior_tasa_motivo, 60),
            jsonb_build_object('activacion', true, 'fecha', new.activacion_fecha, 'primerPeriodo', new.primer_periodo,
                               'tasa', new.deuda_anterior_tasa, 'tasaVigente', new.deuda_anterior_tasa_vigente,
                               'motivoTasa', new.deuda_anterior_tasa_motivo, 'deudaAnterior', new.deuda_anterior_estado));
  end if;
  return null;
end; $$;
--> statement-breakpoint
create trigger trg_barrio_activacion_evento after update on barrio
  for each row execute function app.barrio_activacion_evento();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. Períodos históricos
-- ---------------------------------------------------------------------------------------------
alter table periodo_expensa add column origen text not null default 'mensual';
--> statement-breakpoint
alter table periodo_expensa add constraint periodo_origen_chk check (origen in ('mensual', 'historico'));
--> statement-breakpoint
comment on column periodo_expensa.origen is
  'mensual: un mes que devenga el sistema. historico: deuda anterior a la activación del barrio, mes por mes; no reparte gastos, no tiene boleta ni comprobante, y es anterior a barrio.primer_periodo.';
--> statement-breakpoint

create or replace function app.periodo_historico_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if tg_op = 'DELETE' then
    if old.origen = 'historico' and current_user::text <> 'app_job' then
      raise exception 'la deuda anterior a la activación se reemplaza volviendo a subir la planilla de deuda'
        using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and new.origen is distinct from old.origen then
    raise exception 'el origen de un período no se cambia' using errcode = '23514';
  end if;
  if new.origen = 'historico' then
    if current_user::text <> 'app_job' then
      raise exception 'la deuda anterior a la activación se carga con la planilla de deuda, no a mano'
        using errcode = '42501';
    end if;
    if tg_op = 'INSERT' and not exists (
        select 1 from barrio b
         where b.barrio_id = new.barrio_id and b.primer_periodo is not null and new.periodo < b.primer_periodo) then
      raise exception 'un período histórico es anterior al primer mes a devengar del barrio' using errcode = '23514';
    end if;
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_periodo_historico before insert or update or delete on periodo_expensa
  for each row execute function app.periodo_historico_antes();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. La liquidación histórica: una por unidad, mes y vencimiento
--
-- La unicidad «una liquidación por unidad y período» sigue intacta para todo lo mensual (el índice
-- parcial sobre las filas sin vencimiento propio); lo histórico es único por unidad, período y
-- vencimiento. El índice de `0004` se reemplaza por los dos: no cambia qué filas existen.
-- ---------------------------------------------------------------------------------------------
alter table liquidacion add column vencimiento date;
--> statement-breakpoint
comment on column liquidacion.vencimiento is
  'Vencimiento propio de la liquidación. Solo en la deuda anterior a la activación (período histórico); NULL en todo lo mensual, que vence con su período. Se lee coalesce(l.vencimiento, pe.primer_vencimiento).';
--> statement-breakpoint
drop index uq_liquidacion_periodo_uf;
--> statement-breakpoint
create unique index uq_liquidacion_periodo_uf on liquidacion (periodo_id, unidad_funcional_id) where vencimiento is null;
--> statement-breakpoint
create unique index uq_liquidacion_historica on liquidacion (periodo_id, unidad_funcional_id, vencimiento) where vencimiento is not null;
--> statement-breakpoint

create or replace function app.liquidacion_historica_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
declare v_origen text;
begin
  select origen into v_origen from periodo_expensa where id = new.periodo_id;
  if (new.vencimiento is not null) is distinct from (v_origen = 'historico') then
    raise exception 'el vencimiento propio es de la deuda anterior a la activación, y solo de ella' using errcode = '23514';
  end if;
  if v_origen = 'historico' and current_user::text <> 'app_job' then
    raise exception 'la deuda anterior a la activación se carga con la planilla de deuda, no a mano' using errcode = '42501';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_liquidacion_historica before insert or update on liquidacion
  for each row execute function app.liquidacion_historica_antes();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. La línea histórica: una por concepto del catálogo del barrio
--
-- El concepto es uno de los gastos que se reparten (`concepto`: la expensa, una extraordinaria) o un
-- cargo (`concepto_boleta`: una multa). `clase_item::text` y no el enum: el valor se creó en `0085`,
-- en la misma transacción del migrador.
-- ---------------------------------------------------------------------------------------------
alter table item_liquidacion add column concepto_boleta_id uuid;
--> statement-breakpoint
alter table item_liquidacion add constraint fk_item_concepto_boleta_barrio
  foreign key (concepto_boleta_id, barrio_id) references concepto_boleta (id, barrio_id) on delete restrict;
--> statement-breakpoint
alter table item_liquidacion drop constraint item_liquidacion_origen_chk;
--> statement-breakpoint
alter table item_liquidacion add constraint item_liquidacion_origen_chk check (
     (clase_item::text = 'prorrateo' and gasto_id is not null and coeficiente_aplicado is not null and aplicacion_id is null and tipo is not null and concepto_boleta_id is null)
  or (clase_item::text = 'cuota_fija' and gasto_id is null and coeficiente_aplicado is null and aplicacion_id is null and tipo is not null and concepto_boleta_id is null)
  or (clase_item::text in ('cargo', 'descuento') and gasto_id is null and coeficiente_aplicado is null and aplicacion_id is not null and tipo is null and concepto_boleta_id is null)
  or (clase_item::text = 'historico' and gasto_id is null and coeficiente_aplicado is null and aplicacion_id is null
      and num_nonnulls(concepto_id, concepto_boleta_id) = 1 and (tipo is not null) = (concepto_id is not null))
);
--> statement-breakpoint
comment on column item_liquidacion.concepto_boleta_id is
  'Solo en una línea histórica cuyo concepto es un cargo del catálogo (una multa anterior a la activación). En lo mensual, el cargo va por su aplicación (aplicacion_id).';
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 5. Funciones copiadas enteras, con su único cambio marcado `[0086]`
-- ---------------------------------------------------------------------------------------------
create or replace function app.interes_devengado_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario  uuid := app.current_user_id();
  v_barrio   uuid;
  v_unidad   uuid;
  v_estado   app.estado_periodo;
  v_vto      date;
  v_ultimo   date;
  v_pendiente numeric(14,2);
begin
  if tg_op <> 'INSERT' then
    raise exception 'el interés devengado no se edita ni se borra: se compensa (imputación o condonación)';
  end if;
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un interés sin autor no se registra';
  end if;

  -- [0086] La deuda anterior a la activación vence cuando dice su liquidación, no su período.
  select l.barrio_id, l.unidad_funcional_id, pe.estado, coalesce(l.vencimiento, pe.primer_vencimiento)
    into v_barrio, v_unidad, v_estado, v_vto
    from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
   where l.id = new.liquidacion_id for update of l;
  if v_barrio is null or not app.has_role_on(v_barrio,
      array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) then
    raise exception 'la liquidación no existe o no tenés permiso para registrar su interés';
  end if;
  if v_estado not in ('emitida', 'distribuida') or v_vto is null then
    raise exception 'solo devenga interés una liquidación emitida y con vencimiento';
  end if;

  new.barrio_id := v_barrio;
  new.unidad_funcional_id := v_unidad;
  new.creado_por := v_usuario;
  new.created_at := now();

  -- [0064] Un tramo no termina en el futuro: un pago con la fecha mal tipeada (2027 por 2026)
  -- dejaría interés de meses que no corrieron, y como nada se recalcula hacia atrás, no habría forma
  -- de deshacerlo (security-engineer, hallazgo A1). Hoy es el de la hora del barrio.
  if new.hasta > (select (now() at time zone b.zona_horaria)::date from barrio b where b.barrio_id = v_barrio) then
    raise exception 'el interés no se registra hasta una fecha futura (%): revisá la fecha del pago', new.hasta;
  end if;
  -- [0064] Con qué se calculó: las vigencias de la tasa y los parámetros usados (regla 4 de CLAUDE.md).
  if new.parametros is null or jsonb_typeof(new.parametros) <> 'object' then
    raise exception 'el interés se registra con los parámetros con que se calculó';
  end if;

  -- Los tramos van uno detrás del otro, sin huecos ni solapes: el primero arranca en el vencimiento
  -- (y es el único que cuenta la gracia); los siguientes, donde terminó el anterior.
  select max(hasta) into v_ultimo from interes_devengado where liquidacion_id = new.liquidacion_id;
  if new.desde <> coalesce(v_ultimo, v_vto) or new.desde_vencimiento <> (v_ultimo is null) then
    raise exception 'el tramo de interés tiene que empezar donde terminó el anterior (%): no se recalcula hacia atrás',
      coalesce(v_ultimo, v_vto);
  end if;

  -- La base es el capital pendiente de ESE momento: si cambió (otro pago se imputó), el cálculo
  -- quedó viejo y se rechaza.
  v_pendiente := app.capital_pendiente(new.liquidacion_id);
  if new.base <> v_pendiente then
    raise exception 'la base del interés (%) no es el capital pendiente de la liquidación (%): recalculá', new.base, v_pendiente;
  end if;

  if new.origen = 'pago' and not exists (
      select 1 from pago p where p.id = new.pago_id and p.unidad_funcional_id = v_unidad
         and p.anulado_at is null and p.fecha = new.hasta) then
    raise exception 'el pago que cierra el tramo no es de esta unidad, está anulado o no es de la fecha del tramo';
  end if;
  if new.origen = 'corte' and not exists (
      select 1 from periodo_expensa pe where pe.id = new.periodo_id and pe.barrio_id = v_barrio) then
    raise exception 'el período que cierra el tramo no es de este barrio';
  end if;
  return new;
end; $$;
--> statement-breakpoint

create or replace function app.saldo_uf_por_emision() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  if new.estado = 'emitida' and old.estado is distinct from 'emitida' then
    insert into saldo_uf (barrio_id, unidad_funcional_id, saldo_actual, fecha_ultimo_movimiento)
    -- [0086] Sumado por unidad: un mes histórico puede traer dos liquidaciones de la misma unidad
    -- (dos vencimientos), y un `on conflict` no toca dos veces la misma fila. Con una liquidación
    -- por unidad —todo lo mensual— la suma es esa liquidación: la misma cifra de siempre.
    select l.barrio_id, l.unidad_funcional_id, sum(l.importe_exigible), new.emitida_at::date
      from liquidacion l where l.periodo_id = new.id
     group by l.barrio_id, l.unidad_funcional_id
    on conflict (barrio_id, unidad_funcional_id) do update
       set saldo_actual = saldo_uf.saldo_actual + excluded.saldo_actual,
           fecha_ultimo_movimiento = greatest(
             coalesce(saldo_uf.fecha_ultimo_movimiento, excluded.fecha_ultimo_movimiento),
             excluded.fecha_ultimo_movimiento);
  end if;
  return new;
end; $$;
--> statement-breakpoint

create or replace view app.v_estado_cuenta_uf with (security_invoker = true) as
with movimientos as (
  -- [0086] Lo histórico se fecha por su vencimiento: es cuando esa deuda se hizo exigible.
  select l.unidad_funcional_id, l.barrio_id, coalesce(l.vencimiento, pe.emitida_at::date) as fecha, l.id as origen_id,
         'debito'::text as tipo, l.importe_exigible as monto, 'liquidacion'::text as concepto
    from liquidacion l
    join periodo_expensa pe on pe.id = l.periodo_id
   where pe.estado in ('emitida', 'distribuida')
  union all
  select pg.unidad_funcional_id, pg.barrio_id, pg.fecha, pi.id, 'credito', -pi.monto_imputado, 'pago'
    from pago_imputacion pi
    join pago pg on pg.id = pi.pago_id
   where pi.anulado_at is null and pg.anulado_at is null
  union all
  select d.unidad_funcional_id, d.barrio_id, d.hasta, d.id, 'debito', d.monto, 'interes'
    from interes_devengado d
   where d.monto > 0
  union all
  select pg.unidad_funcional_id, pg.barrio_id, pg.fecha, pii.id, 'credito', -pii.monto_imputado, 'pago_interes'
    from pago_imputacion_interes pii
    join pago pg on pg.id = pii.pago_id
   where pii.anulado_at is null and pg.anulado_at is null
  union all
  select c.unidad_funcional_id, c.barrio_id, (c.created_at at time zone b.zona_horaria)::date, c.id, 'credito', -c.monto, 'condonacion'
    from interes_condonacion c
    join barrio b on b.barrio_id = c.barrio_id
   where c.anulado_at is null -- [0068]
)
select unidad_funcional_id, barrio_id, fecha, origen_id, tipo, monto,
       sum(monto) over (partition by unidad_funcional_id order by fecha, origen_id rows unbounded preceding) as saldo_corriente,
       concepto
  from movimientos;
--> statement-breakpoint

-- El saldo a favor que una unidad trae al activar: un cobro sin imputar de origen `activacion`. No
-- lleva comprobante (no es plata que entró por el sistema) y lo firma quien subió la planilla.
alter table pago drop constraint pago_origen_chk;
--> statement-breakpoint
alter table pago add constraint pago_origen_chk check (origen in ('extracto', 'manual', 'activacion'));
--> statement-breakpoint
alter table pago drop constraint pago_manual_exige_registrador_chk;
--> statement-breakpoint
alter table pago add constraint pago_manual_exige_registrador_chk check (
     (origen = 'manual' and usuario_registrador is not null and comprobante_adjunto is not null)
  or (origen = 'extracto' and usuario_registrador is null)
  or (origen = 'activacion' and usuario_registrador is not null and comprobante_adjunto is null)
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.pago_antes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'app'
AS $function$
declare
  v_usuario uuid := app.current_user_id();
  v_roles_escritura constant app.rol_membership[] :=
    array['admin_plataforma','admin_barrio','operador']::app.rol_membership[];
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un pago sin autor no se registra';
  end if;

  if tg_op = 'INSERT' then
    -- Corte temprano de rol: lo primero que se evalúa, antes de tocar ninguna otra columna. No hay
    -- acá ninguna lectura de otra tabla que pudiera filtrar un dato de otro barrio (a diferencia de
    -- `app.cbu_antes()`), pero el orden se mantiene igual por ser el mismo idioma en todo el repo.
    if not app.has_role_on(new.barrio_id, v_roles_escritura) then
      raise exception 'no tenés permiso para registrar pagos en este barrio';
    end if;

    -- El registrador de un pago MANUAL lo pone la base, nunca el cliente — mismo criterio que
    -- `aplicado_por` en `app.cbu_antes()`. Pero un `extracto` con `usuario_registrador` NO se corrige
    -- en silencio acá: se deja pasar tal cual llegó para que `pago_manual_exige_registrador_chk` lo
    -- rechace. Falla cerrado, no se inventa/corrige — el mismo principio que ya rige
    -- `orden_imputacion` (sin default) y el bloqueo de sobre-imputación; corregirlo en silencio en
    -- este único lugar sería la excepción, no la regla.
    if new.origen = 'manual' then
      new.usuario_registrador := v_usuario;
    end if;
    -- [0086] El saldo a favor que una unidad trae al activar el barrio. No es plata que entró por
    -- el sistema: lo escribe solo `app.cargar_deuda_historica` (dueño `app_job`), con la firma de
    -- quien subió la planilla. Nadie lo inserta a mano con ese origen.
    if new.origen = 'activacion' then
      if current_user::text <> 'app_job' then
        raise exception 'un saldo a favor de la activación entra con la planilla de deuda del barrio'
          using errcode = '42501';
      end if;
      new.usuario_registrador := v_usuario;
    end if;
    -- [0086] Un barrio sin activar todavía no cobra (panel `security-engineer`, A1): un pago contra la
    -- deuda anterior antes de elegir su tasa se imputaría al capital sin registrar el interés, y ese
    -- interés no se podría cobrar nunca.
    if new.origen <> 'activacion'
       and (select b.activacion from barrio b where b.barrio_id = new.barrio_id) = 'sin_activar' then
      raise exception 'el barrio todavía no está activado: no se registran cobros hasta activarlo';
    end if;
    new.anulado_at       := null;
    new.anulado_por      := null;
    new.motivo_anulacion := null;

    -- [0068] BL-022 g: el obligado a cuyo nombre se registra el cobro tiene que ser titular de la
    -- unidad a la fecha del pago. Sin obligado, pasa (la unidad puede no tener uno vigente).
    if new.obligado_id is not null
       and not app.obligado_titular_a_la_fecha(new.unidad_funcional_id, new.obligado_id, new.fecha) then
      raise exception 'el obligado del pago no es titular de la unidad a la fecha del pago';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if not app.has_role_on(new.barrio_id, v_roles_escritura) then
      raise exception 'no tenés permiso para modificar pagos en este barrio';
    end if;

    -- El pago no se edita: se anula (con motivo) y se carga de nuevo. Igual que `app.cbu_antes()`,
    -- la única transición permitida es la terna de anulación.
    if (new.barrio_id, new.unidad_funcional_id, new.obligado_id, new.monto, new.fecha, new.origen,
        new.estado_conciliacion, new.usuario_registrador, new.comprobante_adjunto)
       is distinct from
       (old.barrio_id, old.unidad_funcional_id, old.obligado_id, old.monto, old.fecha, old.origen,
        old.estado_conciliacion, old.usuario_registrador, old.comprobante_adjunto)
    then
      raise exception 'un pago no se edita: se anula (con motivo) y se carga de nuevo';
    end if;

    -- Mensajes DISTINTOS de los de `concepto_boleta_unidad` (0021) a propósito: `errores.ts` traduce
    -- por patrón de texto, y dos dominios que levantan el mismo mensaje literal harían que la
    -- traducción del primero que matchea le gane al segundo (el pago se explicaría como "ese cargo…").
    if old.anulado_at is not null and new.anulado_at is null then
      raise exception 'la anulación de un pago no se revierte';
    end if;

    -- Una vez anulado, las TRES columnas de la anulación quedan congeladas (mismo AGUJERO 1 que
    -- cerró 0021 para `concepto_boleta_unidad`).
    if old.anulado_at is not null
       and (new.anulado_at, new.anulado_por, new.motivo_anulacion)
           is distinct from (old.anulado_at, old.anulado_por, old.motivo_anulacion) then
      raise exception 'el motivo de la anulación de un pago no se reescribe: quedó registrado el % y es '
                      'la única explicación de por qué ese cobro se dejó sin efecto', old.anulado_at::date;
    end if;

    if new.anulado_at is not null and old.anulado_at is null then
      -- [0070] Un pago con interés condonado vigente lo anula la administración: anularlo anula la
      -- condonación, y condonar es de la administración (encargo 11). El operador no lo puede saltear
      -- yendo directo a la tabla: la regla está acá, en el trigger del pago.
      if app.pago_tiene_condonacion_vigente(old.id)
         and not app.has_role_on(new.barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
        raise exception 'anular un pago con interés condonado es de la administración del barrio';
      end if;
      -- [0086] El saldo a favor de la activación lo anula la administración (panel `security-engineer`,
      -- M2): no se puede volver a cargar a mano, así que anularlo es quitarle el crédito a la unidad.
      if old.origen = 'activacion'
         and not app.has_role_on(new.barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
        raise exception 'anular un saldo a favor de la activación es de la administración del barrio';
      end if;
      new.anulado_at  := now();
      new.anulado_por := v_usuario;
    end if;
  end if;

  return new;
end; $function$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 6. La carga de la deuda anterior: una sola puerta
--
-- `p_deudas`:  [{unidad, periodo 'YYYY-MM', vencimiento, concepto | concepto_boleta, importe}]
-- `p_a_favor`: [{unidad, importe}]
--
-- Entra entera o no entra. Si ya había una carga, la DESCARTA y la reemplaza —mientras el barrio no
-- haya emitido su primer mes y nadie haya cobrado contra esa deuda—. Inserta los períodos en borrador
-- y los pasa a emitida, que es lo que debita la cuenta corriente (`app.saldo_uf_por_emision`) y lo
-- que verifica `app.validar_emision` (`0087`). Con las dos listas vacías deja dicho que el barrio no
-- trae deuda.
-- ---------------------------------------------------------------------------------------------
create or replace function app.cargar_deuda_historica(p_barrio uuid, p_deudas jsonb, p_a_favor jsonb, p_archivo text)
  returns jsonb
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario   uuid := app.current_user_id();
  v_primer    text;
  v_hoy       date;
  v_mal       bigint;
  v_n         bigint;
  v_unidades  bigint;
  v_total     numeric(14,2);
  v_n_favor   bigint;
  v_favor     numeric(14,2);
  v_reemplaza boolean;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: la deuda anterior se carga con una identidad';
  end if;
  if not app.has_role_on(p_barrio, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
    raise exception 'la deuda anterior la carga la administración del barrio (admin_barrio o admin_plataforma)'
      using errcode = '42501';
  end if;
  if jsonb_typeof(p_deudas) is distinct from 'array' or jsonb_typeof(p_a_favor) is distinct from 'array' then
    raise exception 'la deuda anterior se carga como dos listas: las deudas y los saldos a favor';
  end if;
  if jsonb_array_length(p_deudas) + jsonb_array_length(p_a_favor) > 5000 then
    raise exception 'la planilla de deuda tiene más de 5000 renglones: partila';
  end if;

  -- Una carga por barrio a la vez.
  perform pg_advisory_xact_lock(hashtextextended('deuda-anterior:' || p_barrio::text, 0));
  select b.primer_periodo, (now() at time zone b.zona_horaria)::date into v_primer, v_hoy
    from barrio b where b.barrio_id = p_barrio for update;
  if v_primer is null then
    raise exception 'el barrio no tiene primer mes a devengar: cargalo antes de traer la deuda anterior';
  end if;
  -- Un barrio que ya operaba antes de que existiera la activación (activo y sin firma) no eligió una
  -- tasa para la deuda anterior: lo que cargara no devengaría nunca (panel `security-engineer`, A2).
  if exists (select 1 from barrio b where b.barrio_id = p_barrio and b.activacion = 'activo' and b.activacion_fecha is null) then
    raise exception 'este barrio ya operaba antes de la activación: no trae deuda anterior por planilla';
  end if;

  if exists (select 1 from periodo_expensa pe
              where pe.barrio_id = p_barrio and pe.origen = 'mensual' and pe.estado in ('emitida', 'distribuida')) then
    raise exception 'el barrio ya emitió su primer mes: la deuda anterior no se reemplaza con otra planilla, se corrige con un ajuste';
  end if;

  -- ── Descartar la carga anterior ────────────────────────────────────────────────────────────
  if exists (
      select 1 from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
       where pe.barrio_id = p_barrio and pe.origen = 'historico'
         and (exists (select 1 from pago_imputacion pi where pi.liquidacion_id = l.id)
           or exists (select 1 from interes_devengado d where d.liquidacion_id = l.id)))
     or exists (
      select 1 from pago p
       where p.barrio_id = p_barrio and p.origen = 'activacion'
         and (exists (select 1 from pago_imputacion pi where pi.pago_id = p.id)
           or exists (select 1 from pago_imputacion_interes pii where pii.pago_id = p.id))) then
    raise exception 'la deuda anterior ya tiene cobros registrados: no se reemplaza con otra planilla, se corrige con un ajuste';
  end if;

  v_reemplaza := exists (select 1 from periodo_expensa pe where pe.barrio_id = p_barrio and pe.origen = 'historico')
              or exists (select 1 from pago p where p.barrio_id = p_barrio and p.origen = 'activacion' and p.anulado_at is null);

  update saldo_uf s
     set saldo_actual = s.saldo_actual - x.total
    from (select l.unidad_funcional_id, sum(l.importe_exigible) as total
            from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
           where pe.barrio_id = p_barrio and pe.origen = 'historico' and pe.estado in ('emitida', 'distribuida')
           group by l.unidad_funcional_id) x
   where s.barrio_id = p_barrio and s.unidad_funcional_id = x.unidad_funcional_id;
  -- Las liquidaciones y sus líneas se van en cascada con el período.
  delete from periodo_expensa pe where pe.barrio_id = p_barrio and pe.origen = 'historico';
  update pago p
     set anulado_at = now(), anulado_por = v_usuario,
         motivo_anulacion = 'Se volvió a cargar la deuda anterior del barrio'
   where p.barrio_id = p_barrio and p.origen = 'activacion' and p.anulado_at is null;

  -- ── Validar lo que llega ───────────────────────────────────────────────────────────────────
  select count(*) into v_mal
    from jsonb_to_recordset(p_deudas)
           as d(unidad uuid, periodo text, vencimiento date, concepto uuid, concepto_boleta uuid, importe numeric)
   where d.unidad is null
      or d.periodo is null or d.periodo !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or d.periodo >= v_primer
      or d.vencimiento is null or d.vencimiento > v_hoy
      -- Un vencimiento anterior a su propio mes es un año mal tipeado: devengaría años de interés.
      or d.vencimiento < (d.periodo || '-01')::date
      or d.importe is null or d.importe <= 0 or d.importe <> round(d.importe, 2) or d.importe >= 1000000000000
      or num_nonnulls(d.concepto, d.concepto_boleta) <> 1;
  if v_mal > 0 then
    raise exception 'la deuda anterior tiene % renglones inválidos: mes anterior al primer mes a devengar, vencimiento que ya pasó y no anterior a su mes, un concepto e importe mayor que cero', v_mal;
  end if;

  select count(*) into v_mal
    from jsonb_to_recordset(p_a_favor) as f(unidad uuid, importe numeric)
   where f.unidad is null or f.importe is null or f.importe <= 0 or f.importe <> round(f.importe, 2) or f.importe >= 1000000000000;
  if v_mal > 0 then
    raise exception 'la deuda anterior tiene % saldos a favor inválidos', v_mal;
  end if;

  -- Las unidades: de este barrio, activas y sin saldo inicial (son dos formas de traer lo mismo).
  select count(*) into v_mal
    from (select d.unidad from jsonb_to_recordset(p_deudas) as d(unidad uuid)
          union
          select f.unidad from jsonb_to_recordset(p_a_favor) as f(unidad uuid)) x
   where not exists (select 1 from unidad_funcional u
                      where u.id = x.unidad and u.barrio_id = p_barrio and u.baja_at is null and u.saldo_inicial = 0);
  if v_mal > 0 then
    raise exception 'la deuda anterior nombra % unidades que no son del padrón activo del barrio o que ya tienen saldo inicial', v_mal;
  end if;

  -- Los conceptos: del catálogo de ESTE barrio. De los cargos y descuentos, solo un cargo.
  select count(*) into v_mal
    from jsonb_to_recordset(p_deudas) as d(concepto uuid, concepto_boleta uuid)
   where (d.concepto is not null
          and not exists (select 1 from concepto co where co.id = d.concepto and co.barrio_id = p_barrio))
      or (d.concepto_boleta is not null
          and not exists (select 1 from concepto_boleta cb
                           where cb.id = d.concepto_boleta and cb.barrio_id = p_barrio and cb.clase::text = 'cargo'));
  if v_mal > 0 then
    raise exception 'la deuda anterior nombra % conceptos que no están en el catálogo del barrio', v_mal;
  end if;

  if exists (
      select 1 from jsonb_to_recordset(p_deudas)
                      as d(unidad uuid, periodo text, vencimiento date, concepto uuid, concepto_boleta uuid)
       group by d.unidad, d.periodo, d.vencimiento, coalesce(d.concepto, d.concepto_boleta)
      having count(*) > 1) then
    raise exception 'la deuda anterior tiene renglones repetidos: la misma unidad, mes, concepto y vencimiento';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_a_favor) as f(unidad uuid) group by f.unidad having count(*) > 1) then
    raise exception 'la deuda anterior tiene más de un saldo a favor para la misma unidad';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_a_favor) as f(unidad uuid)
              join jsonb_to_recordset(p_deudas) as d(unidad uuid) on d.unidad = f.unidad) then
    raise exception 'la deuda anterior trae una unidad con deuda y con saldo a favor: descontá el saldo de lo que debe';
  end if;

  -- ── Escribir ───────────────────────────────────────────────────────────────────────────────
  insert into periodo_expensa (barrio_id, periodo, origen, notas)
  select distinct p_barrio, d.periodo, 'historico', 'Deuda anterior a la activación del barrio'
    from jsonb_to_recordset(p_deudas) as d(periodo text);

  insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, coeficiente_aplicado,
                           subtotal_ordinarias, subtotal_extraordinarias, subtotal_fondo_reserva, subtotal_cargos,
                           interes_mora, total, vencimiento, saldo_anterior_origen)
  select p_barrio, pe.id, d.unidad, 0,
         coalesce(sum(d.importe) filter (where co.id is not null and co.tipo::text <> 'extraordinaria'), 0),
         coalesce(sum(d.importe) filter (where co.tipo::text = 'extraordinaria'), 0),
         0,
         coalesce(sum(d.importe) filter (where d.concepto_boleta is not null), 0),
         0, sum(d.importe), d.vencimiento, 'sin_movimientos'
    from jsonb_to_recordset(p_deudas)
           as d(unidad uuid, periodo text, vencimiento date, concepto uuid, concepto_boleta uuid, importe numeric)
    join periodo_expensa pe on pe.barrio_id = p_barrio and pe.periodo = d.periodo and pe.origen = 'historico'
    left join concepto co on co.id = d.concepto
   group by pe.id, d.unidad, d.vencimiento;

  insert into item_liquidacion (barrio_id, liquidacion_id, concepto_id, concepto_boleta_id, descripcion, tipo,
                                base_monto, monto, clase_item)
  select p_barrio, l.id, d.concepto, d.concepto_boleta, coalesce(co.nombre, cb.nombre), co.tipo,
         d.importe, d.importe, 'historico'
    from jsonb_to_recordset(p_deudas)
           as d(unidad uuid, periodo text, vencimiento date, concepto uuid, concepto_boleta uuid, importe numeric)
    join periodo_expensa pe on pe.barrio_id = p_barrio and pe.periodo = d.periodo and pe.origen = 'historico'
    join liquidacion l on l.periodo_id = pe.id and l.unidad_funcional_id = d.unidad and l.vencimiento = d.vencimiento
    left join concepto co on co.id = d.concepto
    left join concepto_boleta cb on cb.id = d.concepto_boleta;

  -- Emitir es lo que la vuelve deuda: debita la cuenta corriente y la deja inmutable.
  update periodo_expensa pe set estado = 'emitida'
   where pe.barrio_id = p_barrio and pe.origen = 'historico' and pe.estado = 'borrador';

  insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen, estado_conciliacion)
  select p_barrio, f.unidad, f.importe, v_hoy, 'activacion', 'conciliado'
    from jsonb_to_recordset(p_a_favor) as f(unidad uuid, importe numeric);

  select count(*), count(distinct d.unidad), coalesce(sum(d.importe), 0) into v_n, v_unidades, v_total
    from jsonb_to_recordset(p_deudas) as d(unidad uuid, importe numeric);
  select count(*), coalesce(sum(f.importe), 0) into v_n_favor, v_favor
    from jsonb_to_recordset(p_a_favor) as f(unidad uuid, importe numeric);

  update barrio b
     set deuda_anterior_estado = case when v_n + v_n_favor > 0 then 'cargada' else 'sin_deuda' end
   where b.barrio_id = p_barrio;

  insert into padron_evento (barrio_id, unidad_funcional_id, tipo, detalle, archivo, datos)
  values (p_barrio, null, 'configuracion_barrio',
          case when v_n + v_n_favor = 0
               then 'Deuda anterior a la activación: el barrio no trae deuda'
               else 'Deuda anterior a la activación: se cargan ' || v_n || ' deudas de ' || v_unidades
                    || ' unidades por $ ' || v_total || ' y ' || v_n_favor
                    || case when v_n_favor = 1 then ' saldo a favor por $ ' else ' saldos a favor por $ ' end || v_favor
          end || case when v_reemplaza then ' (reemplaza la carga anterior).' else '.' end,
          left(nullif(btrim(p_archivo), ''), 200),
          jsonb_build_object('deudaAnterior', true, 'deudas', v_n, 'unidades', v_unidades, 'total', v_total,
                             'saldosAFavor', v_n_favor, 'totalAFavor', v_favor, 'reemplaza', v_reemplaza));

  return jsonb_build_object('deudas', v_n, 'unidades', v_unidades, 'total', v_total,
                            'saldosAFavor', v_n_favor, 'totalAFavor', v_favor, 'reemplaza', v_reemplaza);
end; $$;
--> statement-breakpoint
alter function app.cargar_deuda_historica(uuid, jsonb, jsonb, text) owner to app_job;
--> statement-breakpoint
revoke all on function app.cargar_deuda_historica(uuid, jsonb, jsonb, text) from public;
--> statement-breakpoint
grant execute on function app.cargar_deuda_historica(uuid, jsonb, jsonb, text) to app_request, app_job;
