-- =============================================================================================
-- 0061_zona_horaria_barrio — la hora que se muestra es la del barrio (BL-010).
--
-- Los instantes (`timestamptz`) se guardan en UTC y está bien. Lo que faltaba es **en qué zona se
-- muestran**: cuatro pantallas imprimían el texto crudo del `timestamptz` (UTC sin decirlo: a las
-- 21:30 de Argentina, el día siguiente) y la de distribución lo rotulaba "UTC" porque no había de
-- dónde sacar otra cosa (HANDOFF, "La zona horaria: pendiente explícito").
--
-- **Es dato del barrio, no del producto**: un barrio de otra provincia o de otro país tiene otra
-- hora. El valor inicial es la hora oficial argentina (`America/Argentina/Buenos_Aires`, UTC−3 sin
-- horario de verano), que es la jurisdicción del producto (`knowledge/`), no la ciudad del piloto.
--
-- Nace **cerrada para `app_request`**, como el formato del código de pago (`0059`): no entra en el
-- grant de `update` por columna de `barrio` (lista vigente en `0050`). Cambiar la hora con la que se
-- leen todos los sellos de un barrio es configuración de la cuenta.
--
-- El `check` valida contra el catálogo de zonas de la propia base: un nombre que Postgres no conoce
-- haría fallar cada consulta que lo use con `at time zone`, lejos de donde se cargó.
-- =============================================================================================

alter table barrio add column zona_horaria text not null default 'America/Argentina/Buenos_Aires';
--> statement-breakpoint

create or replace function app.zona_horaria_valida(p_zona text) returns boolean
  language sql stable
  set search_path = pg_catalog
as $$ select exists (select 1 from pg_timezone_names where name = p_zona) $$;
--> statement-breakpoint

alter table barrio add constraint barrio_zona_horaria_chk check (app.zona_horaria_valida(zona_horaria));
--> statement-breakpoint

grant execute on function app.zona_horaria_valida(text) to app_request, app_job;
--> statement-breakpoint

comment on column barrio.zona_horaria is
  'Zona IANA con la que se muestran los instantes del barrio (BL-010). Inicial: hora oficial '
  'argentina. Cerrada para app_request (0061).';
--> statement-breakpoint

-- El único helper de conversión: un instante, en la hora de su barrio, como texto `YYYY-MM-DD HH24:MI`
-- (lo imprime `formatearFechaHora` de `@admin-barrios/shared/fechas`, que no convierte nada). Se
-- convierte acá y no en la app porque la app no usa `Date` ni `Intl` (regla 6 de la UI).
--
-- Sin `security definer`: lee `barrio` con la RLS de quien consulta, y quien ve un documento, un
-- recibo o una orden de pago ve su barrio. El texto no depende del `TimeZone` de la sesión: `at time
-- zone` con un nombre explícito da siempre lo mismo.
create or replace function app.en_hora_del_barrio(p_instante timestamptz, p_barrio uuid) returns text
  language sql stable
  set search_path = public, app
as $$
  select to_char(p_instante at time zone b.zona_horaria, 'YYYY-MM-DD HH24:MI')
    from barrio b where b.barrio_id = p_barrio
$$;
--> statement-breakpoint

grant execute on function app.en_hora_del_barrio(timestamptz, uuid) to app_request, app_job;
