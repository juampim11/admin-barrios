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
      // Vuelta 2 (§2.4). Defensa en profundidad, NO candado: el `Host` lo elige el cliente.
      // Normalizado de verdad: con `Host: [::1]:4000`, un `split(":")[0]` devuelve `"["`.
      if (!esHostLocal(entrada.headers.get("host"))) return null;

      // El valor de la cookie es un string del cliente que termina en `set_config('app.user_id', …)`.
      // Sin este parseo, un valor no-uuid hace reventar `app.current_user_id()` en CADA evaluación de
      // policy, con un error crudo de Postgres.
      const id = z.string().uuid().safeParse(entrada.cookies.get(COOKIE));
      if (!id.success) return null;

      // Se revalida en CADA request contra la tabla: vaciar `usuario_demo` invalida todas las sesiones.
      const usuario = await deps.buscarUsuarioDemo(id.data);
      return usuario ? { identidad: {...}, expiraEn: …, origen: "dev-suplantacion" } : null;
    },
  };
}
```

`iniciarSesion()` hace **el mismo** chequeo de host que `sesionDe()`: la cookie es un uuid en claro y
quien alcance la app la puede poner a mano sin pasar por el inicio de sesión.

**Por qué una tabla y no una lista en el código ni un `.env`:** porque el candado más fuerte que se
puede poner es que **en producción no haya a quién suplantar**. Una lista en el código viaja al
contenedor; una variable de entorno se puede setear; una fila que solo escribe el seed —y el seed
solo corre en desarrollo— **no está**. El candado deja de depender de la configuración y pasa a
depender de los datos, que es un lugar mucho más difícil de romper por accidente.

**Por qué la lista se lee sin identidad y por qué eso no es un agujero — verificado, no argumentado.**
Es la pantalla de entrada, la tabla contiene el elenco ficticio del seed, no tiene grant de escritura
para ningún rol de la app y en producción devuelve cero filas. Como eso es un argumento y no un
control, se convierte en tres `select` del proyecto `db`: (a) `pg_policies` tiene **exactamente una**
policy permisiva con `qual = 'true'` en todo el esquema, y es `usuario_demo_sel`; (b) las columnas de
`usuario_demo` son exactamente las cinco declaradas; (c) `information_schema.role_table_grants` no
muestra `insert`/`update`/`delete` sobre `usuario_demo` para `app_request` **ni para `app_job`** —
este último importa solo por el grant, porque con `BYPASSRLS` las policies nunca lo tocan. Más una
cuarta verificación, en el arranque de la app: si `APP_ENTORNO <> "local"` y `usuario_demo` tiene
filas, el proceso **lanza**. Ahí la vuelta 3 del candado deja de ser una suposición sobre el seed y
pasa a ser algo que la app comprueba.

La cookie de producción no se parece a la de dev, y conviene decirlo para que el sketch no se copie
como plantilla: prefijo `__Host-`, `httpOnly`, `secure`, `sameSite: "lax"`, `path: "/"`.

**Por qué no se enumera `membership`:** porque leer `membership` requiere pasar
`accessible_tenant_ids()`, que requiere identidad — el huevo y la gallina. La salida "usar la conexión
`BYPASSRLS` para armar la pantalla de login" es exactamente el patrón que este ADR prohíbe en §3, y no
se hace ni siquiera una vez ni siquiera en desarrollo.

**Cómo quedó construida la pantalla, y qué de eso es cerrojo** *(implementada el 2026-08-07)*. La
forma visual está en `docs/diseno/06-direccion-visual.md`; acá va solo lo que toca a este ADR y **se
verifica en el gate** (§5.2, reglas 10b–10e):

- **No tiene ni un `<input>`.** No es una decisión de layout: **un campo que no verifica nada es una
  afirmación falsa sobre la seguridad del producto**, y uno de texto libre convertiría el formulario
  en un delator del elenco (se tipea un nombre y el sistema contesta si existe). La regla se afirma
  **en positivo** —"esta pantalla no tiene ningún campo"— porque enumerar tipos prohibidos es una
  carrera que se pierde: `type={"pass" + "word"}` la esquiva.
- **Un solo `<form>`, que envuelve la lista**, y el `usuarioId` viaja en el `value` del botón
  `submit` de cada persona. Un formulario por persona no es incorrecto, pero deja la etiqueta adentro
  del `.map()` y vuelve incontable —y de paso habilita el envío implícito—. Nada de campos ocultos.
- **La etiqueta de rol que se muestra se DERIVA del mismo `rol` que se inserta en `membership`**
  (`packages/data/src/servicios/usuarios-demo.ts` es el único dueño del formato). Un chip que dijera
  OPERADOR mientras la RLS aplica `contador` no es un bug cosmético: es la demo mintiendo sobre lo
  único que la demo viene a mostrar.
- **La declaración de que es un entorno de demostración va arriba de todo, y la ruta es dinámica.**
  Un build que dejara `/entrar` estática congelaría el elenco en el artefacto.
- **La pantalla no importa `@admin-barrios/auth` por su cuenta** (regla 10b): podría fabricarse una
  `EntradaHttp` con un `Host` inventado y apagar sola la vuelta 2 del candado.

### 2.4. El candado — cuatro vueltas, y cuál de ellas aguanta sola

Ninguna es una advertencia en un README.

| # | Vuelta | Qué impide | Cómo se verifica |
|---|---|---|---|
| **1** | **El proceso no atiende.** `crearAuthProvider()` es la única fábrica. Valida el entorno con Zod y exige **`APP_ENTORNO`** (`local` \| `staging` \| `produccion`), obligatoria y **sin default**. El sustituto se habilita **solo** si `APP_ENTORNO === "local"` — **lista de permitidos, no de prohibidos**. La validación se dispara además desde `apps/web/src/instrumentation.ts` (hook `register()` de Next, que corre al levantar el servidor). | Que un despliegue con el sustituto activo llegue a atender. Y que la falla llegue tarde: **sin el `instrumentation.ts` esto no se cumple** — Next carga los módulos de ruta perezosamente y un `throw` de módulo aparece recién en el primer request que toque esa ruta, como un 500, con el contenedor "sano" para el orquestador. | Test unitario (`packages/auth/src/registro.test.ts`): para **cada** valor de `APP_ENTORNO` distinto de `"local"` —incluidos `undefined` y la cadena vacía— la fábrica con el sustituto **lanza**. Entra en `pnpm test`. |
| **2** | **No atiende fuera de la máquina** — *defensa en profundidad, **no** candado*. `sesionDe()` **y** `iniciarSesion()` devuelven `null` si el `Host` normalizado no está en `{localhost, 127.0.0.1, ::1}`. | Sube el costo de un despliegue expuesto por accidente. **No alcanza sola:** el `Host` lo manda el cliente. `curl -H 'Host: localhost' http://<ip>:4000/` llega a Next —este `docker-compose.yml` publica el 4000 en todas las interfaces— y pasa. Detrás de un proxy, `x-forwarded-host` es igual de falsificable. | Test unitario: `Host` remoto → `null`; `[::1]:4000` → sesión (el caso que un `split(":")[0]` rompe). |
| **3** | **No hay a quién suplantar.** `usuario_demo` la escribe **solo el dueño del esquema**, y no hay grant de escritura para ningún rol de la app. El seed que la llena (`seed-demo.ts`) ya se niega a correr con `NODE_ENV=production`, igual que `setup-dev.ts`. | Que el adapter, aun habilitado y aun local, produzca una identidad. **Falla cerrado por datos, no por configuración.** | Test de base (proyecto `db`): con `usuario_demo` vacía, `iniciarSesion` y `sesionDe` devuelven "no hay elenco". Más los tres `select` de §2.3 y la aserción de arranque. |
| **4** | **CI mira quién lo importa.** El test de arquitectura (§5.3) falla si algún archivo de `apps/web/src` importa `packages/auth/src/adapters/dev-suplantacion.ts`: la **única** referencia permitida en todo el repo es la rama guardada de la fábrica. | Que alguien lo instancie a mano y se saltee la fábrica —que es donde vive la vuelta 1. | `pnpm test` (proyecto `unit`). |

⚠ **Deuda abierta de la vuelta 1: `instrumentation.ts` es la única pieza que la sostiene, y de esa
pieza no se verifica nada** *(anotado el 2026-08-07, es trabajo de `devops`)*. Desde que los recursos
de `apps/web` se arman **perezosamente** —el cambio que hizo que compilar dejara de exigir las
credenciales de producción— ya no hay ninguna constante de módulo que explote al importar: el hook
`register()` de Next quedó solo. Y un test puro **no puede probar** las dos cosas que importan: que
Next efectivamente llame a `register()` al levantar el servidor, ni que un rechazo ahí **aborte** el
arranque en vez de quedar logueado. Si Next loguea y sigue, el contenedor queda verde, el health-check
pasa, el despliegue se da por bueno y **cada request devuelve 500**. Lo que cierra esto es de
plataforma, no de código: una verificación de arranque real y un **health-check que toque una ruta que
ejercite los recursos** (un endpoint que responde 200 sin abrir la base no prueba que el proceso pueda
atender).

**Lo que sí quedó verificado adentro del proceso** *(2026-08-07)*: el rechazo de las credenciales que
no le tocan (`DATABASE_URL`, `DATABASE_URL_JOB` — cerrojo 5 de §3.2) tiene tests propios en
`apps/web/src/servidor/configuracion.test.ts`. Antes estaba verificado **solo sobre el
`docker-compose.yml`**: se comprobaba que el archivo no las pasara, no que el proceso las rechazara si
llegaban igual, que es justo el caso contra el que ese cerrojo existe. *(Para poder testear ese módulo
hay que resolver `server-only` a su entrada vacía en Vitest — la misma que usa React del lado del
servidor.)*

**Por qué `APP_ENTORNO` y no `NODE_ENV`.** `NODE_ENV` es una señal de **modo de build**, no de entorno
de despliegue: hay razones legítimas para correr un entorno real con `NODE_ENV=development` (mensajes
de error completos, un preview). Una condición `=== "production"` **falla abierta** para todo lo demás
—`undefined`, `"Production"`, `"prod"`, `"staging"`— y este repo ya está exactamente en esa situación:
`.env.example` fija `NODE_ENV=development` y el servicio `app` de `docker-compose.yml` se lo pasa tal
cual, con el puerto publicado en todas las interfaces. Una variable propia, obligatoria y evaluada
como lista de permitidos no tiene ese modo de falla. (Consecuencia: hay que agregar `APP_ENTORNO` a
`.env.example` y sincronizar el `AUTH_PROVIDER=` vacío, que hoy contradice el "obligatorio y sin
default" y ni siquiera lista `dev-suplantacion`.)

**De las cuatro vueltas, una sola es un candado, y hay que decirlo.** La **3** es independiente y
alcanza sola: con `usuario_demo` vacía no se emite ninguna identidad, y lo peor que pasa es que nadie
entra. La **1** es un gate de configuración y vale lo que valga la variable contra la que esté escrita
—por eso `APP_ENTORNO`—. La **4 no es independiente**: existe para proteger a la 1. La **2** es
defensa en profundidad y se rodea con un header. Escribirlo así no debilita el diseño: lo hace
auditable, y evita que alguien afloje la vuelta 3 —la única que aguanta— creyendo que hay tres más
atrás.

Y una nota de honestidad sobre la vuelta 3: que `seed-demo.ts` use `set session_replication_role =
replica` (que exige superusuario y por eso no corre en un Postgres administrado) es un **accidente
afortunado**, no un control. Esa línea está ahí para desactivar triggers, y un refactor que la saque
elimina la protección sin que nadie lo note. El control real son dos cosas verificables: la tabla
vacía y la ausencia de grant de escritura para todo rol de la app.

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
  // El vencimiento se rechaza en LA PUERTA, no en cada adapter: así ningún adapter futuro puede
  // olvidárselo, y el que lo implemente mal falla acá y no en una policy.
  if (!sesion || sesion.expiraEn <= new Date()) redirect("/entrar");
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

Una nota sobre el vencimiento, para no disimular: la cookie del sustituto de desarrollo no lleva marca
de emisión ni firma, así que su `expiraEn` es una constante y **no vence de verdad**. El vencimiento
efectivo es propiedad del adapter de producción; ese renglón de `conSesion()` es el contrato que ese
adapter va a tener que cumplir, y el lugar donde se va a cumplir sin que nadie tenga que acordarse.

**`redirect()` y `notFound()` funcionan lanzando. Dos consecuencias con dientes:**

- **Nunca se llaman adentro de `conSesion`.** El throw dispara el `ROLLBACK` y una escritura ya hecha
  se pierde en silencio, sin error y sin log. Se navega **después** de que la transacción cerró. En el
  caso de lectura de §3.4, el `notFound()` va en el `layout.tsx`, sobre el resultado vacío que
  `conSesion` ya devolvió — no adentro del callback.
- **Nunca se los captura.** Un `catch` ancho alrededor de `conSesion` se traga el `NEXT_REDIRECT` que
  manda al login cuando no hay sesión, y lo muestra como un error de formulario: la sesión vencida se
  ve como "algo salió mal" y la persona reintenta contra un formulario muerto. `mensajeDeError()`
  re-lanza todo error de control de flujo de Next (`isRedirectError` / `isNotFoundError` de
  `next/navigation`) **antes** de traducir nada.

**La única excepción a la puerta única, y por qué es una y no un patrón.** `/entrar` necesita leer
`usuario_demo` **sin sesión**: es el huevo y la gallina del login. Esa excepción vive en el **mismo
módulo**, se llama `conIngreso()`, y está acotada por tres cosas:

- La fábrica la devuelve **solo** si el provider activo tiene `aptoParaProduccion === false`. Con el
  adapter real, `conIngreso` no existe y llamarla lanza.
- Ejecuta con `sinUsuario()` —sin identidad, con la RLS activa—, así que lo único que puede leer es lo
  que tenga una policy `using (true)`: hoy `usuario_demo` y nada más. **No es una conexión
  privilegiada**: es la misma conexión de request, sin identidad.
- El test de arquitectura (§5.2, regla 10) falla si `conIngreso` se referencia desde cualquier archivo
  que no sea `src/app/entrar/`.

Lo que **no** se hace, ni una vez ni en desarrollo, es usar `DbJob` para armar la pantalla de login.
Ya está dicho en §2.3 y se repite acá porque es donde la tentación aparece.

### 3.2. Cinco cerrojos, en cinco planos distintos

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

**Y `conUsuario()` verifica que la identidad quedó puesta.** El `select set_config('app.user_id', $1,
true)` ya devuelve el valor efectivo: se compara con el uuid pedido y se lanza si no coinciden. Cuesta
cero round-trips y convierte el único modo de falla silencioso que queda —"la identidad no se seteó,
la RLS devuelve cero filas, la pantalla se ve vacía"— en un error ruidoso. Un `default deny` que se ve
igual que "este barrio no tiene gastos cargados" es un `default deny` que nadie va a descubrir.

**Cerrojo 5 — el proceso no tiene la credencial.** Los cuatro de arriba dificultan **escribir** el
código que abre la conexión equivocada. Ninguno impide que la credencial **esté ahí**, y hoy está: el
servicio `app` de `docker-compose.yml` recibe las tres URLs, incluidas `DATABASE_URL_JOB`
(`BYPASSRLS`) y `DATABASE_URL` (dueño del esquema).

> El contenedor de `apps/web` recibe **una sola** URL de base: `DATABASE_URL_APP`. Las otras dos se
> sacan del servicio `app` de `docker-compose.yml` y de todo manifiesto de despliegue, y
> `apps/web/src/servidor/configuracion.ts` **lanza al arrancar** si las encuentra definidas — es una
> aserción de arranque, no un campo opcional del esquema. El worker es la contraparte: recibe
> `DATABASE_URL_JOB` **y** `DATABASE_URL_APP` (necesita las dos, §6.4), y **nunca** `DATABASE_URL`.

Es el único de los cinco que sigue valiendo frente a algo que no escribimos nosotros: una dependencia
comprometida, un `postinstall` malicioso, un SSRF que alcance `/proc/self/environ`. Contra eso, los
cerrojos 1–3 son estáticos y de tiempo de build (no valen nada en runtime) y el 4 tampoco sirve, porque
`app_job` saltea la RLS por definición. Y es el que sostiene la vuelta 3 del candado de §2.4: con la
credencial del dueño del esquema en el entorno de la web, "`usuario_demo` la escribe solo el seed"
deja de ser cierto.

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

### 3.5. Lo que la RLS de hoy **no** filtra, y qué habilita este incremento

Las policies de `select` de dominio (`0003_dominio_rls.sql`) y de expensas (`0005_expensas_rls.sql`)
son `barrio_id in (select app.accessible_tenant_ids())`, **sin gate de rol**. Las de cargos y
descuentos (`0016`) sí lo tienen: agregan `app.has_role_on(barrio_id, roles_lectura)`, con
`roles_lectura = {admin_plataforma, admin_barrio, operador, contador, auditor}` — y el comentario de
esa migración explica por qué: lo que ahí se filtra no es un monto sino el **motivo**, que es un dato
personal sensible sobre un tercero.

O sea: **"barrios hermanos no se ven" se cumple; "vecinos no se ven" no.** Dentro de un barrio,
cualquier membresía con cualquier rol lee el padrón completo (PII de todos los propietarios), todos los
gastos y todas las liquidaciones de todas las unidades. Hoy es teórico porque no hay login ni
membresías de `propietario`. **Este ADR entrega el login.**

Hasta que exista la migración que lleve el patrón de `0016` a las tablas de `0003` y `0005`:

1. **No se crea ninguna membresía con rol `propietario` ni `residente`** — ni desde el seed, ni en el
   elenco de `usuario_demo`. Es una **precondición de seguridad**, no un recorte de alcance: el día que
   alguien siembre un `propietario` "para ver cómo se ve", ve todo el barrio.
2. Un test del proyecto `db` lo verifica y falla el gate:
   `select count(*) from membership where rol in ('propietario','residente')` tiene que dar cero.
3. Las tablas nuevas de este ADR —`trabajo` y `documento_liquidacion` (§6.2)— **nacen con el gate de
   rol de `0016`**. Que la RLS vieja esté abierta no es motivo para escribir la nueva igual de abierta.
4. Cerrar `0003`/`0005` es prerequisito del portal del residente, junto con el vínculo usuario → unidad
   (§2.5 punto 6). Queda en §12.

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

  // OJO: el `try` envuelve la llamada al SERVICIO, nunca a `conSesion`. `conSesion` puede hacer
  // `redirect("/entrar")`, que en Next funciona LANZANDO: un `catch` acá afuera se lo tragaría y la
  // sesión vencida se vería como un error de formulario (§3.1).
  const resultado = await conSesion(async (tx) => {
    try {
      // El servicio deriva el barrio del período bajo RLS. La acción no le pasa un `barrioId`.
      return { ok: true as const, gasto: await registrarGasto(tx, entrada.data) };
    } catch (e) {
      return { ok: false as const, mensaje: mensajeDeError(e) };   // traduce, no decide
    }
  });

  if (!resultado.ok) return resultado;
  revalidatePath(`/${barrioId}/liquidacion/${entrada.data.periodoId}/gastos`);
  return { ok: true, gastoId: resultado.gasto.id };
}
```

Cuatro cosas que **no** hace y que son violaciones (§5.2): calcular un importe, decidir si el período se
puede editar (lo decide el trigger `app.periodo_editable`), filtrar por `barrio_id` (lo decide la RLS), y
confiar en que solo la propia UI la llama.

Ese último punto merece su renglón: **una Server Action es un endpoint POST público** identificado por
un id opaco. Next 15 valida `Origin`/`Host` por defecto —y hay que dejar `serverActions.allowedOrigins`
configurado en `next.config.mjs` cuando haya dominio—, pero eso es protección contra CSRF, **no**
autorización. La autorización es siempre: sesión (§3) + Zod + la base.

**`mensajeDeError` es una lista de permitidos, no un `e.message`.** Traduce por `code` de Postgres y
por un conjunto **cerrado** de errores de dominio conocidos; para todo lo demás devuelve un texto
genérico más un identificador de correlación, y escribe el detalle completo en el log del servidor. El
motivo es concreto y este esquema lo tiene por todos lados: los `raise exception` interpolan valores de
filas (`'el concepto "%" no tiene valor vigente al %'`, `'el descuento puede llegar a % y el tope del
operador es %'`, `'el período % no existe'`), y un `unique_violation` de Postgres trae el valor en
conflicto en el `detail` — que puede pertenecer a una fila que el usuario **no puede leer** bajo RLS.
La RLS filtra el `select`; no filtra el mensaje de error. Un canal de error que hace pasar `e.message`
es un `select` que no pasó por la RLS. La misma regla vale para la columna `error text` de `trabajo`
(§6.2): lo que el worker escribe ahí lo lee después una pantalla.

### 4.3. Los tres Route Handlers, y por qué cada uno tiene que serlo

| Ruta | Por qué no puede ser una acción |
|---|---|
| `GET /api/documentos/[documentoId]` | Devuelve un `302` a una URL firmada, con `Cache-Control: no-store`. Una Server Action no devuelve una respuesta HTTP: devuelve un valor serializado. |
| `GET /api/trabajos/[trabajoId]` | Es polling: un `GET` barato y repetido desde el navegador. Además es, textualmente, el primer endpoint que la mobile va a reusar sin cambios. |
| `GET /api/liquidaciones/[id]/vista` | Devuelve el **HTML del documento**, servido a un `<iframe sandbox>`. Ver abajo. |

**La vista previa merece una decisión propia.** `packages/documentos` ya expone, por su entrada pública
`.` (la que el test de grafo garantiza que no arrastra Chromium), todo lo necesario para producir el
HTML de una boleta: `solicitudDeBoleta()` + `htmlCompleto()`. O sea que **la vista previa de una boleta
sale sin worker, sin Chromium y sin PDF** — es exactamente el reuso de plantilla única que el ADR-0001
§3 puso como primer fundamento, cobrado por primera vez.

Se sirve en un **`<iframe sandbox>` desde un Route Handler**, y no inyectando el markup en la página con
`dangerouslySetInnerHTML`, por dos razones: el documento trae texto cargado por el administrador (nombre
de concepto, detalle de un cargo, título de un acta) y SVG generado, y meterlo en el DOM de la app
autenticada es una superficie de XSS dentro del origen que tiene la sesión; y los estilos del documento
son de impresión y pisarían los de la app.

La respuesta va con este juego de headers, completo:

```http
Content-Type: text/html; charset=utf-8
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:;
                         font-src data:; form-action 'none'; base-uri 'none';
                         frame-ancestors 'self'; sandbox
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Referrer-Policy: no-referrer
Cache-Control: no-store
Vary: Cookie
```

Renglón por renglón, porque cada uno tapa algo distinto:

- **`form-action`, `base-uri` y `frame-ancestors` no heredan de `default-src`** — es una de las trampas
  clásicas de CSP. Sin ellos, un `<form action="https://…">` inyectado en el detalle de un cargo postea
  a donde quiera, y cualquier sitio puede enmarcar la vista dentro de la sesión de la víctima.
- **`font-src data:` no es cosmético, y su ausencia rompe la funcionalidad.** El ADR-0001 §3.2 embebe
  las fuentes con `@font-face` en `data:`, y `font-src` **sí** cae a `default-src 'none'`. Sin esa
  directiva la vista previa se renderiza con la fuente de fallback y **deja de ser una vista previa del
  PDF**, que es la única razón por la que existe — y se descubre tres semanas después.
- **`sandbox` en la respuesta, además del atributo del `<iframe>`.** Sin tokens: origen opaco, sin
  scripts, sin formularios, sin popups. Y vale también cuando alguien abre la URL de primer nivel,
  donde el atributo del iframe no existe.
- **`no-store` + `Vary: Cookie`**: es la boleta de una unidad servida bajo sesión. No tiene por qué
  quedar en un caché compartido ni en el disco del navegador.
- **La CSP es la segunda línea, no la primera.** La primera es el escapado de la plantilla (ADR-0001
  §3.2). Va con su test: meter `</style><script>alert(1)</script>` y `"><img src=x onerror=…>` en el
  `detalle` de un cargo y en el nombre de un concepto, y verificar que salen escapados en el HTML
  servido. `style-src 'unsafe-inline'` significa que romper el `<style>` es el camino a probar.

Es, además, la misma guarda anti-SSRF del ADR-0001 §3.2 aplicada al canal web.

**Y la ruta pierde el segmento de barrio:** `GET /api/liquidaciones/[id]/vista`, no
`/api/barrios/[barrio]/liquidaciones/[id]/vista`. El handler deriva el barrio de la fila bajo RLS
(§3.4); un segmento de barrio que la ruta recibe y no usa es una invitación a que el próximo que la
toque lo use para filtrar.

Una regla de §3.1 que aplica acá con fuerza: el logo se trae de `ObjectStorage` y se inyecta como
`data:` **antes** de renderizar. Eso es I/O lento y va **fuera** de `conSesion`: leer bajo sesión →
cerrar → traer el logo → armar el HTML.

---

## 5. Decisión — Dónde termina `apps/web` y empieza `packages/`

### 5.1. La regla, en una línea

> `apps/web` hace **cuatro** cosas: routing, sesión, presentación y traducción de errores a mensajes.
> Todo lo demás está en `packages/`.

### 5.2. Qué es una violación, concretamente

No "meter lógica en el cliente". Cosas **detectables**, una por una (las de ADR-0003 —`UI-1` a `UI-8`—
y las de encoding —14, 14b, 15— viven en el mismo archivo de test y en su propio ADR):

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
| 10 | Referenciar `conIngreso` fuera de `src/app/entrar/` | Es la única excepción a la puerta única (§3.1). Una excepción sin cerco se convierte en un `sinSesion()` genérico en la primera semana. |
| 10b | Importar `@admin-barrios/auth` desde fuera de `apps/web/src/servidor/` | §2.4, vuelta 2. Con acceso directo al paquete, una pantalla puede armarse su propia `EntradaHttp` con un `Host` inventado y apagar sola el chequeo de host. Va por el caminante de especificadores (como 1, 2 y 2b), no por regex: un `import()` dinámico esquivaba la primera versión. |
| 10c | Que la pantalla de entrada tenga **cualquier** `<input>`, o que `packages/ui` tenga una pieza de credencial | §2.3. Un campo que no verifica es una afirmación falsa sobre la seguridad. Se afirma **en positivo** —"no hay ningún campo"— porque la primera versión enumeraba tipos prohibidos y `type={"pass" + "word"}` la esquivaba. |
| 10d | Que `/entrar` deje de declararse dinámica, o de declarar que es un entorno de demostración | Un build que la deje estática congela el elenco en el artefacto. La regla ancla en la prop y en el texto exacto: la primera versión buscaba la palabra "demostración" en el archivo y **sobrevivía a borrar la banda entera**, porque la palabra aparece por otros motivos. |
| 10e | Que el `<form>` del elenco no envuelva la lista, que haya uno adentro del recorrido, o que vuelva un campo oculto | §2.3. El `usuarioId` viaja en el `value` del botón `submit`. La primera versión contaba etiquetas `<form` literales y **pasaba en verde sobre la forma que prohibía** (un formulario por persona = una sola etiqueta, adentro del `.map()`). |
| 11 | En **`apps/worker`**: referenciar `DbJob` fuera de `apps/worker/src/servidor/cola.ts` | El worker es el único proceso que legítimamente tiene la conexión `BYPASSRLS`, y hasta acá no tenía ninguna regla. El cerrojo 1 impide pasarle `DbJob` a un servicio (no compila), pero `dbJob.execute(sql\`…\`)` compila perfecto. Ese módulo exporta solo `tomarTrabajo` / `avanzarTrabajo` / `terminarTrabajo`; todo lo demás del worker recibe `DbConIdentidad`. |

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
3. **Nuevo:** `apps/web/src/arquitectura.test.ts`, con las reglas de §5.2. El proyecto `unit` de
   Vitest ya incluye `apps/*/src/**/*.test.ts`: entra al gate barato sin tocar la configuración.

Las reglas 1–4 y 9–11 se verifican con el grafo (o con la lista de imports del archivo, para 9–11; la
11 camina desde `apps/worker/src`, no desde la web). Las 5–8 se verifican con una pasada de expresiones
regulares sobre los fuentes de `apps/web/src`, con una lista blanca **explícita y chica** por regla. Es tosco y es a propósito: una regla de estilo que se puede
verificar con `grep` en 40 milisegundos y falla el build vale más que un lint sofisticado que nadie
configura. Cuando alguna genere ruido, se discute la excepción en un PR — que es donde se tiene que
discutir. La **10b** camina el grafo como 1–4; las **10c–10e** son afirmaciones sobre el texto de la
pantalla de entrada y sobre el kit.

**Cómo se da por buena una regla nueva — y no es "corrió y pasó"** *(regla agregada el 2026-08-07,
después de que dos de las cuatro reglas nuevas nacieran rotas)*:

1. **Una regla de gate no está terminada hasta que se la vio FALLAR contra el código que prohíbe.** No
   es una formalidad: la 10e **pasaba en verde sobre exactamente la forma que decía prohibir** (contaba
   etiquetas `<form` literales, y un formulario por persona deja una sola, adentro del `.map()`), y la
   10d sobrevivía a borrar la banda entera que exigía. Una regla que se lee como cerrojo y es un cartel
   es peor que no tenerla, porque invita a confiar. Es el mismo espíritu del **test de control** que ya
   tenía el caminante de Chromium, aplicado a toda regla nueva.
2. **Enumerar lo prohibido es una carrera que se pierde siempre.** Cuando se pueda, **afirmar en
   positivo lo que sí tiene que ser cierto**. La 10c pasó de listar tipos de campo —esquivada dos veces,
   con `type={"password"}` y con `type={"pass" + "word"}`— a afirmar que **esa pantalla no tiene ni un
   `<input>`**. Una condición sobre la etiqueta entera no se rodea con una concatenación.

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

**a) La tabla `trabajo`** (migración nueva). RLS con el patrón de siempre **menos el `update`**:
`select` por `accessible_tenant_ids()` **más el gate de rol de `0016`**, `insert` por
`has_role_on(barrio_id, {admin_plataforma, admin_barrio, operador})`, y **ni `update` ni `delete` para
`app_request`** — ni policy ni grant. La fila la avanza el worker (`app_job`), que es el único con
`grant update`.

El motivo es directo y hay que entenderlo antes de escribir el SQL: **`solicitado_por` no es una firma
de auditoría, es la identidad bajo la cual el worker va a correr el lote** (§6.4). Una fila cuya
identidad de ejecución la puede escribir —o editar después— quien la creó, es una escalada de
privilegios: un `operador` encola con el uuid de un `admin_plataforma` y la emisión entera corre con
esa identidad. Es exactamente el bug que `0013_seguridad_periodo.sql` §3 arregló para `emitida_por`.
Por eso, igual que con `app.cbu_antes()` (`0017`) y `app.periodo_transicion()` (`0013`): **el request
manda `tipo` y `referencia_id`, y todo lo demás lo escribe la base.**

```sql
-- packages/data/migrations/0019_trabajos.sql — ilustrativo
-- `tipo` es enum, no text: es la columna que decide QUÉ CÓDIGO CORRE en el worker.
create type app.tipo_trabajo   as enum ('emitir_documentos_periodo');
create type app.estado_trabajo as enum ('encolado','corriendo','terminado','fallado');

create table trabajo (
  id             uuid primary key default gen_random_uuid(),
  barrio_id      uuid not null references tenant_node(id),
  tipo           app.tipo_trabajo not null,
  referencia_id  uuid not null,                             -- el periodo_id
  estado         app.estado_trabajo not null default 'encolado',
  hechos         integer  not null default 0,
  total          integer,
  intento        smallint not null default 0,
  solicitado_por uuid not null,
  solicitado_at  timestamptz not null default now(),
  iniciado_at    timestamptz,
  terminado_at   timestamptz,
  error          text
);

create or replace function app.trabajo_antes_insert() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_barrio  uuid;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un trabajo sin autor no se encola';
  end if;

  -- El barrio se DERIVA de la referencia, bajo RLS, en la base. No viene en el insert.
  -- FALLA CERRADO si no se puede resolver (misma regla que `app.periodo_editable` de 0013).
  if new.tipo = 'emitir_documentos_periodo' then
    select barrio_id into v_barrio from periodo_expensa where id = new.referencia_id;
  end if;
  if v_barrio is null then
    raise exception 'no se pudo derivar el barrio de la referencia %: se rechaza por seguridad',
      new.referencia_id;
  end if;

  new.barrio_id      := v_barrio;
  new.solicitado_por := v_usuario;
  new.solicitado_at  := now();
  new.estado         := 'encolado';
  new.hechos         := 0;
  new.intento        := 0;
  new.iniciado_at    := null;
  new.terminado_at   := null;
  new.error          := null;
  return new;
end; $$;

create trigger trg_trabajo_antes_insert before insert on trabajo
  for each row execute function app.trabajo_antes_insert();

-- Idempotencia (ADR-0001 §5.3): un solo trabajo pendiente por (referencia, tipo).
create unique index uq_trabajo_pendiente on trabajo (referencia_id, tipo)
  where estado in ('encolado','corriendo');

-- El barrido de rezagados del worker (§6.3) toca este índice y normalmente devuelve cero filas.
create index idx_trabajo_encolado on trabajo (solicitado_at) where estado = 'encolado';
```

> El orden de evaluación es el correcto y no es casualidad: en Postgres el `with check` de la policy
> de `insert` se evalúa sobre la fila **final**, después de los triggers `before`. La policy ve el
> `barrio_id` derivado, no el que mandó el cliente. Es el mismo mecanismo del que ya depende
> `app.cbu_antes()`.

Con `insert` + `select` solamente, la única forma de encolar es la prevista y la única forma de cambiar
el estado es el worker. Sin eso, el trigger no alcanza: se inserta limpio y **después** se hace
`update trabajo set solicitado_por = …` antes de que el worker lo tome, o se vuelve `fallado` →
`encolado` para re-ejecutar, o se mueven `hechos`/`total` para falsear el progreso. Y el rol de request
no tiene ningún motivo para actualizar `trabajo`: cancelar no está en el alcance (§8).

**b) La tabla `documento_liquidacion`** — la del ADR-0001 §6, que hasta hoy es ilustrativa: append-only,
con `storage_key unique`, `sha256`, `vista jsonb`, `vista_version`, `motor`, `plantilla_hash`,
`medio_cobranza`, `emitido_por` escrito por la base. Sin `update` ni `delete` para el rol de request.
**Nace con el gate de rol de `0016`**, no con el patrón abierto de `0005`: su `vista jsonb` congelada
es la boleta completa de una unidad —destinatario, importes, detalle de cargos— y no corresponde que la
lea toda la membresía del barrio (§3.5). Y lleva el `check` de `storage_key` de §6.4.

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
   **Que ese uuid sea confiable no es una convención de la aplicación:** lo escribe
   `app.trabajo_antes_insert()` desde `app.current_user_id()`, y la fila no es actualizable por el rol
   de request (§6.2). Si esa garantía se cae, este paso deja de ser "correr en nombre de alguien" y
   pasa a ser "correr como quien diga el atacante".
3. **La transacción no envuelve el render.** Es la regla de §3.1, y acá es crítica:
   `conUsuario` (leer las vistas del chunk) → cerrar → `generarLote()` de 50 → `ObjectStorage.put()` ×50
   → `conUsuario` (escribir 50 filas + `hechos += 50`) → siguiente chunk. Una transacción abierta 14
   segundos es una conexión secuestrada y una fila bloqueada.
4. **La `storage_key` no se verifica: se restringe en la base y se valida en un solo lugar.** Un
   chequeo "antes de cada escritura" es justo la forma que `0013` y `0017` existen para eliminar en
   este proyecto: un control que hay que acordarse de hacer. Y un `startsWith` no frena
   `barrios/{A}/../{B}/x.pdf`, que **satisface el prefijo** y resuelve a otro lado apenas alguien haga
   un `path.join` sobre la clave (un adapter sobre filesystem, MinIO, un CDN, una herramienta de
   migración). Tres piezas:
   - `documento_liquidacion` lleva
     `check (storage_key ~ ('^barrios/' || barrio_id::text || '/periodos/[0-9a-fA-F-]{36}/[A-Za-z0-9._-]+\.pdf$'))`.
     Una clave que no corresponde al barrio de su propia fila **no entra**, venga del worker, de un
     script o de una consola.
   - `ObjectStorage.put()` valida la misma expresión y rechaza toda clave con `..`, `//`, `\` o `/`
     inicial. Un solo lugar, todos los llamadores.
   - `put()` es **condicional** (`If-None-Match: *`, soportado por S3 y por MinIO): un reintento **no**
     sobreescribe un objeto ya emitido. `storage_key unique` protege la **fila**, no el **objeto**; sin
     el `put` condicional, una segunda corrida cambia el PDF y deja intacto el `sha256` que lo
     acredita — un documento emitido cuya integridad declarada es mentira.
5. **Progreso por chunk, no por boleta**: 4 `UPDATE` para 200 boletas, no 200.
6. **La delegación tiene cota y queda auditada.** El job corre con la identidad de quien lo pidió, sin
   sesión y en diferido: es una **excepción de aislamiento** y se trata como tal. La cota: la sentencia
   que toma el trabajo lleva `and solicitado_at > now() - interval '1 hour'`, y el barrido de rezagados
   (§6.3) pasa a `fallado` todo lo más viejo, con el motivo escrito. Sin eso, un trabajo que quedó
   `encolado` mientras el worker estuvo caído resucita la identidad de alguien días después. El
   alcance: la fila fija `tipo`, `referencia_id` y `barrio_id` **antes** de que el worker la toque
   (§6.2), así que la delegación no es "actuar como esta persona" sino "hacer esta cosa, sobre esta
   referencia, en este barrio, en nombre de esta persona". La auditoría son las columnas que la fila ya
   tiene: `solicitado_por`, `solicitado_at`, `iniciado_at`, `terminado_at`.

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
`GET /api/documentos/[id]` → verifica bajo RLS que la fila es accesible → URL firmada → `302`.
**Nunca** se proxea el objeto por Next: sería egress duplicado y el archivo entero en memoria del
proceso web, contra las reglas §1 y §2.h del presupuesto.

Una URL firmada descarga **sin sesión** mientras dure. Ese es el trade-off aceptado, y se paga con
cuatro cosas escritas, no con confianza:

- **TTL de 60–120 s**, no 600. El `302` se sigue en el acto; diez minutos es una ventana sin motivo.
  (Sigue dentro del techo de "≤ 10 min" del ADR-0001 §9, que es un máximo, no un objetivo.)
- **`response-cache-control=no-store` en los parámetros del presign.** El `no-store` del `302` **no
  viaja al objeto**: sin esto, un CDN o un proxy intermedio puede cachear el PDF.
- **`response-content-disposition=attachment; filename="…"`**, para que no se renderice inline.
- **`Referrer-Policy: no-referrer` en el `302`**, para que la URL de la app —que lleva el uuid del
  barrio— no aparezca en los logs del proveedor de storage. Y la URL firmada **no se loguea**.

---

## 7. El recorrido: pantallas, servicios y qué falta

Rutas según `docs/diseno/06-direccion-visual.md` §c, con `[barrio]` = uuid (§3.4).

| # | Pantalla | Ruta | Servicio de `packages/data` | Estado |
|---|---|---|---|---|
| 1 | **Entrar** (elegir del elenco) | `/entrar` | `AuthProvider.iniciarSesion` + `listarUsuariosDemo` | **Hecha** (§2.3, forma construida y cerrojos 10b–10e) |
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
  servicio no puede equivocarse **con el importe** porque no tiene permiso de escribirlo (migración
  0017). Lo mismo con `registrarGasto` (`sin_respaldo_asamblea` lo pone el trigger) y con
  `crearPeriodo` (nace en `borrador` por trigger).
  **Lo que eso no cubre es la coherencia de tenant, y `aplicarConceptoAUnidad` tiene que cubrirla a
  mano:** `app.cbu_antes()` deriva `new.barrio_id` **del concepto**, y no verifica que `periodo_id` y
  `unidad_funcional_id` sean del mismo barrio. Para un usuario con membresía en un solo barrio la RLS
  lo tapa; para uno con membresía en dos —un administrador de estudio, que es **el caso central de
  este producto**— tres ids de barrios distintos pasan el `with check`. Es una precondición para
  `backend-dev`, no un defecto del modelo, y conviene que termine siendo una FK compuesta o un check en
  el trigger antes que una validación en TypeScript.
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
  con una batería de reglas —once al escribirse este ADR, y desde entonces creció. Eso tiene un costo: alguna va a molestar en un caso legítimo. La lista blanca es
  explícita por diseño, para que la excepción se vea en el diff y se discuta.
- **`packages/data/package.json` gana subrutas**: `./client` y una por servicio. Es la contrapartida de
  poder decir "la web no importa la raíz" y verificarlo.
- **Se corrige doc 06 §c.1** en dos puntos (la URL no alimenta la RLS; el segmento es el uuid y no un
  slug). Hay que sincronizar ese documento — tarea de `documentador`, no de este ADR.
- **Hay que tocar dos archivos de infraestructura en el mismo PR de implementación**, y no son
  cosméticos: `docker-compose.yml` pierde `DATABASE_URL` y `DATABASE_URL_JOB` del servicio `app`
  (§3.2, cerrojo 5) y gana el servicio `worker`; `.env.example` gana `APP_ENTORNO` y deja de tener
  `AUTH_PROVIDER=` vacío (§2.4).
- **Aparece una precondición de seguridad que limita el elenco de la demo**: nada de membresías
  `propietario`/`residente` hasta cerrar la RLS de `0003`/`0005` (§3.5). Es la clase de restricción
  que se rompe sola si no está escrita, porque "agregar un propietario a la demo" parece inofensivo.
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
- **Cerrar el `select` de `0003`/`0005` con el gate de rol de `0016`** (§3.5). Es prerequisito del
  portal del residente y de cualquier membresía `propietario`/`residente`. Migración propia, con
  `dba-data` y `security-engineer`: hay que decidir qué ve exactamente un `contador` y un `auditor`
  sobre el padrón, y eso es una decisión de dominio antes que técnica.
- **Reintentos del job de emisión.** La tabla tiene `intento`, pero cuántas veces y con qué espera no se
  decide sin ver un fallo real. Por ahora: **un** intento, y el error visible en pantalla. La
  idempotencia (índice único parcial + `put` condicional + una fila por documento) ya deja la puerta
  abierta.
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
