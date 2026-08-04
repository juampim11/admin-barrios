# Análisis del handoff de diseño "Consorcia"

> Pedido del usuario, 2026-08-03: *"validá, analizá viabilidad, mejoras, si se puede, si conviene.
> Análisis a fondo, sin modificar nada aún del desarrollo."*
>
> Material analizado: `design_handoff_consorcia/` — `README.md`, `PROMPT.md`, `business-rules.md`,
> `screens.md`, `acceptance.md`, `design-tokens.json`, `schemas.ts`, `fixtures.ts` y el prototipo HTML
> (20 pantallas). Panel: `product-owner`, `arquitecto-software`, `ux-designer`,
> `administrador-consorcios`. **No se modificó una línea de código.**

---

## 0. El veredicto, en una línea

**Es un excelente documento de producto y de interfaz, y un mal documento de modelo de datos.** Se
adopta el inventario de pantallas, las ideas de flujo y varias reglas de presentación; **no** se adopta
`schemas.ts` como modelo, ni los criterios de aceptación como tests, ni la paleta de color.

Y hay un riesgo que no es de contenido sino de forma, y es el más caro de todos: **`PROMPT.md` es un
prompt listo para pegar** que dice *"recreá esas pantallas en este repo"* y *"escribí primero los tests
de `acceptance.md`"*. Pegado tal cual —por cualquiera, en una sesión sin este contexto— **arranca un
segundo producto** dentro del mismo repositorio, con otro vocabulario, otros roles, otros estados y
otro Zod.

---

## 1. Lo que el handoff trae y hay que quedarse

Ordenado por valor, no por tamaño.

| # | Qué | Por qué vale |
|---|---|---|
| 1 | **El inventario de 16 pantallas con layout, componentes, estados y ruta** | El repo tiene 5. Esto es trabajo de producto bien hecho y **es lo más valioso del paquete**. Vale independientemente de todo lo demás. |
| 2 | **La conciliación como pantalla de trabajo (`2d`)**: tres columnas, match sugerido **con la regla aplicada explicada**, y cuatro salidas legítimas | Ataca de frente el cuello de botella que hoy le cuesta al piloto **dos meses de atraso en el informe** (doc 10 §C.1). Que la pantalla explique *por qué* propone ese match es lo que hace que un operador confíe y deje de revisar todo. |
| 3 | **El cierre masivo (`5c`) con el motivo exacto de retención** | Es, literalmente, el **checklist bloqueante** que doc 10 §C.2 pedía para convertir "esperemos por las dudas" en "faltan estas tres cosas". |
| 4 | **"¿Por qué pago esto?" — incluida la explicación de las excepciones que NO le aplican a esa unidad** | Es la regla dura #4 del proyecto ("toda cifra se explica con su origen") puesta de cara al vecino. Mata la pregunta *"¿por qué pago la pileta si no la uso?"* antes de que llegue. |
| 5 | **"A un rol no se le muestran acciones que no puede ejecutar"** (no botones deshabilitados) | Es exactamente el defecto #8 de la revisión de la tanda C, ya pagado una vez. Escribirlo como regla evita pagarlo en cada pantalla nueva. |
| 6 | **El hilo reclamo → presupuesto → comprobante → gasto → boleta** | La única historia end-to-end de trazabilidad del dinero del paquete. |
| 7 | **La simulación con el último período** en la pantalla de configuración: cambiás una regla y ves qué le hubiera pasado al mes pasado, antes de guardar | Idea excelente, no estaba en ningún documento del proyecto. |
| 8 | **El control de cuadratura en vivo**, en panel fijo, mientras se trabaja | Mejor que el rechazo al cerrar. El cálculo ya existe; falta mostrarlo. |
| 9 | **"Verificar el payload, no sólo la vista"** para el rol de sólo lectura | Categoría de test que el repo no tiene. El test de arquitectura mira imports; nada verifica qué devuelve un servicio según el rol. |
| 10 | **El comportamiento del selector según cantidad** (1 → título fijo, 2–9 → tarjetas, 10+ → buscador) | doc 06 §c.1 no contempla los casos degenerados. Cuesta cero y es mejor. |
| 11 | **Monoespaciada para identificadores**, no sólo para dinero (comprobante, CUIT, código de unidad, id de ticket) | Un identificador se compara carácter por carácter: la monoespaciada impide confundir `0/O` y `1/l/I`. doc 06 §b.2 ya lo pedía y el kit nunca lo materializó. |
| 12 | **Ausencia de sombras**: jerarquía por borde y color | El repo ya le está dando la razón sin decirlo: en toda la app hay **4 sombras**, y dos tokens de sombra no se usan nunca. |
| 13 | **`esMovimientoInterno`** y **`admiteGastoOrdinario`** como propiedades del dato | Dos reglas que se descubren tarde y acá están escritas antes de que exista el módulo. |
| 14 | **`Tenant.razonSocial` + `Tenant.cuit`** | Apunta a un hueco real y ya declarado: `FALTANTES_CONOCIDOS.marcaEmisor`. Falta una tabla `administrador` con la misma forma que `barrio`. |

**Y una que no es una feature:** el handoff **validó, sin conocerlas, cuatro de las once observaciones
del recorrido del usuario**. Su `2a` entra por resumen (A-3), su `4a` tiene la card del período en curso
con "Continuar liquidación" (A-2), su stepper es clickeable hacia atrás (A-5) y su navegación tiene
vuelta explícita (A-1). Dos diseños independientes llegando a lo mismo es la mejor evidencia
disponible de que ese cambio es el correcto.

---

## 2. Lo que hay que descartar, ordenado por lo que cuesta equivocarse

### 2.1. El modelo de pagos — **la decisión más cara del paquete**

`schemas.ts` modela `Pago { ufId, importe, ... }` **sin `liquidacionId`**, e `imputacionPagos:
'DEUDA_MAS_ANTIGUA' | 'PERIODO_INDICADO'`. Es decir: la deuda se imputa al par (período, unidad).

`docs/diseno/08-criterios-de-reparto.md` §E ya decidió lo contrario, y lo marcó como **la única
decisión del panel cuyo costo se multiplica si se posterga**:

> *"La deuda se imputa al comprobante, nunca al par (período, unidad). Si el módulo de cobros se
> escribe contra (periodo, unidad), el segundo comprobante lo rompe y hay que desagregar pagos ya
> imputados."*

El piloto **ya tiene** el segundo comprobante: la obra de gas de Guazú Pytá, con boleta separada.
Fijarlo hoy cuesta cero; fijarlo después es una conversión de datos sobre plata ya cobrada.

### 2.2. El invariante "coeficientes = 100,000% exacto o no se emite"

Es el instinto correcto con la formulación equivocada. Es cierto para un esquema porcentual de
reglamento y **falso para todo lo demás**:

- **Partes iguales**: 33,333 × 3 = **99,999**. Es la "trampa de los 9 decimales" de doc 08 §B, ya
  resuelta en el repo con `partes_iguales` como base propia (migración 0010). **Y es la forma típica
  de la S.A.**: una acción por lote.
- **Superficie en m²**: son pesos relativos, no porcentajes. No suman 100 y no tienen por qué.
- **Escala por tramos** con piso y techo: da 0,999999999 por construcción.
- **Modelo de cuota fija**: no hay prorrateo de gastos que cuadrar.

Adoptarlo haría **inemitibles cuatro de las cinco bases de reparto** del sistema, incluida la más
probable del piloto.

Y hay algo peor: **es ciego al error que importa.** Si entra una unidad nueva sin coeficiente, las
demás siguen sumando 100, el control pasa, y esa unidad **no paga nunca** — el error #2 de doc 08 §F,
*"invisible durante meses"*.

El invariante correcto ya está escrito en doc 08 §L: **`repartido = gastado`** como sub-suma
verificable, más toda otra línea trazada 1 a 1 con su origen. Es aritmética sobre el resultado, no una
restricción sobre los pesos.

### 2.3. El vocabulario de propiedad horizontal, clavado en los criterios de aceptación

`acceptance.md` cierra con un criterio testeable: *"Terminología: consorcio, unidad funcional (UF),
coeficiente, expensas ordinarias/extraordinarias…"*. **Ese test haría fallar la boleta correcta del
piloto.**

| El handoff dice | En el piloto (S.A.) es |
|---|---|
| consorcio | la sociedad / el barrio |
| unidad funcional (UF) | manzana y lote (nomenclatura catastral) |
| coeficiente del reglamento | del estatuto + reglamento interno |
| expensas | **aporte / cuota social** |
| consejo de administración / presidente | **directorio** |

El repo ya tiene la pieza correcta —`periodo_expensa.denominacion_concepto`— y falta su gemela para la
unidad. Una suite de tests que afirma las palabras equivocadas es peor que ninguna suite: hace que el
comportamiento correcto se vea como una regresión.

### 2.4. El rol `CONSEJO` con "no ve deuda individualizada" como invariante

Tres problemas, y el primero es estructural:

1. **En PH, el consejo aprueba el certificado de deuda** (art. 2048). Un certificado dice qué unidad,
   qué períodos y cuánto. Un consejo que por diseño no puede recibir deuda individualizada **no puede
   ejecutar el único acto que la ley le asigna en materia de cobro**. El handoff hace estructuralmente
   imposible la figura para la que está escrito.
2. **En la S.A., el directorio tiene el deber de conocer**: los deudores están en los estados
   contables que ese mismo directorio firma.
3. **Contradice la política del piloto**: en Las Corzuelas el listado de mora se publica **nominado, a
   todo el barrio**, por resolución del órgano (doc 10 §E.1), y doc 10 §E.2 ya decidió que esto es
   **configurable, sin default**.

Está bien como *default de privacidad*; está mal como *invariante*.

### 2.5. La paleta de color

Calculada con la fórmula WCAG, no estimada:

- **`#8a8781`, el gris operativo del sistema** (170 apariciones en el prototipo), **falla AA sobre
  todas sus propias superficies**: 3,58:1 sobre tarjeta, 3,40:1 sobre header de tabla —donde el
  handoff pone labels de 11px—, 3,26:1 sobre la página, 2,93:1 sobre chip. Mínimo AA: 4,5:1.
- **Los bordes, que el handoff declara que *son* el sistema** ("la jerarquía se resuelve con borde y
  color, no con sombras"), dan **1,32:1** el de un input y **1,35:1** el de un contenedor. Mínimo para
  un componente de interfaz: 3:1. En la pantalla de conciliación a tres columnas, eso significa que
  alguien con baja visión no ve dónde termina una columna y empieza la otra — y ahí se imputa un pago
  a la unidad equivocada.
- **El punto ámbar de "requiere atención"** da 2,47:1. Falla.
- **El acento azul `#2f4fa8` es el color mejor calibrado de todo el paquete** (7,49:1) — y es
  exactamente lo que doc 06 §b.1 prohibió por nombre: *"nada de azul-admin genérico"*. La alternativa
  "cercana al teal" (`#1f8a8a`) da 4,15:1: tampoco llega.
- **No tiene un solo token de modo oscuro**, que doc 06 §b.4 exige "desde el día uno".

Y un argumento técnico que no es estético: el **acento por barrio** del repo tiene una banda permitida
de 230°–335°, elegida para no chocar con los colores de estado. El azul del handoff está en **≈224°**,
pegado al borde. Con un barrio cuyo acento caiga cerca, el color de identidad y el de acción se
parecen, y la señal deja de cumplir su función — que es que no liquides el barrio equivocado.

### 2.6. Y cuatro cosas más que revierten decisiones ya tomadas

| Qué propone el handoff | Qué ya está decidido |
|---|---|
| **Base de reparto por rubro con excepciones por sector** (piscina al sector B, agua por medidor) | doc 08 §A.0.1, **corrección del usuario que prevalece sobre todo el documento**: *"los gastos comunes son comunes a todos"*, y el reparto por concepto **baja a caso de borde futuro** |
| **Segundo vencimiento con recargo del 5%** | doc 08 §J: *"el pronto pago se modela como descuento condicional sobre la deuda plena, **nunca** como recargo del segundo vencimiento"* — porque choca con la tasa de mora y **cobra dos veces el mismo atraso**. El handoff tiene recargo **y** mora conviviendo, y no dice nunca cómo interactúan |
| **Reportes: libro de gastos e impositivos, "enviar al contador"** | doc 01 §4.8, **decisión del usuario del 2026-07-24**: el módulo contable queda **fuera del MVP** — *"prácticamente un ERP"*. Lo que entra es la **exportación de movimientos** |
| **Retenciones (Ganancias, SUSS) calculadas por el sistema** | doc 04 §B.3 **prohíbe calcular retenciones automáticamente**: el régimen fiscal no está cargado en `knowledge/` |

---

## 3. Los errores técnicos verificables del material

No son opiniones: se comprobaron ejecutando o midiendo.

1. **`fixtures.ts` hace en coma flotante la multiplicación que su propio `acceptance.md` prohíbe.**
   `Math.floor((importe * coeficiente) / base)` con los números del propio archivo da un producto de
   **8,59 × 10¹⁶**, casi diez veces el entero seguro máximo de JavaScript. `Number.isSafeInteger()`
   devuelve **falso**. Con estos números da bien de casualidad (son redondos); con coeficientes reales
   de seis decimales, no. El archivo que exige *"ningún cálculo de plata usa float"* ya está fuera del
   rango seguro con los $62,6 M que él mismo liquida.

2. **`fixtures.ts` no puede probar lo que dice probar.** Se presenta como el test de referencia de
   *"el resto por redondeo se asigna de forma determinista"*, y **las cuatro divisiones del fixture
   son exactas**: el resto es cero en todas. El archivo no distingue "al mayor coeficiente" de "al
   mayor residuo" de "a la última unidad".

3. **La regla de redondeo que propone es el bug que el repo ya arregló.** Mandar todo el resto al
   mayor coeficiente hace que **la misma unidad se coma el resto todos los meses, para siempre**. El
   repo reparte por mayor residuo, un centavo por unidad, con desempate estable — y el comentario del
   código dice por qué: *"antes se le daban todos a la última unidad, que con 37 unidades podía
   recibir 36 centavos de golpe"*.

4. **El fondo de reserva del fixture rompe el invariante de cuadre.** Cobra el 3% **por encima** del
   gasto: el barrio recauda 103% de lo que gastó. El repo modela el fondo como **un gasto más** con su
   monto. Los dos modelos existen en la realidad, pero el del fixture no cierra contra
   `sum(gastos) = sum(prorrateado)`, que es lo que la base verifica al emitir.

5. **`UnidadFuncional` se contradice a sí misma.** Tiene un `titular` embebido —una sola persona— y a
   la vez `ocupacion: 'CONDOMINIO'`, que por definición es más de un titular. El repo tiene
   `obligado` + `unidad_obligado` con vigencia desde el día uno, precisamente porque una unidad tiene
   varios obligados en el tiempo **y a la vez**.

6. **`DetalleUF.total` significa dos cosas distintas** en el mismo paquete: en `schemas.ts` incluye
   `saldoAnterior`; en `fixtures.ts` los totales lo excluyen.

7. **Ningún parámetro de `ReglasLiquidacion` tiene vigencia.** Tasa de mora, recargo, porcentaje del
   fondo, días de vencimiento: todos valores sueltos. Se cambia la tasa en septiembre y **todo
   recálculo de una deuda de agosto sale con la tasa nueva**, en silencio. El repo versiona
   coeficientes, tasa de mora, cuota fija, atributos del barrio y mandato, exactamente por esto.

8. **La regla de conciliación no va a funcionar.** `CUIT + importe ±$500 dentro de 5 días del
   vencimiento`:
   - El CUIT del ordenante casi nunca identifica a la unidad (paga la esposa, la empresa, el
     inquilino). **El propio fixture lo demuestra**: el mismo CUIT aparece como titular de una unidad
     y como proveedor cobrando.
   - ±$500 sobre boletas de $7.500.000 es el **0,067%**. La gente paga redondo, paga el importe del
     mes pasado, paga dos boletas juntas, paga menos la comisión.
   - *"Dentro de 5 días del vencimiento"* es el ancla equivocada: **los pagos en mora, que son los que
     más cuesta identificar, nunca matchean**.
   - Falta el mecanismo que sí funciona para el piloto: el archivo de rendición de la **red de
     cobranza** (SIRO/Roela), que vuelve con el identificador de la boleta y matchea exacto.

---

## 4. El costo, en tandas de trabajo

Unidad de medida: **una "tanda C"** = la sesión del 2026-08-03 (panel de tres agentes, almacenamiento
nuevo, dos migraciones, un proceso nuevo, una pantalla, dos rutas, diez defectos de revisión, ~29
tests). Es decir: **una pieza de infraestructura y una pantalla**.

El error de lectura del handoff es contar pantallas. **Cada pantalla suya no es una pantalla**: es una
pantalla + los servicios de lectura que la alimentan + a veces un subsistema entero detrás.

| Tanda del `PROMPT.md` | Equivale a | Por qué |
|---|---|---|
| 1 · Shell, selector, roles | 1–1,5 | Lo más barato, y lo menos útil hoy |
| 2 · Resumen, padrón, estado de cuenta | 2–3 (+1–2) | El estado de cuenta necesita **Cobros**, que no existe |
| 3 · Gastos (OCR) y bancos | **5–7** | Bancos = cuentas + ingesta + motor de matching + interfaz. OCR = extractor + AFIP + retenciones |
| 4 · Liquidación | 1,5–2 | La más barata: el motor ya está |
| 5 · Mora y reportes | 3–4 | Mora con planes es un subsistema con devengamiento. Reportes es el módulo contable |
| 6 · Reclamos, config, portal, cierre masivo | 4–6 | Cuatro cosas distintas en una línea |
| **Total** | **17–24** | Sin contar el panel legal y fiscal por figura, que el handoff no contempla y el repo exige |

**Cerrar lo que ya anda** —las once observaciones + cobros + pagos manuales + distribución— son **4 a 6
tandas**, y deja una demo que un administrador real puede mirar de punta a punta.

---

## 5. Por qué el orden del `PROMPT.md` no sirve hoy

Propone empezar por el chrome, el selector de contexto y los roles. **Es la peor tanda posible para el
piloto**, por cuatro razones, y la primera la escribe el propio handoff:

1. **`business-rules.md` la desactiva**: *"1 consorcio → no es selector: título fijo"*. Con un barrio,
   la tanda 1 entrega un título fijo, un consolidado de una fila, y una vista de consejo que en una
   S.A. ni siquiera aplica.
2. **No toca ni una de las once observaciones del recorrido.** Las once pasan **adentro** de un
   barrio: cómo volver, cómo abrir un período, cómo cargar un gasto, cómo escribir un importe.
3. **Su prerrequisito real está en la lista del usuario, no en la suya**: hay un solo barrio y lo ven
   los tres usuarios. El selector no es demostrable hasta que haya dos barrios con elencos distintos.
4. **Falta lo único bloqueante que el handoff no tiene**: el campo de dinero con máscara y
   normalización de decimales. El handoff especifica el formato de **lectura** y no dice **nada** de
   la escritura.

### El orden propuesto

| # | Tanda | Tamaño | Qué cierra |
|---|---|---|---|
| **0** | `CampoDeDinero` (máscara + decimales) **+ segundo barrio en el seed** | 0,5–1 | B-1, B-1.bis, E-1. Desbloquea todo formulario futuro y hace demostrable el aislamiento |
| **1** | Navegación del período: entrada por resumen, fila clickeable, "Volver", salida de la confirmación, "Nuevo gasto" | 1–1,5 | A-1 a A-5, **sin ningún subsistema nuevo**: es re-armar lo que ya existe con el layout de `4a`/`2a` |
| **2** | Identificadores en monoespaciada, densidad bajo demanda, formatos AR (en paralelo con 1) | 0,5 | Lo mejor del handoff que no toca color ni papel |
| **3** | Cobros: estado de cuenta por unidad + pagos manuales | 2 | El hueco más grande del MVP |
| **4** | Configuración del barrio (sin el paso fiscal) | 1 | Alta de barrio sin SQL |
| **5** | Distribución (ZIP + email 1-a-1 con registro) | 1–1,5 | Cierra el mes de punta a punta |

Recién después, el shell multi-barrio — cuando haya dos barrios y algo que consolidar.

---

## 6. Hallazgos sobre el propio repo que este análisis destapó

No son del handoff; salieron de mirarlo con lupa al lado.

1. **`--border` da 1,23:1 y `--border-strong` 1,53:1.** El borde de un input es un componente de
   interfaz y necesita 3:1. **Es una falla de accesibilidad vigente**, no del handoff.
2. **Dos colores de morosidad están un pelo abajo de AA**: `alDia` 4,49:1 y `vencido` 4,46:1 contra
   4,5. Y **viajan al papel** (`boleta.ts`), así que corregirlos arregla los dos lados.
3. **El modo oscuro está generado y nadie lo enciende**: el mecanismo `[data-theme]` emite cuatro
   bloques de CSS y no hay una sola línea que lo setee.
4. **No hay ni una fuente instalada en el repo.** Cero archivos de fuente; Geist está declarada y no
   existe; las plantillas corren con la pila de reserva. **Esto significa que el reflow por cambio de
   tipografía que ADR-0001 §6 anticipa todavía no ocurrió**, y que este es el momento más barato de la
   vida del proyecto para decidir tipografía: antes de embeber la fuente y antes de la primera boleta
   que reciba un vecino real.
5. **El kit muestra el coeficiente con 4 decimales y el handoff pide 3.** Es decisión de dominio.
6. **Comentarios desactualizados**: varios dicen "resto a la última unidad" cuando el código ya reparte
   por mayor residuo.

---

## 7. Sobre los documentos impresos: la respuesta corta es "no se tocan"

**Los PDF ya emitidos no se ven afectados por ningún cambio de diseño.** Está implementado, no
prometido: `documento_emitido` guarda el archivo, su `sha256`, la vista congelada, el motor y el hash
de plantilla, y reimprimir sirve el objeto guardado. Verificado el 2026-08-03.

**Los que se emitan después, sí.** Y ahí está el costo real:

- Los colores de estado de la boleta salen de los mismos tokens semánticos de la pantalla. Con la
  paleta del handoff, las bandas de estado pasan de 5,0–5,2:1 a **2,5–3,6:1** sobre papel — por debajo
  del piso de 4,5:1 que doc 09 §E.8.1 exige en todo el frente de la boleta.
- Hay **un test guardián** (`boleta-diseno.test.ts`) que revienta a propósito si aparece un color
  fuera del set permitido o si cambian los tamaños de impresión. El sistema ya se defiende solo.
- **El handoff no tiene papel**: no tiene escala en puntos, ni tintas de impresión, ni piso de
  legibilidad, ni reglas de fotocopia. El repo tiene los cinco objetos y cada valor salió de una
  medición documentada (la trama a 45° que el rasterizador perdía; el filete de 0,8 pt porque tras una
  fotocopia 0,4 y 0,6 son la misma línea; el negro puro del código de barras). **Ese es el activo más
  caro del repositorio y el más difícil de reconstruir.**

---

## 8. Las preguntas que sólo el usuario puede contestar

1. **¿El cliente es el estudio o el barrio?** El handoff asume una administradora con ~20 consorcios.
   Si el producto se le vende a estudios, el shell multi-consorcio importa y hay que planificarlo. Si
   el cliente es el barrio, no importa hoy y lo que importa es cerrar el mes. **El orden de trabajo
   cambia entero según la respuesta.**
2. **¿La interfaz habla en propiedad horizontal, o el vocabulario sigue siendo configurable por
   barrio?** Ya está decidido que es configurable. Adoptar el diseño literal lo rompe, y es lo que más
   caro sale corregir después porque toca cada texto de cada pantalla.
3. **En Las Corzuelas, ¿se cobra por gastos del mes o por cuota fija del directorio?** El wizard de
   tres pasos del handoff **no tiene lugar para el modelo fijo**. Si el piloto cobra cuota fija, el
   wizard no se adopta: se rehace.
4. **El reparto por rubro con excepciones por sector: ¿vuelve al alcance?** El 25/07 lo bajaste a caso
   de borde futuro; el handoff lo pone como regla central. Las dos posturas son razonables y son dos
   preguntas distintas (el barrio propio vs. el producto que se vende). **No es gratis: es motor de
   reparto nuevo, no una pantalla.**

---

## 9. La recomendación operativa, hoy

Lo único que conviene hacer **ya**, y cuesta media hora:

> **Declarar por escrito que `design_handoff_consorcia/` es insumo de producto — inventario de
> pantallas y batería de reglas para contrastar — y NO es fuente de verdad ni de diseño ni de
> dominio.** Con una nota en `HANDOFF.md` y un aviso en la cabecera de `PROMPT.md` que diga que la
> nomenclatura, los roles, los estados, el modelo de datos y los tokens del repo **ganan siempre**.

Sin eso, el riesgo concreto es que alguien —el usuario, Codex, o esta misma herramienta en una sesión
sin este contexto— pegue el prompt tal cual y arranque el segundo producto. En tres meses hay dos
nomenclaturas en el mismo código y nadie sabe cuál es la canónica.

---

## 10. Derivaciones abiertas

**A `legal-ph`** (ninguna se puede cerrar sin fuente):
- Órganos por figura: quién aprueba qué acto, con qué quórum y mayoría, en qué libro, y si el visto
  bueno mensual tiene algún efecto sobre la exigibilidad. `knowledge/` marca el articulado de la LGS
  como pendiente y no tiene nada de asociación civil, fideicomiso ni geodesia.
- Certificado de deuda en S.A.: ¿se instrumenta por acta de directorio?
- El recargo por segundo vencimiento, ¿es interés punitorio? (ya abierta en doc 08 §R).
- El plan de pago, ¿nova la deuda? Decide si al caducar se puede "volver al tramo original".
- Reparto propietario/inquilino tras el DNU 70/2023.

**A `contador`:**
- Retenciones: el handoff promete cálculo automático y doc 04 §B.3 lo prohíbe.
- Cargos por amenities: doc 08 §Z ya lo marcó como lo más urgente — **puede volver contribuyente de
  IIBB a un barrio que no lo era, y el barrio-S.A. es la figura de mayor riesgo**.
- Fondo de reserva: ¿recargo sobre las ordinarias o partida dentro del presupuesto? Cambia la boleta.

**A `security-engineer` + `dba-data`:** el rol del órgano de gobierno exige control **por columna**,
patrón que este esquema no tiene; y el test de payload por rol.

**Preguntas al barrio que este análisis vuelve a poner arriba** (todas ya en
`preguntas-a-la-administracion.md`, sin responder): el convenio de la red de cobranza (#1, #2), la
numeración y reimpresión de boletas (#3, #4), los medios de cobro (#5), la política de segundo
vencimiento (#7), el criterio del descuento al cumplidor (#8) y a nombre de quién se emite la boleta de
una unidad alquilada (#9). **Las seis tocan reglas que el handoff ya decidió por su cuenta**, en varios
casos en contra de lo que el barrio hace hoy.
