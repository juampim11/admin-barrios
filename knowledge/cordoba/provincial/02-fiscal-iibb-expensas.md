---
name: fiscal-iibb-expensas-cordoba
description: Tratamiento fiscal provincial de las expensas en Córdoba — Ingresos Brutos, Código Tributario y consulta vinculante de Rentas. Hallazgo central para el agente contador.
jurisdiccion: cordoba
nivel: provincial
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# Fiscal Córdoba — Ingresos Brutos y expensas

> Este es el archivo base del agente `contador`. **Nada de acá se usa sin validación de un contador matriculado**: las alícuotas y la numeración de artículos cambian todos los años con la ley impositiva.

## Hallazgo central

`[VERIFICADO]` El **Código Tributario de Córdoba** contempla expresamente el tratamiento de las expensas. La **Ley 10117** incorporó un inciso al artículo sobre base imponible del Impuesto sobre los Ingresos Brutos que alcanza a:

> los importes en concepto de **expensas o contribuciones para gastos comunes o extraordinarios**, por cualquier concepto, determinados para su pago por cada propietario o sujeto obligado —directa o indirectamente—, **incluyendo las cuotas sociales permanentes y de pago periódico** cuando corresponda, con relación a inmuebles ubicados en **"countries", clubes de campo, clubes de chacra, barrios cerrados, barrios privados y demás urbanizaciones**, y también en edificios de propiedad horizontal u otros inmuebles afectados a ese régimen.

**Por qué es un hallazgo grande, y en dos sentidos:**

1. **La norma cubre expresamente a los barrios cerrados y countries**, no solo a la propiedad horizontal clásica. Es decir, el legislador cordobés ya contempló la realidad de estos entes.
2. **Menciona explícitamente las "cuotas sociales permanentes y de pago periódico"** — que es exactamente la forma en que un **barrio-SA** instrumenta sus aportes. La norma parece haber sido redactada para alcanzar también a las figuras societarias, no solo a las consorciales.

`[A VERIFICAR — CRÍTICO]` **Qué efecto exacto tiene ese inciso** (si excluye esos importes de la base imponible, si los exime, o si los trata de otro modo) **debe confirmarse leyendo el artículo completo en el texto ordenado vigente**. La descripción de arriba resume el supuesto alcanzado, no su consecuencia jurídica. No liquidar nada sobre esta base sin esa verificación.

## ⚠️ Problema de numeración de artículos

`[VERIFICADO]` El Código Tributario de Córdoba **se renumera entre textos ordenados**. Ejemplos concretos de la discrepancia encontrada:
- La Ley 10117 introduce el inciso en el **art. 205**.
- Una recopilación consultada ubica las **exenciones objetivas** de Ingresos Brutos en el **art. 208**.
- El texto publicado por Rentas Córdoba ubica las **exenciones subjetivas** en el **art. 241**.

**Regla obligatoria para el agente `contador`:** nunca citar un número de artículo del Código Tributario provincial sin verificarlo contra el **texto ordenado vigente publicado por Rentas Córdoba**. Citar un número desactualizado es un error de alto impacto.

## Consulta vinculante específica

`[VERIFICADO]` Rentas Córdoba emitió la **Resolución CV 018/2012** (20/03/2012), que trata específicamente **Ingresos Brutos y expensas comunes**. Según su índice, aborda:
- la falta de regulación legal de los barrios cerrados en la ciudad de Córdoba (al momento de emitirse),
- la analogía en la interpretación de normas tributarias,
- el tratamiento de expensas/gastos comunes en consorcios de PH y sus similitudes o diferencias con el caso consultado,
- el hecho imponible del Impuesto sobre los Ingresos Brutos en el ordenamiento provincial,
- la naturaleza de los servicios que la asociación contrata para brindar a los vecinos propietarios.

⚠️ **Es de 2012**: anterior tanto al CCyC (2015) como a la Ley 10117. Sirve para entender el **razonamiento** del fisco provincial, no como criterio vigente sin más. Verificar si fue superada.

PDF: `https://www.rentascordoba.gob.ar/cms/wp-content/uploads/2022/06/CV18-Ingresos-Brutos-Expensas-Comunes.pdf`

## Lo que falta cargar

`[A VERIFICAR]`
- **Ley impositiva anual vigente** de Córdoba (alícuotas de IIBB y Sellos). Se actualiza cada año: cargar la del ejercicio en curso.
- **Impuesto de Sellos**: tratamiento de contratos que el ente celebra (con proveedores, de administración).
- **Impuesto Inmobiliario**: quién es sujeto pasivo según la figura (¿el ente titular de los comunes? ¿cada propietario?). Especialmente relevante en barrios-SA, donde los espacios comunes están a nombre de la sociedad.
- **Regímenes de retención/percepción** que puedan alcanzar al ente al pagar proveedores.
- Diferenciar **tasas municipales** de expensas privadas (ver `municipal/`).

## Impacto en el diseño del sistema

1. El módulo de liquidación debe distinguir **conceptos alcanzados y no alcanzados** por IIBB, no meter todo en una bolsa.
2. Un barrio que genera **ingresos ajenos a las expensas** (alquiler de espacios, antenas, publicidad, invitados) puede quedar en situación distinta al que solo recauda expensas. El sistema debe poder **separar esos ingresos**.
3. La **figura jurídica del barrio** condiciona el encuadre fiscal → refuerza que `figura_juridica` sea atributo de primera clase.

## Fuentes

- Ley 10117 (modificatoria del Código Tributario):
  `https://www.argentina.gob.ar/normativa/provincial/ley-10117-123456789-0abc-defg-711-0100ovorpyel/actualizacion`
- Ley 6006 (Código Tributario, t.o.):
  `https://www.argentina.gob.ar/normativa/provincial/ley-6006-123456789-0abc-defg-600-6001ovorpyel/actualizacion`
- Rentas Córdoba — Código Tributario, IIBB, exenciones:
  `https://www.rentascordoba.gob.ar/cms/cs-impuesto-sobre-los-ingresos-brutos-cap-4-5-6/`
- Resolución CV 018/2012 (expensas comunes e IIBB): ver PDF arriba.
