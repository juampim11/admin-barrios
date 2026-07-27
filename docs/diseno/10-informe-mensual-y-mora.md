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
