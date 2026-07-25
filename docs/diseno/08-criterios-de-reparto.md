# 08 — Cómo se reparte la expensa (criterios de reparto) y la boleta separada

> **Fase 6C.** Documento de decisiones del panel convocado el 2026-07-25 a partir de dos huecos que
> marcó el usuario: (1) *una extraordinaria puede ir como ítem de la misma boleta o en un comprobante
> individual*; (2) *el monto puede aplicarse de varias formas: por superficie con una escala, igual
> para todas las UF, un % por UF, etc.* Participaron `administrador-consorcios`, `legal-ph`,
> `analista-funcional` y `arquitecto-software`.

---

## A. El hallazgo que ordena la respuesta

**Cuatro de las seis formas de repartir YA funcionan en el motor y en la base. Ninguna tiene pantalla.**

| Forma | ¿Se puede hoy? | Cómo |
|---|---|---|
| **% por UF (reglamento)** | ✅ Sí, es el caso nativo | `base = 'parte_indivisa'`, el valor es el porcentaje |
| **Superficie lineal** | ✅ Sí | `base = 'superficie'`, el peso son los m² (pesos relativos, no porcentajes) |
| **Mixta como vector** | ✅ Sí | `base = 'mixto'` acepta cualquier vector calculado afuera |
| **Monto fijo por UF** | ✅ Sí, como modelo del período | `modelo = 'fija'` + `cuota_fija` por unidad |
| **Partes iguales** | ⚠️ **Solo de refilón, y con una trampa** | Ver §B |
| **Escala por tramos** | ⚠️ Solo el **resultado**, no la regla | Ver §C |
| **Criterio por CONCEPTO** | ❌ **No, de ninguna forma** | Ver §D. No hay workaround |

`apps/web` hoy no tiene ninguna pantalla de coeficientes, modelo, cuota fija ni gastos. **La mitad del
hueco 2 se resuelve construyendo la UI de lo que ya existe**, sin tocar el esquema.

---

## B. "Partes iguales": la trampa de los 9 decimales

Con `base = 'parte_indivisa'` y 3 unidades: `0,333333333 × 3 = 0,999999999 ≠ 1` → el trigger **rechaza
cerrar la versión**. El parche (darle `0,333333334` a una) hace que **una unidad pague un centavo
distinto sin razón explicable**.

Se puede esquivar declarando `base = 'lote'` o `'mixto'` con peso 1 para todas — pero entonces la
etiqueta miente: dice "mixto" cuando la regla es "partes iguales", y eso va impreso en la boleta.

**Decisión: `partes_iguales` entra como valor propio de `base`.** Es una línea de enum y desbloquea el
caso más común de los barrios chicos.

**Encuadre legal (`legal-ph`), que el sistema debe respetar:** la validez **depende de la figura**.

| Figura | ¿Partes iguales? |
|---|---|
| Conjunto inmobiliario / PH especial | **Sí** — art. 2081: "en la proporción que establece **el reglamento**" |
| SA | **Sí**, por vía estatutaria (es la forma típica: una acción por lote) |
| PH puro | **Problemático** — art. 2046 inc. c manda "en proporción a la parte indivisa", y ahí la proporción **la fija la ley** |
| Asociación civil / fideicomiso | **Sin fuente cargada** |

→ El sistema **debe poder representarlo**, pero **no ofrecerlo como una opción neutra e indiferente a
la figura del barrio**. Y **nunca sugerir un criterio por defecto**: el criterio viene del instrumento.

---

## C. Guardamos el resultado, no la regla

Hoy la versión de coeficientes guarda un número por unidad. **El eslabón `superficie/tramo/% →
coeficiente` vive en el Excel del administrador.** La cadena `gasto → coeficiente → monto` está
impecablemente trazada… y se corta un eslabón antes.

**Qué se rompe hoy:**
- **Cambia la superficie de un lote** → el coeficiente no se mueve, la versión sigue vigente, **nadie
  se entera**. Y como la superficie de hoy ya no es la que generó el coeficiente, la verificación
  manual tampoco se puede hacer.
- **Entra una unidad nueva** → el sistema **falla seguro** (la emisión se bloquea con "faltan
  liquidaciones"), pero el mensaje no nombra la causa y la única salida es **recargar 51 coeficientes
  a mano**.
- **"¿Por qué pago esto?"** → la respuesta llega hasta *"porque tu coeficiente es 0,019372"*. Con una
  escala por tramos, ni el administrador que la cargó puede rehacerla seis meses después.

**Las escalas se expresan en módulos, no en pesos** (`hasta 400 m² = 1,00 · 401-700 = 1,25 · …`), y el
valor del módulo flota cada mes con el gasto. **Los coeficientes derivados de una escala no suman
exactamente 1** (dan 0,999999999): por eso la escala **no entra** por la puerta de la validación
actual. Hay que guardar la regla y derivar.

**Y hay piso y techo**, que son el corazón del asunto: *"ninguna unidad paga más de 2 veces la mínima"*
es la razón por la que la escala existe; la cuota mínima protege al barrio del lote que no cubre ni el
costo de estar en el padrón. Son parámetros de primera clase, no algo que se emula moviendo tramos.

**Decisión: se guardan las dos cosas, con roles distintos.**

> **La regla explica. El resultado congelado obliga.**

- La regla vive en el criterio (método + parámetros/tramos). El resultado sigue en `coeficiente`, con
  las mismas garantías de hoy (cerrada = inmutable, no cierra si no cuadra).
- **Nunca se deriva al liquidar.** Si se derivara al vuelo, un borrador revisado el martes cambiaría
  solo el jueves porque alguien corrigió una superficie: la revisión del administrador valdría cero.
  Derivar es una **acción explícita** sobre una versión abierta.
- **Se congela el insumo** (`los m² que se usaron`, `el tramo que le tocó`). Sin eso la regla explica
  el método pero no la cifra. La cadena auditable completa es **insumo → regla → peso → monto**.
- Si el criterio es derivado, **el coeficiente resultante es de solo lectura**: se corrige la
  superficie o el parámetro, y queda rastro. Editarlo a mano es el error #2 de §F.

---

## D. El criterio va en el CONCEPTO

Es la brecha dura: hoy **todo el período se reparte con un solo vector**. No hay workaround — partir
el gasto no sirve, porque todos los pedazos se reparten igual.

**No es un caso de borde.** En barrios organizados como SA, asociación civil o fideicomiso es **el modo
normal de operar**. Apareamientos típicos:

| Concepto | Criterio habitual | Por qué |
|---|---|---|
| Vigilancia · honorarios de administración | **Partes iguales** | Se cuida a la familia y al portón, no al metro cuadrado |
| Espacios verdes · calles · riego | Superficie / coeficiente | Correlaciona con la extensión |
| Agua | **Consumo medido** | El lote de 1.400 m² riega; el de 300, no |
| Residuos | **Por vivienda** | Una bolsa por casa |
| Alumbrado | Partes iguales o **por frente** | Columnas por frente |
| Obras (portal, asfalto) | **Partes iguales**, aunque las ordinarias vayan por superficie | "La obra beneficia igual a todos" es el argumento asambleario ganador |

**Decisión: el criterio se define en el `concepto` y se congela en el período.**
No a nivel barrio (es el problema de hoy). No a nivel gasto (elegirlo 40 veces por mes es hostil y no
deja regla auditable). El reglamento habla de **conceptos**, no de facturas.

**Encuadre legal:** habilitado por el art. 2081 vía reglamento, y ya estaba en nuestra propia base de
conocimiento (*"prorrateos con ítems de consumo diferenciado"*). **Con la misma tensión en PH puro**,
donde el art. 2046 inc. c no distingue por concepto: ahí el criterio por concepto es excepción que
exige instrumento explícito, no capacidad general.

**Por qué esto NO complica el cuadre.** Los criterios son todos **vectores de pesos**, y el motor ya
reparte cualquier vector garantizando que la suma cierre exacta. `Σ items = Σ gastos` **sigue valiendo
idéntico**. Regla que queda escrita: *el control de cuadre verifica aritmética, nunca ejecuta la regla*.

**Guardrail anti-motor-de-reglas (ADR pendiente).** El criterio **no** se guarda como un `jsonb` con
condiciones. El método es un enum y los parámetros viven en tablas tipadas. Agregar un método cuesta
una migración y una revisión de código: **esa fricción es la feature**. Una expresión que nadie puede
leer es lo contrario de la trazabilidad que promete el producto.

**El monto fijo por unidad NO es un criterio de reparto.** Un criterio de prorrateo **preserva** el
invariante "lo repartido = el gasto"; asignar importes fijos **lo destruye**. Es un cargo, y ya tiene
su lugar (`modelo = 'fija'`).

---

## E. La boleta separada de la extraordinaria

**El default se mantiene: mismo comprobante, ítem separado.** Un documento, un vencimiento, un pago:
menos mora, menos consultas, menos errores. La boleta aparte es la excepción — pero ocurre en todo
barrio que hace una obra.

**Cuándo se separa, en la práctica:** obra en cuotas con vencimiento propio y descuento por
precancelar · universo distinto de obligados (solo un sector, solo los construidos) · **destinatario
distinto** (el contrato de locación pone las ordinarias a cargo del inquilino y las extraordinarias
del propietario) · cuenta bancaria separada · obras pactadas en UVA o en materiales, donde **el importe
no está fijo al emitir** · convenio individual de pago.

**Legalmente no cambia la ejecutividad** — esa cuelga del **certificado de deuda** (art. 2048), no de
la boleta. Pero con una condición: si la extraordinaria vive en un circuito paralelo, **tiene que poder
consolidarse en el mismo certificado**; un comprobante suelto que el certificado no alcanza es un
agujero en el título.

**Lo caro no es el PDF: es la imputación de pagos.**

> **Si el pago viene identificado con un comprobante, se imputa a ese comprobante** — aunque haya deuda
> más vieja. Si el sistema lo manda a la deuda antigua, el propietario queda "al día en la obra y
> debiendo la ordinaria", llama, y no lo entiende nadie.

Y para el pago no dirigido (transferencia pelada), el orden es configurable por barrio con default
(gastos de gestión → intereses más antiguos → capital FIFO), **registrando que fue automático** para
poder revertirlo.

**Decisión estructural (`legal-ph` y `administrador-consorcios` coinciden):**

> **La mora se computa por obligación, con su propio vencimiento — no por boleta ni por período.**
> **La deuda se imputa al comprobante, nunca al par (período, unidad).**

Esta última es la única decisión del panel **cuyo costo se multiplica si se posterga**: si el módulo de
cobros se escribe contra `(periodo, unidad)`, el segundo comprobante lo rompe y hay que desagregar
pagos ya imputados. Fijarla hoy cuesta cero.

**Modelo elegido:** otra fila de `liquidacion` con un tipo de comprobante y vencimientos propios —
`liquidacion` **ya es el comprobante** (tiene número, total, destinatario, y el PDF se genera por
liquidación). Una entidad nueva por encima obligaría a rehacer el PDF, la auditoría y el cuadre para
nada. El saldo anterior y la mora van **en un solo comprobante** por unidad y período (el ordinario),
para no cobrarlos dos veces.

---

## F. Los tres errores más caros del administrador (se vuelven requisitos)

1. **Cambiar el criterio y emitir sin ver el antes/después.** Cuarenta unidades saltan 200% y se
   entera por cuarenta llamados, con las boletas distribuidas y la mitad pagadas.
   → **Simulador comparativo obligatorio** antes de aplicar: mismo gasto, criterio viejo vs. nuevo,
   delta en $ y en % por unidad, ordenado por mayor salto. Bloquear la emisión si hay unidades por
   encima de un umbral sin confirmación explícita registrada.
2. **Coeficientes que "cierran" porque alguien tocó un decimal.** Se unifican dos lotes, uno se da de
   baja, la versión queda sumando 0,97 y **todos los meses el 3% del gasto no se le cobra a nadie**,
   disfrazado de falta de cobranza e invisible durante meses.
   → Cero unidades huérfanas; ajuste del residuo **explícito y con motivo**; aviso al alta/baja de una
   unidad de que la versión vigente quedó incompleta.
3. **Meter una obra en la ordinaria con el criterio equivocado.** El que paga la expensa paga la obra
   sin saberlo; el inquilino paga algo que no le corresponde; y después no se puede reclamar limpio.
   → Toda extraordinaria exige **criterio explícito** (no hereda en silencio) y **se imprime en la
   boleta**.

*(Cuarto, creciendo: operar en modelo fijo sin mirar el desfasaje contra el gasto real. El sistema debe
mostrar todos los meses, sin que nadie lo pida, cuota recaudada vs. gasto del período.)*

**Y una decisión escondida que hay que hacer explícita:** cuando una unidad está exenta de un concepto
(el baldío no paga residuos, el sin cochera no paga su mantenimiento), la plata liberada **se
redistribuye** entre las demás o **la absorbe el barrio**. Son cosas distintas y hoy la segunda **ni
siquiera se puede expresar** (el sistema exige que lo repartido sea igual al gasto). Sin una línea
explícita de absorción, el administrador termina inflando un gasto para que cierre.

---

## G. Orden de construcción

| # | Qué | Por qué en ese lugar | Costo |
|---|---|---|---|
| **0** | **Pantallas de lo que ya funciona** (coeficientes con previsualización, modelo del período, cuota fija, gastos) | Cuatro de las seis formas ya andan y **ninguna tiene UI**. Es la mitad del hueco 2 a costo de esquema **cero**. Y sin esa pantalla no se puede validar con un administrador real qué brecha duele de verdad | UI |
| **1** | **`partes_iguales` como base propia** | Una línea de enum. Desbloquea el caso más común de barrios chicos, hoy **imposible de cerrar** cuando N no divide exacto | Trivial |
| **2** | **Extraordinaria como PDF aparte del mismo período** | Cubre la mayor parte del hueco 1 **sin tocar un solo invariante**. Hay que ponerlo delante del usuario **antes** de pagar la migración cara: puede que alcance | Bajo |
| **3** | **La regla guardada** (método + parámetros + insumos congelados + recálculo asistido) | Resuelve el fondo del hueco 2. Va **antes** del reparto por concepto: sin esto, "por concepto" sería "otro vector manual más por concepto" — multiplica el Excel en vez de eliminarlo | Medio |
| **4** | **Reparto por concepto** | La brecha dura, puramente aditiva sobre el paso 3. Conserva "una línea por gasto", así que la mayoría de los tests sobrevive | Medio |
| **5** | **Boleta separada de verdad** (vencimiento, numeración e imputación propias) | Es la migración con más superficie de rotura, y **la mitad del requisito es la imputación de pagos, que hoy no existe**. Va **pegado al módulo de cobros**, no antes | Alto |
| **6** | **Fijo + variable en el mismo período** | Rediseña el cuadre de emisión, el invariante más protegido. Último, y solo si aparece un barrio que lo necesite | Alto |

---

## H. Lo que hay que confirmar con el usuario

**La pregunta que separa un cambio de un día de una migración con conversión de datos:**

> La "boleta individual" de la extraordinaria, ¿necesita **vencimiento propio e imputación propia de
> pagos**, o alcanza con que sea un **PDF aparte del mismo período**?

Si alcanza el PDF aparte → paso 2, barato, sin tocar invariantes.
Si necesita vencimiento e imputación propios → paso 5, y va con el módulo de cobros.

---

## I. Vacíos de fuente detectados (carga pendiente para `knowledge/cordoba/`)

1. **Requisitos formales de la liquidación/boleta** — nada cargado (forma, contenido mínimo, si admite
   comprobantes separados).
2. **Criterios de reparto no proporcionales** — validez de escalas por tramos y límites del reglamento:
   sin doctrina ni jurisprudencia cargada.
3. **Mora**: constitución (automática vs. interpelación) y efecto de vencimientos escalonados.
4. **Criterio registral de Córdoba** sobre modificación de reglamento y coeficientes (hoy solo consta
   el de CABA 2019). Cambiar el criterio de reparto **es modificar el reglamento** → 2/3 de la
   totalidad (art. 2057) y el tema en el orden del día; **podría requerir escritura e inscripción**.
5. **Mayorías de reforma estatutaria en SA**; **articulado de asociaciones civiles y fideicomiso**.

**Validar con profesional matriculado.** La elección del criterio de reparto y su instrumentación
afectan la exigibilidad del cobro y la validez de la liquidación.
