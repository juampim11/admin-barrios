/**
 * Qué avisos del mes se muestran **después de emitir** (encargo 16c).
 *
 * `avisosDelMes` está escrito para un mes que se prepara: varios de sus textos hablan del antes de
 * emitir («Si no se aprueban antes de emitir, su gasto no entra en este mes», «Las boletas saldrían
 * sin fecha de vencimiento») y en un mes emitido serían falsos. Los que siguen siendo ciertos son los
 * de los gastos —el rubro que se pasó del presupuesto, el extraordinario sin acta—, porque el gasto se
 * sigue cargando después de emitir. Esos son los que se ven en el Resumen y en «Liquidación actual»
 * de un mes emitido o enviado. Lo que bloquea no aplica: el mes ya salió.
 *
 * Es presentación: no cambia qué avisa el servicio, solo cuáles se dicen cuando el mes ya salió.
 */

import type { Falta } from "@admin-barrios/data/servicios/circuito-del-mes";

export function avisosDeUnMesEmitido<F extends Pick<Falta, "tipo" | "donde">>(faltas: readonly F[]): F[] {
  return faltas.filter((f) => f.tipo === "avisa" && f.donde === "gastos");
}
