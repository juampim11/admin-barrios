/**
 * Los parámetros de mora e imputación: el registro tipado (ADR-0006).
 *
 * Cada clave declara su tipo, su nombre y su ayuda, si su cambio exige **respaldo** (de qué
 * instrumento sale el número) y su **valor inicial**: el que recibe una administración nueva. El
 * valor inicial no es un default escondido: el trigger de `0057` lo escribe como fila del nivel
 * administración desde el 2000-01-01, y desde ahí la única verdad son las filas de `parametro_valor`.
 * La base tiene la misma lista en `parametro_registro`; un test de integración verifica que
 * coincidan (`parametros-mora.test.ts` del proyecto `db`).
 *
 * El modelo (dos niveles, vigencias, motivo, anulación de lo programado) se portó de un sistema
 * hermano de cobranzas; acá la empresa es la **administración** y la obra es el **barrio**.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LAS TASAS SON FRACCIÓN, NO PORCENTAJE
 *
 * `"0.025"` es 2,5 % mensual: la misma unidad que usaba `tasa_mora.tasa_mensual` y que entiende
 * `calcularMora`, con hasta seis decimales (millonésimas). La pantalla muestra y recibe porcentaje;
 * la conversión vive **acá y en ningún otro lado** (`fraccionAPorcentaje`, `porcentajeAFraccion`).
 * Una sola unidad en la base es lo que hace posible la paridad al centavo con el cálculo anterior.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LOS TEXTOS DE AYUDA
 *
 * Los escribió `legal-ph` (panel del 2026-11-02) con base en `knowledge/cordoba/`. Donde no hay
 * fuente cargada (arts. 768-771, 793-794 y 900-903 del CCyC no lo están), los valores iniciales son
 * decisiones de producto y no conclusiones legales — por eso ningún texto cita un artículo. Ningún
 * texto dice "moroso", "deudor" ni "ejecutable" (`packages/documentos/src/lenguaje-prohibido.ts`).
 */

import { z } from "zod";
import { montoSchema } from "./dinero.ts";
import { ORDENES_IMPUTACION_BARRIO, type OrdenImputacionBarrio } from "./cobros.ts";

/** Las claves, en el orden en que se muestran. Espejo de `parametro_registro` (`0057`). */
export const CLAVES_PARAMETRO = [
  "interes.cobra",
  "interes.tasa_compensatoria",
  "interes.tasa_punitoria",
  "interes.gracia_dias",
  "interes.forma_gracia",
  "interes.tolerancia",
  "imputacion.orden",
] as const;
export type ClaveParametro = (typeof CLAVES_PARAMETRO)[number];
export const claveParametroSchema = z.enum(CLAVES_PARAMETRO);

export const FORMAS_GRACIA = ["corre_inicio", "escalon"] as const;
export type FormaGracia = (typeof FORMAS_GRACIA)[number];

/** De qué instrumento sale una tasa. Espejo del `check` de `parametro_valor.respaldo_tipo`. */
export const TIPOS_RESPALDO = ["reglamento", "acta_asamblea", "acta_comision", "otro"] as const;
export type TipoRespaldo = (typeof TIPOS_RESPALDO)[number];
export const tipoRespaldoSchema = z.enum(TIPOS_RESPALDO);

export const ETIQUETA_RESPALDO: Record<TipoRespaldo, string> = {
  reglamento: "Reglamento",
  acta_asamblea: "Acta de asamblea",
  acta_comision: "Acta de comisión",
  otro: "Otro",
};

/** Cómo se cargó una fila: por una persona, por la siembra de una administración nueva o por `0057`. */
export const CARGAS_PARAMETRO = ["usuario", "inicial", "migrado"] as const;
export type CargaParametro = (typeof CARGAS_PARAMETRO)[number];

/** Mínimo de caracteres de todo motivo (maqueta T1). El mismo número vive en `app.fijar_parametro`. */
export const MOTIVO_MINIMO = 15;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Tasas: fracción en la base, porcentaje en la pantalla
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Una tasa mensual como fracción: de 0 a 1 (100 %), hasta seis decimales. */
export const tasaFraccionSchema = z
  .string()
  .regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/, "tasa inválida: una fracción entre 0 y 1, con hasta seis decimales");

/** Millonésimas enteras de una tasa en fracción: `"0.025"` → `25000n`. */
export function tasaAMillonesimas(tasa: string): bigint {
  const valida = tasaFraccionSchema.parse(tasa);
  const [ent = "0", dec = ""] = valida.split(".");
  return BigInt(ent) * 1_000_000n + BigInt(dec.padEnd(6, "0"));
}

/** `25000n` → `"0.025"`. Sin ceros de más: es lo que se guarda y lo que se compara. */
export function millonesimasATasa(m: bigint): string {
  if (m < 0n || m > 1_000_000n) throw new Error(`tasa fuera de rango: ${m}`);
  const ent = m / 1_000_000n;
  const dec = (m % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return dec === "" ? ent.toString() : `${ent}.${dec}`;
}

/** `"0.025"` → `"2.5"`: el porcentaje con punto decimal, sin ceros de más. Exacto (cuatro decimales). */
export function fraccionAPorcentaje(tasa: string): string {
  const m = tasaAMillonesimas(tasa); // millonésimas de fracción = cienmilésimas... de porcentaje ×100
  const ent = m / 10_000n;
  const dec = (m % 10_000n).toString().padStart(4, "0").replace(/0+$/, "");
  return dec === "" ? ent.toString() : `${ent}.${dec}`;
}

/**
 * Lo que tipea una persona (`"2,5"`, `"2.5"`, `"3"`) → fracción (`"0.025"`). `null` si no es un
 * porcentaje entre 0 y 100 con hasta cuatro decimales: más precisión que eso no la tiene la base.
 */
export function porcentajeAFraccion(texto: string): string | null {
  const limpio = texto.trim().replace(",", ".").replace(/\s*%$/, "");
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(limpio)) return null;
  const [ent = "0", dec = ""] = limpio.split(".");
  const m = BigInt(ent) * 10_000n + BigInt(dec.padEnd(4, "0"));
  if (m > 1_000_000n) return null;
  return millonesimasATasa(m);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El valor de cada clave
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Esquema del valor (ya en la forma de la base) de cada clave. Espejo de `app.validar_parametro`. */
export const ESQUEMA_VALOR: { readonly [K in ClaveParametro]: z.ZodTypeAny } = {
  "interes.cobra": z.boolean(),
  "interes.tasa_compensatoria": tasaFraccionSchema,
  "interes.tasa_punitoria": tasaFraccionSchema,
  "interes.gracia_dias": z.number().int().min(0).max(365),
  "interes.forma_gracia": z.enum(FORMAS_GRACIA),
  "interes.tolerancia": montoSchema.refine((m) => !m.startsWith("-"), "la tolerancia no puede ser negativa"),
  "imputacion.orden": z.enum(ORDENES_IMPUTACION_BARRIO),
};

/** `null` si el valor es válido para la clave; si no, el motivo. */
export function validarValorParametro(clave: ClaveParametro, valor: unknown): string | null {
  const r = ESQUEMA_VALOR[clave].safeParse(valor);
  return r.success ? null : (r.error.issues[0]?.message ?? "valor inválido");
}

export type TipoParametro = "sino" | "tasa" | "dias" | "pesos" | "opcion";

export type DefinicionParametro = {
  readonly clave: ClaveParametro;
  readonly grupo: "Interés por mora" | "Imputación de pagos";
  readonly nombre: string;
  readonly ayuda: string;
  readonly tipo: TipoParametro;
  readonly opciones?: readonly { readonly valor: string; readonly texto: string; readonly corto: string }[];
  /** Fijar o cambiar esta clave exige decir de qué instrumento sale (decisión del titular, T1). */
  readonly requiereRespaldo: boolean;
  /** Lo que recibe una administración nueva. Espejo de `parametro_registro.valor_inicial`. */
  readonly inicial: unknown;
};

export const REGISTRO_PARAMETROS: readonly DefinicionParametro[] = [
  {
    clave: "interes.cobra",
    grupo: "Interés por mora",
    nombre: "Cobra interés por mora",
    ayuda:
      "Mientras esté en No, la liquidación no calcula interés y la revisión y la boleta lo dicen. Activalo solo si el reglamento o el estatuto del barrio prevé interés, o si lo votó la asamblea.",
    tipo: "sino",
    requiereRespaldo: false,
    inicial: false,
  },
  {
    clave: "interes.tasa_compensatoria",
    grupo: "Interés por mora",
    nombre: "Tasa compensatoria",
    ayuda:
      "Interés simple sobre el saldo vencido, por mes comercial de 30 días. Se calcula al centavo, sin redondear hacia arriba. Cargá la tasa que fija el reglamento o el acta de asamblea.",
    tipo: "tasa",
    requiereRespaldo: true,
    inicial: "0",
  },
  {
    clave: "interes.tasa_punitoria",
    grupo: "Interés por mora",
    nombre: "Tasa punitoria",
    ayuda:
      "Solo si el reglamento o el estatuto del barrio la prevé. Se suma a la tasa compensatoria. Una tasa total muy alta puede ser reducida por un juez: consultalo con el asesor legal del barrio antes de cargarla.",
    tipo: "tasa",
    requiereRespaldo: true,
    inicial: "0",
  },
  {
    clave: "interes.gracia_dias",
    grupo: "Interés por mora",
    nombre: "Días de gracia",
    ayuda:
      "Días después del vencimiento en los que un pago no genera interés. Si el reglamento fija otra cosa, manda el reglamento.",
    tipo: "dias",
    requiereRespaldo: false,
    inicial: 5,
  },
  {
    clave: "interes.forma_gracia",
    grupo: "Interés por mora",
    nombre: "Forma de la gracia",
    ayuda: "Qué pasa con los días de gracia cuando el pago llega tarde. «Corre el inicio» es la más favorable para el vecino.",
    tipo: "opcion",
    opciones: [
      {
        valor: "corre_inicio",
        texto: "Corre el inicio: el interés se cuenta desde el fin de la gracia",
        corto: "Corre el inicio",
      },
      {
        valor: "escalon",
        texto: "Escalón: si se paga fuera de la gracia, el interés se cuenta desde el vencimiento",
        corto: "Escalón",
      },
    ],
    requiereRespaldo: false,
    inicial: "corre_inicio",
  },
  {
    clave: "interes.tolerancia",
    grupo: "Interés por mora",
    nombre: "Tolerancia de saldado",
    ayuda:
      "Una diferencia igual o menor a este importe se da por cancelada y no genera interés. Al ser un monto fijo en pesos, conviene revisarlo cada tanto.",
    tipo: "pesos",
    requiereRespaldo: false,
    inicial: "100.00",
  },
  {
    clave: "imputacion.orden",
    grupo: "Imputación de pagos",
    nombre: "Orden de imputación",
    ayuda: "A qué se aplica un pago que no alcanza para cubrir todo el saldo. Elegí lo que diga el reglamento del barrio.",
    tipo: "opcion",
    opciones: [
      {
        valor: "intereses_primero_capital_antiguo",
        texto: "Intereses primero, después la deuda más antigua",
        corto: "Intereses primero",
      },
      { valor: "capital_primero", texto: "Capital primero, después intereses", corto: "Capital primero" },
    ],
    requiereRespaldo: false,
    inicial: "intereses_primero_capital_antiguo" satisfies OrdenImputacionBarrio,
  },
];

export function definicionDe(clave: ClaveParametro): DefinicionParametro {
  const d = REGISTRO_PARAMETROS.find((x) => x.clave === clave);
  if (!d) throw new Error(`parámetro desconocido: ${clave}`);
  return d;
}

/**
 * Lo que tipea la persona en el formulario (siempre string) → el valor en la forma de la base.
 * Devuelve `{ error }` con un texto para el campo si no se puede convertir.
 */
export function valorDesdeFormulario(
  clave: ClaveParametro,
  texto: string,
): { readonly valor: unknown } | { readonly error: string } {
  const d = definicionDe(clave);
  const t = texto.trim();
  let valor: unknown;
  switch (d.tipo) {
    case "sino":
      if (t !== "si" && t !== "no") return { error: "Elegí Sí o No." };
      valor = t === "si";
      break;
    case "tasa": {
      const f = porcentajeAFraccion(t);
      if (f === null) return { error: "Un porcentaje entre 0 y 100, con hasta cuatro decimales: 2,5 o 2.5." };
      valor = f;
      break;
    }
    case "dias":
      if (!/^\d{1,3}$/.test(t)) return { error: "Días corridos: un número entero." };
      valor = Number.parseInt(t, 10);
      break;
    case "pesos": {
      // Dos formas, porque llegan las dos: la que tipea una persona (`1.000,50`, punto de miles) y la
      // que manda `CampoMonto` (`1000.50`, punto decimal). Un punto seguido de 1 o 2 dígitos al final
      // es decimal; si no, es separador de miles. Sin esto, $ 100,50 se guardaba como $ 10.050,00.
      const m = /^\d+\.\d{1,2}$/.test(t) ? t : t.replaceAll(".", "").replace(",", ".");
      const conDecimales = /^\d+$/.test(m) ? `${m}.00` : /^\d+\.\d$/.test(m) ? `${m}0` : m;
      valor = conDecimales;
      break;
    }
    case "opcion":
      valor = t;
      break;
  }
  const problema = validarValorParametro(clave, valor);
  return problema === null ? { valor } : { error: problema };
}

/** El texto corto con el que se muestra un valor (sin formato de dinero: eso lo hace la pantalla). */
export function textoDeValor(clave: ClaveParametro, valor: unknown): string {
  const d = definicionDe(clave);
  switch (d.tipo) {
    case "sino":
      return valor === true ? "Sí" : "No";
    case "tasa":
      return `${fraccionAPorcentaje(String(valor)).replace(".", ",")} %`;
    case "dias":
      return valor === 1 ? "1 día" : `${String(valor)} días`;
    case "pesos":
      return String(valor);
    case "opcion":
      return d.opciones?.find((o) => o.valor === valor)?.corto ?? String(valor);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Lo que llega de los formularios
// ────────────────────────────────────────────────────────────────────────────────────────────────

const idSchema = z.guid("identificador inválido");
const fechaSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "fecha inválida (esperado AAAA-MM-DD)");
const motivoParametroSchema = z
  .string()
  .trim()
  .min(MOTIVO_MINIMO, `el motivo: al menos ${MOTIVO_MINIMO} caracteres. Queda en el historial.`)
  .max(500);
/** `""` = no cargado (un `FormData` no tiene `null`). */
const opcional = <T extends z.ZodTypeAny>(esquema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), esquema.nullable().default(null));
/** Lista cerrada de lo que cuenta como "sí": cualquier otra cosa es "no confirmó". */
const confirmacionSchema = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === "true" || v === "on" || v === "si")
  .default(false);

/**
 * Fijar un valor (en la administración o en el barrio). `valor` llega como lo tipeó la persona y se
 * convierte con `valorDesdeFormulario`: el error cae en su campo. La base vuelve a validar todo
 * (`app.fijar_parametro`): esto es la experiencia de usuario, aquello es el guardia.
 */
export const fijarParametroSchema = z
  .object({
    nodoId: idSchema,
    clave: claveParametroSchema,
    valor: z.string(),
    rigeDesde: fechaSchema,
    motivo: motivoParametroSchema,
    respaldoTipo: opcional(tipoRespaldoSchema),
    respaldoReferencia: opcional(z.string().trim().min(3, "la referencia: al menos 3 caracteres").max(300)),
    respaldoAdjunto: opcional(z.string().max(300)),
    confirmarActivarInteres: confirmacionSchema,
  })
  .transform((e, ctx) => {
    const v = valorDesdeFormulario(e.clave, e.valor);
    if ("error" in v) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["valor"], message: v.error });
      return z.NEVER;
    }
    if (definicionDe(e.clave).requiereRespaldo) {
      if (e.respaldoTipo === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["respaldoTipo"], message: "elegí de qué instrumento sale la tasa" });
      }
      if (e.respaldoReferencia === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["respaldoReferencia"],
          message: "la referencia: por ejemplo «Reglamento, art. 12» o «Acta de asamblea del 10/09/2026»",
        });
      }
      if (e.respaldoTipo === null || e.respaldoReferencia === null) return z.NEVER;
    }
    return { ...e, valor: v.valor };
  });
export type FijarParametro = z.input<typeof fijarParametroSchema>;

/** «Volver al valor general»: el barrio vuelve a heredar desde una fecha. */
export const volverAlValorGeneralSchema = z.object({
  barrioId: idSchema,
  clave: claveParametroSchema,
  rigeDesde: fechaSchema,
  motivo: motivoParametroSchema,
});
export type VolverAlValorGeneral = z.input<typeof volverAlValorGeneralSchema>;

/** Anular un cambio programado (que todavía no rige). */
export const anularParametroSchema = z.object({ filaId: idSchema, motivo: motivoParametroSchema });
export type AnularParametro = z.input<typeof anularParametroSchema>;

export const prepararSubidaDeRespaldoSchema = z.object({
  nodoId: idSchema,
  contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
});
export type PrepararSubidaDeRespaldo = z.input<typeof prepararSubidaDeRespaldoSchema>;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Lo que queda guardado en la liquidación (`liquidacion.parametros_mora`)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export const ORIGENES_PARAMETRO = ["barrio", "administracion"] as const;
export type OrigenParametro = (typeof ORIGENES_PARAMETRO)[number];

const respaldoUsadoSchema = z
  .object({ tipo: tipoRespaldoSchema, referencia: z.string(), adjunto: z.string().nullable() })
  .nullable();

/** Un valor tal como se usó: qué valía, de dónde salía y desde cuándo regía. */
export const valorUsadoSchema = z.object({
  valor: z.unknown(),
  origen: z.enum(ORIGENES_PARAMETRO),
  vigenteDesde: z.string(),
  carga: z.enum(CARGAS_PARAMETRO),
  filaId: z.string(),
  respaldo: respaldoUsadoSchema,
});
export type ValorUsado = z.infer<typeof valorUsadoSchema>;

/**
 * El registro de con qué se calculó la mora de una liquidación. Es el mismo para todas las unidades de
 * un período salvo `desglose`, que es el de la unidad.
 */
export const parametrosMoraUsadosSchema = z.object({
  /** La fecha a la que se resolvieron los valores (`fechaCorteMora`, o el vencimiento del período). */
  fechaReferencia: z.string(),
  /** La ventana de atraso; `null` si no se computaron días. */
  ventana: z.object({ desde: z.string(), hasta: z.string() }).nullable(),
  /** Los valores vigentes a `fechaReferencia`, por clave. */
  valores: z.record(z.string(), valorUsadoSchema),
  /** Los tramos de la ventana: qué tasa y qué «cobra» rigió cada día. */
  tramos: z.array(
    z.object({ desde: z.string(), cobra: z.boolean(), tasaCompensatoria: z.string(), tasaPunitoria: z.string() }),
  ),
  /** El interés de esta unidad separado en compensatorio y punitorio. `null` si no se cobra. */
  desglose: z.object({ compensatorio: z.string(), punitorio: z.string() }).nullable(),
  /**
   * Con saldo arrastrado de la cuenta corriente (ADR-0009): de dónde sale el saldo anterior (capital
   * pendiente) y el interés —el que quedó pendiente de pagos fuera de término y el de cada tramo de
   * capital impago hasta el corte—. Ausente en las liquidaciones sin arrastre.
   */
  arrastre: z
    .object({
      capital: z.string(),
      interesPendiente: z.string(),
      interesNuevo: z.string(),
      tramos: z.array(
        z.object({
          liquidacionId: z.string(),
          inicio: z.string(),
          fin: z.string(),
          desdeVencimiento: z.boolean(),
          base: z.string(),
          estado: z.string(),
          interes: z.string(),
          compensatorio: z.string(),
          punitorio: z.string(),
          interesCalculado: z.string(),
          dias: z.number(),
          diasDevengados: z.number(),
        }),
      ),
    })
    .optional(),
});
export type ParametrosMoraUsados = z.infer<typeof parametrosMoraUsadosSchema>;
