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
  return armar(entrada, (financiado, n) => {
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
// Los parámetros de las escrituras (encargo P1): forma; las reglas las hacen el servicio y la base
// ────────────────────────────────────────────────────────────────────────────────────────────────

const fechaPlanSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (AAAA-MM-DD).");
const montoPositivoSchema = montoSchema.refine((m) => aCentavos(m) > 0n, "El importe tiene que ser mayor que cero.");

export const ESTADOS_PLAN = ["pendiente", "vigente", "rechazado", "retirado", "cumplido", "caido"] as const;
export type EstadoPlan = (typeof ESTADOS_PLAN)[number];

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
});
export type ProponerPlanDeCatalogo = z.input<typeof proponerPlanDeCatalogoSchema>;

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
});
export type ProponerPlanAMedida = z.input<typeof proponerPlanAMedidaSchema>;

export const cerrarPlanSchema = z.object({
  planId: idSchema,
  motivo: z.string().trim().min(1, "Contá el motivo.").max(500),
});
export type CerrarPlan = z.input<typeof cerrarPlanSchema>;
