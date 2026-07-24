# ADR-0000 — Stack e infraestructura (agnóstico de proveedor)

**Estado:** Aceptado
**Fecha:** 2026-07-22
**Contexto de origen:** heredado de `trazabilidad-obra-gas` (sistema de gas del mismo grupo de
barrios), con las adaptaciones necesarias para ser portable entre proveedores de hosting.

---

## 1. Contexto

El sistema de gas (`trazabilidad-obra-gas`) es TypeScript + Next.js + Supabase + Vercel, y funciona
bien. Pero quedó **acoplado** a Supabase (RLS con `auth.uid()`, SDK de Supabase llamado directo desde
servicios de negocio) y a Vercel (crons vía `vercel.json`, hacks de bundle serverless). Este proyecto
nuevo (administración de barrios/consorcios) **todavía no tiene hosting decidido** — puede terminar en
AWS, en Vercel/Supabase, o self-hosted — y además va a tener una **app mobile futura** (React Native/
Expo) que necesita compartir tipos y lógica con el web.

Dos objetivos entran en tensión: reusar lo que ya funciona vs. no repetir el acople. Este ADR resuelve
esa tensión con **abstracciones finas** en los tres puntos de contacto con el proveedor (datos, auth,
almacenamiento), manteniendo todo lo demás (lenguaje, framework, validación, lógica de negocio,
librerías de ingesta) reusado tal cual.

---

## 2. Decisión — Stack base

- **TypeScript de punta a punta**, estricto (`strict: true`).
- **Next.js (App Router) + React** para la web (igual que el sistema de gas).
- **Zod** para validación de límites (parseo de entrada, contratos entre capas) — igual que el sistema
  de gas.
- **App mobile futura: React Native + Expo.** Para que comparta tipos, lógica de negocio y validaciones
  con el web sin duplicar, se extrae un **paquete compartido** (monorepo):

  ```
  admin-barrios/
  ├── apps/
  │   ├── web/              ← Next.js (App Router)
  │   └── mobile/            ← React Native/Expo (cuando arranque)
  └── packages/
      ├── shared/            ← tipos, dominio (lógica de negocio pura), esquemas Zod
      ├── data/               ← capa de datos neutral (Drizzle + Postgres), ver §3.1
      └── design-tokens/      ← ver §2.1
  ```

  Esta reestructuración a monorepo (workspaces de npm/pnpm) se ejecuta recién al arrancar el código de
  producto en **Fase 6B**; este ADR deja la carpeta prevista para que el primer commit de código ya
  nazca con la forma correcta y no haya que migrar después.

- **Base de datos:** PostgreSQL (sin importar quién lo hostee — RDS, Supabase, Neon, contenedor propio).

### 2.1. Sistema de diseño — design tokens neutrales

El sistema de gas define su sistema visual ("Catastro", ver su `docs/07-sistema-visual.md`) como
variables CSS en `globals.css`, consumidas por **CSS Modules** ("Ola 3"). Eso **no viaja a React
Native** (no hay CSS Modules ni variables CSS en RN). Decisión: extraer los tokens (color, tipografía,
espaciado, radios, sombras) a un **archivo neutral** en `packages/design-tokens/tokens.ts` — objetos
TypeScript planos (no CSS, no StyleSheet):

```ts
// packages/design-tokens/tokens.ts (ilustrativo — se completa en Fase 6B con la paleta real del producto)
export const color = { paper: "#f4f7fb", surface: "#ffffff", ink: "#0b2545", /* ... */ } as const;
export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export const font = { display: "IBM Plex Sans Condensed", sans: "IBM Plex Sans", mono: "IBM Plex Mono" } as const;
```

- **Web:** un `globals.css` (o un generador) vuelca `tokens.ts` a variables CSS (`--ink: ${color.ink}`),
  y los CSS Modules siguen usando `var(--ink)` como hoy.
- **Mobile:** un `theme.ts` en `apps/mobile` arma los `StyleSheet` a partir de las mismas constantes de
  `tokens.ts`.
- Una sola fuente de verdad para la paleta/tipografía; cero duplicación entre web y mobile.

La identidad visual concreta del proyecto de barrios (paleta, motivo gráfico análogo al "Catastro" del
sistema de gas) es una decisión de **producto/diseño**, no de infraestructura — queda para cuando se
trabaje la UI (probablemente con la skill `frontend-design`, igual que el sistema de gas).

---

## 3. Decisión — Agnóstico de proveedor: tres abstracciones

**Regla dura:** ningún servicio de negocio (`packages/shared`, dominio, casos de uso) llama
**directamente** a un SDK propietario (`@supabase/supabase-js`, SDK de Cognito, SDK de un storage
específico). Todo pasa por una interfaz propia; el SDK del proveedor queda **detrás de un adapter**,
reemplazable sin tocar el negocio.

### 3.1. Datos — Drizzle ORM sobre Postgres + RLS

**Decisión: Drizzle (no Prisma).** Motivos concretos para este proyecto:

- Drizzle no tiene motor de queries binario aparte (Prisma sí, el *query engine* en Rust) → imagen
  Docker más liviana y sin binarios por-plataforma que gestionar.
- Drizzle es SQL-transparente: permite ejecutar `SET LOCAL app.user_id = '<uuid>'` dentro de la misma
  transacción antes de la query, que es exactamente lo que hace falta para el patrón RLS multi-tenant
  de abajo. Con Prisma esto es más forzado (requiere `$transaction` + `$executeRaw` con cuidado extra).
- `drizzle-kit` genera **migraciones en SQL plano** versionadas en el repo (no un motor de migración
  propietario) → portable a cualquier Postgres (ver §5, "migraciones neutrales").

**RLS multi-tenant, pero sin atarse a `auth.uid()` de Supabase.** El sistema de gas escribe las
políticas RLS contra `auth.uid()` (función que sólo existe si Supabase Auth/GoTrue está corriendo —
confirmado en `supabase/migrations/0002_rls_policies.sql`). Para que las mismas políticas sirvan sobre
un Postgres puro (RDS, contenedor propio, sin GoTrue), se define una función wrapper propia:

```sql
-- packages/data/sql/00-app-current-user.sql (se crea al escribir el esquema real en Fase 6B)
create schema if not exists app;
create or replace function app.current_user_id() returns uuid as $$
  select coalesce(
    nullif(current_setting('app.user_id', true), '')::uuid,  -- self-hosted: seteado por la app
    auth.uid()                                                 -- Supabase: si existe el schema auth
  )
$$ language sql stable;
```

Las políticas RLS se escriben contra `app.current_user_id()`, nunca contra `auth.uid()` directo. En
Supabase, la función delega a `auth.uid()` y todo sigue igual que en el sistema de gas. En self-hosted/
AWS, la app hace `SET LOCAL app.user_id = $1` al abrir cada transacción (después de validar la sesión
vía la interfaz de Auth, §3.2), y la política ve el mismo valor sin depender de GoTrue.

### 3.2. Auth — detrás de una interfaz

Se define una interfaz propia (`packages/data` o `packages/shared/auth`, a ubicar en Fase 6B):

```ts
// Ilustrativo — el contrato, no la implementación final
interface AuthProvider {
  signIn(credenciales: Credenciales): Promise<Sesion>;
  signOut(sesion: Sesion): Promise<void>;
  getSesion(request: Request): Promise<Sesion | null>;
  // ...
}
```

El **primer adapter concreto** (a implementar recién en Fase 6B/6C, junto con el modelo de
usuarios/roles) se resuelve entre: **Supabase Auth** (funciona igual en la nube y self-hosted vía el
contenedor de GoTrue — es lo ya probado en el sistema de gas) o un **Cognito adapter** si el hosting
termina siendo AWS. La decisión concreta queda **abierta** para cuando se sepa el hosting (ver §6); lo
que este ADR fija es que el negocio nunca importa `@supabase/supabase-js` ni el SDK de Cognito
directamente — siempre pasa por `AuthProvider`.

> **Nota de andamiaje:** el `docker-compose.yml` de este ADR **no** levanta un servicio de auth todavía
> (ni GoTrue ni nada) — no hace falta hasta que exista el modelo de usuarios (Fase 6B/6C). Postgres +
> storage alcanzan para desarrollar el dominio y la ingesta de datos.

### 3.3. Almacenamiento — interfaz S3-compatible

**Decisión: `@aws-sdk/client-s3` como único cliente**, apuntado por configuración a:
- **Local:** MinIO (S3-compatible, corre en Docker).
- **AWS:** S3 real (mismo cliente, sin cambios de código).
- **Supabase Storage:** también expone un endpoint **S3-compatible** — mismo cliente, solo cambia el
  `endpoint`/credenciales.

Se envuelve en una interfaz propia chica (no se expone el cliente S3 crudo al dominio):

```ts
// Ilustrativo
interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
  remove(key: string): Promise<void>;
}
```

Como los tres proveedores hablan el mismo protocolo S3, la interfaz es delgada — pero igual se define
(no se llama al SDK desde el dominio) para poder cambiar a un proveedor no-S3 (ej. Azure Blob) el día
de mañana sin tocar servicios.

---

## 4. Qué se reutiliza del sistema de gas y qué NO

### Se reutiliza tal cual

| Pieza | Motivo |
|---|---|
| TypeScript + Next.js (App Router) + React | Stack ya elegido, funciona. |
| Zod para validación de límites | Sin acople a proveedor. |
| Separación `domain/` (reglas puras) vs `services/` (orquestación) vs `lib/` (clientes de infra) | Patrón portable; de hecho **facilita** meter las abstracciones de §3 (el dominio ya no conoce infra). |
| Librerías de ingesta: `imapflow` (IMAP), `exceljs` (Excel), `unpdf` (texto de PDF), `tesseract.js` (OCR opcional), `mailparser`, `nodemailer`, `date-fns` | Son paquetes npm de propósito general, no dependen de Supabase ni de Vercel. |
| La elección `unpdf` sobre `pdf-parse` para extraer texto de PDF | Ver detalle abajo — **se mantiene**, aunque el motivo original (bundle serverless) ya no aplique. |

### NO conviene portar tal cual

| Pieza del sistema de gas | Por qué no | Reemplazo acá |
|---|---|---|
| `@supabase/supabase-js` / `@supabase/ssr` llamado directo desde `src/lib/supabase/*` y consumido por servicios de negocio | Acopla el dominio al SDK propietario | Detrás de `AuthProvider` / capa de datos Drizzle (§3.1–3.2); el código de `src/lib/supabase` del sistema de gas sirve como **referencia** para un futuro adapter concreto de Supabase, no como acceso directo |
| RLS con `auth.uid()` directo en las políticas (confirmado en `supabase/migrations/0002_rls_policies.sql`) | Sólo existe si corre Supabase Auth/GoTrue | `app.current_user_id()` (§3.1) |
| `SUPABASE_SERVICE_ROLE_KEY` (bypassa RLS) usado en jobs de servidor | Patrón específico de Supabase | Equivalente neutral: un ROLE de Postgres de "aplicación" con `BYPASSRLS`, usado solo server-side, nunca expuesto al cliente — documentar el rol al escribir el esquema (Fase 6B) |
| `vercel.json` → `crons` + header `Authorization: Bearer $CRON_SECRET` | Cron gestionado de Vercel no existe fuera de Vercel | Un **job runner** propio detrás de una interfaz: en Vercel se dispara por su Cron+HTTP; en self-hosted/AWS, por el cron del SO, un `node-cron` en un proceso worker, o un CronJob de K8s/ECS Scheduled Task — mismo handler de negocio, disparador intercambiable |
| `next.config.mjs`: `outputFileTracingIncludes` forzando `pdfjs-dist/standard_fonts` y `cmaps` al bundle | Es un parche específico del *bundle trace* serverless de Vercel: esos archivos son datos (no `import`s JS) y quedan afuera del paquete recortado que sube Vercel. **En un contenedor Docker con `node_modules` completo instalado, el archivo ya está en disco** — el problema que este hack resuelve no existe. | **Se elimina** en el Dockerfile de la app (Fase 6B/6C). Único caso a vigilar: si en el futuro se compila con `output: "standalone"` de Next (que sí hace su propio trace/recorte incluso en Docker), reevaluar si hace falta reintroducirlo — dejar la nota en el Dockerfile cuando se escriba. |
| Motivo original de elegir `unpdf` (texto vacío de `pdf-parse`/`pdfjs` por archivos de fuentes ausentes en el bundle serverless) | Ese problema puntual (bundle recortado) no aplica en contenedor | La elección de `unpdf` **igual se mantiene** como buena práctica: no depende en absoluto de esos archivos de datos externos, es más simple que cargar `pdf-parse` + asegurarse de que `standard_fonts`/`cmaps` estén presentes. Si en Fase 6B/6C se decide portar los extractores de PDF del sistema de gas, portar también el uso de `unpdf`. |
| CLI de Supabase para migraciones (`supabase migration up`, `supabase gen types --local`) | Atado a proyectos Supabase | `drizzle-kit` (migraciones en SQL plano) + `drizzle-kit introspect`/tipado inferido de los esquemas TS (§3.1) |

---

## 5. Migraciones — herramienta neutral

**`drizzle-kit`**, no la CLI de Supabase ni Prisma Migrate. Genera archivos `.sql` versionados en
`packages/data/migrations/NNNN_*.sql`, aplicables con `drizzle-kit migrate` contra **cualquier**
`DATABASE_URL` de Postgres (local, RDS, Supabase, Neon). Regla del proyecto (heredada de
`02-sdlc-git-flow.md`): nunca editar una migración ya aplicada, prefijo incremental para la siguiente.

El esquema real (tablas, RLS, índices) se escribe en **Fase 6B** — este ADR sólo fija la herramienta y
el patrón `app.current_user_id()` que las políticas van a usar.

---

## 6. Arranque local con Docker

Ver `docker-compose.yml` en la raíz. Levanta:

- **`postgres`** (Postgres 16) — la base de datos, para desarrollar 100% local.
- **`minio`** — almacenamiento S3-compatible local.
- **`minio-init`** — contenedor de un solo uso que crea el bucket de la app al arrancar.
- **`app`** (perfil opcional `app`, ver más abajo) — activa recién cuando exista `package.json`/Next.js
  (Fase 6B). Hasta entonces, `docker compose up` alcanza con Postgres + MinIO; la app (cuando exista)
  corre con `npm run dev` en el host, apuntando a esos dos contenedores por `.env.local`.

**Cómo levantarlo (hoy, sólo infra):**

```bash
cp .env.example .env
docker compose up -d postgres minio minio-init
```

Postgres queda en `localhost:5432`, MinIO API en `localhost:9000` (consola en `localhost:9001`).

**Cuando exista la app (Fase 6B en adelante):**

```bash
docker compose --profile app up -d
```

---

## 7. Portabilidad de despliegue

El mismo diseño (stack + 3 abstracciones + migraciones neutrales) se despliega cambiando **solo
configuración**, nunca código de negocio:

| | AWS | Vercel + Supabase | Self-hosted (VPS/Docker) |
|---|---|---|---|
| App | ECS/App Runner/Amplify (contenedor Next.js) | Vercel (build gestionado) | Contenedor Next.js (`docker compose --profile app`) |
| Datos | RDS Postgres, `DATABASE_URL` directo | Postgres de Supabase, `DATABASE_URL` directo | Contenedor Postgres propio |
| RLS | `app.current_user_id()` alimentado por `SET LOCAL` desde el adapter de Auth elegido | `app.current_user_id()` delega a `auth.uid()` (Supabase Auth activo) | Igual que AWS |
| Auth | Adapter Cognito (o GoTrue en contenedor) detrás de `AuthProvider` | Adapter Supabase Auth | Adapter GoTrue en contenedor, o adapter propio |
| Storage | S3 real | Supabase Storage (endpoint S3-compatible) | MinIO en contenedor |
| Jobs/crons | EventBridge Scheduler / ECS Scheduled Task → mismo handler | Vercel Cron → mismo handler | cron del SO / K8s CronJob → mismo handler |
| Migraciones | `drizzle-kit migrate` contra el `DATABASE_URL` de RDS | `drizzle-kit migrate` contra el `DATABASE_URL` de Supabase | `drizzle-kit migrate` contra el `DATABASE_URL` del contenedor |

**Ningún renglón de esta tabla obliga a tocar `packages/shared` ni el dominio.** Solo cambian las
variables de entorno y qué adapter concreto de `AuthProvider`/`ObjectStorage` se instancia.

---

## 8. Consecuencias

- Un poco más de código de "plomería" al principio (interfaces + adapters) comparado con llamar al SDK
  de Supabase directo — se paga una vez, a cambio de no quedar atado a un proveedor antes de decidir
  hosting.
- El monorepo (`apps/` + `packages/`) suma configuración de workspaces desde el día 1, aunque
  `apps/mobile` esté vacío hasta que arranque el mobile — evita una migración estructural después.
- La función `app.current_user_id()` es una pieza nueva (no existe en el sistema de gas) que hay que
  crear y probar en ambos modos (Supabase y self-hosted) cuando se escriba el esquema real.

## 9. Alternativas consideradas

- **Prisma en vez de Drizzle:** descartado por el peso del query engine en la imagen Docker y por la
  fricción para el patrón `SET LOCAL` + RLS (ver §3.1).
- **Seguir llamando al SDK de Supabase directo** (como el sistema de gas): descartado porque el
  hosting **todavía no está decidido** — el costo de migrar todo el negocio después de haber acoplado
  el SDK es mucho mayor que definir la interfaz ahora.
- **CSS Modules compartido con React Native vía alguna lib de interop:** descartado — más simple y más
  transparente extraer los tokens a un archivo neutral (§2.1) que depender de una librería de
  compatibilidad CSS-en-RN.

---

## 10. A confirmar (abierto — no inventado)

- **Proveedor de hosting final** (AWS vs Vercel/Supabase vs self-hosted): no decidido; este ADR es
  válido para los tres. Cuando se decida, actualizar `01-entornos.md` con los valores concretos
  (`<PROVEEDOR_HOSTING>`, `<PROVEEDOR_BD>`).
- **Adapter de Auth inicial** (Supabase Auth vs Cognito vs GoTrue self-hosted): depende del hosting;
  queda para Fase 6B/6C junto con el modelo de usuarios/roles.
- **Paquete de gestor de monorepo** (npm workspaces vs pnpm workspaces vs Turborepo): no evaluado en
  este ADR — a resolver al escribir el primer `package.json` en Fase 6B. Sugerencia liviana (no
  decisión cerrada): `pnpm` workspaces, por instalación más rápida y mejor manejo de dependencias
  compartidas entre `apps/web`, `apps/mobile` y `packages/*`.

---

_Ver también `docs/devops/01-entornos.md` (entornos, cuando se decida el hosting) y
`docs/devops/02-sdlc-git-flow.md` (flujo de trabajo). Este ADR reemplaza, para este proyecto, la
plantilla neutral de `01-entornos.md` en lo referido a stack — no a flujo de ramas/PR, que sigue igual._
