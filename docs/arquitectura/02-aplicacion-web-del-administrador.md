# ADR-0002 — Arquitectura de la aplicación web del administrador

**Estado:** Aceptado
**Fecha:** 2026-07-27
**Contexto de origen:** Fase 6C. Primer incremento con pantallas. Se apoya en el **ADR-0000** (stack,
abstracciones de portabilidad, RLS por `app.current_user_id()`) y en el **ADR-0001** (generación de
documentos: el motor vive en el worker, la web no lo importa). No revierte ninguna decisión de los dos:
las aplica al único lugar del sistema que todavía no existe.

---

## 1. Contexto

Hoy `apps/web` son **122 líneas**: una página que demuestra que los tokens de diseño y el dominio puro
están cableados. Todo lo demás del sistema se opera por comandos (`pnpm db:seed`, `pnpm demo:boleta`) o
por SQL suelto en scripts. Debajo, en cambio, hay bastante construido y probado contra Postgres real:
18 migraciones, RLS multi-tenant jerárquico con `app.accessible_tenant_ids()`, la máquina de estados del
período con sus triggers, el cálculo de la liquidación, el armado de la `VistaBoleta` y la familia de
tres PDF.

El objetivo de este incremento es **un solo recorrido, entero y andando**:

> entrar → ver los barrios que administro → ver el padrón de un barrio → cargar los gastos del mes →
> aplicar un cargo o un descuento a una unidad → generar el borrador y revisarlo → emitir → descargar
> los documentos.

No es el producto. Es la primera vez que una persona que no es programadora puede recorrer el sistema de
punta a punta sin abrir una terminal. El valor de este ADR no está en las pantallas —esas las diseña
`ux-designer` sobre `docs/diseno/06-direccion-visual.md`— sino en **los cuatro límites que, si se ponen
mal ahora, no se arreglan después**:

1. **Identidad.** No hay Auth. Hay que poder entrar hoy sin construir autenticación real, y que ese
   atajo no pueda llegar nunca a producción.
2. **La conexión a la base.** Todo el trabajo de RLS de las 18 migraciones **vale cero** si un
   componente consulta la base sin identidad. Ese es el agujero que hay que hacer imposible, no
   improbable.
3. **La forma de la capa de transporte.** Más adelante viene una app mobile para el residente. Si la
   web se come la lógica en Server Actions, la mobile no tiene con qué hablar.
4. **Dónde termina `apps/web` y empieza `packages/`.** La regla del proyecto es que no hay lógica de
   negocio en el cliente. Una regla que no se verifica en CI es una intención.

Cuatro restricciones de borde que ordenan todo lo demás:

- **La emisión es un lote largo** (ADR-0001 §5: 14,4 s y ~520 MB para 200 boletas). No cuelga de un
  request. Y hoy **no existe** ni el worker, ni el encolador, ni `ObjectStorage`.
- **Presupuesto de recursos** (`docs/devops/03-reglas-desarrollo-optimizado.md`): disparo por evento y no
  por cron (§5), polling espaciado y no de dos segundos (§4), función pesada en job y no en request
  (§2.f), guard de early-exit barato en todo job (§5).
- **La navegación ya está decidida** en `docs/diseno/06-direccion-visual.md` §c: toda ruta cuelga del
  barrio, selector persistente, sidebar por módulo. Este ADR la respeta y le corrige **un** punto (§4.4).
- **Trabajo en paralelo:** `packages/documentos/` y `docs/diseno/10-informe-mensual-y-mora.md` están
  siendo tocados por otra tarea. Este ADR **no los modifica** y no depende de que se resuelvan sus
  pendientes abiertos.

---

## 2. Decisión — Identidad: `AuthProvider`, y un sustituto de desarrollo con candado

### 2.1. Lo que hay hoy, exactamente

Conviene ser preciso, porque la ausencia es más grande de lo que parece:

| Pieza | Estado |
|---|---|
| Tabla de usuarios | **No existe.** Ninguna. |
| Contraseñas, sesiones, tokens | **No existen.** |
| `membership.user_id` | `uuid not null`, **sin FK a nada** — a propósito (ADR-0000 §3.2: la identidad es de la capa de Auth, agnóstica). |
| `app.current_user_id()` | Existe y funciona: `coalesce(current_setting('app.user_id'), auth.uid())`, con un stub de `auth.uid() → null` para Postgres puro. |
| Cómo llega la identidad | `conUsuario(db, userId, fn)` → `set_config('app.user_id', …, true)`. |
| El usuario de la demo | El literal `00000000-0000-4000-8000-000000000001`, hardcodeado en `seed-demo.ts` y `demo-boleta.ts`. |

O sea: **el mecanismo de aislamiento está entero y probado; lo que falta es quién dice quién sos.**

### 2.2. La interfaz de portabilidad

Paquete nuevo `packages/auth`. Contrato, no implementación:

```ts
// packages/auth/src/auth-provider.ts — ilustrativo
/** Lo único que el resto del sistema necesita saber de una persona. */
export interface Identidad {
  /** El uuid que va a `app.user_id` y que las policies ven en `app.current_user_id()`. */
  readonly usuarioId: string;
  readonly email: string | null;
  readonly nombre: string | null;
}

export interface Sesion {
  readonly identidad: Identidad;
  readonly expiraEn: Date;
  /** Clave del adapter que la emitió. Se registra en los logs: una sesión de dev se ve. */
  readonly origen: string;
}

export interface AuthProvider {
  /** "dev-suplantacion" | "supabase" | "cognito" | "gotrue". */
  readonly clave: string;
  /** ¿Sirve para producción? El sustituto de desarrollo devuelve `false` y nadie más. */
  readonly aptoParaProduccion: boolean;

  /** Lee la sesión de las cookies/headers entrantes. `null` = no hay sesión válida. */
  sesionDe(entrada: EntradaHttp): Promise<Sesion | null>;
  /** Inicia sesión. `Credenciales` es una unión discriminada por adapter. */
  iniciarSesion(c: Credenciales): Promise<ResultadoInicio>;
  cerrarSesion(): Promise<void>;
}

/** No se recibe el `Request` de Next: la interfaz también la usa el worker y, mañana, la mobile. */
export type EntradaHttp = {
  readonly cookies: ReadonlyMap<string, string>;
  readonly headers: ReadonlyMap<string, string>;
};
```

Tres propiedades deliberadas:

- **`Identidad.usuarioId` es lo único que cruza el límite hacia los datos.** Ningún servicio de negocio
  recibe una `Sesion`, un token ni un `Request`. Reciben `tx: DbConIdentidad`, que ya lleva la identidad
  puesta por `conUsuario()`. La superficie de acople con el proveedor de Auth es **un uuid**.
- **El rol no viaja en la sesión.** El rol vive en `membership` y lo resuelve la base
  (`app.has_role_on`). Un token que dijera "soy admin_barrio" sería una autorización que la base no
  verificó, y además el rol es **por nodo** (alguien es `admin_barrio` en un barrio y `propietario` en
  otro): no cabe en un claim. Esto ya está resuelto en el esquema; el ADR solo lo cierra.
- **`aptoParaProduccion` es un campo del contrato, no un comentario.** Lo usa el candado de §2.4.

### 2.3. El sustituto de desarrollo: suplantación desde una tabla de demo

**Decidido: un adapter `dev-suplantacion` que deja elegir con qué usuario se entra, de una lista que
sale de una tabla nueva `usuario_demo`, y de ningún otro lado.**

```sql
-- packages/data/migrations/0018_usuario_demo.sql — ilustrativo
create table usuario_demo (
  user_id     uuid primary key,          -- el mismo uuid que va a membership.user_id
  email       text not null unique,
  nombre      text not null,
  descripcion text not null,             -- "admin del estudio", "operador de Los Álamos"
  creado_at   timestamptz not null default now()
);
comment on table usuario_demo is
  'Elenco de la demo. La escribe SOLO el seed, con el rol dueño del esquema. En produccion esta vacia,
   y por eso el adapter dev-suplantacion no puede suplantar a nadie aunque alguien lo habilite.';

alter table usuario_demo enable row level security;
alter table usuario_demo force  row level security;

-- Se lee SIN identidad: es la pantalla de entrada, todavia no hay nadie. Es el unico `using (true)`
-- del esquema, y por eso la tabla no tiene ni una columna que no sea del elenco de la demo.
create policy usuario_demo_sel on usuario_demo for select using (true);

grant select on table usuario_demo to app_request;
-- Sin insert/update/delete para NINGUN rol de la app: ni app_request ni app_job pueden agregar un
-- usuario de demo en caliente. El unico que escribe esta tabla es el dueño del esquema, o sea el seed.
```

El adapter:

```ts
// packages/auth/src/adapters/dev-suplantacion.ts — ilustrativo
export function crearAuthDevSuplantacion(deps: Deps): AuthProvider {
  return {
    clave: "dev-suplantacion",
    aptoParaProduccion: false,

    async iniciarSesion(c) {
      if (c.tipo !== "suplantacion") throw new Error("adapter de desarrollo: solo suplantación");
      // No confía en el uuid que manda el navegador: tiene que estar en el elenco.
      const usuario = await deps.buscarUsuarioDemo(c.usuarioId);
      if (!usuario) throw new Error("ese usuario no está en el elenco de la demo");
      return { ok: true, cookie: { nombre: COOKIE, valor: usuario.user_id, httpOnly: true, sameSite: "lax" } };
    },

    async sesionDe(entrada) {
      // Candado 2 (§2.4): aunque el proceso arranque, no atiende a nadie fuera de la máquina local.
      const host = (entrada.headers.get("host") ?? "").split(":")[0];
      if (!HOSTS_LOCALES.has(host)) return null;

      const id = entrada.cookies.get(COOKIE);
      if (!id) return null;
      // Se revalida en CADA request contra la tabla: vaciar `usuario_demo` invalida todas las sesiones.
      const usuario = await deps.buscarUsuarioDemo(id);
      return usuario ? { identidad: {...}, expiraEn: …, origen: "dev-suplantacion" } : null;
    },
  };
}
```

**Por qué una tabla y no una lista en el código ni un `.env`:** porque el candado más fuerte que se
puede poner es que **en producción no haya a quién suplantar**. Una lista en el código viaja al
contenedor; una variable de entorno se puede setear; una fila que solo escribe el seed —y el seed
solo corre en desarrollo— **no está**. El candado deja de depender de la configuración y pasa a
depender de los datos, que es un lugar mucho más difícil de romper por accidente.

**Por qué la lista se lee sin identidad y eso no es un agujero:** es la pantalla de entrada, no hay
sesión todavía; la tabla contiene únicamente el elenco ficticio del seed; y no tiene grant de escritura
para ningún rol de la app. En producción devuelve cero filas.

**Por qué no se enumera `membership`:** porque leer `membership` requiere pasar
`accessible_tenant_ids()`, que requiere identidad — el huevo y la gallina. La salida "usar la conexión
`BYPASSRLS` para armar la pantalla de login" es exactamente el patrón que este ADR prohíbe en §3, y no
se hace ni siquiera una vez ni siquiera en desarrollo.

### 2.4. El candado — cuatro vueltas, cada una suficiente sola

Ninguna es una advertencia en un README.

| # | Vuelta | Qué impide | Cómo se verifica |
|---|---|---|---|
| **1** | **El proceso no arranca.** `crearAuthProvider()` es la única fábrica. Valida el entorno con Zod **al importarse el módulo**, no en el primer request, y **lanza** si `provider.aptoParaProduccion === false` y `NODE_ENV === "production"`. `AUTH_PROVIDER` es obligatorio y **sin default**: sin la variable, la app tampoco levanta. | Desplegar a producción con el sustituto activo. No hay ventana de "funcionó mal un rato": el contenedor no pasa el arranque. | Test unitario puro (`packages/auth/src/registro.test.ts`): con `NODE_ENV=production` y `AUTH_PROVIDER=dev-suplantacion`, `crearAuthProvider()` lanza. Entra en `pnpm test`. |
| **2** | **No atiende fuera de la máquina.** `sesionDe()` devuelve `null` si el `Host` no es `localhost`/`127.0.0.1`/`::1`. Sin sesión, `conSesion()` (§3) redirige a `/entrar`, y `/entrar` no lista a nadie. | Que un despliegue con la variable forzada, detrás de un dominio real, deje entrar a alguien. | Test unitario con un `Host` remoto → `null`. |
| **3** | **No hay a quién suplantar.** `usuario_demo` la escribe solo el dueño del esquema. El seed que la llena (`seed-demo.ts`) **ya se niega a correr con `NODE_ENV=production`**, igual que `setup-dev.ts`, y además usa `set session_replication_role = replica`, que exige superusuario y por eso **no corre en un Postgres administrado** (Supabase/RDS). | Que el adapter, aun habilitado y aun local, produzca una identidad. Falla cerrado por datos. | Test de base (proyecto `db`): con `usuario_demo` vacía, `iniciarSesion` y `sesionDe` devuelven "no hay elenco". |
| **4** | **CI mira quién lo importa.** El test de arquitectura (§5.3) falla si algún archivo de `apps/web/src` importa `packages/auth/src/adapters/dev-suplantacion.ts`: la **única** referencia permitida en todo el repo es la rama guardada de la fábrica. | Que alguien lo instancie a mano y se saltee la fábrica —que es donde vive la vuelta 1. | `pnpm test` (proyecto `unit`). |

La cookie de dev **no está firmada a propósito**: es un uuid en claro. Firmarla daría la ilusión de ser
un mecanismo de seguridad. No lo es, y que se vea que no lo es forma parte del diseño.

### 2.5. Qué queda pendiente para producción — explícito

Este ADR **no** entrega autenticación. Entrega el contrato y un andamio. Falta, y hay que escribirlo
antes de la primera cuenta real:

1. **Elegir el adapter concreto** — Supabase Auth / Cognito / GoTrue self-hosted. Sigue atado a la
   decisión de hosting, abierta en ADR-0000 §10.
2. **El puente `sub` del IdP → `membership.user_id`.** Hoy no existe ninguna forma de resolver
   "email + contraseña → uuid". Dos caminos: usar el `sub` del IdP directamente como `user_id` (cero
   tablas, pero migrar de proveedor reescribe todas las membresías y las 11 columnas `*_por` que ya
   guardan uuids de usuario), o una tabla `usuario (id uuid pk, sub_externo text unique, email, …)`
   que desacople el id interno del proveedor. **Recomendación: la tabla.** El costo es una migración;
   el ahorro es no quedar atado a un IdP en las columnas de auditoría de dinero.
3. **Alta de usuarios e invitaciones.** No existe camino para crear una membresía desde la UI. Hoy solo
   la escribe el seed.
4. **Revocación efectiva.** `membership.activo = false` corta el acceso en el próximo request; falta
   decidir el TTL de la sesión y si hay lista de revocación.
5. **Índice sobre `membership.user_id`.** Hoy solo existe `uq_membership_user_node_rol (user_id,
   tenant_node_id, rol)`, que sirve de prefijo para buscar por usuario — pero conviene medirlo cuando
   `accessible_tenant_ids()` se ejecute en cada policy de cada query real. **Medir antes de optimizar**
   (regla §0): no se agrega el índice sin un plan que lo justifique.
6. **El vínculo usuario → unidad funcional**, prerequisito declarado en `0016` para que un `propietario`
   pueda leer lo suyo. Sin él, el portal del residente y la mobile no pueden arrancar.
7. **Segundo factor, rotación de contraseñas, recuperación.** Del adapter, no nuestro.

---

## 3. Decisión — Una sola puerta a la base, y por qué no se puede rodear

### 3.1. El patrón

**Decidido: todo acceso a la base desde `apps/web` pasa por `conSesion()`, que vive en
`apps/web/src/servidor/db.ts` y es el único módulo del app que conoce el pool.**

```ts
// apps/web/src/servidor/db.ts — ilustrativo. Primera línea del archivo:
import "server-only";

import { crearDbRequest, crearPoolRequest, conUsuario, type DbRequest } from "@admin-barrios/data/client";
import { crearAuthProvider } from "@admin-barrios/auth";

// El pool es un singleton de módulo y NO se exporta. Nadie más puede fabricar una conexión.
const pool = crearPoolRequest({ maxConexiones: config.dbMaxConexiones });
const db = crearDbRequest(pool);
const auth = crearAuthProvider(config);

/**
 * El ÚNICO camino de la web a la base. Sin sesión no se abre transacción.
 *
 * Para páginas y Server Actions: si no hay sesión, redirige. La función no retorna.
 */
export async function conSesion<T>(fn: (tx: DbRequest, sesion: Sesion) => Promise<T>): Promise<T> {
  const sesion = await auth.sesionDe(entradaHttpDeNext());
  if (!sesion) redirect("/entrar");
  return conUsuario(db, sesion.identidad.usuarioId, (tx) => fn(tx, sesion));
}

/** Para Route Handlers: no redirige, devuelve 401. Un `fetch` no sigue un redirect a una pantalla. */
export async function conSesionHttp<T>(
  fn: (tx: DbRequest, sesion: Sesion) => Promise<T>,
): Promise<{ ok: true; valor: T } | { ok: false; estado: 401 }> { /* … */ }
```

Y una regla de uso que es tan importante como el patrón:

> **Adentro de `conSesion()` no se hace nada lento.** Ni `fetch`, ni `ObjectStorage`, ni renderizar, ni
> esperar a una persona. Una transacción abierta ocupa una conexión del pool y, con `FOR UPDATE`, una
> fila. El patrón es **leer → cerrar la transacción → hacer el trabajo → abrir otra para escribir**.
> Es la misma regla que el job de emisión (§6.4) tiene que respetar con mucho más cuidado, porque ahí
> el trabajo del medio dura 14 segundos.

### 3.2. Cuatro cerrojos, en cuatro planos distintos

Un componente que consulte la base sin identidad es exactamente el agujero que todo el trabajo de RLS
existe para evitar. No alcanza con una convención:

**Cerrojo 1 — el compilador.** Ya está construido: `packages/data/src/client.ts` marca los tipos
(`DbRequest & { __rls: "sujeto" }`, `DbJob & { __rls: "bypass" }`) y `conUsuario()` **no acepta
`DbJob`**. Los servicios reciben `DbConIdentidad`, que es `DbRequest | DbMantenimiento`. Ponerle una
identidad a una conexión con `BYPASSRLS` —el error más caro posible, porque el código *se leería*
aislado y no aislaría nada— no compila.

**Cerrojo 2 — el grafo de imports, verificado en CI.** La violación, definida sin ambigüedad:

> Es una violación que **cualquier archivo de `apps/web/src` que no sea `src/servidor/db.ts`** importe
> `pg`, `drizzle-orm`, `@admin-barrios/data` (la raíz), `@admin-barrios/data/schema`, o cualquiera de
> `crearPoolJob` / `crearDbJob` / `crearDbMantenimiento` / `sinUsuario`. La web importa **solo**
> `@admin-barrios/data/servicios/*`.

Esto exige un cambio chico en `packages/data/package.json`: sacar `client.ts` de la raíz a su propia
subruta (`"./client": "./src/client.ts"`), igual que el adapter de Chromium vive detrás de
`@admin-barrios/documentos/chromium`. Es el mismo mecanismo que ya funciona, aplicado a la otra pieza
peligrosa.

**Cerrojo 3 — `server-only`.** `apps/web/src/servidor/*` abre con `import "server-only"`. Si un
componente marcado `"use client"` llega a importar ese módulo por cualquier camino, **el build de Next
falla**. Es lo que impide la variante más silenciosa del bug: que la conexión termine referenciada desde
un bundle de navegador.

**Cerrojo 4 — la base, que es la que decide de verdad.** `app_request` no tiene `BYPASSRLS`, todas las
tablas tienen `FORCE ROW LEVEL SECURITY`, y sin `app.user_id` seteado `app.current_user_id()` devuelve
`null` → `accessible_tenant_ids()` no devuelve nada → **cero filas**. Ya hay tests que lo prueban
(`sinUsuario()` existe justamente para eso). Los tres cerrojos de arriba están para que el error se
detecte en el editor o en CI; **este** está para que, si igual pasa, el resultado sea una pantalla vacía
y no una fuga entre barrios.

### 3.3. Pooling — lo que `set_config(..., true)` resuelve y lo que no

`conUsuario()` usa `set_config('app.user_id', …, true)`: el `true` lo hace **local a la transacción**.
Al hacer commit, el valor se descarta. Esto es lo que evita el bug de fuga de tenant más caro que existe
con un pool: un `SET` de sesión se pega a la conexión y **el siguiente request que tome esa conexión del
pool hereda el usuario anterior**. Además, ser local a la transacción es lo que lo hace compatible con
un pooler en **modo transacción** (pgBouncer, Supavisor, RDS Proxy), que es el modo que el proyecto va a
necesitar el día que corra en un entorno con muchas instancias chicas.

Lo que **no** resuelve, y hay que respetar:

| Situación | Regla |
|---|---|
| Contenedor largo (Docker, ECS, VPS) — el caso de hoy | Un pool por proceso, `max` acotado (arranca en 10). Postgres 16 default: 100 conexiones. Dos instancias × 10 = 20. Sobra. |
| Serverless (Vercel, Lambda) | Un pool por instancia **no sirve**: cada invocación fría abre conexiones y las abandona. Hace falta un pooler externo y `max: 1`. Es configuración, no código — pero hay que acordarse. Queda anotado en §12. |
| Modo transacción del pooler | Prohibido cualquier estado de sesión: nada de `SET` sin `LOCAL`, nada de `LISTEN` por el pooler (ver §6.3), nada de sentencias preparadas de sesión. |
| Trabajo lento dentro de la transacción | Prohibido (§3.1). Con `max: 10`, diez emisiones simultáneas que renderizaran adentro de la transacción congelarían el pool entero. |

### 3.4. El barrio de la URL **no** autoriza — corrección a doc 06 §c.1

`docs/diseno/06-direccion-visual.md` §c.1 dice, en su nota `[fe]`, que "el `barrio` de la URL alimenta
el `SET LOCAL app.user_id` / filtro por `barrio_id` en la capa de datos". **Eso es incorrecto y hay que
corregirlo antes de escribir la primera pantalla**, porque describe exactamente el patrón que el
aislamiento existe para evitar:

- `app.user_id` **no puede** salir de la URL. Sale de la sesión y de ningún otro lado. Si saliera de la
  URL, cambiar un segmento sería cambiar de identidad.
- El `barrio_id` **no se usa como filtro de autorización**. Los servicios lo derivan de la propia fila
  bajo RLS (`vista-boleta.ts` ya lo hace: recibe `periodoId` y **no** recibe `barrioId`, ADR-0001 §5.2).

Lo que el segmento de la URL sí es: **una preferencia de navegación**. El `layout.tsx` de `[barrio]`
hace una consulta —bajo `conSesion`, como todo— para resolver la cabecera de ese barrio. Si el usuario
no tiene acceso, la RLS devuelve cero filas y el layout hace `notFound()`. La autorización la hizo la
base; la URL solo dijo qué mirar.

**Y el segmento es el `id` (uuid), no un slug.** No hay columna `slug` en `tenant_node`, un slug
derivado del nombre se rompe cuando el barrio se renombra —y con él todos los deep-links y los links de
los emails ya enviados—, y el uuid no es un secreto: quien no tenga membresía ve un 404 igual. Si más
adelante se quiere una URL legible, es una columna `slug` con índice único y su migración; queda
anotado en §12.

---

## 4. Decisión — Server Actions para el administrador, y la costura que le deja lugar a la mobile

**Decidido:**

| Camino | Para qué | Por qué |
|---|---|---|
| **React Server Components** | Todas las lecturas de pantalla | Llaman al servicio dentro de `conSesion`. Cero endpoints, cero estado de carga en el cliente, cero duplicación de tipos. |
| **Server Actions** | Todas las escrituras del administrador | Envoltorio delgado. Ver la regla de abajo. |
| **Route Handlers** | **Tres** casos, desde el día uno | Descarga de documentos, polling del estado del trabajo, y la vista HTML de una boleta. Ninguno de los tres lo puede hacer una acción. |
| **Capa `/api/v1`** | **No se construye ahora** | No hay un segundo consumidor. Se construye cuando lo haya. |

### 4.1. Por qué esto no encierra a la mobile

El argumento en contra de las Server Actions es real y hay que responderlo de frente: si la lógica se
escribe adentro de la acción, la mobile no tiene con qué hablar y hay que reescribir todo.

**La respuesta es que la lógica no vive en la acción. Vive en `packages/data/src/servicios/`, con la
firma `(tx: DbConIdentidad, parametros) => Promise<Resultado>`.** Esa firma no sabe qué es un `Request`,
ni una cookie, ni Next. Es la misma que ya tienen `generarLiquidaciones()`, `emitirPeriodo()` y
`armarVistasDelPeriodo()`, y es la que usan hoy los scripts y va a usar mañana el worker.

Con eso, la elección entre Server Action y Route Handler pasa a ser una decisión de **transporte**, y el
costo de cambiarla es escribir un archivo nuevo que llama al mismo servicio. La costura que importa —la
que sería carísima de mover después— es el límite `apps/*` ↔ `packages/*`, y ese queda fijado acá y
verificado en CI (§5).

Dos observaciones más, para no argumentar con un futuro imaginario:

- **La mobile es del residente, no del administrador.** No va a querer "cargar los gastos del mes": va a
  querer "mi boleta", "mi estado de cuenta", "mi reclamo". Son consultas **distintas**, sobre policies
  que hoy ni siquiera están abiertas (`0016` deja a `propietario` y `residente` fuera del módulo de
  cargos, y falta el vínculo usuario → unidad, §2.5 punto 6). Construir hoy `/api/v1/gastos` "para la
  mobile" sería construir el endpoint equivocado.
- **Una API REST completa para un solo consumidor es duplicación medible**: esquema Zod de entrada y de
  salida, cliente `fetch` tipado, manejo de errores en dos lugares, versionado, y tests de contrato —
  para llegar exactamente al mismo servicio que el Server Component ya llama en proceso. La regla §2 del
  presupuesto de recursos pide preferir "la más barata que sirva".

**El gatillo, escrito:** cuando arranque `apps/mobile`, se agregan Route Handlers `/api/v1/*` **sobre
los mismos servicios**, con sus esquemas Zod de `packages/shared`. Lo que **no** se hace nunca es
exponer las Server Actions del administrador como si fueran una API: son un detalle de transporte de
Next, con ids opacos que cambian entre builds.

### 4.2. La regla dura de una Server Action

> **Una Server Action tiene cuatro pasos y ninguno más:** (1) `parse` con un esquema Zod de
> `packages/shared`; (2) `conSesion`; (3) **una** llamada a un servicio de `@admin-barrios/data/servicios/*`;
> (4) `revalidatePath` y devolver un resultado serializable.

```ts
// apps/web/src/app/(admin)/[barrio]/liquidacion/[periodo]/acciones.ts — ilustrativo
"use server";

export async function registrarGastoAction(_previo: EstadoForm, form: FormData): Promise<EstadoForm> {
  const entrada = registrarGastoSchema.safeParse(Object.fromEntries(form));
  if (!entrada.success) return { ok: false, errores: entrada.error.flatten().fieldErrors };

  try {
    // El servicio deriva el barrio del período bajo RLS. La acción no le pasa un `barrioId`.
    const gasto = await conSesion((tx) => registrarGasto(tx, entrada.data));
    revalidatePath(`/${form.get("barrio")}/liquidacion/${entrada.data.periodoId}/gastos`);
    return { ok: true, gastoId: gasto.id };
  } catch (e) {
    return { ok: false, mensaje: mensajeDeError(e) };   // traduce, no decide
  }
}
```

Cuatro cosas que **no** hace y que son violaciones (§5.2): calcular un importe, decidir si el período se
puede editar (lo decide el trigger `app.periodo_editable`), filtrar por `barrio_id` (lo decide la RLS), y
confiar en que solo la propia UI la llama.

Ese último punto merece su renglón: **una Server Action es un endpoint POST público** identificado por
un id opaco. Next 15 valida `Origin`/`Host` por defecto —y hay que dejar `serverActions.allowedOrigins`
configurado en `next.config.mjs` cuando haya dominio—, pero eso es protección contra CSRF, **no**
autorización. La autorización es siempre: sesión (§3) + Zod + la base.

### 4.3. Los tres Route Handlers, y por qué cada uno tiene que serlo

| Ruta | Por qué no puede ser una acción |
|---|---|
| `GET /api/documentos/[documentoId]` | Devuelve un `302` a una URL firmada, con `Cache-Control: no-store`. Una Server Action no devuelve una respuesta HTTP: devuelve un valor serializado. |
| `GET /api/trabajos/[trabajoId]` | Es polling: un `GET` barato y repetido desde el navegador. Además es, textualmente, el primer endpoint que la mobile va a reusar sin cambios. |
| `GET /api/barrios/[barrio]/liquidaciones/[id]/vista` | Devuelve el **HTML del documento**, servido a un `<iframe sandbox>`. Ver abajo. |

**La vista previa merece una decisión propia.** `packages/documentos` ya expone, por su entrada pública
`.` (la que el test de grafo garantiza que no arrastra Chromium), todo lo necesario para producir el
HTML de una boleta: `solicitudDeBoleta()` + `htmlCompleto()`. O sea que **la vista previa de una boleta
sale sin worker, sin Chromium y sin PDF** — es exactamente el reuso de plantilla única que el ADR-0001
§3 puso como primer fundamento, cobrado por primera vez.

Se sirve en un **`<iframe sandbox>` desde un Route Handler**, y no inyectando el markup en la página con
`dangerouslySetInnerHTML`, por dos razones: el documento trae texto cargado por el administrador (nombre
de concepto, detalle de un cargo, título de un acta) y SVG generado, y meterlo en el DOM de la app
autenticada es una superficie de XSS dentro del origen que tiene la sesión; y los estilos del documento
son de impresión y pisarían los de la app. La respuesta va con
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:` — que es, además,
la misma guarda anti-SSRF del ADR-0001 §3.2 aplicada al canal web.

---

## 5. Decisión — Dónde termina `apps/web` y empieza `packages/`

### 5.1. La regla, en una línea

> `apps/web` hace **cuatro** cosas: routing, sesión, presentación y traducción de errores a mensajes.
> Todo lo demás está en `packages/`.

### 5.2. Qué es una violación, concretamente

No "meter lógica en el cliente". Nueve cosas detectables:

| # | Violación | Por qué |
|---|---|---|
| 1 | Importar `pg` o `drizzle-orm` desde `apps/web` (salvo `src/servidor/db.ts`) | §3.2, cerrojo 2. |
| 2 | Importar `@admin-barrios/data` (raíz) o `/schema` | Arrastra `client.ts` y el esquema entero; la web importa `servicios/*`. |
| 3 | Importar `@admin-barrios/documentos/chromium` (o que `puppeteer-core`/`pdf-lib` aparezcan en el grafo) | ADR-0001 §3. **Ya verificado hoy.** |
| 4 | Importar `packages/auth/src/adapters/dev-suplantacion.ts` | §2.4, vuelta 4. |
| 5 | `Number(…)`, `parseFloat(…)`, `.toFixed(…)` sobre cualquier cosa | El dinero es `numeric` leído como **string** a propósito (`pg.types` no castea `numeric`). Un `Number()` sobre un importe es una pérdida de exactitud silenciosa. La aritmética vive en `@admin-barrios/shared/dinero`. |
| 6 | `Intl.NumberFormat`, `toLocaleString`, `toLocaleDateString` | Node slim sin ICU completo degrada `es-AR` a `en-US` **en silencio** (ADR-0001 §4.1): `359.000,00` en pantalla y `359,000.00` en el PDF. El formateo vive en `shared/dinero` y `shared/fechas`, en un solo lugar, y por eso el test puede comparar la misma cadena en los tres destinos. |
| 7 | `new Date()` para una fecha de negocio | `docs/diseno` ya lo documenta: después de las 21:00 ART el servidor en UTC ya está en el día siguiente. `shared/fechas`. |
| 8 | Leer `process.env` fuera de `apps/web/src/servidor/configuracion.ts` | Una sola puerta al entorno, validada con Zod al arrancar. Es lo que hace posible el candado §2.4 vuelta 1. |
| 9 | Que un archivo `"use server"` importe algo fuera de la lista blanca | La lista: `@admin-barrios/data/servicios/*`, `@admin-barrios/shared/*`, `@admin-barrios/documentos` (entrada `.`), `zod`, `next/*`, y `../servidor/*`. Es la forma operativa de la regla §4.2. |

### 5.3. Cómo se detecta — extendiendo el mecanismo que ya existe

Hoy hay un caminante de grafo real, no un chequeo de imports directos:
`packages/documentos/src/importaciones-web.test.ts` camina el grafo entero desde las entradas de
`apps/web/src`, atravesando los paquetes del workspace por su mapa de `exports`, y falla si
`puppeteer-core`, `puppeteer`, `playwright` o `pdf-lib` aparecen. Incluye un test de control que
verifica que **el caminante detecta de verdad** el motor (si no, todo lo demás sería un falso verde).
Ese detalle es el que hace que valga la pena reusarlo y no escribir otro.

**Plan:**

1. Extraer el caminante a `tools/arquitectura/grafo.ts` (módulo sin dependencias, importado por ruta
   relativa desde los tests). No es un paquete del workspace: es una herramienta de test, y meterla en
   `packages/shared` sería meter utilidades de test en un paquete de producción.
2. `packages/documentos/src/importaciones-web.test.ts` **queda donde está** y pasa a usar el helper —
   la regla de Chromium es del ADR-0001 y su test vive con su paquete.
3. **Nuevo:** `apps/web/src/arquitectura.test.ts`, con las nueve reglas de §5.2. El proyecto `unit` de
   Vitest ya incluye `apps/*/src/**/*.test.ts`: entra al gate barato sin tocar la configuración.

Las reglas 1–4 y 9 se verifican con el grafo (o con la lista de imports del archivo, para la 9). Las 5–8
se verifican con una pasada de expresiones regulares sobre los fuentes de `apps/web/src`, con una lista
blanca **explícita y chica** por regla. Es tosco y es a propósito: una regla de estilo que se puede
verificar con `grep` en 40 milisegundos y falla el build vale más que un lint sofisticado que nadie
configura. Cuando alguna genere ruido, se discute la excepción en un PR — que es donde se tiene que
discutir.

**Lo que este mecanismo NO detecta, y hay que decirlo:** una regla de negocio escrita en prosa dentro de
un componente (un `if (periodo.estado === "borrador" && diasHastaVencimiento < 5)`). Contra eso no hay
regex; hay `code-reviewer` y la regla §4.2 de las cuatro líneas. El test cubre los acoples estructurales,
que son los que se rompen sin que nadie se dé cuenta.

---

## 6. Decisión — La emisión: un trabajo, no un request

### 6.1. Qué es síncrono y qué no

Hay que separar dos cosas que en el habla se llaman igual:

| Paso | Cómo corre | Por qué |
|---|---|---|
| **Emitir el período** (`borrador`/`revisada` → `emitida`) | **Síncrono**, Server Action → `emitirPeriodo()` | Es un `UPDATE`. El trigger `app.periodo_transicion` corre `app.validar_emision` (v4): versión de coeficientes cerrada, una liquidación por unidad activa, cuadre del prorrateo, biyección de cargos/descuentos, totales por unidad, piso de cero. Son agregados sobre ~200 unidades: sub-segundo. Y la firma (`emitida_por`) la escribe la base desde `app.current_user_id()`, que es exactamente la identidad que `conSesion` puso. |
| **Generar los documentos** | **Job** | 14,4 s y ~520 MB para 200 boletas (ADR-0001 §2.1). No entra en un request, no entra en una función serverless, y viola la regla §2.f del presupuesto de recursos. |

Esta separación no es cosmética: hace que el estado del período —lo que la base considera verdad— no
dependa de que un proceso externo termine bien. Un job que falla deja el período `emitida` sin
documentos, que es un estado recuperable y visible. Un job que además tuviera que mover el estado
dejaría el período a medias.

### 6.2. Las tres piezas que hay que construir

Ninguna existe hoy.

**a) La tabla `trabajo`** (migración nueva). RLS con el patrón de siempre — `select` por
`accessible_tenant_ids()`, `insert`/`update` por `has_role_on(barrio_id, {admin_plataforma, admin_barrio,
operador})`, sin `delete`:

```sql
-- packages/data/migrations/0019_trabajos.sql — ilustrativo
create type app.estado_trabajo as enum ('encolado','corriendo','terminado','fallado');

create table trabajo (
  id             uuid primary key default gen_random_uuid(),
  barrio_id      uuid not null references tenant_node(id),  -- derivado del período BAJO RLS al encolar
  tipo           text not null,                             -- 'emitir_documentos_periodo'
  referencia_id  uuid not null,                             -- el periodo_id
  estado         app.estado_trabajo not null default 'encolado',
  hechos         integer not null default 0,
  total          integer,
  intento        smallint not null default 0,
  solicitado_por uuid not null,      -- lo escribe la base con app.current_user_id(), no el request
  solicitado_at  timestamptz not null default now(),
  iniciado_at    timestamptz,
  terminado_at   timestamptz,
  error          text
);

-- Idempotencia (ADR-0001 §5.3): un solo trabajo pendiente por (referencia, tipo).
create unique index uq_trabajo_pendiente on trabajo (referencia_id, tipo)
  where estado in ('encolado','corriendo');

-- El barrido de rezagados del worker (§6.3) toca este índice y normalmente devuelve cero filas.
create index idx_trabajo_encolado on trabajo (solicitado_at) where estado = 'encolado';
```

**b) La tabla `documento_liquidacion`** — la del ADR-0001 §6, que hasta hoy es ilustrativa: append-only,
con `storage_key unique`, `sha256`, `vista jsonb`, `vista_version`, `motor`, `plantilla_hash`,
`medio_cobranza`, `emitido_por` escrito por la base. Sin `update` ni `delete` para el rol de request.

**c) La interfaz del encolador**, neutral como manda el ADR-0000 §4:

```ts
// packages/data/src/servicios/trabajos.ts — ilustrativo
export interface EncoladorTrabajos {
  /** Corre bajo `conSesion`: el barrio se deriva del período por RLS, no viene en el request. */
  encolar(tx: DbConIdentidad, t: { tipo: string; referenciaId: string }): Promise<string>;
  estado(tx: DbConIdentidad, trabajoId: string): Promise<EstadoTrabajo>;
}
```

**El adapter por defecto es la propia tabla de Postgres** (`for update skip locked`), no Redis ni SQS.
Dos motivos: portabilidad (ADR-0000 §7 exige que el sistema corra igual en las tres columnas, y una cola
gestionada no tiene fila self-hosted), y presupuesto (un servicio menos que operar, monitorear y pagar).
Con 12 emisiones por barrio por año, una tabla es holgadamente suficiente. El adapter SQS/Cloud Tasks se
escribe el día que el hosting lo pida, detrás de la misma interfaz.

### 6.3. El worker y su disparo

`apps/worker` es el proceso que el ADR-0001 §11 ya anticipó: imagen propia con Chromium, entrada en
`docker-compose.yml`, y en desarrollo se puede correr con `pnpm dev:worker` sin Docker si hay un Chrome
local (`CHROME_PATH`), igual que en CI.

**Disparo por evento, con red de seguridad** — la regla §5 del presupuesto de recursos:

- `pg_notify('trabajo_nuevo', …)` en el `insert` de `trabajo`; el worker hace `LISTEN`. Latencia:
  milisegundos, cero polling.
- **Barrido de rezagados cada 60 s** para lo que se perdió por una reconexión: un `select` sobre
  `idx_trabajo_encolado`, que en un día típico devuelve **cero filas**. Ese es el "guard de early-exit
  barato" que la regla §5 pide.
- **Nota de portabilidad:** `LISTEN` **no funciona a través de un pooler en modo transacción**. Si el
  hosting introduce uno, el worker se conecta directo (no por el pooler) o degrada a solo-barrido con
  intervalo corto. Es un renglón de configuración, no de código, pero es fácil de olvidar.

### 6.4. Cómo corre el job — la parte delicada

El ADR-0001 §5.2 lo exige: **el job corre con la identidad del usuario que lo solicitó**, no con la
conexión de jobs. Cómo se concilia eso con tomar el trabajo de una cola:

1. **Tomar el trabajo** — con `DbJob` (`BYPASSRLS`), y solo para eso: `update trabajo set estado =
   'corriendo' … where id = (select id … for update skip locked limit 1) returning *`. Es lo único que
   la conexión de jobs toca de esta historia.
2. **Todo el trabajo real** — con `conUsuario(dbRequest, trabajo.solicitado_por, …)`. Las liquidaciones,
   la `VistaBoleta`, la escritura de `documento_liquidacion`: todo bajo RLS, con la identidad de quien
   apretó el botón. Si a esa persona le revocaron la membresía entre el encolado y la corrida, **el job
   falla** — y está bien: falla cerrado, y el error queda escrito en la fila.
3. **La transacción no envuelve el render.** Es la regla de §3.1, y acá es crítica:
   `conUsuario` (leer las vistas del chunk) → cerrar → `generarLote()` de 50 → `ObjectStorage.put()` ×50
   → `conUsuario` (escribir 50 filas + `hechos += 50`) → siguiente chunk. Una transacción abierta 14
   segundos es una conexión secuestrada y una fila bloqueada.
4. **Verificación de path antes de cada escritura** (ADR-0001 §5.2): la `storage_key` tiene que empezar
   por `barrios/{barrio fijado en la fila del trabajo}/`.
5. **Progreso por chunk, no por boleta**: 4 `UPDATE` para 200 boletas, no 200.

### 6.5. Cómo se ve el progreso, y cómo se descarga

**Progreso.** La pantalla `…/liquidacion/[periodo]/emision` hace polling a
`GET /api/trabajos/[trabajoId]`, con **backoff**: primero a los 2 s, después 4, 6, 8, y de ahí cada 10 s,
con techo de 5 minutos; se detiene sola al terminar y hace un `router.refresh()` **una** vez, al final.
Una emisión típica son ~5 requests. Es literalmente la regla §4 del presupuesto ("polling espaciado, no
de pocos segundos") y §4 otra vez ("refrescar al final, no en cascada").

**Nada de SSE ni WebSockets.** Una conexión abierta por administrador, un canal más que operar y que
sobrevivir a un balanceador, para un proceso que dura quince segundos y ocurre doce veces al año por
barrio. La regla §4 del presupuesto es explícita: realtime solo si el negocio lo exige.

**Descarga.** Los PDFs viven en `ObjectStorage` (§7, pieza que también hay que construir).
`GET /api/documentos/[id]` → verifica bajo RLS que la fila es accesible → `getSignedUrl(key, 600)` →
`302` con `Cache-Control: no-store`. **Nunca** se proxea el objeto por Next: sería egress duplicado y el
archivo entero en memoria del proceso web, contra las reglas §1 y §2.h del presupuesto.

---

## 7. El recorrido: pantallas, servicios y qué falta

Rutas según `docs/diseno/06-direccion-visual.md` §c, con `[barrio]` = uuid (§3.4).

| # | Pantalla | Ruta | Servicio de `packages/data` | Estado |
|---|---|---|---|---|
| 1 | **Entrar** (elegir del elenco) | `/entrar` | `AuthProvider.iniciarSesion` + `listarUsuariosDemo` | **Falta todo** (§2) |
| 2 | **Mis barrios** | `/` | `listarBarriosAccesibles` | Falta servicio |
| 3 | **Tablero del barrio** | `/[barrio]/tablero` | `leerBarrio`, `listarPeriodos` | Falta servicio |
| 4 | **Padrón** | `/[barrio]/padron` | `listarPadron` | Falta servicio (hay SQL de referencia en `test/dominio-padron.test.ts`) |
| 4b | **Alta / baja de unidad, obligado** | modal | `altaUnidad`, `bajaUnidad`, `asignarObligado` | Falta servicio |
| 5 | **Períodos** | `/[barrio]/liquidacion` | `listarPeriodos` | Falta servicio |
| 5b | **Crear período** | acción | `crearPeriodo` | Falta servicio |
| 6 | **Gastos del mes** | `/[barrio]/liquidacion/[periodo]/gastos` | `listarGastos`, `listarConceptos`, `registrarGasto`, `anularGasto` | Falta servicio |
| 7 | **Cargos y descuentos** | `/[barrio]/liquidacion/[periodo]/cargos` | `listarConceptosBoleta`, `listarAplicaciones`, `aplicarConceptoAUnidad`, `anularAplicacion` | Falta servicio |
| 8 | **Generar el borrador** | acción | `generarLiquidaciones()` | **Existe y está probado** |
| 9 | **Revisar** (grilla por unidad + totales) | `/[barrio]/liquidacion/[periodo]/revision` | `listarLiquidaciones` | Falta servicio |
| 10 | **Vista previa de una boleta** | `…/revision` → `<iframe>` a `/api/…/vista` | `armarVistaBoleta()` + `solicitudDeBoleta()` + `htmlCompleto()` | **Existe todo** (§4.3) |
| 11 | **Emitir** | acción | `emitirPeriodo()` + `encolarEmision` | Servicio existe; **falta el encolador** |
| 12 | **Progreso de la emisión** | `/[barrio]/liquidacion/[periodo]/emision` | `estadoTrabajo` | Falta (§6) |
| 13 | **Documentos emitidos** | `…/emision` | `listarDocumentos` + `urlFirmadaDocumento` | Falta (§6) |

### 7.1. Los servicios nuevos, contados

**Doce de lectura:** `listarUsuariosDemo`, `listarBarriosAccesibles`, `leerBarrio`, `listarPadron`,
`listarPeriodos`, `leerPeriodo`, `listarGastos`, `listarConceptos`, `listarConceptosBoleta`,
`listarAplicaciones`, `listarLiquidaciones`, `listarDocumentos` (+ `estadoTrabajo`, que va con el
encolador).

**Nueve de escritura:** `altaUnidad`, `bajaUnidad`, `asignarObligado`, `crearPeriodo`, `registrarGasto`,
`anularGasto`, `aplicarConceptoAUnidad`, `anularAplicacion`, `encolarEmision` (+ `registrarDocumento` y
`tomarTrabajo`/`avanzarTrabajo`/`terminarTrabajo`, que son del worker y del encolador).

**Alrededor de 21 servicios de negocio nuevos, más ~5 de la maquinaria de trabajos.** Todos con la misma
firma `(tx: DbConIdentidad, parametros) => Promise<…>` y todos con su subruta en `exports`.

Dos observaciones que abaratan la cuenta:

- **Los de escritura son delgados**, porque el modelo ya hace el trabajo pesado. `aplicarConceptoAUnidad`
  es un `insert` de **siete columnas** (`periodo_id`, `unidad_funcional_id`, `concepto_boleta_id`,
  `fecha_hecho`, `cantidad`, `detalle`, `origen_evaluacion`): las otras dieciocho las pisa
  `app.cbu_antes()` desde el catálogo, y el importe lo escribe `app.resolver_aplicaciones()`. El
  servicio no puede equivocarse con la plata porque **no tiene permiso** de escribirla (migración 0017).
  Lo mismo con `registrarGasto` (`sin_respaldo_asamblea` lo pone el trigger) y con `crearPeriodo` (nace
  en `borrador` por trigger).
- **Los de lectura son donde está el riesgo**, y es de rendimiento: son las queries anchas del padrón y
  de la grilla de revisión, con `accessible_tenant_ids()` corriendo en cada policy. Se escriben como
  `vista-boleta.ts`: consultas contadas y agrupado en memoria, nunca N+1 (regla §2.b). Y **se miden
  antes de indexar** (regla §0).

### 7.2. Lo demás que hay que construir

| Pieza | Dónde | Por qué |
|---|---|---|
| `packages/auth` — interfaz + adapter `dev-suplantacion` | nuevo | §2 |
| `packages/almacenamiento` — `ObjectStorage` sobre `@aws-sdk/client-s3` | nuevo | Está en el ADR-0000 §3.3 como contrato desde hace un año y **no existe**. Sin él no hay descarga. |
| `apps/worker` | nuevo | ADR-0001 §11, §6 de acá |
| Migraciones `usuario_demo`, `trabajo`, `documento_liquidacion` | `packages/data/migrations/` | §2.3, §6.2 |
| Subruta `@admin-barrios/data/client` + una por servicio | `packages/data/package.json` | §3.2, cerrojo 2 |
| `tools/arquitectura/grafo.ts` + `apps/web/src/arquitectura.test.ts` | nuevo | §5.3 |
| Servicio `worker` en `docker-compose.yml` | existente | §6.3 |

### 7.3. Un hueco que va a aparecer en la pantalla 7

`limite_aplicacion_barrio` **no se inserta desde ningún lado** — ni el seed la escribe. `app.cbu_antes()`
falla cerrado sin esa fila: un `operador` no va a poder aplicar un descuento y el mensaje va a ser
oscuro. O el seed la siembra, o la pantalla lo explica, o las dos. Es de `backend-dev` resolverlo al
escribir `aplicarConceptoAUnidad`; queda anotado acá para que no se descubra en la demo.

---

## 8. Qué NO entra en este incremento

Esto es lo que evita que el bloque se estire para siempre. Cada renglón con su motivo:

| Fuera | Por qué, y cuándo entra |
|---|---|
| **Autenticación real** (contraseñas, invitaciones, recuperación, 2FA) | Depende del hosting, que sigue abierto (ADR-0000 §10). El contrato queda escrito (§2.2) y los pendientes enumerados (§2.5). |
| **Alta de barrios, administradores, membresías y subsectores desde la UI** | Es el camino del `admin_plataforma`, no del administrador — y sin auth real no hay a quién invitar. Sigue por seed. |
| **Versionado de coeficientes desde la UI** (crear versión, cargar valores, cerrar) | El recorrido no lo pide: liquida contra la versión cerrada que ya existe. Es una pantalla con reglas propias (`validar_coeficientes` exige coeficiente para toda unidad activa y suma exacta = 1) y merece su tarea. |
| **Modelo de cuota fija** (`cuota_fija_version`, `cuota_fija`) desde la UI | Ídem. `generarLiquidaciones` ya lo soporta; la pantalla no. El recorrido asume modelo `variable`. |
| **Alta del catálogo de conceptos** (de gasto y de boleta) | Se elige de lo sembrado. Un catálogo con vigencias y clasificación fiscal es una pantalla propia. |
| **Subida de documentos** (actas, comprobantes) | `acta_documento_id` sigue viniendo del seed. Requiere `ObjectStorage` **de entrada** más antivirus, tipos permitidos y cuota — y `ObjectStorage` ya es trabajo nuevo solo para la salida. |
| **Cobros, pagos, imputación, estado de cuenta, conciliación** | Módulos enteros del MVP (doc 01 §1.1), cada uno con su tarea. Consecuencia concreta: `saldo_anterior` sigue entrando por parámetro o en cero, y el interés sigue saliendo `mora_pendiente_definicion` si el barrio no tiene tasa. La boleta ya dice eso, correctamente. |
| **Distribución: email, ZIP del período, `FileDestination`** | Es el paso `distribuida` de la máquina de estados y un módulo del MVP. La descarga de este incremento es **por unidad**, con URL firmada. Un administrador con 200 unidades no va a querer 200 clicks — cierto, y por eso el ZIP es lo primero que entra en el incremento siguiente: se arma en el mismo job, que ya tiene los N objetos escritos. |
| **Informe mensual y listado de saldos pendientes en pantalla** | `packages/documentos` los produce, pero el doc 10 tiene pendientes abiertos (retención del listado nominado, gate de rol en la base, el agregado desde su propia query) y hay **trabajo en paralelo** sobre esos archivos. |
| **Paginación y búsqueda server-side del padrón** | 50 unidades en el seed, 200–500 en un barrio real: entra en una tabla. `docs/diseno/06` §e.2 ya fija el patrón (Server Components + `searchParams`) para cuando haga falta. **Medir antes de optimizar.** |
| **`axe-core` en el pipeline** | `docs/diseno/06` §f lo promete y hoy no existe. Es un gate nuevo en CI y una tarea de `qa-automation`; AA se respeta igual desde el día uno, con revisión manual. |
| **Portal del residente y `apps/mobile`** | Falta el vínculo usuario → unidad (§2.5 punto 6) y las policies están cerradas a propósito. |
| **Realtime, notificaciones, bitácora de auditoría en pantalla** | Nada de eso está en el recorrido. |

**Y una cosa que este ADR explícitamente no resuelve:** los pendientes que el HANDOFF le dejó abiertos a
`arquitecto-software` sobre el motor de documentos (`paginasEsperadas: number | "variable"`,
`selloPorPagina`, la retención del listado nominado, la auditoría de `app.resolver_aplicaciones` como
`security definer`). Son del ADR-0001 y de `docs/diseno/10`, están siendo tocados en paralelo, y meterlos
acá sería pisar trabajo en curso.

---

## 9. Encaje con el presupuesto de recursos

| Recurso | Impacto | Cómo queda acotado |
|---|---|---|
| **Conexiones de base** | 1 pool por proceso web, `max: 10` | Transacción **corta** siempre (§3.1); el trabajo lento sale de la transacción (§6.4) |
| **Cómputo web** | Lecturas por Server Component, sin refetch en cascada | Regla §4: caché/ISR donde sirva; el tablero del barrio es render dinámico porque muestra plata de hoy |
| **Cómputo worker** | 14,4 s por barrio de 200 unidades, 12 veces al año | Job por evento, **jamás por cron** (regla §5) |
| **Worker en vacío** | `LISTEN` + un `select` sobre índice parcial cada 60 s, que devuelve cero filas | El "guard de early-exit barato" de la regla §5 |
| **Polling de la UI** | ~5 requests por emisión, con backoff, con techo | Regla §4 |
| **Egress** | Una URL firmada por descarga, TTL 10 min, `no-store`, `302` — el objeto **no** pasa por Next | Reglas §1 y §2.h |
| **Storage** | 73 KB por boleta (medido, ADR-0001 §9) | Sin cambios respecto del ADR-0001 |
| **Imagen** | La app Next sigue en `node:22-alpine` (163 MB); Chromium solo en el worker | Verificado por el test de grafo, que ya existe |
| **CI** | El test de arquitectura entra al proyecto `unit` (gate barato), 40 ms | Sin pasos nuevos en el workflow |

Una nota de honestidad sobre la imagen: `apps/web` va a declarar `@admin-barrios/documentos` como
dependencia (para la vista previa, §4.3), y eso instala `puppeteer-core` en `node_modules` (~12 MB, sin
descarga de navegador). **No entra al bundle** —el grafo lo garantiza— pero sí pesa en la capa de
`node_modules` de la imagen. 12 MB contra 734 MB es una diferencia de dos órdenes de magnitud y no
cambia ninguna decisión; se anota para que nadie se sorprenda.

---

## 10. Consecuencias

- **Aparecen tres unidades nuevas de código** (`packages/auth`, `packages/almacenamiento`, `apps/worker`)
  y tres migraciones. Es el costo real de que el recorrido llegue hasta "descargar los documentos": las
  tres estaban prometidas en ADR-0000 §3.2/§3.3 y ADR-0001 §11, y ninguna existía.
- **La regla de importación deja de ser una sola** (la de Chromium) y pasa a ser un test de arquitectura
  con nueve reglas. Eso tiene un costo: alguna va a molestar en un caso legítimo. La lista blanca es
  explícita por diseño, para que la excepción se vea en el diff y se discuta.
- **`packages/data/package.json` gana subrutas**: `./client` y una por servicio. Es la contrapartida de
  poder decir "la web no importa la raíz" y verificarlo.
- **Se corrige doc 06 §c.1** en dos puntos (la URL no alimenta la RLS; el segmento es el uuid y no un
  slug). Hay que sincronizar ese documento — tarea de `documentador`, no de este ADR.
- **La vista previa de una boleta sale sin worker.** Es la primera vez que el reuso de plantilla única
  del ADR-0001 §3 se cobra de verdad, y es lo que permite que "revisar el borrador" sea una pantalla útil
  aunque el job de emisión todavía no exista.
- **La identidad de dev depende de una fila de base.** Es una dependencia rara —el login necesita la
  base— y es a propósito: es lo que convierte el candado en algo que no se puede desactivar con una
  variable de entorno.
- **Todo lo que este incremento no hace queda escrito en §8.** Si algo de esa lista aparece en un PR de
  este bloque, el PR se rechaza o el ADR se modifica; no las dos cosas a la vez y no en silencio.

---

## 11. Alternativas consideradas

### 11.1. Auth real desde el día uno (Supabase Auth o GoTrue en contenedor)

Descartada **para este incremento**, no para siempre. Levantar GoTrue en el `docker-compose` y usar su
`sub` como `membership.user_id` es perfectamente viable y es probablemente lo que termine pasando. Se
descarta ahora porque encadena tres decisiones que todavía no están tomadas —hosting (ADR-0000 §10),
tabla `usuario` vs `sub` directo (§2.5 punto 2), y modelo de invitaciones— y porque **ninguna de las
tres cambia una línea de las pantallas**. El costo de equivocarse eligiendo hoy es alto; el de esperar,
un adapter de ~80 líneas que se tira.

### 11.2. Suplantación por variable de entorno (`DEV_USER_ID=…`)

Es lo más barato: una variable con el uuid y listo. Descartada por dos motivos concretos. Primero, no
deja **elegir con qué usuario se entra** sin reiniciar el proceso, y la mitad del valor de tener el
sustituto es poder ver el sistema con los ojos de un `operador`, de un `contador` y de alguien de otro
barrio — que es como se descubren los agujeros de RLS *antes* de que los descubra un cliente. Segundo, y
más importante: **una variable de entorno es exactamente lo que alguien puede setear en producción**. El
candado quedaría siendo un `if`, y el enunciado pedía un candado, no una advertencia.

### 11.3. Un middleware de Next que abra la transacción por request

Elegante en apariencia: el middleware resuelve la sesión, abre `conUsuario` y lo deja en un contexto
(`AsyncLocalStorage`) para que cualquier componente consulte "y ya". Descartada por tres razones. El
middleware de Next corre en el runtime Edge, donde `pg` no existe. Una transacción abierta durante todo
el render de la página es exactamente lo que §3.1 prohíbe: dura tanto como la página más lenta.
Y —lo decisivo— una conexión implícita en un contexto ambiental es **lo contrario** de lo que este ADR
busca: hace que consultar la base sea invisible en el código, y lo que tiene que ser imposible de hacer
por accidente no puede ser también invisible.

### 11.4. Una capa de API (`apps/api`, REST o tRPC) desde ahora

Descartada por §4.1: un solo consumidor, endpoints que serían los equivocados para la mobile real (que
es del residente), y duplicación medible de esquemas, cliente y tests. tRPC además suma un acople de
tipos entre `apps/web` y `apps/api` que no viaja a React Native sin fricción. **El gatillo está escrito**
y la costura —la firma de los servicios— ya está puesta.

### 11.5. Emitir dentro de un Route Handler con `maxDuration` alto, o con `after()` de Next

Descartada por los números del ADR-0001 §2 (14,4 s y 520 MB, o 85 s con el plan B), por el techo de 60 s
de una función serverless, y por portabilidad: `after()` es una primitiva de Next que ata la ejecución
diferida al ciclo de vida del request y del proveedor. El job en tabla + worker corre igual en las tres
columnas del ADR-0000 §7.

### 11.6. Una cola gestionada (SQS, Cloud Tasks, Redis/BullMQ)

Descartada **como default**, no como opción. Rompe la fila "self-hosted" del ADR-0000 §7 (Redis se puede
levantar, SQS no), suma un servicio a operar y monitorear, y resuelve un problema de escala —miles de
trabajos por minuto— que este sistema no tiene ni va a tener pronto: doce emisiones por barrio por año.
Queda detrás de `EncoladorTrabajos` para el día que los números cambien.

### 11.7. SSE o WebSocket para el progreso

Descartada por la regla §4 del presupuesto de recursos (realtime solo si el negocio lo exige) y por el
costo operativo: una conexión abierta por administrador, que hay que sostener a través de un balanceador
y reconectar. El trabajo dura quince segundos. Polling con backoff cuesta cinco requests.

### 11.8. Inyectar el HTML de la vista previa en la página con `dangerouslySetInnerHTML`

Descartada por §4.3: mete texto cargado por usuarios en el DOM del origen que tiene la sesión, y mezcla
los estilos de impresión con los de la app. El `<iframe sandbox>` con CSP cuesta un Route Handler.

---

## 12. A confirmar (abierto — no inventado)

- **Adapter de `AuthProvider` para producción** y la decisión `usuario` vs `sub` directo (§2.5). Sigue
  atado al hosting, abierto en ADR-0000 §10.
- **Slug legible en la URL del barrio.** Hoy va el uuid (§3.4). Si se quiere `/los-alamos/...`, es una
  columna `tenant_node.slug` con índice único, y hay que decidir qué pasa cuando un barrio se renombra
  (¿el slug viejo redirige?). Decisión de producto + `ux-designer`.
- **`max` del pool y pooler externo.** Depende del hosting. Si termina siendo serverless, `max: 1` +
  pooler en modo transacción, y el worker se conecta directo por el `LISTEN` (§6.3).
- **TTL de la sesión y política de revocación** (§2.5 punto 4). Decisión de `security-engineer` con el
  adapter concreto sobre la mesa.
- **Reintentos del job de emisión.** La tabla tiene `intento`, pero cuántas veces y con qué espera no se
  decide sin ver un fallo real. Por ahora: **un** intento, y el error visible en pantalla. La
  idempotencia (índice único parcial + una escritura por documento) ya deja la puerta abierta.
- **Retención y purga de la tabla `trabajo`.** Crece 12 filas por barrio por año: no es urgente. Se
  define junto con la retención de documentos, que `legal-ph`/`contador` tienen abierta (ADR-0001 §13).
- **`limite_aplicacion_barrio`** (§7.3): quién la siembra y con qué valores. Es una decisión de
  `administrador-consorcios`, no técnica.
- **Dónde corre el worker en cada hosting** — sigue abierto igual que en ADR-0001 §13.

---

_Ver también `docs/arquitectura/00-stack-infra.md` (ADR-0000: stack, abstracciones, RLS y portabilidad),
`docs/arquitectura/01-generacion-de-documentos.md` (ADR-0001: motor de documentos, job de emisión y la
regla de importación que este ADR extiende), `docs/diseno/06-direccion-visual.md` (navegación, tokens,
patrones de UI y accesibilidad — este ADR corrige su §c.1),
`docs/diseno/01-alcance-modulos.md` (alcance del MVP) y
`docs/devops/03-reglas-desarrollo-optimizado.md` (presupuesto de recursos)._
