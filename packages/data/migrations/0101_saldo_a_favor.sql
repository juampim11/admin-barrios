-- =============================================================================================
-- 0101 · El saldo a favor se aplica en la boleta siguiente (encargo F6 tramo 1, BL-056). Decisión
-- del titular del 19/11.
--
-- Hasta hoy, lo que sobraba de un pago quedaba como crédito sin imputar dentro del pago y nadie lo
-- volvía a mirar: `app.resolver_imputacion` corre al registrar el pago y al reimputar un plan, y la
-- emisión no imputa cobros. Pasaba igual con un pago anterior a la emisión y con el saldo a favor de
-- la activación (`pago.origen = 'activacion'`).
--
-- Partes:
--   1. La clave nueva `saldo_a_favor.aplicacion` en el registro de parámetros, con el patrón de la
--      tasa de mora y del orden de imputación: valor general de la administración y reemplazo por
--      barrio, versionado con `vigente_desde`. Dos valores: `boleta_siguiente` (el inicial) y `manual`.
--      **Sobre el `insert`:** es una fila nueva en `parametro_registro`, el catálogo de claves (el
--      espejo de `@admin-barrios/shared/parametros-mora`, como hicieron `0057` §1 y `0079`). No se
--      modifica ni se borra ninguna fila existente. Una administración que ya existe no recibe fila:
--      sin valor cargado rige `boleta_siguiente`, el valor por defecto que decidió el titular
--      (`app.saldo_a_favor_del_barrio`).
--   2. `app.validar_parametro`: copia ENTERA de la de `0079` con la clave nueva (`[0101]`).
--   3. `app.resolver_imputacion` v6: copia ENTERA de la v5 (`0098` §4) con un argumento nuevo,
--      `p_al_emitir`, y los cambios marcados `[0101]`. La de un argumento queda como estaba para quien
--      la llama (la registración del pago, la reimputación de un plan): llama a la nueva con `false`.
--   4. `app.aplicar_saldo_a_favor_al_emitir(periodo)`: la llama `emitirPeriodo` después de que la base
--      emitió el mes (y con él las cuotas de los planes, `app.plan_emitir_cuotas`, en el trigger de la
--      transición) y después del control del arrastre. Si corriera antes, ese control vería la deuda
--      cambiada y rechazaría la emisión.
-- Lo que NO cambia: el orden de capital del barrio, la pasada de interés (`imputacion.orden`), la
-- cuota que cobra el estudio (sigue sin imputarse con un pago común), el cupón y el devengado (la
-- emisión no toca ninguna columna de la liquidación: solo agrega imputaciones).
-- Cero DML sobre datos existentes.
-- Regla del repo: una migración ya aplicada NO se edita; se agrega la siguiente con prefijo mayor.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. La clave en el registro
-- ---------------------------------------------------------------------------------------------
insert into parametro_registro (clave, valor_inicial, requiere_respaldo) values
  ('saldo_a_favor.aplicacion', '"boleta_siguiente"', false);
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. Validación por clave. Copia ENTERA de `0079` §1 + la clave nueva.
-- ---------------------------------------------------------------------------------------------
create or replace function app.validar_parametro(p_clave text, p_valor jsonb) returns void
  language plpgsql immutable set search_path = public, app
as $$
begin
  case p_clave
    when 'interes.cobra' then
      if jsonb_typeof(p_valor) <> 'boolean' then
        raise exception 'valor de parámetro inválido: «Cobra interés» es sí o no';
      end if;
    when 'interes.tasa_compensatoria', 'interes.tasa_punitoria' then
      if jsonb_typeof(p_valor) <> 'string' or (p_valor #>> '{}') !~ '^(0(\.[0-9]{1,6})?|1(\.0{1,6})?)$' then
        raise exception 'valor de parámetro inválido: la tasa es una fracción entre 0 y 1, con hasta seis decimales';
      end if;
    when 'interes.gracia_dias' then
      if jsonb_typeof(p_valor) <> 'number' or (p_valor #>> '{}') !~ '^[0-9]{1,3}$' or (p_valor #>> '{}')::int > 365 then
        raise exception 'valor de parámetro inválido: los días de gracia son un entero entre 0 y 365';
      end if;
    when 'interes.forma_gracia' then
      if p_valor not in ('"corre_inicio"'::jsonb, '"escalon"'::jsonb) then
        raise exception 'valor de parámetro inválido: la forma de la gracia es «corre el inicio» o «escalón»';
      end if;
    when 'interes.tolerancia' then
      if jsonb_typeof(p_valor) <> 'string' or (p_valor #>> '{}') !~ '^[0-9]{1,12}\.[0-9]{2}$' then
        raise exception 'valor de parámetro inválido: la tolerancia es un importe en pesos, con dos decimales';
      end if;
    when 'imputacion.orden' then
      if p_valor not in ('"intereses_primero_capital_antiguo"'::jsonb, '"capital_primero"'::jsonb) then
        raise exception 'valor de parámetro inválido: el orden de imputación es «intereses primero» o «capital primero»';
      end if;
    -- [0079] «Cómo se devenga».
    when 'devengado.origen' then
      if p_valor not in ('"administracion"'::jsonb, '"gastos"'::jsonb) then
        raise exception 'valor de parámetro inválido: el importe del mes lo define la administración o sale de los gastos';
      end if;
    when 'devengado.reparto' then
      if p_valor not in ('"igual"'::jsonb, '"coeficiente"'::jsonb) then
        raise exception 'valor de parámetro inválido: el reparto es igual para todas o por coeficiente';
      end if;
    when 'cupon.cobra' then
      if p_valor not in ('"solo_mes"'::jsonb, '"mes_mas_deuda"'::jsonb) then
        raise exception 'valor de parámetro inválido: el cupón cobra solo el mes o el mes más la deuda';
      end if;
    when 'bonificacion.modo' then
      if p_valor not in ('"sola"'::jsonb, '"a_mano"'::jsonb, '"no"'::jsonb) then
        raise exception 'valor de parámetro inválido: la bonificación se aplica sola, a mano o no se aplica';
      end if;
    when 'bonificacion.forma' then
      if p_valor not in ('"porcentaje"'::jsonb, '"importe"'::jsonb) then
        raise exception 'valor de parámetro inválido: la bonificación es un porcentaje o un importe';
      end if;
    when 'bonificacion.valor' then
      -- Un porcentaje (7.5 = 7,5 %, la unidad de `concepto_boleta_valor.porcentaje`) o un importe en
      -- pesos, según `bonificacion.forma`. Mayor que cero: una bonificación de cero es «no bonifica».
      if jsonb_typeof(p_valor) <> 'string' or (p_valor #>> '{}') !~ '^[0-9]{1,12}(\.[0-9]{1,6})?$'
         or (p_valor #>> '{}')::numeric <= 0 then
        raise exception 'valor de parámetro inválido: el valor de la bonificación es un número mayor que cero';
      end if;
    when 'bonificacion.tope' then
      if jsonb_typeof(p_valor) <> 'string' or (p_valor #>> '{}') !~ '^[0-9]{1,12}\.[0-9]{2}$'
         or (p_valor #>> '{}')::numeric <= 0 then
        raise exception 'valor de parámetro inválido: el tope de la bonificación es un importe en pesos mayor que cero';
      end if;
    -- [0101] Cómo se aplica el saldo a favor.
    when 'saldo_a_favor.aplicacion' then
      if p_valor not in ('"boleta_siguiente"'::jsonb, '"manual"'::jsonb) then
        raise exception 'valor de parámetro inválido: el saldo a favor se aplica en la boleta siguiente o no se aplica solo';
      end if;
    else
      raise exception 'valor de parámetro inválido: el parámetro % no existe', p_clave;
  end case;
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. La imputación automática (v6): copia ENTERA de la v5 (`0098` §4), con `p_al_emitir` y los
--    cambios marcados `[0101]`.
-- ---------------------------------------------------------------------------------------------
create or replace function app.resolver_imputacion(p_pago_id uuid, p_al_emitir boolean) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_barrio      uuid;
  v_unidad      uuid;
  v_monto       numeric(14,2);
  v_fecha       date;
  v_anulado     timestamptz;
  v_orden       text;
  v_plan_orden  text; -- [0093]
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
  -- [0093] El pago de un plan lo imputa solo su plan (la firma o la caída), con el monto que calculan.
  if exists (select 1 from pago where id = p_pago_id and origen = 'plan') then
    raise exception 'el pago de un plan lo imputa solo su plan';
  end if;

  select x.valor #>> '{}' into v_orden
    from app.parametro_resuelto_interno(v_barrio, 'imputacion.orden', v_fecha) x;
  if v_orden is null then
    raise exception 'el barrio no tiene orden de imputación configurado: cargalo antes de imputar este pago';
  end if;
  -- [0098] El del barrio; si no tiene (NULL o sin fila), el de su administración; si tampoco, la más vieja.
  v_plan_orden := app.orden_plan_del_barrio(v_barrio);

  v_remanente := v_monto
    - coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = p_pago_id and anulado_at is null), 0)
    - coalesce((select sum(monto_imputado) from pago_imputacion_interes where pago_id = p_pago_id and anulado_at is null), 0);
  if v_remanente <= 0 then
    return;
  end if;

  -- [0098] «A elección de quien registra»: el que eligió al cargar el pago. Si no eligió nadie (entró
  -- solo: extracto, importación), la más vieja primero, y el pago queda «para revisar» — solo si es de
  -- extracto o manual (no la reimputación de una rendición ni un saldo de activación) y si la elección
  -- importaba: la unidad debía a la vez una cuota del plan imputable y una expensa (code-reviewer, m1).
  -- [0101] Al emitir el mes (el saldo a favor que se aplica en la boleta siguiente) nadie elige: la más
  -- vieja primero y «para revisar», como un pago de extracto, aunque quien registró el pago hubiera
  -- elegido otro orden para lo que se debía entonces. La marca, con la misma condición: la unidad debe
  -- a la vez una cuota del plan imputable y una expensa.
  if v_plan_orden = 'a_eleccion' then
    v_plan_orden := case when p_al_emitir then null else (select orden_plan_elegido from pago where id = p_pago_id) end;
    if v_plan_orden is null then
      v_plan_orden := 'mas_vieja_primero';
      if (p_al_emitir or (select origen from pago where id = p_pago_id) in ('extracto', 'manual'))
         and exists (select 1 from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
                      where l.unidad_funcional_id = v_unidad and pe.estado in ('emitida', 'distribuida')
                        and pe.origen = 'plan' and not app.es_cuota_del_estudio(l.id)
                        and app.saldo_de_liquidacion(l.id) > 0)
         and exists (select 1 from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
                      where l.unidad_funcional_id = v_unidad and pe.estado in ('emitida', 'distribuida')
                        and pe.origen <> 'plan' and app.saldo_de_liquidacion(l.id) > 0) then
        update pago set imputacion_para_revisar = true where id = p_pago_id and not imputacion_para_revisar;
      end if;
    end if;
  end if;

  for v_pasada in 1..2 loop
    exit when v_remanente <= 0;
    if (v_pasada = 1) = (v_orden = 'intereses_primero_capital_antiguo') then
      for r in
        select d.id, app.interes_pendiente(d.id) as saldo
          from interes_devengado d
         where d.unidad_funcional_id = v_unidad and d.monto > 0
           -- [0097] El interés de una cuota que cobra el estudio no es del barrio.
           and not app.es_cuota_del_estudio(d.liquidacion_id)
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
           -- [0097] Una cuota que cobra el estudio solo se imputa por la rendición, nunca con un pago
           -- común al barrio, aunque el orden sea «cuota primero».
           and not (pe.origen = 'plan' and app.es_cuota_del_estudio(l.id))
         order by
           case when v_orden = 'intereses_primero_capital_antiguo' and coalesce(l.interes_mora, 0) > 0
                     and l.saldo_anterior_origen <> 'calculado'
                then 0 else 1 end,
           -- [0093] La cuota del plan, antes o después del resto según el barrio. [0098] Con «la más
           -- vieja primero», cuotas y expensas van juntas (el mismo grupo) y las ordena el vencimiento.
           case when pe.origen = 'plan' then (case v_plan_orden when 'cuota_primero' then 0 when 'expensa_primero' then 2 else 1 end) else 1 end,
           coalesce(l.vencimiento, pe.primer_vencimiento, (pe.periodo || '-01')::date) asc,
           -- [0098] A igual vencimiento, la cuota primero. Con «cuota primero» y «expensa primero» no
           -- cambia nada: la clave de arriba ya separó las cuotas de las expensas.
           case when pe.origen = 'plan' then 0 else 1 end,
           pe.periodo asc,
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
--> statement-breakpoint
-- La de un argumento, como la llaman todos hasta hoy (registrar un pago, reimputar un plan): igual que
-- la v5. Conserva su dueño (`app_job`) y sus permisos: `create or replace` no los toca.
create or replace function app.resolver_imputacion(p_pago_id uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
begin
  perform app.resolver_imputacion(p_pago_id, false);
end; $$;
--> statement-breakpoint
revoke execute on function app.resolver_imputacion(uuid, boolean) from public;
--> statement-breakpoint
-- Dueña `app_job` (BYPASSRLS), como la v5. Solo la llaman la de un argumento y la emisión, que son
-- `security definer` de `app_job`: `app_request` no la ejecuta directo.
alter function app.resolver_imputacion(uuid, boolean) owner to app_job;
--> statement-breakpoint
grant execute on function app.resolver_imputacion(uuid, boolean) to app_job;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. Aplicar el saldo a favor al emitir el mes
-- ---------------------------------------------------------------------------------------------
-- Cómo se aplica en un barrio a una fecha: el suyo; si no tiene, el de su administración; si tampoco
-- (una administración anterior a esta migración), `boleta_siguiente`, el valor por defecto.
create or replace function app.saldo_a_favor_del_barrio(p_barrio uuid, p_fecha date) returns text
  language sql stable security definer set search_path = public, app, pg_temp
as $$
  select coalesce(
    (select x.valor #>> '{}' from app.parametro_resuelto_interno(p_barrio, 'saldo_a_favor.aplicacion', p_fecha) x),
    'boleta_siguiente');
$$;
--> statement-breakpoint
revoke execute on function app.saldo_a_favor_del_barrio(uuid, date) from public;
--> statement-breakpoint
alter function app.saldo_a_favor_del_barrio(uuid, date) owner to app_job;
--> statement-breakpoint
grant execute on function app.saldo_a_favor_del_barrio(uuid, date) to app_job;
--> statement-breakpoint

-- Al emitir un mes con `boleta_siguiente`: cada pago vivo del barrio al que le queda algo sin imputar
-- (manual, de extracto o el saldo a favor de la activación) se vuelve a imputar, con el orden del
-- barrio. Un pago de plan o de rendición no: los imputa solo su circuito, y enteros.
--
-- Un pago sin orden de imputación resoluble a su fecha se saltea (ver abajo).
-- Idempotente: la imputación parte de lo que le queda al pago (`v_remanente`), así que volver a
-- llamarla no imputa dos veces; y un mes emitido no se vuelve a emitir (`emitirPeriodo` lo rechaza).
-- La regla se lee a la fecha de hoy en el barrio, como la lee la pantalla.
create or replace function app.aplicar_saldo_a_favor_al_emitir(p_periodo uuid) returns integer
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
declare
  v_barrio uuid;
  v_origen text;
  v_estado text;
  v_n      integer := 0;
  r        record;
begin
  select barrio_id, origen::text, estado::text into v_barrio, v_origen, v_estado
    from periodo_expensa where id = p_periodo;
  if v_barrio is null or not app.has_role_on(v_barrio,
      array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) then
    raise exception 'el período no existe o no es de este barrio';
  end if;
  if v_origen <> 'mensual' or v_estado not in ('emitida', 'distribuida') then
    raise exception 'el saldo a favor se aplica al emitir un mes';
  end if;
  if app.saldo_a_favor_del_barrio(v_barrio, left(app.en_hora_del_barrio(now(), v_barrio), 10)::date) <> 'boleta_siguiente' then
    return 0;
  end if;
  for r in
    select p.id, p.unidad_funcional_id
      from pago p
     where p.barrio_id = v_barrio
       and p.anulado_at is null
       and p.origen in ('manual', 'extracto', 'activacion')
       -- Un pago sin orden de imputación a su fecha (una administración migrada que todavía no lo fijó,
       -- `0057` §7) se imputa a mano: queda como estaba. Si entrara, la imputación lanzaría y la
       -- emisión entera volvería atrás (code-reviewer, M1).
       and exists (select 1 from app.parametro_resuelto_interno(v_barrio, 'imputacion.orden', p.fecha) x where x.valor is not null)
       and p.monto
           - coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = p.id and anulado_at is null), 0)
           - coalesce((select sum(monto_imputado) from pago_imputacion_interes where pago_id = p.id and anulado_at is null), 0) > 0
     order by p.unidad_funcional_id, p.fecha, p.created_at, p.id
  loop
    -- El mismo candado que registrar un pago: dos imputaciones de la misma unidad no se cruzan.
    perform app.serializar_cobros_de_unidad(r.unidad_funcional_id);
    perform app.resolver_imputacion(r.id, true);
    v_n := v_n + 1;
  end loop;
  return v_n;
end; $$;
--> statement-breakpoint
revoke execute on function app.aplicar_saldo_a_favor_al_emitir(uuid) from public;
--> statement-breakpoint
alter function app.aplicar_saldo_a_favor_al_emitir(uuid) owner to app_job;
--> statement-breakpoint
grant execute on function app.aplicar_saldo_a_favor_al_emitir(uuid) to app_request, app_job;
