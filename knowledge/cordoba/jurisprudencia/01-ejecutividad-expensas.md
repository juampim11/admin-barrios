---
name: ejecutividad-expensas
description: Criterios jurisprudenciales sobre si el certificado de deuda de expensas es título ejecutivo según la figura jurídica del barrio. Regla de negocio central del módulo de cobranzas.
jurisdiccion: cordoba
nivel: jurisprudencia
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# Ejecutividad del cobro de expensas según la figura jurídica

> **El tema con mayor impacto directo en el producto.** De acá sale la regla de negocio del módulo de cobranzas.

## El problema en una línea

En **propiedad horizontal**, el art. 2048 CCyC le da al certificado de deuda del administrador carácter de **título ejecutivo**. En **conjuntos inmobiliarios no adecuados** (típicamente barrio-SA), esa fuerza ejecutiva **no está garantizada** y depende del tribunal, del fuero y de cómo esté instrumentada la deuda.

## Estado del debate

`[VERIFICADO]` **Antes del CCyC (hasta 1/8/2015):** la tendencia jurisprudencial mayoritaria era que los certificados de deuda emitidos por clubes de campo o barrios cerrados preexistentes **no** revestían carácter de título ejecutivo.

Hito: **CNCom, en pleno, "Barrio Cerrado Los Pilares S.A. c/ Álvarez, Vicente Juan Alfonso s/ ejecutivo", 04/05/2015** — no corresponde otorgar fuerza ejecutiva al certificado de deuda por expensas emitido por un club de campo/barrio cerrado en esas condiciones.

`[VERIFICADO]` **Después del CCyC, criterios divergentes:**

**Línea restrictiva (fuero comercial).** *CNCom, Sala C, "Altos de los Polvorines S.A. c/ Castaño, Mariana s/ Ejecutivo" (oct. 2016)*: rechazó la ejecución. Razonamiento: el CCyC somete a los conjuntos inmobiliarios al régimen de PH; **no estando acreditada la adecuación**, y siendo la actora una **sociedad anónima** cuyo objeto es el dominio y administración de los espacios comunes y el régimen de expensas, **no le asiste el derecho a reclamar ejecutivamente**, porque esa vía es un beneficio derivado de la configuración de un derecho real del que carece.

**Línea permisiva (fuero civil).** *CNCiv, Sala A, "Lagunas del Polo Barrio Cerrado SA c/ G.L.G. s/ ejecución de expensas", 28/08/2015*: confirmó la ejecución y desestimó la excepción de inhabilidad de título, con el argumento de que el art. 2075 dispone que los conjuntos inmobiliarios deben someterse a la normativa de PH, resultando aplicable la vía ejecutiva procesal.

**Línea societaria.** Existe una corriente que funda la ejecutividad en la **naturaleza societaria** del vínculo: la obligación del propietario es un deber asumido como **socio de una sociedad anónima**, con base en una vinculación de carácter societario (se cita en esta línea *CSJN, 23/10/2007, "Club de Campo Haras del Sur S.A."*).

**Evolución reciente.** `[VERIFICADO]` En 2023 se registró un **fallo plenario** que reconoció fuerza ejecutiva al certificado de deuda por expensas emitido por un conjunto inmobiliario preexistente **aunque no esté sometido al derecho real de propiedad horizontal**, apoyándose en la analogía por la **finalidad** de las expensas. `[A VERIFICAR]` Identificar con precisión el tribunal y la carátula de ese plenario y su ámbito territorial antes de citarlo.

## El factor decisivo: cómo está instrumentada la deuda

`[VERIFICADO]` Más allá de la figura, los fallos giran en torno a **de dónde nace la obligación y con qué formalidad**:

- Si hay un **reglamento inscripto** que constituye el derecho real y designa administrador (arts. 2038 y 2056 inc. r) CCyC), el terreno es más firme.
- Si la ejecutividad surge de un **"pacto de ejecutividad"** incluido en el reglamento o en la escritura, su validez es discutida: parte de la doctrina la admite, parte la rechaza.
- Los tribunales han observado la **incoherencia de invocar el CCyC solo cuando conviene**: pretender el certificado del art. 2048 pero regirse por la escritura para el resto (sujetos obligados, porcentuales, exigibilidad, mora).

## Antecedente de Córdoba

`[VERIFICADO]` Se registra al menos un caso en **Córdoba** (Juzgado de 50ª Nominación) donde se **rechazó el cobro ejecutivo de expensas** en un barrio que **no reunía las características de barrio cerrado/country**: calles y veredas públicas, alumbrado público, plazas públicas, y **sin espacios comunes de uso exclusivo** de los residentes. El demandado planteó además la **superposición** entre lo que se le cobraba y los impuestos que ya paga como cualquier vecino de la ciudad.

**Lección para el producto:** no alcanza la figura jurídica; también pesa si el barrio **materialmente** tiene espacios comunes propios. Se conecta directamente con la zona gris de encuadre URE (ver `municipal/cordoba-capital/01-ure-y-uso-del-suelo.md`).

`[A VERIFICAR]` Falta cargar jurisprudencia del **TSJ de Córdoba** y de las **Cámaras Civiles y Comerciales de Córdoba** específicamente sobre este punto. Es el vacío más importante de esta carpeta.

## Reglas de negocio que se derivan

1. El sistema **no debe asumir** que la deuda de expensas es ejecutable. Debe registrar, por barrio: figura jurídica, si se adecuó, si hay reglamento inscripto, y si existe pacto de ejecutividad.
2. El módulo de cobranzas debe modelar **al menos dos caminos de reclamo** (ejecutivo / ordinario) y sugerir el aplicable según esos datos, siempre marcando **"validar con abogado matriculado"**.
3. El **certificado de deuda** que emita el sistema debe poder generarse con la forma exigida por el art. 2048 y, además, dejar registro del instrumento que sustenta la obligación.
4. Conviene registrar si el barrio tiene **espacios comunes de uso exclusivo** — es un hecho que los tribunales valoran.

## Fuentes

- Análisis del criterio restrictivo y del plenario de 2015:
  `https://abogados.com.ar/un-conjunto-inmobiliario-no-posee-el-derecho-de-reclamar-ejecutivamente-el-cobro-de-las-expensas-adeudadas/19430`
- Análisis del criterio permisivo y del pacto de ejecutividad:
  `https://camoron.org.ar/nuevas-normas/derecho-procesal/el-certificado-de-deuda-de-expensas-y-la-adecuacion-de-los-conjuntos-inmobiliarios-preexistentes/`
- Certificado de deuda como título ejecutivo — panorama:
  `https://abogados.com.ar/el-certificado-de-deuda-de-expensas-expedido-por-un-conjunto-inmobiliario-preexistente-al-ccycn-es-considerado-titulo-ejecutivo-para-su-cobro/30137`
- Plenario 2023 (verificar tribunal y carátula):
  `https://aldiaargentina.microjuris.com/2023/10/02/fallos-plenario-tiene-fuerza-ejecutiva-el-certificado-de-deuda-por-expensas-emitido-por-un-conjunto-inmobiliario-preexistente-a-la-fecha-de-entrada-en-vigencia-del-cccn-aunque-no-este-sometido-al-d/`
- Caso de Córdoba (50ª Nom.):
  `https://www.abogadovergara.com.ar/2019/12/rechazan-cobro-ejecutivo-de-expensas.html`
- Doctrina en SAIJ: `https://www.saij.gob.ar/ivan-di-chiazza-cobro-ejecutivo-expensas-clubes-campo-barrios-cerrados-dacf110018-2011-04-01/123456789-0abc-defg8100-11fcanirtcod`

**Buscadores para completar Córdoba:** TSJ Córdoba (jurisprudencia provincial) y SAIJ (`saij.gob.ar`) con filtro por jurisdicción.
