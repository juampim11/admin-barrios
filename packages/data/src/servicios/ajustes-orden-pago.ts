/**
 * El ajuste de una orden de pago anulada, compensado ANTES de prorratear (encargo 8, P2).
 *
 * Cuando se anula una OP cuyo período de origen ya se emitió, la base (trigger de `orden_pago`,
 * migración `0048`) asienta un gasto **negativo** en el borrador abierto del barrio: la devolución
 * del gasto que ya se cobró. El motor de liquidación (`calcularLiquidacion`) rechaza los gastos
 * negativos —y está bien que lo haga: un negativo prorrateado sería un crédito repartido sin que
 * nadie lo decida—, así que el mes siguiente no se podía generar.
 *
 * El tratamiento: el ajuste se **descuenta de los gastos del mismo concepto** del período, antes de
 * llamar al motor. Lo que se prorratea es el neto del concepto, que es lo que cuadra contra
 * `app.validar_emision` (suma de los gastos del período, ajuste incluido). El motor no cambia.
 *
 * - Se descuenta del gasto más grande del concepto primero (y así, si no alcanza), para tocar la
 *   menor cantidad de líneas posible. Cada línea tocada dice de qué anulación sale lo descontado.
 * - Un gasto que queda en cero no se prorratea: no hay nada que repartir.
 * - Si el concepto queda con **neto negativo** (el ajuste es más grande que lo cargado en ese
 *   concepto) y lo que falta se cobraría, la generación se frena con un mensaje que nombra la orden, el proveedor y el
 *   concepto. Nunca se prorratea un negativo.
 *
 * Es una función pura, sin base: el servicio le pasa las filas y ella devuelve los gastos a
 * prorratear o el rechazo.
 */

import { aCentavos, formatearMonto, restarMontos, sumarMontos, type Monto } from "@admin-barrios/shared/dinero";
import type { GastoDelPeriodo } from "@admin-barrios/shared/liquidacion";

/** Un gasto del período tal como lo lee el servicio, con lo necesario para explicar el ajuste. */
export type GastoLeido = GastoDelPeriodo & {
  /** El concepto, para el mensaje de rechazo. */
  readonly conceptoNombre: string;
  /** No nulo = es el ajuste de una OP anulada (el negativo). */
  readonly ajusteDeOrdenPago: {
    readonly ordenPagoId: string;
    readonly proveedor: string;
    readonly numeroFactura: string | null;
  } | null;
};

export type ResultadoCompensacion =
  | { readonly ok: true; readonly gastos: GastoDelPeriodo[] }
  | {
      readonly ok: false;
      readonly ordenPagoId: string;
      readonly proveedor: string;
      readonly numeroFactura: string | null;
      readonly concepto: string;
      /** Lo que le falta al concepto para cubrir el ajuste (positivo). */
      readonly faltante: Monto;
    };

/** «Anulación de la OP de {proveedor}, factura {n.º}», el texto con que se nombra el ajuste. */
export function textoDeAnulacion(proveedor: string, numeroFactura: string | null): string {
  return numeroFactura
    ? `Anulación de la OP de ${proveedor}, factura ${numeroFactura}`
    : `Anulación de la OP de ${proveedor}, sin número de factura`;
}

/**
 * `modelo`: en `fija` las ordinarias no se cobran (las cubre la cuota), así que un ajuste ordinario
 * se descuenta de lo que haya en su concepto y lo que sobre no frena nada: no cambia ninguna boleta y
 * `app.validar_emision` solo cuadra extraordinarias en ese modelo (revisión de código, encargo 8).
 */
export function compensarAjustesDeOrdenPago(
  leidos: readonly GastoLeido[],
  modelo: "variable" | "fija" = "variable",
): ResultadoCompensacion {
  const ajustes = leidos.filter((g) => g.ajusteDeOrdenPago !== null);
  const sinAjuste = (g: GastoLeido): GastoDelPeriodo => {
    const { conceptoNombre: _c, ajusteDeOrdenPago: _a, ...gasto } = g;
    return gasto;
  };
  if (ajustes.length === 0) return { ok: true, gastos: leidos.map(sinAjuste) };

  // Lo que queda de cada gasto positivo después de descontar, y qué se le descontó.
  const restante = new Map<string, Monto>();
  const notas = new Map<string, string[]>();
  for (const g of leidos) if (g.ajusteDeOrdenPago === null) restante.set(g.gastoId, g.monto);

  for (const ajuste of ajustes) {
    const op = ajuste.ajusteDeOrdenPago!;
    // El ajuste llega negativo; lo que hay que descontar es su valor absoluto.
    let porDescontar = restarMontos("0.00", ajuste.monto);
    const candidatos = leidos
      .filter((g) => g.ajusteDeOrdenPago === null && g.conceptoId === ajuste.conceptoId)
      .sort((a, b) => {
        const d = aCentavos(restante.get(b.gastoId)!) - aCentavos(restante.get(a.gastoId)!);
        return d > 0n ? 1 : d < 0n ? -1 : 0;
      });
    for (const g of candidatos) {
      if (aCentavos(porDescontar) === 0n) break;
      const hay = restante.get(g.gastoId)!;
      if (aCentavos(hay) === 0n) continue;
      const descuento = aCentavos(hay) >= aCentavos(porDescontar) ? porDescontar : hay;
      restante.set(g.gastoId, restarMontos(hay, descuento));
      porDescontar = restarMontos(porDescontar, descuento);
      notas.set(g.gastoId, [
        ...(notas.get(g.gastoId) ?? []),
        `$ ${formatearMonto(descuento)} por ${textoDeAnulacion(op.proveedor, op.numeroFactura).replace(/^Anulación/, "la anulación")}`,
      ]);
    }
    if (aCentavos(porDescontar) > 0n && !(modelo === "fija" && ajuste.tipo === "ordinaria")) {
      return {
        ok: false,
        ordenPagoId: op.ordenPagoId,
        proveedor: op.proveedor,
        numeroFactura: op.numeroFactura,
        concepto: ajuste.conceptoNombre,
        faltante: sumarMontos(porDescontar),
      };
    }
  }

  const gastos: GastoDelPeriodo[] = [];
  for (const g of leidos) {
    if (g.ajusteDeOrdenPago !== null) continue;
    const monto = restante.get(g.gastoId)!;
    if (aCentavos(monto) === 0n) continue;
    const nota = notas.get(g.gastoId);
    gastos.push({
      ...sinAjuste(g),
      monto,
      descripcion: nota ? `${g.descripcion} (se descontaron ${nota.join("; ")})` : g.descripcion,
    });
  }
  return { ok: true, gastos };
}
