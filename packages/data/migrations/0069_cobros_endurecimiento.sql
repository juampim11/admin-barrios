-- =============================================================================================
-- 0069_cobros_endurecimiento — lo que pidió `security-engineer` sobre `0068` (encargo 9, PR 2).
--
-- Solo funciones: no cambia ni una fila.
--
--   · `app.obligado_titular_a_la_fecha`: responde solo por unidades de un barrio donde quien pregunta
--     registra pagos. Antes, siendo security definer, contestaba por cualquier barrio: un oráculo de
--     «¿X era titular de la unidad Y?» para quien conociera los dos uuid.
--   · `app.serializar_cobros_de_unidad`: toma el candado solo si quien llama ve la unidad (lectura bajo
--     su RLS). Antes, con el uuid de una unidad ajena, se podía demorar los cobros de otro barrio.
--   · `app.interes_condonacion_antes`: la anulación copia el motivo DEL PAGO, no el que mande el cliente
--     («con el mismo motivo» no depende de quien hace el UPDATE).
--   · `pg_temp` al final del `search_path` de las funciones security definer nuevas: una tabla
--     temporal con el nombre de una real no las engaña.
-- =============================================================================================

create or replace function app.obligado_titular_a_la_fecha(p_unidad uuid, p_obligado uuid, p_fecha date) returns boolean
  language sql stable security definer set search_path = public, app, pg_temp
as $$
  select exists (
    select 1 from unidad_obligado uo
     where uo.unidad_funcional_id = p_unidad and uo.obligado_id = p_obligado
       and uo.desde <= p_fecha and (uo.hasta is null or uo.hasta >= p_fecha)
       and app.has_role_on(uo.barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[])
  )
$$;
--> statement-breakpoint

create or replace function app.serializar_cobros_de_unidad(p_unidad uuid) returns void
  language plpgsql set search_path = public, app, pg_temp set lock_timeout = '5s'
as $$
begin
  -- Bajo la RLS de quien llama: una unidad que no ve no se bloquea (el registro igual va a fallar).
  if not exists (select 1 from unidad_funcional u where u.id = p_unidad) then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cobros-de-unidad:' || p_unidad::text, 0));
exception when lock_not_available then
  raise exception 'se está registrando otro pago de esta unidad';
end; $$;
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
    if not app.has_role_on(old.barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) then
      raise exception 'no tenés permiso para anular pagos en este barrio';
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
--> statement-breakpoint
