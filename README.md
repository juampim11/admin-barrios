# Template de proyecto — arranque optimizado y multi-agente

> **Qué es esto.** Un punto de partida **listo para usar** para arrancar un proyecto de software
> nuevo, que viene con tres cosas ya resueltas desde el día cero:
> 1. **Dos entornos separados** (producción y testing) para no romper datos reales al probar.
> 2. **Una forma ordenada de trabajar cada cambio** (ramas, revisión, versiones) que evita el caos.
> 3. **Un equipo de "sub-agentes" de IA** que funciona igual en **Claude Code** y en **Codex**.
>
> Está escrito para que lo pueda seguir **alguien no técnico**. Es **genérico**: no está atado a
> ningún proveedor (sirve con Vercel/Supabase, con AWS, o con lo que elijas) y no depende de nada
> fuera de esta carpeta.

---

## Qué hay adentro

```
<raíz del proyecto nuevo>/
├── README.md                     ← este archivo
├── CLAUDE.md                     ← instrucciones para Claude Code (con marcadores a completar)
├── AGENTS.md                     ← instrucciones para Codex (con marcadores a completar)
├── docs/
│   └── devops/
│       ├── 01-entornos.md                     ← los dos entornos, neutral de proveedor
│       ├── 02-sdlc-git-flow.md                ← cómo se trabaja cada cambio, de principio a fin
│       └── 03-reglas-desarrollo-optimizado.md ← presupuesto de recursos + buenas prácticas
└── agents/
    ├── README.md                 ← cómo funciona el equipo de sub-agentes (y cómo activarlo)
    ├── personas/                 ← la definición de cada agente (fuente de verdad)
    └── wrappers-claude/          ← lo que se copia a .claude/agents/ para Claude Code
```

## Los marcadores (`<ASI>`)

Todo lo específico de un proyecto está escrito como **marcador entre `< >`**. Reemplazalos por lo
tuyo. Los más importantes:

| Marcador | Qué poner |
|---|---|
| `<NOMBRE_PROYECTO>` | El nombre de tu proyecto |
| `<DESCRIPCION_PROYECTO>` | Una línea de qué hace |
| `<PROVEEDOR_HOSTING>` | Dónde vive la web (ej. Vercel, Netlify, AWS) |
| `<PROVEEDOR_BD>` | Dónde vive la base de datos (ej. Supabase, Neon, RDS) |
| `<RAMA_PRODUCCION>` | La rama de producción (por defecto `main`) |
| `<URL_BASE_DATOS_PROD>` / `<URL_BASE_DATOS_TESTING>` | Las direcciones de cada base |
| `<REGLA_DURA_1..4>` | Las reglas que tu proyecto nunca rompe |
| `<COMANDO_TYPECHECK>` / `<COMANDO_TESTS>` / `<COMANDO_BUILD>` | Los comandos de calidad |
| `<COMANDO_MIGRACIONES>` / `<COMANDO_REGENERAR_TIPOS>` | Los comandos de base de datos |

> Consejo: buscá `<` en toda la carpeta para encontrar todos los marcadores pendientes.

---

## Cómo empezar un proyecto nuevo (orden de pasos)

1. **Copiá esta carpeta** como raíz de tu repo nuevo (o convertila en un repo "template" de GitHub —
   ver la nota al final).
2. **Completá los marcadores** en `CLAUDE.md`, `AGENTS.md` y los `docs/devops/*`. Empezá por el
   nombre, el proveedor y las reglas duras.
3. **Activá los sub-agentes en Claude Code:** copiá `agents/wrappers-claude/*.md` a la carpeta
   `.claude/agents/` de tu repo. (Codex no necesita este paso: usa `agents/personas/` directamente.)
4. **Leé `docs/devops/01-entornos.md`** y creá los **dos entornos** (producción y testing) en tu
   proveedor. Cargá las variables en los dos scopes.
5. **Leé `docs/devops/02-sdlc-git-flow.md`** y adoptá el flujo de ramas desde el primer commit.
6. **Sumá tus personas de dominio:** copiá el patrón de `agents/personas/` para los roles propios de
   tu proyecto. Si vas a construir un sistema de administración de barrios/consorcios, ya tenés una
   propuesta lista en `PROXIMO-PROYECTO-barrios.md` (fuera de esta carpeta, en la raíz del template).
7. **Creá tu `CHANGELOG.md` y tu `HANDOFF.md`** (bitácora) vacíos y empezá a registrar desde el día 1.

Con eso, el proyecto **nace ordenado**: entornos aislados, flujo de trabajo claro y un equipo de
agentes que rinde igual en las dos herramientas.

---

## Convertir esto en un repo "template" de GitHub (opcional)

Si querés reutilizarlo muchas veces, conviene dejarlo como **repositorio "template"** de GitHub (con
el botón **"Use this template"**), en vez de copiar la carpeta a mano cada vez. Los pasos exactos y la
comparación de pros/contras están en la recomendación que acompaña a este template.

---

_Template genérico. Los documentos concretos que le dieron origen (en el proyecto madre) están
indexados en el `docs/README.md` de ese repo._
