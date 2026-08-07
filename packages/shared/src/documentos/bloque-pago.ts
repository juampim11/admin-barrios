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
    /**
     * **Dónde** se puede pagar, en palabras y en el orden en que conviene ofrecerlo: `["Pago
     * electrónico", "Transferencia", "En la caja"]`.
     *
     * Existe porque la zona 1 de la boleta contesta tres preguntas —cuánto, cuándo y **dónde**— y la
     * tercera no se puede derivar de `instrumentos`: la plantilla juntaba las etiquetas de todos los
     * instrumentos de texto y la celda terminaba diciendo "Pago electrónico · CBU · Alias ·
     * Convenio". **"Convenio" no es un lugar donde pagar**: es el número del acuerdo con la red, un
     * campo del cupón. Un canal y un campo del cupón no son la misma cosa aunque los dos vivan en el
     * bloque de pago, así que el adapter —que es el único que sabe qué acepta su red— los declara
     * por separado. La plantilla sigue sin tener un `if` por banco: imprime esta lista.
     *
     * Vacío es legítimo y no es un hueco: significa "no hay canal que se pueda nombrar en dos
     * palabras", y la boleta remite al cupón del pie, que es donde están los datos completos.
     */
    canalesDePago: z.array(z.string().min(1)).readonly().default([]),
    fechas: z
      .object({
        vencimiento: fechaImpresaSchema,
        /**
         * **La SEGUNDA fecha de vencimiento del período**, con su propio importe en `importes.alTope`.
         *
         * ⚠ El nombre `tope` es histórico y hoy dice menos de lo que el campo significa. Nació
         * copiando el papel del piloto, que la llama *"fecha tope de recaudación"* y le cobra el mismo
         * importe —para ese barrio es el límite de la red, no una segunda fecha con recargo—, y de ahí
         * salía una regla que **prohibía** que los importes difirieran.
         *
         * **Esa regla se levantó el 2026-08-05, por decisión del usuario**: *"si hay 2 fechas
         * configuradas, se muestran las 2 fechas y el monto en cada fecha. Si no hay recargo, el monto
         * es el mismo."* O sea que **dos fechas configurables es el modelo**, y que un barrio no cobre
         * recargo en la segunda es su política, no la ausencia del campo. Copiar el vocabulario del
         * papel de un barrio al modelo de todos era el error.
         *
         * **No se renombró a `segundoVencimiento` y no es por pereza:** el nombre viaja adentro de
         * cada `vista` congelada de `documento_emitido`, y `vistaBoletaSchema.version` es un
         * `z.literal("boleta/1")` — renombrar obliga a subir la versión y a escribir un lector
         * multi-versión que **no existe**. Queda anotado como deuda.
         */
        tope: fechaImpresaSchema.nullable(),
      })
      .readonly(),
    importes: z
      .object({ alVencimiento: cifraSchema, alTope: cifraSchema.nullable() })
      .readonly(),
    /**
     * **Cómo se entrega el cupón.** Lo declara el ADAPTER, que es el único que sabe qué hace su red;
     * la plantilla no lo infiere de los instrumentos.
     *
     * Existe porque los rótulos estaban **escritos a mano en la plantilla** y el troquel se dibujaba
     * *siempre*. Con un medio 100 % electrónico, *"PRESENTÁ ESTA PARTE EN LA CAJA"* es **falso** y no
     * hay nada que cortar: es el mismo error que "Prorrateo del mes" en un barrio de cuota fija
     * (regla 6 de `CLAUDE.md`), pero impreso en el papel que recibe el vecino.
     *
     * El `.default()` reproduce **exactamente** el papel de hoy, así que ninguna vista ya emitida
     * cambia de forma ni de aspecto y `"boleta/1"` sigue siendo válida.
     */
    presentacion: z
      .object({
        /** Rótulo del troquel. `null` ⇒ no hay nada que cortar y **el troquel no se dibuja**. */
        troquel: z.string().min(1).nullable(),
        /** Rótulo del talón que se queda quien paga. `null` ⇒ no se imprime talón. */
        talon: z.string().min(1).nullable(),
        /**
         * Una o dos frases de **cómo se paga con este medio**. No son leyendas legales —esas van en
         * `leyendas` y pasan por la lista de lenguaje prohibido—: son la instrucción operativa
         * ("Escaneá el QR desde tu billetera", "Transferí y guardá el comprobante").
         */
        instrucciones: z.array(z.string().min(1)).max(2).readonly(),
      })
      .readonly()
      .default({
        troquel: "PRESENTÁ ESTA PARTE EN LA CAJA",
        talon: "PARA LA ADMINISTRACIÓN",
        instrucciones: [],
      }),
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

    /*
     * **Acá había una regla que exigía que los dos importes fueran IGUALES**, y se levantó el
     * 2026-08-05 por decisión del usuario. Vale dejar escrito qué decía y por qué se cayó, porque el
     * argumento que la sostenía era bueno y alguien va a querer reponerla.
     *
     * Decía: *"la fecha tope no es un segundo vencimiento con recargo: lleva el mismo importe"*, y el
     * motivo era sólido — sin un modelo de recargo, dos importes distintos serían **la plantilla
     * inventando un punitorio** (doc 09 §E.12 punto 9).
     *
     * Lo que estaba mal no era el cuidado: era **de dónde salía la regla**. Salía de mirar el papel
     * del barrio piloto, que no cobra recargo. Generalizar la política de un barrio a una restricción
     * del modelo es la regla 6 de `CLAUDE.md` al revés — y deja al producto sin poder representar al
     * barrio de al lado, que sí lo cobra.
     *
     * **La restricción que sí corresponde es la que queda abajo**: las dos fechas van juntas o no van,
     * y la segunda no puede ser anterior a la primera. Que los importes difieran o no es un hecho del
     * barrio.
     *
     * ⚠ Y el cuidado original sigue vigente en otro lado: **la plantilla no calcula el recargo**. El
     * importe al tope llega armado desde el servicio, como todo el dinero de la vista; si algún día
     * un adapter lo derivara de un porcentaje, ahí sí estaría inventando un punitorio.
     */
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
