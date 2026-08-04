# Observaciones del recorrido — lo que se traba al usar la aplicación

> Levantadas por el usuario recorriendo `guia-de-prueba.md` el **2026-08-03**, con la aplicación en la
> pantalla. No es una lista de deseos: es dónde se frenó alguien que sabe de la operatoria y no del
> código. **Es el insumo para rehacer la navegación**, que quedó pedido en `HANDOFF.md` el 2026-07-28
> (*"no está siendo muy intuitivo el UI como se va construyendo"*).
>
> Lo que está resuelto se marca acá y se saca de la lista.

## A. Navegación — el bloque más grande, y el que motivó la lista

**Las cinco quedaron implementadas el 2026-08-04** (commit `3417a82`). Se dejan escritas con su
resolución en vez de borrarlas: la observación es la que explica por qué el código quedó así, y sin
ella el próximo que lea `pasos.tsx` no va a entender por qué la vuelta vive ahí y no en cada pantalla.

| # | Qué pasó | Cómo quedó resuelto |
|---|---|---|
| A-1 | **No hay botón "Volver" a Liquidación** desde las pantallas del período. Se sale por la solapa de arriba, que no se lee como "volver". | ✅ La vuelta vive en `PasosDelPeriodo`, el único componente que las cinco pantallas comparten: la sexta que nazca nace con la salida puesta. |
| A-2 | **Abrir un período se hace clickeando el número de período**, y no se lee como un botón. La fila entera de la tabla parece inerte. | ✅ Columna «Abrir» con la acción nombrada, y arriba la tarjeta del mes abierto con «Continuar liquidación» (doc 06 §c.6.5). Qué mes está abierto lo dice `editable`, que lo escribe el trigger de la base. |
| A-3 | **La pantalla por defecto de un período debería ser el Resumen**, no el paso 1. | ✅ Crear un período aterriza en el resumen. El resumen dejó de ser el paso 5 y pasó a ser la casa del mes; los cuatro pasos numerados son el trabajo. |
| A-4 | **No hay un botón "Nuevo gasto"**: falta el gesto explícito. | ✅ Botón primario anclado al formulario. **Ancla y no diálogo**, a favor de la ráfaga: lo que faltaba era *nombrar* la acción, no esconder el formulario. |
| A-5 | **La pantalla de confirmación de un cargo inusual no tiene salida.** | ✅ «Volver y corregir» resuelto en `useFormulario`, y el prop es **obligatorio** en `PedidoDeConfirmacion`: ninguna pantalla futura puede nacer sin salida. |

> A-3 y A-4 juntos son el diagnóstico de fondo, escrito en el HANDOFF: **la interfaz se construyó de
> adentro hacia afuera**. Refleja el orden en que funciona el motor (paso 1 → 2 → 3), no cómo trabaja
> una persona ("¿cómo viene el mes?" → "che, falta cargar esto").

**A-6 — El resumen mostraba sin dejar actuar.** *(observación del usuario, 2026-08-04, mirando la
pantalla ya con A-1..A-5 resueltas)*

> *"Cuando entro a «Continuar liquidación» voy a esta pantalla, pero no es intuitiva la navegación.
> Para cargar un gasto o ver los gastos debo hacer clic en «Gastos del mes»; es como que el workflow
> no termina siendo intuitivo para navegar."*

Es la misma raíz que A-3 y A-4, un piso más arriba: **resolver dónde caés no alcanza si la pantalla
donde caés no ofrece qué hacer**. El resumen listaba los gastos del mes y no tenía cómo cargar uno;
la única salida era volver al recorrido de arriba y adivinar cuál de los cuatro pasos tocaba. Y el
recorrido no ayudaba, porque cuatro cajas planas con un número adelante **se leen como un indicador
de avance** —algo que se mira— y no como una barra de secciones —algo que se toca—.

✅ **Resuelto el 2026-08-04** en tres frentes, porque era un problema de tres partes:

1. **Cada panel tiene su acción al lado de lo que muestra.** «Cargar un gasto» en el panel de gastos,
   «Revisar y emitir» en el de liquidación por unidad. Si el período no admite cambios, el botón no
   está —ausente, no apagado (§c.6.4)—.
2. **Un panel «Por dónde sigue el mes»** arriba de todo, con la acción principal y **el motivo
   escrito**. Cuál es el paso lo decide `pasoSugerido` de `@admin-barrios/shared/liquidacion`, con
   sus tests: es una regla del dominio y no podía vivir adentro de un componente (ADR-0002 §5.2).
   **Sugiere, no obliga**: los cuatro pasos siguen a un clic.
3. **El recorrido se rehizo como navegación**: los pasos hechos llevan tilde, el activo va marcado
   con tres señales, hay flechas entre uno y otro, y responden al mouse. Vive en `packages/ui`
   (pieza 7 del inventario), así que la próxima pantalla con pasos no vuelve a empezar de cero.

## B. Reglas de base que salen de este recorrido

**B-1 — Máscara de dinero en TODO campo de escritura de importes.** *(regla del usuario, 2026-08-03)*
✅ **Implementada el 2026-08-04** (commits `3417a82` y `c95fa7c`), junto con B-1.bis, que es la otra
cara de la misma pieza. Vive en `@admin-barrios/shared/dinero` (`enmascararMontoTipeado` y
`normalizarMontoTipeado`) y la consume `CampoMonto`, así que **ningún formulario futuro nace sin
ella**. La regla quedó: el punto es siempre separador de miles y la coma siempre el decimal; el punto
del teclado numérico se traduce a coma en el campo, que es lo único que sabe qué tecla se apretó.
La primera versión intentaba adivinarlo en la función pura y **borrar un dígito dividía el importe
por mil** — está contado en `HANDOFF.md`, con los tests que lo fijan.

Todo campo donde se escribe plata tiene que ir mostrando la separación de miles con `.` y los
decimales con `,`, en el formato de la base. En el teclado numérico, el `.` funciona como separador
decimal.

Hoy no la tiene ninguno: el monto de un gasto se escribe `92368783.69` y se ve `92368783.69` — sin
separadores, imposible de leer de un vistazo y fácil de equivocar en un cero. Y es contradictorio con
el resto del sistema, que **muestra** `$ 6.520.250,00` bien formateado en las tablas.

Esta regla es transversal: gastos, cargos, valores del catálogo, topes del barrio, y todo lo que
venga. **Va propagada a `docs/diseno/06-direccion-visual.md` como componente, no resuelta campo por
campo** — si se hace campo por campo, el próximo formulario nace sin ella.

**B-1.bis — Los decimales no se pueden exigir.** *(2026-08-03, mismo recorrido)*

Escribir `2500000` en el monto de un gasto **rebota**: *"monto inválido (esperado string decimal con 2
decimales, ej '1234.56')"*. Nadie tipea `,00` al final de un importe redondo, y un mensaje que te
manda a agregar dos ceros es el sistema haciéndote trabajar para él.

**El campo tiene que completarlos solo.** Y ojo con dónde se arregla: el rechazo no viene de la
pantalla sino del esquema Zod compartido, que exige dos decimales **con razón** — es el que garantiza
que el dinero viaje exacto hasta la base. Lo que hay que cambiar es el componente, que tiene que
normalizar lo que la persona escribió (`2500000` → `2500000.00`) **antes** de enviarlo. Es
exactamente el mismo `CampoDeDinero` de B-1: la máscara y la normalización son las dos caras de la
misma pieza, y por eso se resuelven juntas y una sola vez.

## C. Huecos de funcionalidad detectados

| # | Qué falta | Estado |
|---|---|---|
| C-1 | **ABM del catálogo de conceptos de gasto** (los que se eligen en "Concepto" al cargar un gasto): alta, baja, activación. | Previsto y **fuera del incremento** por ADR-0002 §8. Hay que construirlo. |
| C-2 | **ABM del catálogo de cargos y descuentos** (`crearConceptoBoleta`, `registrarValorConcepto`). | Ídem: los servicios existen, la pantalla no. |
| C-3 | **Importar la factura para autocompletar el gasto**, y poder adjuntar el comprobante (factura / recibo / documento respaldatorio). No obligatorio, pero posible. | No existe. Necesita `ObjectStorage` (que llega con la tanda C) y un extractor. |
| C-4 | **Asignación masiva de cargos o descuentos** a varias unidades de una vez. | No existe. Hoy es de a una. |
| C-5 | **La bonificación por cumplimiento debería aplicarse sola**, no cargarse a mano unidad por unidad: la condición ("sin saldo pendiente al cierre del período anterior") la sabe el sistema. | No existe. Es la diferencia entre un descuento *manual* y uno *por regla*. |
| C-6 | **El "Detalle" de un cargo es texto libre**, así que dos aplicaciones del mismo concepto salen con textos distintos en la boleta ("Sin saldo pendiente…" vs. "Descuento por vecino cumplir"). Debería proponer el texto del concepto y dejar editarlo, no arrancar vacío. | No existe. |

## D. Preguntas abiertas del recorrido, con la respuesta que se les dio

| # | Pregunta | Respuesta |
|---|---|---|
| D-1 | ¿La **fecha del hecho** de un cargo debería ser la del vencimiento de la boleta? | **No.** La fecha del hecho es *cuándo pasó* (cuándo se usó el quincho), y decide **qué valor del catálogo se congela**. El vencimiento es otra cosa y es del período. Cambiarlo haría que un cargo de marzo se cobre al precio de agosto. Lo que sí falta es que el campo **proponga la fecha de hoy** en vez de nacer vacío. |
| D-2 | ¿Existirá un ABM de tipos de gasto? | Sí — C-1. |

## E. Lo que impide probar el aislamiento (paso 8 de la guía)

**E-1 — Hay un solo barrio, y lo ven los tres usuarios.** El paso 8 es el que más vale de la demo
—que lo que se ve y lo que se puede hacer lo decide la base y no la pantalla— y hoy **no se puede
demostrar**: con un barrio y tres usuarios que lo ven todos, cambiar de usuario solo cambia los
formularios que aparecen, no los datos.

El seed necesita un **segundo barrio** con un elenco distinto: alguien que vea los dos, alguien que
vea solo uno, y que al entrar como ese último el otro barrio **no exista** para él. Recién ahí el
aislamiento se ve en vez de explicarse.
