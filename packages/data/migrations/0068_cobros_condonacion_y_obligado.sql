-- =============================================================================================
-- 0068_cobros_condonacion_y_obligado — encargo 9, PR 2 (P5 y BL-022 f y g).
--
-- Solo esquema y funciones: tres columnas nullable, un check, una política, una vista y cuatro
-- funciones. **No cambia ni una fila**: las condonaciones existentes quedan sin anular y los pagos
-- existentes no se revisan (la regla del obligado mira solo los pagos nuevos).
--
--   P5 · La condonación de interés que se registró con un pago («No cobrar interés de este pago») se
--        anula con el pago, con el mismo motivo y sin borrar nada — igual que sus imputaciones (0066 y
--        `anularPago`, BL-022 a). Columnas `anulado_at`, `anulado_por`, `motivo_anulacion`; el trigger
--        acepta exactamente esa transición, solo si el pago ya está anulado, y le devuelve el importe a
--        `saldo_uf`. `app.interes_pendiente` y `app.v_estado_cuenta_uf` dejan de contar las anuladas:
--        el interés vuelve a estar adeudado, y el estado de cuenta y `saldo_uf` coinciden.
--
--   f  · `app.serializar_cobros_de_unidad(uf)`: un candado por unidad para registrar e imputar un pago.
--        Dos pagos simultáneos de la misma unidad se hacen uno después del otro; si el otro tarda más
--        de 5 segundos, este falla con un texto propio (`errores.ts`: «Se está registrando otro pago de
--        esta unidad; probá de nuevo»). Nunca se imputa dos veces.
--
--   g  · El obligado de un pago tiene que ser titular de la unidad a la fecha del pago
--        (`unidad_obligado.desde <= fecha <= hasta`, con `hasta` inclusive y abierto si es null). Un
--        pago sin obligado sigue pasando (la unidad puede no tener uno vigente).
-- =============================================================================================

alter table interes_condonacion
  add column anulado_at timestamptz,
  add column anulado_por uuid,
  add column motivo_anulacion text;
--> statement-breakpoint
alter table interes_condonacion add constraint interes_condonacion_anulacion_chk check (
  (anulado_at is null) = (anulado_por is null) and (anulado_at is null) = (motivo_anulacion is null)
);
--> statement-breakpoint

-- La condonación: se registra (como antes, sin cambios) y ahora también se anula, pero solo junto con
-- el pago con el que se registró. Ninguna otra edición, y no se borra.
create or replace function app.interes_condonacion_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_barrio uuid;
  v_unidad uuid;
  v_pendiente numeric(14,2);
begin
  if tg_op = 'DELETE' then
    raise exception 'una condonación no se edita ni se borra: queda en el registro';
  end if;
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: una condonación sin autor no se registra';
  end if;

  if tg_op = 'UPDATE' then
    -- [0068] La única edición: anularla junto con su pago (P5). Todo lo demás, como antes.
    if old.anulado_at is not null then
      raise exception 'la anulación de una condonación no se revierte ni se reescribe';
    end if;
    if new.anulado_at is null
       or (new.id, new.barrio_id, new.unidad_funcional_id, new.interes_id, new.monto, new.motivo, new.detalle,
           new.respaldo_tipo, new.respaldo_referencia, new.respaldo_adjunto, new.origen, new.pago_id,
           new.rol_al_condonar, new.creado_por, new.created_at)
          is distinct from
          (old.id, old.barrio_id, old.unidad_funcional_id, old.interes_id, old.monto, old.motivo, old.detalle,
           old.respaldo_tipo, old.respaldo_referencia, old.respaldo_adjunto, old.origen, old.pago_id,
           old.rol_al_condonar, old.creado_por, old.created_at) then
      raise exception 'una condonación no se edita ni se borra: queda en el registro';
    end if;
    if not app.has_role_on(old.barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) then
      raise exception 'no tenés permiso para anular pagos en este barrio';
    end if;
    if old.pago_id is null or not exists (
        select 1 from pago p where p.id = old.pago_id and p.anulado_at is not null) then
      raise exception 'una condonación solo se anula junto con el pago con el que se registró';
    end if;
    if nullif(btrim(new.motivo_anulacion), '') is null then
      raise exception 'la anulación de una condonación necesita motivo';
    end if;
    new.anulado_at := now();
    new.anulado_por := v_usuario;
    -- El interés vuelve a estar adeudado: lo que la condonación había bajado del saldo, vuelve.
    update saldo_uf set saldo_actual = saldo_actual + old.monto, fecha_ultimo_movimiento = current_date
     where barrio_id = old.barrio_id and unidad_funcional_id = old.unidad_funcional_id;
    return new;
  end if;

  select d.barrio_id, d.unidad_funcional_id into v_barrio, v_unidad
    from interes_devengado d where d.id = new.interes_id for update;
  if v_barrio is null or not app.has_role_on(v_barrio, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
    raise exception 'condonar interés es de la administración del barrio';
  end if;
  new.barrio_id := v_barrio;
  new.unidad_funcional_id := v_unidad;
  new.creado_por := v_usuario;
  new.created_at := now();
  new.rol_al_condonar := case when app.has_role_on(v_barrio, array['admin_barrio']::app.rol_membership[])
                              then 'admin_barrio' else 'admin_plataforma' end;
  -- [0068] Nace sin anular.
  new.anulado_at := null;
  new.anulado_por := null;
  new.motivo_anulacion := null;

  -- Solo lo devengado y no pagado: lo ya imputado no se condona.
  v_pendiente := app.interes_pendiente(new.interes_id);
  if new.monto > v_pendiente then
    raise exception 'se quiere condonar % y el interés pendiente es %: lo pagado no se condona', new.monto, v_pendiente;
  end if;
  if new.pago_id is not null and not exists (
      select 1 from pago p where p.id = new.pago_id and p.unidad_funcional_id = v_unidad) then
    raise exception 'el pago de la condonación no es de esta unidad';
  end if;
  if new.respaldo_adjunto is not null and not exists (
      select 1 from subida_respaldo_solicitada s where s.storage_key = new.respaldo_adjunto and s.nodo_id = v_barrio) then
    raise exception 'el adjunto del respaldo no es uno que se haya subido para este barrio';
  end if;

  update saldo_uf set saldo_actual = saldo_actual - new.monto, fecha_ultimo_movimiento = current_date
   where barrio_id = v_barrio and unidad_funcional_id = v_unidad;
  return new;
end; $$;
--> statement-breakpoint
alter function app.interes_condonacion_antes() owner to app_job;
--> statement-breakpoint

create policy interes_condonacion_upd on interes_condonacion for update
  using (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]))
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint
grant update (anulado_at, anulado_por, motivo_anulacion) on table interes_condonacion to app_request;
--> statement-breakpoint

-- El interés pendiente: lo devengado menos lo imputado (de pagos vivos) y lo condonado **sin anular**.
-- Copia de la versión de `0064`; lo único nuevo está marcado `[0068]`.
create or replace function app.interes_pendiente(p_interes uuid) returns numeric
  language sql stable security invoker set search_path = public, app
as $$
  select d.monto
         - coalesce((select sum(pii.monto_imputado) from pago_imputacion_interes pii
                       join pago p on p.id = pii.pago_id
                      where pii.interes_id = d.id and pii.anulado_at is null and p.anulado_at is null), 0)
         - coalesce((select sum(c.monto) from interes_condonacion c
                      where c.interes_id = d.id and c.anulado_at is null), 0) -- [0068]
    from interes_devengado d where d.id = p_interes
$$;
--> statement-breakpoint

-- El estado de cuenta, sin las condonaciones anuladas. Copia de la versión de `0062`; lo único nuevo
-- está marcado `[0068]`. Mismas columnas, mismo orden: `create or replace` alcanza.
create or replace view app.v_estado_cuenta_uf with (security_invoker = true) as
with movimientos as (
  select l.unidad_funcional_id, l.barrio_id, pe.emitida_at::date as fecha, l.id as origen_id,
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

-- BL-022 f: un candado por unidad para registrar e imputar sus pagos, hasta el fin de la transacción.
-- Espera a lo sumo 5 segundos (el `set` de la función vale solo mientras corre); si no, texto propio.
create or replace function app.serializar_cobros_de_unidad(p_unidad uuid) returns void
  language plpgsql set search_path = public, app set lock_timeout = '5s'
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('cobros-de-unidad:' || p_unidad::text, 0));
exception when lock_not_available then
  raise exception 'se está registrando otro pago de esta unidad';
end; $$;
--> statement-breakpoint
revoke all on function app.serializar_cobros_de_unidad(uuid) from public;
--> statement-breakpoint
grant execute on function app.serializar_cobros_de_unidad(uuid) to app_request, app_job;
--> statement-breakpoint

-- BL-022 g: ¿el obligado es titular de la unidad a esa fecha? Security definer y dueño `app_job`
-- (sin RLS) para que la respuesta no dependa de qué filas ve quien registra: la regla es del padrón.
create or replace function app.obligado_titular_a_la_fecha(p_unidad uuid, p_obligado uuid, p_fecha date) returns boolean
  language sql stable security definer set search_path = public, app
as $$
  select exists (
    select 1 from unidad_obligado uo
     where uo.unidad_funcional_id = p_unidad and uo.obligado_id = p_obligado
       and uo.desde <= p_fecha and (uo.hasta is null or uo.hasta >= p_fecha)
  )
$$;
--> statement-breakpoint
alter function app.obligado_titular_a_la_fecha(uuid, uuid, date) owner to app_job;
--> statement-breakpoint
revoke all on function app.obligado_titular_a_la_fecha(uuid, uuid, date) from public;
--> statement-breakpoint
grant execute on function app.obligado_titular_a_la_fecha(uuid, uuid, date) to app_request, app_job;
--> statement-breakpoint

-- La regla del obligado en el trigger de `pago`. Copia de la versión de `0034`; lo único nuevo está
-- marcado `[0068]`.
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
      new.anulado_at  := now();
      new.anulado_por := v_usuario;
    end if;
  end if;

  return new;
end; $function$;
