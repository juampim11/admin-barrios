-- =============================================================================================
-- 0011_partes_iguales_reglas — qué significa cerrar una versión con base `partes_iguales`.
--
-- El valor del enum se agregó solo en `0010`: en Postgres un valor de enum nuevo **no se puede usar
-- en la misma transacción que lo agrega**, y `drizzle-kit` envuelve cada archivo. Por eso van
-- separados, y por eso este archivo sí puede referirlo como literal.
--
-- Fuente de la regla: docs/diseno/08-criterios-de-reparto.md §B.
-- =============================================================================================

-- Reemplaza `app.validar_coeficientes` (creada en 0003) agregándole la rama de partes iguales. El
-- resto del cuerpo es idéntico: es la función que impide cerrar un juego de coeficientes que no
-- cuadra, y no se le toca nada más.
create or replace function app.validar_coeficientes(p_version uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_barrio     uuid;
  v_base       app.base_coeficiente;
  v_suma       numeric(24,9);
  v_con_coef   bigint;
  v_unidades   bigint;
  v_distintos  bigint;
begin
  select barrio_id, base into v_barrio, v_base from coeficiente_version where id = p_version;
  if v_barrio is null then raise exception 'la versión de coeficientes % no existe', p_version; end if;

  select coalesce(sum(valor), 0), count(*), count(distinct valor)
    into v_suma, v_con_coef, v_distintos
    from coeficiente where version_id = p_version;

  select count(*) into v_unidades
    from unidad_funcional where barrio_id = v_barrio and baja_at is null;

  if v_unidades = 0 then
    raise exception 'el barrio no tiene unidades activas: no hay nada que prorratear';
  end if;

  -- Todas las unidades activas tienen que tener coeficiente, incluidas las BALDÍAS (art. 2077).
  if v_con_coef <> v_unidades then
    raise exception 'faltan coeficientes: % unidades activas y % coeficientes cargados', v_unidades, v_con_coef;
  end if;

  if v_base = 'parte_indivisa' then
    -- Expresado en fracción de 1 (0.0125 = 1,25%). Si no cierra exacto, no se cierra la versión.
    if v_suma <> 1 then
      raise exception 'los coeficientes no cuadran: suman % y tienen que sumar exactamente 1', v_suma;
    end if;

  elsif v_base = 'partes_iguales' then
    -- Acá el control no es la suma sino la IGUALDAD: si una unidad quedó con otro valor, el barrio
    -- cree que reparte en partes iguales y no lo está haciendo. Error silencioso y caro.
    if v_distintos <> 1 then
      raise exception 'la base es partes iguales pero hay % valores distintos de coeficiente', v_distintos;
    end if;
    if v_suma <= 0 then
      raise exception 'los coeficientes no cuadran: la suma es %', v_suma;
    end if;

  else
    -- Superficie/lote/mixto: son pesos relativos, no porcentajes; alcanza con que haya masa positiva.
    if v_suma <= 0 then
      raise exception 'los coeficientes no cuadran: la suma de los pesos es %', v_suma;
    end if;
  end if;
end; $$;
