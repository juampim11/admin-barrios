/**
 * `VistaAcuerdoPlan` — el modelo de vista del PDF de un plan de pagos (encargo P2a-3; ADR-0001 §4.1).
 *
 * Dos caminos, una sola vista:
 *  - **`modelo`**: la carátula con el modelo de cláusulas ya completado, las firmas, y el anexo.
 *  - **`anexo`**: solo el anexo, para acompañar el documento que redactó el estudio.
 *
 * El anexo va siempre, con **las cifras del motor**: las que guardó la base al proponer o al firmar
 * (`plan_pago`, `plan_liquidacion`, `plan_cuota`), nunca recalculadas acá. Por eso la vista valida los
 * dos cuadres que la base ya garantiza —deuda + financiación = cronograma + quita, y la suma de las
 * cuotas = el cronograma—: una vista que no cuadra no se renderiza.
 *
 * Mismo principio que el resto de la familia: todo llega resuelto y formateado (`Cifra`,
 * `FechaImpresa`); la plantilla no formatea nada. Se congela con el documento (`plan_documento.vista`).
 */

import { z } from "zod";
import { aCentavos } from "../dinero.ts";
import { cifraSchema, fechaImpresaSchema } from "./primitivas.ts";
import { marcaDocumentoSchema } from "./vista-boleta.ts";

/** Viaja con el documento guardado: un cambio incompatible sube el número (ADR-0001 §6). */
export const VERSION_VISTA_ACUERDO_PLAN = "acuerdo-plan/1";

const textoSchema = z.string().min(1);

export const vistaAcuerdoPlanSchema = z
  .object({
    version: z.literal(VERSION_VISTA_ACUERDO_PLAN),
    camino: z.enum(["modelo", "anexo"]),
    marca: marcaDocumentoSchema,
    /** Cuándo se armó este PDF. */
    emitido: fechaImpresaSchema,
    plan: z
      .object({
        /** `pendiente`: el PDF lleva «Propuesta» en cada hoja; las cifras se recalculan al aprobarlo. */
        estado: z.enum(["pendiente", "vigente", "cumplido", "caido"]),
        /** «Plan del catálogo «12 cuotas al 2 %»» / «Plan a medida». */
        descripcion: textoSchema,
        /** «Cuota fija sin interés» / «Sistema francés al 2 % mensual» / «Cronograma a medida». */
        financiacion: textoSchema,
        /** «Cobra el barrio» / «Cobra y rinde el estudio X». */
        cobro: textoSchema,
        /** El estudio que cobra y rinde, o `null` si cobra el barrio en la boleta (el texto del cronograma depende de esto). */
        cobraElEstudio: textoSchema.nullable(),
        /** La fecha de la firma, si ya se aprobó. */
        fechaFirma: fechaImpresaSchema.nullable(),
        /** El acta que aprobó la quita, si se cargó. */
        acta: textoSchema.nullable(),
      })
      .readonly(),
    unidad: z
      .object({
        etiqueta: textoSchema,
        /** El titular vigente de la unidad, o `null` si no hay uno cargado: no se inventa un nombre. */
        titular: textoSchema.nullable(),
      })
      .readonly(),
    /** La deuda que entra, mes por mes: capital e interés por mora a la fecha del alta o de la firma. */
    deuda: z
      .object({
        meses: z
          .array(z.object({ periodo: textoSchema, capital: cifraSchema, interes: cifraSchema, total: cifraSchema }).readonly())
          .min(1)
          .readonly(),
        capital: cifraSchema,
        interes: cifraSchema,
        total: cifraSchema,
      })
      .readonly(),
    quita: z.object({ interes: cifraSchema, capital: cifraSchema, total: cifraSchema, porcentaje: textoSchema }).readonly(),
    /** Interés de financiación (francés), o cero. */
    financiacion: cifraSchema,
    /** Lo que suma el cronograma: anticipo + cuotas. */
    totalDelPlan: cifraSchema,
    cuotas: z
      .array(
        z
          .object({
            /** 0 = anticipo. */
            numero: z.number().int().min(0).max(60),
            vencimiento: fechaImpresaSchema,
            importe: cifraSchema,
            capital: cifraSchema,
            interes: cifraSchema,
          })
          .readonly(),
      )
      .min(1)
      .readonly(),
    /** Lo que suman las columnas del cronograma: el capital y el interés de financiación. */
    totalCuotas: z.object({ capital: cifraSchema, interes: cifraSchema }).readonly(),
    /** Con cuántas cuotas vencidas sin pagar se puede dar por caído (regla del barrio). */
    cuotasParaCaer: z.number().int().min(1).max(12),
    /** Solo en el camino `modelo`: las cláusulas, ya completadas. */
    clausulas: z.array(z.object({ titulo: textoSchema, texto: textoSchema }).readonly()).readonly().nullable(),
    /** El modelo no está validado: va «Texto a validar por el estudio». */
    textoAValidar: z.boolean(),
    /** Solo en el camino `anexo`: el estudio cuyo documento acompaña, si el plan tiene uno. */
    estudio: textoSchema.nullable(),
    /** Redactadas en positivo, como el resto de la familia. */
    leyendas: z.array(textoSchema).readonly(),
  })
  .superRefine((v, ctx) => {
    const c = (x: { monto: string }) => aCentavos(x.monto as never);
    if (c(v.deuda.capital) + c(v.deuda.interes) !== c(v.deuda.total)) {
      ctx.addIssue({ code: "custom", path: ["deuda", "total"], message: "la deuda no es capital + interés" });
    }
    if (v.deuda.meses.reduce((s, m) => s + c(m.total), 0n) !== c(v.deuda.total)) {
      ctx.addIssue({ code: "custom", path: ["deuda", "meses"], message: "los meses no suman la deuda" });
    }
    if (c(v.quita.interes) + c(v.quita.capital) !== c(v.quita.total)) {
      ctx.addIssue({ code: "custom", path: ["quita", "total"], message: "la quita no es interés + capital" });
    }
    if (c(v.deuda.total) + c(v.financiacion) !== c(v.totalDelPlan) + c(v.quita.total)) {
      ctx.addIssue({ code: "custom", path: ["totalDelPlan"], message: "no cuadra: deuda + financiación ≠ cronograma + quita" });
    }
    if (v.cuotas.reduce((s, q) => s + c(q.importe), 0n) !== c(v.totalDelPlan)) {
      ctx.addIssue({ code: "custom", path: ["cuotas"], message: "las cuotas no suman el total del plan" });
    }
    v.cuotas.forEach((q, i) => {
      if (c(q.capital) + c(q.interes) !== c(q.importe)) {
        ctx.addIssue({ code: "custom", path: ["cuotas", i], message: "una cuota no es capital + interés" });
      }
    });
    if (
      v.cuotas.reduce((s, q) => s + c(q.capital), 0n) !== c(v.totalCuotas.capital) ||
      v.cuotas.reduce((s, q) => s + c(q.interes), 0n) !== c(v.totalCuotas.interes)
    ) {
      ctx.addIssue({ code: "custom", path: ["totalCuotas"], message: "las columnas del cronograma no suman sus totales" });
    }
    if ((v.camino === "modelo") !== (v.clausulas !== null)) {
      ctx.addIssue({ code: "custom", path: ["clausulas"], message: "las cláusulas van solo en el camino del modelo" });
    }
  })
  .readonly();
export type VistaAcuerdoPlan = z.infer<typeof vistaAcuerdoPlanSchema>;

/** Valida y devuelve la vista. Es el único borde por el que entra un acuerdo a renderizarse. */
export function parsearVistaAcuerdoPlan(entrada: unknown): VistaAcuerdoPlan {
  return vistaAcuerdoPlanSchema.parse(entrada);
}
