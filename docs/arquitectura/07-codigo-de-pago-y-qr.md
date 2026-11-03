# ADR-0007 — El código de pago de la UF, y el QR contra EMVCo

- **Estado:** aceptado (implementado 2026-11-02, preparación de T2).
- **Alcance:** BL-012 (código de pago por UF) y BL-013 (verificación del payload del QR de
  transferencia contra EMVCo / Transferencias 3.0).
- **Migración:** `0059_codigo_pago_uf`.
- **Se encadena con:** ADR-0006 (el orden de imputación decide a qué boleta va un pago que llega
  identificado por la unidad), ADR-0001 (el papel es un registro: lo que se imprime se puede
  explicar).

---

## 1. El código de pago: un número estable, un formato configurable

Cada UF tiene un **número** dentro de su barrio, `unidad_funcional.codigo_pago_numero`:

- Lo asigna la base al dar de alta la unidad, **siempre**: si el insert trae otro número, se ignora.
  Un contador por barrio, `codigo_pago_secuencia`, con el mismo mecanismo que `recibo_secuencia`, así
  que un insert de varias filas y dos altas concurrentes numeran bien.
- Es único dentro del barrio (`uq_uf_barrio_codigo_pago`) y **no cambia nunca**: un trigger lo
  rechaza, y no depende del titular.
- Las UF que ya existían lo recibieron en la migración, en un orden **determinístico**: manzana y lote
  en orden natural ("2" antes que "10") y después el id.

Lo que se imprime es `codigoDePago(numero, formato)` (`@admin-barrios/shared/codigo-pago`):
**prefijo + número con ceros a la izquierda hasta el largo + separador + dígito verificador**. El
formato es configuración del barrio (`barrio.codigo_pago_largo`, `_prefijo`, `_separador`; inicial
6 dígitos, sin prefijo, guion).

**Por qué separar número y formato:** para alinear el código con el identificador de cliente de una
red de cobranza (p. ej. SIRO) alcanza con cambiar el largo o el prefijo del barrio. **No se migra
ningún dato**: el número de cada UF queda igual. Las tres columnas del formato nacen cerradas para
`app_request` (mismo criterio que `auditor_exporta_movimientos`, `0050`): cambiar cómo se escribe el
código en todas las boletas de un barrio es configuración de la cuenta.

**Dígito verificador: Damm.** Detecta todo error en un solo dígito y toda transposición de dos dígitos
contiguos, y el verificador es siempre un dígito 0-9. Módulo 11 da "10" en uno de cada once números
(hay que imprimir una X o saltear números), y Luhn no detecta la transposición 09↔90. Se calcula
sobre prefijo + número, así un error en cualquier dígito impreso se detecta. Tests de propiedades
(`codigo-pago.test.ts`, 1000 casos cada uno): determinístico, único dentro del barrio (y se lee de
vuelta), un dígito mal se detecta, una transposición contigua se detecta, numérico y con el largo
exacto.

## 2. Dónde va

- **En todos los medios**, como dato de texto «Código de pago» con la nota «Indicá este código en la
  transferencia».
- **En transferencia-qr reemplaza a la «Referencia»**, que era el número de comprobante. El
  comprobante cambia todos los meses y el vecino que agenda la transferencia lo arrastra mal; el
  código es de la unidad y no cambia, y con él el pago se imputa a la unidad según el orden de
  imputación del barrio (ADR-0006). El comprobante sigue siendo obligatorio y va en el QR.
- **En el QR**, campo 62 (datos adicionales): `05` (etiqueta de referencia) = el código, solo dígitos;
  `01` (número de factura) = el comprobante. Antes el comentario del generador decía "y referencia"
  pero el payload no la llevaba.
- **En generico-demo** el código ocupa el renglón que era del «Convenio»: el cupón con troquel y
  código de barras no tiene lugar para un quinto renglón (el humo del PDF lo detectó: la zona del
  detalle se quedaba sin alto y la boleta no se emitía), y el número de convenio ya está impreso dos
  veces, en el código de barras legible y al principio del código de pago electrónico.

## 3. El QR contra EMVCo (BL-013)

Verificado con un lector TLV propio (`cobranza/emvco.ts`, `leerEmv`), no a ojo:

- **Moneda `032`** (ARS): el generador estaba bien. El error era **solo del fixture** del test «un QR
  sobre una cuenta que podría existir», que tenía la moneda en `203`. El fixture ahora se arma con los
  mismos helpers que el generador.
- **CRC-16/CCITT-FALSE** (polinomio 0x1021, valor inicial 0xFFFF) sobre todo el payload más `6304`,
  cuatro dígitos hex en mayúscula: correcto, con el vector de control `"123456789"` → `29B1` en test.
- Estructura TLV sin desbordes ni tags repetidos, tags en orden y `63` al final: test de propiedades
  sobre cualquier importe, código y comprobante.

**Lo que NO cumple EMVCo, a propósito y anotado:** faltan los campos obligatorios `52` (MCC), `58`
(país), `59` (nombre del comercio) y `60` (ciudad). El generador los deja afuera desde su origen para
que el QR entre en 25 mm (doc 09 §E.10.1) y porque el CVU es inexistente: es un QR de demostración que
la billetera lee y rechaza. **El día que haya un convenio real**, el adapter de ese medio tiene que
agregarlos; queda como decisión de esa tanda, no de esta.

El CBU y el CVU siguen siendo inventados e inválidos a propósito, como dice el adaptador.

## 4. Reglas que salen de que el código sea único DENTRO del barrio

El encargo pide unicidad dentro del barrio, y así quedó. Dos consecuencias, anotadas por la revisión
de código:

- **Con el formato inicial (sin prefijo) el código no identifica al barrio**: la UF 174 del barrio A y
  la del barrio B imprimen las dos `000174-d`. Si una misma cuenta recauda para más de un barrio,
  **cada barrio tiene que tener un prefijo distinto**, y es exactamente para eso que existe el prefijo
  (el identificador de cliente de una red ya trae el del convenio). Leer un código
  (`leerCodigoDePago`) exige saber de qué barrio viene: recibe el formato del barrio y no hay una
  lectura "global". Cuando llegue la imputación desde el extracto (T2), lo resuelve la cuenta del
  barrio: a qué cuenta entró el dinero.
- **Cambiar el largo o el prefijo cambia lo impreso** desde la boleta siguiente. El número de cada UF
  no cambia ("sin migrar datos" es eso), pero el código viejo que un vecino agendó en su home banking
  deja de leerse con el formato nuevo. Un cambio de formato se avisa a los vecinos; no es silencioso.

## 5. Pendiente para `ux-designer` — resuelto en ADR-0008 §5

La nota de «Pago electrónico» pasó a «Solo para LINK y Pago Mis Cuentas» (2026-11-02). Lo que sigue es
el planteo original.

En el cupón de `generico-demo` conviven «Pago electrónico» (sale del comprobante y cambia todos los
meses: es el del convenio de demostración) y «Código de pago» (de la unidad, fijo). Un vecino no tiene
cómo saber cuál va en el concepto de una transferencia: la nota lo dice solo en el segundo. Con una
red real (SIRO), el código electrónico de la red **es** el identificador de cliente y los dos se
vuelven uno; hasta entonces, revisar la redacción con `ux-designer`.

## 6. Revisión de `code-reviewer` (2026-11-02)

Aplicado: el QR solo admite ASCII imprimible y el comprobante entra en el `01` solo si es ASCII de
hasta 25 caracteres (truncarlo podía hacer que dos boletas compartieran el `01`, y "Nº" rompía el
largo); la verificación compara el subcampo `05` leído con `leerTlv` contra lo impreso (antes buscaba
los dígitos en toda la cadena); `generico-demo` también exige el código; el relleno de `0059` desempata
con `collate "C"`; el largo de un barrio no se puede achicar por debajo del número más alto; el
contador va con `on delete cascade`; la subida verifica la configuración antes de registrar el pedido
(sin filas huérfanas); el aviso del `.env` no se dispara si el archivo no existe.
