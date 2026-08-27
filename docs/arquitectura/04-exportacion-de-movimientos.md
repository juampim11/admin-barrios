# ADR-0004 — La exportación de movimientos: síncrona, en XLSX, y con su propia traza

- **Estado:** aceptado (decisión del usuario, 2026-08-26).
- **Alcance:** el módulo de **Exportación de movimientos** (`docs/diseno/01-alcance-modulos.md` §4.8).
  La **Distribución de liquidaciones**, que comparte esa sección del documento de alcance, **no** es
  parte de esta decisión y queda para su propia tanda.
- **Panel previo, en dos rondas:** dominio (`administrador-consorcios` + `contador`) para decidir qué
  tiene que decir la planilla; técnico (`arquitecto-software` + `security-engineer`) para decidir
  cómo se construye y quién puede sacarla.
- **Se encadena con:** ADR-0000 (agnosticismo, RLS multi-tenant), ADR-0001 (el papel tiene sustrato
  propio; la cola de documentos existe por Chromium), ADR-0002 (cerrojos del grafo, presupuesto de
  recursos, la puerta única a la base), ADR-0003 (cero JavaScript en las pantallas de lectura).

---

## 1. El problema

El administrador necesita entregarle a su contador los **ingresos y egresos** del barrio, con el
concepto de cada línea, para que ese contador haga lo suyo. El módulo contable quedó **fuera del
MVP** por decisión del usuario del 2026-07-24 (hacerlo bien es prácticamente un ERP), así que esta
exportación es lo que resuelve la necesidad hoy: **una planilla, sin cálculo fiscal, sin DDJJ y sin
balance**.

Tres preguntas quedaron abiertas al terminar la auditoría del código, y las tres se contestaron en
panel antes de escribir una línea:

1. ¿La planilla es base caja o base devengado? (`pago` **no tiene** `concepto_id`.)
2. ¿Qué fecha lleva un egreso? (`gasto_periodo` **no tiene** columna `fecha`.)
3. ¿Se puede exportar un período todavía en borrador?

---

## 2. Decisión: la exportación es **síncrona**, y no pasa por la cola

Todos los demás documentos del sistema (boleta, informe mensual, recibo) se generan con la cola
`trabajo` y el worker. Esta exportación **no**.

**El motivo obvio no es el bueno.** "Se puede hacer síncrono porque `exceljs` es JavaScript puro y no
necesita Chromium" explica por qué el asincronismo no es *obligatorio* — no por qué la cola sería
*incorrecta*. El motivo real es de límites:

`documento_emitido` y `recibo_emitido` no son "tablas de artefacto asíncrono": son el **libro de
emisiones append-only** del sistema, con `sha256`, `vista`, `vista_version`, `plantilla_hash`,
`storage_key` único y numeración legal por barrio. Existen porque lo que guardan es un documento
**emitido a un tercero**, inmutable y oponible. Una exportación de movimientos es una **lectura
materializada al vuelo**: sin número, sin destinatario formal, reproducible desde el dato, y marcada
`PROVISORIO` cuando el rango incluye períodos no emitidos. Meterla en la cola crea una cuarta clase
de artefacto sin valor legal que después hay que retener, purgar, versionar y cubrir con RLS.

**Y hay dos ganancias concretas, no solo ahorro de trabajo:**

- **Nada queda en reposo.** No hay objeto en el almacenamiento, no hay huérfanos, no hay URL firmada
  que sobreviva a la sesión. Importa especialmente acá: la ruta de descarga de documentos
  (`api/documentos/[documentoId]`) documenta que *la credencial que firma URLs alcanza al bucket
  entero*, y que lo único que separa una boleta de todas las boletas es que la clave haya salido de
  una fila leída bajo RLS. Una boleta filtrada es una unidad; **este archivo filtrado es el barrio
  entero**. Ponerlo en el canal cuya defensa es la más apretada del repo concentraría el peor blast
  radius en el control más ajustado.
- **La traza y la lectura comparten transacción de verdad.** Con cola de por medio eso se parte en
  dos y la garantía de "si el registro falla, no hay entrega" se pierde.

### 2.1 El precio, y cómo se paga

`exceljs` arma el workbook **entero en memoria del proceso web**, y el pool de request tiene 10
conexiones. De ahí tres condiciones que no son opcionales:

1. **Tope de filas verificado con `COUNT` antes de construir nada** → `413`. Contar después de traer
   las filas ya habría pagado el costo que el tope existe para evitar. `MAXIMO_FILAS_EXPORTACION`
   = 50.000 (un barrio de 510 unidades hace ~6.000 filas al año).
2. **Tope de rango** de 24 meses validado por Zod, para que `desde=1900-01&hasta=2999-12` ni llegue a
   la base.
3. **Serializar SIEMPRE fuera de la transacción.** `servidor/db.ts` ya lo dice: adentro de
   `conSesion()` no se hace nada lento, porque diez operaciones lentas congelan el pool entero.

> **`maxDuration` no es la protección.** Es un vercelismo; esto corre en Docker (ADR-0000 §4). La
> protección es el tope de filas.

---

## 3. Decisión: la traza va en **tabla propia**, y ese `insert` **es** el gate de rol

### 3.1 Por qué no un quinto valor en `descarga_documento`

Este repo tiene un principio ganado a pulso: **generalizar en vez de crear tabla nueva**.
`descarga_documento` ya se ensanchó dos veces (`0039`, `0049`) con FKs nullables y un `CHECK` de
"exactamente una referencia", y su docstring explica que se prefirió eso a una columna polimórfica
**para conservar la integridad referencial real**.

**Acá la analogía se rompe, y se rompe en el punto exacto que hacía valiosa esa generalización:**

| | `descarga_documento` | Una exportación |
|---|---|---|
| Referencia | Siempre una fila que existe, con `on delete restrict` | **Ninguna**: no hay artefacto |
| El `CHECK` | "exactamente una de cuatro" | Tendría que ser "exactamente una **o ninguna**" |
| `url_firmada_at` / `ttl_segundos` | El acto que se registra (`CHECK > 0 and <= 600`) | **No existen**: no hay URL que acuñar |
| Qué se registra | *Quién pidió qué documento* | *Quién sacó qué datos, con qué alcance y cuántas filas* |

El quinto caso tendría las cuatro FK en `null`, o sea habría que **relajar** el `CHECK`. Eso no
extiende el precedente: lo **deroga** — deja la tabla exactamente en la forma polimórfica sin FK que
su propio comentario dice que se rechazó. Y lo que se registra es otra cosa: traza de
**exfiltración**, no de descarga.

El precedente propio y decisivo es `recibo_emitido` (`0038`), que tuvo que ser tabla nueva porque
`documento_emitido` no lo albergaba. **La regla del repo no es "generalizá siempre": es "generalizá
cuando la forma es la misma".**

### 3.2 El nombre

`exportacion_movimientos`, no `exportacion_solicitada`: no es una solicitud que se encola y después
se atiende —esa es `trabajo`— sino una extracción que **ocurrió**.

### 3.3 El gate de rol vive en el `insert`

Como la exportación no deja artefacto, **no hay tabla sobre la cual poner una policy de `select`**
que decida quién puede exportar. La solución (hallazgo de `security-engineer`) es ponerlo en el
`insert` de la traza, que se escribe antes de serializar. Con eso, las dos garantías se sostienen
entre sí:

> **No se puede exportar sin dejar rastro, ni dejar rastro sin tener el rol.**

Y va del lado de la base, no en un `if` de la ruta: un gate en TypeScript es un gate que la próxima
ruta se olvida.

### 3.4 Quién puede exportar, y por qué este agregado necesita gate propio

`pago_sel`, `orden_pago_sel` y `proveedor_sel` son `readable_tenant_ids()` a secas, que está bien
**fila por fila** — así las leen las pantallas. Pero el repo **ya decidió, y lo puso en una policy**,
que un agregado del barrio entero es cualitativamente distinto de sus filas:
`documento_emitido_sel` (`0027`) gatea por tipo, y su comentario dice textual que *el listado de
saldos pendientes NO lo lee la membresía de gestión, porque una copia es la deuda con nombre de todo
el barrio*.

El libro de movimientos es un agregado **estrictamente mayor** que ese listado. Que no tuviera gate
sería una **incoherencia del propio esquema**.

| Rol | ¿Exporta? | ¿Lee la traza? |
|---|---|---|
| `admin_plataforma`, `admin_barrio` | Sí | Sí |
| `contador` | **Sí** — es el destinatario del entregable | **No**: no es supervisor del uso del sistema |
| `operador` | **No** — carga movimientos de a uno; el libro completo es otra cosa | No |
| `auditor` | **Según `barrio.auditor_exporta_movimientos`** | **Sí, siempre** — ver el libro y ver quién lo sacó son cosas distintas |
| `propietario`, `residente` | No (no leen ni una fila del barrio desde `0018`) | No |

**El flag del auditor es configurable por barrio** (decisión del usuario): un auditor que no puede
exportar el libro no puede auditar, pero también es un rol de lectura amplia sobre un archivo que
sale del sistema. La decisión es del barrio, no del producto.

### 3.5 La columna **nace cerrada**

`barrio.auditor_exporta_movimientos` es la tercera columna de gobierno del barrio, y la primera que
nace con su `revoke`/`grant` de columna **en la misma migración que la crea**:

- `orden_imputacion` (`0036`) quedó abierta **sin querer**, y se descubrió un módulo después.
- `orden_pago_cuatro_ojos` (`0047`) se cerró **a tiempo**, porque un panel la auditó.
- `auditor_exporta_movimientos` (`0050`) **no espera a que un panel la encuentre por tercera vez**.

> **Trampa a recordar:** `revoke` + `grant (columnas)` **no es incremental**. Cada migración que toca
> ese grant tiene que volver a nombrar las 17 columnas escribibles. Si una se cae de la lista, su
> escritura se rompe **en silencio** — no falla al migrar, falla el día que alguien la edita. Hay un
> test que verifica el conjunto exacto, no solo que la columna nueva esté cerrada.

---

## 4. Decisión: **XLSX es el formato de este entregable, y CSV no lo es**

No es "el CSV queda para después". Es que **CSV es el contenedor equivocado para esta forma**.

El panel de dominio pidió **dos vistas de ingresos** que se relacionan entre sí:

- **Hoja A — "Cobranzas (percibido)"**: una línea por `pago`. Es la única que se puede cruzar contra
  el extracto bancario, que es lo primero que hace el contador. Un pago que cubrió tres boletas fue
  **un** movimiento en el banco, no tres. Y un pago sin imputar **existe** acá, rotulado *"a cuenta"*.
- **Hoja B — "Cobranzas imputadas por período de origen"**: una línea por `pago_imputacion`, **más
  una fila residual por cada pago no aplicado del todo**, para que la hoja B **sume exactamente igual
  que la A**.

**Esa identidad es el producto de la exportación.** Dos archivos CSV sueltos la vuelven inverificable
para el destinatario: recibe dos archivos cuya única relación es una convención de nombre. Y el libro
lleva además **encabezado** (barrio, figura jurídica vigente, CUIT, sello, disclaimer), **sección de
anulaciones** y **subtotales**; un CSV no tiene lugar para un bloque que no sea dato — anteponerlo
rompe el contrato de columnas de cualquier parser.

> El sistema de gas exportaba CSV y es el precedente correcto para el gate de rol, la auditoría y la
> arquitectura de tres capas. **No lo es para el formato**: allá era *una vista = un rectángulo*. Acá
> hay dos rectángulos, un encabezado y una sección aparte.

Si mañana aparece una necesidad real de CSV, será **otra exportación** —una vista plana, un
rectángulo, sin encabezado—, que es la forma que CSV sí sirve. El dataset es agnóstico de formato
justamente para que ese día se reuse entero.

### 4.1 La hoja B **no se llama "devengado"**

Es **caja asignada a un devengado anterior**. El devengado real es la liquidación emitida, que es
otro dato. Llamarla "devengado" induce un error de lectura en quien la recibe.

### 4.2 Lo que la hoja B **no** promete

`pago_imputacion` imputa contra la **liquidación entera**, no contra el ítem: el modelo **no registra
a qué rubro fue el dinero** dentro de una boleta. Por eso la hoja B trae la composición de la boleta
cubierta **tal cual**, con una columna que dice si la imputación la cubre completa o es parcial —y
**no prorratea en silencio**. Repartir por rubro sin que nadie lo haya registrado sería exactamente
la cifra sin origen que CLAUDE.md §1.4 prohíbe.

---

## 5. Decisión: dinero = número, fecha e identificador = **texto**

La asimetría es deliberada, y está escrita en el serializador porque si no alguien la "arregla" para
que sea uniforme:

| Qué | Cómo va a la celda | Por qué |
|---|---|---|
| **Dinero** | **Celda numérica** + `numFmt` en la columna | El valor y su presentación viajan separados: el separador decimal lo pone el Excel de quien abre, con **su** locale. Un importe preformateado como texto se ve bien y **no suma** — que es lo único que esta planilla existe para permitir. |
| **Fechas** | **Texto** en ISO-8601, tal cual las da Postgres | Una celda de fecha le pediría un `Date` de JS a la librería, y ahí `2026-08-01` se vuelve `2026-07-31` según el huso: el modo de falla exacto de la regla 7 del gate. ISO-8601 además ordena bien como texto. |
| **CUIT, CBU, N° de recibo** | **Texto**, aunque sean todo dígitos | Excel guarda **15 dígitos significativos**: un CBU de 22 pierde dígitos y se muestra `1,23457E+21`. Eso es **un número de cuenta bancaria alterado adentro de un archivo contable**. |

**Ningún subtotal es una fórmula.** Todos se calculan server-side y se escriben como valores: una
fórmula puede recalcularse distinto en la máquina del contador y dejar de coincidir con lo que dice
el sistema.

### 5.1 `montoANumeroDePlanilla()` es la única conversión autorizada

Vive en `packages/shared/src/dinero.ts` y es **el único lugar del repo que convierte dinero en
`number`**. Se sostiene con un argumento de rango, no con confianza: las columnas son
`numeric(14,2)`, o sea a lo sumo 10¹⁴ centavos, muy por debajo de 2⁵³ ≈ 9,007·10¹⁵. La regla **EX-2**
del gate verifica que `Number(` aparezca **una sola vez** en ese archivo.

> **Lo que NO se construyó, y conviene que quede escrito:** una función de "monto con coma decimal
> sin separador de miles". Ese es un requisito de **CSV**, y este repo no exporta CSV. La confusión
> venía de que el sistema de gas hace las dos cosas —su `csv.ts` localiza la cadena, su `xlsx.ts`
> pasa el valor crudo— y se leyó como dos formas de hacer lo mismo. Son dos serializadores distintos.

---

## 6. Decisión: el borrador **se exporta**, marcado

Bloquearlo rompería el uso más frecuente del módulo, que **no es el envío al contador**: es el
**control previo a emitir**. Y los cobros y egresos de un período existen aunque la liquidación no se
haya emitido — la plata entró y salió igual. Un barrio atrasado dos meses no puede quedarse sin poder
mirar sus movimientos. Si el sistema lo bloquea, el intercambio se muda a un Excel armado a mano por
WhatsApp, fuera de toda traza.

Tres condiciones, y ninguna es negociable:

1. **`PROVISORIO` en el nombre del archivo**, con el sello. Es la única defensa cuando hay tres
   versiones del mismo período en la carpeta de Descargas.
2. **Sello de extracción en el encabezado.** El catálogo `concepto` sigue siendo editable, así que
   **dos extracciones del mismo borrador pueden diferir legítimamente**; sin el sello no se sabe cuál
   se está mirando. Ese sello sale de la base y es **el mismo instante** que quedó en la traza: es lo
   único que ata un archivo que anda dando vueltas por un mail a su fila de auditoría.
3. **`origen_clasificacion` por fila** (`Congelada al emitir` / `Catálogo vigente (borrador)`), no
   solo en el encabezado: un rango puede mezclar períodos emitidos y borradores.

### 6.1 `sin_clasificar` se imprime, nunca se deja en blanco

Literal en la celda: **`SIN CLASIFICAR — requiere definición`**, con subtotal propio arriba y una hoja
de leyenda que aclara que **no** afirma que el concepto esté fuera del alcance de IIBB. Un blanco o un
guion se leen como "no corresponde", y eso es **afirmar un encuadre por omisión** — justo lo que el
enum, al no llevar default, fue diseñado para impedir.

---

## 7. Decisión: el saneado de fórmula es **bloqueante**, y el precedente del gas no cubría

Una celda cuyo texto empieza con `=`, `+`, `-` o `@` la interpreta Excel como **fórmula**. Con
`=HYPERLINK(...)`, `=WEBSERVICE(...)` o `+cmd|'/c …'!A1` (DDE) eso pasa de "celda rara" a exfiltración
o ejecución de comandos.

**El canal es real y cruza el límite de confianza del producto:** lo escribe un `operador` (el motivo
de anulación de un pago, la descripción de un gasto, el nombre de un proveedor); lo abre el
**contador o el auditor**, en su propia máquina, fuera del sistema.

> **El serializador del sistema de gas NO mitiga esto.** Su CSV escapa `;`, `"`, `\n` y `\r`
> (RFC-4180), que es escape de **parsing**, no de **fórmula**. Que sea el precedente correcto para
> otras cosas no lo convierte en precedente seguro para esto: copiarlo tal cual importa el agujero.

La mitigación es **una sola función en `packages/shared` con test** —`sanearTextoDePlanilla()`—
aplicada a todo texto que tipeó una persona, a los rótulos del encabezado y al nombre del archivo. Un
saneado aplicado columna por columna **se olvida en la columna 14**.

El `filename` se sanea aparte (`sanearNombreDeArchivo()`): la razón social entra en
`Content-Disposition` y es texto que escribe un `admin_barrio` — un `"` cierra el `filename="…"` y un
CR/LF abre una cabecera nueva. Es inyección de cabecera, no cosmética.

---

## 8. Las tres capas, y dónde vive cada cosa

Se conserva la arquitectura del sistema de gas, que es lo bueno que tenía:

```
packages/data/servicios/exportaciones.ts   → datos crudos bajo RLS (strings de numeric, fechas ISO)
apps/web/servidor/export/dataset.ts        → columnas + filas + bloques, AGNÓSTICO DE FORMATO
apps/web/servidor/export/xlsx.ts           → el único archivo que importa `exceljs`
apps/web/app/api/exportaciones/movimientos → contar → registrar → leer → cerrar tx → serializar
```

**Por qué en `apps/web/src/servidor/` y no en un paquete nuevo:** hay un solo consumidor, y —beneficio
no obvio— las reglas 5, 6 y 7 del gate ya cubren `apps/web`, así que todo el código nuevo queda
vigilado gratis. **No** va en `packages/documentos`: ese paquete es el sustrato del **papel**
(plantillas, `vista_version`, `plantilla_hash`), y un serializador tabular no es una plantilla de PDF.

### 8.1 Cuatro reglas nuevas en el gate

| Regla | Qué exige |
|---|---|
| **EX-1** | `packages/shared` tampoco usa `Intl` / `toLocale*`. Costo cero: pasaba limpio. El modo de falla que agrava este módulo es que `es-AR` degrade a `en-US` en silencio y **cambie el separador decimal del archivo entero**. |
| **EX-2** | `Number(` aparece **una sola vez** en `dinero.ts`, y es la conversión a planilla. |
| **EX-3** | `exceljs` solo se importa desde el serializador. |
| **EX-4** | **Nadie lee un `.xlsx`.** La dependencia entró para escribir; parsear un archivo de un tercero es otro modelo de amenaza (zip-bomb, XML hostil) y necesita su propio panel. |

> **La regla 5 (`Number`/`parseFloat`/`toFixed`) NO se extendió a todo `packages/shared`.** Falla
> sobre usos correctos: aritmética de meses en `documentos/series.ts`, `pg.types.setTypeParser` en
> `data/client.ts`, geometría en mm/pt en `packages/documentos`, contadores de reintentos en el
> worker. Un gate que nace con ocho excepciones enseña que la excepción es normal, y la novena sería
> un bug de dinero real. Queda como tarea aparte, con un predicado más angosto.

---

## 9. Tres huecos de datos, declarados y **no suplidos**

Ninguno bloquea el módulo. Los tres salen como **columna vacía honesta**, con el aviso escrito en la
planilla:

1. **El gasto simple no tiene fecha propia.** Solo `created_at`. En la operatoria real el
   administrador junta las facturas del mes y las descarga en una sola sesión, así que usar
   `created_at` como "fecha del egreso" mostraría cuarenta egresos el mismo día: no distorsiona un
   poco, **invalida la columna** para conciliar contra el banco. Por eso van **tres columnas
   separadas** —`Fecha de pago` (solo de `orden_pago.pagada_at`), `Fecha de comprobante`,
   `Fecha de carga`— y **`periodo` es la columna de agrupación y subtotal**. Una columna cuyo
   significado varía por fila produce un total que **no se puede auditar**, porque desde la planilla
   no hay forma de saber qué fila es de qué tipo.
2. **No existe la fecha de la factura del proveedor.** `orden_pago` tiene `numero_factura` y la
   factura adjunta, pero ninguna columna de fecha.
3. **No hay orden de imputación de un pago parcial** dentro de una liquidación (§4.2).

> **Gatillo escrito:** el 1 y el 2 se cierran agregando dos columnas al alta de gasto y de orden de
> pago —dato que el administrador tiene a la vista cuando carga—, y son la condición para que la
> planilla pueda dar fecha de caja de todos los egresos. El 3 depende de una decisión del barrio.

---

## 10. Lo que esta decisión **no** resuelve

- **El archivo deja de estar bajo control del sistema apenas se descarga** (mail, WhatsApp, el Drive
  del contador). Eso no lo arregla ninguna feature; por eso el encabezado dice qué es el archivo y
  que contiene datos personales.
- **No hay rate limiting en el repo** (cero ocurrencias). El tope de filas y el de rango acotan el
  caso, pero un export concurrente por usuario queda como endurecimiento deseable.
- **El módulo contable sigue fuera del MVP.** Esta planilla es descriptiva, no interpretativa —y
  tiene que seguir siéndolo mientras los tres huecos de `knowledge/` que marcó `contador` sigan
  abiertos: efecto jurídico del inciso de expensas de la Ley 10117, criterio de imputación temporal
  del IIBB en Córdoba, y numeración vigente del t.o. del Código Tributario. **Validar con profesional
  matriculado.**
