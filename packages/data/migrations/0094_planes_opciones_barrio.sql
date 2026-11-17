-- 0094 — Planes de pago, P2a-1: dos opciones por barrio (solo estructura).
--
--   · `financia_mora` (false por defecto): si el interés de financiación del sistema francés corre
--     también sobre la mora que entra al plan. Con false, corre solo sobre el capital y la mora se
--     reparte en partes iguales entre las cuotas, sin interés (el anticipo la cubre primero). Con true,
--     el comportamiento de P1: se financia capital + mora y la mora va de la primera cuota en adelante.
--     El cronograma lo arma el servicio (`@admin-barrios/shared/planes`, `cronogramaDeCatalogo`).
--   · `quita_requiere_acta` (false por defecto): si un plan con quita necesita el acta del órgano del
--     barrio para aprobarse. Con false lo aprueba la administración y quedan quién, cuándo y el motivo.
--     (La exigencia del acta al aprobar entra con la pantalla 3, P2a-2.)
--
-- `app.plan_firmar` se redefine solo en el reparto de `mora_incluida` (ver el comentario [0094]).
-- No borra datos ni pide superusuario.

alter table plan_parametro_barrio add column financia_mora boolean not null default false;
--> statement-breakpoint
alter table plan_parametro_barrio add column quita_requiere_acta boolean not null default false;
--> statement-breakpoint
comment on column plan_parametro_barrio.financia_mora is
  'Si el interés de financiación del francés corre también sobre la mora que entra al plan (false: solo sobre el capital).';
--> statement-breakpoint
comment on column plan_parametro_barrio.quita_requiere_acta is
  'Si un plan con quita necesita el acta del órgano del barrio para aprobarse (false: la aprueba la administración).';
--> statement-breakpoint
grant update (financia_mora, quita_requiere_acta) on table plan_parametro_barrio to app_request;
--> statement-breakpoint

create or replace function app.plan_firmar(p_plan uuid, p_pago uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_financia_mora boolean;
  v_quita_requiere_acta boolean;
  v_plan    plan_pago;
  v_pago    pago;
  v_capital numeric(14,2) := 0;
  v_interes numeric(14,2) := 0;
  v_perdon  numeric(14,2);
  v_qi      numeric(14,2);
  v_qc      numeric(14,2);
  v_fin     numeric(14,2);
  v_cuotas  numeric(14,2);
  r         record;
begin
  select * into v_plan from plan_pago where id = p_plan for update;
  if v_plan.id is null or not app.has_role_on(v_plan.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) then
    raise exception 'el plan no existe o no es de un barrio que administres' using errcode = '42501';
  end if;
  if v_plan.estado <> 'pendiente' then
    raise exception 'el plan ya no está pendiente: se firma una sola vez';
  end if;
  perform app.serializar_cobros_de_unidad(v_plan.unidad_funcional_id);
  select coalesce(pr.financia_mora, false), coalesce(pr.quita_requiere_acta, false) into v_financia_mora, v_quita_requiere_acta
    from (select 1) uno left join plan_parametro_barrio pr on pr.barrio_id = v_plan.barrio_id;
  perform pg_advisory_xact_lock(hashtextextended('deuda-anterior:' || v_plan.barrio_id::text, 0));

  select * into v_pago from pago where id = p_pago for update;
  if v_pago.id is null or v_pago.origen <> 'plan' or v_pago.unidad_funcional_id <> v_plan.unidad_funcional_id
     or v_pago.anulado_at is not null
     or exists (select 1 from pago_imputacion where pago_id = p_pago)
     or exists (select 1 from pago_imputacion_interes where pago_id = p_pago) then
    raise exception 'el pago de la firma no es de este plan';
  end if;
  -- La firma con fecha pasada no reescribe la historia: no puede haber pagos de la unidad posteriores.
  if exists (select 1 from pago where unidad_funcional_id = v_plan.unidad_funcional_id and anulado_at is null
                and origen <> 'plan' and fecha > v_pago.fecha) then
    raise exception 'la unidad tiene pagos posteriores a la fecha de firma';
  end if;
  if exists (select 1 from plan_cuota where plan_id = p_plan and vencimiento <= v_pago.fecha) then
    raise exception 'las cuotas vencen después de la firma: corregí el cronograma';
  end if;

  -- La deuda que entra: cada liquidación vencida a la fecha de firma, su capital y su mora pendientes
  -- (los tramos ya se cerraron a esa fecha).
  for r in
    select pl.liquidacion_id, l.unidad_funcional_id, pe.origen, pe.estado,
           coalesce(l.vencimiento, pe.primer_vencimiento) as vence,
           app.capital_pendiente(l.id) as capital,
           coalesce((select sum(app.interes_pendiente(d.id)) from interes_devengado d where d.liquidacion_id = l.id and d.monto > 0), 0) as interes,
           (select max(d.hasta) from interes_devengado d where d.liquidacion_id = l.id) as ultimo
      from plan_liquidacion pl
      join liquidacion l on l.id = pl.liquidacion_id
      join periodo_expensa pe on pe.id = l.periodo_id
     where pl.plan_id = p_plan
  loop
    if r.unidad_funcional_id <> v_plan.unidad_funcional_id or r.origen = 'plan' or r.estado not in ('emitida', 'distribuida')
       or r.vence is null or r.vence >= v_pago.fecha then
      raise exception 'al plan entran liquidaciones emitidas y vencidas de la unidad (no cuotas de otro plan)';
    end if;
    if r.capital + r.interes <= 0 then
      raise exception 'una de las liquidaciones elegidas ya no debe nada: recalculá el plan';
    end if;
    -- Los tramos de mora ya se cerraron a la fecha de firma: los cierra el servicio, con el código de
    -- siempre (`registrarTramos`) y este mismo pago, en la misma transacción. Un tramo posterior a la
    -- firma no puede existir: la base no lo acepta en el futuro ni fuera de orden (`0064`).
    if r.ultimo is not null and r.ultimo > v_pago.fecha then
      raise exception 'la deuda incluida tiene mora registrada después de la fecha de firma';
    end if;
    update plan_liquidacion set capital = r.capital, interes = r.interes where plan_id = p_plan and liquidacion_id = r.liquidacion_id;
    if r.capital > 0 then
      insert into pago_imputacion (pago_id, liquidacion_id, monto_imputado) values (p_pago, r.liquidacion_id, r.capital);
    end if;
    insert into pago_imputacion_interes (pago_id, interes_id, monto_imputado)
    select p_pago, d.id, app.interes_pendiente(d.id) from interes_devengado d
     where d.liquidacion_id = r.liquidacion_id and d.monto > 0 and app.interes_pendiente(d.id) > 0;
    v_capital := v_capital + r.capital;
    v_interes := v_interes + r.interes;
  end loop;
  if v_capital + v_interes <= 0 then
    raise exception 'el plan no tiene deuda incluida';
  end if;
  if v_capital + v_interes <> v_pago.monto then
    raise exception 'el pago de la firma (%) no es la deuda incluida (%): recalculá', v_pago.monto, v_capital + v_interes;
  end if;

  -- El cuadre, con la deuda de la firma. A medida: lo que no cubre el cronograma se perdona, primero
  -- el interés y después el capital; si lo supera, el excedente es interés de financiación pactado.
  select coalesce(sum(importe), 0), coalesce(sum(interes), 0) into v_cuotas, v_fin from plan_cuota where plan_id = p_plan;
  if v_plan.tipo = 'a_medida' then
    v_perdon := v_capital + v_interes - v_cuotas;
    v_fin := greatest(-v_perdon, 0);
    v_perdon := greatest(v_perdon, 0);
    v_qi := least(v_perdon, v_interes);
    v_qc := v_perdon - v_qi;
    -- El interés de financiación pactado se reparte con la deuda de la FIRMA (la del alta pudo cambiar):
    -- va a las primeras cuotas, y lo que sigue de cada una es amortización.
    update plan_cuota pc set interes = least(x.importe, greatest(v_fin - x.antes, 0)),
                             capital = x.importe - least(x.importe, greatest(v_fin - x.antes, 0))
      from (select id, importe, coalesce(sum(importe) over (order by numero rows between unbounded preceding and 1 preceding), 0) as antes
              from plan_cuota where plan_id = p_plan) x
     where pc.id = x.id;
  else
    v_qi := 0;
    v_qc := 0;
    if v_capital + v_interes + v_fin <> v_cuotas then
      raise exception 'la deuda cambió desde que se armó el plan: recalculá las cuotas';
    end if;
  end if;

  -- Sin interés sobre interés: la mora original que queda en el plan (la que no se perdonó) se reparte
  -- en la amortización de las cuotas, de la primera en adelante (lo pagado va primero al interés). Esa
  -- parte de cada cuota no devenga mora si la cuota queda impaga.
  -- [0094] En un plan A MEDIDA la reparte la firma, de la primera cuota en adelante. En uno del
  -- CATÁLOGO la trae el cronograma (según `financia_mora` del barrio: de la primera en adelante, o en
  -- partes iguales): la firma solo verifica que sea la mora de la deuda que entra.
  if v_plan.tipo = 'a_medida' then
    update plan_cuota pc set mora_incluida = least(x.capital, greatest(x.resto - x.antes, 0))
      from (select id, capital, v_interes - v_qi as resto,
                   coalesce(sum(capital) over (order by numero rows between unbounded preceding and 1 preceding), 0) as antes
              from plan_cuota where plan_id = p_plan) x
     where pc.id = x.id;
  elsif (select coalesce(sum(mora_incluida), 0) from plan_cuota where plan_id = p_plan) <> v_interes then
    raise exception 'la deuda cambió desde que se armó el plan: recalculá las cuotas';
  -- [0094, revisión de seguridad] Y con la forma que corresponde a la regla del barrio, no solo que sume:
  -- financiada, de la primera cuota en adelante; si no, el anticipo primero y el resto en partes iguales
  -- (la última ajusta menos centavos que la cantidad de cuotas).
  elsif v_financia_mora and exists (
          select 1 from (select mora_incluida, least(capital, greatest(v_interes - coalesce(sum(capital) over (order by numero rows between unbounded preceding and 1 preceding), 0), 0)) as esperada
                           from plan_cuota where plan_id = p_plan) x
           where x.mora_incluida <> x.esperada) then
    raise exception 'el reparto de la mora en las cuotas no es el de la regla del barrio';
  elsif not v_financia_mora and (
          exists (select 1 from plan_cuota where plan_id = p_plan and numero = 0 and mora_incluida <> least(capital, v_interes))
          or (select max(mora_incluida) - min(mora_incluida) >= count(*) from plan_cuota where plan_id = p_plan and numero > 0)) then
    raise exception 'el reparto de la mora en las cuotas no es el de la regla del barrio';
  end if;

  update plan_pago
     set estado = 'vigente', fecha_firma = v_pago.fecha, pago_firma_id = p_pago,
         deuda_capital = v_capital, deuda_interes = v_interes, total_cuotas = v_cuotas, interes_financiacion = v_fin,
         quita_interes = v_qi, quita_capital = v_qc
   where id = p_plan;

  -- La unidad sale del estudio: la gestiona el plan.
  update derivacion set retiro_motivo = 'plan_administracion', retiro_nota = 'Se firmó un plan de pagos.'
   where unidad_funcional_id = v_plan.unidad_funcional_id and retirada_at is null;

  insert into plan_evento (plan_id, barrio_id, tipo, detalle)
  values (p_plan, v_plan.barrio_id, 'firmado',
          jsonb_build_object('fecha', v_pago.fecha, 'pagoId', p_pago, 'capital', v_capital, 'interes', v_interes,
                             'totalCuotas', v_cuotas, 'interesFinanciacion', v_fin, 'quitaInteres', v_qi, 'quitaCapital', v_qc,
                             -- [0094] Las reglas del barrio con las que se firmó: quedan con el plan.
                             'financiaMora', v_financia_mora, 'quitaRequiereActa', v_quita_requiere_acta));
  perform app.plan_emitir_cuotas(v_plan.barrio_id);
end; $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- La historia de las reglas de cada barrio (revisión de seguridad): solo agregar, la escribe un
-- trigger con quién y cuándo. `quita_requiere_acta` es un control sobre la administración, que es
-- quien lo puede cambiar: si lo apaga para aprobar una quita y lo vuelve a prender, queda escrito.
-- ---------------------------------------------------------------------------------------------
create table plan_parametro_barrio_historia (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  cuotas_para_caer smallint not null,
  orden_imputacion text not null,
  financia_mora boolean not null,
  quita_requiere_acta boolean not null,
  cargado_por uuid not null,
  registrado_at timestamptz not null default clock_timestamp()
);
--> statement-breakpoint
create index idx_plan_parametro_historia_barrio on plan_parametro_barrio_historia (barrio_id, registrado_at);
--> statement-breakpoint
create or replace function app.plan_parametro_a_la_historia() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  insert into plan_parametro_barrio_historia (barrio_id, cuotas_para_caer, orden_imputacion, financia_mora, quita_requiere_acta, cargado_por)
  values (new.barrio_id, new.cuotas_para_caer, new.orden_imputacion, new.financia_mora, new.quita_requiere_acta, new.cargado_por);
  return null;
end; $$;
--> statement-breakpoint
revoke execute on function app.plan_parametro_a_la_historia() from public;
--> statement-breakpoint
-- La escribe solo el trigger, como `app_job` (BYPASSRLS): con la RLS forzada nadie más inserta.
alter function app.plan_parametro_a_la_historia() owner to app_job;
--> statement-breakpoint
grant insert on table plan_parametro_barrio_historia to app_job;
--> statement-breakpoint
create trigger trg_plan_parametro_historia after insert or update on plan_parametro_barrio
  for each row execute function app.plan_parametro_a_la_historia();
--> statement-breakpoint
create trigger trg_plan_parametro_historia_solo_agregar before update or delete on plan_parametro_barrio_historia
  for each row execute function app.plan_solo_agregar();
--> statement-breakpoint
alter table plan_parametro_barrio_historia enable row level security;
--> statement-breakpoint
alter table plan_parametro_barrio_historia force row level security;
--> statement-breakpoint
create policy plan_parametro_historia_sel on plan_parametro_barrio_historia for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
grant select on table plan_parametro_barrio_historia to app_request;

