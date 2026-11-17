/**
 * El diálogo de derivar en lote, sin React: cómo se agrupan las unidades elegidas por barrio, qué
 * estudio viene elegido en cada grupo, qué falta para poder derivar y qué se dice de los correos.
 *
 * **La regla de fondo no es de acá**: que un estudio solo reciba unidades de los barrios donde trabaja
 * lo exige la base (`app.derivacion_antes`, `0091`). Esto solo **no ofrece** lo que la base va a
 * rechazar: cada grupo lista los estudios de su barrio y nada más.
 *
 * Estructura adaptada del diálogo de Aclade (`aclade-cobranzas/src/components/derivar-estudio.tsx`,
 * `ContenidoDerivarVarias`), que agrupaba por obra; acá el grupo es el barrio y cada uno elige estudio.
 * Sin dependencias: lo importa la isla de cliente y no tiene que arrastrar Zod ni el dominio.
 */

/** Una unidad que se puede elegir, con lo que el diálogo dice de ella. */
export type ElegibleMora = {
  readonly id: string;
  readonly barrioId: string;
  /** «Mza 3 · Lote 14». */
  readonly unidad: string;
  readonly meses: number;
  readonly conIntimacion: boolean;
};

export type BarrioParaDerivar = {
  readonly id: string;
  readonly nombre: string;
  /** Si el criterio del barrio pide una intimación antes de derivar (avisa, no bloquea). */
  readonly pedirIntimacion: boolean;
  /** Los estudios que trabajan en el barrio, el de por defecto primero (así los da el servicio). */
  readonly estudios: readonly { readonly id: string; readonly nombre: string; readonly porDefecto: boolean }[];
};

export type GrupoParaDerivar<B extends BarrioParaDerivar = BarrioParaDerivar> = {
  readonly barrio: B;
  readonly unidades: readonly ElegibleMora[];
};

/**
 * Las elegidas, agrupadas por barrio en el orden en que vienen los barrios (alfabético, como los da el
 * servicio) y, dentro de cada uno, en el orden de la lista. Una elegida de un barrio que no está en la
 * lista no aparece: no hay a qué estudio mandarla.
 */
export function agruparPorBarrio<B extends BarrioParaDerivar>(
  elegidas: readonly ElegibleMora[],
  barrios: readonly B[],
): GrupoParaDerivar<B>[] {
  return barrios
    .map((barrio) => ({ barrio, unidades: elegidas.filter((u) => u.barrioId === barrio.id) }))
    .filter((g) => g.unidades.length > 0);
}

/**
 * El estudio que viene elegido en un grupo: el de por defecto; si el barrio no marcó ninguno y hay uno
 * solo, ese; si hay varios sin por defecto, ninguno (que elija la persona: «el primero de la lista» no
 * es una elección).
 */
export function estudioInicial(barrio: BarrioParaDerivar): string | null {
  const porDefecto = barrio.estudios.find((e) => e.porDefecto);
  if (porDefecto) return porDefecto.id;
  return barrio.estudios.length === 1 ? (barrio.estudios[0]?.id ?? null) : null;
}

/**
 * El estudio de cada barrio: si la persona tocó el selector, lo que eligió —y si eligió «Elegí el
 * estudio» (vacío) o algo que no es de ese barrio, **ninguno**: queda bloqueado, no vuelve solo al
 * inicial—; si no lo tocó, el inicial.
 */
export function estudioDe(barrio: BarrioParaDerivar, elegidos: Readonly<Record<string, string>>): string | null {
  if (!Object.hasOwn(elegidos, barrio.id)) return estudioInicial(barrio);
  const elegido = elegidos[barrio.id];
  // Solo vale si es uno de los estudios del barrio: lo demás no se ofrece.
  return elegido && barrio.estudios.some((e) => e.id === elegido) ? elegido : null;
}

/** Por qué no se puede derivar todavía, o `null` si se puede. El motivo va escrito en el diálogo. */
export function motivoParaNoDerivar(
  grupos: readonly GrupoParaDerivar[],
  elegidos: Readonly<Record<string, string>>,
): string | null {
  if (grupos.length === 0) return "No hay ninguna unidad elegida.";
  const sinEstudios = grupos.filter((g) => g.barrio.estudios.length === 0).map((g) => g.barrio.nombre);
  if (sinEstudios.length > 0) {
    return `${enumerar(sinEstudios)} ${sinEstudios.length === 1 ? "no tiene" : "no tienen"} ningún estudio: sumalo en la configuración del barrio, o sacá esas unidades de la elección.`;
  }
  const sinElegir = grupos.filter((g) => estudioDe(g.barrio, elegidos) === null).map((g) => g.barrio.nombre);
  if (sinElegir.length > 0) return `Elegí el estudio de ${enumerar(sinElegir)}.`;
  return null;
}

/** Cuántas unidades recibe cada estudio y de cuántos barrios: lo que diría el correo de cada uno. */
export function porEstudio(
  grupos: readonly GrupoParaDerivar[],
  elegidos: Readonly<Record<string, string>>,
): { readonly estudioId: string; readonly estudio: string; readonly unidades: number; readonly barrios: number }[] {
  const resumen = new Map<string, { estudio: string; unidades: number; barrios: Set<string> }>();
  for (const g of grupos) {
    const id = estudioDe(g.barrio, elegidos);
    const estudio = g.barrio.estudios.find((e) => e.id === id);
    if (!id || !estudio) continue;
    const r = resumen.get(id) ?? { estudio: estudio.nombre, unidades: 0, barrios: new Set<string>() };
    r.unidades += g.unidades.length;
    r.barrios.add(g.barrio.id);
    resumen.set(id, r);
  }
  return [...resumen].map(([estudioId, r]) => ({ estudioId, estudio: r.estudio, unidades: r.unidades, barrios: r.barrios.size }));
}

/**
 * Lo que se dice de los correos. **Hoy no sale ninguno**: los avisos a los estudios llegan con E-b. El
 * texto lo dice así, sin prometer un envío que no ocurre, y cuenta lo que diría cada correo cuando
 * exista.
 */
export function textoDeLosCorreos(resumen: ReturnType<typeof porEstudio>): string {
  if (resumen.length === 0) return "";
  const partes = resumen.map((r) => `${r.estudio}, ${unidades(r.unidades)}${r.barrios > 1 ? ` de ${barrios(r.barrios)}` : ""}`);
  return `Los avisos por correo al estudio todavía no salen: avisale vos (${partes.join("; ")}).`;
}

/** Cuántas elegidas no tienen intimación registrada en un barrio cuyo criterio la pide. */
export function sinIntimacion(grupos: readonly GrupoParaDerivar[]): number {
  return grupos.reduce((n, g) => n + (g.barrio.pedirIntimacion ? g.unidades.filter((u) => !u.conIntimacion).length : 0), 0);
}

/** «A y B», «A, B y C». */
export function enumerar(nombres: readonly string[]): string {
  if (nombres.length <= 1) return nombres.join("");
  return `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
}

/** «1 unidad», «3 unidades». */
export const unidades = (n: number): string => (n === 1 ? "1 unidad" : `${n} unidades`);
/** «1 barrio», «3 barrios». */
export const barrios = (n: number): string => (n === 1 ? "1 barrio" : `${n} barrios`);
/** «1 mes», «5 meses». */
export const meses = (n: number): string => (n === 1 ? "1 mes" : `${n} meses`);
/** «1 estudio», «2 estudios». */
export const estudios = (n: number): string => (n === 1 ? "1 estudio" : `${n} estudios`);
