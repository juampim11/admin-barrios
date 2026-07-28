/**
 * Lectura del elenco de la demo (`usuario_demo`, migración 0019).
 *
 * Son los **dos únicos servicios del sistema que corren sin identidad**, y por eso están solos en su
 * archivo en vez de mezclados con los demás: se los llama desde `conIngreso()` (ADR-0002 §3.1), que
 * es la única excepción a la puerta única, y esa excepción tiene que ser fácil de auditar de un
 * vistazo.
 *
 * Que "corran sin identidad" no significa que corran con privilegio: la conexión es la misma
 * `app_request` sujeta a RLS, sin `app.user_id` puesto. Lo único que pueden leer es lo que tenga una
 * policy `using (true)`, que hoy es esta tabla y nada más. Si mañana la tabla estuviera vacía
 * —producción—, devuelven la lista vacía y `null`: no hay a quién suplantar, que es exactamente el
 * candado del §2.4.
 *
 * La firma es la de siempre, `(tx: DbConIdentidad, …)`: el tipo dice "esta conexión PUEDE llevar una
 * identidad", no "la lleva". Nunca `DbJob`.
 */

import { sql } from "drizzle-orm";
import { idSchema } from "@admin-barrios/shared/consultas";
import type { DbConIdentidad } from "../client.ts";

/** Un personaje del elenco. No hay más columnas: ver el comentario de la migración 0019. */
export type UsuarioDemo = {
  readonly usuarioId: string;
  readonly email: string;
  readonly nombre: string;
  readonly descripcion: string;
};

type Fila = { user_id: string; email: string; nombre: string; descripcion: string };

const mapear = (f: Fila): UsuarioDemo => ({
  usuarioId: f.user_id,
  email: f.email,
  nombre: f.nombre,
  descripcion: f.descripcion,
});

/**
 * El elenco completo, para la pantalla de entrada. En producción devuelve `[]` y la pantalla no
 * ofrece a nadie — que es el comportamiento correcto, no un error.
 *
 * Sin paginado a propósito: son un puñado de filas ficticias por definición. Si algún día no lo
 * fueran, el problema no sería el paginado.
 */
export async function listarUsuariosDemo(tx: DbConIdentidad): Promise<UsuarioDemo[]> {
  const { rows } = await tx.execute<Fila>(sql`
    select user_id, email, nombre, descripcion
      from usuario_demo
     order by nombre
  `);
  return rows.map(mapear);
}

/**
 * Cuántos personajes hay. Existe para **una** cosa: la aserción de arranque de `apps/web`, que se
 * niega a atender si `APP_ENTORNO <> "local"` y esta tabla tiene filas (punto (d) de la migración
 * 0019). Es lo que convierte la vuelta 3 del candado de una suposición sobre el seed en algo que la
 * app comprueba.
 *
 * Es un servicio y no un `select` suelto en `apps/web` a propósito: así **ningún** archivo del app
 * necesita importar `drizzle-orm`, y la regla 1 del test de arquitectura no tiene ni una excepción.
 */
export async function contarUsuariosDemo(tx: DbConIdentidad): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`select count(*)::int as n from usuario_demo`);
  return rows[0]?.n ?? 0;
}

/**
 * Busca **un** personaje por su uuid. Es lo que el adapter llama en cada request para revalidar la
 * cookie: vaciar `usuario_demo` invalida todas las sesiones abiertas en el acto.
 *
 * El uuid viene de una cookie, o sea del cliente. Se valida con Zod antes de tocar la base: sin eso,
 * un valor cualquiera llega al `where` y Postgres devuelve un error de casteo en vez de un `null`
 * limpio. `safeParse` y no `parse` porque acá "no es un uuid" no es una excepción, es un "no".
 */
export async function buscarUsuarioDemo(tx: DbConIdentidad, usuarioId: string): Promise<UsuarioDemo | null> {
  const id = idSchema.safeParse(usuarioId);
  if (!id.success) return null;

  const { rows } = await tx.execute<Fila>(sql`
    select user_id, email, nombre, descripcion
      from usuario_demo
     where user_id = ${id.data}
  `);
  const fila = rows[0];
  return fila ? mapear(fila) : null;
}
