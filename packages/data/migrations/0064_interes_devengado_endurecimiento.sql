-- =============================================================================================
-- 0064_interes_devengado_endurecimiento — lo que encontró la revisión de seguridad de `0062`.
--
--   · A1: un tramo de interés no puede terminar en una fecha futura (en la hora del barrio).
--   · M3: cada tramo guarda con qué se calculó (`parametros` obligatorio).
--   · M1: `app.capital_pendiente` y `app.interes_pendiente` pasan a `security invoker`: con el uuid
--     de una liquidación o de un interés de otro barrio no devuelven nada (RLS de quien consulta).
--     Adentro de los triggers y de `resolver_imputacion` (dueño `app_job`) se comportan igual.
--   · M2: el interés pendiente no descuenta lo imputado por un pago anulado (igual que la vista del
--     estado de cuenta): un pago que se anula no deja el interés como pagado.
--   · B5: `app_job` necesita poder tomar un bloqueo de fila, no editar: `update` solo sobre `id`.
-- La función del trigger se copia de `0062`; lo nuevo está marcado `[0064]`.
-- =============================================================================================

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

  select l.barrio_id, l.unidad_funcional_id, pe.estado, pe.primer_vencimiento
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

alter function app.capital_pendiente(uuid) security invoker;
--> statement-breakpoint

create or replace function app.interes_pendiente(p_interes uuid) returns numeric
  language sql stable security invoker set search_path = public, app
as $$
  select d.monto
         - coalesce((select sum(pii.monto_imputado) from pago_imputacion_interes pii
                       join pago p on p.id = pii.pago_id
                      where pii.interes_id = d.id and pii.anulado_at is null and p.anulado_at is null), 0)
         - coalesce((select sum(c.monto) from interes_condonacion c where c.interes_id = d.id), 0)
    from interes_devengado d where d.id = p_interes
$$;
--> statement-breakpoint

revoke update on table interes_devengado, interes_condonacion from app_job;
--> statement-breakpoint
grant update (id) on table interes_devengado, interes_condonacion to app_job;
