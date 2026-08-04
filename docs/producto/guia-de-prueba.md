# Guía de prueba de la aplicación

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

## Qué hay cargado

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

## Paso 1 — Entrar

Abrí `http://localhost:4000`. Te lleva sola a la pantalla de entrada.

**No hay contraseña**: se elige un personaje. Vas a ver tres tarjetas. Empezá con **Valeria Ríos**
(administradora del estudio) haciendo clic en su tarjeta.

Los otros dos se usan más adelante, en el paso 8.

## Paso 2 — Mis barrios

Caés en la lista de barrios que administra Valeria. Hay uno solo: **Barrio Demo Los Aromos**.
Hacé clic.

## Paso 3 — Mirar antes de tocar

Arriba vas a ver tres solapas: **Tablero · Padrón · Liquidación**.

- **Tablero**: la ficha del barrio y si se puede liquidar.
- **Padrón**: las 50 unidades con su propietario. Probá abrir el triangulito de una fila: ahí
  aparecen documento, CUIT, correo y teléfono. **No están en la grilla a propósito** — una captura
  de pantalla de 50 filas con nombre y DNI es un problema.
- **Liquidación**: la lista de períodos.

## Paso 4 — El período cerrado (para ver qué NO se puede hacer)

En **Liquidación**, entrá al período **emitido** (el del mes anterior). Fijate:

- Arriba, cuatro cifras: gastos cargados, gastos al liquidar, prorrateado del mes y total a cobrar.
  **Las tres primeras tienen que dar igual.** Esa es la pregunta "¿cierra el mes?".
- Abajo, las 50 unidades con su coeficiente y su boleta, y los cargos y descuentos por unidad.
- **No hay ningún formulario para cargar nada.** El período está emitido y es inmutable.

## Paso 5 — El período en borrador

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

## Paso 6 — Los documentos

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

## Paso 7 — Volver a empezar

`pnpm db:seed` deja todo como al principio: el mes anterior emitido, el mes en curso en borrador.

---

## Paso 8 — Probar el aislamiento (lo que más vale de esta demo)

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
