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

/** Escala entera de los coeficientes: 9 decimales, igual que la columna `numeric(18,9)` de la base. */
const ESCALA_COEFICIENTE = 1_000_000_000n;

/**
 * Coeficiente decimal → entero escalado. **Trunca** más allá de 9 decimales (la base guarda 9: si se
 * redondeara acá, el número del sistema y el de la base dejarían de coincidir).
 */
export function coeficienteAEntero(coeficiente: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(coeficiente)) throw new Error(`coeficiente inválido: ${coeficiente}`);
  const [ent = "0", dec = ""] = coeficiente.split(".");
  return BigInt(ent) * ESCALA_COEFICIENTE + BigInt(dec.padEnd(9, "0").slice(0, 9));
}

/**
 * División entera con **redondeo a la mitad, alejándose del cero**. La división de `bigint` trunca
 * hacia cero, así que sumarle "la mitad" al numerador sesga para el lado equivocado en negativos:
 * `-10.00 × 0.5` daría `-4.99`. Esto importa el día que entren las notas de crédito.
 */
function dividirRedondeando(numerador: bigint, denominador: bigint): bigint {
  const negativo = numerador < 0n !== denominador < 0n;
  const n = numerador < 0n ? -numerador : numerador;
  const d = denominador < 0n ? -denominador : denominador;
  const q = (2n * n + d) / (2n * d);
  return negativo ? -q : q;
}

/** Una parte del reparto: lo que se cobra y lo que daría la cuenta a mano. */
export type ParteProrrateada = {
  id: string;
  /** Lo que efectivamente se cobra (con el resto del reparto ya asignado). */
  monto: Monto;
  /**
   * `total × coeficiente / suma de coeficientes`, redondeado. Es la cuenta que haría el
   * administrador con una calculadora. **Sale del mismo denominador que el reparto**: si se dividiera
   * por una escala fija se estaría asumiendo que los coeficientes suman 1, y eso solo vale para la
   * base `parte_indivisa` — en superficie/lote/mixto son pesos relativos (art. 2081).
   */
  montoTeorico: Monto;
};

/**
 * Prorratea un total por coeficiente, con el **resto en la última unidad**: la suma de las partes es
 * **siempre igual al total** (requisito: la liquidación tiene que cerrar).
 *
 * @param total Monto a repartir.
 * @param coeficientes Pares `[idUnidad, coeficiente]` — el coeficiente es string decimal.
 */
export function prorratearDetallado(
  total: string,
  coeficientes: ReadonlyArray<readonly [string, string]>,
): ParteProrrateada[] {
  if (coeficientes.length === 0) throw new Error("prorratear: no hay unidades a las que repartir");

  const pesos = coeficientes.map(([id, coef]) => [id, coeficienteAEntero(coef)] as const);
  const sumaPesos = pesos.reduce<bigint>((a, [, p]) => a + p, 0n);
  if (sumaPesos === 0n) throw new Error("prorratear: la suma de coeficientes es cero");

  const totalCentavos = aCentavos(total);
  const partes = pesos.map(([id, p]) => {
    const producto = totalCentavos * p;
    return {
      id,
      centavos: producto / sumaPesos, // trunca hacia cero
      resto: producto % sumaPesos, // lo que quedó afuera: define quién cobra el centavo sobrante
      teorico: dividirRedondeando(producto, sumaPesos),
    };
  });

  // Reparto del resto por **mayor residuo**: cada centavo sobrante va a la unidad que más cerca
  // estaba de merecerlo. Antes se le daban TODOS a la última unidad, que con 37 unidades podía
  // recibir 36 centavos de golpe y ver cifras que no le cerraban por nada que ella hubiera hecho.
  const asignado = partes.reduce<bigint>((a, x) => a + x.centavos, 0n);
  let faltan = totalCentavos - asignado;
  const paso = faltan >= 0n ? 1n : -1n;
  const orden = [...partes.keys()].sort((a, b) => {
    const ra = partes[a]?.resto ?? 0n;
    const rb = partes[b]?.resto ?? 0n;
    // Mayor residuo primero (en negativos, el de menor residuo es el que "más debe").
    if (ra === rb) return a - b; // desempate estable: el orden de entrada
    return paso > 0n ? (rb > ra ? 1 : -1) : (ra > rb ? 1 : -1);
  });
  for (const i of orden) {
    if (faltan === 0n) break;
    const parte = partes[i];
    if (!parte) continue;
    parte.centavos += paso;
    faltan -= paso;
  }

  return partes.map((x) => ({ id: x.id, monto: deCentavos(x.centavos), montoTeorico: deCentavos(x.teorico) }));
}

/** Igual que `prorratearDetallado`, quedándose solo con lo que se cobra. */
export function prorratear(
  total: string,
  coeficientes: ReadonlyArray<readonly [string, string]>,
): Array<[string, Monto]> {
  return prorratearDetallado(total, coeficientes).map((p) => [p.id, p.monto]);
}
