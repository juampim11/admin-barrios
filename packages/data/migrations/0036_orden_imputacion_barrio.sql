-- =============================================================================================
-- 0036_orden_imputacion_barrio — el criterio con el que un barrio imputa pagos automáticamente.
--
-- `orden_imputacion` nace NULLABLE y SIN DEFAULT, a propósito: un barrio sin este dato configurado
-- sigue pudiendo registrar pagos con total normalidad (`pago` no depende de esto para nada) y solo
-- pierde la imputación AUTOMÁTICA — la manual, línea por línea (`imputarPago`, `0035`), no la
-- necesita. `app.resolver_imputacion()` falla cerrado si está en `NULL`: no hay un criterio "neutro"
-- que asumir, y elegir uno por default sería tomar una decisión de cobranza que el barrio no tomó.
--
-- SOBRE LOS TRES CRITERIOS Y LO QUE `liquidacion` PUEDE EXPRESAR HOY (decisión de `backend-dev`,
-- para revisar con `administrador-consorcios`):
--
-- `pago_imputacion` apunta a `liquidacion`, no a `item_liquidacion` (decisión del panel): una
-- liquidación es UN monto (`total`), no un desglose de capital vs. interés dentro de ella. Con eso,
-- la única palanca real que estos tres criterios tienen para diferenciarse es EN QUÉ ORDEN se eligen
-- las liquidaciones pendientes de la unidad, no CÓMO se reparte un pago dentro de una sola:
--
--   · `intereses_primero_capital_antiguo` — las liquidaciones que todavía arrastran interés de mora
--     (`interes_mora > 0`) se cobran ANTES que las que no, porque el interés sigue devengando; dentro
--     de cada grupo, la más antigua primero.
--   · `capital_primero` y `fifo_estricto` — con el modelo actual, los dos se resuelven igual: la
--     liquidación más antigua primero, sin distinguir si arrastra interés. La diferencia conceptual
--     entre "capital primero" (ignorar el interés al elegir) y "estrictamente por antigüedad" solo
--     se separaría de `intereses_primero_capital_antiguo` con un desglose de interés vs. capital DEL
--     QUE HOY NO HAY DATO por liquidación — y no se inventa acá.
--
-- Desempate SIEMPRE por `id`: determinístico y estable, para que dos resoluciones concurrentes que
-- toquen el mismo conjunto de liquidaciones no las recorran en orden distinto (eso sería la puerta a
-- un deadlock entre ellas — ver el comentario de locks más abajo).
-- =============================================================================================

alter table barrio add column orden_imputacion text;
--> statement-breakpoint

alter table barrio add constraint barrio_orden_imputacion_chk check (
  orden_imputacion is null or orden_imputacion in
    ('intereses_primero_capital_antiguo', 'capital_primero', 'fifo_estricto')
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- `app.resolver_imputacion(p_pago_id)` — imputa el remanente de un pago contra las liquidaciones
-- pendientes de su unidad, según el criterio del barrio.
--
-- **El `insert` de `pago` NUNCA depende de esta función.** Un pago se registra igual aunque el
-- barrio no tenga `orden_imputacion` configurado; lo único que falla es la resolución automática. En
-- `packages/data/src/servicios/pagos.ts` y `cobros.ts` son dos pasos separados y dos servicios
-- distintos — `registrarPago()` nunca llama a `resolverImputacionAutomatica()`.
--
-- **Locks: el orden es pago primero, después cada liquidación — igual que 0035, y por el mismo
-- motivo (evitar deadlock entre escritores que tomen los mismos locks en órdenes distintos).** Acá
-- se toma el lock del `pago` una sola vez, al principio. El de cada `liquidacion` NO se toma en este
-- `select`: se deja que lo tome el propio `trigger` de `pago_imputacion` en cada `insert` del bucle
-- (0035 ya lo hace, y motor de esta función no puede leer un saldo "confiable" por más que lo
-- bloquee, porque lo único que importa es el saldo que ve el `insert` en el momento de escribir).
-- Si el saldo cambió entre que este `select` lo calculó y que el `insert` corrió, el `insert` lo
-- vuelve a calcular bajo su propio lock y rechaza si ya no entra — la función entera es una sola
-- transacción, así que un rechazo a mitad de camino no deja nada a medio imputar.
-- ---------------------------------------------------------------------------------------------
create or replace function app.resolver_imputacion(p_pago_id uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_barrio      uuid;
  v_unidad      uuid;
  v_monto       numeric(14,2);
  v_anulado     timestamptz;
  v_orden       text;
  v_ya_imputado numeric(14,2);
  v_remanente   numeric(14,2);
  v_a_imputar   numeric(14,2);
  r             record;
begin
  select barrio_id, unidad_funcional_id, monto, anulado_at into v_barrio, v_unidad, v_monto, v_anulado
    from pago where id = p_pago_id for update;

  -- Mensaje uniforme: para quien no tiene acceso al barrio del pago, inexistente y ajeno se ven igual.
  if v_barrio is null or not app.has_role_on(v_barrio,
      array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) then
    raise exception 'el pago no existe o no es de este barrio';
  end if;
  if v_anulado is not null then
    raise exception 'ese pago está anulado: no se le puede imputar nada';
  end if;

  select orden_imputacion into v_orden from barrio where barrio_id = v_barrio;
  if v_orden is null then
    raise exception 'el barrio no tiene orden de imputación configurado: cargalo antes de imputar este pago';
  end if;

  select coalesce(sum(monto_imputado), 0) into v_ya_imputado
    from pago_imputacion where pago_id = p_pago_id and anulado_at is null;
  v_remanente := v_monto - v_ya_imputado;
  if v_remanente <= 0 then
    return; -- nada pendiente de imputar: no es un error, es el caso normal de un pago ya cubierto.
  end if;

  -- Solo liquidaciones de un período YA EMITIDO: una de un período todavía en borrador puede
  -- cambiar o desaparecer al regenerar, y no es deuda exigible todavía — mismo filtro que
  -- `app.v_estado_cuenta_uf` (0037).
  for r in
    select l.id,
           l.total - coalesce((
             select sum(pi.monto_imputado) from pago_imputacion pi
              where pi.liquidacion_id = l.id and pi.anulado_at is null
           ), 0) as saldo,
           l.interes_mora, l.created_at
      from liquidacion l
      join periodo_expensa pe on pe.id = l.periodo_id
     where l.unidad_funcional_id = v_unidad
       and pe.estado in ('emitida', 'distribuida')
     order by
       -- Solo `intereses_primero_capital_antiguo` distingue por interés (ver el comentario de
       -- arriba); los otros dos criterios caen en el mismo orden cronológico.
       case when v_orden = 'intereses_primero_capital_antiguo' and coalesce(l.interes_mora, 0) > 0
            then 0 else 1 end,
       l.created_at asc,
       l.id asc -- desempate estable y determinístico
  loop
    exit when v_remanente <= 0;
    if r.saldo <= 0 then
      continue; -- ya está totalmente cubierta: no hay nada que imputarle
    end if;
    v_a_imputar := least(v_remanente, r.saldo);
    insert into pago_imputacion (pago_id, liquidacion_id, monto_imputado)
      values (p_pago_id, r.id, v_a_imputar);
    v_remanente := v_remanente - v_a_imputar;
  end loop;
end; $$;--> statement-breakpoint

alter function app.resolver_imputacion(uuid) owner to app_job;
--> statement-breakpoint

revoke execute on function app.resolver_imputacion(uuid) from public;
--> statement-breakpoint
grant execute on function app.resolver_imputacion(uuid) to app_request, app_job;
