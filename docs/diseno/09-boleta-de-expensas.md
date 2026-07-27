# 09 — La boleta de expensas

> Fuente: dos boletas reales de **Las Corzuelas** (marzo y abril de 2026), de la misma unidad,
> generadas por el sistema actual de la administración. Los originales **no están en el repositorio**
> (traen datos personales); viven en `_referencias/`, fuera del control de versiones. Acá queda la
> estructura, ya anonimizada.

## §A. Qué trae hoy la boleta de Las Corzuelas

**Figura jurídica:** *S.A.* ("Administración Las Corzuelas S.A."), no PH. Confirma que la
multi-figura del ADR-0000 no era una hipótesis: el primer barrio real ya no es un consorcio.

**Cabecera**

| Dato | Ejemplo |
|---|---|
| Ente recaudador | Banco (logo) + red de cobranza (logo) |
| Administración | razón social, domicilio |
| Cuenta corriente | número de convenio de la administración |
| Período | `03/2026` |
| Identificación de la unidad | `Mza/Lote <mz> / <lote>` + un campo `Unidad Nº` **que viene vacío** |
| Número de boleta | 8 dígitos, correlativo global (avanzó ~3.100 en un mes entre las dos muestras) |

**Detalle** — dos columnas, `Concepto` e `Importe`, sin subtotales:

```
Alquiler - Cancha Padel            24.000,00
Cuota Ordinaria 03/2026           360.500,00
Cuota Extraordinaria 1/2            8.500,00
Bonificación Especial 03/2026     -34.000,00
                                  ──────────
                                  359.000,00
```

Al mes siguiente: sin el cargo de pádel, con `Extraordinaria 2/2` y la bonificación en `-36.000,00`.

**Bloque de pago** — el que convierte al PDF en un instrumento:

- Código de barras (≈58 dígitos) que codifica convenio, número de boleta, período, día de
  vencimiento, importe y cuenta.
- Código para LINK / Pago Mis Cuentas.
- `Vencimiento` + `Importe`, y `Fecha Tope` + `Importe` — **con el mismo importe en las dos**.
- Logos de las redes de cobranza.

**Talón "Para la Administración"**: repite razón social, titular, ambas fechas con sus importes,
período, Mza/Lote y número de boleta.

**Leyendas al pie**

- "El pago de la presente no libera de deudas anteriores".
- "Esta boleta podrá ser abonada en las entidades autorizadas hasta su Fecha Tope de recaudación.
  Pasada dicha fecha deberá ser actualizada vía mail a <casilla de la administración>".
- "Los intereses generados por el pago posterior a la fecha de vencimiento, serán devengados en la
  boleta correspondiente al próximo período."

## §B. Lo que esto confirma del diseño ya construido

1. **El cargo por uso existe en la vida real** (`Alquiler - Cancha Padel`): es exactamente el
   `concepto_boleta` de clase `cargo` con método precio × cantidad.
2. **La extraordinaria va como ítem de la boleta común, en cuotas** (`1/2`, `2/2`), sin tratamiento
   diferenciado de vencimiento ni de mora. Es el caso (a) del doc 08 §O.
3. **La bonificación al cumplidor es un renglón en negativo**, no un precio distinto: la boleta
   muestra la expensa entera y después descuenta. Confirma la decisión del doc 08 §J.
4. La bonificación **no es un porcentaje redondo** (−34.000 sobre 360.500 = 9,43 %; −36.000 sobre
   372.000 = 9,68 %): es un **monto fijo** que se decide por período. El modelo soporta las dos.
5. **La mora no se cobra en esta boleta**: se devenga y aparece en la del período siguiente. Es
   exactamente el par `saldo_anterior` + `interes_mora` que ya está construido.
6. La `Fecha Tope` **no es un segundo vencimiento con recargo**: es el límite de la red de cobranza,
   con el mismo importe. Son dos conceptos distintos y hoy el sistema tiene uno solo.

## §C. Lo que la boleta actual NO dice (oportunidades, no defectos)

- **No hay ningún detalle de qué cubre la cuota ordinaria**: ni gastos, ni coeficiente, ni total del
  barrio. El vecino recibe un número y confía. Es la regla dura del proyecto ("toda cifra de dinero
  se explica con su origen") sin cumplir en el único lugar donde el vecino la lee.
- **La deuda anterior es invisible**: la leyenda dice que el pago no libera deudas anteriores, pero
  no dice cuánto se debe. Quien está al día y quien debe seis meses reciben la misma hoja.
- **La bonificación no dice por qué**: aparece "Especial", sin criterio. Quien no la recibe tampoco
  sabe qué tendría que hacer para recibirla — que es justo el efecto que se busca con el descuento.
- **`Unidad Nº` viene vacío**: campo muerto del sistema actual.
- **Las etiquetas cambian de mes a mes** (`Cuota Extraordinaria 1/2` → `Extraordinaria 2/2`) porque
  se escriben a mano. En el nuestro son un snapshot congelado del catálogo.
- **No distingue destinatario**: dice "Inquilino / Propietario" a la vez, sin decir quién es quién.

## §D. Restricción dura del rediseño

El bloque de pago (código de barras + código LINK/PMC + fechas e importes) **no se toca**: si el
formato o el dígito verificador salen mal, el vecino no puede pagar en la red de cobranza y el
problema aparece recién en la caja de un Rapipago. Todo lo demás de la hoja es rediseñable.

Pendiente de confirmar con la administración: quién asigna el número de boleta y quién arma el
código de barras — si lo genera el sistema contra el convenio del banco, o si lo devuelve el banco.
De eso depende si el nuestro emite el instrumento de pago o solo lo imprime.

---

# §E. Propuesta de diseño

> **Autoría:** `ux-designer`. **Fase 6C — diseño, no implementación.** No cambia **qué** dice la
> boleta (eso lo fijaron el doc 07 §C, el doc 08 y `legal-ph`): cambia **el peso de cada cosa** y
> **cómo se entiende**. Respeta la restricción dura de §D (el bloque de pago no se toca) y no
> contradice el doc 07; donde lo **refina**, está marcado como tal en §E.13.
>
> **Primer uso: vender.** Antes que un artefacto del sistema, esta boleta es la **pieza con la que se
> le muestra el producto al administrador de Las Corzuelas**. La especificación de la muestra —las tres
> hojas, la prueba de los cinco segundos, el bloque de pago que no puede cobrar y lo que de esa muestra
> el sistema todavía no produce— está en **§E.15**, y conviene leerla antes que el resto si lo que hace
> falta es la reunión.
>
> **Encuadre de producto.** `admin-barrios` se vende a administraciones: es multi-tenant y
> **multi-cliente**. Las Corzuelas es el **piloto**, no el destinatario único. Por eso la boleta se
> diseña como **un formato del producto con identidad del cliente** (§E.9, white-label) y **un pie con
> variantes** (§E.10, seis formas de cobrar): las §E.1–§E.8 describen la parte que es igual para todos,
> y §E.9–§E.10 la que cambia por cliente. Las §A–§D de este documento describen **un** caso real, que en
> esta propuesta es la variante **P1**.
>
> **Insumos:** §A–§D de este documento · doc 08 §J (consolidado vs. condicional), §M (sobre qué se
> descuenta), §N/§N.bis (financiamiento del descuento e "impreso: bruto, descuento y neto"), §O
> (comprobante separado), §Z (fiscal), §AA (piezas que faltan), §AC (quién escribe qué) · doc 07 §A
> (motor `@react-pdf/renderer` y sus límites), §B (estructura), §C (alcance), §E (lenguaje
> prohibido), §F (seguridad) · doc 06 §b (tokens Verdemar), §f (accesibilidad) ·
> `packages/design-tokens/{tokens,semantic}.ts` · `packages/data/src/schema/expensas.ts`.

---

## E.1. La decisión que ordena todo: son dos documentos en una hoja

La boleta de hoy tiene un solo registro visual porque en realidad son **dos documentos superpuestos
con dos lectores distintos**, y nadie los separó:

| | **El instrumento** | **La explicación** |
|---|---|---|
| Lo lee | La caja de Rapipago, un escáner, un cajero | El vecino, en el teléfono, 40 segundos |
| Necesita | Formato exacto, negro sobre blanco, dígito verificador | Jerarquía, aire, lenguaje criollo |
| Si sale mal | El vecino **no puede pagar** | El vecino **llama por teléfono** |
| Se toca | **Nunca** (§D) | Todo |

**Todo el rediseño es consecuencia de separarlos**: el instrumento se blinda en una zona de exclusión
al pie, y el resto de la hoja se reorganiza para el lector humano. La hoja de hoy los mezcla — por eso
"todo tiene el mismo peso visual": está diseñada para el escáner, y el vecino lee las sobras.

Corolario práctico: **el importe aparece dos veces a propósito** (arriba en 32 pt para el humano,
abajo en el cupón para la caja). La redundancia es una feature; la regla que la hace segura está en
§E.6.

---

## E.2. Jerarquía de la hoja — cinco zonas y un presupuesto vertical

### E.2.1 El principio: tres preguntas primero, todo lo demás después

Quien abre el PDF tiene tres preguntas en este orden: **cuánto · hasta cuándo · dónde pago**. Hoy las
tres están dispersas y en el mismo cuerpo que el resto. En la propuesta ocupan una fila de tres celdas
en el primer tercio de la hoja, y son lo único de ese tamaño en todo el documento.

Lo demás se ordena por "distancia a la pregunta":

| Zona | Qué responde | Dónde |
|---|---|---|
| **0 · Identidad** | *"¿esto es mío?"* | Frente, arriba |
| **1 · El titular** | *"¿cuánto, cuándo, dónde?"* | Frente, primer tercio — **la primera pantalla del teléfono** |
| **2 · La composición** | *"¿cómo se arma ese número?"* | Frente, segundo tercio |
| **3 · El detalle** | *"¿qué cubre la expensa?"* | Frente, tercer tercio — la única zona elástica |
| **4 · Instrumento (§D)** | *(la caja)* | Frente, pie — **zona de exclusión** |
| **Dorso** | *"¿por qué cambió? ¿por qué tengo/no tengo el descuento? ¿de dónde sale el saldo anterior?"* | Página 2, explicativa, no hace falta imprimirla |

### E.2.2 Presupuesto vertical (A4, 210 × 297 mm)

Márgenes: **14 mm** laterales, **12 mm** arriba, **10 mm** abajo. Ancho útil **182 mm** (el mismo que
fija el doc 07 §B para la tabla de detalle). Alto útil **275 mm**.

| Zona | mm | Elástica |
|---|---|---|
| Franja de acento del barrio (a sangre, sobre el margen superior) | 4 | no |
| 0 · Cabecera de identidad (incluye la caja de logo de 20 mm — §E.9.2) | 28 | no |
| 1 · El titular (cuánto / cuándo / dónde + bandas de estado) | 52 | **no** — 3 slots de banda reservados |
| 2 · Composición del total | 40 | no — renglones de altura fija, ceros explícitos |
| 3 · Detalle por concepto | 54 | **sí, con tope** → desborda al dorso con marcador `(1)` |
| 4 · Notas y "cómo pagar" | 18 | no |
| Línea de corte (troquel punteado real) | 3 | no |
| 5 · **Bloque de pago — INTOCABLE** | 44 | no |
| 6 · Talón "Para la Administración" | 26 | no |
| **Total** | **269** (+22 de márgenes = 291 de 297) | holgura 6 mm |

> **Este presupuesto es el de la variante de pago P1** (cupón con código de barras, el caso de Las
> Corzuelas). `admin-barrios` es un producto multi-cliente y **la zona de pago cambia de tamaño y de
> naturaleza según cómo cobre cada administración** — puede medir 73 mm, 20 mm o no existir. Las
> zonas 0, 1 y 2 son fijas siempre; la 3 absorbe la diferencia, y cuando sobra demasiado el documento
> **se colapsa de dos páginas a una**. El mecanismo completo está en **§E.10**.

**La única zona que crece es la 3.** Es la decisión que hace que la plantilla no se rompa: todo lo
demás tiene altura fija, así que el bloque de pago siempre cae en el mismo lugar de la hoja —
independientemente de si el vecino tiene deuda, bonificación, las dos o ninguna. Un instrumento de
pago que se mueve verticalmente según el caso es un instrumento que alguien corta mal con la tijera.

**Margen inferior de 10 mm y no menos:** las impresoras hogareñas tienen zona no imprimible de
~8–12 mm. Un código de barras a 6 mm del borde sale cortado y no lo lee ninguna caja.

### E.2.3 Wireframe — FRENTE

```
      ╔══════════════════════════════════════════════════════════════════════════╗
  0mm ║██████████████ franja acento del barrio · 4mm · a sangre ██████████████████║
      ╟──────────────────────────────────────────────────────────────────────────╢
      ║                                    ZONA 0 · IDENTIDAD (dos niveles, §E.9.1) ║
      ║  ┌──────────┐                                                              ║
      ║  │  [LOGO]  │  Las Corzuelas            Comprobante N.º  A-2026-07-00174   ║ ← nivel BARRIO
  4mm ║  │ 20×20 mm │  ─────────────────        Emitida         18/07/2026         ║
      ║  └──────────┘  Administra: Administración Las Corzuelas S.A. ·             ║ ← nivel EMISOR
      ║                CUIT 30-XXXXXXXX-X · domicilio            (8 pt)            ║
      ║  ─────────────────────────────────────────────────────────────────────────║
      ║  Mza 61 · Lote 07                         PERÍODO      07/2026             ║
      ║  Destinatario: PÉREZ, ANA — propietaria   Coeficiente  1,9074 %            ║
 32mm ╟──────────────────────────────────────────────────────────────────────────╢
      ║                                                        ZONA 1 · EL TITULAR ║
      ║   TOTAL A PAGAR          VENCE EL              DÓNDE PAGÁS                 ║
      ║  ┌─────────────────┬──────────────────┬─────────────────────────────────┐  ║
      ║  │                 │                  │  Rapipago · Pago Fácil · LINK   │  ║
      ║  │  $ 359.000,00   │   10/08/2026     │  Pago Mis Cuentas               │  ║
      ║  │   ▁▁▁▁32 pt▁▁▁  │    ▁▁18 pt▁▁     │  → con el código del pie         │  ║
      ║  │  período 07/2026│  tope de la red: │  Transferencia → alias al dorso  │  ║
      ║  │  Mza 61 · L 07  │     20/08/2026   │                                  │  ║
      ║  └─────────────────┴──────────────────┴─────────────────────────────────┘  ║
      ║                                                                            ║
      ║  ┌ ● ─────────────────────────────────────────────────────────────────┐   ║ ← banda 1
      ║  │ ✓ AL DÍA · Esta boleta cubre solo el período 07/2026.               │   ║
      ║  └─────────────────────────────────────────────────────────────────────┘   ║
      ║  ┌ ● ─────────────────────────────────────────────────────────────────┐   ║ ← banda 2
      ║  │ ★ BONIFICACIÓN APLICADA  −$ 34.000,00 por pago en término.          │   ║
      ║  │   Cómo se gana y cómo se pierde → al dorso.                         │   ║
      ║  └─────────────────────────────────────────────────────────────────────┘   ║
      ║  ·········· slot 3 reservado (altura fija, vacío en este caso) ··········   ║ ← banda 3
 78mm ╟──────────────────────────────────────────────────────────────────────────╢
      ║                                                    ZONA 2 · LA COMPOSICIÓN ║
      ║  De dónde sale ese número                                                  ║
      ║                                                                            ║
      ║  Expensa ordinaria 07/2026 .............................. $   360.500,00   ║
      ║  Cuota extraordinaria 1/2 · Portal de acceso  (1) ....... $     8.500,00   ║
      ║  Alquiler cancha de pádel · sáb 12/07 · 1 turno ......... $    24.000,00   ║
      ║  Bonificación por pago en término (−)  (2) .............. $  − 34.000,00   ║
      ║                                                          ────────────────  ║
      ║  TOTAL DEL PERÍODO 07/2026 .............................. $   359.000,00   ║
      ║  Saldo de períodos anteriores ........................... $         0,00   ║
      ║  Interés (base $0,00 · 3,00 % mensual · 0 días · al 31/07) $        0,00   ║
      ║                                                          ════════════════  ║
      ║  TOTAL A PAGAR   ↑ es el número grande de arriba ........ $   359.000,00   ║
118mm ╟──────────────────────────────────────────────────────────────────────────╢
      ║                                                      ZONA 3 · QUÉ CUBRE    ║
      ║  El barrio gastó $ 18.900.000,00 en 07/2026. Tu coeficiente es 1,9074 %    ║
      ║  (versión vigente desde 03/2024).                                          ║
      ║                                                                            ║
      ║  CONCEPTO             TIPO       GASTO DEL PERÍODO   COEF.       IMPORTE   ║
      ║  ───────────────────────────────────────────────────────────────────────   ║
      ║  Vigilancia           Ordinaria       8.100.000,00   1,9074 %  154.499,40  ║
      ║  Espacios verdes      Ordinaria       3.400.000,00   1,9074 %   64.851,60  ║
      ║  Administración       Ordinaria       2.200.000,00   1,9074 %   41.962,80  ║
      ║  Energía y alumbrado  Ordinaria       1.900.000,00   1,9074 %   36.240,60  ║
      ║  Mantenimiento        Ordinaria       1.500.000,00   1,9074 %   28.611,00  ║
      ║  Aporte fondo reserva Fondo res.      1.800.000,00   1,9074 %   34.334,60  ║
      ║  Portal de acceso (1) Extraordin.       445.600,00   1,9074 %    8.500,00  ║
      ║  ───────────────────────────────────────────────────────────────────────   ║
      ║  (1) Respaldo: Acta de Asamblea N.º 47 del 12/05/2026. Cuota 1 de 2.       ║
      ║  (2) Bonificación consolidada: no se reclama si esta boleta no se paga.    ║
      ║      El importe ya está descontado del total.                              ║
      ║  (3) El prorrateo usa el coeficiente con 9 decimales; acá se muestran 4.   ║
      ║      Diferencias de hasta $0,01 por unidad son el resto del reparto.       ║
178mm ╟──────────────────────────────────────────────────────────────────────────╢
      ║  Consultas: administracion@lascorzuelas.com.ar · Lun a Vie 9 a 17           ║
      ║  El pago de la presente no libera de obligaciones de períodos anteriores.   ║
      ║  Explicación completa, bonificación y medios de pago → AL DORSO             ║
196mm ╟─ ✂ ─────────────────────── PRESENTÁ ESTA PARTE EN LA CAJA ─ ✂ ───────────╢
      ║                                                                            ║
      ║   ██ ZONA 4 · BLOQUE DE PAGO — INTOCABLE (§D) ██                           ║
      ║   ██ Nada del rediseño entra acá: ni filete, ni acento, ni marca de agua ██ ║
      ║                                                                            ║
      ║   [logo banco]  [logos red de cobranza]     Cta. cte. / convenio: 00XXXXX   ║
      ║   LINK / Pago Mis Cuentas:  0000 0000 0174                                  ║
      ║                                                                            ║
      ║   VENCIMIENTO   10/08/2026    IMPORTE   $ 359.000,00                        ║
      ║   FECHA TOPE    20/08/2026    IMPORTE   $ 359.000,00                        ║
      ║                                                                            ║
      ║   ┃┃│┃││┃┃│┃│┃┃││┃│┃┃│┃││┃┃│┃│┃┃││┃│┃┃│┃││┃┃│┃│┃┃││┃│┃┃│┃││┃┃│┃│┃┃││┃│┃    ║
      ║   ←5mm quiet zone→        ~139 mm de ancho        ←5mm quiet zone→          ║
243mm ╟─ · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · ─╢
      ║   ZONA 5 · PARA LA ADMINISTRACIÓN                                          ║
      ║   Administración Las Corzuelas S.A. · Mza 61 · Lote 07 · Período 07/2026    ║
      ║   PÉREZ, ANA          Comprobante A-2026-07-00174                          ║
      ║   Vencimiento 10/08/2026  $ 359.000,00  ·  Fecha tope 20/08/2026 $ 359.000,00║
269mm ╚══════════════════════════════════════════════════════════════════════════╝
```

### E.2.4 Qué se **bajó** de peso respecto de la boleta de hoy

| Elemento | Hoy | Propuesta | Por qué |
|---|---|---|---|
| Logos de banco y redes | Cabecera, arriba de todo | **Dentro del bloque de pago**, al pie | Son información **de pago**, no de identidad. Arriba compiten con el importe |
| Razón social de la administración | Cuerpo grande, arriba | 10 pt, cabecera | El vecino ya sabe quién le cobra. Ocupa el lugar del dato que sí necesita |
| Número de comprobante | 8 dígitos sueltos | Cabecera derecha, mono, 10 pt | Es un dato de referencia, no un titular |
| Las tres leyendas al pie | Tres párrafos del mismo cuerpo que el detalle | **Una** al frente, las otras dos al dorso | La única que cambia la conducta ("no libera de obligaciones anteriores") se queda; las otras dos son procedimiento |
| Fecha tope | Igual de grande que el vencimiento | **Subordinada** al vencimiento (10 pt bajo el 18 pt) | No es un segundo vencimiento (§B.6). Igualarlas enseña a pagar tarde |

---

## E.3. El detalle que hoy no está — tres niveles, no uno

La regla dura del proyecto ("toda cifra se explica con su origen") no se cumple imprimiendo todo:
40 renglones de $890 explican menos que 7 renglones agrupados. La respuesta es **estratificar**.

| Nivel | Dónde | Qué |
|---|---|---|
| **1 · La cuenta** | Frente, zona 2 | Bruto → cargos → bonificación → total del período → saldo anterior → interés → total a pagar. **Siempre los mismos renglones, con cero explícito** |
| **2 · El origen** | Frente, zona 3 | Una línea **por concepto agrupado** (doc 07 §C.2), con `gasto del período × coeficiente = importe` en columnas verificables con calculadora |
| **3 · La explicación** | **Dorso** | Por qué cambió contra el mes pasado · la bonificación (ganada, perdida, cómo se recupera) · el saldo anterior período por período · cómo se calculó el interés · medios de pago completos |
| **4 · El desglose gasto por gasto** | **Reporte mensual del barrio**, adjunto en el mismo email (doc 07 §C.2) | 25–40 gastos con proveedor y comprobante. **No va en la boleta y tampoco en el dorso** |

### E.3.1 Wireframe — DORSO (página 2)

```
      ╔══════════════════════════════════════════════════════════════════════════╗
      ║  Mza 61 · Lote 07 · Período 07/2026 · Comprobante A-2026-07-00174          ║
      ║  Esta página es explicativa. No hace falta imprimirla para pagar.          ║
      ╟──────────────────────────────────────────────────────────────────────────╢
      ║  1 · CÓMO SE LLEGÓ A ESTE NÚMERO                                          ║
      ║                                                                            ║
      ║     El barrio gastó ................................ $ 18.900.000,00       ║
      ║     Tu coeficiente ................................. × 1,9074 %            ║
      ║     Te corresponde de la expensa ordinaria ......... $    360.500,00       ║
      ║     + obra Portal de acceso (cuota 1 de 2) ......... $      8.500,00       ║
      ║     + alquiler cancha de pádel (sáb 12/07, 1 turno)  $     24.000,00       ║
      ║     − bonificación por pago en término .............. $    −34.000,00       ║
      ║     = TOTAL DEL PERÍODO ............................ $    359.000,00       ║
      ╟──────────────────────────────────────────────────────────────────────────╢
      ║  2 · POR QUÉ CAMBIÓ RESPECTO DEL MES PASADO                               ║
      ║                                                                            ║
      ║     06/2026  $ 372.000,00  →  07/2026  $ 360.500,00     ▼ −3,1 %          ║
      ║     El gasto del barrio bajó 3,1 %. Tu coeficiente no cambió.              ║
      ║     (Comparación contra el período anterior liquidado en este sistema.)    ║
      ╟──────────────────────────────────────────────────────────────────────────╢
      ║  3 · LA BONIFICACIÓN POR PAGO EN TÉRMINO                                  ║
      ║                                                                            ║
      ║     Qué es      Un descuento sobre la expensa ordinaria para quien no      ║
      ║                 tiene saldo pendiente al cierre del período anterior.      ║
      ║     Cómo se     Se pierde el mes siguiente a quedar con saldo.             ║
      ║     pierde      Se recupera apenas te ponés al día — sin esperar meses.    ║
      ║     No se       No se aplica sobre el fondo de reserva, ni sobre la obra,  ║
      ║     aplica a    ni sobre intereses o saldos anteriores.                    ║
      ║     ──────────────────────────────────────────────────────────────────    ║
      ║     TU SITUACIÓN ESTE PERÍODO                                              ║
      ║     ✓ Aplicada · −$ 34.000,00                                              ║
      ║       Evaluada al 30/06/2026 · sin saldo pendiente a esa fecha.            ║
      ║       Origen del dato: carga manual de la administración.  (*)             ║
      ╟──────────────────────────────────────────────────────────────────────────╢
      ║  4 · SALDO DE PERÍODOS ANTERIORES E INTERÉS                               ║
      ║     (bloque presente siempre; en cero cuando no hay saldo)                 ║
      ║                                                                            ║
      ║     Período   Concepto              Importe      Estado                    ║
      ║     ──────────────────────────────────────────────────────────────────    ║
      ║     —         Sin saldo pendiente al 30/06/2026                            ║
      ║                                                                            ║
      ║     Interés: no corresponde (base $0,00).                                  ║
      ╟──────────────────────────────────────────────────────────────────────────╢
      ║  5 · MEDIOS DE PAGO                                                       ║
      ║     Redes        Rapipago · Pago Fácil · LINK · Pago Mis Cuentas,          ║
      ║                  con el código del pie del frente.                         ║
      ║     Transferencia  CBU 0000000000000000000000                              ║
      ║                    Alias LAS.CORZUELAS.EXP                                 ║
      ║                    Titular Administración Las Corzuelas S.A.               ║
      ║                    Poné el N.º de comprobante A-2026-07-00174 en la        ║
      ║                    referencia: así se imputa a esta boleta.                ║
      ║     Después de   Esta boleta se abona en las entidades autorizadas hasta   ║
      ║     la fecha     su fecha tope. Pasada esa fecha, pedí la actualización    ║
      ║     tope         por mail a administracion@lascorzuelas.com.ar             ║
      ╟──────────────────────────────────────────────────────────────────────────╢
      ║  6 · LEYENDAS                                                             ║
      ║     El pago de la presente no libera de obligaciones de períodos           ║
      ║     anteriores. Los intereses generados por el pago posterior al           ║
      ║     vencimiento se devengan en la boleta del período siguiente.            ║
      ║     Administración Las Corzuelas S.A. · Sociedad Anónima ·                 ║
      ║     domicilio · CUIT · consultas y horarios.                              ║
      ╚══════════════════════════════════════════════════════════════════════════╝
```

`(*)` El origen del dato es obligatorio y no es adorno: mientras no exista el módulo de cobros, el
sistema **no puede decir "el sistema verificó"** (doc 08 §AA). Ver §E.11.

### E.3.2 Por qué el dorso y no un QR a una vista web

**El QR queda fuera del MVP, y no por costo.** Doc 07 §F es explícito: *"nunca URLs o tokens adentro
del documento (el PDF se reenvía)"*. Un QR con URL firmada es exactamente eso — y el PDF de expensas
es el archivo que más se reenvía en un barrio (al cónyuge, al inquilino, al contador, al grupo de
WhatsApp del consorcio). Con TTL de 10 minutos el QR además estaría muerto para casi todos los que lo
escaneen, lo que es peor que no tenerlo.

Y un QR a un portal **con login** tampoco sirve todavía: doc 08 §Y fija que *no se abre ningún camino
de lectura para `propietario`/`residente` hasta que exista el vínculo usuario→unidad y la RLS filtre
por unidad*. Hoy el QR no tiene destino legítimo.

**Decisión:** el dorso hace el trabajo del QR, y **se reserva el espacio** (esquina inferior derecha de
la zona 4 de notas, 20 × 20 mm) para cuando exista el portal del residente. Cuando exista, el QR
apuntará a una URL **estable y sin token** del tipo `/{barrio}/boleta/{numeroComprobante}` que exige
sesión — no a un objeto de storage.

### E.3.3 QR de acceso ≠ QR de pago — la distinción que hay que fijar

Lo de arriba prohíbe **el QR de acceso**: el que lleva a un documento, a un objeto de storage o a una
sesión. Un **QR de pago** es otra cosa y **sí está permitido**:

| | QR de **acceso** | QR de **pago** |
|---|---|---|
| Codifica | URL + token | CVU/alias + importe + referencia |
| Si el PDF se reenvía | Un tercero **lee datos de otra unidad** | Un tercero **le paga la expensa al barrio** |
| Veredicto | **Prohibido** (doc 07 §F) | **Permitido** — es la variante P4 de §E.10 |

La regla queda enunciada así, para que nadie la lea al revés: *del PDF nunca sale un identificador que
**abra** algo; sí puede salir uno que **cobre**.* El QR de pago es, además, la variante de instrumento
más probable en las administraciones que no tienen convenio con una red de cobranza.

---

## E.4. Los estados — una plantilla, bandas apilables

**Una sola plantilla. Nunca dos.** Dos plantillas divergen, y el bug siempre aparece en la que menos se
mira. Lo que cambia es el **contenido** de bloques de altura fija.

**Dos mecanismos, y son distintos a propósito:**

1. **Los renglones de la zona 2 nunca desaparecen** — saldo anterior, interés y total se imprimen
   aunque valgan cero (doc 07 §B: *"un renglón ausente se lee como dato escondido"*). Altura constante.
2. **Las bandas de la zona 1 cambian, apilan y tienen 3 slots reservados.** Son las que hacen que la
   hoja del que debe se lea distinta de la del que está al día, sin mover una sola coordenada.

### E.4.1 Catálogo de bandas

| Banda | Cuándo | Token de color | Ícono | Texto (modelo) |
|---|---|---|---|---|
| **Al día** | `saldo_anterior = 0` | `morosidad.alDia` | `✓` | "AL DÍA · Esta boleta cubre solo el período MM/AAAA." |
| **Saldo anterior** | `saldo_anterior > 0` | `morosidad.vencido` | `!` | "INCLUYE $X de períodos anteriores y $Y de interés. Detalle al dorso." |
| **Bonificación aplicada** | descuento presente | `primarySubtle` / `primary` | `★` | "BONIFICACIÓN APLICADA −$X por pago en término. Cómo se gana y cómo se pierde → al dorso." |
| **Bonificación no aplicada** | régimen vigente + no calificó | `info` | `i` | "ESTE PERÍODO NO SE APLICÓ LA BONIFICACIÓN de $X. Se evalúa por saldo pendiente al DD/MM. Cómo recuperarla → al dorso." |
| **Interés pendiente de definición** | `mora_pendiente_definicion = true` | `warning` | `?` | "INTERÉS PENDIENTE DE DEFINICIÓN: el barrio no tiene tasa cargada a la fecha de emisión. No se estimó ningún importe." |
| **Vista previa** | período en `borrador`/`revisada` | `liquidacion.borrador` | `▢` | "VISTA PREVIA — no es un comprobante de pago." Marca de agua diagonal **que no cruza la zona 4**. |

**Reglas de apilado:** máximo 3 bandas; orden fijo *(estado de cuenta → bonificación → estado de la
cifra)*; si hubiera una cuarta, se colapsa la de menor prioridad en una línea de texto de 10 pt. El
slot vacío **no se colapsa** — mantiene la altura.

### E.4.2 Los cuatro casos pedidos, más el quinto que impone el esquema

**Caso A · Al día, con bonificación** *(el wireframe de §E.2.3)*

```
  [ TOTAL A PAGAR $359.000,00 ]  [ VENCE 10/08 ]  [ DÓNDE PAGÁS ]
  ✓ AL DÍA · Esta boleta cubre solo el período 07/2026.
  ★ BONIFICACIÓN APLICADA  −$34.000,00 por pago en término. → al dorso
  ····· slot 3 vacío (altura reservada) ·····
  ─── zona 2 ────────────────────────────────────────────────────
  TOTAL DEL PERÍODO 07/2026 ................. $ 359.000,00
  Saldo de períodos anteriores .............. $       0,00
  Interés (base $0,00 · 3,00 % · 0 días) .... $       0,00
  TOTAL A PAGAR ............................. $ 359.000,00
```

**Caso B · Al día, SIN bonificación** — *el que hoy no se entera de nada* (doc 08 §AA)

```
  [ TOTAL A PAGAR $394.500,00 ]  [ VENCE 10/08 ]  [ DÓNDE PAGÁS ]
  ✓ AL DÍA · Esta boleta cubre solo el período 07/2026.
  i ESTE PERÍODO NO SE APLICÓ LA BONIFICACIÓN de $34.000,00.
    Se evalúa por saldo pendiente al 30/06/2026. Cómo recuperarla → al dorso.
  ····· slot 3 vacío ·····
  ─── zona 2 ────────────────────────────────────────────────────
  Expensa ordinaria 07/2026 ................. $ 360.500,00
  Bonificación por pago en término .......... $       0,00   ← renglón informativo
     no aplicada · evaluada al 30/06/2026
  TOTAL DEL PERÍODO 07/2026 ................. $ 394.500,00
```

Este renglón en cero es lo que hace funcionar el mecanismo entero de doc 08 §N.bis: *"un descuento que
no se ve no cambia la conducta de nadie"*. **No es un `item_liquidacion`** (violaría el signo y la
biyección de §L) — es un renglón informativo del documento, y hoy **no tiene dónde guardarse** (§E.9).

Nota de lenguaje: el texto dice *"por saldo pendiente al DD/MM"*, **nunca** "moroso", "deudor" ni
"incumplidor" (doc 07 §E, grupo G).

**Caso C · Con saldo anterior e interés**

```
  [ TOTAL A PAGAR $598.418,00 ]  [ VENCE 10/08 ]  [ DÓNDE PAGÁS ]
  ! INCLUYE $ 230.100,00 de períodos anteriores y $ 9.318,00 de interés.
    Detalle período por período → al dorso.
  i ESTE PERÍODO NO SE APLICÓ LA BONIFICACIÓN de $34.000,00. → al dorso
  ····· slot 3 vacío ·····
  ─── zona 2 ────────────────────────────────────────────────────
  TOTAL DEL PERÍODO 07/2026 ................. $ 359.000,00
  Saldo de períodos anteriores .............. $ 230.100,00
  Interés (base $230.100,00 · 3,00 % mensual · 45 días · al 31/07/2026)
                                              $  10.354,50
  TOTAL A PAGAR ............................. $ 599.454,50
```

**Los dos totales, siempre.** Fusionarlos hace imposible responder *"¿cuánto es de este mes?"*, que es
la primera pregunta de todo reclamo (doc 07 §B). Y el interés **siempre** con base, tasa, días y fecha
de corte en la misma línea.

**Caso D · Saldo anterior + bonificación perdida** — el que rompe plantillas. Es el caso C con las dos
bandas y el renglón informativo en cero: **3 bloques extra, 0 mm de reflow**, porque los renglones ya
estaban reservados y las bandas tienen 3 slots. Este es el caso de prueba de la plantilla.

**Caso E · Interés pendiente de definición** — lo impone el esquema
(`liquidacion.mora_pendiente_definicion`, con su check). El renglón dice **"pendiente de definición"**,
no `$0,00`: un cero es una afirmación de que no hay interés, y el sistema no la puede hacer. Es la
misma regla que doc 01 §3.4 ("no se muestra como cifra cerrada, se marca pendiente").

---

## E.5. Jerarquía tipográfica con los tokens existentes

### E.5.1 La restricción que fija los tamaños: el teléfono

La mayoría abre el PDF en WhatsApp, en un teléfono, **con la hoja ajustada al ancho**. Ese es el
escenario de diseño, no el papel.

- A4 = **595 pt** de ancho. Viewport típico ≈ **390 px**. Factor de escala **0,655**.
- Piso de legibilidad sin zoom ≈ **9 px** en pantalla.
- ⇒ **Nada de la zona 1 puede bajar de 14 pt** (14 × 0,655 ≈ 9,2 px).
- ⇒ Un titular de **32 pt** llega a ≈ **21 px**: se lee de un vistazo, sin zoom, con el teléfono en la
  mano y el brazo estirado.
- ⇒ El detalle a **9 pt** llega a ≈ 5,9 px: **se lee con zoom, y está bien** — nadie audita el
  prorrateo sin zoom. La distancia entre 32 pt y 9 pt **es** la jerarquía.

> Token nuevo a agregar antes de construir (regla doc 06 §g.2 — primero el token, después el uso):
> `printFitWidthFactor = 0.655` y `printMinLegibleZona1 = 14` (pt). Sin ellos, alguien va a "achicar
> un poquito el total para que entre" y va a romper la única garantía de lectura en teléfono.

### E.5.2 Escala de impresión — token nuevo `fontSizePrint`

Los tokens de `fontSize` están en **px** para pantalla; el papel necesita **pt**. No se reusa el mismo
objeto: `fontSize.base = 16` en pt sería un cuerpo de texto de 5,6 mm. Se agrega una escala hermana,
derivada de la misma jerarquía de nombres.

```ts
// packages/design-tokens/tokens.ts — a agregar
export const fontSizePrint = {
  micro: 7,   // SOLO pie legal del dorso
  xs:    8,   // piso duro del FRENTE
  sm:    9,   // filas del detalle
  base: 10,   // cuerpo
  lg:   12,   // subtotales y etiquetas de zona
  xl:   14,   // PISO de la zona 1 (fit-width en teléfono)
  "2xl":18,   // vencimiento e importes del bloque de pago
  "3xl":24,   // (reservado)
  "4xl":32,   // TOTAL A PAGAR
} as const;
```

Endurece el piso de 7 pt del doc 07 §B: **7 pt solo en el pie legal del dorso**; en el frente el piso
es **8 pt**.

### E.5.3 Mapa rol → token

| Rol | Tamaño | Peso | Familia | Tinta (scheme `print`) |
|---|---|---|---|---|
| **TOTAL A PAGAR** (zona 1) | `4xl` 32 | `bold` | `font.numeric` | `textPrimary` |
| Etiqueta "TOTAL A PAGAR" | `xl` 14 | `semibold`, versalitas, tracking +4 % | `font.sans` | `textSecondary` |
| Fecha de vencimiento | `2xl` 18 | `semibold` | `font.numeric` | `textPrimary` |
| "Tope de la red" + fecha | `base` 10 | `regular` | `font.numeric` | `textSecondary` |
| Texto de banda de estado | `xl` 14 | `medium` | `font.sans` | `morosidad.*.fg` / `primary` / `info` / `warning` |
| Identidad (barrio · Mza/Lote · período) | `xl` 14 | `medium` | `font.sans` + `font.mono` para Mza/Lote | `textPrimary` |
| Cabecera administración, CUIT, emisión | `base` 10 | `regular` | `font.sans` | `textSecondary` |
| N.º de comprobante | `base` 10 | `medium` | `font.mono` | `textPrimary` |
| Título de zona ("De dónde sale ese número") | `lg` 12 | `semibold`, versalitas | `font.sans` | `textSecondary` |
| Renglones de composición | `base` 10 | `regular` | `font.numeric` | `textPrimary` |
| "TOTAL DEL PERÍODO" / "TOTAL A PAGAR" (zona 2) | `lg` 12 | `bold` | `font.numeric` | `textPrimary` |
| Encabezado de tabla de detalle | `xs` 8 | `semibold`, versalitas | `font.sans` | `textSecondary` |
| Filas de detalle — concepto y tipo | `sm` 9 | `regular` | `font.sans` | `textPrimary` |
| Filas de detalle — importes y coeficiente | `sm` 9 | `regular` | `font.numeric` | `textPrimary` |
| Notas `(1) (2) (3)` | `xs` 8 | `regular` | `font.sans` | `textSecondary` |
| **Bloque de pago — importes** | `2xl` 18 | `bold` | `font.numeric` | **`#000000`** |
| **Bloque de pago — etiquetas** | `base` 10 | `semibold` | `font.sans` | **`#000000`** |
| Talón | `sm` 9 | `regular` | `font.sans` | **`#000000`** |
| Pie legal del dorso | `micro` 7 | `regular` | `font.sans` | `textSecondary` |

**Tres reglas de tinta, no negociables:**

1. **`textMuted` (`#6B7686`) está prohibido en `print`.** Da ~4,6:1 sobre blanco — apenas AA a tamaño
   normal, y por debajo de 10 pt o tras una fotocopia deja de leerse. En papel solo existen
   `textPrimary` (`#0B1220`, ~18:1) y `textSecondary` (`#3A4657`, ~10,3:1). La jerarquía la hace el
   **tamaño y el peso**, no el gris.
2. **La zona 4 se imprime en `#000000` puro sobre `#FFFFFF` puro**, no en `textPrimary`. `#0B1220` es
   azulado: una impresora lo puede resolver como negro compuesto (CMY) y bajar el contraste del
   código de barras justo lo suficiente para que la caja no lo lea. **Este es el único lugar del
   producto donde un hex crudo está permitido**, y va documentado en el token
   `print.instrumentoInk = "#000000"`.
3. **El acento del barrio termina en la franja superior de 4 mm** (doc 06 §b.5) y necesita
   `acentoBarrioHex()` — el motor no parsea la sintaxis `hsl()` moderna (doc 07 §B). No entra en
   ninguna otra parte de la hoja, y jamás en la zona 4.

**Sobre `tabular-nums`:** `@react-pdf/renderer` **no soporta `font-variant-numeric`** (doc 07 §A).
Geist Mono es monoespaciada real, así que las columnas alinean igual. La consecuencia es que
**`font.numeric` es obligatorio en toda cifra del papel** — no es una preferencia estética, es lo único
que sostiene la alineación en este motor.

---

## E.6. El bloque de pago — cómo se diseña alrededor sin tocarlo

**Regla de zona de exclusión.** El rectángulo del instrumento **de la variante activa** (§E.10) es una
región cerrada, anclada siempre al borde inferior. En la variante P1 son los últimos 73 mm (zonas 4 + 5
más el troquel); en P3 son 28 mm; en P5 no hay instrumento y no hay zona de exclusión. **Lo que no
cambia con la variante es la regla**:

- **Prohibido dentro:** acento del barrio · sombras · radios · fondos de color · marcas de agua
  (incluida la de "VISTA PREVIA") · filetes decorativos · texto del rediseño · el QR futuro.
- **Permitido:** el contenido tal como lo entrega el convenio de cobranza, más **dos agregados
  puramente orientativos y fuera del rectángulo del instrumento**: (a) el rótulo del troquel
  *"✂ PRESENTÁ ESTA PARTE EN LA CAJA ✂"*, y (b) la línea de corte punteada real (hoy no está clara y
  la gente corta a ojo).
- **Quiet zone:** ≥ 5 mm libres a izquierda y derecha del código de barras, y ≥ 4 mm arriba y abajo.
  **Nada se pone al costado del código**, y no es una preferencia: con ~58 dígitos, una simbología
  tipo *Interleaved 2 of 5* y un módulo de 0,33 mm, el código mide **≈ 139 mm** de los 182 útiles. Con
  las dos quiet zones quedan ~33 mm de sobrante total: no hay columna lateral posible. *(Estimación —
  la simbología y el módulo reales dependen del convenio; ver §D, pendiente de confirmar.)*

**La duplicación de importes: una sola fuente, tres renderizados.** El total aparece en zona 1, en la
zona 4 y en el talón. Regla: los tres salen del **mismo campo** (`liquidacion.total`) por el **mismo
helper de formato** (`packages/shared` — doc 07 §A: formatear en Node, nunca dejarlo a
`Intl.NumberFormat` en un runtime sin ICU completo). Si alguna vez difieren, es un bug, no un caso.

> **Criterio de aceptación para `qa-automation`,** extensión del test de humo del doc 07 §A: *el
> importe de la zona 1, el del cupón, el del talón y el codificado en el código de barras son la misma
> cifra, byte a byte, y las dos fechas del cupón coinciden con `primer_vencimiento` y con la fecha
> tope.*

**Fecha tope subordinada, nunca igualada.** §B.6 ya estableció que la fecha tope **no es un segundo
vencimiento con recargo**: es el límite de la red, con el mismo importe. Diseñar las dos con el mismo
peso —como hoy— le enseña al vecino que el vencimiento real es el segundo. En la zona 1 el vencimiento
va en 18 pt y la fecha tope en 10 pt debajo, con la palabra "tope de la red". **Dentro de la zona 4 se
respeta el formato del convenio tal cual**: ahí no se rediseña nada.

---

## E.7. Impresión y pantalla

### E.7.1 Un PDF, dos páginas, dos usos

| | Pantalla (mayoría) | Papel (minoría) |
|---|---|---|
| Página 1 | Se lee sin zoom hasta zona 2; zona 3 con zoom | Se imprime y se corta por el troquel |
| Página 2 | Se scrollea | **No hace falta imprimirla** — lo dice en la cabecera de la página |

**Nada crítico depende del color.** La hoja tiene que sobrevivir a: escala de grises · fotocopia ·
captura de pantalla comprimida por WhatsApp. Por eso las bandas de estado llevan **ícono geométrico +
palabra + cifra**, los filetes son de 0,4 pt (doc 07 §B) y no hay zebra striping.

### E.7.2 Lo que se lee en la primera pantalla del teléfono

```
 ┌───────────────────────────┐  ← 390 px, A4 ajustado al ancho
 │▓▓▓▓ acento del barrio ▓▓▓▓│
 │ Adm. Las Corzuelas S.A.   │  ~7 px  — se intuye, no se lee
 │ Mza 61 · Lote 07  07/2026 │  ~9 px  — SE LEE  ✔
 │                           │
 │  TOTAL A PAGAR            │  ~9 px  ✔
 │  $ 359.000,00             │ ~21 px  ✔✔ ← lo que se ve de un vistazo
 │  VENCE 10/08/2026         │ ~12 px  ✔
 │  Rapipago · Pago Fácil…   │  ~9 px  ✔
 │  ✓ AL DÍA · solo 07/2026  │  ~9 px  ✔
 │  ★ BONIFICACIÓN −$34.000  │  ~9 px  ✔
 │ ───────────────────────── │
 │ De dónde sale ese número  │  ~8 px  ~ límite
 │ ·········(zoom)·········· │  ~6 px  — con zoom, y está bien
 └───────────────────────────┘
```

**Prueba de aceptación:** abrir el PDF en un teléfono de 390 px de ancho, ajustado al ancho, sin
zoom — **cuánto, cuándo, dónde y el estado se responden sin tocar la pantalla**. Si hace falta zoom
para saber cuánto se paga, el diseño falló.

### E.7.3 La entrega también es diseño

- **Nombre del archivo.** En WhatsApp lo primero que se ve es el nombre, no el contenido. Vía
  `response-content-disposition` (doc 07 §F, que ya separa la clave opaca del nombre lindo):
  `Expensas-LasCorzuelas-2026-07-Mza61-Lote07.pdf`. **Sin nombres de personas** — el archivo se
  reenvía.
- **El cuerpo del email lleva el resumen en texto real** (no una imagen, no solo el adjunto): barrio,
  unidad, período, total y vencimiento. Una parte de la gente no abre el adjunto, y este es hoy **el
  único camino accesible del producto** (§E.8).
- **El asunto** trae el dato, no el trámite: *"Las Corzuelas · Mza 61 L 07 · Expensas 07/2026 ·
  $359.000 · vence 10/08"*.
- **Un destinatario por mail, sin cc/bcc** (doc 07 §F.2). No se toca.

### E.7.4 Estados del artefacto (equivalentes a vacío/carga/error)

Un PDF no tiene estado de carga, pero el flujo que lo produce sí:

| Estado | Qué se ve |
|---|---|
| **Generando** | En la pantalla de distribución: progreso por unidad con la forma del contenido (doc 06 §e.4), nunca un spinner mudo |
| **Vista previa** (período `borrador`/`revisada`) | Banda `▢ VISTA PREVIA — no es un comprobante de pago` + marca de agua diagonal **que no cruza la zona 4** |
| **Dato faltante** | El renglón dice *"pendiente"* con el motivo, nunca `$0,00` (doc 01 §3.4). Caso E de §E.4.2 |
| **Emisión bloqueada** | Fideicomiso: el sistema **no emite** (doc 07 §E) y la UI explica que falta la fuente cargada de denominación y órganos — no cae al texto de PH por defecto |
| **Sin período anterior** | El bloque 2 del dorso dice *"primer período liquidado en este sistema"* y **no calcula un delta contra nada** |

---

## E.8. Accesibilidad

**Se dice sin maquillaje, como en el doc 07 §B: el PDF sale sin etiquetar y no es accesible para
lectores de pantalla.** Ningún motor evaluado lo resuelve, y **no se declara AA sobre el PDF**. Lo que
sí se garantiza:

1. **Contraste.** Todo texto del frente ≥ 4,5:1 sobre blanco. `textMuted` prohibido en papel (§E.5.3).
   La zona 4, en negro puro.
2. **Tamaño mínimo.** 8 pt en el frente, 7 pt solo en el pie legal del dorso, **14 pt en toda la
   zona 1** (§E.5.1). Verificable con un linter sobre los estilos del generador: cualquier `fontSize`
   por debajo del piso de su zona falla el build.
3. **Nunca solo color.** Cada banda lleva **ícono + palabra + cifra**. La bonificación se distingue por
   el signo `−` **y** la palabra "Bonificación", no por ser verde; el saldo anterior por el `!` **y**
   la palabra, no por ser rojo. Verificable: la hoja en escala de grises sigue diciendo lo mismo.
   *(Corolario: la bonificación **no se imprime en verde ni en rojo**. Rojo es `danger`/mora en los
   tokens del producto y una bonificación es buena noticia; verde compite con "al día". Va en tinta
   normal.)*
4. **No depende de la orientación ni del zoom**: una sola columna lógica, sin cajas flotantes que se
   pierdan al ajustar al ancho.
5. **El camino accesible es el HTML** — hoy, el resumen en el cuerpo del email (§E.7.3); mañana, la
   vista web de la misma plantilla cuando exista el portal del residente. **Esa vista sí se declara
   AA** (doc 06 §f completo: foco visible, teclado, `aria`, 200 % de zoom).
6. **Lenguaje.** Doc 07 §E se aplica entero. Ninguna frase de los grupos A–G. En particular, quien
   pierde la bonificación lee *"por saldo pendiente al 30/06/2026"*, **nunca** una calificación de la
   persona. Las leyendas se redactan **en positivo**.
7. **Hyphenation propia** (doc 07 §A): no se corta ninguna palabra salvo que supere el ancho de
   columna. Un CBU o un alias partido al medio es un error de lectura que termina en una transferencia
   fallida.

---

## E.9. White-label — qué se personaliza y qué no

`admin-barrios` se vende a administraciones. **La hoja lleva la identidad del cliente, no la nuestra**:
en la boleta que recibe el vecino no aparece ni el nombre ni la marca del producto. Pero "personalizable"
no puede significar "cada cliente arma su boleta": lo que estamos vendiendo **es** la trazabilidad y la
legibilidad, y eso no se negocia por cliente.

### E.9.0 La marca es de DOS niveles, no de uno

**Corrección de fondo** (2026-07-26). La primera versión de esta sección trataba "el cliente" como una
sola entidad. Son dos, con funciones distintas, y confundirlas es lo que produce boletas donde el vecino
no sabe de quién es la cuenta:

| | **El BARRIO** | **La ADMINISTRACIÓN** |
|---|---|---|
| Qué es | **La identidad que el vecino reconoce** | **El emisor legal** |
| Aporta | Logo · nombre comercial · color de acento | Razón social · CUIT · domicilio · contacto · mandato |
| Dónde va | **Arriba y grande**: caja de logo + nombre en 12 pt + la franja de color | **Letra chica**, jerarquía de pie: 8 pt bajo el nombre del barrio, completo al dorso |
| Por qué | El vecino le paga **a su barrio** | Es un dato legal obligatorio, no un elemento de marca |

**Un administrador gestiona varios barrios y cada uno conserva su identidad.** La misma administración
emite la boleta de Las Corzuelas y la de otro barrio, y **las dos se ven distintas arriba y iguales
abajo**. Eso no es una concesión estética: es lo que evita que el vecino crea que le está pagando a una
empresa que no conoce.

**Qué pasa cuando falta uno de los dos:**

| Caso | Qué se hace | Por qué |
|---|---|---|
| Barrio con logo · administración con logo | **Solo el del barrio arriba.** El de la administración va **al dorso**, a 10 mm, junto a la razón social | El frente responde "¿de quién es esta cuenta?", y la respuesta es el barrio |
| **Barrio sin logo · administración con logo** | **NO se sube el de la administración al frente.** Se compone el logotipo tipográfico con el nombre **del barrio** (§E.9.2). El de la administración sigue al dorso | Poner el logo de la administración donde el vecino espera el de su barrio es exactamente la confusión que este modelo evita |
| Barrio con logo · administración sin logo | Caso normal, no pasa nada | — |
| Ninguno de los dos | Logotipo tipográfico con el nombre del barrio | Es el default, no la excepción |

### E.9.1 Los tres niveles de personalización

| Nivel | Qué | Quién lo define |
|---|---|---|
| **1 · Identidad — se personaliza** | **Del barrio:** logo · nombre comercial · color de acento. **De la administración:** razón social · CUIT · domicilio · casilla y teléfono · horarios · leyendas propias. Y la denominación del concepto ("expensa" / "cuota social" / "aporte", que ya existe como `denominacion_concepto`) | La administración configura los dos niveles (§E.9.0) |
| **2 · Instrumento — se configura por barrio** | Qué variante de pago se usa y sus datos (§E.10) | La administración, por barrio |
| **3 · Estructura — NO se personaliza** | Orden de las zonas · jerarquía y pisos tipográficos (§E.5) · la composición del total con ceros explícitos · la tabla `gasto del período × coeficiente = importe` · las bandas de estado · la zona de exclusión · el lenguaje prohibido (doc 07 §E) · el piso de contraste | **El producto** |

**El criterio que separa el nivel 1 del 3:** se personaliza lo que dice **quién cobra**; no se
personaliza lo que dice **por qué se cobra eso**. El nivel 3 es la promesa del producto; si un cliente
puede sacar la columna "Gasto del período" porque "queda cargado", en seis meses hay cuarenta boletas
distintas, ninguna soportable, y la regla dura del proyecto se evapora cliente por cliente.

**Lo que un cliente puede pedir y la respuesta es no** *(anticipando el ticket, que va a llegar)*:
mover el detalle al dorso · sacar la columna del gasto del barrio · achicar el total "porque queda muy
grande" · poner la boleta en dos columnas · agregar el logo de un sponsor · imprimir un ranking, un
listado de unidades con saldo, o cualquier dato de otra unidad (doc 07 §F). Para todo eso la respuesta
es la misma: **el frente es un formato del producto**. Lo que el cliente quiera agregar de su cosecha
va en un **bloque de texto libre de la administración** en el dorso, acotado (ver §E.9.4).

### E.9.2 El logo — diseño defensivo, porque va a llegar horrible

Va a pasar: 90 × 90 px sacado de una web de 2011, un JPG con artefactos, un PNG apaisado 8:1, uno con
el fondo blanco recortado a medias, uno de 6 MB. **El diseño tiene que producir una hoja digna con
cualquiera de ellos**, sin intervención nuestra.

> **Corregido con el logo real del piloto** (2026-07-26). La versión anterior fijaba una caja de
> **40 × 14 mm**, pensada para un lockup horizontal. El logo de Las Corzuelas es **1000 × 1000 px
> (1:1)**: contenido en esa caja renderiza **14 × 14 mm**, la marca queda como una manchita y el texto
> calado "LAS CORZUELAS" dentro de la loma, ilegible. **Y el 1:1 es el caso frecuente** — los barrios
> tienen logos cuadrados o circulares, no lockups de agencia.

**Caja por LÍMITES, no por dimensiones.** Alto máximo **20 mm**, ancho máximo **45 mm**, ajuste
**`contain`**. El logo toca **uno** de los dos límites según su relación, nunca los dos:

| Relación | Renderiza | Limitado por |
|---|---|---|
| **1:1** *(el piloto, y el caso frecuente)* | **20 × 20 mm** | alto |
| 3:1 apaisado | 45 × 15 mm | ancho |
| 5:1 apaisado | 45 × 9 mm | ancho |
| 1:2 vertical | 10 × 20 mm | alto |
| Fuera de 1:2 – 5:1 | `contain` igual, con aire. **Nunca se recorta** | — |

**Por qué 20 y 45 y no otros dos números:** son **límites de área constante**. Un 1:1 ocupa
20 × 20 = 400 mm²; un 5:1 ocupa 45 × 9 = 405 mm². **Ningún formato de logo pesa más que otro en la
hoja**, que es lo que la caja fija anterior rompía.

**Verificación del texto calado** (la razón de que el alto sea 20 y no 14):

- En el logo del piloto el texto ocupa ≈8 % de la altura → a 20 mm da una altura de mayúscula de
  **≈1,6 mm**. Impreso se lee. A los 14 mm de la caja vieja daba 1,1 mm: no.
- **En el teléfono no se lee, y no hace falta.** Con el factor 0,655 de §E.5.1, 1,6 mm ≈ 3 px. Para
  llevarlo a 9 px haría falta una caja de ~60 mm de alto, que es absurdo. **Se declara explícitamente:
  en pantalla el logo identifica por silueta y color; el nombre lo lleva el texto real** (§E.9.2.bis).
  Esta es exactamente la razón por la que el nombre del barrio no puede vivir solo dentro del logo.
- **Consecuencia en el layout:** la zona 0 pasa de 22 a **28 mm** y la zona 3 baja su tope de 60 a
  **54 mm** (§E.2.2). El presupuesto total no cambia: 269 mm.

**Lo que se mantiene de la versión anterior:**

- **El logo nunca determina la altura de la cabecera.** La zona 0 mide 28 mm siempre. Es lo que evita
  que la hoja de un cliente tenga el bloque de pago 10 mm más abajo que la de otro.
- **Nunca se deforma y nunca se recorta.** `contain`, no `cover`.
- **Fondo blanco forzado dentro de la caja.** Con el piloto ni hace falta —es un JPEG sin alfa sobre
  blanco sólido— pero mata el halo de los PNG mal recortados sin tener que detectarlo.

### E.9.2.bis Qué texto acompaña al logo (y cuál no)

**Se estaban tratando como una sola cosa dos datos distintos.** La regla anterior —*"la razón social va
siempre en texto aunque el logo la incluya"*— aplicada al piloto haría que "LAS CORZUELAS" apareciera
dos veces arriba: calado dentro del logo y otra vez en grande al lado. Ruido.

| Dato | Qué es | Cómo va |
|---|---|---|
| **Nombre comercial del barrio** *("Las Corzuelas")* | Lo que el vecino reconoce. **El logo ya lo dice** | **En texto real, pero en 12 pt — no en grande.** No compite con el logo en papel, y resuelve la ilegibilidad en teléfono, la búsqueda de texto en el PDF y la ausencia de texto alternativo (§E.8) |
| **Razón social del emisor** *("Administración Las Corzuelas S.A.")* | **Dato legal obligatorio.** No es marca | **8 pt**, precedida de "Administra:", debajo del nombre del barrio. Con CUIT y domicilio |

Que en el piloto las dos digan casi lo mismo es una coincidencia de este barrio, no la regla: la
administración que gestione otro barrio va a imprimir su misma razón social bajo otro logo y otro nombre.

**Reglas de ingesta** — acá se resuelve el problema de verdad, no en el render:

| Regla | Valor | Comportamiento |
|---|---|---|
| Formatos | SVG (preferido) · PNG con transparencia · JPG | Se **normaliza a PNG** en la ingesta: el motor tiene soporte limitado de SVG (doc 07 §A) |
| Lado largo mínimo | **300 px** (≈380 dpi en una caja 1:1 de 20 mm; ≈170 dpi en un 5:1 de 45 mm) | Por debajo se **rechaza** con el motivo en criollo |
| Lado largo recomendado | **≥ 900 px** | Entre 300 y 900 se **acepta con aviso**, no se bloquea. *(El piloto: 1000 px → ≈1270 dpi. Sobra)* |
| Normalización | PNG, lado largo **`min(1200, original)`** | **Nunca se escala hacia arriba**: agrandar un JPEG de 1000 px a 1200 solo amplifica los artefactos alrededor del texto calado, que es justo el detalle fino que hay que conservar |
| Peso tras normalizar | **≤ 500 KB** | 300 boletas × un logo de 4 MB es un problema de entrega real |
| Ratio | Entre **1:1 y 5:1** | Fuera de rango se acepta, se hace `contain` y queda con aire. **Nunca se recorta** |

**La pieza que hace que esto funcione no es la validación: es la previsualización.** La pantalla de
configuración muestra el logo **a tamaño real de impresión** (40 × 14 mm en pantalla, no un thumbnail
de 200 px) y **en escala de grises**, junto a una miniatura de la zona 0 completa. El cliente ve el
problema antes que el vecino. Un logo borroso rechazado por un mensaje se discute; un logo borroso que
el cliente **ve borroso** se cambia solo.

**Sin logo: es el caso por defecto, no la excepción.** Va a ser la mitad de los clientes chicos. La
caja se rellena con un **logotipo tipográfico** compuesto: la razón social en `font.sans` `semibold`
14 pt sobre el color del cliente, con la franja superior de 4 mm haciendo de marca. **Se ve
deliberado, no roto** — que es la única diferencia que importa entre "sin logo" y "logo faltante".

```
  CON LOGO (el piloto)                    SIN LOGO (default)
  ┌────────────┐                          ┌────────────────────┐
  │            │                          │                    │
  │  [ LOGO ]  │  Las Corzuelas   (12 pt) │   LAS CORZUELAS    │ ← nombre del BARRIO,
  │  20×20 mm  │                          │                    │   14 pt semibold, blanco
  │            │  Administra: Adm. Las    │  (sobre el color   │   sobre el color del barrio
  └────────────┘  Corzuelas S.A. · CUIT   │   del barrio)      │
                  30-XXXXXXXX-X   (8 pt)  └────────────────────┘
                                           Administra: Adm. Las Corzuelas S.A. ·
                                           CUIT 30-XXXXXXXX-X          (8 pt)
```

### E.9.3 El color de acento — quién manda y qué pasa si el cliente elige mal

**Manda el color del BARRIO.** Corrige la versión anterior de esta sección, que decía "manda el de la
administración": con el modelo de dos niveles (§E.9.0), el acento es parte de la identidad que el vecino
reconoce, y esa es la del barrio. Cadena de resolución, en orden:

```
color del barrio  →  color de la administración (default heredado)  →  gris neutro (borderStrong)
```

**Nunca cae a la marca del producto (el teal).** Un barrio sin color declarado sale con una franja gris
neutra, no con la nuestra — §E.12.13.

El acento **derivado del `id`** de `barrio-accent.ts` no se imprime: existe para que el administrador no
liquide el barrio equivocado (doc 06 §b.5), y el vecino tiene un solo barrio.

**Dónde se usa el acento en el papel** — dos lugares, y ninguno más:

| Uso | Requisito de contraste |
|---|---|
| Franja superior de 4 mm | ≥ **3:1** contra el papel blanco (si no, se lee como un error de impresión) |
| Fondo del logotipo tipográfico, con el nombre en **blanco** encima (caso "sin logo") | ≥ **4,5:1**, por ser texto |

**Un solo umbral cubre los dos:** como el contraste es simétrico, exigir **≥ 4,5:1 contra blanco**
garantiza a la vez la franja y el texto blanco encima.

**Verificación de `#772B30` (el piloto):**

| Par | Ratio | Veredicto |
|---|---|---|
| `#772B30` sobre papel blanco (franja) | **9,66:1** | ✅ AAA — pasa holgado, **sin degradación** |
| Texto **blanco** sobre `#772B30` | **9,66:1** | ✅ AAA |
| Texto **oscuro** (`textPrimary`) sobre `#772B30` | **2,17:1** | ❌ **falla** |

⇒ **Regla dura: el texto que va encima del acento es SIEMPRE blanco** (`textInverse`), nunca oscuro.
No es configurable. Con un acento normalizado a ≥4,5:1 contra blanco, el blanco encima siempre funciona
y el oscuro puede fallar — así que no se ofrece la opción.

**Regla de degradación** *(porque el color lo elige el cliente y va a elegir mal)*:

1. Se calcula el contraste del color declarado contra blanco.
2. **Si es ≥ 4,5:1 → se usa tal cual.** El piloto entra por acá: `#772B30` se imprime exactamente como
   lo mandaron. Es su marca; no se toca sin necesidad.
3. **Si es < 4,5:1 → se conservan H y S y se baja la luminosidad** hasta alcanzar 4,5:1 exactos. Un
   `#FFFF00` (1,07:1 contra blanco, invisible en la franja) sale como un ocre oscuro del mismo matiz.
   **El cliente elige el matiz; la legibilidad la fija el sistema.**
4. **Se le muestra el antes/después en la pantalla de configuración**, con el motivo en criollo: *"Tu
   color no se distingue del papel blanco. Lo oscurecimos para que la franja se vea impresa."* Un ajuste
   silencioso genera un ticket; uno explicado, no.
5. **No se rechaza ningún color.** Rechazar la marca de un cliente es una conversación que no se gana.

**Para la franja se levanta la restricción de banda** (230°–335°) que rige en la UI: ahí la banda existe
para no chocar con los colores semánticos, y en la franja superior del papel **no hay ningún semántico
adyacente**. El piloto lo confirma — `#772B30` es un bordó, matiz ≈355°, en pleno rango "prohibido" en
pantalla, y en la franja no molesta a nada. **Pero el color no se propaga a ningún otro elemento de la
hoja**: ni a las bandas de estado, ni a los filetes, ni a los totales, ni —jamás— a la zona del
instrumento.

### E.9.4 Textos del cliente

- **Contacto** (casilla, teléfono, horarios, domicilio): campos tipados, van al frente (zona 4 de notas,
  una línea) y completos al dorso.
- **Bloque de texto libre de la administración:** existe, **solo en el dorso**, con **tope de 400
  caracteres** y sin formato rico. Es la válvula de escape para "avisamos que el 15 corta el agua".
- **Pasa por el filtro de lenguaje prohibido de doc 07 §E** antes de imprimirse, igual que los textos
  del sistema. Un cliente escribiendo *"bajo apercibimiento de acciones legales"* en el pie de la boleta
  es exactamente el riesgo que ese filtro existe para evitar — y es más probable que lo escriba el
  cliente que nosotros. **Si el texto no pasa, no se emite y el administrador ve por qué.**
- **Las leyendas legales del sistema no se editan ni se sacan.** Son del producto, nivel 3.

---

## E.10. La zona de pago — una zona con variantes, no un bloque fijo

Las Corzuelas cobra por una red de cobranza con código de barras. **Eso es una variante, no el caso
general.** Otra administración debita automáticamente, otra cobra solo por transferencia, otra por
billetera con QR. El diseño no puede asumir que ese bloque existe, ni que mide 73 mm.

### E.10.1 Las seis variantes

| Var. | Cómo cobra | Alto | Qué trae | Troquel |
|---|---|---|---|---|
| **P1** | Red de cobranza con código de barras *(Las Corzuelas)* | **73 mm** | Barcode · código LINK/PMC · convenio · vto + tope con importes · logos de redes · talón | **Sí** |
| **P2** | Pago electrónico sin barcode (solo código LINK/PMC) | **34 mm** | Código de pago en `font.mono` grande · vto + tope · logos | No |
| **P3** | Transferencia (CBU / alias) | **28 mm** | CBU · alias · titular · CUIT · **"poné el N.º de comprobante en la referencia"** | No |
| **P4** | Billetera / QR de pago interoperable | **40 mm** | **QR de pago** (§E.3.3) 25 × 25 mm mínimo + quiet zone 4 mm · alias · importe · vencimiento | No |
| **P5** | Débito automático | **20 mm** | **No es un cupón: es un aviso.** "No hace falta que hagas nada: se debita de tu cuenta •••4471 el 10/08/2026" | No |
| **P0** | **Sin medio configurado** | — | **La emisión se bloquea.** No se imprime una boleta impagable | — |
| **P-DEMO** | **Muestra comercial** — no es una forma de cobrar | **73 mm** | Barcode **real y escaneable sobre un número inválido** · CBU/alias con dígito verificador roto · QR de pago inerte. Tiene la **forma** de P1 + P3 + P4 juntas, y **no puede mover un peso**. Ver §E.15.4 | Sí |

**P0 es una decisión, no un hueco.** Mismo criterio que el bloqueo por fideicomiso (doc 07 §E): el
sistema no emite un documento que no sirve para lo único que tiene que servir. El administrador ve
*"Este barrio no tiene medio de pago configurado. Configuralo antes de emitir → [Medios de pago]"*.

**Combinables, con una sola principal.** Un barrio puede tener P1 **y** P3 (cupón y además
transferencia). Regla: **la variante con instrumento físico ancla al pie y es la única que ocupa la
zona**; las secundarias van como una línea en la zona 4 de notas y completas en el bloque 5 del dorso.
**Nunca dos cupones en la misma hoja** — el vecino paga dos veces o no paga ninguna.

### E.10.2 Cómo se comporta la hoja según el tamaño de la zona

**Regla de anclaje: el instrumento se pega al borde inferior, siempre.** Nunca se centra, nunca se
estira, nunca flota. Motivo concreto: el troquel tiene que estar a una distancia predecible del borde
para cortarlo con tijera, y el talón tiene que ser **el pedazo de abajo**. Un bloque que flota al medio
se corta distinto en cada boleta.

**Regla de absorción: el espacio que libera una zona de pago chica NO se reparte estirando todo.**
Estirar es exactamente lo que hace que una plantilla se vea rota. El sobrante se consume en un orden
fijo y determinista:

```
espacio libre = 73 mm (referencia P1) − alto de la variante activa

paso 1  El detalle (zona 3) sube su tope de 54 mm hasta 95 mm y agrupa menos:
        muestra más conceptos en vez de consolidarlos.
paso 2  Si TODAVÍA sobra ≥ 35 mm, se PROMUEVEN bloques del dorso al frente,
        en este orden fijo:
            3 · la bonificación   →   2 · por qué cambió
          → 4 · saldo anterior    →   5 · medios de pago
paso 3  Si se promovieron TODOS y el dorso queda solo con leyendas y contacto,
        el DORSO SE ELIMINA: las leyendas van al pie del frente.
        → El documento se colapsa de dos páginas a UNA.
paso 4  Si aún sobra, sobra. Queda aire al pie, arriba del instrumento.
        NO se estira nada.
```

Esto tiene una consecuencia buena que vale la pena nombrar: **la administración que debita
automáticamente (P5) recibe una boleta de una sola página, más explicada que la de P1** — porque el
lugar que no gasta en el cupón lo gasta en decirle al vecino de dónde sale el número. Es el resultado
correcto, y sale del mecanismo, no de una plantilla aparte.

En el sentido inverso ya estaba resuelto: si P1 + un detalle largo no entran, el detalle desborda al
dorso con el marcador `(1) sigue al dorso`.

### E.10.3 La zona 1 también cambia con la variante

La tercera celda del titular (*"DÓNDE PAGÁS"*) es texto derivado, nunca hardcodeado. Y en P5 cambia la
tríada entera, porque la pregunta del vecino es otra:

| Var. | Celda 1 | Celda 2 | Celda 3 |
|---|---|---|---|
| P1 | TOTAL A PAGAR | VENCE EL | **DÓNDE PAGÁS** — Rapipago · Pago Fácil · LINK · PMC → con el código del pie |
| P2 | TOTAL A PAGAR | VENCE EL | **DÓNDE PAGÁS** — LINK · Pago Mis Cuentas → con el código del pie |
| P3 | TOTAL A PAGAR | VENCE EL | **CÓMO PAGÁS** — transferencia al alias del pie, con el N.º de comprobante en la referencia |
| P4 | TOTAL A PAGAR | VENCE EL | **CÓMO PAGÁS** — escaneá el QR del pie desde tu billetera |
| **P5** | **TOTAL A DEBITAR** | **SE DEBITA EL** | **NO HACE FALTA HACER NADA** — se debita de tu cuenta •••4471 |

En P5 el vencimiento sigue siendo un dato, pero deja de ser una acción: por eso la banda de estado de
la zona 1 agrega, en ese caso, *"Si la cuenta no tiene fondos ese día, el débito se rechaza y el saldo
pasa a la boleta siguiente"* — que es la única cosa que un vecino con débito automático necesita saber
y hoy nadie le dice.

### E.10.4 Lo que la variante NO cambia

El resto de este documento **vale idéntico para las seis**: las zonas 0 a 3, la jerarquía tipográfica
(§E.5), las bandas de estado y los cinco casos (§E.4), la accesibilidad (§E.8), el white-label (§E.9),
la regla de "una sola fuente para el importe repetido" (§E.6) y la prohibición de personalizar la
estructura (§E.9.1 nivel 3). **Una plantilla, seis pies.**

Y la regla de exclusión de §E.6 se aplica al rectángulo de la variante activa: en P4 la quiet zone es
la del QR (4 mm y **mínimo 25 × 25 mm**, o un teléfono no lo lee desde papel impreso en láser); en P3 y
P5 no hay código que proteger, pero **el bloque sigue siendo negro puro sobre blanco puro** — un CBU
tiene 22 dígitos que alguien va a tipear a mano desde el papel.

---

## E.11. Datos que este diseño necesita y el sistema HOY NO GUARDA

Ordenados por bloqueo. **Nada de esto se resuelve con diseño**: o existe el dato, o el renglón no se
imprime.

### Bloquean el frente (sin ellos no hay boleta que se pueda pagar)

| # | Dato | Estado hoy | Consecuencia |
|---|---|---|---|
| 1 | **Fecha tope de la red de cobranza** | No existe. `periodo_expensa` tiene `primer_vencimiento` y `segundo_vencimiento`; §B.6 ya estableció que la fecha tope **no es** el segundo vencimiento | Sin campo propio, la zona 4 no se puede imprimir como es hoy, o se imprime una fecha que significa otra cosa |
| 2 | **Código de barras** (≈58 dígitos) y **código LINK / Pago Mis Cuentas** | Ningún campo | Es el instrumento. Sin esto el PDF es informativo, no pagable |
| 3 | **Convenio del barrio con el ente recaudador** (número de cuenta corriente, red, logos) | No existe. `medio_pago_barrio` (0008) cubre "dónde pago", no el convenio de cobranza | Sin él no se arma ni el código ni la cabecera del cupón |
| 4 | **Número de boleta con serie y correlativo** | `liquidacion.numero_comprobante` es `text` **nullable**, sin serie ni formato. Doc 08 §O ya pide `serie_comprobante` con prefijo de numeración | El correlativo suele ser parte del código de barras. Y §D deja abierto **quién lo asigna** (¿el sistema contra el convenio, o el banco?) — **es la pregunta que define si emitimos el instrumento o solo lo imprimimos** |

### Bloquean el diferencial del rediseño

| # | Dato | Estado hoy | Consecuencia |
|---|---|---|---|
| 5 | **Renglón informativo de bonificación NO aplicada** (importe que se perdió + motivo + fecha de corte) | **No existe y no puede ser un `item_liquidacion`** — violaría el check de signo y la biyección de doc 08 §L. Declarado como faltante en §AA | **Mata el Caso B entero**, que es el que hace funcionar el incentivo de §N.bis. Es la pieza más valiosa del rediseño y la que no tiene dónde guardarse |
| 6 | **`origen_evaluacion` del cumplidor** (`carga_manual` / `override_administrador` / `cuenta_corriente`) | Decidido en §AA, sin columna | El dorso no puede decir de dónde salió la evaluación — y **no puede decir "el sistema verificó"** mientras no exista el módulo de cobros |
| 7 | **Desglose del saldo anterior por período** | `liquidacion.saldo_anterior` es un solo número + `saldo_anterior_origen`. El desglose vive en el módulo de cobros, que no existe | El bloque 4 del dorso imprime el total y el origen, pero **no la tabla período por período**. Se declara así, no se simula |
| 8 | **Delta contra el período anterior** | Derivable de la `liquidacion` del período previo **si se liquidó en este sistema**; no existe para el primer período ni para datos migrados | El bloque 2 del dorso dice "primer período liquidado en este sistema". **No se compara contra un número traído del sistema viejo** |
| 9 | **Rol del destinatario (propietario / inquilino) y qué le corresponde a cada uno** | `liquidacion.obligado_id` guarda "el obligado notificado", sin rol imprimible. §C ya marca que la boleta actual dice "Inquilino / Propietario" a la vez. Doc 08 §E describe el caso real (ordinarias al inquilino, extraordinarias al propietario) | El wireframe imprime "PÉREZ, ANA — propietaria". **Ese rótulo hoy es una suposición.** Con dos destinatarios distintos por concepto, además, cambia la estructura del documento, no solo la etiqueta |
| 10 | **Cuota "1 de 2" de la extraordinaria** | El texto vive en `item_liquidacion.descripcion` (§C: *"las etiquetas cambian de mes a mes porque se escriben a mano"*). En el nuestro es snapshot del catálogo, pero el par cuota/total no está tipado | Se imprime como parte de la descripción. Aceptable en el MVP; anotado como deuda de modelo (doc 08 §O lo pide en `serie_comprobante`) |
| 11 | **Fuente de financiamiento del descuento** (modo a/b/c de doc 08 §N) | Decidido (modo **a**), sin columna verificada en el esquema | §N dice *"va impreso: esconderlo dentro de gastos generales es un descubrimiento de asamblea muy caro"*. Si la partida existe como gasto, sale sola en la zona 3; **hay que confirmar que así se carga** |

### Bloquean el white-label y las variantes de pago (§E.9 y §E.10)

| # | Dato | Estado hoy | Consecuencia |
|---|---|---|---|
| 12 | **Marca del BARRIO**: logo, nombre comercial, color de acento | **No existe nada.** `barrio` tiene los 5 ejes jurídicos, jurisdicción, municipio y `denominacion_concepto` — **ni un campo de marca**. El nombre vive en `tenant_node.nombre` | **Es el nivel que va arriba y grande** (§E.9.0). Sin esto la cabecera no se arma para ningún barrio |
| 12.bis | **Datos del EMISOR**: razón social, CUIT, domicilio, casilla, teléfono, horarios, logo secundario, color por default | **No existe nada.** `tenant_node` con `tipo='administrador'` es la entidad correcta, pero **su única columna descriptiva es `nombre`** | Decisión de modelo del `arquitecto-software`: ¿columnas en `tenant_node` y en `barrio`, o **una tabla `marca` polimórfica** que sirva a los dos niveles? Lo segundo evita duplicar las reglas de logo y de color en dos lados. Va con storage para el logo, con las claves opacas de doc 07 §F |
| 13 | **Variante de pago del barrio** (P1–P5) y sus datos imprimibles | `medio_pago_barrio` (0008) modela **dónde transferir** (`cbu` · `alias` · `cuenta` · `efectivo` · `otro`) — es exactamente la variante **P3**. **No modela** cupón con barcode (P1), código electrónico (P2), QR de pago (P4) ni débito automático (P5) | Sin esto no hay forma de elegir la variante ni de bloquear P0. El enum de `medio_pago_tipo_chk` **se queda corto**; ampliarlo es una migración, y hay que decidir si la variante es un tipo más o un campo aparte (`variante_instrumento`) — porque un barrio puede tener P1 **y** P3 a la vez, y solo uno ancla al pie (§E.10.1) |
| 14 | **Convenio de cobranza** (ente recaudador, número de convenio, red, logos de redes) | No existe — es el ítem 3 de arriba, y es lo que distingue P1/P2 de P3 | — |
| 15 | **Mandato de débito automático** (P5): CBU adherido, últimos 4 dígitos imprimibles, fecha de débito, estado de la adhesión | No existe | P5 no se puede imprimir. Y ojo con la PII: **solo los últimos 4 dígitos van al papel**, nunca el CBU completo del vecino (doc 07 §F: del PDF sale el mínimo) |
| 16 | **Bloque de texto libre de la administración** (§E.9.4) con su tope y su paso por el filtro de lenguaje | No existe | Sin el filtro aplicado al texto del cliente, doc 07 §E queda cubriendo solo los textos del sistema — que son justamente los que menos riesgo tienen |

### Existen hoy y el diseño los usa

Para que quede claro qué parte del rediseño **no depende de nada nuevo**: `periodo_expensa.total_gastos`
(la línea "el barrio gastó $X") · `liquidacion.coeficiente_aplicado` (9 decimales, se muestran 4) ·
`subtotal_ordinarias` / `subtotal_extraordinarias` / `subtotal_fondo_reserva` / `subtotal_cargos` /
`subtotal_descuentos` (**el bruto, el descuento y el neto que §N.bis exige imprimir salen enteros de
acá**) · `saldo_anterior` + `saldo_anterior_origen` · `interes_mora` + `tasa_mora_aplicada` +
`dias_atraso` + `fecha_corte_mora` (la línea completa del interés) · `mora_pendiente_definicion` (el
Caso E) · `item_liquidacion.base_monto` + `coeficiente_aplicado` + `monto_teorico` + `ajuste_redondeo`
(la tabla de detalle y la nota `(3)`) · `acta_titulo` (la nota `(1)`) ·
`periodo_expensa.denominacion_concepto` (que la hoja diga "expensa" o "cuota social" según la figura).

**Las zonas 0, 1 (parcial), 2 y 3 se pueden construir hoy.** Lo que falta es el instrumento (ítems 1–4)
y el renglón que cambia la conducta (ítem 5).

---

## E.12. Lo que NO haría, y por qué

1. **No pondría un QR con URL firmada.** Doc 07 §F lo prohíbe (*"nunca URLs o tokens adentro del
   documento"*) y el PDF de expensas es el archivo más reenviado del barrio. Con TTL de 10 min,
   además, estaría muerto para casi todos. Ver §E.3.2.

2. **No haría un gráfico de torta de los gastos.** Es la tentación número uno cuando alguien pide
   "más moderno". Motivos: a 30 mm con 7 conceptos es ilegible; **codifica información por color**, que
   viola doc 06 §f.2 y muere en la fotocopia; **no es verificable con calculadora**, que es
   exactamente lo que la tabla de tres columnas sí permite; y ocupa el espacio de la zona 3, que es la
   única elástica. Si el barrio quiere una torta, va en el **reporte mensual**, que ya viaja en el
   mismo email y tiene página entera y audiencia adecuada.

3. **No pintaría la bonificación de verde ni la deuda de rojo como única señal.** Verde es "al día" y
   rojo es `danger`/mora en los tokens del producto; reusarlos como decoración de renglón rompe la
   regla 6 del doc 06 (*"el color de estado no se reutiliza para decoración"*). El renglón va en tinta
   normal con signo y palabra; el color vive **solo** en la banda de estado, y siempre acompañado de
   ícono y texto.

4. **No haría dos plantillas** (una "al día", otra "con deuda"). Divergen en el primer cambio y el bug
   aparece siempre en la que menos se mira — que es justo la del que debe. Una plantilla, bloques de
   altura fija, bandas apilables.

5. **No haría la hoja "sin bordes, todo aire, estilo fintech".** Es un instrumento que se fotocopia,
   se corta con tijera y se presenta en una caja. Necesita filetes, troquel visible y zonas delimitadas.
   El aire va en la zona 1, donde el lector es una persona; la estructura va abajo, donde el lector es
   una máquina.

6. **No metería el desglose gasto por gasto ni en el frente ni en el dorso.** Doc 07 §C.2 ya lo decidió
   para el frente y el argumento vale igual para el dorso: 40 líneas de $890 multiplican las preguntas
   en vez de responderlas, y el desglose ya viaja **en el mismo email** en el reporte del barrio. La
   traza se conserva: concepto + gasto del período + coeficiente + período.

7. **No usaría el acento del barrio como color de la hoja.** Franja de 4 mm arriba y nada más
   (doc 06 §b.5). Un documento de pago teñido de magenta porque así salió el hash del `id` es
   exactamente lo que §b.5 acota.

8. **No imprimiría la clasificación fiscal** (alcanzado/no alcanzado IIBB). Doc 07 §C.1: su audiencia
   es el contador. Lo que sí va, y es obligatorio, es la clasificación del art. 2048 —
   **ordinaria / extraordinaria / fondo de reserva** — que está en la columna "Tipo".

9. **No convertiría la fecha tope en un "segundo vencimiento con recargo".** §B.6 ya estableció que no
   lo es, y doc 08 §J fija que el pronto pago se modela como **descuento condicional**, nunca como
   recargo. Imprimir dos importes distintos sin que exista el descuento condicional en el modelo sería
   inventar un punitorio en la plantilla.

10. **No declararía AA sobre el PDF.** Sería una afirmación falsa. El camino accesible es el HTML, y
    hoy eso significa el resumen en el cuerpo del email.

11. **No agregaría datos personales "por las dudas"** (DNI, CUIT del propietario, teléfono, domicilio).
    Doc 07 §F: del PDF salen solo nombre del obligado y unidad. Nunca datos de otra unidad, nunca un
    ranking, nunca el motivo de la bonificación de un tercero (doc 08 §Y: el **motivo** —"jubilado",
    "eximición social"— es dato sensible y es el combustible de conflicto más eficiente que existe en
    un barrio).

12. **No pondría la marca de agua de "VISTA PREVIA" sobre la zona 4.** Una vista previa impresa por
    error con el código de barras tachado es un vecino que no puede pagar. La marca de agua se recorta
    en el troquel.

13. **No pondría nuestra marca en la boleta.** Ni logo, ni "generado con", ni un pie de página. La hoja
    es de la administración frente a su vecino; meternos ahí es meternos en una relación comercial que
    no es la nuestra, y es lo primero que un cliente pide sacar. Si algún día hay un plan gratuito con
    marca, se decide como política comercial, no como default de diseño.

14. **No dejaría que el logo del cliente defina la altura de la cabecera.** Es la forma más rápida de
    que la hoja de un cliente tenga el troquel 10 mm más abajo que la de otro. Caja fija, `contain`,
    y el logo se adapta a la hoja (§E.9.2).

15. **No estiraría el contenido para llenar la hoja cuando la zona de pago es chica.** Estirar es
    exactamente lo que hace que una plantilla se vea rota. Se promueven bloques del dorso en un orden
    fijo y, si sobra, sobra: queda aire arriba del instrumento (§E.10.2).

16. **No armaría una plantilla por variante de pago ni por cliente.** Es el mismo argumento del punto 4,
    multiplicado por la cantidad de clientes: seis plantillas divergen seis veces más rápido que dos, y
    el bug aparece en la del cliente que menos mirás — que es siempre el que más grita. **Una plantilla,
    seis pies** (§E.10.4).

---

## E.13. Qué refina del doc 07 (y qué no toca)

| Doc 07 §B decía | Acá | Por qué |
|---|---|---|
| "El cupón va arriba, antes del detalle" | **Se separa en dos**: el *resumen* de pago va arriba (zona 1, para el humano) y el *instrumento* al pie (zona 4, para la caja) | El doc 07 describía el PDF de liquidación genérico; la boleta real de §A tiene un instrumento físico con troquel que **tiene** que ir al pie. La intención del doc 07 (*"quien abre el PDF quiere saber cuánto y hasta cuándo"*) se cumple igual, y mejor |
| Piso duro de 7 pt | **8 pt en el frente**, 7 pt solo en el pie legal del dorso | El escenario real es un teléfono con la hoja ajustada al ancho (§E.5.1) |
| Tabla de detalle de 5 columnas en 182 mm | **Sin cambios**, se adopta tal cual | Ya estaba bien resuelto |
| "Dos totales, nunca uno" | **Sin cambios**, se adopta | Idem |
| "Nunca se omite, aunque valga cero" | **Sin cambios**, y se le agrega el mecanismo de bandas para que la jerarquía sí cambie por caso | El renglón en cero mantiene la estructura; la banda comunica el estado |
| Scheme `print` derivado de `light` | Se le agregan `fontSizePrint`, `printFitWidthFactor`, `printMinLegibleZona1`, `print.instrumentoInk` y la prohibición de `textMuted` | Regla doc 06 §g.2: primero el token, después el uso |
| PDF sin etiquetar, no se declara AA | **Sin cambios**, se ratifica | — |

**No toca nada de:** doc 07 §A (motor y sus condiciones), §C (alcance del contenido), §D (respaldo de
la extraordinaria), §E (lenguaje prohibido), §F (seguridad, claves de storage, un destinatario por
mail). Ni doc 08 en ninguna de sus decisiones de modelo.

---

## E.14. Lo que hay que confirmar antes de construir

1. **¿Quién asigna el número de boleta y quién arma el código de barras?** Ya estaba abierto en §D.
   **Es el bloqueo número uno** para la variante P1: define si emitimos el instrumento o solo lo
   imprimimos, y de eso dependen los ítems 1–4 de §E.11. *(No bloquea a P3/P4/P5, que se pueden
   construir antes.)*
2. **Simbología y módulo reales del código de barras.** El cálculo de ≈139 mm de §E.6 es una
   estimación. Si el módulo real es mayor, el código no entra en 182 mm y hay que revisar la zona 4
   **antes** de fijar el presupuesto vertical.
3. **¿La fecha tope es fija por período o la devuelve el ente recaudador por boleta?** Cambia si el
   campo va en `periodo_expensa` o en `liquidacion` (doc 08 §O ya bajó los vencimientos a
   `liquidacion`).
4. **Rol imprimible del destinatario.** ¿Se imprime "propietaria" / "inquilino"? Si el barrio manda
   ordinarias al inquilino y extraordinarias al propietario (doc 08 §E), eso **no es un rótulo: son dos
   documentos**, y hay que decidirlo antes del layout.
5. **El renglón de bonificación no aplicada (§E.11 ítem 5).** Necesita una decisión de modelo del
   `arquitecto-software`: **no puede ser un `item_liquidacion`**. Sin esa pieza, el Caso B se cae y con
   él el mecanismo de incentivo de doc 08 §N.bis.
6. **Consulta a `legal-ph`:** ¿la leyenda del frente *"El pago de la presente no libera de obligaciones
   de períodos anteriores"* sobrevive al filtro de doc 07 §E? Se redactó en positivo y se evitó
   "deudas", pero es una leyenda que se imprime en todas las boletas y merece revisión con fuente.
7. **Consulta a `administrador-consorcios`:** validar el orden de las zonas con una boleta real en la
   mano y un vecino real del otro lado. En particular, si la fecha tope subordinada (§E.6) genera
   consultas nuevas — es el cambio de jerarquía más discutible de la propuesta.

8. **Consulta a `arquitecto-software` — dónde vive la marca de la administración.** `tenant_node` solo
   tiene `nombre` (§E.11 ítem 12). ¿Columnas ahí, o una tabla `administracion_marca`? Con el detalle de
   que la boleta la firma **el administrador con mandato vigente al momento de emitir**
   (`mandato_administracion`, que ya se versiona con `desde`/`hasta`): si un barrio cambia de
   administración, **las boletas ya emitidas tienen que seguir mostrando la marca de quien las emitió**.
   Eso es un snapshot en `liquidacion`, no un `join` al vigente — mismo criterio que
   `denominacion_concepto` y que el resto de los snapshots del período.

9. **Consulta a `product-owner` — el corte del MVP entre variantes.** P3 (transferencia) se puede
   construir **hoy**: `medio_pago_barrio` ya la modela y no depende de ningún convenio bancario. P1
   depende del punto 1 de esta lista, que es una conversación con un banco. **Sugerencia de orden: P3 →
   P1 → P5 → P4 → P2.** P3 primero desbloquea la demo con cualquier administración prospecto sin
   integrar nada, que es lo que un producto que se vende necesita antes que la boleta perfecta del
   piloto.

10. **Consulta a `security-engineer`:** el logo del cliente es **un archivo subido por un usuario que se
    embebe en un documento generado**. Aunque el motor elegido no ejecuta contenido (a diferencia de
    Chromium — doc 07 §A), la ingesta necesita su revisión: validación real de formato (no por
    extensión), normalización que descarte metadatos, límite de dimensiones para evitar la bomba de
    descompresión, y almacenamiento con las mismas claves opacas de doc 07 §F. Y el bloque de texto
    libre (§E.9.4) es entrada de usuario que termina impresa en un documento que sale del sistema.

---

## E.15. La muestra comercial — la boleta como pieza de venta

> **Este es el primer uso real del diseño.** Antes de que exista una línea del generador, la boleta se
> le muestra al administrador de Las Corzuelas para que diga *"sí, me interesa"*. El relevamiento
> técnico viene después. Lo que sigue especifica **qué muestra se arma y con qué reglas**, para que el
> entusiasmo no nos haga prometer datos que el sistema no tiene ni repartir una boleta que alguien
> pueda pagar por error.

### E.15.1 La prueba de los cinco segundos

Va a mirarla en un teléfono, al lado de la que emite hoy. **La diferencia tiene que ser evidente antes
de leer una palabra.** La prueba es literal: achicá las dos hojas hasta que el texto sea ilegible y
mirá las manchas.

```
      HOY (el sistema actual)              LA PROPUESTA
   ┌────────────────────────┐           ┌────────────────────────┐
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │████████████████████████│ ← franja de marca
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │ ░░░░░░░░░              │
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │ ░░░░░░       ░░░░      │
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │                        │
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │  ███████████   ▓▓▓▓▓   │ ← EL TOTAL
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │  ███████████   ▓▓▓▓▓   │
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │ ← bandas de estado
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │                        │
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │ ░░░░░░░░░░░░░░  ░░░░░░ │
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │ ░░░░░░░░░░░░░░  ░░░░░░ │
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │                        │
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │ ·············· ······· │
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │ ·············· ······· │
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │ ← troquel
   │▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│           │ ██  ▐▌▐▐▌▌▐▌▐▐▌▌▐▌▐▐▌  │
   └────────────────────────┘           └────────────────────────┘
    una sola mancha uniforme.            cuatro pesos distintos y
    Nada dice "mirá acá".                una sola cosa que grita.
```

**Las tres cosas que producen ese contraste, en orden de impacto:**

1. **Un único elemento enorme.** El total en 32 pt contra filas de 9 pt. En la boleta de hoy el importe
   final tiene el mismo cuerpo que "Alquiler - Cancha Padel".
2. **Blanco.** El aire de las zonas 1 y 2 es lo que hace que la mancha del total exista. Sin blanco
   alrededor, un número grande es solo un número grande.
3. **Color con función, en dos lugares.** La franja de marca arriba y las bandas de estado. Nada más.
   El color escaso es lo que se lee como deliberado; el color repartido, como plantilla de Word.

> **Esto NO reabre §E.12.** La tentación ahora es agregar decoración "porque hay que vender". Al revés:
> mirá el thumbnail de arriba — **un gráfico de torta a ese tamaño es una mancha gris más**, y compite
> con el total. Lo que lee como moderno a un metro de distancia es **jerarquía y blanco**, no ornamento.
> Toda la lista de §E.12 se mantiene, y la muestra es la mejor prueba de que alcanza.

**Criterio de aceptación de la muestra:** abrirla en un teléfono, mirarla 5 segundos y taparla. Si la
persona puede decir **cuánto y cuándo** de memoria, la muestra funciona. Si no, no se muestra.

### E.15.2 La muestra son tres hojas, no una

La consigna pide enseñar la bonificación **aplicada** y el renglón de la bonificación **no aplicada**.
**No pueden convivir en la misma boleta**: son estados excluyentes de la misma unidad. Y ahí hay una
oportunidad, no un problema.

> **Una boleta linda vende una plantilla. Tres boletas de la misma plantilla venden un sistema.**

| Hoja | Unidad | Qué demuestra | Rol en la venta |
|---|---|---|---|
| **1 · La rica** | Mza 99 · Lote 07 | Al día · bonificación aplicada · cargo de pádel con fecha · extraordinaria 1/2 con su acta · delta contra el mes anterior | **El héroe.** Es la que se manda por WhatsApp si solo se puede mostrar una |
| **2 · El hallazgo** | Mza 99 · Lote 03 | Al día pero **sin** bonificación: el renglón en $0,00 con motivo y fecha de corte | *"Hoy este vecino cree que le aumentaron. Este renglón es la diferencia entre un llamado y ninguno."* |
| **3 · La difícil** | Mza 99 · Lote 22 | Saldo anterior desglosado por período · interés con base, tasa, días y fecha de corte · bonificación perdida | *"La misma hoja, sin romperse, y sin llamarlo moroso."* |

Las tres se muestran juntas, en abanico. El argumento se dice solo: **misma plantilla, mismo lugar del
cupón, tres situaciones distintas**. Eso es lo que un administrador que emite 300 boletas por mes
necesita ver, y es exactamente lo que §E.4 diseñó.

### E.15.3 Hoja 1 — el caso rico, número por número

Todo cuadra; se puede verificar con calculadora delante del cliente, que es medio punto de la venta.

**Período 07/2026 · gasto total del barrio $18.900.000,00 · coeficiente de la unidad 1,9074 %**

```
  ZONA 3 · DETALLE
  CONCEPTO              TIPO         GASTO DEL PERÍODO    COEF.       IMPORTE
  ────────────────────────────────────────────────────────────────────────────
  Vigilancia            Ordinaria         8.100.000,00   1,9074 %   154.499,40
  Espacios verdes       Ordinaria         3.400.000,00   1,9074 %    64.851,60
  Administración        Ordinaria         2.200.000,00   1,9074 %    41.962,80
  Energía y alumbrado   Ordinaria         1.900.000,00   1,9074 %    36.240,60
  Mantenimiento         Ordinaria         1.500.000,00   1,9074 %    28.611,00
  Aporte fondo reserva  Fondo res.        1.800.000,00   1,9074 %    34.333,20
  Portal de acceso (1)  Extraordin.         445.600,00   1,9074 %     8.499,52
  ────────────────────────────────────────────────────────────────────────────
                                         18.900.000,00 = el gasto del barrio, entero

  ZONA 2 · COMPOSICIÓN
  Expensa ordinaria 07/2026 ............................ $  326.165,40
  Aporte al fondo de reserva ........................... $   34.333,20
  Cuota extraordinaria 1/2 · Portal de acceso  (1) ..... $    8.499,52
  Alquiler cancha de pádel · sáb 12/07 · 1 turno ....... $   24.000,00
  Bonificación por pago en término (−)  (2) ............ $  −34.000,00
                                                        ──────────────
  TOTAL DEL PERÍODO 07/2026 ............................ $  358.998,12
  Saldo de períodos anteriores ......................... $        0,00
  Interés (base $0,00 · 3,00 % mensual · 0 días) ....... $        0,00
                                                        ══════════════
  TOTAL A PAGAR ........................................ $  358.998,12

  DORSO · POR QUÉ CAMBIÓ
  06/2026  $ 372.000,00  →  07/2026  $ 360.498,60      ▼ −3,1 %
  El gasto del barrio bajó 3,1 %. Tu coeficiente no cambió.
```

**Las cinco cosas que la muestra tiene que dejar demostradas**, y que ninguna boleta que ese
administrador haya visto hace:

1. **El gasto del barrio, entero, en la misma hoja.** La columna suma $18.900.000: el vecino ve el
   número del barrio y el suyo al lado.
2. **La cuenta se puede rehacer.** `gasto × coeficiente = importe`, en columnas, con calculadora.
3. **El cargo tiene fecha y hecho.** *"Alquiler cancha de pádel · sáb 12/07 · 1 turno"*, no "Alquiler -
   Cancha Padel" (doc 08 §K: *"la única pregunta que llega siempre es 'yo no usé el quincho el 14'"*).
4. **La extraordinaria dice de qué obra es, qué cuota es y qué acta la aprobó.** *"Portal de acceso ·
   cuota 1 de 2 · Acta de Asamblea N.º 47 del 12/05/2026"*.
5. **La bonificación dice por qué.** Y no se reclama si después no paga — está escrito en la nota `(2)`.

**Números de las otras dos hojas** (mismos gastos del barrio, coeficientes distintos):

| | Hoja 2 · Lote 03 (coef. 1,2450 %) | Hoja 3 · Lote 22 (coef. 2,3100 %) |
|---|---|---|
| Ordinarias | $ 212.895,00 | $ 395.010,00 |
| Fondo de reserva | $ 22.410,00 | $ 41.580,00 |
| Extraordinaria 1/2 | $ 5.547,72 | $ 10.293,36 |
| Bonificación | **$ 0,00 — no aplicada** (se perdieron $34.000,00) | **$ 0,00 — no aplicada** |
| **Total del período** | **$ 240.852,72** | **$ 446.883,36** |
| Saldo anterior | $ 0,00 | **$ 230.100,00** (05/26 $112.400,00 + 06/26 $117.700,00) |
| Interés | $ 0,00 | **$ 10.354,50** (base $230.100,00 · 3,00 % mensual · 45 días · al 31/07/2026) |
| **TOTAL A PAGAR** | **$ 240.852,72** | **$ 687.337,86** |

> **Conversación que la hoja 2 va a abrir, y conviene tenerla lista:** con bonificación de **monto
> fijo** ($34.000 para todos, que es como la usa hoy Las Corzuelas — §B.4), el lote chico pierde el
> 14 % de su boleta y el grande el 7 %. No es un defecto de la muestra: es la operatoria actual del
> barrio, hecha visible por primera vez. El sistema soporta monto fijo **y** porcentaje (§B.4); la
> muestra es una buena excusa para preguntar cuál quiere.

### E.15.4 P-DEMO — el bloque de pago de la muestra

**El riesgo concreto: una boleta que se ve real, con un CBU real, es una boleta que alguien paga.** La
muestra se va a reenviar por WhatsApp — al socio, al contador, a alguien del consejo. Tiene que ser
**imposible que mueva un peso**, sin que eso se note al mirarla.

**La forma es la de P1 + P3 + P4 juntas** (cupón con barcode, transferencia y QR), porque enseña las
tres capacidades de una. Es la única boleta donde conviven, y por eso P-DEMO es una variante propia y
no una configuración: **§E.10.1 prohíbe dos cupones en una hoja de producción**, y esta no lo es.

| Elemento | Cómo se arma | Por qué no puede cobrar |
|---|---|---|
| **Código de barras** | **Real y escaneable** — nítido, con su quiet zone. Si el administrador lo escanea por curiosidad, tiene que leer: eso vende | Codifica un **número de convenio inexistente** y con dígito verificador deliberadamente incorrecto. La caja lo lee y responde "convenio inexistente" |
| **Código LINK / PMC** | Formato correcto | Mismo convenio inexistente |
| **CBU** | 22 dígitos, aspecto normal | **Dígitos verificadores rotos** (posiciones 8 y 22). El home banking lo rechaza antes de pedir confirmación. Es el control más importante de los seis |
| **Alias** | `CORZUELAS.MUESTRA` | No existe y no es registrable por un tercero. El alias CBU admite hasta **20 caracteres**: se recorta por palabras enteras, nunca el sufijo |
| **QR de pago** | Payload sintácticamente válido, se escanea bien | CVU inexistente: la billetera lo lee y falla limpio |
| **Marca de muestra** | `MUESTRA SIN VALOR COMERCIAL`, 8 pt versalitas, **dentro del área de etiquetas del cupón** | Inequívoca al leer, invisible al vistazo |
| **Nombre del archivo** | `Expensas-LasCorzuelas-2026-07-Mza99-Lote07-MUESTRA.pdf` | Lo primero que se ve en WhatsApp |

**Nada de marca de agua diagonal.** Mata el efecto comercial, que es lo único que la muestra tiene que
producir. La leyenda dentro del cupón hace el trabajo sin arruinar los cinco segundos. *(Es lo inverso
del estado "VISTA PREVIA" de §E.7.4, que sí lleva marca de agua porque su función es impedir que se
confunda con un comprobante: acá la función es que se **vea** como uno, sin serlo.)*

**PII — el error que termina la reunión.** Los originales de §A son boletas **reales** de vecinos
reales y viven fuera del repositorio. La muestra:

- Usa **obligados inventados** y **`Mza 99`, fuera del rango real del padrón**. *(Los wireframes de
  §E.2.3 y §E.3.1 usan `Mza 61 · Lote 07`, que sale de la boleta real anonimizada: **eso no se puede
  reusar en la muestra**.)* Si el administrador reconoce a un vecino en la hoja que le estamos
  mostrando, se terminó la venta y empezó otra conversación.
- Usa el **logo y el color reales del barrio** (`#772B30`, verificado en §E.9.3: pasa sin degradación) y
  la **razón social, el CUIT y el domicilio reales de la administración**: es su boleta y ese es medio
  efecto — que la levante y diga "esta es la mía". Nada de eso es dato personal de un tercero.
- **No lleva ningún dato de otra unidad**, ningún listado, ningún ranking (doc 07 §F).

### E.15.5 Qué de la muestra el sistema TODAVÍA no produce

**Regla:** la muestra puede llevar el dato, pero **acá queda escrito que hoy es una constante escrita a
mano**. Sin esta tabla, alguien construye contra la muestra creyendo que el dato existe — y es lo que
convierte una demo linda en una promesa incumplida.

| En la muestra | Estado | Ref. |
|---|---|---|
| Código de barras, código LINK/PMC, convenio, logos de redes | **No existe.** Se dibuja para la muestra | §E.11 ítems 2–4 |
| Fecha tope de la red | **No existe** como campo propio | §E.11 ítem 1 |
| N.º de comprobante con serie y correlativo | Existe como texto libre nullable, **sin serie ni formato** | §E.11 ítem 4 |
| **Renglón de bonificación NO aplicada** (hojas 2 y 3) | **No existe, y no puede ser un `item_liquidacion`.** Es **el hallazgo que la muestra vende** y la pieza que menos respaldo tiene | §E.11 ítem 5 |
| Origen de la evaluación del cumplidor | **No existe.** Sin módulo de cobros, la muestra **no puede decir "el sistema verificó"** | §E.11 ítem 6 |
| Saldo anterior desglosado por período (hoja 3) | **No existe.** Hoy es un solo número | §E.11 ítem 7 |
| Delta contra el mes anterior (dorso, hoja 1) | Derivable **solo** si el período previo se liquidó en este sistema | §E.11 ítem 8 |
| Rol del destinatario ("propietaria") | **Es una suposición.** No hay rol imprimible | §E.11 ítem 9 |
| "Cuota 1 de 2" de la extraordinaria | Vive en el texto de la descripción, sin tipar | §E.11 ítem 10 |
| **Logo y color del barrio** — el logo real del piloto ya está (`_referencias/logo-las-corzuelas.jpg`, 1000×1000, `#772B30`) y la muestra lo usa | **El archivo existe; el campo donde guardarlo, no.** Ni `barrio` ni `tenant_node` tienen campos de marca | §E.11 ítems 12 y 12.bis |
| Razón social, CUIT y domicilio del emisor (8 pt) | **No existe** como dato del sistema | §E.11 ítem 12.bis |
| Interés con base, tasa, días y fecha de corte (hoja 3) | **Existe entero** | §E.11, "existen hoy" |
| Gasto del barrio, coeficiente, bruto/descuento/neto, cargos, fondo de reserva, acta | **Existen enteros** | §E.11, "existen hoy" |

**Lo tranquilizador:** las dos filas finales son el grueso de lo que la muestra enseña. Lo que falta es
el **instrumento de pago** (que depende de una conversación con un banco, no de nosotros) y **el
renglón de la bonificación perdida** (una migración chica y una decisión de modelo).

### E.15.6 Cómo se muestra — 90 segundos

Un guion corto para que la pieza no se explique sola y mal:

1. **(0–15 s) Sin decir nada**, el teléfono con la hoja 1 al lado de la boleta actual. Que hable el
   contraste. *La única pregunta:* "¿cuál preferirías recibir?".
2. **(15–45 s) Una sola idea:** *"Acá está el gasto del barrio entero, y al lado lo que le toca a esa
   unidad. Se puede rehacer con calculadora."* Es la respuesta a la pregunta por la que más lo llaman.
3. **(45–75 s) El hallazgo — la hoja 2.** *"Este vecino no tiene la bonificación este mes. Hoy el
   renglón simplemente no aparece y él cree que le aumentaron. Acá aparece en cero, con el motivo y la
   fecha, y dice cómo recuperarla."*
4. **(75–90 s) La hoja 3**, sin adjetivos: *"La misma hoja, con deuda de dos meses y el interés
   explicado. Y en ninguna parte dice 'moroso'."*

**Lo que NO se dice en la demo:** ni una promesa sobre el código de barras (§E.14 punto 1 sigue
abierto), ni una fecha de entrega, ni "esto ya funciona" sobre nada de la tabla de §E.15.5. El objetivo
de la reunión es **un sí de interés**; el relevamiento técnico es la reunión siguiente, y las preguntas
de §E.14 se hacen ahí — con la muestra ya sobre la mesa, que es el mejor momento para hacerlas.
