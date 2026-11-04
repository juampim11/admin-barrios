/**
 * El orden de las unidades en toda lista y exportación: **natural** (encargo 10, BL-030 d).
 *
 * Manzana y lote como números —el lote 10 va después del 9, no entre el 1 y el 2— y, a igual número,
 * por el texto («12A» antes que «12B»). Las manzanas con letra («A», «B») van después de las
 * numéricas, ordenadas entre sí. Es la expresión que ya usaban el padrón (`padron-edicion.ts`), el
 * código de pago al numerar las unidades (`0059`) y el ZIP de boletas del worker, puesta en un solo
 * lugar para que las demás listas no vuelvan al orden alfabético.
 *
 * ⚠ **No se usa en el reparto** (`liquidacion.ts`, las unidades que se prorratean): ahí el orden decide
 * a qué unidad va el resto de los centavos, y cambiarlo cambiaría quién paga ese centavo. Eso es el
 * motor de plata y no se toca por una cuestión de presentación.
 *
 * Interno al paquete. Recibe las dos columnas (con su alias) y devuelve el fragmento para un `order by`.
 */

import { sql, type SQL } from "drizzle-orm";

export function ordenNaturalDeUnidad(manzana: SQL, lote: SQL): SQL {
  return sql`nullif(regexp_replace(${manzana}, '[^0-9]', '', 'g'), '')::numeric nulls last, ${manzana} collate "C",
             nullif(regexp_replace(${lote}, '[^0-9]', '', 'g'), '')::numeric nulls last, ${lote} collate "C"`;
}

/** El orden natural sobre `u.manzana`/`u.lote`, el alias más común. */
export const ORDEN_NATURAL_U = ordenNaturalDeUnidad(sql`u.manzana`, sql`u.lote`);
