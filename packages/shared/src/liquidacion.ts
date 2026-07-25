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

import {
  type Monto,
  aCentavos,
  deCentavos,
  montoSchema,
  prorratearDetallado,
  restarMontos,
  sumarMontos,
} from "./dinero.ts";

/**
 * Cómo se determina lo que paga cada unidad. Los dos modelos conviven en la realidad y un barrio
 * puede pasar de uno a otro (por eso el modelo se guarda **en el período**, no en el barrio).
 *
 * - `variable`: la expensa sale de los **gastos del mes**, prorrateados por coeficiente.
 * - `fija`: el directorio o el administrador fija una **cuota mensual** por unidad; los gastos se
 *   registran igual (para el reporte y el libro), pero no determinan lo que se cobra. Las
 *   **extraordinarias sí se prorratean** aparte, porque son eventos puntuales.
 */
export const MODELOS_EXPENSA = ["variable", "fija"] as const;
export type ModeloExpensa = (typeof MODELOS_EXPENSA)[number];

/** Ordinaria vs extraordinaria (art. 2048 para el respaldo; ver `GastoDelPeriodo.sinRespaldoAsamblea`). */
export const TIPOS_CONCEPTO = ["ordinaria", "extraordinaria"] as const;
export type TipoConcepto = (typeof TIPOS_CONCEPTO)[number];

/**
 * Clasificación fiscal del concepto. Se **guarda** aunque el módulo contable esté fuera del MVP:
 * así el día que se evalúe no hay que recargar nada (decisión de alcance del 2026-07-24).
 */
export const CLASIFICACIONES_FISCALES = [
  "alcanzado",
  "no_alcanzado",
  "ingreso_ajeno",
  "no_gravado",
  /**
   * **El default.** Distingue "lo revisamos y no está alcanzado" de "nadie lo miró": sin este valor,
   * cada concepto que se da de alta afirma por omisión que no está alcanzado por IIBB — una
   * afirmación fiscal que nadie hizo, contra la regla del proyecto de no presuponer encuadre
   * (`docs/diseno/04-requisitos-dominio.md` §B.1).
   */
  "sin_clasificar",
] as const;
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
  /**
   * Extraordinaria cargada **sin** acta de asamblea. Pasa en la práctica y el sistema **no lo
   * impide**: lo deja registrado (y la liquidación lo puede mostrar), porque el respaldo pesa
   * después, cuando hay que reclamar la deuda — no al momento de cargarla.
   */
  sinRespaldoAsamblea?: boolean;
};

/** Una unidad que participa del prorrateo, con el coeficiente que le corresponde. */
export type UnidadAPRorratear = {
  unidadFuncionalId: string;
  /** Coeficiente de la versión cerrada vigente (string decimal). */
  coeficiente: string;
};

/** Una línea de la liquidación: dice de dónde sale, no solo cuánto. */
export type ItemCalculado = {
  /** `null` en la línea de cuota fija: no sale de un gasto, sale de la cuota del barrio. */
  gastoId: string | null;
  /** `null` en la línea de cuota fija. */
  conceptoId: string | null;
  descripcion: string;
  tipo: TipoConcepto;
  esFondoReserva: boolean;
  esCuotaFija: boolean;
  /** Monto total del gasto que se repartió, o el importe de la cuota fija (la base del cálculo). */
  baseMonto: Monto;
  /** `null` en la cuota fija: no hay prorrateo, el importe es el de esa unidad. */
  coeficienteAplicado: string | null;
  monto: Monto;
  /**
   * Lo que da la cuenta a mano: `baseMonto × coeficiente`, redondeado a centavos. Se guarda para que
   * el administrador pueda verificar la línea con una calculadora y llegue al mismo número.
   */
  montoTeorico: Monto;
  /**
   * `monto − montoTeorico`: la diferencia entre lo que se cobra y lo que da la cuenta a mano. Sale de
   * que el reparto **trunca** (y le da el resto a la última unidad) mientras que el teórico redondea.
   * Son centavos, y aparece en varias unidades, no en una. Se guarda **explícito** porque si no, el
   * administrador saca la calculadora, no le cierra, y pierde la confianza en las 50 liquidaciones.
   */
  ajusteRedondeo: Monto;
};

export type LiquidacionCalculada = {
  unidadFuncionalId: string;
  coeficienteAplicado: string;
  items: ItemCalculado[];
  subtotalCuotaFija: Monto;
  subtotalOrdinarias: Monto;
  subtotalExtraordinarias: Monto;
  subtotalFondoReserva: Monto;
  /** Cuota fija + ordinarias + extraordinarias + fondo. Todavía sin mora ni saldo anterior. */
  total: Monto;
};

export type ResultadoLiquidacion = {
  modelo: ModeloExpensa;
  liquidaciones: LiquidacionCalculada[];
  /** Suma de los gastos del período (se registran en los dos modelos). */
  totalGastos: Monto;
  /** Suma de las cuotas fijas cobradas (0 en el modelo variable). */
  totalCuotasFijas: Monto;
  /** Suma de lo efectivamente cobrado a las unidades. */
  totalRepartido: Monto;
  /** Lo que debería dar `totalRepartido` según el modelo. Si no coincide, se lanza. */
  totalEsperado: Monto;
  /** Gastos extraordinarios cargados sin acta de asamblea (no bloquean: se informan). */
  extraordinariasSinRespaldo: number;
};

/**
 * Reparte los gastos del período entre las unidades, por coeficiente.
 *
 * @throws si no hay unidades, si un gasto es negativo, o si el reparto no cierra (defensa en
 *   profundidad: nunca debería pasar, y si pasa NO se emite una liquidación descuadrada).
 */
export type EntradaLiquidacion = {
  modelo: ModeloExpensa;
  gastos: readonly GastoDelPeriodo[];
  unidades: readonly UnidadAPRorratear[];
  /**
   * Importe fijo de cada unidad (solo modelo `fija`). Tiene que estar **toda** unidad activa: si
   * falta alguna, no se liquida — antes que cobrarle de menos a alguien sin darse cuenta.
   */
  cuotasFijas?: ReadonlyMap<string, Monto>;
};

/**
 * Calcula la liquidación del período según el modelo del barrio.
 *
 * - **variable**: se reparten TODOS los gastos por coeficiente. Lo cobrado = el gasto del mes.
 * - **fija**: cada unidad paga su cuota, y **además** se le prorratean las **extraordinarias** (que
 *   son eventos puntuales, no parte de la cuota mensual). Los gastos ordinarios quedan registrados
 *   para el reporte, pero no se cobran de nuevo.
 *
 * @throws si no hay unidades, si un gasto es negativo, si falta una cuota fija, o si el reparto no
 *   cierra (defensa en profundidad: si algo salió mal, NO se emite una liquidación descuadrada).
 */
export function calcularLiquidacion(entrada: EntradaLiquidacion): ResultadoLiquidacion {
  const { modelo, gastos, unidades, cuotasFijas } = entrada;

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

  // --- Modelo fija: primero la cuota mensual de cada unidad ---------------------------------
  let totalCuotasFijas: Monto = "0.00";
  if (modelo === "fija") {
    if (!cuotasFijas || cuotasFijas.size === 0) {
      throw new Error("el modelo de expensa fija necesita la cuota vigente de cada unidad");
    }
    const importes: Monto[] = [];
    for (const unidad of unidades) {
      const importe = cuotasFijas.get(unidad.unidadFuncionalId);
      if (importe === undefined) {
        throw new Error(`falta la cuota fija de la unidad ${unidad.unidadFuncionalId}`);
      }
      montoSchema.parse(importe);
      if (aCentavos(importe) < 0n) throw new Error(`la cuota fija de ${unidad.unidadFuncionalId} es negativa`);
      importes.push(importe);
      porUnidad.get(unidad.unidadFuncionalId)?.push({
        gastoId: null,
        conceptoId: null,
        descripcion: "Cuota fija mensual",
        tipo: "ordinaria",
        esFondoReserva: false,
        esCuotaFija: true,
        baseMonto: importe,
        coeficienteAplicado: null,
        monto: importe,
        montoTeorico: importe,
        ajusteRedondeo: "0.00",
      });
    }
    totalCuotasFijas = sumarMontos("0.00", ...importes);
  }

  // --- Gastos que se prorratean por coeficiente ---------------------------------------------
  // En el modelo fijo solo se reparten las extraordinarias: lo ordinario ya está en la cuota.
  const aRepartir = modelo === "variable" ? gastos : gastos.filter((g) => g.tipo === "extraordinaria");

  for (const gasto of aRepartir) {
    // Cada gasto se reparte por separado: así cada uno cierra exacto y el total también.
    for (const { id: unidadId, monto, montoTeorico } of prorratearDetallado(gasto.monto, coeficientes)) {
      const unidad = unidades.find((u) => u.unidadFuncionalId === unidadId);
      const coeficienteAplicado = unidad?.coeficiente ?? "0";
      porUnidad.get(unidadId)?.push({
        gastoId: gasto.gastoId,
        conceptoId: gasto.conceptoId,
        descripcion: gasto.descripcion,
        tipo: gasto.tipo,
        esFondoReserva: gasto.esFondoReserva,
        esCuotaFija: false,
        baseMonto: gasto.monto,
        coeficienteAplicado,
        monto,
        montoTeorico,
        ajusteRedondeo: restarMontos(monto, montoTeorico),
      });
    }
  }

  const liquidaciones: LiquidacionCalculada[] = unidades.map((unidad) => {
    const items = porUnidad.get(unidad.unidadFuncionalId) ?? [];
    const sumar = (filtro: (i: ItemCalculado) => boolean): Monto =>
      sumarMontos("0.00", ...items.filter(filtro).map((i) => i.monto));

    const subtotalCuotaFija = sumar((i) => i.esCuotaFija);
    const subtotalFondoReserva = sumar((i) => !i.esCuotaFija && i.esFondoReserva);
    const subtotalOrdinarias = sumar((i) => !i.esCuotaFija && !i.esFondoReserva && i.tipo === "ordinaria");
    const subtotalExtraordinarias = sumar((i) => !i.esCuotaFija && !i.esFondoReserva && i.tipo === "extraordinaria");

    return {
      unidadFuncionalId: unidad.unidadFuncionalId,
      coeficienteAplicado: unidad.coeficiente,
      items,
      subtotalCuotaFija,
      subtotalOrdinarias,
      subtotalExtraordinarias,
      subtotalFondoReserva,
      total: sumarMontos(subtotalCuotaFija, subtotalOrdinarias, subtotalExtraordinarias, subtotalFondoReserva),
    };
  });

  const totalGastos = sumarMontos("0.00", ...gastos.map((g) => g.monto));
  const totalRepartido = sumarMontos("0.00", ...liquidaciones.map((l) => l.total));
  const totalEsperado =
    modelo === "variable"
      ? totalGastos
      : sumarMontos(totalCuotasFijas, ...aRepartir.map((g) => g.monto));

  if (totalRepartido !== totalEsperado) {
    throw new Error(`la liquidación no cierra: esperado ${totalEsperado} vs repartido ${totalRepartido}`);
  }

  return {
    modelo,
    liquidaciones,
    totalGastos,
    totalCuotasFijas,
    totalRepartido,
    totalEsperado,
    extraordinariasSinRespaldo: gastos.filter((g) => g.tipo === "extraordinaria" && g.sinRespaldoAsamblea).length,
  };
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
