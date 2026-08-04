# HANDOFF — bitácora de handoff entre herramientas

> Regla de oro: **lo que no está escrito acá o en `docs/`, no existe para la otra herramienta.**
> Entradas nuevas arriba (orden cronológico inverso).

---

## 2026-08-04 (noche) — Tanda 1 commiteada, y las cinco trabas del recorrido resueltas

**Estado:** dos commits en `feat/boleta-de-expensas`. Gate completo en verde: **489 unitarios**,
**320 contra Postgres**, `pnpm build`. Falta **la verificación visual**, que la hace el usuario.

| Commit | Qué |
|---|---|
| `af8ed89` | La tanda 1 de ADR-0003 (lo de Codex, con los acentos ya reparados) + regla 14 del gate |
| `3417a82` | Las observaciones A-1 a A-5 del recorrido + primera pieza del kit + −48 kB de JS |

### Lo que se resolvió

**A-1 a A-5** (`docs/producto/observaciones-del-recorrido.md`, marcadas como resueltas ahí). Dos
decisiones de esas cinco merecen quedar escritas porque son juicios de diseño y no obviedades:

- **A-4 se resolvió con un ancla y no con un diálogo.** La pantalla de gastos se usa en ráfaga —seis,
  ocho gastos seguidos con las facturas al lado— y un modal que hay que abrir ocho veces es peor que
  un formulario que ya está. Lo que faltaba no era esconder el formulario: era **nombrar la acción**.
  Si al usuario no le cierra, el cambio a `Dialog` es chico y el kit ya tiene dónde ponerlo.
- **En A-2, "Continuar liquidación" lleva al resumen y no al paso donde quedó.** Deducir el paso a
  partir de los datos (hay gastos pero no liquidaciones ⇒ revisión) es una regla de negocio, y una
  regla de negocio escrita en un componente es lo que ADR-0002 §5.2 prohíbe y ningún test detecta.

**B-1 y B-1.bis — la máscara de dinero.** `enmascararMontoTipeado` y `normalizarMontoTipeado` en
`@admin-barrios/shared/dinero`, con 12 tests. `CampoMonto` muestra `2.500.000,00` en un input **sin
`name`** y manda `2500000.00` por un `hidden`: la comodidad de la pantalla no le cuesta rigor al
esquema, que **sigue exigiendo dos decimales** porque es lo que garantiza que el dinero llegue exacto
a `numeric(14,2)`. El cursor se recoloca contando dígitos, así que se puede corregir un cero en el
medio de un importe grande — que es justo el error que el campo existe para evitar.

> La regla del punto: con una coma presente, la coma es el decimal. Sin coma, un punto es decimal
> **solo si atrás quedan dos dígitos o menos**. Es lo que distingue `1.23` (un peso veintitrés) de
> `1.234` (mil doscientos treinta y cuatro), y lo que hace que el decimal se pueda escribir con el
> teclado numérico del celular, donde la única tecla de separador es el punto.

**Kit (ADR-0003 §4):** `Boton` (pieza 12) + `BarraDeAcciones`, el estrato de cliente
`@admin-barrios/ui/cliente/boton-de-accion`, iconos de flecha y suma, y el **atajo `Ctrl`/`⌘`+`K`**
del selector (doc 06 §c.6.3). El alto de control dejó de ser un número suelto y es token
(`control.sm`/`control.base` = el objetivo táctil de 44px).

### El hallazgo que no estaba en la lista: −48 kB de JavaScript por pantalla

`index.ts` del kit reexporta `shell.tsx`, que importaba `SelectorDeBarrio`. Resultado: **cualquier**
pantalla que importara aunque sea un botón se llevaba la isla de cliente y su primitiva. La lista de
períodos —lectura pura, cero interacción— tenía **155 kB** de First Load JS; quedó en **106 kB**. La
isla ahora entra como prop desde el layout, que la importa por su subruta `cliente/*`, con lo cual
además **la frontera se lee en el import**, que es lo que ADR-0003 §4 pedía. Cerrojo **UI-8** para que
no vuelva.

### La ronda de revisión, que cambió la máscara de raíz

`code-reviewer` y `tester` (protocolo §3.1) encontraron **cuatro defectos de dinero** que los tests
que yo había escrito no cubrían. El peor lo encontró el tester probando tecleo real:

> **Borrar un dígito dividía el importe por mil.** `2.500.000` menos una tecla daba `2.500,00`. Con
> todo importe de cuatro dígitos o más, con una sola tecla, en el gesto de corrección más frecuente
> que hay. Y lo caro no es el factor mil: es que **el resultado parece un importe normal**.

La causa era la regla que yo había elegido —*"un punto con dos dígitos o menos atrás es decimal"*,
para que el teclado numérico del celular pudiera escribir centavos—. La máscara escribe el punto de
miles y después **no puede distinguirlo del que tipeó la persona**.

**La regla nueva no tiene heurística: el punto es SIEMPRE miles, la coma es SIEMPRE el decimal.** El
punto del teclado numérico se traduce a coma **en el campo** (`onBeforeInput`), que es el único lugar
que sabe qué tecla se apretó; la función pura ve el texto final y ahí los dos puntos son idénticos.
Va en `beforeinput` y no en `keydown` porque los teclados virtuales de Android no reportan la tecla.

Los otros tres, todos arreglados y con test:

- **Pegar `1,234,567.89` guardaba $1,23** en silencio, con un monto válido que ninguna capa de abajo
  podía atrapar. Ahora un punto después de la última coma se interpreta como formato yanqui — acá los
  miles van antes del decimal y nunca después, así que no es ambiguo.
- **Dos comas seguidas** dejaban el campo inválido **y trabado** (dejaba de aceptar teclas).
- **Empezar por la coma multiplicaba por cien**: la coma desaparecía del campo y `,50` entraba como
  cincuenta pesos.

Y una regresión propia que encontré antes de que la reportaran: con el campo **controlado**, el
importe quedaba escrito después de guardar. React resetea solo los formularios **no controlados**, y
un `useState` se le escapa; en una pantalla que se usa en ráfaga, eso es un importe viejo esperando a
que alguien no lo mire.

**Otros hallazgos aplicados:** cambiar de barrio desde un período caía en **404** (arrastraba el id
de período del barrio A a la URL del B — no había fuga, había callejón, y en las cinco pantallas
donde se pasa el mes); "Volver y corregir" se podía apretar con el envío en vuelo y no cancelaba
nada; un `Boton` con `href` y deshabilitado se veía apagado y navegaba igual; el botón "Salir" era el
único control del kit sin foco visible; **seis archivos habían entrado con BOM** justo en el commit
que agrega el gate anti-mojibake, y la regla 14 no lo detectaba — ahora sí (**14b**).

### Lo que quedó pendiente, y por qué

- **La verificación visual de todo esto.** Es lo primero al retomar.
- **El login sobre el kit** (pieza 4 del inventario). Se decidió **no** rehacerlo a ciegas: la
  pantalla funciona, el valor era estético y era lo más riesgoso de la lista sin poder mirarla. Se
  prefirió gastar el turno en B-1, que es un defecto real y se verifica con tests.
- **Geist self-hosted** (pieza 1): necesita bajar los archivos de fuente. Hoy corre con la pila de
  reserva.
- **El sidebar del shell** (pieza 2 / doc 06 §c.2): cambia el layout entero. Es una decisión que
  conviene tomar con el usuario mirando la pantalla.
- ⚠ **El kit no tiene breakpoints y por lo tanto no puede hacer nada responsive.** El `@theme`
  generado apaga los de Tailwind (`--breakpoint-*: initial`) y no define otros: un `sm:` no compila y
  **se pierde en silencio**. Hay que crearlos como token, con la vuelta de que Tailwind los necesita
  como **valor literal** —un `@media` no acepta `var()`—, o sea que van a ser la primera excepción
  legítima al guardián UI-7. Está anotado en el código, en `selector-de-barrio.tsx`.
- Los títulos de los tests de ADR-0003 que Codex había escrito sin tildes quedaron corregidos: era el
  mismo problema del encoding esquivado por el otro lado, y ahora `AGENTS.md` lo dice explícitamente.
- **Quedan medidas hardcodeadas en el kit** que no tienen token todavía: el ancho del contenido
  (`80rem`, que además duplica el de `ui.module.css`), el punto de acento del barrio (`0.7rem`) y el
  ancho del menú del selector (`18rem`). El caso que sí duplicaba un token existente —el alto del
  botón de salir— quedó arreglado. Conviene resolverlas junto con los breakpoints, que es el mismo
  tema: medidas de layout que hoy no son token.
- **El foco al apretar "Volver y corregir"** cae al `<body>`: `volverACorregir` no cambia el
  `resultado`, así que `useFocoEnElPrimerError` no se dispara, y el botón que tenía el foco se
  desmonta. Quien navega con teclado consigue la salida pero aterriza al principio del documento.
  Está identificado y no arreglado: es una pieza de foco que conviene escribir con la pantalla
  delante.

### Verificación de esta tanda

- `pnpm typecheck` · `pnpm test` (**504** unitarios) · `pnpm build` · `pnpm test:db` (**320**)
- **Prueba de humo real contra el servidor de desarrollo**: las 11 rutas del administrador devuelven
  200, y se verificó en el HTML que estén la vuelta a Liquidación, el botón "Nuevo gasto" con su
  ancla, la tarjeta del mes abierto, la columna "Abrir", el campo oculto canónico del monto —y que el
  visible **no** tenga `name`— y los acentos en pantalla.
- Lo que **no** está verificado es cómo se ve. Eso lo hace el usuario.

---

## 2026-08-04 — Los acentos rotos de la tanda 1, y el candado que lo impide

**Estado:** reparado en working tree, sobre lo de la tanda 1 (sigue sin commit).

### Qué pasó

El usuario vio la pantalla de "Mis barrios" con los nombres del elenco partidos —cada letra
acentuada convertida en dos símbolos, y la raya del nombre del estudio en tres— y avisó: *"algo que
Codex siempre hace: rompe todas las palabras con acento/tilde"*. No era la
pantalla: **los archivos estaban doble-codificados en disco** (UTF-8 guardado como cp1252). Tres
archivos, todos reescritos completos en la tanda 1:

| Archivo | Alcance del daño |
|---|---|
| `packages/data/scripts/seed-demo.ts` | **192 secuencias** — nombres del elenco, apellidos del padrón, la razón social del estudio. **Dato que se ve en pantalla.** |
| `apps/web/next.config.mjs` | 21 secuencias, todas en comentarios |
| `apps/web/src/app/globals.css` | 15 secuencias, todas en comentarios |

Dato que confirma la causa: al reparar los dos últimos, el diff contra `HEAD` **se achicó a la línea
que Codex realmente quería cambiar**. O sea, no fue un cambio de contenido: fue el archivo entero
reescrito con el encoding equivocado.

### Qué se hizo

1. **Reparación** carácter por carácter (cp1252 → bytes → UTF-8), solo sobre secuencias que
   round-trippean; el resto quedó intacto. Verificado: cero coincidencias de mojibake en el repo.
2. **`pnpm db:seed`** de nuevo — la base tenía los nombres rotos, no solo el script.
3. **Regla 14 en el gate** (`apps/web/src/arquitectura.test.ts`): ningún archivo de texto del repo
   —`ts/tsx/js/mjs/cjs/css/json/md/sql/yaml`— puede contener las firmas del doble-encodeo. Se probó
   en negativo (se sembró un archivo roto, el test lo nombró) antes de darlo por bueno.
4. **Regla dura 6** en `CLAUDE.md` §1, repetida textual en `AGENTS.md` §1 porque es Codex quien la
   rompe: si la herramienta no garantiza el encoding al reescribir un archivo entero, **se edita el
   fragmento, no el archivo**. Y **no** se esquiva sacando los acentos.

> **Nota sobre lo segundo:** los tests nuevos de ADR-0003 §5 quedaron con títulos sin acento
> (`"la frontera de packages/ui esta gateada"`, `"UI-1 -- ..."`). Es el mismo problema esquivado por
> el otro lado. No se tocó ahora para no ensuciar el diff de la tanda 1; corregirlo es cosmético y
> entra con la tanda 2.

### Verificación corrida

- `pnpm test` — **476** unitarios (475 + la regla 14)
- Prueba en negativo de la regla 14: falla y **nombra el archivo** infractor
- `pnpm db:seed` — el elenco vuelve a decir `Martín Coria`, `Valeria Ríos`

---

## 2026-08-04 — Tanda 1 ADR-0003: setup del kit UI + shell multi-barrio

**Estado:** implementado en working tree, sin commit. Se trabajó con las personas del equipo en secuencia según `AGENTS.md`/`CLAUDE.md` §3.1. La verificación visual queda fuera de Codex por indicación del usuario: **no intentar más pruebas de visualización; las hace él**.

### Qué quedó hecho

- Nuevo paquete `packages/ui` con Tailwind v4 acotado al kit, `@base-ui/react` como primitiva headless, exports explícitos, shell de administración, chips, iconos y `SelectorDeBarrio` como isla cliente.
- `pnpm tokens:css` ahora emite también `packages/ui/src/theme.generated.css`; el theme de Tailwind se genera desde tokens y el gate verifica que no tenga hex/px sueltos.
- `apps/web` importa los estilos del kit, transpila `@admin-barrios/ui` y mantiene `page.tsx`/`layout.tsx` como Server Components. El layout admin usa el shell nuevo y el layout de barrio resuelve `leerBarrio` + `listarBarriosAccesibles` bajo `conSesion` antes de pasar props al selector.
- El seed demo agrega `Barrio Demo Las Cortaderas` como segundo barrio del mismo administrador, sin períodos cargados, con unidades/obligados/coeficientes/tasa de mora/documento base. Sirve para probar selector, aislamiento y estados vacíos sin duplicar la liquidación demo.
- `apps/web/src/arquitectura.test.ts` ganó los cerrojos de ADR-0003 §5 para Base UI, grafo de `packages/ui`, frontera con `packages/documentos`, rutas sin `"use client"`, `.module.css` fuera del kit, prohibiciones de formateo/entorno en UI y guardián de theme generado.
- ADR-0003 y `CLAUDE.md` quedaron alineados al paquete real de Base UI usado por la implementación: `@base-ui/react` / `@base-ui/*`.

### Verificación corrida

- `pnpm tokens:css`
- `pnpm typecheck`
- `pnpm test` — 475 unitarios
- `pnpm build`
- `pnpm db:up`, `pnpm db:reset`, `pnpm db:migrate`, `pnpm db:setup`, `pnpm db:seed`
- `pnpm test:db` — 320 tests contra Postgres

### Notas para retomar

- Hubo un primer `pnpm test:db` con `ECONNREFUSED` porque la base todavía no estaba levantada; después de `db:up` + setup pasó completo.
- El dev server local llegó a responder en `http://localhost:4000`. Next dejó en stderr un aviso no bloqueante al generar rutas estáticas de `/[barrio]/tablero`: `Unexpected end of JSON input`. `pnpm build` igual pasó; si aparece de nuevo al navegar, investigarlo como tarea aparte.
- No continuar con pruebas visuales desde Codex salvo que el usuario lo pida explícitamente.

---
## 2026-08-03 — Cierre de sesión: por dónde se retoma

**Estado del repo:** rama `feat/boleta-de-expensas`, tres commits nuevos, gate en verde
(468 unitarios · 320 contra Postgres · 9 de almacenamiento · build). Sin pushear.

| Commit | Qué |
|---|---|
| `ee004a6` | **La tanda C**: las boletas se generan y se descargan desde la pantalla |
| `d905986` | Las **once observaciones** del recorrido del usuario + la regla de la máscara de dinero |
| `e84f7f6` | **ADR-0003** (sistema de UI) + el candado del prototipo "Consorcia" |

### Lo primero al retomar

`docs/producto/guia-de-prueba.md` sigue siendo el punto de entrada (el usuario prueba el producto, no
lee código). **Cambió el arranque**: para el paso 6 hace falta un comando más, en otra terminal.

```
docker compose up -d                 # base y almacenamiento
docker compose --profile app up -d   # la aplicación web
pnpm db:seed
pnpm worker:dev                      # ← NUEVO, solo para generar/bajar boletas
```

Si el contenedor `app` sale con error, es porque cambiaron dependencias; el comando de rescate está en
la guía y **no toca la base**.

### Por dónde sigue el trabajo

**Tanda 1 de ADR-0003 §7** — setup del sistema de UI + shell. Incluye el **segundo barrio del seed**,
que dejó de ser una tarea de demo: sin él el selector de barrio no es demostrable ni se puede probar
el aislamiento (observación E-1 del usuario).

Después: el spike **login → shell → elegir barrio** (no el dashboard — obligaría a decidir la librería
de gráficos, que está en backlog), y recién el resto del kit con las pantallas re-enmarcadas.

Fuera de esa fila, dos cosas anotadas: **corregir los contrastes propios** (`--border` en 1,23:1 y dos
colores de morosidad apenas debajo de 4,5:1 — los dos viajan al papel, así que se arreglan de una
vez), y el **`CampoDeDinero`**, que entra como pieza 11 del kit v0.

### Lo que NO hay que hacer al retomar

- **No ejecutar `design_handoff_consorcia/PROMPT.md`.** Ver ADR-0003 §9; el aviso está en cinco
  lugares.
- **No revisitar "Verdemar"** dentro de una tarea de implementación: fue ratificada por el usuario y
  tiñe el sistema entero.
- **No rediseñar la navegación por criterio propio**: el modelo está escrito en doc 06 §c.6 y las
  correcciones concretas, en `docs/producto/observaciones-del-recorrido.md`.

### Preguntas abiertas que solo contesta el usuario

Siguen sin respuesta y ordenan decisiones de fondo (detalle en
`docs/producto/analisis-handoff-consorcia.md` §8): si en Las Corzuelas se cobra **por gastos del mes o
por cuota fija** del directorio (el wizard de tres pasos no tiene lugar para el modelo fijo), y si el
**reparto por rubro con excepciones por sector** vuelve al alcance — lo bajó él mismo a caso de borde
el 2026-07-25 y el prototipo lo trae como regla central.

Y las seis de `docs/producto/preguntas-a-la-administracion.md`, que van a **Diego Galizzi**, no al
usuario.

---

## 2026-08-03 — Se decidió el sistema de UI (ADR-0003) y el estatus del prototipo "Consorcia"

**Nada implementado todavía.** Esta entrada registra decisiones tomadas por el usuario, con el
análisis que las respalda. Quien retome, arranca por la **tanda 1** de ADR-0003 §7.

### Lo que se decidió

**ADR-0003 — `docs/arquitectura/03-sistema-de-ui.md`** (aceptado, decisión del usuario). Seis piezas:

1. **Base UI**, no Radix. La propuesta original decía "default razonable: Radix" — correcto al
   escribirse, **invertido por el tiempo**: Base UI estable desde dic 2025, y **default del generador
   shadcn desde jul 2026**. Verificado con fuentes.
2. **Tailwind v4 SOLO dentro de `packages/ui`.** Ni "Tailwind por defecto" (deja las pantallas como
   legado sin fecha) ni CSS Modules para todo (paga 2–3× donde está el cuello de botella). El límite
   **lo hace cumplir el build**: el `@source` acotado hace que una clase de utilidad en `apps/web`
   no compile y se vea rota. Los 18 `.module.css` existentes **se congelan, no se migran**.
3. **Los tokens TS siguen siendo la única fuente.** Se agrega un *sink* (`theme.generated.css`,
   generado, cada valor un `var()` al token existente) y **se apaga la paleta default de Tailwind** —
   sin eso, `bg-red-500` es la segunda fuente de verdad por la puerta de atrás.
4. **Sin react-hook-form.** El puente con `useActionState` sigue artesanal, y adoptarlo obligaría a
   tirar y recomprar el ciclo de confirmación de montos (con su test de tres vueltas). Se extiende
   `useFormulario` con validación en cliente usando **el mismo esquema Zod**.
5. **TanStack Table v8** (v9 está en beta) **solo donde hay ≥2 interacciones reales**. En la demo:
   una sola tabla interactiva, el padrón.
6. **Toast global → backlog.** Las confirmaciones de dinero van pegadas al formulario a propósito.

**Cuatro correcciones a la propuesta** que el ADR escribe como reglas, porque chocaban con lo ya
construido: `Intl.NumberFormat` (prohibido por CI — degrada `es-AR` a `en-US` en silencio), date-fns
como API de formateo, el "wizard" que confundía estados del período con pasos de formulario, y el
toast.

**Nueve cerrojos nuevos del gate** (ADR-0003 §5), a implementar en la tanda 1 **antes** de la segunda
pantalla. El más importante y el más barato: **`packages/documentos` jamás alcanza `packages/ui` ni
`react`** — un componente de pantalla en una plantilla de PDF es un reflow silencioso de un documento
emitido.

**Verdemar (teal) ratificada** por el usuario como dirección visual. No se revisita dentro de una
tarea de implementación.

### El estatus del prototipo, que es lo que el usuario pidió blindar

`design_handoff_consorcia/` es **insumo de producto, no fuente de verdad** (ADR-0003 §9). El pedido
textual fue que quede *"extremadamente documentado al detalle para que si usamos Codex, no cometa ni
un solo error"*. Por eso el candado está en **cinco lugares**, no en uno:

| Dónde | Qué dice |
|---|---|
| `design_handoff_consorcia/PROMPT.md` | Encabezado ⛔ **NO EJECUTAR**, con la tabla de qué gana el repo |
| `design_handoff_consorcia/README.md` | Mismo encabezado, mismo detalle |
| `docs/arquitectura/03-sistema-de-ui.md` §9 | El estatus **vinculante** |
| `CLAUDE.md` §2.1 | Las 13 reglas duras de UI + el estatus |
| `AGENTS.md` §2.1 | Lo mismo para Codex, con las 5 que más se violan por costumbre |

**Lo único adoptado del prototipo: el modelo de navegación** — decisión explícita del usuario
(*"la forma en que resuelve la navegabilidad de pantallas/módulos es acertada y no debemos
descartarlo"*). Escrito en **doc 06 §c.6**: dos alcances con un solo chrome; el selector que se
adapta a 1 / 2–9 / 10+ barrios (con **uno** es un título, no un control); cambiar de barrio conserva
la sección; a un rol no se le muestran acciones que no puede ejecutar; y la entrada a un período es
su resumen.

### Los análisis que respaldan esto

- **`docs/producto/analisis-handoff-consorcia.md`** — panel de cuatro (producto, arquitectura,
  diseño, operatoria de consorcios) sobre el prototipo. Incluye los errores verificados ejecutando:
  `fixtures.ts` hace en coma flotante la multiplicación que su propio `acceptance.md` prohíbe y ya
  está fuera del rango seguro con sus propios números; y sus cuatro divisiones dan exactas, así que
  **no puede probar la regla de redondeo que dice probar**.
- **`_referencias/front/paquete-de-decision-front.md`** — síntesis del panel de front (con
  verificación web de versiones a agosto 2026).
- **`_referencias/front/competencia-consorcioabierto.md`** — análisis competitivo traído por el
  usuario. Lo que más importa: **atacaron la conciliación eliminándola** (circuito cerrado con cuenta
  de pago propia), no automatizándola. Y una lectura estratégica para el front: **una empresa con
  14.000 consorcios no puede rediseñarse**; que un producto de cinco pantallas se vea moderno es lo
  único barato para nosotros y carísimo para ellos.

### Dos cosas que este análisis destapó del propio repo

1. **Fallas de accesibilidad vigentes, nuestras:** `--border` da 1,23:1 (mínimo para un componente de
   interfaz: 3:1), y los colores `morosidad.alDia` (4,49:1) y `morosidad.vencido` (4,46:1) quedan
   apenas por debajo de 4,5:1. **Estos dos viajan al papel** (`boleta.ts`), así que corregirlos
   arregla pantalla y boleta de una vez.
2. **No hay ni una fuente instalada.** Geist está declarada y no existe; todo corre con la pila de
   reserva. Consecuencia: **el reflow por cambio de tipografía que ADR-0001 §6 anticipa todavía no
   ocurrió**, y este es el momento más barato de la vida del proyecto para elegirla — antes de
   embeber la fuente y antes de la primera boleta que reciba un vecino real.

### Por dónde se sigue

**Tanda 1 de ADR-0003 §7**, que incluye el **segundo barrio del seed**: sin él, el selector de barrio
no es demostrable (observación E-1 del recorrido). Después el spike **login → shell → elegir barrio**
—no el dashboard, que obligaría a decidir la librería de gráficos que está en backlog— y recién
entonces el resto del kit.

---

## 2026-08-03 — La tanda C: los documentos se bajan desde la pantalla (Claude Code, panel + `backend-dev`/`frontend-dev`)

Rama `feat/boleta-de-expensas`. **El recorrido completo del ADR-0002 ya no necesita una terminal**: se
genera el período, se emite, se generan los documentos y se descargan. Verificado de punta a punta
contra la base y el almacenamiento reales: **50 boletas en 13,2 s**, 50 objetos en MinIO, 50 filas.

### Cómo se levanta ahora (cambió: hay un comando más, y es opcional)

```
docker compose up -d                 # base y almacenamiento
docker compose --profile app up -d   # la aplicación web
pnpm db:seed
pnpm worker:dev                      # ← NUEVO, en otra terminal, solo para el paso 6
```

El worker corre **en la máquina, no en un contenedor**, y usa el Chrome que ya está instalado. Es una
decisión de recursos, no de comodidad: la imagen con Chromium adentro pesa ~750 MB y su pico de ~650 MB
lo reclama la VM de WSL2 y **no lo devuelve** hasta reiniciar Docker Desktop. Existe igual el servicio
`worker` en `docker-compose.yml`, en un **perfil propio que no se levanta con nada de lo de arriba**,
para cuando haga falta correr contra el mismo Chromium que va a producción.

### Lo que se construyó

| Pieza | Dónde |
|---|---|
| `ObjectStorage` + adapter S3/MinIO | `packages/almacenamiento/` (nuevo) |
| `trabajo`, `documento_emitido`, `descarga_documento` | `0026_documentos_y_cola.sql` + `0027_..._reglas.sql` |
| Encolar / leer estado / registrar / preparar descarga | `packages/data/src/servicios/{trabajos,documentos}.ts` |
| El worker | `apps/worker/` (nuevo) |
| Pantalla, rutas de API y acción | `apps/web/.../[periodo]/documentos/`, `app/api/{trabajos,documentos}/`, `servidor/almacenamiento.ts` |

### El panel de diseño corrió ANTES de escribir una línea, y cambió cosas

`arquitecto-software`, `security-engineer` y `devops`, en paralelo, sobre los ADR y el código. Los tres
informes valieron el rato. Lo que cambiaron:

1. **Los dos ADR se contradicen sobre la forma de la `storage_key`** (ADR-0001 §6 lleva
   `liquidaciones/{id}/`, el `check` de ADR-0002 §6.4 no). Se resolvió con una sola forma:
   `barrios/{barrio}/periodos/{periodo}/{boletas|informes|listados}/{token}.pdf`, con token de 128 bits.
   **Hay que corregir los dos ADR**: quedó pendiente.
2. **`documento_liquidacion` no tenía dónde poner el informe ni el listado** (colgaba de
   `liquidacion_id not null`, y los dos son del período). Se renombró a **`documento_emitido`**, con
   `tipo` y `liquidacion_id` nullable atado por un `check`. Un nombre que miente sobre lo que la tabla
   contiene es una trampa para el próximo.
3. **Contradicción interna del ADR-0002**: §6.2a dice que el rol de request no tiene `update` sobre
   `trabajo`, y §6.4 punto 3 manda avanzar `hechos` adentro del mismo `conUsuario` — que corre como rol
   de request. Ganan las policies: el progreso lo avanza el worker con la conexión de jobs, y
   **`trabajo.hechos` es un indicador de pantalla**, no la verdad. La verdad es `count(documento_emitido)`.
4. **El trigger que deriva el barrio NO es `security definer`.** El precedente del repo
   (`app.resolver_aplicaciones`, dueño `app_job`, ver `0022`) es justo el que no había que copiar: un
   definer que saltea la RLS derivaría el barrio de un período que el solicitante no puede ver, y la
   diferencia de mensajes convertiría el encolado en un **oráculo**. Corriendo como invoker, "no existe"
   y "no es tuyo" son literalmente el mismo caso.
5. **La firma de `ObjectStorage` del ADR-0000 §3.3 no alcanzaba** para lo que el ADR-0002 exige (`put`
   condicional, encabezados en el presign). Se amplió; **hay que versionar la corrección en el ADR-0000**.
6. **`getStream` existe pero todavía no se usa**: es para el día que el listado nominado se sirva por la
   aplicación en vez de con URL firmada, que es lo que recomendó `security-engineer` para ese documento
   —una copia es la deuda con nombre de todo el barrio— y que **no está implementado** porque el listado
   todavía no se emite.

### Los tres controles que sostienen la descarga, con su test

Están en `packages/data/test/documentos-rls.test.ts` (13 tests) y `packages/almacenamiento/test/s3.test.ts`
(7). El razonamiento de fondo, que conviene no perder: **presignar no consulta a nadie** —se calcula
localmente con la credencial, que alcanza al bucket entero—, así que lo único entre "esta boleta" y
"todas las boletas de todos los barrios" es el `select` bajo RLS.

1. **La ruta recibe `documentoId`, jamás una clave.** `prepararDescarga()` lee bajo RLS y **escribe el
   registro de la descarga antes de que la URL exista**: si el registro falla, no hay URL.
2. **`trabajo.barrio_id` es una aserción, nunca un filtro.** El worker no lo pone en ningún `where`: lo
   compara contra lo que devolvió la consulta y **frena** si no coincide. Con un `where`, una fila
   corrupta filtraría distinto y nadie se enteraría.
3. **Gate por tipo en la policy**, más `revoke select (vista)` por columna. El caso que importa es el
   `auditor`: hoy pasaría por `readable_tenant_ids()` sin este gate.

Más: **un `GET` anónimo contra el bucket devuelve 403**, con test. Diez líneas, y es lo único que atrapa
a alguien que corrió `mc anonymous set download` para probar algo.

### Dos cosas que aparecieron trabajando y hay que saber

- **El snapshot de Drizzle estaba desincronizado desde la `0025`** (esa migración se escribió a mano y
  nunca se actualizó el snapshot), así que `drizzle-kit generate` metía tres `ALTER TABLE` ya aplicados
  dentro de la migración nueva. Se sacaron a mano y **el snapshot de la `0026` deja el generador
  sincronizado otra vez**. Si volvés a ver `ALTER TABLE` viejos en una migración generada, es esto.
- **`drizzle-kit` se come la barra invertida de un `\.` en un `check`** escrito en un template de
  TypeScript, porque `\.` es una secuencia de escape inválida y se colapsa a `.` — que en una expresión
  regular acepta cualquier carácter. Hay que escribir `\\.`. Se ve idéntico en el diff.

### Alcance recortado a propósito, y por qué

**La tanda C son las boletas, no los tres documentos.** El informe mensual y el listado de saldos
pendientes tienen plantilla y modelo de vista, pero **no tienen quién arme sus datos desde la base**:
el único armador que existe es `vista-boleta.ts`. Son dos servicios de lectura nuevos y no triviales
(el listado tiene agregados por antigüedad y k-anonimato). El `tipo` y su gate de rol ya están en el
esquema, así que el día que se emitan, el control ya está puesto.

### Verificación

`pnpm typecheck` · `pnpm test` (**468**) · `pnpm test:db` (**320**) · `pnpm test:storage` (**9**, nuevo,
contra MinIO real) · `pnpm build`. Y la cadena entera de migraciones aplicada **desde cero** en una base
limpia, para verificar que `0026`/`0027` no dependen del estado de la base de desarrollo.

Además, contra la aplicación corriendo, después de las correcciones:

- **50 boletas generadas y descargadas desde el contenedor**: `302` → `localhost:9000` → `200`,
  140 KB, `%PDF-1.7`. Es el camino de la guía de prueba, no el de desarrollo.
- **El barrido recuperó un trabajo huérfano de verdad.** No fue un escenario armado: durante las
  pruebas quedó un trabajo real en `corriendo` con su worker muerto, se lo envejeció para no esperar
  diez minutos, y el barrido lo pasó a `fallado` con el mensaje que la pantalla sabe usar. Antes de la
  corrección, ese período quedaba intocable para siempre.
- **Regenerar sobre un período completo: 0 documentos, cero filas nuevas.**

Un meta-test del repo atrapó un error propio en el camino: la policy de `select` de `descarga_documento`
tenía el gate de rol pero no `readable_tenant_ids()`. Corregido antes de cerrar.

### Lo que salió de la revisión, y por qué vale leerlo

`code-reviewer` devolvió **cuatro bloqueantes** y `tester` —que ejercitó la tanda contra la aplicación
real, no leyendo código— devolvió **cuatro más del borde**. Los ocho corregidos. Seis no se hubieran
visto mirando la pantalla.

1. **Un trabajo que moría en `corriendo` dejaba el período bloqueado para siempre.** `caducarRezagados`
   barría `encolado` y nada más; el índice único sigue contando `corriendo` como pendiente, y el rol de
   request no puede tocar `trabajo` — o sea que no había salida desde la aplicación. Se llegaba con un
   reinicio del proceso durante los 13 segundos del lote. Ahora son **dos redes**: el apagado espera al
   lote en vuelo (30 s de techo) y el barrido cierra lo que quedó colgado (ventana de 10 minutos).
   Verificado por `tester` envejeciendo `iniciado_at`.
2. **Una promesa sin `catch` terminaba el proceso.** El `try/catch` envolvía al handler pero no a
   `tomarTrabajo` ni al barrido; un parpadeo de la base ahí era una promesa rechazada sin capturar, y
   el servicio arranca con `restart: "no"`. Ahora hay `catch` en los dos disparadores y un
   `unhandledRejection` como última red.
3. **Fuga de conexión en el `LISTEN`.** Si `connect()` resolvía y el `listen` fallaba, el cliente
   quedaba tomado; con el pool en 2 y sin `connectionTimeoutMillis`, dos vueltas de reintento dejaban
   al worker **colgado pidiendo trabajo, sin error y sin log**. Se corrigió el `release`, el
   `release(e)` del handler de error, el tamaño del pool (3) y el timeout — que ahora tiene
   `crearPoolJob` por defecto, igual que `crearPoolRequest`.
4. **"Generar los que falten" regeneraba todo.** No había filtro por lo ya emitido: tras una falla
   parcial quedaban **dos boletas por unidad**, distinguibles solo por la hora. Ahora está
   `liquidacionesConBoleta()` y el guard de early-exit del ADR-0001 §5 punto 6. Verificado en vivo:
   segunda corrida sobre un período completo = **0 documentos, 185 ms, cero filas nuevas**.
5. **La regla del "período emitido" vivía solo en TypeScript.** `insert into trabajo (tipo,
   referencia_id)` sobre un **borrador** era aceptado por la base: el servicio lo comprobaba, pero el
   servicio no es el control. Un borrador con liquidaciones se hubiera renderizado y registrado como
   emitido, sobre cifras que todavía se editan — justo lo que la pantalla promete que no puede pasar.
   Ahora lo verifica `app.trabajo_antes_insert()`, con test (C2).
6. **La regla 11 del gate tenía un agujero.** Miraba el identificador `DbJob`, y
   `crearDbJob(crearPoolJob({url}))` no lo menciona: la inferencia se lo pone. Pasaba en verde
   mientras el aislamiento se evaporaba. Ahora mira también las dos fábricas.
7. **Un uuid mal escrito en la URL devolvía 500 con código de soporte.** Un enlace roto no es una
   caída. Se traduce al **mismo** rechazo que un uuid válido inexistente, a propósito: un código
   distinto para "mal formado" es un oráculo.
8. **La contadora veía el botón de generar y lo podía apretar**, para recibir un cartel rojo con
   código de incidente. La base lo rechazaba (o sea: no era un agujero), pero ofrecerle una acción de
   escritura a un rol de solo lectura y después retarlo es tratar como incidente algo que el sistema
   ya sabía.

Y dos textos que dejaron de ser ciertos **por culpa del arreglo 4**, corregidos: la nota de éxito
decía *"se generaron 50 documentos"* cuando no se había generado ninguno, y la ayuda del botón prometía
documentos nuevos "con su propia fecha".

**Y la novena, que es la que más dolía y apareció en la segunda pasada de `tester`: con la web en un
contenedor, el enlace de descarga apuntaba a un host que el navegador no puede resolver.** El
contenedor alcanza el almacenamiento como `http://minio:9000` —un nombre que solo existe adentro de la
red de contenedores— y esa era la dirección que se firmaba y se devolvía **al navegador del host**. El
botón de descargar no llegaba a ningún lado, y solo en el camino documentado: con la web corriendo en
la máquina, la misma línea de código andaba.

Lo que hace que este no se arregle "reescribiendo el host": **la firma incluye el encabezado `host`**,
así que cambiar `minio:9000` por `localhost:9000` después de firmar invalida la URL. Hay que firmar
desde el principio con el host que va a usar el navegador. El adapter tiene ahora **dos clientes**: el
que habla de verdad con el almacenamiento y el que **solo firma**, que puede apuntar a una dirección
que este proceso ni siquiera alcanza (presignar es cálculo local, no abre conexión). Se configura con
`S3_ENDPOINT_PUBLICO`, que en un entorno real no se declara porque las dos direcciones coinciden.
Con dos tests: uno verifica que la URL lleva la dirección pública, y el otro **la usa contra el
almacenamiento real** — porque que la cadena se vea bien no prueba nada si la firma se calculó con el
otro host.

**Y una décima, encontrada al cerrar y que no reportó nadie:** `pnpm db:seed` **no limpiaba las tres
tablas nuevas**. Su limpieza corre con `session_replication_role = replica`, que apaga también las
claves foráneas, así que el barrio se borraba igual y quedaban documentos y trabajos **apuntando a un
barrio que ya no existe** — en silencio, acumulándose en cada sembrado. Corregido y verificado.

**Además, algo que rompía tu flujo y no tenía que ver con la tanda:** `docker compose --profile app
up -d` **dejó de levantar** en cuanto la web ganó una dependencia. pnpm quiere purgar los
`node_modules` del volumen anónimo, pide confirmación, no hay TTY y aborta — con un error que no
menciona dependencias por ningún lado. Arreglado en los dos `Dockerfile.dev`
(`npm_config_confirm_modules_purge=false`) y documentado en la guía el comando de rescate, que **no
toca la base**.

### Pendientes de esta tanda, anotados

- **Corregir ADR-0000 §3.3** (la firma de `ObjectStorage`) y **ADR-0001 §6 / ADR-0002 §6.4** (la forma
  de la clave y el nombre de la tabla). Los tres quedaron desactualizados por decisiones de hoy.
- **`plantilla_hash` es el hash del CSS que emitió la plantilla**, no del módulo entero: un cambio en el
  armado del markup que no toque una regla de estilo **no lo mueve**. La columna promete más de lo que
  cumple; está dicho en el código, no disimulado.
- **Un intento y nada más** (ADR-0002 §12). Reintentar = encolar un trabajo nuevo, que es seguro: el
  `put` condicional y `storage_key unique` hacen que no se pise nada.
- **Versionado / object-lock del bucket**: el `put` condicional es un flag del cliente, así que quien
  tenga la credencial del worker puede sobreescribir un objeto. El control real es del lado del bucket
  y hoy no está.
- **`retencion_meses` se cita en doc 07 §G.2 y ADR-0001 §6 y no existe en el esquema**, y ni la web ni
  el worker tienen permiso de borrado — o sea que no hay quién purgue. Hay que dejar de escribirlo como
  si estuviera resuelto.
- **La imagen del worker no fija la versión de Chromium** (instala la que traiga el snapshot de Debian).
  Para producción hay que fijarla con `@puppeteer/browsers`. Está anotado en el propio Dockerfile.
- **Objetos huérfanos en el almacenamiento, y un camino que nadie ejercita.** `tester` terminó con 252
  objetos contra 100 filas. Es el trade-off documentado (objeto primero, fila después), pero con
  `APP_WORKER_CHUNK=50` y 50 unidades **el período entero es un solo chunk**: un corte entre los 50
  `put` y la transacción deja hasta 50 objetos (~6,8 MB) huérfanos por intento. Y como el chunk cubre
  todo el padrón de la demo, **el camino de "completar lo que falta" parcialmente no lo prueba nadie**
  con estos datos: o entran las 50 filas o ninguna. Vale sembrar un barrio con más unidades que el
  chunk, o bajar el chunk en desarrollo, para que ese camino se ejercite.
- **Una fila registrada por error en `documento_emitido` es permanente.** Para borrarla hay que
  deshabilitar dos triggers `append-only` (el suyo y el de `descarga_documento`, que la referencia).
  Es el diseño funcionando, pero conviene que esté escrito: **no hay forma soportada de retractar un
  documento registrado por error**, ni siendo dueño del esquema.
- **`HEAD /api/documentos/{id}` acuña una URL y deja fila de auditoría.** Next deriva `HEAD` de `GET`.
  Inofensivo, pero el registro cuenta como pedido de descarga algo que fue un `HEAD`.
- **`node --watch` no reinicia el worker después de un crash** (solo ante cambios de archivo), y el
  servicio de compose tiene `restart: "no"`. En desarrollo hay que volver a levantarlo a mano; en
  producción lo resuelve el orquestador. Está anotado porque el síntoma —"la pantalla dice generando y
  no avanza"— no apunta a esto.

### Y lo que ordena lo que sigue: la lista del recorrido del usuario

Está en **`docs/producto/observaciones-del-recorrido.md`** (nueva). Es la lista que el HANDOFF anterior
pedía y que estaba bloqueando el rediseño de la navegación: **11 observaciones**, casi todas de
navegación, más una regla de base nueva (máscara de miles y decimales en todo campo de dinero) y el
hallazgo de que **el paso 8 de la guía no se puede probar** — hay un solo barrio y lo ven los tres
usuarios, así que cambiar de usuario no demuestra el aislamiento. El seed necesita un segundo barrio
con elenco distinto.

---

## 2026-07-28 — Cierre de sesión: por dónde se retoma (Claude Code)

**Lo primero al retomar: `docs/producto/guia-de-prueba.md`.** Es el paso a paso de la aplicación
escrito mirando la pantalla, no el código, y verificado contra el seed. El usuario pidió
explícitamente partir de ahí. Si algo no coincide con lo que se ve, **la guía está vieja y hay que
corregirla**, no ignorarla.

### Cómo se levanta todo

```
docker compose up -d                 # base y almacenamiento
docker compose --profile app up -d   # la aplicación web
pnpm db:seed                          # deja el barrio demo en su estado conocido
```
La aplicación queda en `http://localhost:4000`. Para los PDF hace falta
`CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe"`.

### Estado del seed (verificado)

Un barrio, *Barrio Demo Los Aromos*, 50 unidades. **06/2026 emitida** (5 gastos por $9.875.500,
50 liquidaciones, cargos y bonificaciones). **07/2026 en borrador** (3 gastos por $6.520.250, uno
extraordinario sin acta, 2 cargos aplicados, 0 liquidaciones — "generar el borrador" tiene algo que
hacer). Tres usuarios de demostración: `admin@estudio.test` (Valeria Ríos, admin del estudio),
`operador@estudio.test` (Martín Coria) y `contador@estudio.test` (Silvia Aguirre, solo lectura).

### Lo que quedó andando

El recorrido completo desde el navegador: crear el período, cargar gastos, aplicar cargos y
descuentos, generar el borrador, revisarlo y emitir. Gate en verde: **467 unitarios · 306 contra
Postgres · 40 de PDF**.

### La devolución del usuario, que es la que ordena lo que sigue

Textual: *"no está siendo muy intuitivo el UI como se va construyendo"*. El diagnóstico que le di y
que conviene sostener: **la interfaz se construyó de adentro hacia afuera** —primero el motor, después
las pantallas para operarlo— así que refleja cómo funciona el sistema y no cómo trabaja una persona.
Un administrador no piensa "voy a la solapa Liquidación, elijo el período, paso 1": piensa "tengo que
cerrar julio".

**Quedó pedido que él recorra la guía y anote dónde se traba.** Esa lista es el insumo para rehacer
la navegación con fundamento en vez de con criterio propio. **No rediseñar la interfaz antes de tener
esa lista.**

### Lo que falta para cerrar el bloque de pantallas

La **tanda C**: bajar los documentos desde la pantalla. Hoy las boletas se generan por comando
(`pnpm demo:boleta` → `tmp/boletas`). Necesita las tres piezas de infraestructura prometidas en los
ADR y todavía inexistentes: `ObjectStorage`, el encolador de trabajos y `apps/worker`.

### Pendientes anotados, chicos y visibles

- Cuando la base rechaza por una regla sin traducción propia, el mensaje es genérico: cargar 120
  jornadas de quincho con tope 100 dice "alguno de los datos no cumple una regla del sistema", sin
  decir cuál es el límite.
- Los importes que interpola la base salen sin formato (`$ 3420000.00` al lado de `$ 38.000,00`).
- Un barrio nuevo necesita que se le cargue `monto_max_cargo_operador` o sus operadores no pueden
  aplicar cargos (falla cerrado, a propósito). Falta la pantalla de configuración del barrio.
- La lista de riesgos menores de la revisión de `code-reviewer` sobre las pantallas: el motivo de una
  anulación que se pierde al reintentar, el `<form>` pelado sin `noValidate`, `cantidad` marcado como
  requerido sin validador que lo exija, el acuse de emisión que se desmonta al revalidar, y el
  `.trim()` de `opcionalDeFormulario`.
- La portada visual del informe mensual (doc 10 §I), postergada a propósito hasta que el producto
  tenga pantallas.

---

## 2026-07-28 — Las pantallas de carga y emisión: el recorrido entero anda (Claude Code, `frontend-dev`)

Rama `feat/boleta-de-expensas`. Cierra el primer recorrido del ADR-0002: **crear un período → cargar
los gastos del mes → aplicar un cargo o un descuento a una unidad → generar el borrador → revisarlo →
emitir**, sin abrir una terminal. Recorrido completo verificado en el navegador, incluidos los caminos
que fallan; capturas en `tmp/capturas/20-*` a `51-*`.

### Las pantallas

| Ruta | Qué hace |
|---|---|
| `/[barrio]/liquidacion/nuevo` | Alta del período. Ruta propia y no modal: el formulario tiene errores por campo y una salida por código, y adentro de un `<details>` el error vive en un bloque que se puede cerrar. |
| `…/[periodo]/gastos` | Cargar y quitar gastos, con el total recalculado y las extraordinarias sin acta marcadas. |
| `…/[periodo]/cargos` | Aplicar un concepto a una unidad, anular con motivo, y el catálogo del barrio con su valor vigente. |
| `…/[periodo]/revision` | Generar el borrador, la grilla por unidad, y emitir. |

Más `PasosDelPeriodo` (el recorrido dibujado, en las cuatro pantallas del período) y el botón
**Nuevo período** en el listado.

### Lo que hay que saber para tocarlo

- **Las Server Actions viven en `apps/web/src/acciones/liquidacion.ts`**, las siete. Los pasos 2 y 3 de
  la regla del ADR-0002 §4.2 (`conSesion` + una llamada al servicio) están una sola vez, en
  `ejecutar.ts`; el `parse` y el `revalidatePath` quedan a la vista en cada acción a propósito.
- **`revalidatePath` va con el patrón de ruta**, no con la URL concreta: armar la URL exigiría un
  `barrioId` en el request, que es justo el dato del que el aislamiento no depende (§3.4).
- **El kit de formularios es `componentes/formulario.tsx`, y es el único módulo de cliente nuevo.**
  Las pantallas de lectura siguen costando cero JavaScript. Hace cumplir por construcción: error en el
  campo con `aria-invalid`+`aria-describedby`, foco al primer error, identificador de correlación
  seleccionable de un click, y la confirmación dibujada distinto de un error.

### La confirmación del cargo inusual, conectada

Contra el `cargo_requiere_confirmacion` de la entrada de abajo. La tabla está en
`apps/web/src/acciones/confirmacion.ts` y es **explícita**: un código es confirmable porque alguien lo
escribió ahí, nunca por heurística sobre el texto. `tope_operador`, `concepto_requiere_admin` y
`sin_limite_de_aplicacion` **no** están, y hay un test que lo fija: significan "esto lo tiene que hacer
otra persona", y ofrecerle una casilla a quien no tiene derecho a marcarla es peor que el error.

El reintento necesita **tres** condiciones (`conConfirmacion`): la casilla marcada, el código que se
está confirmando, y que ese código esté en la tabla. Falta una y los valores salen intactos, el
servicio vuelve a rechazar y la pantalla vuelve a preguntar. `confirmacion.test.ts` prueba las tres por
separado. **No es un control de seguridad** —quien arme el POST a mano manda lo que quiera, y el
candado real está en `app.cbu_antes()`—: lo que garantiza es que la **UI no confirme sola**.

### Lo que salió de la revisión de código, y por qué vale leerlo

`code-reviewer` devolvió **seis bloqueantes** y `security-engineer` uno con dientes. Los siete
corregidos; cinco no los hubiera encontrado mirando la pantalla, y dos son trampas puestas para el
próximo que toque el archivo.

1. **La confirmación se quedaba pegada.** La acción devolvía al navegador los valores **ya mergeados**
   con `confirmarMontoInusual`, y el pedido de confirmación los reemitía como campos ocultos: desde el
   segundo pedido el campo viajaba solo y la casilla pasaba a ser decorativa. La base registraba
   "alguien revisó y confirmó" sobre un envío en el que nadie marcó nada — el dato que después
   contesta un reclamo. Ahora `ejecutar` recibe los **crudos**, el merge alimenta solo al `parse`, y
   `CAMPOS_DE_CONFIRMACION` filtra los campos de toda confirmación registrada como cinturón. Con test
   del **ciclo de tres vueltas**: el de antes probaba `conConfirmacion` aislada, y el agujero estaba
   un renglón más afuera.
2. **El `catch` estaba adentro de la transacción.** `conUsuario` corre sobre `db.transaction`: un
   retorno normal es un `COMMIT`. Un error lanzado desde TypeScript **después** de escribir —un
   `rechazar()` de dominio tras un `insert`— quedaba **confirmado** mientras la pantalla decía que
   falló. Hoy no era alcanzable (los `rechazar()` posteriores a una escritura son todos de "cero filas
   afectadas") pero es el módulo por el que pasan las siete escrituras de dinero.
3. **`CampoSeleccion` perdía el valor en todo reintento.** React 19 hace `form.reset()` al terminar la
   acción, y aplica el `defaultValue` de un `<select>` **solo al montar**: un default nuevo no llega al
   DOM. Los `<input>` volvían con lo tipeado y los desplegables al placeholder. Se arregla **adentro
   del componente** —escucha el `reset` de su propio `<form>` y se remonta— y no con un `key` en cada
   llamador, porque los cuatro llamadores ya se lo habían olvidado.
4. **Un rechazo confirmable sin entrada en la tabla no mostraba nada.** El cliente volvía a consultar
   la tabla por su cuenta; con un despliegue nuevo y una pestaña vieja las dos copias difieren, caía a
   la rama normal —donde el aviso solo mira `falla`— y quedaba **sin escritura, sin cartel y con el
   botón rehabilitado**. Ahora la `Confirmacion` la resuelve `ejecutar` y **viaja adentro del
   resultado**: se decide una vez, del lado que decide.
5. **"Total a cobrar" era el total de las primeras 500.** Justo arriba del botón irreversible, al lado
   de "Boletas que quedan emitidas" que **sí** es el conteo completo: dos hechos distintos presentados
   como uno. Ahora va `null` cuando la grilla no cubre el período, y el formulario dice por qué.
6. **`visiblesDe` trataba `null` como cero.** Con todas las unidades sin tasa de mora —el caso que la
   propia pantalla anuncia— el pie afirmaba *"todas las liquidaciones las tienen en cero: interés por
   mora"*. Ahora "en cero" y "sin definir" son dos listas distintas y se declaran por separado. Con
   test (`grilla.test.ts`), porque los datos del seed no lo ejercitan: la mora sale `0.00`, no `null`.
7. **`barrioId` duplicado** en el alta durante el estado `confirmar` — ganaba el del intento anterior
   en vez del que renderizó el servidor.

Y uno más, encontrado al volver a mirar la pantalla con la base resembrada: **el encuadre de la
confirmación contradecía al mensaje del servidor.** El texto fijo decía "el sistema comparó contra lo
que esa unidad paga por mes" y arriba, en la misma tarjeta, el servidor decía "esa unidad todavía no
tiene ninguna boleta para comparar" — es el tercer caso de `0025`, el de la unidad sin historia.
Ahora ese renglón **no dice nada sobre por qué saltó la alarma**: habla solo de qué significa
confirmar. El porqué lo sabe el servidor y nadie más, y ya viene escrito con su cifra.

Y **`useFormulario(accion)`**, que es la corrección estructural que hace que esto no vuelva. Las tres
líneas de estrechamiento (`campos`, `previos`, `confirmacion`) estaban copiadas en seis formularios y
**tres ya se habían olvidado de algún estado**; el foco era otra llamada que había que acordarse de
agregar y los tres formularios chicos no la tenían. Ahora es un `switch` exhaustivo en un solo lugar:
una variante nueva no compila hasta que alguien decida qué le corresponde.

### Dos bugs encontrados mirando la pantalla, no leyendo el código

1. **Un campo opcional era imposible de dejar vacío.** El navegador manda `""` para un `<input>`
   vacío, `null` no existe en un `FormData`, y `.nullable()` solo acepta `null`: dejar en blanco un
   vencimiento devolvía *"fecha inválida (esperado YYYY-MM-DD)"* sobre un campo rotulado "opcional".
   Arreglado con `opcionalDeFormulario()` en `packages/shared/src/escrituras.ts`, aplicado a los ocho
   campos opcionales que vienen de un formulario. **Es el único archivo fuera de `apps/web` que toqué.**
2. **La grilla de revisión mostraba una fila de ceros con un total de $9.562,10.** Había arrancado con
   una versión "simplificada" de siete columnas, y la plata estaba en dos de las tres que el recorte
   dejó afuera. La lección no es que faltaban columnas: es que dos definiciones de las mismas columnas
   divergen siempre. Ahora hay una sola, en `[periodo]/grilla.tsx`, y la usan el resumen y la revisión.

### Pendientes anotados, no disimulados

- **El mensaje de `cbu_cantidad_chk` es genérico.** Cargar 120 jornadas de quincho (el tope es 100)
  devuelve *"Alguno de los datos no cumple una regla del sistema y no se guardó"*, que no dice cuál es
  el límite. Es del catálogo de `packages/data/src/errores.ts`, no de la pantalla.
- **Los importes que interpola la base no vienen formateados**: el mensaje del cargo inusual dice
  `$ 4560000.00` al lado de un `$ 38.000,00` nuestro. El contrato pide mostrar `mensaje` tal cual, así
  que la pantalla no lo puede arreglar sin romperlo.
- **El desplegable de unidades trae el padrón entero** (techo 500). El día que un barrio no entre, el
  control correcto es una búsqueda, no un `<select>`.
- **La grilla empuja el botón de emitir muy abajo** con 50 unidades (~5.500 px). Es deliberado —que se
  vea antes de apretar— pero con 200 unidades hay que revisarlo.
- **Objetivos táctiles de la barra superior por debajo de 44 px** (`Salir` 36, `Mis barrios` 22,
  `admin-barrios` 28): son de `(admin)/admin.module.css`, anteriores a esta tanda. Medido con
  `tmp/accesibilidad-escritura.mjs`.
- No se construyó el alta del catálogo de conceptos (`crearConceptoBoleta`, `registrarValorConcepto`):
  el ADR-0002 §8 la deja fuera del incremento. Las pantallas lo dicen donde corresponde.

### Verificación

Gate: `pnpm typecheck` (6/6), `pnpm test` (**467**), `pnpm test:db` (**306**), `pnpm build` — todo en
verde, sobre base reseteada y resembrada.

Y tres herramientas en `tmp/`, que no son código de producto pero son las que encontraron casi todo:

| Script | Qué verifica |
|---|---|
| `capturas-escritura.mjs` | El recorrido entero en el navegador **incluidos los caminos que fallan**, con dos sondas de regresión: que la confirmación no quede pegada como campo oculto y que un rechazo no vacíe los desplegables. |
| `accesibilidad-escritura.mjs` | Etiquetas asociadas, `aria-describedby` en los inválidos, objetivos táctiles, regiones vivas, foco **tabulando de verdad** y desborde horizontal. Sin hallazgos en las cuatro pantallas. |
| `crop2.mjs` | Recorta una región de una captura para poder mirarla de cerca. |

---

## 2026-07-28 — Tope de los cargos de boleta (Claude Code, `backend-dev`)

Decisión de producto del usuario, sobre el hallazgo de `tester` en `ataques-escritura` §8: el tope del
barrio **solo miraba descuentos**, y por el camino legítimo se emitió una boleta de **$3.100.000 sobre
una expensa de $100.000** (veinte cargos de $150.000 a la misma unidad, todos válidos de a uno).

Decisión textual del usuario: *"Un operador tiene tope por unidad y período, igual que con los
descuentos. Un administrador no tiene tope, pero el sistema le pide confirmar cuando el cargo supera
varias veces la expensa de esa unidad. Frena el error de tipeo sin trabar la operatoria."*

Diseño completo en `docs/diseno/08-criterios-de-reparto.md` **§AD**. Lo esencial:

| | Tope del operador | Confirmación por monto inusual |
|---|---|---|
| Qué es | autorización ("no podés") | freno al tipeo ("¿seguro?") |
| A quién | a quien no es admin del barrio | a **todos los roles** |
| Se levanta | no: lo aplica un administrador | confirmando explícitamente |
| Dónde | `limite_aplicacion_barrio.monto_max_cargo_operador` (nulo = falla cerrado) | `multiplo_confirmacion_cargo`, **default 3** |

Los dos son **acumulados por unidad y período**: partir el cargo en varios chicos es exactamente cómo
se llegó a los $3.100.000.

### Para quien construya la pantalla

- **Código de error nuevo: `cargo_requiere_confirmacion`.** Es el único que significa "esto no está
  mal, necesita que confirmes". El mensaje trae la cifra concreta (*"este cargo es 31 veces la expensa
  de esta unidad"*) y `datos` trae `multiplo` / `importe` / `expensa` (o `acumulado` / `referencia`).
  Se reintenta con `confirmarMontoInusual: true` en los parámetros.
- `tope_operador` y `sin_limite_de_aplicacion` **no** se reintentan: los aplica un administrador.
- **La pantalla no puede mandar la confirmación de arranque.** El campo es opcional en el tipo a
  propósito, y el candado vive en `app.cbu_antes()`: mandarla siempre la convierte en un cartel.

### Archivos

| Qué | Dónde |
|---|---|
| Migración (columnas, `app.cbu_expensa_de_referencia`, `app.cbu_antes` v5) | `packages/data/migrations/0025_tope_de_cargos.sql` |
| Esquema Drizzle | `packages/data/src/schema/cargos.ts` |
| Código de error y parámetro Zod | `packages/shared/src/errores.ts`, `packages/shared/src/escrituras.ts` |
| Traducción de los seis mensajes nuevos | `packages/data/src/errores.ts` |
| Servicio | `packages/data/src/servicios/cargos.ts` |
| Tests de los cuatro caminos | `packages/data/test/ataques-escritura.test.ts` §8 |

### Cambios de comportamiento que hay que saber

1. **Un `operador` ya no aplica cargos si el barrio no cargó `monto_max_cargo_operador`.** Antes sí
   (los cargos eran el único camino sin techo). El seed y las tres suites de test ya cargan la
   columna; **un barrio existente en producción necesita cargarla o sus operadores quedan sin aplicar
   cargos** — es el fallo cerrado pedido, no un olvido.
2. **Una unidad sin ninguna boleta previa pide confirmación** si el barrio tampoco declaró tope de
   cargos. No hay con qué comparar y no se asume que es normal (§AD, punto 4 de la cadena).

Gate: `typecheck` y `test:db` (306) en verde, seed corriendo. **Los 2 unitarios rojos y el error de
`apps/web/src/acciones/resultado.ts` son de la rama de pantallas que se está construyendo en paralelo,
no de esta tanda** (falta `revision.module.css`).

---

## 2026-07-27 — Informe mensual y listado de saldos pendientes, construidos (Claude Code, `frontend-dev`)

Implementa el doc 10 y cierra los defectos de §B.1. Rama `feat/boleta-de-expensas`. **Salen los tres
PDF de la familia** (boleta + informe + listado) con el mismo motor, los mismos tokens y la misma
marca de dos niveles. Gate: **261 unitarios + 34 del proyecto `pdf`**, `typecheck` y `build` en verde.

### Lo construido

| Pieza | Dónde |
|---|---|
| `DatoFaltante` — el hueco como valor de primera clase, con motivo y responsable | `packages/shared/src/documentos/faltantes.ts` |
| `VistaInformeMensual` + Zod | `packages/shared/src/documentos/vista-informe-mensual.ts` |
| `VistaListadoMora` + Zod | `packages/shared/src/documentos/vista-listado-mora.ts` |
| Sustrato común de las tres plantillas (escapado, fuentes, hoja con corridos, celdas) | `packages/documentos/src/plantillas/comun.ts` |
| Plantillas `informe-mensual.ts` y `listado-mora.ts` | `packages/documentos/src/plantillas/` |
| `solicitudDeInformeMensual` / `solicitudDeListadoMora` | `packages/documentos/src/emision-informes.ts` |

### Cinco defectos que ahora son imposibles de cometer, no cosas para acordarse

1. **El resultado del período** es campo obligatorio y el invariante lo ata a `ingresos − egresos`.
2. **Devengado y percibido** son secciones separadas por tipo, con un **puente explícito** entre las
   dos y su diferencia sin explicar declarada. Un renglón faltante **no se trata como cero**: el
   puente no puede declararse cerrado con un hueco adentro.
3. **Un solo cuadro de fondos.** El tipo no admite el segundo.
4. **Piso de desagregación del 5 %** y **honorarios de administración con renglón propio siempre**,
   los dos verificados en el `superRefine`.
5. **Nombres de personas:** `ProveedorImpreso` es una unión discriminada y la variante
   `persona_humana` **no tiene campo de nombre** — lleva una cantidad ("3 personas"). La razón social
   de una empresa sí se publica.

### El listado: la decisión del cliente, hecha configuración

Nominado en el piloto (decisión del usuario, doc 10 §E.1), **configurable** vía `PoliticaListado`
(`modo`, `destinatarios`, `pisoImporte`, `excluirPlanAlDia`), congelada con el documento. Lo que hace
que la versión agregada sea segura y no una promesa: **`detalle` es una unión discriminada y la rama
`agregado` no tiene `filas`** — ni titular, ni manzana/lote, ni uuid, ni hash. Todo el schema es
`.strict()`, porque la vista se congela en `jsonb` y un schema permisivo persiste lo que la plantilla
no imprime. Más: **k-anonimato con piso duro 5** sobre tramos, instancias y concentración; importes
agregados redondeados al mil **incluida la evolución** (con la variación exacta, el total anterior
sale por diferencia); marca `USO INTERNO — CONTIENE DATOS PERSONALES` e identificador de copia
derivados del modo, sin parámetro que los apague.

**Del panel de `security-engineer`, aplicado:** grupo `exposicion` nuevo en el lenguaje prohibido
(*listado de morosos, escrache, publicación en cartelera, se publicará el nombre…*), que **bloquea la
emisión**; el título impreso es la constante `TITULO_LISTADO_MORA = "Estado de saldos pendientes"` y
no se configura; el nombre del titular **no pasa** por el filtro (un apellido prohibido bloquearía
todo el listado y dejaría el apellido en el log); `destinatarios ≠ directorio` **se rechaza en
runtime** hasta que exista el vínculo usuario → unidad funcional (doc 07 §F, ADR-0001 §13).

**Del panel de `administrador-consorcios`:** los tramos de antigüedad se cuentan en **períodos, no en
días**; el catálogo de instancias es cerrado; la etapa que operativamente se llama "intimación
fehaciente" se imprime `aviso_formal` porque las dos palabras están en la lista prohibida; y el orden
del listado es **de trabajo** —las instancias recuperables primero, las terminales al final— con el
invariante verificándolo, no una convención.

### Cambios de contrato del motor (los revisa `arquitecto-software`)

1. **`paginasEsperadas: number | "variable"`.** Un listado tiene tantas páginas como unidades tenga
   el barrio: exigirle un número sería inventarlo. **Renuncia al lote** y el adapter lo hace cumplir.
2. **`selloPorPagina`** — folio y marca de agua estampados con `pdf-lib` **después** de partir. Hacía
   falta por dos motivos del mismo origen: Chromium no implementa las cajas de margen de `@page` (no
   hay `counter(page)`) y `footerTemplate` es por pasada, no por documento; y la capa DOM de marca de
   agua es **una por `<article>`**, así que en un documento de seis páginas aparecía una sola vez, en
   el medio de la tercera, y las otras cinco se imprimían sin marca.

### Correcciones a doc 09 §E que este documento obligó (de `ux-designer`)

- **Ancho útil 178 mm y margen izquierdo de 18** para los multipágina que se archivan (la boleta se
  queda en 182 y 14/14: no se archiva y su código de barras necesita el ancho entero).
- **`printMinLegibleZona1` → `printMinLegibleTitular`**: el piso de 14 pt está atado al **rol**, no a
  la zona 1 de la boleta.
- **`fontSizePrint["3xl"] = 24` deja de estar reservado**: es "la cifra que titula un documento que
  nadie paga". `4xl` queda exclusivo del TOTAL A PAGAR.
- Franja de acento **sólo en la primera página**; las 2..n se identifican por el encabezado corrido.

### Trampas verificadas en este entorno (para que nadie las vuelva a descubrir)

- **`table-layout:fixed` es obligatorio en la hoja.** Con layout automático, la celda que contiene el
  documento **se ensancha para acomodar su contenido** (un `flex` con doce cajas de 40 mm de mínimo
  pide 480 mm) y el documento entero se sale del papel. Lo atrapó la guarda de desbordes del
  renderizador antes de que saliera un PDF.
- **Un contenedor `flex` sólo se parte entre líneas**, y Chromium empuja el resto entero a la página
  siguiente: las cajas de denominadores dejaban seis centímetros de hueco en el medio del informe.
  Con `inline-block` el corte lo decide el flujo normal.
- **La trama a 45° para "dato pendiente" no sobrevive al rasterizador.** Se resolvía como gris sólido
  en unas celdas y desaparecía en otras **en la misma hoja**, con cualquier paso probado. Se cambió
  por fondo `slate.100` + subrayado punteado, que es reproducible.
- **El `thead`/`tfoot` repetido no puede llevar `position`, `overflow` ni `transform`**: Chromium
  deja de repetirlo. Y los márgenes laterales los tiene que poner el `padding` del documento, porque
  el padding **vertical** de una caja partida sólo aparece en la primera y en la última página.

### Lo que el material real no tiene, y cómo quedó marcado

Todo lo que falta viaja como `DatoFaltante` **con su motivo y quién lo carga**, y se imprime con el
patrón de celda pendiente + recuento al pie de la sección. En el informe: **fondo de reserva** (no
aparece en ninguno de los cuatro meses) y saldos pendientes al corte. En el listado: **composición
del saldo, antigüedad, gestiones y fecha de derivación** — el sistema de origen no los guarda.

Y tres cosas que el informe real publica y **no se pudieron verificar**, ahora señaladas en el propio
documento (`Observacion`): el bloque financiero de 05/2026 **repite las cinco cifras de 04/2026** sin
una diferencia; la deuda con proveedores **abre distinta de como cerró el mes anterior** en los
cuatro meses; y el bloque de caja de 05/2026 **daría un saldo negativo**. El invariante exige la
observación: si la deuda abre distinta y no hay marcador, **no se emite**.

### Lo que encontró la revisión, y que ya está corregido

`code-reviewer` verificó cada hallazgo ejecutando código contra los modelos reales. Los cinco
bloqueantes eran reales y **todos están corregidos, con un test que los cubre**. Cuatro de los cinco
estaban en los invariantes **alrededor** de la estructura, no en la estructura: la unión discriminada
y el `ProveedorImpreso` hacían lo que prometían.

1. **El agregado publicaba por debajo de k por la puerta de al lado.** El piso cubría tramos,
   instancias y concentración, pero **no `resumen.unidades`** — que es lo que se imprime más grande en
   la página 1. Un agregado con las dos listas de celdas vacías publicaba "$ 100.000,00 — 3 unidades
   con saldo al corte". Ahora el conteo del documento y el del corte anterior están sujetos a k.
2. **La supresión de celdas, que el docstring prohíbe, pasaba validación.** El control de que los
   tramos suman el total estaba condicionado a `modo === "nominado"`, o sea **apagado justo donde
   importa**, y no existía el de unidades. Suprimir una celda chica y publicar el resto la dejaba
   calculable por resta. Ahora corre en los dos modos, con tolerancia de redondeo en agregado.
3. **`concentracion` escapaba a todo control**: ni redondeo (siendo el bloque de mayor saldo, o sea
   la huella más cruzable) ni verificación de su porcentaje contra su propio numerador y denominador.
4. **El filtro de lenguaje prohibido no veía los `motivo` de los huecos**, que se imprimen enteros al
   pie. Una fila con `faltante("no se registró desde cuándo el moroso dejó de pagar; se iniciarán
   acciones legales")` **se emitía**. `motivosFaltantes()` entra ahora a las dos funciones de textos
   impresos.
5. **El informe perdía el pie legal del emisor** cuando `leyendas` estaba vacío: la guarda miraba
   `leyendas` y el bloque imprimía `leyendas + marca.pie`. Las dos copias del mismo bloque habían
   divergido; ahora es `cierreDelDocumento()` en `comun.ts`.

De los riesgos, corregidos también: el **presupuesto de anchos del listado sumaba 208 mm sobre 178**
—con todas las columnas presentes el titular quedaba en 9 mm y los nombres se aplastaban, y la guarda
de desbordes no lo ve porque un nombre que envuelve no desborda—, así que **multas y cargos comparten
columna** (se desagregan en la segunda línea) y `anchos()` **falla** si el presupuesto no cierra; una
celda de columna accesoria que faltaba salía **en blanco** en vez de marcada; una **antigüedad
desconocida se ordenaba como la más fresca** (empataba con `un_periodo`); `sellar()` era **fail-open**
ante un desajuste de índice; el **folio caía a 6 mm del borde**, dentro de la zona no imprimible de
una impresora hogareña, y ahora sale de `doc.margenesMm`; el piso del 5 % **no cubría grupos
negativos** (peso negativo nunca supera el piso) y ahora se mide en valor absoluto; y un
`diferenciaSinExplicar: 0,00` **esquivaba** el "un hueco no es un cero". Además, con un hueco en el
cuadro de fondos el puente quedaba sin verificar y sin decirlo: ahora exige observación, igual que la
rueda de proveedores.

**Y los tests que no probaban nada**, corregidos: el de redondeo rompía dos campos y afirmaba un solo
regex (ahora es uno por campo, y cubre `concentracion` y `tramos`) · `URL_EXTERNA` **nunca se
ejercitaba**, porque los fixtures no tienen logo y la plantilla jamás emitía un `<img src>` (ahora hay
fixture con logo `data:` y un auto-test del detector) · faltaban los bordes del piso del 5 % (exacto,
apenas por debajo, y grupo negativo) y el caso `leyendas: []`.

### Pendiente, anotado y no corregido

- **Retención propia del listado nominado.** `security-engineer` recomienda default de purga (12
  meses o cierre de ejercicio), contra el "no purgar nunca" del ADR-0001 §6, y evaluar **no persistir
  la vista nominada completa** en `jsonb`. Es decisión de `arquitecto-software` + `dba-data`.
- **Gate de rol en la base**: nominado sólo `admin_plataforma`/`admin_barrio`; agregado suma
  `operador` y `contador`. Hoy no está implementado — la emisión no lo verifica.
- **El agregado tiene que salir de su propia query**, no de proyectar el nominado en memoria: si el
  objeto nominado existe en el camino, termina en un log o en un cache.
- El **pie corrido flota a media página en la última hoja** (comportamiento de `tfoot` de Chromium
  cuando el contenido termina antes); el folio, que lo estampa `pdf-lib`, sí queda al pie.
- La derivación de **510 unidades** del piloto sale de dividir las cuotas ordinarias por la cuota de
  la boleta de 04/2026 —da entera en los cuatro meses— y viaja publicada como derivación, con su
  observación. **Falta confirmarla contra el padrón.**
- Preguntas abiertas para la administración (tasa del recargo, importe unitario de la bonificación,
  concepto de ~8 renglones que hoy son sólo razón social, correlato de egreso de los amenities): ver
  `docs/producto/preguntas-a-la-administracion.md`.

---

## 2026-07-27 — El informe mensual real del piloto y la política de mora (Claude Code, `documentador`)

Análisis del **segundo documento** del material real del barrio piloto (Las Corzuelas, S.A.): el
"Estado de cuentas" mensual que viaja junto a la boleta ya analizada en el doc 09, más el listado de
mora del mismo envío. Rama `feat/boleta-de-expensas`. **Solo documentación: no se tocó código.**

**Dónde quedó:** [`docs/diseno/10-informe-mensual-y-mora.md`](docs/diseno/10-informe-mensual-y-mora.md)
(nuevo), índice `docs/diseno/README.md` y `CHANGELOG.md`.

### Regla de privacidad aplicada (importante para quien siga)

El material fuente tiene **~100 propietarios morosos con nombre, manzana/lote e importe**, y renglones
de gasto donde el proveedor es un **empleado nombrado**. Vive en `_referencias/`, que está en
`.gitignore`. **No entró al repo ni un nombre, ni un lote individual, ni un importe de una unidad.**

Decisión que conviene conocer: **tampoco se transcribieron los importes agregados del barrio.** Están
permitidos (son de gestión, no personales), pero los hallazgos del doc 10 son **estructurales** —qué
cuadro falta, qué no cierra contra qué— y se sostienen sin las magnitudes. Las magnitudes viven en
`_referencias/` y quien las necesite las mira ahí. Está dicho explícitamente en el §A del doc 10 para
que no se lea como un olvido. **Si alguien agrega cifras después, la regla del §A dice cómo.**

### Lo que quedó escrito

| § del doc 10 | Qué |
|---|---|
| **§A** | La regla de privacidad del documento — qué nunca puede entrar y qué sí, y cómo se cita |
| **§B** | Qué es el informe hoy (híbrido: devengado + deuda a proveedores + caja + banco) y **los 9 hallazgos verificados** |
| **§C** | El desfasaje de dos meses: de dónde sale, hasta dónde se acorta, y **informe cerrado vs. tablero vivo** |
| **§D** | Qué se publica del gasto y qué no: regla de corte, dos niveles, dos reglas duras, el caso mixto |
| **§E** | La política de publicación de la mora, configurable |
| **§F** | Los 5 huecos del modelo de datos, con tabla y columna |
| **§G/§H** | 8 preguntas para la administración + derivaciones a `legal-ph` y `contador` |

### Las cuatro cosas que hay que retener

1. **La meta del informe es un mes, no tiempo real.** Los dos meses de hoy son tres esperas
   encadenadas (extracto bancario → imputación manual de cientos de acreditaciones → comprobantes de
   proveedores) más un criterio de completitud que la administración **no quiere** aflojar y que es
   defendible. Lo que baja a un mes: conciliación automática de ingresos (ataca la espera grande),
   devengar **por orden de pago** en vez de por factura recibida, cierre con checklist bloqueante y
   stock de mora calculado.
2. **Informe cerrado y tablero vivo son artefactos distintos, y hay que construir los dos.** El
   informe es una rendición: se emite, se distribuye y no se edita. El tablero es gestión: siempre
   disponible, cifras rotuladas provisorias, sin exigencia de completitud. **Confundirlos es la causa
   de que hoy el informe llegue tarde y el tablero no exista** — cuando el único artefacto es el
   informe, se presiona para que salga antes, contra el criterio que impide que salga antes.
3. **La mora nominada es decisión del usuario y se respeta; el software la vuelve configurable.** En
   su barrio va con nombre y manzana/lote, por resolución del órgano competente, para incentivar el
   pago. El producto se vende a barrios con la política opuesta → modo `nominado`/`agregado`,
   destinatarios, piso de importe, exclusión de quien tiene plan al día, y registro de quién publicó
   qué con qué fecha de corte. **Documento y distribución siempre separados de la boleta**, porque la
   boleta la recibe el inquilino, que paga las ordinarias y no es el deudor.
4. **Nadie del equipo puede dictaminar sobre la legalidad de publicar el listado nominado.** La
   normativa de protección de datos personales **no está cargada** en `knowledge/` (hay CCyC/PH, 19550,
   IGJ/IPJ, expensas, asambleas, IIBB y jurisprudencia de ejecutividad — nada de datos personales).
   `legal-ph` va a responder "no tengo esa fuente cargada" y **eso es correcto**. Lo que respalda la
   práctica es una resolución del órgano del barrio: un hecho verificable, **no un dictamen**.

### Pendientes que este material dejó abiertos

**Huecos del modelo de datos** (doc 10 §F) — anotados, **ninguno implementado**:

| # | Hueco | Dónde |
|---|---|---|
| F-1 | Falta subtipo del ingreso ajeno (el enum es plano) → el desglose que el doc 04 §B.2 **ya exige** no se puede emitir | `app.clasificacion_fiscal` (`0004`) |
| F-2 | Falta el **CUIT del proveedor** en el gasto (hoy solo `proveedor_nombre` texto libre) — y es el dato que decide si el nombre se publica (§D.4) | `gasto_periodo` (`0004`) |
| F-3 | **El más caro.** La clasificación fiscal se escribe solo si hay `gasto_id` → **toda línea de cargo queda sin clasificar**, y el cargo por alquiler de amenity es justo el ingreso que podría cambiar el encuadre fiscal del barrio | `item_liquidacion.clasificacion_fiscal` (`0008`) |
| F-4 | El catálogo de conceptos tiene `activo` pero no vigencia → **un cero se lee igual si el concepto no tuvo movimiento que si dejó de existir** | `concepto` (`0004`) |
| F-5 | Falta el renglón **partida presupuestada / otorgado / excedente** de las bonificaciones (doc 08 §N.bis lo decidió y lo dejó sin lugar donde vivir) | no existe |

> F-1, F-3 y F-5 **ya los había detectado el doc 08** desde el lado de la emisión. Aparecer dos veces
> por caminos independientes los saca de "pendiente" y los pone en "requisito".

**Para preguntarle a la administración** (doc 10 §G, 8 preguntas). Las tres que más definen diseño:
qué compone la **brecha entre débitos bancarios y pagos a proveedores** (define el modelo de egresos);
si el barrio **recauda fondo de reserva** (hoy no aparece en el informe y la ausencia admite dos
lecturas opuestas); y **cuánto de los dos meses es esperar el extracto y cuánto imputar los pagos**
(confirma o corrige el supuesto de que la conciliación automática es lo que destraba el mes).

**Derivaciones abiertas:** a `legal-ph` — publicación de mora (**bloqueada hasta cargar la fuente**),
contenido mínimo de la rendición **por figura jurídica** (el piloto es S.A., rinde ante directorio y
asamblea de accionistas, no ante asamblea de PH), y si el detalle individual de gastos es exigible o
es cortesía. A `contador` — el puente devengado↔percibido, si **devengar por orden de pago** es
defendible como cambio de criterio, previsión por incobrabilidad, y el subtipo de ingreso ajeno (ya
derivado en doc 08 §Z, **sigue abierto**).

### Qué NO se tocó

`packages/`, `docs/diseno/09-boleta-de-expensas.md` y `docs/arquitectura/01-generacion-de-documentos.md`
— hay trabajo en paralelo sobre esos archivos. En `docs/diseno/README.md` se agregó **solo** la fila
del doc 10, por el mismo motivo.

---

## 2026-07-26 — Generación de documentos, fase 1: sale un PDF de verdad (Claude Code, `backend-dev`)

Primera implementación de **ADR-0001**. Rama `feat/boleta-de-expensas`. **Sale un PDF real, de punta a
punta, desde la base**: `pnpm demo:boleta` emite las 50 boletas del período del seed en **8 s en una
sola pasada** (161 ms por boleta con el navegador frío incluido), ~120 KB cada una.

### Lo construido

| Pieza | Dónde |
|---|---|
| `VistaBoleta` + `BloquePago` — modelo de vista puro, Zod | `packages/shared/src/documentos/` |
| Formato de dinero y fecha **sin `Intl`** (`formatearMonto`, `formatearDecimal`, `formatearFecha`) | `packages/shared/src/{dinero,fechas}.ts` |
| Plantilla `VistaBoleta → HTML`, símbolos, lenguaje prohibido, `MedioCobranza` + `generico-demo`, `GeneradorDocumento` | `packages/documentos/` |
| Adapter Chromium (un pase por lote + split con `pdf-lib`) | `packages/documentos/src/adapters/chromium.ts` |
| Armador desde la base bajo RLS, sin N+1 (4 consultas para N boletas) | `packages/data/src/servicios/vista-boleta.ts` |
| `pnpm demo:boleta` | `packages/data/scripts/demo-boleta.ts` |

**Gate:** 138 tests unitarios + 97 contra Postgres + 18 del proyecto nuevo `pdf`. `pnpm test` no paga
Chromium; el paso de CI nuevo va después de "Tests puros".

### Decisiones que el ADR no cerraba (y por qué)

1. **`packages/cobranza` se pliega dentro de `packages/documentos`** (`src/cobranza/`). El ADR §11 lo
   preveía como paquete propio; con un solo adapter, un paquete más era configuración sin beneficio.
   El **modelo de vista sí quedó en `shared`**, como manda el ADR §3: es lo que permite que `data` lo
   arme sin depender de `documentos`.
2. **`DocumentoSolicitado` lleva `estilos` + `cuerpo`, no un `html` único** (§4.2 lo ilustraba como
   una cadena). Es lo que permite emitir el CSS y las fuentes **una vez por lote**, que es de dónde
   sale la diferencia de 6×. Para el email y la vista web está `htmlCompleto()`.
3. **La geometría de los símbolos no viaja en `InstrumentoPago`** (§4.4 la ilustraba con
   `anchoModuloMm` y `zonaMudaModulos` por instrumento). La impone `simbolos.ts`, así todo adapter
   futuro hereda las guardas gratis en vez de tener que copiarlas.
4. **`MarcaDocumento` es de dos niveles** (barrio + emisor), siguiendo doc 09 §E.9.0, que corrigió el
   modelo de un solo nivel de ADR §4.3 el mismo día.
5. **`leible` puede ser `null`** (el payload de un QR no se imprime) y, cuando no lo es, tiene que ser
   idéntico a `carga` **salvo los espacios de agrupación**: `"0000 0000 0174"` es legítimo,
   `"0000 0000 0175"` no.
6. **El código de pago electrónico (LINK/PMC) es un instrumento de TEXTO, no un código de barras.**
   Es como está en la boleta real (doc 09 §A) y en el wireframe de §E.2.3: se tipea, no se escanea.
   Un símbolo de más al pie le comía 25 mm a la zona del detalle sin darle nada a nadie.
7. **Guarda de desborde en el renderizador** (no estaba en el ADR y hizo falta en el primer PDF real):
   si una zona de alto acotado no entra, la emisión **falla** con el nombre de la zona. Sin esto, el
   primer PDF contra datos reales perdió en silencio un concepto del detalle mientras el total de la
   zona 2 lo seguía incluyendo — una cifra sin la línea que la explica.
8. **Conflicto de documentos, resuelto a favor del ADR:** §10 del ADR manda marca de agua obligatoria
   cuando el medio es `generico-demo`; doc 09 §E.15.4 pide **no** poner marca de agua diagonal porque
   "mata el efecto comercial". Se implementó la del ADR (diagonal, al 16 % de opacidad, estampada por
   el renderizador). **Si para la reunión de venta se prefiere el criterio de §E.15.4, es una decisión
   de `product-owner` + `security-engineer`, no de implementación** — y hay que escribirla en el ADR.

### Lo que falta para que la boleta se vea como manda doc 09 §E

Ordenado por lo que más cambia la hoja:

1. **El dorso (página 2).** Es lo primero. Hoy la boleta es **una sola página** y el detalle entra
   raspando con los 5 conceptos del seed. Sin dorso no hay: por qué cambió contra el mes anterior,
   la explicación de la bonificación, el desglose del saldo anterior, ni el desborde del detalle con
   `(1) sigue al dorso`. El contrato ya lo contempla (`detalle.continuaAlDorso`,
   `DocumentoSolicitado.paginasEsperadas`), así que es plantilla, no rediseño.
2. **La zona 5 mide ~60 mm y el presupuesto de §E.2.2 reservaba 44** (era el de P1, un solo cupón).
   P-DEMO son tres instrumentos (§E.10.1 le da 73 mm). La diferencia sale de la zona 3, exactamente
   como manda §E.10.2. La zona 2 pasó a tomar el alto que necesita; **el troquel sigue anclado al
   borde inferior** porque el bloque de pago cierra la columna flex.
3. **Marca del barrio y del emisor (§E.9).** No hay columnas: hoy sale el nombre de `tenant_node`, sin
   logo, con acento **gris neutro** (`acentoImpreso(null)`) y sin CUIT ni domicilio del emisor. La
   caja de logo, el logotipo tipográfico y la degradación de contraste ya están implementados y
   testeados: falta el dato y `ObjectStorage` para resolverlo a `data:`.
4. **Fuentes propias embebidas.** Hoy se usa la pila local (`Liberation`/`DejaVu`/Arial), que no sale a
   la red pero **no es Geist**. El mecanismo está (`estilosBoleta(fuentes)` con `@font-face` en
   `data:` y rechazo de cualquier URL); faltan los archivos vendorizados.
5. **Tokens de impresión.** §E.5.2 pide `fontSizePrint`, `printFitWidthFactor`,
   `printMinLegibleZona1` y `print.instrumentoInk` en `packages/design-tokens`. La plantilla usa hoy
   los valores en pt a mano. Primero el token, después el uso (doc 06 §g.2).
6. **Fecha tope de la red** (§E.11 ítem 1): sin campo propio, sale `null` y la zona 1 dice "Sin fecha
   tope informada". **No se usa el segundo vencimiento**, que significa otra cosa (§B.6).
7. **Renglón de bonificación NO aplicada** (§E.11 ítem 5): el contrato lo contempla
   (`RenglonComposicion.informativo`), pero **no tiene dónde guardarse**. Es el Caso B entero.
8. **Rol del destinatario** (§E.11 ítem 9): `unidad.rolDestinatario` es opcional y hoy **no se
   imprime**, porque sería una suposición.
9. **Numeración de comprobante con serie y correlativo** (§E.11 ítem 4) y el **snapshot de la marca
   del administrador con mandato vigente** (§E.14 punto 8): hoy se lee el mandato vigente, así que una
   boleta vieja mostraría la administración de hoy.

Todos estos huecos viajan **enumerados dentro de la propia vista**, en `VistaBoleta.faltantes`
(`FALTANTES_CONOCIDOS` en `packages/data/src/servicios/vista-boleta.ts`): el día que el dato exista se
sabe exactamente qué boletas se emitieron sin él.

### Trampas verificadas en este entorno (para que nadie las vuelva a descubrir)

- **`bwip-js` antepone un `0` en silencio** con cantidad impar de dígitos en Interleaved 2 of 5: el
  símbolo de `"1234567"` es **byte a byte idéntico** al de `"01234567"` y el lector devuelve el
  segundo. Guarda en `revisarCargaSimbolo()`, con round-trip real (`zxing-wasm`) que lo demuestra.
- **`bwip-js` deforma el QR si se le pasa `height`**: devuelve una matriz de 58 × 71 módulos para un
  símbolo cuadrado. Escalarla a un cuadrado lo vuelve ilegible. Al QR no se le pasa `height`.
- El **fondo transparente** es el default de `bwip-js`. El renderizador fuerza `#FFFFFF` opaco sobre
  toda la caja, zona muda incluida, y no hay parámetro para cambiarlo.
- Un **código de 58 dígitos ocupa los 182 mm útiles enteros** con X-dimension 0,323 mm (el
  renderizador la achica sola hasta el piso de 0,25 mm y falla si no entra). No hay columna lateral
  posible al costado del código: su zona muda es parte de su propio SVG.

### Lo que encontró la revisión, y que ya está corregido

`code-reviewer` y `security-engineer` revisaron el diff. Los tres bloqueantes eran reales y estaban
verificados con evidencia, no inferidos. **Todos corregidos, con un test que los cubre.**

1. **El código de barras salía ILEGIBLE.** El SVG mide los 182 mm útiles enteros y compartía fila
   flex con el QR: se derramaba fuera de su contenedor (688 px de contenido en 511 px de caja) y el
   QR —posterior en el DOM— **se imprimía encima del último 24 % del símbolo**, zona muda incluida.
   ZXing no leía nada. La hoja se veía impecable.
   - **Arreglo:** los símbolos lineales van en un renglón propio a ancho completo. La regla de doc 09
     §E.6 ("nada se pone al costado del código") ahora la hace cumplir el CSS, no un comentario.
   - **Dos guardas nuevas, las dos verificadas reintroduciendo el bug a propósito:**
     `buscarDesbordes` mira **ancho** además de alto y corta la emisión con el número exacto
     (688 vs 511 px), y `test/canario-cupon.test.ts` renderiza la boleta, **recorta la zona del cupón
     de la página** y se la pasa a un lector de verdad. `codigo-de-barras.test.ts` no podía atraparlo:
     verifica la **carga** regenerando el símbolo aparte, y la falla estaba en la **geometría**.
2. **La participación impresa usaba otro denominador que el que cobró.** `leerSumaCoeficientes`
   sumaba `coeficiente` entero; el prorrateo suma solo las unidades con `baja_at is null`. Con una
   unidad dada de baja después de cerrar la versión, el porcentaje impreso quedaba **por debajo** del
   real y la cuenta dejaba de rehacerse con calculadora, por mucho más que el "$ 0,01" que promete la
   leyenda fija. Ahora es exactamente la misma consulta, con test contra Postgres.
3. **El interés se explicaba con datos inventados.** `tasaImpresa(… ?? "0")`, `dias ?? 0` y
   `fecha_corte_mora ?? fecha_emision` fabricaban el respaldo de una cifra de dinero — y el camino
   **cotidiano** (unidad al día, con tasa cargada) llegaba sin fecha de corte, así que la hoja
   imprimía `current_date` del servidor como si fuera un hecho. Los tres campos son ahora nullables y
   la hoja imprime solo lo que existe. Ídem `emision.fecha`: un período en borrador **no tiene** fecha
   de emisión y ya no se rellena con la de hoy.

**Además, de la misma revisión:** gate de rol para emitir (`admin_plataforma`/`admin_barrio`/
`operador` vía `app.has_role_on` en la misma consulta, sin round-trip: `app.accessible_tenant_ids()`
mira que haya membresía, **no el rol**, así que un `propietario` pasaba las policies) · la banda de
"vista previa" ya no se cae por un `slice(0,3)` silencioso · sin `numero_comprobante` el adapter **no
arma el instrumento** (con `null` todas las boletas del período recibían el mismo código, byte a
byte) · un importe negativo ya no se codifica como una deuda del mismo monto · `permitida()` filtra
por **mediatype** (un `data:text/html` es un documento nuevo) · JavaScript apagado en el contenido
(`setJavaScriptEnabled(false)` **antes** de `setContent`, que es una navegación — verificado con un
script que intenta borrar el documento) · el filtro de lenguaje prohibido corre **al emitir** y no en
`parsearVistaBoleta`, porque ahí el día que crezca la lista dejaría de poder abrirse toda boleta vieja
que la contenga (ADR-0001 §6) · la vista previa de una boleta ya no lee el período entero.

**Y los tests que no probaban nada**, corregidos: el de "no depende de `Intl`" (setear `LANG` no
cambia nada: ahora se verifica sobre la implementación) · el del prorrateo (usaba una regex sobre el
string del coeficiente que solo funcionaba con parte entera cero: usa `coeficienteAEntero`) · varios
`.toThrow()` pelados sin matcher. **Y el hueco más grande: `vista-boleta.ts` no tenía ni un test** —
ahora tiene `packages/data/test/vista-boleta.test.ts`, contra Postgres real, cubriendo los tres
bloqueantes y el gate de rol.

**Estado del gate:** 146 unitarios + 105 contra Postgres + 26 del proyecto `pdf`, todos en verde;
`pnpm build` limpio; 50 boletas reales emitidas en 5 s.

### Pendiente, anotado y no corregido

- **`app.resolver_aplicaciones` es `security definer` con dueño `app_job` (BYPASSRLS) y está
  granteada a `app_request`** (`0017`, ya en `main`). Es el único lugar donde el aislamiento no lo
  garantiza la policy sino el cuerpo de la función. No lo toca esta rama; merece una auditoría propia
  de `dba-data` + `security-engineer`.
- Alinear las **policies** con el gate de rol es tarea de `dba-data`, y **no es copiar el patrón de
  `0016`**: el portal del residente va a querer que un propietario lea *su propia* liquidación, o sea
  "solo su unidad", no "nada".
- `partir()` compara el total de páginas del lote, no documento por documento. Hoy cierra porque
  `paginasEsperadas` vale siempre 1; **el día que el dorso lo haga valer 2**, un documento que rinde 1
  y otro que rinde 3 pasarían el chequeo. Hay que marcar cada artículo con su índice antes de eso.
- Casos borde que hacen fallar el `superRefine` con un mensaje de Zod en vez de uno de negocio:
  liquidación sin ítems, y `coeficienteImpreso` sin piso (una participación de 0,0000 % mientras se
  cobra) ni tope (un `version_id` equivocado imprimiría más de 100 %).

---

## 2026-07-25 — Cargos y descuentos de boleta: implementación + inversión del modelo de confianza (Claude Code)

Implementa §AB del doc 08 y **cambia una decisión de diseño** a partir de la auditoría.

**Lo construido** (`0015`, `0016`, `0017`):

- Tres tablas: `concepto_boleta` (catálogo del barrio), `concepto_boleta_valor` (valores con
  vigencia) y `concepto_boleta_unidad` (la aplicación a una unidad en un período), más
  `concepto_boleta_unidad_evento` (append-only) y `limite_aplicacion_barrio`.
- `clase_item` en `item_liquidacion` (`prorrateo` / `cuota_fija` / `cargo` / `descuento`): **el
  invariante del cuadre pasa a ser una sub-suma** — lo repartido sigue siendo exactamente el gasto,
  y cargos y descuentos van por afuera, con biyección 1 a 1 contra sus aplicaciones y subtotales
  verificados **por unidad** (un cargo en la boleta equivocada no mueve el total del período).
- FK de tres columnas `(liquidacion_id, periodo_id, unidad_funcional_id)`: una línea no puede caer en
  la boleta de otro vecino.
- La aplicación **no cuelga de `liquidacion`**: regenerar el borrador no evapora lo cargado a mano.

**El cambio de diseño (importante para quien retome):** la primera versión dejaba que el request
escribiera el snapshot del catálogo y el importe. Era explotable en un renglón de SQL. Ahora:

| Lo manda el request | Lo escribe la base |
|---|---|
| concepto, unidad, período, `fecha_hecho`, `cantidad`, `detalle`, `origen_evaluacion` | todo el snapshot (`clase`, `metodo`, nombre, parámetros, `tope`, `financiamiento`), la firma, la base de cálculo y el importe |

`app_request` **no tiene UPDATE** sobre `concepto_boleta_unidad` salvo las tres columnas de la
anulación. El importe lo resuelve `app.resolver_aplicaciones(periodo)` (definer, propiedad de
`app_job`), en **una sola pasada para todo el período**. La aritmética del dinero vive en **una sola
definición**, `app.cbu_importe_bruto()`, usada por el cálculo y por el CHECK.

**Trampa de infraestructura que hay que recordar:** una función `security definer` cuyo dueño no sea
superusuario **queda sujeta a `force row level security`**. En dev no se nota (el dueño es
superusuario); en un Postgres administrado rompe. Por eso las definer de este módulo son propiedad de
`app_job`, que tiene BYPASSRLS. Hay un test con rol `operador` que lo detectaría.

**Decisiones de dominio que quedaron escritas:** la base del descuento es *cuota fija + ordinarias*,
nunca el fondo de reserva ni la extraordinaria; el descuento al cumplidor se presupuesta (el barrio
arma el presupuesto sobre la expensa **con** el descuento, así que no lo absorbe); `cuenta_corriente`
como origen de la evaluación está **inhabilitado** hasta que exista el módulo de cobros, porque el
sistema todavía no puede afirmar que verificó nada.

**Estado:** 97 tests contra Postgres real + 43 unitarios, todos en verde; seed emitiendo con cargo y
descuento reales.

**Pendiente conocido (no bloqueante, anotado por la auditoría):** `limite_aplicacion_barrio` no
registra quién subió el techo ni cuándo (un administrador se lo puede subir sin rastro); los **cargos**
no tienen tope de ninguna clase; `financiamiento = 'fondo_reserva'` debería pasar por `legal-ph` y
`contador` antes de quedar como opción; `orden_impresion` no se congela en la aplicación.

**Próximo:** la UI de carga (§AB), la regla guardada con simulador comparativo, y el comprobante
separado de la extraordinaria con su propio vencimiento e imputación (atado al módulo de cobros).

---

## 2026-07-25 — Cierre de los tres agujeros de seguridad + encuadre fiscal explícito (Claude Code)

Primera tanda de implementación salida del panel (`docs/diseno/08-criterios-de-reparto.md` §T y §S-6).

- **`0012_sin_clasificar.sql`**: valor nuevo del enum, **solo en su archivo**.
- **`0013_seguridad_periodo.sql`**: `periodo_editable` falla cerrado (con excepción explícita para el
  borrado en cascada); un período **nace en borrador** y no puede insertarse ya emitido; la firma de
  quién emitió sale de `app.current_user_id()` y no del request.
- **`0014_sin_default_fiscal.sql`**: se elimina el default `no_alcanzado` de `concepto`. Dar de alta un
  concepto ahora **exige declarar el encuadre**.
- `emitirPeriodo()` **ya no recibe el usuario**: hay que llamarla dentro de `conUsuario()`. El seed se
  adaptó (emite con identidad).

**Aprendizaje operativo que corrige al panel:** `drizzle-kit migrate` envuelve **todas las migraciones
pendientes en UNA transacción**, así que separar el `ALTER TYPE ... ADD VALUE` en su propio archivo
**no alcanza** — el valor nuevo tampoco se puede usar en un archivo posterior de la misma corrida. Por
eso el default se **elimina** en vez de cambiarse, que además es más estricto.

**Estado:** 74 tests contra Postgres real (6 nuevos) + 43 unitarios, todos en verde; seed funcionando.

**Próximo:** la estructura de cargos y descuentos (§AB del doc 08): tres tablas, `clase_item` por
columna generada, FK compuesta de tres columnas contra el cruce de unidades, y `validar_emision` v3.

---

## 2026-07-25 — Correcciones del usuario sobre el reparto (Claude Code)

**El usuario administra barrios reales; donde su operatoria contradice a un agente, manda la suya.**
Quedaron asentadas en `docs/diseno/08-criterios-de-reparto.md` §A.0.

1. **Los gastos comunes son comunes a todos**: no se reparten por concepto. Lo que varía es **cómo se
   cobra la expensa** (a nivel barrio), y la suma total cubre todos los gastos. → El criterio por
   concepto **baja a caso de borde futuro** (contradice al `administrador-consorcios`, que lo había
   puesto como modo normal).
2. **Extraordinaria como ítem de la boleta = parte de la expensa común del mes**, sin vencimiento, mora
   ni deuda diferenciados. → Confirma el comportamiento actual: no hay nada que construir.
3. **Extraordinaria con boleta propia = TODO diferenciado** (vencimiento, intereses, imputación y
   seguimiento). Caso real: la obra de gas de Las Corzuelas (Guazú Pytá). → **Cierra la pregunta
   abierta**: no alcanza un PDF aparte. Se elimina el "paso 2 barato" y se confirma el comprobante
   cobrable propio, pegado al módulo de cobros.
4. **Requisito nuevo: conceptos prefijados por unidad** — descuento por vecino cumplidor (% o monto
   fijo) y cargos por uso (pádel, tenis, quincho, Club House). **Rompe el invariante de cuadre**: un
   descuento recauda menos que el gasto y un alquiler es plata que no es un gasto repartido. Hay que
   **redefinir** el invariante, no aflojarlo. Diseño en curso.

**Nota fiscal:** el alquiler de amenities es **ingreso ajeno a las expensas** (`provincial/02`) y va
separado en la clasificación. `contador` tiene que confirmar si **vuelve contribuyente de IIBB a un
barrio que no lo era** — es lo más urgente de su lista.

**Diseño resuelto (Parte II del doc 08):** tres tablas con el patrón catálogo -> valor versionado ->
aplicación; `monto_resuelto` firmado; el invariante se **redefine** (`repartido = gastado` como
sub-suma intacta + biyección 1:1 para cargos y descuentos), no se afloja; exclusiones duras (fondo de
reserva, extraordinaria, interés y saldo **nunca** son base de descuento; los descuentos no se
componen; piso cero). **Un check que escribimos nosotros — `item_liquidacion_origen_chk` — bloquea hoy
el requisito entero** y hay que reemplazarlo por `clase_item`. Orden definitivo en el doc 08 §P.

**Decisiones del usuario (2026-07-25), en el doc 08 §N.bis:**
- **Financiamiento del descuento = modo (a) partida presupuestada**, con regla propia de
  dimensionamiento: **la partida se calcula como si todas las unidades calificaran**, para que la
  expensa **neta** cubra los gastos. Quien no califica paga el bruto, y esa diferencia **es la
  penalidad** (la intención declarada: en vez de recargo al que paga tarde, descuento al que paga
  bien). Consecuencia a reportar: si alguien no califica, el barrio recauda **más** que sus gastos y
  ese excedente necesita destino declarado.
- **"Vecino cumplidor" = familia A**: sin saldo pendiente al cierre del período anterior; se recupera
  **automáticamente** al ponerse al día. Lo calcula el sistema, con override motivado.

---

## 2026-07-25 — Panel: criterios de reparto y boleta separada (Claude Code)

**Origen:** dos huecos que marcó el usuario — la extraordinaria puede ir en la misma boleta o en un
comprobante individual; y el monto puede repartirse de varias formas (partes iguales, superficie con
escala, % por UF…). Panel: `administrador-consorcios`, `legal-ph`, `analista-funcional`,
`arquitecto-software`. **Todo está en `docs/diseno/08-criterios-de-reparto.md`.**

**Lo que hay que saber sin leer el doc entero:**
- **Cuatro de las seis formas de repartir YA funcionan** en el motor y en la base (% de reglamento,
  superficie lineal, mixta como vector, monto fijo vía `modelo='fija'`). **Ninguna tiene pantalla.**
- **`partes_iguales` no se puede** hoy con `base='parte_indivisa'`: con N que no divide exacto en 9
  decimales la versión **no cierra** (0,333333333×3 ≠ 1). Es una línea de enum.
- **El criterio por concepto no existe y no tiene workaround** — es la brecha dura. En barrios SA /
  asociación civil es **el modo normal de operar**, no un caso de borde.
- **Guardamos el resultado del reparto, no la regla.** Si cambia una superficie o entra una unidad,
  nadie puede re-derivar ni auditar. Las escalas se expresan en **módulos** y **no suman exacto 1**,
  así que ni siquiera entran por la validación actual.
- **Dos decisiones estructurales a fijar ANTES del módulo de cobros** (su costo se multiplica si se
  postergan): la **mora se computa por obligación con su propio vencimiento** (no por boleta ni por
  período), y **la deuda se imputa al comprobante, nunca al par (período, unidad)**.
- **Guardrail anti-motor-de-reglas:** el criterio nunca se guarda como `jsonb` con condiciones; método
  = enum, parámetros = tablas tipadas. *"Esa fricción es la feature."*
- El cuadre **no se complica**: todos los criterios son vectores de pesos y el motor ya garantiza que
  la suma cierre. Regla: *el control de cuadre verifica aritmética, nunca ejecuta la regla*.

**Orden de construcción acordado:** 0) UI de lo que ya funciona · 1) `partes_iguales` · 2) extraordinaria
como PDF aparte del mismo período · 3) la regla guardada · 4) reparto por concepto · 5) boleta separada
de verdad (con el módulo de cobros) · 6) fijo + variable.

**Pendiente del usuario:** si la boleta individual de la extraordinaria necesita **vencimiento e
imputación propios** (paso 5, migración cara) o alcanza con un **PDF aparte del mismo período**
(paso 2, barato). También sigue abierta la del doc 07 §G.1 (si el residente ve que una extraordinaria
no tiene respaldo).

---

## 2026-07-24 — Correcciones de dominio: dos modelos de expensa y extraordinaria sin acta (Claude Code)

**Origen:** dos correcciones del usuario sobre la operatoria real.

**1. Hay DOS modelos de expensa, y se elige por período** (`periodo_expensa.modelo`):
- `variable`: lo que se cobra sale de los **gastos del mes**, prorrateados por coeficiente (lo que ya
  estaba).
- `fija`: **cuota mensual** que fija el directorio o el administrador. Se versiona en
  `cuota_fija_version` (+ `cuota_fija` con el importe por unidad: todas iguales o distintas, lo decide
  el barrio), con la anterior cerrándose sola al entrar una nueva. Los gastos **ordinarios** se
  registran igual (reporte y libro) pero **no se cobran de nuevo**; las **extraordinarias sí se
  prorratean aparte**, porque son eventos puntuales.
- El modelo va en el período, no en el barrio: cambiar de criterio no reescribe la historia.
- El **cuadre al emitir** se bifurca: `variable` → repartido = gastos; `fija` → repartido = cuotas
  fijas de las unidades activas + extraordinarias. Además, en modelo fijo, **toda unidad activa
  necesita su cuota** o no se emite.

**2. Una extraordinaria puede existir SIN acta de asamblea.** Se sacó el bloqueo. Ahora la base
**marca** el gasto (`sin_respaldo_asamblea`, lo pone el trigger — no la app, así vale para la UI, una
importación o un job) y `generarLiquidaciones()` devuelve `extraordinariasSinRespaldo` para que la UI
avise. El encuadre legal del art. 2048 **no cambia**: sigue pesando al reclamar la deuda (doc 04), y el
sistema sigue sin asumir que la deuda es ejecutable.

**Migraciones:** `0006_modelos_expensa.sql` (generada) y `0007_modelos_expensa_reglas.sql` (a mano:
cuadre por modelo, vigencia de la cuota fija, la marca de la extraordinaria, FKs compuestas y RLS de
las dos tablas nuevas, y un check que impide mezclar una línea de cuota fija con un gasto prorrateado).

**Tests:** 101 en total — 35 unitarios (5 nuevos del modelo fijo + 1 de la extraordinaria sin acta) y
66 contra Postgres real (6 nuevos).

**Pendiente relacionado:** el **modo demo sigue siendo modelo variable**; falta un barrio demo con
cuota fija cuando haya que mostrarlo.

---

## 2026-07-24 — Fase 6C: expensas y liquidación mensual (0004/0005) (Claude Code)

**Rama:** `feat/expensas-liquidacion` (de `main`).

**Qué se cerró:**
- **`0004_expensas.sql`**: `concepto` (ordinaria/extraordinaria + `clasificacion_fiscal` +
  `es_fondo_reserva`), `tasa_mora` versionada, `periodo_expensa` (estado, vencimientos, versión de
  coeficientes congelada, `total_gastos`), `gasto_periodo`, `liquidacion` (subtotales separados, saldo
  anterior, interés, `mora_pendiente_definicion`) e `item_liquidacion` **con el origen de cada línea**.
- **`0005_expensas_rls.sql`**: FKs compuestas `(id, barrio_id)` como en el padrón, más los controles:
  - **extraordinaria exige acta** (art. 2048);
  - **período emitido inmutable** (gastos, liquidaciones y líneas);
  - **no se emite descuadrado**, ni con unidades activas sin liquidar, ni con la versión de
    coeficientes abierta;
  - **transiciones válidas** borrador/revisada -> emitida -> distribuida, sin vuelta atrás;
  - `app.tasa_mora_vigente(barrio, fecha)`; RLS de las 6 tablas.
- **`packages/shared/liquidacion.ts`** (cálculo puro): `calcularLiquidacion()` reparte **cada gasto por
  separado** (resto a la última unidad) para que la suma cobrada sea **idéntica** al gasto del período,
  con subtotales por tipo y fondo; `calcularMora()` con interés simple y, **sin tasa cargada, devuelve
  el motivo en vez de un número**; `transicionValida()` para los estados.
- **`packages/data/src/servicios/liquidacion.ts`**: lee coeficientes/gastos/tasa, llama al cálculo puro
  y persiste; `generarLiquidaciones()` es **regenerable** (borra y recalcula, solo en borrador) y
  `emitirPeriodo()` delega la validación pesada en el trigger de la base.
- **Modo demo con un período EMITIDO** (5 conceptos, tasa 3%, 50 liquidaciones), generado con el mismo
  servicio que usa la app: si algo se rompe, se rompe en el seed y no en una demostración.
- **60 tests contra Postgres real** (13 nuevos) + **30 unitarios** (13 nuevos del cálculo).

**Dos bugs propios que encontraron los tests (documentados en el SQL):**
1. El trigger de "período editable" usaba un `CASE` con `new.liquidacion_id`: plpgsql resuelve todas las
   ramas y fallaba en `gasto_periodo`, que no tiene ese campo. Quedó con `IF/ELSIF`.
2. `item_liquidacion.gasto_id` con `on delete restrict` impedía borrar un período en borrador. Ahora es
   `cascade`: la línea no sobrevive al gasto que la originó (y tras emitir, el trigger no deja borrar).

**Qué NO se hizo (lo próximo):**
- **Cobros y pagos** (`0006`): estado de cuenta por unidad, imputación con orden configurable, pagos
  manuales con `usuario_registrador`, comprobante y **flag antiduplicado**. Con eso, el `saldo_anterior`
  y los días de atraso dejan de ser un parámetro y salen de los datos.
- **PDF por unidad** (HTML->PDF en Docker) y **distribución** (ZIP + email 1-a-1 con registro de envíos).
- **Primera pantalla real** (padrón y liquidación) sobre estos datos.

**Próximo paso sugerido:** cobros/pagos (`0006`), que cierra el circuito del mes; después el PDF.

---

## 2026-07-24 — Fase 6C: padrón del barrio (0002/0003) + modo demo (Claude Code)

**Rama:** `feat/dominio-barrio` (de `main`, que ya tiene 6B + 6C Etapa 0 + la decisión de alcance).

**Qué se cerró:**
- **`0002_dominio.sql`** (generada del esquema Drizzle) — `barrio` (5 ejes + flags de ejecutividad +
  `denominacion_concepto`), `barrio_atributo_vigencia`, `unidad_funcional`, `unidad_contacto`,
  `obligado`, `unidad_obligado`, `coeficiente_version`, `coeficiente`, `documento_barrio`,
  `mandato_administracion`. El `barrio` **extiende** al nodo de tenancía (misma PK), así no hay dos
  identidades del mismo barrio.
- **`0003_dominio_rls.sql`** (a mano) — lo que la base hace cumplir sola:
  - **FKs compuestas `(id, barrio_id)`**: imposible cruzar datos de dos barrios, ni con `app_job`.
  - **Vigencia de los 5 ejes**: la tabla es la fuente de verdad, las columnas son cache; el trigger
    cierra la vigencia anterior **antes** del insert (el índice único de "una sola abierta" se valida
    en el insert, así que cerrarla en un AFTER llegaba tarde) y sincroniza la columna;
    `app.valor_eje_vigente(barrio, eje, fecha)` para los actos con fecha.
  - **Cuadre de coeficientes**: no se cierra una versión que no cuadra (exacto = 1 en parte indivisa;
    pesos relativos en superficie/lote/mixto, art. 2081) ni si falta alguna unidad activa —
    **incluidas las baldías** (art. 2077). Cerrada = inmutable y no se reabre.
  - **RLS de las 10 tablas** con el mismo patrón (lee el subárbol accesible; escribe rol
    administrativo/operativo del barrio) y **sin DELETE**: todas las bajas son lógicas.
- **`packages/shared/barrio`**: los 5 ejes como constantes + Zod (una sola fuente para UI y base),
  `sugerirDenominacionConcepto()` que devuelve **null si no hay fuente cargada** (no inventa cómo se
  llama el concepto en fideicomiso/geodesia) y `faltantesParaViaEjecutiva()` que **nunca afirma** que
  la deuda sea ejecutable: enumera lo que falta acreditar.
- **Modo demo** (`pnpm db:seed`, idempotente): 1 administrador + 1 barrio PH especial en Villa Allende,
  50 unidades (13 baldías/en construcción), 55 obligados (uno de cada diez lotes con poseedor además
  del propietario), contactos, coeficientes por superficie **cerrados y sumando exactamente 1**, y dos
  documentos del barrio. Todo ficticio, sin PII real.
- **47 tests contra Postgres real** (20 nuevos), verdes y repetibles con la base ya sembrada.

**Qué NO se hizo (lo próximo):**
- **Expensas y liquidación** (`0004`): período, conceptos con clasificación fiscal, prorrateo,
  fondo de reserva, mora versionada, estados de la liquidación.
- Pagos/cobros, PDF por unidad, distribución, conciliación.
- **Primera pantalla real (padrón)** sobre estos datos.

**Próximo paso sugerido:** `0004_expensas.sql` + el servicio de liquidación usando `prorratear()` de
`packages/shared` (ya probado: la suma de las partes cierra siempre), y recién después la UI del padrón.

---

## 2026-07-24 — Decisión de alcance: el módulo contable sale del MVP (Claude Code)

**Decisión del usuario:** el **módulo contable no entra al MVP inicial** — hacerlo bien es
prácticamente un ERP (libro contable, resumen fiscal por concepto, balance según figura jurídica).
**Se evalúa más adelante.**

**Qué queda en el MVP en su lugar:** **exportación de movimientos** — planilla CSV/Excel de ingresos y
egresos del período, cada línea con su concepto, barrio y período, para que el administrador se la
entregue a su contador (que es como se resuelve hoy).

**Qué NO cambia:** el **dato** sigue guardando la `clasificacion_fiscal` por concepto (doc 03 §B.3), así
que evaluar el módulo contable más adelante no obliga a recargar ni a migrar nada. El agente `contador`
y `knowledge/cordoba/` siguen igual: se usan para encuadrar, no para construir un módulo ahora.

**Docs actualizados:** `docs/diseno/01-alcance-modulos.md` (§1.1 tabla de módulos y §4.8),
`docs/diseno/05-roadmap.md` (MVP paso 7 y resumen ejecutivo), `CHANGELOG.md`.

---

## 2026-07-24 — Fase 6C (Etapa 0): monorepo + tenancy con RLS probada en Docker (Claude Code)

**Rama:** `feat/fase-6c-fundaciones` (nace de `main`, que ya tiene el merge de 6B). Sin push.

**Qué se cerró:**
- **Monorepo pnpm workspaces** (decisión tomada; cierra el punto abierto del ADR §10):
  `apps/web` + `packages/{shared,data,design-tokens}`, `tsconfig.base.json` estricto
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Vitest con dos
  proyectos (`unit` sin base / `db` contra Postgres real).
  - Los paquetes se consumen como **TS fuente** (sin build previo) y los imports llevan **extensión
    `.ts` explícita**: así los resuelven igual Node (type-stripping nativo de Node 22), Vitest y Next,
    sin sumar `tsx`/`ts-node`. `hoist=false` en `.npmrc`: cada paquete solo importa lo que declara.
- **`packages/shared`** — dominio puro: dinero como **string decimal + aritmética en centavos
  (`bigint`)**, nunca `number` (0.1+0.2 no puede decidir una expensa); `prorratear()` con el resto a
  la última unidad, así **la suma de las partes siempre cierra igual al total**; `CifraTrazable`
  (monto + origen: barrio/período/UF/coeficiente/detalle); helpers de subárbol de tenancía.
- **`packages/data`** — Drizzle + Postgres, con dos migraciones aplicadas y probadas:
  - `0000_tenancy.sql` (generada del esquema TS): `tenant_node` (uuid + `nid` identity + materialized
    path + soft-delete), `membership`, `tenant_grant`, enums en schema `app`, índices (incluido
    `path text_pattern_ops` y el parcial `where activo`).
  - `0001_tenancy_rls.sql` (escrita a mano): `app.current_user_id()`, `accessible_tenant_ids()`,
    `has_role_on()` (STABLE + SECURITY DEFINER + `search_path` fijo), trigger de path en INSERT,
    trigger de **re-parentado** que reescribe el subárbol y rechaza ciclos, roles `app_request`
    (sujeto a RLS) / `app_job` (BYPASSRLS) **sin contraseña en el repo**, y todas las policies.
  - Cliente: `conUsuario(db, userId, fn)` = transacción + `set_config('app.user_id', …, true)`.
- **27 tests contra Postgres real** (`pnpm test:db`), todos en verde: hermanos que no se ven, no se ve
  hacia arriba, administradores distintos aislados, membresía inactiva, soft-delete, **`1.7` vs
  `1.70`**, escritura por rol, propietario que no puede auto-ascenderse, baja lógica (sin DELETE),
  `tenant_grant` visible solo por sus dos puntas, `app_job` que ve todo, re-parentado + ciclo, y
  **`app.current_user_id()` en sus dos modos** (`SET LOCAL` y `auth.uid()` estilo Supabase) más la
  prueba de que la identidad **no queda pegada** a la conexión del pool.
- **`apps/web`** (Next 15 + React 19) mínima pero real: consume los tokens vía CSS vars generadas
  (`pnpm tokens:css`), muestra un prorrateo con `tabular-nums` y los chips de morosidad. `pnpm build`
  en verde. Servicio `app` del `docker-compose.yml` activado (Dockerfile de desarrollo con pnpm).

**Hallazgos que corrigieron el diseño de 6B (importan para 6C/6D):**
1. **`insert … returning` fallaba contra la propia RLS.** `accessible_tenant_ids()` es `STABLE`: se
   evalúa con la foto previa a la sentencia, así que la fila recién insertada "no existe" para ella y
   el RETURNING violaba la policy de SELECT. Solución: la policy de lectura de `tenant_node` acepta
   también `parent_id ∈ accesibles` (no amplía el acceso — si se ve el padre, el hijo ya está en su
   subárbol) **y** exige `deleted_at is null` en esa rama, para que un tenant dado de baja no
   reaparezca por la puerta del padre. **A tener en cuenta al escribir `0002_dominio.sql`.**
2. **El trigger de path lee bajo RLS**: colgar un nodo de un barrio ajeno falla con "parent_id
   inexistente" en vez de un error de policy. Se dejó así a propósito (el sistema no confirma la
   existencia de tenants ajenos) y el test lo documenta.
3. **`app_request` no tiene privilegio de DELETE** además de no tener policy: doble candado para que
   un dato financiero no se evapore desde la app.

**Qué NO se hizo (queda para lo próximo):**
- **`0002_dominio.sql`**: barrio con los 5 ejes versionados + `barrio_atributo_vigencia`, UF,
  `unidad_obligado` multi-obligado desde el día uno, coeficiente con cuadre, expensa, pago con origen.
- **Seed de modo demo** (~50 UF, un período liquidado) — depende de `0002`.
- **Portar el motor puro de conciliación** del gas con sus tests (doc 02).

**Estado de integración (2026-07-24) — TODO EN `main`:**
- **PR #1** (`feat/fase-6b-diseno-producto` → `main`): Fase 6B, mergeado. **PR #2**
  (`feat/fase-6c-fundaciones` → `main`): Fase 6C Etapa 0, mergeado **con el CI en verde**. Las dos
  ramas quedaron borradas; `main` = `Merge PR #2`.
- Se mergeó en ese orden a propósito: con 6B ya en `main`, el diff del PR de 6C muestra **solo el
  código nuevo** (55 archivos) y no los 95 de documentación.
- **CI en GitHub Actions** (`.github/workflows/ci.yml`), verde en el PR y en `main`: tipos → tests
  puros → migraciones y roles → **tests de RLS contra un Postgres real del runner** → tokens al día →
  build de la web. Corre en cada push de rama de trabajo **y** en el PR (`concurrency` evita el run
  duplicado), así el gate funciona incluso si GitHub tiene caídos los Pull Requests — cosa que pasó
  justo hoy (`major_outage`, HTTP 500 al crear PRs) y demoró la integración ~40 minutos.
- Los `push` a `main` de acá en más pasan siempre por PR: es lo que pide `docs/devops/02-sdlc-git-flow.md` §4.

**Cómo levantar todo (queda documentado en `README.md` y `packages/data/README.md`):**
`pnpm install` → `cp .env.example .env` → `pnpm db:up` → `pnpm db:migrate` → `pnpm db:setup` →
`pnpm dev`. Verificación: `pnpm typecheck && pnpm test && pnpm test:db && pnpm build`.

**Próximo paso sugerido:** `0002_dominio.sql` (padrón del barrio) con sus policies por `barrio_id`,
tests de aislamiento a nivel dominio y el seed de modo demo; después, el motor de conciliación.

---

## 2026-07-23 — Fase 6B: diseño de producto + roster técnico (Claude Code)

**Qué se cerró:**
- **Roster técnico de ingeniería (perfiles super-senior)** dado de alta con la estructura portable
  (persona en `agents/personas/`, wrapper en `agents/wrappers-claude/`, copia activa en
  `.claude/agents/`): `product-owner`, `analista-funcional`, `arquitecto-software`, `tech-lead`,
  `ux-designer`, `backend-dev`, `frontend-dev`, `devops`, `qa-funcional`, `qa-automation`,
  `security-engineer`, `dba-data` (12). `mobile-dev` queda para el arranque de React Native. Roster
  sincronizado en `agents/README.md`, `CLAUDE.md` §3 y `AGENTS.md` (que delega al README).
- **5 documentos de diseño en `docs/diseno/`** (+ `README.md` índice), producidos con el equipo y con
  los agentes de dominio (`legal-ph`/`contador`/`administrador-consorcios`) citando la base
  `knowledge/cordoba/` con marca de confianza:
  - `01-alcance-modulos.md`: corte de **MVP básico y mostrable** + operatoria por módulo + multi-figura
    como **5 ejes versionados** + mobile residente-primero.
  - `02-reuso-conciliacion.md`: reúso del motor puro de conciliación del gas (matcher/reglas/reversas/
    FIFO + `nodemailer`/`exceljs`), qué adaptar/descartar, y **pasos de migración** accionables.
  - `03-modelo-datos.md`: **multi-tenancy jerárquica por materialized path** (`tenant_node`+`membership`)
    con RLS por subárbol vía `app.current_user_id()`; dominio del barrio fundado en
    `REQUISITOS-MODELO-DATOS.md` (5 ejes, obligados múltiples, deuda anclada a la UF, pago con origen +
    antiduplicado, mandato de administración versionado, excepciones de aislamiento art. 2084); PDF por
    HTML→PDF en Docker.
  - `04-requisitos-dominio.md`: requisitos **legales y fiscales por figura** con fuente + marca; regla
    rectora "**nunca asumir deuda ejecutable**"; IIBB (Ley 10117, efecto `[A VERIFICAR — CRÍTICO]`),
    conceptos alcanzados/no alcanzados, superposición tasa/expensa (adicional 25% URE).
  - `05-roadmap.md`: MVP en Docker → incrementos → mobile; modo demo (seed ~50 UF); multi-banco
    por-cliente; hosting NO bloquea; **resumen ejecutivo + 3 primeros pasos**.
- `CHANGELOG.md` (`[Sin desplegar]`) actualizado.

**Decisiones tomadas por el usuario en esta fase:**
- MVP = **básico y mostrable** (padrón, expensas+liquidación mensual, liquidación PDF por UF, cobros,
  pagos manuales, proveedores/OP, reporte mensual, **exportación contable**, distribución ZIP+email
  trazable, conciliación de ingresos **no bloqueante**, modo demo). Egresos: registro/órdenes de pago +
  libro exportable; **conciliación de egresos → Inc. 2**. Comunicaciones/reservas/accesos/reclamos/
  reportes avanzados → Inc. 2.
- Tenancy por **materialized path** (sin extensiones; `ltree` opcional a futuro).
- App mobile **residente primero**.

**Qué NO se hizo (fuera de alcance, es Fase 6C):**
- No se scaffoldeó el monorepo ni el esquema real (sigue sin `package.json`); el diseño deja las
  migraciones previstas (`0001_tenancy.sql`, `0002_dominio.sql`) pero no se crearon.
- No se cargó código de producción ni se portó todavía el motor de conciliación (solo el plan de
  migración en `02`).
- **Sin commits/push** (regla del usuario para esta sesión).

**Pendientes / a validar (marcados en los docs):**
- Cerrar con fuente los `[A VERIFICAR]`/`[NO ENCONTRADO]` de `knowledge/cordoba/` (sobre todo: efecto
  del inciso de la Ley 10117, criterio de adecuación de la IPJ Córdoba, jurisprudencia del TSJ/Cámaras
  de Córdoba, tarifarias municipales vigentes). Hasta entonces van como suposición.
- Confirmaciones abiertas del ADR: hosting final, gestor de monorepo (sugerido pnpm), adapter de Auth.
- Puntos `[validar]` del modelo de datos (enum de roles, `tenant_path` denormalizado, motor de PDF
  Playwright vs `@react-pdf/renderer`, si se permite mover barrios entre administradores).

**Revisión de cierre 6B (2026-07-23):**
- **Doc 06 `06-direccion-visual.md`** agregado (ux-designer, con [fe]/[po]): 7 principios, design tokens
  con **modo oscuro desde el día uno** y 3 direcciones de paleta (recomendada **A "Verdemar"** teal+ámbar,
  para romper con el azul-admin y dejar libres los matices semánticos/morosidad), navegación multi-barrio
  con selector persistente + color por barrio, wireframes de 5 pantallas (dashboard, wizard de
  liquidación, estado de cuenta UF, cola de excepciones, distribución), patrones (`CifraTrazable`, Zod
  compartido, estados vacíos con guía), accesibilidad **WCAG AA**, y la regla 6C (toda UI con skill
  `frontend-design` + estos tokens).
- **Ratificación visual (revisión 6B — cierra los 3 pendientes):**
  - **Paleta = A "Verdemar"** (marca teal `#0D9488`, acento ámbar `#F59E0B`). B y C **descartadas** con
    motivo (B: bordó convive mal con el rojo semántico de mora; C: lectura demasiado *consumer* para el
    público administrador).
  - **Tipografía = Geist** (principal) + **Geist Mono** con `tabular-nums` para **toda** columna/cifra
    de dinero (alineación en tablas = requisito). Self-hosted, sin CDN.
  - **Acento por barrio = aprobado** con regla de sutileza: solo línea del selector + tinte leve del
    header; nunca en acciones/estados; nunca reemplaza la marca; hue en banda 230°–335° que excluye
    marca y semánticos; contraste AA. Algoritmo en doc 06 §b.5.
  - **Tokens definitivos materializados** en `packages/design-tokens/` (`tokens.ts`, `semantic.ts` con
    light+dark, `barrio-accent.ts`, `README.md`). La Fase 6C construye la UI desde ahí (el `package.json`
    y el generador de CSS vars se agregan con el scaffold del monorepo).
  - **No queda ninguna decisión visual abierta para 6C.**
- **Confirmado:** conciliación de egresos → Inc. 2 (doc 01, nota como decisión confirmada).
- **Decisión tomada — 5 ejes del barrio (doc 03 §B.1):** modelo **híbrido** — columna enum con el valor
  **vigente** (lectura caliente + validación) + tabla `barrio_atributo_vigencia` como **historial**
  (auditoría / valor a una fecha); trigger sincroniza la columna (cache derivado; la tabla de vigencias
  es la fuente de verdad).
- **Nota para 6C (doc 05):** `unidad_obligado` multi-obligado + histórico se crea en el esquema desde el
  día uno aunque la UI del MVP cargue un solo obligado (evita migración cara con datos ya cargados).

**Próximo paso sugerido:** Fase 6C — scaffold del monorepo + `packages/data` con `0001_tenancy.sql`
probado en Docker (ambos modos de `app.current_user_id()`), modelo de dominio del barrio con RLS + seed
de modo demo, y portar el motor puro de conciliación con sus tests.

---

## 2026-07-22 — Fase 6A: andamiaje de stack/infra + agentes de dominio (Claude Code)

**Qué se cerró:**
- ADR de stack e infraestructura: `docs/arquitectura/00-stack-infra.md`. Decisión: TypeScript +
  Next.js (App Router) + Zod, reusados tal cual del sistema de gas (`trazabilidad-obra-gas`);
  agnóstico de proveedor vía tres abstracciones (datos con Drizzle+RLS, auth detrás de
  `AuthProvider`, storage S3-compatible detrás de `ObjectStorage`); migraciones con `drizzle-kit`
  (SQL plano, no atado a Supabase/Prisma). Documentado qué se reusa tal cual del sistema de gas y qué
  no (llamadas directas al SDK de Supabase, RLS con `auth.uid()` directo, hacks de bundle serverless
  de Vercel — el de `outputFileTracingIncludes` para fuentes de pdfjs deja de ser necesario en Docker).
- `docker-compose.yml` + `Dockerfile.dev` + `.env.example`: Postgres + MinIO local, servicio `app`
  bajo perfil `app` (se activa recién cuando exista el Next.js real en Fase 6B).
- Tres agentes de dominio dados de alta con la estructura portable del template (persona en
  `agents/personas/`, wrapper en `agents/wrappers-claude/`, copiados a `.claude/agents/` — ya
  activos en Claude Code): `administrador-consorcios`, `legal-ph`, `contador`. `legal-ph` y
  `contador` llevan guardrails duros: solo responden con base en `knowledge/<jurisdicción-activa>/`,
  citan fuente, distinguen por figura jurídica del barrio (PH especial/conjunto inmobiliario, SA,
  asociación civil, fideicomiso), y cierran con "Validar con profesional matriculado".
- Estructura de conocimiento jurisdiccional: `knowledge/JURISDICCION-ACTIVA.md` (activa: `cordoba`) +
  `knowledge/cordoba/{nacional,provincial,municipal,jurisprudencia}/` con placeholders (**sin
  normativa real cargada todavía**) + `docs/agents/guia-carga-conocimiento.md` (qué cargar en cada
  carpeta para Córdoba y de dónde sacarlo, fuente oficial, sin transcribir texto normativo).
- `CLAUDE.md`/`AGENTS.md` sincronizados: reglas duras concretas (agnóstico de proveedor, guardrails
  de `legal-ph`/`contador`, PII/RLS multi-tenant, trazabilidad de cifras de dinero, sin secretos),
  tabla de sub-agentes con los 3 nuevos.

**Qué NO se hizo (explícitamente fuera de alcance de esta fase, es Fase 6B):**
- Diseño de producto y modelo de datos (tablas, esquema Drizzle real, roles/usuarios).
- No se scaffoldeó código de Next.js ni el monorepo (`apps/`, `packages/`) — el ADR deja la forma
  prevista pero no se creó `package.json` todavía.
- No se decidió el adapter concreto de Auth (Supabase Auth vs Cognito vs GoTrue self-hosted) ni el
  hosting final (AWS vs Vercel/Supabase vs self-hosted) — el ADR es válido para los tres, queda
  abierto hasta que el usuario lo confirme.

**A confirmar por el usuario antes de seguir (ver ADR §10):**
- Proveedor de hosting final.
- Gestor de monorepo (sugerido: pnpm workspaces, no es decisión cerrada).
- Qué fuentes de Córdoba cargar en `knowledge/` (ver `docs/agents/guia-carga-conocimiento.md`) — sin
  esto, `legal-ph` y `contador` van a responder "no tengo esa fuente cargada" ante casi todo, que es
  el comportamiento correcto del guardrail, no un bug.

**Próximo paso sugerido:** Fase 6B — diseño de producto y modelo de datos (con `administrador-
consorcios` para la operatoria, `legal-ph`/`contador` en panel para lo que dependa de figura jurídica),
recién ahí se scaffoldea `package.json`/monorepo y se activa el servicio `app` del `docker-compose.yml`.
