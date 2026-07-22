# CLAUDE.md — Instrucciones para Claude Code (`<NOMBRE_PROYECTO>`)

> Puntero fino. La fuente de verdad vive en `docs/` y en las personas de `agents/personas/`. Codex usa
> `AGENTS.md`, que apunta a los mismos documentos. Mantener ambos sincronizados en lo operativo y **no**
> duplicar contenido de dominio acá.

## 0. Antes de tocar nada

1. Leé `docs/devops/01-entornos.md` (entornos), `02-sdlc-git-flow.md` (cómo se trabaja cada cambio) y
   `03-reglas-desarrollo-optimizado.md` (presupuesto de recursos y buenas prácticas).
2. Leé la última entrada de `HANDOFF.md` (o `<BITACORA>`) para saber en qué estado quedó el trabajo.
3. Si vas a trabajar en un dominio específico, **adoptá la persona** correspondiente en
   `agents/personas/<persona>.md` (o usá el subagente en `.claude/agents/`).

## 1. Reglas duras (no negociables) — completá con las tuyas

1. `<REGLA_DURA_1>` (ej.: el sistema nunca ejecuta operaciones irreversibles sin confirmación).
2. `<REGLA_DURA_2>` (ej.: lógica de negocio determinística; sin LLM en el núcleo).
3. `<REGLA_DURA_3>` (ej.: modelos canónicos primero; toda fuente externa entra por un adapter).
4. `<REGLA_DURA_4>` (ej.: datos personales con control de acceso por rol; nada de PII fuera de los roles autorizados).
5. **Nada de secretos en el repo.** Todo por variables de entorno (`.env.example`).

## 2. Convenciones técnicas

- `<LENGUAJE_Y_TIPADO>` (ej.: TypeScript estricto; validación de límites con `<LIB_VALIDACION>`).
- Dominio en `<IDIOMA_DOMINIO>`; plomería técnica en inglés. Comentarios en `<IDIOMA_COMENTARIOS>`.
- Commits: **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- Una tarea = una rama (`feat/<slug>`). PRs chicos y revisables.
- Migraciones: nunca editar una ya aplicada; crear una nueva con prefijo incremental; regenerar tipos
  con `<COMANDO_REGENERAR_TIPOS>`.
- **Flujo completo** (ramas → entornos → deploy → versionado): `docs/devops/02-sdlc-git-flow.md`.
  Versionado en `CHANGELOG.md`.

## 3. Sub-agentes disponibles (`.claude/agents/`)

Roster y protocolo portable: `agents/README.md`. Los nombres del sub-agente y de su persona son el
mismo (= filename en `agents/personas/`).

| Sub-agente | Para qué |
|---|---|
| `code-reviewer` | Revisa el diff: bugs de correctitud + simplificación/reuso/eficiencia |
| `documentador` | Docs, README, CHANGELOG y bitácora sincronizados con el código |
| `tester` | Verificación adversarial y estrategia de test (intenta romper antes del "Done") |
| `<PERSONA_DOMINIO_1>` | `<qué hace>` |
| `<PERSONA_DOMINIO_2>` | `<qué hace>` |

## 4. Handoff

Escribí una entrada en `HANDOFF.md` **apenas se cierra el DoD** de una tarea o decisión (no esperes al
final de la sesión). La otra herramienta (Codex) lee la misma bitácora y retoma. **Lo que no está
escrito en `HANDOFF.md` o en los docs, no existe para la otra herramienta.**
