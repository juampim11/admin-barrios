# CHANGELOG

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) + [SemVer](https://semver.org/lang/es/).
La versión se corta al desplegar a producción (ver `docs/devops/02-sdlc-git-flow.md` §5).

## [Sin desplegar]

### Fixed
- **Los acentos del seed demo.** Tres archivos habían quedado doble-codificados (UTF-8 guardado como cp1252) al reescribirse completos, y el padrón demo mostraba cada nombre acentuado partido en dos símbolos en la pantalla del administrador. Reparados los 228 lugares, base resembrada, y **regla 14 del test de arquitectura** para que ningún archivo de texto del repo vuelva a entrar con mojibake.

### Added
- **Las cinco trabas de navegación del recorrido (A-1 a A-5).** Vuelta explícita a Liquidación desde las pantallas del período; columna «Abrir» y tarjeta del mes abierto con «Continuar liquidación»; crear un período aterriza en su resumen y no en el paso 1; botón «Nuevo gasto» que nombra la acción; y **«Volver y corregir» en todo pedido de confirmación** —el prop es obligatorio, así que ninguna pantalla futura puede nacer sin salida—. Con ellas entra la primera pieza del kit v0: `Boton`, `BarraDeAcciones` y el estrato de cliente del kit, más el alto de control como token (44px, el objetivo táctil de doc 06 §f.6).
- **La máscara de dinero (reglas B-1 y B-1.bis del usuario).** Todo campo de importe muestra `2.500.000,00` mientras se escribe y **completa solo los decimales**: escribir `2500000` ya no rebota. La comodidad no le cuesta rigor al esquema —`montoSchema` sigue exigiendo dos decimales, que es lo que garantiza que el dinero llegue exacto a `numeric(14,2)`—: lo que normaliza es el campo, antes de enviar. Texto a texto, sin un `Number` en el camino, con 12 tests.
- **Atajo `Ctrl`/`⌘` + `K`** para abrir el selector de barrio desde cualquier pantalla (doc 06 §c.6.3), sin robarle las teclas a quien está escribiendo en un campo.

### Changed
- **−48 kB de JavaScript en todas las pantallas del barrio.** El índice del kit reexportaba el shell, que importaba la isla del selector: cualquier pantalla que importara aunque sea un botón se llevaba esa isla y su primitiva. La lista de períodos —lectura pura— pasó de 155 kB a 106 kB de First Load JS. La isla entra como prop desde el layout, que la importa por su subruta `cliente/*`, con lo que además la frontera se lee en el import. Cerrojo **UI-8** para que no vuelva.

- **Tanda 1 de ADR-0003: kit UI y shell multi-barrio.** Nuevo paquete `@admin-barrios/ui` con Tailwind v4 acotado, `@base-ui/react`, theme generado desde tokens, shell de administración y selector de barrio; la web lo transpila/importa sin convertir layouts en cliente. El seed demo suma `Barrio Demo Las Cortaderas` como segundo barrio del administrador para probar selector, aislamiento y estados vacíos. El gate incorpora los cerrojos de ADR-0003 §5.

- **Los documentos se bajan desde la pantalla** (tanda C). Las boletas ya no salen solo por comando:
  se generan desde `…/[periodo]/documentos`, con el avance a la vista, y se descargan de a una.
  - **`packages/almacenamiento`** — la interfaz `ObjectStorage` del ADR-0000 §3.3, con su adapter
    S3-compatible (MinIO local, S3 real o el endpoint de Supabase, sin cambiar código). Tres
    diferencias con la firma ilustrativa del ADR, cada una con su motivo: el `put` es **condicional**
    (un reintento no puede pisar un documento emitido y dejar intacto el `sha256` que lo acredita),
    `urlFirmada` recibe los encabezados de respuesta (el `no-store` de la aplicación no viaja al
    objeto), y **no hay `remove()`** — la retención por defecto es no purgar nunca.
  - **La cola es una tabla de Postgres**, no un servicio más que operar: `for update skip locked` +
    `pg_notify`. Disparo por evento (milisegundos, cero polling) con un barrido de rezagados cada 60 s
    como red de seguridad.
  - **`apps/worker`** — el proceso que renderiza. Toma el trabajo con la conexión que saltea la RLS y
    **eso es lo único que hace con ella**: el lote entero corre con `conUsuario()` y la identidad de
    quien apretó el botón. Si a esa persona le revocaron la membresía en el medio, el trabajo falla
    cerrado. En desarrollo corre en la máquina con `pnpm worker:dev`, sin contenedor nuevo.
  - **Tres tablas** (`0026`/`0027`): `trabajo`, `documento_emitido` y `descarga_documento`, esta
    última el registro de **acuñación de URLs firmadas** — el nombre de la columna es `url_firmada_at`
    y no `descargado_at` a propósito: con una URL firmada el objeto lo sirve el almacenamiento, así que
    sabemos que alguien pidió el link, no que lo bajó.
  - **La descarga es un `302` a una URL firmada de 90 segundos**, y la ruta recibe un `documentoId`,
    **jamás una clave de almacenamiento**: la credencial con la que se firma alcanza al bucket entero,
    y lo único que separa una boleta de todas las boletas de todos los barrios es que la clave haya
    salido de una fila leída bajo RLS.
  - **Gate de descarga por tipo de documento**, en la policy: el listado de saldos pendientes queda en
    `admin_plataforma`/`admin_barrio` y no lo alcanzan `operador`, `contador` ni `auditor` — que sí
    entran en `readable_tenant_ids()`. Y **`documento_emitido.vista` no se le concede en lectura al rol
    de request** (grant por columna): proyectarla es servir el documento entero sin pasar por la
    descarga ni por su registro.
  - **Regla 12 del test de arquitectura**: el SDK de almacenamiento solo lo nombra la puerta de cada
    aplicación. Hasta acá, nada impedía que un servicio de `packages/data` importara el SDK de S3.
  - **Se firma con la dirección que va a usar el navegador, no con la que usa el proceso**
    (`S3_ENDPOINT_PUBLICO`). Con la aplicación en un contenedor no son la misma, y no se puede
    corregir después de firmar porque la firma incluye el `host`.

### Fixed
- **`docker compose --profile app up -d` volvió a levantar.** Dejó de hacerlo en cuanto la web ganó
  una dependencia: pnpm quiere purgar los `node_modules` del volumen anónimo, pide confirmación, no
  hay TTY y aborta — con un error que no menciona dependencias por ningún lado.
- **`pnpm db:seed` limpia las tablas de documentos.** Su limpieza corre con
  `session_replication_role = replica`, que apaga también las claves foráneas, así que el barrio se
  borraba igual y quedaban documentos y trabajos apuntando a un barrio inexistente, acumulándose en
  cada sembrado.
- **Las pantallas de carga y emisión de la web del administrador** — con esto el primer recorrido del
  ADR-0002 anda entero sin abrir una terminal: crear un período, cargar los gastos del mes, aplicar un
  cargo o un descuento a una unidad, generar el borrador, revisarlo y emitir.
  - Rutas nuevas: `/[barrio]/liquidacion/nuevo`, `…/[periodo]/gastos`, `…/[periodo]/cargos`,
    `…/[periodo]/revision`. Más el recorrido dibujado en las cuatro pantallas del período.
  - **Siete Server Actions** en `apps/web/src/acciones/liquidacion.ts`, con la regla de los cuatro
    pasos del ADR-0002 §4.2 y los pasos comunes escritos una sola vez.
  - **Kit de formularios accesible** (`componentes/formulario.tsx`): el error va **en el campo** con
    `aria-invalid` + `aria-describedby`, el foco salta al primero, el identificador de correlación se
    selecciona de un click, y nada depende solo del color. Es el único módulo de cliente nuevo: las
    pantallas de lectura siguen costando cero JavaScript.
  - **La confirmación de un cargo inusual se trata como una confirmación y no como un error**: otro
    tono, otro verbo, y una casilla que hay que marcar. El reintento exige tres condiciones y sin las
    tres los valores salen intactos, así que la pantalla no puede confirmar sola.
  - Emitir es irreversible **y se ve antes de apretar**: el objeto se nombra completo (barrio, mes,
    boletas, total), las consecuencias están escritas y hay una casilla de acuse que valida el servidor.
  - La grilla de liquidaciones pasó a ser **una sola definición** (`[periodo]/grilla.tsx`) compartida
    por el resumen y la revisión.
- **`docs/diseno/10-informe-mensual-y-mora.md`**: análisis del **informe mensual real** del barrio
  piloto (el "Estado de cuentas" que viaja con la boleta del doc 09) y decisiones que salieron de ahí.
  - **Nueve hallazgos verificados** sobre el informe actual. Cuatro ya los cubre el alcance del doc 01
    §4.3; **cinco son requisitos nuevos**: el puente entre los débitos bancarios y los pagos a
    proveedores (hoy hay una brecha que ningún cuadro explica), el comparativo contra presupuesto y
    contra el mes anterior —hoy marcado `[MADURA]` y que este material sugiere que es de lo primero
    que se pide—, y tres defectos de composición que se resuelven por diseño (cuadro duplicado,
    referencias entre cuadros definidas y nunca usadas, y el desfasaje no declarado en el documento).
  - **El desfasaje de dos meses queda explicado y acotado**: son tres esperas encadenadas (extracto
    bancario, imputación manual de cientos de acreditaciones, llegada de comprobantes) más un criterio
    de completitud. **La meta es un mes, no cero**, y la habilitan cuatro piezas concretas
    (conciliación automática de ingresos, devengar por orden de pago, cierre con checklist bloqueante,
    stock de mora calculado).
  - **"Informe en tiempo real" se declara promesa no realista.** El informe mensual es un documento
    **cerrado** —una rendición que se emite, se distribuye y no se edita—; lo que sí puede ser en
    tiempo real es un **tablero vivo** para administrador y consejo, con cifras rotuladas como
    provisorias. Son **dos artefactos distintos**, y confundirlos es lo que hace que el informe llegue
    tarde y el tablero no exista.
  - **Regla de corte de lo que se publica del gasto**: al vecino, estructura y total; el nombre propio
    solo cuando el proveedor es institucional. Dos niveles de agrupación (concepto agrupado para el
    vecino, gasto individual para el directorio y quien lo pida, cuadrando al centavo contra el
    primero) y dos reglas duras de desagregación: **honorarios de administración con renglón propio,
    siempre**, y **todo renglón mayor al 5 % del gasto se desagrega** (umbral configurable, con default
    puesto). Más el caso mixto: **una razón social no es dato personal, pero cuando el proveedor es
    persona humana la razón social ES el nombre de una persona** → se publica el concepto.
- **Política de publicación de la mora, configurable** (doc 10 §E). **Decisión de producto del usuario**
  (director de la S.A. del piloto): en su barrio el listado va **nominado**, con nombre y manzana/lote,
  como convención del barrio para incentivar el pago. La decisión se respeta **y se vuelve
  configurable**, porque el producto se vende a barrios con la política opuesta. El modelo: modo
  `nominado` o `agregado`, destinatarios, **piso de importe** (para que un saldo residual de centavos
  no convierta en moroso publicado a un vecino al día), **exclusión de quien tiene plan de pagos al
  día** (publicarlo destruye el incentivo que el propio convenio creó) y **registro de quién publicó
  qué, a quiénes y con qué fecha de corte**. Se sostiene la separación de hoy: **documento y
  distribución propios, nunca adjunto a la boleta**, porque la boleta la recibe también el inquilino,
  que paga las ordinarias pero no es el deudor.

### Fixed
- **Un campo opcional de un formulario era imposible de dejar vacío**: el navegador manda `""` y
  `.nullable()` solo acepta `null`, así que dejar en blanco un vencimiento devolvía "fecha inválida
  (esperado YYYY-MM-DD)" sobre un campo rotulado "opcional". `opcionalDeFormulario()` en
  `packages/shared/src/escrituras.ts`, aplicado a los ocho campos opcionales que vienen de un `<form>`.
- **`apps/web/src/app/error.tsx` afirmaba que "todas las pantallas de esta versión son de lectura"**,
  que dejó de ser cierto. Una afirmación tranquilizadora que puede ser falsa hace que alguien no
  revise después de un error en el medio de una carga.
- Concordancia: los estados del período están en femenino porque describen la liquidación, y salían
  interpolados como "este período ya está emitida".

### Decided
- **Nadie del equipo puede dictaminar sobre la legalidad de publicar el listado de mora nominado**: la
  **normativa de protección de datos personales no está cargada** en `knowledge/`, así que `legal-ph`
  responde "no tengo esa fuente cargada" y eso es el guardrail funcionando, no un bug. Lo que respalda
  la práctica del piloto es una **resolución del órgano competente del barrio** — un hecho verificable
  del barrio, **no un dictamen de legalidad**. El sistema implementa las dos modalidades, exige
  declarar cuál eligió el barrio y con qué instrumento, y **no sugiere default** (mismo criterio que el
  del criterio de reparto, doc 08 §B).

### Added
- **Generación de documentos, primera fase (ADR-0001).** Sale la boleta de expensas en PDF de punta a
  punta: `pnpm demo:boleta` emite las 50 boletas del período del seed en 8 s, en una sola pasada.
  - `packages/shared/src/documentos/` — el modelo de vista `VistaBoleta`, puro y validado con Zod. Es
    el contrato que alimenta por igual al PDF, al email y a la vista web, y el que se congela con
    cada documento emitido. **Toda cifra viaja con su valor exacto y con la cadena impresa**, y Zod
    verifica que la segunda salga de la primera: el bug de `Intl` degradando a formato en-US en un
    runtime sin ICU completo pasa a ser imposible de no ver.
  - Invariantes de dinero en el contrato, no en la plantilla: las líneas suman el total del período,
    el total a pagar es total + saldo anterior + interés, y **el importe del cupón es el mismo que el
    del titular**. Una vista que no cierra no llega al motor.
  - `packages/documentos/` — plantilla HTML de la boleta, renderizador de símbolos, puerto
    `MedioCobranza` con el adapter `generico-demo`, puerto `GeneradorDocumento` y su adapter de
    Chromium (un pase por lote y split con `pdf-lib`, red apagada en el renderizador).
  - `packages/data/src/servicios/vista-boleta.ts` — armado desde la base bajo RLS, **4 consultas para
    N boletas** (sin N+1).
  - Proyecto de tests nuevo `pdf` (`pnpm test:pdf`), fuera del gate barato: round-trip real del código
    de barras con un lector de verdad y humo del PDF con Chromium.

### Security
- **La muestra comercial no puede cobrar, y se afirma en positivo.** El adapter `generico-demo` emite
  un código de barras real y escaneable sobre un convenio inexistente con el dígito verificador
  deliberadamente roto, y un CBU de 22 dígitos con **los dos** verificadores incorrectos (el home
  banking lo rechaza antes de pedir confirmación). `verificar()` **falla si alguno de esos
  instrumentos resultara válido**: una boleta que se ve real, con un CBU real, es una boleta que
  alguien paga, y la muestra se va a reenviar por WhatsApp.
- **La marca de agua `MUESTRA — SIN VALOR DE PAGO` no se puede apagar.** No es una opción de
  configuración ni un elemento de la plantilla: sale de `bloquePago.sinValorDePago` y la estampa el
  renderizador sobre el DOM ya cargado, con estilos que el markup no puede pisar.
- **Red apagada en el renderizador.** Chromium renderiza texto cargado por el administrador; se
  intercepta cada request y se aborta todo lo que no sea `data:` o `about:blank`. El adapter lleva la
  cuenta de lo abortado y hay un test que fuerza un `<img src="http://169.254.169.254/…">` para
  comprobar que no sale.
- **Dos fallas silenciosas del generador de códigos, cerradas con guardas propias.** Con cantidad
  impar de dígitos en Interleaved 2 of 5, `bwip-js` **antepone un `0` sin error** y el símbolo
  codifica un número distinto del impreso debajo (verificado con lector real); y su fondo por defecto
  es transparente, con el que el código **no se lee**. Ambas viven en el renderizador, así que todo
  adapter de cobranza futuro las hereda.
- **No se pierde una línea de dinero por desborde, ni a lo alto ni a lo ancho.** Si una zona de
  tamaño acotado no entra, la emisión falla con el nombre de la zona en vez de recortar en silencio.
  Las dos direcciones las encontró un PDF real: **a lo alto**, el detalle perdía un concepto mientras
  el total de la composición lo seguía sumando; **a lo ancho**, el código de barras —que mide los
  182 mm útiles enteros— se derramaba fuera de su caja y el QR se imprimía **encima de su último
  24 %**, zona muda incluida, dejándolo ilegible sin que se notara al mirar la hoja.
- **El cupón se verifica sobre la hoja impresa, no sobre el descriptor.** El round-trip que ya había
  regeneraba el símbolo aparte, así que verificaba la carga y no la geometría — que es donde estaba la
  falla. Se agrega un canario que renderiza la boleta, recorta la zona del cupón de la página y se la
  pasa a un lector de verdad (ADR-0001 §7.2, compuerta 2).
- **Emitir el padrón exige rol de administración.** `app.accessible_tenant_ids()` mira que haya
  membresía activa sobre el barrio, **no el rol**: un `propietario` pasaba las policies de
  `liquidacion`. Y exportar las N liquidaciones como documentos, con el nombre del obligado de cada
  unidad, es autorización sobre una **operación**, no sobre filas — algo que la RLS no expresa. El
  gate va en el servicio, en la misma consulta y sin round-trip extra.
- **El instrumento no se arma sin numeración ni con importe negativo.** Sin `numero_comprobante`
  todas las boletas del período recibían el mismo código de barras, el mismo código electrónico y el
  mismo QR, byte a byte; y un saldo a favor se codificaba como una deuda del mismo monto, porque el
  layout de la carga no tiene lugar para el signo.
- **JavaScript apagado en el contenido del renderizador**, además de la red. La plantilla no tiene ni
  una línea de script, así que apagarlo saca de la superficie todo lo que un `<script>` inyectado por
  un campo de texto podría intentar. Se verifica el **efecto** y no la llamada: la opción toma efecto
  en la próxima navegación y `setContent()` es una navegación, así que puesta en el orden equivocado
  no protegería nada y el test pasaría igual.
- **El interceptor filtra por mediatype, no por prefijo `data:`.** Un `data:text/html` es un documento
  nuevo y un `data:text/css` puede traer un `@import`. La lista blanca es espejo exacto de los
  schemas de logo y de fuente: si divergieran, ganaría el más laxo.

### Fixed
- **El porcentaje impreso usaba un denominador distinto del que repartió la plata.** La suma de
  coeficientes ignoraba la baja lógica de las unidades, así que en cualquier barrio con una unidad
  dada de baja después de cerrar la versión el coeficiente impreso quedaba por debajo del real y la
  cuenta dejaba de poder rehacerse con una calculadora — por mucho más que el "$ 0,01 por unidad" que
  promete la leyenda fija del documento.
- **El interés dejó de explicarse con datos inventados.** La tasa, los días y la fecha de corte
  salían con `?? "0"` y `?? fecha_de_hoy`, y el camino **cotidiano** —unidad al día, con tasa
  cargada— llega sin fecha de corte porque el check de la base lo exime. La hoja imprimía la fecha
  del servidor como si fuera un hecho del expediente. Ahora imprime solo lo que existe. Ídem la fecha
  de emisión: un período en borrador no tiene una, y ya no se rellena con la de hoy.

### Security
- **El importe de un cargo dejó de ser escribible por el cliente** (`0017`). La auditoría del módulo
  de cargos y descuentos encontró que el "snapshot del catálogo" lo escribía el request: se podía
  aplicar el concepto legítimo *Alquiler de quincho ($38.000)* mandando `precio_unitario = 9.500.000`
  y **todos los controles cerraban**, porque el check verificaba la fila contra sí misma y el cuadre
  comparaba la boleta contra ese mismo importe inventado. Ahora el request manda solo *qué concepto,
  a qué unidad, de qué período, cuándo, cuántas unidades y por qué*; el resto lo escribe la base
  copiándolo del catálogo, y el importe lo resuelve `app.resolver_aplicaciones()` derivando la base de
  cálculo de la propia liquidación. `app_request` perdió el UPDATE sobre la tabla: conserva solo las
  tres columnas de la anulación.
- **El tope por rol del `operador` no se ejecutaba nunca**: se evaluaba `importe_resuelto` en el
  INSERT, donde por diseño siempre es nulo. Un operador con techo de $500 podía escribir un descuento
  de $250.000. Ahora se controla contra el monto fijo o el tope del porcentual —que ya son confiables
  porque los puso la base—, se suma el **acumulado por unidad y período** (si no, el techo se evadía
  partiendo el descuento en varios conceptos chicos) y se usa `porcentaje_max_operador`, que estaba
  declarado y no se leía en ningún lado.
- **El registro de auditoría era falsificable**: `app_request` tenía INSERT, así que un administrador
  podía fabricar una anulación firmada por un operador. Se le revoca; lo escribe solo el trigger.
- **Divergencia dev/prod que hubiera roto producción**: los triggers `security definer` funcionaban
  solo porque en desarrollo el dueño del esquema es superusuario. En un Postgres administrado no lo
  es y, con `force row level security`, queda sujeto a las policies: **cada cargo aplicado por un
  `operador` habría fallado entero** al no poder escribir su evento de alta. Las funciones pasan a ser
  propiedad de `app_job` (BYPASSRLS), y hay un test con rol `operador` que lo cubre.
- **El tope recortaba también los CARGOS**: un cargo de tres reservas a $38.000 con un "tope" de
  $50.000 se facturaba $50.000 y el barrio perdía $64.000 **sin que el cuadre lo viera**. El tope es
  el techo de un descuento; en un cargo ahora es inexpresable, en el catálogo y en la aplicación.
- Menores del mismo bloque: `aplicado_at` y `anulado_at` dejaron de ser retrodatables; el log de
  eventos se ata por `(aplicacion_id, barrio_id)`; `app.concepto_valor_vigente` filtra por tenant.
- **Tres agujeros cerrados**, encontrados por el panel de implementación en código ya mergeado
  (`0013_seguridad_periodo.sql`):
  - **La firma de quién emitió un período era autoatribuible**: se escribía desde un argumento de la
    aplicación y nada verificaba que fuera el usuario de la sesión. Ahora la pone la base con
    `app.current_user_id()`, y `emitirPeriodo()` **ya no recibe el usuario**.
  - **`app.periodo_editable` fallaba ABIERTO**: si no lograba resolver el período, `NULL in (...)` daba
    NULL, el `if` no entraba y la escritura pasaba. Ahora rechaza — con la única excepción del borrado
    en cascada, donde el padre ya desapareció legítimamente.
  - **Un período podía nacer `emitida`**, saltándose la validación de cuadre por completo: el control
    de transiciones solo corría en UPDATE. Ahora nace en borrador y las marcas de emisión las pone la
    base, no quien inserta.

### Changed
- **Dar de alta un concepto exige declarar su encuadre fiscal** (`0012` + `0014`). El default era
  `no_alcanzado`: cada concepto nuevo afirmaba **por omisión** que no está alcanzado por IIBB, sin que
  nadie lo hubiera mirado — contra la regla del proyecto de no presuponer encuadre. Se agrega
  `sin_clasificar` como valor explícito y se elimina el default.

### Added
- **Base de prorrateo `partes_iguales`** (`0010` + `0011`): con `parte_indivisa` era **imposible de
  cerrar** cuando N no divide exacto en 9 decimales (3 unidades → 0,999999999 ≠ 1). Ahora la versión
  cierra, y la validación exige que **todos los coeficientes sean iguales** — si una unidad quedó con
  otro valor, el barrio cree que reparte en partes iguales y no lo está haciendo.
- Decisiones del usuario sobre el financiamiento de los descuentos y la regla de "vecino cumplidor"
  (doc 08 §N.bis).

### Added
- **`docs/diseno/08-criterios-de-reparto.md`**: decisiones del panel sobre cómo se reparte la expensa
  (partes iguales, superficie lineal, escalas por tramos, % de reglamento, monto fijo, por concepto) y
  sobre la extraordinaria en comprobante separado. Incluye el orden de construcción en 7 pasos y las
  dos decisiones estructurales que hay que fijar antes del módulo de cobros: **la mora se computa por
  obligación con su propio vencimiento**, y **la deuda se imputa al comprobante, nunca al par
  (período, unidad)**.

### Added
- **Trazabilidad de la liquidación** (`0008_trazabilidad.sql` + `0009_trazabilidad_reglas.sql`), de los
  hallazgos del panel de agentes: cada línea guarda **`monto_teorico`** (`base × coeficiente`, lo que da
  la calculadora) y **`ajuste_redondeo`** explícito; snapshots de `clasificacion_fiscal`,
  `sin_respaldo_asamblea` y título del acta (el catálogo de conceptos es editable después de emitir);
  **días de atraso y fecha de corte** de la mora (sin eso el interés no se puede rehacer a mano);
  **número de comprobante** legible; **origen del saldo anterior**; y la **denominación del concepto
  congelada en el período** (la figura jurídica se versiona: no puede cambiar retroactivamente la
  etiqueta de lo ya emitido).
- **`medio_pago_barrio`**: dónde paga el propietario. Faltaba, y sin eso el campo más leído del PDF
  sale vacío.
- **`docs/diseno/07-liquidacion-pdf.md`**: decisiones del panel (motor, estructura, alcance, respaldo
  de la extraordinaria, lenguaje prohibido, seguridad del módulo).

### Fixed
- **El reparto de los centavos sobrantes ya no cae entero en la última unidad**: se distribuye por
  mayor residuo, así ninguna unidad se desvía más de un centavo de lo que da la cuenta a mano (antes,
  con 37 unidades, la última podía recibir 36 centavos de golpe).

### Security
- **La conexión de jobs (BYPASSRLS) ya no puede usarse como si estuviera aislada.** `conUsuario()`
  aceptaba cualquier conexión: el `set_config` se ejecutaba, el código **se leía** aislado y no aislaba
  nada. Ahora los tipos lo impiden (`DbRequest` / `DbJob` / `DbMantenimiento`).

### Changed
- **Dos modelos de expensa** (corrección del usuario, 2026-07-24): además del **variable** (lo que se
  cobra sale de los gastos del mes), ahora existe el **fijo** — una **cuota mensual** que fija el
  directorio o el administrador, versionada (`cuota_fija_version` + importe por unidad). El modelo se
  elige **por período**, así un barrio puede cambiar de criterio sin perder cómo se liquidó cada mes.
  En el modelo fijo las **extraordinarias se prorratean aparte** y los gastos ordinarios se registran
  sin volver a cobrarse. El control de cuadre al emitir se adaptó a cada modelo.
- **Una expensa extraordinaria ya NO exige acta de asamblea** (corrección del usuario): pasa en la
  operatoria real. Se carga igual y la base la **marca** (`sin_respaldo_asamblea`, puesta por trigger)
  para que la liquidación y el resumen lo informen; el respaldo pesa al **reclamar** la deuda, no al
  registrar el gasto.

### Added
- **Expensas y liquidación mensual (Fase 6C)** — migraciones `0004_expensas.sql` y
  `0005_expensas_rls.sql`: `concepto` (con clasificación fiscal y fondo de reserva), `tasa_mora`
  versionada, `periodo_expensa` con estados `borrador -> revisada -> emitida -> distribuida`,
  `gasto_periodo`, `liquidacion` e `item_liquidacion` **con el origen de cada línea** (de qué gasto
  sale y con qué coeficiente).
- **Controles en la base**: una extraordinaria **exige el acta** que la respalda (art. 2048); un
  período **emitido no se edita**; **no se emite descuadrado**, ni con unidades sin liquidar, ni con
  una versión de coeficientes abierta.
- **Cálculo puro en `@admin-barrios/shared/liquidacion`**: prorrateo por coeficiente donde la suma de
  lo cobrado es **exactamente** el gasto del período, subtotales separados (ordinarias /
  extraordinarias / fondo de reserva) e **interés de mora simple**. Sin tasa cargada, la liquidación
  sale marcada como **"mora pendiente de definición"** en vez de inventar una tasa.
- **Servicio de liquidación** (`packages/data/src/servicios/liquidacion.ts`): genera y regenera las
  liquidaciones de un período en borrador y emite el período.
- **El modo demo ahora incluye un período liquidado y emitido** de punta a punta (5 conceptos, tasa de
  mora del reglamento, 50 liquidaciones), generado con el mismo servicio que usa la app.
- 13 tests nuevos contra Postgres real (60 en total) + 13 unitarios del cálculo (30 en total).
- **Padrón del barrio (Fase 6C)** — migraciones `0002_dominio.sql` y `0003_dominio_rls.sql`: `barrio`
  con los **5 ejes versionados** (`barrio_atributo_vigencia` como fuente de verdad + columnas cache
  sincronizadas por trigger y `app.valor_eje_vigente()` para consultar a una fecha), `unidad_funcional`
  (baldías incluidas, art. 2077), `unidad_contacto`, `obligado` y `unidad_obligado` **multi-obligado con
  histórico** (arts. 2049/2050), `coeficiente_version`/`coeficiente` con **cierre que exige cuadre**
  (exacto = 1 en parte indivisa; pesos relativos en superficie/lote/mixto, art. 2081),
  `documento_barrio` y `mandato_administracion` versionado (arts. 2065/2066).
- **FKs compuestas `(id, barrio_id)`** en todo el dominio: mezclar datos de dos barrios es imposible a
  nivel base, incluso para el rol que saltea la RLS.
- **`packages/shared/barrio`**: los 5 ejes como constantes y esquemas Zod compartidos,
  `sugerirDenominacionConcepto()` (devuelve `null` cuando no hay fuente cargada, en vez de inventar) y
  `faltantesParaViaEjecutiva()` (nunca afirma que la deuda sea ejecutable: dice qué falta).
- **Modo demo** (`pnpm db:seed`): barrio ficticio de 50 unidades con baldías, propietarios, un poseedor
  cada diez unidades, coeficientes cerrados que suman exactamente 1 y documentos del barrio. Idempotente.
- 20 tests nuevos contra Postgres real (47 en total).
- **Fundación de código (Fase 6C, Etapa 0)** — monorepo **pnpm workspaces** con `apps/web` (Next.js
  App Router 15 + React 19), `packages/shared` (dominio puro: dinero exacto en centavos con prorrateo
  que siempre cierra, jerarquía de tenancía, Zod), `packages/data` (Drizzle + Postgres) y
  `packages/design-tokens` (ahora con `package.json` y generador de variables CSS).
- **Aislamiento multi-tenant real y probado**: migraciones `0000_tenancy.sql` (tablas `tenant_node`,
  `membership`, `tenant_grant`, enums, índices con `text_pattern_ops`) y `0001_tenancy_rls.sql`
  (`app.current_user_id()`, `accessible_tenant_ids()`, `has_role_on()`, triggers de materialized path
  y de re-parentado, roles `app_request`/`app_job` y todas las policies). **27 tests contra Postgres
  real**: barrios hermanos que no se ven, membresía inactiva, soft-delete, prefijo `1.7` vs `1.70`,
  escritura por rol, baja lógica, `tenant_grant`, re-parentado con reescritura de paths, y
  `app.current_user_id()` **en sus dos modos** (`SET LOCAL` y `auth.uid()` de Supabase) incluida la
  no-fuga de identidad entre requests del pool.
- Gate local y en **CI (GitHub Actions)**: `pnpm typecheck`, `pnpm test`, `pnpm test:db`, tokens al
  día y `pnpm build`, con un Postgres real en el runner; corre en cada push de rama y en el PR.
  Servicio `app` del `docker-compose.yml` activado (Dockerfile de desarrollo con pnpm).

### Decided
- **Gestor de monorepo: pnpm workspaces** (cerrando el punto abierto del ADR-0000 §10).
- **El módulo contable queda FUERA del MVP** (decisión del usuario, 2026-07-24): libro contable,
  resumen fiscal por concepto y balance por figura son, en la práctica, un ERP. El MVP entrega una
  **exportación de movimientos** (planilla de ingresos/egresos con su concepto) para que el
  administrador se la pase a su contador. La clasificación fiscal se sigue guardando en el dato, así
  que evaluarlo más adelante no obliga a recargar nada. Docs 01 §1.1/§4.8 y 05 actualizados.

### Added (fases 6A y 6B)
- **Diseño de producto (Fase 6B)** en `docs/diseno/`: alcance y módulos con corte de MVP básico y
  mostrable (`01`), reúso del motor de conciliación del sistema de gas con pasos de migración (`02`),
  modelo de datos con multi-tenancy jerárquica por materialized path + RLS por subárbol (`03`),
  requisitos legales y fiscales por figura citando `knowledge/cordoba/` (`04`), roadmap por etapas con
  modo demo y multi-banco (`05`), y **dirección visual** (principios, design tokens con modo oscuro,
  navegación multi-barrio, wireframes de las 5 pantallas clave, patrones y accesibilidad AA) (`06`).
- Revisión 6B: conciliación de egresos **confirmada** en Inc. 2; **modelo híbrido** de los 5 ejes del
  barrio (columna enum vigente + `barrio_atributo_vigencia` como historial); nota de `unidad_obligado`
  multi-obligado desde el día uno en el esquema.
- **Tokens de diseño materializados** en `packages/design-tokens/` (`tokens.ts`, `semantic.ts` con
  modo claro y oscuro, `barrio-accent.ts`, `README.md`) — dirección "Verdemar" (teal + ámbar), Geist +
  Geist Mono con `tabular-nums`, acento por barrio acotado. Ratificada la dirección visual (paleta A,
  tipografía Geist, acento por barrio); doc 06 actualizado.
- **Roster técnico de ingeniería (perfiles super-senior)**: `product-owner`, `analista-funcional`,
  `arquitecto-software`, `tech-lead`, `ux-designer`, `backend-dev`, `frontend-dev`, `devops`,
  `qa-funcional`, `qa-automation`, `security-engineer`, `dba-data` (persona + wrapper, activados en
  `.claude/agents/`); tablas de roster sincronizadas en `agents/README.md`, `CLAUDE.md` §3 y `AGENTS.md`.
- Andamiaje de arquitectura (Fase 6A): ADR de stack e infraestructura agnóstica de proveedor
  (`docs/arquitectura/00-stack-infra.md`), `docker-compose.yml` (Postgres + MinIO local).
- Tres agentes de dominio: `administrador-consorcios`, `legal-ph`, `contador` (persona + wrapper,
  activados en `.claude/agents/`).
- Estructura de conocimiento jurisdiccional `knowledge/cordoba/{nacional,provincial,municipal,jurisprudencia}/`
  (placeholders, sin normativa real cargada todavía) y guía de carga (`docs/agents/guia-carga-conocimiento.md`).
