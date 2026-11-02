/**
 * Interés por mora con parámetros que cambian en el tiempo — dominio puro (ADR-0006).
 *
 * Portado del cálculo con vigencias de un sistema hermano de cobranzas (`interesDe`,
 * `interesDeTramo`, `interesPorCuota`), adaptado a cómo liquida este repo: **un saldo vencido por
 * unidad y una ventana de atraso uniforme** (`fechaCorte` y `diasDeAtraso`, ver `generarLiquidaciones`),
 * no un cronograma de cuotas.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LAS REGLAS
 *
 *  1. **Interés simple sobre el saldo**, por mes comercial de 30 días. La ventana va del día
 *     siguiente al inicio (`fechaCorte − diasDeAtraso`) hasta el corte, los dos inclusive.
 *  2. **Cada día devenga con la tasa (compensatoria + punitoria) y el «cobra» vigentes ESE día.** Una
 *     tasa nueva no se aplica a días anteriores a su fecha: eso sería retroactivo. Un día con
 *     «Cobra interés: No» no devenga.
 *  3. **La gracia, su forma y la tolerancia son las vigentes al inicio de la ventana** (panel de
 *     arquitectura, CAMBIO 3): el saldo anterior es un monto agrupado sin vencimiento propio, así que
 *     el inicio de la ventana es el único "vencimiento" que hay.
 *  4. **Se trunca UNA sola vez, al final**, a centavos. Igual que `calcularMora`: nunca se cobra un
 *     centavo no devengado, y con una sola vigencia el resultado es **idéntico** al cálculo anterior
 *     (es el test de paridad). El otro sistema redondeaba por tramo; eso no se portó.
 *  5. La punitoria se desglosa: `compensatorio` es el truncado de la parte compensatoria sola, y
 *     `punitorio` es la diferencia — así las dos partes suman exactamente el total.
 *
 * Nada de `number` para dinero: centavos en `bigint`, tasas en millonésimas enteras.
 */

import { aCentavos, deCentavos, type Monto } from "./dinero.ts";
import { tasaAMillonesimas, type FormaGracia } from "./parametros-mora.ts";

/** Lo que vale para un día. */
export type ParametrosDelDia = {
  readonly cobra: boolean;
  /** Fracción mensual: `"0.03"` = 3 %. */
  readonly tasaCompensatoria: string;
  readonly tasaPunitoria: string;
};

/** Lo que se fija al inicio de la ventana. */
export type ParametrosDeLaVentana = {
  readonly graciaDias: number;
  readonly formaGracia: FormaGracia;
  /** Un saldo menor o igual a esto se da por saldado y no devenga. */
  readonly tolerancia: Monto;
};

export type ParametrosMora = ParametrosDelDia & ParametrosDeLaVentana;

/** Los parámetros vigentes en cada fecha, y las fechas en las que cambian (ordenadas, sin repetir). */
export type VigenciasMora = {
  readonly en: (fecha: string) => ParametrosMora;
  readonly cambios: readonly string[];
};

/** Unos parámetros que no cambian nunca. */
export function vigenciasConstantes(p: ParametrosMora): VigenciasMora {
  return { en: () => p, cambios: [] };
}

export type ResultadoInteres =
  /** «Cobra interés: No» en toda la ventana y al corte: no se calculó nada, y eso se dice. */
  | { readonly estado: "no_se_cobra" }
  | {
      readonly estado: "calculado";
      readonly interes: Monto;
      readonly compensatorio: Monto;
      readonly punitorio: Monto;
      readonly diasAtraso: number;
      /** Días que devengaron de verdad (después de la gracia y con «cobra» en Sí). */
      readonly diasDevengados: number;
      /** Por qué dio cero, si dio cero. */
      readonly motivoCero: "sin_saldo" | "sin_dias" | "tolerancia" | "gracia" | "no_cobra" | null;
    };

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Fechas como número de día (sin `Date`, sin zona horaria)
// ────────────────────────────────────────────────────────────────────────────────────────────────

const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Días desde 1970-01-01 de una fecha `YYYY-MM-DD` (algoritmo de días civiles, proléptico gregoriano). */
export function numeroDeDia(iso: string): number {
  const m = FECHA.exec(iso);
  if (!m) throw new Error(`fecha inválida: ${iso}`);
  let y = Number.parseInt(m[1]!, 10);
  const mes = Number.parseInt(m[2]!, 10);
  const d = Number.parseInt(m[3]!, 10);
  if (mes < 1 || mes > 12 || d < 1 || d > 31) throw new Error(`fecha inválida: ${iso}`);
  y -= mes <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (mes + (mes > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const n = era * 146097 + doe - 719468;
  if (fechaDeDia(n) !== iso) throw new Error(`fecha inválida: ${iso}`);
  return n;
}

/** Al revés de `numeroDeDia`. */
export function fechaDeDia(n: number): string {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const mes = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (mes <= 2 ? 1 : 0);
  return `${String(y).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function sumarDias(iso: string, dias: number): string {
  return fechaDeDia(numeroDeDia(iso) + dias);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El cálculo
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** El mes comercial (30 días) por el millón de las millonésimas: el divisor común de todo. */
const DIVISOR = 1_000_000n * 30n;

/**
 * Interés de un saldo vencido en la ventana `(fechaCorte − diasDeAtraso, fechaCorte]`.
 *
 * Con «Cobra interés: Sí», gracia 0, tolerancia 0 y punitoria 0 en una sola vigencia, el resultado es
 * idéntico al centavo al de `calcularMora` (`liquidacion.ts`). Es una propiedad testeada, no un deseo.
 */
export function calcularInteresMora(entrada: {
  readonly saldoVencido: Monto;
  readonly fechaCorte: string;
  readonly diasDeAtraso: number;
  readonly vigencias: VigenciasMora;
}): ResultadoInteres {
  const { saldoVencido, fechaCorte, diasDeAtraso, vigencias } = entrada;
  if (!Number.isSafeInteger(diasDeAtraso) || diasDeAtraso < 0) {
    throw new Error("los días de atraso no pueden ser negativos");
  }
  const corte = numeroDeDia(fechaCorte);
  const inicio = corte - diasDeAtraso;
  const alInicio = vigencias.en(fechaDeDia(inicio));
  if (!Number.isSafeInteger(alInicio.graciaDias) || alInicio.graciaDias < 0) {
    throw new Error(`días de gracia inválidos: ${alInicio.graciaDias}`);
  }

  // Los tramos de la ventana completa: de un cambio de parámetros al siguiente.
  const primerDia = inicio + 1;
  const tramos: { desde: number; hasta: number; p: ParametrosDelDia }[] = [];
  if (diasDeAtraso > 0) {
    const cortes = vigencias.cambios
      .map(numeroDeDia)
      .filter((c) => c > primerDia && c <= corte)
      .sort((a, b) => a - b);
    let desde = primerDia;
    for (const c of [...cortes, corte + 1]) {
      if (c > desde) tramos.push({ desde, hasta: c - 1, p: vigencias.en(fechaDeDia(desde)) });
      desde = c;
    }
  }

  const cobraAlCorte = vigencias.en(fechaCorte).cobra;
  if (!cobraAlCorte && tramos.every((t) => !t.p.cobra)) return { estado: "no_se_cobra" };

  const cero = (motivo: NonNullable<Extract<ResultadoInteres, { estado: "calculado" }>["motivoCero"]>) =>
    ({
      estado: "calculado",
      interes: "0.00",
      compensatorio: "0.00",
      punitorio: "0.00",
      diasAtraso: diasDeAtraso,
      diasDevengados: 0,
      motivoCero: motivo,
    }) as const;

  const saldo = aCentavos(saldoVencido);
  if (saldo <= 0n) return cero("sin_saldo");
  if (diasDeAtraso === 0) return cero("sin_dias");
  if (saldo <= aCentavos(alInicio.tolerancia)) return cero("tolerancia");

  // Desde qué día devenga, según la forma de la gracia vigente al inicio.
  let devengaDesde: number;
  if (alInicio.formaGracia === "corre_inicio") {
    devengaDesde = primerDia + alInicio.graciaDias;
  } else {
    if (diasDeAtraso <= alInicio.graciaDias) return cero("gracia");
    devengaDesde = primerDia;
  }
  if (devengaDesde > corte) return cero("gracia");

  let sumaComp = 0n;
  let sumaPun = 0n;
  let diasDevengados = 0;
  for (const t of tramos) {
    const desde = Math.max(t.desde, devengaDesde);
    if (desde > t.hasta || !t.p.cobra) continue;
    const dias = BigInt(t.hasta - desde + 1);
    diasDevengados += t.hasta - desde + 1;
    sumaComp += saldo * tasaAMillonesimas(t.p.tasaCompensatoria) * dias;
    sumaPun += saldo * tasaAMillonesimas(t.p.tasaPunitoria) * dias;
  }

  const interes = (sumaComp + sumaPun) / DIVISOR;
  const compensatorio = sumaComp / DIVISOR;
  return {
    estado: "calculado",
    interes: deCentavos(interes),
    compensatorio: deCentavos(compensatorio),
    punitorio: deCentavos(interes - compensatorio),
    diasAtraso: diasDeAtraso,
    diasDevengados,
    motivoCero: interes > 0n ? null : diasDevengados === 0 ? "no_cobra" : null,
  };
}
