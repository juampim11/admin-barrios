-- 0074 — La deuda de un barrio en una sola consulta (ensayo de T2, 2026-11-05; `dba-data`).
--
-- `deudaALaFecha` llamaba a `app.capital_pendiente(l.id)` una vez por cada liquidación emitida del
-- barrio (920 en Los Aromos) y a `app.interes_pendiente(d.id)` una vez por cada interés. Cada llamada
-- es una consulta aparte, con su propia evaluación de las policies de RLS (`readable_tenant_ids()`),
-- y eso se llevaba el 65 % de la vista previa y de la emisión: unos 2,8 s por cálculo, y se calcula
-- dos veces en cada una.
--
-- Estas dos funciones devuelven lo mismo **para todo el barrio de una vez**, con las MISMAS
-- expresiones que las escalares (`0062`/`0064`/`0068`), en un join lateral: la RLS se evalúa una vez
-- por consulta y no una vez por fila. Las escalares no cambian (las siguen usando los triggers, que
-- miran una sola liquidación). Un test compara las dos, fila por fila, con pagos y condonaciones anuladas y vivas
-- (`packages/data/test/circuito-deuda.test.ts`, «la deuda por barrio»).
--
-- **`security invoker`, como las escalares desde `0064` (BL-033):** quien consulta solo ve las
-- liquidaciones y los pagos de sus barrios. Pedir otro barrio devuelve cero filas, no un oráculo. El
-- filtro `barrio_id = p_barrio` es para usar el índice, no para aislar: aísla la RLS.
--
-- Solo DDL: dos funciones nuevas.

create or replace function app.capitales_pendientes(p_barrio uuid)
  returns table (liquidacion_id uuid, pendiente numeric)
  language sql stable security invoker set search_path = public, app
as $$
  select l.id,
         l.importe_exigible - coalesce(i.imputado, 0)
    from liquidacion l
    left join lateral (
      select sum(pi.monto_imputado) as imputado
        from pago_imputacion pi
       where pi.liquidacion_id = l.id and pi.anulado_at is null
    ) i on true
   where l.barrio_id = p_barrio
$$;
--> statement-breakpoint

create or replace function app.intereses_pendientes(p_barrio uuid)
  returns table (interes_id uuid, unidad_funcional_id uuid, pendiente numeric)
  language sql stable security invoker set search_path = public, app
as $$
  select d.id, d.unidad_funcional_id,
         d.monto - coalesce(pii.imputado, 0) - coalesce(c.condonado, 0)
    from interes_devengado d
    left join lateral (
      select sum(x.monto_imputado) as imputado
        from pago_imputacion_interes x
        join pago p on p.id = x.pago_id
       where x.interes_id = d.id and x.anulado_at is null and p.anulado_at is null
    ) pii on true
    left join lateral (
      select sum(k.monto) as condonado
        from interes_condonacion k
       where k.interes_id = d.id and k.anulado_at is null
    ) c on true
   where d.barrio_id = p_barrio
$$;
--> statement-breakpoint

revoke all on function app.capitales_pendientes(uuid), app.intereses_pendientes(uuid) from public;
--> statement-breakpoint
grant execute on function app.capitales_pendientes(uuid), app.intereses_pendientes(uuid) to app_request, app_job;
