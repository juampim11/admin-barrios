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

/**
 * Un personaje del elenco, **ya decodificado**.
 *
 * `rol` y `alcance` no son dos columnas: son las dos mitades de `descripcion`, que es la única que la
 * tabla tiene para esto (ver `armarDescripcion` acá abajo). El servicio devuelve las piezas y no el
 * texto crudo a propósito: quien consume la lista —hoy la pantalla de entrada, en otro paquete— no
 * tiene por qué conocer el formato de datos de este.
 *
 * No hay más columnas que las cinco: ver el comentario de la migración 0019.
 */
export type UsuarioDemo = {
  readonly usuarioId: string;
  readonly email: string;
  readonly nombre: string;
  /** El rol, como etiqueta para mostrar. `null` cuando la descripción no lo trae — nunca se inventa. */
  readonly rol: string | null;
  /** Qué ve y qué no. */
  readonly alcance: string;
};

/**
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LA CONVENCIÓN DE `descripcion`, Y POR QUÉ VIVE ACÁ Y EN NINGÚN OTRO LADO
 *
 * `usuario_demo` tiene **cinco columnas y ni una más**, y eso es parte del diseño del candado: es la
 * única tabla del esquema con una policy `using (true)`, así que no puede crecer sin volver a
 * discutirse (ver el docblock de `../schema/usuario-demo.ts`). Un `rol` no entra ahí por una etiqueta
 * de pantalla. Entonces el rol viaja **dentro** del texto, con el formato `"Rol — qué ve y qué no"`.
 *
 * Eso está bien; lo que estaba mal era **dónde vivía el formato**: se escribía a mano en tres
 * literales del seed y se parseaba a mano en la pantalla, o sea existía tres veces como prosa y cero
 * veces como código, en dos paquetes distintos y sin un solo test. Estas dos funciones son ahora el
 * único dueño: el seed **arma** con `armarDescripcion` y el mapper de acá abajo **parte** con
 * `partirDescripcion`. Nadie más toca la cadena.
 *
 * **No se infiere nada.** Partir esto es formatear una cadena para mostrarla, no una regla de
 * negocio: el único lugar donde se decide algo con el rol sigue siendo la RLS, sobre `membership`.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * El separador: **raya** (U+2014) entre espacios, y nada más.
 *
 * Ni el guión común `-` ni el guión medio `–` cuentan, aunque a ojo se confundan. Es a propósito: un
 * separador ambiguo convierte cualquier alcance con un guión en un rol inventado. Si el texto no
 * trae exactamente esto, no hay rol y se muestra la línea entera — que es el modo de falla barato.
 */
const SEPARADOR = " — ";

/**
 * Arma la `descripcion` que se guarda en la tabla. Lo usa el seed, y es el **único** productor.
 *
 * Es total a propósito: si el rol o el alcance vienen vacíos, o si el rol trae la raya adentro —lo
 * que rompería el ida y vuelta—, el seed falla ruidosamente en vez de dejar una fila que la pantalla
 * va a mostrar mal, en silencio, delante de un cliente.
 */
export function armarDescripcion({
  rol,
  alcance,
}: {
  readonly rol: string;
  readonly alcance: string;
}): string {
  if (rol.trim() === "" || alcance.trim() === "") {
    throw new Error("[usuario_demo] la descripción necesita rol y alcance, y los dos con texto");
  }
  if (rol.includes(SEPARADOR)) {
    throw new Error(`[usuario_demo] el rol no puede contener el separador: ${rol}`);
  }
  return `${rol}${SEPARADOR}${alcance}`;
}

/**
 * Parte la `descripcion` en **rol** y **alcance**. Es la inversa exacta de `armarDescripcion`.
 *
 * **Media convención no es la convención**: si falta la raya, o si de un lado no queda texto (raya al
 * principio, raya al final, descripción vacía), no hay rol y el texto **entero** es el alcance. Nunca
 * se devuelve un rol vacío, porque la tarjeta lo tomaría por una etiqueta y pintaría un chip en
 * blanco. Corta en la **primera** raya: las que vengan después son parte del alcance.
 */
export function partirDescripcion(descripcion: string): {
  readonly rol: string | null;
  readonly alcance: string;
} {
  const corte = descripcion.indexOf(SEPARADOR);
  if (corte < 0) return { rol: null, alcance: descripcion };

  const rol = descripcion.slice(0, corte);
  const alcance = descripcion.slice(corte + SEPARADOR.length);
  if (rol === "" || alcance === "") return { rol: null, alcance: descripcion };

  return { rol, alcance };
}

type Fila = { user_id: string; email: string; nombre: string; descripcion: string };

const mapear = (f: Fila): UsuarioDemo => ({
  usuarioId: f.user_id,
  email: f.email,
  nombre: f.nombre,
  ...partirDescripcion(f.descripcion),
});

/**
 * El elenco completo, para la pantalla de entrada. En producción devuelve `[]` y la pantalla no
 * ofrece a nadie — que es el comportamiento correcto, no un error.
 *
 * Sin paginado a propósito: son un puñado de filas ficticias por definición. Si algún día no lo
 * fueran, el problema no sería el paginado.
 *
 * **El orden es el de carga, y es intencional.** Estaba `order by nombre`, que es tan arbitrario como
 * cualquier otro criterio alfabético y ponía último a quien decide la compra. En una demostración la
 * primera fila de la lista es la que se elige: el orden lo fija quien arma el elenco, escribiéndolo
 * en el orden en que quiere que se ofrezca, y esta consulta lo respeta. `nombre` queda de desempate
 * para que dos filas cargadas en el mismo instante no salgan en orden indefinido.
 */
export async function listarUsuariosDemo(tx: DbConIdentidad): Promise<UsuarioDemo[]> {
  const { rows } = await tx.execute<Fila>(sql`
    select user_id, email, nombre, descripcion
      from usuario_demo
     order by creado_at, nombre
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
