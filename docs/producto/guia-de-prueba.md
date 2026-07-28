# Guía de prueba de la aplicación

> Escrita mirando la pantalla, no el código. Si algo no coincide con lo que ves, la guía está vieja:
> avisá. Estado verificado el 2026-07-28 con el seed recién corrido.

## Antes de empezar

Si la aplicación no responde en `http://localhost:4000`:

```
docker compose --profile app up -d
```

Si querés volver todo al estado inicial en cualquier momento (borra y recrea el barrio de
demostración, sin tocar nada más):

```
pnpm db:seed
```

## Qué hay cargado

**Un barrio:** *Barrio Demo Los Aromos*, 50 unidades, PH especial.

**Dos períodos:**

| Período | Estado | Qué tiene |
|---|---|---|
| **06/2026** | Emitida | 5 gastos por $9.875.500 · 50 liquidaciones · cargos y bonificaciones aplicadas |
| **07/2026** | **Borrador** | 3 gastos por $6.520.250 (uno extraordinario **sin acta**) · 2 cargos aplicados · **0 liquidaciones** |

El de julio es el que se puede tocar. El de junio está cerrado a propósito, para que veas cómo se
comporta un período emitido.

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

En **Liquidación**, entrá a **06/2026**. Fijate:

- Arriba, cuatro cifras: gastos cargados, gastos al liquidar, prorrateado del mes y total a cobrar.
  **Las tres primeras tienen que dar igual.** Esa es la pregunta "¿cierra el mes?".
- Abajo, las 50 unidades con su coeficiente y su boleta, y los cargos y descuentos por unidad.
- **No hay ningún formulario para cargar nada.** El período está emitido y es inmutable.

## Paso 5 — El período en borrador

Volvé a **Liquidación** y entrá a **07/2026**. Ahora sí aparecen los cuatro pasos arriba:

> **1** Gastos del mes · **2** Cargos y descuentos · **3** Revisar y emitir · **4** Resumen

### 5.a — Cargar un gasto

Andá al paso **1 · Gastos del mes**. Ya hay tres cargados. Agregá uno:

- Concepto: elegí cualquiera de la lista.
- Descripción: lo que quieras.
- Importe: por ejemplo `250000`.

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

Todavía **no se bajan desde la pantalla**: es lo único que falta del recorrido. Por ahora se generan
por comando y aparecen en `tmp/boletas`:

```
pnpm demo:boleta
```

## Paso 7 — Volver a empezar

`pnpm db:seed` deja todo como al principio: junio emitido, julio en borrador.

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
