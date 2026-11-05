-- 0073 — El latido de un trabajo (ensayo de T2, 2026-11-05).
--
-- Un trabajo `corriendo` cuyo proceso murió (un reinicio del worker, un corte) quedaba así hasta que
-- `caducarRezagados` lo barría a los **10 minutos**, y entonces pasaba a `fallado` sin reintentarse:
-- en el ensayo, Envío mostró «Preparando… 0 de 340» diez minutos y después pidió volver a generar a
-- mano. Con el latido, el worker marca cada pocos segundos que sigue vivo, y un trabajo sin latido
-- hace un minuto se reencola solo (lo hace el worker, `apps/worker/src/servidor/cola.ts`).
--
-- Solo DDL: una columna nueva, nula en las filas existentes. Ningún dato se toca.
alter table trabajo add column latido_at timestamptz;
