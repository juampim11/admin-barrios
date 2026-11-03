/**
 * Interés por pago fuera de término y reparto del pago entre interés y capital — dominio puro
 * (ADR-0009). Se apoya en el motor de T1 (`calcularInteresMora`, ADR-0006): **no hay un segundo
 * cálculo de interés**, solo la forma de partir la vida de una deuda en tramos.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LOS TRAMOS
 *
 * El capital de una liquidación devenga desde su vencimiento. Cada **hecho** —un pago que llega
 * tarde, o el corte de la boleta siguiente— cierra un tramo: el interés del capital que estaba
 * pendiente, desde donde quedó el tramo anterior hasta la fecha del hecho. El tramo siguiente arranca
 * ahí, sobre el capital que quedó.
 *
 *  · **Solo el primer tramo cuenta la gracia** (`desdeVencimiento`): es el único que empieza en el
 *    vencimiento, y la gracia se aplica como en T1 —con «corre el inicio» los días de gracia no
 *    devengan; con «escalón», pasada la gracia devengan todos—. Un tramo que da cero por gracia no se
 *    registra y no mueve el inicio: el próximo hecho vuelve a medir desde el vencimiento, así la gracia
 *    se aplica una sola vez y entera.
 *  · **«Cobra interés: No»** no devenga (día por día, como en T1) y no registra nada.
 *  · **Tolerancia**: además de la de T1 (un saldo menor o igual a la tolerancia no devenga), si el
 *    interés de un tramo es **menor** que la tolerancia, no se cobra — pero queda registrado como
 *    "no cobrado por tolerancia" y el tramo se cierra (legal-ph: el interés que no se cobra no
 *    desaparece sin rastro).
 *  · **El interés no devenga interés**: solo el capital tiene tramos (decisión de producto; la norma
 *    sobre anatocismo no está cargada en `knowledge/`).
 *
 * Centavos en `bigint`, tasas en millonésimas: nada de `number` para plata.
 */

import { aCentavos, deCentavos, type Monto } from "./dinero.ts";
import { calcularInteresMora, numeroDeDia, type VigenciasMora } from "./interes-mora.ts";
import type { OrdenImputacionBarrio } from "./cobros.ts";

export type ResultadoTramo =
  /** «Cobra interés: No» en todo el tramo: no se registra nada y el tramo no se cierra. */
  | { readonly estado: "no_se_cobra" }
  /** Cero porque el pago cayó dentro de la gracia (solo el primer tramo): no se registra ni se cierra. */
  | { readonly estado: "gracia" }
  /** Sin días o sin saldo: no hay nada que registrar. */
  | { readonly estado: "sin_interes" }
  /** Se calculó, pero es menor que la tolerancia (o el saldo no la supera): se registra en cero y se cierra. */
  | { readonly estado: "tolerancia"; readonly interesCalculado: Monto; readonly dias: number }
  | {
      readonly estado: "calculado";
      readonly interes: Monto;
      readonly compensatorio: Monto;
      readonly punitorio: Monto;
      /** Días corridos del tramo. */
      readonly dias: number;
      /** Días que devengaron de verdad (después de la gracia y con «cobra» en Sí). */
      readonly diasDevengados: number;
    };

/** Las vigencias sin gracia: para los tramos que no empiezan en el vencimiento. */
function sinGracia(v: VigenciasMora): VigenciasMora {
  return { cambios: v.cambios, en: (f) => ({ ...v.en(f), graciaDias: 0 }) };
}

/**
 * El interés de un tramo: el capital `base`, desde `inicio` (exclusivo: el vencimiento o el fin del
 * tramo anterior) hasta `fin` (inclusivo: la fecha del pago o el corte).
 */
export function interesDelTramo(entrada: {
  readonly base: Monto;
  readonly inicio: string;
  readonly fin: string;
  /** `true` si `inicio` es el vencimiento de la liquidación: es el único tramo que cuenta la gracia. */
  readonly desdeVencimiento: boolean;
  readonly vigencias: VigenciasMora;
}): ResultadoTramo {
  const dias = numeroDeDia(entrada.fin) - numeroDeDia(entrada.inicio);
  if (dias <= 0 || aCentavos(entrada.base) <= 0n) return { estado: "sin_interes" };
  const vigencias = entrada.desdeVencimiento ? entrada.vigencias : sinGracia(entrada.vigencias);
  const r = calcularInteresMora({ saldoVencido: entrada.base, fechaCorte: entrada.fin, diasDeAtraso: dias, vigencias });
  if (r.estado === "no_se_cobra") return { estado: "no_se_cobra" };
  if (r.motivoCero === "gracia") return { estado: "gracia" };
  if (r.motivoCero === "no_cobra") return { estado: "no_se_cobra" };
  if (r.motivoCero === "tolerancia") return { estado: "tolerancia", interesCalculado: "0.00", dias };
  // Devengaron días pero el monto no llega a un centavo (tasa 0, un resto chico): no hay interés.
  if (aCentavos(r.interes) === 0n) return { estado: "sin_interes" };
  const tolerancia = vigencias.en(entrada.inicio).tolerancia;
  if (aCentavos(r.interes) < aCentavos(tolerancia)) return { estado: "tolerancia", interesCalculado: r.interes, dias };
  return {
    estado: "calculado",
    interes: r.interes,
    compensatorio: r.compensatorio,
    punitorio: r.punitorio,
    dias,
    diasDevengados: r.diasDevengados,
  };
}

/** Lo que el interés de un tramo suma a la deuda: cero si no se cobra, por gracia o por tolerancia. */
export function interesCobrable(r: ResultadoTramo): Monto {
  return r.estado === "calculado" ? r.interes : "0.00";
}

/** Si el tramo se cierra (y se registra): el siguiente arranca en su `fin`. */
export function cierraElTramo(r: ResultadoTramo): boolean {
  return r.estado === "calculado" || r.estado === "tolerancia";
}

export type RepartoDelPago = {
  readonly aInteres: Monto;
  readonly aCapital: Monto;
  /** Lo que excede interés y capital pendientes: queda a cuenta, sin imputar. */
  readonly sobrante: Monto;
};

/**
 * Cómo se reparte un pago entre interés y capital, según el orden de imputación del barrio (T1).
 * «Intereses primero»: el pago cubre primero el interés y el resto va al capital. «Capital primero»:
 * cancela capital, y el interés queda como deuda.
 */
export function repartirPago(entrada: {
  readonly monto: Monto;
  readonly interes: Monto;
  readonly capital: Monto;
  readonly orden: OrdenImputacionBarrio;
}): RepartoDelPago {
  const monto = aCentavos(entrada.monto);
  const interes = aCentavos(entrada.interes);
  const capital = aCentavos(entrada.capital);
  if (monto < 0n || interes < 0n || capital < 0n) throw new Error("el pago, el interés y el capital no pueden ser negativos");
  const menor = (a: bigint, b: bigint) => (a < b ? a : b);
  let aInteres: bigint;
  let aCapital: bigint;
  if (entrada.orden === "intereses_primero_capital_antiguo") {
    aInteres = menor(monto, interes);
    aCapital = menor(monto - aInteres, capital);
  } else {
    aCapital = menor(monto, capital);
    aInteres = menor(monto - aCapital, interes);
  }
  return { aInteres: deCentavos(aInteres), aCapital: deCentavos(aCapital), sobrante: deCentavos(monto - aInteres - aCapital) };
}
