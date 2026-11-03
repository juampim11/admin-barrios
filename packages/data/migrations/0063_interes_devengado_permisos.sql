-- =============================================================================================
-- 0063_interes_devengado_permisos — lo que le faltó a `0062` para que las funciones de la base
-- (dueño `app_job`, `security definer`) puedan trabajar con las tablas nuevas:
--   · `app.resolver_imputacion` inserta en `pago_imputacion_interes`;
--   · los triggers toman `for update` sobre `interes_devengado` (un bloqueo de fila pide el permiso
--     de `update`; el trigger append-only sigue rechazando cualquier edición real).
-- =============================================================================================
grant insert, update on table pago_imputacion_interes to app_job;
--> statement-breakpoint
grant update on table interes_devengado to app_job;
--> statement-breakpoint
grant update on table interes_condonacion to app_job;
