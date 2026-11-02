# Relevamiento — autenticación y roles en `admin-barrios`

> Encargado como insumo para otra sesión de Claude Code (proyecto `sistema-contable`), que está
> diseñando su propio `AuthProvider`. Es diagnóstico, no una recomendación de producto: no se tocó
> código para escribirlo. Fuente primaria citada en cada punto: `packages/auth/src/*`,
> `apps/web/src/servidor/db.ts`, `apps/web/src/acciones/sesion.ts`,
> `docs/arquitectura/02-aplicacion-web-del-administrador.md` (ADR-0002) y `HANDOFF.md`.

## 1. Mecanismo de autenticación actual

**No hay autenticación real implementada. Hoy existe un contrato de portabilidad (`AuthProvider`) y
un único adapter, marcado explícitamente como no apto para producción.**

- El contrato vive en `packages/auth/src/auth-provider.ts`: un `AuthProvider` con `sesionDe()`,
  `iniciarSesion()`, `cerrarSesion()` y un campo `aptoParaProduccion: boolean` que es parte del tipo,
  no un comentario.
- El único adapter implementado es `dev-suplantacion`
  (`packages/auth/src/adapters/dev-suplantacion.ts`): deja "entrar" **eligiendo un usuario de una
  lista**, sin contraseña ni verificación real, tomada de una tabla `usuario_demo` que en producción
  tiene que estar vacía.
- No hay ningún SDK de proveedor integrado. `docs/arquitectura/02-aplicacion-web-del-administrador.md`
  §2.1 lo dice en una tabla: "Tabla de usuarios: **No existe**. Contraseñas, sesiones, tokens: **No
  existen**."
- Supabase Auth **fue evaluado y descartado, para este incremento, no para siempre** (ADR-0002 §11.1):
  se decidió no levantarlo todavía porque la elección encadena tres decisiones aún abiertas (hosting,
  si el `user_id` interno es el `sub` del IdP o una tabla propia, y el modelo de invitaciones), y
  ninguna de las tres cambia una línea de las pantallas ya construidas. La nota aclara que **es
  "probablemente lo que termine pasando"**. No hay proyecto ni cuenta de Supabase Auth creados para
  este propósito — lo que sí existe es una app de Vercel y una de Supabase "colgadas del repo" sin
  revisar (`HANDOFF.md`, pendiente #3 en la sección 12 de la entrada más reciente sobre esto), que el
  propio repo señala como sin justificación escrita y con acceso de terceros al código.
- Zod, sobre `APP_ENTORNO`, ya soporta `"local" | "staging" | "produccion"` como los tres entornos
  declarados (`packages/auth/src/registro.ts`), y el adapter de desarrollo solo se instancia con
  `APP_ENTORNO === "local"` — el resto de la matriz (`AUTH_PROVIDER=supabase|cognito|gotrue`) todavía
  no tiene ningún adapter escrito: la fábrica **lanza** con un mensaje explícito de "no tiene adapter
  implementado" (`registro.ts:99-106`).

## 2. Relación entre el usuario autenticado y el modelo de tenancy

**El rol se verifica del lado del servidor, en la base, nunca se confía desde el cliente ni viaja en
la sesión.**

- `Identidad` (lo único que cruza el límite hacia los datos) es `{ usuarioId: string; email;
  nombre }` — **no lleva rol** (`auth-provider.ts:23-29`). El comentario del archivo lo dice como
  regla de diseño: "Si algún día aparece un campo `rol` en `Identidad`, es un bug de diseño, no una
  comodidad" (mismo archivo, líneas 14-17).
- El rol vive en la tabla `membership` y lo resuelve Postgres, no la aplicación: es **por nodo**
  (alguien es `admin_barrio` en un barrio y `contador` en otro), así que un claim de sesión no podría
  representarlo aunque quisiera (ADR-0002 §2.2).
- El único dato que cruza de la capa de identidad a la capa de datos es un uuid. `conUsuario(db,
  userId, fn)` hace `set_config('app.user_id', …, true)` dentro de una transacción, y las políticas
  RLS de Postgres (`app.current_user_id()`, `app.accessible_tenant_ids()`, `app.has_role_on()`)
  deciden qué filas ve esa conexión — es Postgres el que autoriza, no una condición en TypeScript.
  Esto es aislamiento multi-tenant jerárquico, documentado en ADR-0000 §3.1 y con 27 tests contra
  Postgres real (`HANDOFF.md`, sección de estado técnico).
- Hay un único camino de la aplicación web a la base: `conSesion()` en `apps/web/src/servidor/db.ts`.
  Sin sesión válida, la función **redirige** antes de abrir ninguna transacción — no hay forma de que
  un componente consulte la base "por las suyas". El propio archivo enumera cinco cerrojos en cinco
  planos (tipos, grafo de imports verificado en CI, `server-only`, la base con `FORCE ROW LEVEL
  SECURITY`, y que el proceso ni siquiera tiene la credencial de superusuario) para que ese camino
  único no se pueda rodear por accidente.
- La sesión expira **en la puerta**: `sesionActual()` (`db.ts:190-199`) compara `expiraEn` contra
  `Date.now()` antes de dejar pasar cualquier request, así que ningún adapter futuro puede "olvidarse"
  de chequear vencimiento.

## 3. Manejo de contraseñas

**No hay ningún manejo manual de contraseñas en el código, porque no hay ningún manejo de contraseñas
en absoluto todavía — ni propio ni delegado a un proveedor externo.** Esto es la respuesta más
importante del relevamiento y hay que leerla con precisión, porque no es "las gestiona un tercero":

- El adapter que existe (`dev-suplantacion`) **no pide contraseña**. Se "inicia sesión" eligiendo un
  nombre de una lista (`usuario_demo`) en un `<form>` sin un solo `<input>`. El propio ADR lo señala
  como decisión deliberada: *"un campo que no verifica nada es una afirmación falsa sobre la seguridad
  del producto"* (ADR-0002 §2.3).
- La cookie de sesión de este adapter es **el `uuid` del usuario en texto plano, sin firmar**. Es a
  propósito: firmarla daría "la ilusión de ser un mecanismo de seguridad" que no es
  (`dev-suplantacion.ts:22-30`). Cualquiera que llegue a la app puede poner esa cookie a mano; por eso
  `iniciarSesion()` repite exactamente los mismos chequeos que `sesionDe()` y no confía en haber sido
  invocado desde el formulario real.
- Ningún rol de base de datos tiene contraseña en el repositorio: `HANDOFF.md` lo registra
  explícitamente al describir `app_request` (sujeto a RLS) y `app_job` (`BYPASSRLS`) como creados
  **"sin contraseña en el repo"** — las credenciales de conexión a Postgres viven fuera del
  versionado, en variables de entorno (regla dura §1.5 de `CLAUDE.md`: "Nada de secretos en el repo").
- **Login real con contraseña está dimensionado pero no construido.** `HANDOFF.md` registra que
  `arquitecto-software` estimó esa tarea en 3 jornadas, de las cuales sobrevive ~70% cuando se elija
  el proveedor definitivo (la tabla `usuario` y el puente hacia `membership`), y se descarta el resto
  — literalmente "el verificador de contraseñas y la firma de la cookie" del sustituto de desarrollo.
  Es decir: el propio proyecto ya decidió que el manejo de contraseñas **no** lo va a escribir a mano
  cuando llegue el momento; lo que hoy existe es un placeholder sin contraseñas, no un intento propio
  de hashing/verificación que haya que auditar.
- **Hallazgo de seguridad para dejar explícito:** no hay manejo manual de contraseñas para señalar como
  vulnerabilidad porque no hay ningún flujo de contraseñas todavía — ni bueno ni malo. El riesgo real
  hoy no es "contraseñas mal manejadas", es que el sistema **todavía no autentica a nadie**: la única
  puerta es un candado de varias vueltas (ver §4) que impide que ese estado llegue a producción, no un
  mecanismo de identidad utilizable fuera de una demo.

## 4. Incidentes o hallazgos de seguridad ya documentados sobre este tema

Sí, varios, todos en `docs/arquitectura/02-aplicacion-web-del-administrador.md` §2.4 y en `HANDOFF.md`:

- **El candado tiene 4 vueltas y el propio ADR aclara que solo una es un candado de verdad, no una
  advertencia.** Tabla completa en ADR-0002 §2.4:
  1. *El proceso no atiende* — `crearAuthProvider()` exige `APP_ENTORNO` obligatoria, sin default,
     como lista de **permitidos** (`=== "local"`), no de prohibidos (`!== "produccion"`). Es un gate
     de configuración: "vale lo que valga la variable".
  2. *No atiende fuera de la máquina* (chequeo de `Host`) — el propio documento dice explícitamente
     que **es defensa en profundidad, no un candado**, porque el `Host` lo manda el cliente y se
     puede falsificar con `curl -H 'Host: localhost' ...`.
  3. *No hay a quién suplantar* — la tabla `usuario_demo` la escribe solo el dueño del esquema, sin
     grants de escritura para ningún rol de la app, y el seed se niega a correr fuera de `local`. **Es
     la única de las cuatro que "aguanta sola"**, según el propio ADR.
  4. *CI vigila quién importa el adapter* — protege a la vuelta 1, no es independiente.
- **Deuda abierta, anotada el 2026-08-07 y sin resolver:** la vuelta 1 depende enteramente de que
  `apps/web/src/instrumentation.ts` corra al levantar el servidor, y **nada verifica en un test que
  Next efectivamente llame a ese hook, ni que un rechazo ahí aborte el arranque en vez de solo
  loguearse**. El propio ADR describe el escenario de falla: un contenedor que pasa el health-check y
  responde 500 a todo. Está marcado como tarea de `devops`, no cerrado.
- **Hallazgo de `security-engineer` durante la revisión de `apps/web/src/servidor/db.ts`:** el
  `AuthProvider` se arma antes que el pool de conexiones a propósito, porque si `crearAuthProvider()`
  lanza después de crear el pool, deja un `pg.Pool` huérfano. (Se corrigió el orden; el `HANDOFF.md`
  también corrige una sobreestimación posterior de ese mismo hallazgo — "sin límite" era exagerado —
  dejando constancia de que un diagnóstico inflado manda a buscar una fuga que no existe.)
- **Nada de lo anterior es un incidente en producción**: no hay producción con datos reales todavía.
  Son hallazgos de diseño/revisión de código, encontrados y corregidos en el propio proceso de
  desarrollo (paneles de `arquitecto-software` + `security-engineer`, según protocolo de `CLAUDE.md`
  §3.1).

## 5. Autoevaluación honesta

**No, este mecanismo no alcanza como referencia directa para un sistema que maneja datos financieros
de terceros — y el propio proyecto lo dice de sí mismo, no es una lectura externa.**

Lo que sí vale la pena llevarse, porque es sólido y probado independientemente de que la
autenticación esté incompleta:

- **La separación entre "quién sos" y "qué podés ver" es un patrón defendible.** Que la identidad sea
  solo un uuid opaco, que el rol nunca viaje en la sesión ni en un claim, y que la autorización real
  ocurra en la base vía RLS (no en el código de aplicación) es una arquitectura que un sistema
  contable con datos financieros de terceros debería envidiar, no descartar. Está probada con 27 tests
  contra Postgres real y aislamiento verificado entre tenants.
- **La honestidad del diseño sobre sus propios límites es infrecuente y vale imitarla.** El ADR
  clasifica explícitamente cada capa de defensa por cuánto aguanta sola (una de cuatro), documenta la
  deuda pendiente sin maquillarla, y el propio adapter de desarrollo está escrito para que "se vea"
  que no es seguro (cookie sin firmar, a propósito, para no dar falsa sensación de protección).

Lo que **no** es transferible, porque directamente no existe:

- **No hay autenticación real que auditar.** El único "login" es una lista de suplantación para
  demos, con un candado de configuración para que no llegue a producción — no hay contraseñas,
  tokens, hashing, ni sesión firmada que evaluar como referencia.
- **El adapter de producción (Supabase Auth, Cognito o GoTrue) todavía no se eligió ni se escribió.**
  ADR-0002 §2.5 enumera siete puntos pendientes antes de la primera cuenta real, incluyendo el puente
  entre el `sub` del proveedor y el `user_id` interno, alta de usuarios, revocación efectiva y segundo
  factor — todos "abiertos, no inventados".
- **Un sistema que ya maneja plata de terceros necesita un estándar más alto que este proyecto
  mismo se exige a sí mismo para lo que viene.** Este repo trata el dinero de los barrios con reglas
  duras (toda cifra con origen trazable, RLS por barrio) pero **todavía no tiene un solo usuario real
  autenticado** — es, por diseño y de forma consciente, anterior a esa etapa. Copiar el adapter de
  desarrollo sería copiar exactamente la pieza que este proyecto marca como "no apto para producción"
  en su propio tipo (`aptoParaProduccion: false`).

**Conclusión para la otra sesión:** tomar de acá el *contrato* (`AuthProvider` con superficie mínima
de un uuid, rol resuelto en el servidor/base, sesión con expiración verificada en un único punto de
entrada) como insumo de diseño válido. No tomar el *adapter* como ejemplo de autenticación, porque no
pretende serlo — y no hay todavía, en este repo, un adapter de producción real contra el cual
comparar el nivel de madurez que un sistema contable de terceros necesita.
