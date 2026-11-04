-- =============================================================================================
-- 0070_condonacion_y_mes_del_servicio — encargo 11 (BL-030 k y el permiso de anular un pago).
--
-- Solo esquema y funciones: una columna nullable, un check, una función y tres triggers. **No cambia
-- ni una fila.**
--
--   k  · `orden_pago.mes_servicio` («Mes del servicio», `YYYY-MM`): de qué mes es el servicio que se
--        paga. Opcional y solo informativo: el gasto se sigue imputando al período de la orden. Se
--        carga con la orden y, como el resto de sus datos, fuera de `pendiente` no se cambia.
--
--   Permiso · Un pago con interés condonado vigente lo anula la administración (admin del barrio o de
--        la plataforma), no un operador: anularlo anula también la condonación, y condonar es de la
--        administración (`0062`). La regla va en el trigger del pago (`app.pago_antes`), así no se
--        saltea con un `update pago` directo. Y la anulación de una condonación (`0068`, `0069`)
--        queda también solo para la administración.
--
-- `app.pago_antes` es copia de la versión de `0068`, e `app.interes_condonacion_antes` de la de
-- `0069`; lo único nuevo está marcado `[0070]`.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- k. El mes del servicio de una orden de pago
-- ---------------------------------------------------------------------------------------------
alter table orden_pago add column mes_servicio text;
--> statement-breakpoint
alter table orden_pago add constraint orden_pago_mes_servicio_chk
  check (mes_servicio is null or mes_servicio ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
--> statement-breakpoint

-- Igual que las demás columnas de la orden (`app.orden_pago_transicion`, `0066`): fuera de
-- `pendiente`, no se edita. Trigger propio para no reescribir la transición entera por una columna.
create or replace function app.orden_pago_mes_servicio_congelado() returns trigger
  language plpgsql set search_path = public, app, pg_temp
as $$
begin
  if old.estado <> 'pendiente' and new.mes_servicio is distinct from old.mes_servicio then
    raise exception 'una orden de pago fuera de pendiente no se edita: anulá y cargá una nueva';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_orden_pago_mes_servicio_congelado before update of mes_servicio on orden_pago
  for each row execute function app.orden_pago_mes_servicio_congelado();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Permiso. ¿El pago tiene interés condonado vigente?
-- ---------------------------------------------------------------------------------------------
-- Security definer (dueño `app_job`) para que la respuesta no dependa de qué condonaciones ve quien
-- anula; responde solo por pagos de un barrio donde quien pregunta registra pagos (sin oráculo, como
-- `app.obligado_titular_a_la_fecha` en `0069`).
create or replace function app.pago_tiene_condonacion_vigente(p_pago uuid) returns boolean
  language sql stable security definer set search_path = public, app, pg_temp
as $$
  select exists (
    select 1 from interes_condonacion c
      join pago p on p.id = c.pago_id
     where c.pago_id = p_pago and c.anulado_at is null
       and app.has_role_on(p.barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[])
  )
$$;
--> statement-breakpoint
alter function app.pago_tiene_condonacion_vigente(uuid) owner to app_job;
--> statement-breakpoint
revoke all on function app.pago_tiene_condonacion_vigente(uuid) from public;
--> statement-breakpoint
grant execute on function app.pago_tiene_condonacion_vigente(uuid) to app_request, app_job;
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
      new.anulado_at  := now();
      new.anulado_por := v_usuario;
    end if;
  end if;

  return new;
end; $function$;
--> statement-breakpoint

create or replace function app.interes_condonacion_antes() returns trigger
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_barrio uuid;
  v_unidad uuid;
  v_pendiente numeric(14,2);
  v_motivo_pago text;
begin
  if tg_op = 'DELETE' then
    raise exception 'una condonación no se edita ni se borra: queda en el registro';
  end if;
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: una condonación sin autor no se registra';
  end if;

  if tg_op = 'UPDATE' then
    -- La única edición: anularla junto con su pago (P5, `0068`).
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
    -- [0070] Anular una condonación es de la administración, igual que crearla: un operador ya no anula
    -- el pago que la tiene (`app.pago_antes`), y tampoco la condonación suelta de un pago anulado.
    if not app.has_role_on(old.barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
      raise exception 'anular un pago con interés condonado es de la administración del barrio';
    end if;
    select p.motivo_anulacion into v_motivo_pago
      from pago p where p.id = old.pago_id and p.anulado_at is not null;
    if old.pago_id is null or v_motivo_pago is null then
      raise exception 'una condonación solo se anula junto con el pago con el que se registró';
    end if;
    -- [0069] El motivo es el del pago, no el que mande el cliente.
    new.motivo_anulacion := v_motivo_pago;
    new.anulado_at := now();
    new.anulado_por := v_usuario;
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
  new.anulado_at := null;
  new.anulado_por := null;
  new.motivo_anulacion := null;

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
