-- =============================================================================================
-- 0040_saldo_anterior_origen_calculado — el módulo de Cobros ya puede decir de dónde sale el saldo.
--
-- `liquidacion_saldo_origen_chk` (`0009_trazabilidad_reglas.sql`) admitía tres valores:
-- `sin_movimientos` | `carga_manual` | `cuenta_corriente` — el tercero, escrito **antes** de que
-- existiera este módulo, ya anticipaba una cuenta corriente real. Con `app.v_estado_cuenta_uf` y
-- `saldo_uf` (`0037`), esa cuenta corriente existe: se agrega `calculado`, el valor que usa
-- `generarLiquidaciones()` cuando el saldo anterior sale de `saldo_uf` y no de una carga a mano.
--
-- Sin backfill: ninguna fila existente pasa a `calculado` retroactivamente — esas liquidaciones se
-- generaron antes de que el sistema pudiera calcular nada, y decir lo contrario sería falso.
-- =============================================================================================

alter table liquidacion drop constraint liquidacion_saldo_origen_chk;
--> statement-breakpoint

alter table liquidacion add constraint liquidacion_saldo_origen_chk
  check (saldo_anterior_origen in ('sin_movimientos', 'carga_manual', 'cuenta_corriente', 'calculado'));
