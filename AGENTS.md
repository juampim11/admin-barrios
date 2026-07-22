# AGENTS.md — Instrucciones para agentes (Codex y compatibles) — `<NOMBRE_PROYECTO>`

> Puntero fino. La fuente de verdad vive en `docs/` y en `agents/personas/`. Claude Code usa
> `CLAUDE.md`, que apunta a los mismos documentos. Ambos se mantienen sincronizados en lo operativo;
> el contenido de dominio **no** se duplica acá.

## 0. Antes de tocar nada

1. Leé `docs/devops/01-entornos.md`, `02-sdlc-git-flow.md` y `03-reglas-desarrollo-optimizado.md`.
2. Leé la última entrada de `HANDOFF.md` para conocer el estado actual.
3. Para trabajar en un dominio específico, **adoptá la persona** correspondiente leyendo
   `agents/personas/<persona>.md`. Las personas son neutrales a la herramienta; las mismas que Claude
   Code expone como sub-agentes.

## 1. Reglas duras (idénticas a CLAUDE.md)

Ver `CLAUDE.md` §1 (`<REGLA_DURA_1..4>` + sin secretos en el repo). **No** reescribir acá.

## 2. Convenciones técnicas

Idénticas a `CLAUDE.md` §2 (tipado estricto, validación de límites, Conventional Commits, una tarea
por rama, migraciones inmutables, regenerar tipos tras cambios de esquema). Ver `CLAUDE.md` para el
detalle; **no** reescribir acá.

## 3. El equipo (personas en `agents/personas/`)

**Roster completo y cuándo convocar cada persona: `agents/README.md`** (índice único, misma fuente
para Codex y Claude Code — no se re-lista acá para que no diverjan). El nombre de cada persona es el
mismo en las dos herramientas (= filename en `agents/personas/`).

## 4. Handoff (protocolo transparente)

Agregá una entrada en `HANDOFF.md` apenas se cierra el DoD de una tarea o decisión. Claude Code lee la
misma bitácora y retoma. Regla de oro: **lo que no está escrito en `HANDOFF.md` o en los docs, no
existe para la otra herramienta.**

## 5. Convocatoria de sub-agentes en Codex (protocolo)

Codex **no auto-descubre** los sub-agentes de `.claude/agents/`. Para trabajar como el mismo equipo,
**adopta personas en secuencia**:

1. Leé el archivo `agents/personas/<persona>.md` **completo**.
2. Anunciá el cambio de sombrero, p. ej. `=== [Code Reviewer] ===`, y respondé **solo** desde ese rol
   y sus límites.
3. Al terminar, cerrá el rol: `=== [fin Code Reviewer] ===`.
4. Toda conclusión queda **escrita** (en la doc o en `HANDOFF.md`): lo que no está escrito no existe
   para Claude Code.
