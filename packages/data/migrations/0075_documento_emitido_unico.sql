-- 0075 — Un documento por boleta y un informe por período (encargo 14, BL-035 a).
--
-- Si dos workers toman a la vez la generación de un mismo período (dos réplicas, o un trabajo
-- reencolado por falta de latido mientras el proceso original seguía vivo), los dos leen
-- `liquidacionesConBoleta()` vacío y los dos registran una boleta por liquidación: la unidad queda
-- con dos PDF distintos del mismo mes. Con estos índices el segundo `insert` choca, y
-- `registrarDocumentoEmitido()` lo toma como «ya estaba» (`on conflict do nothing`): queda un objeto
-- huérfano en el almacenamiento —el mismo caso que ya está documentado para un proceso que muere
-- entre el `put` y la fila— y ninguna fila duplicada.
--
-- **Parciales, por tipo:** la boleta es única por liquidación y el informe por período. El listado
-- de saldos no entra: hoy no lo emite nadie, y su regla se decide cuando exista.
--
-- **Regenerar.** ADR-0001 §6 dice que regenerar un documento crea una fila nueva y nunca pisa la
-- anterior. Hoy no hay ningún camino que regenere (el worker salta lo ya emitido). El día que exista,
-- ese camino tiene que marcar la fila vieja como reemplazada y estos índices pasar a excluirla.
--
-- Solo DDL. Si la base tuviera duplicados, el `create unique index` falla y la migración no pasa:
-- se resuelven a mano antes, nunca con un `delete` escondido acá.
create unique index uq_documento_boleta_por_liquidacion
  on documento_emitido (liquidacion_id)
  where tipo = 'boleta_unidad';
--> statement-breakpoint
create unique index uq_documento_informe_por_periodo
  on documento_emitido (periodo_id)
  where tipo = 'informe_mensual';
