-- =============================================================================================
-- 0085_clase_item_historico — la línea de la deuda anterior a la activación (encargo 17).
-- **Solo DDL**: un valor de enum, solo en su archivo.
--
-- El migrador corre todas las migraciones pendientes en UNA transacción, y un valor de enum nuevo
-- no se puede usar en la misma transacción que lo crea. Por eso va acá, y `0086` compara
-- `clase_item::text`.
-- =============================================================================================

alter type app.clase_item add value if not exists 'historico';
