# 01 · Entornos (producción y testing) — guía neutral de infraestructura

> **Plantilla.** Reemplazá los marcadores `<ASI>` por los valores de tu proyecto. Esta guía es
> **neutral respecto del proveedor**: usa **`<PROVEEDOR_HOSTING>`** (ej. Vercel, Netlify, AWS
> Amplify, Cloud Run) y **`<PROVEEDOR_BD>`** (ej. Supabase, Neon, PlanetScale, AWS RDS) como piezas
> **intercambiables**. Los principios valen igual con cualquiera; los ejemplos concretos van entre
> paréntesis.

---

## 0. Por qué dos entornos (el problema que evita)

Con **un solo mundo** (una base y un hosting), desarrollar y probar en tu máquina se conecta a la
**base de producción**: cada prueba consume recursos reales y puede corromper datos reales. La
solución de base: **dos entornos separados**.

```
   Rama de producción  ──►  <PROVEEDOR_HOSTING> · Producción  ──►  <PROVEEDOR_BD> PROD   (datos reales)
   Ramas de trabajo    ──►  <PROVEEDOR_HOSTING> · Preview      ──►  <PROVEEDOR_BD> TESTING (datos de prueba)
   y pruebas locales
```

**Principio 1 — Aislamiento total:** producción nunca recibe tráfico de desarrollo. Testing usa
**sus propias credenciales**, jamás las de producción.

---

## 1. Mapa de entornos

| Origen | Hosting despliega en | Base de datos | Cuándo |
|---|---|---|---|
| Rama **`<RAMA_PRODUCCION>`** (por defecto `main`) | **Production** | **`<PROVEEDOR_BD>` PROD** (`<REF_PROYECTO_PROD>`) | en cada push/merge |
| **Cualquier otra rama** de trabajo | **Preview** (URL por rama) | **`<PROVEEDOR_BD>` TESTING** (`<REF_PROYECTO_TESTING>`) | en cada push a esa rama |
| Tu máquina (`.env.local`) | local | **`<PROVEEDOR_BD>` TESTING** | siempre |

> **Opcional — URL de staging estable:** si querés *una* dirección fija para mostrar/probar (en vez
> de una URL distinta por rama), usá una rama fija `staging` o `develop` apuntada al entorno de
> testing. No es obligatorio; es comodidad.

---

## 2. Variables de entorno (el puente entre deploy y base)

**Principio 2 — Cada variable existe dos veces:** una en *Production* (valor de prod) y otra en
*Preview/Development* (valor de testing). Al **agregar una variable nueva**, cargala en **los dos**
scopes del hosting **y** en tu `.env.local`. Si falta en alguno, ese entorno rompe.

| Variable (ejemplo) | Producción | Testing / Preview | `.env.local` | ¿Secreta? |
|---|---|---|---|---|
| `<VAR_URL_BD>` | URL de PROD (`<URL_BASE_DATOS_PROD>`) | URL de TESTING (`<URL_BASE_DATOS_TESTING>`) | URL de TESTING | No (pública) |
| `<VAR_CLAVE_PUBLICA_BD>` | clave pública PROD | clave pública TESTING | clave pública TESTING | No |
| `<VAR_CLAVE_SECRETA_BD>` | clave secreta PROD | clave secreta TESTING | clave secreta TESTING | 🔴 **Sí** |
| `<VAR_SECRET_CRON>` | valor A | valor B **distinto** | valor B | 🔴 Sí |
| `<VAR_INTEGRACIONES_*>` (email, pagos, OCR…) | credenciales reales | de prueba / modo off | de prueba / off | 🔴 Sí |
| `<VAR_CONFIG_NO_SECRETA>` (timezone, flags) | igual en ambos | igual | igual | No |

**Reglas de secretos:**
1. Ningún secreto en el repo ni por chat/mail: se cargan directo en el panel del hosting y en
   `.env.local` (que está gitigneado).
2. La **clave secreta / de servicio** de la base **nunca** con prefijo público ni en el navegador.
   Si se filtra, se rota de inmediato.
3. Usá un **secreto de cron distinto** por entorno, para que un disparo de un entorno no sirva contra
   el otro.
4. Las variables "públicas" que se **hornean en el build** (ej. `NEXT_PUBLIC_*` en Next, `VITE_*` en
   Vite) quedan fijas al momento del build → si cambian, hay que **rebuildear**.

---

## 2.1. Qué credencial recibe cada proceso (concreto de `admin-barrios`)

**Principio 2.1 — Un proceso recibe las credenciales de su rol, y ninguna más.** No es orden ni
prolijidad: es lo único que sostiene el aislamiento multi-tenant. El aislamiento entre barrios lo
hace cumplir **la base** (RLS con `app.current_user_id()`), y solo funciona si el proceso que atiende
personas se conecta con un rol **sujeto a RLS**. Con la conexión del dueño del esquema o la del rol
con `BYPASSRLS`, las policies **no se evalúan**: el código se lee aislado y no aísla nada. Todo el
trabajo de las migraciones de RLS vale cero.

| Proceso | Conexión a la base | Rol | Qué más recibe |
|---|---|---|---|
| **web** (`apps/web`, Next) | `DATABASE_URL_APP` — **y ninguna otra** | `app_request`, **sujeto a RLS** | `APP_ENTORNO`, `APP_TIMEZONE`, `AUTH_PROVIDER`, storage de **solo lectura** (firma URLs de descarga) |
| **worker** (`apps/worker`, cuando exista) | `DATABASE_URL_JOB` **y** `DATABASE_URL_APP` | `app_job` (`BYPASSRLS`) **solo** para tomar el trabajo de la cola; el trabajo real corre bajo `conUsuario()` | `CRON_SECRET`, storage de lectura+escritura |
| **migraciones y scripts** (`pnpm db:*`, `vitest`) | `DATABASE_URL` | dueño del esquema | Corren en la máquina/CI, **nunca** en un contenedor que atiende pedidos |

Consecuencias operativas, y son las que se olvidan:

- El `.env` de la raíz es el scope de **compose, los scripts de base y los tests**. Tiene las tres
  conexiones porque las tres cosas las necesitan. **La web no lee ese archivo:** sus variables van en
  `apps/web/.env.local` (plantilla en `apps/web/.env.local.example`). Copiar el `.env` de la raíz
  encima de `apps/web/.env.local` es exactamente el error que abre el agujero.
- Los servicios de `docker-compose.yml` que corren código nuestro **no usan `env_file`**: enumeran sus
  variables una por una. `env_file` entrega el `.env` **entero**, y entonces cada variable nueva que
  alguien agregue mañana al `.env` viaja sola al contenedor de la web.
- En CI las credenciales van **por paso**, no a nivel de job: `pnpm install` (que ejecuta código de
  terceros) y el build de la web no tienen ninguna URL de base en su entorno.
- Los contenedores corren como el usuario `node`, sin privilegios. El proceso que atiende pedidos no
  puede escribir su propio código.
- El storage local (MinIO) tiene **dos cuentas de servicio** que crea `pnpm db:up` (`app_web_dev` solo
  lectura, `app_worker_dev` lectura+escritura). La cuenta de root administra la instancia y **no la
  recibe ninguna aplicación**. En un entorno real son dos políticas de IAM.

### Los tres cerrojos que lo hacen cumplir

Una convención documentada no es un control. Esto se verifica en tres planos, y el tercero es el que
aguanta solo:

1. **Estructural** — `docker-compose.yml` enumera las variables de cada servicio, sin `env_file`.
2. **En CI** — `tools/infra/credenciales.test.ts` (entra en `pnpm test`, gate barato) lee el
   `docker-compose.yml` y falla si un servicio gobernado declara una variable que no está en la lista
   de permitidos de su rol, si usa `env_file`, o si publica un puerto en todas las interfaces.
   Incluye casos de control con violaciones inyectadas: sin ellos, un lector que dejara de encontrar
   los servicios daría verde con el compose roto.
3. **En runtime** — `tools/infra/verificar-credenciales.ts` corre **antes** de la app (`CMD` del
   contenedor y script `pnpm dev`) y aborta el arranque si encuentra una credencial que no le toca.
   Es el único que sigue valiendo frente a un `docker run -e …`, un manifiesto escrito a mano o una
   variable cargada de más en el panel del hosting.

La fuente de verdad de las tres es un solo archivo: **`tools/infra/credenciales.ts`**. Es una **lista
de permitidos**, no de prohibidos: una credencial nueva sin declarar falla sola. Agregar una variable
a un proceso es un cambio en ese archivo, y por lo tanto algo que se ve en el diff y se discute en el
PR — que es donde se tiene que discutir.

## 2.2. `APP_ENTORNO`, y por qué no `NODE_ENV`

**Principio 2.2 — Lo que no está declarado explícitamente como desarrollo, es producción.**

`APP_ENTORNO` toma uno de tres valores: `local`, `staging`, `produccion`. Es **obligatoria y sin
default** en el código, y se evalúa como **lista de permitidos** (`=== "local"`), nunca como lista de
prohibidos (`!== "production"`).

`NODE_ENV` **no sirve** para esto: dice cómo se compila, no en qué entorno se está corriendo. Hay
razones legítimas para levantar un entorno real con `NODE_ENV=development` (mensajes de error
completos, un preview), y una condición `!== "production"` **falla abierta** para todo lo demás:
`undefined`, `"Production"`, `"prod"`, `"staging"`. Por eso `.env.example` ya **no** fija `NODE_ENV`.

De esta variable cuelga el candado del sustituto de identidad de desarrollo (ADR-0002 §2.4): el
adapter `dev-suplantacion` se habilita **solo** con `APP_ENTORNO=local`. En el gate de CI, el paso de
build corre con `APP_ENTORNO=staging` a propósito: si el build llega a ejecutar la validación del
entorno, tiene que ver uno que **no** habilita el sustituto.

## 2.3. Secretos: los del repo son de juguete, los de verdad no existen todavía

Los valores que están en `.env.example` (`admin_barrios_dev`, `app_web_dev_secret`, …) son
credenciales **de desarrollo, de una base descartable que corre en tu máquina y escucha solo en
`127.0.0.1`**. No son secretos y no valen en ningún otro lado. Los de cada entorno real se generan
por entorno, se cargan en el panel del hosting y **nunca** pasan por el repo, ni por chat, ni por
mail. Lo mismo vale para `CRON_SECRET`: uno distinto por entorno, para que un disparo de local no
sirva contra staging.

---

## 3. Preparar el entorno de testing (una vez)

**Principio 3 — Testing es un clon estructural de prod, con datos sintéticos:**

1. **Crear** el proyecto/base de testing en `<PROVEEDOR_BD>` (misma región que prod si se puede).
   Generar una **contraseña distinta** a la de prod.
2. **Aplicar el esquema:** correr todas las migraciones sobre testing (`<COMANDO_MIGRACIONES>`).
3. **Cargar catálogo base** (datos de configuración, no personales).
4. **Cargar datos de prueba sintéticos** — **nunca** el padrón real con datos personales (ver §5).
5. **Cargar las variables** de testing en el hosting (scope Preview) y en `.env.local`.

> **Límites del plan gratis (verificar los vigentes del proveedor elegido):** muchos free tiers
> permiten **2 proyectos activos** por organización (prod + testing llegan justo), y **pausan** un
> proyecto sin uso por un tiempo. Presupuestar ambos entornos contra el mismo plan.

---

## 4. Aplicar cambios de base (migraciones) — el paso que no es automático

**Principio 4 — El hosting despliega CÓDIGO, no ESQUEMA.** Código y base se coordinan a mano:

> **Regla de oro:** para una migración **aditiva y compatible hacia atrás** (agregar tabla/columna/
> índice/vista sin romper lo viejo), aplicala a **prod ANTES** de mergear el código. El orden inverso
> deja una ventana en la que prod corre contra un esquema que todavía no existe → error.

Flujo genérico (adaptá `<COMANDO_MIGRACIONES>` a tu herramienta):

```
# 1) VERIFICAR a qué entorno apunta la CLI (el error más caro es aplicar al equivocado)
<COMANDO_VER_ENTORNO_ACTIVO>

# 2) Aplicar a TESTING (durante el desarrollo)
<COMANDO_VINCULAR_TESTING> && <COMANDO_MIGRACIONES>

# 3) Aplicar a PROD (recién en el pasaje a producción, con aprobación)
<COMANDO_VINCULAR_PROD> && <COMANDO_MIGRACIONES>

# 4) Regenerar tipos/artefactos si cambió el esquema
<COMANDO_REGENERAR_TIPOS>
```

**Reglas duras:** nunca editar una migración ya aplicada; crear una nueva con prefijo incremental;
regenerar tipos después. **Cambios destructivos** (renombrar/eliminar columna en uso): patrón
**expand/contract** en dos pasos, nunca en una sola migración.

**Caveat de testing compartido:** si hay **una sola** base de testing para todas las ramas de
preview, dos ramas con migraciones distintas se pisan. Con equipo chico, alcanza con tener **una
feature con migración a la vez** en testing.

---

## 5. Qué NO hacer (seguridad — leer antes de tocar)

1. **Nunca apuntar testing (ni `.env.local`) a las credenciales de PRODUCCIÓN.**
2. **La clave de servicio jamás en el navegador** ni con prefijo público. Solo variable server.
3. **No cargar datos personales reales en testing.** Testing usa datos **sintéticos**. La PII real
   solo vive en producción.
4. **Antes de cada migración, confirmar a qué entorno apunta la CLI.** Aplicar al equivocado es el
   error más caro.
5. **Secretos distintos por entorno** (cron, tokens de integración).
6. **Ningún secreto por chat, mail o captura.**
7. **Nunca darle al proceso web una conexión que no sea la del rol sujeto a RLS** (§2.1). Ni "por un
   rato", ni "solo en local para probar una cosa": el gate y el guard de arranque lo van a rechazar,
   y están para eso.
8. **Nunca copiar el `.env` de la raíz a `apps/web/.env.local`.** Usar `apps/web/.env.local.example`.
9. **Nunca publicar los puertos de la infra local en todas las interfaces.** Una base de desarrollo,
   con contraseña de desarrollo y datos de demo, alcanzable desde la red donde estés (una wifi
   compartida, una VPN de cliente), es una base de desarrollo pública. Van atados a `127.0.0.1`.
10. **Nada de material real (`_referencias/`) adentro de una imagen de contenedor.** Una imagen se
    sube a un registry y se inspecciona igual que un repo; está excluida en `.dockerignore`.

---

## 5.1. Flujo local — lo que cambia y lo que no

**No cambia nada** de lo de todos los días:

```
pnpm db:up                                        # postgres + minio + bucket + cuentas de storage
pnpm db:reset && pnpm db:migrate && pnpm db:setup && pnpm db:seed
pnpm dev                                          # la web en el host, ahora con guard de credenciales
pnpm test / pnpm test:db / pnpm test:pdf          # el gate
```

Tres cosas para tener presentes:

1. **`apps/web/.env.local`.** La web ya no toma nada del `.env` de la raíz. Copiá
   `apps/web/.env.local.example` a `apps/web/.env.local` (una vez). Si no existe, `pnpm dev` arranca
   igual: el guard no exige las variables en el host, solo rechaza las que no corresponden.
2. **El contenedor de la web hay que recrearlo una vez.** El compose conserva los volúmenes anónimos
   de `node_modules` entre recreaciones, y los que había quedaron de una imagen que instalaba como
   root. Una sola vez: `docker compose --profile app rm -sfv app` y después
   `docker compose --profile app up -d app`. (Sin eso, `pnpm dev` adentro del contenedor aborta con
   `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.)
3. **Los puertos siguen en `localhost`** (5432, 9000, 9001, 4000); lo único que cambió es que ya no
   escuchan en el resto de las interfaces de la máquina.

---

## 6. Rollback (principio de seguridad)

- **Código:** revertir el merge en la rama de producción (el hosting redepliega el estado anterior) o
  promover un deploy previo desde el panel.
- **Base:** **nunca** se "desaplica" una migración editándola. Se crea una **migración nueva** que
  revierte el efecto (forward-fix). Por eso las migraciones aditivas/compatibles son preferibles.
- **Datos:** si el plan **no** tiene backups automáticos, **presupuestar backups manuales** antes de
  cada release — otra razón para que prod solo reciba cambios ya probados en testing.

---

_Plantilla del template `<NOMBRE_PROYECTO>`. Ver `02-sdlc-git-flow.md` (cómo se trabaja cada cambio) y
`03-reglas-desarrollo-optimizado.md` (presupuesto de recursos y buenas prácticas)._
