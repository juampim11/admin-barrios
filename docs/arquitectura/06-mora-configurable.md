# ADR-0006 — La mora configurable: dos niveles, vigencias con motivo, y el interés día por día

- **Estado:** aceptado (implementado 2026-11-02, tanda T1).
- **Alcance:** los parámetros de interés por mora y de imputación de pagos; dónde viven, cómo se
  heredan, quién los cambia, cómo los usa la liquidación y cómo se muestran (configuración general,
  configuración del barrio, bloque de mora de la revisión y puesto del tablero).
- **Especificación:** la maqueta aprobada `coordinacion-admin-barrios/maquetas/mora-parametros.html`
  (tres pantallas). El modelo y el dominio de plata se **portaron** de un sistema hermano de
  cobranzas (empresa → obra, con vigencias y motivo); acá es **administración → barrio**. Se portó el
  código y el diseño, ningún dato ni texto de ese sistema.
- **Panel previo:** `arquitecto-software`, `dba-data`, `legal-ph` (2026-11-02), y las decisiones del
  titular del mismo día sobre lo que el panel dejó abierto.
- **Migraciones:** `0056` (formas), `0057` (reglas, RLS, migración de datos, `resolver_imputacion`),
  `0058` (se van `tasa_mora`, `app.tasa_mora_vigente` y `barrio.orden_imputacion`).
- **Se encadena con:** ADR-0000 (portabilidad y RLS multi-tenant), ADR-0002 (la puerta única a la
  base), ADR-0003 (sistema de UI: a un rol no se le muestran acciones que no puede ejecutar).

---

## 1. El problema

Hasta esta tanda, la mora tenía **dos fuentes** que no se hablaban y un hueco:

- `tasa_mora` por barrio, versionada a mano (`vigente_hasta` sin trigger que cierre la anterior: podía
  tener huecos, solapes y empates de fecha), y resuelta **a la fecha en que se generaba el borrador**.
  Regenerar el borrador otro día podía cambiar el interés (hallazgo del panel de arquitectura).
- `barrio.orden_imputacion`, una columna sin historia y sin default.
- Sin tasa, la liquidación salía con **"mora pendiente de definición"**: un hueco, no una decisión.

Y nada se podía configurar a nivel de la administración, que es el cliente real del producto (un
estudio con 1..N barrios).

## 2. Decisión: dos niveles, un nodo, append-only

- **Una tabla de valores, `parametro_valor`, con UNA columna `nodo_id`** → `tenant_node`, que es la
  administración (tipo `administrador`) o el barrio. La administración de un barrio es su **padre en
  la tenancía** y se resuelve al consultar (panel de arquitectura, CAMBIO 1): guardarla en cada fila
  del barrio sería una segunda fuente de verdad que queda vieja el día que el barrio cambia de padre.
- **Append-only.** Un valor no se edita ni se borra: se agrega uno nuevo con `vigente_desde` y
  **motivo** (≥ 15 caracteres). Con la misma vigencia gana el último creado (`orden`).
- **`valor` NULL solo en el barrio**: "vuelve a heredar de la administración".
- **Anular un cambio PROGRAMADO** (que todavía no rige) es una fila en `parametro_anulacion`, también
  append-only. Lo que ya rige no se anula: se fija otro valor desde hoy.
- **«Volver al valor general»** inserta un NULL desde la fecha elegida y anula, con el mismo motivo,
  los valores propios programados para después (si no, el programado seguiría rigiendo).
- **Nada es retroactivo.** `app.fijar_parametro` rechaza una fecha anterior a `current_date`. Lo
  emitido o imputado antes no cambia.
- **Sin `ENABLE ALWAYS`** en los triggers de append-only — desvío consciente del modelo portado
  (panel `dba-data`): `session_replication_role` es SUSET, ningún rol de la aplicación puede activarlo
  ni tiene grant de update/delete, y ALWAYS solo frenaría a la limpieza de los tests.

## 3. Decisión: la resolución vive en la base, y solo ahí

`app.parametro_resuelto(nodo, clave, fecha)` devuelve el valor, su **origen** (`barrio` |
`administracion`), desde cuándo rige, cómo se cargó (`usuario` | `inicial` | `migrado`) y el respaldo.
Barrio primero; si no tiene o dice "vuelve a heredar", la administración; si tampoco, **cero filas**
(quien llama decide: la imputación automática falla cerrada, la pantalla dice "sin definir").

- No hay una segunda implementación en TypeScript: las pantallas listan filas (historial), pero el
  valor vigente y su origen salen siempre de la función.
- La lectura pasa por funciones `security definer` porque quien es miembro **solo del barrio** no
  tiene a la administración en `readable_tenant_ids()` (panel, CAMBIO 2); la policy de SELECT de las
  tablas suma `app.readable_admin_ancestros()`, que abre **solo las filas de parámetros** de ese nodo.

## 4. Decisión: quién cambia qué

- **General** (nodo administración): `admin_plataforma` o `admin_barrio` con membresía en la
  administración.
- **Barrio**: los mismos roles con alcance sobre el barrio. Un `admin_barrio` de un solo barrio edita
  el suyo y **ve** la configuración general sin poder tocarla.
- **El `operador` queda afuera**, aunque escribía en `tasa_mora`: es un parámetro de dinero (mismo
  criterio que el candado de `orden_imputacion` en `0047`/`0050`).
- Contador, auditor y operador **ven sin botones** (ADR-0003 §6.4). La pantalla recibe `puedeEditar`
  calculado por la base (`app.puede_editar_parametros`), no una lista de roles en TypeScript.
- `app_request` no tiene grant de insert/update/delete sobre las tablas: solo `execute` sobre
  `app.fijar_parametro` y `app.anular_parametro_programado` (dueño `app_job`, mismo patrón que
  `resolver_imputacion`), con la guarda de permisos adentro y un candado advisory por
  (administración, clave).

## 5. Decisiones técnicas que el titular delegó (diferencias entre arquitecto y dba)

| Tema | Arquitecto | DBA | **Decisión** y motivo |
|---|---|---|---|
| Dónde se guardan los parámetros usados | en el período | en la liquidación | **En la liquidación** (`liquidacion.parametros_mora jsonb`). Ya se congela entera al emitir (`trg_liquidacion_editable`), así que lo usado queda inmutable sin tocar la lista de columnas congeladas del período; y lleva además el desglose compensatorio/punitorio de cada unidad. |
| Cómo se guarda «No se cobra» | `interes_mora = 0` | NULL + marca | **NULL + `mora_no_se_cobra`**. "No se calculó porque se decidió no cobrar" no es "se calculó y dio cero", y así **ninguna cifra de dinero** de las liquidaciones existentes ni de sus tests cambió de valor: solo cambió la marca que explica el NULL. Check nuevo `liquidacion_mora_estado_chk` (tres estados excluyentes). |
| Unidad de la tasa | fracción | porcentaje | **Fracción con hasta seis decimales** (`"0.025"` = 2,5 %): la misma unidad que `tasa_mora.tasa_mensual` y que `calcularMora`. Es lo que hace posible la paridad al centavo. La conversión a porcentaje vive en un solo lugar (`shared/parametros-mora.ts`). |

## 6. El interés: día por día, truncado una sola vez

`@admin-barrios/shared/interes-mora` (dominio puro, portado del cálculo con vigencias):

1. Interés simple sobre el saldo vencido, mes comercial de 30 días, en la ventana
   `(fechaCorte − díasDeAtraso, fechaCorte]`.
2. **Cada día devenga con la tasa (compensatoria + punitoria) y el «cobra» vigentes ESE día.** Una
   tasa nueva no se aplica a días anteriores a su fecha. Resolver todo una vez al vencimiento habría
   sido retroactivo (panel de arquitectura). La maqueta decía "se aplica desde la primera liquidación
   con vencimiento a partir de la fecha elegida": se cumple igual, porque un cambio del día X recién
   aparece en boletas que vencen después de X.
3. Gracia, forma de la gracia y tolerancia: **las vigentes al inicio de la ventana** (CAMBIO 3 del
   arquitecto: el saldo anterior es un monto agrupado, sin vencimiento propio).
4. **Se trunca una sola vez al final**, como `calcularMora`: nunca se cobra un centavo no devengado. El
   sistema portado redondeaba por tramo; eso no se portó. La ayuda de la maqueta ("se redondea") se
   corrigió: "se calcula al centavo, sin redondear hacia arriba".
5. La punitoria se desglosa: compensatorio = truncado de la parte compensatoria; punitorio = la
   diferencia, así las partes suman exacto el total. Sin columna nueva: va en `parametros_mora`.

**Paridad:** con «Cobra: Sí», gracia 0, tolerancia 0, punitoria 0 y una sola vigencia, el resultado es
**idéntico al centavo** al de `calcularMora` — propiedad testeada con `fast-check`
(`interes-mora.test.ts`), junto con: nunca negativo, monótono en días y en tasa, «Cobra: No» ⇒ no se
calcula, partir la ventana en un cambio da la suma exacta, y un cambio posterior al corte no mueve nada.

**Fecha de referencia** de la liquidación: `fechaCorteMora`; sin días de atraso, el primer vencimiento
del período; sin vencimiento, el primer día del mes. Ya no `current_date`.

## 7. Qué pasó con `tasa_mora` y `barrio.orden_imputacion`

Una sola fuente de verdad: `parametro_valor`. `0057` migra, `0058` borra.

- **Administraciones existentes**: «Valor migrado» desde el 2000-01-01 con el comportamiento de antes
  — «Cobra: No», tasa 0, punitoria 0, gracia 0, tolerancia $ 0. **Sin `imputacion.orden`**: hoy un
  barrio sin criterio no imputa automáticamente, y así sigue hasta que la administración lo fije.
- **`tasa_mora`** → filas propias del barrio, evaluando **la función vieja** en cada punto de quiebre
  (cada `vigente_desde` y cada `vigente_hasta`, que era exclusivo): equivalente por construcción,
  huecos y solapes incluidos. Donde había tasa, el barrio queda con «Cobra: Sí» y esa tasa (y su
  documento como respaldo, si lo tenía); donde no, vuelve a heredar. Prechequeo: si hay dos versiones
  del mismo barrio desde el mismo día, o una tasa > 100 % mensual, **la migración frena** (no se adivina
  cuál valía). En los datos del entorno local no hubo ninguno.
- **`barrio.orden_imputacion`** no nulo → fila propia del barrio desde 2000-01-01;
  `fifo_estricto` → `capital_primero`, que es exactamente lo que ya hacía.
- `app.resolver_imputacion` lee el orden **vigente a la fecha del pago** (`pago.fecha`, la fecha del
  hecho: re-imputar después da lo mismo).

## 8. Valores iniciales de una administración NUEVA (decisión del titular, con `legal-ph`)

Los siembra un trigger al crear el nodo administrador (producción no corre el seed):

| Parámetro | Inicial |
|---|---|
| Cobra interés por mora | No |
| Tasa compensatoria | 0 (pasar «Cobra» a Sí exige una tasa > 0: lo rechaza la base) |
| Tasa punitoria | 0 % |
| Días de gracia / forma | 5 / corre el inicio |
| Tolerancia de saldado | $ 100 |
| Orden de imputación | Intereses primero, después la deuda más antigua |

Al pasar «Cobra interés» a Sí, la pantalla pide **confirmación** diciendo qué orden de imputación rige
y cómo cambiarlo (código `activar_interes_requiere_confirmacion`).

## 9. Lo que dijo `legal-ph` (jurisdicción activa: Córdoba)

- **No están cargados** en `knowledge/cordoba/` los arts. 768-771, 793-794 ni 900-903 del CCyC, y
  `nacional/04-regimen-expensas.md` §7 dice [A VERIFICAR] que el régimen de intereses de expensas sale
  del reglamento o de la asamblea. Por eso **los valores iniciales son decisiones de producto, no
  conclusiones legales**, y **ninguna pantalla cita un artículo** (se sacó "art. 903" de la opción).
- **Orden de imputación:** se puede ofrecer configurable (todo lo de mora "viene del reglamento"). Si
  "capital primero" es válido frente al art. 903: sin fuente cargada. Se ofrecen **dos** opciones
  porque el sistema ejecuta dos comportamientos (`0036`).
- **Tasa punitoria:** se ofrece, inicial 0 %, con ayuda: "Solo si el reglamento o el estatuto del
  barrio la prevé… Una tasa total muy alta puede ser reducida por un juez".
- **Faltaba un dato obligatorio: el respaldo de la tasa.** Al fijar o cambiar la tasa compensatoria o
  la punitoria, en los dos niveles: tipo (Reglamento / Acta de asamblea / Acta de comisión / Otro),
  referencia de texto obligatoria y adjunto opcional (almacenamiento existente, clave
  `barrios/{id}/…` o `administraciones/{id}/parametros/respaldos/…`). Se muestra en el historial y en
  la revisión.
- "Moroso desde" / "Gestión legal desde" chocan con `lenguaje-prohibido.ts` y con la regla de no
  afirmar ejecutividad. **No se implementaron** (ver §10).
- Pendiente de fuente: cargar en `knowledge/cordoba/nacional/` los arts. 768-771, 793-794 y 900-903
  y la jurisprudencia de Córdoba sobre morigeración. *Validar con profesional matriculado.*

## 10. Lo que NO entra, y por qué

- **«Moroso desde» y «Gestión legal desde»**: el encargo los condicionaba a que existiera hoy un
  cálculo de morosidad con umbrales fijos en el código. **No existe**: el listado de mora usa tramos
  de antigüedad en **períodos** (`TRAMOS_ANTIGUEDAD`, `vista-listado-mora.ts`), no en días, y no hay
  ninguna clasificación Vencido/Moroso/Ejecutable. Además legal-ph objeta los rótulos.
- **El chip y el filtro «A confirmar»** de la maqueta: eran notas para el panel, ya resuelto.
- **Mora por cuota con su propio vencimiento** (el modelo portado lo tiene): acá el saldo anterior es
  un monto agrupado por unidad. El día que exista la cuenta corriente con vencimientos, la ventana se
  vuelve por deuda y el snapshot baja a ese nivel.

## 11. Riesgo conocido (sin resolver, a propósito)

**Cambio de administración de un barrio.** La herencia sigue al padre **actual** en la tenancía. Lo ya
liquidado está protegido por `parametros_mora` (congelado al emitir), pero **re-imputar pagos viejos**
usaría el orden de imputación de la administración nueva si el barrio no tiene uno propio. Resolverlo
pediría resolver por `mandato_administracion` a la fecha. Queda anotado; no hay hoy un flujo de cambio
de administración en el producto.

## 12. Revisión de `security-engineer` (2026-11-02)

Veredicto: apto, sin hallazgos críticos ni altos. Lo que se arregló antes del PR:

- **M1 — las guardas también en la tabla.** `app_job` tiene insert directo; un job con un bug no puede
  escribir un valor retroactivo ni sin firma: el trigger de `parametro_valor` exige, para los roles de
  la aplicación, `carga = 'usuario'`, firma de la sesión y fecha ≥ hoy. Una anulación hereda el nodo de
  su fila y solo cae sobre lo que todavía no rige, la escriba quien la escriba.
- **M2 — lo que una liquidación emitida usó no se anula.** La fecha de referencia de una liquidación
  puede ser futura (su vencimiento), así que una emitida puede haber usado un valor programado. Anularlo
  dejaría la trazabilidad citando una fila anulada: `anular_parametro_programado` lo rechaza y pide
  fijar un valor nuevo.
- **M3 — tests de aislamiento**: otra administración no fija ni anula; resolver un nodo ajeno o
  inexistente da el mismo mensaje; un adjunto pedido para otro nodo no sirve; un subsector no tiene
  parámetros.
- **B1** el permiso se verifica antes del pedido de confirmación; **B2** el candado es por
  (administración, familia de la clave), así «Cobra: Sí» y la tasa se serializan; **B3** la subida de un
  respaldo solo para nodos administración o barrio.

Aceptados y anotados, sin arreglo en esta tanda:

- **B4** — `fijar` no verifica que el objeto del adjunto exista de verdad ni su tipo (lo hace el POST
  presignado con `eq` de content-type); y `creado_por`/`solicitado_por` (UUIDs del personal) quedan
  legibles para los miembros de un barrio. La pantalla no los muestra.
- **B5** — `current_date` depende del huso de la sesión: con la base en UTC, de 21 a 24 h de Argentina
  "hoy" ya es mañana y no se puede fijar desde el hoy argentino. No abre retroactividad (UTC va
  adelante). Va a la tanda de infraestructura: fijar `timezone` en la base o en los roles.

## 13. Revisión de `code-reviewer` (2026-11-02)

Arreglado antes del PR:

1. **(Alta) La boleta imprimía una fórmula que no daba el interés cobrado.** `tasa_mora_aplicada` era
   solo la compensatoria y `dias_atraso` todos los días de la ventana. Ahora la tasa guardada es la
   **total** (compensatoria + punitoria) y los días son los que **devengaron** (después de la gracia,
   sin los días con «Cobra: No»): "Base · X % · N días" reproduce la cifra. Si en la ventana rigió más
   de una tasa no hay una sola que la reproduzca, y va NULL: la boleta no imprime una tasa que
   mentiría (el detalle queda en `parametros_mora`). Test: 50.000 × 4 % × 25/30 = 1.666,66.
2. **(Media) «Cobra: Sí» con tasa 0** se podía armar bajando la tasa o volviendo a heredar un 0.
   `fijar_parametro` lo rechaza (en el nodo y, si es la administración, en cada barrio que hereda).
3. **(Media) Borrador → anular → emitir** dejaba una liquidación emitida citando una fila anulada.
   `emitirPeriodo` rechaza si un parámetro que el borrador usó se anuló después de generarlo, y pide
   regenerar.
4. Los tramos guardados arrancan el primer día de la ventana y se colapsan si no cambió nada; la nota
   de la revisión muestra compensatoria y punitoria. La ayuda de la fecha distingue las claves que
   pesan día a día de las que se toman al inicio del atraso; el campo de tasa acepta y dice "2,5 o
   2.5"; un registro de parámetros mal formado ya no esconde el bloque de la revisión (lanza).

Anotados como menores, sin arreglo en esta tanda:

- El tablero dice "no afecta a este barrio" sin mirar si el barrio tiene programado volver al valor
  general antes de esa fecha, y la tasa que muestra es solo la compensatoria.
- "Cambia en N de M barrios" (configuración general) descuenta los barrios con un valor propio solo
  **programado**, que hasta esa fecha sí reciben el cambio general. Y el conteo es de los barrios que
  la persona puede leer (un usuario de un solo barrio ve "1 de 1").
- `valores` y `tramos` se copian iguales en cada liquidación del período (solo `desglose` es de la
  unidad). Funciona; si pesa, se normaliza.
