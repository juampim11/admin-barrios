-- =============================================================================================
-- 0082_metodo_importe_libre — el método «importe a cargar cada vez» (encargo 16b).
--
-- Solo agrega el valor al enum, y va en una migración propia a propósito: el migrador corre todo
-- en una transacción, y un valor de enum recién agregado no se puede USAR como enum dentro de la
-- misma transacción. Por eso `0083` compara el método como texto (`metodo::text`) en los checks y
-- en la función SQL, igual que hizo `0078` con la figura «sin entidad» de `0077`.
-- =============================================================================================
alter type app.metodo_concepto_boleta add value if not exists 'importe_libre';
