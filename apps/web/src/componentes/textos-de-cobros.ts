/**
 * Los textos del estado de cuenta que llevan cifras (encargo 10): el «Listo:» de un pago registrado,
 * de una condonación y de un pago anulado, y el resumen del diálogo de anular un pago (BL-029).
 *
 * Son funciones puras para poder probarlas sin pantalla: reciben cifras **leídas de la base** (las
 * filas del pago, sus imputaciones y su condonación, `listarPagosDeUnidad`) y solo las ponen en
 * palabras. La única suma es la del saldo después de anular, y es la misma que hace la base: anular
 * el pago anula sus imputaciones y su condonación, y cada trigger le devuelve ese importe a `saldo_uf`
 * (`0068`). El pago en sí no toca `saldo_uf`.
 */

import { aCentavos, formatearMonto, restarMontos, sumarMontos, type Monto } from "@admin-barrios/shared/dinero";
import { formatearFecha } from "@admin-barrios/shared/fechas";

const pesos = (monto: string): string => `$ ${formatearMonto(monto)}`;

/** Lo mínimo de un pago para contar cómo se imputó. */
export type ImputacionDePago = {
  readonly monto: Monto;
  readonly fecha: string;
  readonly aCapital: Monto;
  readonly aInteres: Monto;
  /** Todo lo condonado con el pago (las dos partes de «No cobrar interés»). */
  readonly interesCondonado: Monto;
  /** De eso, el interés anterior que la unidad ya debía (encargo 11, BL-030 j). Sin dato, cero. */
  readonly interesCondonadoAnterior?: Monto;
};

/** Las dos partes de lo condonado: el interés de este atraso y el anterior (encargo 11, BL-030 j). */
function partesCondonadas(p: ImputacionDePago): { readonly delPago: Monto; readonly anterior: Monto } {
  const anterior = p.interesCondonadoAnterior ?? "0.00";
  return { delPago: restarMontos(p.interesCondonado, anterior), anterior };
}

/** «$ 800,00 de interés de este atraso y $ 3.000,00 de interés anterior», solo las partes que no son cero. */
function enDosPartes(delPago: Monto, anterior: Monto): string {
  return [
    aCentavos(delPago) > 0n ? `${pesos(delPago)} de interés de este atraso` : null,
    aCentavos(anterior) > 0n ? `${pesos(anterior)} de interés anterior` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" y ");
}

/**
 * Cómo se imputó, en una frase: «$ 351.420,61 a capital y $ 2.481,87 a interés[, $ X de interés no
 * cobrado]». Si lo no cobrado incluye interés anterior (encargo 11), dice las dos partes: «…, y no se
 * cobraron $ 800,00 de interés de este atraso y $ 3.000,00 de interés anterior».
 */
function comoSeImputo(p: ImputacionDePago): string {
  const base = `${pesos(p.aCapital)} a capital y ${pesos(p.aInteres)} a interés`;
  if (p.interesCondonado === "0.00") return base;
  const { delPago, anterior } = partesCondonadas(p);
  if (aCentavos(anterior) === 0n) return `${base}, ${pesos(p.interesCondonado)} de interés no cobrado`;
  return `${base}, y no se ${aCentavos(delPago) > 0n ? "cobraron" : "cobró"} ${enDosPartes(delPago, anterior)}`;
}

/**
 * «Listo: se registró el pago de $ 353.902,48 del 04/11/2026: $ 351.420,61 a capital y $ 2.481,87 a
 * interés.» Con «No cobrar interés», agrega «, $ X de interés no cobrado» antes del punto.
 */
export function listoDelPago(p: ImputacionDePago): string {
  return `Listo: se registró el pago de ${pesos(p.monto)} del ${formatearFecha(p.fecha)}: ${comoSeImputo(p)}.`;
}

/** «Listo: se condonaron $ 15,00 de interés de esta unidad.» */
export function listoDeLaCondonacion(monto: Monto): string {
  return `Listo: se condonaron ${pesos(monto)} de interés de esta unidad.`;
}

/** «Listo: se anuló el pago de $ X del dd/mm/aaaa. El saldo volvió a deber lo que ese pago cubría.» */
export function listoDeLaAnulacion(p: ImputacionDePago): string {
  return `Listo: se anuló el pago de ${pesos(p.monto)} del ${formatearFecha(p.fecha)}; la unidad vuelve a deber lo que ese pago cubría.`;
}

/** Lo que muestra el diálogo de anular un pago (BL-029), con el patrón del de anular una orden de pago. */
export type ResumenDeAnulacion = {
  readonly titulo: string;
  /** Una línea por concepto, en el orden en que se lee. */
  readonly lineas: readonly string[];
  readonly saldoAntes: Monto;
  readonly saldoDespues: Monto;
};

/**
 * El resumen del diálogo: el importe, cómo se imputó (y la condonación que se anula con él), y el
 * saldo antes y después.
 *
 * `saldoActual` es el de `saldo_uf` (`listarSaldosUF`). Después de anular, la base le devuelve lo que
 * el pago imputó a capital y a interés y lo que condonó: esa es la suma de acá, ni una regla más. El
 * interés que el pago devengó por llegar tarde **no** se anula (queda devengado, y vuelve a deberse).
 */
export function resumenDeAnulacion(p: ImputacionDePago, saldoActual: Monto): ResumenDeAnulacion {
  const lineas = [
    `Importe del pago: ${pesos(p.monto)}, del ${formatearFecha(p.fecha)}.`,
    `Se imputó ${pesos(p.aCapital)} a capital y ${pesos(p.aInteres)} a interés: las dos imputaciones se anulan con el pago.`,
  ];
  if (p.interesCondonado !== "0.00") {
    const { delPago, anterior } = partesCondonadas(p);
    lineas.push(
      aCentavos(anterior) === 0n
        ? `Con el pago se condonaron ${pesos(p.interesCondonado)} de interés («No cobrar interés»): esa condonación también se anula, y ese interés vuelve a deberse.`
        : // Encargo 11 (BL-030 j): las dos partes, y que las dos se anulan.
          `Con el pago se condonaron ${pesos(p.interesCondonado)} de interés («No cobrar interés»): ${enDosPartes(delPago, anterior)}. ` +
            "Esas condonaciones también se anulan, y ese interés vuelve a deberse.",
    );
  }
  return {
    titulo: `¿Anular el pago de ${pesos(p.monto)} del ${formatearFecha(p.fecha)}?`,
    lineas,
    saldoAntes: saldoActual,
    saldoDespues: sumarMontos(saldoActual, p.aCapital, p.aInteres, p.interesCondonado),
  };
}
