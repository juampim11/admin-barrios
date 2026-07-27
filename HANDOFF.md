# HANDOFF — bitácora de handoff entre herramientas

> Regla de oro: **lo que no está escrito acá o en `docs/`, no existe para la otra herramienta.**
> Entradas nuevas arriba (orden cronológico inverso).

---

## 2026-07-26 — Generación de documentos, fase 1: sale un PDF de verdad (Claude Code, `backend-dev`)

Primera implementación de **ADR-0001**. Rama `feat/boleta-de-expensas`. **Sale un PDF real, de punta a
punta, desde la base**: `pnpm demo:boleta` emite las 50 boletas del período del seed en **8 s en una
sola pasada** (161 ms por boleta con el navegador frío incluido), ~120 KB cada una.

### Lo construido

| Pieza | Dónde |
|---|---|
| `VistaBoleta` + `BloquePago` — modelo de vista puro, Zod | `packages/shared/src/documentos/` |
| Formato de dinero y fecha **sin `Intl`** (`formatearMonto`, `formatearDecimal`, `formatearFecha`) | `packages/shared/src/{dinero,fechas}.ts` |
| Plantilla `VistaBoleta → HTML`, símbolos, lenguaje prohibido, `MedioCobranza` + `generico-demo`, `GeneradorDocumento` | `packages/documentos/` |
| Adapter Chromium (un pase por lote + split con `pdf-lib`) | `packages/documentos/src/adapters/chromium.ts` |
| Armador desde la base bajo RLS, sin N+1 (4 consultas para N boletas) | `packages/data/src/servicios/vista-boleta.ts` |
| `pnpm demo:boleta` | `packages/data/scripts/demo-boleta.ts` |

**Gate:** 138 tests unitarios + 97 contra Postgres + 18 del proyecto nuevo `pdf`. `pnpm test` no paga
Chromium; el paso de CI nuevo va después de "Tests puros".

### Decisiones que el ADR no cerraba (y por qué)

1. **`packages/cobranza` se pliega dentro de `packages/documentos`** (`src/cobranza/`). El ADR §11 lo
   preveía como paquete propio; con un solo adapter, un paquete más era configuración sin beneficio.
   El **modelo de vista sí quedó en `shared`**, como manda el ADR §3: es lo que permite que `data` lo
   arme sin depender de `documentos`.
2. **`DocumentoSolicitado` lleva `estilos` + `cuerpo`, no un `html` único** (§4.2 lo ilustraba como
   una cadena). Es lo que permite emitir el CSS y las fuentes **una vez por lote**, que es de dónde
   sale la diferencia de 6×. Para el email y la vista web está `htmlCompleto()`.
3. **La geometría de los símbolos no viaja en `InstrumentoPago`** (§4.4 la ilustraba con
   `anchoModuloMm` y `zonaMudaModulos` por instrumento). La impone `simbolos.ts`, así todo adapter
   futuro hereda las guardas gratis en vez de tener que copiarlas.
4. **`MarcaDocumento` es de dos niveles** (barrio + emisor), siguiendo doc 09 §E.9.0, que corrigió el
   modelo de un solo nivel de ADR §4.3 el mismo día.
5. **`leible` puede ser `null`** (el payload de un QR no se imprime) y, cuando no lo es, tiene que ser
   idéntico a `carga` **salvo los espacios de agrupación**: `"0000 0000 0174"` es legítimo,
   `"0000 0000 0175"` no.
6. **El código de pago electrónico (LINK/PMC) es un instrumento de TEXTO, no un código de barras.**
   Es como está en la boleta real (doc 09 §A) y en el wireframe de §E.2.3: se tipea, no se escanea.
   Un símbolo de más al pie le comía 25 mm a la zona del detalle sin darle nada a nadie.
7. **Guarda de desborde en el renderizador** (no estaba en el ADR y hizo falta en el primer PDF real):
   si una zona de alto acotado no entra, la emisión **falla** con el nombre de la zona. Sin esto, el
   primer PDF contra datos reales perdió en silencio un concepto del detalle mientras el total de la
   zona 2 lo seguía incluyendo — una cifra sin la línea que la explica.
8. **Conflicto de documentos, resuelto a favor del ADR:** §10 del ADR manda marca de agua obligatoria
   cuando el medio es `generico-demo`; doc 09 §E.15.4 pide **no** poner marca de agua diagonal porque
   "mata el efecto comercial". Se implementó la del ADR (diagonal, al 16 % de opacidad, estampada por
   el renderizador). **Si para la reunión de venta se prefiere el criterio de §E.15.4, es una decisión
   de `product-owner` + `security-engineer`, no de implementación** — y hay que escribirla en el ADR.

### Lo que falta para que la boleta se vea como manda doc 09 §E

Ordenado por lo que más cambia la hoja:

1. **El dorso (página 2).** Es lo primero. Hoy la boleta es **una sola página** y el detalle entra
   raspando con los 5 conceptos del seed. Sin dorso no hay: por qué cambió contra el mes anterior,
   la explicación de la bonificación, el desglose del saldo anterior, ni el desborde del detalle con
   `(1) sigue al dorso`. El contrato ya lo contempla (`detalle.continuaAlDorso`,
   `DocumentoSolicitado.paginasEsperadas`), así que es plantilla, no rediseño.
2. **La zona 5 mide ~60 mm y el presupuesto de §E.2.2 reservaba 44** (era el de P1, un solo cupón).
   P-DEMO son tres instrumentos (§E.10.1 le da 73 mm). La diferencia sale de la zona 3, exactamente
   como manda §E.10.2. La zona 2 pasó a tomar el alto que necesita; **el troquel sigue anclado al
   borde inferior** porque el bloque de pago cierra la columna flex.
3. **Marca del barrio y del emisor (§E.9).** No hay columnas: hoy sale el nombre de `tenant_node`, sin
   logo, con acento **gris neutro** (`acentoImpreso(null)`) y sin CUIT ni domicilio del emisor. La
   caja de logo, el logotipo tipográfico y la degradación de contraste ya están implementados y
   testeados: falta el dato y `ObjectStorage` para resolverlo a `data:`.
4. **Fuentes propias embebidas.** Hoy se usa la pila local (`Liberation`/`DejaVu`/Arial), que no sale a
   la red pero **no es Geist**. El mecanismo está (`estilosBoleta(fuentes)` con `@font-face` en
   `data:` y rechazo de cualquier URL); faltan los archivos vendorizados.
5. **Tokens de impresión.** §E.5.2 pide `fontSizePrint`, `printFitWidthFactor`,
   `printMinLegibleZona1` y `print.instrumentoInk` en `packages/design-tokens`. La plantilla usa hoy
   los valores en pt a mano. Primero el token, después el uso (doc 06 §g.2).
6. **Fecha tope de la red** (§E.11 ítem 1): sin campo propio, sale `null` y la zona 1 dice "Sin fecha
   tope informada". **No se usa el segundo vencimiento**, que significa otra cosa (§B.6).
7. **Renglón de bonificación NO aplicada** (§E.11 ítem 5): el contrato lo contempla
   (`RenglonComposicion.informativo`), pero **no tiene dónde guardarse**. Es el Caso B entero.
8. **Rol del destinatario** (§E.11 ítem 9): `unidad.rolDestinatario` es opcional y hoy **no se
   imprime**, porque sería una suposición.
9. **Numeración de comprobante con serie y correlativo** (§E.11 ítem 4) y el **snapshot de la marca
   del administrador con mandato vigente** (§E.14 punto 8): hoy se lee el mandato vigente, así que una
   boleta vieja mostraría la administración de hoy.

Todos estos huecos viajan **enumerados dentro de la propia vista**, en `VistaBoleta.faltantes`
(`FALTANTES_CONOCIDOS` en `packages/data/src/servicios/vista-boleta.ts`): el día que el dato exista se
sabe exactamente qué boletas se emitieron sin él.

### Trampas verificadas en este entorno (para que nadie las vuelva a descubrir)

- **`bwip-js` antepone un `0` en silencio** con cantidad impar de dígitos en Interleaved 2 of 5: el
  símbolo de `"1234567"` es **byte a byte idéntico** al de `"01234567"` y el lector devuelve el
  segundo. Guarda en `revisarCargaSimbolo()`, con round-trip real (`zxing-wasm`) que lo demuestra.
- **`bwip-js` deforma el QR si se le pasa `height`**: devuelve una matriz de 58 × 71 módulos para un
  símbolo cuadrado. Escalarla a un cuadrado lo vuelve ilegible. Al QR no se le pasa `height`.
- El **fondo transparente** es el default de `bwip-js`. El renderizador fuerza `#FFFFFF` opaco sobre
  toda la caja, zona muda incluida, y no hay parámetro para cambiarlo.
- Un **código de 58 dígitos ocupa los 182 mm útiles enteros** con X-dimension 0,323 mm (el
  renderizador la achica sola hasta el piso de 0,25 mm y falla si no entra). No hay columna lateral
  posible al costado del código: su zona muda es parte de su propio SVG.

### Lo que encontró la revisión, y que ya está corregido

`code-reviewer` y `security-engineer` revisaron el diff. Los tres bloqueantes eran reales y estaban
verificados con evidencia, no inferidos. **Todos corregidos, con un test que los cubre.**

1. **El código de barras salía ILEGIBLE.** El SVG mide los 182 mm útiles enteros y compartía fila
   flex con el QR: se derramaba fuera de su contenedor (688 px de contenido en 511 px de caja) y el
   QR —posterior en el DOM— **se imprimía encima del último 24 % del símbolo**, zona muda incluida.
   ZXing no leía nada. La hoja se veía impecable.
   - **Arreglo:** los símbolos lineales van en un renglón propio a ancho completo. La regla de doc 09
     §E.6 ("nada se pone al costado del código") ahora la hace cumplir el CSS, no un comentario.
   - **Dos guardas nuevas, las dos verificadas reintroduciendo el bug a propósito:**
     `buscarDesbordes` mira **ancho** además de alto y corta la emisión con el número exacto
     (688 vs 511 px), y `test/canario-cupon.test.ts` renderiza la boleta, **recorta la zona del cupón
     de la página** y se la pasa a un lector de verdad. `codigo-de-barras.test.ts` no podía atraparlo:
     verifica la **carga** regenerando el símbolo aparte, y la falla estaba en la **geometría**.
2. **La participación impresa usaba otro denominador que el que cobró.** `leerSumaCoeficientes`
   sumaba `coeficiente` entero; el prorrateo suma solo las unidades con `baja_at is null`. Con una
   unidad dada de baja después de cerrar la versión, el porcentaje impreso quedaba **por debajo** del
   real y la cuenta dejaba de rehacerse con calculadora, por mucho más que el "$ 0,01" que promete la
   leyenda fija. Ahora es exactamente la misma consulta, con test contra Postgres.
3. **El interés se explicaba con datos inventados.** `tasaImpresa(… ?? "0")`, `dias ?? 0` y
   `fecha_corte_mora ?? fecha_emision` fabricaban el respaldo de una cifra de dinero — y el camino
   **cotidiano** (unidad al día, con tasa cargada) llegaba sin fecha de corte, así que la hoja
   imprimía `current_date` del servidor como si fuera un hecho. Los tres campos son ahora nullables y
   la hoja imprime solo lo que existe. Ídem `emision.fecha`: un período en borrador **no tiene** fecha
   de emisión y ya no se rellena con la de hoy.

**Además, de la misma revisión:** gate de rol para emitir (`admin_plataforma`/`admin_barrio`/
`operador` vía `app.has_role_on` en la misma consulta, sin round-trip: `app.accessible_tenant_ids()`
mira que haya membresía, **no el rol**, así que un `propietario` pasaba las policies) · la banda de
"vista previa" ya no se cae por un `slice(0,3)` silencioso · sin `numero_comprobante` el adapter **no
arma el instrumento** (con `null` todas las boletas del período recibían el mismo código, byte a
byte) · un importe negativo ya no se codifica como una deuda del mismo monto · `permitida()` filtra
por **mediatype** (un `data:text/html` es un documento nuevo) · JavaScript apagado en el contenido
(`setJavaScriptEnabled(false)` **antes** de `setContent`, que es una navegación — verificado con un
script que intenta borrar el documento) · el filtro de lenguaje prohibido corre **al emitir** y no en
`parsearVistaBoleta`, porque ahí el día que crezca la lista dejaría de poder abrirse toda boleta vieja
que la contenga (ADR-0001 §6) · la vista previa de una boleta ya no lee el período entero.

**Y los tests que no probaban nada**, corregidos: el de "no depende de `Intl`" (setear `LANG` no
cambia nada: ahora se verifica sobre la implementación) · el del prorrateo (usaba una regex sobre el
string del coeficiente que solo funcionaba con parte entera cero: usa `coeficienteAEntero`) · varios
`.toThrow()` pelados sin matcher. **Y el hueco más grande: `vista-boleta.ts` no tenía ni un test** —
ahora tiene `packages/data/test/vista-boleta.test.ts`, contra Postgres real, cubriendo los tres
bloqueantes y el gate de rol.

**Estado del gate:** 146 unitarios + 105 contra Postgres + 26 del proyecto `pdf`, todos en verde;
`pnpm build` limpio; 50 boletas reales emitidas en 5 s.

### Pendiente, anotado y no corregido

- **`app.resolver_aplicaciones` es `security definer` con dueño `app_job` (BYPASSRLS) y está
  granteada a `app_request`** (`0017`, ya en `main`). Es el único lugar donde el aislamiento no lo
  garantiza la policy sino el cuerpo de la función. No lo toca esta rama; merece una auditoría propia
  de `dba-data` + `security-engineer`.
- Alinear las **policies** con el gate de rol es tarea de `dba-data`, y **no es copiar el patrón de
  `0016`**: el portal del residente va a querer que un propietario lea *su propia* liquidación, o sea
  "solo su unidad", no "nada".
- `partir()` compara el total de páginas del lote, no documento por documento. Hoy cierra porque
  `paginasEsperadas` vale siempre 1; **el día que el dorso lo haga valer 2**, un documento que rinde 1
  y otro que rinde 3 pasarían el chequeo. Hay que marcar cada artículo con su índice antes de eso.
- Casos borde que hacen fallar el `superRefine` con un mensaje de Zod en vez de uno de negocio:
  liquidación sin ítems, y `coeficienteImpreso` sin piso (una participación de 0,0000 % mientras se
  cobra) ni tope (un `version_id` equivocado imprimiría más de 100 %).

---

## 2026-07-25 — Cargos y descuentos de boleta: implementación + inversión del modelo de confianza (Claude Code)

Implementa §AB del doc 08 y **cambia una decisión de diseño** a partir de la auditoría.

**Lo construido** (`0015`, `0016`, `0017`):

- Tres tablas: `concepto_boleta` (catálogo del barrio), `concepto_boleta_valor` (valores con
  vigencia) y `concepto_boleta_unidad` (la aplicación a una unidad en un período), más
  `concepto_boleta_unidad_evento` (append-only) y `limite_aplicacion_barrio`.
- `clase_item` en `item_liquidacion` (`prorrateo` / `cuota_fija` / `cargo` / `descuento`): **el
  invariante del cuadre pasa a ser una sub-suma** — lo repartido sigue siendo exactamente el gasto,
  y cargos y descuentos van por afuera, con biyección 1 a 1 contra sus aplicaciones y subtotales
  verificados **por unidad** (un cargo en la boleta equivocada no mueve el total del período).
- FK de tres columnas `(liquidacion_id, periodo_id, unidad_funcional_id)`: una línea no puede caer en
  la boleta de otro vecino.
- La aplicación **no cuelga de `liquidacion`**: regenerar el borrador no evapora lo cargado a mano.

**El cambio de diseño (importante para quien retome):** la primera versión dejaba que el request
escribiera el snapshot del catálogo y el importe. Era explotable en un renglón de SQL. Ahora:

| Lo manda el request | Lo escribe la base |
|---|---|
| concepto, unidad, período, `fecha_hecho`, `cantidad`, `detalle`, `origen_evaluacion` | todo el snapshot (`clase`, `metodo`, nombre, parámetros, `tope`, `financiamiento`), la firma, la base de cálculo y el importe |

`app_request` **no tiene UPDATE** sobre `concepto_boleta_unidad` salvo las tres columnas de la
anulación. El importe lo resuelve `app.resolver_aplicaciones(periodo)` (definer, propiedad de
`app_job`), en **una sola pasada para todo el período**. La aritmética del dinero vive en **una sola
definición**, `app.cbu_importe_bruto()`, usada por el cálculo y por el CHECK.

**Trampa de infraestructura que hay que recordar:** una función `security definer` cuyo dueño no sea
superusuario **queda sujeta a `force row level security`**. En dev no se nota (el dueño es
superusuario); en un Postgres administrado rompe. Por eso las definer de este módulo son propiedad de
`app_job`, que tiene BYPASSRLS. Hay un test con rol `operador` que lo detectaría.

**Decisiones de dominio que quedaron escritas:** la base del descuento es *cuota fija + ordinarias*,
nunca el fondo de reserva ni la extraordinaria; el descuento al cumplidor se presupuesta (el barrio
arma el presupuesto sobre la expensa **con** el descuento, así que no lo absorbe); `cuenta_corriente`
como origen de la evaluación está **inhabilitado** hasta que exista el módulo de cobros, porque el
sistema todavía no puede afirmar que verificó nada.

**Estado:** 97 tests contra Postgres real + 43 unitarios, todos en verde; seed emitiendo con cargo y
descuento reales.

**Pendiente conocido (no bloqueante, anotado por la auditoría):** `limite_aplicacion_barrio` no
registra quién subió el techo ni cuándo (un administrador se lo puede subir sin rastro); los **cargos**
no tienen tope de ninguna clase; `financiamiento = 'fondo_reserva'` debería pasar por `legal-ph` y
`contador` antes de quedar como opción; `orden_impresion` no se congela en la aplicación.

**Próximo:** la UI de carga (§AB), la regla guardada con simulador comparativo, y el comprobante
separado de la extraordinaria con su propio vencimiento e imputación (atado al módulo de cobros).

---

## 2026-07-25 — Cierre de los tres agujeros de seguridad + encuadre fiscal explícito (Claude Code)

Primera tanda de implementación salida del panel (`docs/diseno/08-criterios-de-reparto.md` §T y §S-6).

- **`0012_sin_clasificar.sql`**: valor nuevo del enum, **solo en su archivo**.
- **`0013_seguridad_periodo.sql`**: `periodo_editable` falla cerrado (con excepción explícita para el
  borrado en cascada); un período **nace en borrador** y no puede insertarse ya emitido; la firma de
  quién emitió sale de `app.current_user_id()` y no del request.
- **`0014_sin_default_fiscal.sql`**: se elimina el default `no_alcanzado` de `concepto`. Dar de alta un
  concepto ahora **exige declarar el encuadre**.
- `emitirPeriodo()` **ya no recibe el usuario**: hay que llamarla dentro de `conUsuario()`. El seed se
  adaptó (emite con identidad).

**Aprendizaje operativo que corrige al panel:** `drizzle-kit migrate` envuelve **todas las migraciones
pendientes en UNA transacción**, así que separar el `ALTER TYPE ... ADD VALUE` en su propio archivo
**no alcanza** — el valor nuevo tampoco se puede usar en un archivo posterior de la misma corrida. Por
eso el default se **elimina** en vez de cambiarse, que además es más estricto.

**Estado:** 74 tests contra Postgres real (6 nuevos) + 43 unitarios, todos en verde; seed funcionando.

**Próximo:** la estructura de cargos y descuentos (§AB del doc 08): tres tablas, `clase_item` por
columna generada, FK compuesta de tres columnas contra el cruce de unidades, y `validar_emision` v3.

---

## 2026-07-25 — Correcciones del usuario sobre el reparto (Claude Code)

**El usuario administra barrios reales; donde su operatoria contradice a un agente, manda la suya.**
Quedaron asentadas en `docs/diseno/08-criterios-de-reparto.md` §A.0.

1. **Los gastos comunes son comunes a todos**: no se reparten por concepto. Lo que varía es **cómo se
   cobra la expensa** (a nivel barrio), y la suma total cubre todos los gastos. → El criterio por
   concepto **baja a caso de borde futuro** (contradice al `administrador-consorcios`, que lo había
   puesto como modo normal).
2. **Extraordinaria como ítem de la boleta = parte de la expensa común del mes**, sin vencimiento, mora
   ni deuda diferenciados. → Confirma el comportamiento actual: no hay nada que construir.
3. **Extraordinaria con boleta propia = TODO diferenciado** (vencimiento, intereses, imputación y
   seguimiento). Caso real: la obra de gas de Las Corzuelas (Guazú Pytá). → **Cierra la pregunta
   abierta**: no alcanza un PDF aparte. Se elimina el "paso 2 barato" y se confirma el comprobante
   cobrable propio, pegado al módulo de cobros.
4. **Requisito nuevo: conceptos prefijados por unidad** — descuento por vecino cumplidor (% o monto
   fijo) y cargos por uso (pádel, tenis, quincho, Club House). **Rompe el invariante de cuadre**: un
   descuento recauda menos que el gasto y un alquiler es plata que no es un gasto repartido. Hay que
   **redefinir** el invariante, no aflojarlo. Diseño en curso.

**Nota fiscal:** el alquiler de amenities es **ingreso ajeno a las expensas** (`provincial/02`) y va
separado en la clasificación. `contador` tiene que confirmar si **vuelve contribuyente de IIBB a un
barrio que no lo era** — es lo más urgente de su lista.

**Diseño resuelto (Parte II del doc 08):** tres tablas con el patrón catálogo -> valor versionado ->
aplicación; `monto_resuelto` firmado; el invariante se **redefine** (`repartido = gastado` como
sub-suma intacta + biyección 1:1 para cargos y descuentos), no se afloja; exclusiones duras (fondo de
reserva, extraordinaria, interés y saldo **nunca** son base de descuento; los descuentos no se
componen; piso cero). **Un check que escribimos nosotros — `item_liquidacion_origen_chk` — bloquea hoy
el requisito entero** y hay que reemplazarlo por `clase_item`. Orden definitivo en el doc 08 §P.

**Decisiones del usuario (2026-07-25), en el doc 08 §N.bis:**
- **Financiamiento del descuento = modo (a) partida presupuestada**, con regla propia de
  dimensionamiento: **la partida se calcula como si todas las unidades calificaran**, para que la
  expensa **neta** cubra los gastos. Quien no califica paga el bruto, y esa diferencia **es la
  penalidad** (la intención declarada: en vez de recargo al que paga tarde, descuento al que paga
  bien). Consecuencia a reportar: si alguien no califica, el barrio recauda **más** que sus gastos y
  ese excedente necesita destino declarado.
- **"Vecino cumplidor" = familia A**: sin saldo pendiente al cierre del período anterior; se recupera
  **automáticamente** al ponerse al día. Lo calcula el sistema, con override motivado.

---

## 2026-07-25 — Panel: criterios de reparto y boleta separada (Claude Code)

**Origen:** dos huecos que marcó el usuario — la extraordinaria puede ir en la misma boleta o en un
comprobante individual; y el monto puede repartirse de varias formas (partes iguales, superficie con
escala, % por UF…). Panel: `administrador-consorcios`, `legal-ph`, `analista-funcional`,
`arquitecto-software`. **Todo está en `docs/diseno/08-criterios-de-reparto.md`.**

**Lo que hay que saber sin leer el doc entero:**
- **Cuatro de las seis formas de repartir YA funcionan** en el motor y en la base (% de reglamento,
  superficie lineal, mixta como vector, monto fijo vía `modelo='fija'`). **Ninguna tiene pantalla.**
- **`partes_iguales` no se puede** hoy con `base='parte_indivisa'`: con N que no divide exacto en 9
  decimales la versión **no cierra** (0,333333333×3 ≠ 1). Es una línea de enum.
- **El criterio por concepto no existe y no tiene workaround** — es la brecha dura. En barrios SA /
  asociación civil es **el modo normal de operar**, no un caso de borde.
- **Guardamos el resultado del reparto, no la regla.** Si cambia una superficie o entra una unidad,
  nadie puede re-derivar ni auditar. Las escalas se expresan en **módulos** y **no suman exacto 1**,
  así que ni siquiera entran por la validación actual.
- **Dos decisiones estructurales a fijar ANTES del módulo de cobros** (su costo se multiplica si se
  postergan): la **mora se computa por obligación con su propio vencimiento** (no por boleta ni por
  período), y **la deuda se imputa al comprobante, nunca al par (período, unidad)**.
- **Guardrail anti-motor-de-reglas:** el criterio nunca se guarda como `jsonb` con condiciones; método
  = enum, parámetros = tablas tipadas. *"Esa fricción es la feature."*
- El cuadre **no se complica**: todos los criterios son vectores de pesos y el motor ya garantiza que
  la suma cierre. Regla: *el control de cuadre verifica aritmética, nunca ejecuta la regla*.

**Orden de construcción acordado:** 0) UI de lo que ya funciona · 1) `partes_iguales` · 2) extraordinaria
como PDF aparte del mismo período · 3) la regla guardada · 4) reparto por concepto · 5) boleta separada
de verdad (con el módulo de cobros) · 6) fijo + variable.

**Pendiente del usuario:** si la boleta individual de la extraordinaria necesita **vencimiento e
imputación propios** (paso 5, migración cara) o alcanza con un **PDF aparte del mismo período**
(paso 2, barato). También sigue abierta la del doc 07 §G.1 (si el residente ve que una extraordinaria
no tiene respaldo).

---

## 2026-07-24 — Correcciones de dominio: dos modelos de expensa y extraordinaria sin acta (Claude Code)

**Origen:** dos correcciones del usuario sobre la operatoria real.

**1. Hay DOS modelos de expensa, y se elige por período** (`periodo_expensa.modelo`):
- `variable`: lo que se cobra sale de los **gastos del mes**, prorrateados por coeficiente (lo que ya
  estaba).
- `fija`: **cuota mensual** que fija el directorio o el administrador. Se versiona en
  `cuota_fija_version` (+ `cuota_fija` con el importe por unidad: todas iguales o distintas, lo decide
  el barrio), con la anterior cerrándose sola al entrar una nueva. Los gastos **ordinarios** se
  registran igual (reporte y libro) pero **no se cobran de nuevo**; las **extraordinarias sí se
  prorratean aparte**, porque son eventos puntuales.
- El modelo va en el período, no en el barrio: cambiar de criterio no reescribe la historia.
- El **cuadre al emitir** se bifurca: `variable` → repartido = gastos; `fija` → repartido = cuotas
  fijas de las unidades activas + extraordinarias. Además, en modelo fijo, **toda unidad activa
  necesita su cuota** o no se emite.

**2. Una extraordinaria puede existir SIN acta de asamblea.** Se sacó el bloqueo. Ahora la base
**marca** el gasto (`sin_respaldo_asamblea`, lo pone el trigger — no la app, así vale para la UI, una
importación o un job) y `generarLiquidaciones()` devuelve `extraordinariasSinRespaldo` para que la UI
avise. El encuadre legal del art. 2048 **no cambia**: sigue pesando al reclamar la deuda (doc 04), y el
sistema sigue sin asumir que la deuda es ejecutable.

**Migraciones:** `0006_modelos_expensa.sql` (generada) y `0007_modelos_expensa_reglas.sql` (a mano:
cuadre por modelo, vigencia de la cuota fija, la marca de la extraordinaria, FKs compuestas y RLS de
las dos tablas nuevas, y un check que impide mezclar una línea de cuota fija con un gasto prorrateado).

**Tests:** 101 en total — 35 unitarios (5 nuevos del modelo fijo + 1 de la extraordinaria sin acta) y
66 contra Postgres real (6 nuevos).

**Pendiente relacionado:** el **modo demo sigue siendo modelo variable**; falta un barrio demo con
cuota fija cuando haya que mostrarlo.

---

## 2026-07-24 — Fase 6C: expensas y liquidación mensual (0004/0005) (Claude Code)

**Rama:** `feat/expensas-liquidacion` (de `main`).

**Qué se cerró:**
- **`0004_expensas.sql`**: `concepto` (ordinaria/extraordinaria + `clasificacion_fiscal` +
  `es_fondo_reserva`), `tasa_mora` versionada, `periodo_expensa` (estado, vencimientos, versión de
  coeficientes congelada, `total_gastos`), `gasto_periodo`, `liquidacion` (subtotales separados, saldo
  anterior, interés, `mora_pendiente_definicion`) e `item_liquidacion` **con el origen de cada línea**.
- **`0005_expensas_rls.sql`**: FKs compuestas `(id, barrio_id)` como en el padrón, más los controles:
  - **extraordinaria exige acta** (art. 2048);
  - **período emitido inmutable** (gastos, liquidaciones y líneas);
  - **no se emite descuadrado**, ni con unidades activas sin liquidar, ni con la versión de
    coeficientes abierta;
  - **transiciones válidas** borrador/revisada -> emitida -> distribuida, sin vuelta atrás;
  - `app.tasa_mora_vigente(barrio, fecha)`; RLS de las 6 tablas.
- **`packages/shared/liquidacion.ts`** (cálculo puro): `calcularLiquidacion()` reparte **cada gasto por
  separado** (resto a la última unidad) para que la suma cobrada sea **idéntica** al gasto del período,
  con subtotales por tipo y fondo; `calcularMora()` con interés simple y, **sin tasa cargada, devuelve
  el motivo en vez de un número**; `transicionValida()` para los estados.
- **`packages/data/src/servicios/liquidacion.ts`**: lee coeficientes/gastos/tasa, llama al cálculo puro
  y persiste; `generarLiquidaciones()` es **regenerable** (borra y recalcula, solo en borrador) y
  `emitirPeriodo()` delega la validación pesada en el trigger de la base.
- **Modo demo con un período EMITIDO** (5 conceptos, tasa 3%, 50 liquidaciones), generado con el mismo
  servicio que usa la app: si algo se rompe, se rompe en el seed y no en una demostración.
- **60 tests contra Postgres real** (13 nuevos) + **30 unitarios** (13 nuevos del cálculo).

**Dos bugs propios que encontraron los tests (documentados en el SQL):**
1. El trigger de "período editable" usaba un `CASE` con `new.liquidacion_id`: plpgsql resuelve todas las
   ramas y fallaba en `gasto_periodo`, que no tiene ese campo. Quedó con `IF/ELSIF`.
2. `item_liquidacion.gasto_id` con `on delete restrict` impedía borrar un período en borrador. Ahora es
   `cascade`: la línea no sobrevive al gasto que la originó (y tras emitir, el trigger no deja borrar).

**Qué NO se hizo (lo próximo):**
- **Cobros y pagos** (`0006`): estado de cuenta por unidad, imputación con orden configurable, pagos
  manuales con `usuario_registrador`, comprobante y **flag antiduplicado**. Con eso, el `saldo_anterior`
  y los días de atraso dejan de ser un parámetro y salen de los datos.
- **PDF por unidad** (HTML->PDF en Docker) y **distribución** (ZIP + email 1-a-1 con registro de envíos).
- **Primera pantalla real** (padrón y liquidación) sobre estos datos.

**Próximo paso sugerido:** cobros/pagos (`0006`), que cierra el circuito del mes; después el PDF.

---

## 2026-07-24 — Fase 6C: padrón del barrio (0002/0003) + modo demo (Claude Code)

**Rama:** `feat/dominio-barrio` (de `main`, que ya tiene 6B + 6C Etapa 0 + la decisión de alcance).

**Qué se cerró:**
- **`0002_dominio.sql`** (generada del esquema Drizzle) — `barrio` (5 ejes + flags de ejecutividad +
  `denominacion_concepto`), `barrio_atributo_vigencia`, `unidad_funcional`, `unidad_contacto`,
  `obligado`, `unidad_obligado`, `coeficiente_version`, `coeficiente`, `documento_barrio`,
  `mandato_administracion`. El `barrio` **extiende** al nodo de tenancía (misma PK), así no hay dos
  identidades del mismo barrio.
- **`0003_dominio_rls.sql`** (a mano) — lo que la base hace cumplir sola:
  - **FKs compuestas `(id, barrio_id)`**: imposible cruzar datos de dos barrios, ni con `app_job`.
  - **Vigencia de los 5 ejes**: la tabla es la fuente de verdad, las columnas son cache; el trigger
    cierra la vigencia anterior **antes** del insert (el índice único de "una sola abierta" se valida
    en el insert, así que cerrarla en un AFTER llegaba tarde) y sincroniza la columna;
    `app.valor_eje_vigente(barrio, eje, fecha)` para los actos con fecha.
  - **Cuadre de coeficientes**: no se cierra una versión que no cuadra (exacto = 1 en parte indivisa;
    pesos relativos en superficie/lote/mixto, art. 2081) ni si falta alguna unidad activa —
    **incluidas las baldías** (art. 2077). Cerrada = inmutable y no se reabre.
  - **RLS de las 10 tablas** con el mismo patrón (lee el subárbol accesible; escribe rol
    administrativo/operativo del barrio) y **sin DELETE**: todas las bajas son lógicas.
- **`packages/shared/barrio`**: los 5 ejes como constantes + Zod (una sola fuente para UI y base),
  `sugerirDenominacionConcepto()` que devuelve **null si no hay fuente cargada** (no inventa cómo se
  llama el concepto en fideicomiso/geodesia) y `faltantesParaViaEjecutiva()` que **nunca afirma** que
  la deuda sea ejecutable: enumera lo que falta acreditar.
- **Modo demo** (`pnpm db:seed`, idempotente): 1 administrador + 1 barrio PH especial en Villa Allende,
  50 unidades (13 baldías/en construcción), 55 obligados (uno de cada diez lotes con poseedor además
  del propietario), contactos, coeficientes por superficie **cerrados y sumando exactamente 1**, y dos
  documentos del barrio. Todo ficticio, sin PII real.
- **47 tests contra Postgres real** (20 nuevos), verdes y repetibles con la base ya sembrada.

**Qué NO se hizo (lo próximo):**
- **Expensas y liquidación** (`0004`): período, conceptos con clasificación fiscal, prorrateo,
  fondo de reserva, mora versionada, estados de la liquidación.
- Pagos/cobros, PDF por unidad, distribución, conciliación.
- **Primera pantalla real (padrón)** sobre estos datos.

**Próximo paso sugerido:** `0004_expensas.sql` + el servicio de liquidación usando `prorratear()` de
`packages/shared` (ya probado: la suma de las partes cierra siempre), y recién después la UI del padrón.

---

## 2026-07-24 — Decisión de alcance: el módulo contable sale del MVP (Claude Code)

**Decisión del usuario:** el **módulo contable no entra al MVP inicial** — hacerlo bien es
prácticamente un ERP (libro contable, resumen fiscal por concepto, balance según figura jurídica).
**Se evalúa más adelante.**

**Qué queda en el MVP en su lugar:** **exportación de movimientos** — planilla CSV/Excel de ingresos y
egresos del período, cada línea con su concepto, barrio y período, para que el administrador se la
entregue a su contador (que es como se resuelve hoy).

**Qué NO cambia:** el **dato** sigue guardando la `clasificacion_fiscal` por concepto (doc 03 §B.3), así
que evaluar el módulo contable más adelante no obliga a recargar ni a migrar nada. El agente `contador`
y `knowledge/cordoba/` siguen igual: se usan para encuadrar, no para construir un módulo ahora.

**Docs actualizados:** `docs/diseno/01-alcance-modulos.md` (§1.1 tabla de módulos y §4.8),
`docs/diseno/05-roadmap.md` (MVP paso 7 y resumen ejecutivo), `CHANGELOG.md`.

---

## 2026-07-24 — Fase 6C (Etapa 0): monorepo + tenancy con RLS probada en Docker (Claude Code)

**Rama:** `feat/fase-6c-fundaciones` (nace de `main`, que ya tiene el merge de 6B). Sin push.

**Qué se cerró:**
- **Monorepo pnpm workspaces** (decisión tomada; cierra el punto abierto del ADR §10):
  `apps/web` + `packages/{shared,data,design-tokens}`, `tsconfig.base.json` estricto
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), Vitest con dos
  proyectos (`unit` sin base / `db` contra Postgres real).
  - Los paquetes se consumen como **TS fuente** (sin build previo) y los imports llevan **extensión
    `.ts` explícita**: así los resuelven igual Node (type-stripping nativo de Node 22), Vitest y Next,
    sin sumar `tsx`/`ts-node`. `hoist=false` en `.npmrc`: cada paquete solo importa lo que declara.
- **`packages/shared`** — dominio puro: dinero como **string decimal + aritmética en centavos
  (`bigint`)**, nunca `number` (0.1+0.2 no puede decidir una expensa); `prorratear()` con el resto a
  la última unidad, así **la suma de las partes siempre cierra igual al total**; `CifraTrazable`
  (monto + origen: barrio/período/UF/coeficiente/detalle); helpers de subárbol de tenancía.
- **`packages/data`** — Drizzle + Postgres, con dos migraciones aplicadas y probadas:
  - `0000_tenancy.sql` (generada del esquema TS): `tenant_node` (uuid + `nid` identity + materialized
    path + soft-delete), `membership`, `tenant_grant`, enums en schema `app`, índices (incluido
    `path text_pattern_ops` y el parcial `where activo`).
  - `0001_tenancy_rls.sql` (escrita a mano): `app.current_user_id()`, `accessible_tenant_ids()`,
    `has_role_on()` (STABLE + SECURITY DEFINER + `search_path` fijo), trigger de path en INSERT,
    trigger de **re-parentado** que reescribe el subárbol y rechaza ciclos, roles `app_request`
    (sujeto a RLS) / `app_job` (BYPASSRLS) **sin contraseña en el repo**, y todas las policies.
  - Cliente: `conUsuario(db, userId, fn)` = transacción + `set_config('app.user_id', …, true)`.
- **27 tests contra Postgres real** (`pnpm test:db`), todos en verde: hermanos que no se ven, no se ve
  hacia arriba, administradores distintos aislados, membresía inactiva, soft-delete, **`1.7` vs
  `1.70`**, escritura por rol, propietario que no puede auto-ascenderse, baja lógica (sin DELETE),
  `tenant_grant` visible solo por sus dos puntas, `app_job` que ve todo, re-parentado + ciclo, y
  **`app.current_user_id()` en sus dos modos** (`SET LOCAL` y `auth.uid()` estilo Supabase) más la
  prueba de que la identidad **no queda pegada** a la conexión del pool.
- **`apps/web`** (Next 15 + React 19) mínima pero real: consume los tokens vía CSS vars generadas
  (`pnpm tokens:css`), muestra un prorrateo con `tabular-nums` y los chips de morosidad. `pnpm build`
  en verde. Servicio `app` del `docker-compose.yml` activado (Dockerfile de desarrollo con pnpm).

**Hallazgos que corrigieron el diseño de 6B (importan para 6C/6D):**
1. **`insert … returning` fallaba contra la propia RLS.** `accessible_tenant_ids()` es `STABLE`: se
   evalúa con la foto previa a la sentencia, así que la fila recién insertada "no existe" para ella y
   el RETURNING violaba la policy de SELECT. Solución: la policy de lectura de `tenant_node` acepta
   también `parent_id ∈ accesibles` (no amplía el acceso — si se ve el padre, el hijo ya está en su
   subárbol) **y** exige `deleted_at is null` en esa rama, para que un tenant dado de baja no
   reaparezca por la puerta del padre. **A tener en cuenta al escribir `0002_dominio.sql`.**
2. **El trigger de path lee bajo RLS**: colgar un nodo de un barrio ajeno falla con "parent_id
   inexistente" en vez de un error de policy. Se dejó así a propósito (el sistema no confirma la
   existencia de tenants ajenos) y el test lo documenta.
3. **`app_request` no tiene privilegio de DELETE** además de no tener policy: doble candado para que
   un dato financiero no se evapore desde la app.

**Qué NO se hizo (queda para lo próximo):**
- **`0002_dominio.sql`**: barrio con los 5 ejes versionados + `barrio_atributo_vigencia`, UF,
  `unidad_obligado` multi-obligado desde el día uno, coeficiente con cuadre, expensa, pago con origen.
- **Seed de modo demo** (~50 UF, un período liquidado) — depende de `0002`.
- **Portar el motor puro de conciliación** del gas con sus tests (doc 02).

**Estado de integración (2026-07-24) — TODO EN `main`:**
- **PR #1** (`feat/fase-6b-diseno-producto` → `main`): Fase 6B, mergeado. **PR #2**
  (`feat/fase-6c-fundaciones` → `main`): Fase 6C Etapa 0, mergeado **con el CI en verde**. Las dos
  ramas quedaron borradas; `main` = `Merge PR #2`.
- Se mergeó en ese orden a propósito: con 6B ya en `main`, el diff del PR de 6C muestra **solo el
  código nuevo** (55 archivos) y no los 95 de documentación.
- **CI en GitHub Actions** (`.github/workflows/ci.yml`), verde en el PR y en `main`: tipos → tests
  puros → migraciones y roles → **tests de RLS contra un Postgres real del runner** → tokens al día →
  build de la web. Corre en cada push de rama de trabajo **y** en el PR (`concurrency` evita el run
  duplicado), así el gate funciona incluso si GitHub tiene caídos los Pull Requests — cosa que pasó
  justo hoy (`major_outage`, HTTP 500 al crear PRs) y demoró la integración ~40 minutos.
- Los `push` a `main` de acá en más pasan siempre por PR: es lo que pide `docs/devops/02-sdlc-git-flow.md` §4.

**Cómo levantar todo (queda documentado en `README.md` y `packages/data/README.md`):**
`pnpm install` → `cp .env.example .env` → `pnpm db:up` → `pnpm db:migrate` → `pnpm db:setup` →
`pnpm dev`. Verificación: `pnpm typecheck && pnpm test && pnpm test:db && pnpm build`.

**Próximo paso sugerido:** `0002_dominio.sql` (padrón del barrio) con sus policies por `barrio_id`,
tests de aislamiento a nivel dominio y el seed de modo demo; después, el motor de conciliación.

---

## 2026-07-23 — Fase 6B: diseño de producto + roster técnico (Claude Code)

**Qué se cerró:**
- **Roster técnico de ingeniería (perfiles super-senior)** dado de alta con la estructura portable
  (persona en `agents/personas/`, wrapper en `agents/wrappers-claude/`, copia activa en
  `.claude/agents/`): `product-owner`, `analista-funcional`, `arquitecto-software`, `tech-lead`,
  `ux-designer`, `backend-dev`, `frontend-dev`, `devops`, `qa-funcional`, `qa-automation`,
  `security-engineer`, `dba-data` (12). `mobile-dev` queda para el arranque de React Native. Roster
  sincronizado en `agents/README.md`, `CLAUDE.md` §3 y `AGENTS.md` (que delega al README).
- **5 documentos de diseño en `docs/diseno/`** (+ `README.md` índice), producidos con el equipo y con
  los agentes de dominio (`legal-ph`/`contador`/`administrador-consorcios`) citando la base
  `knowledge/cordoba/` con marca de confianza:
  - `01-alcance-modulos.md`: corte de **MVP básico y mostrable** + operatoria por módulo + multi-figura
    como **5 ejes versionados** + mobile residente-primero.
  - `02-reuso-conciliacion.md`: reúso del motor puro de conciliación del gas (matcher/reglas/reversas/
    FIFO + `nodemailer`/`exceljs`), qué adaptar/descartar, y **pasos de migración** accionables.
  - `03-modelo-datos.md`: **multi-tenancy jerárquica por materialized path** (`tenant_node`+`membership`)
    con RLS por subárbol vía `app.current_user_id()`; dominio del barrio fundado en
    `REQUISITOS-MODELO-DATOS.md` (5 ejes, obligados múltiples, deuda anclada a la UF, pago con origen +
    antiduplicado, mandato de administración versionado, excepciones de aislamiento art. 2084); PDF por
    HTML→PDF en Docker.
  - `04-requisitos-dominio.md`: requisitos **legales y fiscales por figura** con fuente + marca; regla
    rectora "**nunca asumir deuda ejecutable**"; IIBB (Ley 10117, efecto `[A VERIFICAR — CRÍTICO]`),
    conceptos alcanzados/no alcanzados, superposición tasa/expensa (adicional 25% URE).
  - `05-roadmap.md`: MVP en Docker → incrementos → mobile; modo demo (seed ~50 UF); multi-banco
    por-cliente; hosting NO bloquea; **resumen ejecutivo + 3 primeros pasos**.
- `CHANGELOG.md` (`[Sin desplegar]`) actualizado.

**Decisiones tomadas por el usuario en esta fase:**
- MVP = **básico y mostrable** (padrón, expensas+liquidación mensual, liquidación PDF por UF, cobros,
  pagos manuales, proveedores/OP, reporte mensual, **exportación contable**, distribución ZIP+email
  trazable, conciliación de ingresos **no bloqueante**, modo demo). Egresos: registro/órdenes de pago +
  libro exportable; **conciliación de egresos → Inc. 2**. Comunicaciones/reservas/accesos/reclamos/
  reportes avanzados → Inc. 2.
- Tenancy por **materialized path** (sin extensiones; `ltree` opcional a futuro).
- App mobile **residente primero**.

**Qué NO se hizo (fuera de alcance, es Fase 6C):**
- No se scaffoldeó el monorepo ni el esquema real (sigue sin `package.json`); el diseño deja las
  migraciones previstas (`0001_tenancy.sql`, `0002_dominio.sql`) pero no se crearon.
- No se cargó código de producción ni se portó todavía el motor de conciliación (solo el plan de
  migración en `02`).
- **Sin commits/push** (regla del usuario para esta sesión).

**Pendientes / a validar (marcados en los docs):**
- Cerrar con fuente los `[A VERIFICAR]`/`[NO ENCONTRADO]` de `knowledge/cordoba/` (sobre todo: efecto
  del inciso de la Ley 10117, criterio de adecuación de la IPJ Córdoba, jurisprudencia del TSJ/Cámaras
  de Córdoba, tarifarias municipales vigentes). Hasta entonces van como suposición.
- Confirmaciones abiertas del ADR: hosting final, gestor de monorepo (sugerido pnpm), adapter de Auth.
- Puntos `[validar]` del modelo de datos (enum de roles, `tenant_path` denormalizado, motor de PDF
  Playwright vs `@react-pdf/renderer`, si se permite mover barrios entre administradores).

**Revisión de cierre 6B (2026-07-23):**
- **Doc 06 `06-direccion-visual.md`** agregado (ux-designer, con [fe]/[po]): 7 principios, design tokens
  con **modo oscuro desde el día uno** y 3 direcciones de paleta (recomendada **A "Verdemar"** teal+ámbar,
  para romper con el azul-admin y dejar libres los matices semánticos/morosidad), navegación multi-barrio
  con selector persistente + color por barrio, wireframes de 5 pantallas (dashboard, wizard de
  liquidación, estado de cuenta UF, cola de excepciones, distribución), patrones (`CifraTrazable`, Zod
  compartido, estados vacíos con guía), accesibilidad **WCAG AA**, y la regla 6C (toda UI con skill
  `frontend-design` + estos tokens).
- **Ratificación visual (revisión 6B — cierra los 3 pendientes):**
  - **Paleta = A "Verdemar"** (marca teal `#0D9488`, acento ámbar `#F59E0B`). B y C **descartadas** con
    motivo (B: bordó convive mal con el rojo semántico de mora; C: lectura demasiado *consumer* para el
    público administrador).
  - **Tipografía = Geist** (principal) + **Geist Mono** con `tabular-nums` para **toda** columna/cifra
    de dinero (alineación en tablas = requisito). Self-hosted, sin CDN.
  - **Acento por barrio = aprobado** con regla de sutileza: solo línea del selector + tinte leve del
    header; nunca en acciones/estados; nunca reemplaza la marca; hue en banda 230°–335° que excluye
    marca y semánticos; contraste AA. Algoritmo en doc 06 §b.5.
  - **Tokens definitivos materializados** en `packages/design-tokens/` (`tokens.ts`, `semantic.ts` con
    light+dark, `barrio-accent.ts`, `README.md`). La Fase 6C construye la UI desde ahí (el `package.json`
    y el generador de CSS vars se agregan con el scaffold del monorepo).
  - **No queda ninguna decisión visual abierta para 6C.**
- **Confirmado:** conciliación de egresos → Inc. 2 (doc 01, nota como decisión confirmada).
- **Decisión tomada — 5 ejes del barrio (doc 03 §B.1):** modelo **híbrido** — columna enum con el valor
  **vigente** (lectura caliente + validación) + tabla `barrio_atributo_vigencia` como **historial**
  (auditoría / valor a una fecha); trigger sincroniza la columna (cache derivado; la tabla de vigencias
  es la fuente de verdad).
- **Nota para 6C (doc 05):** `unidad_obligado` multi-obligado + histórico se crea en el esquema desde el
  día uno aunque la UI del MVP cargue un solo obligado (evita migración cara con datos ya cargados).

**Próximo paso sugerido:** Fase 6C — scaffold del monorepo + `packages/data` con `0001_tenancy.sql`
probado en Docker (ambos modos de `app.current_user_id()`), modelo de dominio del barrio con RLS + seed
de modo demo, y portar el motor puro de conciliación con sus tests.

---

## 2026-07-22 — Fase 6A: andamiaje de stack/infra + agentes de dominio (Claude Code)

**Qué se cerró:**
- ADR de stack e infraestructura: `docs/arquitectura/00-stack-infra.md`. Decisión: TypeScript +
  Next.js (App Router) + Zod, reusados tal cual del sistema de gas (`trazabilidad-obra-gas`);
  agnóstico de proveedor vía tres abstracciones (datos con Drizzle+RLS, auth detrás de
  `AuthProvider`, storage S3-compatible detrás de `ObjectStorage`); migraciones con `drizzle-kit`
  (SQL plano, no atado a Supabase/Prisma). Documentado qué se reusa tal cual del sistema de gas y qué
  no (llamadas directas al SDK de Supabase, RLS con `auth.uid()` directo, hacks de bundle serverless
  de Vercel — el de `outputFileTracingIncludes` para fuentes de pdfjs deja de ser necesario en Docker).
- `docker-compose.yml` + `Dockerfile.dev` + `.env.example`: Postgres + MinIO local, servicio `app`
  bajo perfil `app` (se activa recién cuando exista el Next.js real en Fase 6B).
- Tres agentes de dominio dados de alta con la estructura portable del template (persona en
  `agents/personas/`, wrapper en `agents/wrappers-claude/`, copiados a `.claude/agents/` — ya
  activos en Claude Code): `administrador-consorcios`, `legal-ph`, `contador`. `legal-ph` y
  `contador` llevan guardrails duros: solo responden con base en `knowledge/<jurisdicción-activa>/`,
  citan fuente, distinguen por figura jurídica del barrio (PH especial/conjunto inmobiliario, SA,
  asociación civil, fideicomiso), y cierran con "Validar con profesional matriculado".
- Estructura de conocimiento jurisdiccional: `knowledge/JURISDICCION-ACTIVA.md` (activa: `cordoba`) +
  `knowledge/cordoba/{nacional,provincial,municipal,jurisprudencia}/` con placeholders (**sin
  normativa real cargada todavía**) + `docs/agents/guia-carga-conocimiento.md` (qué cargar en cada
  carpeta para Córdoba y de dónde sacarlo, fuente oficial, sin transcribir texto normativo).
- `CLAUDE.md`/`AGENTS.md` sincronizados: reglas duras concretas (agnóstico de proveedor, guardrails
  de `legal-ph`/`contador`, PII/RLS multi-tenant, trazabilidad de cifras de dinero, sin secretos),
  tabla de sub-agentes con los 3 nuevos.

**Qué NO se hizo (explícitamente fuera de alcance de esta fase, es Fase 6B):**
- Diseño de producto y modelo de datos (tablas, esquema Drizzle real, roles/usuarios).
- No se scaffoldeó código de Next.js ni el monorepo (`apps/`, `packages/`) — el ADR deja la forma
  prevista pero no se creó `package.json` todavía.
- No se decidió el adapter concreto de Auth (Supabase Auth vs Cognito vs GoTrue self-hosted) ni el
  hosting final (AWS vs Vercel/Supabase vs self-hosted) — el ADR es válido para los tres, queda
  abierto hasta que el usuario lo confirme.

**A confirmar por el usuario antes de seguir (ver ADR §10):**
- Proveedor de hosting final.
- Gestor de monorepo (sugerido: pnpm workspaces, no es decisión cerrada).
- Qué fuentes de Córdoba cargar en `knowledge/` (ver `docs/agents/guia-carga-conocimiento.md`) — sin
  esto, `legal-ph` y `contador` van a responder "no tengo esa fuente cargada" ante casi todo, que es
  el comportamiento correcto del guardrail, no un bug.

**Próximo paso sugerido:** Fase 6B — diseño de producto y modelo de datos (con `administrador-
consorcios` para la operatoria, `legal-ph`/`contador` en panel para lo que dependa de figura jurídica),
recién ahí se scaffoldea `package.json`/monorepo y se activa el servicio `app` del `docker-compose.yml`.
