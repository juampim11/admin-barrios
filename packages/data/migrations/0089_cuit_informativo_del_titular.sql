-- =============================================================================================
-- 0089_cuit_informativo_del_titular — el titular tiene un CUIT opcional e informativo
-- (encargo 17b, punto i). **Solo DDL**: una columna, dos checks y su comentario. No toca filas.
--
-- No se reutiliza `cuit_cuil`: esa columna es de **identidad** (única por barrio, `uq_obligado_barrio_cuit`;
-- decide «es la misma persona» al importar el padrón) y se llena cuando el documento de identidad ES
-- un CUIT. `cuit_informativo` es un dato de quien se identifica con DNI (o no tiene documento
-- cargado): sin unicidad y sin índice — nadie busca ni reconoce a una persona por él.
--
-- Si la identidad ya es un CUIT, el informativo no hace falta: el segundo check no deja tener los dos
-- (los servicios ignoran el mismo número y rechazan uno distinto antes de llegar acá).
--
-- Permisos: `app_request` y `app_job` tienen `insert`/`select`/`update` sobre la TABLA `obligado`
-- (no por columnas, a diferencia de `barrio`), así que la columna nueva queda cubierta sin `grant`.
-- La RLS de `obligado` es por fila y no cambia.
-- =============================================================================================

alter table obligado add column cuit_informativo text;
--> statement-breakpoint
alter table obligado add constraint obligado_cuit_informativo_chk
  check (cuit_informativo is null or cuit_informativo ~ '^[0-9]{11}$');
--> statement-breakpoint
alter table obligado add constraint obligado_cuit_informativo_sin_cuit_chk
  check (cuit_informativo is null or cuit_cuil is null);
--> statement-breakpoint
comment on column obligado.cuit_informativo is
  'CUIT o CUIL informativo del titular que se identifica con DNI (11 dígitos, sin guiones). Opcional. No es identidad: no tiene unicidad ni decide «es la misma persona» (eso es cuit_cuil / numero_documento). Vacío si el documento de identidad ya es un CUIT.';
