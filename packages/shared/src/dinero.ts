/**
 * Dinero — representación exacta y trazable.
 *
 * Reglas duras del proyecto (CLAUDE.md §1.4): **toda cifra de dinero se explica con su origen**
 * (barrio, unidad, coeficiente, período) — nunca un número suelto.
 *
 * Representación: **string decimal con 2 decimales** (espejo de `numeric(14,2)` en Postgres).
 * Nunca `number` de JS: 0.1 + 0.2 !== 0.3 y una expensa no puede depender de eso. La aritmética
 * se hace en **centavos enteros** (`bigint`).
 */

import { z } from "zod";

/** Monto en pesos, con punto decimal y exactamente 2 decimales. Ej: `"12345.67"`, `"-8.00"`. */
export const montoSchema = z
  .string()
  .regex(/^-?\d+\.\d{2}$/, "monto inválido (esperado string decimal con 2 decimales, ej '1234.56')");
export type Monto = z.infer<typeof montoSchema>;

/** Período de expensa `YYYY-MM`. */
export const periodoSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "período inválido (YYYY-MM)");
export type Periodo = z.infer<typeof periodoSchema>;

/**
 * De dónde sale la cifra. Todo importe que se muestre o se persista viaja con esto para poder
 * contestar "¿por qué me cobran esto?" sin reconstruirlo a mano.
 */
export const origenCifraSchema = z.object({
  barrioId: z.string().uuid(),
  periodo: periodoSchema.optional(),
  unidadFuncionalId: z.string().uuid().optional(),
  /** Coeficiente aplicado, como string decimal (ej. `"0.012345"`). */
  coeficiente: z.string().optional(),
  conceptoId: z.string().uuid().optional(),
  /** Explicación legible para el administrador y para el propietario. */
  detalle: z.string().min(1),
});
export type OrigenCifra = z.infer<typeof origenCifraSchema>;

export const cifraTrazableSchema = z.object({ monto: montoSchema, origen: origenCifraSchema });
export type CifraTrazable = z.infer<typeof cifraTrazableSchema>;

/** Convierte un monto a centavos enteros. Lanza si el formato no es válido. */
export function aCentavos(monto: string): bigint {
  const valido = montoSchema.parse(monto);
  const negativo = valido.startsWith("-");
  const [enteros = "0", decimales = "00"] = valido.replace("-", "").split(".");
  const centavos = BigInt(enteros) * 100n + BigInt(decimales);
  return negativo ? -centavos : centavos;
}

/** Convierte centavos enteros a monto con 2 decimales. */
export function deCentavos(centavos: bigint): Monto {
  const negativo = centavos < 0n;
  const abs = negativo ? -centavos : centavos;
  const enteros = abs / 100n;
  const resto = abs % 100n;
  return `${negativo ? "-" : ""}${enteros}.${resto.toString().padStart(2, "0")}`;
}

/** Suma exacta de montos (en centavos). */
export function sumarMontos(...montos: readonly string[]): Monto {
  return deCentavos(montos.reduce<bigint>((acum, m) => acum + aCentavos(m), 0n));
}

/** Resta exacta: `a - b`. */
export function restarMontos(a: string, b: string): Monto {
  return deCentavos(aCentavos(a) - aCentavos(b));
}

/**
 * Prorratea un total por coeficiente, con **redondeo bancario del resto en la última unidad**:
 * la suma de las partes es **siempre igual al total** (requisito: la liquidación tiene que cerrar).
 *
 * @param total Monto a repartir.
 * @param coeficientes Pares `[idUnidad, coeficiente]` — el coeficiente es string decimal.
 * @returns Pares `[idUnidad, monto]` en el mismo orden recibido.
 */
export function prorratear(
  total: string,
  coeficientes: ReadonlyArray<readonly [string, string]>,
): Array<[string, Monto]> {
  if (coeficientes.length === 0) throw new Error("prorratear: no hay unidades a las que repartir");

  // Escala común: se trabaja con enteros para no perder precisión con los coeficientes.
  const ESCALA = 1_000_000_000n; // 9 decimales de coeficiente
  const pesos = coeficientes.map(([id, coef]) => {
    if (!/^\d+(\.\d+)?$/.test(coef)) throw new Error(`coeficiente inválido: ${coef}`);
    const [ent = "0", dec = ""] = coef.split(".");
    const decNorm = dec.padEnd(9, "0").slice(0, 9);
    return [id, BigInt(ent) * ESCALA + BigInt(decNorm || "0")] as const;
  });

  const sumaPesos = pesos.reduce<bigint>((a, [, p]) => a + p, 0n);
  if (sumaPesos === 0n) throw new Error("prorratear: la suma de coeficientes es cero");

  const totalCentavos = aCentavos(total);
  const partes: Array<[string, bigint]> = pesos.map(([id, p]) => [id, (totalCentavos * p) / sumaPesos]);
  const asignado = partes.reduce<bigint>((a, [, c]) => a + c, 0n);

  // El resto (por truncamiento) va a la última unidad: garantiza que la suma cierre exacto.
  const ultima = partes[partes.length - 1];
  if (ultima) ultima[1] += totalCentavos - asignado;

  return partes.map(([id, c]) => [id, deCentavos(c)]);
}
