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

## Personas de dominio — administración de barrios/consorcios

| Persona (nombre único) | Qué hace | Cuándo convocar |
|---|---|---|
| `administrador-consorcios` | Operatoria de recaudación/gestión: expensas (ordinarias/extraordinarias, coeficientes, fondo de reserva, mora), cobros, pagos, proveedores. | Al diseñar cualquier flujo de liquidación o gestión operativa. |
| `legal-ph` | Legal argentino multi-figura (PH especial/conjunto inmobiliario, SA, asociación civil, fideicomiso). Guardrails: solo `knowledge/`, cita fuente, distingue por figura jurídica, cierra con "Validar con profesional matriculado". | Encuadre legal, ejecutividad de cobro, reglamentos/actas. |
| `contador` | Tratamiento contable/fiscal de la operatoria, según figura jurídica y jurisdicción activa. Mismos guardrails que `legal-ph`. | Liquidación desde el ángulo contable, obligaciones fiscales provinciales/municipales. |

`legal-ph` y `contador` leen **exclusivamente** de `knowledge/<jurisdicción-activa>/` (ver
`knowledge/JURISDICCION-ACTIVA.md`; hoy `cordoba`) — nunca inventan normativa que no esté cargada ahí.
Ver `docs/agents/guia-carga-conocimiento.md` para qué cargar en Córdoba y de dónde sacarlo.

Las personas de grano más fino propuestas en `PROXIMO-PROYECTO-barrios.md` (`expensas-contabilidad`,
`reservas-espacios`, `control-accesos`, `comunicacion-residentes`, `reclamos-tickets`) quedan como
candidatas para cuando exista el modelo de producto (Fase 6B en adelante); no compiten con las tres de
arriba, que son los **expertos de dominio** (operativo/legal/contable) convocables desde ya.

## Roster técnico — ingeniería (perfiles super-senior)

Equipo de roles de ingeniería dado de alta en la Fase 6B para diseñar el producto y construirlo en
6C. Cada uno es un perfil **super-senior** con criterio de decisión y guardrails propios.

| Persona (nombre único) | Qué hace | Cuándo convocar |
|---|---|---|
| `product-owner` | Dueño del valor y la priorización; define el corte del MVP y los criterios de aceptación de producto. | Al definir o priorizar alcance de un incremento. |
| `analista-funcional` | Traduce negocio y conocimiento de dominio a requisitos, casos de uso y criterios de aceptación trazables a la fuente. | Al detallar una feature antes de construirla. |
| `arquitecto-software` | Custodio del ADR-0000 y las abstracciones de portabilidad; arquitectura, límites de capas, RLS multi-tenant, reuso del gas. | Ante cualquier decisión de arquitectura o riesgo de acoplamiento a proveedor. |
| `tech-lead` | Estándares, descomposición en tareas, orquesta revisiones y gate técnico pre-merge. | Al partir una feature o antes de mergear un cambio no trivial. |
| `ux-designer` | Flujos, wireframes, accesibilidad y design-tokens (administrador web / residente mobile). | Al diseñar una pantalla o flujo nuevo. |
| `backend-dev` | Dominio, servicios y capa de datos (TS/Next/Drizzle/Postgres/Zod) con RLS y trazabilidad de dinero. | Al implementar lógica, endpoints, migraciones o jobs. |
| `frontend-dev` | UI web del administrador (React/Next App Router, CSS Modules + tokens), sin lógica de negocio en el cliente. | Al construir pantallas, formularios, tablas, exportaciones. |
| `devops` | Docker/compose, CI, migraciones en el pipeline, dos entornos, job-runner neutral, presupuesto de recursos. | Al preparar entornos, deploys, migraciones o jobs. |
| `qa-funcional` | Casos de prueba, criterios de aceptación ejecutables y UAT end-to-end. | Antes de cerrar una feature o incremento. |
| `qa-automation` | Estrategia y suites automatizadas (Vitest/e2e), gates de CI, datos sintéticos, cobertura de RLS. | Al definir estrategia de test o automatizar regresión. |
| `security-engineer` | Modelado de amenazas, aislamiento multi-tenant/RLS, PII/dinero, secretos, authz por rol. | Ante cambios que tocan datos personales, dinero, permisos o aislamiento. |
| `dba-data` | Modelado físico Postgres, índices, RLS performante, migraciones, versionado temporal, endurecimiento de tenant. | Al diseñar/tocar esquema, índices o RLS; ante queries lentas. |

> `mobile-dev` (React Native/Expo) se da de alta cuando arranque la app mobile (etapa posterior).
> Los genéricos `code-reviewer`, `tester` y `documentador` se mantienen: el `tech-lead` convoca a
> `code-reviewer`; `qa-funcional`/`qa-automation` complementan a `tester` (no lo reemplazan).

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
