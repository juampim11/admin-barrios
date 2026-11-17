/**
 * Lo elegido para derivar en la lista de mora, sin React: puro y probable.
 *
 * **Portado de Aclade** (`aclade-cobranzas/src/lib/seleccion-derivar.ts`). La regla es la misma: **la
 * elección pertenece al filtro con el que se hizo**. Cambiar de filtro (barrio, estudio o chip) la
 * vacía, y volver al filtro anterior no la trae de vuelta. Acá no hay paginado —la lista de mora sale
 * entera—, así que la parte de Aclade que contaba las elegidas «fuera de esta página» no se portó.
 *
 * Lo que cambia respecto de Aclade es el vocabulario (unidad en vez de UF) y nada más.
 */

export interface EstadoSeleccion {
  /** Clave del filtro con el que se hizo la elección. */
  readonly clave: string;
  readonly elegidas: ReadonlySet<string>;
}

/** La clave de un filtro: los pares de la URL, en orden estable y sin los vacíos. (Aclade sacaba además la página.) */
export function claveDeFiltro(params: Readonly<Record<string, string | null | undefined>>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export const sinElegir = (clave: string): EstadoSeleccion => ({ clave, elegidas: new Set() });

/**
 * Lo elegido que vale para el filtro actual: si la clave cambió, nada; y, con `delFiltro`, solo lo que
 * sigue en el filtro (una unidad que dejó de estar en él sin que cambie la clave —la derivó otra
 * persona y la lista se refrescó— deja de estar elegida).
 */
export function elegidasVigentes(estado: EstadoSeleccion, claveActual: string, delFiltro?: readonly string[]): ReadonlySet<string> {
  if (estado.clave !== claveActual) return new Set();
  if (!delFiltro) return estado.elegidas;
  const enFiltro = new Set(delFiltro);
  return new Set([...estado.elegidas].filter((u) => enFiltro.has(u)));
}

export function alternarUnidad(estado: EstadoSeleccion, claveActual: string, unidadId: string): EstadoSeleccion {
  const n = new Set(elegidasVigentes(estado, claveActual));
  if (n.has(unidadId)) n.delete(unidadId);
  else n.add(unidadId);
  return { clave: claveActual, elegidas: n };
}

export function agregarUnidades(estado: EstadoSeleccion, claveActual: string, unidadIds: readonly string[]): EstadoSeleccion {
  return { clave: claveActual, elegidas: new Set([...elegidasVigentes(estado, claveActual), ...unidadIds]) };
}

/** Saca unas unidades de la elección (las de un barrio sin estudio, desde el diálogo). No está en Aclade. */
export function quitarUnidades(estado: EstadoSeleccion, claveActual: string, unidadIds: readonly string[]): EstadoSeleccion {
  const fuera = new Set(unidadIds);
  return { clave: claveActual, elegidas: new Set([...elegidasVigentes(estado, claveActual)].filter((u) => !fuera.has(u))) };
}

/** Lo que se manda a derivar: solo lo que el diálogo mostró y que sigue elegido, en el orden del diálogo. */
export function aMandar(mostradas: readonly string[], elegidas: ReadonlySet<string>): string[] {
  return mostradas.filter((u) => elegidas.has(u));
}
