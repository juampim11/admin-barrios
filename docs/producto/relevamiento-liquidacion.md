# Relevamiento — el proceso de liquidación en pantalla

> **Origen.** El usuario, probando la pantalla del período con las observaciones A-1..A-6 ya
> resueltas: *"no me ofrece o me dice que el paso natural también es cargar un «Cargo o descuento».
> Sigue haciéndome ruido la pantalla así como está para el proceso de liquidación. Yo convocaría al
> equipo para darle una vuelta más"*. **2026-08-04.**
>
> **Panel:** `administrador-consorcios` (la operatoria real), `analista-funcional` (el modelo y sus
> criterios), `ux-designer` (la forma en pantalla, con relevamiento de `design_handoff_consorcia/`).
>
> **Estado:** hallazgos cerrados. **El usuario eligió la vuelta completa y está implementada**
> (2026-08-04): la ficha de cierre reemplaza al recorrido y al panel, nace el panel de cargos,
> «generar» deja de compartir botón con «emitir», los bloqueos se dicen antes y la nota verde declara
> su alcance. Lo que **no** entró queda en §7.

---

## 1. El veredicto — los tres coinciden

**El mes no es una escalera de cuatro escalones.** Son **dos frentes de preparación que se llenan
todo el mes, en paralelo y por gente distinta**, que alimentan un **cierre de tres momentos**.

```
PERMANENTE (todo el mes, sin orden entre sí, distinta gente)
   Gastos del barrio  ·  Cargos y descuentos por unidad  ·  (Pagos recibidos)
                              │
                              ▼
EL CIERRE (esto sí es secuencia)
   Generar el borrador → Revisar → Emitir (irreversible) → Distribuir
```

El cargo del quincho lo carga portería el lunes; la factura de energía llega tres semanas después.
Numerarlos «1» y «2» **afirma una precedencia que no existe**.

## 2. Los defectos, en orden de daño

### D-1 · La pantalla puede mandarte a emitir cuando la emisión va a fallar ⚠

`pasoSugerido` dice *"el borrador está generado: falta revisarlo y emitir"* con solo mirar que haya
liquidaciones. Eso es **falso en cuatro situaciones frecuentes**, y en las cuatro `app.validar_emision`
(migración `0017`) rechaza la emisión:

| Qué pasó después de generar el borrador | Qué levanta la base |
|---|---|
| Se cargó o anuló un gasto | `el período no cuadra (modelo variable)` |
| Se aplicó un cargo o descuento | `hay N conceptos aplicados sin resolver` |
| Se anuló una aplicación | `N líneas de cargo/descuento contra M aplicaciones` |
| Cambió el padrón (alta/baja de unidad) | `faltan liquidaciones: N unidades activas y M liquidaciones` |

Hoy eso aparece **recién como un error de Postgres al apretar el botón**. La causa raíz está escrita
en doc 08 §X: el borrador es un **nodo derivado que se invalida solo** cuando cambia cualquiera de sus
entradas.

### D-2 · La nota verde da seguridad falsa sobre una acción irreversible ⚠

*"No quedan pendientes registrados en este período"* cubre **3 de las ~12 condiciones** que la base
verifica antes de emitir, y se lee como "podés emitir".

### D-3 · «Cargos» es un valor **inalcanzable**, no un paso olvidado

`PASOS_DEL_PERIODO` declara cuatro y `pasoSugerido` solo puede devolver tres. Y **no se arregla con
un `if` más**: un cargo se aplica el día 1 o el 28, así que no existe un estado del mes en el que
"aplicar cargos" sea *el* paso que falta. La pregunta *"¿cuál es el paso?"* no tiene respuesta para
este proceso.

> **La forma es la culpable, no el código.** Un stepper tiene dos estados: **hecho** y **pendiente**.
> «Opcional, y este mes no aplica» no tiene celda en esa tabla. Las dos decisiones que lo produjeron
> eran correctas por separado: no marcar cargos como "hecho" (*sería mentir*) y no sugerirlo (*no hay
> trabajo pendiente ahí*). **Entre dos honestidades, el paso desapareció.**

### D-4 · Defectos menores, verificados

- El tilde de "Revisar y emitir" se pone con el borrador generado, **sin haber emitido nada**.
- `hechos` solo se pasa en el resumen: entrando a "Gastos del mes" con 12 gastos cargados, el
  recorrido dice que el paso 1 está pendiente.
- La regla ignora el **modelo del barrio**: en `fija` el motivo *"sin gastos no hay nada que
  prorratear"* es falso —se liquida la cuota igual— y la alerta roja de descuadre es una falsa alarma
  cuando el gasto es ordinario.
- `puedeEmitir` existe en el modelo y **no se lee en la pantalla**: a un contador se le ofrece un
  botón que la base le va a rechazar.
- El resumen **no tiene panel de cargos**. Un paso cuyo resultado no aparece en el resumen del mes es
  un paso que el resumen no reconoce como parte del mes.

## 3. Lo que el proceso real tiene y la aplicación no menciona

Del `administrador-consorcios`, para backlog de producto — **no** son parte de esta pantalla:

1. **La cobranza del mes anterior bloquea la liquidación del mes**: la boleta lleva el saldo anterior,
   y mandarle deuda a alguien que pagó es el error que más caro sale en confianza. No hay un renglón
   de esto en el recorrido.
2. **El administrador vive en "¿cómo vengo con los cinco barrios?"**, no adentro de uno. La ventana de
   cierre es transversal y toda la navegación cuelga del barrio.
3. **Esperar dos facturas**: falta el estado *esperando factura de X* / monto provisorio. Sin eso, el
   administrador anota en un papel por qué no cerró.
4. **"Traer los gastos del mes anterior"**: el 80 % son los mismos 12 rubros todos los meses. Es el
   mayor ahorro de tiempo del oficio y no existe.
5. **El ajuste del mes siguiente**: cuando algo salió mal ya emitido no se reemite, se mete una línea
   "Ajuste liquidación 07/2026" en la boleta del mes que viene. Es un cargo por unidad — **prueba
   definitiva de que Cargos no puede ser el paso 2 de un período: es la herramienta con la que se
   arregla el período anterior**.
6. **Las cuotas de planes y la bonificación por pago en término no deberían cargarse a mano.** Hoy sí.
   Es la fuente número uno de errores del oficio.

## 4. La propuesta — «la ficha de cierre» *(implementada, ver §7)*

**Reemplaza el recorrido de cuatro cajas Y el panel «Por dónde sigue el mes» por una sola pieza**: un
checklist vertical. Una pieza, un lugar; contradicción imposible. Hoy son dos componentes que
contestan la misma pregunta y se contradicen a 40 píxeles de distancia.

```
┌─ Para cerrar 08/2026 ─────────── 1 de 3 obligatorios · falta emitir ─────────┐
│  ✓  LISTO       1 · Gastos del mes                                           │
│                 12 gastos cargados · $ 6.520.250,00    [ Cargar otro gasto ] │
│  ──────────────────────────────────────────────────────────────────────────  │
│  –  SIN         2 · Cargos y descuentos        ‹OPCIONAL›                    │
│     NOVEDADES   Ninguno aplicado este mes — la mayoría                       │
│                 de los meses no lleva.                [ Aplicar un cargo ]   │
│  ──────────────────────────────────────────────────────────────────────────  │
│  ☐  FALTA       3 · Revisar y emitir                                         │
│                 Borrador del 14/09 · 47 boletas ·   [ Revisar y emitir → ]   │
│                 2 avisos anotados más abajo          ▲ única acción primaria │
│  ──────────────────────────────────────────────────────────────────────────  │
│  ·  TODAVÍA NO  4 · Boletas                                                  │
│                 Se generan cuando el período esté emitido.  (sin botón)      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**El estado que faltaba ya existe en el vocabulario estándar: la casilla en guión** (checkbox
indeterminado). Cuatro estados, cada uno con **glifo + palabra + color** — tres señales, se distinguen
en escala de grises (doc 06 §f.2):

| Glifo | Palabra | Qué afirma | Botón |
|---|---|---|---|
| `✓` | **LISTO** | hecho verificable | sí, secundario |
| `☐` | **FALTA** | trabajo obligatorio pendiente | sí, primario si es el sugerido |
| `–` | **SIN NOVEDADES** | opcional, y este mes no hubo | **sí, siempre** |
| `·` | **TODAVÍA NO** | no se puede aún, **con la razón** | no (§c.6.4) |

Cero tokens nuevos, cero hex.

**Las otras cinco piezas de la propuesta:**

1. **Cada fila lleva su evidencia, no una etiqueta**: no *"Gastos del mes ✓"* sino *"12 gastos
   cargados · $ 6.520.250,00"*. El estado **es** el hecho.
2. **Nace el panel de cargos del período** en el resumen, con su estado vacío (*"Este mes no se aplicó
   ninguno — es lo normal"*). Es el arreglo más barato y el que más mueve la aguja.
3. **La cadena de cifras usa las mismas palabras que la grilla de abajo** (`Prorrateo del mes ·
   Ajustes de la unidad · Viene de antes`, que son los `GRUPOS` de `grilla.tsx`): la cifra de arriba y
   el encabezado de la tabla **no se pueden contradecir porque son el mismo texto**. Y el cero se
   declara: *"Ajustes de la unidad — ninguno este mes — $ 0,00"*.
4. **La salida de «Gastos del mes» nombra dos caminos**, con la pregunta que hace el trabajo:
   *"¿Hubo quincho, invitados de más o alguna bonificación? → Cargos y descuentos. Si no hubo nada de
   eso —que es lo normal— → Revisar y emitir."*
5. **Un vacío por pantalla, no cinco.** Un período recién creado hoy dibuja cinco contenedores vacíos
   y un botón útil. Con cero gastos y cero liquidaciones, la cadena de cifras y las dos tablas no se
   renderizan.

**Y `pasoSugerido` cambia de forma**: deja de devolver *un paso* y pasa a devolver **situación +
bloqueos + avisos + acción principal**. Una regla que elige uno siempre va a callar los otros.

## 5. Qué se relevó de `design_handoff_consorcia/`

Insumo de producto, **no** fuente de verdad (ADR-0003 §9).

**Se toma la forma de cinco ideas:** el estado como motivo exacto y no etiqueta genérica; la anatomía
del panel de cuadratura (etiqueta-izquierda / cifra-derecha, subtotal con línea, veredicto al final);
que **todo aviso declare si bloquea o no**; el CTA con el número embebido (*"Emitir 47 boletas"*) y la
consecuencia irreversible pegada al botón; y el avance resumido en palabras en la lista de períodos.

**Con una corrección obligatoria:** ellos rematan la cuadratura con *"Diferencia $0 · cuadra"*. Esta
pantalla **no dictamina** si el mes cierra —depende del modelo y es regla de negocio—. Se adopta la
forma, no el veredicto: nuestra línea afirma un hecho verificable (*"los $X prorrateados coinciden con
los 12 gastos cargados hoy"*), no una conclusión.

**Se descarta, con motivo:** su stepper (**no tiene estado "completado"**: un paso recorrido se ve
igual que uno futuro); su forma de resolver lo opcional (una frase en el header y ninguna marca en los
pasos — *es exactamente el defecto que estamos arreglando*, y además codifica hecho/futuro solo con
color); sus tres pasos fijos (no hay lugar para cargos por unidad ni para el modelo de cuota fija, y
el barrio piloto es S.A.); el footer «Anterior/Continuar» con autoguardado (wizard de cliente, ya
rechazado en ADR-0003 §3); el total como `<div>` con fondo fuera del `<tfoot>` (un lector de pantalla
no lo asocia a las columnas); y los chips como control principal (sin `<label>`, sin foco, sin
teclado).

> **Dato que vale por sí solo:** el prototipo cometió **el mismo error dos veces**, de forma
> independiente. Es la mejor evidencia de que el problema es de la **forma**, no de nuestra
> implementación.

## 6. Preguntas abiertas — no se deciden acá

| # | Pregunta | A quién |
|---|---|---|
| P-1 | ¿Emitir un período `variable` con **cero gastos** es legítimo (un mes solo de cargos) o un error operativo? Hoy la base lo acepta: se pueden emitir 50 boletas en cero | `administrador-consorcios` + `product-owner` |
| P-2 | ¿Se puede emitir **sin fecha de vencimiento**? El esquema la deja nullable y la base no la exige | `administrador-consorcios` + `legal-ph` |
| P-3 | ¿Regenerar el borrador debería ser automático al detectar el desfasaje, o siempre un gesto explícito? (regenerar reescribe cifras de dinero) | `product-owner` |
| P-4 | ¿La etapa `revisada` tiene semántica propia —alguien distinto revisa y firma— o es decorativa? Hoy el resumen no la distingue de `borrador` | `product-owner` |
| P-5 | Qué respaldo corresponde a una extraordinaria en **SA, asociación civil y fideicomiso**, y si su ausencia condiciona el reclamo igual que en PH | `legal-ph` |
| P-6 | El vocabulario por figura: en una **SA** no se liquidan "expensas" sino aportes o cuotas sociales. El nombre de los pasos y de la boleta debería salir de la figura del barrio | `product-owner` + `legal-ph` |

---

## 7. Qué entró y qué no *(2026-08-04)*

### Entró

| Qué | Dónde |
|---|---|
| `estadoDelCierre` reemplaza a `pasoSugerido`: devuelve **situación + bloqueos + acción + frentes**, no un paso | `packages/shared/src/liquidacion.ts`, con 18 tests |
| Los **frentes abiertos** (cargar un gasto / aplicar un cargo) se ofrecen en **toda** situación editable | ídem, `frentesAbiertos` |
| El estado **`sinNovedades`** — el que faltaba y por el que el paso de cargos había desaparecido | ídem + `packages/ui/src/ficha-de-cierre.tsx` |
| **«Generar el borrador» deja de compartir botón con «Emitir»** | ídem |
| **Los bloqueos se dicen antes**, con la cifra concreta y qué los levanta | `[periodo]/page.tsx` |
| **Nace el panel de cargos del período**, con su vacío que explica qué entra ahí | ídem |
| La nota verde declara su alcance y **solo aparece sin bloqueos ni avisos** | ídem |
| La diferencia liquidaciones/unidades pasa de nota `info` («es esperable») a **bloqueo** | ídem |
| El tilde de «Revisar y emitir» **ya no se pone antes de emitir** | `estadoDelCierre.frentes.revision` |
| **La barra de las pantallas de trabajo dejó de ser un recorrido numerado.** Una pieza, un trabajo: la ficha dice cómo viene el mes (solo en el resumen) y la barra dice a dónde se puede ir (solo en las de trabajo). Sin números, sin tildes y sin flechas | `packages/ui/src/barra-de-frentes.tsx` |

### No entró, y por qué

| Qué | Motivo |
|---|---|
| **Distinguir ordinaria de extraordinaria en `fija`** para el bloqueo de descuadre | Pide un dato que todavía no se trae. Mientras tanto, en `fija` el desfasaje de gastos **no se declara bloqueo**: antes eso que pintar una alerta roja falsa |
| **El estado de la versión de cuota fija por unidad** (`unidadesSinCuotaFija`) | Ídem: bloqueo real, dato no disponible. Hoy solo se mira que exista la versión |
| La cadena de cifras con las palabras de la grilla, y el «un vacío por pantalla» | Son mejoras de composición del panel de cifras, no del ruido que se reportó. Quedan pendientes |
| Todo lo de §3 (cobranza del mes anterior, vista de los N barrios, esperar facturas, traer los gastos del mes anterior) | **Backlog de producto.** Son huecos de alcance, no de esta pantalla |
| Las seis preguntas abiertas de §6 | Dependen de la operatoria o del encuadre legal. No se deciden desde acá |

---

## 8. La segunda vuelta: el formulario de carga y el peso de la barra *(2026-08-04)*

> **Origen.** El usuario, con la ficha de cierre ya puesta: *"[En Gastos] aparece el botón «Nuevo
> gasto» que te lleva a la misma pantalla, más abajo. [En Cargos] no hay un botón de nuevo cargo,
> pero sí el form para cargar. Los 4 recuadros arriba me hacen ruido visual. O en todas las pantallas
> hay un form por defecto para cargar, o en todas las pantallas el botón abre el form (idealmente, a
> nivel UI, entiendo que sería mejor con un modal), salvo que el equipo vea otra cosa."*
>
> **Panel:** `ux-designer` y `administrador-consorcios`. **El equipo vio otra cosa**, y no coincidió
> entre sí: vale la pena que quede escrito por qué.

### Lo que dijo cada uno

**`administrador-consorcios`** — recomendó **mixto**: formulario siempre visible en gastos, modal en
cargos. Su dato decisivo no fue la ráfaga sino **si hace falta ver la lista mientras se carga**, y da
resultado opuesto en cada pantalla:

- **Gastos: la lista hace falta.** Cargando contra una pila de veinte comprobantes, la pregunta cada
  dos minutos es *"¿la de seguridad ya la cargué?"*, y el único chequeo es mirar la lista. Y el total
  acumulado es la brújula contra el mes anterior: si a mitad de carga ya está muy por encima, se
  revisa antes de seguir. **60–80 % del volumen entra en los últimos 3 a 5 días**; un estudio de 5
  barrios carga 150–300 líneas esa semana.
- **Cargos: no hace falta.** Se carga a ciegas contra el papel en la mano (la planilla de reserva, el
  parte de portería), son 5 a 30 por mes, y muchas veces lo hace otra persona con menos práctica: ahí
  la ventana enfocada ayuda a no equivocar la unidad.
- Y una advertencia que vale para cualquier modal: **si se cierra al guardar, es un impuesto por
  ítem**. El antídoto es «Guardar y cargar otro».

**`ux-designer`** — recomendó **el mismo patrón en las dos**: el botón despliega el formulario en
línea. Su argumento decisivo es el que ganó:

> **El ciclo de confirmación de monto inusual vive adentro del formulario.** `PedidoDeConfirmacion`
> **reemplaza** al formulario dentro de la misma tarjeta, y de ahí sale «Volver y corregir» con los
> valores intactos. Metido en un diálogo, ese ciclo pasa a necesitar **cuatro invariantes nuevas**:
> que `Esc` no cierre en la mitad (cerrar ahí pierde los valores del intento anterior y el código
> confirmado), que «Volver y corregir» no cierre el diálogo, que el foco vaya al aviso que apareció y
> no al primer tabulable, y que el scroll no desplace el fondo. Son cuatro invariantes sobre **el
> freno que atrapa el cero de más**, que tiene un test de tres vueltas. **La forma correcta de no
> degradarlo es no moverlo.**

Y un segundo motivo, sobre el guardado: si el modal **se cierra**, el acuse de éxito se queda sin
lugar y el sustituto es un **toast** — que ADR-0003 §3.4 mandó a backlog con gatillo escrito, y con el
motivo: *las confirmaciones de dinero se muestran pegadas al formulario a propósito*. Si **queda
abierto**, tapa la tabla y el total que se acaban de actualizar detrás.

### Lo que se hizo

**El botón despliega el formulario en línea, igual en las dos pantallas** (`PanelDesplegable`, sobre
`<details>`/`<summary>` nativo: cero JavaScript, teclado y `aria-expanded` gratis). Cerrado cuando la
lista de abajo ya tiene filas, abierto cuando no hay ninguna — mismo criterio en las dos, escrito una
vez. **Nunca se cierra solo**: ni al guardar, ni al fallar, ni al pedir confirmación.

Reconcilia las dos recomendaciones: la lista sigue a la vista para gastos (el requisito del
administrador) y el gesto es único para las dos pantallas (el pedido del usuario), sin tocar una línea
de `formulario.tsx` — que era el criterio de aceptación.

**Y la barra pasó a pestañas de una línea.** Se fueron el borde, el fondo, el radio y el renglón de
detalle (*"qué se gastó"*, *"por unidad"* — ocho palabras que repetían el título). La activa se marca
con subrayado, peso y `aria-current`: se cambió una señal cromática por una de forma, no se perdió
una señal.

### Lo que queda anotado

- **«Guardar y cargar otro»** para la carga en ráfaga: hoy el panel queda abierto y el formulario se
  limpia solo, que cubre el caso. Si el piloto pide contador de cargados, es una vuelta más.
- **El modal sigue teniendo su lugar**, y es otro: lo **irreversible** (emitir), donde interrumpir es
  el punto (doc 06 §e.5).
- Cuatro preguntas para la administración del piloto que salieron de acá: proporción real goteo vs.
  ráfaga y cuántos gastos por mes; **quién carga los cargos por unidad** (si portería entra al sistema
  o pasa una planilla, cambia la respuesta); volumen mensual de cargos; y qué usan hoy y qué es lo que
  más los enoja de eso.

---

## 9. El barrio piloto y la cuota fija *(panel del 2026-08-04)*

> **Origen.** El usuario: *"¿podemos usar Las Corzuelas como un nuevo barrio, ya con los datos que
> tenemos? Tenemos padrón, expensas, liquidación. A lo mejor es el mejor ejemplo para la demo con
> Diego. Son expensas con monto fijo iguales para todos (no tienen un % o coeficiente)."*
>
> **Panel:** `security-engineer` (obligatorio: hay datos personales) y `administrador-consorcios`.

### 9.1 La cuota fija no es un caso de borde: es la otra mitad del mercado

El prorrateo por coeficiente de parte indivisa es el patrón de **edificio / PH**, donde las unidades
son heterogéneas y la ley manda la proporción. En **loteos y barrios cerrados organizados como SA o
asociación civil**, con lotes vendidos como equivalentes —una acción, un lote, un voto, una cuota—, la
cuota única es la forma típica. Doc 08 §B ya lo tenía resuelto: en SA, cuota única es válida por vía
estatutaria.

> ⚠ Es criterio de industria, **no una estadística**. No presentarlo como dato duro.

**Y es el modelo que nunca se vio en pantalla.** Los dos barrios de la demo prorratean por
coeficiente. Sembrar uno de cuota fija hace que la demo sirva además de prueba de un camino de código
que hoy solo cubren los tests.

### 9.2 Qué cambia en la operatoria, y por qué se siguen cargando los gastos

Se rompe la identidad *"lo repartido = lo gastado"*. La liquidación deja de ser un **cálculo** y pasa
a ser una **emisión**: la cuota es un ingreso presupuestado, no un resultado. Los gastos se siguen
cargando por cuatro motivos, todos confirmados contra el informe real del piloto (doc 10 §B):

1. **Rendición de cuentas.** El vecino paga un número que no se explica solo: en cuota fija el informe
   mensual es *más* importante, no menos.
2. **El resultado del período** (recaudación esperada menos gasto devengado). Es *el* número de un
   barrio así, y el informe actual del piloto **no lo calcula**.
3. **Fijar la cuota siguiente.** Sin gasto cargado, el directorio la fija a ojo.
4. **Pagar proveedores.**

**Cuando el gasto supera lo recaudado**, las palancas en orden de uso real: absorber con excedente o
fondo, **ajustar la cuota hacia adelante** (nunca retroactivo), extraordinaria solo para gasto no
recurrente e identificable, y estirar el pago a proveedores (financiamiento, no solución). El
tratamiento del excedente cuando sobra sistemáticamente se deriva a **`contador`**.

### 9.3 C-10 · La alerta de suficiencia de la cuota *(requisito del usuario)*

> *"Claramente, el sistema debe alertar si con ese monto de cuota de expensas —incluso calculando con
> la mora corriente— la recaudación alcanza para afrontar los costos. **Pero no es que los costos
> totales se dividen por las UFs.**"*

Es la contracara exacta del hallazgo 9.2.2, y llegó por dos caminos independientes: el oficio dijo
*"el resultado del período es el número que falta"* y el usuario pidió la alerta. **Convergencia, no
coincidencia.**

Lo que la distingue de un prorrateo, escrito para que nadie lo implemente al revés:

- **No hay derivación de la cuota desde el gasto.** La cuota la fija el directorio; el sistema **no la
  calcula ni la sugiere dividiendo**. Si algún día se sugiere, es una propuesta explícita y separada,
  nunca el valor por defecto.
- **La alerta compara, no reparte:** recaudación esperada por cobrabilidad, contra gasto devengado.
- **La cobrabilidad no es un supuesto nuestro:** sale de la mora corriente del propio barrio, que el
  sistema ya conoce. Una alerta que asuma 100 % de cobranza en un barrio con cien unidades en mora no
  sirve para nada.
- **Es un aviso, no un bloqueo.** Un mes puede cerrar en rojo a propósito (se usa el excedente, viene
  una extraordinaria). Lo que no puede es cerrar en rojo **sin que nadie se entere**.

### 9.4 Los datos: qué entra al repositorio y qué no

**Corrección a lo que se creía:** `_referencias/datos/informes.json` **sí tiene datos personales**, y
son los más sensibles del material: un bloque de mora con **145 titulares únicos**, cada uno con
nombre, manzana, lote, saldo y estado de gestión judicial (100 registros en 02/2026, 74 en 03, 114 en
04). En un barrio, manzana y lote **son** el domicilio.

**La regla, aplicable sin criterio caso por caso.** Tres preguntas antes de que un valor entre a un
archivo versionado: ¿está atado a una unidad, lote, manzana o titular? (el saldo también) ¿Nombra a
una persona física o a un proveedor real? ¿Es un agregado de al menos cinco unidades que no se despeja
por diferencia? Las dos primeras excluyen; la tercera admite. Y una de piso, verificable en CI:
**ningún archivo versionado lee `_referencias/`**. El k≥5 no se inventa acá: ya es doctrina del repo
en `vista-listado-mora.ts`.

**Decisión del usuario sobre el padrón** *(2026-08-04)*: se cargan **todas las manzanas y lotes
reales** —que son la traza física del barrio, no un dato personal— y **los nombres y los CUIT se
reemplazan por otros completamente ficticios**. Estructura real, personas inventadas. Es exactamente
lo que pide la regla de arriba.

**Los importes, en cambio, no van tal cual.** Con cuota fija igual para todos, publicar el total de
cuotas ordinarias junto con la cantidad de unidades hace que **la cuota individual salga de una
división**, y con ella cualquier vecino que conozca su saldo empieza a ubicar los ajenos. Lo que
parecía simplificar es lo que vuelve el agregado reversible. Se siembra **orden de magnitud**, no la
cifra: la demo se ve igual de creíble.

Regla que lo resume: **nombre real y cifra real no conviven en un archivo versionado.**

**El nombre del barrio.** ADR-0001 §1 ya lo tiene decidido por otro motivo —el producto es
**white-label** y multi-cliente: *"Nada de «Las Corzuelas» en el código"*—. El barrio sembrado lleva
nombre ficticio; para la reunión con el administrador se usa el **cargador local** de 9.5, que sí
puede poner el nombre y el padrón reales en la máquina de quien demuestra.

### 9.5 El cargador local, para la demo puntual

Aceptado por `security-engineer` con controles, todos necesarios: vive **en `_referencias/`** (no en
`packages/`, donde un `git add -f` lo commitea); **doble guard** de entorno **y** de host —un `.env`
con `APP_ENTORNO=local` apuntando a staging pasa el primero sin ruido—; administrador con id fijo
**distinto** del demo y bandera de "contiene datos reales"; vencimiento con borrado que el arranque
verifica; contenedor efímero; y el padrón no sale de esa máquina.

**Y el aislamiento sale gratis:** si el barrio real cuelga de un administrador distinto, la RLS ya
hace que un prospecto no pueda verlo. Aun así, el control más simple es el más fuerte: **dos bases, no
dos barrios en la misma base.** Si el dato real no está en la base que se abre frente al prospecto, no
hay control que pueda fallar.

### 9.6 Lo que bloquea, y no es de datos

- **No existe pantalla para el modelo del período ni para la cuota fija**, y `crearPeriodoSchema`
  (`packages/shared/src/escrituras.ts`) **no acepta `modelo`**. Hoy un barrio de cuota fija solo se
  puede sembrar por SQL.
- **La cuota se actualiza casi todos los meses**: las dos boletas reales dan +3,2 % entre 03 y
  04/2026. La pantalla tiene que pedir **un importe para todas las unidades más excepciones**, no
  ciento diez números. El esquema ya soporta lo demás: `cuota_fija_version` tiene vigencia, documento
  y órgano aprobador.
- **Hueco en `estadoDelCierre`**: en `fija` devuelve `sinNovedades` cuando no hay gastos, así que se
  puede emitir un mes entero sin cargar un peso y nadie se entera. Debería bloquear el **cierre del
  informe**, aunque no la emisión.
- **Bug de diseño que esto destapa:** el dorso de la boleta (doc 09 §E.3.1) explica el cambio del mes
  con *"el gasto del barrio bajó 3,1 %. Tu coeficiente no cambió"*. En un barrio de cuota fija eso es
  **falso**: ahí tiene que decir que la cuota cambió porque el directorio la actualizó, con su acta.

### 9.7 La demo con el administrador: en qué orden mira, y qué la hunde

**Mira, en este orden:** su boleta (la única pieza que ya conoce), el listado de mora (lo que más le
duele: unas cien unidades), el informe mensual **con el resultado del período** que hoy su informe no
calcula, y cambiar la cuota.

**Lo que le hace decir "esto no es lo mío":** que le pidamos coeficientes (fatal); que el flujo lo
obligue a cargar gastos antes de emitir; que falte la **bonificación al cumplidor** o el **cargo por
uso** (pádel), que emite todos los meses.

⚠ **El riesgo número uno: el bloque de pago del convenio bancario.** Sin él no es su boleta. Mostrar
la boleta **sin** código de barras diciendo "esto lo trae el convenio" es aceptable; mostrarla con uno
**inventado** es peor que no mostrarla. Sigue sin respuesta en `preguntas-a-la-administracion.md`
bloque 1.
