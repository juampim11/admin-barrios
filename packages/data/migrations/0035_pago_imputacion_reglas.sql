-- =============================================================================================
-- 0035_pago_imputacion_reglas — la imputación manual, con su propio candado de concurrencia.
--
-- Es el archivo más sensible de toda la tanda: dos transacciones que intentan imputar contra la
-- MISMA liquidación al mismo tiempo tienen que serializarse, no sumar por encima de lo que la
-- liquidación admite. Calco del idioma de `0023_carrera_de_emision_y_oraculos.sql` (`for update`
-- explícito, corte temprano de rol antes de cualquier lectura que pudiera interpolar un dato de otro
-- barrio) y de `0021` (anulación pareada y congelada).
--
-- **Orden de los locks, y por qué importa.** Esta función SIEMPRE toma el lock de `pago` antes que
-- el de `liquidacion`. Es el único camino de escritura que toma los dos, así que mientras se respete
-- ese orden acá no hay forma de deadlockear entre dos inserts concurrentes: el segundo espera al
-- primero en el primer lock que pisan en común.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. FKs compuestas anti-cruce.
-- ---------------------------------------------------------------------------------------------
alter table pago_imputacion add constraint uq_pago_imputacion_id_barrio unique (id, barrio_id);
--> statement-breakpoint

alter table pago_imputacion
  add constraint fk_pago_imputacion_pago_barrio foreign key (pago_id, barrio_id)
  references pago (id, barrio_id) on delete restrict;
--> statement-breakpoint

alter table pago_imputacion
  add constraint fk_pago_imputacion_liquidacion_barrio foreign key (liquidacion_id, barrio_id)
  references liquidacion (id, barrio_id) on delete restrict;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. El trigger.
-- ---------------------------------------------------------------------------------------------
create or replace function app.pago_imputacion_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario  uuid := app.current_user_id();
  v_roles    constant app.rol_membership[] :=
    array['admin_plataforma','admin_barrio','operador']::app.rol_membership[];
  v_barrio_pago      uuid;
  v_monto_pago       numeric(14,2);
  v_ya_imputado_pago numeric(14,2);
  v_remanente_pago   numeric(14,2);
  v_barrio_liq       uuid;
  v_total_liq        numeric(14,2);
  v_estado_periodo   app.estado_periodo;
  v_ya_imputado_liq  numeric(14,2);
  v_saldo_liq        numeric(14,2);
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: una imputación sin autor no se registra';
  end if;

  if tg_op = 'INSERT' then
    -- (1) Lock del PAGO, primero siempre. De acá sale también el barrio: nunca se confía en lo que
    -- mande el cliente en `barrio_id` (se pisa más abajo).
    select barrio_id, monto into v_barrio_pago, v_monto_pago
      from pago where id = new.pago_id for update;

    -- Corte temprano de rol e "uniforme": para quien no tiene acceso al barrio del pago, un pago
    -- inexistente y uno ajeno se ven igual. Se corta ACÁ, antes de tocar la liquidación, que es
    -- exactamente el AGUJERO 2 que cerró 0023.
    if v_barrio_pago is null or not app.has_role_on(v_barrio_pago, v_roles) then
      raise exception 'el pago no existe o no es de este barrio';
    end if;
    if exists (select 1 from pago where id = new.pago_id and anulado_at is not null) then
      raise exception 'ese pago está anulado: no se le puede imputar nada';
    end if;

    -- (2) Lock de la LIQUIDACIÓN, segundo. Mismo criterio de mensaje uniforme si no es del mismo
    -- barrio que el pago (ya autorizado arriba): no se distingue "no existe" de "es de otro barrio".
    select l.barrio_id, l.total, pe.estado into v_barrio_liq, v_total_liq, v_estado_periodo
      from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
     where l.id = new.liquidacion_id for update of l;
    if v_barrio_liq is null or v_barrio_liq <> v_barrio_pago then
      raise exception 'la liquidación no existe o no es del mismo barrio que el pago';
    end if;
    -- Solo se imputa contra una liquidación de un período YA EMITIDO: una en borrador puede
    -- desaparecer al regenerar (`generarLiquidaciones` borra y recrea las liquidaciones del
    -- período), y la FK de imputación es `on delete restrict` — bloquearía esa regeneración con un
    -- error de FK que no explica nada. Emitida, `app.periodo_editable()` ya la vuelve inmutable.
    if v_estado_periodo not in ('emitida', 'distribuida') then
      raise exception 'esa liquidación todavía no está emitida: no se le puede imputar un pago';
    end if;

    -- El propio barrio de la fila lo escribe la base, nunca el request.
    new.barrio_id := v_barrio_pago;

    -- Saldo pendiente de la liquidación: lo que ya tiene imputado (vivo) se descuenta del total.
    select coalesce(sum(monto_imputado), 0) into v_ya_imputado_liq
      from pago_imputacion where liquidacion_id = new.liquidacion_id and anulado_at is null;
    v_saldo_liq := v_total_liq - v_ya_imputado_liq;
    if new.monto_imputado > v_saldo_liq then
      raise exception 'el importe imputado (%) supera el saldo pendiente de la liquidación (%): no se '
                      'sobre-imputa', new.monto_imputado, v_saldo_liq;
    end if;

    -- Remanente del pago: lo mismo, del lado del pago. El lock tomado en (1) es lo que hace que este
    -- número no pueda quedar viejo si otra transacción está imputando el mismo pago contra OTRA
    -- liquidación al mismo tiempo.
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
  end if;

  if tg_op = 'UPDATE' then
    if not app.has_role_on(new.barrio_id, v_roles) then
      raise exception 'no tenés permiso para modificar imputaciones en este barrio';
    end if;

    -- Append-only real: lo único que se puede tocar es la terna de anulación.
    if (new.barrio_id, new.pago_id, new.liquidacion_id, new.monto_imputado)
       is distinct from
       (old.barrio_id, old.pago_id, old.liquidacion_id, old.monto_imputado)
    then
      raise exception 'una imputación no se edita: se anula (con motivo) y se carga otra';
    end if;

    -- Mensajes DISTINTOS de los de `pago` (0034) y `concepto_boleta_unidad` (0021) a propósito: ver
    -- la nota de 0034 sobre por qué `errores.ts` necesita que no colisionen.
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
    end if;
  end if;

  return new;
end; $$;--> statement-breakpoint

alter function app.pago_imputacion_antes() owner to app_job;--> statement-breakpoint

create trigger trg_pago_imputacion_antes before insert or update on pago_imputacion
  for each row execute function app.pago_imputacion_antes();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. RLS. Sin policy ni grant de DELETE para NADIE, ni siquiera `app_job`: append-only real, mismo
--    criterio que `concepto_boleta_unidad_evento` (0016) — si hace falta corregir un monto, se
--    anula la fila y se carga otra.
-- ---------------------------------------------------------------------------------------------
alter table pago_imputacion enable row level security;
--> statement-breakpoint
alter table pago_imputacion force row level security;
--> statement-breakpoint

create policy pago_imputacion_sel on pago_imputacion for select
  using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint

create policy pago_imputacion_ins on pago_imputacion for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

create policy pago_imputacion_upd on pago_imputacion for update
  using (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]))
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

grant select, insert, update on table pago_imputacion to app_request;
--> statement-breakpoint
grant select, insert, update on table pago_imputacion to app_job;
