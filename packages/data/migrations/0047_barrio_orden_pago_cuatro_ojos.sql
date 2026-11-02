-- =============================================================================================
-- 0047_barrio_orden_pago_cuatro_ojos — la columna de configuración del control de cuatro-ojos, MÁS
-- el grant de columna que hace que esa configuración no sea, de hecho, autoconfigurable.
--
-- Dos cosas en un archivo por prolijidad técnica (la sección 2 no tiene sentido sin la columna que
-- agrega la sección 1), pero son DOS COMMITS separados al cerrar esta tanda: la sección 1 es la
-- feature nueva de Proveedores/OP; la sección 2 es un fix de seguridad sobre un agujero que YA
-- EXISTÍA en código commiteado (`orden_imputacion`, `0036_orden_imputacion_barrio.sql`, tanda de
-- Cobros) — encontrado al auditar esta columna nueva, no una consecuencia de ella.
--
-- **El hallazgo, completo** (`security-engineer`, consulta acotada, 2026-08-21): `0003_dominio_rls.sql`
-- deja `barrio` con `grant update` de TABLA ENTERA (sin restricción de columna) a `app_request`, con
-- policy de UPDATE que habilita a `admin_plataforma`, `admin_barrio` Y `operador` por igual. Postgres
-- `GRANT` distingue roles de BASE (`app_request` vs `app_job`), no los roles de NEGOCIO dentro de
-- `app_request` — así que la única forma real de sacarle una columna a "admin_barrio" es sacársela a
-- TODO `app_request`, y dársela solo a `app_job`/soporte. Sin este fix, `orden_pago_cuatro_ojos`
-- quedaría de hecho autoconfigurable por el mismo rol que la decisión de dominio dice que no puede
-- tocarla — y `orden_imputacion` ya está en esa situación hoy, sin que ningún servicio de escritura
-- la haya explotado todavía (no hay ningún endpoint de escritura de `barrio` en el repo).
--
-- Precedente del patrón de columna: `0017_cargos_endurecimiento.sql` (`revoke update` de tabla +
-- `grant update (columnas)`), aplicado ahí a `concepto_boleta_unidad` para distinguir cliente de job.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. La columna — feature de Proveedores/OP.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "barrio" ADD COLUMN "orden_pago_cuatro_ojos" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. El grant de columna — fix de seguridad, commit aparte. Ningún rol de negocio conectado por
--    `app_request` (ni siquiera `admin_plataforma`) puede tocar `orden_imputacion` ni
--    `orden_pago_cuatro_ojos`: las dos son dato de mandato/gobierno del barrio, se escriben vía
--    `app_job`/soporte. El resto de las columnas queda exactamente como estaba (mismo grant amplio
--    de `0003`) — este fix cierra el agujero puntual, no rediseña el permiso de `barrio` entero.
-- ---------------------------------------------------------------------------------------------
revoke update on table barrio from app_request;
--> statement-breakpoint

grant update (
  jurisdiccion, figura_juridica, adecuado_art_2075, encuadre_urbanistico, municipio,
  servicios_internos_a_cargo_de, titularidad_espacios_comunes, denominacion_concepto,
  medio_cobranza_clave, reglamento_inscripto, pacto_ejecutividad, tiene_espacios_comunes_exclusivos,
  tiene_consejo, tiene_fondo_reserva, cuit, domicilio_sede, updated_at
) on table barrio to app_request;
-- `orden_imputacion` y `orden_pago_cuatro_ojos` NO están en esta lista — a propósito. No las
-- agregues de vuelta sin volver a leer el comentario de cabecera de esta migración.