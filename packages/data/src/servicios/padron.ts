/**
 * El padrón del barrio: unidades funcionales con sus obligados vigentes y su coeficiente.
 *
 * Es **la consulta más sensible del incremento**, por dos motivos distintos que conviene no
 * mezclar:
 *
 * **PII.** Cada fila trae nombre, documento, email y teléfono de una persona real. Que solo la vea
 * quien corresponde no lo decide este archivo: lo decide `app.readable_tenant_ids()` (migración
 * 0018), que exige un rol de **gestión**. Una membresía `propietario` no lee ni una fila —ni la
 * suya—, y eso es deliberado hasta que exista el vínculo usuario → unidad (ADR-0002 §3.5). Lo que
 * este archivo sí hace es no ampliar la superficie: no expone columnas que la pantalla no use, y
 * pagina, para que "ver el padrón" no sea "descargar el padrón".
 *
 * **Ancho.** ~200 unidades es lo típico, pero el producto es multi-cliente y multi-barrio: nada
 * impide 3.000. Por eso son **tres consultas contadas** —total, unidades, obligados de esas
 * unidades— y el agrupado se hace en memoria, igual que en `vista-boleta.ts`. Nunca una consulta de
 * obligados por unidad: con 200 unidades eso serían 201 viajes a la base, cada uno pagando la
 * evaluación de las policies.
 *
 * Índices que sostienen esto, todos preexistentes: `idx_uf_barrio_activas` (el `where` del listado),
 * `uq_coeficiente_version_uf` y `uq_coef_version_vigente` (el coeficiente vigente),
 * `idx_unidad_obligado_uf` (los obligados por unidad). No se agrega ninguno: la regla es medir antes
 * de indexar.
 *
 * ⚠ **El orden es lexicográfico, no numérico**: `manzana`/`lote` son `text` (la IPJ los exige
 * estructurados, y hay barrios con lotes tipo `"12 bis"`), así que el padrón sale `1, 10, 2, …`. Se
 * deja así **a propósito**: es exactamente el orden que usa `armarVistasDelPeriodo()` para recorrer
 * el lote de boletas y el que usa `listarLiquidaciones()`. Ordenar "lindo" acá y no allá haría que
 * la fila N de la pantalla no fuera la boleta N del PDF, que es peor que el orden feo. Si se quiere
 * arreglar, se arregla **en los tres a la vez** —con una clave de ordenamiento natural calculada, no
 * con un `sort` en el cliente— y queda anotado como tal.
 */

import { sql } from "drizzle-orm";
import { consultaPadronSchema, type ConsultaPadron } from "@admin-barrios/shared/consultas";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import type { DbConIdentidad } from "../client.ts";

/**
 * Quién responde por la unidad. Puede haber **varios a la vez** —propietario y poseedor— y el
 * propietario no se libera porque exista un poseedor (art. 2050): por eso es una lista, no un campo.
 */
export type ObligadoDeUnidad = {
  readonly id: string;
  readonly nombre: string;
  readonly esPersonaJuridica: boolean;
  readonly tipoDocumento: string | null;
  readonly numeroDocumento: string | null;
  readonly cuitCuil: string | null;
  readonly email: string | null;
  readonly telefono: string | null;
  /** `propietario` · `poseedor` · `usufructuario` … */
  readonly tipo: string;
  readonly desde: string;
  /** A este le llega la liquidación. Hay uno solo por unidad (`uq_unidad_notificado`). */
  readonly esNotificado: boolean;
};

export type UnidadDelPadron = {
  readonly id: string;
  readonly manzana: string;
  readonly lote: string;
  readonly etiqueta: string;
  readonly estadoUnidad: string;
  readonly nomenclaturaCatastral: string | null;
  /** `numeric` leído como **string**: nunca `Number()` sobre una superficie que pondera un reparto. */
  readonly superficieM2: string | null;
  /**
   * Coeficiente de la versión **cerrada y vigente**, con sus 9 decimales. `null` = el barrio todavía
   * no tiene versión cerrada, o esta unidad quedó fuera de ella. No se rellena con `"0"`: un cero
   * fabricado se lee como "no paga nada".
   */
  readonly coeficiente: string | null;
  readonly dadaDeBaja: boolean;
  readonly obligados: readonly ObligadoDeUnidad[];
};

export type Padron = {
  readonly unidades: readonly UnidadDelPadron[];
  /** Total de unidades que matchean el filtro, más allá de la página devuelta. */
  readonly total: number;
  readonly limite: number;
  readonly desplazamiento: number;
};

type FilaUnidad = {
  id: string;
  manzana: string;
  lote: string;
  estado_unidad: string;
  nomenclatura_catastral: string | null;
  superficie_m2: string | null;
  coeficiente: string | null;
  dada_de_baja: boolean;
};

type FilaObligado = {
  unidad_funcional_id: string;
  id: string;
  nombre: string;
  es_persona_juridica: boolean;
  tipo_documento: string | null;
  numero_documento: string | null;
  cuit_cuil: string | null;
  email: string | null;
  telefono: string | null;
  tipo: string;
  desde: string;
  es_notificado: boolean;
};

/**
 * El padrón de un barrio, paginado.
 *
 * El `barrioId` **no autoriza**: dice qué barrio mirar. Si el usuario no lo puede leer, la RLS
 * devuelve cero filas y esto sale `{ unidades: [], total: 0 }` — el mismo resultado que un barrio
 * vacío, a propósito (ADR-0002 §3.4).
 */
export async function listarPadron(
  tx: DbConIdentidad,
  parametros: Partial<ConsultaPadron> & { barrioId: string },
): Promise<Padron> {
  const { barrioId, limite, desplazamiento, incluirBajas } = consultaPadronSchema.parse(parametros);

  // `where` idéntico en las dos consultas: si divergen, el total deja de corresponder a la lista.
  const filtroBajas = incluirBajas ? sql`` : sql` and u.baja_at is null`;

  const total = (
    await tx.execute<{ n: number }>(sql`
      select count(*)::int as n
        from unidad_funcional u
       where u.barrio_id = ${barrioId}${filtroBajas}
    `)
  ).rows[0]?.n;

  const unidades = (
    await tx.execute<FilaUnidad>(sql`
      select u.id, u.manzana, u.lote,
             u.estado_unidad::text as estado_unidad,
             u.nomenclatura_catastral,
             u.superficie_m2::text,
             c.valor::text as coeficiente,
             (u.baja_at is not null) as dada_de_baja
        from unidad_funcional u
        left join coeficiente_version cv
               on cv.barrio_id = u.barrio_id and cv.cerrada and cv.vigente_hasta is null
        left join coeficiente c
               on c.version_id = cv.id and c.unidad_funcional_id = u.id
       where u.barrio_id = ${barrioId}${filtroBajas}
       order by u.manzana, u.lote
       limit ${limite} offset ${desplazamiento}
    `)
  ).rows;

  if (unidades.length === 0) {
    return { unidades: [], total: total ?? 0, limite, desplazamiento };
  }

  // Una sola consulta para los obligados de TODA la página. El `any(...)` va con `sql.param`: un
  // array pelado en el template de Drizzle se aplana en un parámetro por elemento y Postgres recibe
  // un uuid donde esperaba un array (mismo detalle que en `vista-boleta.ts`).
  const ids = unidades.map((u) => u.id);
  const obligados = (
    await tx.execute<FilaObligado>(sql`
      select uo.unidad_funcional_id,
             o.id, o.nombre, o.es_persona_juridica, o.tipo_documento, o.numero_documento,
             o.cuit_cuil, o.email, o.telefono,
             uo.tipo::text as tipo, uo.desde::text, uo.es_notificado
        from unidad_obligado uo
        join obligado o on o.id = uo.obligado_id
       where uo.unidad_funcional_id = any(${sql.param(ids)}::uuid[])
         and uo.hasta is null
       order by uo.es_notificado desc, o.nombre
    `)
  ).rows;

  const porUnidad = new Map<string, ObligadoDeUnidad[]>();
  for (const o of obligados) {
    const lista = porUnidad.get(o.unidad_funcional_id) ?? [];
    lista.push({
      id: o.id,
      nombre: o.nombre,
      esPersonaJuridica: o.es_persona_juridica,
      tipoDocumento: o.tipo_documento,
      numeroDocumento: o.numero_documento,
      cuitCuil: o.cuit_cuil,
      email: o.email,
      telefono: o.telefono,
      tipo: o.tipo,
      desde: o.desde,
      esNotificado: o.es_notificado,
    });
    porUnidad.set(o.unidad_funcional_id, lista);
  }

  return {
    unidades: unidades.map((u) => ({
      id: u.id,
      manzana: u.manzana,
      lote: u.lote,
      etiqueta: etiquetaUnidad(u.manzana, u.lote),
      estadoUnidad: u.estado_unidad,
      nomenclaturaCatastral: u.nomenclatura_catastral,
      superficieM2: u.superficie_m2,
      coeficiente: u.coeficiente,
      dadaDeBaja: u.dada_de_baja,
      obligados: porUnidad.get(u.id) ?? [],
    })),
    // `?? 0` igual que arriba, y no `?? unidades.length`: la rama es inalcanzable, pero devolver el
    // tamaño de la página como total del padrón haría que la paginación dijera "hay 500" cuando hay
    // 3.000. Un default que miente para conformar al tipo es peor que un cero evidente.
    total: total ?? 0,
    limite,
    desplazamiento,
  };
}
