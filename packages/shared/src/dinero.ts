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

// --- Formato para impresión (es-AR) -----------------------------------------------------------
//
// **Se formatea acá y en ningún otro lado.** `Intl.NumberFormat("es-AR")` degrada a formato en-US
// **en silencio** en un Node slim sin ICU completo (doc 07 §A): un total que en pantalla dice
// `359.000,00` y en el PDF dice `359,000.00` es un bug de dinero invisible en desarrollo. Estas
// funciones no dependen de ICU, así que la misma cadena sale igual en la web, en el email y en el
// PDF — y el test puede compararla contra el modelo de vista (doc 09 §E.6).

/** Separador de miles en el formato argentino. */
function agruparMiles(enteros: string): string {
  return enteros.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/**
 * Monto → cadena impresa en formato argentino: `"359000.00"` → `"359.000,00"`.
 *
 * Sin símbolo de moneda (lo pone la plantilla) y sin `Intl`. El cero negativo se normaliza: un
 * `"-0.00"` sale `"0,00"`, porque un signo menos delante de un cero se lee como un error.
 */
export function formatearMonto(monto: string): string {
  const valido = montoSchema.parse(monto);
  const negativo = valido.startsWith("-") && aCentavos(valido) !== 0n;
  const [enteros = "0", decimales = "00"] = valido.replace("-", "").split(".");
  return `${negativo ? "-" : ""}${agruparMiles(enteros)},${decimales}`;
}

/**
 * Decimal arbitrario → cadena impresa con `decimales` posiciones, **redondeando** a la mitad
 * alejándose del cero. Se usa para el coeficiente (se guardan 9 decimales, se muestran 4) y para la
 * tasa de mora. Que redondee y no trunque es a propósito: quien rehaga la cuenta con la calculadora
 * llega al número más cercano posible, y la diferencia la explica la nota fija del documento.
 */
export function formatearDecimal(valor: string, decimales: number): string {
  if (!Number.isInteger(decimales) || decimales < 0) throw new Error("decimales tiene que ser un entero >= 0");
  if (!/^-?\d+(\.\d+)?$/.test(valor)) throw new Error(`decimal inválido: ${valor}`);

  const negativo = valor.startsWith("-");
  const [ent = "0", dec = ""] = valor.replace("-", "").split(".");
  const escala = 10n ** BigInt(decimales);
  // Se lleva un dígito extra para poder redondear sin pasar por `number`.
  const crudo = BigInt(ent) * escala * 10n + BigInt((dec + "0".repeat(decimales + 1)).slice(0, decimales + 1));
  const redondeado = (crudo + 5n) / 10n;

  const enteros = redondeado / escala;
  const resto = (redondeado % escala).toString().padStart(decimales, "0");
  const signo = negativo && redondeado !== 0n ? "-" : "";
  return decimales === 0 ? `${signo}${agruparMiles(enteros.toString())}` : `${signo}${agruparMiles(enteros.toString())},${resto}`;
}

// --- La máscara de escritura (reglas B-1 y B-1.bis del usuario, 2026-08-03) ---------------------
//
// Las dos reglas salen del mismo recorrido y son **una sola pieza**: mostrar el importe agrupado
// mientras se escribe, y no exigirle a nadie que tipee `,00` al final de un número redondo.
//
// > *"El monto de un gasto se escribe `92368783.69` y se ve `92368783.69` — sin separadores,
// > imposible de leer de un vistazo y fácil de equivocar en un cero."*
// > *"Escribir `2500000` rebota: «esperado string decimal con 2 decimales»."*
//
// **Dónde se arregla importa.** `montoSchema` exige dos decimales **con razón**: es lo que garantiza
// que el dinero llegue exacto a `numeric(14,2)`. Aflojar el esquema para que la pantalla sea cómoda
// sería mover el problema a la base. Lo que normaliza es el campo, **antes** de enviar.
//
// Todo esto es texto → texto: ni un `Number` en el camino, igual que el resto del módulo.

/**
 * ¿Qué separador quiso decir la persona? Devuelve `[enteros, decimales]` ya separados, **solo con
 * dígitos**: lo que salga de acá no puede producir un monto que el esquema rechace.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LA REGLA, Y POR QUÉ NO ES LA OBVIA
 *
 * **El punto es SIEMPRE separador de miles y la coma es SIEMPRE el decimal.** Sin excepciones y sin
 * heurística. La versión obvia —"un punto con dos dígitos o menos atrás es decimal", para que el
 * teclado numérico del celular pueda escribir centavos— es la que se probó primero, y **se rompió de
 * la peor manera posible**: como la máscara escribe el punto de miles y después no puede
 * distinguirlo del que tipeó la persona, **borrar un dígito dividía el importe por mil**.
 *
 * ```
 *   2.500.000  --retroceso-->  2.500,00        (dos millones y medio → dos mil quinientos)
 * ```
 *
 * Y lo caro no es el factor mil: es que el resultado **parece un importe normal**. Nadie mira dos
 * veces un "2.500,00". Pasaba con todo importe de cuatro dígitos o más, con una sola tecla, en el
 * gesto de corrección más frecuente que hay.
 *
 * El teclado numérico no se pierde: el punto se traduce a coma **en el campo**, donde se sabe qué
 * tecla se apretó (ver `CampoMonto`). Ahí hay contexto de edición; acá no, y una función pura que
 * solo ve el texto final no puede distinguir un punto tipeado de uno que puso ella misma.
 *
 * **La excepción del formato yanqui.** Si aparece un punto **después** de la última coma
 * (`1,234.56`, `1,234,567.89`), es un importe copiado de un Excel o una página en inglés: acá eso no
 * puede escribirse, porque los miles van antes del decimal y nunca después. En ese caso las comas
 * son los miles y el punto es el decimal. Sin esta rama, pegar `1,234,567.89` guardaba **$1,23** en
 * silencio, con un monto perfectamente válido que ninguna capa de abajo podía atrapar.
 */
function partirLoTipeado(texto: string): readonly [string, string | null] {
  const soloValidos = texto.replace(/[^\d.,]/g, "");
  const soloDigitos = (t: string): string => t.replace(/\D/g, "");

  const ultimaComa = soloValidos.lastIndexOf(",");
  const ultimoPunto = soloValidos.lastIndexOf(".");

  // Formato yanqui: un punto después de la última coma.
  if (ultimaComa !== -1 && ultimoPunto > ultimaComa) {
    return [soloDigitos(soloValidos.slice(0, ultimoPunto)), soloDigitos(soloValidos.slice(ultimoPunto + 1))];
  }

  // Formato de acá: manda la **primera** coma. Lo que venga después —otra coma, un punto— es ruido
  // de tipeo y se descarta quedándose con los dígitos. Una segunda coma que sobreviviera dejaría el
  // campo con un valor que el esquema rechaza, y trabado.
  if (ultimaComa !== -1) {
    const primeraComa = soloValidos.indexOf(",");
    return [soloDigitos(soloValidos.slice(0, primeraComa)), soloDigitos(soloValidos.slice(primeraComa + 1))];
  }

  return [soloDigitos(soloValidos), null];
}

const sinCerosAlaIzquierda = (enteros: string): string => enteros.replace(/^0+(?=\d)/, "");

/**
 * Lo que la persona tipeó → lo que se ve en el campo, ya agrupado: `"92368783.69"` → `"92.368.783,69"`.
 *
 * **Respeta que se está escribiendo a medias.** `"2500000,"` sale `"2.500.000,"` con la coma colgada
 * y sin decimales inventados: si la máscara completara `,00` en ese momento, el próximo dígito
 * quedaría atrás de los ceros. Los decimales se recortan a dos, que es lo que la base guarda.
 *
 * **Empezar por la coma escribe el cero.** `","` sale `"0,"`, no vacío: si la coma desapareciera del
 * campo, las teclas siguientes entrarían como enteros y quien escribe `,50` pensando en cincuenta
 * centavos terminaría cargando **cincuenta pesos**.
 */
export function enmascararMontoTipeado(texto: string): string {
  const negativo = texto.trimStart().startsWith("-");
  const [enteros, decimales] = partirLoTipeado(texto);
  if (enteros === "" && decimales === null) return negativo ? "-" : "";

  const signo = negativo ? "-" : "";
  const cuerpo = agruparMiles(sinCerosAlaIzquierda(enteros) || "0");
  return decimales === null ? `${signo}${cuerpo}` : `${signo}${cuerpo},${decimales.slice(0, 2)}`;
}

/**
 * Lo que se ve en el campo → lo que viaja al servidor: `"2.500.000"` → `"2500000.00"`.
 *
 * **Completa los decimales que falten** (regla B-1.bis): nadie tipea `,00` al final de un importe
 * redondo, y un mensaje que te manda a agregar dos ceros es el sistema haciéndote trabajar para él.
 * `"1234,5"` sale `"1234.50"` por el mismo motivo.
 *
 * Devuelve `""` cuando no hay ni un dígito: un campo vacío tiene que llegar vacío al esquema, para
 * que sea él —y no esta función— el que decida si era obligatorio.
 */
export function normalizarMontoTipeado(texto: string): string {
  const negativo = texto.trimStart().startsWith("-");
  const [enteros, decimales] = partirLoTipeado(texto);
  if (enteros === "" && (decimales === null || decimales === "")) return "";

  const parteEntera = sinCerosAlaIzquierda(enteros) || "0";
  const parteDecimal = (decimales ?? "").slice(0, 2).padEnd(2, "0");
  return `${negativo ? "-" : ""}${parteEntera}.${parteDecimal}`;
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
