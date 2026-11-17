-- =============================================================================================
-- 0092_clase_item_plan — la línea de una cuota de plan de pagos (encargo P1, BL-051). **Solo DDL**:
-- un valor de enum, solo en su archivo (no se puede usar en la misma transacción que lo crea; ver
-- `0085`). `0093` compara `clase_item::text`.
-- =============================================================================================

alter type app.clase_item add value if not exists 'plan_cuota';
