# ADR-0010 — Alta de barrio y padrón editable

- **Estado:** aceptado (implementado 2026-11-03, encargo T3, BL-009).
- **Especificación:** la maqueta aprobada `coordinacion-admin-barrios/maquetas/alta-barrio-padron.html`
  (6 pantallas y sus diálogos), portada sin reinterpretar. Sin PH.
- **Migración:** `0065_alta_barrio_padron` (solo esquema: no cambia ninguna fila existente).
- **Panel:** `legal-ph` (deuda y cambio de titular), `security-engineer` (panel obligatorio para leer
  Excel, regla EX-4; amenazas del resto), `code-reviewer`, `tester`.

---

## 1. Nuevo barrio

Desde **Mis barrios → Nuevo barrio** (`/barrios/nuevo`). Crea, en una transacción (`crearBarrio`):

- el **nodo de tenancía** colgado de la administración (la policy `tenant_node_ins` exige rol de
  administración sobre el padre). Los admin de la administración lo ven **por herencia**, sin
  membresías nuevas: no hizo falta tocar el modelo de tenancía ni de roles (BL-005);
- la **ficha** (`barrio`): nombre, razón social, CUIT, municipio (texto → slug), figura (SA o
  asociación civil; PH visible y deshabilitado), modelo (`modelo_liquidacion`: cuota fija o
  coeficiente), día de vencimiento, primer período, forma de identificar el pago (§3), medio impreso y
  prefijo del código de pago;
- el **mandato** desde la fecha cargada, con el acta opcional (subida pedida para la administración,
  verificada contra `subida_respaldo_solicitada`);
- el evento `alta_barrio` en `padron_evento`.

La mora y el orden de imputación **se heredan** de la configuración general de T1: no se copia nada.

**Los cuatro datos legales aceptan «A confirmar»** (adecuación al art. 2075, encuadre urbanístico,
servicios internos, reglamento inscripto): la base los exigía; `0065` les saca el `not null` y la
siembra de vigencias deja de versionar un eje sin valor. Configuración del barrio los muestra con un
chip «A confirmar». El tablero dice «A confirmar»; `faltantesParaViaEjecutiva` trata `null` como no
acreditado.

## 2. Quién escribe

Escriben **`admin_plataforma` y `admin_barrio`**, como en T1; los demás roles ven sin botones.

Las policies de `0003` sobre `unidad_funcional` y `obligado` **no se tocaron**: un test de RLS
existente (`codigo-pago.test.ts`) fija que un `operador` puede dar de alta una unidad, y cerrarlas
obligaba a cambiar su resultado esperado (motivo para frenar «a»). La regla la hace cumplir la base por
otro lado: **toda operación del padrón escribe su `padron_evento` en la misma transacción**, y esa tabla
solo la escriben esos dos roles (RLS + trigger que además fija `rol`, `creado_por` y `created_at`, y es
append-only). El servicio lo adelanta (`exigirAdministracion`) para que el mensaje sea claro.

## 3. Identificación del pago

| Forma | Qué se carga | Qué imprime la boleta |
|---|---|---|
| «Una cuenta para todo el barrio» (`cuenta_unica`) | CBU y alias del barrio | esa cuenta + el código de pago |
| «Una cuenta por unidad» (`cuenta_por_unidad`) | recaudador y cuenta padre; cada unidad, su CBU o alias | la cuenta de la unidad (también en el QR); sin cuenta propia, la cuenta padre + el código de pago |
| sin definir (barrios de antes de T3) | — | la cuenta de demostración de siempre |

- CBU **validado** (los dos verificadores, en la pantalla y en la base: `app.cbu_valido`) y alias de 6
  a 20 caracteres.
- **Una cuenta, una unidad, en toda la administración** (`app.uf_cuenta_unica`, con lock por cuenta):
  ni otra unidad ni la cuenta de un barrio de la misma administración. Solo lo carga la administración
  (el trigger mira barrios hermanos; sin esa guarda un operador lo usaría para preguntar si una cuenta
  existe: hallazgo G3). Excepción de aislamiento explícita: el mensaje no dice qué unidad ni qué barrio.
- Con cuenta única, los campos de cuenta de la unidad **no aparecen** en el alta, la ficha ni la
  planilla, y el servicio los rechaza.
- **Para T2** (conciliación): `idx_uf_cbu` e `idx_uf_alias` dejan la cuenta de la unidad lista como la
  señal más fuerte para saber de quién es un pago. T2 no se implementó.

**La boleta de muestra no puede quedar pagable** (bloqueante B1 del panel). `transferencia-qr` es un
medio de demostración: imprime una cuenta declarada **solo si está en la lista cerrada de cuentas de
demostración** (`inercia.ts`: 60 CBU y 60 alias fijos), y si el CBU impreso es el mismo que lleva el QR.
Cualquier otra —la cuenta real de una administración, sea de un banco o un CVU de billetera (prefijo
`000`)— hace fallar `verificar()` y esa boleta no se emite (compuerta 1) hasta que exista el medio real
del recaudador. La demo usa esas cuentas.

## 4. Padrón editable y la deuda

- **Agregar unidad**: varios titulares (carácter, CUIT/CUIL/DNI, mail), **una sola** marca «Recibe la
  boleta»; el código de pago lo asigna la base (`0059`). Un documento ya registrado en el barrio con
  otro nombre pide confirmación (`titular_ya_registrado`: «¿Es la misma persona?»).
- **Editar** sin manzana ni lote. **Saldo inicial** por unidad: entra **una vez**, en la primera boleta
  que se le emite, con el origen `carga_manual` que ya existía (deuda traída de afuera: `importe_exigible`
  la incluye). Después de emitida, la base no deja cambiarlo (`app.uf_saldo_inicial_una_vez`).
- **Cambiar titular** con fecha desde (no futura, posterior al inicio de los actuales), motivo (venta,
  sucesión, corrección, otro) y respaldo opcional: los titulares anteriores cierran **el día anterior**,
  el nuevo rige desde esa fecha y recibe la boleta. **La deuda sigue con la unidad**: la cuenta
  corriente no se mueve; el diálogo muestra cuánto debe.
- **Dar de baja** con motivo y detalle: no recibe boleta desde el próximo período sin emitir, conserva
  su historia, sus pagos y su deuda (que se sigue pudiendo cobrar), y su código no se reutiliza.
- **Historial** de la unidad en la ficha (`padron_evento`), con fecha, rol, motivo y respaldo.

**Panel `legal-ph`** (con `knowledge/cordoba/`): **no obliga a elegir entre dos comportamientos** (no se
activó el motivo «c»). Para SA y asociación civil no hay fuente cargada que diga que la deuda sigue al
lote (para SA, la base apunta a un vínculo societario y a una corriente jurisprudencial de obligación
personal del socio: CSJN 2007 «Haras del Sur»). El diseño es compatible con las dos lecturas **si el
historial de titulares no se pierde nunca** —se cumple: los vínculos se cierran, no se borran, y cada
liquidación guarda a quién se le emitió (`liquidacion.obligado_id`)—. Observaciones adoptadas: la
pantalla **no** dice «por ley la deuda sigue al lote»; se registra motivo, respaldo, rol y la fecha desde
la que rige separada de la del registro. Nada en `knowledge/` obliga a exigir libre deuda. **Pendiente**:
cargar la LGS sobre transferencia de acciones, un estatuto tipo de barrio-SA y el régimen de
asociaciones civiles (CCyC + IPJ Córdoba); y revisar si un cambio de poseedor/tenedor debería cerrar a
todos los cotitulares (hoy cierra a todos, como pide la maqueta). Validar con profesional matriculado.

**Nada de esto toca una liquidación emitida** (motivo «e»): agregar o dar de baja cambia qué unidades
entran en la **próxima generación** de un período no emitido; lo emitido es inmutable (`0030`).

## 5. Coeficientes

- Versiones que **rigen desde un período**; la generación del borrador usa **la que rige para el mes**
  (y se vuelve a resolver en cada regeneración, como la cuota fija). Si ninguna rige todavía para ese
  mes, la vigente del barrio (la regla de antes: así siguen los tests que cargan la versión con fecha de
  hoy y liquidan un mes anterior).
- Tres formas: **por superficie**, **iguales por lote** o **por planilla** (manzana, lote, coeficiente).
  En las tres, **9 decimales y el resto a la última unidad**: la suma da 1 exacto
  (`shared/coeficientes.ts`; propiedades fast-check: suma 1, nunca ≤ 0, determinístico).
- Una versión no rige desde un período ya emitido ni antes que la vigente; una cerrada no se modifica
  (`0003`). Una usada para liquidar se marca así en la pantalla.
- **Unidades activas sin coeficiente**: el borrador no se genera (`unidades_sin_coeficiente`, con hasta
  tres unidades nombradas) y la pantalla de coeficientes lo avisa.
- En un barrio de **cuota fija** el coeficiente es «partes iguales» (lo usan las extraordinarias): al
  agregar unidades se arma solo una versión nueva con todas, desde el próximo período (con su evento).
  La cuota de la unidad nueva se define en la pantalla de la cuota («unidades sin importe»).

## 6. La planilla

Importar Excel (`.xlsx`) o CSV, hasta 5.000 filas, con el patrón portado de la importación de padrón de
otro sistema de la casa: vista previa por unidad con **Alta**, **Corrige**, **Sin cambios**, **A
revisar** y **Con error**; **todo o nada**. Columnas: `manzana · lote · superficie_m2 · estado ·
nomenclatura · titular · caracter · cuit_o_dni · recibe_boleta · mail · telefono · cbu_unidad ·
alias_unidad · saldo_inicial` (las de cuenta solo con cuenta por unidad). Una fila por titular; los
datos de la unidad en la primera. El cambio de titular no se hace por planilla. **Exportar** con las
mismas columnas (lo exportado se vuelve a importar «sin cambios»; queda registrado quién exportó) y
**plantilla** con una fila inventada.

- La subida va por un route handler (`app/api/padron/planilla`) y no por una acción (el tope de una
  acción es 1 MB): sesión y rol **antes** de leer el cuerpo, y el cuerpo se lee contando bytes (G4). La
  confirmación vuelve a leer el archivo y a planificar contra el padrón de ese momento.
- **Leer Excel** (EX-4 lo prohibía; panel del 2026-11-03): un solo archivo lo hace
  (`servidor/planilla/padron-xlsx.ts`). Antes de `exceljs`: bytes mágicos, cada entrada del ZIP
  **descomprimida de verdad con tope** y comparada con lo declarado (B2: JSZip descomprime y recién
  después compara), sin ZIP64, cifrado, métodos raros, nombres repetidos, políglotas ni `<!DOCTYPE`,
  15 MB descomprimidos, 150.000 celdas y textos compartidos, una lectura por vez en el proceso. Celdas a
  texto sin evaluar nada; un número de más de 15 dígitos (un CBU guardado como número) se rechaza;
  NFC y sin caracteres de control ni de dirección (G1). CSV: UTF-8 o Windows-1252, UTF-16 rechazado.
- El saneado anti-fórmula de la exportación agrega `'` delante de `+`, `=`, `-`, `@`; la lectura lo saca.

## 7. Volumen

`tests/volumen/padron-planilla.test.ts`: vista previa y confirmación de 700 unidades (770 titulares).
Medido en local: 0,12–0,19 s y 3,6 s (topes 2 s y 15 s). La confirmación tardaba 10,9 s: el trigger que
numera el código de pago (`0059`) evaluaba la RLS dos veces por fila; pasó a `security definer` (`0065`
§6: numera, no autoriza).

## 8. Demo

Seed: **Barrio Demo Los Ceibos** (SA, cuota fija, cuenta por unidad), creado al final por el mismo camino
que la pantalla, con 40 unidades (Mza 1 · Lote 4 con dos titulares y cuenta propia; algunas sin cuenta
propia; dos con saldo inicial) y el mes en curso emitido. Los cuatro barrios de antes no cambian (mismas
cifras). La planilla para importar en vivo: `docs/demo/padron-de-ejemplo.csv` (30 unidades, cuentas de la
lista de demostración; la cuenta padre para el barrio nuevo es `cuentaDeDemostracion(60)`,
`0000003199999990000603`).

## 9. Límites conocidos y pendientes

- La lectura de Excel no corre en un `worker_thread` con `resourceLimits` (lo sugirió el panel); con
  los topes del §6 el peor caso aceptado son ~150.000 celdas.
- La vista previa de 5.000 filas se dibuja entera, sin paginar.
- Una administración **sin ningún barrio** no tiene de dónde leer «hoy» ni la mora para el formulario
  del alta: el primer período pasa a un campo de mes y la nota de la mora no muestra valores.
- La boleta ya emitida que se vuelve a generar lee la cuenta **actual** de la unidad (como el resto de
  los datos de la vista): congelar la cuenta en la liquidación queda para cuando haya medio real.
- Los datos legales se cargan en el alta; editarlos después no está en este encargo.
- Una unidad agregada en un barrio de cuota fija queda sin importe hasta que se vuelve a definir la
  cuota (la pantalla de la cuota lo avisa).
- **Dos unidades con el CBU cruzado** no se corrigen con una sola planilla (se actualiza unidad por
  unidad y la regla de cuenta única ve la cuenta en la otra): se hace en dos pasos. Fijado en
  `padron-romper.test.ts` como `it.fails`.
- La vista previa no mira las cuentas que ya están en la base: un CBU repetido contra un barrio hermano
  aparece recién al confirmar (`cuenta_repetida`, y no se importa nada).
- Un cambio de titular no puede tener fecha anterior al alta de los titulares actuales (salvo con
  «Corrección de datos», el mismo día): una venta anterior a la carga del padrón se registra con la
  fecha de carga.
- Una persona sin documento que aparece en varias unidades de la planilla queda como varias personas.
- Una confirmación de «¿Es la misma persona?» al agregar una unidad vale para todos sus titulares.
- Con unidades dadas de baja, el coeficiente que imprime la boleta es el de la versión, sin normalizar
  (el reparto sí normaliza).
- El saldo inicial entra solo cuando el borrador se genera con saldo calculado (la pantalla y la demo
  lo hacen así); una carga manual de saldos por script no lo toma. Un pago a cuenta anterior a la
  primera boleta queda en la cuenta corriente pero no se imprime en esa primera boleta.
