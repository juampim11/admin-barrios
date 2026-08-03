# Observaciones del recorrido — lo que se traba al usar la aplicación

> Levantadas por el usuario recorriendo `guia-de-prueba.md` el **2026-08-03**, con la aplicación en la
> pantalla. No es una lista de deseos: es dónde se frenó alguien que sabe de la operatoria y no del
> código. **Es el insumo para rehacer la navegación**, que quedó pedido en `HANDOFF.md` el 2026-07-28
> (*"no está siendo muy intuitivo el UI como se va construyendo"*).
>
> Ninguna está implementada todavía. Lo que está resuelto se marca acá y se saca de la lista.

## A. Navegación — el bloque más grande, y el que motivó la lista

| # | Qué pasó | Dónde |
|---|---|---|
| A-1 | **No hay botón "Volver" a Liquidación** desde las pantallas del período. Se sale por la solapa de arriba, que no se lee como "volver". | `…/[periodo]/gastos`, `cargos`, `revision`, `resumen` |
| A-2 | **Abrir un período se hace clickeando el número de período**, y no se lee como un botón. La fila entera de la tabla parece inerte. | `/[barrio]/liquidacion` |
| A-3 | **La pantalla por defecto de un período debería ser el Resumen**, no el paso 1. Hoy entrar a un período te deja en "Gastos del mes", que es una pantalla de carga; lo primero que quiere ver un administrador es cómo viene el mes. | `…/[periodo]` |
| A-4 | **No hay un botón "Nuevo gasto"**: el formulario está siempre desplegado abajo de la lista. Falta el gesto explícito. | `…/[periodo]/gastos` |
| A-5 | **La pantalla de confirmación de un cargo inusual no tiene salida.** Ofrece confirmar y aplicar, pero no "volver y corregir": si el error fue de tipeo —que es justo lo que la pantalla existe para atrapar— no hay camino de vuelta. | `…/[periodo]/cargos` |

> A-3 y A-4 juntos son el diagnóstico de fondo, escrito en el HANDOFF: **la interfaz se construyó de
> adentro hacia afuera**. Refleja el orden en que funciona el motor (paso 1 → 2 → 3), no cómo trabaja
> una persona ("¿cómo viene el mes?" → "che, falta cargar esto").

## B. Reglas de base que salen de este recorrido

**B-1 — Máscara de dinero en TODO campo de escritura de importes.** *(regla del usuario, 2026-08-03)*

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
