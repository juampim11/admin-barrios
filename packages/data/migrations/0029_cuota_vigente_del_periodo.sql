-- =============================================================================================
-- 0029_cuota_vigente_del_periodo — qué valor de expensa le corresponde a un período, en un
-- solo lugar
--
-- ⚠ EL DEFECTO QUE ESTO CIERRA, MEDIDO EN PANTALLA EL 2026-08-04
--
-- El barrio piloto tenía el período 08/2026 **en borrador** y ya generado una vez, así que
-- `periodo_expensa.cuota_fija_version_id` había quedado apuntando a la versión de junio ($382.000).
-- Se definió el aumento del 3,25 % con vigencia desde 08/2026 ($394.400) y:
--
--   * el resumen del período **siguió mostrando $382.000 × 510**, y
--   * volver a generar el borrador **tampoco aplicó el valor nuevo**, porque el cálculo respetaba la
--     versión ya fijada en la fila.
--
-- Sin error, sin aviso, y con todos los controles cuadrando — contra la versión equivocada.
--
-- EL PRINCIPIO QUE SE VIOLABA
--
-- **Un borrador es derivado y regenerable.** Es la regla que la propia pantalla de revisión enuncia:
-- *"volver a generarlo borra las liquidaciones que están y las vuelve a calcular con los gastos y
-- los cargos de ahora"*. El valor de la expensa no era "de ahora": era el de la corrida anterior.
-- Congelar tiene sentido **al emitir**, que es cuando el número se le comunicó a alguien; antes, no.
--
-- POR QUÉ VIVE EN LA BASE Y NO EN TYPESCRIPT
--
-- La misma pregunta la hacen dos lugares —el cálculo (`generarLiquidaciones`) y la lectura del
-- resumen (`detallePeriodo`)— y ya habían divergido una vez: uno tomaba "la versión abierta" y el
-- otro "la fijada en el período". Dos respuestas distintas a la misma pregunta sobre dinero es
-- exactamente la clase de diferencia que se descubre comparando dos boletas. Acá hay **una**.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- La versión de valor fijo que rige para un período.
--
-- La vigente el **primer día del mes que se liquida**, no la que esté abierta hoy: definir en agosto
-- el valor que rige desde septiembre no puede cambiar lo que se cobra en agosto. Mismo criterio con
-- el que un cargo congela el precio del catálogo a la fecha del hecho.
-- ---------------------------------------------------------------------------------------------
create or replace function app.cuota_fija_version_vigente(p_barrio uuid, p_periodo text)
  returns uuid
  language sql stable security definer set search_path = public, app
as $$
  select v.id
    from cuota_fija_version v
   where v.barrio_id = p_barrio
     and v.vigente_desde <= (p_periodo || '-01')::date
     and (v.vigente_hasta is null or v.vigente_hasta > (p_periodo || '-01')::date)
   order by v.vigente_desde desc
   limit 1
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- La que le corresponde **a este período**, que es la de arriba salvo que ya se haya emitido.
--
-- Un período emitido conserva la suya y no se recalcula nunca: el número ya está en una boleta que
-- alguien recibió, y cambiarlo hacia atrás sería reescribir lo que se le cobró. Un borrador, al
-- revés, tiene que reflejar lo que se va a cobrar — que es lo que rige hoy para ese mes.
-- ---------------------------------------------------------------------------------------------
create or replace function app.cuota_fija_version_del_periodo(p_periodo uuid)
  returns uuid
  language sql stable security definer set search_path = public, app
as $$
  select case
           when p.estado in ('emitida', 'distribuida') then p.cuota_fija_version_id
           else coalesce(app.cuota_fija_version_vigente(p.barrio_id, p.periodo), p.cuota_fija_version_id)
         end
    from periodo_expensa p
   where p.id = p_periodo
$$;
--> statement-breakpoint

grant execute on function app.cuota_fija_version_vigente(uuid, text) to app_request, app_job;
--> statement-breakpoint
grant execute on function app.cuota_fija_version_del_periodo(uuid) to app_request, app_job;
--> statement-breakpoint

comment on function app.cuota_fija_version_del_periodo(uuid) is
  'Qué versión de valor fijo aplica a un período: la vigente a su mes mientras es borrador, la que quedó fijada una vez emitido. Única definición: la usan el cálculo y las pantallas.';
