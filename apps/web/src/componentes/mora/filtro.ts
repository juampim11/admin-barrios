/**
 * El filtro de la lista de mora (encargo E-a): qué se lee de la URL, qué filas quedan y cuántas hay en
 * cada chip. **Puro y sin regla de negocio**: la situación de cada unidad ya viene resuelta por el
 * servicio (`situacionMora`, `@admin-barrios/shared/mora`); acá solo se elige cuáles mostrar.
 *
 * Lo usan las dos pantallas —«Mora · todos los barrios» y la del barrio— y el CSV, para que el archivo
 * que se baja tenga **exactamente** las filas que se están viendo.
 */

import { idSchema } from "@admin-barrios/shared/consultas";
import type { FilaMora } from "@admin-barrios/data/servicios/mora";

/**
 * Los chips. «En plan» entró con los planes de pago (P2a-1): hasta entonces no estaba, porque un chip que
 * siempre cuenta cero promete algo que la aplicación no hace (doc 06 §c.6.4).
 */
export const VISTAS_MORA = ["con_deuda", "para_derivar", "derivadas", "en_plan", "promesa_vencida"] as const;
export type VistaMora = (typeof VISTAS_MORA)[number];

export const TEXTO_VISTA: Record<VistaMora, string> = {
  con_deuda: "Con deuda",
  para_derivar: "Para derivar",
  derivadas: "Derivadas",
  en_plan: "En plan",
  promesa_vencida: "Promesa vencida",
};

/** El chip con el que se entra: el de la maqueta, lo que el sistema propone derivar. */
export const VISTA_POR_DEFECTO: VistaMora = "para_derivar";

/** «Sin derivar» en el filtro de estudio: las que no están en ningún estudio. */
export const SIN_DERIVAR = "sin";

export type FiltroMora = {
  /** Solo en «todos los barrios»: un barrio, o `null` = todos. */
  readonly barrio: string | null;
  /** Un estudio, `SIN_DERIVAR`, o `null` = todos. */
  readonly estudio: string | null;
  readonly ver: VistaMora;
};

const unico = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const id = (v: string | undefined): string | null => (v && idSchema.safeParse(v).success ? v : null);

/**
 * El filtro que trae la URL. Viene del cliente: lo que no tiene forma se ignora (un barrio o un estudio
 * que no es un uuid, una vista desconocida), sin error. Que el barrio o el estudio sean de quien mira
 * no lo decide esto: las filas ya llegaron bajo RLS, y un id ajeno no matchea ninguna.
 */
export function leerFiltroMora(
  crudos: Readonly<Record<string, string | string[] | undefined>>,
  { conBarrio }: { readonly conBarrio: boolean },
): FiltroMora {
  const estudio = unico(crudos["estudio"]);
  const ver = unico(crudos["ver"]);
  return {
    barrio: conBarrio ? id(unico(crudos["barrio"])) : null,
    estudio: estudio === SIN_DERIVAR ? SIN_DERIVAR : id(estudio),
    ver: VISTAS_MORA.find((v) => v === ver) ?? VISTA_POR_DEFECTO,
  };
}

/** Los parámetros de la URL de un filtro: lo que vale «todos» o el chip por defecto no se escribe. */
export function parametrosDelFiltro(f: FiltroMora): Record<string, string | null> {
  return { barrio: f.barrio, estudio: f.estudio, ver: f.ver === VISTA_POR_DEFECTO ? null : f.ver };
}

type FilaParaFiltrar = Pick<FilaMora, "barrioId" | "meses" | "situacion" | "derivacion" | "promesa">;

/** El barrio y el estudio: lo que recortan los desplegables (y lo que cuentan los chips). */
export function enAlcance(f: FiltroMora, fila: FilaParaFiltrar): boolean {
  if (f.barrio !== null && fila.barrioId !== f.barrio) return false;
  if (f.estudio === SIN_DERIVAR) return fila.derivacion === null;
  if (f.estudio !== null) return fila.derivacion?.estudioId === f.estudio;
  return true;
}

/** Si una fila va en un chip. Las mismas definiciones que las cifras de `moraDeLaAdministracion`. */
export function enVista(v: VistaMora, fila: FilaParaFiltrar): boolean {
  switch (v) {
    case "con_deuda":
      return fila.meses > 0;
    case "para_derivar":
      return fila.situacion === "para_derivar";
    case "derivadas":
      return fila.derivacion !== null;
    case "en_plan":
      return fila.situacion === "en_plan";
    case "promesa_vencida":
      return fila.promesa?.estado === "vencida";
  }
}

export function filtrarMora<T extends FilaParaFiltrar>(filas: readonly T[], f: FiltroMora): T[] {
  return filas.filter((fila) => enAlcance(f, fila) && enVista(f.ver, fila));
}

/** Cuántas hay en cada chip, dentro del barrio y el estudio elegidos. */
export function contarVistas(filas: readonly FilaParaFiltrar[], f: FiltroMora): Record<VistaMora, number> {
  const enEl = filas.filter((fila) => enAlcance(f, fila));
  return {
    con_deuda: enEl.filter((x) => enVista("con_deuda", x)).length,
    para_derivar: enEl.filter((x) => enVista("para_derivar", x)).length,
    derivadas: enEl.filter((x) => enVista("derivadas", x)).length,
    en_plan: enEl.filter((x) => enVista("en_plan", x)).length,
    promesa_vencida: enEl.filter((x) => enVista("promesa_vencida", x)).length,
  };
}
