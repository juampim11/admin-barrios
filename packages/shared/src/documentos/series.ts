/**
 * `SerieHistorica` — los puntos de una **tira de períodos** (doc 10 §I.2, forma 2).
 *
 * ## La regla que ordena todo este archivo: la serie es un DATO DE ENTRADA, no un cálculo
 *
 * > **Los puntos de una tira son cifras de documentos ya emitidos. Se congelan al cerrar el período,
 * > con la misma disciplina que la liquidación emitida, y el documento los recibe hechos.**
 *
 * Nada acá calcula una serie, y **nada debe calcularla aguas arriba en el momento de emitir**. Quien
 * conecte la fuente real (hoy no existe: es el hueco **F-7** de doc 10 §I.9) tiene que leer valores
 * guardados al cerrar cada período, no rehacerlos:
 *
 *  - **un informe emitido no se edita** (doc 10 §C.3), así que su resultado del período es una
 *    afirmación de la administración con fecha;
 *  - si la serie se recalculara en cada emisión, un cambio posterior en un período viejo —una
 *    imputación corregida, un gasto que llegó tarde— **cambiaría la historia sola**, y algún día la
 *    tira de julio contradiría el PDF de marzo que el barrio ya repartió por correo;
 *  - el que descubre esa contradicción no es un desarrollador: es un propietario en una asamblea, con
 *    las dos hojas en la mano.
 *
 * Por eso el tipo **no recibe montos ni fechas de las que se pueda recalcular nada**: recibe el
 * período y **la cadena tal como se publicó**.
 *
 * ## La segunda regla: la forma se alimenta del texto publicado (§I.8.2)
 *
 * > **Redondear un número no redondea su barra.**
 *
 * Un punto no lleva `monto`: lleva `texto`. Si el listado agregado publica los importes redondeados
 * al millar y la tira se dibujara desde el valor con centavos, **el dibujo llevaría la precisión que
 * el número deliberadamente perdió** — y con la escala a la vista, esa precisión se recupera con una
 * regla. Con `texto` como única fuente, dos cortes que se publican con el mismo importe redondeado
 * dibujan la **misma** columna, al punto.
 */

import { z } from "zod";

/** Período de un punto, `YYYY-MM`. Es la única forma de ubicar una columna en el eje. */
const codigoPeriodoSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "período inválido (YYYY-MM)");

/**
 * Un punto de la serie.
 *
 * `texto` en `null` **no es un cero**: es un período de la ventana para el que no hay documento
 * emitido (§I.7, caso 8). El lugar se reserva y no se interpola — interpolar un mes de plata es
 * inventarlo, y el hueco dice algo verdadero: *"acá no hay informe"*.
 */
export const puntoSerieSchema = z
  .object({
    periodo: codigoPeriodoSchema,
    /** Cómo se rotula la columna si le toca ser la primera o la última: `"05/2026"`. */
    etiqueta: z.string().min(1),
    /**
     * **La cadena tal como se imprime**, sin símbolo de moneda: `"102.068.591,27"`, `"94,05"`,
     * `"-1.200.000,00"`. De acá —y de ningún otro lado— sale la longitud de la columna.
     */
    texto: z.string().min(1).nullable(),
    /**
     * Cuántas unidades describe el punto, cuando el punto es un **agregado de personas** (el total de
     * mora de un corte). `null` cuando no describe a nadie: el resultado de un período o la deuda con
     * proveedores no son un grupo de vecinos.
     *
     * Existe para que el k-anonimato pueda alcanzar también al dibujo: una serie temporal es tan
     * sensible como una celda —un corte con 3 unidades publica esas 3, aunque los otros once tengan
     * cien (§I.8.4)— y sin este campo la regla no se puede verificar.
     */
    unidades: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .readonly();
export type PuntoSerie = z.infer<typeof puntoSerieSchema>;

/**
 * La serie completa: los puntos **en orden y sin saltos**.
 *
 * Los períodos tienen que ser **consecutivos**: si faltara un mes en el medio, la tira dibujaría las
 * columnas pegadas y el lector leería una evolución mes a mes que no es la que pasó. Un mes sin
 * informe se declara con `texto: null` y ocupa su lugar — que es el caso 8 y la única forma de
 * expresar un hueco.
 */
export const serieHistoricaSchema = z
  .object({
    /** De la más vieja a la más nueva, sin saltos de mes. Tope: un año (`chartPrint.maxPoints`). */
    puntos: z
      .array(puntoSerieSchema)
      .min(1)
      .max(12, "la tira dibuja como máximo 12 períodos: recortá la serie a la ventana que se publica")
      .readonly(),
  })
  .strict()
  .readonly()
  .superRefine((s, ctx) => {
    const error = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    for (let i = 1; i < s.puntos.length; i++) {
      const previo = s.puntos[i - 1];
      const actual = s.puntos[i];
      if (!previo || !actual) continue;
      if (mesSiguiente(previo.periodo) !== actual.periodo) {
        error(
          ["puntos", i, "periodo"],
          `la serie salta de ${previo.periodo} a ${actual.periodo}: los períodos van consecutivos y un mes ` +
            "sin informe se declara con el punto en null, no se omite (doc 10 §I.7, caso 8)",
        );
      }
    }
    if (s.puntos.every((p) => p.texto === null)) {
      error(["puntos"], "la serie no tiene ni un punto con dato: no es una serie, es una ventana vacía");
    }
  });
export type SerieHistorica = z.infer<typeof serieHistoricaSchema>;

/** `"2026-12"` → `"2027-01"`. Sin `Date`: una zona horaria no tiene nada que decir sobre un período. */
export function mesSiguiente(periodo: string): string {
  const [anio = "0", mes = "1"] = periodo.split("-");
  const m = Number(mes);
  return m === 12 ? `${Number(anio) + 1}-01` : `${anio}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * Escala interna con la que se comparan las magnitudes publicadas: 6 decimales.
 *
 * Sobra para dinero (2) y para un porcentaje (2 o 4), y **es exacta**: la comparación entre una fila
 * y su total no puede depender de un `number`.
 */
const ESCALA = 1_000_000n;

/**
 * La magnitud que dibuja una forma, leída **del texto ya formateado**.
 *
 * Es la implementación literal de §I.8.2: la única entrada de la geometría es la cadena que el lector
 * tiene impresa delante. Acepta el formato argentino que produce `formatearMonto` /
 * `formatearDecimal` (`1.234.567,89`), con o sin `$`, con o sin `%`, y con el menos tipográfico
 * (`−`) además del guion.
 *
 * **No acepta un `monto` de dominio** (`"1234567.89"`): un punto como separador de miles no puede
 * significar también coma decimal, y el día que alguien pase el valor exacto por error, esto falla
 * ruidosamente en vez de dibujar una barra mil veces más corta.
 */
export function magnitudPublicada(texto: string): bigint {
  const limpio = texto.trim().replace(/[$%\s]/g, "").replace(/^\+/, "");
  const negativo = /^[-−]/.test(limpio);
  const cuerpo = limpio.replace(/^[-−]/, "");
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,6})?$/.test(cuerpo)) {
    throw new Error(
      `"${texto}" no es una cifra publicada en formato argentino: la forma se alimenta del texto impreso, ` +
        "nunca del monto de dominio (doc 10 §I.8.2)",
    );
  }
  const [enteros = "0", decimales = ""] = cuerpo.replace(/\./g, "").split(",");
  const escalado = BigInt(enteros) * ESCALA + BigInt(decimales.padEnd(6, "0").slice(0, 6));
  return negativo ? -escalado : escalado;
}
