# 10 — El informe mensual, el desfasaje y la publicación de la mora

> **Fuente:** material real de la administración del barrio piloto (**Las Corzuelas**, S.A.) — el
> "Estado de cuentas" mensual que viaja junto a la boleta analizada en el doc 09, más el listado de
> mora del mismo envío. Los originales **no están en el repositorio**: viven en `_referencias/`, fuera
> del control de versiones, porque traen datos personales. Acá queda **la estructura y las decisiones**,
> nunca el dato.
>
> **Fecha del análisis:** 2026-07-27. Complementa al doc 09 (la boleta individual) mirando el otro
> documento del mismo envío: el que le explica al vecino en qué se gastó la plata de todos.

---

## §A. La regla de privacidad de este documento (leer antes de agregarle nada)

El material fuente incluye un listado de **~100 propietarios morosos con nombre, manzana/lote e
importe adeudado**, y renglones de gasto donde el proveedor es un **empleado nombrado con nombre y
apellido**. Es exactamente el tipo de dato que el proyecto se comprometió a no filtrar (CLAUDE.md §1.3).

**Qué NO puede entrar nunca a `docs/`:**

- un nombre de persona (propietario, residente, empleado, proveedor persona humana);
- una identificación de unidad individual (manzana/lote, número de unidad);
- un importe atribuible a una unidad o a una persona.

**Qué sí puede entrar:** cifras **agregadas del barrio** (total de gastos del período, total de mora,
cantidad de unidades en mora, participación de un rubro sobre el total). Son datos de gestión, no
personales — pero se citan **siempre** diciendo que salen del material del piloto y de qué período,
porque una cifra de un barrio y un mes concretos no es un parámetro del producto.

> **Nota deliberada sobre este documento:** los **importes agregados del material no se transcriben
> acá**. Los hallazgos de abajo son estructurales (qué cuadro falta, qué no cierra contra qué) y se
> sostienen sin las magnitudes. Las magnitudes viven en `_referencias/` y quien las necesite las mira
> ahí. Copiarlas al repo hubiera sido meter cifras de un barrio real en un documento de producto para
> no ganar nada.

---

## §B. Qué es el informe mensual hoy

El documento se llama **"Estado de cuentas"** y es un **híbrido**: en la misma hoja conviven cuatro
cosas que responden preguntas distintas y se miden con reglas distintas.

| Lo que hay adentro | Qué pregunta responde | Criterio |
|---|---|---|
| Gastos del período por rubro | ¿En qué se gastó? | **Devengado** |
| Deuda con proveedores | ¿Cuánto se debe todavía? | Saldo, no flujo |
| Movimientos de caja | ¿Cuánta plata entró y salió por caja? | **Percibido** |
| Movimientos y saldo de banco | ¿Cuánto hay en la cuenta? | **Percibido** |

Mezclar devengado y percibido en un mismo documento no es un error en sí: el vecino quiere las dos
respuestas. **El problema es que están mezclados sin puente**: nada en la hoja explica cómo se pasa de
una a la otra, así que ninguna de las dos se puede verificar.

### B.1 Los hallazgos verificados

Nueve, todos confirmados sobre el material. Ordenados por lo que le cuestan al lector.

| # | Hallazgo | Por qué importa |
|---|---|---|
| **1** | **Nunca se calcula el resultado del período.** Hay ingresos y hay gastos, pero el documento no dice en ningún renglón si el mes cerró con superávit o con déficit | Es *la* pregunta del informe. Que el lector tenga que restar dos columnas a mano es la diferencia entre un informe y una planilla |
| **2** | **El mismo cuadro aparece dos veces**, idéntico, en dos partes del documento | Además del ruido: si algún día uno se corrige y el otro no, el informe se contradice a sí mismo y nadie sabe cuál es el bueno |
| **3** | **El esquema de referencias entre cuadros está roto**: hay letras que se definen (`(A)`, `(B)`, …) y **nunca se usan** en ningún otro cuadro | Las referencias existen justamente para encadenar los cuadros. Definidas y sin usar, el lector busca un vínculo que no está — y concluye, con razón, que el documento no fue revisado entero |
| **4** | **No hay puente entre lo devengado y lo cobrado.** El informe dice cuánto se gastó y cuánto entró, pero no cuánto de lo facturado del período se cobró | Es el único número que mide la salud del barrio. Sin él, un mes con superávit de caja puede ser en realidad un mes con morosidad récord y cobranza vieja |
| **5** | **Brecha grande entre los débitos bancarios y los pagos a proveedores, que ningún cuadro explica** | Salió plata de la cuenta que el informe no atribuye a un proveedor. Puede tener explicación completamente legítima (transferencias entre cuentas propias, impuestos, sueldos por otra vía), pero **el informe no la da** — y una diferencia sin explicar en un documento de rendición es la pregunta de asamblea más cara que existe |
| **6** | **El fondo de reserva no aparece por ningún lado** | Si el barrio lo recauda, tiene que verse: cuánto entró, cuánto se usó y cuánto quedó. Si no lo recauda, también hay que decirlo. Su ausencia deja al lector sin saber cuál de las dos cosas pasa |
| **7** | **No hay previsión por incobrabilidad** | El total a recaudar se presenta como si fuera a cobrarse entero. Con la mora que el mismo envío informa, no se va a cobrar entero, y el barrio planifica sobre un número que ya sabe que es optimista |
| **8** | **No hay comparativo: ni contra presupuesto ni contra el mes anterior** | Un número solo no se puede juzgar. "Seguridad: $X" no dice nada; "Seguridad: $X, 12% arriba del mes pasado y 8% arriba de lo presupuestado" es información |
| **9** | **El desfasaje de dos meses respecto de la boleta con la que viaja no está declarado en el documento** | El vecino recibe en el mismo sobre una boleta de un período y un informe de otro, sin una línea que lo aclare. El que no se da cuenta cree que está leyendo la explicación de lo que le están cobrando — y no lo es |

> El hallazgo **9** es el más barato de arreglar (una línea de texto) y el que más confusión evita.
> Es el primer candidato a corregir en el documento actual, incluso antes de que exista el módulo.

### B.2 Qué le pide el diseño ya escrito

El doc [`01-alcance-modulos.md` §4.3](01-alcance-modulos.md) ya define el **reporte mensual por
barrio** del MVP: gastos por rubro, total a recaudar vs. recaudado y morosidad, estado del fondo de
reserva, ingresos ajenos separados, listado de UF con su total.

**Ese alcance cubre los hallazgos 1, 4, 6 y 7 sin agregar nada nuevo.** Lo que este análisis suma son
los hallazgos **2, 3, 5, 8 y 9**, que no estaban previstos:

- el **puente banco ↔ proveedores** (5) es un requisito nuevo y depende de la conciliación;
- el **comparativo contra presupuesto y contra el mes anterior** (8) figura hoy como `[MADURA]` en el
  doc 01 y este material sugiere que es lo primero que se pide, no lo último;
- **2, 3 y 9** son defectos de composición del documento actual: se resuelven **por diseño**, no
  reproduciéndolos.

---

## §C. El desfasaje de dos meses

El informe que acompaña a la boleta corresponde a un período **dos meses anterior**. No es desprolijidad
ni capricho de la administración: es la suma de **tres esperas encadenadas más un criterio**.

### C.1 De dónde salen los dos meses

| # | Espera | Por qué bloquea |
|---|---|---|
| **1** | **El resumen bancario** | El informe declara saldo y movimientos de banco. Hasta que el banco no cierra el mes, ese cuadro no se puede escribir |
| **2** | **La imputación manual de las acreditaciones** | Cientos de acreditaciones por mes hay que atribuirlas una por una a la unidad que pagó. Es trabajo humano y **es el cuello de botella real**, no el banco |
| **3** | **La llegada de los comprobantes de proveedores** | El gasto se devenga cuando aparece la factura. Un proveedor que factura tarde corre todo el cierre |
| **4** | **El criterio de completitud** (no es una espera, es una decisión) | **Nadie quiere publicar un informe que después haya que corregir.** Un informe rectificado le cuesta a la administración más credibilidad de lo que le gana en velocidad. Es una decisión defendible y hay que respetarla, no discutirla |

Las tres esperas son **secuenciales en la práctica**: no se imputan pagos sin el extracto, y no se
cierra el período sin las facturas. Dos meses es lo que da esa cadena hecha a mano.

### C.2 La meta defendible: un mes, no cero

> **La meta es publicar el informe del mes anterior, no el del mes en curso.**

Cuatro cosas la habilitan, y las cuatro atacan una espera concreta:

| Qué se construye | Qué espera ataca | Efecto |
|---|---|---|
| **Conciliación automática de ingresos** | La espera 2, que es la más grande | Convierte "imputar cientos de acreditaciones" en "revisar las excepciones". Ya está previsto: el motor se reusa del sistema de gas ([`02-reuso-conciliacion.md`](02-reuso-conciliacion.md)) |
| **Devengar por orden de pago, no por factura recibida** | La espera 3 | El gasto entra cuando el barrio **decide pagarlo**, que es un hecho propio y con fecha cierta, en vez de cuando el proveedor manda el papel, que es un hecho ajeno y sin fecha |
| **Cierre de período con checklist bloqueante** | El criterio 4 | El miedo a rectificar sale de no saber qué falta. Un checklist que enumera lo pendiente y **bloquea** el cierre convierte "esperemos por las dudas" en "faltan estas tres cosas" |
| **Stock de mora calculado** | El hallazgo 4 y el 7 | Que el sistema sepa cuánto se debe al corte, en vez de reconstruirlo a mano cada vez |

**Por qué un mes y no menos.** Aun con todo lo anterior, sigue haciendo falta el extracto bancario
cerrado del mes para el cuadro de banco, y sigue habiendo un momento de revisión humana antes de
publicar. Prometer menos de un mes es prometer que se elimina la revisión, y ese es el paso que el
barrio no quiere dar.

### C.3 "Informe en tiempo real" no es una promesa realista — y confundirlo tiene costo

Es la promesa que todo software de administración hace y que ninguno cumple, porque el informe mensual
**es un documento cerrado**: se publica una vez, se distribuye, y a partir de ahí es una afirmación de
la administración ante los propietarios. Un documento que cambia solo no sirve para eso.

**Lo que sí puede ser en tiempo real es otra cosa, y es un artefacto distinto:**

| | **Informe mensual** | **Tablero vivo** |
|---|---|---|
| **Para quién** | Todos los propietarios | Administrador y consejo/directorio |
| **Cuándo** | Una vez por mes, en fecha | Siempre |
| **Qué es** | Una **rendición**: cerrada, versionada, distribuida | Un **instrumento de gestión**: la foto de ahora |
| **Puede cambiar** | **No.** Emitido no se edita — mismo criterio que la liquidación (doc 01 §4.2) | **Sí, todo el tiempo.** Esa es la gracia |
| **Completitud** | Exigida: se publica cuando está todo | **No exigida**: muestra lo que hay, con lo que falta a la vista |
| **Naturaleza de sus cifras** | Definitivas | **Provisorias, y rotuladas como tales** |

> **Confundirlos es lo que produce el estado actual: el informe llega tarde y el tablero no existe.**
> Cuando el único artefacto es el informe cerrado, el administrador que quiere saber cómo viene el mes
> no tiene dónde mirar — y entonces presiona para que el informe salga antes, que es justo lo que el
> criterio de completitud impide. Separarlos destraba las dos cosas: el informe puede seguir siendo
> lento y riguroso porque hay otro lugar donde mirar rápido.

**Consecuencia de producto:** el tablero vivo es un módulo propio, con sus propias cifras rotuladas
como provisorias, y **no** una pantalla que muestra el informe a medio hacer. Si una cifra del tablero
se puede confundir con una del informe, el tablero es un pasivo.

---

## §D. Qué se publica del gasto y qué no

El informe explica en qué se gastó la plata de todos. Ese detalle roza dos cosas a la vez: el derecho
del propietario a saber, y datos de terceros que no eligieron aparecer en un documento que se
distribuye a cientos de personas.

### D.1 La regla de corte

> **Al vecino le llega la estructura y el total. El nombre propio solo cuando el proveedor es
> institucional.**

"Estructura" es el rubro y su composición; "total", el importe agrupado. El nombre de la empresa de
seguridad se publica; el nombre del empleado al que se le pagó una changa, no — se publica el concepto.

### D.2 Dos niveles de agrupación, no uno

| Nivel | Qué muestra | Para quién |
|---|---|---|
| **Concepto agrupado** | El rubro con su total (*"Seguridad"*, *"Mantenimiento de espacios verdes"*) | **El vecino** — es el informe distribuido |
| **Gasto individual** | Cada gasto con proveedor, comprobante e importe | **El directorio/consejo, y quien lo pida** |

**Por qué dos y no uno.** Con un solo nivel se elige entre publicar de más (y filtrar datos de
terceros a cientos de personas) o publicar de menos (y no poder responder *"¿qué hay adentro de
'Mantenimiento'?"*, que es la pregunta que llega siempre). Con dos niveles, el detalle **existe y está
disponible**, pero se entrega a pedido y a quien corresponde — no se distribuye masivamente.

El segundo nivel es **el mismo dato**, no otro documento: se genera del mismo período y tiene que
cuadrar contra el primero al centavo. Si son dos armados distintos, van a divergir.

### D.3 Dos reglas duras de desagregación

Sin ellas, "agrupar" se convierte en "esconder".

1. **Los honorarios de administración llevan renglón propio, siempre.** Nunca dentro de "gastos
   generales" ni de "administración y otros". Es el gasto sobre el que el barrio contrata y el que la
   asamblea vota; esconderlo en una bolsa es el reproche más frecuente que recibe un administrador, y
   es evitable con una línea.
2. **Todo renglón que supere el 5 % del gasto del período se desagrega.** Un rubro que se lleva más de
   la vigésima parte del dinero de todos no puede ser una línea sola. El umbral es **configurable por
   barrio** pero con default puesto: si es opcional y arranca apagado, nadie lo enciende.

> Las dos reglas dicen lo mismo desde ángulos distintos: **el nivel de agrupación no lo elige quien
> rinde cuentas caso por caso.** Si el administrador decide mes a mes qué agrupa, la agrupación deja
> de ser un criterio de legibilidad y pasa a ser una decisión sobre qué se ve.

### D.4 El caso mixto que hay que tener escrito

> **Una razón social no es un dato personal. Pero cuando el proveedor es persona humana, la razón
> social ES el nombre de una persona.**

Es literalmente el mismo campo (`gasto_periodo.proveedor_nombre`) conteniendo dos cosas jurídicamente
distintas. Y no es hipotético: el material del piloto tiene **renglones de gasto donde el proveedor es
un empleado, nombrado**.

**Regla:** cuando el proveedor es persona humana, **en el informe distribuido se publica el concepto,
no el nombre** (*"Mantenimiento de piletas"*, no el nombre de quien lo hizo). El nombre sigue en el
sistema y en el detalle del segundo nivel, que no se distribuye masivamente.

**Consecuencia para el modelo de datos:** el sistema tiene que **saber** si el proveedor es persona
humana o jurídica. Hoy no lo sabe — `proveedor_nombre` es texto libre. Sin ese dato, la regla no se
puede aplicar automáticamente y depende de que el administrador se acuerde cada mes. Ver §F.

---

## §E. La política de publicación de la mora

### E.1 La decisión, y quién la tomó

**Decisión de producto, tomada por el usuario** (director de la S.A. del barrio piloto), 2026-07-27:

> En su barrio, el listado de mora se publica **nominado**: con nombre y manzana/lote. Es una
> convención del barrio, sostenida en el tiempo, cuyo objetivo declarado es **incentivar el pago**.

**La decisión se respeta.** Es el dueño del problema, conoce a su barrio y hay un órgano que lo
resolvió. **Y se vuelve configurable**, porque el producto se vende a barrios con la política
exactamente opuesta — y en varios de ellos publicar el listado nominado sería el motivo por el que no
compran.

> **Que sea configurable no es una posición tibia: es el reconocimiento de que esto es una decisión
> del barrio, no una capacidad del software.** Cablearlo en cualquiera de las dos direcciones convierte
> una decisión de gobierno del barrio en un default de un proveedor de software.

### E.2 El modelo

| Pieza | Qué es | Por qué |
|---|---|---|
| **Modo de publicación** | `nominado` (nombre + manzana/lote + importe) o `agregado` (cantidad de unidades en mora, monto total, tramos de antigüedad) | Son los dos únicos modos que se piden. Un tercero "solo manzana/lote" es nominado con un paso extra: en un barrio, la unidad identifica a la persona |
| **Destinatarios** | A quién llega el listado: solo directorio/consejo · propietarios · todo el barrio (incluye inquilinos) | Es una decisión distinta del modo, y se confunde con él. "Nominado para el consejo" y "nominado para todos" son políticas muy diferentes |
| **Piso de importe** | Debajo de X no se publica | Un saldo residual de centavos —un redondeo, una diferencia de intereses— convierte a un vecino al día en un moroso publicado. Es el error que más caro sale y el más fácil de evitar |
| **Exclusión por plan de pagos al día** | Quien tiene convenio y lo está cumpliendo **no aparece** | Publicarlo destruye el incentivo que el propio convenio creó: el que se acercó a regularizar termina expuesto igual que el que no hizo nada |
| **Registro de publicación** | Quién publicó, qué modo, con qué **fecha de corte**, a qué destinatarios y cuándo | Sin esto no se puede responder *"¿por qué salí en la lista de marzo si había pagado?"*. Con la fecha de corte registrada, la respuesta es un dato: se pagó después del corte |

**La fecha de corte es la pieza que evita el conflicto más común.** Un listado sin corte declarado es
indefendible: siempre hay alguien que pagó entre que se armó el listado y que se distribuyó.

### E.3 Documento y distribución **separados** de la boleta individual

Se sostiene igual que en el material actual, y por una razón que no depende de la política elegida:

> **La boleta la recibe también el inquilino.**

El inquilino paga las expensas ordinarias pero **no es el deudor** — la deuda está anclada a la unidad
y a su obligado (doc 01 §4.4, art. 2049). Adjuntar el listado de mora a la boleta significa entregarle
a un tercero la situación de deuda de los demás propietarios, y en el caso del propio propietario del
inmueble que alquila, entregársela a su inquilino.

**Consecuencia técnica:** el listado de mora es **un documento propio con su propia lista de
distribución**, no un anexo del PDF de la boleta. Esto ya calza con el diseño: el doc 09 §E.10 define
un documento de dos páginas cuyo destinatario es el obligado de esa unidad, y el ADR-0001 separa el
armado del documento de su distribución.

### E.4 Lo que este equipo NO puede dictaminar

> **La normativa de protección de datos personales NO está cargada en `knowledge/`.**

`knowledge/cordoba/` tiene hoy CCyC/PH, Ley 19550, adecuación IGJ/IPJ, régimen de expensas, asambleas,
conjuntos inmobiliarios, IIBB y jurisprudencia de ejecutividad. **No hay nada sobre datos personales.**

Por la regla dura del proyecto (CLAUDE.md §1.2), **ni `legal-ph` ni `contador` ni ningún otro agente
puede dictaminar sobre la legalidad de publicar el listado nominado.** La respuesta correcta hasta que
la fuente se cargue es *"no tengo esa fuente cargada"* — y este documento no la reemplaza.

**Lo que sí se puede afirmar, y es lo que respalda la práctica:** existe una **resolución del órgano
competente del barrio** que estableció la publicación nominada como convención. Eso es un hecho del
barrio, verificable y citable. **No es un dictamen de legalidad**, y el documento no lo presenta como
tal.

**Cómo se comporta el sistema mientras tanto:** implementa las dos modalidades, exige que el barrio
declare cuál eligió y con qué instrumento la respalda, y **no sugiere un default**. Mismo criterio que
ya se aplicó al criterio de reparto (doc 08 §B: *"nunca sugerir un criterio por defecto: el criterio
viene del instrumento"*).

---

## §F. Huecos del modelo de datos que este material dejó al descubierto

Cinco, concretos, sobre el esquema que ya existe. **Ninguno se implementa en esta tanda**: quedan
anotados como pendientes con su nombre de tabla y columna, para que quien los tome no tenga que
redescubrirlos.

| # | Hueco | Dónde | Por qué importa |
|---|---|---|---|
| **F-1** | **Falta el subtipo del ingreso ajeno.** El enum `app.clasificacion_fiscal` tiene `ingreso_ajeno` **plano**: alquiler de amenity, antena, publicidad e invitados caen todos en el mismo valor | `app.clasificacion_fiscal` (`0004`) | El doc 04 §B.2 **ya exige** el desglose (*"alquiler / antenas / publicidad / invitados"*) y hoy **no se puede emitir**. Ya estaba anotado en doc 08 §Z; este material lo confirma desde el otro lado: el informe tiene que mostrarlo |
| **F-2** | **Falta el CUIT del proveedor en el gasto.** `gasto_periodo` guarda `proveedor_nombre` (texto libre) y `comprobante`, y nada más | `gasto_periodo` (`0004`) | Sin identificador, dos escrituras del mismo proveedor son dos proveedores distintos y el acumulado por proveedor no existe. **Y es el dato que resuelve §D.4**: el CUIT dice si el proveedor es persona humana o jurídica, que es lo que decide si el nombre se publica |
| **F-3** | **La clasificación fiscal se escribe solo cuando el ítem viene de un gasto.** El servicio copia `clasificacion_fiscal` al ítem únicamente si hay `gasto_id`, así que **toda línea de cargo queda sin clasificar** | `item_liquidacion.clasificacion_fiscal` (`0008`) | **Es el hueco más caro de los cinco.** El cargo por alquiler de un amenity es *exactamente* el ingreso que podría cambiar el encuadre fiscal del barrio (doc 08 §Z: *"puede volver contribuyente a un barrio que no lo era"*), y es justo la línea que queda en NULL. Ya figuraba en doc 08 §AA; sigue abierto |
| **F-4** | **El catálogo de conceptos no tiene vigencia.** `concepto` tiene `activo` (booleano) pero no desde/hasta | `concepto` (`0004`) | En el informe, **un cero se lee igual si el concepto no tuvo movimiento este mes que si dejó de existir el año pasado**. Son cosas distintas: la primera es información, la segunda es ruido. Y sin vigencia, el comparativo contra el mes anterior (hallazgo 8) no puede distinguir "bajó a cero" de "ya no aplica" |
| **F-5** | **Falta el renglón "partida presupuestada / otorgado / excedente" de las bonificaciones** | — (no existe) | El doc 08 §N.bis lo dejó **decidido y sin lugar donde vivir**: la partida se dimensiona como si todas las unidades calificaran, y quien no califica paga el bruto, así que **el barrio recauda más que sus gastos corrientes**. Ese excedente *"no puede quedar como un sobrante sin nombre"*. El informe mensual es el lugar donde tiene que aparecer, con las tres cifras: lo presupuestado, lo efectivamente otorgado y la diferencia |

> **Patrón que se repite en F-1, F-3 y F-5:** son huecos que el doc 08 ya había detectado desde el lado
> de la **emisión** y que este material vuelve a encontrar desde el lado del **informe**. Cuando un
> hueco aparece dos veces por caminos independientes, deja de ser un pendiente y pasa a ser un
> requisito.

> **F-6 y F-7 viven en §I.9**, no acá: son huecos que aparecieron recién al definir el vocabulario
> gráfico y no se entienden sin él. Continúan esta numeración.

---

## §G. Preguntas abiertas para la administración

Cortas y accionables. Ninguna se puede responder desde el material: todas necesitan a la
administración del piloto.

1. **La brecha entre los débitos bancarios y los pagos a proveedores (hallazgo 5): ¿qué la compone?**
   Es la pregunta que más define el modelo de egresos. Si son transferencias entre cuentas propias, es
   un tipo de movimiento; si son sueldos o impuestos que no pasan por el circuito de proveedores, es
   otro; si son pagos a proveedores que el cuadro no lista, es un bug del informe.
2. **¿El barrio recauda fondo de reserva?** Si sí, ¿en cuenta separada (art. 2046 inc. d)? Su ausencia
   total del informe admite las dos lecturas y hay que cerrar cuál es.
3. **¿Existe presupuesto anual aprobado?** El comparativo contra presupuesto (hallazgo 8) no se puede
   construir sin él. Si no existe, el comparativo del MVP es solo contra el mes anterior.
4. **¿Cuál es el criterio actual para agrupar renglones de gasto en el informe?** Interesa si hay
   criterio escrito o es mes a mes: define si el catálogo de rubros se migra o se diseña de cero.
5. **¿Con qué instrumento y de qué órgano se aprobó publicar la mora nominada?** (§E.4). Tipo de acto,
   órgano y fecha — es lo que el sistema va a registrar como respaldo de la política.
6. **¿Hay piso de importe hoy para entrar al listado de mora, y hay exclusión de quien tiene convenio
   de pago vigente?** (§E.2). Si hoy no los hay, conviene saber si es decisión o es que nadie lo pensó.
7. **¿Qué se hace hoy con el excedente de las bonificaciones?** (F-5). ¿Baja la expensa siguiente, va
   al fondo, queda como excedente declarado? Es una decisión de barrio, no una default del sistema.
8. **¿Cuánto de los dos meses es esperar el extracto y cuánto es imputar los pagos?** (§C.1). Confirma
   o corrige el supuesto de que la espera 2 es el cuello de botella — y con eso, si la conciliación
   automática es realmente lo que destraba el mes.

---

## §H. Derivaciones

### A `legal-ph`

| Consulta | Motivo |
|---|---|
| **Publicación de la mora nominada** | **Bloqueada por falta de fuente** (§E.4): sin normativa de protección de datos personales en `knowledge/`, no puede responder. La derivación queda abierta y **se activa cuando la fuente se cargue** |
| **Contenido mínimo obligatorio de la rendición de cuentas mensual, por figura jurídica** | El informe de una **S.A.** rinde ante un directorio y una asamblea de accionistas con reglas societarias (Ley 19550), no ante una asamblea de propietarios de PH. El material del piloto es de una S.A. y el diseño tiene que cubrir las cuatro figuras |
| **¿El propietario tiene derecho a exigir el detalle individual de gastos (§D.2, segundo nivel), o alcanza con el agrupado?** | Define si el segundo nivel es una cortesía configurable o una obligación que el sistema debe garantizar. Cambia el requisito |

### A `contador`

| Consulta | Motivo |
|---|---|
| **El puente devengado ↔ percibido en la rendición** | Es el hallazgo 4 y el que hace verificable el informe. Cuál es la forma estándar de presentarlo para que un contador lo lea sin rearmarlo |
| **Devengar por orden de pago en vez de por factura recibida** (§C.2) | Es lo que acorta el cierre un mes, y es un **cambio de criterio contable**. Hay que confirmar que es defendible y qué consecuencias tiene sobre la exportación de movimientos que el MVP entrega |
| **Previsión por incobrabilidad** (hallazgo 7) | Cómo se calcula y se presenta en un barrio, y si corresponde presentarla en la rendición a propietarios o solo en la contabilidad |
| **Subtipo del ingreso ajeno** (F-1) | Ya derivado en doc 08 §Z y **sigue abierto**. Este material confirma que además del encuadre de IIBB, el desglose lo necesita el informe |

**Validar con profesional matriculado.** El encuadre de la rendición de cuentas, el criterio de
devengamiento y el tratamiento de la incobrabilidad afectan la contabilidad del barrio y su situación
fiscal.

---

# §I. El vocabulario gráfico de los documentos

> **Autoría:** `ux-designer`, 2026-07-27. **Fase 6C — diseño, no implementación.**
>
> **Revisión del 2026-07-27, con las piezas ya generadas e impresas:** se descartan **G-4 y G-5** y se
> agregan las dos reglas que ese ejercicio dejó — **§I.5.7** (una tira no discrimina si la serie no baja
> cerca del cero) y **§I.5.8** (el pie de una tabla larga se imprime una vez). Las dos salieron de mirar
> el PDF, no de razonar sobre el diseño; están escritas para que la próxima salga antes.
>
> **Por qué existe esta sección.** Con las tres piezas ya generadas a la vista (boleta, informe mensual
> de 05/2026, listado de saldos en versión nominada y agregada), el diagnóstico del usuario fue exacto:
> *"son PDFs con mucho texto, no tienen casi nada gráfico"*. Y es más grave en el informe que en los
> otros dos, porque **es un documento sobre plata que no muestra una sola forma**: once grupos de gasto,
> una rueda de deuda con proveedores y un puente devengado↔percibido, todo resuelto con columnas de
> números alineados a la derecha.
>
> Esta sección define **qué se dibuja, con qué formas, con qué reglas y dónde entra**. No agrega
> contenido al informe: agrega **una segunda lectura** de contenido que ya está.
>
> **Insumos:** doc 09 §E.2.2 (presupuesto vertical), §E.5 (escala tipográfica de impresión y factor de
> reducción en teléfono), §E.7 (impresión y pantalla), §E.8 (accesibilidad) · doc 07 §A (límites del
> motor y sus condiciones), §B (tabla de detalle, filetes de 0,4 pt, sin zebra striping) ·
> ADR-0001 §3.2 (red apagada en el renderizador) · `packages/design-tokens/tokens.ts`
> (`printInk`, `printPatron`, `fontSizePrint`) ·
> doc 06 §b (tokens) · §D y §E.2 de este documento (agrupación y política de publicación de la mora) ·
> las tres piezas generadas en `_referencias/comparacion/png/` (fuera del repo).
>
> **Alcance de edición.** Esta sección **define** el gráfico de la boleta pero **no modifica el doc 09**
> (hay trabajo en paralelo ahí): lo que le corresponde a la boleta queda escrito acá como **pedido de
> cambio**, en §I.6.1, con el impacto sobre su presupuesto vertical ya calculado.

---

## I.1. El criterio de admisión

> **Un gráfico entra solamente si responde una pregunta que hoy obliga al lector a hacer una cuenta
> mental. Si no reemplaza una cuenta, no va.**

No es una preferencia estética ni una regla de austeridad: es la única que se puede aplicar sin
discutir. "Queda más lindo" no se puede refutar; "esta barra no reemplaza ninguna cuenta" sí.

**Esto está escrito porque el próximo que agregue un gráfico va a querer poner una torta bonita.** Va a
tener razón en que la hoja está seca y va a estar equivocado en el remedio. La respuesta no es "no,
porque sí": es hacerle las tres preguntas de abajo.

### I.1.1 El test de admisión — tres preguntas, las tres tienen que dar

| # | Pregunta | Si falla |
|---|---|---|
| **1** | **¿Qué cuenta hace hoy el lector con los ojos, que el gráfico le ahorra?** Enunciada como cuenta: "sumar cuatro filas", "dividir dos números de siete cifras", "abrir cuatro PDFs viejos y comparar" | Si la respuesta es *"ninguna, pero se entiende más rápido"* → **no va**. "Más rápido" sin cuenta atrás es decoración |
| **2** | **¿El número que el gráfico dibuja ya está impreso en la misma fila o al lado?** | Si **no** está → **no va tampoco**, pero por el motivo opuesto: un gráfico nunca puede ser la única vía a una cifra (§I.5.4). Primero se imprime el número; después se ve si además se dibuja |
| **3** | **¿Entra sin agregar una página y sin mover nada de lugar?** | Si hay que correr una zona o sumar una hoja → **no va** (§I.6). La paginación ya funciona y una hoja más son 500 hojas más por mes |

**Las tres, no dos de tres.** La 1 es la que decide si el gráfico sirve; la 2, si es honesto; la 3, si
es gratis. Un gráfico que pasa la 1 y la 2 pero no la 3 **no se recorta para que entre**: se anota como
pendiente y se espera a que haya lugar.

### I.1.2 Corolario: la mayoría de las veces la respuesta correcta no es un gráfico

Tres respuestas más baratas, que en estos documentos ganaron varias veces:

| En vez de un gráfico | Cuándo |
|---|---|
| **Una frase** | Cuando la cuenta da un solo número. *"Las 20 unidades de mayor saldo concentran el 59,71 % del total"* ya es la respuesta — dibujarla no agrega nada (§I.4, descarte 2) |
| **Una columna más en la tabla** | Cuando la cuenta es una división. La columna `% DEL TOTAL` del informe ya hace ese trabajo y por eso el gráfico de composición tiene que aportar **otra** cosa (el orden de magnitud), no la misma |
| **Un renglón de control que cierra en cero** | Cuando la cuenta es una conciliación. El *"Sin diferencias — $ 0,00"* de §C es más fuerte que cualquier waterfall: dice que cierra, no lo insinúa (§I.4, descarte 3) |

---

## I.2. El repertorio: **dos formas**, y ninguna más

> **Un documento con cinco lenguajes gráficos distintos es peor que uno sin ninguno**, porque cada
> lenguaje nuevo obliga al lector a aprender a leerlo antes de poder leer el dato.

Dos formas, con **el mismo vocabulario de dos estados**: **tinta llena = el valor del que habla la
fila** · **contorno de 0,4 pt = la referencia contra la que se lo compara**. Quien aprendió a leer una,
ya sabe leer la otra.

| | **Forma 1 · Barra de participación** | **Forma 2 · Tira de períodos** |
|---|---|---|
| **Responde** | *"¿qué parte del total es esta fila?"* | *"¿esto viene subiendo o bajando?"* |
| **Vive** | **Dentro de una fila de tabla que ya existe**, en una columna propia | Al lado del número grande del que es la historia |
| **Dibuja** | Una pista vacía (el total) + un relleno (la fila) | Una columna por período + una línea de base cero |
| **Cuesta** | **0 mm verticales** — usa el alto de fila que ya se paga | 10 mm de alto + 4 mm de rótulos, pagados con blanco horizontal que ya estaba |
| **No sirve si** | El cuadro tiene un renglón negativo o menos de tres filas con valor (§I.7, casos 4 y 6) | La serie no baja cerca del cero: `mín ÷ máx` > ~0,7 (**§I.5.7**) |
| **Reemplaza** | Once divisiones y un ordenamiento mental | Abrir cuatro PDFs viejos |
| **Analogía** | Es la columna `% DEL TOTAL` hecha visible | Es el `▲ +13,35 % contra el corte anterior` con memoria |

**Por qué estas dos y no otras.** Son las dos únicas preguntas que estos documentos dejan sin responder
de manera sistemática: **la proporción** (que exige dividir) y **la evolución** (que exige recordar).
Todo lo demás que se les puede preguntar, o ya está impreso como número, o es una pregunta que el
documento no tiene por qué contestar.

**Y hay una tercera razón, técnica y decisiva:** las dos formas son **rectángulos**. Ver §I.5.1 — es lo
que las hace dibujables sin riesgo en este motor y portables sin cambios a la vista web y a mobile.

> **La regla del repertorio, para el futuro:** una forma nueva no se agrega porque haya un dato nuevo;
> se agrega solo si hay una **pregunta** nueva que ninguna de las dos responde. Y si la forma nueva no
> es un rectángulo, se revisa dos veces (§I.5.1).

---

## I.3. Qué gráfico va en qué documento

Seis instancias vivas, de dos formas. Ordenadas por cuánto ahorran.

| # | Documento | Dónde | Forma | Pregunta que responde | Cuenta mental que reemplaza | Estado |
|---|---|---|---|---|---|---|
| **G-1** | **Informe** | §A, cuadro **Gastos del período**, una barra por grupo | Barra | *"¿en qué se va la plata?"* | Ordenar once porcentajes de memoria para saber cuáles importan | **Entra** |
| **G-2** | **Informe** | §A, al lado del **resultado del período** (el número grande de p. 1) | Tira | *"¿este superávit es lo normal o es raro?"* | Abrir los informes de los meses anteriores | **Entra** |
| **G-3** | **Informe** | §B, al lado de **Deuda con proveedores al cierre** | Tira | *"¿la deuda con proveedores se está estabilizando o se está yendo?"* | Comparar el cierre contra el cierre informado el mes anterior, mes por mes | **Entra** |
| ~~**G-4**~~ | ~~Informe, tarjeta **Cobranza del período**~~ | — | Tira | *"¿94 % es bueno?"* | — | **DESCARTADO** con la pieza impresa delante — §I.4, descarte 9 |
| ~~**G-5**~~ | ~~Mora, debajo del delta contra el corte anterior~~ | — | Tira | *"¿la mora crece hace un mes o hace un año?"* | — | **DESCARTADO** por lo mismo — §I.4, descarte 9 |
| **G-6** | **Mora** (agregada y nominada, solo p. 1) | Cuadro **Antigüedad de la deuda**, una barra por tramo | Barra | *"¿esta mora es reciente o es crónica?"* | Sumar tramos para separar lo recuperable de lo que ya no vuelve | **Entra, bloqueado por dato** (F-6) |
| **G-7** | **Mora** (agregada y nominada, solo p. 1) | Cuadro **Estado de la gestión**, una barra por instancia | Barra | *"¿cuánto de la mora ya salió de mis manos?"* | Dividir el saldo derivado a jurídico por el total | **Ya existe** en la pieza generada — se normaliza a la forma 1 |
| **G-8** | **Boleta** | Zona 3 «Qué cubre», una barra por concepto | Barra | *"¿qué parte de lo que pago es seguridad?"* | Dividir el importe de cada concepto por el total de la cuota ordinaria | **Entra** — pedido de cambio al doc 09 (§I.6.1) |

> **G-4 y G-5 se numeran igual aunque no existan.** Los números no se reciclan: quien lea el descarte 9
> y quiera reabrir la discusión tiene que poder encontrar de qué instancia se hablaba. Y las dos
> pasaron el test de admisión de §I.1 —la pregunta era buena y el número estaba impreso al lado— así
> que su descarte **no** se deduce de las tres preguntas: hizo falta ver el dibujo hecho. Eso es lo que
> §I.5.7 viene a evitar la próxima vez.

**Cuatro cosas que se leen mejor en esa tabla que en prosa:**

1. **Ninguna instancia es un gráfico suelto.** Las seis están pegadas a un número que ya está impreso.
2. **Las barras siempre viven en un cuadro que ya existe.** Nunca se crea un cuadro para poner una barra.
3. **Las tiras siempre viven al lado del número del que son la historia**, no en una "sección de
   gráficos" al final. Un informe con una sección de gráficos al final es un informe con una sección
   que nadie lee.
4. **G-7 ya está dibujado en la pieza generada.** No es un agregado: es la prueba de que la forma 1
   apareció sola cuando hizo falta, antes de que existiera esta sección. Lo que aporta acá es la
   normalización — hoy es una barra sin pista, es decir sin la referencia que le da sentido.

### I.3.1 La instancia que hay que mirar dos veces: la boleta (G-8)

La boleta es el documento **más leído del producto** y el que menos margen tiene. Por eso G-8 es la
única instancia del repertorio que se define con una condición extra:

> **En la boleta entra una sola forma, la barra, y en una sola zona, la 3. La zona 1 y la zona 2 no
> llevan nada dibujado, nunca.**

La zona 1 es *cuánto · cuándo · dónde* a 32 pt (doc 09 §E.2.1): cualquier forma ahí compite con el
único elemento que tiene que ganar la primera pantalla del teléfono. La zona 2 son cuatro renglones —
en la muestra generada, tres— y **cuatro números se comparan leyéndolos**. Una torta de la composición
del total, que es el candidato obvio, se descarta con fundamento en §I.4 (descarte 1).

---

## I.4. Lo que se descartó, y por qué

**Esta lista es la parte más útil de la sección.** Los descartes son lo que evita que en seis meses el
informe tenga siete gráficos, y cada uno de estos va a volver a proponerse.

| # | Candidato | Por qué se descarta |
|---|---|---|
| **1** | **Torta de la composición del gasto** (*"seguridad se lleva el 58 %"*) — **candidato del usuario** | **La pregunta es correcta; la forma no.** Tres motivos, cualquiera alcanza: (a) el cuadro tiene **once grupos** y una torta deja de leerse pasados seis — los siete de abajo se vuelven astillas indistinguibles; (b) **el porcentaje ya está impreso** en la columna `% DEL TOTAL`, así que la torta no agrega el dato, solo el ranking; (c) una torta cuesta **35–40 mm de alto propio**, y no hay 40 mm libres en la página 1. → **La pregunta se responde con G-1**, que da el mismo ranking a 0 mm y sin sacrificar filas |
| **2** | **Curva de concentración / Pareto de la mora** (*"20 unidades explican el 60 %"*) — **candidato del usuario** | **La respuesta ya es una frase impresa:** *"Las 20 unidades de mayor saldo concentran el 59,71 % del total"*. Dibujarla no reemplaza ninguna cuenta: la cuenta ya está hecha. Y en la **versión agregada** es peor que inútil — una curva de 101 puntos es **un punto por unidad**, es decir el dato individual que esa versión existe para no publicar (§I.8). **Si hace falta más resolución, la respuesta es una segunda frase** (*"las 10 primeras, el X %"*): cuesta un renglón, no viola nada y se puede leer por teléfono |
| **3** | **Waterfall del puente devengado ↔ percibido** (§C) | Es el cuadro más difícil del informe y la tentación es fuerte. Pero **§C ya termina en un renglón de control que cierra en `$ 0,00`**, y ese renglón dice algo que un waterfall no puede decir: *que cierra*. Un waterfall lo haría más lindo, no más verificable. Además sería una **tercera forma** (barras flotantes con signo), que en una sola tinta necesita distinguir "sube" de "baja" con trama — prohibido por §I.5.3 |
| **4** | **Gauge / semicírculo para la cobranza del período (94,05 %)** | Un solo valor contra un límite. Es el gráfico decorativo por excelencia: ocupa 25 mm para mostrar un número que ya está en 18 pt. **La pregunta real no es *"¿cuánto es?"* sino *"¿es bueno?"*, y eso lo contesta la historia, no el arco.** El reemplazo que se propuso —una tira dentro de la tarjeta— **también se descartó**, y por un motivo que este descarte no anticipaba: ver el 9 |
| **5** | **Plano del barrio con las manzanas sombreadas según mora** | **Se descarta por privacidad, no por diseño, y es un descarte duro.** Un mapa **ubica geográficamente al deudor**: en un barrio donde todos saben quién vive en cada lote, sombrear una manzana con pocas unidades es publicar un nombre sin escribirlo, y es exactamente el resultado que la versión agregada existe para impedir (§I.8). **No se construye ni siquiera para uso interno del directorio**, porque el documento del directorio se reenvía |
| **6** | **Barras en el cuadro de INGRESOS del informe** | Se descarta por un motivo aritmético que conviene tener escrito: en ese cuadro la cuota ordinaria es **102,93 %** del total y la bonificación es **−7,72 %**. Los renglones **no son partes de un todo**: uno excede el 100 % y otro es negativo. Una barra de participación ahí sería una figura falsa. → Regla general en §I.7.4 |
| **7** | **Barras al lado de cada unidad en el detalle nominado** (páginas 2 a 6) | Convertiría el listado en un **ranking visual de vecinos**. El listado nominado ya es una decisión delicada del barrio (§E.1) y su justificación declarada es *incentivar el pago*, no exhibir. Una barra por unidad cambia la naturaleza del documento sin que nadie lo haya decidido. **Los gráficos del listado de mora viven solo en la página 1**, que es la de agregados |
| **8** | **Sombreado de fondo / zebra striping para "ayudar a leer" las tablas** | Ya prohibido por doc 07 §B, y se repite acá porque va a volver disfrazado de gráfico. Un fondo gris claro no sobrevive a la fotocopia y compite con la única tinta que estas formas usan |
| **9** | **G-4 (tira de cobranza) y G-5 (tira del total de mora)** — *descartadas después de dibujarlas*, 2026-07-27 | **Las dos pasaron el test de admisión y las dos salieron mal igual**, y esa es la parte que hay que leer. Con los datos reales del piloto, G-4 va de **101,92 % a 94,05 %** y G-5 de **83 a 102 millones**; con el eje obligado a arrancar en cero (§I.5.6), la columna más baja mide el 92 % y el 81 % de la más alta. **Columnas del mismo alto no dicen "estable": no dicen nada**, y el lector no sabe si lo plano es su barrio o es el dibujo. Recortar el eje las arreglaría y **está prohibido justamente porque las arreglaría mintiendo**. → La condición general que las dos violan, y cómo se verifica **antes** de dibujar, en **§I.5.7** |

---

## I.5. Las reglas duras

### I.5.1 Se dibuja **dentro** del documento, y son rectángulos

**Nada se pide por red.** Ni una imagen de gráfico generada por un servicio, ni una fuente de íconos,
ni un PNG embebido en base64 (un PNG se pixela al imprimir y mete un raster en un documento que es
vectorial). El dibujo es parte del documento, como el filete de 0,4 pt.

**Esto no queda librado a la disciplina de quien escriba la plantilla:** el adapter de renderizado ya
**intercepta y aborta todo request que no sea `data:` o `about:blank`**, y lleva la cuenta de lo que
abortó para que un test la afirme (ADR-0001 §3.2). Un gráfico que necesite red **no se ve mal: no se
ve**. La regla está cerrada por infraestructura, no por criterio.

**Y no hace falta SVG:** las dos formas son rectángulos, y un rectángulo es una caja con borde o con
fondo. Nada de `<path>`, nada de `viewBox`, nada de texto dentro de un SVG (que es donde el manejo de
fuentes se vuelve otro problema, y las fuentes de este producto están vendorizadas y pinneadas por
checksum — doc 07 §A).

> **Regla:** las formas se construyen con rectángulos. El SVG queda disponible como salida de
> emergencia, pero **necesitar un `<path>` es la señal de que la forma se salió del repertorio** —
> antes de escribirlo, se releen §I.1 y §I.2.

**Beneficio lateral que vale la decisión sola:** un rectángulo con medidas en pt es el **mismo objeto**
en el PDF, en la futura vista web del residente y en mobile. **Las dos formas viajan a los tres destinos
con los mismos tokens y sin reimplementarse** — que es exactamente lo que los design-tokens tienen que
comprar, y lo que un SVG hecho a mano por documento no compra.

### I.5.2 Sin color, y sin una tinta que no exista ya

**Dos tintas, y son las dos que el documento ya usa** — no se agrega ninguna:

| Elemento | Tinta | Por qué esa |
|---|---|---|
| **Relleno** — *el dato* | `printInk.textPrimary` (~18:1 sobre blanco) | Es lo único que carga significado, así que va en la tinta más fuerte que hay |
| **Pista, contorno y línea de base** — *la referencia* | `printInk.hairline`, **el mismo filete de 0,4 pt que el resto del documento** | Consistencia con cada línea de cada tabla. Y es exactamente por ser tenue que **no puede llevar información** (§I.5.4): la pista dice dónde está el 100 %, y el 100 % está impreso |

Y todo lo demás, prohibido:

| | |
|---|---|
| **Grises intermedios en una forma** | **Prohibidos.** `textMuted` ya está prohibido en `print` (doc 09 §E.5.3) y una "pista gris clarita" es justamente el idiom que hay que resistir. *(No alcanza a `printPatron.pendienteFondo`: esa píldora es un **estado de la celda**, no una forma con valor, y su fondo clarísimo ya está resuelto con evidencia)* |
| **Color** | **Ninguno.** El acento del barrio termina en la franja superior de 4 mm (doc 09 §E.5.3) y no entra a un gráfico. Un barrio no elige el color de sus barras |
| **Más oscuro = más grande** | **Prohibido.** Duplicaría en tinta lo que la longitud ya dice, y quemaría el único canal libre |

**Consecuencia directa: el contraste queda verificado por construcción.** Todo lo que **significa** algo
va a ~18:1 sobre blanco, muy por encima del 3:1 que WCAG pide para objetos gráficos. Y **no hay paleta
que validar porque no hay paleta**: cero series categóricas, cero hues, cero pares que separar bajo
daltonismo, cero decisiones de color que puedan salir mal. El modo de fallo más común de los gráficos
—la paleta— acá no existe.

> **El caso que la literatura de visualización reserva como excepción —impresión, escala de grises,
> `forced-colors`— es nuestro caso normal.** La salida estándar recomendada para ese caso es la textura,
> y acá está prohibida por evidencia propia (§I.5.3). Lo que la reemplaza es **presencia contra ausencia
> de tinta**, que es la única codificación que ninguna impresora, fotocopiadora ni compresor puede
> degradar a medias.

### I.5.3 Impreso en blanco y negro — y **sin tramas**

El documento tiene que sobrevivir a: escala de grises · fotocopia · captura de WhatsApp (doc 09 §E.7.1).

> **La distinción visual es siempre entre *hay tinta* y *no hay tinta*, nunca entre *más tinta* y
> *menos tinta*.**

- **Tramas (hatching) y densidades: prohibidas.** Es una corrección deliberada al planteo intuitivo —
  "tramas distinguibles en escala de grises" es la solución de manual y **acá no funciona**. A estos
  tamaños —barras de 1 mm de alto, columnas de 1,6 mm de ancho— una trama de 45° no se lee como
  textura: hace **moiré con la trama de la impresora y con la compresión de WhatsApp**, y en una
  fotocopia de segunda generación se rellena y se vuelve sólida. Una trama que a veces se ve sólida es
  peor que dos formas iguales.
- **Y esto no es una precaución teórica: ya se midió en este producto.** La primera versión de la
  píldora `pendiente` era exactamente una trama a 45° —la convención de dibujo técnico para "superficie
  reservada"— y hubo que abandonarla porque **el rasterizador la resolvía como gris sólido en unas
  celdas y la perdía del todo en otras, en la misma hoja**, con los dos pasos probados (1,4 y 2,2 mm).
  Está documentado en `printPatron.pendienteFondo`. **Si una trama no sobrevive en una celda de tabla,
  no va a sobrevivir en una barra de 1 mm.**
- **Solo dos estados**, y son los del repertorio (§I.2): **relleno sólido** (el valor) y **contorno de
  0,4 pt** (la referencia).
- **Si un gráfico necesita un tercer estado, el gráfico está mal planteado**, no falta un gris. Se
  vuelve a §I.1.

### I.5.4 El gráfico **nunca** es el portador del dato

> **Ninguna distinción visual de estas formas carga información que no esté además escrita en texto en
> la misma fila o en su rótulo.**

Es la regla maestra: la que hace que todo lo demás sea seguro a cualquier reducción, en cualquier
fotocopia y con cualquier impresora. De ella salen tres cosas concretas:

1. **Las barras no llevan escala, ni eje, ni marca de valor.** El valor está en la fila, formateado por
   el mismo helper que el resto del dinero (doc 09 §E.6). **Si alguien tiene que medir una barra con la
   regla, el gráfico falló.**
2. **Las tiras rotulan dos puntos y nada más:** el primer período y el último, más el valor del último.
   Nunca un número por columna.
3. **El equivalente accesible ya existe y es la tabla que contiene al gráfico.** Si el dibujo no se
   renderiza, o el lector es un lector de pantalla —y el PDF **no es accesible**, se dice sin maquillaje
   (doc 09 §E.8)— **no se pierde ni un dato**. Esa es la única razón por la que se puede meter un
   gráfico en un documento que no se puede etiquetar.

### I.5.5 Geometría, mínimos y el factor de reducción del teléfono

Tokens a agregar antes de construir (regla doc 06 §g.2: primero el token, después el uso), hermanos de
`fontSizePrint` y de `printFitWidthFactor` (doc 09 §E.5):

```ts
// packages/design-tokens/tokens.ts — a agregar junto a printInk / printPatron / fontSizePrint.
// NO se toca en esta tanda: hay trabajo en paralelo en packages/.
export const chartPrint = {
  // Tintas: las dos que ya existen, ninguna nueva — §I.5.2
  inkValor:     "printInk.textPrimary", // el relleno: el dato
  inkPista:     "printInk.hairline",    // pista, contorno y línea de base: la referencia
  rule:         0.4,   // pt — el mismo filete del resto del documento (doc 07 §B)
  barHeight:    3,     // pt — alto de la barra de participación
  trackWidth:   51,    // pt (18 mm) — ancho de la pista, y por lo tanto del 100 %
  minInk:       1.5,   // pt — longitud mínima de un valor > 0 (§I.7.2)
  colWidth:     4.5,   // pt (1,6 mm) — ancho de columna de la tira
  colGap:       2,     // pt (0,7 mm) — separación entre columnas
  stripHeight:  28,    // pt (10 mm) — alto útil de la tira
  minPoints:    3,     // mínimo de períodos para dibujar una tira (§I.7.1)
  maxPoints:   12,     // máximo: un año. Más columnas bajan del ancho mínimo
} as const;
```

**Mínimos impresos y qué queda de ellos en el teléfono** (A4 = 210 mm → 390 px ⇒ **1,86 px/mm**;
factor `printFitWidthFactor = 0,655` del doc 09 §E.5.1):

| Elemento | Impreso | En el teléfono | Veredicto |
|---|---|---|---|
| Barra rellena (alto) | 3 pt = **1,06 mm** | ~2 px | **Se ve.** Sobrevive mejor que el texto de 9 pt, que baja a ~5,9 px |
| Columna de tira (ancho) | 4,5 pt = **1,6 mm** | ~3 px | **Se ve** |
| Alto de tira | 28 pt = **10 mm** | ~19 px | **Se ve** |
| Contorno / línea de base | 0,4 pt = **0,14 mm** | ~0,26 px | **Se difumina** — condición ya aceptada para todos los filetes del producto (doc 07 §B). Aceptable **porque el contorno es referencia, no dato** (§I.5.4) |
| Barra mínima (§I.7.2) | 1,5 pt = **0,53 mm** | ~1 px | **Al límite.** Dice *"hay algo"*, no *"cuánto"* — y el cuánto está en la fila |

**El hallazgo que ordena todo esto:** en el teléfono, **las formas aguantan la reducción mejor que la
letra chica**. El detalle a 9 pt cae a ~5,9 px y se lee con zoom (doc 09 §E.5.1); una barra de 1,06 mm
llega a 2 px y se ve sin zoom. **Por eso el gráfico agrega valor justo donde el texto lo pierde** — a
condición de que no cargue el dato (§I.5.4).

**Lo que la reducción sí rompe, y hay que tenerlo escrito:** a ~1,6 mm de ancho, la diferencia entre una
columna **contorneada** y una **rellena** se pierde en el teléfono. Por eso esa distinción solo marca
*cuál es el período del informe*, que además está rotulado. Ninguna decisión del lector depende de ella.

### I.5.6 La escala: el error que se va a cometer

> **La barra de participación se escala de 0 al TOTAL DEL CUADRO. Nunca de 0 al máximo de la serie.**

Es el bug más probable de toda la sección, y es un bug de dinero. Con escala 0→máximo, "Seguridad
58,49 %" ocuparía la pista entera y "Espacios verdes 11,37 %" ocuparía el 19 % de la pista — y el lector
leería que espacios verdes es el 19 % del gasto del barrio. **Con escala 0→total, la pista siempre es el
100 % y todas las filas de todos los cuadros de todos los meses son comparables entre sí.**

**Para la tira, la regla hermana:** el eje **arranca siempre en cero y nunca se corta**. Truncar un eje
en un documento de rendición de cuentas es fabricar una tendencia. Si un período aplasta a los demás (una
derrama, un mes atípico), **no se recorta el eje**: se rotula el máximo debajo de la tira y, si supera
cuatro veces la mediana de la serie, se agrega la nota que lo explica.

**Y una que el motor no impide pero el criterio sí:** **dos series nunca comparten una tira.** El
resultado del período y la deuda con proveedores tienen escalas distintas; superponerlos con dos ejes
inventa una correlación que no está en los datos. Son **G-2 y G-3, dos tiras separadas**, cada una al
lado de su propio número.

### I.5.7 La tira no sirve para una serie que no baja cerca del cero

> **El eje desde cero es innegociable. Su precio es que la tira solo discrimina cuando el mínimo de la
> serie está lejos del máximo. Una serie que se mueve dentro de su último 20 % dibuja columnas
> indistinguibles — y una forma que no discrimina no es "sobria": es lugar ocupado sin información.**

Es la regla que faltaba, y **se descubrió imprimiendo**, no razonando (§I.4, descarte 9). Las dos
instancias que se cayeron habían pasado las tres preguntas de §I.1: la pregunta era buena, el número
estaba impreso al lado y no costaban una página. **Lo que ninguna de las tres pregunta es qué forma va
a tomar el dibujo con los datos que ese barrio realmente tiene.**

**El caso real, que es el fundamento y por eso se escribe con sus cifras** (barrio piloto, cuatro
períodos de 2026, material de `_referencias/`):

| Instancia | Serie real | Mín ÷ Máx | Qué se imprimió |
|---|---|---|---|
| **G-4** cobranza del período | 101,92 % → 94,05 % | **0,92** | Cuatro columnas que difieren en menos de 1 mm |
| **G-5** total de mora al corte | $ 83 M → $ 102 M (tres cortes) | **0,81** | Ídem. El 23 % de crecimiento **no se ve** |
| **G-2** resultado del período | cruza el cero (déficit → superávit) | **negativo** | Se lee de un vistazo: es la que la forma existe para dibujar |
| **G-3** deuda con proveedores | crece sostenido sobre una base baja | — | Se lee |

**El caso peor es el ratio, y por eso lleva nombre propio: *un ratio pegado a su techo*.** Cobranza,
ocupación, cumplimiento, disponibilidad — todos viven arriba del 85 % o el negocio está en llamas, así
que su rango útil es el último 15 % de un eje que tiene que llegar hasta el cero. **La tira los aplasta
contra el techo por construcción, no por mala suerte con estos cuatro meses.**

**La regla operativa, para el próximo:**

1. **Antes de conectar una serie, se calcula `mínimo ÷ máximo` sobre los valores reales de un barrio
   real.** Si da más de ~0,7 y la serie no cruza el cero, **la tira no va**: no se dibuja para "ver
   cómo queda", porque queda plana y alguien la va a dejar puesta.
2. **La alternativa no es otro gráfico: es la frase que ya existe.** El delta contra el período
   anterior —en pesos o en puntos, con su fecha— dice exactamente lo que la tira aplastada no pudo, y
   cuesta un renglón. Es el corolario §I.1.2 aplicado a la forma 2.
3. **Un ratio no se dibuja como tira nunca**, salvo que su serie histórica cruce un umbral que
   signifique algo y ese umbral esté impreso.
4. **Y la salida prohibida sigue prohibida:** no se recorta el eje, no se dibuja "la variación contra
   el primer punto" en vez del valor, no se cambia a escala logarítmica. Las tres hacen que la serie se
   vea; las tres cambian lo que la columna significa sin decirlo, en un documento de rendición de
   cuentas. **Si la serie no se puede dibujar honestamente, no se dibuja.**

> **Por qué esto no se pudo prever en el papel.** El test de admisión mira la *pregunta*; esta regla
> mira los *datos*. Son dos filtros distintos y hacen falta los dos — y el segundo **solo se puede
> correr con datos de un barrio real, no con el fixture**, que tiene números elegidos para que las
> cuentas cierren a mano y por eso siempre se ven bien. **La pieza generada con datos reales no es una
> demo: es el último filtro de diseño**, y acá se ganó el lugar.

### I.5.8 El pie de una tabla larga se imprime una vez, al final de verdad

> **Un encabezado repetido rotula columnas: es verdadero en todas las páginas. Un pie repetido afirma
> un TOTAL: es falso en todas menos en la última.**

Se descubrió en la misma pieza que el descarte 9. El cuadro de gastos del piloto tiene **doce rubros** y
cruza de página; Chromium repite el `tfoot` igual que el `thead`, así que al pie de la página 1 salía
impreso `Total — 100,00 % — 180.429.036,45` **debajo de cinco rubros**. Con las barras de participación
de G-1 al costado, la lectura natural es que esos cinco suman los 180 millones.

**Es una violación de la regla dura del proyecto** (CLAUDE.md §1.4: *toda cifra de dinero se explica con
su origen*) producida por un **default del navegador**, no por una decisión de nadie — y esa es la razón
para escribirla: nadie la eligió y nadie la iba a ir a buscar.

- **El pie va una sola vez, al final de verdad de la tabla.** En el motor de hoy: el `tfoot` fuera del
  grupo que se repite. Aplica a **todos** los cuadros de la familia, no sólo al que falló.
- **No se pone un subtotal parcial en su lugar.** El documento se arma en HTML y **el HTML no sabe dónde
  va a caer el corte de página**: cualquier cifra que se imprimiera ahí sería inventada, o el mismo total
  con otro nombre. Si algún día hay un motor que sí lo sepa, la condición es que el renglón **diga que es
  parcial**, con esa palabra, y que no repita el formato del total.
- **La continuidad la declara el `thead` repetido**, que sí es verdadero. Es la misma economía que el eco
  de grupo del listado nominado: lo que se repite es lo que sigue siendo cierto en una hoja suelta.

> **La regla general, que es la que hay que recordar:** *en un documento paginado sólo se puede repetir
> en cada página lo que sigue siendo verdad en cada página.* Rótulos, sí. Cifras que resumen lo que hay
> arriba, nunca.


---

## I.6. Dónde entra cada uno en el presupuesto vertical

> **Regla dura: ningún gráfico puede agregar una página, y ninguno desplaza contenido existente.**
>
> El informe y el listado se imprimen y se despachan. Una hoja más son ~500 hojas más por mes en un
> barrio de 510 unidades, más el trabajo de alguien que las abrocha. **Un gráfico no vale una hoja.**

**Y se cumple sin excepciones — no por suerte, sino porque el repertorio se eligió para eso:** la forma
1 vive en filas que ya se pagan (**0 mm**), y las tiras se dimensionaron contra el blanco que las
piezas generadas ya tienen. **No se saca ni se mueve nada.** Si hubiera hecho falta correr una zona para
hacerle lugar a un gráfico, la respuesta habría sido que no entra.

**Con G-4 y G-5 descartadas (§I.4, descarte 9), las dos únicas instancias que costaban milímetros
verticales se fueron:** todo lo que queda dibujado en la familia cuesta **0 mm de alto**. Las dos tiras
vivas se pagan con blanco horizontal que ya estaba ahí.

| Documento | Instancia | Costo vertical | Costo horizontal | De dónde sale |
|---|---|---|---|---|
| **Informe** p. 1 | G-1 barras de gasto | **0 mm** | 18 mm | Blanco que ya hay entre `% DEL TOTAL` e `IMPORTE`. **Sin columna nueva** |
| **Informe** p. 1 | G-2 tira del resultado | **0 mm** | 28 mm | Los ~55 mm de blanco a la derecha del número del superávit |
| **Informe** p. 2 | G-3 tira de deuda con proveedores | **0 mm** | 28 mm | Blanco a la derecha del renglón de cierre de §B |
| ~~**Informe** p. 3~~ | ~~G-4 tira de cobranza~~ | ~~+10 mm~~ | — | **Descartada** (§I.4, descarte 9). Los 10 mm vuelven al blanco del pie de p. 3 |
| ~~**Mora** p. 1~~ | ~~G-5 tira de mora~~ | ~~+14 mm~~ | — | **Descartada** (§I.4, descarte 9). Los 14 mm vuelven al tercio inferior de p. 1 |
| **Mora** p. 1 (ambas versiones) | G-6 tramos · G-7 gestión | **0 mm** | 18 mm | Blanco entre `UNIDADES` y `SALDO` |
| **Boleta** frente, zona 3 | G-8 barras de concepto | **0 mm** | 18 mm | La columna `Concepto`: **74 → 56 mm** (§I.6.1) |
| **Boleta** dorso, bloque 2 | tira de la cuota *(nivel 2, §I.6.1)* | **+14 mm** en el **dorso** | 0 | El dorso tiene holgura; **el frente no se toca** |

**Recuento de páginas: informe 3 → 3 · mora agregada 1 → 1 · mora nominada 6 → 6 · boleta 2 → 2.**

### I.6.1 Pedido de cambio al doc 09 — no aplicado acá

Lo de la boleta se define acá y **se escribe en el doc 09 cuando ese documento esté libre**. Dos niveles,
en orden de valor:

**Nivel 1 — G-8, la barra en la zona 3.** Único cambio real, y es horizontal:

| | Doc 07 §B / doc 09 hoy | Con G-8 |
|---|---|---|
| Anchos de la tabla de detalle (182 mm útiles) | `Concepto (74) · Tipo (26) · Gasto del período (30) · Coef. (22) · Importe (30)` | `Concepto (56) · Tipo (26) · Gasto (30) · Coef. (22) · **Part. (18)** · Importe (30)` |
| Presupuesto vertical (doc 09 §E.2.2) | Zona 3 = 54 mm | **Zona 3 = 54 mm, idéntico** |

- La barra representa **la participación del concepto en el total de la cuota ordinaria** — no en el
  total a pagar, que incluye extraordinarias, saldo anterior e intereses y no es un todo homogéneo.
- **Los conceptos extraordinarios y el saldo anterior no llevan barra**, por el mismo motivo de §I.4
  (descarte 6): no son partes de ese todo. La fila queda con pista vacía y una nota `(n)`.
- **G-8 es el único elemento del rediseño de la boleta declarado sacrificable:** si un barrio tiene
  nombres de concepto largos que no entran en 56 mm, **se cae la columna de participación, no el nombre**.

**Nivel 2 — la tira de la cuota, en el dorso.** El bloque 2 del dorso hoy muestra un delta contra un solo
mes (*"06/2026 $372.000 → 07/2026 $360.500 ▼ −3,1 %"*). Una tira de hasta 12 períodos de **la cuota de
esa unidad** responde *"¿esto viene subiendo hace cuánto?"*, que es la pregunta número uno del vecino y
la que hoy no tiene respuesta en ningún lado. Cuesta 14 mm **en el dorso**.

> **Condición atada a §E.10:** cuando la variante de pago activa colapsa la boleta a una sola página, el
> dorso desaparece — **y la tira se va con él. No se reubica al frente.** El frente es zona 1 y no se
> negocia (§I.3.1).

---

## I.7. Casos degenerados

**En producción son la mayoría, no la excepción:** un barrio que arranca tiene un período; un barrio
chico tiene tres conceptos; un mes malo da negativo. **Un gráfico que se ve raro con datos pobres es
peor que no tenerlo**, porque el lector no sabe si lo raro es el dibujo o su barrio.

| # | Caso | Comportamiento | Por qué |
|---|---|---|---|
| **1** | **Menos de 3 períodos de historia** | **La tira no se dibuja.** En su lugar, una línea de texto: *"primer período liquidado en este sistema"* (n = 1) o el delta contra el anterior (n = 2) | **Con dos puntos no hay tendencia, hay un delta — y un delta es una frase.** Alinea con doc 09 §E.7.4 ("Sin período anterior"), que ya prohíbe calcular un delta contra nada |
| **2** | **Valor cero en una fila** | **La pista se dibuja; el relleno no.** El importe muestra `$ 0,00` o `—` | La pista tiene que estar en **todas** las filas: es la referencia común que hace comparables las filas entre sí. **Y un cero nunca se dibuja como una barra mínima**: ausencia de tinta = cero, y esa equivalencia no admite excepciones |
| **3** | **Valor mayor que cero pero minúsculo** (0,4 % del total) | Se dibuja con la **longitud mínima de 1,5 pt**, que es discernible del borde de la pista | Es lo opuesto del caso 2 y por eso funciona: hay tinta, entonces hay algo. Está declarado que una barra mínima significa *"mayor que cero"*, no *"tanto"* |
| **4** | **Un renglón negativo en el cuadro** (bonificación, nota de crédito, ajuste) | **La columna de barras no se dibuja en TODO el cuadro** — no solo en esa fila | Un cuadro con un renglón negativo **no es una partición de un todo**, y una barra de participación afirma que lo es. Es literalmente el caso de INGRESOS del informe (§I.4, descarte 6): cuota ordinaria 102,93 %, bonificación −7,72 % |
| **5** | **Un valor negativo en una tira** (mes con déficit) | **Se dibuja, y es el caso para el que la línea de base existe.** Columna hacia abajo desde la base | Acá el negativo **es la información**. Por eso la línea de base cero **se dibuja siempre**, incluso cuando toda la serie es positiva: el lector nunca tiene que adivinar dónde está el cero |
| **6** | **Menos de 3 filas con valor > 0** en un cuadro (barrio con un único concepto de gasto) | **La columna de barras no se dibuja.** El cuadro queda como está hoy | Una barra sola al 100 % no compara nada; dos barras se comparan leyendo los dos números. **La forma 1 empieza a servir en la tercera fila** |
| **7** | **Una fila que se lleva más del 90 %** | Se dibuja normalmente. Las demás caen a la longitud mínima | El dibujo aplastado **es** el hallazgo. Lo que no se hace es "darles aire" a las chicas: eso sería falsear la escala (§I.5.6) |
| **8** | **Un período faltante en el medio de la serie** (un mes no liquidado) | **Hueco vacío, el lugar se reserva.** No se interpola, no se corre la serie | Interpolar un mes de plata es inventarlo. El hueco dice *"acá no hay informe"*, que es información verdadera |
| **9** | **Un período que aplasta la escala** (derrama, mes atípico) | El eje **no se recorta**. Se rotula el máximo debajo de la tira; si supera 4× la mediana, se agrega nota | §I.5.6 |
| **10** | **El dato no existe todavía** (los tramos de antigüedad — F-6) | **Ni gráfico ni fila muda:** la píldora `pendiente` que las piezas generadas ya usan, más el renglón de *"Qué falta cargar"* | Ya es el comportamiento del producto y funciona. **Un gráfico nunca se dibuja sobre un dato estimado ni sobre un cero que en realidad es un faltante** (doc 01 §3.4) |

> **Los casos 2, 3 y 6 se contradicen en apariencia y no en el fondo.** La jerarquía es: primero se
> decide **si el cuadro lleva columna de barras** (casos 4 y 6, que la apagan entera); recién después,
> **fila por fila**, cuánta tinta lleva cada una (casos 2, 3 y 7). Invertir ese orden es lo que produce
> cuadros con una barra sola al 100 %.

---

## I.8. El límite con la privacidad

El planteo es exacto y hay que escribirlo tal cual: **en la versión agregada del listado, una barra de
un tramo con pocas unidades es un dato individual dibujado.** El documento agregado existe justamente
para no publicar eso, y un gráfico puede reintroducirlo por una puerta que nadie estaba mirando.

Las piezas generadas ya declaran las dos defensas numéricas: *"agrupación mínima: 5 unidades"* y *"los
importes se publican redondeados al múltiplo de $ 1.000"*. **Las cuatro reglas de abajo las extienden al
dibujo.**

### I.8.1 Regla 1 — la barra hereda la regla de la celda

> **Un gráfico está sujeto a la misma regla de agrupación mínima que la celda que acompaña. Si la celda
> no se publica, la barra no se dibuja.**

Corolario: **un gráfico nunca puede mostrar un corte que la tabla no muestra.** Si alguien quiere una
barra por tramo más fino que los tramos publicados, lo que está pidiendo es cambiar la política de
publicación — y eso se decide en §E, no acá.

### I.8.2 Regla 2 — la barra se dibuja desde el valor **publicado**, no desde el exacto

> **Redondear un número no redondea su barra.**

Es la fuga menos obvia y la más fácil de cometer. Si la celda publica un importe **redondeado al
millar** pero la barra se dibuja desde el valor con centavos, **la barra lleva la precisión que el
número deliberadamente perdió** — y con la pista como escala, esa precisión es recuperable con una
regla. Dos tramos que se publican con el mismo importe redondeado tienen que dibujar la **misma** barra;
si dibujan barras distintas, el dibujo acaba de desredondear el número.

**Regla de implementación:** la forma se alimenta **del mismo valor formateado que se imprime en la
fila**, nunca del valor del dominio. Verificable con un test (§I.10).

### I.8.3 Regla 3 — supresión complementaria

Si un tramo cae bajo el mínimo de agrupación y se suprime, **el total sigue publicado**: restar los
tramos dibujados del total reconstruye el suprimido. Suprimir una celda y dejar el resto es no suprimir
nada.

> **Regla:** un tramo bajo el mínimo **se fusiona con el tramo adyacente más antiguo**, y la fusión se
> declara en el renglón del cuadro (*"tramos de X y de Y unificados: menos de 5 unidades"*).

Se fusiona en vez de suprimir porque **la fusión conserva el total y no deja nada que despejar**. Y se
fusiona hacia lo más antiguo porque la lectura de gestión ("cuánto es crónico") se degrada hacia el lado
conservador: nunca hace parecer la mora más nueva de lo que es.

### I.8.4 Regla 4 — dónde no hay gráficos, y punto

| Prohibición | Motivo |
|---|---|
| **Ningún gráfico en el detalle por unidad** del listado nominado (pp. 2–6) | §I.4, descarte 7. Los gráficos del listado viven **solo en la página 1** |
| **Ningún mapa, plano ni disposición espacial** de la mora | §I.4, descarte 5. Ubicar es identificar |
| **Ninguna tira en el listado de mora, en ninguna de las dos versiones** | Hoy es un hecho: G-5 se descartó (§I.4, descarte 9) y el modelo de vista ya no tiene dónde recibir la serie. **La condición sigue escrita porque la defensa se fue con ella:** si alguna vez vuelve, vuelve con la regla de que un corte de la serie es tan sensible como una celda —uno con 3 unidades publica esas 3, aunque los otros once tengan cien— y con el redondeo al mismo múltiplo que el resto (§I.8.2) |

> **La regla que cubre lo que estas cuatro no previeron:** *la versión agregada tiene que poder mirarse
> con una regla en la mano sin que salga de ahí ningún dato de una unidad.* Es el test que hay que
> aplicarle a cualquier forma nueva antes de dibujarla, y es el que descarta el mapa, el Pareto y la
> barra por unidad sin necesidad de haberlos previsto uno por uno.

---

## I.9. Huecos nuevos — continúan la numeración de §F

Ninguno se implementa en esta tanda. **F-6 bloquea una instancia del repertorio (G-6); F-7 degrada las
dos tiras vivas a una frase.**

| # | Hueco | Dónde | Por qué importa |
|---|---|---|---|
| **F-6** | **No se sabe desde qué período está impago cada saldo.** El listado de origen no lo informa y el esquema no lo deriva | Falta el vínculo saldo → período de expensa de origen | **Sin esto no hay tramos de antigüedad**, y sin tramos no hay G-6. Ya es visible en las piezas generadas: el cuadro *Antigüedad de la deuda* está entero en `pendiente`. Y no es solo un gráfico — es la diferencia entre *"mora reciente, recuperable"* y *"mora crónica, para jurídico"*, que es lo que decide a quién se llama primero |
| **F-7** | **No hay serie histórica consultable de las cifras de cierre.** Cada informe y cada corte es un documento; el sistema no expone "el resultado de los últimos 12 períodos" ni "el total de mora de los últimos 12 cortes" | Serie por barrio de: **resultado del período** y **deuda con proveedores al cierre**, y nada más — las otras dos que este cuadro pedía (cobranza del período, total de mora al corte) alimentaban a G-4 y G-5, que se descartaron: **guardar una serie que no se dibuja ni se consulta es trabajo sin destinatario** (§I.4, descarte 9) | **Las dos tiras vivas (G-2 y G-3) dependen enteramente de esto.** Y no es un requisito de gráficos: es el hallazgo 8 de §B.1 (*"un número solo no se puede juzgar"*) pedido desde el otro lado. **Un informe emitido no se edita** (§C.3), así que la serie tiene que salir de valores **congelados al emitir**, nunca recalculados: si se recalculan, la historia cambia sola y el informe de marzo deja de coincidir con la tira de julio |

> **F-7 tiene una consecuencia de arquitectura que conviene decir ahora:** los puntos de las tiras son
> **cifras de documentos ya emitidos**. Se guardan al cerrar el período, con la misma disciplina que la
> liquidación emitida. Reconstruirlos on-the-fly es garantizar que algún día una tira contradiga a un PDF
> que el barrio ya distribuyó.

**Mientras F-6 y F-7 no estén:** las dos tiras y G-6 **no se dibujan** y el documento se comporta como
hoy (caso degenerado 10 y caso 1). **G-1, G-7 y G-8 no dependen de ningún hueco y ya están construidos.**

> **Y una condición que F-7 arrastra desde §I.5.7:** cuando la serie exista, **antes de conectarla se
> mira `mínimo ÷ máximo` con los datos de un barrio real**. Que el dato esté disponible no es motivo
> suficiente para dibujarlo — es exactamente el razonamiento que puso a G-4 y G-5 en el documento.

---

## I.10. Criterios de aceptación — para `qa-funcional` y `qa-automation`

Nueve, todos verificables sin ojo humano salvo el último.

| # | Criterio |
|---|---|
| **1** | **Escala.** En cualquier cuadro con barras, la fila cuyo importe es el total del cuadro llena la pista exactamente; una fila del 50 % llena la mitad. **Con un cuadro cuyo máximo es el 58 %, ninguna barra llega al borde de la pista** (detecta la escala 0→máximo, §I.5.6) |
| **2** | **Valor publicado.** La longitud de cada barra se deriva del **string formateado** de la fila, no del valor de dominio. Con redondeo al millar activo, dos filas cuyo importe publicado es idéntico dibujan barras **idénticas al punto** (§I.8.2) |
| **3** | **Cero.** Una fila en cero dibuja pista y **cero rectángulos de relleno**. Una fila con valor positivo mínimo dibuja **un** rectángulo de ≥ 1,5 pt (§I.7, casos 2 y 3) |
| **4** | **Negativos.** Un cuadro con al menos un renglón negativo se renderiza **sin ninguna barra** (§I.7.4). Una tira con al menos un período negativo dibuja la línea de base y ≥ 1 columna por debajo (§I.7.5) |
| **5** | **Umbral de la tira.** Con 1 y con 2 períodos, **cero tiras** en el documento y presente el texto de reemplazo. Con 3, la tira aparece (§I.7.1) |
| **6** | **Paginación.** El mismo documento, con y sin formas, ocupa **lo mismo**; la mora agregada entra en **1** hoja y la boleta en **2** (§I.6) |
| **7** | **Privacidad.** En modo `agregado`, ningún elemento dibujado corresponde a un grupo bajo el mínimo de agrupación, y **la suma de las barras dibujadas más los tramos fusionados iguala el total publicado** (§I.8.3). En modo `nominado`, **cero elementos dibujados en las páginas de detalle por unidad** (§I.8.4) |
| **8** | **Tinta.** Ningún elemento gráfico usa un color fuera de `chartPrint.inkValor` / `chartPrint.inkPista`. **Prohibido `textMuted`, prohibido el acento del barrio, prohibida cualquier opacidad menor a 1, prohibido `background-image` de cualquier tipo** (§I.5.2 y §I.5.3 — la última cláusula es la que atrapa una trama disfrazada de gradiente repetido). Es lintable sobre los estilos del generador, igual que el piso de `fontSize` del doc 09 §E.8 |
| **9** | **Escala de grises.** *(Manual, una vez por versión de plantilla.)* El documento impreso en blanco y negro y fotocopiado una vez **dice exactamente lo mismo** — y ninguna cifra depende de un dibujo (§I.5.4). El corolario del doc 09 §E.7.1 se extiende a las formas |
| **10** | **Un total, una vez.** En un cuadro con barras que cruza páginas, la cifra de `Total` aparece **exactamente una vez en todo el PDF**, al final de verdad de la tabla — y ninguna página intermedia cierra con un renglón que parezca un total. Se afirma sobre el **texto extraído del PDF**, no sobre el HTML: en el HTML el `tfoot` está una sola vez de las dos maneras, y el que lo duplica es el paginador. Ver §I.5.8 |
| **11** | **Discriminación de la tira.** Ninguna serie conectada a una tira tiene `mínimo ÷ máximo` por encima de ~0,7 sin cruzar el cero (§I.5.7). Es lintable sobre la serie, y es el control que G-4 y G-5 no tuvieron |

---

## I.11. Lo que esta sección deja pendiente

Tres cosas, dichas para que nadie las descubra tarde:

1. **De las seis instancias vivas, tres se pueden ver hoy y tres no.** G-1, G-7 y G-8 están dibujadas
   en las piezas generadas; G-2 y G-3 esperan a F-7 y G-6 a F-6. **El informe va a seguir siendo un
   documento con pocas formas durante un tiempo**, y no por falta de diseño: por falta de historia
   guardada. *(El recuento arrancó en ocho instancias: G-4 y G-5 se descartaron al verlas impresas —
   §I.4, descarte 9.)*
2. **La tira asume que hay 12 períodos que mirar.** El barrio piloto tiene **cuatro meses** de material.
   Las tiras van a nacer con 3 o 4 columnas y van a verse pobres antes de verse útiles. **Es correcto que
   así sea** (caso degenerado 1) pero conviene decirlo antes de que alguien las juzgue con datos de
   arranque.
3. **La regla de admisión es más fácil de escribir que de sostener.** La presión no va a venir de un
   desarrollador: va a venir de una reunión comercial donde el informe se compare con el de un competidor
   lleno de tortas de colores. **La respuesta preparada es §I.4**, y en particular el descarte 1: la torta
   se descartó porque el dato que mostraría **ya está impreso**, no porque no supiéramos dibujarla.
