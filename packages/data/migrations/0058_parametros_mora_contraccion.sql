-- =============================================================================================
-- 0058_parametros_mora_contraccion — se va lo que `0057` migró (tanda T1, ADR-0006).
--
-- Una sola fuente de verdad: desde acá la tasa de mora y el orden de imputación viven SOLO en
-- `parametro_valor`. Va en un archivo propio (la "contracción" del patrón expandir/contraer que
-- propuso `dba-data`) para que se lea qué se borra y por qué, separado de qué se crea. Corre en la
-- misma transacción que `0056`/`0057` (el migrador aplica todo lo pendiente junto), así que no hay
-- un instante con las dos fuentes vivas.
--
-- Lo que leía lo viejo, y ya no: `servicios/liquidacion.ts` (la tasa), `servicios/barrios.ts` (el
-- semáforo del tablero), `app.resolver_imputacion` (reescrita en `0057` §8), el seed y los tests.
-- =============================================================================================

drop function app.tasa_mora_vigente(uuid, date);
--> statement-breakpoint
drop table tasa_mora;
--> statement-breakpoint
alter table barrio drop constraint barrio_orden_imputacion_chk;
--> statement-breakpoint
alter table barrio drop column orden_imputacion;
