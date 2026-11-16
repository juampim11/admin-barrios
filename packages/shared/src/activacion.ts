/**
 * Activar un barrio que ya venía funcionando (encargo 17, Etapa 1.4): la planilla de deuda anterior,
 * los textos y los esquemas de las escrituras. Dominio puro: lo que toca Postgres está en
 * `packages/data/src/servicios/activacion.ts`.
 *
 * La deuda anterior se trae **mes por mes**, no como un saldo: cada renglón es lo que una unidad
 * todavía debe de un mes, por un concepto del catálogo del barrio y con su vencimiento. Un renglón
 * negativo y sin mes es un saldo a favor.
 *
 * No hay un lector de planillas acá (regla EX-4): el archivo lo lee el servidor con `filasDeXlsx` /
 * `textoDeCsv` y este validador recibe las celdas como texto.
 */

import { z } from "zod";
import { idSchema } from "./consultas.ts";
import { leerFechaDePlanilla, nombreDeConceptoNormalizado, type ErrorDeFila } from "./conceptos.ts";
import { deCentavos, type Monto } from "./dinero.ts";

export const ESTADOS_DE_ACTIVACION = ["sin_activar", "activo"] as const;
export type EstadoDeActivacion = (typeof ESTADOS_DE_ACTIVACION)[number];

/** De dónde sale cada mes adeudado, como se lee en el estado de cuenta. */
export const TEXTO_ORIGEN_DE_LA_DEUDA: Record<"mensual" | "historico", string> = {
  historico: "Anterior a la activación",
  mensual: "Devengado en el sistema",
};

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La planilla de deuda
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** El tope de la base (`app.cargar_deuda_historica`): más que esto se parte en varias cargas… que no hay. */
export const MAX_FILAS_DEUDA = 5000;
export const COLUMNAS_DE_DEUDA = ["manzana", "lote", "mes", "concepto", "vencimiento", "importe"] as const;
type ColumnaDeDeuda = (typeof COLUMNAS_DE_DEUDA)[number];

/** Una deuda leída de la planilla, sin resolver contra el padrón ni el catálogo. */
export type DeudaLeida = {
  readonly fila: number;
  readonly manzana: string;
  readonly lote: string;
  /** `YYYY-MM`. */
  readonly periodo: string;
  readonly concepto: string;
  /** `YYYY-MM-DD`. */
  readonly vencimiento: string;
  /** Lo que falta pagar de ese mes y concepto: positivo, con dos decimales. */
  readonly importe: Monto;
};

/** Un saldo a favor leído de la planilla: el importe ya en positivo. */
export type SaldoAFavorLeido = {
  readonly fila: number;
  readonly manzana: string;
  readonly lote: string;
  readonly importe: Monto;
};

const sinAcentos = nombreDeConceptoNormalizado;

/** `08/2026`, `8/2026` o `2026-08` → `2026-08`. `null` si no es un mes. */
export function leerMesDePlanilla(texto: string): string | null {
  const t = texto.trim();
  const m = /^(\d{1,2})[/-](\d{4})$/.exec(t) ?? null;
  const iso = /^(\d{4})-(\d{1,2})(?:-01)?(?:T.*)?$/.exec(t) ?? null;
  const mes = m ? Number(m[1]) : iso ? Number(iso[2]) : NaN;
  const anio = m ? Number(m[2]) : iso ? Number(iso[1]) : NaN;
  if (!Number.isInteger(mes) || mes < 1 || mes > 12 || !Number.isInteger(anio) || anio < 2000 || anio > 2100) return null;
  return `${anio}-${String(mes).padStart(2, "0")}`;
}

/**
 * Un importe de planilla a centavos, con su signo. Acepta `125000`, `125000,5`, `125000.50`,
 * `125.000,50`, `1.250.000` y un `$` adelante. **`125.000` se rechaza**: sin coma no se puede saber si
 * el punto es de miles o de decimales, y no se adivina con plata (mismo criterio que la planilla de
 * usos). `null` si no se entiende.
 */
export function leerImporteDePlanilla(texto: string): bigint | null {
  let t = texto.trim().replace(/^\$\s*/, "").replace(/\s+/g, "");
  if (t.length === 0 || t.length > 24) return null;
  const negativo = t.startsWith("-");
  if (negativo) t = t.slice(1).replace(/^\$/, "");
  let enteros: string;
  let decimales = "";
  if (t.includes(",")) {
    // Con coma, la coma es la de los decimales y los puntos, si hay, son de miles (grupos de tres).
    const partes = t.split(",");
    if (partes.length !== 2) return null;
    if (partes[0]!.includes(".") && !/^\d{1,3}(\.\d{3})+$/.test(partes[0]!)) return null;
    enteros = partes[0]!.replace(/\./g, "");
    decimales = partes[1]!;
  } else if ((t.match(/\./g) ?? []).length > 1) {
    if (!/^\d{1,3}(\.\d{3})+$/.test(t)) return null;
    enteros = t.replace(/\./g, "");
  } else if (t.includes(".")) {
    const partes = t.split(".");
    // Un solo punto con tres cifras detrás: ¿miles o decimales? No se adivina.
    if (partes[1]!.length === 3) return null;
    enteros = partes[0]!;
    decimales = partes[1]!;
  } else {
    enteros = t;
  }
  // Hasta doce cifras enteras: el tope de la base (`app.cargar_deuda_historica`).
  if (!/^\d{1,12}$/.test(enteros) || !/^\d{0,2}$/.test(decimales)) return null;
  const centavos = BigInt(enteros) * 100n + BigInt(decimales.padEnd(2, "0") || "0");
  return negativo ? -centavos : centavos;
}

/** Con qué nombres se acepta cada columna (ya sin acentos ni mayúsculas). Lista cerrada: no se adivina. */
const NOMBRES_DE_COLUMNA: Record<ColumnaDeDeuda, readonly string[]> = {
  manzana: ["manzana"],
  lote: ["lote"],
  mes: ["mes"],
  concepto: ["concepto"],
  vencimiento: ["vencimiento", "vencio"],
  importe: ["importe", "importe adeudado", "importe que falta pagar", "falta pagar"],
};

/**
 * En qué posiciones del encabezado (ya normalizado) está una columna de la planilla de deuda. Más de
 * una posición es una planilla ambigua. La usan el validador y el servidor que achica la planilla
 * antes de mandarla: los dos tienen que buscar igual.
 */
export function indicesDeColumnaDeDeuda(encabezado: readonly string[], columna: ColumnaDeDeuda): number[] {
  return encabezado.flatMap((n, i) => (NOMBRES_DE_COLUMNA[columna].includes(n) ? [i] : []));
}

/** La clave de un renglón de deuda: no puede repetirse en la planilla. */
const claveDeDeuda = (d: { manzana: string; lote: string; periodo: string; concepto: string; vencimiento: string }): string =>
  `${claveDeUnidad(d.manzana, d.lote)}|${d.periodo}|${sinAcentos(d.concepto)}|${d.vencimiento}`;

/** Cómo se compara una unidad de la planilla con el padrón: sin distinguir mayúsculas ni espacios. */
export const claveDeUnidad = (manzana: string, lote: string): string => `${manzana.trim().toUpperCase()}|${lote.trim().toUpperCase()}`;

/**
 * Lee la planilla de deuda. Devuelve **todos** los errores, por fila (la del archivo: el encabezado
 * es la 1). Lo que acá no se puede saber —si la unidad está en el padrón, si el concepto existe, si el
 * vencimiento ya pasó— lo revisa el servicio.
 */
export function leerPlanillaDeDeuda(filasCrudas: readonly (readonly string[])[]): {
  readonly deudas: readonly DeudaLeida[];
  readonly aFavor: readonly SaldoAFavorLeido[];
  readonly errores: readonly ErrorDeFila[];
} {
  const [encabezado, ...resto] = filasCrudas;
  const nombres = (encabezado ?? []).map((c) => sinAcentos(String(c ?? "")));
  // Una exportación del sistema anterior puede traer «importe original», «importe pagado» e «importe
  // adeudado»: si hay más de una columna que se lee como el importe, no se elige (code-reviewer, M2).
  const importes = indicesDeColumnaDeDeuda(nombres, "importe");
  if (importes.length > 1) {
    return {
      deudas: [],
      aFavor: [],
      errores: [{ fila: 1, mensaje: "La planilla tiene más de una columna de importe: dejá una sola, con lo que falta pagar." }],
    };
  }
  const indice = Object.fromEntries(COLUMNAS_DE_DEUDA.map((c) => [c, indicesDeColumnaDeDeuda(nombres, c)[0] ?? -1])) as Record<ColumnaDeDeuda, number>;
  const faltan = COLUMNAS_DE_DEUDA.filter((c) => indice[c] < 0);
  if (faltan.length > 0) {
    return {
      deudas: [],
      aFavor: [],
      errores: [
        {
          fila: 1,
          mensaje: `La planilla necesita las columnas manzana, lote, mes, concepto, vencimiento e importe. ${faltan.length === 1 ? "Falta" : "Faltan"}: ${faltan.join(", ")}.`,
        },
      ],
    };
  }
  const conDatos = resto.map((c, i) => ({ c, fila: i + 2 })).filter(({ c }) => c.some((x) => String(x ?? "").trim() !== ""));
  if (conDatos.length === 0) return { deudas: [], aFavor: [], errores: [{ fila: 1, mensaje: "La planilla no tiene filas." }] };
  if (conDatos.length > MAX_FILAS_DEUDA) {
    return { deudas: [], aFavor: [], errores: [{ fila: 1, mensaje: `La planilla tiene más de ${MAX_FILAS_DEUDA} filas.` }] };
  }

  const deudas: DeudaLeida[] = [];
  const aFavor: SaldoAFavorLeido[] = [];
  const errores: ErrorDeFila[] = [];
  const vistas = new Map<string, number>();
  for (const { c, fila } of conDatos) {
    const celda = (col: ColumnaDeDeuda) => String(c[indice[col]] ?? "").trim();
    const manzana = celda("manzana");
    const lote = celda("lote");
    const mesTexto = celda("mes");
    const concepto = celda("concepto");
    const importe = leerImporteDePlanilla(celda("importe"));
    if (!manzana || !lote) {
      errores.push({ fila, mensaje: "Falta la manzana o el lote." });
      continue;
    }
    if (manzana.length > 20 || lote.length > 20) {
      errores.push({ fila, mensaje: "La manzana o el lote son demasiado largos." });
      continue;
    }
    if (importe === null) {
      errores.push({
        fila,
        mensaje: `El importe «${celda("importe").slice(0, 24)}» no se entiende: escribilo sin punto de miles (125000 o 125000,50).`,
      });
      continue;
    }
    if (importe === 0n) {
      errores.push({ fila, mensaje: "El importe es cero: un mes que no debe nada no va en la planilla." });
      continue;
    }
    if (importe < 0n) {
      // Un saldo a favor: negativo y sin mes. No lleva concepto ni vencimiento.
      if (mesTexto !== "") {
        errores.push({ fila, mensaje: "Un importe negativo es un saldo a favor y va sin mes. Si es una deuda, escribila en positivo." });
        continue;
      }
      // Con concepto o vencimiento es, casi seguro, una deuda con el signo al revés: no se adivina.
      if (concepto !== "" || celda("vencimiento") !== "") {
        errores.push({ fila, mensaje: "Un saldo a favor va sin concepto ni vencimiento. Si es una deuda, escribila en positivo y con su mes." });
        continue;
      }
      const clave = `favor|${claveDeUnidad(manzana, lote)}`;
      if (vistas.has(clave)) {
        errores.push({ fila, mensaje: `La unidad ya tiene un saldo a favor en la fila ${vistas.get(clave)}: sumalos en un solo renglón.` });
        continue;
      }
      vistas.set(clave, fila);
      aFavor.push({ fila, manzana, lote, importe: deCentavos(-importe) });
      continue;
    }
    const periodo = leerMesDePlanilla(mesTexto);
    const vencimiento = leerFechaDePlanilla(celda("vencimiento"));
    if (mesTexto === "") errores.push({ fila, mensaje: "Falta el mes de la deuda (mm/aaaa)." });
    else if (periodo === null) errores.push({ fila, mensaje: `El mes «${mesTexto.slice(0, 20)}» no se entiende: escribilo como mm/aaaa.` });
    else if (!concepto) errores.push({ fila, mensaje: "Falta el concepto." });
    else if (concepto.length > 120) errores.push({ fila, mensaje: "El nombre del concepto es demasiado largo." });
    else if (vencimiento === null) {
      errores.push({ fila, mensaje: `El vencimiento «${celda("vencimiento").slice(0, 20)}» no existe o no se entiende: escribilo como dd/mm/aaaa.` });
    } else {
      const d = { fila, manzana, lote, periodo, concepto, vencimiento, importe: deCentavos(importe) };
      const clave = claveDeDeuda(d);
      if (vistas.has(clave)) {
        errores.push({ fila, mensaje: `Renglón repetido: es la misma unidad, mes, concepto y vencimiento que la fila ${vistas.get(clave)}.` });
        continue;
      }
      vistas.set(clave, fila);
      deudas.push(d);
    }
  }
  // Deuda y saldo a favor en la misma unidad se contradicen: se descuenta uno del otro antes de subir.
  const conDeuda = new Set(deudas.map((d) => claveDeUnidad(d.manzana, d.lote)));
  const sinContradiccion = aFavor.filter((f) => {
    if (!conDeuda.has(claveDeUnidad(f.manzana, f.lote))) return true;
    errores.push({ fila: f.fila, mensaje: "La unidad trae deuda y saldo a favor: descontá el saldo de lo que debe y dejá un solo dato." });
    return false;
  });
  return { deudas, aFavor: sinContradiccion, errores: errores.sort((a, b) => a.fila - b.fila) };
}

/** La planilla modelo: el encabezado y tres filas de ejemplo (dos deudas y un saldo a favor). */
export function plantillaDeDeuda(): string[][] {
  return [
    [...COLUMNAS_DE_DEUDA],
    ["1", "7", "08/2026", "Expensa", "10/08/2026", "125000"],
    ["1", "7", "10/2026", "Expensa", "10/10/2026", "62500,50"],
    ["2", "3", "", "", "", "-18000"],
  ];
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Las escrituras
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Las celdas de la planilla, ya leídas del archivo por el servidor, como texto. */
const filasDePlanillaSchema = z.array(z.array(z.string().max(500)).max(20)).min(1).max(MAX_FILAS_DEUDA + 100);

export const cargarDeudaAnteriorSchema = z.object({
  barrioId: idSchema,
  archivo: z.string().trim().min(1, "Falta el nombre del archivo.").max(200),
  filas: filasDePlanillaSchema,
});
export type CargarDeudaAnterior = z.input<typeof cargarDeudaAnteriorSchema>;

/**
 * Una tasa mensual escrita como porcentaje (`3`, `3,5`, `2.75`) → fracción con seis decimales
 * (`0.030000`), que es como la guardan los parámetros de mora. `null` si no es un porcentaje entre 0 y 100.
 */
export function tasaDePorcentaje(texto: string): string | null {
  const t = texto.trim().replace(/%$/, "").trim().replace(",", ".");
  const m = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(t);
  if (!m) return null;
  // Diezmilésimas de punto porcentual = millonésimas de la fracción.
  const millonesimas = BigInt(m[1]!) * 10000n + BigInt((m[2] ?? "").padEnd(4, "0") || "0");
  if (millonesimas > 1000000n) return null;
  return `${millonesimas / 1000000n}.${(millonesimas % 1000000n).toString().padStart(6, "0")}`;
}

/** Al revés: `0.030000` → `3`, `0.035000` → `3,5`. Para mostrar y para precargar el campo. */
export function porcentajeDeTasa(tasa: string): string {
  const [enteros = "0", decimales = ""] = tasa.split(".");
  const millonesimas = BigInt(enteros) * 1000000n + BigInt(decimales.padEnd(6, "0").slice(0, 6) || "0");
  const resto = (millonesimas % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return `${millonesimas / 10000n}${resto ? `,${resto}` : ""}`;
}

export const activarBarrioSchema = z
  .object({
    barrioId: idSchema,
    /** La tasa mensual para la deuda anterior, como porcentaje: `3` o `3,5`. */
    tasa: z.string().trim().min(1, "Escribí la tasa mensual para la deuda anterior."),
    /** Obligatorio si la tasa no es la vigente del barrio (lo controla la base). */
    motivo: z
      .string()
      .trim()
      .max(500)
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .default(null),
  })
  .transform((v, ctx) => {
    const fraccion = tasaDePorcentaje(v.tasa);
    if (fraccion === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tasa"], message: "La tasa es un porcentaje mensual entre 0 y 100, con hasta cuatro decimales." });
      return z.NEVER;
    }
    return { barrioId: v.barrioId, tasa: fraccion, motivo: v.motivo };
  });
export type ActivarBarrio = z.input<typeof activarBarrioSchema>;
