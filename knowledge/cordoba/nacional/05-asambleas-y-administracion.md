---
name: asambleas-y-administracion
description: Órganos del consorcio — asamblea, consejo de propietarios y administrador. Convocatoria, quórum, mayorías, actas y libros. Base de los módulos de asambleas y gobierno.
jurisdiccion: cordoba
nivel: nacional
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# Asambleas y administración (CCyC)

## 1. Los tres órganos

`[VERIFICADO]` **Art. 2044** — el conjunto de los propietarios de las unidades funcionales **constituye la persona jurídica consorcio**, y sus órganos son: **la asamblea, el consejo de propietarios y el administrador**.

**Regla de negocio:** el consorcio es **sujeto de derecho propio**. En el modelo de datos es una entidad, no una etiqueta del barrio. (Ojo: esto vale para PH; en un barrio-SA el sujeto es la sociedad y los órganos son otros — ver `02-ley-19550-barrio-sa.md`.)

## 2. Facultades de la asamblea

`[VERIFICADO]` **Art. 2058** — la asamblea resuelve:
- a) las cuestiones que le atribuyen especialmente la ley o el reglamento;
- b) las cuestiones atribuidas al administrador o al consejo, **cuando se las someten** cualquiera de ellos **o quien represente el cinco por ciento (5%) de las partes proporcionales indivisas**;
- c) la conformidad con el **nombramiento y despido del personal** del consorcio;
- d) todo lo no contemplado como atribución del administrador o del consejo.

**Regla de negocio:** el sistema debe poder calcular si un grupo de propietarios **alcanza el 5% de partes indivisas** para forzar el tratamiento de un tema. Es un cálculo sobre coeficientes, no sobre cantidad de personas.

## 3. Convocatoria y orden del día

`[VERIFICADO]` **Art. 2059** — los propietarios deben ser convocados **en la forma prevista en el reglamento**, con **transcripción del orden del día**, que debe redactarse **en forma precisa y completa**.

⚠️ **Es nulo el tratamiento de temas fuera del orden del día**, salvo que estén presentes **todos** los propietarios y acuerden **por unanimidad** tratarlo.

`[VERIFICADO]` La convocatoria la realiza **el administrador** (art. 2067 inc. a). Ante su omisión, el **consejo de propietarios** está autorizado a convocarla (art. 2064 inc. a).

`[VERIFICADO]` **Autoconvocatoria:** la asamblea puede autoconvocarse. Las decisiones son válidas si **la autoconvocatoria y el temario se aprueban por una mayoría de dos tercios (2/3) de la totalidad de los propietarios**.

`[VERIFICADO]` **Decisiones fuera de asamblea:** son igualmente válidas las tomadas **por voluntad unánime del total de los propietarios**, aunque no lo hagan en asamblea (por ejemplo, por escrito).

**Reglas de negocio:**
- El sistema debe **bloquear** el registro de decisiones sobre temas no incluidos en el orden del día, salvo que se acredite presencia total + unanimidad.
- Debe soportar **tres modalidades**: asamblea convocada, autoconvocada (2/3) y decisión unánime fuera de asamblea.
- El orden del día es un campo estructurado (lista de puntos), no texto libre.

## 4. Quórum — atención, trampa

`[VERIFICADO]` El art. 2059 **titula "Convocatoria y quórum" pero no define el quórum**. Debe seguirse lo que establezca el reglamento. Si el reglamento nada dice, **no rige el quórum como condición** y se aplican solo las reglas de mayorías. Muchos reglamentos no establecen quórum.

Dicho de forma simple: **sin quórum no hay asamblea y sin mayoría no hay decisión** — pero el quórum solo existe si el reglamento lo creó.

**Regla de negocio:** el quórum es **configurable por barrio** (viene del reglamento) y puede estar **ausente**. El sistema no debe imponer un quórum por defecto.

## 5. Mayorías — la regla más importante

`[VERIFICADO]` **Art. 2060 — Mayoría absoluta.** Las decisiones se adoptan por mayoría absoluta **computada sobre la totalidad de los propietarios de las unidades funcionales** (estén o no presentes), y se forma con la **doble exigencia**:
1. el **número de unidades**, y
2. las **partes proporcionales indivisas** de éstas con relación al conjunto.

⚠️ **Esto es una doble mayoría simultánea, no una alternativa.** Y se computa sobre el total del padrón, no sobre los presentes.

`[VERIFICADO]` **Art. 2057 — Modificación del reglamento:** requiere **dos tercios (2/3) de la totalidad de los propietarios**.

`[A VERIFICAR]` **Art. 2061** — regula el cómputo respecto de propietarios ausentes / la comunicación de decisiones. Cargar el texto y confirmar su mecánica, porque afecta directamente cómo se cierra una votación.

**Reglas de negocio (críticas para el módulo de votaciones):**
- El motor de cómputo debe evaluar **dos umbrales en paralelo** (unidades + coeficientes) y solo dar aprobada la moción si **ambos** se alcanzan.
- La base de cómputo es **la totalidad del padrón**, no los presentes. Un ausente cuenta como no-voto en el denominador.
- Debe soportar **mayorías distintas por tipo de decisión**: absoluta (art. 2060), 2/3 (reforma de reglamento y autoconvocatoria), unanimidad (temas fuera del orden del día, decisiones fuera de asamblea), y las que el reglamento agregue.

## 6. Actas y libros obligatorios

`[VERIFICADO]` **Art. 2062 — Actas.** Sin perjuicio de los demás libros de administración, es **obligatorio llevar**:
- un **Libro de Actas de Asamblea**, y
- un **Libro de Registro de Firmas** de los propietarios.

Debe **labrarse acta de cada asamblea**, y **los presentes deben firmar** como constancia de asistencia. Las firmas deben ser **cotejadas por el administrador** contra las firmas originales registradas.

**Reglas de negocio:**
- El sistema debe generar el **acta** de cada asamblea con su registro de asistentes.
- Debe contemplar el **registro de firmas** y el cotejo. En una implementación digital, esto se traduce en identidad verificada del votante — un requisito de diseño, no un detalle.
- Los libros son obligatorios: el sistema debe poder **exportarlos** en forma que sirva como respaldo.

## 7. Consejo de propietarios

`[VERIFICADO]` **Arts. 2063 y 2064.** Atribuciones relevantes ya identificadas:
- **Convocar la asamblea** ante la omisión del administrador (2064 inc. a).
- **Autorizar al administrador a disponer del fondo de reserva** ante gastos imprevistos y mayores que los ordinarios (2064 inc. c).
- **Aprobar el certificado de deuda** para que sea título ejecutivo, cuando el consejo existe (art. 2048).

⚠️ El consejo **puede no existir** (la ley dice reiteradamente "si lo hay"). El sistema debe soportar barrios con y sin consejo, y ajustar los circuitos de aprobación en consecuencia.

## 8. Administrador

`[VERIFICADO]`
- **Arts. 2065/2066** — los administradores sucesivos son **nombrados y removidos por la asamblea**, sin que ello importe reforma del reglamento, y **pueden ser removidos sin expresión de causa**.
- **Art. 2067** — tiene los derechos y obligaciones impuestos por **la ley, el reglamento y la asamblea**. Inc. a): convocar la asamblea.

`[VERIFICADO]` **Punto práctico relevante:** existe criterio registral (Registro de la Propiedad Inmueble de la Capital Federal, 2019) según el cual, reunida la mayoría necesaria en asamblea, la **escritura de modificación del reglamento puede ser otorgada por los propietarios o por el administrador**, este último en su carácter de **órgano representativo** del consorcio, en ejecución de lo resuelto. ⚠️ Es un criterio **de CABA**; verificar el criterio registral aplicable en Córdoba.

**Reglas de negocio:**
- El administrador es un **rol con mandato**, con fecha de designación y de cese, ligado a un acta de asamblea. Debe versionarse: quién administraba en cada período importa para la validez de los actos.
- Un cambio de administrador **no** implica reforma de reglamento — no debe disparar ese flujo.
- Esto conecta con la multi-tenancy: el **administrador es el cliente del sistema**, y su mandato sobre cada barrio tiene vigencia acotada. Ver `REQUISITOS-MODELO-DATOS.md`.

## Fuentes

- CCyC texto actualizado — InfoLeg:
  `https://servicios.infoleg.gob.ar/infolegInternet/anexos/235000-239999/235975/texact.htm`
- Articulado de PH (recopilación sectorial):
  `https://ligadelconsorcista.org/legislacion/nuevo-codigo-civil-comercial-parte-pertinente`
- Doctrina sobre asambleas y mayorías — Revista del Notariado:
  `https://www.revista-notariado.org.ar/index.php/2019/11/la-asamblea-como-organo-del-consorcio-de-propiedad-horizontal-mayorias-para-resolver/`
- Criterio registral sobre otorgamiento de la modificación del reglamento (CABA, 2019):
  `https://servicios.infoleg.gob.ar/infolegInternet/anexos/330000-334999/330848/norma.htm`
