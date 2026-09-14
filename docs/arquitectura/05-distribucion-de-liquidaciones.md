# ADR-0005 — La distribución de liquidaciones: tres trabajos, un registro que nace antes del correo, y los rebotes recortados

- **Estado:** aceptado (implementado 2026-08-29/30).
- **Alcance:** el módulo de **Distribución de liquidaciones**
  (`docs/diseno/01-alcance-modulos.md` §4.8, segundo renglón). La **Exportación de movimientos**, que
  comparte esa sección del documento de alcance, es el ADR-0004 y no se toca acá.
- **Panel previo:** `security-engineer` (gate de rol, PII fuera del sistema, superficie de correo
  entrante), `arquitecto-software` (dónde vive el envío, agnosticismo del transporte),
  `administrador-consorcios` (qué recibe el vecino y qué archiva el administrador).
- **Se encadena con:** ADR-0000 (agnosticismo de proveedor, RLS multi-tenant), ADR-0001 (el papel se
  guarda, no se regenera; la cola existe por Chromium), ADR-0002 (la puerta única a la base,
  presupuesto de recursos), ADR-0003 (cero JavaScript en las pantallas de lectura), ADR-0004 (el
  precedente de tabla propia cuando la forma no es la misma).
- **Migraciones:** `0052` (las tres tablas), `0053` (reglas, gates y tipos de trabajo), `0054` (la
  máquina de estados del envío).

---

## 1. El problema, y la regla de oro que lo gobierna todo

Emitido el período y generadas las boletas, falta lo único que el vecino ve: **que le llegue la
suya**. Y el administrador necesita quedarse con una copia de lo que mandó.

Todo lo demás que hace este sistema es reversible o repetible sin costo: un PDF se genera de nuevo,
un ZIP se rearma, una URL firmada vence, un pago se anula. Esto no.

> **Un email no se puede retirar.** Con 510 destinatarios, un reintento mal resuelto son cientos de
> duplicados irreversibles en bandejas de entrada de personas reales, y el vecino que recibe dos
> liquidaciones no sabe cuál rige.

Las cinco decisiones de abajo se deducen casi enteras de esa frase.

---

## 2. Decisión: son **tres trabajos separados**, no uno

`emitir_informe_periodo`, `armar_paquete_periodo` y `distribuir_liquidaciones` son tres valores del
`trabajo_tipo_chk` y tres handlers distintos del worker.

**El motivo es operativo, no de prolijidad.** `MAX_INTENTOS_TRABAJO` y `estado = 'fallado'` son **por
fila**. Con un solo trabajo, un fallo al armar el ZIP quemaría un intento del envío, y reintentarlo
volvería a recorrer destinatarios — que es exactamente lo que la regla de oro prohíbe. Separados,
*"reintentá el ZIP"* no toca un email.

Costó **un renglón** de migración porque `trabajo.tipo` es `text` + `CHECK` desde `0039` y no un enum
nativo: agregar valores no exige un `ALTER TYPE`, que el migrador de este repo no tolera (aplica
todas las pendientes en una transacción). Es el argumento inverso al del ZIP en `0052`, donde
ensanchar `tipo_documento` sí era caro.

### 2.1 Consecuencia en la pantalla

La pantalla muestra **tres pasos con su propio estado y su propio botón**, no un botón "Distribuir".
Un único botón escondería justamente la distinción que hace que un reintento sea seguro. El sello
"Hecho / Pendiente" de cada paso sale de **estado real leído de la base** (¿existe el informe?,
¿existe el paquete y está completo?, ¿hay envíos aceptados?), nunca de "ya lo apreté".

---

## 3. Decisión: el registro por destinatario **nace antes** del `sendMail()`

`envio_liquidacion` no es solo trazabilidad: **es el guard de idempotencia**. La fila se inserta y se
commitea antes de que salga el mensaje, con `on conflict do nothing` sobre
`uq_envio_periodo_contacto`.

De ahí tres consecuencias deliberadas:

1. **El claim es un `update` condicional** (`… where estado = 'pendiente'`), no una lectura seguida de
   una escritura. Dos workers sobre el mismo lote: uno gana la fila, el otro recibe cero filas y
   sigue de largo. La condición está en la base, no en el `if` de nadie.
2. **`enviando` es una puerta de una vía, y `fallado` es terminal** (`0055`). Es estado *desconocido*
   a propósito: el mensaje puede haber salido. Reintentar automáticamente convierte una duda en un
   duplicado seguro. Se prefiere perder la certeza de que se mandó antes que arriesgar mandarlo dos
   veces.

   > ⚠ **`0054` no cerraba esto, y hay que saber por qué.** Validaba las transiciones **salto por
   > salto, no la historia**, así que `enviando → fallado → pendiente` devolvía a la cola una fila en
   > estado desconocido con dos sentencias que cualquier `admin_barrio` podía emitir. Que no se
   > hubiera visto un duplicado **no era mérito de la máquina de estados: lo tapaba un bug** —el claim
   > reescribía el `mensaje_id` congelado y reventaba el lote entero—, así que arreglar ese bug solo
   > habría convertido la protección en la puerta del segundo correo.
   >
   > Lo cierra **ENV-1**, un `CHECK` y no una guarda del trigger:
   > `estado <> 'pendiente' or (mensaje_id is null and intento = 0)`. O sea: **una fila en `pendiente`
   > nunca fue entregada al transporte.** No hizo falta ninguna columna nueva —`intento` ya era el
   > registro de "estuvo en vuelo", porque sube solo en el claim— y al ser un `CHECK` no depende de
   > la lista de transiciones: aunque alguien reponga la arista, una fila fallada tiene `intento ≥ 1`
   > y se rechaza igual.
   >
   > **Consecuencia deliberada: no hay reintento por fila.** Reintentar mandaría a `email_snapshot`,
   > que está congelada — la misma dirección que ya se sabe que no anda. Lo que sí funciona sin tocar
   > nada: una **casilla nueva** en esa unidad es otro `unidad_contacto_id`, así que al reencolar nace
   > una fila nueva con su propio `Message-ID`, sin conflicto con `uq_envio_periodo_contacto`.
3. **Si el proceso muere en el medio**, lo que queda escrito es "se intentó" — que es la verdad.

### 3.1 El par contacto↔documento no se arma en TypeScript

`crearLoteDeEnvios()` inserta filas que ya traen los dos juntos, y el trigger
`app.envio_antes_insert()` (`0053`) deriva la unidad **desde la liquidación del documento** y rechaza
la fila si no coincide con la del contacto.

Por eso el código nunca arma arrays paralelos de contactos y PDFs unidos por índice: ese es el modo
de falla clásico de estos lotes, y un chunking desalineado **le manda a un vecino la boleta de otro**.

### 3.2 La boleta que viaja es la **última emitida** de cada unidad

Hay un `distinct on`: con una reemisión hay dos filas de la misma unidad en el mismo período, y
mandar la vieja es mandar importes que ya se corrigieron. La fila de `envio_liquidacion` guarda cuál
viajó, justamente porque "la boleta de esa unidad" es ambiguo.

---

## 4. Decisión: distribuir **no** hereda la autorización de emitir

`operador` puede emitir documentos desde `0027`. **No puede distribuir.**

Emitir es interno: el PDF se escribe en el storage y no sale del sistema. Distribuir manda **datos
personales a cientos de casillas externas**, y eso es otra operación (`security-engineer`, B-6).
`ROLES_QUE_DISTRIBUYEN` = `admin_plataforma` + `admin_barrio`.

**El gate vive en `app.trabajo_antes_insert()`, no en el servicio.** El rol de request puede insertar
en `trabajo` directo, así que un gate en TypeScript es un gate que la próxima ruta se olvida
(`security-engineer`, B-5). Es el mismo criterio con el que `0051` puso el gate de la exportación en
el `insert` de su traza: el único lugar que no se puede saltear.

Por eso **el servicio de encolado no tiene ninguna compuerta propia**, a diferencia de
`encolarEmisionDeDocumentos()`. Lo que sí se agregó son las **reglas de traducción** de los cinco
rechazos del trigger, para que lleguen a la pantalla como un mensaje y una salida y no como un código
de soporte. La pantalla, además, **no le ofrece el botón a quien la base va a rechazar** — eso es
honestidad de la UI, no control de acceso.

### 4.1 Las precondiciones materiales, también en la base

Distribuir exige: período emitido, **boletas emitidas** (sin ellas el correo sale sin su adjunto
principal), **informe emitido** (es el segundo adjunto) y **paquete armado** (sin él, el administrador
se queda sin la copia que archiva). Armar el paquete exige boletas: un ZIP vacío es un archivo que
miente.

---

## 5. Decisión: el ZIP es un artefacto **derivado**, y la pantalla **no promete que se borre**

`paquete_distribucion` + `paquete_distribucion_item` (el manifiesto, tabla hija y no `jsonb`, para
conservar integridad referencial real y poder contestar *"¿le faltan boletas emitidas después de
armarlo?"* con una consulta y no con una interpretación).

Un paquete puede quedar **superado**, noción que `documento_emitido` deliberadamente no tiene. Por eso
la pantalla dice "el paquete quedó desactualizado" en vez de ofrecer una descarga que miente por
omisión, y la ruta de descarga resuelve **siempre el último**.

### 5.1 Por qué la ruta es `api/paquetes/[periodoId]` y no `[paqueteId]`

Una ruta por id del paquete dejaría descargar un ZIP superado con solo conservar la URL vieja: un
archivo que dice ser "las liquidaciones del período" y al que le faltan las boletas emitidas después.
Con el período en el segmento, el enlace no puede quedar viejo.

### 5.2 ⚠ **La regla de expiración del bucket NO existe, y por eso la pantalla no la menciona**

La carpeta `/paquetes/` está separada del resto de las claves (`SUFIJO_PATRON_CLAVE_PAQUETE`)
**precisamente** para poder colgarle una regla de expiración: un objeto que expira mezclado con los
que no expiran es un accidente esperando.

Pero esa regla **todavía no está aprovisionada en ninguna parte**, y se verificó antes de escribir el
texto de la pantalla:

| Dónde debería estar | Qué hay hoy |
|---|---|
| `docker-compose.yml` (`minio-init`) | crea el bucket y tres cuentas de servicio. **Ningún `mc ilm`.** |
| Infraestructura como código | **no existe** (`terraform/`, `infra/`, `iac/`, `pulumi/`: ninguno) |
| Permiso de borrado | ni la web ni el worker tienen `s3:DeleteObject` — **a propósito** |
| `ObjectStorage` | **no expone `remove()`** (ADR-0000 §3.3): "un `remove()` disponible es un `remove()` que alguien va a llamar" |

> **Regla dura mientras eso siga así: la pantalla no dice una palabra sobre la expiración del ZIP.**
> Un cartel que dijera *"se elimina a los N días"* sería una promesa que **nada en el sistema
> cumple** — el archivo seguiría ahí para siempre, y alguien habría decidido, confiando en ese
> cartel, no guardar su copia. Un cartel de retención que miente es peor que no tener ninguno.
>
> El día que la regla exista de verdad se cambian **juntos** el texto de `recorrido.tsx`, el
> docstring de `page.tsx` y esta sección.

Esto es coherente con la retención del resto de los documentos, que sigue abierta: `retencion_meses`
por barrio con default **no purgar nunca**, y el plazo real pendiente de `legal-ph`/`contador` con
fuente (doc 07 §G.2, ADR-0001 §13).

---

## 6. Decisión: **el correo saliente entra por una interfaz propia**, y **no se lee ningún buzón**

`packages/notificaciones` expone una interfaz propia; `nodemailer` vive **solo** en
`src/adapters/smtp.ts`. Mismo cerrojo que protege el SDK de S3, y por el mismo motivo del ADR-0000:
el dominio no ve el SDK. Acá compra algo más concreto: si el envío se pudiera armar desde cualquier
lado, el día que la web mande un correo nacería un segundo camino con su propio remitente, su propio
formato y **sin la fila de registro que se escribe antes**.

La configuración SMTP es **opcional**: sin credenciales el worker **arranca igual**, avisa por consola
y la distribución es lo único que no puede hacer (`armarCorreoDelWorker()` devuelve `null` y el
handler falla temprano, con el motivo escrito). Emitir documentos no tiene nada que ver con mandarlos,
y un entorno de desarrollo no necesita un servidor de correo para liquidar un período.

Las credenciales SMTP son del **worker y solo del worker**: `SMTP_` está en `PREFIJOS_GOBERNADOS`, así
que una credencial de correo puesta en el entorno de la web hace fallar el arranque en vez de quedar
disponible para el proceso que atiende pedidos.

### 6.1 ⚠ El manejo de rebotes está **recortado**, y `rebotado` no tiene productor

`envio_liquidacion.estado` incluye `rebotado`, y **hoy nada lo escribe.** Es un valor del enum
preparado, no una funcionalidad.

**Por qué se recortó:** parsear correo entrante es superficie de entrada nueva —contenido que
controla cualquiera, más credenciales de un buzón, más un proceso desatendido— y **un DSN falsificado
marcaría `rebotado` un envío que sí llegó**, que es peor que no saber. Eso necesita su propio panel y
su propia decisión escrita.

**Los ganchos que quedaron puestos**, para que la implementación futura no tenga que rediseñar nada:

- **`mensaje_id`**, que se guarda por envío: es lo que permite correlacionar un DSN con la fila.
- **`SMTP_DOMINIO_REBOTES`**, el dominio del `Return-Path` con VERP (`rebotes+{envio_id}@…`). **Se
  configura y no se lee todavía**, a propósito: es lo que hace que el día que exista el consumidor de
  rebotes no haya que rediseñar nada **ni re-emitir lo ya enviado**.
- La alternativa prevista, si el proveedor la ofrece, es un **webhook firmado** en vez de un buzón.

**El gate lo hace cumplir:** la regla **DIST-2** prohíbe `imapflow` y `mailparser` en todo el
monorepo. El día que se implemente será con decisión escrita, no entrando por la puerta de atrás de
una librería ya instalada.

> **`docs/diseno/01-alcance-modulos.md` §4.8 decía "estado (`enviado`/`rebotado`/`pendiente`)" sin
> aclarar esto.** Se corrigió en la misma tanda: prometía un estado que ningún productor escribe.

---

## 7. Las tres capas, y dónde vive cada cosa

| Capa | Qué hace | Qué **no** hace |
|---|---|---|
| `packages/data/servicios/distribucion.ts` · `paquetes.ts` | arma el lote, reclama, sella estados, lee el panorama | no manda ningún correo, no arma ningún ZIP |
| `apps/worker` (`distribucion.ts`, `paquete.ts`, `emision-informe.ts`) | el único proceso con credenciales SMTP y lectura del storage | no decide quién puede distribuir |
| `apps/web` (pantalla, acciones, ruta de descarga) | ofrece, confirma, sigue y descarga | no valida precondiciones (las valida la base) |

`panoramaDeDistribucion()` existe aparte de `leerContextoDeDistribucion()` porque **no lanza**:
aquélla arma el lote y por eso exige el informe emitido; ésta dibuja la pantalla, y *"todavía no hay
informe"* es justamente uno de los estados que tiene que poder mostrar. Una función que rechaza no
puede pintar el checklist que dice qué falta.

### 7.1 La confirmación muestra **los dos conteos**

Antes de mandar, la pantalla dice a cuántas unidades les llega **y a cuántas no**
(`unidadesSinContacto`: unidades con boleta emitida y sin ninguna casilla activa). El segundo número
es el que nadie mira si el botón manda a la primera, y es el que después explica por qué tres vecinos
llamaron diciendo que no recibieron nada.

`destinatarios` cuenta **unidades**, no filas de contacto: una unidad con dos casillas es un
destinatario. Sin ese `distinct`, el cartel prometería más envíos de los que hay.

### 7.3 Lo que la pantalla hace con un envío que no llegó

Con `fallado` terminal, el recuento agregado dejó de ser un diagnóstico y pasó a ser **una tarea
abierta**: reencolar la distribución no resucita esas filas, así que "No llegó: 3" significa que a
tres vecinos les falta su liquidación y nadie más se lo va a resolver. Un número así, sin salida, es
el callejón que este documento prohíbe.

Por eso el paso 3 muestra **una fila por unidad**: la unidad, **qué pasó** en criollo (el
`error_codigo` traducido — y la traducción distingue si el problema es la casilla del vecino o el
servidor de correo del barrio, porque mandarlo a "contactar al vecino" cuando lo que falló fue el
SMTP es mandarlo a arreglar algo que no está roto), y **su boleta para descargar**, que es la salida
real: se le hace llegar por otro medio.

La **dirección va adentro de un `<details>`, no como columna** —mismo corte que la pantalla de
padrón— y es `email_snapshot`, la congelada a la que se intentó, **nunca la vigente del contacto**:
mostrar la vigente le haría creer al administrador que ya lo arregló.

Y el **sello del paso tiene tres valores**, no dos: `Hecho`, `Pendiente`, y **`Enviado con N
excepción(es)`**. Sin el tercero, un período con 3 fallas de 510 quedaba "Pendiente" para siempre
—el contador nunca vuelve a cero— mientras `marcarPeriodoDistribuido()` sí sellaba el período: la
pantalla contradiciendo al estado, y una tarea que no se podía terminar nunca.

Detalle que no es cosmético: **"Sin confirmar" reemplazó a "En vuelo"** en el recuento. `enviando` es
estado desconocido a propósito, y "en vuelo" promete lo contrario de lo que la máquina de estados
decidió — que va en camino y va a llegar.

### 7.2 Tres reglas nuevas en el gate

| Regla | Qué hace cumplir |
|---|---|
| **DIST-1** | `nodemailer` solo desde `packages/notificaciones/src/adapters/smtp.ts` |
| **DIST-2** | prohibido leer correo: `imapflow` / `mailparser` en cualquier parte del monorepo |
| **DIST-3** | la librería de ZIP (`yazl`) solo desde `apps/worker/src/paquete.ts`; `yauzl` (leer) prohibido entero |

DIST-3 es el reflejo de EX-4: `yazl` entró para **escribir**. Leer un ZIP que sube un tercero es la
familia de la zip-bomb y del path traversal, es otro modelo de amenaza, y no debe poder entrar por la
puerta de atrás de una dependencia ya instalada. Y un ZIP armado fuera de ese handler es un archivo
**sin su fila ni su manifiesto**: nadie puede decir después qué boletas tenía.

---

## 8. Lo que esta decisión **no** resuelve

1. **Los rebotes.** Recortados, con `mensaje_id` y VERP como gancho (§6.1). Necesitan panel propio.
2. **La expiración del ZIP.** El prefijo está preparado; la regla **no existe** (§5.2). Hasta que
   exista, la pantalla no promete nada.
3. **El portal del residente.** Que el vecino se baje su boleta en vez de recibirla por correo es
   otro camino de lectura (su propia liquidación, no "el período entero en PDF") y otra tanda.
4. **El listado de mora.** **No es un adjunto de este correo** (doc 01 §4.8, decisión del usuario del
   2026-08-27): es un documento propio, con su propia lista de destinatarios.
5. **La retención de `trabajo` y de los documentos.** Sigue abierta, junto con el plazo que definen
   `legal-ph`/`contador` con fuente (ADR-0001 §13).
6. **Reintentar un envío `fallado` desde la pantalla.** **Descartado con motivo, no pendiente**
   (`product-owner`, 2026-08-31). Reintentar la misma fila mandaría a `email_snapshot`, que está
   congelada: es la dirección que ya se sabe que no anda. O sea que "reintentar" solo sirve **después**
   de corregir el padrón — y entonces es *corregir el padrón* **más un click**, pagando por ese click
   volver parcial `uq_envio_periodo_contacto`, que es el guard que impide duplicar el lote de 510.
   Mal negocio.

   Lo que la pantalla ofrece en su lugar (§7.3): **una tarea por unidad**, con la boleta descargable
   para hacerla llegar por otro medio. **Gatillo para revisitarlo:** que un barrio real tenga la falla
   de forma recurrente, o que el volumen de excepciones por período deje de ser un puñado. Y antes de
   construirlo tiene que pasar por `security-engineer`: reintentar contra una dirección corregida
   puede mandarle la liquidación de un titular al contacto de un titular **nuevo**, si el cambio de
   padrón fue por venta y no por un error de tipeo.

7. **Cerrar a mano un envío fallado** (`fallado → cancelado`, con motivo). Evaluado y **descartado**
   para esta tanda: `cancelado` significa hoy "se canceló antes de intentar" (`intento = 0`), y
   desde `fallado` significaría "puede haber salido" — un mismo estado contestando dos cosas
   distintas a la pregunta que sostiene el módulo. Además `cancelado` **todavía no tiene ningún
   productor**, así que su primer camino habría sido el semánticamente equivocado.

   El problema real que motivaba la propuesta —que el paso 3 no se pudiera sellar nunca— se resolvió
   **en la pantalla, con cero SQL**: el sello tiene un tercer valor (§7.3). Si algún día hace falta
   dejar constancia de *cómo* se resolvió cada excepción, eso es un **acuse con motivo tipificado**
   con su propia forma, no una arista de esta máquina.

8. **La zona horaria por barrio.** `paquete_distribucion.armado_at` se muestra **en UTC y rotulado
   como UTC**, porque `barrio` **no tiene columna de zona horaria** y elegir una sería hornear la del
   barrio piloto (§1.6 de `CLAUDE.md`). No es un olvido: es la opción honesta mientras el dato no
   exista. El día que exista `barrio.zona_horaria` se convierte en el servicio con `at time zone` y se
   saca el rótulo — el formateo ya pasa por `formatearFechaHora()` de `@admin-barrios/shared/fechas`,
   así que el cambio es de una línea y en un solo lugar.

   ⚠ El mismo patrón crudo (`valor.slice(0, 16).replace("T", " ")`, que además mostraba UTC **sin
   decirlo** y cuyo `replace` era código muerto) **sigue vivo en cuatro pantallas ya mergeadas**:
   `cobros/[unidad]`, `liquidacion/[periodo]/documentos`, y las dos de `ordenes-pago`. No entraron en
   esta tanda porque son de otro módulo, pero tienen el mismo defecto.
