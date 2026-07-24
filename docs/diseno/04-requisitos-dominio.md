# 04 — Requisitos de dominio (legal y fiscal), por figura — Córdoba

> **Fase 6B — diseño de producto.** Requisitos legales y contables que el sistema debe respetar,
> **distinguiendo por figura jurídica**. Cada requisito remite a su archivo de `knowledge/cordoba/` y a
> su **marca de confianza**. Elaborado con los agentes de dominio `legal-ph` y `contador`, respetando
> sus guardrails (solo `knowledge/`, cita en cada afirmación, no inventar).
>
> **Jurisdicción activa:** `cordoba`. **Estado de la base:** los archivos están marcados
> `sources_status: borrador-para-validar`; el núcleo fiscal cargado es `provincial/02`, el resto del
> régimen impositivo (alícuotas, Sellos, Inmobiliario, retenciones) figura pendiente.

## Marcas de confianza (leyenda)

- `[VERIFICADO]` — afirmación con fuente oficial identificada en la base.
- `[A VERIFICAR]` / `[A VERIFICAR — CRÍTICO]` — hay indicio pero falta confirmar contra el texto vigente.
- `[NO ENCONTRADO]` — la base no localizó la fuente.
- **[SUPOSICIÓN]** — no cubierto por la base; deriva de razonamiento, a validar.

> **Aviso de vigencia (transversal).** `nacional/01` marca `[A VERIFICAR — IMPORTANTE]` que hay indicios
> de modificaciones posteriores al CCyC (referencias a **Ley 27.799** y **Decreto 338/2025**): confirmar
> el texto vigente en InfoLeg antes de citar cualquier artículo, porque numeración y redacción pueden
> haber cambiado. Todos los números de artículo de abajo se citan tal como constan en la base, sujetos a
> esa verificación. **Validar con profesional matriculado.**

---

## PARTE A — Requisitos LEGALES por figura

### A.1 Regla rectora: el sistema NUNCA debe asumir que la deuda es ejecutable

`[VERIFICADO]` Es la conclusión más importante de la investigación jurídica (`REQUISITOS §5`,
`jurisprudencia/01`). Fundamento:

- En **PH**, el art. 2048 último párrafo CCyC da al certificado de deuda del administrador (aprobado por
  el consejo, si existe) carácter de **título ejecutivo** `[VERIFICADO]` (`nacional/04`, `nacional/01`).
- En **conjuntos inmobiliarios**, el art. 2081 **no reproduce** esa cláusula: la ejecutividad se
  **deriva** de la remisión del art. 2075 2° párr. `[VERIFICADO]` — es lo que se litiga si el ente no se
  adecuó.
- En **SA no adecuada**, la fuerza ejecutiva **no está garantizada**: depende del tribunal, del fuero y
  de la instrumentación `[VERIFICADO]` (`jurisprudencia/01`).

**Jurisprudencia cargada:**

| Caso | Criterio | Marca |
|---|---|---|
| CNCom en pleno, *"Barrio Cerrado Los Pilares S.A. c/ Álvarez"*, 04/05/2015 | Antes del CCyC: no corresponde fuerza ejecutiva al certificado de un club de campo/barrio preexistente | `[VERIFICADO]` |
| CNCom Sala C, *"Altos de los Polvorines S.A. c/ Castaño"*, oct. 2016 (**restrictivo**) | Sin adecuación acreditada, la SA **no** puede reclamar ejecutivamente | `[VERIFICADO]` |
| CNCiv Sala A, *"Lagunas del Polo Barrio Cerrado SA c/ G.L.G."*, 28/08/2015 (**permisivo**) | El art. 2075 somete los conjuntos a PH → aplica la vía ejecutiva | `[VERIFICADO]` |
| *CSJN "Club de Campo Haras del Sur S.A."*, 23/10/2007 (**societario**) | Ejecutividad fundada en la naturaleza societaria del vínculo | `[VERIFICADO]` |
| Fallo plenario 2023 | Fuerza ejecutiva a un conjunto preexistente no sometido al derecho real de PH | Existencia `[VERIFICADO]`; **tribunal/carátula/ámbito `[A VERIFICAR]`** |
| Juzgado Civ. y Com. 50ª Nom., **Córdoba** | **Rechazó** el cobro ejecutivo en un barrio sin características de barrio cerrado (calles/plazas públicas, **sin espacios comunes exclusivos**), con planteo de superposición con impuestos municipales | `[VERIFICADO]` |

`[A VERIFICAR]` **Vacío clave:** falta jurisprudencia del **TSJ de Córdoba** y de las **Cámaras Civiles
y Comerciales de Córdoba**. Hasta cargarla, no hay criterio provincial firme.

**Lección de diseño `[VERIFICADO]`:** no alcanza la figura; también pesa si el barrio **materialmente**
tiene espacios comunes propios.

### A.2 Flags a registrar por barrio (para no asumir ejecutabilidad)

`[VERIFICADO]` (`jurisprudencia/01`, `REQUISITOS §5`): `figura_juridica`, `adecuado_art_2075`,
`reglamento_inscripto` (constituye el derecho real y designa administrador, arts. 2038/2056 inc. r),
`pacto_ejecutividad` (validez **discutida** en doctrina), `tiene_espacios_comunes_exclusivos`.
El sistema debe registrar el **instrumento sobre el que se funda** cada deuda (los tribunales observaron
la incoherencia de invocar el CCyC solo cuando conviene).

### A.3 Dos caminos de reclamo

`[VERIFICADO]` (`jurisprudencia/01`, `REQUISITOS §5`): modelar **al menos dos caminos** (ejecutivo /
ordinario) y **sugerir** el aplicable según los flags, **siempre** con aviso de validación profesional.
El certificado de deuda se genera con la forma del art. 2048 (emitido por el administrador; aprobado por
el consejo si existe) y trazabilidad completa (quién, cuándo, qué períodos, sobre qué instrumento).

### A.4 Deber de adecuación (art. 2075 CCyC)

`[VERIFICADO]` El art. 2075 tiene tres tramos (`nacional/01`): (1) lo urbanístico se rige por normas
administrativas de cada jurisdicción; (2) todos los conjuntos **deben someterse** al derecho real de PH;
(3) los **preexistentes** como derechos personales/mixtos **deben adecuarse**. El CCyC **no fijó plazo
ni sanción** `[VERIFICADO]` → de ahí la controversia (de la adecuación "funcional" hasta el planteo de
inconstitucionalidad).

**IGJ (ámbito NACIONAL/CABA — NO rige directamente en Córdoba)** `[VERIFICADO]` (`nacional/03`): RG
25/2020 (intimó, 180 días) → RG 27/2020 (360 días) → **RG 4/2024** (adecuación "funcional" voluntaria:
adaptar estatutos + "Reglamento de Adecuación", sin convertir necesariamente el derecho real).

`[NO ENCONTRADO]` **No se localizó una resolución de la IPJ de Córdoba equivalente** (`provincial/01`).
Hasta cargar la fuente, el agente responde **"no tengo fuente cargada sobre el criterio de adecuación en
Córdoba"** y **no extrapola** el criterio de la IGJ nacional.

**Modelo:** `adecuado_art_2075` ∈ {sí, no, en trámite, no aplica}, **versionado**. El deber pesa sobre
preexistentes constituidos como derechos personales/mixtos (típicamente **SA y asociación civil**); un
barrio ya constituido como PH especial es `no_aplica`; fideicomiso/geodesia **[SUPOSICIÓN]**.

### A.5 Órganos de gobierno y administración, por figura

**PH / conjunto inmobiliario** `[VERIFICADO]` (`nacional/05`): consorcio persona jurídica (art. 2044),
órganos = **asamblea, consejo (si lo hay), administrador**. Asamblea (art. 2058), convocatoria y **orden
del día** con transcripción (art. 2059; nulo tratar temas fuera de él salvo presencia total +
unanimidad; autoconvocatoria 2/3), **quórum no definido por ley** (surge del reglamento, **puede estar
ausente** — no imponer default), **mayorías art. 2060** (doble exigencia: unidades **y** partes
indivisas, sobre **la totalidad del padrón**), reforma de reglamento 2/3 (art. 2057), **libro de actas +
registro de firmas** (art. 2062). **Consejo (arts. 2063/2064):** convoca ante omisión del administrador,
**autoriza a disponer del fondo de reserva** (2064 inc. c), **aprueba el certificado de deuda** (2048);
**puede no existir**. **Administrador (arts. 2065/2066/2067):** nombrado/removido por asamblea, removible
sin causa; es un **rol con mandato** (designación/cese ligado a acta), **versionado**; su cambio no
dispara reforma de reglamento.

**SA** `[A VERIFICAR]` (`nacional/02`): mapeo **funcional, no jurídico** — asamblea de accionistas,
**directorio**, sindicatura; estatuto + reglamento interno. El sujeto de derecho es **la sociedad**, no
el consorcio `[VERIFICADO]`. El modelo debe poder representar **directorio / asamblea de accionistas**,
no solo administrador / asamblea de propietarios.

**Asociación civil / fideicomiso / geodesia:** **no tengo esa fuente cargada** con detalle de órganos
(`nacional/03` `[A VERIFICAR]`; geodesia `[fuente a cargar]`) → **[SUPOSICIÓN]** hasta cargar.

### A.6 Fondo de reserva

`[VERIFICADO]` (`nacional/04`): art. 2046 inc. d — contribuir **"si lo hay"** (no automáticamente
obligatorio; depende del reglamento); art. 2064 inc. c — el **consejo** autoriza **disponer** del fondo
ante gastos imprevistos. **Modelo:** cuenta **separada** con reglas propias; configurar si el barrio lo
tiene y cómo se integra; **exigir registro de la autorización** antes de imputar; reportar saldo por
separado. Base **legal-reglamentaria** en PH; **estatutaria/contractual** en SA/asociación/fideicomiso
(**[SUPOSICIÓN]**, sin norma específica cargada para esas figuras).

### A.7 Documentos de primera clase por barrio

`[derivado — REQUISITOS §9]`, con fundamento en los artículos citados: reglamento de PH (o estatuto +
reglamento interno si es SA) — fuente de coeficientes/quórum/mayorías/mora `[VERIFICADO]`; instrumento
municipal de aprobación (define qué servicio presta quién); actas de asamblea `[VERIFICADO]` (arts.
2048/2058/2062); acta de designación del administrador `[VERIFICADO]` (arts. 2065/2066); constancia de
adecuación (art. 2075); pacto de ejecutividad (`jurisprudencia/01`).

---

## PARTE B — Requisitos FISCALES por figura

### B.0 La figura es la primera variable fiscal

`[VERIFICADO]` (`provincial/02` "Impacto" p.3): la figura condiciona el encuadre fiscal → refuerza que
`figura_juridica` sea atributo de primera clase, **versionado** (`REQUISITOS §1`). Ningún requisito
fiscal se resuelve con un único parámetro global.

### B.1 IIBB sobre expensas

**Hallazgo central** `[VERIFICADO — existencia]` (`provincial/02`, **Ley 10117** que modifica el Código
Tributario de Córdoba): el inciso alcanza a "los importes en concepto de **expensas o contribuciones
para gastos comunes o extraordinarios** (…) **incluyendo las cuotas sociales permanentes y de pago
periódico**", respecto de "countries, clubes de campo, clubes de chacra, barrios cerrados, barrios
privados y demás urbanizaciones", y también PH. Dos consecuencias: (1) cubre **expresamente countries y
barrios cerrados**; (2) la mención a "cuotas sociales permanentes y de pago periódico" es la forma de la
**SA** (y la asociación civil).

`[A VERIFICAR — CRÍTICO]` **Qué efecto exacto produce el inciso** (si **excluye** de la base, si
**exime**, u otro) **debe confirmarse en el texto ordenado vigente**. La descripción es el **supuesto
alcanzado**, no su **consecuencia jurídica**. → **Requisito:** el sistema **no debe presuponer** que las
expensas están gravadas ni excluidas; modela el tratamiento IIBB como **parámetro configurable
dependiente del efecto verificado**, y **bloquea** cualquier cálculo automático de IIBB sobre expensas
hasta que ese efecto esté cargado y validado.

**Consulta CV 018/2012** `[VERIFICADO]`: Rentas Córdoba, IIBB y expensas comunes. **Límite temporal
obligatorio** — es **anterior al CCyC (2015) y a la Ley 10117**; sirve para el **razonamiento**, no como
criterio vigente sin más; verificar si fue superada.

**Alícuotas** `[A VERIFICAR]`: la **ley impositiva anual** (alícuotas IIBB/Sellos) **no está cargada** →
la alícuota es un **dato externo, versionado por ejercicio**, que ingresa validado, nunca constante en
código.

**Renumeración (regla dura)** `[VERIFICADO]`: el Código Tributario se **renumera** entre textos
ordenados (referencias detectadas: inciso Ley 10117 en art. 205; exenciones objetivas art. 208;
subjetivas art. 241 — **todas a verificar**). Toda cita de artículo del Código Tributario debe salir con
la leyenda "verificar numeración en texto ordenado vigente".

| Figura | ¿La cubre el inciso Ley 10117? | Efecto IIBB |
|---|---|---|
| PH / conjunto inmobiliario | Sí (nombra PH y "demás urbanizaciones") | `[A VERIFICAR — CRÍTICO]` |
| Barrio-SA | Sí (vía "cuotas sociales permanentes y de pago periódico") | `[A VERIFICAR — CRÍTICO]` |
| Asociación civil | **[SUPOSICIÓN]** (mismo giro "cuotas sociales"; no afirmado para asociaciones); exenciones subjetivas: existencia `[VERIFICADO]`, contenido/alcance `[NO ENCONTRADO]` | `[A VERIFICAR — CRÍTICO]` |
| Fideicomiso | **no tengo esa fuente cargada** | Pendiente |

### B.2 Conceptos alcanzados/no alcanzados e ingresos ajenos

`[VERIFICADO como requisito]` (`provincial/02` "Impacto" p.1-2): la liquidación debe **distinguir
conceptos alcanzados y no alcanzados** por IIBB (no una sola bolsa), y **separar los ingresos ajenos a
las expensas** (alquiler de espacios, antenas, publicidad, invitados), que pueden quedar en situación
fiscal distinta. → **Requisito:** todo concepto lleva una **clasificación fiscal** (`expensa`
alcanzada/no alcanzada · `ingreso_ajeno:<tipo>` · `no_gravado`) como **atributo del concepto**, no
calculada al vuelo (también en `REQUISITOS §4`). Los ingresos comerciales **no** están amparados por el
inciso de expensas; su alícuota general **no está cargada** → el sistema no les asigna alícuota.

### B.3 Sellos, Inmobiliario, retenciones (pendientes)

`[A VERIFICAR]` (`provincial/02` "Lo que falta cargar") — capacidades del sistema, sin alícuota:

- **Sellos:** marcar **contratos** (proveedores, mandato de administración) como potencialmente
  alcanzados; no liquidar monto.
- **Inmobiliario:** registrar **titularidad de espacios comunes** por figura (define el sujeto pasivo).
  En **SA** los comunes están a nombre de la sociedad `[VERIFICADO]`; en **PH/conjunto** es **pregunta
  abierta** `[A VERIFICAR]` — **no asumir** que cada propietario tributa por su parte.
- **Retenciones/percepciones:** contemplar la eventualidad de actuar como **agente** al pagar
  proveedores; régimen **no cargado** → no calcular ninguna retención automáticamente.

### B.4 Tasa municipal vs. expensa privada

- **Expensa privada** = contribución de **derecho privado** (CCyC arts. 2048/2081; en SA, aporte/cuota
  social por estatuto). **Tasa municipal** = **tributo público** de la Ordenanza Tarifaria de cada
  municipio.
- **Superposición (crítico):** `[VERIFICADO]` (`municipal/cordoba-capital`, art. 7° Ord. 8606 y modif.):
  por inmuebles en **URE** se abona un **adicional del 25%** sobre la obligación tributaria municipal;
  **no se aplica** cuando la administración asume la prestación de los servicios públicos internos en el
  instrumento de aprobación. La tarifaria **vigente** (n°/año) `[A VERIFICAR]` (no exhibir el 25% como
  cifra actual sin verificar). `jurisprudencia/01` `[VERIFICADO]`: un juzgado de Córdoba **rechazó** un
  cobro ejecutivo donde se planteó la superposición.
- **Requisitos:** registrar `servicios_internos_a_cargo_de` (municipio/urbanización/mixto) y el
  `instrumento_aprobacion` (crítico en La Calera, ordenanza por barrio); **tasa municipal y expensa
  privada son objetos distintos** en el modelo (no mezclar en un mismo concepto).

### B.5 Por qué la figura condiciona el encuadre — SA vs. consorcio

`[VERIFICADO]` (`provincial/02` p.3, `nacional/02`): en **SA** el ente es una **sociedad comercial**
titular de los comunes, los propietarios son **accionistas**, el cobro es **aporte/cuota social** (no
"expensa"), nace del estatuto/reglamento/pacto de ejecutividad, los comunes están a nombre de la
sociedad (→ Inmobiliario), y está sujeta al **régimen de estados contables** de la LGS `[A VERIFICAR —
articulado por cargar]`. En **PH/consorcio** el ente es el consorcio (no comercial), el cobro es
**expensa** (arts. 2048/2081), del reglamento inscripto, y la titularidad de los comunes es **pregunta
abierta**. **Asociación civil:** persona jurídica sin fin de lucro, IPJ Córdoba (Ley 8652)
`[VERIFICADO organismo]`; cuotas sociales; ventajas fiscales por "sin fines de lucro" **[SUPOSICIÓN no
verificada]**. **Fideicomiso:** `[A VERIFICAR]`, figura típica de desarrollo/construcción.

**Campos fiscales que el modelo debe soportar:** `figura_juridica` versionada,
`servicios_internos_a_cargo_de`, `instrumento_aprobacion` + `encuadre_urbanistico`,
`titularidad_espacios_comunes`, por concepto `clasificacion_fiscal` + `denominacion_segun_figura`, y
parámetros externos versionados por ejercicio (alícuota IIBB, Sellos, retención — **hoy sin fuente**).

---

## PARTE C — Requisitos del módulo Exportación contable (MVP)

Es **insumo para que el contador matriculado arme la liquidación fiscal** — **no** una DDJJ ni un
formulario. **No calcula impuesto a pagar** ni asigna alícuotas (ninguna cargada; efecto IIBB
`[A VERIFICAR — CRÍTICO]`). Reglas:

- **Resumen de IIBB:** agrupa ingresos por `clasificacion_fiscal` (expensas/aportes · ingresos ajenos
  desglosados: alquiler/antenas/publicidad/invitados · no gravado); columna `tratamiento_iibb` con
  leyenda "sujeto a verificación Ley 10117" / "régimen general — alícuota no cargada"; **sin** columna
  "IIBB a pagar".
- **Libro de ingresos/egresos por período:** ingresos con período, barrio, UF, **coeficiente**,
  concepto, `tipo` (ordinaria/extraordinaria), `respaldo_asamblea` si extraordinaria,
  `clasificacion_fiscal`, `es_fondo_reserva`, `denominacion_segun_figura`; egresos con período, barrio,
  concepto, monto, `tipo`, `imputa_a_fondo_reserva` + `autorizacion_consejo`, proveedor + banderas
  `potencial_sellos`/`potencial_retencion` (solo **marcar**, no calcular). Fondo de reserva **siempre en
  línea separada**.
- **Balance simple por barrio, presentación según figura:** PH → ingresos/egresos de expensas + fondo
  separado (base de la rendición del administrador); SA → conceptos como **aportes/cuotas sociales**, e
  **insumo** (no reemplaza el estado contable societario de la LGS); asociación → cuotas sociales,
  rendición ante IPJ (formato **[NO ENCONTRADO]**); fideicomiso **[SUPOSICIÓN]**.
- **Leyendas obligatorias en la salida:** numeración de artículos "verificar t.o. vigente"; efecto IIBB
  "pendiente — Ley 10117"; alícuotas/Sellos/retenciones "no cargadas".
- **NO debe:** calcular impuesto/alícuota; emitir DDJJ/formularios; fundir fondo de reserva con caja,
  tasa municipal con expensa, o ingresos ajenos con expensas; rotular como "expensas" los cobros de una
  SA/asociación.

---

## Resumen de confianza (qué está firme vs. qué es suposición)

- **`[VERIFICADO]` (núcleo sólido):** CCyC arts. 2038/2044/2046/2048/2049/2050/2057/2058/2059/2060/
  2062/2063-2064/2065-2067/2073-2086; art. 3° LGS 19.550; Ley 26.994 (vigencia 1/8/2015); RG IGJ
  25/2020, 27/2020, 4/2024 (ámbito CABA); jurisprudencia de ejecutividad citada; Ley 8652 e IPJ Córdoba;
  Ley 10117 (existencia del inciso); adicional 25% URE (art. 7 Ord. 8606); Res. CV 018/2012.
- **`[A VERIFICAR]`:** posible modificación del CCyC (Ley 27.799 / Decreto 338/2025); art. 2061;
  mapeo de órganos SA↔PH; articulado de asociaciones civiles y fideicomiso; tribunal/carátula del
  plenario 2023; **efecto exacto del inciso de la Ley 10117 (CRÍTICO)**; alícuotas IIBB/Sellos; sujeto
  pasivo del Inmobiliario en PH; retenciones; tarifaria municipal vigente.
- **`[NO ENCONTRADO]`:** resolución de la IPJ de Córdoba sobre adecuación; contenido de exenciones
  subjetivas de IIBB; formato de estados contables exigido por IPJ.
- **[SUPOSICIÓN]:** denominación del aporte y órganos en asociación civil/fideicomiso/geodesia; base del
  fondo de reserva fuera de PH; ventajas fiscales de la asociación por "sin fines de lucro";
  aplicabilidad real de la geodesia en Córdoba.

**Validar con profesional matriculado.** Todo lo anterior tiene implicancia legal/fiscal real; ninguna
cifra o efecto `[A VERIFICAR]` puede usarse para liquidar o reclamar sin verificación contra el texto
oficial vigente (abogado y contador con matrícula en Córdoba). Los huecos marcados —especialmente el
criterio de adecuación de la IPJ Córdoba, la jurisprudencia del TSJ/Cámaras de Córdoba, y el efecto del
inciso de la Ley 10117— deben cerrarse con fuente antes de darse por firmes.
