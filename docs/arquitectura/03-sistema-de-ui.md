# ADR-0003 — El sistema de UI: primitivas, `packages/ui` y el vehículo de estilado

- **Estado:** aceptado (decisión del usuario, 2026-08-03).
- **Contexto de estrategia que ordena el corte:** el objetivo inmediato es una **demo/POC** para
  mostrar capacidad a posibles clientes (estudios administradores con 1..N barrios) y relevar
  necesidades. *"Todo entra por los ojos."* Lo que la demo no necesita va a backlog **con gatillo
  escrito**, no a "algún día".
- **Insumos:** `_referencias/front/propuesta-front-ui.md` (propuesta trabajada por el usuario en
  Claude.ai — se adopta el esqueleto con las correcciones de §6) y
  `design_handoff_consorcia/` (prototipo visual — **solo insumo de producto**, ver §9, que es
  vinculante). Panel: `frontend-dev` (verificación web de versiones, agosto 2026) +
  `arquitecto-software` (cerrojos), síntesis en `_referencias/front/paquete-de-decision-front.md`.
- **Se encadena con:** ADR-0000 (agnosticismo; tokens como fuente única), ADR-0001 (el papel tiene
  sustrato propio; veto de Chromium en la web), ADR-0002 (cerrojos del grafo, reglas 1–12,
  presupuesto de recursos).

---

## 1. El problema

El stack (TypeScript + Next App Router + React) no es el límite. El límite es que **cada componente
se escribe a mano** sobre CSS Modules: botón, modal, dropdown, tabla. Eso es lento, visualmente
irregular, y deja afuera lo difícil de hacer bien (foco atrapado, teclado, ARIA, posicionamiento,
portales). La demo exige velocidad de construcción visual **sin** perder tres propiedades que ya
están construidas y verificadas:

1. **La disciplina de tokens** — 700+ referencias `var(--)`, cero hex fuera de tokens, verificado.
2. **Las pantallas de lectura cuestan cero JavaScript** (server components).
3. **El papel es intocable** — las plantillas de PDF tienen sustrato propio (`plantillas/comun.ts`,
   `fontSizePrint`, guardián `boleta-diseno.test.ts`) y un documento emitido no se reflowea.

## 2. Decisión — las seis piezas

### 2.1 Primitivas headless: **Base UI** (`@base-ui/react`)

No Radix. La propuesta original decía "default razonable: Radix" — correcto cuando se escribió,
invertido por el tiempo: Base UI está **estable desde dic 2025** (1.6 a ago 2026, ~35 componentes,
equipo ex-Radix + MUI + Floating UI) y **es el default del generador shadcn desde jul 2026**. Elegir
Radix hoy sería vendorear contra el ecosistema que se quiere aprovechar. Radix queda como fallback
documentado si Base UI no cubriera un componente puntual (hoy cubre todo el inventario de §4).

### 2.2 Patrón shadcn: componentes **vendoreados** en `packages/ui`

shadcn no se instala: sus componentes **se copian** al repo y pasan a ser código nuestro, estilado
Verdemar. Regla de la propuesta que se ratifica: **no copiar 40 componentes el día uno** — solo el
inventario de §4.

### 2.3 Vehículo de estilado: **Tailwind v4, SOLO dentro de `packages/ui`** (híbrido)

Ni la opción A pura ("Tailwind por defecto": deja a las pantallas existentes como legado sin fecha,
que es donde los front se pudren) ni la B pura (CSS Modules para todo: paga 2–3× justo donde está el
cuello de botella). El corte es **por paquete, y lo hace cumplir el build**:

- **Adentro de `packages/ui`:** Tailwind v4. Se vendorea shadcn casi verbatim.
- **Afuera (todo `apps/web`):** prohibido. Las pantallas componen desde el kit semántico en español
  (`<Panel>`, `<Chip tono="alerta">`), como hoy. El `@source` de Tailwind se configura para escanear
  **solo `packages/ui`**: una clase utilitaria tipeada en una pantalla **no compila a CSS y se ve
  rota en el acto**. El límite no es una convención: es el build (mismo espíritu que `server-only`).
- **Los `.module.css` existentes de `apps/web` se congelan, no se migran.** Mueren por atrición
  cuando cada pantalla se rehaga sobre el kit. Consumen los mismos tokens: no molestan.
- Dentro de `packages/ui` está prohibido `.module.css`; fuera de él, las clases de Tailwind. La
  frontera se verifica en el gate (§5).

### 2.4 Tokens: los TS siguen siendo **la única fuente**; Tailwind es un *sink* más

```
tokens.ts / semantic.ts  (TS — única fuente de verdad, sin cambios)
    ├─ tokens.generated.css   (ya existe: CSS vars, light/dark/data-theme)
    ├─ theme.generated.css    (NUEVO: @theme de Tailwind; cada valor es var(--token). GENERADO.)
    ├─ objetos TS directo     (React Native mañana — sin cambios)
    └─ constantes print       (packages/documentos — sin cambios; JAMÁS pasa por Tailwind)
```

- El `@theme` lo emite `pnpm tokens:css`, con cabecera "ARCHIVO GENERADO". **Nunca se edita a mano.**
- **La paleta default de Tailwind se apaga** (`--color-*: initial` y equivalentes). Sin esto,
  `bg-red-500` existe y es la segunda fuente de verdad por la puerta de atrás.
- Light/dark siguen resueltos por el mecanismo actual (`css.ts`): Tailwind no sabe de modos.
- **NativeWind queda descartado por escrito**: Tailwind es un vehículo de la web, capa de
  aplicación, no de definición. Mobile consume los objetos TS.

### 2.5 Tablas: TanStack Table **v8** (v9 está en beta: no), solo donde hay interacción real

> El default de tabla es `Tabla` (server, cero JS). Una tabla usa `TablaInteractiva` (TanStack v8
> envuelta en `packages/ui`, como isla de cliente) **solo si necesita al menos dos** de: orden por
> columna instantáneo, búsqueda/filtro instantáneo, selección múltiple de filas, mostrar/ocultar
> columnas. Orden o paginado solos se resuelven server-side con `searchParams` y links. La adopción
> se anota en el código con el motivo.

Para la demo: **una sola** — el padrón. TanStack Virtual: backlog (gatillo: el primer padrón que
degrade, medido).

### 2.6 Formularios: **sin react-hook-form** — se extiende `useFormulario`

El puente RHF ↔ `useActionState` sigue siendo artesanal (dos dueños del estado a sincronizar), y el
kit ya tiene resuelto lo caro: a11y de campos, foco al primer error, y el ciclo de confirmación de
montos inusuales con test de tres vueltas. Adoptar RHF sería tirar y recomprar eso. Lo que se agrega:
**validación en cliente dentro de `useFormulario`, con el mismo esquema Zod de
`@admin-barrios/shared`** (un `safeParse` antes de despachar la acción, pintando los mismos errores
que pintaría el servidor). El "punto de oro" —un esquema, N usos— se logra sin segundo sistema.

- **Gatillo de reevaluación de RHF:** el primer formulario con listas dinámicas y subtotales en vivo
  (`useFieldArray`). Si entra, entra **reemplazando por dentro** a `useFormulario` (misma API
  externa), nunca como segundo sistema conviviendo.

## 3. Correcciones a la propuesta original (vinculantes)

| # | La propuesta decía | Queda así, y por qué |
|---|---|---|
| 1 | Formato AR vía `Intl.NumberFormat('es-AR')` | **Rechazado.** Regla 6 de ADR-0002 §5.2, verificada en CI: sin ICU completo `es-AR` degrada a `en-US` **en silencio**. Todo formateo sale de `shared/dinero` / `shared/fechas` (misma cadena en pantalla, PDF y worker). Ojo al vendorear: los bloques de shadcn traen `toLocale*` en celdas de ejemplo — el CI los rechaza, y está bien: toda cifra entra al componente **ya formateada**. |
| 2 | date-fns "para formateo/parseo" | Permitida solo como utilidad **interna** de `shared/fechas`. Nunca como API que un componente llame directo. |
| 3 | "Wizard de liquidación (borrador → … → distribuida), el estado vive en el form" | Esos son estados del **período** (máquina de estados de la base, triggers). Las transiciones son Server Actions → servicios → triggers. Un "wizard" de UI es, a lo sumo, presentación **adentro** del estado `borrador`; hoy los pasos son rutas y siguen siéndolo. |
| 4 | Toast global (Radix Toast o sonner) en el inventario | **Backlog.** Las confirmaciones de dinero se muestran pegadas al formulario a propósito (documentado en `formulario.tsx`), y el caso asíncrono real (emisión) ya tiene su pantalla de polling. Gatillo: una acción cuyo resultado llegue cuando el usuario ya está en otra pantalla. |
| 5 | "Radix como default razonable" | Invertido por el estado del ecosistema (§2.1). |

Se ratifican tal cual: TanStack Query solo ante necesidad real; **no** adoptar suites con estética
propia (MUI/Ant/Mantine); una sola librería por función.

## 4. `packages/ui` — contrato e inventario v0

**Contrato del paquete:**
- Mapa de `exports` **explícito** (el caminante del grafo resuelve por ese mapa).
- Solo puede alcanzar `@admin-barrios/design-tokens` y `@admin-barrios/shared` (más la primitiva y
  utilidades de la primitiva). Lista de permitidos, no de prohibidos.
- **Dos estratos con nombre:** server por default (sin `"use client"`, cero JS — `Cifra`, `Chip`,
  `Panel`, `Tabla`, `Vacio`, `Skeleton`…); cliente **solo** lo que envuelve una primitiva, con
  `"use client"` en el archivo y exportado por subruta propia (`@admin-barrios/ui/cliente/*`), para
  que la frontera se vea en el import.
- No lee `process.env`. No formatea dinero ni fechas por su cuenta (recibe texto ya formateado o usa
  `shared`). Todo componente nace con claro/oscuro y foco visible.

**Inventario v0 (13 piezas; nada más sin tocar este ADR):**

Se migran del kit actual tal cual (ya cumplen): `Pagina`/`EncabezadoDePagina`/`Panel`,
`Cifra`/`Coeficiente`, `Chip`/`TiraDeChips`, `Vacio`, `Tabla`/`MarcoTabla`/`Paginado`, y todo
`formulario.tsx`.

Nuevos: **(1)** Geist + Geist Mono self-hosted y **modo oscuro encendido** (mayor salto visual por
peso; hoy corre con pila de reserva y el dark está generado y apagado) · **(2)** Shell con sidebar ·
**(3)** `SelectorDeBarrio` con acento por tenant (`barrio-accent`) · **(4)** Login · **(5)** Dialog ·
**(6)** DropdownMenu · **(7)** Tabs (envoltura visual sobre rutas — no wizard cliente) ·
**(8)** Tooltip (vehículo de la trazabilidad: el origen de la cifra al hover/foco) · **(9)** Skeleton ·
**(10)** `TablaInteractiva` (solo padrón, regla §2.5) · **(11)** `CampoDeDinero` (máscara de miles +
completa decimales — regla B-1/B-1.bis del usuario, doc 06 §e.6.bis) · **(12)** `Boton` general ·
**(13)** `TarjetaKPI`.

**Backlog con gatillo:** gráficos (elegir Recharts/visx cuando el dashboard entre al corte) ·
TanStack Virtual (padrón que degrade) · toasts (§3.4) · Motion (microinteracciones: cuando el kit v0
esté estable) · Storybook/galería · tablas server-driven (primer tenant grande) · theme para RN (al
arrancar mobile).

## 5. Cerrojos nuevos del gate

Ortogonales a la decisión de estilado — valen con cualquier opción. Se implementan en la tanda 1,
**antes** de que exista la segunda pantalla nueva:

1. **La primitiva solo desde el kit:** ningún archivo fuera de `packages/ui/src/**` importa
   `@base-ui/*` (forma de la regla 12 existente).
2. **El grafo de `packages/ui` acotado:** desde sus entradas solo se alcanza `design-tokens` +
   `shared` (+ primitiva). Veta `data`, `auth`, `documentos`, `almacenamiento`, `pg`, `drizzle-orm`,
   `@aws-sdk` de una vez.
3. **El papel jamás alcanza al kit:** el grafo desde `packages/documentos/src` no contiene
   `packages/ui` **ni `react`** entre sus externos. Con test de control (patrón del falso verde).
   Motivo: un componente de pantalla en una plantilla es un reflow silencioso del documento emitido.
4. **Los tokens de papel no salen del papel:** `fontSizePrint`, `printInk`, `printPatron`,
   `printFila`, `chartPrint` no se nombran fuera de `packages/documentos` + `design-tokens`.
   (La dirección pantalla→papel vía `semantic.ts` sigue: es a propósito — una identidad, tres
   salidas.)
5. **Regla 13:** ningún `page.tsx`, `layout.tsx`, `loading.tsx`, `template.tsx` de
   `apps/web/src/app/**` contiene `"use client"`. El chrome entra como **islas** (server-page
   resuelve datos bajo `conSesion` y pasa props serializables; la isla trae la primitiva). Es el
   patrón que `navegacion.tsx` ya usa.
6. **Las reglas 5–8 de ADR-0002 §5.2 extienden su barrido a `packages/ui/src`** (dinero, `Intl`,
   fechas de negocio, `process.env`). La excepción de la regla 8 no se extiende: el kit no lee el
   entorno.
7. **Guardián del theme:** todo valor de `theme.generated.css` es un `var()` a un token emitido;
   cero hex, cero px sueltos (espíritu de `boleta-diseno.test.ts`).
8. **Frontera de estilado:** clases de Tailwind prohibidas fuera de `packages/ui`; `.module.css`
   prohibido dentro. (Refuerza lo que el `@source` ya hace cumplir en build.)
9. **`packages/ui` NO entra a la lista blanca de `"use server"`** (regla 9): una acción no
   renderiza. La lista queda como está.

## 6. La navegación — qué se adopta del prototipo "Consorcia" (decisión del usuario)

El usuario evaluó el prototipo y decidió: **la forma en que resuelve la navegabilidad de
pantallas/módulos es acertada y se adopta**. Lo adoptado, en concreto (detalle UX en doc 06 §c.6):

1. **Dos alcances, un solo chrome:** contexto "toda la cartera" (consolidado del estudio) y contexto
   "un barrio". Lo único que cambia es el selector del header y algunos ítems del nav. **Nunca dos
   navegaciones distintas.**
2. **El selector según cuántos barrios tiene asignados el usuario:** 1 → no es selector, es título
   fijo; 2–9 → lista simple, y el home son tarjetas de trabajo por barrio (no el consolidado);
   10+ → buscador + fijados + "toda la cartera" solo si el rol la tiene.
3. **Cambiar de barrio conserva la sección actual** (de Gastos de A a Gastos de B). Atajo de teclado
   (⌘K / Ctrl+K) abre el selector.
4. **A un rol no se le muestran acciones que no puede ejecutar** — no botones deshabilitados. La
   vista de solo lectura lleva su sello.
5. **La entrada a un período es por su resumen**, y la lista de períodos lleva la card del período en
   curso con "continuar" (coincide con las observaciones A-2/A-3 del recorrido del usuario).

**Lo que NO se adopta del prototipo** (ya analizado en `docs/producto/analisis-handoff-consorcia.md`
y en este ADR): su modelo de datos, sus roles, sus estados, su vocabulario de PH, su paleta, sus
criterios de aceptación. Ver §9.

## 7. Plan de adopción — tres tandas

1. **Setup + shell:** Tailwind acotado + `theme.generated.css` + fuentes + dark encendido + los
   cerrojos de §5 + sidebar + DropdownMenu + `SelectorDeBarrio`. **Incluye el segundo barrio del
   seed** (sin él, el selector no es demostrable — observación E-1).
2. **Spike: login → shell → elegir barrio.** No el dashboard (obligaría a decidir la librería de
   gráficos, que está en backlog). Criterios de éxito: Verdemar en claro y oscuro con cero hex
   nuevos; teclado y lector completos; regla 13 en verde; cambiar de barrio cambia el acento; los
   guardianes de §5 corren en el gate.
3. **Resto del kit v0 + pantallas existentes re-enmarcadas** en el shell (incluye las correcciones
   de navegación A-1..A-5 del recorrido).

## 8. La dirección visual

**Verdemar (doc 06 §b.1) queda ratificada por el usuario (2026-08-03).** Todo el theme se genera
desde sus tokens. Revisitar la dirección (p. ej. el azul del prototipo) es una decisión **previa y
aparte** que tiñe el sistema entero; no se toma dentro de este ADR.

## 9. El estatus de `design_handoff_consorcia/` — vinculante

> **`design_handoff_consorcia/` es INSUMO DE PRODUCTO, no fuente de verdad.** Sirve como inventario
> de pantallas, referencia visual y batería de reglas para contrastar. **Su `PROMPT.md` no se
> ejecuta.** Su modelo de datos (`schemas.ts`), sus fixtures, sus roles (`ADMIN_TENANT`…), sus
> estados (`CERRADA`/`ANULADA`), su vocabulario (consorcio/UF/expensas hardcodeado) y sus criterios
> de aceptación **no se adoptan**: donde difieran del repo, **el repo gana siempre** — nomenclatura,
> roles, estados, modelo, tokens y reglas de CI. Lo único adoptado es lo que este ADR §6 y doc 06
> §c.6 enumeran, y el análisis completo está en `docs/producto/analisis-handoff-consorcia.md`.
>
> Esta regla existe porque el `PROMPT.md` de esa carpeta es un prompt listo para pegar que, ejecutado
> sin este contexto, **arranca un segundo producto** dentro del repo. Los encabezados de advertencia
> en la propia carpeta apuntan acá.

## 10. Riesgos aceptados

- **Dos vocabularios de estilado conviven** (Tailwind en el kit, CSS Modules congelados en
  pantallas). Mitigado por: frontera por paquete, build que rompe a la vista, regla en el gate, y
  atrición programada. Reversible en las dos direcciones (ampliar `@source` o desarmar el paquete).
- **Base UI es más joven que Radix.** Mitigado por: estable hace 8+ meses, default del ecosistema,
  y el patrón vendoreado (el código queda en el repo; migrar de primitiva es cambiar el backend de
  ~6 componentes de cliente, no las pantallas).
- **El inventario puede quedar corto.** A propósito: agregar una pieza cuesta una línea en este ADR;
  sacar una que nadie usa cuesta una migración de pantallas.
