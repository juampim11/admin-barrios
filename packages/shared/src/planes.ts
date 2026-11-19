/**
 * Planes de pago — cálculo puro, sin E/S. Portado del motor de convenios de Aclade
 * (`aclade-cobranzas`), y pasado de centavos `number` a `bigint` por dentro y `Monto` por fuera.
 *
 * Origen, archivo por archivo:
 *  - `repartirEnCuotas`: `src/domain/dinero/reparto.ts` L9-18 (R3: N−1 cuotas al piso y la última
 *    absorbe la diferencia). Tope de cuotas: acá 60 (el del convenio, `convenio.ts` L26), no 1200.
 *  - Cuota francesa: `src/domain/dinero/cronograma.ts` L320-335 (`cuotasFinanciadas`, modelo
 *    `frances`): cuota = P·a·(a+b)^n / (b·((a+b)^n − b^n)) con i = a/b, exacta en BigInt, redondeada
 *    al centavo con R2 (`centavos.ts` L128-134, medio centavo hacia arriba). **Aclade no usa float**
 *    para la potencia: la fracción es exacta, así que no hizo falta una escala fija.
 *  - `vencimientoDeCuota`: `src/domain/plan/convenio.ts` L100-108 (mismo día de cada mes, o el
 *    último del mes si no existe). Acá sin `Date`: el último día del mes sale de aritmética pura.
 *  - Mensajes de rechazo y la clase de error: `convenio.ts` L79-87 (`ConvenioInvalido` → `PlanInvalido`).
 *
 * Diferencias con Aclade (y por qué):
 *  - **Capital e interés por cuota.** Aclade guarda solo el importe de la cuota francesa. Acá cada cuota
 *    lleva su amortización (`capital`) y su `interes` de financiación, por el método francés: el interés
 *    de la cuota k es R2(saldo × i) y el capital es la cuota menos ese interés. La última cuota amortiza
 *    exactamente el saldo que queda, así el capital de todas suma lo financiado al centavo.
 *    El **importe** de todas las cuotas (también la última) es la cuota francesa de Aclade: el
 *    redondeo que acumulan los intereses lo absorbe el interés de la última, no su importe. Así el
 *    total del plan es N × cuota, igual que en Aclade y que la maqueta (12 × 114.285,69).
 *    Se descartó la otra variante («la última cuota = saldo + R2(saldo × i)»): en el caso de la
 *    maqueta da una última cuota de 114.285,67 y un total 2 centavos menor que el de Aclade.
 *    Única excepción: con tasas y montos ínfimos el interés de la última daría negativo; entonces
 *    la última cuota baja al saldo, con interés 0.
 *  - **Sin día hábil.** Aclade corre el vencimiento al próximo día hábil con su calendario de
 *    feriados; acá no hay calendario de feriados en `shared`, y el vencimiento queda nominal.
 *  - **Sin periodicidad.** Siempre mensual (Aclade admite bimestral y trimestral).
 *  - **Anticipo.** En Aclade vence el día de la firma (`hoy`); acá esa fecha la pasa quien llama en
 *    `vencimientoAnticipo`, y es obligatoria si hay anticipo (no se inventa una fecha).
 *  - **Quita a medida.** `cuadreAMedida` no existe en Aclade (allá la quita se elige y el cronograma
 *    sale de ella); acá es al revés: se carga el cronograma y la quita es lo que falta para la deuda,
 *    imputada primero al interés y después al capital.
 */

import { z } from "zod";
import { idSchema } from "./consultas.ts";
import { aCentavos, deCentavos, montoSchema, type Monto } from "./dinero.ts";

/** Máximo de cuotas de un plan (sin contar el anticipo). Aclade: `CUOTAS_MAXIMAS_CONVENIO`. */
export const CUOTAS_MAXIMAS_PLAN = 60;

export class PlanInvalido extends RangeError {
  override name = "PlanInvalido";
}

const fallar = (mensaje: string): never => {
  throw new PlanInvalido(mensaje);
};

/** Una cuota del plan. `numero` 0 es el anticipo; 1..N son las cuotas. */
export type CuotaDePlan = {
  numero: number;
  /** `YYYY-MM-DD`. */
  vencimiento: string;
  /** capital + interes. */
  importe: Monto;
  /** Amortización de lo financiado (o el anticipo entero, en la cuota 0). */
  capital: Monto;
  /** Interés de financiación de la cuota ("0.00" sin interés). */
  interes: Monto;
  /**
   * La parte de `capital` que es mora de la deuda original (no devenga mora si la cuota queda impaga).
   * Solo la pone `cronogramaDeCatalogo`; los cronogramas sueltos no la conocen.
   */
  moraIncluida?: Monto;
};

export type CronogramaDePlan = {
  cuotas: CuotaDePlan[];
  /** Suma de los importes (anticipo incluido). */
  total: Monto;
  /** total − deuda. */
  interesFinanciacion: Monto;
};

export type EntradaCuotaFija = {
  deuda: Monto;
  anticipo: Monto | null;
  cuotas: number;
  primerVencimiento: string;
  /** Obligatoria si hay anticipo. */
  vencimientoAnticipo?: string;
};

export type EntradaFrances = EntradaCuotaFija & {
  /** Tasa MENSUAL, decimal: `"0.02"` = 2 %. */
  tasaMensual: string;
};

// --- Aritmética --------------------------------------------------------------------------------

/** R2 de Aclade: `monto × num / den` redondeado al centavo, medio centavo hacia arriba. Solo ≥ 0. */
function multiplicarRedondeando(monto: bigint, num: bigint, den: bigint): bigint {
  return (2n * monto * num + den) / (2n * den);
}

/** `"0.02"` → { num: 2n, den: 100n }. Decimal no negativo, sin exponentes. */
function tasaAFraccion(tasa: string): { num: bigint; den: bigint } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(tasa);
  if (!m) return fallar(`La tasa mensual se escribe como decimal, por ejemplo 0.02 para 2 %: «${tasa}»`);
  const decimales = m[2] ?? "";
  return { num: BigInt(m[1]! + decimales), den: 10n ** BigInt(decimales.length) };
}

// --- Fechas (sin Date) -------------------------------------------------------------------------

function esBisiesto(anio: number): boolean {
  return (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0;
}

function ultimoDiaDelMes(anio: number, mes: number): number {
  if (mes === 2) return esBisiesto(anio) ? 29 : 28;
  return [4, 6, 9, 11].includes(mes) ? 30 : 31;
}

function validarFecha(fecha: string, nombre: string): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  const anio = Number(m?.[1]);
  const mes = Number(m?.[2]);
  const dia = Number(m?.[3]);
  if (!m || mes < 1 || mes > 12 || dia < 1 || dia > ultimoDiaDelMes(anio, mes)) {
    fallar(`${nombre}: la fecha no existe o no está en formato AAAA-MM-DD («${fecha}»)`);
  }
}

/**
 * Fecha de la cuota `j` (0 = la primera): el mismo día del mes que `primero`, o el último día del
 * mes si ese día no existe (31/01 → 28/02 → 31/03). Aclade `convenio.ts` L100-108, mensual.
 */
export function vencimientoDeCuota(primero: string, j: number): string {
  const anio = Number(primero.slice(0, 4));
  const mes0 = Number(primero.slice(5, 7)) - 1 + j;
  const dia = Number(primero.slice(8, 10));
  const a = anio + Math.floor(mes0 / 12);
  const m = (mes0 % 12) + 1;
  const d = Math.min(dia, ultimoDiaDelMes(a, m));
  return `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// --- Reparto ------------------------------------------------------------------------------------

function validarCantidad(cantidad: number): void {
  if (!Number.isSafeInteger(cantidad) || cantidad < 1 || cantidad > CUOTAS_MAXIMAS_PLAN) {
    fallar(`Las cuotas son un número entero de 1 a ${CUOTAS_MAXIMAS_PLAN}`);
  }
}

function repartirCentavos(total: bigint, cantidad: number): bigint[] {
  validarCantidad(cantidad);
  if (total < 0n) fallar("No se reparte un total negativo");
  const n = BigInt(cantidad);
  const base = total / n;
  const cuotas = Array.from({ length: cantidad }, () => base);
  cuotas[cantidad - 1] = total - base * (n - 1n);
  return cuotas;
}

/**
 * R3 (Aclade `reparto.ts` L9-18): reparte `total` en `cantidad` cuotas. Las N−1 primeras valen el
 * piso de total/N y la última absorbe la diferencia: la suma da el total exacto.
 */
export function repartirEnCuotas(total: Monto, cantidad: number): Monto[] {
  return repartirCentavos(aCentavos(total), cantidad).map(deCentavos);
}

// --- Cronogramas --------------------------------------------------------------------------------

type CuotaCentavos = { capital: bigint; interes: bigint };

function armar(
  entrada: EntradaCuotaFija,
  financiar: (financiado: bigint, n: number) => CuotaCentavos[],
): CronogramaDePlan {
  const deuda = aCentavos(entrada.deuda);
  const anticipo = entrada.anticipo === null ? 0n : aCentavos(entrada.anticipo);
  if (deuda <= 0n) fallar("La deuda del plan tiene que ser mayor a cero");
  if (anticipo < 0n) fallar("El anticipo no puede ser negativo");
  if (anticipo >= deuda) fallar("El anticipo tiene que ser menor que la deuda");
  validarCantidad(entrada.cuotas);
  validarFecha(entrada.primerVencimiento, "Primer vencimiento");

  const cuotas: CuotaDePlan[] = [];
  if (anticipo > 0n) {
    if (entrada.vencimientoAnticipo === undefined) fallar("Falta la fecha de vencimiento del anticipo");
    validarFecha(entrada.vencimientoAnticipo!, "Vencimiento del anticipo");
    const a = deCentavos(anticipo);
    cuotas.push({ numero: 0, vencimiento: entrada.vencimientoAnticipo!, importe: a, capital: a, interes: "0.00" });
  }
  const financiado = deuda - anticipo;
  financiar(financiado, entrada.cuotas).forEach(({ capital, interes }, j) => {
    cuotas.push({
      numero: j + 1,
      vencimiento: vencimientoDeCuota(entrada.primerVencimiento, j),
      importe: deCentavos(capital + interes),
      capital: deCentavos(capital),
      interes: deCentavos(interes),
    });
  });
  validarCronograma(cuotas);

  const total = cuotas.reduce((s, c) => s + aCentavos(c.importe), 0n);
  return { cuotas, total: deCentavos(total), interesFinanciacion: deCentavos(total - deuda) };
}

/** Cuota fija sin interés: lo financiado (deuda − anticipo) en N cuotas iguales; la última ajusta. */
export function cronogramaCuotaFija(entrada: EntradaCuotaFija): CronogramaDePlan & { interesFinanciacion: "0.00" } {
  const plan = armar(entrada, (financiado, n) => repartirCentavos(financiado, n).map((capital) => ({ capital, interes: 0n })));
  return { ...plan, interesFinanciacion: "0.00" };
}

/**
 * Sistema francés con tasa mensual. Importe de cada cuota = cuota francesa de Aclade
 * (`cronograma.ts` L326-331), exacta en fracción BigInt y redondeada con R2. Cada cuota se abre en
 * interés = R2(saldo × i) y capital = cuota − interés; la última amortiza el saldo exacto y su
 * interés es la cuota menos ese saldo. Con tasa 0 da lo mismo que `cronogramaCuotaFija`.
 */
export function cronogramaFrances(entrada: EntradaFrances): CronogramaDePlan {
  const { num: a, den: b } = tasaAFraccion(entrada.tasaMensual);
  if (a === 0n) return cronogramaCuotaFija(entrada);
  return armar(entrada, (financiado, n) => frances(financiado, n, a, b));
}

/** El sistema francés sobre `financiado`, en centavos (tasa `a/b` mensual, `a > 0`). */
function frances(financiado: bigint, n: number, a: bigint, b: bigint): CuotaCentavos[] {
  {
    const potencia = (a + b) ** BigInt(n);
    const cuota = multiplicarRedondeando(financiado, a * potencia, b * (potencia - b ** BigInt(n)));
    if (cuota === 0n) fallar("Con tantas cuotas, alguna queda en cero: elegí menos cuotas");
    const salida: CuotaCentavos[] = [];
    let saldo = financiado;
    for (let k = 1; k <= n; k++) {
      const interesDelSaldo = multiplicarRedondeando(saldo, a, b);
      if (k < n) {
        const capital = cuota - interesDelSaldo;
        // Con una tasa que hace que la cuota no cubra el interés no hay plan que amortice.
        if (capital <= 0n || capital > saldo) fallar("La cuota no alcanza a amortizar la deuda: revisá la tasa o las cuotas");
        salida.push({ capital, interes: interesDelSaldo });
        saldo -= capital;
      } else {
        // Última: amortiza el saldo exacto y mantiene el importe de la cuota francesa; el redondeo
        // acumulado (unos centavos) lo absorbe su interés. Solo con tasas y montos ínfimos ese
        // interés daría negativo: entonces la última cuota baja al saldo, con interés 0 (nunca se
        // cobra un interés negativo ni más capital del que se financió).
        const interes = cuota - saldo;
        salida.push(interes >= 0n ? { capital: saldo, interes } : { capital: saldo, interes: 0n });
      }
    }
    return salida;
  }
}

/**
 * El cronograma de un plan del CATÁLOGO, con la mora de la deuda que entra marcada en cada cuota
 * (`moraIncluida`), según `financiaMora` del barrio (0094):
 *
 * - `true` (P1): se financia capital + mora; la mora va en la amortización de la primera cuota en
 *   adelante (el anticipo primero).
 * - `false`: el anticipo cubre primero la mora; el interés del francés corre solo sobre el capital que
 *   queda, y la mora restante se reparte en partes iguales entre las cuotas, sin interés (la última
 *   ajusta los centavos). En cuota fija sin interés cambia solo el reparto de la mora, no los importes.
 */
export type EntradaDeCatalogo = EntradaCuotaFija & {
  readonly sistema: "fija" | "frances";
  /** Solo francés. */
  readonly tasaMensual?: string;
  /** La mora a la firma incluida en `deuda` (deuda = capital + mora). */
  readonly mora: Monto;
  readonly financiaMora: boolean;
};

export function cronogramaDeCatalogo(e: EntradaDeCatalogo): CronogramaDePlan {
  const mora = aCentavos(e.mora);
  const deuda = aCentavos(e.deuda);
  if (mora < 0n || mora > deuda) fallar("La mora del plan tiene que estar entre cero y la deuda");
  const tasa = e.sistema === "frances" ? tasaAFraccion(e.tasaMensual ?? "0") : { num: 0n, den: 1n };

  if (e.financiaMora || tasa.num === 0n) {
    const plan = tasa.num === 0n ? cronogramaCuotaFija(e) : cronogramaFrances({ ...e, tasaMensual: e.tasaMensual! });
    if (e.financiaMora) {
      // De la primera cuota (el anticipo, si hay) en adelante.
      let resto = mora;
      return {
        ...plan,
        cuotas: plan.cuotas.map((c) => {
          const m = resto < aCentavos(c.capital) ? resto : aCentavos(c.capital);
          resto -= m;
          return { ...c, moraIncluida: deCentavos(m) };
        }),
      };
    }
    // Cuota fija sin financiar la mora: mismos importes, la mora en partes iguales.
    return { ...plan, cuotas: repartirMora(plan.cuotas, mora) };
  }

  // Francés sin financiar la mora: el anticipo cubre primero la mora.
  const anticipo = e.anticipo === null ? 0n : aCentavos(e.anticipo);
  const moraDelAnticipo = anticipo < mora ? anticipo : mora;
  const capitalFinanciado = deuda - mora - (anticipo - moraDelAnticipo);
  const moraEnCuotas = mora - moraDelAnticipo;
  const plan = armar(e, (financiado, n) => {
    if (financiado !== capitalFinanciado + moraEnCuotas) fallar("El plan no cuadra con la deuda");
    // Con menos centavos de capital que cuotas, el francés daría alguna cuota en cero: ese capital ínfimo
    // se reparte sin interés (no hay interés que cobrar sobre unos centavos).
    const amortizacion =
      capitalFinanciado >= BigInt(n)
        ? frances(capitalFinanciado, n, tasa.num, tasa.den)
        : repartirCentavos(capitalFinanciado, n).map((capital) => ({ capital, interes: 0n }));
    const moraDeCadaUna = repartirCentavos(moraEnCuotas, n);
    return amortizacion.map((c, j) => ({ capital: c.capital + moraDeCadaUna[j]!, interes: c.interes }));
  });
  return { ...plan, cuotas: repartirMora(plan.cuotas, mora) };
}

/** `moraIncluida`: el anticipo primero (hasta su importe) y el resto en partes iguales entre las cuotas. */
function repartirMora(cuotas: readonly CuotaDePlan[], mora: bigint): CuotaDePlan[] {
  const anticipo = cuotas.find((c) => c.numero === 0);
  const delAnticipo = anticipo ? (aCentavos(anticipo.capital) < mora ? aCentavos(anticipo.capital) : mora) : 0n;
  const resto = mora - delAnticipo;
  const n = cuotas.filter((c) => c.numero > 0).length;
  const partes = repartirCentavos(resto, n);
  let j = 0;
  return cuotas.map((c) => {
    if (c.numero === 0) return { ...c, moraIncluida: deCentavos(delAnticipo) };
    const m = partes[j++]!;
    if (m > aCentavos(c.capital)) fallar("La mora de una cuota no puede superar su amortización");
    return { ...c, moraIncluida: deCentavos(m) };
  });
}

// --- Validación y cuadre -----------------------------------------------------------------------

/**
 * Valida un cronograma: de 1 a 60 cuotas (el anticipo, `numero` 0, no cuenta), importes mayores a
 * cero, fechas válidas y vencimientos estrictamente crecientes. Lanza `PlanInvalido`.
 */
export function validarCronograma(cronograma: readonly { numero?: number; vencimiento: string; importe: Monto }[]): void {
  const cantidad = cronograma.filter((c) => c.numero !== 0).length;
  if (cantidad < 1 || cantidad > CUOTAS_MAXIMAS_PLAN) fallar(`Las cuotas son de 1 a ${CUOTAS_MAXIMAS_PLAN}`);
  cronograma.forEach((c, i) => {
    const nombre = c.numero === 0 ? "El anticipo" : `La cuota ${c.numero ?? i + 1}`;
    validarFecha(c.vencimiento, `Vencimiento de ${nombre.toLowerCase()}`);
    let importe: bigint;
    try {
      importe = aCentavos(c.importe);
    } catch {
      return fallar(`${nombre}: el importe no es válido («${c.importe}»)`);
    }
    if (importe <= 0n) fallar(`${nombre}: el importe tiene que ser mayor a cero`);
    const anterior = cronograma[i - 1];
    if (anterior && c.vencimiento <= anterior.vencimiento) fallar(`${nombre} tiene que vencer después de la anterior`);
  });
}

export type CuadreAMedida = {
  /** Suma de los importes del cronograma. */
  financiado: Monto;
  quitaInteres: Monto;
  quitaCapital: Monto;
  quitaTotal: Monto;
  /** quitaTotal / deuda × 100, con un decimal, medio hacia arriba: `"17.3"`. */
  porcentajeQuita: string;
  /** El cronograma suma más que la deuda: no se prohíbe, se informa (las quitas quedan en 0). */
  excede: boolean;
};

/**
 * Plan a medida: el cronograma lo carga la persona y la quita es lo que falta para la deuda.
 * deuda = financiado + quitaInteres + quitaCapital; el perdón va primero al interés y después al capital.
 */
export function cuadreAMedida(
  deuda: { capital: Monto; interes: Monto },
  cronograma: readonly { vencimiento: string; importe: Monto }[],
): CuadreAMedida {
  const capital = aCentavos(deuda.capital);
  const interes = aCentavos(deuda.interes);
  if (capital < 0n || interes < 0n) fallar("El capital y el interés de la deuda no pueden ser negativos");
  const total = capital + interes;
  const financiado = cronograma.reduce((s, c) => s + aCentavos(c.importe), 0n);
  const quitaTotal = financiado >= total ? 0n : total - financiado;
  const quitaInteres = quitaTotal < interes ? quitaTotal : interes;
  const quitaCapital = quitaTotal - quitaInteres;
  // Décimas de punto: quita × 1000 / total, medio hacia arriba.
  const decimas = total === 0n ? 0n : multiplicarRedondeando(quitaTotal, 1000n, total);
  return {
    financiado: deCentavos(financiado),
    quitaInteres: deCentavos(quitaInteres),
    quitaCapital: deCentavos(quitaCapital),
    quitaTotal: deCentavos(quitaTotal),
    porcentajeQuita: `${decimas / 10n}.${decimas % 10n}`,
    excede: financiado > total,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// F4 tramo 2 (BL-055 a): la tasa mensual equivalente de un plan a medida que cobra más que la deuda
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** El tope de tasa equivalente de un plan a medida si la administración no cargó otro: el del catálogo. */
export const TOPE_TASA_A_MEDIDA_POR_DEFECTO = "0.100000";

/** Escala de la tasa durante el cálculo: cienmillonésimas (1e-8) de la fracción. */
const ESCALA_TASA = 100000000n;

/**
 * El signo de `VP(i) − deuda`, exacto con enteros: la misma convención del catálogo (sistema francés,
 * tasa mensual efectiva, una cuota por período). El anticipo (cuota 0) va en el período 0 y la cuota k en
 * el período k, **por su número, no por su fecha** — igual que `cronogramaFrances`, donde la primera cuota
 * lleva un mes de interés aunque venza antes o después. Así, un cronograma francés del catálogo al 2 %
 * da exactamente 2 % (salvo el redondeo al centavo de sus cuotas).
 *
 *   VP(i) = Σ importe_k / (1 + i)^k    →    se compara  Σ importe_k · S^k · (S + i)^(T − k)  con  deuda · (S + i)^T
 *
 * (todo multiplicado por S^T · (1 + i)^T, con i en escala S y T el número de la última cuota): sin
 * flotantes ni redondeos intermedios.
 */
function signoDelValorPresente(deuda: bigint, cuotas: readonly { k: bigint; importe: bigint }[], i: bigint): number {
  const T = cuotas.reduce((m, c) => (c.k > m ? c.k : m), 0n);
  const base = ESCALA_TASA + i;
  let vp = 0n;
  for (const c of cuotas) vp += c.importe * ESCALA_TASA ** c.k * base ** (T - c.k);
  const d = deuda * base ** T;
  return vp > d ? 1 : vp < d ? -1 : 0;
}

function cuotasParaLaTasa(cronograma: readonly { numero: number; importe: Monto }[]) {
  return cronograma.map((c) => ({ k: BigInt(c.numero), importe: aCentavos(c.importe) }));
}

export type TasaEquivalente = {
  /** Lo que el cronograma cobra de más sobre la deuda. */
  readonly excedente: Monto;
  /** La tasa mensual equivalente como fracción, con seis decimales y medio hacia arriba: `"0.023457"`. */
  readonly tasa: string;
  /** La misma, en porcentaje con dos decimales y coma, para mostrar: `"2,35"`. */
  readonly porcentaje: string;
  /**
   * Redondeada **hacia arriba** a la centésima de punto: para decir que pasa un tope sin que se lea como si
   * estuviera adentro (10,004 % contra un tope de 10 % se muestra «10,01 %», no «10,00 %»).
   */
  readonly porcentajeHaciaArriba: string;
};

/** Más allá de esto (100.000 % mensual) la búsqueda se corta: no es un cronograma, es un error de carga. */
const TASA_MAXIMA_BUSCADA = 1000n * ESCALA_TASA;

/** El anticipo (cuota 0) no se descuenta: si ya cubre la deuda, todo lo demás es interés y no hay tasa. */
function anticipoCubreLaDeuda(deuda: bigint, cuotas: readonly { k: bigint; importe: bigint }[]): boolean {
  return cuotas.filter((c) => c.k === 0n).reduce((s, c) => s + c.importe, 0n) >= deuda;
}

const textoDeCentesimas = (c: bigint) => `${c / 100n},${(c % 100n).toString().padStart(2, "0")}`;

/**
 * La tasa mensual a la que el cronograma de un plan a medida devuelve la deuda: la `i` con
 * `VP(i) = deuda` (ver `signoDelValorPresente` para la convención). `null` si el cronograma no suma más que
 * la deuda (no hay interés que medir). Bisección sobre enteros hasta 1e-8; el resultado se redondea a la
 * millonésima (medio hacia arriba) y a la centésima de punto para mostrar.
 *
 * Lanza `PlanInvalido` si el anticipo solo ya cubre la deuda (el valor presente nunca baja de él: no hay
 * tasa que lo iguale; code-reviewer, B1) o si la tasa pasa el 100.000 % mensual. Ninguno de los dos es un
 * plan, y la búsqueda no puede quedar abierta.
 */
export function tasaMensualEquivalente(deuda: Monto, cronograma: readonly { numero: number; importe: Monto }[]): TasaEquivalente | null {
  const d = aCentavos(deuda);
  const cuotas = cuotasParaLaTasa(cronograma);
  const financiado = cuotas.reduce((s, c) => s + c.importe, 0n);
  if (d <= 0n || financiado <= d) return null;
  if (anticipoCubreLaDeuda(d, cuotas)) fallar("El anticipo ya cubre la deuda: lo que cobran las cuotas es todo de más. Ajustá las cuotas.");
  let bajo = 0n;
  let alto = ESCALA_TASA;
  while (signoDelValorPresente(d, cuotas, alto) > 0) {
    if (alto >= TASA_MAXIMA_BUSCADA) fallar("Las cuotas cobran mucho más que la deuda: revisá los importes.");
    alto *= 2n;
  }
  while (alto - bajo > 1n) {
    const medio = (bajo + alto) / 2n;
    if (signoDelValorPresente(d, cuotas, medio) >= 0) bajo = medio;
    else alto = medio;
  }
  const millonesimas = (bajo + 50n) / 100n;
  return {
    excedente: deCentavos(financiado - d),
    tasa: `${millonesimas / 1000000n}.${(millonesimas % 1000000n).toString().padStart(6, "0")}`,
    porcentaje: textoDeCentesimas((bajo + 5000n) / 10000n),
    // La raíz está en (bajo, alto] salvo que `bajo` ya la sea exacta (el VP da justo la deuda).
    porcentajeHaciaArriba: textoDeCentesimas(((signoDelValorPresente(d, cuotas, bajo) === 0 ? bajo : alto) + 9999n) / 10000n),
  };
}

/**
 * Si la tasa equivalente del cronograma pasa el tope (`"0.100000"` = 10 % mensual). Exacto: se evalúa el
 * valor presente **a la tasa del tope** — si todavía supera la deuda, la tasa equivalente es mayor. Justo
 * en el tope, no lo pasa. Un anticipo que ya cubre la deuda (con más cuotas) pasa cualquier tope.
 */
export function superaElTopeDeTasa(deuda: Monto, cronograma: readonly { numero: number; importe: Monto }[], tope: string): boolean {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(tope);
  if (!m) return fallar(`El tope de tasa se escribe como fracción con hasta seis decimales: «${tope}»`);
  const millonesimas = BigInt(m[1]!) * 1000000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  const d = aCentavos(deuda);
  const cuotas = cuotasParaLaTasa(cronograma);
  if (cuotas.reduce((s, c) => s + c.importe, 0n) <= d) return false;
  if (anticipoCubreLaDeuda(d, cuotas)) return true;
  return signoDelValorPresente(d, cuotas, millonesimas * (ESCALA_TASA / 1000000n)) > 0;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Los parámetros de las escrituras (encargo P1): forma; las reglas las hacen el servicio y la base
// ────────────────────────────────────────────────────────────────────────────────────────────────

const fechaPlanSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (AAAA-MM-DD).");
const montoPositivoSchema = montoSchema.refine((m) => aCentavos(m) > 0n, "El importe tiene que ser mayor que cero.");

export const ESTADOS_PLAN = ["pendiente", "vigente", "rechazado", "retirado", "cumplido", "caido"] as const;
export type EstadoPlan = (typeof ESTADOS_PLAN)[number];

/**
 * F4 tramo 2: una confirmación explícita (el reintento después de un `…_requiere_confirmacion`). Lista
 * cerrada de lo que cuenta como «sí»; cualquier otra cosa, o la ausencia, es «no confirmó» (mismo
 * criterio que `confirmacionExplicitaSchema` de `escrituras.ts`).
 */
const confirmacionSchema = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === "true" || v === "on" || v === "1")
  .default(false);

/** Un plan del catálogo: el sistema arma las cuotas con la deuda de la firma. */
export const proponerPlanDeCatalogoSchema = z.object({
  unidadFuncionalId: idSchema,
  liquidacionIds: z.array(idSchema).min(1, "Elegí al menos un mes.").max(240),
  catalogoId: idSchema,
  cuotas: z.number().int().min(1).max(CUOTAS_MAXIMAS_PLAN),
  anticipo: montoSchema.nullable().default(null),
  vencimientoAnticipo: fechaPlanSchema.nullable().default(null),
  primerVencimiento: fechaPlanSchema,
  /**
   * La fecha de firma del acuerdo, si se carga después de firmado (default: hoy). No puede ser futura
   * ni anterior a un pago de la unidad: la mora se cierra a esa fecha y nada se recalcula hacia atrás.
   */
  fecha: fechaPlanSchema.nullable().default(null),
  /**
   * [P2a-2] Quién cobra, si se cambia el del plan del catálogo (pantalla 2). null: el del catálogo. El
   * estudio, solo si el plan del catálogo tiene uno (es el que cobra y rinde).
   */
  modoCobro: z.enum(["barrio", "estudio"]).nullable().default(null),
  /** F4 tramo 2: la unidad está derivada a un estudio y al firmar sale de él: quien firma lo confirmó. */
  confirmarDerivada: confirmacionSchema,
});
export type ProponerPlanDeCatalogo = z.input<typeof proponerPlanDeCatalogoSchema>;

/** [P2a-2] Un adjunto del acta sin su referencia no sirve: la regla de todos los esquemas con acta. */
function conActaCompleta(v: { readonly actaReferencia: string | null; readonly actaAdjunto: string | null }, ctx: z.RefinementCtx): void {
  if (v.actaAdjunto !== null && v.actaReferencia === null) {
    ctx.addIssue({ code: "custom", path: ["actaReferencia"], message: "Poné la referencia del acta (número y fecha)." });
  }
}

/** Un plan a medida: el cronograma lo carga quien lo arma; el sistema solo controla el cuadre. */
export const proponerPlanAMedidaSchema = z.object({
  unidadFuncionalId: idSchema,
  liquidacionIds: z.array(idSchema).min(1, "Elegí al menos un mes.").max(240),
  cronograma: z
    .array(z.object({ numero: z.number().int().min(0).max(CUOTAS_MAXIMAS_PLAN), vencimiento: fechaPlanSchema, importe: montoPositivoSchema }))
    .min(1)
    .max(CUOTAS_MAXIMAS_PLAN + 1),
  modoCobro: z.enum(["barrio", "estudio"]).default("barrio"),
  estudioId: idSchema.nullable().default(null),
  motivo: z.string().trim().min(1, "Contá el motivo del acuerdo.").max(1000),
  /** [P2a-2] El acta de aprobación del barrio, si ya está (la exige el barrio para una quita: `0094`/`0095`). */
  actaReferencia: z.string().trim().min(3).max(300).nullable().default(null),
  /** Storage key de una subida de respaldo del barrio. */
  actaAdjunto: z.string().max(300).nullable().default(null),
  /** F4 tramo 2: el cronograma cobra más que la deuda; quien lo arma vio el importe y la tasa y confirmó. */
  confirmarExcedente: confirmacionSchema,
  /**
   * El importe de más que se le mostró al pedir la confirmación (`datos.cifras`). Si al reintentar ya no es
   * ese —se cambiaron las cuotas—, se vuelve a preguntar. null: quien llama no pasa por una pantalla.
   */
  cifrasConfirmadas: z.string().max(40).nullable().default(null),
}).superRefine((v, ctx) => conActaCompleta(v, ctx));
export type ProponerPlanAMedida = z.input<typeof proponerPlanAMedidaSchema>;

export const cerrarPlanSchema = z.object({
  planId: idSchema,
  motivo: z.string().trim().min(1, "Contá el motivo.").max(500),
});
export type CerrarPlan = z.input<typeof cerrarPlanSchema>;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// P2a-1: el catálogo de la administración y las reglas de cada barrio (pantalla 1)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export const SISTEMAS_DE_CATALOGO = ["fija", "frances"] as const;
export type SistemaDeCatalogo = (typeof SISTEMAS_DE_CATALOGO)[number];
export const TEXTO_SISTEMA: Record<SistemaDeCatalogo | "libre", string> = {
  fija: "Cuota fija, sin interés",
  frances: "Francés (con interés)",
  libre: "A medida",
};
export const ANTICIPOS_DE_CATALOGO = ["no", "opcional", "obligatorio"] as const;
export type AnticipoDeCatalogo = (typeof ANTICIPOS_DE_CATALOGO)[number];
export const MODOS_DE_COBRO = ["barrio", "estudio"] as const;
export type ModoDeCobro = (typeof MODOS_DE_COBRO)[number];
export const TEXTO_MODO_DE_COBRO: Record<ModoDeCobro, string> = {
  barrio: "El barrio, en la boleta",
  estudio: "El estudio, y rinde al barrio",
};
/**
 * Qué va primero cuando un pago no dice a qué va y la unidad debe cuotas de un plan y expensas (F4
 * tramo 1, BL-055 e; `0098`). Valor general de la administración, con reemplazo por barrio. La base
 * vuelve a controlar los cuatro valores (`plan_parametro_*_orden_chk`) y aplica el orden en
 * `app.resolver_imputacion`.
 */
export const ORDENES_DE_IMPUTACION = ["mas_vieja_primero", "cuota_primero", "expensa_primero", "a_eleccion"] as const;
export type OrdenDeImputacion = (typeof ORDENES_DE_IMPUTACION)[number];
export const TEXTO_ORDEN_DE_IMPUTACION: Record<OrdenDeImputacion, string> = {
  mas_vieja_primero: "La más vieja primero",
  cuota_primero: "Primero la cuota del plan",
  expensa_primero: "Primero la expensa",
  a_eleccion: "A elección de quien registra",
};
/** El valor general cuando la administración no cargó ninguno. */
export const ORDEN_DE_IMPUTACION_POR_DEFECTO: OrdenDeImputacion = "mas_vieja_primero";
/** En el reemplazo del barrio: no tiene valor propio y usa el de la administración. */
export const ORDEN_COMO_LA_ADMINISTRACION = "administracion" as const;
export const TEXTO_ORDEN_COMO_LA_ADMINISTRACION = "Como la administración";

/**
 * Lo que puede elegir quien registra un pago a mano en un barrio «a elección» (`pago.orden_plan_elegido`).
 * La más vieja primero va preseleccionada.
 */
export const ORDENES_ELEGIBLES_AL_REGISTRAR = ["mas_vieja_primero", "cuota_primero", "expensa_primero"] as const;
export type OrdenElegibleAlRegistrar = (typeof ORDENES_ELEGIBLES_AL_REGISTRAR)[number];
export const ordenElegibleAlRegistrarSchema = z.enum(ORDENES_ELEGIBLES_AL_REGISTRAR, { message: "Elegí qué se paga primero." });


/** Un porcentaje escrito como en pantalla (`2`, `2,5`, `30`), entre 0 y 100, hasta 4 decimales. */
const porcentajeSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}([.,]\d{1,4})?$/, "Escribí un porcentaje, por ejemplo 2 o 2,5.")
  .refine((t) => Number.parseFloat(t.replace(",", ".")) <= 100, "Hasta 100 %.");

const opcional = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), s.nullable()).default(null);

/**
 * Las reglas generales de los planes de la administración (Configuración general › Planes de pago): el
 * orden de imputación entre la cuota y la expensa (F4 tramo 1) y el tope de tasa mensual equivalente de un
 * plan a medida (F4 tramo 2), como se escribe en pantalla (`10`, `7,5`).
 */
export const guardarReglasGeneralesDePlanesSchema = z.object({
  administracionId: idSchema,
  ordenImputacion: z.enum(ORDENES_DE_IMPUTACION, { message: "Elegí el orden." }),
  topeTasaPorcentaje: porcentajeSchema.refine((t) => Number.parseFloat(t.replace(",", ".")) > 0, "Mayor que cero."),
});
export type GuardarReglasGeneralesDePlanes = z.input<typeof guardarReglasGeneralesDePlanesSchema>;

/**
 * Alta o edición de un plan del catálogo. Las tasas y los porcentajes viajan como se escriben (`2`,
 * `2,5`); el servicio los pasa a fracción con `tasaDePorcentaje`. El resto lo vuelve a controlar la base.
 */
export const guardarPlanDelCatalogoSchema = z
  .object({
    administracionId: idSchema,
    /** null = alta. */
    planId: opcional(idSchema),
    nombre: z.string().trim().min(1, "Poné un nombre.").max(120, "Hasta 120 caracteres."),
    sistema: z.enum(SISTEMAS_DE_CATALOGO, { message: "Elegí el sistema." }),
    tasaPorcentaje: opcional(porcentajeSchema),
    cuotasMin: z.coerce.number({ message: "Escribí un número." }).int("Sin decimales.").min(1, "Desde 1.").max(CUOTAS_MAXIMAS_PLAN, `Hasta ${CUOTAS_MAXIMAS_PLAN}.`),
    cuotasMax: z.coerce.number({ message: "Escribí un número." }).int("Sin decimales.").min(1, "Desde 1.").max(CUOTAS_MAXIMAS_PLAN, `Hasta ${CUOTAS_MAXIMAS_PLAN}.`),
    anticipo: z.enum(ANTICIPOS_DE_CATALOGO, { message: "Elegí si lleva anticipo." }),
    // Hasta dos decimales: es lo que guarda la base (`numeric(5,2)`); con más se perdería sin avisar.
    anticipoMaxPorcentaje: opcional(porcentajeSchema.refine((t) => /^\d{1,3}([.,]\d{1,2})?$/.test(t), "Hasta dos decimales.")),
    deudaMaxima: opcional(montoSchema),
    /** null = solo la administración. */
    estudioId: opcional(idSchema),
    modoCobro: z.enum(MODOS_DE_COBRO, { message: "Elegí quién cobra." }),
    barrioIds: z.array(idSchema).min(1, "Elegí al menos un barrio.").max(500),
  })
  .superRefine((v, ctx) => {
    if (v.cuotasMax < v.cuotasMin) ctx.addIssue({ code: "custom", path: ["cuotasMax"], message: "Tiene que ser igual o mayor que el mínimo." });
    const tasa = v.tasaPorcentaje === null ? 0 : Number.parseFloat(v.tasaPorcentaje.replace(",", "."));
    if (v.sistema === "frances" && !(tasa > 0)) ctx.addIssue({ code: "custom", path: ["tasaPorcentaje"], message: "El francés lleva una tasa mayor que cero." });
    if (v.sistema === "frances" && tasa > 10) ctx.addIssue({ code: "custom", path: ["tasaPorcentaje"], message: "Hasta 10 % mensual." });
    if (v.anticipo === "no" && v.anticipoMaxPorcentaje !== null) ctx.addIssue({ code: "custom", path: ["anticipoMaxPorcentaje"], message: "Sin anticipo no hay máximo." });
    if (v.anticipo !== "no" && v.anticipoMaxPorcentaje === null) ctx.addIssue({ code: "custom", path: ["anticipoMaxPorcentaje"], message: "Poné el anticipo máximo." });
    if (v.deudaMaxima !== null && aCentavos(v.deudaMaxima) <= 0n) ctx.addIssue({ code: "custom", path: ["deudaMaxima"], message: "Mayor que cero, o vacío." });
    if (v.modoCobro === "estudio" && v.estudioId === null) ctx.addIssue({ code: "custom", path: ["modoCobro"], message: "Si cobra el estudio, el plan tiene que ser con un estudio." });
  });
export type GuardarPlanDelCatalogo = z.input<typeof guardarPlanDelCatalogoSchema>;

export const bajaPlanDelCatalogoSchema = z.object({ administracionId: idSchema, planId: idSchema });
export type BajaPlanDelCatalogo = z.input<typeof bajaPlanDelCatalogoSchema>;

/** Las reglas de los planes en un barrio (`plan_parametro_barrio`, 0093 y 0094). */
export const guardarReglasDePlanesSchema = z.object({
  barrioId: idSchema,
  cuotasParaCaer: z.coerce.number({ message: "Escribí un número." }).int("Sin decimales.").min(1, "Desde 1.").max(12, "Hasta 12."),
  /** «Como la administración» (`administracion`) se guarda como NULL: el barrio hereda el valor general. */
  ordenImputacion: z
    .enum([ORDEN_COMO_LA_ADMINISTRACION, ...ORDENES_DE_IMPUTACION], { message: "Elegí el orden." })
    .transform((v) => (v === ORDEN_COMO_LA_ADMINISTRACION ? null : v)),
  financiaMora: z.enum(["si", "no"], { message: "Elegí una opción." }).transform((v) => v === "si"),
  quitaRequiereActa: z.enum(["si", "no"], { message: "Elegí una opción." }).transform((v) => v === "si"),
  /**
   * F4 tramo 3 (`0100`): la rendición la confirma otra persona. Sin decir (`undefined`), queda como estaba:
   * guardar las otras reglas nunca apaga el control en silencio (code-reviewer, m3); un barrio nuevo nace apagado.
   */
  rendicionCuatroOjos: z
    .enum(["si", "no"], { message: "Elegí una opción." })
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "si")),
});
export type GuardarReglasDePlanes = z.input<typeof guardarReglasDePlanesSchema>;

export const REGLAS_DE_PLANES_POR_DEFECTO = {
  cuotasParaCaer: 2,
  /** null: como la administración. */
  ordenImputacion: null as OrdenDeImputacion | null,
  financiaMora: false,
  quitaRequiereActa: false,
  rendicionCuatroOjos: false,
} as const;

/**
 * F4 tramo 3 (BL-053 b, `0100`): quién firma los convenios por el barrio. El texto que va en el PDF lo
 * redactó `legal-ph` y lleva «Texto a validar por el estudio». `ninguno`: el convenio sale como antes.
 */
export const TIPOS_DE_FIRMANTE = ["presidente_directorio", "administrador_poder", "otro"] as const;
export type TipoDeFirmante = (typeof TIPOS_DE_FIRMANTE)[number];
export const TEXTO_TIPO_DE_FIRMANTE: Record<TipoDeFirmante, string> = {
  presidente_directorio: "El presidente del directorio",
  administrador_poder: "El administrador con poder delegado",
  otro: "Otro",
};
export const SIN_FIRMANTE = "ninguno" as const;
export const guardarFirmanteDelConvenioSchema = z
  .object({
    barrioId: idSchema,
    tipo: z.enum([SIN_FIRMANTE, ...TIPOS_DE_FIRMANTE], { message: "Elegí quién firma." }),
    nombre: opcional(z.string().trim().max(200, "Hasta 200 caracteres.")),
    cargo: opcional(z.string().trim().max(120, "Hasta 120 caracteres.")),
    poder: opcional(z.string().trim().max(300, "Hasta 300 caracteres.")),
  })
  .superRefine((v, ctx) => {
    if (v.tipo === SIN_FIRMANTE) return;
    if (v.nombre === null) ctx.addIssue({ code: "custom", path: ["nombre"], message: "Poné el nombre de quien firma." });
    if (v.tipo === "administrador_poder" && v.poder === null) {
      ctx.addIssue({ code: "custom", path: ["poder"], message: "Poné la referencia del poder: número, fecha y escribanía." });
    }
    if (v.tipo === "otro" && v.cargo === null) ctx.addIssue({ code: "custom", path: ["cargo"], message: "Poné el cargo de quien firma." });
  })
  // Lo que no corresponde al tipo no se guarda (la base exige exactamente eso: `plan_parametro_firmante_chk`).
  .transform((v) => ({
    barrioId: v.barrioId,
    tipo: v.tipo === SIN_FIRMANTE ? null : v.tipo,
    nombre: v.tipo === SIN_FIRMANTE ? null : v.nombre,
    cargo: v.tipo === "otro" ? v.cargo : null,
    poder: v.tipo === "administrador_poder" ? v.poder : null,
  }));
export type GuardarFirmanteDelConvenio = z.input<typeof guardarFirmanteDelConvenioSchema>;

/** «Declarar caído» (pantalla 4). La nota queda en el evento del plan. */
export const declararCaidoSchema = z.object({
  planId: idSchema,
  nota: z.string().trim().max(500, "Hasta 500 caracteres.").default(""),
});
export type DeclararCaido = z.input<typeof declararCaidoSchema>;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// P2a-2: armar un plan (maqueta de planes, pantallas 2 y 3)
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Los parámetros de un plan del catálogo que deciden si un plan armado entra en él. */
export type ParametrosDelCatalogo = {
  readonly cuotasMin: number;
  readonly cuotasMax: number;
  readonly anticipo: AnticipoDeCatalogo;
  /** Como lo guarda la base: `"30.00"` = 30 %. */
  readonly anticipoMaxPorcentaje: string | null;
  readonly deudaMaxima: Monto | null;
};

/** `"30.00"` → `"30"`, `"12.50"` → `"12,5"`: un porcentaje de la base, para un texto. */
export function textoDePorcentaje(p: string): string {
  return (p.includes(".") ? p.replace(/\.?0+$/, "") : p).replace(".", ",");
}

/**
 * Por qué un plan armado con estos números **no entra** en el plan del catálogo (vacío: entra). La usan
 * la pantalla, para avisar en vivo que pasa a ser a medida, y el servicio, que rechaza con el primero:
 * así las dos puntas no pueden discrepar.
 */
export function fueraDelCatalogo(
  c: ParametrosDelCatalogo,
  e: { readonly deuda: Monto; readonly cuotas: number; readonly anticipo: Monto | null },
): string[] {
  const motivos: string[] = [];
  if (e.cuotas < c.cuotasMin || e.cuotas > c.cuotasMax) {
    motivos.push(c.cuotasMin === c.cuotasMax ? `El plan es de ${c.cuotasMax} cuotas.` : `El plan va de ${c.cuotasMin} a ${c.cuotasMax} cuotas.`);
  }
  const anticipo = e.anticipo !== null && aCentavos(e.anticipo) > 0n ? aCentavos(e.anticipo) : null;
  const deuda = aCentavos(e.deuda);
  if (c.anticipo === "no" && anticipo !== null) motivos.push("El plan no lleva anticipo.");
  if (c.anticipo === "obligatorio" && anticipo === null) motivos.push("El plan lleva anticipo.");
  if (anticipo !== null && c.anticipoMaxPorcentaje !== null && anticipo * 10000n > deuda * aCentavos(c.anticipoMaxPorcentaje)) {
    motivos.push(`El anticipo del plan es de hasta el ${textoDePorcentaje(c.anticipoMaxPorcentaje)} % de la deuda.`);
  }
  if (c.deudaMaxima !== null && deuda > aCentavos(c.deudaMaxima)) motivos.push("La deuda supera el tope del plan.");
  return motivos;
}

/** Los dos campos del acta, como llegan de un formulario (vacío = sin acta). */
const actaDeFormulario = () => ({
  actaReferencia: opcional(z.string().trim().min(3, "Al menos 3 caracteres.").max(300, "Hasta 300 caracteres.")),
  actaAdjunto: opcional(z.string().max(300)),
});

/** Registrar un plan del catálogo desde la pantalla 2: los campos como llegan del formulario. */
export const registrarPlanDelCatalogoSchema = z
  .object({
    unidadFuncionalId: idSchema,
    liquidacionIds: z.array(idSchema).min(1, "Elegí al menos un mes.").max(240),
    catalogoId: z.string().min(1, "Elegí un plan del catálogo.").pipe(idSchema),
    cuotas: z.coerce.number({ message: "Elegí la cantidad de cuotas." }).int("Sin decimales.").min(1, "Desde 1.").max(CUOTAS_MAXIMAS_PLAN, `Hasta ${CUOTAS_MAXIMAS_PLAN}.`),
    anticipo: opcional(montoSchema),
    vencimientoAnticipo: opcional(fechaPlanSchema),
    primerVencimiento: fechaPlanSchema,
    modoCobro: z.enum(MODOS_DE_COBRO, { message: "Elegí quién cobra." }),
    confirmarDerivada: confirmacionSchema,
  })
  .superRefine((v, ctx) => {
    if (v.anticipo !== null && aCentavos(v.anticipo) > 0n && v.vencimientoAnticipo === null) {
      ctx.addIssue({ code: "custom", path: ["vencimientoAnticipo"], message: "Poné cuándo vence el anticipo." });
    }
  });

/** Una cuota de un cronograma a medida: el anticipo es la `numero` 0. */
const cuotaAMedidaSchema = z.object({
  numero: z.number().int().min(0).max(CUOTAS_MAXIMAS_PLAN),
  vencimiento: fechaPlanSchema,
  importe: montoPositivoSchema,
});

/**
 * Proponer un plan a medida desde la pantalla 3. El cronograma viaja como JSON en un campo oculto (lo
 * arma la tabla editable); «Quién cobra» es `barrio` o el id del estudio que cobra y rinde.
 */
export const registrarPlanAMedidaSchema = z
  .object({
    unidadFuncionalId: idSchema,
    liquidacionIds: z.array(idSchema).min(1, "Elegí al menos un mes.").max(240),
    cronograma: z.preprocess(
      (v) => {
        if (typeof v !== "string") return v;
        try {
          return JSON.parse(v) as unknown;
        } catch {
          return null;
        }
      },
      z.array(cuotaAMedidaSchema, { message: "Cargá las cuotas del plan." }).min(1, "Cargá al menos una cuota.").max(CUOTAS_MAXIMAS_PLAN + 1),
    ),
    cobro: z.union([z.literal("barrio"), idSchema], { message: "Elegí quién cobra." }),
    motivo: z.string().trim().min(1, "Contá el motivo del acuerdo: es obligatorio.").max(1000, "Hasta 1000 caracteres."),
    ...actaDeFormulario(),
    confirmarExcedente: confirmacionSchema,
    /** Lo viaja la confirmación (`__cifrasConfirmadas`, ver `apps/web/src/acciones/confirmacion.ts`). */
    __cifrasConfirmadas: opcional(z.string().max(40)),
  })
  .superRefine((v, ctx) => conActaCompleta(v, ctx))
  .transform(({ cobro, __cifrasConfirmadas, ...v }) => ({
    ...v,
    cifrasConfirmadas: __cifrasConfirmadas,
    modoCobro: cobro === "barrio" ? ("barrio" as const) : ("estudio" as const),
    estudioId: cobro === "barrio" ? null : cobro,
  }));

/** Aprobar un plan a medida pendiente; con el acta, si el barrio la exige y todavía no estaba. */
export const aprobarPlanSchema = z
  .object({
    planId: idSchema,
    ...actaDeFormulario(),
    /** F4 tramo 2: la unidad está derivada y al aprobar sale del estudio: quien aprueba lo confirmó. */
    confirmarDerivada: confirmacionSchema,
  })
  .superRefine((v, ctx) => conActaCompleta(v, ctx));
export type AprobarPlan = z.input<typeof aprobarPlanSchema>;
