/**
 * Coeficientes de un barrio que liquida por coeficiente (T3, pantalla 6): de unos **pesos** (la
 * superficie, un 1 por lote o lo que vino en una planilla) a coeficientes con **9 decimales que suman
 * 1 exacto**. Determinístico, sin E/S y sin coma flotante: todo en milmillonésimas con `bigint`.
 *
 * La regla, la misma que ya usaba el seed para la demo:
 *   - cada unidad recibe `peso × 1.000.000.000 / suma de pesos`, truncado;
 *   - **el resto de redondeo va a la última unidad** (la del orden que manda quien llama: manzana y
 *     lote), así la suma da 1,000000000 exacto;
 *   - **ninguna unidad queda en cero**: una con un peso ínfimo recibe una milmillonésima, que se le
 *     descuenta a la última. Una unidad activa sin coeficiente no paga, y eso no es un redondeo: es
 *     una exención que nadie decidió.
 *
 * Las propiedades (suma 1, ninguno ≤ 0, determinístico) las prueba `coeficientes.test.ts` con
 * fast-check.
 */

/** Una unidad entera de coeficiente, en milmillonésimas. */
export const ESCALA_COEFICIENTE = 1_000_000_000n;

/** El tope de unidades que la escala admite: con más, alguna quedaría en cero sí o sí. */
export const MAX_UNIDADES_COEFICIENTE = 100_000;

/** Un peso decimal positivo («605.00», «1», «0.0125») → entero escalado a 6 decimales. */
function pesoEscalado(peso: string): bigint {
  const t = peso.trim().replace(",", ".");
  const m = /^(\d{1,12})(?:\.(\d{1,9}))?$/.exec(t);
  if (!m) throw new RangeError(`peso inválido: "${peso}" (un número positivo, con punto decimal)`);
  const decimales = (m[2] ?? "").padEnd(9, "0");
  return BigInt(m[1]!) * ESCALA_COEFICIENTE + BigInt(decimales);
}

/** Milmillonésimas → «0.012500000» (siempre 9 decimales; «1.000000000» si es una sola unidad). */
export function coeficienteATexto(nano: bigint): string {
  const entero = nano / ESCALA_COEFICIENTE;
  const resto = (nano % ESCALA_COEFICIENTE).toString().padStart(9, "0");
  return `${entero}.${resto}`;
}

/** «0.012500000» → milmillonésimas. Rechaza más de 9 decimales en vez de redondear en silencio. */
export function coeficienteDesdeTexto(texto: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(texto.trim());
  if (!m) throw new RangeError(`coeficiente inválido: "${texto}"`);
  return BigInt(m[1]!) * ESCALA_COEFICIENTE + BigInt((m[2] ?? "").padEnd(9, "0"));
}

/** La suma de unos coeficientes, con sus 9 decimales: «1.000000000» si cuadran. */
export function sumarCoeficientes(valores: readonly string[]): string {
  return coeficienteATexto(valores.reduce((s, v) => s + coeficienteDesdeTexto(v), 0n));
}

export type PesoDeUnidad = { readonly unidadFuncionalId: string; readonly peso: string };
export type CoeficienteDeUnidad = { readonly unidadFuncionalId: string; readonly valor: string };

/**
 * Reparte 1 entre las unidades, proporcional a su peso. El orden de entrada importa (define cuál es la
 * «última», que absorbe el resto) y se respeta en la salida.
 */
export function repartirCoeficientes(unidades: readonly PesoDeUnidad[]): CoeficienteDeUnidad[] {
  if (unidades.length === 0) throw new RangeError("no hay unidades a las que repartirles el coeficiente");
  if (unidades.length > MAX_UNIDADES_COEFICIENTE) {
    throw new RangeError(`hasta ${MAX_UNIDADES_COEFICIENTE} unidades: con más, alguna quedaría en cero`);
  }
  const pesos = unidades.map((u) => pesoEscalado(u.peso));
  if (pesos.some((p) => p <= 0n)) throw new RangeError("todas las unidades tienen que tener un peso mayor que cero");
  const total = pesos.reduce((s, p) => s + p, 0n);

  const nanos = pesos.map((p) => {
    const v = (p * ESCALA_COEFICIENTE) / total;
    return v < 1n ? 1n : v;
  });
  const ultima = nanos.length - 1;
  nanos[ultima] = ESCALA_COEFICIENTE - nanos.slice(0, ultima).reduce((s, v) => s + v, 0n);

  // Si las milmillonésimas mínimas de las unidades ínfimas dejaron a la última sin nada, se le
  // descuentan a la de mayor coeficiente (la primera, si empatan): determinístico y sin ceros.
  while (nanos[ultima]! < 1n) {
    let mayor = 0;
    for (let i = 1; i < ultima; i++) if (nanos[i]! > nanos[mayor]!) mayor = i;
    const falta: bigint = 1n - nanos[ultima]!;
    const toma: bigint = nanos[mayor]! - 1n < falta ? nanos[mayor]! - 1n : falta;
    if (toma <= 0n) throw new RangeError("no se puede repartir sin dejar una unidad en cero");
    nanos[mayor] = nanos[mayor]! - toma;
    nanos[ultima] = nanos[ultima]! + toma;
  }

  return unidades.map((u, i) => ({ unidadFuncionalId: u.unidadFuncionalId, valor: coeficienteATexto(nanos[i]!) }));
}

/** Las tres formas de armar una versión (pantalla 6). */
export const FORMAS_COEFICIENTE = ["superficie", "iguales", "planilla"] as const;
export type FormaCoeficiente = (typeof FORMAS_COEFICIENTE)[number];

export const ETIQUETA_FORMA_COEFICIENTE: Record<FormaCoeficiente, string> = {
  superficie: "Por superficie",
  iguales: "Iguales por lote",
  planilla: "Cargados por planilla",
};

/** La base de `coeficiente_version` que corresponde a cada forma (`app.base_coeficiente`). */
export const BASE_DE_FORMA: Record<FormaCoeficiente, "superficie" | "lote" | "parte_indivisa"> = {
  superficie: "superficie",
  iguales: "lote",
  planilla: "parte_indivisa",
};
