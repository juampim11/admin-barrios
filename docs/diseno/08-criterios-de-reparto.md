# 08 — Cómo se reparte la expensa (criterios de reparto) y la boleta separada

> **Fase 6C.** Documento de decisiones del panel convocado el 2026-07-25 a partir de dos huecos que
> marcó el usuario: (1) *una extraordinaria puede ir como ítem de la misma boleta o en un comprobante
> individual*; (2) *el monto puede aplicarse de varias formas: por superficie con una escala, igual
> para todas las UF, un % por UF, etc.* Participaron `administrador-consorcios`, `legal-ph`,
> `analista-funcional` y `arquitecto-software`.


---

## A.0 — CORRECCIONES DEL USUARIO (2026-07-25). Prevalecen sobre todo lo demás de este documento

El usuario administra barrios reales. Donde su operatoria contradice a un agente, **manda la suya**.

### 1. Los gastos comunes son comunes a todos. No se reparten por concepto

> *"Es casi imposible, y deberíamos dejarlo como caso excepcional de borde a futuro, que los gastos
> comunes se distribuyan por superficie. Los gastos comunes son comunes a todos; lo que puede variar
> es **la forma en que se cobra la expensa**, cuya sumatoria total cubre todos los gastos comunes."*

**Qué cambia:** el criterio es **cómo se cobra la expensa, a nivel barrio** — no un criterio distinto
por concepto. Todo el §D de este documento (criterio en el `concepto`, con la tabla de "vigilancia por
partes iguales, verde por superficie") **baja a caso de borde futuro**. El `administrador-consorcios`
lo había puesto como modo normal de operación; el usuario dice que no lo es.

**Consecuencia práctica:** el paso 4 del plan (§G) sale del camino crítico. Lo que queda del hueco 2 es
**cómo se cobra** (partes iguales, % de reglamento, cuota fija por categoría) y **guardar la regla**
(§C), que sigue en pie: si la cuota sale de una escala, la escala tiene que estar en el sistema.

### 2. Extraordinaria como ítem de la boleta: sin tratamiento diferenciado

> *"La expensa extraordinaria, cuando es un ítem de la boleta de expensa común, no tiene un tratamiento
> diferenciado (vencimiento, deuda, mora, etc). **Es parte de la expensa común de ese mes.**"*

**Confirma el comportamiento actual del sistema.** No hay nada que construir para este caso, que es el
default.

### 3. Extraordinaria con boleta propia: TODO diferenciado

> *"Si esa extraordinaria va por separado, con su boleta, su imputación y seguimiento, todo lo referido
> a esa boleta sí es diferenciado. Puede que un vecino abone la ordinaria y no la extraordinaria, o
> viceversa, y cada una con un vencimiento diferente, con una composición de intereses diferente, y así
> debe tratarse."*
>
> Caso real de referencia: **la obra de gas de Las Corzuelas (Guazú Pytá)**.

**Cierra la pregunta abierta de §H:** no alcanza con un PDF aparte. El comprobante separado necesita
**vencimiento, intereses, imputación y seguimiento propios**. Es el paso 5, y va pegado al módulo de
cobros. El paso 2 ("PDF anexo barato") **deja de tener sentido como entrega intermedia**: resolvería la
mitad visible del problema y ninguna de las de fondo.

### 4. Requisito nuevo: conceptos prefijados por unidad (cargos y descuentos)

> *"En la boleta se deben poder agregar conceptos, prefijados en el sistema. A modo de ejemplo: la
> expensa tiene un valor de tanta plata, pero por vecino cumplidor se le aplica un descuento (que puede
> ser un % o un monto fijo), entonces para ese vecino el monto a abonar es la expensa menos el
> descuento. O cargos por otros ítems: alquiler de canchas de pádel, tenis, quincho, Club House."*

**Esto rompe el invariante más protegido del sistema.** Hoy la base exige que **lo cobrado sea
exactamente igual al gasto del período**:
- un **descuento** hace que se recaude **menos** que el gasto;
- un **cargo por alquiler de quincho** es plata que entra y **no es un gasto repartido**.

El invariante de cuadre hay que **redefinirlo**, no aflojarlo: tiene que seguir siendo verificable por
la base con aritmética pura. Diseño en curso (`administrador-consorcios` + `arquitecto-software`).

**Nota fiscal para no perderla:** el alquiler de amenities es, en el encuadre ya cargado, un **ingreso
ajeno a las expensas** (`provincial/02` los nombra junto con alquileres, antenas y publicidad) y tiene
que quedar **separado** en la clasificación — aunque el módulo contable esté fuera del MVP, el dato se
guarda desde el día uno.

### Orden de construcción, corregido

| # | Qué | Estado tras las correcciones |
|---|---|---|
| 0 | Pantallas de lo que ya funciona | **Sin cambios** — sigue siendo lo primero |
| 1 | `partes_iguales` como base propia | **Sin cambios** — trivial y desbloquea el caso común |
| 2 | ~~Extraordinaria como PDF anexo~~ | **Se elimina**: la corrección 3 dice que no alcanza |
| 3 | La regla guardada (escala, insumos, recálculo) | **Sin cambios** — sigue en pie |
| **N** | **Cargos y descuentos por unidad + cuadre redefinido** | **Nuevo, y es MVP**: el descuento por cumplidor y el alquiler de canchas son cotidianos |
| 4 | ~~Reparto por concepto~~ | **Baja a borde futuro** (corrección 1) |
| 5 | Comprobante separado con vencimiento, mora e imputación propias | **Confirmado y ascendido**: es el requisito, no una opción cara |
| 6 | Fijo + variable en el mismo período | Sin cambios |

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

---

# PARTE II — Cargos y descuentos por unidad (diseño)

> Sale de la corrección 4 del usuario (§A.0). Panel: `administrador-consorcios` + `arquitecto-software`.

## J. La distinción que ordena todo: consolidado vs. condicional

| | **Consolidado al emitir** (cumplidor, jubilado, exención) | **Condicional al pago** (pronto pago) |
|---|---|---|
| Mira | El pasado | El futuro |
| **La deuda exigible es** | El neto, ya descontado | **El monto pleno** |
| El interés corre sobre | El neto | El pleno |
| Si no paga | Debe el neto. **Nada que reclamar** | Debe el pleno; el descuento caduca sin dejar rastro |
| En la boleta | Renglón que resta | **Un segundo importe**, no un renglón |
| **¿Toca el cuadre de emisión?** | **Sí** | **No** — no se resta al emitir |

> **"Si el barrio quiere que se pierda el descuento cuando no paga esa boleta, entonces no está
> pidiendo un descuento por cumplidor: está pidiendo un pronto pago."**

**El descuento por cumplidor NO se reclama si después no paga.** Se ganó por las boletas que ya pagó;
se pierde para la próxima. Cobrarlo retroactivamente deja una diferencia que no es capital ni interés
y que nadie sabe imputar.

**El pronto pago se modela como descuento condicional sobre la deuda plena, nunca como recargo del
segundo vencimiento.** Con recargo, el capital es el bajo, el plus hay que justificarlo como punitorio
—y choca con la tasa de mora ya versionada, cobrando dos veces el mismo atraso— y aparece la pregunta
sin respuesta buena de si el interés corre sobre el monto con recargo o sin él. Impreso puede seguir
viéndose como los dos vencimientos de siempre: eso es decisión de plantilla, no de modelo.

**"Vecino cumplidor" lo calcula el sistema**, con override del administrador que exige motivo. Dos
familias posibles, y **no hay default correcto**: (A) *"sin saldo pendiente al cierre del período
anterior"* — se recupera automático al ponerse al día; (B) *"las últimas N boletas en término"* — se
pierde con un solo atraso y **se recupera recién N meses después**. Se congela en la liquidación qué
regla, con qué fecha de corte y con qué dato se evaluó.

## K. Modelo — tres tablas, patrón conocido

Mismo patrón que `cuota_fija_version` / `cuota_fija`: catálogo -> valor versionado -> aplicación.

| Tabla | Qué es |
|---|---|
| **`concepto_boleta`** | Catálogo del barrio: nombre, `clase` (cargo/descuento), `metodo` (monto fijo, porcentaje, precio x cantidad), `base_calculo`, clasificación fiscal, orden de impresión |
| **`concepto_boleta_valor`** | El parámetro **versionado con vigencia** (monto, %, precio unitario, tope) + el instrumento que lo aprobó. Trigger de cierre automático, copia del de `cuota_fija_version` |
| **`concepto_boleta_unidad`** | La aplicación a una unidad en un período, con **snapshot congelado** y el origen: `fecha_hecho`, `detalle`, `aplicado_por` |

**Un solo catálogo, no dos.** Misma pantalla, mismo ciclo de vida, misma RLS. Lo que difiere se tipa
con `clase` + checks. Dos tablas obligarían a FKs nullables en la aplicación: peor.

**`monto_resuelto` va FIRMADO** (descuento negativo, cargo positivo). Así `total = suma de items` sigue
siendo una suma sin casos especiales, el PDF no necesita un `case when`, y el check del ajuste de
redondeo sobrevive sin tocarse.

**`aplicado_por` es obligatorio**: un descuento es plata que el barrio deja de cobrar; sin autor no hay
control. **`fecha_hecho` + `detalle` también**, para los cargos: *"Alquiler quincho $45.000"* sin fecha
ni reserva es un número sin origen — y la única pregunta que llega siempre es *"yo no usé el quincho
el 14"*.

**Necesita el trigger `app.periodo_editable`**, igual que los gastos: sin él se le agrega un cargo a
una boleta ya distribuida.

## L. El invariante, redefinido (no aflojado)

El invariante viejo era **`recaudado = gastado`**. Estaba **mal enunciado, no mal implementado**:

> **`repartido = gastado`** (una sub-suma, **intacta**) **+ toda otra línea trazada 1 a 1 con su origen.**

```
modelo variable:  suma items[clase='prorrateo']  = suma gastos del período          <- INTACTO
modelo fija:      suma items[clase='prorrateo']  = suma gastos extraordinarios      <- INTACTO
                  suma items[clase='cuota_fija'] = suma cuotas de unidades activas  <- INTACTO
ambos:            biyección 1:1 {items cargo/descuento} <-> {concepto_boleta_unidad}
```

La identidad del prorrateo es **exactamente** la de hoy, con un filtro por clase. No cambia una línea
de su semántica. Y todo sigue siendo **aritmética sobre datos guardados**: la base nunca decide *si*
el vecino es cumplidor — verifica que, si se declara 5% sobre $180.000, el número sea $9.000.

**Lo que se pierde a propósito:** el sistema ya no garantiza que el barrio recaude lo que gastó. Eso
pasa de invariante impuesto a **dato reportado** — y hay que reportarlo todos los meses sin que nadie
lo pida (`periodo_expensa.total_cargos` / `total_descuentos`).

**Un check que escribimos nosotros bloquea el requisito entero.** `item_liquidacion_origen_chk` exige
que toda línea sea cuota fija **o** tenga gasto y coeficiente: una línea *"Quincho — sáb 11/07"* no es
ninguna de las dos. Se reemplaza por un `clase_item` (`prorrateo` / `cuota_fija` / `cargo` /
`descuento`) con su check por clase, más un **check de signo** que hoy no existe.

## M. Sobre qué se descuenta

**Configurable** (`base_calculo`): expensa ordinaria, expensa del período, sin base.
**Exclusiones duras, NO configurables:**

- **Fondo de reserva, nunca.** Va a cuenta separada (art. 2046 inc. d): descontar ahí desfinancia una
  cuenta que no es del administrador para premiar a un vecino.
- **Extraordinaria, nunca por default.** Tiene instrumento y universo de obligados propios; un
  descuento de la ordinaria que se derrama a la obra la deja corta y se descubre al final.
- **Interés y saldo anterior, nunca.** Un descuento sobre intereses **no es un descuento: es una
  condonación** — otra figura, otro respaldo, otro autor autorizado. Va al módulo de cobros como quita
  de un crédito ya devengado.
- **Los descuentos no se componen**: todos aplican sobre la misma base calculada una vez. Componer es
  un motor de reglas disfrazado y no se le puede explicar a un residente en una línea.
- **Piso duro de cero**: el neto de una unidad nunca es negativo. Una boleta negativa no es un
  descuento, es una nota de crédito — otro artefacto.

**Dato lateral valioso:** este mecanismo resuelve además la "decisión escondida" de §F (unidad exenta
de un concepto). *"El baldío no paga residuos"* es un **descuento del catálogo** con su base y su tope.

## N. De dónde sale la plata (decisión del barrio, declarada, sin default)

| Modo | Qué es | Cuándo |
|---|---|---|
| **(a) Lo pagan los demás** | Partida presupuestada "bonificaciones a otorgar", que **se reparte como cualquier gasto** | El modo honesto para descuentos generales y recurrentes. **Va impreso**: esconderlo dentro de "gastos generales" es un descubrimiento de asamblea muy caro |
| **(b) Lo absorbe el barrio** | Se recauda menos que el gasto; sale del capital de trabajo | Eximiciones puntuales y el desvío entre partida y realidad. **Es lo que de hecho pasa hoy en los barrios que "dan un descuentito" sin presupuestarlo — y es lo que el sistema no puede expresar** |
| **(c) Sale del fondo de reserva** | — | **Modo equivocado** salvo eximición social votada con cargo al fondo. Financiar un beneficio comercial con el fondo lo vacía en silencio |

**Ningún tipo de descuento se puede activar sin declarar su fuente de financiamiento.**

**La plata del alquiler de amenities** se afecta al mantenimiento de ese amenity (bajando la base a
repartir), **por lo COBRADO del mes anterior, nunca por lo facturado del mes en curso**: si baja la
expensa de todos contra un alquiler que todavía se está cobrando y el vecino no paga, el descalce
vuelve como incobrable sin origen. Va impreso con las dos cifras, nunca neteado a ciegas.

## N.bis — DECISIONES DEL USUARIO (2026-07-25)

### 1. Financiamiento del descuento: modo (a), con una regla de dimensionamiento propia

> *"El presupuesto de expensas para cubrir todos los gastos corrientes debe estar hecho en base a la
> expensa **menos el descuento**. Porque el objetivo es 'disfrazar' de penalidad o intereses al
> incumplidor, pero con un descuento al cumplidor."*

Es el modo **(a) partida presupuestada**, pero con un matiz que cambia cómo se dimensiona y que hay
que implementar explícitamente:

- **La partida se calcula como si TODAS las unidades calificaran.** El presupuesto se arma para que la
  expensa **neta** (ya descontada) cubra los gastos corrientes. En números: si el barrio necesita
  $10.000.000 y el descuento es 5%, la expensa bruta a repartir es `10.000.000 / 0,95 = $10.526.316`,
  y la partida de bonificaciones es la diferencia, $526.316.
- **Quien no califica paga el bruto**, y esa diferencia es la penalidad — que es exactamente la
  intención: en vez de cobrarle un recargo al que paga tarde, se le da un descuento al que paga bien.
  Misma economía, mejor recepción, y sin tener que justificar un punitorio.
- **Consecuencia que hay que reportar todos los meses:** si alguien no califica, el barrio recauda
  **más** que sus gastos corrientes. Ese excedente es real y tiene destino (baja la expensa siguiente,
  va al fondo, o queda como excedente declarado) — **no puede quedar como un sobrante sin nombre**.
  Es la contracara del desvío que el modo (a) ya obligaba a mostrar.
- **Va impreso.** El bruto, el descuento y el neto se ven en la boleta: es lo que hace que el
  incentivo funcione. Un descuento que no se ve no cambia la conducta de nadie.

**Implicancia para la UI:** al configurar el descuento, el sistema debe **sugerir el monto de la
partida** = suma de los descuentos si todas las unidades calificaran, y mostrar el bruto resultante.
El administrador confirma; no lo calcula a mano.

### 2. Regla de "vecino cumplidor": familia A

> **Sin saldo pendiente al cierre del período anterior.**

- Se **pierde** el mes siguiente a quedar con saldo.
- Se **recupera automáticamente** apenas se pone al día — sin esperar N meses.
- Lo **calcula el sistema**, con override del administrador que exige motivo y queda registrado.
- Se congela en la liquidación **qué regla, con qué fecha de corte y con qué dato** se evaluó.

*(La familia B — "las últimas N boletas en término" — queda descartada: se pierde con un solo atraso y
se recupera recién N meses después. Es un castigo largo que el usuario no eligió.)*

## O. El comprobante separado, corregido

**Se descarta el check que proponía el propio arquitecto** (`saldo_solo_ordinaria`): era una economía de
diseño que la corrección 3 del usuario rechaza — cada comprobante lleva su vencimiento, sus intereses
y su imputación.

**Ninguna columna de mora migra.** `saldo_anterior`, `interes_mora`, `dias_atraso` y `fecha_corte_mora`
hoy son "un solo juego por unidad-período" **por accidente**: porque un índice único fuerza una sola
fila. Con dos filas, cada comprobante trae naturalmente lo suyo.

**La trampa real: el saldo anterior de una serie.** El saldo de un comprobante de obra es el de **la
misma serie**, no el total de la unidad: si el vecino debe la cuota 2, el comprobante de la cuota 3
arrastra la cuota 2, **no** la expensa ordinaria impaga. Hace falta `serie_comprobante` (nombre,
prefijo de numeración, cuotas totales, cuenta bancaria propia).

**Cuatro cambios estructurales:** cae `uq_liquidacion_periodo_uf` (se reemplaza por índices parciales
que conservan la garantía); los **vencimientos bajan a `liquidacion`** y son NOT NULL, no
nullable-con-fallback (dos lugares de verdad para una fecha impresa es un bug esperando); la
numeración lleva prefijo de serie — **hoy el segundo comprobante fallaría contra el índice único que
ya existe**; y el **estado sigue siendo del período**: se emite entero o no se emite, porque el
prorrateo cuadra sobre todos los comprobantes.

**Y lo que se fija hoy, gratis:** *el pago se imputa a `liquidacion.id`; ninguna tabla del módulo de
cobros puede usar `(periodo_id, unidad_funcional_id)` como clave de deuda.*

## P. Orden de construcción definitivo

| # | Qué | Rompe | Costo |
|---|---|---|---|
| **0010** | `partes_iguales` como base propia | nada | trivial |
| **0011** | Cargos/descuentos: 3 tablas + `clase_item`, **sin constraints** | nada | bajo |
| **0012** | Cargos/descuentos: RLS, FKs compuestas, checks, **reemplazo de `item_liquidacion_origen_chk`**, `validar_emision` v3, totales reportados | **2 tests + 4 extendidos** | medio |
| **0013** | Dominio + servicio + **seed con un descuento y un cargo reales** | — | medio |
| **0014** | **UI**: coeficientes con previsualización, modelo, cuota fija, gastos + catálogo de conceptos y aplicación por unidad. **Esquema cero** | — | UI |
| **0015-16** | La regla guardada (§C) + simulador comparativo (§F.1) | tests de coeficientes | medio |
| **0017-18** | Comprobante separado con serie, vencimientos e imputación propias. **Pegado al módulo de cobros** | ~8-12 tests | alto |
| — | ~~Criterio por concepto~~ | **BORRADO** (§A.0.1) | — |

**Dos avisos que rompen deploys:** (1) el `ALTER TYPE ... ADD VALUE` va **solo en su migración**: en
Postgres un valor de enum nuevo no se puede usar en la misma transacción que lo agrega. (2) `0012`
toca `validar_emision`, que es lo único que protege la plata: **los tests de cuadre van en el mismo
PR**, no después.

## Q. Lo que se BORRA del diseño anterior

**§D completo ("el criterio va en el concepto")** — era la apuesta más fuerte del arquitecto y la
sección más larga del documento. Baja a caso de borde futuro: **sin diseño, sin enum, sin migración,
sin línea en el roadmap.** También se borra su afirmación de que en SA/asociación el criterio por
concepto es *"el modo normal de operar"*: era una afirmación de dominio **sin fuente cargada**, y la
corrección del usuario la desmiente. Queda anotada como vacío de fuente, no como hecho.

**Lo que la corrección simplifica:** un vector por período (una suma, no N x M); `item_liquidacion`
conserva "una línea por gasto"; el simulador compara dos vectores, no una matriz; y la **regla
guardada (§C) sube a ser el único pendiente sobre el reparto**, que es el que elimina el Excel.

## R. Derivaciones abiertas del panel

**A `legal-ph`:** que unos propietarios financien el descuento de otros — ¿qué mayoría e instrumento,
según figura? (en PH puro el art. 2046 inc. c manda proporción a la parte indivisa, y un descuento
selectivo puede leerse como alteración del criterio); ¿el recargo por segundo vencimiento es interés
punitorio?; **multas**: el administrador no las impone solo (arts. 2078/2080/2086), y cobrarlas dentro
de la expensa **puede contaminar el certificado de deuda**; **¿el cargo por amenity integra "expensa"
a los efectos del certificado (art. 2048), o es un crédito común con otra vía?**

**A `contador`:** **clasificación fiscal del alquiler de amenities — lo más urgente**: probablemente
**alcanzado por IIBB aunque la expensa no lo esté**, o sea, un ingreso que **puede volver contribuyente
a un barrio que no lo era**; el **depósito de garantía es un pasivo, no un ingreso**; el descuento,
¿menor ingreso o gasto?; la multa cobrada.
