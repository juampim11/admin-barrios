import "server-only";

/**
 * **Qué administración muestra una pantalla de «todos los barrios»** — la configuración general, sus
 * estudios jurídicos y la mora de todos los barrios (encargo 8, T1 §4; encargo E-a). Estaba escrito
 * dentro de `configuracion/page.tsx`; se mudó acá cuando aparecieron otras dos pantallas que tenían
 * que elegir igual, para que las tres no decidan distinto.
 *
 * Nada de esto autoriza: cada servicio vuelve a decidir la visibilidad bajo RLS.
 */

import { cookies } from "next/headers";
import {
  administracionDelBarrio,
  listarAdministracionesVisibles,
  type AdministracionVisible,
} from "@admin-barrios/data/servicios/parametros";
import { listarBarriosAccesibles, type BarrioAccesible } from "@admin-barrios/data/servicios/barrios";
import { COOKIE_ULTIMO_BARRIO, esIdValido } from "../../rutas.ts";
import type { Transaccion } from "../../acciones/ejecutar.ts";

/** Un valor de la URL que puede venir repetido: se toma el primero, y solo si es texto. */
export const primero = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * En orden:
 *
 * 1. La del `?administracion=`, si es una de las que esta persona ve. Un id ajeno o inventado se
 *    ignora (no es un 404: no se confirma ni se niega que exista).
 * 2. Si ve una sola, esa.
 * 3. La del último barrio visitado (cookie `httpOnly` que escribe `/configuracion/desde/[barrio]`).
 * 4. La primera por nombre. No hay pantalla para elegir: el selector de barrio cambia de contexto.
 */
export function elegirAdministracion(
  visibles: readonly AdministracionVisible[],
  pedida: string | undefined,
  delUltimoBarrio: AdministracionVisible | null,
): AdministracionVisible | null {
  const entre = (id: string | undefined) => (id ? (visibles.find((a) => a.id === id) ?? null) : null);
  return (
    entre(pedida) ??
    (visibles.length === 1 ? (visibles[0] ?? null) : null) ??
    entre(delUltimoBarrio?.id) ??
    visibles[0] ??
    null
  );
}

/** Lo que la página lee de la URL y la cookie, **antes** de abrir la transacción. */
export async function pedidoDeAdministracion(
  consulta: Readonly<Record<string, string | string[] | undefined>>,
): Promise<{ readonly pedida: string | undefined; readonly ultimoBarrioId: string | null }> {
  const pedidaCruda = primero(consulta["administracion"]);
  const ultimoCrudo = (await cookies()).get(COOKIE_ULTIMO_BARRIO)?.value;
  return {
    pedida: pedidaCruda && esIdValido(pedidaCruda) ? pedidaCruda : undefined,
    ultimoBarrioId: ultimoCrudo && esIdValido(ultimoCrudo) ? ultimoCrudo : null,
  };
}

export type AdministracionResuelta = {
  readonly visibles: readonly AdministracionVisible[];
  readonly barrios: readonly BarrioAccesible[];
  /** El último barrio visitado, solo si sigue siendo visible: la RLS decide, la cookie no. */
  readonly ultimo: BarrioAccesible | null;
  readonly elegida: AdministracionVisible | null;
};

/** Las lecturas de la elección, secuenciales y en la transacción de quien llama. */
export async function resolverAdministracion(
  tx: Transaccion,
  pedido: { readonly pedida: string | undefined; readonly ultimoBarrioId: string | null },
): Promise<AdministracionResuelta> {
  const visibles = await listarAdministracionesVisibles(tx);
  const barrios = await listarBarriosAccesibles(tx);
  const ultimo = pedido.ultimoBarrioId ? (barrios.find((b) => b.id === pedido.ultimoBarrioId) ?? null) : null;
  const delUltimo = ultimo ? await administracionDelBarrio(tx, { barrioId: ultimo.id }) : null;
  return { visibles, barrios, ultimo, elegida: elegirAdministracion(visibles, pedido.pedida, delUltimo) };
}

/**
 * El barrio de la barra lateral: el último visitado, solo si es de esta administración; si no, el
 * primero de esta administración que se vea; y si tampoco, el primero que se vea.
 */
export function barrioDeLaBarra(
  resuelta: AdministracionResuelta,
  idsDeLaAdministracion: readonly string[],
): BarrioAccesible | null {
  const suyos = new Set(idsDeLaAdministracion);
  return (
    (resuelta.ultimo && suyos.has(resuelta.ultimo.id) ? resuelta.ultimo : null) ??
    resuelta.barrios.find((b) => suyos.has(b.id)) ??
    resuelta.barrios[0] ??
    null
  );
}
