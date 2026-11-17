/**
 * Cómo se dice cada fila de la lista de mora en palabras: el chip de «Situación» y la «Última
 * gestión». Lo usan la tabla y el CSV, para que la planilla diga lo mismo que la pantalla.
 *
 * **No decide la situación**: viene resuelta del servicio (`situacionMora`). Esto solo la nombra, con
 * los textos del dominio (`TEXTO_CANAL`, `TEXTO_RESULTADO`) y las fechas de `shared/fechas`.
 */

import { formatearMonto } from "@admin-barrios/shared/dinero";
import { formatearFecha } from "@admin-barrios/shared/fechas";
import { TEXTO_CANAL, TEXTO_RESULTADO } from "@admin-barrios/shared/mora";
import type { FilaMora } from "@admin-barrios/data/servicios/mora";
import type { OrigenDelCriterio } from "@admin-barrios/shared/mora";
import { meses } from "./derivar.ts";

/** Los tonos que usa la columna (un subconjunto de los del chip del kit). */
export type TonoDeSituacion = "peligro" | "alerta" | "derivada" | "neutro";

export type ChipDeSituacion = { readonly tono: TonoDeSituacion; readonly texto: string };

/** `"2026-11-05"` → `"05/11"`: la fecha corta de la lista (la completa va en la ficha y en el CSV). */
export const diaYMes = (iso: string): string => formatearFecha(iso).slice(0, 5);

type FilaParaTexto = Pick<FilaMora, "situacion" | "derivacion" | "promesa" | "ultimaGestion">;

/**
 * Los chips de la columna «Situación». Casi siempre uno; dos cuando la unidad pasa el criterio **y**
 * tiene una promesa vencida —las dos cosas son ciertas y las dos importan para decidir—.
 */
export function chipsDeSituacion(f: FilaParaTexto): ChipDeSituacion[] {
  const vencida = f.promesa?.estado === "vencida";
  switch (f.situacion) {
    case "derivada": {
      // Una derivada con la promesa vencida lo dice también: el estudio la tiene, pero es un dato para él.
      const chip: ChipDeSituacion = { tono: "derivada", texto: `Derivada · ${f.derivacion?.estudio ?? "estudio"}` };
      return vencida ? [chip, { tono: "peligro", texto: "Promesa vencida" }] : [chip];
    }
    // [P1] Con un plan de pagos vigente: la deuda vencida que muestra es una cuota del plan.
    case "en_plan":
      return [{ tono: "neutro", texto: "En plan de pagos" }];
    case "promesa":
      return [{ tono: "alerta", texto: f.promesa ? `Promesa al ${diaYMes(f.promesa.fecha)}` : "Promesa de pago" }];
    case "para_derivar":
      return vencida
        ? [
            { tono: "peligro", texto: "Para derivar" },
            { tono: "peligro", texto: "Promesa vencida" },
          ]
        : [{ tono: "peligro", texto: "Para derivar" }];
    case "debajo_del_minimo":
      return vencida ? [{ tono: "peligro", texto: "Promesa vencida" }] : [{ tono: "alerta", texto: "Debajo del monto mínimo" }];
    case "con_deuda":
      return vencida ? [{ tono: "peligro", texto: "Promesa vencida" }] : [{ tono: "neutro", texto: "Con deuda" }];
  }
}

/** La situación en una sola línea, para el CSV. */
export const textoDeSituacion = (f: FilaParaTexto): string =>
  chipsDeSituacion(f)
    .map((c) => c.texto)
    .join(" · ");

/**
 * La última gestión: «Llamada · 09/11» y, aparte, el resultado («No contesta»). Si la cargó el estudio,
 * se dice. Sin gestión, `null` (la pantalla escribe «—»).
 */
export function ultimaGestionEnPalabras(
  f: FilaParaTexto,
  { fechaCompleta = false }: { readonly fechaCompleta?: boolean } = {},
): { readonly principal: string; readonly resultado: string | null } | null {
  const g = f.ultimaGestion;
  if (!g) return null;
  // El renglón de una derivación que después se retiró: se dice el retiro, no la derivación.
  if (g.retiradaEl) {
    return { principal: `Retirada del estudio · ${fechaCompleta ? formatearFecha(g.retiradaEl) : diaYMes(g.retiradaEl)}`, resultado: null };
  }
  const fecha = fechaCompleta ? formatearFecha(g.fecha) : diaYMes(g.fecha);
  const quien = g.autor === "estudio" ? " (estudio)" : "";
  return { principal: `${TEXTO_CANAL[g.canal]} · ${fecha}${quien}`, resultado: g.resultado ? TEXTO_RESULTADO[g.resultado] : null };
}

/** La última gestión en una sola línea, para el CSV. */
export function textoDeUltimaGestion(f: FilaParaTexto): string | null {
  const u = ultimaGestionEnPalabras(f, { fechaCompleta: true });
  return u ? [u.principal, u.resultado].filter((x): x is string => x !== null).join(" · ") : null;
}

/**
 * Los meses del criterio en palabras: «con algún mes vencido» (0, que es «más de 0»), «más de 1 mes»,
 * «más de 3 meses». Un solo lugar, para que la lista y la configuración del barrio digan lo mismo.
 */
export function mesesDelCriterio(n: number): string {
  return n === 0 ? "con algún mes vencido" : `más de ${meses(n)}`;
}

/** De dónde sale el criterio de un barrio, entre paréntesis después del criterio. */
export const ORIGEN_DEL_CRITERIO: Record<OrigenDelCriterio, string> = {
  barrio: "propio del barrio",
  administracion: "de la administración",
  por_defecto: "por defecto: la administración todavía no cargó uno",
};

/** El criterio entero: «más de 3 meses de deuda vencida y desde $ 300.000,00». */
export function criterioEnPalabras(c: { readonly meses: number; readonly montoMinimo: string }): string {
  const plazo = c.meses === 0 ? "con algún mes vencido" : `más de ${meses(c.meses)} de deuda vencida`;
  return `${plazo} y desde $ ${formatearMonto(c.montoMinimo)}`;
}
