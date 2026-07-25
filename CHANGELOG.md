# CHANGELOG

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) + [SemVer](https://semver.org/lang/es/).
La versión se corta al desplegar a producción (ver `docs/devops/02-sdlc-git-flow.md` §5).

## [Sin desplegar]

### Added
- **Fundación de código (Fase 6C, Etapa 0)** — monorepo **pnpm workspaces** con `apps/web` (Next.js
  App Router 15 + React 19), `packages/shared` (dominio puro: dinero exacto en centavos con prorrateo
  que siempre cierra, jerarquía de tenancía, Zod), `packages/data` (Drizzle + Postgres) y
  `packages/design-tokens` (ahora con `package.json` y generador de variables CSS).
- **Aislamiento multi-tenant real y probado**: migraciones `0000_tenancy.sql` (tablas `tenant_node`,
  `membership`, `tenant_grant`, enums, índices con `text_pattern_ops`) y `0001_tenancy_rls.sql`
  (`app.current_user_id()`, `accessible_tenant_ids()`, `has_role_on()`, triggers de materialized path
  y de re-parentado, roles `app_request`/`app_job` y todas las policies). **27 tests contra Postgres
  real**: barrios hermanos que no se ven, membresía inactiva, soft-delete, prefijo `1.7` vs `1.70`,
  escritura por rol, baja lógica, `tenant_grant`, re-parentado con reescritura de paths, y
  `app.current_user_id()` **en sus dos modos** (`SET LOCAL` y `auth.uid()` de Supabase) incluida la
  no-fuga de identidad entre requests del pool.
- Gate local y en **CI (GitHub Actions)**: `pnpm typecheck`, `pnpm test`, `pnpm test:db`, tokens al
  día y `pnpm build`, con un Postgres real en el runner; corre en cada push de rama y en el PR.
  Servicio `app` del `docker-compose.yml` activado (Dockerfile de desarrollo con pnpm).

### Decided
- **Gestor de monorepo: pnpm workspaces** (cerrando el punto abierto del ADR-0000 §10).
- **El módulo contable queda FUERA del MVP** (decisión del usuario, 2026-07-24): libro contable,
  resumen fiscal por concepto y balance por figura son, en la práctica, un ERP. El MVP entrega una
  **exportación de movimientos** (planilla de ingresos/egresos con su concepto) para que el
  administrador se la pase a su contador. La clasificación fiscal se sigue guardando en el dato, así
  que evaluarlo más adelante no obliga a recargar nada. Docs 01 §1.1/§4.8 y 05 actualizados.

### Added (fases 6A y 6B)
- **Diseño de producto (Fase 6B)** en `docs/diseno/`: alcance y módulos con corte de MVP básico y
  mostrable (`01`), reúso del motor de conciliación del sistema de gas con pasos de migración (`02`),
  modelo de datos con multi-tenancy jerárquica por materialized path + RLS por subárbol (`03`),
  requisitos legales y fiscales por figura citando `knowledge/cordoba/` (`04`), roadmap por etapas con
  modo demo y multi-banco (`05`), y **dirección visual** (principios, design tokens con modo oscuro,
  navegación multi-barrio, wireframes de las 5 pantallas clave, patrones y accesibilidad AA) (`06`).
- Revisión 6B: conciliación de egresos **confirmada** en Inc. 2; **modelo híbrido** de los 5 ejes del
  barrio (columna enum vigente + `barrio_atributo_vigencia` como historial); nota de `unidad_obligado`
  multi-obligado desde el día uno en el esquema.
- **Tokens de diseño materializados** en `packages/design-tokens/` (`tokens.ts`, `semantic.ts` con
  modo claro y oscuro, `barrio-accent.ts`, `README.md`) — dirección "Verdemar" (teal + ámbar), Geist +
  Geist Mono con `tabular-nums`, acento por barrio acotado. Ratificada la dirección visual (paleta A,
  tipografía Geist, acento por barrio); doc 06 actualizado.
- **Roster técnico de ingeniería (perfiles super-senior)**: `product-owner`, `analista-funcional`,
  `arquitecto-software`, `tech-lead`, `ux-designer`, `backend-dev`, `frontend-dev`, `devops`,
  `qa-funcional`, `qa-automation`, `security-engineer`, `dba-data` (persona + wrapper, activados en
  `.claude/agents/`); tablas de roster sincronizadas en `agents/README.md`, `CLAUDE.md` §3 y `AGENTS.md`.
- Andamiaje de arquitectura (Fase 6A): ADR de stack e infraestructura agnóstica de proveedor
  (`docs/arquitectura/00-stack-infra.md`), `docker-compose.yml` (Postgres + MinIO local).
- Tres agentes de dominio: `administrador-consorcios`, `legal-ph`, `contador` (persona + wrapper,
  activados en `.claude/agents/`).
- Estructura de conocimiento jurisdiccional `knowledge/cordoba/{nacional,provincial,municipal,jurisprudencia}/`
  (placeholders, sin normativa real cargada todavía) y guía de carga (`docs/agents/guia-carga-conocimiento.md`).
