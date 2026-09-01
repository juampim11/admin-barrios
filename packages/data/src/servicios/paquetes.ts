/**
 * El **paquete de distribución**: el ZIP con las boletas de un período, y su manifiesto.
 *
 * Este servicio no arma el archivo —eso es del worker, que es quien puede leer objetos del storage—:
 * registra qué se empaquetó y resuelve su descarga.
 *
 * **Lo que hace distinto a un paquete de un documento emitido, y explica todo lo de abajo:** es un
 * artefacto **derivado**. Se reconstruye de sus partes, así que puede quedar *superado* —si después
 * se emite una boleta más, el ZIP viejo está incompleto— y esa es una noción que `documento_emitido`
 * deliberadamente no tiene. De ahí que exista `boletasFaltantesDelPaquete()`.
 */

import { sql } from "drizzle-orm";
import { consultaPeriodoSchema, idSchema } from "@admin-barrios/shared/consultas";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";
import { registrarDescarga, type DescargaPreparada } from "./documentos.ts";

export type PaqueteRegistrado = {
  readonly id: string;
  readonly storageKey: string;
  readonly documentos: number;
};

/**
 * Registra el paquete y su manifiesto **en una sola transacción**.
 *
 * El manifiesto no es decorativo: es lo que permite contestar después *"¿este ZIP tiene todas las
 * boletas que hoy existen?"*. Guardarlo como una lista de FKs y no como un `jsonb` es lo que hace
 * que esa pregunta sea una consulta y no una interpretación.
 *
 * `barrio_id` y `armado_por` **no viajan en el insert**: los escribe la base (`0053`).
 */
export async function registrarPaquete(
  tx: DbConIdentidad,
  entrada: {
    readonly periodoId: string;
    readonly storageKey: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly documentoIds: readonly string[];
  },
): Promise<PaqueteRegistrado> {
  const { periodoId } = consultaPeriodoSchema.parse({ periodoId: entrada.periodoId });
  for (const id of entrada.documentoIds) idSchema.parse(id);

  if (entrada.documentoIds.length === 0) {
    // Un ZIP vacío es un archivo que miente: dice que el período se empaquetó y no contiene nada.
    rechazar(
      "periodo_incompleto",
      "No hay boletas emitidas para empaquetar.",
      "Generá los documentos del período antes de armar el paquete.",
    );
  }

  return enBase(async () => {
    /*
     * `barrio_id` y `armado_por` **se omiten del insert a propósito**: son `not null`, pero el
     * trigger `before insert` los escribe desde `app.current_user_id()` y desde el período, y la
     * validación de `not null` corre después del trigger. Pasarlos desde acá sería dejar que el
     * llamador declare de qué barrio es la fila y quién la armó — que es exactamente lo que el
     * trigger existe para impedir.
     */
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into paquete_distribucion (periodo_id, storage_key, sha256, bytes)
      values (${periodoId}, ${entrada.storageKey}, ${entrada.sha256}, ${entrada.bytes})
      returning id
    `);

    const paqueteId = rows[0]?.id;
    if (!paqueteId) {
      rechazar("desconocido", "No se pudo registrar el paquete.", "Reintentá en unos minutos.");
    }

    /*
     * El manifiesto en **un solo viaje**, con las N tuplas parametrizadas: 510 inserts de a uno
     * adentro de la misma transacción es justo lo que `db.ts` pide no hacer.
     *
     * `sql.join` sobre valores parametrizados y **no** una interpolación de los ids en el texto:
     * aunque acá vengan de la propia base, armar SQL concatenando identificadores es el hábito que
     * después se aplica a un id que vino de afuera.
     */
    const tuplas = sql.join(
      entrada.documentoIds.map((id) => sql`(${paqueteId}, ${id})`),
      sql`, `,
    );
    await tx.execute(sql`
      insert into paquete_distribucion_item (paquete_id, documento_id) values ${tuplas}
    `);

    return { id: paqueteId, storageKey: entrada.storageKey, documentos: entrada.documentoIds.length };
  });
}

/**
 * Las boletas del período que **no** están en el último paquete.
 *
 * Es la pregunta que solo tiene sentido en un artefacto derivado: si devuelve algo, el ZIP que el
 * administrador tiene en la mano ya no representa al período, y la pantalla puede decirlo en vez de
 * ofrecer una descarga que miente por omisión.
 */
export async function boletasFaltantesDelPaquete(
  tx: DbConIdentidad,
  parametros: { readonly periodoId: string },
): Promise<number> {
  const { periodoId } = consultaPeriodoSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<{ faltantes: string }>(sql`
      with ultimo as (
        select id from paquete_distribucion
         where periodo_id = ${periodoId}
         order by armado_at desc limit 1
      )
      select count(*)::text as faltantes
        from documento_emitido d
       where d.periodo_id = ${periodoId}
         and d.tipo = 'boleta_unidad'
         and not exists (
           select 1 from paquete_distribucion_item i
            where i.documento_id = d.id and i.paquete_id = (select id from ultimo)
         )
         and exists (select 1 from ultimo)
    `);
    return Number.parseInt(rows[0]?.faltantes ?? "0", 10);
  });
}

/**
 * Prepara la descarga del último paquete de un período.
 *
 * **Registra la acuñación ANTES de que exista la URL**, en la misma transacción que leyó la fila
 * bajo RLS — mismo principio que el resto de las descargas del sistema: si el registro falla, no hay
 * URL. Y la ruta recibe un `periodoId`, nunca una `storageKey`: la credencial que firma alcanza al
 * bucket entero, así que lo único que separa este ZIP de todos los ZIP es que la clave haya salido
 * de una fila leída bajo RLS en esta misma request.
 */
export async function prepararDescargaDePaquete(
  tx: DbConIdentidad,
  parametros: { readonly periodoId: string; readonly ttlSegundos: number },
): Promise<DescargaPreparada> {
  const { periodoId } = consultaPeriodoSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string; storage_key: string; periodo: string }>(sql`
      select p.id, p.storage_key, pe.periodo
        from paquete_distribucion p
        join periodo_expensa pe on pe.id = p.periodo_id
       where p.periodo_id = ${periodoId}
       order by p.armado_at desc
       limit 1
    `);

    const paquete = rows[0];
    if (!paquete) {
      // "No existe" y "no es tuyo" salen iguales: distinguirlos convertiría esto en un oráculo.
      rechazar(
        "documento_no_encontrado",
        "No encontramos el paquete de este período.",
        "Armá el paquete desde la pantalla de distribución.",
      );
    }

    await registrarDescarga(tx, { paqueteId: paquete.id, ttlSegundos: parametros.ttlSegundos });

    return {
      storageKey: paquete.storage_key,
      nombreArchivo: `Liquidaciones-${paquete.periodo}.zip`,
    };
  });
}
