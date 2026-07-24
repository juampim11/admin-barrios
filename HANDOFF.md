# HANDOFF — bitácora de handoff entre herramientas

> Regla de oro: **lo que no está escrito acá o en `docs/`, no existe para la otra herramienta.**
> Entradas nuevas arriba (orden cronológico inverso).

---

## 2026-07-24 — Fase 6C (Etapa 0): monorepo + tenancy con RLS probada en Docker (Claude Code)

**Rama:** `feat/fase-6c-fundaciones` (nace de `main`, que ya tiene el merge de 6B). Sin push.

**Qué se cerró:**
- **Monorepo pnpm workspaces** (decisión tomada; cierra el punto abierto del ADR §10):
  `apps/web` + `packages/{shared,data,design-tokens}`, `tsconfig.base.json` estricto
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Vitest con dos
  proyectos (`unit` sin base / `db` contra Postgres real).
  - Los paquetes se consumen como **TS fuente** (sin build previo) y los imports llevan **extensión
    `.ts` explícita**: así los resuelven igual Node (type-stripping nativo de Node 22), Vitest y Next,
    sin sumar `tsx`/`ts-node`. `hoist=false` en `.npmrc`: cada paquete solo importa lo que declara.
- **`packages/shared`** — dominio puro: dinero como **string decimal + aritmética en centavos
  (`bigint`)**, nunca `number` (0.1+0.2 no puede decidir una expensa); `prorratear()` con el resto a
  la última unidad, así **la suma de las partes siempre cierra igual al total**; `CifraTrazable`
  (monto + origen: barrio/período/UF/coeficiente/detalle); helpers de subárbol de tenancía.
- **`packages/data`** — Drizzle + Postgres, con dos migraciones aplicadas y probadas:
  - `0000_tenancy.sql` (generada del esquema TS): `tenant_node` (uuid + `nid` identity + materialized
    path + soft-delete), `membership`, `tenant_grant`, enums en schema `app`, índices (incluido
    `path text_pattern_ops` y el parcial `where activo`).
  - `0001_tenancy_rls.sql` (escrita a mano): `app.current_user_id()`, `accessible_tenant_ids()`,
    `has_role_on()` (STABLE + SECURITY DEFINER + `search_path` fijo), trigger de path en INSERT,
    trigger de **re-parentado** que reescribe el subárbol y rechaza ciclos, roles `app_request`
    (sujeto a RLS) / `app_job` (BYPASSRLS) **sin contraseña en el repo**, y todas las policies.
  - Cliente: `conUsuario(db, userId, fn)` = transacción + `set_config('app.user_id', …, true)`.
- **27 tests contra Postgres real** (`pnpm test:db`), todos en verde: hermanos que no se ven, no se ve
  hacia arriba, administradores distintos aislados, membresía inactiva, soft-delete, **`1.7` vs
  `1.70`**, escritura por rol, propietario que no puede auto-ascenderse, baja lógica (sin DELETE),
  `tenant_grant` visible solo por sus dos puntas, `app_job` que ve todo, re-parentado + ciclo, y
  **`app.current_user_id()` en sus dos modos** (`SET LOCAL` y `auth.uid()` estilo Supabase) más la
  prueba de que la identidad **no queda pegada** a la conexión del pool.
- **`apps/web`** (Next 15 + React 19) mínima pero real: consume los tokens vía CSS vars generadas
  (`pnpm tokens:css`), muestra un prorrateo con `tabular-nums` y los chips de morosidad. `pnpm build`
  en verde. Servicio `app` del `docker-compose.yml` activado (Dockerfile de desarrollo con pnpm).

**Hallazgos que corrigieron el diseño de 6B (importan para 6C/6D):**
1. **`insert … returning` fallaba contra la propia RLS.** `accessible_tenant_ids()` es `STABLE`: se
   evalúa con la foto previa a la sentencia, así que la fila recién insertada "no existe" para ella y
   el RETURNING violaba la policy de SELECT. Solución: la policy de lectura de `tenant_node` acepta
   también `parent_id ∈ accesibles` (no amplía el acceso — si se ve el padre, el hijo ya está en su
   subárbol) **y** exige `deleted_at is null` en esa rama, para que un tenant dado de baja no
   reaparezca por la puerta del padre. **A tener en cuenta al escribir `0002_dominio.sql`.**
2. **El trigger de path lee bajo RLS**: colgar un nodo de un barrio ajeno falla con "parent_id
   inexistente" en vez de un error de policy. Se dejó así a propósito (el sistema no confirma la
   existencia de tenants ajenos) y el test lo documenta.
3. **`app_request` no tiene privilegio de DELETE** además de no tener policy: doble candado para que
   un dato financiero no se evapore desde la app.

**Qué NO se hizo (queda para lo próximo):**
- **`0002_dominio.sql`**: barrio con los 5 ejes versionados + `barrio_atributo_vigencia`, UF,
  `unidad_obligado` multi-obligado desde el día uno, coeficiente con cuadre, expensa, pago con origen.
- **Seed de modo demo** (~50 UF, un período liquidado) — depende de `0002`.
- **Portar el motor puro de conciliación** del gas con sus tests (doc 02).

**Estado de integración (2026-07-24, 16:55):**
- Ramas **pusheadas**: `feat/fase-6b-diseno-producto` y `feat/fase-6c-fundaciones`.
- **CI en verde en GitHub Actions** (`.github/workflows/ci.yml`): tipos → tests puros → migraciones y
  roles → **tests de RLS contra un Postgres real del runner** → tokens al día → build de la web. El
  gate corre en cada push de rama de trabajo y en el PR, con `concurrency` para no duplicar runs.
- **PRs pendientes por una caída mayor de GitHub** (componente "Pull Requests" en `major_outage`: la
  API devuelve HTTP 500 al crear un PR). Quedó un reintento automático corriendo; el orden previsto es
  PR de 6B → merge a `main` → PR de 6C (así el diff de 6C muestra solo el código nuevo). **`main` en
  el remoto sigue en el commit inicial** hasta que eso se pueda hacer.

**Cómo levantar todo (queda documentado en `README.md` y `packages/data/README.md`):**
`pnpm install` → `cp .env.example .env` → `pnpm db:up` → `pnpm db:migrate` → `pnpm db:setup` →
`pnpm dev`. Verificación: `pnpm typecheck && pnpm test && pnpm test:db && pnpm build`.

**Próximo paso sugerido:** `0002_dominio.sql` (padrón del barrio) con sus policies por `barrio_id`,
tests de aislamiento a nivel dominio y el seed de modo demo; después, el motor de conciliación.

---

## 2026-07-23 — Fase 6B: diseño de producto + roster técnico (Claude Code)

**Qué se cerró:**
- **Roster técnico de ingeniería (perfiles super-senior)** dado de alta con la estructura portable
  (persona en `agents/personas/`, wrapper en `agents/wrappers-claude/`, copia activa en
  `.claude/agents/`): `product-owner`, `analista-funcional`, `arquitecto-software`, `tech-lead`,
  `ux-designer`, `backend-dev`, `frontend-dev`, `devops`, `qa-funcional`, `qa-automation`,
  `security-engineer`, `dba-data` (12). `mobile-dev` queda para el arranque de React Native. Roster
  sincronizado en `agents/README.md`, `CLAUDE.md` §3 y `AGENTS.md` (que delega al README).
- **5 documentos de diseño en `docs/diseno/`** (+ `README.md` índice), producidos con el equipo y con
  los agentes de dominio (`legal-ph`/`contador`/`administrador-consorcios`) citando la base
  `knowledge/cordoba/` con marca de confianza:
  - `01-alcance-modulos.md`: corte de **MVP básico y mostrable** + operatoria por módulo + multi-figura
    como **5 ejes versionados** + mobile residente-primero.
  - `02-reuso-conciliacion.md`: reúso del motor puro de conciliación del gas (matcher/reglas/reversas/
    FIFO + `nodemailer`/`exceljs`), qué adaptar/descartar, y **pasos de migración** accionables.
  - `03-modelo-datos.md`: **multi-tenancy jerárquica por materialized path** (`tenant_node`+`membership`)
    con RLS por subárbol vía `app.current_user_id()`; dominio del barrio fundado en
    `REQUISITOS-MODELO-DATOS.md` (5 ejes, obligados múltiples, deuda anclada a la UF, pago con origen +
    antiduplicado, mandato de administración versionado, excepciones de aislamiento art. 2084); PDF por
    HTML→PDF en Docker.
  - `04-requisitos-dominio.md`: requisitos **legales y fiscales por figura** con fuente + marca; regla
    rectora "**nunca asumir deuda ejecutable**"; IIBB (Ley 10117, efecto `[A VERIFICAR — CRÍTICO]`),
    conceptos alcanzados/no alcanzados, superposición tasa/expensa (adicional 25% URE).
  - `05-roadmap.md`: MVP en Docker → incrementos → mobile; modo demo (seed ~50 UF); multi-banco
    por-cliente; hosting NO bloquea; **resumen ejecutivo + 3 primeros pasos**.
- `CHANGELOG.md` (`[Sin desplegar]`) actualizado.

**Decisiones tomadas por el usuario en esta fase:**
- MVP = **básico y mostrable** (padrón, expensas+liquidación mensual, liquidación PDF por UF, cobros,
  pagos manuales, proveedores/OP, reporte mensual, **exportación contable**, distribución ZIP+email
  trazable, conciliación de ingresos **no bloqueante**, modo demo). Egresos: registro/órdenes de pago +
  libro exportable; **conciliación de egresos → Inc. 2**. Comunicaciones/reservas/accesos/reclamos/
  reportes avanzados → Inc. 2.
- Tenancy por **materialized path** (sin extensiones; `ltree` opcional a futuro).
- App mobile **residente primero**.

**Qué NO se hizo (fuera de alcance, es Fase 6C):**
- No se scaffoldeó el monorepo ni el esquema real (sigue sin `package.json`); el diseño deja las
  migraciones previstas (`0001_tenancy.sql`, `0002_dominio.sql`) pero no se crearon.
- No se cargó código de producción ni se portó todavía el motor de conciliación (solo el plan de
  migración en `02`).
- **Sin commits/push** (regla del usuario para esta sesión).

**Pendientes / a validar (marcados en los docs):**
- Cerrar con fuente los `[A VERIFICAR]`/`[NO ENCONTRADO]` de `knowledge/cordoba/` (sobre todo: efecto
  del inciso de la Ley 10117, criterio de adecuación de la IPJ Córdoba, jurisprudencia del TSJ/Cámaras
  de Córdoba, tarifarias municipales vigentes). Hasta entonces van como suposición.
- Confirmaciones abiertas del ADR: hosting final, gestor de monorepo (sugerido pnpm), adapter de Auth.
- Puntos `[validar]` del modelo de datos (enum de roles, `tenant_path` denormalizado, motor de PDF
  Playwright vs `@react-pdf/renderer`, si se permite mover barrios entre administradores).

**Revisión de cierre 6B (2026-07-23):**
- **Doc 06 `06-direccion-visual.md`** agregado (ux-designer, con [fe]/[po]): 7 principios, design tokens
  con **modo oscuro desde el día uno** y 3 direcciones de paleta (recomendada **A "Verdemar"** teal+ámbar,
  para romper con el azul-admin y dejar libres los matices semánticos/morosidad), navegación multi-barrio
  con selector persistente + color por barrio, wireframes de 5 pantallas (dashboard, wizard de
  liquidación, estado de cuenta UF, cola de excepciones, distribución), patrones (`CifraTrazable`, Zod
  compartido, estados vacíos con guía), accesibilidad **WCAG AA**, y la regla 6C (toda UI con skill
  `frontend-design` + estos tokens).
- **Ratificación visual (revisión 6B — cierra los 3 pendientes):**
  - **Paleta = A "Verdemar"** (marca teal `#0D9488`, acento ámbar `#F59E0B`). B y C **descartadas** con
    motivo (B: bordó convive mal con el rojo semántico de mora; C: lectura demasiado *consumer* para el
    público administrador).
  - **Tipografía = Geist** (principal) + **Geist Mono** con `tabular-nums` para **toda** columna/cifra
    de dinero (alineación en tablas = requisito). Self-hosted, sin CDN.
  - **Acento por barrio = aprobado** con regla de sutileza: solo línea del selector + tinte leve del
    header; nunca en acciones/estados; nunca reemplaza la marca; hue en banda 230°–335° que excluye
    marca y semánticos; contraste AA. Algoritmo en doc 06 §b.5.
  - **Tokens definitivos materializados** en `packages/design-tokens/` (`tokens.ts`, `semantic.ts` con
    light+dark, `barrio-accent.ts`, `README.md`). La Fase 6C construye la UI desde ahí (el `package.json`
    y el generador de CSS vars se agregan con el scaffold del monorepo).
  - **No queda ninguna decisión visual abierta para 6C.**
- **Confirmado:** conciliación de egresos → Inc. 2 (doc 01, nota como decisión confirmada).
- **Decisión tomada — 5 ejes del barrio (doc 03 §B.1):** modelo **híbrido** — columna enum con el valor
  **vigente** (lectura caliente + validación) + tabla `barrio_atributo_vigencia` como **historial**
  (auditoría / valor a una fecha); trigger sincroniza la columna (cache derivado; la tabla de vigencias
  es la fuente de verdad).
- **Nota para 6C (doc 05):** `unidad_obligado` multi-obligado + histórico se crea en el esquema desde el
  día uno aunque la UI del MVP cargue un solo obligado (evita migración cara con datos ya cargados).

**Próximo paso sugerido:** Fase 6C — scaffold del monorepo + `packages/data` con `0001_tenancy.sql`
probado en Docker (ambos modos de `app.current_user_id()`), modelo de dominio del barrio con RLS + seed
de modo demo, y portar el motor puro de conciliación con sus tests.

---

## 2026-07-22 — Fase 6A: andamiaje de stack/infra + agentes de dominio (Claude Code)

**Qué se cerró:**
- ADR de stack e infraestructura: `docs/arquitectura/00-stack-infra.md`. Decisión: TypeScript +
  Next.js (App Router) + Zod, reusados tal cual del sistema de gas (`trazabilidad-obra-gas`);
  agnóstico de proveedor vía tres abstracciones (datos con Drizzle+RLS, auth detrás de
  `AuthProvider`, storage S3-compatible detrás de `ObjectStorage`); migraciones con `drizzle-kit`
  (SQL plano, no atado a Supabase/Prisma). Documentado qué se reusa tal cual del sistema de gas y qué
  no (llamadas directas al SDK de Supabase, RLS con `auth.uid()` directo, hacks de bundle serverless
  de Vercel — el de `outputFileTracingIncludes` para fuentes de pdfjs deja de ser necesario en Docker).
- `docker-compose.yml` + `Dockerfile.dev` + `.env.example`: Postgres + MinIO local, servicio `app`
  bajo perfil `app` (se activa recién cuando exista el Next.js real en Fase 6B).
- Tres agentes de dominio dados de alta con la estructura portable del template (persona en
  `agents/personas/`, wrapper en `agents/wrappers-claude/`, copiados a `.claude/agents/` — ya
  activos en Claude Code): `administrador-consorcios`, `legal-ph`, `contador`. `legal-ph` y
  `contador` llevan guardrails duros: solo responden con base en `knowledge/<jurisdicción-activa>/`,
  citan fuente, distinguen por figura jurídica del barrio (PH especial/conjunto inmobiliario, SA,
  asociación civil, fideicomiso), y cierran con "Validar con profesional matriculado".
- Estructura de conocimiento jurisdiccional: `knowledge/JURISDICCION-ACTIVA.md` (activa: `cordoba`) +
  `knowledge/cordoba/{nacional,provincial,municipal,jurisprudencia}/` con placeholders (**sin
  normativa real cargada todavía**) + `docs/agents/guia-carga-conocimiento.md` (qué cargar en cada
  carpeta para Córdoba y de dónde sacarlo, fuente oficial, sin transcribir texto normativo).
- `CLAUDE.md`/`AGENTS.md` sincronizados: reglas duras concretas (agnóstico de proveedor, guardrails
  de `legal-ph`/`contador`, PII/RLS multi-tenant, trazabilidad de cifras de dinero, sin secretos),
  tabla de sub-agentes con los 3 nuevos.

**Qué NO se hizo (explícitamente fuera de alcance de esta fase, es Fase 6B):**
- Diseño de producto y modelo de datos (tablas, esquema Drizzle real, roles/usuarios).
- No se scaffoldeó código de Next.js ni el monorepo (`apps/`, `packages/`) — el ADR deja la forma
  prevista pero no se creó `package.json` todavía.
- No se decidió el adapter concreto de Auth (Supabase Auth vs Cognito vs GoTrue self-hosted) ni el
  hosting final (AWS vs Vercel/Supabase vs self-hosted) — el ADR es válido para los tres, queda
  abierto hasta que el usuario lo confirme.

**A confirmar por el usuario antes de seguir (ver ADR §10):**
- Proveedor de hosting final.
- Gestor de monorepo (sugerido: pnpm workspaces, no es decisión cerrada).
- Qué fuentes de Córdoba cargar en `knowledge/` (ver `docs/agents/guia-carga-conocimiento.md`) — sin
  esto, `legal-ph` y `contador` van a responder "no tengo esa fuente cargada" ante casi todo, que es
  el comportamiento correcto del guardrail, no un bug.

**Próximo paso sugerido:** Fase 6B — diseño de producto y modelo de datos (con `administrador-
consorcios` para la operatoria, `legal-ph`/`contador` en panel para lo que dependa de figura jurídica),
recién ahí se scaffoldea `package.json`/monorepo y se activa el servicio `app` del `docker-compose.yml`.
