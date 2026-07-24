# CHANGELOG

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) + [SemVer](https://semver.org/lang/es/).
La versión se corta al desplegar a producción (ver `docs/devops/02-sdlc-git-flow.md` §5).

## [Sin desplegar]

### Added
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
