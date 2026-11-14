/**
 * Cómo se **dice** lo que la pestaña Boletas muestra desde el encargo 16: las marcas de una boleta
 * («Sin bonificación», «Con cargos», «Deuda») y el detalle de «Ver quién» recibe la bonificación.
 *
 * Funciones puras, sin base ni React (`textos.test.ts`). **No deciden nada**: quién está al día, quién
 * la recibe y cuánto lo resolvió el servicio (`bonificacionDelMes`, `boletasDelMes`); acá se agrupa
 * para mostrar y se arma el texto. Tampoco se calcula dinero: `aCentavos` se usa solo para saber si
 * un importe es cero.
 */

import type { BonificacionDelMes, UnidadEnLaBonificacion } from "@admin-barrios/data/servicios/devengado";
import { aCentavos, formatearMonto } from "@admin-barrios/shared/dinero";
import { fechaIsoSchema, formatearFecha, nombreDelPeriodo } from "@admin-barrios/shared/fechas";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Las marcas de una boleta
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type MarcaDeBoleta = "sin_bonificacion" | "con_cargos" | "deuda";

export const TEXTO_DE_MARCA: Record<MarcaDeBoleta, string> = {
  sin_bonificacion: "Sin bonificación",
  con_cargos: "Con cargos",
  deuda: "Deuda",
};

/** Lo que hace falta de una boleta para marcarla. */
export type BoletaParaMarcar = {
  /** Cargos y descuentos sin la bonificación de la regla del barrio. */
  readonly otrosCargos: string;
  readonly saldoAnterior: string;
  readonly interes: string;
  readonly bonificada: boolean;
  readonly bonificacionNoAplicada: string | null;
};

/**
 * Lo «fuera de lo común» de una boleta, en el orden en que se muestra.
 *
 * «Con cargos» mira los cargos y descuentos **sin la bonificación de la regla**: la bonificación es lo
 * común, y marcar a todas las bonificadas no diría nada.
 */
export function marcasDeLaBoleta(b: BoletaParaMarcar): MarcaDeBoleta[] {
  const marcas: MarcaDeBoleta[] = [];
  if (b.bonificacionNoAplicada !== null) marcas.push("sin_bonificacion");
  if (aCentavos(b.otrosCargos) !== 0n) marcas.push("con_cargos");
  if (aCentavos(b.saldoAnterior) > 0n || aCentavos(b.interes) > 0n) marcas.push("deuda");
  return marcas;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// «Ver quién»
// ────────────────────────────────────────────────────────────────────────────────────────────────

const lista = (partes: readonly string[]): string =>
  partes.length <= 1 ? (partes[0] ?? "") : `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`;

/**
 * `["2026-09", "2026-10"]` → «septiembre y octubre de 2026». De años distintos, cada mes con su año;
 * más de tres, «5 meses, desde junio de 2026» (va en un chip).
 */
export function mesesConNombre(meses: readonly string[]): string {
  const partes = meses.map((m) => {
    const [mes = "", anio = ""] = nombreDelPeriodo(m).toLowerCase().split(" ");
    return { mes, anio };
  });
  const primero = partes[0];
  if (!primero) return "";
  if (partes.length > 3) return `${partes.length} meses, desde ${primero.mes} de ${primero.anio}`;
  return partes.every((p) => p.anio === primero.anio)
    ? `${lista(partes.map((p) => p.mes))} de ${primero.anio}`
    : lista(partes.map((p) => `${p.mes} de ${p.anio}`));
}

/** Por qué una unidad no está al día, en las palabras del chip. */
export function textoDeLoQueDebe(u: Pick<UnidadEnLaBonificacion, "mesesAdeudados" | "conSaldoInicial">): string {
  if (u.mesesAdeudados.length > 0) return `Debe ${mesesConNombre(u.mesesAdeudados)}`;
  return u.conSaldoInicial ? "Deuda anterior al sistema" : "Con deuda vencida";
}

const fecha = (iso: string): string | null => (fechaIsoSchema.safeParse(iso).success ? formatearFecha(iso) : null);

/** A qué fecha se miró quién está al día: hoy antes de emitir; la de emisión después. */
export function fraseDeEvaluacion(b: Pick<BonificacionDelMes, "emitido" | "evaluadaAl">): string {
  const dia = fecha(b.evaluadaAl);
  if (b.emitido) {
    return `Estaban al día las unidades sin deuda vencida al emitir${dia ? ` (${dia})` : ""}, con los pagos imputados hasta ese momento.`;
  }
  return `Están al día las unidades sin deuda vencida${dia ? ` al ${dia}` : ""}, con los pagos imputados hasta hoy.`;
}

export type UnidadParaElegir = { readonly unidadFuncionalId: string; readonly etiqueta: string };

export type ExcepcionEnLaLista = UnidadParaElegir & {
  readonly recibe: boolean;
  /** «Motivo · quién, fecha», ya armado. */
  readonly detalle: string;
  /** Lo bonificado o lo que no recibió, ya formateado. Solo después de emitir. */
  readonly importe: string | null;
};

export type SinBonificacionEnLaLista = UnidadParaElegir & {
  /** «Debe septiembre y octubre de 2026». */
  readonly debe: string;
  readonly importe: string | null;
};

/** Lo que el diálogo «Ver quién» dibuja: es lo único que cruza al navegador. */
export type DetalleDeBonificacion = {
  /** Las que están al día sin excepción y la reciben: se muestran agrupadas, no una por una. */
  readonly alDia: number;
  /** Esas mismas, para el selector de «Quitar». Vacío si quien mira no puede cargar excepciones. */
  readonly paraQuitar: readonly UnidadParaElegir[];
  readonly excepciones: readonly ExcepcionEnLaLista[];
  readonly sinBonificacion: readonly SinBonificacionEnLaLista[];
};

const importeDe = (u: UnidadEnLaBonificacion): string | null => (u.importe === null ? null : `$ ${formatearMonto(u.importe)}`);

/**
 * Agrupa las unidades como las muestra el diálogo. No reevalúa nada: `alDia`, `recibe` y `excepcion`
 * vienen del servicio.
 */
export function detalleDeBonificacion(b: Pick<BonificacionDelMes, "unidades" | "puedeExceptuar">): DetalleDeBonificacion {
  const alDia = b.unidades.filter((u) => u.excepcion === null && u.recibe);
  return {
    alDia: alDia.length,
    paraQuitar: b.puedeExceptuar ? alDia.map((u) => ({ unidadFuncionalId: u.unidadFuncionalId, etiqueta: u.etiqueta })) : [],
    excepciones: b.unidades.flatMap((u) =>
      u.excepcion === null
        ? []
        : [
            {
              unidadFuncionalId: u.unidadFuncionalId,
              etiqueta: u.etiqueta,
              recibe: u.recibe,
              detalle: [u.excepcion.motivo, [u.excepcion.cargoNombre, fecha(u.excepcion.cargadaEl)].filter(Boolean).join(", ")]
                .filter((t) => t !== "")
                .join(" · "),
              importe: importeDe(u),
            },
          ],
    ),
    sinBonificacion: b.unidades
      .filter((u) => u.excepcion === null && !u.recibe)
      .map((u) => ({
        unidadFuncionalId: u.unidadFuncionalId,
        etiqueta: u.etiqueta,
        debe: textoDeLoQueDebe(u),
        importe: importeDe(u),
      })),
  };
}
