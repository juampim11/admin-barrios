-- =============================================================================================
-- 0084_validar_emision_v6 — la emisión verifica la planilla de usos y lo que el catálogo aplica
-- solo (encargo 16b). **Solo DDL**: una función.
--
-- `app.validar_emision` se copia ENTERA de la v5 (`0081`) y lo nuevo va marcado `[0084]`:
--   · la cantidad de un renglón que vino de una planilla es la suma de sus usos;
--   · una aplicación con origen `catalogo_sola` es de un concepto que se aplica solo.
-- `create or replace` conserva el dueño (`app_job`) y los permisos.
-- =============================================================================================

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
  -- [0081]
  v_total_mes     numeric(14,2);
  v_cupon         text;
  v_bonif_modo    text;
  v_bonif_forma   text;
  v_bonif_valor   numeric;
  v_bonif_tope    numeric;
  v_mal           bigint;
begin
  select barrio_id, modelo, coeficiente_version_id, cuota_fija_version_id, cupon_cobra, bonificacion_modo,
         bonificacion_forma, bonificacion_valor, bonificacion_tope
    into v_barrio, v_modelo, v_version, v_cuota_ver, v_cupon, v_bonif_modo, v_bonif_forma, v_bonif_valor, v_bonif_tope
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
    -- [0081] La versión define un importe por unidad, o un total del mes que se reparte por coeficiente.
    select total_del_mes into v_total_mes from cuota_fija_version where id = v_cuota_ver;

    if v_total_mes is null then
      -- Importe por unidad: idéntico a la v4.
      select count(*) into v_sin_cuota
        from unidad_funcional u
       where u.barrio_id = v_barrio and u.baja_at is null
         and not exists (select 1 from cuota_fija c where c.version_id = v_cuota_ver and c.unidad_funcional_id = u.id);
      if v_sin_cuota > 0 then
        raise exception 'faltan % cuotas fijas: hay unidades activas sin importe asignado', v_sin_cuota;
      end if;
    end if;
    select coalesce(sum(g.monto), 0) into v_esperado
      from gasto_periodo g join concepto co on co.id = g.concepto_id
     where g.periodo_id = p_periodo and co.tipo = 'extraordinaria';

    if v_total_mes is null then
      -- La cuota fija cuadra contra su propia versión (idéntico a la v4).
      if (select coalesce(sum(i.monto), 0) from liquidacion l join item_liquidacion i on i.liquidacion_id = l.id
           where l.periodo_id = p_periodo and i.clase_item = 'cuota_fija')
         <> (select coalesce(sum(c.importe), 0) from cuota_fija c
              join unidad_funcional u on u.id = c.unidad_funcional_id and u.baja_at is null
             where c.version_id = v_cuota_ver) then
        raise exception 'el período no cuadra: las cuotas fijas cobradas no coinciden con la versión vigente';
      end if;
    else
      -- [0081] Por coeficiente: lo repartido es el total del mes, AL CENTAVO. Y cada unidad tiene su
      -- parte: una sola línea de cuota, con el total del mes como base (el coeficiente con que se
      -- repartió es el de su liquidación, `liquidacion.coeficiente_aplicado`).
      if (select coalesce(sum(i.monto), 0) from liquidacion l join item_liquidacion i on i.liquidacion_id = l.id
           where l.periodo_id = p_periodo and i.clase_item = 'cuota_fija')
         <> v_total_mes then
        raise exception 'el período no cuadra: lo repartido por coeficiente no es el total del mes (%)', v_total_mes;
      end if;
      select count(*) into v_mal
        from liquidacion l
       where l.periodo_id = p_periodo
         and (select count(*) from item_liquidacion i
               where i.liquidacion_id = l.id and i.clase_item = 'cuota_fija'
                 and i.base_monto = v_total_mes) <> 1;
      if v_mal > 0 then
        raise exception 'el período no cuadra: hay % unidades sin su parte del total del mes', v_mal;
      end if;
    end if;
  end if;

  if v_esperado <> v_prorrateo then
    raise exception 'el período no cuadra (modelo %): esperado % y repartido % (diferencia %)',
      v_modelo, v_esperado, v_prorrateo, v_esperado - v_prorrateo;
  end if;

  -- Tercera capa: el snapshot sigue siendo fiel al catálogo y la base es la de la liquidación.
  perform app.validar_aplicaciones(p_periodo);

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

  -- [0081] El cupón cobra lo que dice el modo del período, ni un centavo más ni uno menos. `solo_mes`:
  -- lo que la boleta suma a la deuda (`importe_exigible`); `mes_mas_deuda`: el total. Un período sin
  -- modo (calculado antes de `0080`) no tiene cupón propio y no se verifica.
  if v_cupon is not null then
    select count(*) into v_mal
      from liquidacion l
     where l.periodo_id = p_periodo
       and l.importe_cupon is distinct from (case when v_cupon = 'solo_mes' then l.importe_exigible else l.total end);
    if v_mal > 0 then
      raise exception 'el período no cuadra: hay % cupones cuyo importe no es el del modo del período (%)', v_mal, v_cupon;
    end if;
  elsif exists (select 1 from liquidacion l where l.periodo_id = p_periodo and l.importe_cupon is not null) then
    raise exception 'el período no cuadra: hay cupones con importe propio y el período no tiene modo de cupón';
  end if;

  -- [0081] La bonificación que aplica la regla del barrio existe solo si el mes bonifica solo, y es
  -- siempre el concepto de la regla: nadie la cuela a mano con ese rótulo.
  select count(*) into v_mal
    from concepto_boleta_unidad c
    join concepto_boleta cb on cb.id = c.concepto_boleta_id
   where c.periodo_id = p_periodo and c.anulado_at is null and c.origen_evaluacion = 'regla_barrio'
     and (v_bonif_modo is distinct from 'sola' or cb.regla_barrio is null);
  if v_mal > 0 then
    raise exception 'el período no cuadra: hay % bonificaciones marcadas como regla del barrio que la regla no aplicó', v_mal;
  end if;

  -- [0081] En un mes que bonifica solo, la bonificación la decide la regla y nadie más (panel
  -- `security-engineer`, 1 y 2): no se carga a mano con el concepto de la regla, no la tiene una unidad
  -- a la que la administración se la quitó, y su valor es el de «Cómo se devenga» congelado en el
  -- período —no otro que alguien haya cargado en el catálogo sin motivo ni firma—.
  if v_bonif_modo = 'sola' then
    select count(*) into v_mal
      from concepto_boleta_unidad c
      join concepto_boleta cb on cb.id = c.concepto_boleta_id
     where c.periodo_id = p_periodo and c.anulado_at is null
       and cb.regla_barrio is not null and c.origen_evaluacion <> 'regla_barrio';
    if v_mal > 0 then
      raise exception 'el período no cuadra: hay % bonificaciones por pago en término cargadas a mano en un mes que las aplica solo', v_mal;
    end if;

    select count(*) into v_mal
      from concepto_boleta_unidad c
      join concepto_boleta cb on cb.id = c.concepto_boleta_id
      join bonificacion_excepcion e on e.periodo_id = c.periodo_id and e.unidad_funcional_id = c.unidad_funcional_id
     where c.periodo_id = p_periodo and c.anulado_at is null
       and cb.regla_barrio is not null and e.tipo = 'quitar';
    if v_mal > 0 then
      raise exception 'el período no cuadra: hay % unidades con la bonificación aplicada y una excepción que se la quita', v_mal;
    end if;

    select count(*) into v_mal
      from concepto_boleta_unidad c
     where c.periodo_id = p_periodo and c.anulado_at is null and c.origen_evaluacion = 'regla_barrio'
       and ((c.metodo = 'porcentaje') is distinct from (v_bonif_forma = 'porcentaje')
            or coalesce(c.porcentaje, c.monto_fijo) is distinct from v_bonif_valor
            or c.tope is distinct from v_bonif_tope);
    if v_mal > 0 then
      raise exception 'el período no cuadra: hay % bonificaciones cuyo valor no es el de cómo se devenga este mes', v_mal;
    end if;
  end if;

  -- [0084] Lo que vino de una planilla de usos: la cantidad del renglón es la suma de sus usos, ni un
  -- uso más ni uno menos. Y un renglón de planilla sin usos no existe.
  select count(*) into v_mal
    from concepto_boleta_unidad c
   where c.periodo_id = p_periodo and c.anulado_at is null and c.origen_evaluacion = 'planilla'
     and c.cantidad is distinct from (select sum(u.cantidad) from concepto_boleta_unidad_uso u where u.aplicacion_id = c.id);
  if v_mal > 0 then
    raise exception 'el período no cuadra: hay % renglones de planilla cuya cantidad no es la suma de sus usos', v_mal;
  end if;

  -- [0084] Lo que el catálogo aplicó solo es de un concepto que se aplica solo: nadie lo carga a mano
  -- con ese rótulo.
  select count(*) into v_mal
    from concepto_boleta_unidad c
    join concepto_boleta cb on cb.id = c.concepto_boleta_id
   where c.periodo_id = p_periodo and c.anulado_at is null and c.origen_evaluacion = 'catalogo_sola'
     and cb.modo_mes is distinct from 'sola';
  if v_mal > 0 then
    raise exception 'el período no cuadra: hay % conceptos marcados como aplicados solos que el catálogo no aplica solos', v_mal;
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
