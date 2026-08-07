/**
 * `usuario_demo` — el **elenco de la demo** (ADR-0002 §2.3).
 *
 * No es una tabla de usuarios. La tabla de usuarios de la plataforma **no existe todavía** y su
 * diseño está pendiente (ADR-0002 §2.5 punto 2): `membership.user_id` sigue siendo un `uuid` sin FK
 * a nada, a propósito, porque la identidad es de la capa de Auth.
 *
 * Lo que es: la lista cerrada de personas ficticias que el sustituto de desarrollo
 * (`dev-suplantacion`) deja elegir en la pantalla de entrada, y **el candado que aguanta solo** de
 * las cuatro vueltas del §2.4. La lógica es esta:
 *
 *   - la escribe **únicamente el dueño del esquema**, o sea el seed, que a su vez se niega a correr
 *     con `APP_ENTORNO <> "local"`;
 *   - `app_request` tiene `select` y nada más; `app_job` no tiene **ningún** grant sobre ella;
 *   - en producción, por lo tanto, está **vacía** — y un adapter que no tiene a quién suplantar no
 *     emite identidad, aunque alguien lo habilite por error.
 *
 * O sea: el candado deja de depender de la configuración y pasa a depender de los datos.
 *
 * **Cinco columnas y ni una más, y eso es parte del diseño.** Es la única tabla del esquema con una
 * policy `using (true)` —se lee SIN identidad, porque es la pantalla de entrada y todavía no hay
 * nadie—, así que no puede tener una sola columna que no sea del elenco ficticio. Las reglas y los
 * grants viven en `migrations/0019_usuario_demo.sql`, y hay un test del proyecto `db` que verifica
 * las tres cosas (policy única, columnas exactas, cero grants de escritura).
 */

import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const usuarioDemo = pgTable("usuario_demo", {
  /** El mismo uuid que va a `membership.user_id`, y el que termina en `app.user_id`. */
  userId: uuid("user_id").primaryKey(),
  email: text("email").notNull().unique(),
  nombre: text("nombre").notNull(),
  /** Para qué sirve este personaje: "admin del estudio", "operador de Los Álamos". */
  descripcion: text("descripcion").notNull(),
  creadoAt: timestamp("creado_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UsuarioDemoRow = typeof usuarioDemo.$inferSelect;
