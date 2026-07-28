/**
 * Quién puede **emitir** documentos del padrón — una sola definición, y su fragmento SQL.
 *
 * Existía dos veces: en `vista-boleta.ts` y en `periodos.ts`, cada una con su propio `sql.raw`, y
 * cada una con un comentario que decía "el mismo conjunto que la otra, no se define dos veces
 * distinto". Dos copias de una regla que solo vale si son idénticas es exactamente lo que hay que
 * extraer: el día que alguien agregue un rol en un lado, la pantalla va a ofrecer el botón y la
 * emisión va a rechazarlo, o al revés.
 *
 * **Por qué esta autorización es aparte de la RLS.** `app.readable_tenant_ids()` decide quién puede
 * *leer* las filas de un barrio, y ahí entran también `contador` y `auditor`. Emitir los documentos
 * del padrón es otra cosa: es una autorización sobre una **operación**, no sobre filas —"puede leer
 * la fila X" no es "puede exportar las N filas como documentos, con el nombre del obligado de cada
 * unidad"—, y la RLS no expresa esa diferencia. Por eso el gate es explícito.
 */

import { sql } from "drizzle-orm";
import type { RolMembership } from "@admin-barrios/shared/tenancy";

/**
 * Roles de administración que pueden emitir. **No incluye `propietario` ni `residente`**: el día que
 * exista el portal del residente, ese camino tendrá que leer **su propia** liquidación, que es una
 * consulta distinta y no "el período entero en PDF".
 *
 * Tipado como `RolMembership[]` para que un valor que no sea un rol del enum no compile.
 */
export const ROLES_QUE_EMITEN = [
  "admin_plataforma",
  "admin_barrio",
  "operador",
] as const satisfies readonly RolMembership[];

/**
 * El mismo conjunto como literal de array de Postgres, listo para interpolar en un
 * `app.has_role_on(barrio_id, …)`.
 *
 * Va con `sql.raw` porque es un **literal de tipo**, no un parámetro: se arma desde la constante de
 * arriba y nunca desde entrada de usuario. Se construye una vez, al cargar el módulo.
 */
export const SQL_ROLES_QUE_EMITEN = sql.raw(
  `array[${ROLES_QUE_EMITEN.map((r) => `'${r}'`).join(",")}]::app.rol_membership[]`,
);
