-- =============================================================================================
-- 0102 · El saldo a favor en la boleta: lo que se aplicó al emitir y lo que queda (encargo F6
-- tramo 2, BL-056). Decisión del titular del 19/11: con «Se aplica en la boleta siguiente», el total
-- a pagar de la boleta y el cupón vienen netos del crédito aplicado; con «No se aplica solo», la
-- boleta informa cuánto tiene a favor, sin restarlo.
--
-- **Por qué una tabla y no `liquidacion.importe_cupon`.** El crédito se aplica cuando el mes ya está
-- emitido (después del control del arrastre, `0101`), y una liquidación de un mes emitido no se
-- modifica (`app.periodo_editable`, `0005`). Además `importe_cupon` es lo que `app.validar_emision`
-- verifica contra lo devengado (`solo_mes` → `importe_exigible`; si no, `total`), y el devengado no se
-- toca. Lo que cobra la boleta —el «Total a pagar», el bloque de pago y su código— lo arma la vista:
-- lo de siempre menos lo aplicado (`app.saldo_a_favor_de_boleta`).
--
-- **Qué se guarda y qué se calcula** (code-reviewer, F6 tramo 2, B1 y M1):
--   · Se guarda, al emitir y ANTES de aplicar el crédito, la foto de las cuotas del plan que cobra el
--     barrio y vencen en el mes (`cuotas`), con lo que cada una debía. Leerlas después no sirve: una
--     cuota que el crédito cubre entera, o la última del plan (que lo deja cumplido), sale de
--     `app.cuotas_del_plan_en_boleta` y la boleta cobraba de menos.
--   · Se guardan las imputaciones que dejó la emisión (capital e interés), no los importes: lo aplicado
--     se suma en vivo y sin las anuladas. Si el pago se anula después de emitir, la boleta deja de
--     restar ese crédito.
--
-- Partes:
--   1. `saldo_a_favor_boleta`: una fila por unidad y mes emitido cuando la emisión aplicó crédito o la
--      unidad sigue teniendo a favor. Solo se agrega (la escribe la emisión; nadie la edita).
--   2. `app.saldo_a_favor_de_boleta(periodo, unidad)`: lo aplicado, en vivo, y lo que la fila guardó.
--   3. `app.aplicar_saldo_a_favor_al_emitir` v2: copia ENTERA de la de `0101` §4 con los cambios
--      `[0102]`: la foto de las cuotas antes del loop, qué imputaciones nuevas dejó cada pago y, al
--      final, la fila de cada unidad.
-- Cero DML sobre datos existentes (la tabla nace vacía; los meses ya emitidos no tienen fila y su
-- boleta sale como antes).
-- Regla del repo: una migración ya aplicada NO se edita; se agrega la siguiente con prefijo mayor.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. Lo que dejó la emisión, por unidad
-- ---------------------------------------------------------------------------------------------
create table saldo_a_favor_boleta (
  periodo_id              uuid not null references periodo_expensa(id),
  unidad_funcional_id     uuid not null references unidad_funcional(id),
  barrio_id               uuid not null references barrio(barrio_id),
  -- La regla que rigió al emitir: con `manual` no se aplica nada y la boleta solo informa.
  modo                    text not null,
  -- Lo que cobra esta boleta además de la deuda: la liquidación del mes y las cuotas de `cuotas`. Con
  -- «solo el mes», solo lo imputado a estas baja el cupón (lo que fue a meses anteriores, no).
  liquidaciones_del_cobro uuid[] not null,
  -- Las cuotas del plan que cobra el barrio y vencen en el mes, como estaban ANTES de aplicar el crédito:
  -- [{planCuotaId, liquidacionId, numero, cuotas, vencimiento, importe}]. Es lo que la boleta muestra.
  cuotas                  jsonb not null,
  -- Las imputaciones que dejó esta emisión (`pago_imputacion.id` y `pago_imputacion_interes.id`).
  imputaciones            uuid[] not null,
  imputaciones_interes    uuid[] not null,
  -- El crédito que le quedó a la unidad después de emitir (lo que sobra de sus pagos vivos).
  queda                   numeric(14,2) not null,
  created_at              timestamptz not null default now(),
  primary key (periodo_id, unidad_funcional_id),
  constraint saldo_a_favor_boleta_modo_chk check (modo in ('boleta_siguiente', 'manual')),
  constraint saldo_a_favor_boleta_queda_chk check (queda >= 0),
  constraint saldo_a_favor_boleta_cuotas_chk check (jsonb_typeof(cuotas) = 'array'),
  constraint saldo_a_favor_boleta_manual_chk check (modo = 'boleta_siguiente' or (imputaciones = '{}' and imputaciones_interes = '{}'))
);
--> statement-breakpoint
comment on table saldo_a_favor_boleta is
  'El saldo a favor de cada boleta emitida (F6, 0102): las cuotas del mes antes del crédito, las imputaciones que dejó la emisión y lo que queda. La escribe app.aplicar_saldo_a_favor_al_emitir.';
--> statement-breakpoint
create index idx_saldo_a_favor_boleta_unidad on saldo_a_favor_boleta (unidad_funcional_id);
--> statement-breakpoint
create or replace function app.saldo_a_favor_boleta_solo_agregar() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  raise exception 'el saldo a favor de una boleta emitida no se edita ni se borra';
end; $$;
--> statement-breakpoint
create trigger trg_saldo_a_favor_boleta_solo_agregar before update or delete on saldo_a_favor_boleta
  for each row execute function app.saldo_a_favor_boleta_solo_agregar();
--> statement-breakpoint
alter table saldo_a_favor_boleta enable row level security;
--> statement-breakpoint
alter table saldo_a_favor_boleta force row level security;
--> statement-breakpoint
-- La lee quien lee el barrio (como la liquidación); la escribe solo la emisión (`app_job`, definer).
create policy saldo_a_favor_boleta_sel on saldo_a_favor_boleta for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
grant select on table saldo_a_favor_boleta to app_request;
--> statement-breakpoint
grant select, insert on table saldo_a_favor_boleta to app_job;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. El saldo a favor de una boleta, en vivo
--
-- `aplicado`: todo lo que el crédito cubrió al emitir y sigue vivo (sin las imputaciones anuladas).
-- `aplicado_en_cupon`: la parte que baja lo que cobra la boleta. Con «solo el mes», lo imputado a la
-- liquidación del mes y a las cuotas del mes; si no (el mes más la deuda, o sin modo de cupón), todo:
-- el cupón cobra también la deuda de antes y su interés. `aplicado_a_cuotas`: lo que fue a las cuotas.
-- Lee con los permisos de quien llama (`security invoker`): la tabla y las imputaciones tienen RLS.
-- ---------------------------------------------------------------------------------------------
create or replace function app.saldo_a_favor_de_boleta(p_periodo uuid, p_unidad uuid)
  returns table (modo text, aplicado numeric(14,2), aplicado_en_cupon numeric(14,2), aplicado_a_cuotas numeric(14,2),
                 cuotas jsonb, queda numeric(14,2))
  language sql stable security invoker set search_path = public, app, pg_temp
as $$
  select s.modo,
         (coalesce(cap.total, 0) + coalesce(itr.total, 0))::numeric(14,2),
         (case when pe.cupon_cobra = 'solo_mes' then coalesce(cap.del_cobro, 0)
               else coalesce(cap.total, 0) + coalesce(itr.total, 0) end)::numeric(14,2),
         coalesce(cap.a_cuotas, 0)::numeric(14,2),
         s.cuotas,
         s.queda
    from saldo_a_favor_boleta s
    join periodo_expensa pe on pe.id = s.periodo_id
    left join lateral (
      select sum(pi.monto_imputado) as total,
             sum(pi.monto_imputado) filter (where pi.liquidacion_id = any(s.liquidaciones_del_cobro)) as del_cobro,
             sum(pi.monto_imputado) filter (where pi.liquidacion_id in (
               select (c ->> 'liquidacionId')::uuid from jsonb_array_elements(s.cuotas) c)) as a_cuotas
        from pago_imputacion pi
       where pi.id = any(s.imputaciones) and pi.anulado_at is null
    ) cap on true
    left join lateral (
      select sum(pii.monto_imputado) as total
        from pago_imputacion_interes pii
       where pii.id = any(s.imputaciones_interes) and pii.anulado_at is null
    ) itr on true
   where s.periodo_id = p_periodo and s.unidad_funcional_id = p_unidad;
$$;
--> statement-breakpoint
revoke execute on function app.saldo_a_favor_de_boleta(uuid, uuid) from public;
--> statement-breakpoint
grant execute on function app.saldo_a_favor_de_boleta(uuid, uuid) to app_request, app_job;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. Aplicar el saldo a favor al emitir (v2): copia ENTERA de `0101` §4 con los cambios `[0102]`.
-- ---------------------------------------------------------------------------------------------
-- Al emitir un mes con `boleta_siguiente`: cada pago vivo del barrio al que le queda algo sin imputar
-- (manual, de extracto o el saldo a favor de la activación) se vuelve a imputar, con el orden del
-- barrio. Un pago de plan o de rendición no: los imputa solo su circuito, y enteros.
-- Un pago sin orden de imputación resoluble a su fecha se saltea (ver abajo).
-- Idempotente: la imputación parte de lo que le queda al pago (`v_remanente`), así que volver a
-- llamarla no imputa dos veces; y un mes emitido no se vuelve a emitir (`emitirPeriodo` lo rechaza).
-- [0102] La fila de cada unidad en `saldo_a_favor_boleta` se escribe una sola vez: si ya existe (una
-- segunda llamada), no se vuelve a escribir.
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
  v_modo   text;               -- [0102]
  v_cuotas jsonb;              -- [0102] las cuotas del mes por unidad, ANTES de aplicar el crédito
  v_antes  uuid[];             -- [0102] las imputaciones del pago antes de imputarlo
  v_antes_i uuid[];            -- [0102] ídem, de interés
  v_nuevas uuid[] := '{}';     -- [0102] las imputaciones de capital que dejó esta emisión
  v_nuevas_i uuid[] := '{}';   -- [0102] ídem, de interés
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
  -- [0102] La foto de las cuotas del plan que cobra el barrio y vencen en el mes, ANTES del crédito: una
  -- que el crédito cubra entera (o la última, que cumple el plan) deja de salir en
  -- `app.cuotas_del_plan_en_boleta`, y la boleta tiene que mostrarla igual (code-reviewer, B1).
  select coalesce(jsonb_object_agg(x.unidad, x.lista), '{}'::jsonb) into v_cuotas
    from (select c.unidad_funcional_id::text as unidad,
                 jsonb_agg(jsonb_build_object('planCuotaId', c.plan_cuota_id, 'liquidacionId', pc.liquidacion_id,
                                              'numero', c.numero, 'cuotas', c.cuotas, 'vencimiento', c.vencimiento,
                                              'importe', c.importe::numeric(14,2)::text)
                           order by c.vencimiento, c.numero) as lista
            from app.cuotas_del_plan_en_boleta(p_periodo) c join plan_cuota pc on pc.id = c.plan_cuota_id
           where c.modo_cobro = 'barrio'
           group by c.unidad_funcional_id) x;
  -- [0102] Con «No se aplica solo» no se imputa nada, pero la boleta informa lo que la unidad tiene a
  -- favor: se sigue hasta la fila de cada unidad.
  v_modo := app.saldo_a_favor_del_barrio(v_barrio, left(app.en_hora_del_barrio(now(), v_barrio), 10)::date);
  if v_modo = 'boleta_siguiente' then
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
      v_antes := array(select id from pago_imputacion where pago_id = r.id);                  -- [0102]
      v_antes_i := array(select id from pago_imputacion_interes where pago_id = r.id);        -- [0102]
      perform app.resolver_imputacion(r.id, true);
      v_nuevas := v_nuevas || array(select id from pago_imputacion where pago_id = r.id and id <> all(v_antes));             -- [0102]
      v_nuevas_i := v_nuevas_i || array(select id from pago_imputacion_interes where pago_id = r.id and id <> all(v_antes_i)); -- [0102]
      v_n := v_n + 1;
    end loop;
  end if;

  -- [0102] La fila de cada unidad con boleta en el mes a la que la emisión le aplicó crédito o que sigue
  -- con crédito.
  insert into saldo_a_favor_boleta (periodo_id, unidad_funcional_id, barrio_id, modo, liquidaciones_del_cobro, cuotas,
                                    imputaciones, imputaciones_interes, queda)
  select p_periodo, x.unidad, v_barrio, v_modo,
         array[x.liquidacion] || coalesce(array(select (c ->> 'liquidacionId')::uuid from jsonb_array_elements(x.cuotas) c), '{}'),
         x.cuotas, x.imputaciones, x.imputaciones_interes, x.queda
    from (
      select l.unidad_funcional_id as unidad, l.id as liquidacion,
             coalesce(v_cuotas -> l.unidad_funcional_id::text, '[]'::jsonb) as cuotas,
             coalesce(array(select pi.id from pago_imputacion pi join pago p on p.id = pi.pago_id
                             where pi.id = any(v_nuevas) and p.unidad_funcional_id = l.unidad_funcional_id), '{}') as imputaciones,
             coalesce(array(select pii.id from pago_imputacion_interes pii join pago p on p.id = pii.pago_id
                             where pii.id = any(v_nuevas_i) and p.unidad_funcional_id = l.unidad_funcional_id), '{}') as imputaciones_interes,
             coalesce((select sum(p.monto
                                  - coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = p.id and anulado_at is null), 0)
                                  - coalesce((select sum(monto_imputado) from pago_imputacion_interes where pago_id = p.id and anulado_at is null), 0))
                         from pago p
                        where p.unidad_funcional_id = l.unidad_funcional_id and p.anulado_at is null
                          and p.origen in ('manual', 'extracto', 'activacion')), 0) as queda
        from liquidacion l
       where l.periodo_id = p_periodo
    ) x
   where (cardinality(x.imputaciones) > 0 or cardinality(x.imputaciones_interes) > 0 or x.queda > 0)
     and not exists (select 1 from saldo_a_favor_boleta s where s.periodo_id = p_periodo and s.unidad_funcional_id = x.unidad);
  return v_n;
end; $$;
