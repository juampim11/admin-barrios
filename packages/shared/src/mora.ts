/**
 * La mora del lado de la administración y los estudios jurídicos (encargo E-a, BL-050). Dominio puro:
 * lo que toca Postgres está en `packages/data/src/servicios/mora.ts`.
 *
 * **Nada de acá calcula deuda ni interés.** Las cifras de cada unidad las calcula `deudaALaFecha`
 * (`packages/data/src/servicios/deuda.ts`), la misma cuenta del estado de cuenta y de la boleta; acá
 * solo se las compara contra el criterio para **proponer** una derivación. Derivar es siempre una
 * decisión de la administración: nadie se deriva solo.
 *
 * Portado de Aclade (`aclade-cobranzas`): los textos de canal y resultado y la regla de la promesa
 * (`src/lib/gestiones.ts`, `promesas_de_pago` de `0014`), y la neutralización de fórmulas del CSV
 * (`src/lib/estudio-csv.ts`, `celdaCsv`).
 */
import { z } from "zod";
import { idSchema } from "./consultas.ts";
import { aCentavos, deCentavos, montoSchema, type Monto } from "./dinero.ts";
import { normalizarCuit } from "./cuentas.ts";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El criterio para proponer
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type CriterioMora = {
  /** Se propone con **más de** estos meses de deuda vencida. */
  readonly meses: number;
  /** Y con una deuda (capital vencido + interés a hoy) de al menos este monto. */
  readonly montoMinimo: Monto;
  /** Avisar al derivar si no hay una intimación registrada. */
  readonly pedirIntimacion: boolean;
};

/** El criterio de una administración que todavía no cargó el suyo. */
export const CRITERIO_POR_DEFECTO: CriterioMora = { meses: 3, montoMinimo: "300000.00", pedirIntimacion: true };

/** De dónde sale el criterio que se aplica en un barrio. */
export type OrigenDelCriterio = "barrio" | "administracion" | "por_defecto";

/**
 * El criterio que vale en un barrio: el propio del barrio (meses y monto) si lo tiene; si no, el de la
 * administración; si la administración no cargó ninguno, el de por defecto. «Pedir intimación» sigue la
 * misma cadena por separado: el barrio puede tener meses propios y heredar el aviso.
 */
export function criterioEfectivo(
  administracion: CriterioMora | null,
  barrio: { readonly meses: number | null; readonly montoMinimo: Monto | null; readonly pedirIntimacion: boolean | null } | null,
): { readonly criterio: CriterioMora; readonly origen: OrigenDelCriterio } {
  const base = administracion ?? CRITERIO_POR_DEFECTO;
  const propio = barrio !== null && barrio.meses !== null && barrio.montoMinimo !== null;
  return {
    criterio: {
      meses: propio ? barrio.meses! : base.meses,
      montoMinimo: propio ? barrio.montoMinimo! : base.montoMinimo,
      pedirIntimacion: barrio?.pedirIntimacion ?? base.pedirIntimacion,
    },
    origen: propio ? "barrio" : administracion ? "administracion" : "por_defecto",
  };
}

/** Si una unidad pasa el criterio: los meses y el monto, por separado (para decir cuál falta). */
export function evaluarCriterio(
  unidad: { readonly meses: number; readonly deuda: Monto },
  criterio: CriterioMora,
): { readonly porMeses: boolean; readonly porMonto: boolean; readonly cumple: boolean } {
  const porMeses = unidad.meses > criterio.meses;
  const porMonto = aCentavos(unidad.deuda) >= aCentavos(criterio.montoMinimo);
  return { porMeses, porMonto, cumple: porMeses && porMonto };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La promesa de pago (Aclade `promesas_de_pago`, 0014)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type EstadoPromesa = "pendiente" | "cumplida" | "vencida";

/**
 * El estado de una promesa: **cumplida** si lo pagado (lo imputado a la unidad de pagos con fecha entre
 * el alta de la gestión y la fecha prometida, inclusive) llega al monto; si no, **vencida** después de la
 * fecha prometida y **pendiente** hasta entonces. La misma cuenta que Aclade.
 */
export function estadoPromesa(p: { readonly monto: Monto; readonly pagado: Monto; readonly fecha: string }, hoy: string): EstadoPromesa {
  if (aCentavos(p.pagado) >= aCentavos(p.monto)) return "cumplida";
  return hoy > p.fecha ? "vencida" : "pendiente";
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La situación de una unidad en la lista de mora
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que dice la columna «Situación», en este orden de precedencia:
 *  - `derivada`: ya está en un estudio.
 *  - `promesa`: tiene una promesa pendiente. No se propone mientras corre.
 *  - `para_derivar`: pasa el criterio de su barrio (meses y monto).
 *  - `debajo_del_minimo`: pasa los meses pero no llega al monto. No se propone, pero se puede derivar a mano.
 *  - `con_deuda`: el resto.
 */
export type SituacionMora = "derivada" | "promesa" | "para_derivar" | "debajo_del_minimo" | "con_deuda";

export function situacionMora(u: {
  readonly derivada: boolean;
  readonly promesa: EstadoPromesa | null;
  readonly criterio: { readonly porMeses: boolean; readonly cumple: boolean };
}): SituacionMora {
  if (u.derivada) return "derivada";
  if (u.promesa === "pendiente") return "promesa";
  if (u.criterio.cumple) return "para_derivar";
  if (u.criterio.porMeses) return "debajo_del_minimo";
  return "con_deuda";
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Vocabulario
// ────────────────────────────────────────────────────────────────────────────────────────────────

export const MOTIVOS_DERIVACION = ["criterio_cumplido", "incumplio_plan", "incumplio_promesa", "otro"] as const;
export type MotivoDerivacion = (typeof MOTIVOS_DERIVACION)[number];
export const TEXTO_MOTIVO_DERIVACION: Record<MotivoDerivacion, string> = {
  // Sin «sin respuesta» (legal-ph): el sistema no comprueba que no haya habido respuesta.
  criterio_cumplido: "Criterio de mora cumplido",
  incumplio_plan: "Incumplió un plan de pagos",
  incumplio_promesa: "Incumplió una promesa de pago",
  otro: "Otro",
};

export const MOTIVOS_RETIRO = ["pago", "plan_administracion", "acuerdo_juicio", "venta", "error", "cambio_estudio", "otro"] as const;
export type MotivoRetiro = (typeof MOTIVOS_RETIRO)[number];
export const TEXTO_MOTIVO_RETIRO: Record<MotivoRetiro, string> = {
  pago: "Pagó la deuda",
  plan_administracion: "Plan de pagos con la administración",
  // Sin suponer que hubo juicio: según la figura puede no haber vía ejecutiva (legal-ph, E-a2).
  acuerdo_juicio: "Acuerdo alcanzado por el estudio (judicial o extrajudicial)",
  // La deuda no se libera con la venta: sigue a la unidad (CCyC 2049 y 1937; legal-ph). Retirar no toca el saldo.
  venta: "Venta o cambio de titular (retirarla no cancela la deuda)",
  error: "Error al derivar",
  cambio_estudio: "Cambio de estudio",
  otro: "Otro",
};

/** Aclade `CANALES`, más la carta documento y la derivación (que deja su renglón en el historial). */
export const CANALES_GESTION = ["llamada", "whatsapp", "mail", "visita", "nota", "carta_documento", "derivacion"] as const;
export type CanalGestion = (typeof CANALES_GESTION)[number];
export const TEXTO_CANAL: Record<CanalGestion, string> = {
  llamada: "Llamada",
  whatsapp: "WhatsApp",
  mail: "Mail",
  visita: "Visita",
  // La «nota firmada» de la maqueta: una nota entregada con acuse firmado (pide adjunto).
  nota: "Nota con acuse firmado",
  carta_documento: "Carta documento",
  derivacion: "Derivación",
};

/** Aclade `RESULTADOS`, más «Intimación entregada» y «Enviada» (carta documento). */
export const RESULTADOS_GESTION = [
  "contactado",
  "no_contesta",
  "dato_equivocado",
  "promesa_de_pago",
  "se_niega",
  "intimacion_entregada",
  "enviada",
  "otro",
] as const;
export type ResultadoGestion = (typeof RESULTADOS_GESTION)[number];
export const TEXTO_RESULTADO: Record<ResultadoGestion, string> = {
  contactado: "Contactado",
  no_contesta: "No contesta",
  dato_equivocado: "Dato equivocado",
  promesa_de_pago: "Promesa de pago",
  se_niega: "Se niega",
  intimacion_entregada: "Intimación entregada",
  enviada: "Enviada",
  otro: "Otro",
};

export const PREFERENCIAS_AVISO = ["cada_derivacion", "cada_derivacion_y_resumen", "solo_resumen"] as const;
export type PreferenciaAviso = (typeof PREFERENCIAS_AVISO)[number];
export const TEXTO_PREFERENCIA_AVISO: Record<PreferenciaAviso, string> = {
  cada_derivacion: "En cada derivación y retiro",
  cada_derivacion_y_resumen: "En cada derivación y retiro + resumen mensual",
  solo_resumen: "Solo resumen mensual",
};

export const PACTOS_EJECUTIVIDAD = ["a_confirmar", "si", "no"] as const;
export type PactoEjecutividad = (typeof PACTOS_EJECUTIVIDAD)[number];
export const TEXTO_PACTO: Record<PactoEjecutividad, string> = { a_confirmar: "A confirmar", si: "Sí", no: "No" };

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El aviso de la boleta de una unidad derivada (lo imprime E-c; acá se carga y se valida)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export const LEYENDA_BASE =
  "Esta unidad registra deuda vencida y está derivada a {estudio} para gestionar el cobro. Los pagos se reciben a cuenta y se imputan según la normativa aplicable y el reglamento o estatuto del barrio. Para pagar o consultar, comuníquese con {estudio} al {telefono}.";

/**
 * Lo que el aviso **no puede** decir: medidas que nadie decidió. Se busca sin acentos ni mayúsculas.
 * Revisado con `legal-ph` (encargo E-a): el aviso describe solo lo decidido —que la unidad está
 * derivada y cómo pagar—. No anuncia medidas: ninguna está decidida al derivar, y para varias no hay
 * fuente cargada en `knowledge/` que las respalde. La «acción judicial» o la «vía ejecutiva» tampoco:
 * según la figura del barrio puede no existir (`knowledge/cordoba/jurisprudencia/01-ejecutividad-expensas.md`).
 * Revisar con abogado matriculado antes de habilitar alguna.
 */
const AMENAZAS: readonly { readonly patron: RegExp; readonly medida: string }[] = [
  { patron: /embarg/, medida: "embargo" },
  { patron: /remat|subasta/, medida: "remate" },
  { patron: /\b(cort|suspend|interrump)\w*[^.]*\b(servicio|agua|luz|gas|internet)/, medida: "corte de servicios" },
  { patron: /(prohib|impedi|restring|negar|niega)[^.]*\b(ingreso|acceso|entrada)/, medida: "prohibir el ingreso" },
  { patron: /inhabilit/, medida: "inhabilitación" },
  { patron: /\bveraz\b|informes? comercial/, medida: "informe comercial" },
  { patron: /ejecuci|ejecutiv|juicio|demanda|acci(o|ó)n(es)? judicial/, medida: "acción judicial" },
  { patron: /inhibic/, medida: "inhibición" },
  { patron: /(suspend|prohib|restring|impedi|negar)[^.]*\b(uso|reserva|amenit|espacios? comun|instalacion)/, medida: "restringir el uso de lo común" },
  { patron: /lista de moros|publica\w*[^.]*deud/, medida: "difundir la deuda" },
];

/** `null` si el texto se puede usar; si no, la medida que nombra. */
export function amenazaEnLeyenda(texto: string): string | null {
  const plano = texto.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  return AMENAZAS.find((a) => a.patron.test(plano))?.medida ?? null;
}

const leyendaSchema = z
  .string()
  .trim()
  .min(1, "Escribí el aviso.")
  .max(600, "El aviso tiene hasta 600 caracteres.")
  .superRefine((t, ctx) => {
    const medida = amenazaEnLeyenda(t);
    if (medida) ctx.addIssue({ code: "custom", message: `El aviso no puede anunciar una medida no decidida (${medida}).` });
  });

// ────────────────────────────────────────────────────────────────────────────────────────────────
// CSV de mora (Aclade `src/lib/estudio-csv.ts`)
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Neutraliza una celda para que la planilla no la tome como fórmula (inyección CSV): lo que empieza con
 * `=`, `+`, `-`, `@`, el menos tipográfico (U+2212), tabulación o retorno —aun con espacios adelante— va
 * con un apóstrofo. Después escapa las comillas y entrecomilla si hace falta. **Copiado de Aclade
 * (`estudio-csv.ts:28-31`) sin cambios.**
 */
export function celdaCsv(texto: string): string {
  const seguro = /^\s*[=+\-−@]|^[\t\r]/.test(texto) ? `'${texto}` : texto;
  return /[";\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

/** Un monto para la planilla: coma decimal, sin separador de miles (`1234567,89`). */
function montoCsv(m: Monto): string {
  return m.replace(".", ",");
}

export type FilaCsvMora = {
  readonly barrio: string;
  readonly unidad: string;
  readonly titular: string;
  readonly meses: number;
  readonly capital: Monto;
  readonly interes: Monto;
  readonly situacion: string;
  readonly estudio: string | null;
  readonly ultimaGestion: string | null;
};

const ENCABEZADO_MORA = ["Barrio", "Unidad", "Titular", "Meses", "Capital", "Interés a hoy", "Deuda a hoy", "Situación", "Estudio", "Última gestión"];

/** El CSV de la lista de mora: «;», coma decimal, CRLF (el mismo formato que el de Aclade). */
export function csvMora(filas: readonly FilaCsvMora[]): string {
  const lineas: string[][] = [ENCABEZADO_MORA];
  for (const f of filas) {
    lineas.push([
      f.barrio,
      f.unidad,
      f.titular,
      String(f.meses),
      montoCsv(f.capital),
      montoCsv(f.interes),
      montoCsv(deCentavos(aCentavos(f.capital) + aCentavos(f.interes))),
      f.situacion,
      f.estudio ?? "",
      f.ultimaGestion ?? "",
    ]);
  }
  return lineas.map((l) => l.map(celdaCsv).join(";")).join("\r\n") + "\r\n";
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Escrituras (forma; la regla la hacen la base y el servicio)
// ────────────────────────────────────────────────────────────────────────────────────────────────

const vacioANull = <T extends z.ZodTypeAny>(esquema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : (v ?? null)), esquema.nullable());

const notaSchema = z.string().trim().max(500, "La nota tiene hasta 500 caracteres.");
const montoNoNegativoSchema = montoSchema.refine((m) => !m.startsWith("-"), "El monto no puede ser negativo.");
const mesesSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}$/, "Escribí una cantidad de meses, por ejemplo 3.")
  .transform(Number)
  .refine((n) => n <= 120, "Hasta 120 meses.");

export const cuitEstudioSchema = z
  .string()
  .transform((t, ctx) => {
    const c = normalizarCuit(t);
    if (!c) {
      ctx.addIssue({ code: "custom", message: "El CUIT no es válido: revisá los 11 números." });
      return z.NEVER;
    }
    return c;
  });

const correoSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Escribí un correo, por ejemplo estudio@ejemplo.com.")
  .max(160);

/** Lo que se busca para vincular un estudio que ya usa el sistema: un correo o un CUIT, **exacto**. */
export const buscarEstudioSchema = z.object({ dato: z.string().trim().min(1, "Escribí el correo o el CUIT del estudio.").max(160) });

/** Los datos del vínculo con la administración (alta, vínculo o edición). */
const vinculoSchema = z.object({
  correoAvisos: correoSchema,
  telefonoBoleta: vacioANull(z.string().trim().min(6, "El teléfono es muy corto.").max(40)),
  preferenciaAviso: z.enum(PREFERENCIAS_AVISO),
});

/** Agregar un estudio nuevo: nombre, CUIT y el vínculo. */
export const agregarEstudioSchema = vinculoSchema.extend({
  administracionId: idSchema,
  nombre: z.string().trim().min(1, "Escribí el nombre del estudio.").max(160),
  cuit: cuitEstudioSchema,
});
export type AgregarEstudio = z.input<typeof agregarEstudioSchema>;

/**
 * Vincular un estudio que ya existe (lo encontró `buscar_estudio_exacto`). El nombre es el que esta
 * administración le da: cada una ve al estudio con el suyo (security-engineer).
 */
export const vincularEstudioSchema = vinculoSchema.extend({
  administracionId: idSchema,
  estudioId: idSchema,
  nombre: z.string().trim().min(1, "Escribí el nombre del estudio.").max(160),
});
export type VincularEstudio = z.input<typeof vincularEstudioSchema>;

export const editarVinculoSchema = vinculoSchema.extend({
  administracionId: idSchema,
  estudioId: idSchema,
  nombre: z.string().trim().min(1, "Escribí el nombre del estudio.").max(160),
});
export type EditarVinculo = z.input<typeof editarVinculoSchema>;

export const bajaEstudioSchema = z.object({ administracionId: idSchema, estudioId: idSchema });
export type BajaEstudio = z.input<typeof bajaEstudioSchema>;

export const criterioAdministracionSchema = z.object({
  administracionId: idSchema,
  meses: mesesSchema,
  montoMinimo: montoNoNegativoSchema,
  pedirIntimacion: z.enum(["si", "no"]).transform((v) => v === "si"),
  leyendaBoleta: leyendaSchema,
});
export type CriterioAdministracion = z.input<typeof criterioAdministracionSchema>;

/** «Mora y estudios» del barrio: criterio propio o heredado, pacto y aviso propio o heredado. */
export const moraBarrioSchema = z
  .object({
    barrioId: idSchema,
    criterio: z.enum(["administracion", "propio"]),
    meses: vacioANull(mesesSchema),
    montoMinimo: vacioANull(montoNoNegativoSchema),
    pactoEjecutividad: z.enum(PACTOS_EJECUTIVIDAD),
    aviso: z.enum(["administracion", "propio"]),
    leyendaBoleta: vacioANull(leyendaSchema),
  })
  .superRefine((v, ctx) => {
    if (v.criterio === "propio" && v.meses === null) ctx.addIssue({ code: "custom", path: ["meses"], message: "Escribí los meses." });
    if (v.criterio === "propio" && v.montoMinimo === null)
      ctx.addIssue({ code: "custom", path: ["montoMinimo"], message: "Escribí el monto mínimo." });
    if (v.aviso === "propio" && v.leyendaBoleta === null)
      ctx.addIssue({ code: "custom", path: ["leyendaBoleta"], message: "Escribí el aviso propio." });
  });
export type MoraBarrio = z.input<typeof moraBarrioSchema>;

/** Sumar o sacar un estudio del barrio, o hacerlo el de por defecto. */
export const estudioDelBarrioSchema = z.object({
  barrioId: idSchema,
  estudioId: idSchema,
  accion: z.enum(["sumar", "sacar", "por_defecto"]),
});
export type EstudioDelBarrio = z.input<typeof estudioDelBarrioSchema>;

/** Derivar en lote: cada unidad con su barrio y su estudio; motivo y nota, para toda la tanda. */
export const derivarSchema = z
  .object({
    unidades: z
      .array(z.object({ unidadFuncionalId: idSchema, barrioId: idSchema, estudioId: idSchema }))
      .min(1, "Elegí al menos una unidad.")
      .max(500, "Hasta 500 unidades por tanda.")
      .refine((u) => new Set(u.map((x) => x.unidadFuncionalId)).size === u.length, "Una unidad está dos veces."),
    motivo: z.enum(MOTIVOS_DERIVACION),
    nota: vacioANull(notaSchema),
  })
  .superRefine((v, ctx) => {
    if (v.motivo === "otro" && v.nota === null) ctx.addIssue({ code: "custom", path: ["nota"], message: "Con «Otro», contá el motivo en la nota." });
  });
export type Derivar = z.input<typeof derivarSchema>;

export const retirarSchema = z
  .object({
    derivacionId: idSchema,
    motivo: z.enum(MOTIVOS_RETIRO),
    nota: vacioANull(notaSchema),
  })
  .superRefine((v, ctx) => {
    if (v.motivo === "otro" && v.nota === null) ctx.addIssue({ code: "custom", path: ["nota"], message: "Con «Otro», contá el motivo en la nota." });
  });
export type Retirar = z.input<typeof retirarSchema>;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Gestiones (encargo E-a2): registrar y anular desde la ficha de la unidad
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Los canales que se registran a mano: la derivación la escribe la base al derivar. */
export const CANALES_REGISTRABLES = ["llamada", "whatsapp", "mail", "visita", "nota", "carta_documento"] as const satisfies readonly CanalGestion[];
export type CanalRegistrable = (typeof CANALES_REGISTRABLES)[number];

/**
 * Los canales que piden adjunto como respaldo documental: la carta documento y la nota con acuse firmado
 * (canal `nota`). Sin afirmar que sean «fehacientes»: no hay fuente cargada que lo diga (legal-ph). La
 * base lo exige igual (`gestion_adjunto_fehaciente_chk`).
 */
export const CANALES_CON_ADJUNTO: readonly CanalGestion[] = ["carta_documento", "nota"];
export const pideAdjunto = (canal: string): boolean => (CANALES_CON_ADJUNTO as readonly string[]).includes(canal);

/** El canal que se carga solo al tocar un botón de contacto (Aclade `CANAL_DE_CONTACTO`). */
export const CANAL_DE_CONTACTO = { llamar: "llamada", whatsapp: "whatsapp", mail: "mail" } as const satisfies Record<string, CanalRegistrable>;

/** Hasta cuántos días desde hoy puede caer una promesa (Aclade lo lee de un parámetro; acá es fijo). */
export const PLAZO_MAXIMO_PROMESA_DIAS = 60;
export const NOTA_MAXIMA_GESTION = 500;

/** El adjunto ya subido: la clave la dio el servidor; el nombre es el del archivo de la persona. */
const adjuntoSchema = z.object({
  clave: z.string().min(1).max(300),
  nombre: z.string().trim().min(1).max(200),
});

export const registrarGestionSchema = z
  .object({
    unidadFuncionalId: idSchema,
    canal: z.enum(CANALES_REGISTRABLES, { message: "Elegí por qué canal fue la gestión." }),
    resultado: z.enum(RESULTADOS_GESTION, { message: "Elegí el resultado." }),
    nota: vacioANull(z.string().trim().max(NOTA_MAXIMA_GESTION, `La nota tiene hasta ${NOTA_MAXIMA_GESTION} caracteres.`)),
    promesaFecha: vacioANull(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Elegí la fecha en que promete pagar.")),
    promesaMonto: vacioANull(montoSchema.refine((m) => aCentavos(m) > 0n, "El monto prometido tiene que ser mayor que cero.")),
    adjunto: adjuntoSchema.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.resultado === "otro" && v.nota === null) ctx.addIssue({ code: "custom", path: ["nota"], message: "Con «Otro», contá en la nota qué pasó." });
    if (v.resultado === "promesa_de_pago") {
      if (v.promesaFecha === null) ctx.addIssue({ code: "custom", path: ["promesaFecha"], message: "Elegí la fecha en que promete pagar." });
      if (v.promesaMonto === null) ctx.addIssue({ code: "custom", path: ["promesaMonto"], message: "Escribí el monto que promete pagar." });
    } else if (v.promesaFecha !== null || v.promesaMonto !== null) {
      ctx.addIssue({ code: "custom", path: ["promesaFecha"], message: "La fecha y el monto van solo con una promesa de pago." });
    }
    // «Enviada» es de lo que se manda por escrito: la carta documento y la nota (legal-ph, E-a2).
    if (v.resultado === "enviada" && !pideAdjunto(v.canal)) {
      ctx.addIssue({ code: "custom", path: ["resultado"], message: "«Enviada» va con la carta documento o la nota con acuse firmado." });
    }
    if (pideAdjunto(v.canal) && v.adjunto === null) {
      ctx.addIssue({ code: "custom", path: ["adjunto"], message: "La carta documento y la nota firmada llevan el archivo adjunto." });
    }
  });
export type RegistrarGestion = z.input<typeof registrarGestionSchema>;

export const anularGestionSchema = z.object({
  gestionId: idSchema,
  motivo: z.string().trim().min(1, "Contá por qué se anula.").max(300, "El motivo tiene hasta 300 caracteres."),
});
export type AnularGestion = z.input<typeof anularGestionSchema>;

export const prepararSubidaDeAdjuntoSchema = z.object({
  unidadFuncionalId: idSchema,
  contentType: z.enum(["application/pdf", "image/jpeg", "image/png"], { message: "El adjunto tiene que ser PDF, JPG o PNG." }),
});
export type PrepararSubidaDeAdjunto = z.input<typeof prepararSubidaDeAdjuntoSchema>;

/**
 * Lo que se ve de una promesa (Aclade `CHIP_PROMESA`). Una promesa pagada en parte sigue «Pendiente»
 * hasta su fecha y después queda «Vencida»: **solo se cumple si lo pagado llega al monto** (la regla
 * de Aclade). La pantalla muestra cuánto pagó.
 */
export const TEXTO_ESTADO_PROMESA: Record<EstadoPromesa, string> = { pendiente: "Pendiente", cumplida: "✓ Cumplida", vencida: "⚠ Vencida" };
