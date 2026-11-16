# Guía de prueba de la aplicación

> ⚠ **La guía vigente de la demo la lleva la coordinación, no este archivo** (BL-024, 2026-11-03).
> Acá quedan dos cosas: «Antes de empezar» (cómo levantar el entorno) y la sección **«Alta de barrio
> y padrón (T3)»**, que sigue al día. La sección «Qué hay cargado» y los pasos 1 a 8 están
> **obsoletos**: describen la demo de agosto y no la de hoy; se conservan solo como historia.

> Escrita mirando la pantalla, no el código. Si algo no coincide con lo que ves, la guía está vieja:
> avisá. Estado verificado el 2026-08-03 con el seed recién corrido.

## Antes de empezar

Si la aplicación no responde en `http://localhost:4000`:

```
docker compose --profile app up -d
```

> **Si te dice que el contenedor `app` salió con error**, es porque cambiaron las dependencias y las
> que tiene adentro quedaron viejas. Se arregla una vez, y **no borra la base**:
>
> ```
> docker compose --profile app up -d --build --force-recreate --renew-anon-volumes app
> ```
>
> (`--renew-anon-volumes` solo tira los `node_modules` del contenedor; los datos de Postgres viven en
> un volumen con nombre y no se tocan.)

> **Si te aparece un cartel rojo que dice `Jest worker encountered child process exceptions`**, no es
> un error de la aplicación: es el servidor de desarrollo, al que se le murieron los procesos que
> compilan las pantallas. Las tres formas de llegar ahí, todas vistas el 2026-08-04:
>
> 1. Se corrió `pnpm build` con el servidor levantado — **comparten la carpeta `.next` y se pisan**.
>    (Para compilar sin molestar a quien está usando la aplicación:
>    `NEXT_DIST_DIR=.next-build pnpm --filter @admin-barrios/web build`.)
> 2. Se **mató el proceso a la fuerza** para liberar el puerto 4000, y quedaron procesos hijos
>    huérfanos con la carpeta a medio escribir.
> 3. Se cerró a medias la terminal que lo tenía.
>
> El síntoma típico es que una pantalla ya visitada anda y una nueva revienta. Se arregla así:
>
> ```
> pnpm dev:limpio
> ```
>
> Borra la carpeta de compilación y vuelve a levantar. **No toca la base.** La primera visita a cada
> pantalla después de esto tarda hasta 20 segundos: está compilando, no está colgada.

Para el **paso 6** (los documentos) hace falta además el proceso que los genera, en otra terminal:

```
pnpm worker:dev
```

Corre en tu máquina y usa el Chrome que ya tenés instalado: no levanta ningún contenedor nuevo. Si
no lo arrancás, todo lo demás de la guía funciona igual.

Si querés volver todo al estado inicial en cualquier momento (borra y recrea el barrio de
demostración, sin tocar nada más):

```
pnpm db:seed
```

## Qué hay cargado — OBSOLETO

> **Obsoleto** (BL-024): no describe lo que siembra hoy `pnpm db:seed`. La guía vigente la lleva la coordinación.

**Un barrio:** *Barrio Demo Los Aromos*, 50 unidades, PH especial.

**Dos períodos.** Ojo: **el seed los arma relativos a la fecha de hoy**, así que los meses que veas en
pantalla dependen de cuándo lo corriste. Corrido el 2026-08-03 quedan 07/2026 y 08/2026:

| Período | Estado | Qué tiene |
|---|---|---|
| **El mes anterior** (hoy 07/2026) | Emitida | 5 gastos por $9.875.500 · 50 liquidaciones · cargos y bonificaciones aplicadas |
| **El mes en curso** (hoy 08/2026) | **Borrador** | 3 gastos por $6.520.250 (uno extraordinario **sin acta**) · 2 cargos aplicados · **0 liquidaciones** |

El del mes en curso es el que se puede tocar. El anterior está cerrado a propósito, para que veas cómo
se comporta un período emitido.

**Catálogo de conceptos del barrio:**

| Concepto | Tipo | Valor |
|---|---|---|
| Alquiler de quincho | Cargo | $38.000 por jornada |
| Bonificación vecino cumplidor | Descuento | 10 %, con tope de $35.000 |

**Topes del barrio para el rol operador:** descuentos hasta $40.000, cargos hasta $120.000 por unidad
y período. Y a cualquiera —incluido el administrador— el sistema le pide confirmar cuando los cargos
de una unidad superan **3 veces** su expensa.

---

## Paso 1 — Entrar — OBSOLETO

> **Obsoleto** (BL-024): ver el aviso de arriba.

Abrí `http://localhost:4000`. Te lleva sola a la pantalla de entrada.

**No hay contraseña**: se elige un personaje. Vas a ver tres tarjetas. Empezá con **Valeria Ríos**
(administradora del estudio) haciendo clic en su tarjeta.

Los otros dos se usan más adelante, en el paso 8.

## Paso 2 — Mis barrios — OBSOLETO

> **Obsoleto** (BL-024): ver el aviso de arriba.

Caés en la lista de barrios que administra Valeria. Hay uno solo: **Barrio Demo Los Aromos**.
Hacé clic.

## Paso 3 — Mirar antes de tocar — OBSOLETO

> **Obsoleto** (BL-024): ver el aviso de arriba.

Arriba vas a ver tres solapas: **Tablero · Padrón · Liquidación**.

- **Tablero**: la ficha del barrio y si se puede liquidar.
- **Padrón**: las 50 unidades con su propietario. Probá abrir el triangulito de una fila: ahí
  aparecen documento, CUIT, correo y teléfono. **No están en la grilla a propósito** — una captura
  de pantalla de 50 filas con nombre y DNI es un problema.
- **Liquidación**: la lista de períodos.

## Paso 4 — El período cerrado (para ver qué NO se puede hacer) — OBSOLETO

> **Obsoleto** (BL-024): ver el aviso de arriba.

En **Liquidación**, entrá al período **emitido** (el del mes anterior). Fijate:

- Arriba, cuatro cifras: gastos cargados, gastos al liquidar, prorrateado del mes y total a cobrar.
  **Las tres primeras tienen que dar igual.** Esa es la pregunta "¿cierra el mes?".
- Abajo, las 50 unidades con su coeficiente y su boleta, y los cargos y descuentos por unidad.
- **No hay ningún formulario para cargar nada.** El período está emitido y es inmutable.

## Paso 5 — El período en borrador — OBSOLETO

> **Obsoleto** (BL-024): ver el aviso de arriba.

Volvé a **Liquidación**. Arriba de la lista está la **tarjeta del mes abierto**, con «Continuar
liquidación»; en la lista, cada fila tiene su botón **«Abrir»** a la derecha. Entrá al período **en
borrador** (el del mes en curso).

**Dónde caés: en el resumen del mes**, no en una pantalla de carga. Es la pregunta que se hace
primero ("¿cómo viene el mes?"), y de ahí salen los cuatro pasos del trabajo:

> **1** Gastos del mes · **2** Cargos y descuentos · **3** Revisar y emitir · **4** Documentos

Y arriba de todo, a la izquierda, **«← Volver a Liquidación»**: está en las cinco pantallas del
período, así que nunca hay que salir por la solapa de arriba.

### 5.a — Cargar un gasto

Andá al paso **1 · Gastos del mes** — o apretá el botón **«Nuevo gasto»** de arriba a la derecha, que
te lleva derecho al formulario. Ya hay tres cargados. Agregá uno:

- Concepto: elegí cualquiera de la lista.
- Descripción: lo que quieras.
- Importe: escribí `2500000`, **sin puntos y sin decimales**.

**Mirá el campo mientras escribís:** se va separando solo (`2.500.000`) y al guardar completa los
decimales. Antes esto rebotaba pidiéndote que escribieras `,00` al final, que era el sistema
haciéndote trabajar para él. Probá también borrar un cero **en el medio** del número: el cursor tiene
que quedarse donde estaba, no saltar al final.

**Probá esto:** elegí un concepto **extraordinario** y no cargues acta. El gasto **entra igual**, pero
vuelve marcado como *sin respaldo de asamblea*. Es a propósito: en la vida real se rompe una bomba y
no se espera a la asamblea. El sistema no lo impide, lo deja anotado.

**Y probá esto otro:** poné un importe con letras, o negativo. Tiene que avisarte **en el campo**, no
con un cartel arriba.

### 5.b — Aplicar un cargo a una unidad

Andá al paso **2 · Cargos y descuentos**.

Aplicá un **Alquiler de quincho** a cualquier unidad, con cantidad `1`. Fijate que en la columna
importe dice **"se conoce al liquidar"** y no `$ 0,00`: el importe lo calcula la base cuando se
genera el borrador, no la pantalla.

Aplicá también una **Bonificación vecino cumplidor** a otra unidad. Ahí el importe tampoco se sabe
todavía, y con más razón: es un porcentaje sobre una expensa que aún no existe.

**El paso más interesante de toda la prueba:** aplicá un quincho con cantidad **90**. Como eso supera
varias veces la expensa de esa unidad, **el sistema lo rechaza** y te muestra una tarjeta que dice la
cifra concreta y contra qué comparó. Recién marcando la casilla y confirmando, entra.

Probá también **desmarcar la casilla y volver a enviar**: tiene que pedirte la confirmación de nuevo.
Si entrara sin marcarla, el control sería decorativo.

**Y ahora la salida:** en esa misma tarjeta hay un **«Volver y corregir»**. Apretalo. Tenés que
volver al formulario **con todo lo que habías tipeado intacto**, para poder arreglar el número. Es
para el caso que la pantalla existe para atrapar: si pusiste 90 porque se te fue un cero, lo que
querés es corregir, no ratificar. Volvé a enviar el 90 sin tocar nada: **la confirmación tiene que
aparecer otra vez** — la salida no es una llave que quede abierta.

**Y probá anular** uno de los cargos: pide un motivo de al menos 5 caracteres y **es irreversible**.
No hay forma de editar un cargo — se anula y se carga de nuevo. La fila anulada queda a la vista con
su motivo, porque es la única explicación de por qué esa plata no se cobró.

### 5.c — Generar el borrador

Andá al paso **3 · Revisar y emitir** y apretá **Generar el borrador**.

Ahora sí aparecen las 50 liquidaciones con sus importes, y los cargos que aplicaste **ya tienen
número**. Verificá arriba que *gastos cargados*, *gastos al liquidar* y *prorrateado del mes* den
exactamente igual.

Podés volver al paso 1, cargar otro gasto, y regenerar. **Los cargos que aplicaste no se pierden**:
se recalculan, no se borran.

### 5.d — Emitir

En el mismo paso 3, abajo, está la emisión. Antes de apretar vas a ver qué queda emitido y cuántas
boletas. Hay que marcar una casilla explícita: **emitir es irreversible** y el período queda
inmutable.

Después de emitir, volvé al paso 1: **el formulario de carga ya no está**.

---

## Paso 6 — Los documentos — OBSOLETO

> **Obsoleto** (BL-024): ver el aviso de arriba.

Ya se bajan desde la pantalla. Hace falta **una cosa más prendida**: el proceso que los genera, que
corre aparte de la web. En otra terminal:

```
pnpm worker:dev
```

Tiene que decir `worker listo`. Dejalo corriendo y volvé al navegador.

En el período **emitido**, entrá al paso **Documentos** y apretá **Generar los documentos**. Fijate:

- La pantalla muestra el avance y **se actualiza sola** (50 boletas tardan unos 13 segundos).
- Podés irte a otra pantalla y volver: el estado no se pierde, vive en la base.
- Cuando termina, aparece la lista con una fila por unidad y un botón **Descargar PDF**.

**Probá esto:** apretá **Generar los documentos** dos veces seguidas. La segunda tiene que decir que
ya se están generando — no un error. Y una vez que terminó, volver a generar **no reemplaza** lo que
ya está: cada boleta emitida queda guardada tal como se envió. Eso es a propósito y es la regla más
importante de esta parte: lo que un vecino reclama es el papel que recibió, no uno nuevo hecho hoy
con la plantilla de hoy.

**Y probá esto otro:** copiá el enlace de "Descargar PDF" y pegalo en otra pestaña **después de dos
minutos**. No funciona: el enlace de descarga vive 90 segundos. Cada vez que apretás el botón se
acuña uno nuevo, y queda registrado quién lo pidió y cuándo.

> Si preferís no levantar el worker, las boletas se siguen generando por comando a `tmp/boletas` con
> `pnpm demo:boleta`. Es el mismo motor; lo que cambia es quién lo dispara.

## Paso 7 — Volver a empezar — OBSOLETO

> **Obsoleto** (BL-024): ver el aviso de arriba.

`pnpm db:seed` deja todo como al principio: el mes anterior emitido, el mes en curso en borrador.

---

## Paso 8 — Probar el aislamiento (lo que más vale de esta demo) — OBSOLETO

> **Obsoleto** (BL-024): ver el aviso de arriba.

Salí (arriba a la derecha) y entrá como **Martín Coria**, el operador. Fijate:

- Ve **un solo barrio**, no el estudio.
- Puede cargar gastos y aplicar cargos.
- Si intenta aplicar un descuento de más de **$40.000**, o un cargo de más de **$120.000** a una
  unidad, **no puede**: no es una confirmación, es un no. Eso lo aplica un administrador.

Salí y entrá como **Silvia Aguirre**, la contadora. Fijate:

- Ve el mismo barrio y las mismas cifras.
- **No tiene ningún formulario**: no carga, no aplica, no emite.

Ese cambio de lo que se ve y de lo que se puede hacer **no lo decide la pantalla**: lo decide la base
de datos. Aunque alguien salteara la interfaz, el resultado sería el mismo.

---

## Alta de barrio y padrón (T3, ADR-0010)

Con la base sembrada (`pnpm db:seed`) y entrando como **Valeria Ríos**:

1. **Crear un barrio.** En **Mis barrios**, «Nuevo barrio». Cargá nombre y municipio, elegí Sociedad
   anónima, Cuota fija, «Una cuenta por unidad» (recaudador cualquiera; **cuenta padre
   `0000003199999990000603`**, que es de demostración), y dejá los datos legales en «A confirmar».
   «Crear el barrio y cargar el padrón».
2. **Importar la planilla.** En el padrón del barrio nuevo, «Importar planilla» y subí
   `docs/demo/padron-de-ejemplo.csv`. La vista previa muestra 30 altas, cada una con su código de pago
   previsto. «Confirmar importación».
3. **Una ficha con dos titulares y cuenta propia.** En el padrón, **Mza A · Lote 2**: dos titulares,
   uno que recibe la boleta, y la cuenta de la unidad. Ahí mismo: «Editar», «Cambiar titular» (dice
   cuánto debe la unidad y que la deuda sigue con ella) y «Dar de baja».
4. **La boleta con la cuenta de la unidad.** En **Barrio Demo Los Ceibos** (sembrado así), Liquidación
   → el mes en curso → Documentos → generar y bajar la boleta de **Mza 1 · Lote 4**: el CBU, el alias
   y el QR son los de la unidad, y el código de pago queda de respaldo. Una unidad sin cuenta propia
   (por ejemplo **Mza 2 · Lote 1**) imprime la cuenta padre con el código de pago. (Los PDF los arma el
   worker: hace falta Chromium.)

Para probar que el padrón no se rompe: subir la planilla dos veces (la segunda dice «Sin cambios» o
«la cuenta ya la usa otra unidad»), o entrar como Martín Coria (operador) y ver que el padrón no tiene
botones.

## Proveedores, órdenes de pago y cobros (encargo 9)

`pnpm db:seed` deja **Barrio Demo Los Aromos** y **Barrio Demo Las Cortaderas** listos para recorrer
cada pantalla. Todo es inventado y entra por los servicios de la aplicación, sin saltear ninguna regla
de la base. Correrlo dos veces no duplica nada: lo verifica `tests/volumen/seed-demo.test.ts`.

| En cada uno de los dos barrios | Qué queda |
|---|---|
| Proveedores | 7 con CUIT y CBU de prueba válidos (limpieza, seguridad, jardinería, electricidad, pileta, contador, residuos). «Recolectora del Valle S.A.» está **inactivo**. |
| Órdenes de pago | 2 **pendientes** (Brillo Serrano: limpieza; Aguas Claras: pileta), 1 **aprobada** (honorarios del Estudio Contable Paz, con su gasto en el borrador), 1 **pagada** (Electro Sierras, del mes emitido), 1 **rechazada** con motivo (Centinela, adicional de vigilancia) y 1 **anulada** de un mes emitido (Verde Monte, poda): su ajuste negativo está en el borrador (P2). |
| Liquidación | El mes anterior **emitido**, con el sello de quién emitió, y el mes en curso **en borrador** con gastos cargados a mano y los que vienen de órdenes de pago. «Generar el borrador» funciona con el ajuste incluido. |
| Cobros | La mayoría al día, un **pago anulado** (el banco revirtió la transferencia) y unidades con **deuda vencida**. Solo en Los Aromos, porque Las Cortaderas no cobra interés: pagos tardíos con interés cobrado y uno imputado con **«No cobrar interés»**. |
| Cargos | En el borrador: uno **vigente** (pádel) y uno **anulado** (club house, cargado a la unidad equivocada). |

Al terminar, el seed imprime **qué unidad y qué proveedor usar en cada prueba en vivo**: pago tardío,
«No cobrar interés», orden de pago para aprobar, orden de pago para rechazar, gasto de una orden y
gasto manual. Los importes cambian con la fecha, porque el interés corre desde el vencimiento.

## Ajustes del ensayo del titular (encargo 10)

Con la demo sembrada (`pnpm db:seed`), en **Barrio Demo Los Aromos**:

| Qué probar | Dónde | Qué tiene que pasar |
|---|---|---|
| Importe con el teclado numérico | Cualquier campo de importe (Registrar pago, gasto, condonar…) | `1234.56` con el punto del teclado numérico se ve `1.234,56`: el punto escribe la coma y los centavos caen después. Nunca aparece «esperado string decimal»; si algo no se entiende, dice «Escribí el importe con hasta dos decimales, por ejemplo 1.234,56». |
| Registrar un pago | Cobros › Registrar pago, unidad Mza 1 · Lote 1 | Al confirmar vuelve al estado de cuenta con una sola línea: «Listo: se registró el pago de $ … del …: $ … a capital y $ … a interés.» (más lo no cobrado, si se marcó «No cobrar interés»). |
| Condonar | Estado de cuenta de una unidad con interés pendiente › Condonar interés | Vuelve al estado de cuenta con «Listo: se condonaron $ … de interés de esta unidad.» |
| Buscar unidades | Cobros y Padrón | «Mza 1», «mza 1» o «1-» traen **solo** la manzana 1 (no la 10 ni la 11). «Mza 1 Lote 2» trae esa unidad. «19», «000019» y «000019-» seguido del verificador traen la unidad del código 19. |
| Orden | Cobros, Padrón, liquidación, envíos | Manzana y lote como números: el lote 10 va después del 9. Las manzanas con letra, al final y ordenadas. |
| Filtros de Cobros | Cobros | «Con deuda vencida» y «Al día», con su conteo. El resumen separa «Deuda vencida» (la misma cifra que el tablero) del «Saldo a vencer». La columna «Vencido» dice cuánto de cada saldo ya venció. |
| Casilla «No cobrar el interés» | Registrar pago › No cobrar el interés | Desde el encargo 11 la casilla va arriba, sola, con sus dos renglones debajo (ver la sección del encargo 11). |
| Condición fiscal | Proveedores › Nuevo proveedor, y Editar | Un desplegable: Responsable Inscripto, Monotributo, Exento, IVA no alcanzado, Consumidor final. Un proveedor viejo con otro texto lo muestra tal cual y lo conserva al editar. |
| Ajuste de una orden anulada | Liquidación › mes en borrador › Gastos | La línea negativa de Verde Monte dice en Acciones «Por la anulación de la orden de pago de Verde Monte Parques y Jardines», con enlace a la orden. |
| Anular un pago | Estado de cuenta › Pagos registrados › Anular | El diálogo muestra el importe, cómo se imputó (y la condonación que se anula con él), el saldo antes y después, y pide el motivo. Al anular vuelve con «Listo:». «Ver anulados» muestra los pagos anulados con la fecha y el motivo. |

## Condonación en dos partes, mes del servicio y permiso de anular (encargo 11)

Con la demo sembrada (`pnpm db:seed`), en **Barrio Demo Los Aromos**. El resumen de la consola del seed
dice qué unidad usar (sección «Encargo 11»).

### «No cobrar el interés» en dos renglones (BL-030 j)

| Qué probar | Dónde | Qué tiene que pasar |
|---|---|---|
| Los dos renglones | Cobros › Registrar pago, una unidad con deuda vencida e interés, como administrador | En «No cobrar el interés», debajo de la casilla, dos renglones marcados: «Interés de este atraso: $ …» y «Interés anterior que la unidad todavía debe: $ …». Los importes aparecen al elegir la unidad y la fecha. |
| Condonar las dos partes | Marcar la casilla, dejar los dos renglones, motivo y detalle | La confirmación dice «se condonan $ … del interés de este atraso y $ … de interés anterior…». Al confirmar, el «Listo:» dice las dos partes: «…, y no se cobraron $ … de interés de este atraso y $ … de interés anterior.» |
| Destildar un renglón | Igual, destildando uno | Lo destildado se cobra: va a interés en el orden del barrio. La confirmación y el «Listo:» solo nombran lo condonado. |
| Los dos destildados | Casilla marcada, los dos renglones destildados | No se registra: pide «Marcá qué interés no se cobra…». |
| Las boletas emitidas | Liquidación › mes emitido › boleta de la unidad | No cambian: lo condonado queda como condonación en el estado de cuenta, no como boleta corregida. |
| Anular | Estado de cuenta › Pagos registrados › Anular (como administrador) | El diálogo dice las dos partes condonadas y que las dos se anulan; el saldo «después» las suma. Al anular, el interés vuelve a deberse. |

«Interés anterior» es **todo** el interés que la unidad debía antes de registrar el pago, haya salido
o no impreso en una boleta (decisión del titular, 2026-11-04): por ejemplo, el que quedó de un pago
parcial anterior.

### «Mes del servicio» en la orden de pago (BL-030 k)

| Qué probar | Dónde | Qué tiene que pasar |
|---|---|---|
| Cargarlo | Órdenes de pago › Nueva orden | Campo opcional «Mes del servicio (opcional)», mes y año. El período de la orden no cambia. |
| Verlo | La orden de la reparación del tablero eléctrico (seed), el detalle y la lista de órdenes | «Servicio de {mes}/{año}», junto a la descripción. |
| En Gastos, la boleta y el informe | Liquidación › mes emitido › Gastos, la boleta de una unidad y el informe mensual | Junto al gasto de esa orden: «Servicio de {mes}/{año}». En la boleta va en el renglón de aclaraciones. El importe del gasto y de las boletas es el mismo. |
| Congelado | Una orden ya aprobada | El mes ya no se cambia (como el resto de la orden). |

### Quién anula un pago con interés condonado (permiso, `0070`)

| Qué probar | Dónde | Qué tiene que pasar |
|---|---|---|
| Como operador | Estado de cuenta de la unidad del caso de dos partes › Pagos registrados | En lugar de «Anular» dice «Lo anula un administrador porque tiene interés condonado». Los pagos sin condonación siguen con «Anular». |
| Como administrador | El mismo pago | Aparece «Anular» y anula el pago con sus dos condonaciones. |

## Circuito del mes (T2)

Con la demo sembrada (`pnpm db:seed`). La especificación es la maqueta aprobada
`coordinacion-admin-barrios/maquetas/mes-liquidacion.html`; el porqué, la ADR-0011
(`docs/arquitectura/11-circuito-del-mes.md`). Los casos de la demo los dice la consola del seed
(«T2, el circuito del mes»): Los Aromos preparando (bloquea una unidad nueva sin coeficiente; avisan el
gasto extraordinario sin respaldo y las órdenes sin aprobar), Las Cortaderas listo para emitir, Los
Talas y El Algarrobal emitidos con el envío pendiente, y Los Talas con un aumento de cuota.

### Inicio

| Qué probar | Dónde | Qué tiene que pasar |
|---|---|---|
| El mes en cada tarjeta | Barrios (la primera pantalla) | Cada tarjeta sigue con su información y suma «Noviembre: <estado>» (Preparando, Emitido, Enviado) como información. El único enlace de la tarjeta es el nombre, al Tablero (y «Cargar el padrón» en un barrio sin padrón). |

### Liquidación actual

| Qué probar | Dónde | Qué tiene que pasar |
|---|---|---|
| La tabla | Barra de la administración › Liquidación actual | «Noviembre en mis barrios»: una fila por barrio con el estado del mes y su motivo («1 bloqueo · 2 avisos» con «1 unidad activa sin coeficiente» abajo, «Nada bloquea a la vista · 1 aviso», «N boletas sin enviar»), las boletas y el vencimiento. Singular y plural. Carga enseguida: no calcula vistas previas. |
| Dentro de un barrio | La barra lateral de cualquier barrio | Debajo de la línea, «Liquidación actual · todos los barrios» y «Configuración general»: se llega a la lista sin volver a Barrios. |
| La contadora | Entrar como Silvia Aguirre | Ve Los Aromos y Las Cortaderas (dos filas, sin «Emitir»). |
| Filtros | Igual | Todos, Preparando, Listos para emitir, Sin enviar y Enviados, con su conteo. |
| Seguir | Cada fila | Lleva a la parte del mes pendiente: el Resumen, la vista previa (Boletas) o Envío. |

### La ficha del mes: cabecera y pestañas

| Qué probar | Dónde | Qué tiene que pasar |
|---|---|---|
| Se abre solo | Un barrio › Liquidación | Va al mes en curso. Si el barrio no tenía el período del mes, lo abre al entrar (modelo y día de vencimiento del barrio), sin botón «Abrir período». |
| Cabecera | Cualquier pestaña del mes | «Noviembre 2026» con su estado; «Por coeficiente · vence el …» con «Cambiar»; «Meses anteriores» y «Emitir N boletas». |
| Vencimientos | «Cambiar» | Diálogo con 1.er y 2.º vencimiento y motivo; vale solo para este mes y hasta emitir. |
| Pestañas | Igual | Resumen · Gastos y pagos (N) · Cargos y descuentos (N) · Boletas (N) · Envío. No hay «Generar el borrador» ni «Revisada». |
| Meses anteriores | Botón de la cabecera | La lista de períodos del barrio; sin «Nuevo período» ni «Valor de la expensa». |

### Resumen

| Qué probar | Dónde | Qué tiene que pasar |
|---|---|---|
| Preparando (Los Aromos) | Los Aromos › Liquidación | Etapas: Preparar actual («1 bloqueo · 2 avisos»). Próximo paso: la unidad nueva sin coeficiente, con «Ir a Coeficientes». Lo que falta: Bloquea (la unidad) y Avisa (órdenes sin aprobar y el gasto extraordinario sin respaldo de asamblea). «Emitir» apagado. |
| Solo lectura | Entrar como el contador | La vista previa dice que la calcula la administración; no aparece un bloqueo falso ni «Emitir». |
| Listo para emitir (Las Cortaderas) | Las Cortaderas › Liquidación | Preparar hecha, Emitir actual con «N boletas · $ … a hoy». Próximo paso «Emitir N boletas». |
| Emitido (Los Talas) | Los Talas › Liquidación | Preparar y Emitir hechas («Emitido el … por …»), Enviar actual. Próximo paso «Enviar las boletas por correo» → Envío. |
| Cifras | Igual | Gastos del mes · N, cargos y descuentos · N, interés por mora · N unidades, total a cobrar · N boletas. |

### Boletas

| Qué probar | Dónde | Qué tiene que pasar |
|---|---|---|
| Vista previa | Las Cortaderas › Liquidación › Boletas | «Vista previa · Calculada hoy … con lo cargado hasta ahora. Se actualiza sola». Arriba, el total a emitir y la cantidad de boletas. Tabla Unidad · Expensa · Cargos · Interés · Total, con filtros Todas, Con interés y Con cargos. Tarda unos 2 segundos en Los Aromos. |
| Filtrar no recalcula | Los filtros | Cambian la tabla al instante, sin volver a calcular (no aparece «Calculando la vista previa…»). |
| Boleta de ejemplo | Clic en una unidad | A la derecha, la boleta de esa unidad, al instante: expensa, cargos, saldo anterior, interés y total al vencimiento. |
| Emitidas | Los Talas › Boletas | Las boletas emitidas, con la fecha y quién emitió. |

### Emitir

| Qué probar | Dónde | Qué tiene que pasar |
|---|---|---|
| El diálogo | Las Cortaderas › «Emitir N boletas» | «Se calculan y firman N boletas por $ …, con el interés a hoy»; los vencimientos; «Lo emitido no se deshace»; «Después se arman solos los PDF, el informe y el paquete». Cancelar y Emitir. |
| Cambió desde la vista previa | Abrir la vista previa, registrar un pago de una unidad de Las Cortaderas en otra pestaña, y emitir | No emite: «Cambió desde la vista previa de las HH:MM: entró 1 pago. El total pasa de $ … a $ …», con la casilla «Revisé las cifras y confirmo la emisión». Marcada, emite con las cifras de ahora. |
| Después de emitir | Igual | Va a Envío. El barrio queda trabado mientras emite (Los Aromos, 460 unidades: unos 2,5 segundos; Las Cortaderas, 340: menos de 2). |

### Envío

| Qué probar | Dónde | Qué tiene que pasar |
|---|---|---|
| La cadena | Con `pnpm worker:dev` andando, emitir Las Cortaderas › Envío | 1 Boletas en PDF («Preparando… N de 340», con su barra), 2 Informe del mes, 3 Paquete para el contador: se arman solos y terminan (en esta máquina, unos 85 s los PDF, 3 s el informe y 14 s el paquete). La página se actualiza sola mientras corren. |
| Lo que dice cada paso | Igual | «En cola: arranca en unos segundos»; si sigue en cola más de un minuto, pregunta si está andando el worker. Si el worker se corta en el medio, dice «Se interrumpió…» y el trabajo se retoma solo al minuto. Si falla, dice el motivo y aparece su botón. |
| Botones que esperan | Mientras un paso corre | Los botones de los otros pasos están apagados y dicen «Esperá a que termine …». |
| Cuota fija | Los Talas › Envío › «Armar el informe» | El informe se arma (antes fallaba siempre en un barrio de cuota fija). |
| Enviar | Paso 4 | «Enviar N boletas» con su diálogo (cuántas, cuántas unidades sin mail). Es la única acción a mano. |
| Cobrar | Paso $ | «N de M pagadas · vence el …» e «Ir a Cobros». |

### Cuota en Configuración

| Qué probar | Dónde | Qué tiene que pasar |
|---|---|---|
| La pantalla | Los Talas › Configuración del barrio › Cuota del barrio | Valor vigente con «vigente desde», unidades alcanzadas, el cambio programado (el aumento del seed), el formulario «Aplicar un aumento» y el historial (rige desde, cuota, cambio, estado, acta, cargó). |
| Estado y quién cargó | El historial | Columna Estado: Programada (el aumento de diciembre), Vigente (una sola) y Anterior. «Cargó»: el nombre de quien lo cargó, o «Carga inicial» en las filas sembradas. |
| Desde el mes | Un mes de cuota fija sin emitir › «Aplicar aumento desde este mes» | Abre la misma pantalla con ese mes elegido en «Rige desde»; «Cancelar» vuelve al mes. |
| Lo viejo | /…/liquidacion/cuota | Redirige a la cuota en Configuración. |

### «No cobrar el interés» (BL-031 a)

| Qué probar | Dónde | Qué tiene que pasar |
|---|---|---|
| Atenuados | Cobros › Registrar pago › No cobrar el interés | Con la casilla desmarcada, los dos renglones se ven atenuados y no se pueden tocar; al marcarla se habilitan. |
| Sin unidad ni fecha | Igual, recién abierto | Los dos renglones deshabilitados, sin importes que parpadeen, y un solo texto: «Elegí la unidad y la fecha del pago para ver el interés». Al elegir las dos, se habilitan con su importe; al cambiar la fecha queda el importe anterior hasta que llega el nuevo. |
| Lo anula un administrador | Entrar como el operador (Martín Coria) › Los Aromos › Cobros › Mza 2 · Lote 12 | En «Pagos», el pago de hoy con «$ … no cobrado» y, en Acciones, «Lo anula un administrador porque tiene interés condonado» en lugar de «Anular». Como la administración, «Anular». |

## Cómo se devenga, bonificación automática y cupón que cobra solo el mes (encargo 16)

Con el seed recién corrido (`pnpm db:seed` dice al final qué unidad es cada caso). Entrá como
administración del barrio (Valeria Ríos).

1. **Barrio Demo Los Espinillos → Configuración → «Cómo se devenga»:** los cuatro puntos. Rige:
   importe definido por la administración, igual para todas; bonificación sola del 7,5 % con tope de
   $ 20.000; el cupón cobra solo el mes. Abajo, el historial con el motivo y quién lo cargó.
   - Cambiá un punto, elegí «Rige desde» y escribí el motivo: se guarda y aparece en el historial.
   - «Rige desde» no deja elegir un mes emitido. Si lo forzás, dice que ese mes ya está emitido.
   - Con porcentaje, sin «Tope por unidad» no guarda. Sin motivo (o con menos de 15 letras), tampoco.
   - Con un usuario operador o contador, el panel se ve y no se puede cambiar.
2. **Los Espinillos → Liquidación → el mes en curso (sin emitir) → Boletas:** arriba, lo devengado en el
   mes, la deuda anterior con interés («no entra en los cupones») y «N de 45 con bonificación». En la
   lista, un renglón por unidad con lo que se sale de lo común y el total del cupón.
   - **«Ver quién»:** las que están al día (agrupadas), las que deben un mes y no la reciben, y la
     excepción «Quitar» ya cargada. Probá «Dársela igual» en una que debe y «Sacar la excepción»: las
     dos piden motivo. Después mirá la ficha de esa unidad en el Padrón: quedó en su historial.
   - Emití el mes: las excepciones quedan fijas y «Ver quién» pasa a solo lectura.
3. **Una boleta emitida de Los Espinillos (el mes anterior), de una unidad con deuda** (el seed nombra
   dos que deben los dos meses): «Total a pagar» es solo lo del mes; debajo, «Deuda de meses anteriores
   (no incluida en este cupón)», mes por mes, con su total aparte. La banda de arriba dice
   «Bonificación no aplicada» con el importe. El corte sale con año.
   - En una unidad al día: la bonificación va justo después de la expensa, y la deuda anterior en cero.
4. **Barrio Demo Las Tipas → Configuración → Cuota:** pide el **total del mes** ($ 4.800.000), no el
   importe por unidad. En la boleta emitida, el renglón de la expensa dice «Tu parte de $ 4.800.000,00
   del mes, por tu coeficiente (… %)». Las 24 boletas suman exactamente el total.
5. **Un barrio que no configuró nada (Los Aromos, Los Talas…):** todo igual que antes. El panel «Cómo
   se devenga» avisa que todavía no se configuró y muestra lo que rige hoy.
6. **Nuevo barrio:** después del alta, «Cómo se devenga» ya trae el origen de su modelo y «Solo el mes».

## Vencimientos del barrio y datos del padrón (encargo 15)

Con el seed recién corrido. Entrá como administración del barrio.

1. **Barrio Demo Los Talas → Configuración → Vencimientos:** día 10, segundo vencimiento a 3 días
   (mismo importe) y corte a 10 días del último. «Cambiar los vencimientos» los edita; rigen para los
   meses que se abran desde ahí. Con un usuario operador o contador, el panel se ve sin el botón.
2. **Liquidación → un mes de Los Talas:** el Resumen, la lista de meses y el Tablero dicen «se puede
   pagar hasta el …». En «Cambiar los vencimientos» del mes (sin emitir) está el campo «Se puede pagar
   hasta»: una fecha anterior al último vencimiento la rechaza; vacía deja el mes sin corte.
3. **Una boleta emitida de Los Talas:** debajo de los dos vencimientos, «Se puede pagar hasta el dd/mm».
4. **Nuevo barrio:** la figura «Sin entidad constituida» pide quién lo representa (delegado o
   comisión); CUIT y razón social quedan opcionales.
5. **Padrón de Los Talas:** columna «N.º de acción» (LT-0001…). En la ficha de una unidad con residente,
   el bloque «Residente o inquilino (solo informativo)». Editar: número de acción repetido en el barrio
   → «Ya hay otra unidad del barrio con ese número de acción».
6. **Padrón → «Padrón a una fecha»:** pedí una fecha y baja una planilla con una fila por titular vigente
   ese día. Para ver el cambio de titular: en una ficha, «Cambiar titular» con fecha de hace unos días,
   y bajá el padrón al día anterior y al del cambio.
