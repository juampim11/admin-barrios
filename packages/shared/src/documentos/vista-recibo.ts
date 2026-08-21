/**
 * `VistaRecibo` — el modelo de vista del recibo de un pago (ADR-0001 §4.1, aplicado a `pago`/
 * `recibo_emitido` en vez de a una liquidación).
 *
 * Mismo principio que `VistaBoleta`: el dominio no produce HTML ni PDF, produce este objeto plano y
 * validado, con todo ya resuelto y formateado — la plantilla no formatea nada (evita el bug de ICU,
 * doc 07 §A) — y se congela junto con `recibo_emitido.vista`.
 *
 * **Mucho más chico que la boleta, a propósito.** Un recibo acredita UNA operación ya ocurrida — un
 * pago que ya se cobró —, no una liquidación con líneas variables. No hay detalle de conceptos, ni
 * cupón, ni instrumento de pago: eso es lo que la boleta ofrece para que alguien pague: el recibo
 * solo confirma que ya se pagó.
 */

import { z } from "zod";
import { origenPagoSchema } from "../cobros.ts";
import { cifraSchema, fechaImpresaSchema } from "./primitivas.ts";
import { marcaDocumentoSchema } from "./vista-boleta.ts";

/** Viaja con el documento guardado: un cambio incompatible sube el número (ADR-0001 §6). */
export const VERSION_VISTA_RECIBO = "recibo/1";

export const vistaReciboSchema = z
  .object({
    version: z.literal(VERSION_VISTA_RECIBO),
    /** Mismo modelo de marca de dos niveles que la boleta: barrio arriba y grande, emisor legal chico. */
    marca: marcaDocumentoSchema,
    unidad: z
      .object({
        etiqueta: z.string().min(1),
        /**
         * `null`: el pago no tiene un obligado vinculado — `pago.obligado_id` es nullable (la unidad
         * puede no tener uno vigente al momento de registrar el cobro). No se inventa un nombre; el
         * hueco se declara acá y la plantilla lo imprime en positivo ("a nombre de la unidad").
         */
        destinatario: z.string().min(1).nullable(),
        rolDestinatario: z.string().min(1).optional(),
      })
      .readonly(),
    recibo: z
      .object({
        /** Ya formateado (con el relleno de ceros que use la administración): la plantilla no decide. */
        numero: z.string().min(1),
        /** Fecha de emisión de ESTE recibo — puede no coincidir con la fecha del pago. */
        fecha: fechaImpresaSchema,
      })
      .readonly(),
    pago: z
      .object({
        /** Cuándo se cobró, no cuándo se emite el recibo. */
        fecha: fechaImpresaSchema,
        monto: cifraSchema,
        /** `manual` | `extracto` — espejo de `pago.origen` (`@admin-barrios/shared/cobros`). */
        origen: origenPagoSchema,
      })
      .readonly(),
    /** Redactadas solo en positivo (doc 07 §E): mismo filtro de lenguaje que el resto de la familia. */
    leyendas: z.array(z.string().min(1)).readonly(),
    /**
     * Datos que el diseño pide y el sistema todavía no guarda (doc 09 §E.11). Viaja congelado con el
     * documento y **no se imprime** — mismo criterio que `VistaBoleta.faltantes`.
     */
    faltantes: z.array(z.string().min(1)).readonly(),
  })
  .readonly();
export type VistaRecibo = z.infer<typeof vistaReciboSchema>;

/** Valida y devuelve la vista. Es el único borde por el que entra un recibo a renderizarse. */
export function parsearVistaRecibo(entrada: unknown): VistaRecibo {
  return vistaReciboSchema.parse(entrada);
}
