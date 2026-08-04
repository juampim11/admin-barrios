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
