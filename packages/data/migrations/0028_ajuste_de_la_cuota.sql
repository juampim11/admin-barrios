-- =============================================================================================
-- 0028_ajuste_de_la_cuota — por qué cambió la cuota, no solo cuánto quedó
--
-- Un barrio de cuota fija no decide "que la cuota sea $383.904": decide **"le damos el 3,2 %"**,
-- casi siempre atado a la paritaria del rubro que más pesa. Hasta acá el sistema guardaba solo el
-- importe resultante, y con eso el motivo se perdía: al mes siguiente nadie podía contestar por qué
-- había cambiado sin volver al acta o al Excel.
--
-- Se guardan las **tres** cosas, porque ninguna se deduce de las otras:
--   * el porcentaje  → la explicación (es lo que se contesta cuando el vecino pregunta);
--   * el redondeo    → una decisión que **cambia lo que se cobra**, no un detalle de presentación;
--   * la versión anterior → contra qué se aplicó, para poder rehacer la cuenta años después.
--
-- Todas las columnas son opcionales a propósito: la primera cuota de un barrio no tiene contra qué
-- aplicar un porcentaje, y no todo ajuste es porcentual (a veces el directorio fija un número).
-- =============================================================================================

alter table cuota_fija_version
  add column ajuste_porcentaje  numeric(9,4),
  add column redondeo           text,
  add column version_anterior_id uuid;
--> statement-breakpoint

alter table cuota_fija_version
  add constraint fk_cuota_fija_version_anterior foreign key (version_anterior_id, barrio_id)
  references cuota_fija_version (id, barrio_id) on delete restrict;
--> statement-breakpoint

-- El vocabulario del redondeo vive en la base además de en el dominio: cualquier vía de carga
-- (UI, importación, script) escribe uno de estos cuatro o no escribe nada.
alter table cuota_fija_version
  add constraint cuota_fija_version_redondeo_chk
  check (redondeo is null or redondeo in ('centavo', 'peso', 'centena', 'mil'));
--> statement-breakpoint

-- Un porcentaje sin base es un número sin significado: no se puede rehacer la cuenta ni explicar el
-- salto. Si se declara el ajuste, se declara contra qué.
alter table cuota_fija_version
  add constraint cuota_fija_version_ajuste_chk
  check (ajuste_porcentaje is null or version_anterior_id is not null);
--> statement-breakpoint

-- Una versión no puede derivar de sí misma (el FK no lo impide: la fila ya existe al actualizarse).
alter table cuota_fija_version
  add constraint cuota_fija_version_anterior_distinta_chk
  check (version_anterior_id is null or version_anterior_id <> id);
--> statement-breakpoint

comment on column cuota_fija_version.ajuste_porcentaje is
  'Aumento aplicado sobre la versión anterior, en porcentaje (3.2000 = 3,2 %). Puede ser negativo: una cuota puede bajar. Null = el importe se cargó directo.';
--> statement-breakpoint
comment on column cuota_fija_version.redondeo is
  'A qué se redondeó el resultado del porcentaje: centavo | peso | centena | mil. No es formato: cambia lo que se cobra.';
