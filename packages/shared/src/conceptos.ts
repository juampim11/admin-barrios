/**
 * «Conceptos del barrio» (encargo 16b, Etapa 1.3): a quién va cada concepto de boleta, cómo entra
 * cada mes, los grupos de unidades y la planilla de usos.
 *
 * Por dentro siguen siendo **dos catálogos** y no se unen: `concepto` (los gastos que se prorratean,
 * con su tipo ordinaria / extraordinaria) y `concepto_boleta` (cargos y descuentos de una unidad). La
 * pantalla los muestra juntos. Este archivo cubre lo nuevo del segundo: los valores, los textos y la
 * lectura de la planilla. No toca la base ni calcula dinero.
 */

import { z } from "zod";
import { idSchema } from "./consultas.ts";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// A quién va y cómo entra cada mes (`concepto_boleta`, `0083`)
// ────────────────────────────────────────────────────────────────────────────────────────────────

export const DESTINATARIOS_CONCEPTO = ["todas", "grupo", "por_uso", "una_unidad"] as const;
export type DestinatarioConcepto = (typeof DESTINATARIOS_CONCEPTO)[number];

export const MODOS_DEL_MES = ["sola", "planilla_o_mano", "mano"] as const;
export type ModoDelMes = (typeof MODOS_DEL_MES)[number];

export const UNIDADES_DE_USO = ["turno", "jornada"] as const;
export type UnidadDeUso = (typeof UNIDADES_DE_USO)[number];

/** Los métodos de un concepto de boleta. `importe_libre` es «importe a cargar cada vez» (`0082`). */
export const METODOS_CONCEPTO_BOLETA = ["monto_fijo", "porcentaje", "precio_x_cantidad", "importe_libre"] as const;
export type MetodoConceptoBoleta = (typeof METODOS_CONCEPTO_BOLETA)[number];

/** De dónde salió una aplicación (`cbu_origen_chk`, `0083`). */
export const ORIGENES_DE_APLICACION = ["carga_manual", "override_administrador", "regla_barrio", "catalogo_sola", "planilla"] as const;
export type OrigenDeAplicacion = (typeof ORIGENES_DE_APLICACION)[number];

export const TEXTO_DESTINATARIO: Record<DestinatarioConcepto, string> = {
  todas: "Todas las unidades",
  grupo: "Un grupo de unidades",
  por_uso: "Quien lo usó",
  una_unidad: "Una unidad",
};

export const TEXTO_MODO_DEL_MES: Record<ModoDelMes, { readonly corto: string; readonly detalle: string }> = {
  sola: { corto: "Sola", detalle: "Al calcular el mes ya está aplicado, sin que nadie elija unidades." },
  planilla_o_mano: { corto: "Por planilla o a mano", detalle: "Se cargan los usos del mes con una planilla, o uno por uno." },
  mano: { corto: "A mano", detalle: "Se aplica a una unidad cuando corresponde." },
};

export const TEXTO_METODO: Record<MetodoConceptoBoleta, string> = {
  monto_fijo: "$ por unidad",
  precio_x_cantidad: "$ por uso",
  porcentaje: "% de la expensa",
  importe_libre: "Importe a cargar cada vez",
};

/** «turno» / «turnos», «jornada» / «jornadas»; sin unidad cargada, «uso» / «usos». */
export function textoDeUsos(cantidad: string, unidad: UnidadDeUso | null): string {
  const n = cantidad.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1").replace(".", ",");
  const uno = n === "1";
  const palabra = unidad === "turno" ? (uno ? "turno" : "turnos") : unidad === "jornada" ? (uno ? "jornada" : "jornadas") : uno ? "uso" : "usos";
  return `${n} ${palabra}`;
}

/**
 * Lo que la boleta dice de una aplicación que vino de una planilla: las fechas de los usos y el
 * total, «03/11, 17/11 · 2 turnos». Con muchos usos, las primeras fechas y «…».
 */
export function detalleDeUsos(usos: readonly { readonly fecha: string }[], cantidad: string, unidad: UnidadDeUso | null): string {
  const fechas = [...new Set(usos.map((u) => u.fecha))].sort().map((f) => `${f.slice(8, 10)}/${f.slice(5, 7)}`);
  const lista = fechas.length > 6 ? `${fechas.slice(0, 6).join(", ")}…` : fechas.join(", ");
  return lista === "" ? textoDeUsos(cantidad, unidad) : `${lista} · ${textoDeUsos(cantidad, unidad)}`;
}

/**
 * Las reglas que atan destinatario, modo y método (los mismos checks de `0083`, para que el mensaje
 * caiga en su campo). Devuelve los problemas por campo; vacío si está bien.
 */
export function revisarComoEntraElConcepto(v: {
  readonly clase: "cargo" | "descuento";
  readonly metodo: MetodoConceptoBoleta;
  readonly destinatario: DestinatarioConcepto;
  readonly grupoId: string | null;
  readonly modoMes: ModoDelMes;
  readonly unidadUso: UnidadDeUso | null;
}): { readonly campo: "destinatario" | "grupoId" | "modoMes" | "unidadUso" | "metodo"; readonly mensaje: string }[] {
  const problemas: { campo: "destinatario" | "grupoId" | "modoMes" | "unidadUso" | "metodo"; mensaje: string }[] = [];
  if (v.destinatario === "grupo" && v.grupoId === null) problemas.push({ campo: "grupoId", mensaje: "Elegí el grupo de unidades." });
  if (v.destinatario !== "grupo" && v.grupoId !== null) problemas.push({ campo: "grupoId", mensaje: "El grupo va solo si el concepto es para un grupo." });
  if (v.modoMes === "sola") {
    if (v.destinatario !== "todas" && v.destinatario !== "grupo") {
      problemas.push({ campo: "modoMes", mensaje: "Para aplicarse solo, el concepto tiene que ir a todas las unidades o a un grupo." });
    }
    if (v.metodo !== "monto_fijo" && v.metodo !== "porcentaje") {
      problemas.push({ campo: "modoMes", mensaje: "Para aplicarse solo, el importe tiene que ser fijo por unidad o un porcentaje: no puede depender de usos ni de un importe a mano." });
    }
  }
  if (v.modoMes === "planilla_o_mano" && v.metodo !== "precio_x_cantidad") {
    problemas.push({ campo: "modoMes", mensaje: "Por planilla entra solo lo que se cobra por uso." });
  }
  if (v.unidadUso !== null && v.metodo !== "precio_x_cantidad") {
    problemas.push({ campo: "unidadUso", mensaje: "La unidad de uso va solo en lo que se cobra por uso." });
  }
  if (v.metodo === "importe_libre" && v.clase !== "cargo") {
    problemas.push({ campo: "metodo", mensaje: "El importe a cargar cada vez es de un cargo, no de un descuento." });
  }
  return problemas;
}

const vacioANull = <T extends z.ZodTypeAny>(esquema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : (v ?? null)), esquema.nullable());

/** Los cuatro campos de «a quién va y cómo entra», tal como llegan de un formulario. */
export const comoEntraElConceptoSchema = z.object({
  destinatario: z.enum(DESTINATARIOS_CONCEPTO).default("una_unidad"),
  grupoId: vacioANull(idSchema).default(null),
  modoMes: z.enum(MODOS_DEL_MES).default("mano"),
  unidadUso: vacioANull(z.enum(UNIDADES_DE_USO)).default(null),
});

/** Editar un concepto de boleta: el nombre, si está activo, y a quién va y cómo entra. El valor va aparte. */
export const editarConceptoBoletaSchema = z
  .object({
    conceptoBoletaId: idSchema,
    nombre: z.string().trim().min(1, "Escribí el nombre del concepto.").max(120),
    activo: z.union([z.boolean(), z.string()]).transform((v) => v === true || v === "true" || v === "on" || v === "si"),
  })
  .and(comoEntraElConceptoSchema);
export type EditarConceptoBoleta = z.input<typeof editarConceptoBoletaSchema>;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Grupos de unidades
// ────────────────────────────────────────────────────────────────────────────────────────────────

const unidadesDelGrupoSchema = z.array(idSchema).max(5000);
const nombreDeGrupoSchema = z.string().trim().min(1, "Escribí el nombre del grupo.").max(80);

export const crearGrupoDeUnidadesSchema = z.object({ barrioId: idSchema, nombre: nombreDeGrupoSchema, unidades: unidadesDelGrupoSchema });
export type CrearGrupoDeUnidades = z.input<typeof crearGrupoDeUnidadesSchema>;

/** Editar un grupo: el nombre y **la lista completa** de sus unidades (las que no vienen, salen). */
export const editarGrupoDeUnidadesSchema = z.object({ grupoId: idSchema, nombre: nombreDeGrupoSchema, unidades: unidadesDelGrupoSchema });
export type EditarGrupoDeUnidades = z.input<typeof editarGrupoDeUnidadesSchema>;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La planilla de usos
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Tope de filas de una planilla de usos: un mes de reservas de un barrio entra holgado. */
export const MAX_FILAS_USOS = 2000;
/** Lo máximo que acepta un renglón de boleta (`cbu_cantidad_chk`): los usos de una unidad en un mes. */
export const MAX_USOS_POR_UNIDAD = 100;
export const COLUMNAS_DE_USOS = ["manzana", "lote", "concepto", "fecha", "cantidad"] as const;

/** Un uso leído de la planilla, ya normalizado. */
export type UsoLeido = {
  /** Número de fila en la planilla (la 1 es el encabezado). */
  readonly fila: number;
  readonly manzana: string;
  readonly lote: string;
  readonly concepto: string;
  /** `YYYY-MM-DD`. */
  readonly fecha: string;
  /** Decimal con punto, hasta tres decimales: `"2"`, `"1.5"`. */
  readonly cantidad: string;
};
export type ErrorDeFila = { readonly fila: number; readonly mensaje: string };

const sinAcentos = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

/** `dd/mm/aaaa`, `d/m/aa` o `aaaa-mm-dd` → `YYYY-MM-DD`; `null` si no es una fecha que exista. */
export function leerFechaDePlanilla(texto: string): string | null {
  const t = texto.trim();
  let a: number, m: number, d: number;
  // Con hora opcional detrás (así llega una celda de fecha de una planilla); nada más.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]*Z?)?$/.exec(t);
  const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (iso) [a, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (local) [d, m, a] = [Number(local[1]), Number(local[2]), local[3]!.length === 2 ? 2000 + Number(local[3]) : Number(local[3])];
  else return null;
  // Que exista de verdad: un 31/02 pasa la forma y no es un día.
  const fecha = new Date(Date.UTC(a, m - 1, d));
  if (fecha.getUTCFullYear() !== a || fecha.getUTCMonth() !== m - 1 || fecha.getUTCDate() !== d) return null;
  if (a < 2000 || a > 2200) return null;
  return `${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `"2"`, `"1,5"`, `"1.5"` → `"2"`, `"1.5"`; `null` si no es un número mayor que cero con hasta tres decimales. */
function leerCantidad(texto: string): string | null {
  // «1.000» es ambiguo (¿mil, o uno con tres decimales?): no se adivina. Los decimales van con coma,
  // o con punto y hasta dos cifras.
  if (/^\d{1,3}(\.\d{3})+$/.test(texto.trim())) return null;
  const t = texto.trim().replace(",", ".");
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(t)) return null;
  if (Number(t) <= 0) return null;
  return t.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/**
 * Lee la planilla de usos: `manzana · lote · concepto · fecha · cantidad`, una fila por uso.
 *
 * Valida **la forma** de cada fila y devuelve los errores por fila, todos juntos. Que la unidad
 * exista, que el concepto sea del barrio y se cobre por uso lo valida el servicio contra la base
 * (`vistaPreviaDePlanillaDeUsos`), con el mismo formato de error.
 *
 * La planilla es una entrada de terceros (la arma quien lleva las reservas): no se confía en nada.
 * Recibe las celdas como texto, ya leídas por el lector de planillas de siempre; no abre archivos.
 */
export function leerPlanillaUsos(filasCrudas: readonly (readonly string[])[]): {
  readonly usos: readonly UsoLeido[];
  readonly errores: readonly ErrorDeFila[];
} {
  const [encabezado, ...resto] = filasCrudas;
  const nombres = (encabezado ?? []).map((c) => sinAcentos(String(c ?? "")));
  const indice = Object.fromEntries(COLUMNAS_DE_USOS.map((c) => [c, nombres.indexOf(c)])) as Record<(typeof COLUMNAS_DE_USOS)[number], number>;
  const faltan = COLUMNAS_DE_USOS.filter((c) => indice[c] < 0);
  if (faltan.length > 0) {
    return { usos: [], errores: [{ fila: 1, mensaje: `La planilla necesita las columnas manzana, lote, concepto, fecha y cantidad. ${faltan.length === 1 ? "Falta" : "Faltan"}: ${faltan.join(", ")}.` }] };
  }
  const conDatos = resto.map((c, i) => ({ c, fila: i + 2 })).filter(({ c }) => c.some((x) => String(x ?? "").trim() !== ""));
  if (conDatos.length === 0) return { usos: [], errores: [{ fila: 1, mensaje: "La planilla no tiene filas." }] };
  if (conDatos.length > MAX_FILAS_USOS) {
    return { usos: [], errores: [{ fila: 1, mensaje: `La planilla tiene más de ${MAX_FILAS_USOS} filas: partila en varias.` }] };
  }
  const usos: UsoLeido[] = [];
  const errores: ErrorDeFila[] = [];
  for (const { c, fila } of conDatos) {
    const celda = (col: (typeof COLUMNAS_DE_USOS)[number]) => String(c[indice[col]] ?? "").trim();
    const manzana = celda("manzana");
    const lote = celda("lote");
    const concepto = celda("concepto");
    const fecha = leerFechaDePlanilla(celda("fecha"));
    const cantidad = leerCantidad(celda("cantidad"));
    if (!manzana || !lote) errores.push({ fila, mensaje: "Falta la manzana o el lote." });
    else if (manzana.length > 20 || lote.length > 20) errores.push({ fila, mensaje: "La manzana o el lote son demasiado largos." });
    else if (!concepto) errores.push({ fila, mensaje: "Falta el concepto." });
    else if (concepto.length > 120) errores.push({ fila, mensaje: "El nombre del concepto es demasiado largo." });
    else if (fecha === null) errores.push({ fila, mensaje: `La fecha «${celda("fecha").slice(0, 20)}» no existe o no se entiende: escribila como dd/mm/aaaa.` });
    else if (cantidad === null) errores.push({ fila, mensaje: "La cantidad tiene que ser un número mayor que cero (hasta tres decimales)." });
    else usos.push({ fila, manzana, lote, concepto, fecha, cantidad });
  }
  return { usos, errores };
}

/** La clave con que se agrupan los usos de una unidad y un concepto, sin distinguir mayúsculas ni acentos. */
export const claveDeUso = (manzana: string, lote: string, concepto: string): string =>
  `${manzana.trim().toUpperCase()}|${lote.trim().toUpperCase()}|${sinAcentos(concepto)}`;

export const nombreDeConceptoNormalizado = (nombre: string): string => sinAcentos(nombre);

/** La planilla modelo, con su encabezado y dos filas de ejemplo. */
export function plantillaDeUsos(): string[][] {
  return [[...COLUMNAS_DE_USOS], ["1", "4", "Cancha de pádel", "08/11/2026", "1"], ["2", "15", "Uso del club house", "22/11/2026", "1"]];
}

/**
 * Aplicar la planilla de usos de un mes. Las filas viajan como texto (ya leídas del archivo por el
 * servidor). `confirmarMontoInusual` es la respuesta a la pregunta que hace la base cuando los cargos
 * de una unidad superan lo habitual (`app.cbu_antes`, `0025`): no se manda por las dudas.
 */
export const aplicarPlanillaDeUsosSchema = z.object({
  periodoId: idSchema,
  archivo: z.string().trim().min(1, "Falta el nombre del archivo.").max(200),
  // Con margen sobre `MAX_FILAS_USOS`: una planilla un poco pasada llega al validador, que lo dice
  // con sus palabras («partila en varias») en vez de un error de forma.
  filas: z.array(z.array(z.string().max(500)).max(20)).min(1).max(MAX_FILAS_USOS * 2),
  confirmarMontoInusual: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true" || v === "on" || v === "si")
    .default(false),
});
export type AplicarPlanillaDeUsos = z.input<typeof aplicarPlanillaDeUsosSchema>;
