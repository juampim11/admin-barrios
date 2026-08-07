import "server-only";

/**
 * **El único camino de `apps/web` a la base** (ADR-0002 §3).
 *
 * Un componente que consulte la base sin identidad es exactamente el agujero que todo el trabajo de
 * RLS de las veinte migraciones existe para evitar. Este archivo es el único del app que conoce el
 * pool, y hay cinco cerrojos —en cinco planos distintos— para que no se lo pueda rodear:
 *
 * **1. El compilador.** `packages/data/src/client.ts` marca los tipos (`DbRequest & { __rls:
 *    "sujeto" }`, `DbJob & { __rls: "bypass" }`) y `conUsuario()` **no acepta `DbJob`**. Ponerle una
 *    identidad a una conexión con `BYPASSRLS` —el error más caro posible, porque el código *se
 *    leería* aislado y no aislaría nada— no compila.
 *
 * **2. El grafo de imports, verificado en CI.** `apps/web/src/arquitectura.test.ts` falla si
 *    cualquier archivo de `apps/web/src` que no sea **este** importa `pg`, `drizzle-orm`,
 *    `@admin-barrios/data` (raíz), `/schema`, o `crearPoolJob` / `crearDbJob` /
 *    `crearDbMantenimiento` / `sinUsuario`. La web importa **solo** `@admin-barrios/data/servicios/*`.
 *
 * **3. `server-only`.** La primera línea de este archivo. Si un componente `"use client"` llega acá
 *    por cualquier camino, **el build de Next falla**. Es lo que impide la variante más silenciosa
 *    del bug: la conexión referenciada desde un bundle de navegador.
 *
 * **4. La base, que es la que decide de verdad.** `app_request` no tiene `BYPASSRLS`, todas las
 *    tablas tienen `FORCE ROW LEVEL SECURITY`, y sin `app.user_id` seteado `app.current_user_id()`
 *    devuelve `null` → cero filas. Los tres cerrojos de arriba están para que el error se vea en el
 *    editor o en CI; **este** está para que, si igual pasa, el resultado sea una pantalla vacía y no
 *    una fuga entre barrios.
 *
 * **5. El proceso no tiene la credencial.** Ver `configuracion.ts`. Es el único que sigue valiendo
 *    en runtime frente a algo que no escribimos nosotros.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LA REGLA DE USO, TAN IMPORTANTE COMO EL PATRÓN
 *
 * > **Adentro de `conSesion()` no se hace nada lento.** Ni `fetch`, ni `ObjectStorage`, ni
 * > renderizar, ni esperar a una persona. Una transacción abierta ocupa una conexión del pool y,
 * > con `FOR UPDATE`, una fila. El patrón es: **leer → cerrar la transacción → hacer el trabajo →
 * > abrir otra para escribir**.
 *
 * Con `max: 10`, diez operaciones que hicieran I/O lento adentro de la transacción congelan el pool
 * entero.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * `redirect()` Y `notFound()` FUNCIONAN LANZANDO. DOS CONSECUENCIAS CON DIENTES
 *
 * · **Nunca se llaman adentro del callback de `conSesion`.** El throw dispara el `ROLLBACK` y una
 *   escritura ya hecha se pierde en silencio, sin error y sin log. Se navega **después** de que la
 *   transacción cerró: por eso los servicios de lectura devuelven `null` en vez de lanzar, y el
 *   `notFound()` va en el `layout.tsx`, sobre el resultado que `conSesion` ya devolvió.
 * · **Nunca se los captura.** Un `catch` ancho alrededor de `conSesion` se traga el `NEXT_REDIRECT`
 *   que manda al login, y la sesión vencida se ve como "algo salió mal" en un formulario muerto. El
 *   `try` va alrededor de la llamada al **servicio**, nunca alrededor de `conSesion`.
 */

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import {
  conUsuario,
  crearDbRequest,
  crearPoolRequest,
  sinUsuario,
  verificarConexionSujetaARls,
  type DbRequest,
} from "@admin-barrios/data/client";
import { buscarUsuarioDemo, contarUsuariosDemo } from "@admin-barrios/data/servicios/usuarios-demo";
import {
  crearAuthProvider,
  esHostLocal,
  permiteIngresoSinSesion,
  type EntradaHttp,
  type InstruccionCookie,
  type ResultadoInicio,
  type Sesion,
} from "@admin-barrios/auth";
import { leerConfiguracion } from "./configuracion.ts";

/*
 * ⚠ **Nada de esto se construye al importar el módulo. Se construye en el primer request.**
 *
 * Estaban los cuatro como constantes de módulo, y eso **rompía `pnpm build`**: cuando Next junta los
 * datos de las páginas (`Collecting page data`) **importa** cada Route Handler, aunque esté marcado
 * `force-dynamic`, y con el import se ejecutaba `leerConfiguracion()`. El build no tiene —ni tiene
 * por qué tener— `DATABASE_URL_APP` ni `AUTH_PROVIDER`: compilar no es atender. El gate de CI corre
 * el build **a propósito sin ninguna URL de base**, así que lo cazaba, y quedó rojo desde el
 * 2026-07-28 con `Failed to collect page data for /api/trabajos/[trabajoId]`.
 *
 * **La verificación estricta NO se aflojó, se corrió de momento.** `leerConfiguracion()` sigue
 * lanzando ante configuración inválida o credenciales que no le tocan (ADR-0002 §3.2); lo que cambia
 * es que explota en el **primer request** en vez de en el import. En un proceso que atiende, la
 * diferencia son milisegundos: el primer request llega enseguida y falla igual de fuerte. Lo que se
 * gana es que **construir el artefacto deje de exigir las credenciales de producción**, que es
 * justamente lo que un build no debería poder tocar.
 *
 * Memorizado: se arma una sola vez por proceso, así que el pool sigue siendo el singleton que los
 * cinco cerrojos protegen.
 */
function construirRecursos() {
  const config = leerConfiguracion();

  /**
   * El pool es un singleton de proceso y **no se exporta**. Nadie más puede fabricar una conexión: no
   * porque esté prohibido por convención, sino porque `crearPoolRequest` solo se llama acá y el
   * cerrojo 2 falla si alguien lo importa en otro archivo.
   */
  const pool = crearPoolRequest({ url: config.urlBaseApp, maxConexiones: config.maxConexiones });

  /**
   * **Sin este listener, el proceso se cae entero.** `pg.Pool` emite `'error'` cuando una conexión
   * **ociosa** se rompe —la base se reinicia, un firewall corta la sesión, el proveedor administrado
   * hace failover— y en Node un `'error'` sin oyente es una excepción no capturada que tumba el
   * proceso. No es hipotético en este repo: un `docker compose restart postgres` con la web levantada
   * y sin tráfico alcanza.
   *
   * No hay nada que "arreglar" acá: el pool descarta la conexión rota y abre otra sola. Lo que hace
   * falta es que quede registrado y que el proceso siga vivo.
   */
  pool.on("error", (error) => {
    console.error("[db] conexión ociosa del pool caída (el pool la reemplaza sola):", error);
  });

  const db = crearDbRequest(pool);

  /**
   * El provider de identidad. La fábrica valida `APP_ENTORNO` y **lanza** si el sustituto de
   * desarrollo no corresponde: si esta línea no explota, el proceso tiene una forma válida de saber
   * quién es quién.
   *
   * `buscarUsuarioDemo` se inyecta corriendo con `sinUsuario()` —la conexión de request **sin
   * identidad**, con la RLS activa—, nunca con `DbJob`. Lo único que puede leer así es lo que tenga
   * una policy `using (true)`: hoy `usuario_demo` y nada más.
   */
  const auth = crearAuthProvider(
    { entorno: config.entorno, proveedor: config.proveedorAuth },
    {
      buscarUsuarioDemo: async (usuarioId) => {
        const usuario = await sinUsuario(db, (tx) => buscarUsuarioDemo(tx, usuarioId));
        return usuario ? { usuarioId: usuario.usuarioId, email: usuario.email, nombre: usuario.nombre } : null;
      },
    },
  );

  return { config, db, auth };
}

let recursosMemo: ReturnType<typeof construirRecursos> | null = null;

/** Los recursos del proceso, armados en el primer uso. Ver el comentario de `construirRecursos`. */
function recursos(): ReturnType<typeof construirRecursos> {
  recursosMemo ??= construirRecursos();
  return recursosMemo;
}

/** Cookies y headers del request entrante, en la forma neutral que `AuthProvider` entiende. */
async function entradaHttpDeNext(): Promise<EntradaHttp> {
  const [almacenCookies, cabeceras] = await Promise.all([cookies(), headers()]);
  return {
    cookies: new Map(almacenCookies.getAll().map((c) => [c.name, c.value])),
    // Los nombres van en minúsculas: es el contrato de `EntradaHttp`, y `Headers` ya los normaliza.
    headers: new Map([...cabeceras.entries()]),
  };
}

/** La sesión del request, o `null`. Rechaza lo vencido **en la puerta** (ver `conSesion`). */
export async function sesionActual(): Promise<Sesion | null> {
  const sesion = await recursos().auth.sesionDe(await entradaHttpDeNext());
  if (!sesion) return null;
  // `Date.now()` y no `new Date()`: esto es una comparación de **instantes**, no una fecha de
  // negocio. La distinción importa —la regla 7 del test de arquitectura prohíbe `new Date()`
  // justamente para que nadie saque de acá una fecha que después se imprime— y expresarlo con el
  // reloj monótono del proceso deja claro cuál de las dos cosas es.
  return sesion.expiraEn.getTime() > Date.now() ? sesion : null;
}

/**
 * **El ÚNICO camino de la web a la base.** Sin sesión no se abre transacción.
 *
 * Para páginas y Server Actions: si no hay sesión, redirige a `/entrar` y **la función no retorna**.
 *
 * El vencimiento se rechaza acá y no en cada adapter: así ningún adapter futuro se lo puede olvidar,
 * y el que lo implemente mal falla en un solo lugar y no en una policy. (La cookie del sustituto de
 * desarrollo no lleva marca de emisión ni firma, así que su `expiraEn` es una constante y **no vence
 * de verdad**: este renglón es el contrato que el adapter de producción va a tener que cumplir, y el
 * lugar donde se va a cumplir sin que nadie tenga que acordarse.)
 */
export async function conSesion<T>(fn: (tx: DbRequest, sesion: Sesion) => Promise<T>): Promise<T> {
  const sesion = await sesionActual();
  if (!sesion) redirect("/entrar");
  return conUsuario(recursos().db, sesion.identidad.usuarioId, (tx) => fn(tx, sesion));
}

export type ResultadoHttp<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly estado: 401 };

/**
 * Para Route Handlers: **no redirige, devuelve 401**.
 *
 * Un `fetch` no sigue un redirect a una pantalla de login de forma útil: el polling del progreso de
 * la emisión recibiría el HTML del formulario con un 200 y lo trataría como una respuesta válida.
 */
export async function conSesionHttp<T>(
  fn: (tx: DbRequest, sesion: Sesion) => Promise<T>,
): Promise<ResultadoHttp<T>> {
  const sesion = await sesionActual();
  if (!sesion) return { ok: false, estado: 401 };
  return { ok: true, valor: await conUsuario(recursos().db, sesion.identidad.usuarioId, (tx) => fn(tx, sesion)) };
}

/**
 * La pantalla de entrada solo existe con el sustituto de desarrollo. Con Auth real se entra con
 * credenciales, no eligiendo de una lista.
 */
export function hayPantallaDeIngreso(): boolean {
  return permiteIngresoSinSesion(recursos().auth);
}

/**
 * Inicia sesión eligiendo del elenco de la demo, y devuelve la cookie que hay que escribir.
 *
 * **Existe para que la `EntradaHttp` la arme SIEMPRE este módulo.** Si `/entrar` recibiera el
 * provider y tuviera que fabricar la entrada, nada le impediría escribir
 * `headers: new Map([["host", "localhost"]])` a mano y desactivar la vuelta 2 del candado desde
 * adentro de la app — sin romper ninguna regla del test de arquitectura, sin tocar `packages/auth` y
 * sin que se vea raro en un diff. Por eso el provider **no se exporta**: la app no puede escribir la
 * palabra `headers` en el camino de identidad.
 */
export async function iniciarSesionDeDemo(usuarioId: string): Promise<ResultadoInicio> {
  return recursos().auth.iniciarSesion({ tipo: "suplantacion", usuarioId, entrada: await entradaHttpDeNext() });
}

/** La cookie a expirar. El provider no toca el almacén de cookies: lo hace la Server Action. */
export async function cerrarSesionActual(): Promise<InstruccionCookie> {
  return recursos().auth.cerrarSesion();
}

/**
 * **La única excepción a la puerta única, y es una, no un patrón** (ADR-0002 §3.1).
 *
 * `/entrar` necesita leer `usuario_demo` sin sesión: es el huevo y la gallina del login —enumerar
 * `membership` requeriría `accessible_tenant_ids()`, que requiere identidad—. La excepción vive en
 * **este mismo módulo** y está acotada por cuatro cosas:
 *
 *  · existe **solo** si el provider activo tiene `aptoParaProduccion === false`. Con un adapter
 *    real, llamarla lanza;
 *  · corre con `sinUsuario()` —sin identidad, con la RLS activa—, así que lo único que puede leer es
 *    lo que tenga una policy `using (true)`. **No es una conexión privilegiada**: es la misma
 *    conexión de request, sin identidad;
 *  · exige `Host` local, igual que `sesionDe()` y que `iniciarSesion()`. Ver abajo por qué este
 *    tercer camino también lo necesita;
 *  · el test de arquitectura falla si se la referencia desde cualquier archivo que no sea
 *    `src/app/entrar/`. Una excepción sin cerco se convierte en un `sinSesion()` genérico en la
 *    primera semana.
 *
 * **Por qué el chequeo de `Host` acá no es redundante.** El ADR-0002 §2.4 describe la vuelta 2 sobre
 * dos caminos (`sesionDe` e `iniciarSesion`), pero hay un tercero: esta pantalla. Y es el más
 * delicado de los tres, porque en el sustituto de desarrollo **la cookie de sesión es el `user_id` en
 * claro** — o sea, la lista que `/entrar` muestra *es* el juego de tokens de sesión. Sin este
 * chequeo, la cadena desde afuera sería: leer el elenco por `/entrar` → mandar ese uuid como cookie
 * con `Host: localhost` → sesión de `admin_barrio`. Sigue haciendo falta que `usuario_demo` tenga
 * filas (la vuelta 3, la única que aguanta sola), pero no hay motivo para dejar el camino abierto.
 *
 * Falla **cerrado**, lanzando: prefiero un 500 en un `/entrar` alcanzado desde afuera antes que
 * servir el elenco.
 *
 * Lo que **no** se hace, ni una vez ni en desarrollo, es usar `DbJob` para armar la pantalla de
 * login.
 */
export async function conIngreso<T>(fn: (tx: DbRequest) => Promise<T>): Promise<T> {
  if (!permiteIngresoSinSesion(recursos().auth)) {
    throw new Error(
      `conIngreso() no existe con el provider "${recursos().auth.clave}": la pantalla de elegir usuario es del ` +
        "sustituto de desarrollo. Con Auth real se entra con credenciales, no eligiendo de una lista.",
    );
  }
  const entrada = await entradaHttpDeNext();
  if (!esHostLocal(entrada.headers.get("host"))) {
    throw new Error(
      "la pantalla de ingreso del sustituto de desarrollo solo atiende desde la propia máquina, y " +
        "este request llegó con otro Host. El elenco de la demo no se sirve hacia afuera: en este " +
        "adapter, el uuid que muestra la lista ES la cookie de sesión (ADR-0002 §2.3).",
    );
  }
  return sinUsuario(recursos().db, fn);
}

/**
 * Aserciones de arranque. Se llaman desde `instrumentation.ts`, al levantar el servidor — **no** en
 * el primer request, que es la diferencia entre un despliegue que no arranca y uno que arranca, pasa
 * el health-check y sirve mal.
 *
 * Son dos, y cubren cosas distintas:
 *
 * **1. La conexión está de verdad sujeta a la RLS.** Es el hueco que ningún otro cerrojo tapa: los
 * demás verifican *nombres de variable*, no privilegios. Un DSN de superusuario metido en
 * `DATABASE_URL_APP` pasa los cinco y sirve todos los barrios a todos los usuarios sin un solo
 * error. Corre **siempre**, en todos los entornos, porque es el que protege el aislamiento.
 *
 * **2. El elenco de la demo está vacío fuera de `local`.** Es el punto (d) de la migración 0019, y
 * lo que convierte la vuelta 3 del candado de una suposición sobre el seed en algo que la app
 * comprueba: "en producción la tabla está vacía" descansaría, si no, en que nadie haya corrido el
 * seed contra la base equivocada.
 */
export async function verificarArranque(): Promise<void> {
  await verificarConexionSujetaARls(recursos().db);

  if (recursos().config.entorno === "local") return;

  const filas = await sinUsuario(recursos().db, contarUsuariosDemo);
  if (filas > 0) {
    throw new Error(
      `APP_ENTORNO="${recursos().config.entorno}" y la tabla \`usuario_demo\` tiene ${filas} fila(s). Es el elenco ` +
        "del sustituto de identidad de desarrollo y en un entorno real tiene que estar VACÍA: mientras " +
        "tenga filas, hay a quién suplantar. El proceso no atiende hasta que se vacíe " +
        "(ADR-0002 §2.3 y §2.4 vuelta 3).",
    );
  }
}
