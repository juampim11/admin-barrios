/**
 * El bloque de pago **como dato** (ADR-0001 §4.4).
 *
 * Acá vive el descriptor: qué instrumentos hay, qué codifican y qué se imprime. El **puerto**
 * `MedioCobranza` (quién lo arma y quién lo verifica) y sus adapters viven en
 * `@admin-barrios/documentos/cobranza` — el modelo de vista no depende de ellos, que es lo que
 * permite congelar un bloque de pago emitido hace un año y volver a leerlo sin el adapter que lo
 * produjo.
 *
 * **La plantilla no sabe de qué red salió**: recorre `instrumentos` y pinta. No tiene un `if` por
 * banco. Nunca (ADR-0001 §4.4).
 */

import { z } from "zod";
import { cifraSchema, fechaImpresaSchema, logoDocumentoSchema } from "./primitivas.ts";

/** Simbologías que el renderizador sabe dibujar y un lector real sabe decodificar. */
export const SIMBOLOGIAS = ["interleaved2of5", "code128", "qrcode"] as const;
export const simbologiaSchema = z.enum(SIMBOLOGIAS);
export type Simbologia = (typeof SIMBOLOGIAS)[number];

/**
 * Un símbolo (código de barras o QR).
 *
 * **La geometría no está acá a propósito.** El ancho de módulo, la zona muda y el fondo los impone
 * el renderizador (`simbolos.ts`), no el adapter: así las guardas de ADR-0001 §7 las hereda gratis
 * todo adapter futuro, en vez de depender de que cada convenio nuevo se acuerde de copiarlas.
 */
export const instrumentoSimboloSchema = z.object({
  tipo: z.literal("simbolo"),
  etiqueta: z.string().min(1),
  simbologia: simbologiaSchema,
  /** Exactamente lo que se codifica. */
  carga: z.string().min(1),
  /**
   * Lo que se imprime debajo, para el humano y para el cajero. Puede llevar espacios de
   * agrupación (`"0000 0000 0174"`), pero **sin espacios tiene que ser idéntico a `carga`**: si
   * difieren, el símbolo dice un número y el papel dice otro — que es exactamente la falla
   * silenciosa de ADR-0001 §7.1. `null` = no se imprime nada debajo (el caso del QR).
   */
  leible: z.string().min(1).nullable(),
});

/** CBU, alias, código de pago electrónico, titular: texto que alguien tipea a mano. */
export const instrumentoTextoSchema = z.object({
  tipo: z.literal("texto"),
  etiqueta: z.string().min(1),
  valor: z.string().min(1),
  /** Aclaración corta (titular de la cuenta, "poné el N.º de comprobante en la referencia"). */
  nota: z.string().min(1).nullable(),
});

export const instrumentoPagoSchema = z.discriminatedUnion("tipo", [
  instrumentoSimboloSchema,
  instrumentoTextoSchema,
]);
export type InstrumentoPago = z.infer<typeof instrumentoPagoSchema>;
export type InstrumentoSimbolo = z.infer<typeof instrumentoSimboloSchema>;

/** `leible` sin los espacios de agrupación: lo que tiene que coincidir con `carga`. */
export function leibleNormalizado(leible: string): string {
  return leible.replace(/\s+/g, "");
}

export const bloquePagoSchema = z
  .object({
    /** Clave del adapter que lo armó (`"generico-demo"`). Se persiste con el documento (§6). */
    medio: z.string().min(1),
    instrumentos: z.array(instrumentoPagoSchema).min(1).readonly(),
    fechas: z
      .object({
        vencimiento: fechaImpresaSchema,
        /**
         * Límite de la red de cobranza, **no un segundo vencimiento con recargo** (doc 09 §B.6).
         * Hoy el sistema **no tiene campo propio** para esto (doc 09 §E.11 ítem 1).
         */
        tope: fechaImpresaSchema.nullable(),
      })
      .readonly(),
    importes: z
      .object({ alVencimiento: cifraSchema, alTope: cifraSchema.nullable() })
      .readonly(),
    /** Pasan por la lista de lenguaje prohibido del doc 07 §E antes de imprimirse. */
    leyendas: z.array(z.string().min(1)).readonly(),
    logos: z.array(logoDocumentoSchema).readonly(),
    /**
     * `true` ⇒ el **renderizador** estampa la marca de agua obligatoria (ADR-0001 §10). No es una
     * opción de la plantilla ni de la configuración: un documento con un código de barras legible y
     * un importe se parece demasiado a un instrumento de pago real.
     */
    sinValorDePago: z.boolean(),
  })
  .superRefine((bloque, ctx) => {
    bloque.instrumentos.forEach((inst, i) => {
      if (inst.tipo !== "simbolo" || inst.leible === null) return;
      if (leibleNormalizado(inst.leible) !== inst.carga) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["instrumentos", i, "leible"],
          message: `el número impreso no es el que se codifica (impreso "${inst.leible}", codificado "${inst.carga}")`,
        });
      }
    });

    // Doc 09 §B.6: la fecha tope lleva **el mismo importe** que el vencimiento. Dos importes
    // distintos sin descuento condicional en el modelo sería inventar un punitorio en la plantilla
    // (doc 09 §E.12 punto 9).
    if (bloque.importes.alTope && bloque.importes.alTope.monto !== bloque.importes.alVencimiento.monto) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["importes", "alTope"],
        message: "la fecha tope no es un segundo vencimiento con recargo: lleva el mismo importe",
      });
    }
    if ((bloque.fechas.tope === null) !== (bloque.importes.alTope === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["importes", "alTope"],
        message: "la fecha tope y su importe van juntos o no van",
      });
    }
    if (bloque.fechas.tope && bloque.fechas.tope.iso < bloque.fechas.vencimiento.iso) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fechas", "tope"],
        message: "la fecha tope no puede ser anterior al vencimiento",
      });
    }
  });
export type BloquePago = z.infer<typeof bloquePagoSchema>;
