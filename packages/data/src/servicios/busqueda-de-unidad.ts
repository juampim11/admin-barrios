/**
 * La búsqueda de una unidad por texto libre: **una sola**, para todas las grillas que la ofrecen.
 *
 * Nació en el padrón editable (`listarPadronEditable`, maqueta `alta-barrio-padron.html`) y se movió
 * acá cuando Cobros pidió la misma búsqueda (encargo 8, T1). Dos copias del mismo `where` divergen en
 * silencio: el día que el padrón aprenda a buscar por otra cosa, Cobros tiene que aprenderlo igual.
 *
 * Coincide por:
 * - **manzana y lote** («12 3» o «mza 12 lote 3», parcial);
 * - **código de pago**, por su número: «000004-5» → 4 (sin el verificador);
 * - **titular vigente**, por nombre (parcial) o por CUIT/CUIL/DNI (6 dígitos o más).
 *
 * Los titulares los sigue filtrando la RLS de `obligado`: un rol que no los ve no encuentra por nombre.
 *
 * Interno al paquete: no está en el mapa de `exports`. Devuelve un fragmento ` and (…)` para pegar
 * detrás de un `where` sobre `unidad_funcional u`, o un fragmento vacío si no hay nada que buscar.
 */

import { sql, type SQL } from "drizzle-orm";

/** El techo del texto que se busca: lo mismo que acepta el `?q=` de la pantalla. */
export const LARGO_MAXIMO_BUSQUEDA = 80;

export function condicionDeBusquedaDeUnidad(texto: string): SQL {
  const busqueda = texto.trim().slice(0, LARGO_MAXIMO_BUSQUEDA);
  if (busqueda === "") return sql``;
  const soloDigitos = busqueda.replace(/\D/g, "");
  // El código de pago se busca por su número: «000004-5» → 4 (sin el verificador).
  const numeroCodigo = /^\d+-?\d$/.test(busqueda.replace(/\s/g, "")) && soloDigitos.length > 1 ? Number(soloDigitos.slice(0, -1)) : null;

  return sql` and (
          (u.manzana || ' ' || u.lote) ilike ${`%${busqueda}%`}
          or ('mza ' || u.manzana || ' lote ' || u.lote) ilike ${`%${busqueda}%`}
          or (${numeroCodigo}::bigint is not null and u.codigo_pago_numero = ${numeroCodigo}::bigint)
          or exists (select 1 from unidad_obligado uo join obligado o on o.id = uo.obligado_id
                      where uo.unidad_funcional_id = u.id and uo.hasta is null
                        and (o.nombre ilike ${`%${busqueda}%`}
                             or (${soloDigitos} <> '' and length(${soloDigitos}) >= 6
                                 and (o.cuit_cuil like ${`%${soloDigitos}%`} or o.numero_documento like ${`%${soloDigitos}%`}))))
        )`;
}
