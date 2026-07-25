# 01 — Alcance, módulos y multi-figura

> **Fase 6B — diseño de producto.** Este documento define **qué se construye** (módulos y su corte
> MVP) y **cómo funciona operativamente** cada módulo, desde la práctica real de administración de
> barrios/consorcios/PH en Argentina. No es especificación técnica ni modelo de datos (eso vive en
> [`03-modelo-datos.md`](03-modelo-datos.md)); es la operatoria que el sistema debe soportar.
>
> **Fundamentos.** Cada regla de negocio remite a `knowledge/cordoba/` (base cargada, con marcas
> `[VERIFICADO]`/`[A VERIFICAR]`/`[NO ENCONTRADO]`). Requisitos legales y fiscales por figura: ver
> [`04-requisitos-dominio.md`](04-requisitos-dominio.md).

## Convenciones de lectura

- **[MVP]** — entra en la primera versión mostrable a administradores.
- **[MADURA]** — se difiere a una iteración posterior; se deja el gancho en el diseño, no se construye ahora.
- **→ legal-ph** — punto que depende de la figura jurídica / ejecutividad; el sistema no decide, deriva.
- **→ contador** — punto con tratamiento impositivo (IIBB, retenciones, formato contable); no se opina de fondo.

---

## 1. Corte del MVP — "básico y mostrable"

El MVP es una solución **básica y mostrable** a administradores (no un sistema integral): lo mínimo
para administrar un barrio real corriendo en Docker local y presentarlo en una demo.

### 1.1 Módulos por etapa

| Módulo | Qué resuelve | Etapa |
|---|---|---|
| **Padrón** | Barrios (con sus 5 ejes), unidades funcionales, propietarios/obligados, coeficientes | **MVP** |
| **Expensas + liquidación mensual** | Liquidación ordinaria/extraordinaria, fondo de reserva, mora, prorrateo por coeficiente | **MVP** |
| **Liquidación en PDF por UF** | PDF individual por unidad y período | **MVP** |
| **Cobros** | Estado de cuenta por unidad, imputación de pagos | **MVP** |
| **Pagos manuales** | Registro de pagos fuera del circuito bancario (efectivo, etc.) con antiduplicado | **MVP** |
| **Proveedores / Órdenes de pago** | Registro de egresos e imputación al período | **MVP** |
| **Reporte mensual por barrio** | Resumen de estado/liquidación por período | **MVP** |
| **Exportación de movimientos** | Planilla de ingresos/egresos del período, con el concepto de cada línea, para entregarle al contador | **MVP** |
| ~~**Módulo contable**~~ (libro contable, resumen IIBB, balance por figura) | **FUERA del MVP** (decisión del usuario, 2026-07-24): hacerlo bien es prácticamente un ERP. Se evalúa más adelante | A evaluar |
| **Distribución de liquidaciones** | ZIP a carpeta + email 1‑a‑1 con dos adjuntos, con trazabilidad de envíos | **MVP** |
| **Conciliación automática (ingresos)** | Reuso del motor del sistema de gas; cruza extractos con UF | **MVP (no bloqueante de la demo)** |
| **Modo demo** | Seed de datos realistas para presentaciones | **MVP** |
| **Comunicaciones a residentes** (broadcast/avisos) | Avisos generales más allá de la liquidación | Inc. 2 |
| **Reservas de espacios comunes** | Reserva de amenities (art. 2083) | Inc. 2 |
| **Control de accesos / visitas** | Autorizaciones de acceso (art. 2083) | Inc. 2 |
| **Reclamos / Tickets** | Gestión de reclamos de residentes | Inc. 2 |
| **Reportes/indicadores avanzados** | Comparativos, tableros, morosidad avanzada | Inc. 2 |
| **Conciliación automática de egresos** | Matching de pagos a proveedores (mismo motor) | Inc. 2 |
| **Destinos Drive/OneDrive** | Distribución a nube detrás de `FileDestination` (OAuth) | Inc. 2 |
| **App mobile (residente)** | Ver/pagar expensas, avisos, reservas, visitas | Mobile |
| **Asambleas / obras / accesos plenos** | Doble mayoría, quórum, aprobación de obras | Posterior (el modelo los contempla) |

> **Decisión confirmada (revisión 6B).** La conciliación **de egresos** queda en **Incremento 2**: el
> MVP registra los egresos como **Proveedores / Órdenes de pago + libro exportable**. Ratificado por el
> usuario; ya no es un ajuste pendiente.

---

## 2. Multi-figura jurídica (transversal)

La figura jurídica del barrio **no es un solo campo "tipo de barrio"**: según
`REQUISITOS-MODELO-DATOS.md §1`, es una de **cinco dimensiones ortogonales y versionadas** del barrio,
y **cualquier combinación es posible** (ej. *SA + no adecuado + sin encuadre URE + en La Calera +
servicios a cargo del municipio*). Ninguna combinación debe estar prohibida por el modelo.

| Eje | Valores | Determina |
|---|---|---|
| `figura_juridica` | SA · asociación civil · PH especial/conjunto inmobiliario · fideicomiso · geodesia | Órganos, instrumentación de aportes, vía de cobro |
| `adecuado_art_2075` | sí · no · en trámite · no aplica | Ejecutividad del certificado de deuda |
| `encuadre_urbanistico` | URE/equivalente · loteo abierto · cierre de calles autorizado · sin encuadre | Obligaciones municipales, tasas |
| `municipio` | La Calera · Villa Allende · Mendiolaza · Unquillo · Córdoba capital · … | Toda la capa normativa local |
| `servicios_internos_a_cargo_de` | municipio · urbanización · mixto | Adicional tarifario, superposición tasa/expensa |

Todos estos campos **se versionan con vigencia temporal** (un barrio puede adecuarse o cambiar de
figura; para un acto vale el valor vigente **en ese momento**).

### 2.1 Qué cambia por figura jurídica

> Fuente: `00-panorama-figuras-juridicas.md`, `nacional/02`, `nacional/04`, `nacional/05`,
> `jurisprudencia/01`. La **ejecutividad no depende solo de la figura** (también pesan la adecuación y
> hechos materiales); ver [`04-requisitos-dominio.md`](04-requisitos-dominio.md).

| Figura | Denominación del aporte | Órganos | Ejecutividad de la mora |
|---|---|---|---|
| **PH especial / conjunto inmobiliario** | **Expensas** comunes ordinarias/extraordinarias `[VERIFICADO]` (`nacional/04`, arts. 2048/2081) | Consorcio persona jurídica: **asamblea, consejo (si lo hay), administrador** `[VERIFICADO]` (`nacional/05`, art. 2044) | **La más firme**: certificado del art. 2048 = título ejecutivo `[VERIFICADO]`; en conjuntos, ejecutividad **derivada** del art. 2075 2° párr. |
| **Sociedad Anónima** | **Aportes / cuotas sociales** de base societaria/estatutaria — **no "expensas"** `[VERIFICADO]` (`nacional/02`); el fisco los llama "cuotas sociales permanentes y de pago periódico" `[VERIFICADO]` (`provincial/02`) | **Asamblea de accionistas, directorio, sindicatura** (mapeo funcional, no jurídico) `[A VERIFICAR]` (`nacional/02`) | **No garantizada**: depende del fuero/instrumentación (`jurisprudencia/01`, fallos citados en doc 04) |
| **Asociación civil** | "Cuota social" (denominación específica **no** fijada por la base → suposición) | No cargado en detalle → suposición (típico: asamblea + comisión directiva) | Sin criterio propio cargado → **no asumir ejecutable** |
| **Fideicomiso** | No cubierto → **no tengo esa fuente cargada** | Partes del fideicomiso no descriptas → suposición | No cargado → **no asumir ejecutable** |
| **Geodesia / servidumbres** | No cubierta → suposición | Sociedad titular de áreas comunes (`00-panorama` §2.E) | `[fuente a cargar]` → **no asumir ejecutable** |

**Lectura para el diseño.** El módulo de cobranzas/expensas **ramifica por figura**: instrumento del
aporte, **denominación** de los conceptos (no llamar "expensas" a lo que en una SA son aportes/cuotas
sociales), camino de reclamo y ejecutividad. `legal-ph` **lee la figura antes de opinar**, nunca asume
PH especial por defecto. **Validar con profesional matriculado.**

---

## 3. Principios transversales (aplican a todos los módulos)

1. **Multi-tenant por barrio.** Todo dato pertenece a un barrio; el administrador es el cliente y su
   vínculo con cada barrio es un **mandato con inicio y cese** (no permanente). Aislamiento por RLS: un
   obligado nunca ve datos de otra unidad ni de otro barrio (ver doc 03).
2. **Toda cifra de dinero se explica con su origen.** Ningún monto suelto: siempre lleva barrio + UF +
   concepto + coeficiente aplicado + período.
3. **La nomenclatura de los conceptos depende de la figura.** En PH → **expensas**; en barrio‑SA →
   **aportes/cuotas sociales**. Etiqueta configurable por barrio; la operatoria de liquidación/cobro es
   la misma para cualquier figura salvo donde se marque lo contrario.
4. **El sistema nunca inventa** una tasa de mora, un coeficiente ni un orden de imputación: si el dato
   no está cargado (viene del reglamento o de una asamblea), se pide o se marca **pendiente**.
5. **Versionado temporal.** Coeficientes, tasa de mora y figura se versionan con vigencia.

---

## 4. Operatoria por módulo (MVP)

### 4.1 Padrón

Estructura sobre la que se prorratea todo: barrios, UF, obligados y coeficientes. Si el padrón está
mal, toda cifra posterior está mal.

- **Barrio.** Alta con **figura jurídica** (condiciona cobro y encuadre fiscal), municipio, y
  configuración de recaudación: etiqueta de conceptos (expensas vs. aportes/cuotas sociales), si
  **tiene fondo de reserva** y cómo se integra, **tasa de mora vigente** (o "pendiente"), esquema de
  prorrateo. Documentos de primera clase: reglamento, acta de designación del administrador, actas.
  **[MVP]** alta manual; **[MADURA]** versionado histórico de figura/encuadre y adjuntos versionados.
- **Unidades funcionales.** **Manzana y lote estructurados** (no dirección libre), nomenclatura
  catastral, `estado_unidad` (baldío / en construcción / construido). **Una UF baldía o en
  construcción integra el padrón y genera expensas igual** (art. 2077); no se excluye del prorrateo por
  defecto. **[MADURA]** validación contra IDECOR/MapasCórdoba.
- **Propietarios / obligados.** Obligado principal y, si aplica, poseedores por cualquier título —
  **más de un obligado por UF sin liberar al propietario** (art. 2050). **La deuda sigue a la UF, no a
  la persona**: al cambiar de titular el saldo **no se reinicia** (arts. 2049/1937); histórico de
  titulares. **[MVP]** un obligado + histórico; **[MADURA]** múltiples obligados con roles finos
  (reparto propietario/inquilino **no** se modela en MVP — zona normativa en movimiento tras el DNU
  70/2023, `nacional/04`).
- **Coeficientes.** Tal como los fija el reglamento (porcentual de parte indivisa, o por lote/
  superficie/mixto — art. 2081). **La suma debe cerrar**; el sistema valida el cuadre y no liquida un
  padrón descuadrado. El coeficiente **nunca lo inventa el sistema**. **[MVP]** un esquema vigente con
  validación; **[MADURA]** versionado con recálculo y múltiples esquemas.

### 4.2 Expensas + liquidación mensual

Convierte los gastos del período en el cargo de cada UF.

1. Se abre el **período** para un barrio.
2. Se cargan los **conceptos**, cada uno clasificado **ordinario vs. extraordinario** (art. 2048) y con
   su **clasificación fiscal** (alcanzado/no alcanzado por IIBB, o ingreso ajeno a expensas — **→ contador**).
3. Se **prorratea** cada concepto por el coeficiente de cada UF; cada línea guarda su origen (concepto
   + coeficiente + período).
4. **Fondo de reserva** como línea separada (solo si el barrio lo tiene; art. 2046 inc. d). Disponer de
   él exige autorización del consejo (art. 2064 inc. c).
5. **Mora e intereses** con la tasa **definida por el barrio**, versionada. Si no hay tasa cargada, el
   sistema **no inventa**: liquida el capital y marca "mora pendiente de definición".
6. Se **cierra/emite** la liquidación.

**Controles.** Una extraordinaria **exige respaldo de asamblea** (art. 2048): el sistema pide la
referencia al acta; sin respaldo queda bloqueada. Una liquidación **Emitida no se edita** (se corrige
con nota de crédito/débito en el período siguiente). El sistema no cierra un período **descuadrado**.
Estados: `Borrador → Revisada (consejo si existe) → Emitida/Cerrada → Distribuida`.
**[MVP]** ordinarias/extraordinarias/fondo separados, prorrateo por coeficiente único, mora simple.
**[MADURA]** presupuesto vs. ejecutado, consumo por medidor, planes de pago.

### 4.3 Liquidación PDF por UF y Reporte mensual por barrio

- **Liquidación PDF (por obligado):** encabezado (barrio, UF manzana/lote, obligado, período);
  detalle de conceptos con clasificación, coeficiente aplicado y monto; subtotales separados
  (ordinarias · extraordinarias · fondo); saldo anterior e intereses con **base y tasa explicitadas**;
  total, vencimientos, medios de pago; **etiqueta correcta según figura**.
- **Reporte mensual (para consejo/asamblea):** gastos del período por rubro; total a recaudar vs.
  recaudado y morosidad; estado del fondo de reserva; ingresos ajenos separados (**→ contador**);
  listado de UF con su total.

**[MVP]** ambos con plantilla única; **[MADURA]** plantillas por barrio, gráficos, comparativos.
Enfoque de generación de PDF: ver [`03-modelo-datos.md §C`](03-modelo-datos.md) (Docker, sin límites
serverless → HTML→PDF).

### 4.4 Cobros

- **Estado de cuenta por UF:** débitos (liquidaciones) y créditos (pagos) en orden cronológico, con
  saldo corriente. La deuda **está anclada a la UF** (art. 2049).
- **Imputación de pagos:** según el **orden que define el barrio** (típicamente intereses → capital más
  antiguo, pero **configurable, no una constante**). Pago parcial/total/multi-período.
- **Certificado de deuda / ejecutividad → legal-ph.** El sistema **no asume que la deuda es
  ejecutable** (`jurisprudencia/01`). El certificado formal y los caminos de reclamo salen del MVP.

**[MVP]** estado de cuenta + imputación configurable simple; **[MADURA]** planes de pago, certificado
de deuda formal (art. 2048), condicionado a `legal-ph`.

### 4.5 Pagos manuales

Registra cobros fuera del circuito bancario (efectivo, cheque en mano, transferencia avisada).

- **Datos:** UF y obligado, monto, fecha, **origen** (efectivo/transferencia informada/cheque/otro),
  **usuario que registra**, **comprobante adjunto**, observaciones. Genera recibo imputable.
- **Controles:** usuario + timestamp para auditoría; comprobante requerido; **no se borra**, se **anula
  con motivo**.
- **Antiduplicado (crítico):** un pago informado y cargado a mano hoy **puede aparecer luego en el
  extracto**. Cada pago manual lleva una marca para que la conciliación (4.7) lo **matchee y unifique**
  contra el movimiento del extracto en vez de **acreditar dos veces**.

**[MVP]** alta con origen/usuario/comprobante + flag antiduplicado; **[MADURA]** arqueo de caja,
aprobación de excepciones.

### 4.6 Proveedores / Órdenes de pago

- **Proveedor:** razón social, CUIT, **condición fiscal** (dato; retenciones **→ contador**, no
  automáticas en MVP), contacto, CBU/alias.
- **Orden de pago:** proveedor, concepto/factura, monto, **barrio y período de gasto** al que se imputa
  (esa imputación reaparece como concepto en la liquidación), medio de pago, comprobante. Estados:
  `pendiente → aprobada → pagada → conciliada`.

**[MVP]** alta + OP con imputación + estados; **[MADURA]** cuenta corriente de proveedor, retenciones
automáticas (con `contador`), aprobaciones multinivel.

### 4.7 Conciliación automática de ingresos (reuso del sistema de gas)

Reutiliza el **motor de matching** de `trazabilidad-obra-gas` (ver
[`02-reuso-conciliacion.md`](02-reuso-conciliacion.md)). Cruza los movimientos de crédito de un
extracto bancario con la UF/obligado que los generó.

- **Entra:** un extracto (movimientos: fecha, importe, referencia/CBU del pagador, concepto).
- **Hace:** por cada movimiento busca la UF candidata por **importe + identificador** (CBU/alias o un
  identificador de UF en el concepto), con score; los inequívocos se imputan solos, los dudosos van a
  una **cola de excepciones**.
- **Dedupe con pagos manuales (4.5):** antes de crear un crédito, verifica si el movimiento ya fue
  registrado manualmente; si coincide, **unifica** (marca el manual como conciliado) en vez de duplicar.
- **No bloqueante de la demo:** si la conciliación atrasa, la demo sale con carga manual de cobros.

**[MVP]** importación + match por importe+identificador + cola + dedupe; **[MADURA]** aprendizaje de
patrones, multi-cuenta, reglas por barrio.

### 4.8 Exportación de movimientos y Distribución de liquidaciones

> **Decisión del usuario (2026-07-24): el MÓDULO CONTABLE queda FUERA del MVP.** Un módulo contable
> de verdad (libro contable, resumen fiscal por concepto, balance según figura jurídica) es
> prácticamente un ERP: mucho alcance, mucha normativa que cerrar y poco valor para la primera demo.
> Se evalúa como incremento posterior. Lo que sí entra es la **exportación de movimientos**: el
> administrador baja la planilla y se la manda a su contador, que es como se resuelve hoy.

- **Exportación de movimientos → planilla.** Export CSV/Excel del período con los **ingresos y egresos
  registrados**, cada línea con su **concepto**, su barrio y su período (dinero trazable). Sin cálculo
  de impuestos, sin DDJJ, sin balance ni encuadre fiscal — eso queda para el contador del barrio con
  la planilla en la mano. La clasificación fiscal por concepto **se sigue guardando en el dato**
  (está en el modelo), así que el día que se evalúe el módulo contable no hay que recargar nada.
- **Distribución de liquidaciones** (al pasar a `Distribuida`):
  1. **ZIP a carpeta:** un ZIP con todos los PDF por UF, depositado vía `ObjectStorage`/`FileDestination`.
  2. **Email 1‑a‑1:** a cada obligado, con **dos adjuntos** — su liquidación individual (solo la suya)
     + el reporte mensual del barrio. **PII y aislamiento:** cada email lleva únicamente su UF.
     **Registro de envíos** con estado (`enviado`/`rebotado`/`pendiente`). Reusa `nodemailer` del gas.

**[MVP]** planilla de movimientos; ZIP + email 1‑a‑1 con dos adjuntos + log de envío. **[A EVALUAR]**
módulo contable (libro, resumen fiscal, balance por figura), portal del propietario, reenvío selectivo
de rebotes, destinos Drive/OneDrive.

---

## 5. App mobile (etapa posterior) — residente primero

La app mobile (React Native/Expo) arranca como **app del residente/propietario**: ver expensas y
estado de cuenta, pagar y ver comprobante, recibir comunicaciones/avisos, reservar espacios comunes,
registrar/autorizar visitas. El **administrador sigue operando en web**. Los design-tokens neutrales
(ver ADR-0000 §2.1) permiten compartir identidad visual entre web y mobile. Módulos administrativos en
mobile (indicadores, aprobar pagos) quedan para una etapa aún posterior.

---

## 6. Puntos derivados (fuera del alcance operativo)

- **Ejecutividad del cobro / certificado de deuda / camino de reclamo → `legal-ph`** — depende de
  figura, adecuación (art. 2075), reglamento inscripto y pacto de ejecutividad. El sistema **nunca
  asume que la deuda es ejecutable** (`jurisprudencia/01`).
- **IIBB, retenciones/percepciones, Sellos, Inmobiliario, formato contable → `contador`** — el módulo
  mantiene conceptos separados y trazados; el encuadre fiscal es del contador (`provincial/02`).
- **Reparto propietario/inquilino de expensas** — zona normativa en movimiento (DNU 70/2023); no se
  modela reparto automático en el MVP.

---

## 7. Resumen: MVP vs. madura

| Módulo | MVP | Madura después |
|---|---|---|
| Padrón | Barrio+figura+config; UF con estado (baldías liquidan); 1 obligado + histórico; coeficiente con cuadre | Versionado, IDECOR, múltiples obligados/esquemas |
| Liquidación | Ordinarias/extraordinarias/fondo separados; prorrateo por coeficiente; mora simple; extraordinaria con acta | Presupuesto vs. ejecutado, consumo por medidor, planes de pago |
| PDF + Reporte | Ambos con plantilla única | Plantillas por barrio, gráficos, comparativos |
| Cobros | Estado de cuenta + imputación configurable | Planes de pago; certificado de deuda formal (→ legal-ph) |
| Pagos manuales | Alta con origen/usuario/comprobante + antiduplicado | Arqueo de caja, aprobaciones |
| Proveedores/OP | Alta + OP con imputación + estados | Cta. cte., retenciones (→ contador), aprobaciones |
| Conciliación | Extracto → match + excepciones + dedupe (ingresos) | Egresos; aprendizaje de patrones; multi-cuenta |
| Export + Distribución | Planilla de movimientos; ZIP + email 1‑a‑1 + log | Módulo contable completo; portal del propietario; Drive/OneDrive |

**Validar con profesional matriculado** todo lo legal/fiscal citado; ver marcas de confianza en
[`04-requisitos-dominio.md`](04-requisitos-dominio.md).
