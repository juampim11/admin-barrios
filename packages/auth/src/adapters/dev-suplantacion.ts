/**
 * Sustituto de desarrollo: **suplantación desde el elenco de la demo** (ADR-0002 §2.3).
 *
 * Deja entrar sin autenticación real eligiendo con qué usuario, de una lista que sale de la tabla
 * `usuario_demo` **y de ningún otro lado**. Es un andamio, no autenticación, y todo el archivo está
 * escrito para que eso se vea.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * QUÉ IMPIDE QUE ESTO LLEGUE A PRODUCCIÓN, EN ORDEN DE CUÁNTO AGUANTA
 *
 *  · **La tabla vacía (el único candado que aguanta solo).** `usuario_demo` la escribe únicamente el
 *    dueño del esquema, o sea el seed, y el seed se niega a correr con `APP_ENTORNO <> "local"`. En
 *    producción no hay a quién suplantar, así que `iniciarSesion` y `sesionDe` no emiten identidad
 *    ni aunque alguien habilite el adapter. Falla cerrado **por datos**, no por configuración.
 *    Además se revalida en CADA request: vaciar la tabla invalida todas las sesiones en el acto.
 *  · **La fábrica** (`../registro.ts`) no lo instancia si `APP_ENTORNO !== "local"`. Es un gate de
 *    configuración: vale lo que valga esa variable, y por eso es obligatoria y sin default.
 *  · **El `Host`** tiene que ser local. Defensa en profundidad; se rodea con un header. Ver
 *    `../host-local.ts`.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LA COOKIE NO ESTÁ FIRMADA, Y ES A PROPÓSITO
 *
 * Es un uuid en claro. Firmarla daría la ilusión de ser un mecanismo de seguridad, y no lo es:
 * cualquiera que alcance la app la puede poner a mano sin pasar por la pantalla de entrada — por eso
 * `iniciarSesion()` hace **los mismos** chequeos que `sesionDe()` y no confía en haber sido llamada.
 * Que se vea que no protege nada forma parte del diseño.
 *
 * La cookie del adapter de producción no se parece a esta y este archivo no es su plantilla: allá va
 * con prefijo `__Host-`, `secure`, y un vencimiento de verdad.
 */

import { idSchema } from "@admin-barrios/shared/consultas";
import type {
  AuthProvider,
  Credenciales,
  EntradaHttp,
  Identidad,
  InstruccionCookie,
  ResultadoInicio,
  Sesion,
} from "../auth-provider.ts";
import { esHostLocal } from "../host-local.ts";

export const CLAVE_DEV_SUPLANTACION = "dev-suplantacion";

/**
 * Sin prefijo `__Host-`: ese prefijo exige `secure`, y en `http://localhost` no hay TLS. Ponerlo
 * haría que el navegador descarte la cookie en silencio y nadie pudiera entrar en su propia máquina.
 */
export const COOKIE_SESION_DEV = "ab_dev_usuario";

/**
 * El `expiraEn` de esta sesión es una constante y **no vence de verdad**: la cookie no lleva marca
 * de emisión ni firma, así que no hay nada que verificar. El vencimiento efectivo es propiedad del
 * adapter de producción; este valor existe para que `conSesion()` —que rechaza lo vencido **en la
 * puerta**— tenga contra qué comparar, y para que el contrato quede ejercitado desde el día uno.
 */
const VIGENCIA_SEGUNDOS = 12 * 60 * 60;

/** Lo mínimo que el adapter necesita de la capa de datos, inyectado: acá no se importa `pg`. */
export type UsuarioDelElenco = {
  readonly usuarioId: string;
  readonly email: string;
  readonly nombre: string;
};

export type DependenciasDevSuplantacion = {
  /**
   * Busca en `usuario_demo`. La implementa `apps/web` con la conexión de request **sin identidad**
   * (`sinUsuario`), nunca con la conexión `BYPASSRLS` — ADR-0002 §2.3.
   */
  readonly buscarUsuarioDemo: (usuarioId: string) => Promise<UsuarioDelElenco | null>;
  /** Inyectable para los tests; en producción no existe este adapter. */
  readonly ahora?: () => Date;
};

/**
 * Un solo motivo de rechazo para todos los caminos.
 *
 * No es pereza: distinguir "ese uuid no está en el elenco" de "no atiendo desde ese Host" convierte
 * al formulario de entrada en un oráculo que enumera el elenco. Cuesta cero y evita la costumbre.
 */
const MOTIVO_UNICO = "no se puede iniciar sesión con esos datos";

function cookieDeSesion(valor: string, maxEdad: number): InstruccionCookie {
  return {
    nombre: COOKIE_SESION_DEV,
    valor,
    httpOnly: true,
    // `secure: false` porque el único origen donde este adapter atiende es `http://localhost`.
    // No es un descuido: con `secure: true` el navegador no manda la cookie y nada funciona.
    secure: false,
    sameSite: "lax",
    path: "/",
    maxEdad,
  };
}

const identidadDe = (u: UsuarioDelElenco): Identidad => ({
  usuarioId: u.usuarioId,
  email: u.email,
  nombre: u.nombre,
});

export function crearAuthDevSuplantacion(deps: DependenciasDevSuplantacion): AuthProvider {
  const ahora = deps.ahora ?? (() => new Date());

  /** El uuid del elenco, o `null`. Es el mismo camino en los dos métodos públicos, a propósito. */
  async function resolver(entrada: EntradaHttp, usuarioId: string | undefined): Promise<UsuarioDelElenco | null> {
    if (!esHostLocal(entrada.headers.get("host"))) return null;

    // El valor viene del cliente y termina en `set_config('app.user_id', …)`. `conUsuario()` ya
    // rechaza lo que no sea uuid, pero validarlo acá convierte "cookie basura" en "no hay sesión",
    // que es lo que la pantalla necesita, en vez de en una excepción a mitad del request.
    const id = idSchema.safeParse(usuarioId);
    if (!id.success) return null;

    return deps.buscarUsuarioDemo(id.data);
  }

  return {
    clave: CLAVE_DEV_SUPLANTACION,
    aptoParaProduccion: false,

    async sesionDe(entrada: EntradaHttp): Promise<Sesion | null> {
      const usuario = await resolver(entrada, entrada.cookies.get(COOKIE_SESION_DEV));
      if (!usuario) return null;
      return {
        identidad: identidadDe(usuario),
        expiraEn: new Date(ahora().getTime() + VIGENCIA_SEGUNDOS * 1000),
        origen: CLAVE_DEV_SUPLANTACION,
      };
    },

    async iniciarSesion(credenciales: Credenciales): Promise<ResultadoInicio> {
      if (credenciales.tipo !== "suplantacion") return { ok: false, motivo: MOTIVO_UNICO };

      // No se confía en el uuid que manda el navegador: tiene que estar en el elenco. Y se repite el
      // chequeo de `Host`, porque la cookie se puede poner a mano sin pasar por acá y la simetría es
      // lo que hace que este método no sea la puerta floja.
      const usuario = await resolver(credenciales.entrada, credenciales.usuarioId);
      if (!usuario) return { ok: false, motivo: MOTIVO_UNICO };

      return {
        ok: true,
        identidad: identidadDe(usuario),
        cookie: cookieDeSesion(usuario.usuarioId, VIGENCIA_SEGUNDOS),
      };
    },

    async cerrarSesion(): Promise<InstruccionCookie> {
      return cookieDeSesion("", 0);
    },
  };
}
