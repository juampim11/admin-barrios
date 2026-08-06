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

**Los importes: la objeción de reidentificación NO aplica acá, y el usuario tuvo razón en marcarlo.**

> *«No entiendo el problema de que cada vecino pueda inferir o calcular la expensa del otro, si son
> todas iguales, el mismo monto para todos.»*

Es correcto, y la corrección importa porque el argumento se había dado por bueno. El razonamiento
—el total dividido por las unidades despeja la cuota individual— **es válido en un barrio que
prorratea por coeficiente**, donde cada unidad paga distinto y la cifra de una persona es un dato de
esa persona. **En un barrio de cuota única no hay nada que despejar:** todos pagan lo mismo, todos ya
lo saben, y conocer la cuota no revela nada de nadie. Se aplicó una regla correcta a un caso donde no
corresponde.

**Entonces la cuota va con su valor real.** Y los conceptos de gasto también.

Lo que sí queda afuera, y por motivos distintos entre sí:

- **El bloque de mora y el padrón nominado** — dato personal, individual y sensible. No entra, y eso
  no está en discusión.
- **La nómina de proveedores con sus importes** — no es un problema de privacidad sino de **de quién
  es el dato**: es información comercial del barrio, no de quien desarrolla el sistema. Publicarla es
  una decisión del directorio, no de ingeniería. Mientras no haya una, los proveedores van con nombre
  genérico y los conceptos con su nombre real.

Regla corregida: **el dato individual no entra; el dato que es igual para todos, sí.**

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

⚠ **El riesgo número uno era el bloque de pago del convenio bancario.** Sin él no es su boleta.
Mostrar la boleta **sin** código de barras diciendo "esto lo trae el convenio" es aceptable; mostrarla
con uno **inventado** es peor que no mostrarla.

#### 9.7.1 ✅ RESUELTO — la demo no replica la boleta de Diego *(decisión del usuario, 2026-08-05)*

> *"No tiene que ser la boleta de Diego, porque hay info que no tenemos. Lo que le presentemos tiene
> que demostrar la capacidad de adaptarse al sistema de cobro que se tenga (o que se vaya a
> incorporar). El sistema muestra en la demo versatilidad, pero no tiene que replicar algo, para una
> demo, que no tenemos detalles de la operatoria, generación de código de barras, proceso de Roela,
> etc."*

**Esto no contesta las preguntas del bloque 1: las saca del camino crítico**, que es más fuerte. El
diseño del PDF **ya no está bloqueado**.

Qué cambia, concretamente:

1. **El objetivo del PDF en la demo deja de ser "que se parezca" y pasa a ser "que se adapte".** Lo
   que tiene que quedar demostrado es que el bloque de pago es **una pieza intercambiable**: que el
   sistema puede alojar el medio de cobro que el barrio tenga hoy o incorpore mañana. Eso ya está
   modelado —`crearMedioGenericoDemo()` y la abstracción de cobranza en `packages/documentos`— y es
   justamente lo que hay que dejar ver.
2. **No se genera ningún código de barras, ni válido ni de mentira.** No hay instructivo del convenio,
   no se conoce el proceso de Roela, y un código inventado sigue siendo peor que ninguno.
3. **Las preguntas del bloque 1 siguen valiendo, pero para el PRODUCTO, no para la demo.** El día que
   haya que emitir un código real hacen falta igual; hoy no frenan nada. Hay que reordenar el
   encabezado de `preguntas-a-la-administracion.md`, que las declara "lo que frena".
4. **Es la regla 6 otra vez, del lado del papel:** replicar la boleta del piloto —con su ente
   recaudador, su cuenta y su formato— sería hornear al piloto en la pieza más visible del producto.
   Lo que se muestra es el mecanismo, no la copia.

### 9.8 Dos decisiones del usuario sobre la cuota *(2026-08-04)*

**El acta no entra ahora.** El esquema ya tiene dónde guardarla (`cuota_fija_version` con documento y
órgano aprobador) y el oficio la marcó como el papel que le van a pedir el día que un vecino discuta
el aumento. Se deja el lugar hecho y **no se pide en la pantalla** todavía: para la demo es fricción
sin valor, y el día que se necesite es agregar un campo, no rehacer el modelo.

**La cuota nueva se carga como porcentaje de aumento sobre la vigente**, no como un importe absoluto.

> *"Si sería bueno que de alguna manera tenga para cargar un % de ajuste (aumento) respecto al mes
> anterior."*

Es cómo se decide de verdad: la cuota no se piensa en pesos, se piensa en *"le damos el 3 %"* — casi
siempre atado a la paritaria del rubro más pesado. Las dos boletas reales del piloto dan **+3,2 %**
entre 03 y 04/2026, o sea que el porcentaje es el dato original y el importe es la consecuencia.

Tres cosas que hay que resolver bien, porque es dinero:

1. **El porcentaje se aplica con la aritmética exacta del proyecto** (`shared/dinero`, centavos en
   `bigint`). Nada de `number`: un 3,2 % en punto flotante sobre ciento diez cuotas deja centavos
   distintos según el orden de las operaciones.
2. **Hay que decidir el redondeo y escribirlo**: una cuota de $372.000 con 3,2 % da $383.904. Lo
   habitual en el oficio es redondear —al peso, o a la centena— para que la cifra sea decible por
   teléfono. **Redondear no es un detalle de formato: cambia lo que se cobra.** Propuesta: al peso, y
   que la pantalla muestre el resultado antes de confirmar.
3. **Se guardan los dos**: el porcentaje aplicado y el importe resultante. El porcentaje es el motivo
   —alimenta el bloque del dorso de la boleta que hoy dice, falsamente para un barrio así, *"tu
   coeficiente no cambió"*— y el importe es lo que se cobra. Guardar solo el importe pierde la
   explicación; guardar solo el porcentaje obliga a recalcular y a que dos lecturas puedan diferir.

El importe absoluto sigue siendo cargable, para el primer período y para cuando el ajuste no sea
porcentual.

### 9.9 La dirección del cálculo: la cuota es **entrada**, no resultado *(corrección del usuario)*

Al sembrar el barrio se escribió *"la cuota sale sola: 194.820.000 ÷ 510 = 382.000"*. **Está al
revés**, y es exactamente la inversión que C-10 venía advirtiendo:

> *"Es al revés: en el sistema el administrador **fijó** el monto de la expensa, y si queremos, el
> sistema le muestra el total a devengar."*

La división sirvió como comprobación —dio el mismo número que las boletas reales, así que el dato es
coherente— pero **describirla como derivación instala justo la idea prohibida**. En este modelo:

```
  el directorio fija        →   CUOTA (entrada)
  el sistema multiplica     →   total a devengar = cuota × unidades activas
  el sistema descuenta      →   recaudación esperada = total a devengar × cobrabilidad
  el sistema compara        →   recaudación esperada  vs  gasto devengado
```

**Nunca al revés.** El sistema no divide gastos por unidades, ni para calcular, ni para sugerir.

**Qué es la cuota, para la demo:** la **expensa pura, ya con el descuento aplicado**. Es decir, la
cifra que efectivamente se le cobra a una unidad que está al día. Se toma así hasta que la
administración diga otra cosa (pregunta 17 del bloque 4).

### 9.10 La alerta de suficiencia, precisada *(C-10, versión definitiva)*

> *"Es interesante que el sistema también muestre o «juegue» con la mora actual o mora corriente, para
> que tampoco sea mentiroso diciendo que sí cubre, pero es porque está asumiendo que todos pagan y
> pagan a tiempo."*

Esto convierte la alerta en **dos cifras y no una**, y la diferencia entre las dos es la que informa:

| | Qué es | Qué supone |
|---|---|---|
| **Total a devengar** | `cuota × unidades activas` | Nada. Es un hecho: lo que se va a facturar. |
| **Recaudación esperada** | `total a devengar × (1 − mora)` | Una tasa de incobrabilidad **declarada**. |

**El total a devengar es el mejor caso posible** —los 510 cumplidores y al día— y por eso **no
alcanza como respuesta**. Una pantalla que dijera "cubre" comparando el gasto contra el total a
devengar estaría afirmando algo cierto solo en un barrio donde nadie se atrasa. En el barrio piloto,
el material real muestra en torno a **cien unidades en gestión de cobranza**: la diferencia entre las
dos cifras no es un matiz, es la respuesta.

**La mora es un parámetro con el que se juega, no un número que el sistema deduzca.** Y hoy **no
puede deducirlo**: el módulo de cobros no existe (es el hueco más grande del relevamiento, §3.1), así
que no hay saldo real contra el cual medir la cobrabilidad. Entonces:

- Se pide como **entrada explícita**, con su valor a la vista, y se puede mover para ver el efecto.
- **La pantalla declara de dónde salió.** Un porcentaje sin origen es un número inventado con cara de
  dato, y eso es justo lo que este proyecto no hace con el dinero.
- El día que exista el módulo de cobros, el valor por defecto pasa a salir de la mora real del barrio
  y el parámetro queda para simular. **La forma no cambia**: por eso se construye así desde ahora.

**Sigue siendo un aviso, nunca un bloqueo.** Un mes puede cerrar en rojo a propósito —se usa el
excedente, viene una extraordinaria—. Lo que no puede es cerrar en rojo sin que nadie se entere.

### 9.11 La pantalla de la cuota: el porcentaje es la decisión, el importe es la consecuencia

> Implementado el 2026-08-04. Cierra el hueco que dejaba a la cuota fija sin pantalla: el modelo
> `fija` se podía liquidar, pero la cuota solo entraba por el script de siembra — o sea que la
> decisión más importante del mes, *cuánto paga cada vecino*, se cambiaba tocando la base.

**El directorio no decide un importe: decide un porcentaje.** No dice "que la cuota sea $383.904",
dice *"le damos el 3,2 %"*, casi siempre atado a la paritaria del rubro que más pesa. Una pantalla
que pide el importe absoluto obliga a hacer la cuenta afuera —en el Excel del que se trata de
salir— y a tipear un número que ya estaba determinado, con el error de tipeo multiplicado por todas
las unidades del barrio.

Por eso son **dos formas del mismo acto** y no dos pantallas: aumentar un porcentaje (lo habitual) y
cargar el importe (el primer período del barrio, y el ajuste que se fijó en pesos).

#### Las cinco reglas que la pantalla hace cumplir

1. **Se guardan tres cosas, porque ninguna se deduce de las otras.** El **importe** (lo que se
   cobra), el **porcentaje** (la explicación: es lo que se contesta cuando el vecino pregunta por qué
   cambió) y el **redondeo**. Más la versión anterior, para poder rehacer la cuenta años después.
   Migración `0028`.
2. **El redondeo no es formato: cambia lo que se cobra.** No tiene valor por omisión — el sistema no
   puede elegir en silencio cuánta plata se mueve en quinientas boletas. Se elige, se ve el efecto
   exacto por unidad y sobre el total, y recién ahí se confirma. Y **un redondeo que mueve la cuota
   más que el ajuste dejó de redondear**: un 0 % al mil sobre una cuota de $500 la duplica; se
   rechaza (`redondeo_desproporcionado`).
3. **El porcentaje se aplica unidad por unidad.** Un barrio puede tener una sola cuota (el caso del
   piloto) o importes distintos —cocheras que pagan la mitad, una quita acordada—. "Aumentar un
   3,2 %" tiene una sola lectura que no inventa nada: aplicarlo a lo que cada unidad paga hoy.
   Promediar sería el sistema decidiendo sobre plata de terceros. Cargar un importe directo, en
   cambio, **iguala a todas**, y la pantalla lo advierte antes.
4. **Dejar la cuota en cero pide confirmación explícita.** Cero es un valor posible —un barrio puede
   suspender la cuota un mes— y también es lo que sale de un −100 %, de un redondeo mal elegido o de
   un campo mal tipeado. La diferencia la ve una persona, no el sistema: misma puerta que la
   migración `0025` le puso a un cargo sobre *una* unidad, en la escritura que multiplica por
   **todas**. Con el aviso de que **de cero no se sale con un porcentaje**.
5. **La cuota se versiona hacia adelante.** Una versión nueva no empieza antes que la que reemplaza
   (`cuota_retroactiva`); lo ya cobrado se corrige en el período siguiente, no cambiándole la cuota al
   pasado. Retrodatar *dentro* de la versión abierta sí se puede: definir el 4 de agosto la cuota que
   rige desde el 1 es la operatoria normal.

#### El bug que la pantalla destapó, y que ya estaba

⚠ **El borrador tomaba "la versión de cuota abierta", sin mirar de qué mes era el período.** Era
inofensivo mientras la cuota entraba solo por el seed y nunca había más de una. Con esta pantalla el
camino normal pasa a ser definir en agosto la cuota **que rige desde septiembre** — y desde ese
momento la versión abierta es la de septiembre.

El modo de falla, con las teclas por omisión y sin un solo error a la vista: se define la cuota de
septiembre, después se genera el borrador de **agosto**, y la boleta de agosto sale con la cuota de
septiembre. `app.validar_emision` cuadra perfecto, porque compara contra la misma versión
equivocada. Nadie se entera hasta que un vecino compara dos boletas.

Corregido: la versión que se usa es la vigente **al primer día del mes que se liquida** —el mismo
criterio con el que un cargo congela el valor del catálogo a la fecha del hecho—, con test de
regresión.

#### La vista previa no es una segunda aritmética

La regla del proyecto es que la pantalla no calcula dinero (doc 08 §AC punto 1). Acá el resultado se
muestra **antes** de confirmar y no la contradice, porque no hay una segunda cuenta: se llama a
`ajustarCuota`, la misma función pura que después ejecuta el servicio, y el rango del porcentaje se
valida con `esPorcentajeDeAjusteValido`, el mismo predicado que usa el borde. La primera versión
copió *solo la regex* y el resultado fue una pantalla afirmando "el barrio pasa a facturar
19.674.871.800,00 por mes" sobre un valor que el servidor rechazaba. **Una regla copiada es una regla
que en algún momento diverge.**


---

### 9.12 Cuándo vence un período respecto de su mes *(dato del usuario, 2026-08-05)*

> *"La liquidación de Corzuelas es del mes corriente. Se liquida el período de abril, en el mismo mes
> de abril y con vencimiento en abril."*

Es un hecho de la operatoria que **no estaba escrito en ninguna parte** —ni acá, ni en el doc 08, ni
en el 09— y que la demostración estaba contradiciendo: los dos barrios sembrados vencían igual, con el
primer vencimiento **45 días después** del 1° del período (el período de julio venciendo el 15 de
agosto). Para el barrio de valor fijo eso es falso.

**Y no es una preferencia del piloto: se desprende del modelo de expensa.**

| Modelo | Cuándo se puede facturar el mes | Por qué |
|---|---|---|
| `variable` (prorrateo) | **después** de que el mes cerró | No se puede saber cuánto paga cada unidad hasta que llegaron las facturas del período. El importe *es* el resultado del mes. |
| `fija` (valor por unidad) | **dentro del propio mes** | El importe lo fijó el directorio de antemano. No hay nada que esperar: el mes se cobra mientras transcurre, como cualquier cuota. |

Consecuencias, ya aplicadas:

1. **El seed siembra las dos operatorias**, una por barrio. Si los dos vencieran igual, la
   demostración estaría afirmando que hay una sola forma de cobrar — la regla 6 de `CLAUDE.md`
   aplicada al dato sembrado y no solo al código. El período emitido del barrio de valor fijo queda
   con el vencimiento **ya pasado**, que además es más fiel a cómo se ve un mes cerrado y le da a la
   mora de dónde salir.
2. **La ayuda del campo del mes en el alta depende del modelo.** Decía *"el mes al que corresponden
   los gastos, **no el mes en que se cobra**"*, que en un barrio de valor fijo es exactamente al
   revés. Es el mismo error que el rótulo "Prorrateo del mes": un texto que explica *cuándo* se cobra,
   escrito mirando un solo modelo.
3. **Nada en el sistema fuerza el desfase**, y está bien así: la boleta imprime el vencimiento que el
   período tenga, y el único control es que el segundo no sea anterior al primero
   (`periodo_vencimientos_chk`). No hay que agregar una regla — hay que dejar de suponerla en los
   textos.

**Lo que queda abierto:** el alta no propone ninguna fecha de vencimiento (a propósito: el sistema no
decide una fecha que sale impresa en la boleta de doscientas familias). Si en algún momento se
quisiera sugerirla, la sugerencia **tendría que depender del modelo** — y antes habría que preguntar
si el barrio tiene un día fijo, que es un dato de configuración que hoy no existe. Por lo de abajo,
en el piloto **sí lo tiene**: es el 10.

#### 9.12.1 Lo que dicen las boletas reales *(medido, 2026-08-05)*

El usuario señaló que no hacía falta generar un PDF para mirar una boleta: hay tres del barrio piloto
en `_referencias/Boletas ejemplos/`. Se leyeron como **dato, no como especificación** (regla de
`CLAUDE.md` sobre material de referencia). Lo que muestran:

| Boleta | Período | Vencimiento | Fecha tope |
|---|---|---|---|
| `Boleta_01228025` | 03/2026 | **10**/03/2026 | 13/03 |
| `boleta_6107_202604` | 04/2026 | **10**/04/2026 | 13/04 |
| `Boleta_01245313` | 08/2026 | **10**/08/2026 | 14/08 |

1. **El vencimiento es el día 10 del propio mes**, las tres veces. Confirma §9.12 con el día exacto.
2. **La segunda fecha existe, pero el papel la llama "fecha tope de recaudación"** y no le cobra
   interés: es hasta cuándo la entidad la sigue recibiendo. La distinción ya estaba escrita en el doc
   09 §B.6 y `vista-boleta.ts` la respeta (la fecha tope **no** sale de `segundo_vencimiento`).

   ⚠ **Acá se cometió y se corrigió un error de dirección**, y vale escribirlo porque es sutil: al
   ver que el piloto no cobra recargo, el seed se dejó con `segundo_vencimiento` en `null` "para ser
   fiel al papel". Eso **no es apegarse al piloto: es quitarle una capacidad al producto para
   parecerse a él**. El usuario lo corrigió el mismo día:

   > *"Las fechas pueden ser configuradas (así como estaba en el alta de un nuevo período, y está
   > buenísimo que así pueda hacerse). Primer vencimiento, segundo vencimiento. No hace falta que sea
   > el mismo texto que la boleta actual, porque **vamos al concepto**. Por más que al 2do vencimiento
   > no haya intereses."*

   O sea: **dos fechas configurables es el modelo**; que un barrio no cobre recargo en la segunda es
   su política, no la ausencia del campo; y el nombre que le ponga su papel es vocabulario, no
   estructura. El seed volvió a sembrar las dos (día 10 y 13).
3. **La estructura de renglones del piloto**, tomada de la de abril: `Cuota Ordinaria 04/2026`
   372.000,00 · `Extraordinaria 2/2` 8.500,00 · `Bonificacion Especial 04/2026` −36.000,00 · total
   **344.500,00**. Tres cosas para el layout: el concepto **lleva el período en el nombre**, la
   extraordinaria viene **en cuotas** (`2/2`), y la bonificación es un **descuento recurrente**.
4. **La hoja es Letter (612×792 pt), no A4**, y trae **talón desprendible** ("Para la Administración")
   con período, vencimiento, fecha tope e importe repetidos.

⚠ **5. El bloque de pago del convenio bancario ESTÁ en las boletas reales**, y es el riesgo §9.7 que
sigue sin decidirse. Se ve: "Ente Recaudador", "Cta. Cte. Nº: 5150048419", una línea de código de
barras, y `Código LINK / Pago mis Cuentas: 0000139055150048419`. **Tener las muestras no decide
nada** —sigue en pie la regla de que mostrarla sin código es aceptable y con uno inventado es peor que
no mostrarla—, pero ahora la pregunta al administrador se puede hacer con el papel en la mano: de
dónde sale ese número, quién lo genera y si el convenio se puede replicar.

---

## 10. Por dónde sigue *(cierre del 2026-08-04)*

El recorrido del mes anda entero y el barrio de importe fijo ya se opera desde la pantalla. Lo que
falta, en el orden acordado con el usuario:

### 10.1 El alta de período no acepta el modelo — y es lo único que puede fallar en vivo

`crearPeriodoSchema` no tiene `modelo`, así que **todo período nuevo nace en prorrateo**. En un barrio
de cuota fija, crear un mes desde la pantalla lo convierte en uno que reparte gastos, y con eso
desaparece el acceso al valor de la expensa. Hoy está tapado porque los períodos del barrio demo los
sembró el script — o sea que **el defecto aparece justo cuando alguien usa la aplicación de verdad**.

Ya estaba anotado en §9.6. Dos cosas para no perder al construirlo:

- El modelo se guarda **por período** y no por barrio, a propósito: un barrio puede cambiar de
  criterio sin perder cómo se liquidó cada mes.
- Un período `fija` **sin versión de valor cargada no se puede liquidar**. La pantalla tiene que
  decirlo al crear, no dejar nacer un mes que después no cierra.

### 10.2 El layout de la boleta, y la decisión que lo precede

El material está en `_referencias/boleta_sistema/` (fuera del control de versiones) y el diseño
documentado en el doc 09. Es lo primero que mira el administrador: la única pieza que ya conoce.

⚠ **Antes hay que contestar qué se hace con el bloque de pago del convenio bancario** (§9.7, riesgo
número uno). Sin esa respuesta el layout se hace dos veces. La regla ya está escrita y no cambia:
mostrar la boleta **sin** código de barras diciendo "esto lo trae el convenio" es aceptable;
**con uno inventado es peor que no mostrarla**. Sigue abierta en
`preguntas-a-la-administracion.md` bloque 1.

### 10.3 Lo grande que viene después

| | Por qué pesa |
|---|---|
| **Cobros** | Sin esto no hay total cobrado, mora real ni saldo — la mitad de lo que el administrador manda hoy en su liquidación. La alerta de suficiencia (§9.10) usa una mora **declarada** justamente porque no hay saldo real contra el cual medirla. |
| **ABM de barrio** | La denominación de lo que se cobra, el logo, el CUIT y los datos del emisor. Doce faltantes documentados en `FALTANTES_CONOCIDOS`, y la boleta hoy imprime sin marca de nadie. |
| **Importación de facturas y tickets** | Pedido del usuario: PDF legible u OCR, y **ticket ≠ factura**. Más la aplicación masiva de descuentos. |
