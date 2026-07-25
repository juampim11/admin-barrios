-- =============================================================================================
-- 0014_seguridad_periodo — tres agujeros que encontró el panel de implementación en código ya
-- mergeado (`docs/diseno/08-criterios-de-reparto.md` §T). Ninguno se nota hoy; los tres se vuelven
-- explotables apenas exista una tabla más colgando del período.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. `app.periodo_editable` fallaba ABIERTO.
--
--    Si no lograba resolver el período, `v_estado` quedaba NULL, `NULL in ('emitida','distribuida')`
--    da NULL (no false), el `if` no entraba y **la escritura pasaba**. Hoy no se nota porque las tres
--    tablas que usan el trigger tienen `periodo_id` NOT NULL con FK. Con una tabla nueva cuyo
--    período se resuelva por un join, el congelamiento del período se saltearía solo.
--
--    El resto del cuerpo es idéntico al de 0005.
-- ---------------------------------------------------------------------------------------------
create or replace function app.periodo_editable() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_estado  app.estado_periodo;
  v_periodo uuid;
begin
  -- IF/ELSIF y no CASE: plpgsql prepara cada sentencia por separado, así solo se resuelven los
  -- campos de la tabla que disparó el trigger.
  if tg_table_name = 'item_liquidacion' then
    select periodo_id into v_periodo from liquidacion where id = coalesce(new.liquidacion_id, old.liquidacion_id);
  else
    v_periodo := coalesce(new.periodo_id, old.periodo_id);
  end if;

  -- FALLA CERRADO: si no se puede determinar el período, se rechaza. Nunca se deja pasar por no
  -- saber. Única excepción: un DELETE en cascada, donde el padre ya desapareció (borrar un período
  -- arrastra sus liquidaciones, y esas arrastran sus líneas: para cuando la línea llega acá, su
  -- liquidación ya no existe). Ahí el borrado es legítimo y el estado del período ya se verificó
  -- cuando se borró el período mismo.

  if v_periodo is null then
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'no se pudo determinar el período de la fila: se rechaza por seguridad';
  end if;

  select estado into v_estado from periodo_expensa where id = v_periodo;

  if v_estado is null then
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'el período % no existe: se rechaza por seguridad', v_periodo;
  end if;

  if v_estado in ('emitida', 'distribuida') then
    raise exception 'el período ya está % : no se edita (se corrige en el período siguiente)', v_estado;
  end if;

  return coalesce(new, old);
end; $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. Un período podía NACER emitido.
--
--    `trg_periodo_transicion` es `before update`: nada controlaba el INSERT. Un período insertado
--    directamente con `estado = 'emitida'` es un contenedor donde `app.validar_emision` **no corrió
--    nunca** — o sea, un período que nadie verificó que cuadre, indistinguible de uno emitido en regla.
-- ---------------------------------------------------------------------------------------------
create or replace function app.periodo_nace_en_borrador() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if new.estado <> 'borrador' then
    raise exception 'un período nace en borrador (llegó en %): emitir es una transición, no un estado inicial', new.estado;
  end if;
  -- Las marcas de emisión y distribución las pone la base al transicionar, no quien inserta.
  new.emitida_at := null;
  new.emitida_por := null;
  new.distribuida_at := null;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_periodo_nace_en_borrador before insert on periodo_expensa
  for each row execute function app.periodo_nace_en_borrador();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. La firma de quién emitió era autoatribuible.
--
--    `emitirPeriodo()` escribía `emitida_por` desde un **argumento de la aplicación**: nada verificaba
--    que fuera el usuario de la sesión. Cualquiera podía firmar con el nombre de otro. Ahora la
--    identidad la pone la base — es el mismo criterio con el que ya se marca `sin_respaldo_asamblea`.
--
--    El resto de la función es idéntico al de 0007.
-- ---------------------------------------------------------------------------------------------
create or replace function app.periodo_transicion() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare v_usuario uuid;
begin
  if new.estado = old.estado then
    return new;
  end if;

  -- Camino previsto: borrador ⇄ revisada → emitida → distribuida. Después de emitir no se vuelve.
  if not (
       (old.estado = 'borrador'  and new.estado in ('revisada', 'emitida'))
    or (old.estado = 'revisada'  and new.estado in ('borrador', 'emitida'))
    or (old.estado = 'emitida'   and new.estado = 'distribuida')
  ) then
    raise exception 'transición de estado inválida: % → %', old.estado, new.estado;
  end if;

  if new.estado = 'emitida' then
    perform app.validar_emision(new.id);

    -- La firma sale de la sesión, no del cuerpo del request.
    v_usuario := app.current_user_id();
    if v_usuario is null then
      raise exception 'no hay usuario en la sesión: emitir un período requiere identidad';
    end if;

    new.emitida_at := now();
    new.emitida_por := v_usuario;
    new.total_gastos := (select coalesce(sum(monto), 0) from gasto_periodo where periodo_id = new.id);
  elsif new.estado = 'distribuida' then
    new.distribuida_at := now();
  end if;

  return new;
end; $$;
