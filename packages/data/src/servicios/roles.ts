/**
 * Quién puede **emitir** documentos del padrón, y quién puede **registrar pagos** — una sola
 * definición para cada operación, y su fragmento SQL.
 *
 * El conjunto de emisión existía dos veces: en `vista-boleta.ts` y en `periodos.ts`, cada una con su
 * propio `sql.raw`, y cada una con un comentario que decía "el mismo conjunto que la otra, no se
 * define dos veces distinto". Dos copias de una regla que solo vale si son idénticas es exactamente
 * lo que hay que extraer: el día que alguien agregue un rol en un lado, la pantalla va a ofrecer el
 * botón y la emisión va a rechazarlo, o al revés.
 *
 * **Por qué esta autorización es aparte de la RLS.** `app.readable_tenant_ids()` decide quién puede
 * *leer* las filas de un barrio, y ahí entran también `contador` y `auditor`. Emitir los documentos
 * del padrón —o registrar un pago— es otra cosa: es una autorización sobre una **operación**, no
 * sobre filas —"puede leer la fila X" no es "puede exportar las N filas como documentos" ni "puede
 * escribir un cobro nuevo"—, y la RLS no expresa esa diferencia. Por eso el gate es explícito.
 *
 * **`ROLES_QUE_REGISTRAN_PAGO` coincide hoy, letra por letra, con `ROLES_QUE_EMITEN`.** Son dos
 * constantes igual de aposta: son dos operaciones distintas —emitir el padrón entero en PDF no es
 * cargar un cobro— que HOY autorizan el mismo conjunto de roles, y que el día de mañana pueden
 * divergir sin que tocar una le cambie el comportamiento a la otra. Es el mismo criterio que ya usan,
 * repetidas, las tres policies de `pago` en `0034_pagos_reglas.sql` (`pago_ins`/`pago_upd`) — acá se
 * junta en una sola definición para que el servicio (`listarSaldosUF`, en `cobros.ts`) no vuelva a
 * escribir el array a mano.
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

/**
 * Roles que pueden registrar (y anular) pagos — el mismo conjunto que las policies `pago_ins` /
 * `pago_upd` de `0034_pagos_reglas.sql`. Ver el docstring de arriba sobre por qué es una constante
 * propia y no un alias de `ROLES_QUE_EMITEN`.
 */
export const ROLES_QUE_REGISTRAN_PAGO = [
  "admin_plataforma",
  "admin_barrio",
  "operador",
] as const satisfies readonly RolMembership[];

/** El mismo conjunto como literal de array de Postgres. Ver `SQL_ROLES_QUE_EMITEN`, arriba. */
export const SQL_ROLES_QUE_REGISTRAN_PAGO = sql.raw(
  `array[${ROLES_QUE_REGISTRAN_PAGO.map((r) => `'${r}'`).join(",")}]::app.rol_membership[]`,
);
