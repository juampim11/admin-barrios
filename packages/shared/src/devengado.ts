/**
 * «Cómo se devenga» (encargo 16, Etapa 1.3): de dónde sale lo que se le pide cada mes a cada unidad.
 *
 * Son cuatro decisiones del barrio, independientes entre sí, que rigen **desde un mes** y se guardan
 * como parámetros con vigencia (`parametro_valor`, claves de `./parametros-mora.ts`):
 *
 *  1. **De dónde sale el importe** (`devengado.origen`): lo define la administración antes de empezar
 *     el mes, o son los gastos del mes. De acá sale el modelo del período (`fija` / `variable`).
 *  2. **Cómo se reparte** (`devengado.reparto`): igual para todas o por coeficiente.
 *  3. **La bonificación por pago en término** (`bonificacion.*`): se aplica sola a quien está al día,
 *     a mano, o el barrio no bonifica.
 *  4. **Qué cobra el cupón** (`cupon.cobra`): solo el mes, o el mes más la deuda.
 *
 * **Sin valor cargado, el barrio se comporta como antes de este encargo** (`porDefecto`): el modelo
 * sale de `barrio.modelo_liquidacion`, el cupón cobra el mes más la deuda y la bonificación es a mano.
 * Por eso ningún barrio existente cambia al desplegar esto.
 *
 * Este archivo no toca la base ni calcula dinero: son los valores, los textos y las reglas que
 * comparten el servicio, la pantalla y los tests.
 */

import { z } from "zod";
import { aCentavos, montoSchema, normalizarMontoTipeado, periodoSchema, type Monto } from "./dinero.ts";
import type { ModeloExpensa } from "./liquidacion.ts";

export const ORIGENES_DEVENGADO = ["administracion", "gastos"] as const;
export type OrigenDevengado = (typeof ORIGENES_DEVENGADO)[number];

export const REPARTOS_DEVENGADO = ["igual", "coeficiente"] as const;
export type RepartoDevengado = (typeof REPARTOS_DEVENGADO)[number];

export const COBROS_DEL_CUPON = ["solo_mes", "mes_mas_deuda"] as const;
export type CobroDelCupon = (typeof COBROS_DEL_CUPON)[number];

export const MODOS_BONIFICACION = ["sola", "a_mano", "no"] as const;
export type ModoBonificacion = (typeof MODOS_BONIFICACION)[number];

export const FORMAS_BONIFICACION = ["porcentaje", "importe"] as const;
export type FormaBonificacion = (typeof FORMAS_BONIFICACION)[number];

/** La regla del barrio que aplica un concepto solo (`concepto_boleta.regla_barrio`, `0080`). */
export const REGLA_BONIFICACION = "bonificacion_pago_en_termino";

/** El nombre con que la bonificación sale en la boleta y en el catálogo. */
export const NOMBRE_BONIFICACION = "Bonificación por pago en término";

/** Cuánto se bonifica. `valor` es un porcentaje (`"7.5"` = 7,5 %) o un importe (`"15000.00"`). */
export type ValorDeBonificacion = {
  readonly forma: FormaBonificacion;
  readonly valor: string;
  /** El techo en pesos por unidad. Obligatorio con porcentaje (todo descuento porcentual lo lleva). */
  readonly tope: Monto | null;
};

export type ComoSeDevenga = {
  readonly origen: OrigenDevengado;
  readonly reparto: RepartoDevengado;
  readonly cuponCobra: CobroDelCupon;
  readonly bonificacion: {
    readonly modo: ModoBonificacion;
    /** `null` si no hay un valor cargado (con `a_mano` o `no` puede no haberlo). */
    readonly cuanto: ValorDeBonificacion | null;
  };
};

/** El modelo del período que corresponde a cada origen. */
export const modeloDeOrigen = (origen: OrigenDevengado): ModeloExpensa => (origen === "administracion" ? "fija" : "variable");

/** El origen que corresponde a un modelo (para un barrio que todavía no cargó «Cómo se devenga»). */
export const origenDeModelo = (modelo: ModeloExpensa): OrigenDevengado => (modelo === "fija" ? "administracion" : "gastos");

/**
 * Lo que rige cuando el barrio no cargó nada: **el comportamiento anterior al encargo 16**. El
 * reparto por omisión es el del modelo —un importe por unidad en cuota fija, por coeficiente en el
 * prorrateo de gastos—.
 */
export function porDefecto(modelo: ModeloExpensa): ComoSeDevenga {
  return {
    origen: origenDeModelo(modelo),
    reparto: modelo === "fija" ? "igual" : "coeficiente",
    cuponCobra: "mes_mas_deuda",
    bonificacion: { modo: "a_mano", cuanto: null },
  };
}

/** Lo que `crearBarrio` escribe en un barrio nuevo: su modelo, y el cupón que cobra solo el mes. */
export function inicialDeBarrioNuevo(modelo: ModeloExpensa): Pick<ComoSeDevenga, "origen" | "reparto" | "cuponCobra"> {
  return { origen: origenDeModelo(modelo), reparto: modelo === "fija" ? "igual" : "coeficiente", cuponCobra: "solo_mes" };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Quién recibe la bonificación
// ────────────────────────────────────────────────────────────────────────────────────────────────

export const TIPOS_EXCEPCION_BONIFICACION = ["dar", "quitar"] as const;
export type TipoExcepcionBonificacion = (typeof TIPOS_EXCEPCION_BONIFICACION)[number];

/**
 * Si una unidad recibe la bonificación que se aplica sola. La regla es estar al día; la excepción de
 * la administración, si la hay, manda sobre la regla en los dos sentidos.
 */
export function recibeBonificacion(entrada: { readonly alDia: boolean; readonly excepcion: TipoExcepcionBonificacion | null }): boolean {
  if (entrada.excepcion === "dar") return true;
  if (entrada.excepcion === "quitar") return false;
  return entrada.alDia;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La deuda anterior, mes por mes (`liquidacion.deuda_anterior`)
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Un mes adeudado: su capital pendiente y el interés que ese mes generó. */
export const deudaAnteriorDelMesSchema = z
  .object({
    /** `YYYY-MM`. */
    periodo: periodoSchema,
    /** `YYYY-MM-DD`: el primer vencimiento de ese mes. */
    vencimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    capital: montoSchema,
    interes: montoSchema,
  })
  .strict();
export type DeudaAnteriorDelMes = z.infer<typeof deudaAnteriorDelMesSchema>;
export const deudaAnteriorSchema = z.array(deudaAnteriorDelMesSchema);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Lo que llega del formulario
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** El mismo mínimo que todo motivo de parámetro (`MOTIVO_MINIMO`, `app.fijar_parametro`). */
const MOTIVO_MINIMO_DEVENGADO = 15;

/**
 * Lo que tipea una persona como porcentaje (`"7,5"`, `"7.5 %"`) → `"7.5"`. `null` si no es un
 * porcentaje entre 0,01 y 100, con hasta cuatro decimales.
 */
export function porcentajeDeBonificacion(texto: string): string | null {
  const limpio = texto.trim().replace(/\s*%$/, "").replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(limpio)) return null;
  const [ent = "0", dec = ""] = limpio.split(".");
  const diezmilesimas = BigInt(ent) * 10_000n + BigInt(dec.padEnd(4, "0"));
  // De 0,01 a 100: el mismo piso que `concepto_boleta_valor_porcentaje_chk`.
  if (diezmilesimas < 100n || diezmilesimas > 1_000_000n) return null;
  const d = dec.replace(/0+$/, "");
  return d === "" ? String(BigInt(ent)) : `${BigInt(ent)}.${d}`;
}

/** `"7.5"` → `"7,5 %"`. */
export const textoDePorcentaje = (valor: string): string => `${valor.replace(".", ",")} %`;

const vacioANull = <T extends z.ZodTypeAny>(esquema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : (v ?? null)), esquema.nullable());

const montoTipeado = z.string().transform((v, ctx) => {
  // Llegan las dos formas: la que tipea una persona (`15.000,00`, punto de miles) y la canónica
  // (`15000.00`, punto decimal, lo que manda un campo de monto o un script). Un punto seguido de
  // exactamente dos dígitos al final es decimal: sin esto, `15000.00` se guardaba como 1.500.000,00.
  const m = /^\d+\.\d{2}$/.test(v.trim()) ? v.trim() : normalizarMontoTipeado(v);
  if (!montoSchema.safeParse(m).success || aCentavos(m) <= 0n) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Escribí un importe mayor que cero, por ejemplo 15.000,00" });
    return z.NEVER;
  }
  return m as Monto;
});

/**
 * Guardar «Cómo se devenga». Los cuatro puntos viajan juntos, con el mes desde el que rigen y el
 * motivo. La base vuelve a validar cada valor y el mes (`app.fijar_parametro`, `0079`).
 */
export const cambiarComoSeDevengaSchema = z
  .object({
    barrioId: z.guid("identificador inválido"),
    /** `YYYY-MM`: el mes desde el que rige. No puede estar emitido. */
    rigeDesde: periodoSchema,
    origen: z.enum(ORIGENES_DEVENGADO),
    reparto: z.enum(REPARTOS_DEVENGADO),
    cuponCobra: z.enum(COBROS_DEL_CUPON),
    bonificacionModo: z.enum(MODOS_BONIFICACION),
    bonificacionForma: vacioANull(z.enum(FORMAS_BONIFICACION)).default(null),
    /** Como lo tipeó la persona: un porcentaje o un importe, según la forma. */
    bonificacionValor: vacioANull(z.string()).default(null),
    bonificacionTope: vacioANull(z.string()).default(null),
    motivo: z
      .string()
      .trim()
      .min(MOTIVO_MINIMO_DEVENGADO, `el motivo: al menos ${MOTIVO_MINIMO_DEVENGADO} caracteres. Queda en el historial.`)
      .max(500),
  })
  .transform((e, ctx) => {
    const base = {
      barrioId: e.barrioId,
      rigeDesde: e.rigeDesde,
      origen: e.origen,
      reparto: e.reparto,
      cuponCobra: e.cuponCobra,
      bonificacionModo: e.bonificacionModo,
      motivo: e.motivo,
    };
    // «Este barrio no bonifica»: no hay cuánto.
    if (e.bonificacionModo === "no") return { ...base, cuanto: null as ValorDeBonificacion | null };

    // A mano, el cuánto es opcional (la administración puede seguir con sus propios conceptos).
    if (e.bonificacionModo === "a_mano" && e.bonificacionValor === null) return { ...base, cuanto: null as ValorDeBonificacion | null };

    if (e.bonificacionForma === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bonificacionForma"], message: "Elegí si es un porcentaje de la expensa o un importe fijo." });
      return z.NEVER;
    }
    if (e.bonificacionValor === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bonificacionValor"], message: "Escribí cuánto se bonifica." });
      return z.NEVER;
    }
    if (e.bonificacionForma === "porcentaje") {
      const valor = porcentajeDeBonificacion(e.bonificacionValor);
      if (valor === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bonificacionValor"], message: "Un porcentaje mayor que 0 y hasta 100, por ejemplo 7,5." });
        return z.NEVER;
      }
      // Todo descuento porcentual lleva un techo en pesos (`cbv_tope_obligatorio_chk`): sin él, el
      // importe escala con la expensa y nadie decidió cuánto es lo máximo que el barrio deja de cobrar.
      if (e.bonificacionTope === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bonificacionTope"], message: "Escribí el tope por unidad: un porcentaje siempre lleva un máximo en pesos." });
        return z.NEVER;
      }
      const tope = montoTipeado.safeParse(e.bonificacionTope);
      if (!tope.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bonificacionTope"], message: tope.error.issues[0]?.message ?? "Importe inválido." });
        return z.NEVER;
      }
      return { ...base, cuanto: { forma: "porcentaje", valor, tope: tope.data } as ValorDeBonificacion | null };
    }
    const importe = montoTipeado.safeParse(e.bonificacionValor);
    if (!importe.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bonificacionValor"], message: importe.error.issues[0]?.message ?? "Importe inválido." });
      return z.NEVER;
    }
    return { ...base, cuanto: { forma: "importe", valor: importe.data, tope: null } as ValorDeBonificacion | null };
  });
export type CambiarComoSeDevenga = z.input<typeof cambiarComoSeDevengaSchema>;
export type ComoSeDevengaACambiar = z.output<typeof cambiarComoSeDevengaSchema>;

/** «Dársela igual» o «Quitar»: una excepción de la bonificación para una unidad en un mes. */
export const ponerExcepcionDeBonificacionSchema = z.object({
  periodoId: z.guid("identificador inválido"),
  unidadFuncionalId: z.guid("identificador inválido"),
  tipo: z.enum(TIPOS_EXCEPCION_BONIFICACION),
  motivo: z.string().trim().min(5, "Escribí el motivo: queda en el historial de la unidad.").max(500),
});
export type PonerExcepcionDeBonificacion = z.input<typeof ponerExcepcionDeBonificacionSchema>;

/** Sacar una excepción: la unidad vuelve a la regla. También lleva motivo. */
export const sacarExcepcionDeBonificacionSchema = z.object({
  periodoId: z.guid("identificador inválido"),
  unidadFuncionalId: z.guid("identificador inválido"),
  motivo: z.string().trim().min(5, "Escribí el motivo: queda en el historial de la unidad.").max(500),
});
export type SacarExcepcionDeBonificacion = z.input<typeof sacarExcepcionDeBonificacionSchema>;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Textos (los mismos en el panel, en la ficha del mes y en el historial)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export const TEXTO_ORIGEN: Record<OrigenDevengado, { readonly titulo: string; readonly detalle: string; readonly corto: string }> = {
  administracion: {
    titulo: "Lo define la administración",
    detalle: "Se pide un importe decidido antes de empezar el mes. Se devenga por adelantado: el mes corriente.",
    corto: "Importe definido por la administración",
  },
  gastos: {
    titulo: "Los gastos del mes",
    detalle: "Se reparte lo que el barrio gastó de verdad. Se devenga a mes vencido, cuando los gastos están cargados.",
    corto: "Los gastos del mes",
  },
};

export const TEXTO_REPARTO: Record<RepartoDevengado, { readonly titulo: string; readonly detalle: string; readonly corto: string }> = {
  igual: { titulo: "Igual para todas", detalle: "Un importe por unidad.", corto: "igual para todas" },
  coeficiente: {
    titulo: "Por coeficiente",
    detalle: "Un total del mes, repartido según el coeficiente de cada unidad.",
    corto: "por coeficiente",
  },
};

export const TEXTO_CUPON: Record<CobroDelCupon, { readonly titulo: string; readonly detalle: string; readonly corto: string }> = {
  solo_mes: {
    titulo: "Solo el mes",
    detalle:
      "El total a pagar es lo devengado ese mes. La deuda de meses anteriores figura como referencia, sin sumar.",
    corto: "el cupón cobra solo el mes",
  },
  mes_mas_deuda: {
    titulo: "El mes más la deuda",
    detalle: "El total a pagar suma la deuda de meses anteriores y su interés.",
    corto: "el cupón cobra el mes más la deuda",
  },
};

export const TEXTO_MODO_BONIFICACION: Record<ModoBonificacion, string> = {
  sola: "Sola, a quien está al día",
  a_mano: "A mano, unidad por unidad",
  no: "Este barrio no bonifica",
};

export const TEXTO_FORMA_BONIFICACION: Record<FormaBonificacion, string> = {
  porcentaje: "Porcentaje de la expensa",
  importe: "Importe fijo",
};

/** Qué significa estar al día, con las mismas palabras en todos lados. */
export const TEXTO_ESTAR_AL_DIA =
  "Estar al día es no tener deuda vencida en el momento de emitir, con los pagos imputados hasta ese momento.";
