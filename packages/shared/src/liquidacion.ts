/**
 * Cálculo de la liquidación mensual. **Dominio puro**: sin base de datos, sin fechas del sistema,
 * sin efectos — se puede probar entero y es el mismo código que va a usar el PDF y la UI.
 *
 * Fuente: `docs/diseno/01-alcance-modulos.md` §4.2 y `knowledge/cordoba/REQUISITOS-MODELO-DATOS.md` §4.
 *
 * Invariante que sostiene todo: **la suma de lo que se le cobra a las unidades es exactamente igual
 * al gasto del período**. Cada gasto se reparte por separado (con el resto a la última unidad), así
 * ningún redondeo se "pierde" ni aparece de la nada.
 */

import { type Monto, aCentavos, deCentavos, montoSchema, prorratear, sumarMontos } from "./dinero.ts";

/** Ordinaria vs extraordinaria (art. 2048): la extraordinaria exige respaldo de asamblea. */
export const TIPOS_CONCEPTO = ["ordinaria", "extraordinaria"] as const;
export type TipoConcepto = (typeof TIPOS_CONCEPTO)[number];

/**
 * Clasificación fiscal del concepto. Se **guarda** aunque el módulo contable esté fuera del MVP:
 * así el día que se evalúe no hay que recargar nada (decisión de alcance del 2026-07-24).
 */
export const CLASIFICACIONES_FISCALES = ["alcanzado", "no_alcanzado", "ingreso_ajeno", "no_gravado"] as const;
export type ClasificacionFiscal = (typeof CLASIFICACIONES_FISCALES)[number];

/** Estados de la liquidación del período. Una vez emitida no se edita. */
export const ESTADOS_PERIODO = ["borrador", "revisada", "emitida", "distribuida"] as const;
export type EstadoPeriodo = (typeof ESTADOS_PERIODO)[number];

/** Transiciones admitidas. Volver atrás solo se puede antes de emitir. */
const TRANSICIONES: Record<EstadoPeriodo, readonly EstadoPeriodo[]> = {
  borrador: ["revisada", "emitida"],
  revisada: ["borrador", "emitida"],
  emitida: ["distribuida"],
  distribuida: [],
};

export function transicionValida(desde: EstadoPeriodo, hacia: EstadoPeriodo): boolean {
  return TRANSICIONES[desde].includes(hacia);
}

/** Un gasto del período, ya cargado y clasificado. */
export type GastoDelPeriodo = {
  gastoId: string;
  conceptoId: string;
  descripcion: string;
  tipo: TipoConcepto;
  esFondoReserva: boolean;
  monto: Monto;
};

/** Una unidad que participa del prorrateo, con el coeficiente que le corresponde. */
export type UnidadAPRorratear = {
  unidadFuncionalId: string;
  /** Coeficiente de la versión cerrada vigente (string decimal). */
  coeficiente: string;
};

/** Una línea de la liquidación: dice de dónde sale, no solo cuánto. */
export type ItemCalculado = {
  gastoId: string;
  conceptoId: string;
  descripcion: string;
  tipo: TipoConcepto;
  esFondoReserva: boolean;
  /** Monto total del gasto que se repartió (la base del cálculo). */
  baseMonto: Monto;
  coeficienteAplicado: string;
  monto: Monto;
};

export type LiquidacionCalculada = {
  unidadFuncionalId: string;
  coeficienteAplicado: string;
  items: ItemCalculado[];
  subtotalOrdinarias: Monto;
  subtotalExtraordinarias: Monto;
  subtotalFondoReserva: Monto;
  /** Ordinarias + extraordinarias + fondo. Todavía sin mora ni saldo anterior. */
  total: Monto;
};

export type ResultadoLiquidacion = {
  liquidaciones: LiquidacionCalculada[];
  /** Suma de los gastos del período. */
  totalGastos: Monto;
  /** Suma de lo repartido. Es igual a `totalGastos`: si no, se lanza antes de devolver. */
  totalRepartido: Monto;
};

/**
 * Reparte los gastos del período entre las unidades, por coeficiente.
 *
 * @throws si no hay unidades, si un gasto es negativo, o si el reparto no cierra (defensa en
 *   profundidad: nunca debería pasar, y si pasa NO se emite una liquidación descuadrada).
 */
export function calcularLiquidacion(
  gastos: readonly GastoDelPeriodo[],
  unidades: readonly UnidadAPRorratear[],
): ResultadoLiquidacion {
  if (unidades.length === 0) throw new Error("no hay unidades activas para liquidar");
  for (const gasto of gastos) {
    montoSchema.parse(gasto.monto);
    if (aCentavos(gasto.monto) < 0n) {
      throw new Error(`el gasto "${gasto.descripcion}" es negativo: eso se registra como nota de crédito`);
    }
  }

  const porUnidad = new Map<string, ItemCalculado[]>();
  for (const unidad of unidades) porUnidad.set(unidad.unidadFuncionalId, []);

  const coeficientes = unidades.map((u) => [u.unidadFuncionalId, u.coeficiente] as const);

  for (const gasto of gastos) {
    // Cada gasto se reparte por separado: así cada uno cierra exacto y el total también.
    for (const [unidadId, monto] of prorratear(gasto.monto, coeficientes)) {
      const unidad = unidades.find((u) => u.unidadFuncionalId === unidadId);
      porUnidad.get(unidadId)?.push({
        gastoId: gasto.gastoId,
        conceptoId: gasto.conceptoId,
        descripcion: gasto.descripcion,
        tipo: gasto.tipo,
        esFondoReserva: gasto.esFondoReserva,
        baseMonto: gasto.monto,
        coeficienteAplicado: unidad?.coeficiente ?? "0",
        monto,
      });
    }
  }

  const liquidaciones: LiquidacionCalculada[] = unidades.map((unidad) => {
    const items = porUnidad.get(unidad.unidadFuncionalId) ?? [];
    const sumar = (filtro: (i: ItemCalculado) => boolean): Monto =>
      sumarMontos("0.00", ...items.filter(filtro).map((i) => i.monto));

    const subtotalFondoReserva = sumar((i) => i.esFondoReserva);
    const subtotalOrdinarias = sumar((i) => !i.esFondoReserva && i.tipo === "ordinaria");
    const subtotalExtraordinarias = sumar((i) => !i.esFondoReserva && i.tipo === "extraordinaria");

    return {
      unidadFuncionalId: unidad.unidadFuncionalId,
      coeficienteAplicado: unidad.coeficiente,
      items,
      subtotalOrdinarias,
      subtotalExtraordinarias,
      subtotalFondoReserva,
      total: sumarMontos(subtotalOrdinarias, subtotalExtraordinarias, subtotalFondoReserva),
    };
  });

  const totalGastos = sumarMontos("0.00", ...gastos.map((g) => g.monto));
  const totalRepartido = sumarMontos("0.00", ...liquidaciones.map((l) => l.total));
  if (totalGastos !== totalRepartido) {
    throw new Error(`la liquidación no cierra: gastos ${totalGastos} vs repartido ${totalRepartido}`);
  }

  return { liquidaciones, totalGastos, totalRepartido };
}

/** Resultado del cálculo de mora: o hay interés, o hay un motivo por el que no se puede calcular. */
export type ResultadoMora =
  | { interes: Monto; tasaMensualAplicada: string; dias: number }
  | { interes: null; motivo: "mora pendiente de definición" };

/**
 * Interés por mora, **simple** (MVP), proporcional a los días de atraso.
 *
 * Si el barrio no tiene tasa cargada, el sistema **no inventa una**: devuelve el motivo para que la
 * liquidación salga con el capital y la leyenda "mora pendiente de definición" (doc 01 §4.2).
 */
export function calcularMora(parametros: {
  saldoVencido: Monto;
  /** Tasa mensual como string decimal (`"0.03"` = 3% mensual). `null` si el barrio no la definió. */
  tasaMensual: string | null;
  diasDeAtraso: number;
}): ResultadoMora {
  const { saldoVencido, tasaMensual, diasDeAtraso } = parametros;
  if (tasaMensual === null) return { interes: null, motivo: "mora pendiente de definición" };
  if (!/^\d+(\.\d+)?$/.test(tasaMensual)) throw new Error(`tasa de mora inválida: ${tasaMensual}`);
  if (diasDeAtraso < 0) throw new Error("los días de atraso no pueden ser negativos");

  const saldo = aCentavos(saldoVencido);
  if (saldo <= 0n || diasDeAtraso === 0) {
    return { interes: "0.00", tasaMensualAplicada: tasaMensual, dias: diasDeAtraso };
  }

  // Entero puro: tasa a millonésimas, y el mes comercial de 30 días como divisor.
  const [ent = "0", dec = ""] = tasaMensual.split(".");
  const tasaMillonesimas = BigInt(ent) * 1_000_000n + BigInt(dec.padEnd(6, "0").slice(0, 6) || "0");
  const interes = (saldo * tasaMillonesimas * BigInt(diasDeAtraso)) / (1_000_000n * 30n);

  return { interes: deCentavos(interes), tasaMensualAplicada: tasaMensual, dias: diasDeAtraso };
}
