-- =============================================================================================
-- 0079_devengado_registro — las claves de «Cómo se devenga» en el registro de parámetros
-- (encargo 16, Etapa 1.3).
--
-- «Cómo se devenga» se guarda donde ya viven los parámetros de mora: `parametro_valor`, versionado
-- con `vigente_desde`, solo se agrega y cada fila lleva motivo y firma (ADR-0006). Son siete claves
-- nuevas, y difieren de las de mora en tres cosas que este archivo hace cumplir:
--
--   1. **Son del barrio, no de la administración** (`parametro_registro.solo_barrio`). De dónde sale
--      el importe o si el cupón cobra la deuda no se hereda de un estudio: cada barrio lo decide.
--   2. **No tienen valor inicial** (`valor_inicial` pasa a admitir NULL). Sin valor cargado, el
--      barrio se comporta como hasta hoy: el modelo sale de `barrio.modelo_liquidacion`, el cupón
--      cobra el mes más la deuda y la bonificación se aplica a mano. Una administración nueva NO
--      recibe filas de estas claves.
--   3. **Rigen desde el primer día de un mes, y ese mes no puede estar emitido.** La regla de mora
--      («desde hoy o una fecha futura») no sirve acá: definir el 14 de noviembre cómo se devenga
--      noviembre es la operatoria normal, mientras noviembre no se haya emitido. Lo que no se
--      puede es tocar un mes emitido, ni dejar un mes emitido en el medio.
--
-- **Sobre los `insert` de este archivo:** son siete filas nuevas en `parametro_registro`, que es el
-- catálogo de claves (el espejo de `@admin-barrios/shared/parametros-mora`, igual que hizo `0057`
-- §1). No se modifica ni se borra ninguna fila existente, y ningún barrio cambia de comportamiento:
-- sin filas en `parametro_valor` para estas claves, todo sigue como estaba.
--
-- Las funciones que cambian se copian ENTERAS de `0057` y lo nuevo va marcado `[0079]`.
-- =============================================================================================

alter table parametro_registro alter column valor_inicial drop not null;
--> statement-breakpoint
alter table parametro_registro add column solo_barrio boolean not null default false;
--> statement-breakpoint
comment on column parametro_registro.solo_barrio is
  'La clave se fija solo en un barrio, sin valor en la administración, y rige por mes: desde el día 1 '
  'de un mes que no esté emitido (0079).';
--> statement-breakpoint

insert into parametro_registro (clave, valor_inicial, requiere_respaldo, solo_barrio) values
  ('devengado.origen',    null, false, true),
  ('devengado.reparto',   null, false, true),
  ('cupon.cobra',         null, false, true),
  ('bonificacion.modo',   null, false, true),
  ('bonificacion.forma',  null, false, true),
  ('bonificacion.valor',  null, false, true),
  ('bonificacion.tope',   null, false, true);
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 1. Validación por clave. Copia de `0057` §2 + las siete claves nuevas.
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
    else
      raise exception 'valor de parámetro inválido: el parámetro % no existe', p_clave;
  end case;
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. La regla del mes, en una función: la usan el trigger de la tabla y `fijar_parametro`.
--    Un mes emitido no se toca, y tampoco se salta: si diciembre ya se emitió, un cambio que rige
--    desde noviembre le cambiaría las reglas a un mes cerrado.
-- ---------------------------------------------------------------------------------------------
create or replace function app.parametro_del_mes_valido(p_barrio uuid, p_desde date) returns void
  language plpgsql stable security definer set search_path = public, app
as $$
begin
  if p_desde is null or p_desde <> date_trunc('month', p_desde)::date then
    raise exception 'cómo se devenga rige desde el primer día de un mes';
  end if;
  if exists (
    select 1 from periodo_expensa p
     where p.barrio_id = p_barrio
       and p.estado in ('emitida', 'distribuida')
       and p.periodo >= to_char(p_desde, 'YYYY-MM')
  ) then
    raise exception 'cómo se devenga no se cambia para un mes ya emitido: elegí un mes posterior al último emitido';
  end if;
end; $$;
--> statement-breakpoint
alter function app.parametro_del_mes_valido(uuid, date) owner to app_job;
--> statement-breakpoint
revoke execute on function app.parametro_del_mes_valido(uuid, date) from public;
--> statement-breakpoint
grant execute on function app.parametro_del_mes_valido(uuid, date) to app_job;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. El trigger de la tabla. Copia de `0057` §2 + la rama de las claves del barrio.
-- ---------------------------------------------------------------------------------------------
create or replace function app.parametro_valor_antes_insert() returns trigger
  language plpgsql set search_path = public, app
as $$
declare
  v_tipo   app.tipo_tenant;
  v_padre  uuid;
  v_tipo_p app.tipo_tenant;
  v_solo_barrio boolean;   -- [0079]
begin
  select tipo, parent_id into v_tipo, v_padre from tenant_node where id = new.nodo_id;
  if v_tipo is null or v_tipo not in ('administrador', 'barrio') then
    raise exception 'un parámetro se fija en una administración o en un barrio';
  end if;
  if v_tipo = 'barrio' then
    select tipo into v_tipo_p from tenant_node where id = v_padre;
    if v_tipo_p is distinct from 'administrador' then
      raise exception 'el barrio no cuelga de una administración: no tiene de quién heredar';
    end if;
  end if;
  -- [0079] Una clave del barrio no se fija en la administración, la cargue quien la cargue.
  select r.solo_barrio into v_solo_barrio from parametro_registro r where r.clave = new.clave;
  if coalesce(v_solo_barrio, false) and v_tipo <> 'barrio' then
    raise exception 'cómo se devenga se define en cada barrio, no en la administración';
  end if;
  -- Las reglas de negocio TAMBIÉN en la tabla, no solo en `fijar_parametro` (revisión de
  -- `security-engineer`, M1): `app_job` tiene insert directo, y un job con un bug —o comprometido— no
  -- puede escribir un valor retroactivo ni sin firma. La migración y el seed corren con el dueño del
  -- esquema y cargan historia (`inicial`/`migrado`); los roles de la aplicación, nunca.
  if current_user in ('app_job', 'app_request') then
    if new.carga <> 'usuario' or new.creado_por is distinct from app.current_user_id() then
      raise exception 'un parámetro lo carga una persona con sesión: no se escribe a mano';
    end if;
    if coalesce(v_solo_barrio, false) then
      -- [0079] Por mes: desde el día 1 de un mes que no esté emitido (ni tenga uno emitido después).
      perform app.parametro_del_mes_valido(new.nodo_id, new.vigente_desde);
    elsif new.vigente_desde < current_date then
      raise exception 'un cambio de parámetro rige desde hoy o una fecha futura: nunca hacia atrás';
    end if;
  end if;
  -- Un JSON `null` es "vuelve a heredar" (SQL NULL).
  if new.valor = 'null'::jsonb then new.valor := null; end if;
  if new.valor is null and v_tipo = 'administrador' then
    raise exception 'en la administración el parámetro necesita un valor';
  end if;
  if new.valor is not null then perform app.validar_parametro(new.clave, new.valor); end if;
  return new;
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. Una administración nueva recibe SOLO las claves que tienen valor inicial. Copia de `0057` §3.
-- ---------------------------------------------------------------------------------------------
create or replace function app.tenant_node_parametros_iniciales() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  insert into parametro_valor (nodo_id, clave, valor, vigente_desde, motivo, carga)
  select new.id, r.clave, r.valor_inicial, date '2000-01-01', 'Valor inicial del producto', 'inicial'
    from parametro_registro r
   where r.valor_inicial is not null;   -- [0079] las claves del barrio no se siembran
  return new;
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 5. `app.fijar_parametro`. Copia de `0057` §5 + la rama de las claves del barrio: la fecha se
--    valida por mes y no contra hoy. Todo lo demás (quién, motivo, respaldo, candado) es igual.
-- ---------------------------------------------------------------------------------------------
create or replace function app.fijar_parametro(
  p_nodo uuid, p_clave text, p_valor jsonb, p_desde date, p_motivo text,
  p_respaldo_tipo text default null, p_respaldo_referencia text default null, p_respaldo_adjunto text default null
) returns uuid
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_tipo    app.tipo_tenant;
  v_valor   jsonb := case when p_valor = 'null'::jsonb then null else p_valor end;
  v_reg     parametro_registro;
  v_tasa    jsonb;
  v_id      uuid;
  v_motivo  text := btrim(coalesce(p_motivo, ''));
  r         record;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión';
  end if;
  select n.tipo into v_tipo from tenant_node n where n.id = p_nodo and n.deleted_at is null;
  if v_tipo is null or v_tipo not in ('administrador', 'barrio') or not app.puede_editar_parametros(p_nodo) then
    raise exception 'solo la administración cambia los parámetros de mora';
  end if;
  select * into v_reg from parametro_registro where clave = p_clave;
  if v_reg.clave is null then
    raise exception 'valor de parámetro inválido: el parámetro % no existe', p_clave;
  end if;
  if v_reg.solo_barrio then
    -- [0079] Del barrio y por mes.
    if v_tipo <> 'barrio' then
      raise exception 'cómo se devenga se define en cada barrio, no en la administración';
    end if;
    perform app.parametro_del_mes_valido(p_nodo, p_desde);
  elsif p_desde is null or p_desde < current_date then
    raise exception 'un cambio de parámetro rige desde hoy o una fecha futura: nunca hacia atrás';
  end if;
  if length(v_motivo) < 15 then
    raise exception 'el cambio de parámetro necesita un motivo de al menos 15 caracteres';
  end if;
  if v_valor is null and v_tipo = 'administrador' then
    raise exception 'en la administración el parámetro necesita un valor';
  end if;
  if v_reg.requiere_respaldo and v_valor is not null
     and (nullif(btrim(coalesce(p_respaldo_tipo, '')), '') is null or nullif(btrim(coalesce(p_respaldo_referencia, '')), '') is null) then
    raise exception 'una tasa necesita su respaldo: de qué instrumento sale y su referencia';
  end if;
  if p_respaldo_adjunto is not null and not exists (
    select 1 from subida_respaldo_solicitada s where s.storage_key = p_respaldo_adjunto and s.nodo_id = p_nodo
  ) then
    raise exception 'el adjunto del respaldo no es uno que se haya subido para este lugar';
  end if;

  perform app.candado_parametro(p_nodo, p_clave);

  -- «Cobra: Sí» sin tasa es un interés que no calcula nada y que la pantalla diría que se cobra.
  if p_clave = 'interes.cobra' and v_valor = 'true'::jsonb then
    select x.valor into v_tasa from app.parametro_resuelto_interno(p_nodo, 'interes.tasa_compensatoria', p_desde) x;
    if v_tasa is null or (v_tasa #>> '{}')::numeric <= 0 then
      raise exception 'antes de cobrar interés hay que cargar la tasa compensatoria';
    end if;
  end if;

  insert into parametro_valor (nodo_id, clave, valor, vigente_desde, motivo, carga,
                               respaldo_tipo, respaldo_referencia, respaldo_adjunto, creado_por)
  values (p_nodo, p_clave, v_valor, p_desde, v_motivo, 'usuario',
          case when v_valor is null then null else nullif(btrim(coalesce(p_respaldo_tipo, '')), '') end,
          case when v_valor is null then null else nullif(btrim(coalesce(p_respaldo_referencia, '')), '') end,
          case when v_valor is null then null else p_respaldo_adjunto end,
          v_usuario)
  returning id into v_id;

  -- Una tasa compensatoria que queda en cero (o sin valor, al volver a heredar) mientras se cobra
  -- interés es «Cobra: Sí» que no calcula nada y que la pantalla diría que se cobra (revisión de
  -- código, hallazgo 2). Se mira el nodo y, si es la administración, cada barrio que hereda de ella.
  if p_clave = 'interes.tasa_compensatoria' then
    for r in
      select n.id from tenant_node n
       where n.id = p_nodo or (v_tipo = 'administrador' and n.parent_id = p_nodo and n.tipo = 'barrio' and n.deleted_at is null)
    loop
      if (select x.valor from app.parametro_resuelto_interno(r.id, 'interes.cobra', p_desde) x) = 'true'::jsonb
         and coalesce((select (x.valor #>> '{}')::numeric from app.parametro_resuelto_interno(r.id, 'interes.tasa_compensatoria', p_desde) x), 0) <= 0
      then
        raise exception 'mientras se cobre interés, la tasa compensatoria no puede quedar en cero';
      end if;
    end loop;
  end if;

  -- "Volver al valor general" cancela también los valores propios programados para DESPUÉS: si no,
  -- el programado seguiría rigiendo desde su fecha. Se anula con su motivo (queda auditado).
  -- [0079] No para las claves del barrio: ahí NULL es «como antes de configurar» desde ese mes, y lo
  -- programado para después sigue siendo una decisión aparte.
  if v_valor is null and not v_reg.solo_barrio then
    for r in
      select x.id from parametro_valor x
       where x.nodo_id = p_nodo and x.clave = p_clave and x.vigente_desde > p_desde and x.valor is not null
         and not exists (select 1 from parametro_anulacion a where a.fila_id = x.id)
    loop
      insert into parametro_anulacion (fila_id, nodo_id, motivo, anulado_por) values (r.id, p_nodo, v_motivo, v_usuario);
    end loop;
  end if;
  return v_id;
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 6. Un cambio de «Cómo se devenga» NO se anula. Copia de `0057` §2 + la guarda `[0079]`.
--
--    La anulación de `0057` existe para sacar un cambio de mora programado que todavía no rige, y
--    mira la fecha contra HOY. Con vigencia por mes eso no alcanza: un barrio que devenga por
--    adelantado emite diciembre el 20/11 con una fila que rige desde el 01/12, y el 25/11 esa fila
--    todavía es «futura». Anularla dejaría un mes emitido sin el rastro de con qué se emitió
--    (panel `security-engineer`, 3). Para deshacer un cambio se carga otro valor desde ese mes, que
--    pasa por la regla del mes (`app.parametro_del_mes_valido`) y queda en el historial.
--    El trigger cubre también a `app.anular_parametro_programado`, que inserta en esta tabla.
-- ---------------------------------------------------------------------------------------------
create or replace function app.parametro_anulacion_antes_insert() returns trigger
  language plpgsql set search_path = public, app
as $$
declare
  v_nodo  uuid;
  v_desde date;
  v_solo_barrio boolean;   -- [0079]
begin
  select v.nodo_id, v.vigente_desde, r.solo_barrio into v_nodo, v_desde, v_solo_barrio
    from parametro_valor v join parametro_registro r on r.clave = v.clave
   where v.id = new.fila_id;
  if v_nodo is null then
    raise exception 'ese cambio programado no existe';
  end if;
  if v_solo_barrio then
    raise exception 'un cambio de cómo se devenga no se anula: se carga otro valor desde ese mes';
  end if;
  if v_desde <= current_date then
    raise exception 'ese cambio ya rige: no se anula; se fija un valor nuevo desde hoy';
  end if;
  new.nodo_id := v_nodo;
  return new;
end; $$;
