# 05 — Roadmap por etapas

> **Fase 6B — diseño de producto.** Plan por etapas: MVP básico y mostrable (Docker local) → incrementos
> → app mobile. **La decisión de hosting es un hito posterior y NO bloquea** el roadmap (el diseño es
> válido para AWS/Vercel-Supabase/self-hosted). Alineado con el SDLC (`docs/devops/02-sdlc-git-flow.md`:
> ramas `feat/<slug>`, dos entornos prod/testing, Conventional Commits, SemVer/CHANGELOG) y las reglas de
> optimización de recursos (`03-reglas-desarrollo-optimizado.md`), sin atarlas a un proveedor.

## Etapa 0 — Fundaciones (antes de cualquier módulo)

1. **Scaffold del monorepo** (`apps/web`, `packages/{shared,data,design-tokens}`; gestor sugerido
   **pnpm workspaces** [a confirmar]); activar el servicio `app` del `docker-compose.yml`.
2. **`packages/data`** con las migraciones `drizzle-kit` en SQL plano:
   - `0001_tenancy.sql`: schema `app`, enums, `tenant_node` (+ trigger de path), `membership`,
     funciones `app.current_user_id()` / `accessible_tenant_ids()` / `has_role_on()`, roles `app_request`
     / `app_job` (ver [`03-modelo-datos.md`](03-modelo-datos.md)).
   - `0002_dominio.sql`: barrio (5 ejes versionados), UF, obligados, coeficiente, expensa, pago, etc.
3. **Probar `app.current_user_id()` en ambos modos** (self-hosted con `SET LOCAL app.user_id` y el stub
   `auth.uid()` no-op; y en Supabase si aplica) — es la pieza nueva marcada por el ADR §8.
4. **Gate técnico base**: typecheck + Vitest + (build web) en CI; una feature con migración a la vez en
   testing; datos sintéticos (sin PII real).

> **Nota para 6C — obligados desde el día uno.** La estructura de **múltiples obligados por UF**
> (`unidad_obligado` con histórico; deuda anclada a la UF, arts. 2049/2050) se crea en el esquema
> **desde el día uno** (en `0002_dominio.sql`), **aunque la UI del MVP muestre y cargue un solo obligado
> por unidad**. Cambiar esto más tarde, con datos ya cargados, es una migración cara; con la tabla ya en
> su forma final, la **UI multi-obligado llega después sin migración**. Misma lógica para el histórico de
> titulares.

## MVP — administrar un barrio real en Docker local

Secuencia sugerida (cada ítem es una o varias ramas chicas, con panel de dominio donde toca dinero/PII):

1. **Padrón** — barrios (5 ejes), UF (estado, manzana/lote, `1..N` emails), obligados (múltiples,
   histórico, deuda anclada a la UF), coeficientes con **validación de cierre**.
2. **Expensas + liquidación mensual** — ordinarias/extraordinarias (extraordinaria con respaldo de
   asamblea), fondo de reserva separado, mora versionada, prorrateo por coeficiente; estados de la
   liquidación con período cerrado inmutable.
3. **Liquidación PDF por UF** — HTML→PDF en job (Docker; ver doc 03 §C).
4. **Cobros** — estado de cuenta por UF, imputación con orden **configurable**.
5. **Pagos manuales** — origen/usuario/comprobante + **flag antiduplicado**.
6. **Proveedores / Órdenes de pago** — alta + OP imputada a barrio/período + estados.
7. **Exportación contable** — libro ingresos/egresos + resumen IIBB (conceptos separados) + balance
   simple por figura (**→ contador**; ver doc 04 Parte C).
8. **Distribución** — ZIP a carpeta (`ObjectStorage`/`FileDestination`) + **email 1‑a‑1** con dos
   adjuntos (liquidación individual + reporte mensual), con **registro de envíos** (reuso `nodemailer`).
9. **Conciliación automática de ingresos** — reuso del motor del gas (ver
   [`02-reuso-conciliacion.md`](02-reuso-conciliacion.md)). **No bloqueante de la demo:** si atrasa, la
   demo sale con carga manual de cobros.

### Modo demo (transversal al MVP)

**Seed de datos realistas** para presentaciones a administradores: 1 barrio (~50 UF, con baldías),
propietarios con morosos, **un período liquidado** de punta a punta (liquidación → PDF → estado de
cuenta → algunos pagos conciliados). Sirve además de fixture para los tests de `qa-automation` (sin PII
real).

### Multi-banco (trabajo por-cliente, incremental)

La ingesta de extractos es un **adapter por banco** detrás de `ExtractoBancarioSource`. Cada
administración cliente puede operar con un banco distinto → los adapters se agregan **de a uno, por
cliente**, a medida que se incorporan. Es trabajo **incremental**, no un big-bang; el arranque cubre el
primer banco real y el resto entra bajo demanda.

## Incremento 2

- **Comunicaciones a residentes** (broadcast/avisos generales, más allá de la liquidación).
- **Reservas de espacios comunes** (art. 2083), **Control de accesos/visitas** (3 categorías, permiso
  personal e intransferible), **Reclamos/Tickets**.
- **Reportes/indicadores avanzados** (comparativos, morosidad avanzada).
- **Conciliación automática de egresos** (mismo motor; pagos a proveedores).
- **Destinos Drive/OneDrive** para distribución (interfaz `FileDestination` ya en MVP; los adapters con
  OAuth entran acá por complejidad).

## App mobile (etapa posterior) — residente primero

React Native/Expo, cara del **residente**: ver/pagar expensas, avisos, reservas, visitas (ver doc 01
§5). Se da de alta el agente `mobile-dev`. El administrador sigue en web.

## Hitos posteriores (no bloquean el diseño)

- **Decisión de hosting** (AWS RDS+S3 / Vercel+Supabase / self-hosted): al decidirse, completar los
  marcadores de `docs/devops/01-entornos.md` y elegir el adapter concreto de `AuthProvider`. El diseño
  no se bloquea esperándola.
- **Adapter de Auth** inicial; **identidad visual** (paleta/tokens reales, skill `frontend-design`).

## Alineación con SDLC y recursos

- **Ramas**: `feat/<slug>` desde `main`, PRs chicos; una tarea = una rama. **Versionado** SemVer en
  `CHANGELOG.md` (se corta al desplegar a prod). **Migraciones** aditivas a prod (con aprobación) antes
  del merge; expand/contract para cambios destructivos.
- **Recursos**: medir antes de optimizar; índices en `WHERE`/`JOIN`; disparo por **evento** sobre cron
  ancho; PDF/exportación en **job** con presupuesto de tiempo; cuidar Disk IO y egress.

---

## Resumen ejecutivo (cierre de la Fase 6B)

El **MVP** es una solución básica y mostrable a administradores, corriendo en **Docker local**: padrón
(barrios con sus **5 ejes jurídicos versionados**, UF que incluyen baldías, obligados con deuda anclada
a la unidad), **liquidación mensual** de expensas ordinarias/extraordinarias con fondo de reserva y mora
versionada, **liquidación en PDF por UF**, **cobros** con estado de cuenta, **pagos manuales** con
antiduplicado, **proveedores/órdenes de pago**, **reporte mensual por barrio**, **exportación contable**
(libro + resumen IIBB por concepto + balance por figura) y **distribución** por ZIP y email 1‑a‑1
trazable; la **conciliación automática de ingresos** (reuso del gas) va en MVP pero **no bloquea la
demo**. Del **sistema de gas** reutilizamos el **motor puro de conciliación** (matching por CUIT/alias/
DNI/nombre, imputación FIFO, reversas) más `nodemailer` y `exceljs`, reescribiendo la capa de I/O contra
un esquema **multi-tenant por barrio**; el gas es single-tenant con `auth.uid()` directo, así que **todo
el aislamiento se rehace** con RLS por subárbol y `app.current_user_id()`. La **multi-figura** se maneja
tratando la figura (y los otros 4 ejes) como **atributos versionados del barrio** que ramifican la
denominación de los conceptos, la ejecutividad del cobro y el encuadre fiscal — con la regla rectora de
que el sistema **nunca asume que la deuda es ejecutable** y cierra lo legal/fiscal con "Validar con
profesional matriculado". El aislamiento entre barrios de un mismo administrador es total (hermanos no
se ven), con excepciones auditadas para servidumbres (art. 2084).

**Primeros 3 pasos para empezar a construir:**
1. **Scaffold** del monorepo + `packages/data` con `0001_tenancy.sql` (tenant_node / membership /
   `app.current_user_id()` / RLS por subárbol) **probado en Docker** en ambos modos.
2. **Modelo de dominio del barrio** (5 ejes versionados + UF + obligados + coeficiente con cuadre +
   expensa + pago con origen) con `barrio_id` y RLS, más el seed del **modo demo**.
3. **Portar el motor puro de conciliación** del gas con sus tests-spec y enchufar la interfaz
   `EstadoCuentaCorriente` en su implementación **"expensas"**.
