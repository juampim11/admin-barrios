-- =============================================================================================
-- 0088_imputacion_por_vencimiento — el capital se imputa del vencimiento más viejo al más nuevo
-- (encargo 17). **Solo DDL**: una función.
--
-- `app.resolver_imputacion` se copia ENTERA de `0062` y lo único nuevo va marcado `[0088]`: el
-- capital se ordena por `(coalesce(l.vencimiento, pe.primer_vencimiento, <primer día del mes>), l.created_at, l.id)` en vez
-- de `(l.created_at, l.id)`. La pasada de interés, los topes y el orden del barrio no cambian.
-- `create or replace` conserva el dueño (`app_job`) y los permisos.
-- =============================================================================================

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
  v_remanente   numeric(14,2);
  v_a_imputar   numeric(14,2);
  v_pasada      int;
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

  v_remanente := v_monto
    - coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = p_pago_id and anulado_at is null), 0)
    - coalesce((select sum(monto_imputado) from pago_imputacion_interes where pago_id = p_pago_id and anulado_at is null), 0);
  if v_remanente <= 0 then
    return;
  end if;

  -- Dos pasadas: interés y capital, en el orden del barrio.
  for v_pasada in 1..2 loop
    exit when v_remanente <= 0;
    if (v_pasada = 1) = (v_orden = 'intereses_primero_capital_antiguo') then
      for r in
        select d.id, app.interes_pendiente(d.id) as saldo
          from interes_devengado d
         where d.unidad_funcional_id = v_unidad and d.monto > 0
         order by d.hasta asc, d.created_at asc, d.id asc
      loop
        exit when v_remanente <= 0;
        continue when r.saldo <= 0;
        v_a_imputar := least(v_remanente, r.saldo);
        insert into pago_imputacion_interes (pago_id, interes_id, monto_imputado) values (p_pago_id, r.id, v_a_imputar);
        v_remanente := v_remanente - v_a_imputar;
      end loop;
    else
      for r in
        select l.id,
               l.importe_exigible - coalesce((
                 select sum(pi.monto_imputado) from pago_imputacion pi
                  where pi.liquidacion_id = l.id and pi.anulado_at is null
               ), 0) as saldo
          from liquidacion l
          join periodo_expensa pe on pe.id = l.periodo_id
         where l.unidad_funcional_id = v_unidad
           and pe.estado in ('emitida', 'distribuida')
         order by
           case when v_orden = 'intereses_primero_capital_antiguo' and coalesce(l.interes_mora, 0) > 0
                     and l.saldo_anterior_origen <> 'calculado'
                then 0 else 1 end,
           -- [0088] Por VENCIMIENTO y no por fecha de carga: la deuda anterior a la activación se
           -- carga después que su vencimiento, y es la más vieja. Lo mensual se crea en el orden
           -- en que vence, así que para un barrio sin deuda histórica el orden es el de siempre.
           -- Un mes emitido sin vencimiento cargado (los hay de antes) se ordena por su mes: no queda
           -- al final de la fila, detrás de meses más nuevos.
           coalesce(l.vencimiento, pe.primer_vencimiento, (pe.periodo || '-01')::date) asc,
           l.created_at asc,
           l.id asc
      loop
        exit when v_remanente <= 0;
        continue when r.saldo <= 0;
        v_a_imputar := least(v_remanente, r.saldo);
        insert into pago_imputacion (pago_id, liquidacion_id, monto_imputado) values (p_pago_id, r.id, v_a_imputar);
        v_remanente := v_remanente - v_a_imputar;
      end loop;
    end if;
  end loop;
end; $$;
