/**
 * Primitivas del modelo de vista de un documento (ADR-0001 §4.1).
 *
 * La idea que ordena todo el módulo: **un dato impreso viaja siempre con su valor exacto y con la
 * cadena que se imprime**, y un refinamiento de Zod verifica que la segunda salga de la primera.
 * Así:
 *
 *  - la plantilla **no formatea nada** — no puede equivocarse ni divergir entre PDF, email y web;
 *  - el test del dinero se hace sobre `monto` (aritmética exacta), no sobre el PDF (ADR-0001 §8);
 *  - el bug de ICU (`Intl` degradando a formato en-US en un Node slim) se vuelve **imposible de no
 *    ver**: el `parse` falla en cuanto el texto no coincide con el monto.
 */

import { z } from "zod";
import { coeficienteAEntero, formatearDecimal, formatearMonto, montoSchema } from "../dinero.ts";
import { fechaIsoSchema, formatearFecha } from "../fechas.ts";

// --- Dinero -------------------------------------------------------------------------------------

/**
 * Una cifra de dinero lista para imprimir: el valor exacto y su representación argentina.
 * **Construir siempre con `cifra()`** — el objeto literal es válido, pero solo si coincide.
 */
export const cifraSchema = z
  .object({
    /** Valor exacto, espejo de `numeric(14,2)`. Es sobre esto que se verifica el dinero. */
    monto: montoSchema,
    /** Lo que se imprime, sin símbolo de moneda: `"359.000,00"`. */
    texto: z.string().min(1),
  })
  .refine((c) => c.texto === formatearMonto(c.monto), {
    message: "el texto impreso no corresponde al monto (¿se formateó con Intl en vez del helper?)",
    path: ["texto"],
  });
export type Cifra = z.infer<typeof cifraSchema>;

/** Única forma correcta de armar una `Cifra`. */
export function cifra(monto: string): Cifra {
  const valido = montoSchema.parse(monto);
  return { monto: valido, texto: formatearMonto(valido) };
}

// --- Fechas -------------------------------------------------------------------------------------

/** Una fecha lista para imprimir: la de la base (`YYYY-MM-DD`) y la que ve el vecino. */
export const fechaImpresaSchema = z
  .object({ iso: fechaIsoSchema, texto: z.string().min(1) })
  .refine((f) => f.texto === formatearFecha(f.iso), {
    message: "el texto impreso no corresponde a la fecha",
    path: ["texto"],
  });
export type FechaImpresa = z.infer<typeof fechaImpresaSchema>;

/** Única forma correcta de armar una `FechaImpresa`. */
export function fechaImpresa(iso: string): FechaImpresa {
  const valido = fechaIsoSchema.parse(iso);
  return { iso: valido, texto: formatearFecha(valido) };
}

// --- Coeficiente --------------------------------------------------------------------------------

/** Coeficiente con más de 4 decimales, tal como lo guarda la base. */
export const coeficienteExactoSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "coeficiente inválido (esperado decimal positivo)");

/**
 * El coeficiente impreso. Se muestran **4 decimales de la participación** y se guarda el valor
 * exacto con el que se prorrateó: quien rehaga la cuenta con la calculadora obtiene otro número, y
 * la diferencia la explica la nota fija del documento (doc 07 §B).
 */
export const coeficienteImpresoSchema = z
  .object({
    /** El valor con el que se repartió, con los 9 decimales de la base. */
    valor: coeficienteExactoSchema,
    /** Participación sobre el juego de coeficientes, en porcentaje: `"1,9074"`. */
    participacionTexto: z.string().min(1),
  })
  .readonly();
export type CoeficienteImpreso = z.infer<typeof coeficienteImpresoSchema>;

/**
 * Arma el coeficiente impreso.
 *
 * @param valor Coeficiente exacto de la unidad.
 * @param sumaDelJuego Suma de los coeficientes de la versión. **Es obligatoria**: solo la base
 *   `parte_indivisa` normaliza a 1; en superficie/lote/mixto son pesos relativos (art. 2081) y
 *   dividir por 1 imprimiría un porcentaje falso.
 */
export function coeficienteImpreso(valor: string, sumaDelJuego: string): CoeficienteImpreso {
  coeficienteExactoSchema.parse(valor);
  coeficienteExactoSchema.parse(sumaDelJuego);
  // Misma escala y misma regla de truncado que usa el prorrateo: si acá se convirtiera distinto, el
  // porcentaje impreso dejaría de corresponder al coeficiente con el que se cobró.
  const escala = 1_000_000_000n;
  const suma = coeficienteAEntero(sumaDelJuego);
  if (suma === 0n) throw new Error("la suma de coeficientes del juego es cero: no hay participación que imprimir");
  // Porcentaje con 9 decimales de trabajo; el formateador redondea a los 4 que se muestran.
  const porcentaje = (coeficienteAEntero(valor) * 100n * escala) / suma;
  const entero = porcentaje / escala;
  const resto = (porcentaje % escala).toString().padStart(9, "0");
  return { valor, participacionTexto: formatearDecimal(`${entero}.${resto}`, 4) };
}

// --- Logo ---------------------------------------------------------------------------------------

/**
 * Un logo ya resuelto a `data:`. **Nunca una URL**: el renderizador tiene la red apagada y aborta
 * todo lo que no sea `data:` (ADR-0001 §3.2), así que un logo por URL saldría en blanco.
 * La caja es por **límites** y el ajuste es `contain` (doc 09 §E.9.2): el logo toca uno de los dos
 * lados, nunca los dos, y **nunca define la altura de la cabecera**.
 */
export const logoDocumentoSchema = z
  .object({
    dataUri: z.string().regex(/^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/, "el logo tiene que venir como data: (la red está apagada en el renderizador)"),
    altoMaxMm: z.number().positive().max(20),
    anchoMaxMm: z.number().positive().max(45),
  })
  .readonly();
export type LogoDocumento = z.infer<typeof logoDocumentoSchema>;
