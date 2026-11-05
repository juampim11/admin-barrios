-- =============================================================================================
-- 0071_motivo_de_vencimientos — T2, el circuito del mes (ADR-0011).
--
-- Solo esquema: una columna nullable. **No cambia ni una fila.**
--
-- Los vencimientos de un mes vienen de la configuración del barrio cuando el mes se abre solo, y se
-- pueden cambiar para ese mes hasta emitir (el diálogo «Cambiar los vencimientos» de la maqueta). El
-- motivo del cambio queda en el período. Después de emitir, el período es inmutable (`0030`).
-- =============================================================================================

alter table periodo_expensa add column motivo_vencimientos text;
