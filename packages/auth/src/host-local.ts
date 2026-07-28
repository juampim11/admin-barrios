/**
 * ¿El `Host` entrante es de esta máquina?
 *
 * **Esto es defensa en profundidad, NO un candado** (ADR-0002 §2.4, vuelta 2), y decirlo importa:
 * el `Host` lo manda el cliente. `curl -H 'Host: localhost' http://<ip>:4000/` llega a Next —el
 * `docker-compose.yml` publica el 4000 en todas las interfaces— y pasa este chequeo sin despeinarse.
 * Detrás de un proxy, `x-forwarded-host` es igual de falsificable, y por eso ni se mira.
 *
 * Lo que sí hace: sube el costo de un despliegue expuesto por accidente. Lo que **no** hay que
 * hacer es aflojar la vuelta 3 del candado —la tabla `usuario_demo` vacía, que es la única que
 * aguanta sola— creyendo que esta la respalda.
 *
 * **Por qué la normalización no es un `split(":")[0]`.** Con `Host: [::1]:4000` —que es lo que manda
 * un navegador cuando el servidor escucha en IPv6, y el caso cotidiano de `next dev` en Windows— un
 * `split(":")[0]` devuelve `"["`. El chequeo fallaría y nadie podría entrar en su propia máquina,
 * que es la forma más rápida de que alguien lo saque del medio.
 */

/** Los tres nombres que significan "esta máquina". Lista de permitidos, no de prohibidos. */
const HOSTS_LOCALES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

export function esHostLocal(host: string | null | undefined): boolean {
  if (!host) return false;
  const limpio = host.trim().toLowerCase();
  if (limpio.length === 0) return false;

  let nombre: string;

  if (limpio.startsWith("[")) {
    // Forma IPv6 literal: `[::1]` o `[::1]:4000`. Todo lo que venga después del `]` solo puede ser
    // un puerto; cualquier otra cosa es un Host malformado y se rechaza en vez de interpretarse.
    const cierre = limpio.indexOf("]");
    if (cierre < 1) return false;
    const resto = limpio.slice(cierre + 1);
    if (resto !== "" && !/^:\d+$/.test(resto)) return false;
    nombre = limpio.slice(1, cierre);
  } else {
    const partes = limpio.split(":");
    // Más de dos partes = una IPv6 sin corchetes, que no es un `Host` válido (RFC 3986 §3.2.2).
    // Se rechaza en vez de adivinar: adivinar acá es exactamente de dónde salen los bypass.
    if (partes.length > 2) return false;
    nombre = partes[0] ?? "";
    const puerto = partes[1];
    if (puerto !== undefined && !/^\d+$/.test(puerto)) return false;
  }

  return HOSTS_LOCALES.has(nombre);
}
