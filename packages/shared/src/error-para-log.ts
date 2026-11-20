/**
 * Cómo se escribe un error en un log sin llevarse los datos de la conexión.
 *
 * **Por qué no `console.error(..., error)`.** Un error de `pg` (y de `net`) no es solo un mensaje: trae
 * propiedades de la conexión —`address`, `port`, y en el cliente de la base que lo emitió, `user`,
 * `password`, `host` y `database` dentro de `client.connectionParameters`—. `console.error` y
 * `util.inspect` las imprimen todas: una caída de la base dejaba la contraseña del rol en el log del
 * worker y de la web (S5, visto al correr el test sin el oyente). Un log es un almacén que se envía a otro
 * lado: no puede llevar credenciales.
 *
 * Esta función devuelve **una línea** con `nombre: mensaje (código)` y, si se pide, la pila, y en ese
 * texto reemplaza lo que identifica la base: las URLs de conexión, las direcciones IPv4 (con su puerto) y
 * los valores `address`, `host`, `hostname`, `user`, `password`, `database` y `port` que traiga el propio
 * error. Sigue los `errors` de un `AggregateError` (Node prueba IPv6 e IPv4 y falla con uno solo) y la
 * `cause`.
 *
 * No es un anonimizador general: un mensaje de Postgres puede nombrar una tabla o un valor
 * (`errores.ts` los trata aparte). Lo que garantiza es lo de la conexión.
 */

const DATOS_DE_CONEXION = ["address", "host", "hostname", "user", "password", "database", "dest"] as const;

type ConDatos = Record<string, unknown> & { code?: unknown; port?: unknown; errors?: unknown; cause?: unknown };

/** Reemplaza lo que identifica la base en `texto`, usando también los valores que el propio error trae. */
function limpiar(texto: string, e: ConDatos): string {
  let t = texto;
  // Primero los valores exactos que trae el error (`10.9.8.7`, `app_job`, la contraseña…).
  for (const clave of DATOS_DE_CONEXION) {
    const v = e[clave];
    if (typeof v === "string" && v.length >= 3) t = t.split(v).join("«…»");
  }
  const puerto = typeof e.port === "number" || typeof e.port === "string" ? String(e.port) : null;
  if (puerto !== null && puerto.length >= 2) t = t.split(`:${puerto}`).join(":«puerto»");
  return limpiarParaLog(t);
}

/**
 * Lo genérico, sin el error a mano: URLs de conexión, direcciones IPv4 e IPv6, los altnames de un certificado
 * TLS y los nombres que el **servidor** de Postgres pone en sus mensajes de autenticación y de acceso
 * (`password authentication failed for user "app_job"`, `database "x" does not exist`, `no pg_hba.conf
 * entry for host "h", user "u"…`), que el objeto de error no trae como propiedad.
 */
export function limpiarParaLog(texto: string): string {
  return texto
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "«url»")
    .replace(/\b(user|role|database|host)\s+"[^"]*"/gi, '$1 "«…»"')
    .replace(/\b(user|role|database|host)\s+'[^']*'/gi, "$1 '«…»'")
    .replace(/\bDNS:\S+/g, "DNS:«…»")
    .replace(/\[[0-9a-f:]{2,}\](?::\d+)?/gi, "«dirección»")
    // IPv6 sin corchetes: un tramo de hexadecimales y dos puntos con «::» o muchos «:» (una hora, 10:30:45, no).
    .replace(/[0-9a-f:]{3,}/gi, (m) => (m.includes("::") || m.split(":").length > 5 ? "«dirección»" : m))
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "«dirección»");
}

function una(e: unknown, pila: boolean, profundidad: number): string {
  if (!(e instanceof Error)) {
    return typeof e === "string" ? limpiarParaLog(e) : `(valor que no es un Error: ${typeof e})`;
  }
  const d = e as unknown as ConDatos;
  const codigo = typeof d.code === "string" || typeof d.code === "number" ? ` (${String(d.code)})` : "";
  const base = limpiar(pila && e.stack ? e.stack : `${e.name}: ${e.message}`, d) + codigo;
  if (profundidad >= 3) return base;
  const hijos: string[] = [];
  if (Array.isArray(d.errors)) for (const h of d.errors) hijos.push(una(h, false, profundidad + 1));
  if (d.cause !== undefined && d.cause !== null) hijos.push(`causa: ${una(d.cause, false, profundidad + 1)}`);
  return hijos.length === 0 ? base : `${base} [${hijos.join(" | ")}]`;
}

/** Una línea para el log, sin datos de conexión. `pila: true` agrega la pila (sin credenciales). */
export function describirErrorParaLog(e: unknown, opciones: { readonly pila?: boolean } = {}): string {
  return una(e, opciones.pila === true, 0);
}
