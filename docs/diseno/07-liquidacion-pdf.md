# 07 — Liquidación en PDF: decisiones del panel

> **Fase 6C.** Documento de decisiones, no de implementación. Sale del panel de agentes convocado el
> 2026-07-24 antes de escribir una línea del módulo: `devops`, `ux-designer`, `security-engineer`,
> `qa-funcional`, `product-owner` y `legal-ph`. Lo que está acá reemplaza lo que digan los docs de 6B
> sobre el motor de PDF (doc 03 §C) y sobre el control de la extraordinaria (doc 01 §4.2).

---

## A. Motor: `@react-pdf/renderer` (cierra el `[validar]` del doc 03 §C)

**Decidido: `@react-pdf/renderer`. Playwright/Chromium descartado para este módulo.**

| Criterio | Peso en la decisión |
|---|---|
| **Portabilidad (ADR-0000 §7)** | Chromium suma ~1,4 GB, obliga a cambiar la imagen base de alpine a debian-slim y **condicionaría de hecho la decisión de hosting**. Es el único componente del stack que le pondría un veto a un proveedor. Decisivo. |
| **Reuso visual** | El argumento "reusamos las plantillas web" **no se sostiene**: la fuente visual única viaja por `packages/design-tokens/tokens.ts` (objetos TS), que este motor consume igual que mobile. El reuso de *markup* con un documento de impresión es marginal. |
| **Costo** | 500 PDFs (10 barrios × 50 UF): ~20-30 s de cómputo vs ~60-90 s. Imagen +2 % vs ×2,5. |
| **Seguridad** | Chromium renderizando texto cargado por usuarios abre SSRF/exfiltración (`<img src="http://169.254.169.254/…">`). Evitarlo entero es más barato que blindarlo. |

**Lo que se pierde y se acepta:** CSS reducido (sin grid, sin `font-variant-numeric`), y los componentes React de la web no se reusan. La alineación de columnas de dinero **se resuelve con Geist Mono** (monoespaciada real), que ya era la decisión visual del doc 06.

**Puerta abierta sin costo:** el generador va detrás de `GeneradorLiquidacionPdf`; un adapter Chromium en **imagen aparte** sigue siendo posible para un caso puntual.

**Condiciones de implementación (no opcionales):**
- **Instancias estáticas TTF** de Geist y Geist Mono (Regular/Medium/SemiBold/Bold), vendorizadas en
  `packages/design-tokens/fonts/` y **pinneadas con checksum**. Geist es variable y el motor **no
  soporta ejes variables**: sin las estáticas, toda la jerarquía de pesos cae al default **en
  silencio**. Un cambio de fuente **reflowea PDFs históricos** → los emitidos no se regeneran sobre
  la misma clave.
- `Font.register` y `StyleSheet.create` **a nivel de módulo**, nunca por render.
- Hyphenation propia: no cortar palabras salvo que superen el ancho de columna (un CBU partido al
  medio es un error de lectura).
- Render en **worker threads** con timeout real: el motor es síncrono y un `Promise.race` no
  dispararía nunca. El worker es un **proceso aparte** (misma imagen, otro comando).
- **Formatear en Node** con el helper compartido: Node slim sin ICU completo degrada
  `Intl.NumberFormat("es-AR")` a formato en-US en silencio. Es un bug de dinero invisible en dev.
- **Test de humo en CI** (~2 s): cabecera `%PDF-`, páginas esperadas, fuentes embebidas correctas, y
  que el total salga **formateado igual que en pantalla** (divergencia pantalla/PDF = el bug caro).

---

## B. Estructura del documento (ux-designer)

Orden: **cabecera → identificación (unidad / destinatario) → cupón con el total y los vencimientos →
detalle → subtotales → notas → avisos → cómo pagar → pie repetido.**

El **cupón va arriba**, antes del detalle: quien abre el PDF quiere saber cuánto y hasta cuándo. El
detalle es la justificación y está 8 cm más abajo, en la misma hoja.

**Tabla de detalle (modelo variable), 5 columnas en A4 (182 mm útiles):**
`Concepto (74) · Tipo (26) · Gasto del período (30) · Coef. (22) · Importe (30)`.

- **El origen se muestra con columnas, no con una sublínea gris**: `gasto del período × coeficiente =
  importe` es verificable con calculadora y alinea; una sublínea de 7 pt duplicaría la altura y sería
  lo primero que se pierde al imprimir.
- El encabezado dice **"Gasto del período"**, no "Base": deja explícito que es el gasto **entero del
  barrio**, no algo que se le cobra a esa unidad.
- **Coeficiente con 4 decimales visibles** + nota fija: el prorrateo usa los 9 decimales. Sin esa
  línea, quien multiplique obtiene otro número y cree que le cobraron mal.
- **Sin zebra striping**: filetes de 0,4 pt, que sobreviven a una fotocopia.
- **Marcadores `(1)` `(2)`**, no `†`/`‡`: un glifo faltante se renderiza como **nada** y perderíamos
  justo la marca que importa. Las notas van en un **bloque al final del detalle** (no hay motor de
  notas al pie).

**Modelo fijo: dos bloques, no una tabla con guiones.** Arriba "Cuota mensual" con su **vigencia y el
instrumento que la aprobó**; abajo, solo si hay, las extraordinarias prorrateadas. Más la línea: *los
gastos del mes se informan en el reporte, pero no determinan esta cuota*.

**Dos totales, nunca uno:** "Total del período" y "TOTAL A PAGAR" (que suma saldo anterior e interés).
Fusionarlos hace imposible responder "¿cuánto es de este mes?", que es la primera pregunta de todo
reclamo. **El interés muestra siempre base, tasa y días.**

**Nunca se omite, aunque valga cero:** saldo anterior, interés y total. Un renglón ausente se lee como
dato escondido.

**Tokens en papel:** se agrega un scheme `print` (derivado de `light`) — fondo blanco, **sombras en
`none`**, filetes `borderStrong`, tipografía en pt con **piso duro de 7 pt**, radios ≤ 2 mm, y
**ningún estado codificado solo por color** (la palabra completa en la columna Tipo). El acento por
barrio queda solo en la franja superior, y **necesita `acentoBarrioHex()`**: el motor no parsea la
sintaxis `hsl()` moderna que devuelve hoy `barrio-accent.ts`.

**Accesibilidad, dicho sin maquillaje:** el PDF sale **sin etiquetar** y no es accesible para lectores
de pantalla. Ningún motor de los evaluados lo resuelve. El camino accesible es la **versión HTML de
la misma plantilla**; no se declara AA sobre el PDF.

---

## C. Alcance del contenido (product-owner)

1. **La clasificación fiscal NO va en el PDF de la unidad.** Su audiencia es el contador y el módulo
   contable está fuera del MVP. Va en el reporte al consejo y en la exportación de movimientos. Lo
   que sí va, y es obligatorio, es la clasificación del art. 2048: **ordinaria / extraordinaria /
   fondo de reserva**. (Corregir doc 01 §4.3, que dice "clasificación" a secas.)
2. **Una línea por CONCEPTO agrupado, no por gasto individual.** Con 25-40 gastos, el PDF de cada
   unidad saldría con 40 líneas de $890 que no le sirven a nadie y le multiplican las preguntas al
   administrador. El desglose gasto por gasto vive en el reporte mensual del barrio, **que viaja en
   el mismo email**. La traza se conserva: el origen es concepto + coeficiente + período.
3. **Medios de pago: faltan y son MVP.** Un PDF sin "dónde pago" no es demostrable. → tabla
   `medio_pago_barrio` (creada en `0008`).

---

## D. Respaldo de la extraordinaria (legal-ph + product-owner)

**El texto que se había propuesto se descarta.** Decía *"No modifica el importe liquidado"*, que es
una **afirmación sobre el efecto jurídico** de la falta de respaldo hecha por el acreedor — y la base
de conocimiento **no la sostiene**: la tensión entre el art. 2048 (la extraordinaria la dispone la
asamblea) y el art. 2049 (el propietario no puede oponer defensas, salvo compensación) **no está
resuelta en `knowledge/`**. El sistema no zanja eso en un pie de página.

**Cambio estructural que reemplaza al booleano:** en vez de marcar la **ausencia** (`sin_respaldo_
asamblea`), el sistema registra el **instrumento que sí existe**, tipado:

| Instrumento | Cuándo | Fuente |
|---|---|---|
| Acta de asamblea | El caso del art. 2048 | `nacional/04` §1 |
| **Autorización del consejo para disponer del fondo de reserva** | **Gasto imprevisto y urgente** — el cauce que la ley ya prevé para "se rompió la bomba y no espera a la asamblea" | **art. 2064 inc. c** (`nacional/04` §4) |
| Acta de directorio / resolución | Barrio-SA o asociación civil (el art. 2048 **no aplica**) | `nacional/02` |
| *(ninguno)* | Residuo, no etiqueta por defecto | — |

Esto además cubre un requisito que ya estaba escrito y no se había implementado: registrar **el
instrumento sobre el que se funda cada deuda** (`REQUISITOS` §5).

**Qué se imprime:** el respaldo **en positivo** — `Respaldo: Acta de Asamblea N° X del dd/mm/aaaa` —
anclado a la línea del concepto, no como caja suelta (con dos extraordinarias, una con acta y otra
sin, una caja única sería directamente incorrecta).

**Para el caso residual (ningún instrumento) hay una decisión de producto abierta** (ver §G): el
`product-owner` decidió **no informarlo al residente en el MVP** —protege al administrador de una ola
de reclamos sobre un hecho normal, y el dato viaja igual en el reporte al consejo que va **adjunto en
el mismo email**—; `legal-ph` acepta ese razonamiento (declarar la ausencia es una admisión escrita y
masiva del defecto de instrumentación) pero pide que, si algún día se imprime, el texto sea:

> *"A la fecha de emisión, este concepto extraordinario no cuenta con resolución de asamblea
> registrada. La documentación del gasto que lo origina puede consultarse en la administración."*

En ambos casos, el **`motivo_sin_respaldo` es obligatorio en el wizard** antes de emitir: no bloquea,
pero el administrador no pasa de largo sin dejar escrito por qué.

**Ratificación posterior:** el remedio natural de una extraordinaria sin acta es **ratificarla**
(art. 2058 inc. b). El vínculo debe ser **append-only con fecha**: no reescribe el PDF ya emitido,
pero limpia el estado para los documentos siguientes.

---

## E. Lenguaje prohibido (legal-ph)

El sistema **nunca afirma que la deuda es ejecutable** (`jurisprudencia/01`). La lista es de **frases**,
no de palabras sueltas, y son **tres listas separadas** — universal, condicional por figura, y por
plantilla — porque banear a ciegas rompe usos legítimos (`presupuesto vs. ejecutado` en el reporte,
`acciones` como títulos societarios en un barrio-SA):

| Grupo | Ejemplos |
|---|---|
| **A. Ejecutividad** | título ejecutivo · vía ejecutiva · deuda ejecutable · mérito ejecutivo · apremio · certificado de deuda *(prohibido en esta plantilla; es un artefacto legítimo en otro lado)* |
| **B. Intimación** | intimación · emplazamiento · bajo apercibimiento · plazo perentorio · queda constituido en mora · notificación fehaciente |
| **C. Judicial** | juicio · demanda · acciones legales/judiciales · embargo · subasta · Veraz/Nosis/BCRA |
| **D. Sanciones y corte de servicios** | corte de servicio · restricción de acceso · bloqueo de credencial · suspensión del uso de instalaciones — **art. 2049**: el propietario no se libera renunciando al uso, y las sanciones tienen su propio circuito (arts. 2078/2080/2086) |
| **E. Normativa mal atribuida** | `Ley 13.512` (derogada) siempre · **articulado del CCyC de PH cuando la figura NO es PH** · "expensa/consorcio/unidad funcional" cuando es SA o asociación |
| **F. Afirmaciones sin respaldo** | exento de IIBB · el pago implica conformidad · **no modifica el importe liquidado** |
| **G. Calificación de la persona** | moroso · deudor · incumplidor → **"saldo pendiente"** |

**La leyenda del pie se redacta solo en positivo.** Una negación del tipo "este documento no
constituye título ejecutivo" mete en el papel justo las palabras del grupo A e instala una pregunta
que nadie hizo.

**Fideicomiso: la emisión se bloquea.** No hay fuente cargada sobre denominación ni órganos; el
sistema no cae al texto de PH por defecto (`00-panorama` §4: no asumir PH).

---

## F. Seguridad del módulo (security-engineer)

**Los tres controles innegociables:**

1. **Tenant fijado y verificado por archivo.** El `barrio_id` **nunca viaja en el request**: se deriva
   del `periodo_id` **bajo RLS antes de encolar** el job, queda fijado en la fila del job, y el job
   corre con la **conexión de request + identidad del usuario**, no con la de jobs. Antes de cada
   escritura se verifica `liquidacion.barrio_id === barrioFijado` y que la clave empiece por
   `barrios/{barrioFijado}/`. El ZIP no se publica ni el período pasa a `distribuida` si
   `archivos ≠ count(liquidacion)`.
2. **Nada se sirve sin URL firmada corta emitida por el servidor, y un solo destinatario por mail.**
   Bucket privado, solo GET, TTL ≤ 10 min, respuesta `no-store`, autorización re-verificada en cada
   emisión. En el envío: `to.length === 1`, sin cc/bcc, destinatario resuelto **en la misma fila** que
   la liquidación (jamás apareando dos listas por índice), y **el ZIP del barrio nunca se le manda a
   un residente**.
3. **Auditoría append-only con hash.** Cada PDF deja `documento_liquidacion` con `sha256`, quién y
   cuándo; cada envío deja la dirección **congelada como texto** (la fila de contacto se edita
   después); cada URL firmada deja registro. Sin UPDATE ni DELETE para el rol de request.

**Claves de storage:** `barrios/{barrio_id}/periodos/{periodo_id}/liquidaciones/{liquidacion_id}/{token}.pdf`
— `barrio_id` primero (permite política por prefijo y purga por mandato) y **nada legible por humanos**
(las claves aparecen en logs y en previews de mail). El nombre lindo se entrega con
`response-content-disposition`. El `{token}` aleatorio hace que **regenerar cree un objeto nuevo**: la
URL emitida ayer sigue apuntando al PDF que se auditó ayer.

**Del PDF salen** solo el mínimo: nombre del obligado + unidad. **No** DNI, CUIT, teléfono ni domicilio
"por las dudas"; **nunca** datos de otra unidad, ni ranking de morosos, ni URLs o tokens adentro del
documento (el PDF se reenvía).

**Mandato que se cierra:** el corte real **no es borrar archivos, es cortar la emisión de URLs** (dar
de baja la membresía). Las URLs firmadas ya emitidas **no se pueden revocar** — por eso el TTL corto.
No se promete revocación.

**Dos agujeros que ya estaban y se cerraron en esta tanda:** `conUsuario()` aceptaba la conexión de
jobs (BYPASSRLS) y daba una **falsa sensación de aislamiento** → los tipos ahora lo impiden. Y el
`propietario` **ve hoy todas las liquidaciones del barrio** (la RLS es por barrio, no por unidad, y no
existe vínculo usuario→unidad): **el endpoint del PDF no se expone a `propietario`/`residente` en este
incremento** hasta resolverlo.

---

## G. Lo que quedó abierto (decisiones de negocio, no técnicas)

1. **Caso residual "extraordinaria sin ningún instrumento": ¿se le informa al residente?** El
   `product-owner` dice que no en el MVP (con el dato viajando en el reporte al consejo del mismo
   email); `legal-ph` lo acepta y deja el texto listo por si se decide lo contrario. **Pendiente de
   confirmación del usuario.**
2. **Retención de los PDFs**: el plazo lo definen `legal-ph`/`contador` con fuente. Mientras tanto, el
   mecanismo existe (`retencion_meses` por barrio) con default **no purgar nunca**.
3. **Vínculo usuario → unidad funcional** (para que un propietario vea solo lo suyo). Estaba abierto en
   el doc 03 §F; ahora tiene consecuencia concreta.
4. **Verificar el articulado citado** contra el texto vigente: `nacional/01` marca indicios de
   modificación del CCyC (Ley 27.799, Decreto 338/2025). **Validar con profesional matriculado** antes
   de imprimir cualquier leyenda.
