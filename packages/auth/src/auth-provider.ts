/**
 * `AuthProvider` — la interfaz de portabilidad de identidad (ADR-0000 §3.2, ADR-0002 §2.2).
 *
 * Contrato, no implementación. Este archivo no importa `pg`, ni `next`, ni el SDK de ningún
 * proveedor, y no puede: el día que se elija Supabase Auth / Cognito / GoTrue self-hosted, lo que se
 * escribe es un adapter más, no un cambio en el resto del sistema.
 *
 * Tres propiedades deliberadas, que son las que hacen que la superficie de acople sea chica:
 *
 * **1. Lo único que cruza el límite hacia los datos es un uuid.** Ningún servicio de negocio recibe
 * una `Sesion`, un token ni un `Request`: reciben `tx: DbConIdentidad`, que ya lleva la identidad
 * puesta por `conUsuario()`. Cambiar de proveedor de Auth cambia de dónde sale ese uuid, y nada más.
 *
 * **2. El rol NO viaja en la sesión.** El rol vive en `membership` y lo resuelve la base. Un token
 * que dijera "soy admin_barrio" sería una autorización que la base no verificó; y además el rol es
 * **por nodo** —alguien es `admin_barrio` en un barrio y `contador` en otro—, así que no cabe en un
 * claim. Si algún día aparece un campo `rol` en `Identidad`, es un bug de diseño, no una comodidad.
 *
 * **3. `aptoParaProduccion` es un campo del contrato, no un comentario.** Lo lee el candado de la
 * fábrica (`registro.ts`) y lo lee `apps/web` para decidir si existe la puerta de ingreso sin sesión.
 */

/** Lo único que el resto del sistema necesita saber de una persona. */
export type Identidad = {
  /** El uuid que va a `app.user_id` y que las policies ven en `app.current_user_id()`. */
  readonly usuarioId: string;
  readonly email: string | null;
  readonly nombre: string | null;
};

export type Sesion = {
  readonly identidad: Identidad;
  readonly expiraEn: Date;
  /** Clave del adapter que la emitió. Va a los logs: una sesión de desarrollo se ve como tal. */
  readonly origen: string;
};

/**
 * Entrada HTTP mínima. **No se recibe el `Request` de Next**: esta interfaz también la va a usar el
 * worker y, mañana, la app mobile — ninguno de los dos tiene un `Request` de Next.
 *
 * Las claves de `headers` van **en minúsculas**; quien arma la entrada normaliza.
 */
export type EntradaHttp = {
  readonly cookies: ReadonlyMap<string, string>;
  readonly headers: ReadonlyMap<string, string>;
};

/** Unión discriminada por adapter. Hoy hay una sola variante porque hay un solo adapter. */
export type Credenciales = {
  readonly tipo: "suplantacion";
  readonly usuarioId: string;
  /** La misma entrada que ve `sesionDe`: `iniciarSesion` hace los mismos chequeos de borde. */
  readonly entrada: EntradaHttp;
};

/**
 * Qué cookie hay que escribir o borrar. **El provider no toca el almacén de cookies de Next**: lo
 * describe y deja que el transporte lo aplique.
 *
 * Es una desviación consciente del boceto del ADR (que tenía `cerrarSesion(): Promise<void>`), y el
 * motivo es el mismo por el que `EntradaHttp` no es un `Request`: el worker y la mobile no tienen
 * `cookies()` de `next/headers`. Un provider que llamara a Next dejaría de ser portable en la
 * primera línea.
 */
export type InstruccionCookie = {
  readonly nombre: string;
  readonly valor: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: "lax" | "strict" | "none";
  readonly path: string;
  /** Segundos de vida. `0` = borrar. */
  readonly maxEdad: number;
};

export type ResultadoInicio =
  | { readonly ok: true; readonly cookie: InstruccionCookie; readonly identidad: Identidad }
  | { readonly ok: false; readonly motivo: string };

export type AuthProvider = {
  /** `"dev-suplantacion"` | `"supabase"` | `"cognito"` | `"gotrue"`. */
  readonly clave: string;
  /** ¿Sirve para producción? El sustituto de desarrollo devuelve `false` y nadie más. */
  readonly aptoParaProduccion: boolean;

  /** Lee la sesión de las cookies/headers entrantes. `null` = no hay sesión válida. */
  sesionDe(entrada: EntradaHttp): Promise<Sesion | null>;
  iniciarSesion(credenciales: Credenciales): Promise<ResultadoInicio>;
  /** Devuelve la cookie a expirar. No borra nada por su cuenta: ver `InstruccionCookie`. */
  cerrarSesion(): Promise<InstruccionCookie>;
};
