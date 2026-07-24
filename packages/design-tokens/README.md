# `packages/design-tokens`

Fuente de verdad de la **identidad visual** de `admin-barrios` — dirección **"Verdemar"** (elegida en la
Fase 6B; ver [`docs/diseno/06-direccion-visual.md`](../../docs/diseno/06-direccion-visual.md)).

Son **objetos TypeScript planos**: no dependen de CSS ni de StyleSheet, así el **mismo** valor viaja a
web y a mobile (ADR-0000 §2.1). Nada de hex/px sueltos en la UI — si falta un valor, se agrega acá
primero (con su par light/dark validado por contraste) y después se usa (doc 06 §g).

## Archivos

| Archivo | Qué contiene |
|---|---|
| `tokens.ts` | Primitivos: paleta (marca teal + acento ámbar + neutros), **tipografía** (Geist / Geist Mono + `tabular-nums` para dinero), espaciado, radios, sombras (light + dark). |
| `semantic.ts` | Tokens **semánticos por modo** (`light` / `dark`): fondo, superficie, texto, borde, primario, acento, éxito/alerta/peligro/info, **escala de morosidad**, **estados de liquidación** y **fondo de reserva**. La UI referencia estos, nunca un hex. |
| `barrio-accent.ts` | **Acento por barrio** (identidad de tenant): `acentoBarrio(id, mode)` — hue estable derivado del `id`, en una banda que excluye marca y semánticos; uso acotado (solo refuerzo del tenant activo). |

## Uso previsto (se cablea en Fase 6C)

- **Web (Next + CSS Modules):** un generador vuelca cada `Scheme` de `semantic.ts` a variables CSS
  (`:root { --bg: … }` y `:root[data-theme='dark'] { --bg: … }`); los CSS Modules usan `var(--bg)`.
  El selector de tema estampa `data-theme` en `:root` (default = `prefers-color-scheme`).
- **Mobile (React Native/Expo):** `theme.ts` arma los `StyleSheet` desde estas constantes;
  `useColorScheme()` elige `light`/`dark`.
- **PDF (Playwright HTML→PDF):** reusa las mismas plantillas y tokens (doc 03 §C) → una sola identidad
  visual, tres salidas.

## Reglas duras

- **Dinero:** `font.numeric` (Geist Mono) + `font-variant-numeric: tabular-nums` en **toda** columna o
  cifra de dinero (alineación en tablas = requisito).
- **Color con significado:** los tokens de estado (morosidad, liquidación, envío) van **siempre** con
  ícono + texto además del color (WCAG AA, doc 06 §f).
- **Acento por barrio:** solo refuerzo del tenant (línea del selector + tinte del header); nunca en
  acciones ni estados; nunca reemplaza la marca.

> El `package.json` y el generador de CSS vars se agregan al scaffoldear el monorepo (Fase 6C). Los
> **valores** ya son definitivos.
