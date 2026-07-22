# Sub-agentes portables — estructura y roster

> Estructura de sub-agentes **portable**: la misma fuente de verdad sirve para **Claude Code** y para
> **Codex** (u otro agente compatible con `AGENTS.md`), sin duplicar contenido.

## El modelo en una frase

**La fuente de verdad son las personas** (`agents/personas/*.md`): el rol completo, **neutral a la
herramienta**. Encima:

- **Claude Code** expone cada persona como sub-agente vía un **wrapper fino** en `.claude/agents/`
  (frontmatter `name` + `description` + un cuerpo que dice "Leé `agents/personas/<persona>.md`").
- **Codex** no auto-descubre `.claude/agents/`; en cambio **"adopta la persona"** leyendo el mismo
  `agents/personas/<persona>.md`, siguiendo el protocolo de `AGENTS.md`.

```
              agents/personas/<persona>.md   ← FUENTE DE VERDAD (rol completo, neutral)
                 ▲                       ▲
   "Leé la persona"                       "Adoptá la persona" (AGENTS.md)
                 │                       │
   .claude/agents/<x>.md            AGENTS.md
   (wrapper fino, Claude Code)      (protocolo de adopción, Codex)
```

**Regla de oro: un agente = un nombre.** El nombre del wrapper de Claude Code y el de la persona que
adopta Codex **son el mismo** (= el filename en `agents/personas/`).

## Contenido de esta carpeta

```
agents/
├── README.md                 ← este archivo (roster + cómo funciona + activación)
├── personas/                 ← FUENTE DE VERDAD (neutral, se lee en las dos herramientas)
│   ├── code-reviewer.md
│   ├── documentador.md
│   └── tester.md
└── wrappers-claude/          ← wrappers finos; copiar a .claude/agents/ para activar en Claude Code
    ├── code-reviewer.md
    ├── documentador.md
    └── tester.md
```

## Roster base (propósito general)

| Persona (nombre único) | Qué hace | Cuándo convocar |
|---|---|---|
| `code-reviewer` | Revisa el diff buscando bugs de correctitud y oportunidades de simplificación/eficiencia. | Antes de mergear cualquier cambio no trivial. |
| `documentador` | Mantiene docs, README, CHANGELOG y la bitácora sincronizados con el código. | Al cerrar una feature o decisión; cuando la doc quedó atrás. |
| `tester` | Diseña y ejercita pruebas; intenta **romper** el cambio antes del "Done". | Antes de cerrar toda tarea sensible, aunque el gate esté verde. |

> Estos 3 son la base. Agregá **personas de dominio** propias de tu proyecto (ver
> `PROXIMO-PROYECTO-barrios.md` como ejemplo de sub-agentes específicos).

## Activación en un proyecto nuevo

1. **Claude Code:** copiá `agents/wrappers-claude/*.md` a **`.claude/agents/`** (Claude Code
   auto-descubre esa carpeta). Los wrappers ya apuntan a `agents/personas/<persona>.md`.
2. **Codex:** nada que copiar — `AGENTS.md` ya instruye adoptar personas desde `agents/personas/`.
3. Ajustá `CLAUDE.md` y `AGENTS.md` con el nombre y las reglas de tu proyecto (`<ASI>`).

## Checklist de sincronía (al agregar o renombrar una persona)

- [ ] `agents/personas/<nombre>.md` — el rol (fuente de verdad).
- [ ] `agents/wrappers-claude/<nombre>.md` — wrapper con **el mismo nombre** (y, si ya activaste,
      copialo también a `.claude/agents/`).
- [ ] Esta tabla de roster (arriba).
- [ ] Si cambia **cuándo se la convoca**: la matriz/proceso de tu equipo.
