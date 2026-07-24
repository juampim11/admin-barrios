---
name: fuentes-manifest
description: Manifiesto de descargas y registro de huecos pendientes. Qué bajar, de dónde, y qué falta verificar.
jurisdiccion: cordoba
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# Manifiesto de fuentes y huecos pendientes

## Parte 1 — Qué descargar (fuentes oficiales)

Guardar cada texto junto al archivo de conocimiento que lo cita, con el nombre indicado y **anotando la fecha de descarga**.

### Nacional

| Norma | Dónde | Guardar como |
|-------|-------|--------------|
| CCyC (Ley 26.994) texto actualizado | `https://servicios.infoleg.gob.ar/infolegInternet/anexos/235000-239999/235975/texact.htm` | `nacional/fuentes/ccyc-texto-actualizado.html` |
| Ley 19.550 texto actualizado | `https://www.argentina.gob.ar/normativa/nacional/ley-19550-25553/actualizacion` | `nacional/fuentes/ley-19550-actualizada.html` |
| IGJ RG 4/2024 | `https://www.boletinoficial.gob.ar/detalleAviso/primera/302578/20240214` | `nacional/fuentes/igj-rg-4-2024.html` |

⚠️ El CCyC es enorme. Conviene extraer y guardar por separado los bloques que usa el sistema: PH (2037 y ss.), conjuntos inmobiliarios (2073–2086), asociaciones civiles, fideicomiso.

### Provincial (Córdoba)

| Norma | Dónde | Guardar como |
|-------|-------|--------------|
| Ley 8652 (personas jurídicas / IPJ) | `https://www.argentina.gob.ar/normativa/provincial/ley-8652-123456789-0abc-defg-256-8000ovorpyel/actualizacion` | `provincial/fuentes/ley-8652.html` |
| Código Tributario (Ley 6006 t.o.) | `https://www.argentina.gob.ar/normativa/provincial/ley-6006-123456789-0abc-defg-600-6001ovorpyel/actualizacion` | `provincial/fuentes/codigo-tributario.html` |
| Ley 10117 (modificatoria — inciso de expensas) | `https://www.argentina.gob.ar/normativa/provincial/ley-10117-123456789-0abc-defg-711-0100ovorpyel/actualizacion` | `provincial/fuentes/ley-10117.html` |
| Rentas — IIBB, exenciones (texto vigente) | `https://www.rentascordoba.gob.ar/cms/cs-impuesto-sobre-los-ingresos-brutos-cap-4-5-6/` | `provincial/fuentes/rentas-iibb-exenciones.html` |
| Resolución CV 018/2012 (expensas e IIBB) | `https://www.rentascordoba.gob.ar/cms/wp-content/uploads/2022/06/CV18-Ingresos-Brutos-Expensas-Comunes.pdf` | `provincial/fuentes/cv-018-2012.pdf` |
| **Ley impositiva anual vigente** | Boletín Oficial Córdoba / Rentas | `provincial/fuentes/ley-impositiva-<año>.pdf` |

### Municipal (Córdoba capital)

| Norma | Dónde | Guardar como |
|-------|-------|--------------|
| Ordenanza 8606 (URE) | `https://static.cordoba.gov.ar/DigestoWeb/pdf/87ff95ad-5f06-4113-8917-ee80465c596f/ORD_8606.pdf` | `municipal/cordoba-capital/fuentes/ord-8606-ure.pdf` |
| Ord. 8060/85 (fraccionamiento) | Digesto: `https://static.cordoba.gov.ar/DigestoWeb/` | `.../ord-8060.pdf` |
| Ord. 8133/85 (uso del suelo) | Digesto | `.../ord-8133.pdf` |
| Ord. 8256/86 y 8057/85 (ocupación) | Digesto | `.../ord-8256.pdf` |
| Modificatorias de URE (10.760/04, 12.108) | Digesto | `.../ord-10760.pdf`, `.../ord-12108.pdf` |

---

## Parte 2 — Huecos pendientes, por prioridad

### 🔴 Prioridad alta (bloquean respuestas correctas)

1. **`[NO ENCONTRADO]` Criterio de adecuación de la IPJ Córdoba.** No se halló resolución provincial equivalente a las RG de IGJ. Define si un barrio-SA cordobés está bajo presión de adecuarse. → Consultar IPJ o abogado matriculado.

2. **`[A VERIFICAR]` Efecto jurídico exacto del inciso de expensas del Código Tributario** (Ley 10117): ¿excluye de base imponible, exime, u otra cosa? Se conoce el supuesto alcanzado, no la consecuencia. → Leer el artículo completo en el texto ordenado vigente.

3. **`[A VERIFICAR]` Numeración vigente del Código Tributario.** Se detectaron tres numeraciones distintas para materias afines (205 / 208 / 241) según la recopilación. → Fijar la numeración del t.o. vigente antes de que el agente `contador` cite cualquier artículo.

4. **`[A VERIFICAR]` Modificaciones recientes al CCyC.** Hay referencias a una Ley 27.799 y a un Decreto 338/2025 en repositorios oficiales. → Confirmar si afectan los artículos de PH/conjuntos inmobiliarios.

5. **`[A VERIFICAR]` Jurisprudencia del TSJ y de las Cámaras Civiles y Comerciales de Córdoba** sobre ejecutividad de expensas. Es el vacío más grande: hoy casi toda la jurisprudencia cargada es de CABA/Buenos Aires.

### 🟡 Prioridad media

6. Ley impositiva anual vigente (alícuotas IIBB y Sellos).
7. Impuesto Inmobiliario: sujeto pasivo según figura, sobre todo en barrio-SA donde los comunes están a nombre de la sociedad.
8. Impuesto de Sellos sobre contratos del ente.
9. Regímenes de retención/percepción aplicables al pagar proveedores.
10. Resoluciones generales de IPJ Córdoba sobre asambleas, estatutos y presentación de estados contables.
11. Identificación precisa del plenario de 2023 (tribunal, carátula, ámbito territorial).

### 🟢 Prioridad baja / incremental

12. Ordenanzas de otros municipios (a medida que entren barrios de esas localidades).
13. Códigos de edificación locales.
14. Régimen de fideicomiso y asociaciones civiles en el CCyC (articulado y numeración).
15. Verificar si existe encuadre por **geodesia** en Córdoba (el precedente conocido, Decreto 9404/86, es de Buenos Aires).

---

## Parte 3 — Correcciones a la guía original

Dos supuestos de `guia-carga-conocimiento.md` resultaron inexactos:

1. **El régimen de urbanizaciones (URE) no es provincial: es municipal.** En la Ciudad de Córdoba lo regula la Ordenanza 8606/91. Es coherente con el art. 2075, 1er párrafo del CCyC, que remite lo urbanístico a las normas administrativas de cada jurisdicción. → La carpeta `municipal/` es más importante de lo previsto, y hay que organizarla por municipio.

2. **La afirmación de que "la vía ejecutiva de PH no aplica automáticamente a la SA" es correcta pero incompleta.** No es solo la figura: pesa también si el barrio se adecuó, si hay reglamento inscripto, si hay pacto de ejecutividad, y si materialmente tiene espacios comunes de uso exclusivo. → Ver `jurisprudencia/01-ejecutividad-expensas.md`.

Además, un hallazgo que la guía no anticipaba: el Código Tributario de Córdoba **ya contempla expresamente** countries, clubes de campo y barrios cerrados, e incluso menciona las **"cuotas sociales permanentes y de pago periódico"** —la forma típica del barrio-SA—. El legislador provincial ya reconoció esta realidad.

---

## Parte 4 — Ampliación: expensas y municipios de Sierras Chicas (2ª pasada)

### Nuevas descargas

| Norma | Dónde | Guardar como |
|-------|-------|--------------|
| Ley 9841 (usos del suelo RMC) | `https://www.saij.gob.ar/legislacion/ley-cordoba-9841-regulacion_usos_suelo_puesta.htm` | `provincial/fuentes/ley-9841.html` |
| Ley 9687 (Plan Director RMC) | Boletín Oficial Córdoba | `provincial/fuentes/ley-9687.pdf` |
| Villa Allende Ord. 43/18 | `http://cd.villaallende.gob.ar/ordenanzas/43-18%20Fraccionamiento%20Uso%20de%20Suelo.pdf` | `municipal/villa-allende/fuentes/ord-43-18.pdf` |
| Villa Allende Ord. 37/19 | `http://cd.villaallende.gov.ar/ordenanzas/37-19%20ORD.%20USO%20DE%20SUELO%20+%20PLANOS%20ANEXOS.pdf` | `municipal/villa-allende/fuentes/ord-37-19.pdf` |

### Nuevos huecos

🔴 **Alta**
- **Unquillo:** ordenanza restrictiva de urbanizaciones cerradas (aprox. 2014). Número, texto y vigencia. Define si hay mercado nuevo en esa localidad.
- **Villa Allende:** ordenanza de cierre de calles (2025). Número, texto y estado. Crea un tipo de cliente que no estábamos modelando.
- **Inquilinos:** estado actual del reparto propietario/locatario de expensas extraordinarias tras la derogación de la Ley 27.551 por el DNU 70/2023.
- **La Calera y Mendiolaza:** no se relevó normativa municipal propia. Es lo que falta para cubrir los cuatro municipios.

🟡 **Media**
- Título oficial exacto de la Ley 9687 ("Plan Director" vs "Plan Vial Director").
- Confusión detectada entre **Ley 9841** (usos del suelo RMC) y **Ley 9814** (bosques nativos) en el texto de una ordenanza municipal. Verificar cuál corresponde en cada mención.
- Relación de vigencia entre las ordenanzas de Villa Allende 43/18 y 37/19.
- Régimen de intereses por mora en expensas y criterios de morigeración en tribunales de Córdoba.
- ¿IDECOR expone API o servicio WMS/WFS, además del visor web?

### Corrección adicional a la guía

A las dos correcciones ya registradas se suma una tercera, que matiza la primera:

3. **Sí existe una capa provincial de uso del suelo**, al menos para la Región Metropolitana: las **Leyes 9841 y 9687** alcanzan el territorio de los municipios de la RMC (incluidos La Calera, Villa Allende, Mendiolaza y Unquillo). Lo que es estrictamente municipal es el **régimen de urbanización cerrada** (tipo URE). El modelo correcto es de **tres capas superpuestas**: nacional (CCyC) → provincial (RMC) → municipal (ordenanzas).

---

## Parte 5 — Cierre de la capa municipal (3ª pasada)

### Sitios oficiales confirmados

| Municipio | Sitio | Estado de publicación |
|-----------|-------|-----------------------|
| Córdoba capital | `https://servicios2.cordoba.gov.ar/DigestoWeb/index.aspx` | Digesto completo y buscable |
| La Calera | `https://lacalera.gob.ar/` | Boletines por año; ordenanzas de barrios NO publicadas |
| Mendiolaza | `https://www.mendiolaza.gob.ar/concejo-deliberante/` | Concejo Deliberante |
| Villa Allende | `http://cd.villaallende.gov.ar/` | PDFs de ordenanzas |
| Unquillo | `https://unquillo.gov.ar/` | Código de Edificación en PDF |

### Nuevas descargas

| Norma | Dónde |
|-------|-------|
| Unquillo — Código de Edificación y Urbanización | `https://unquillo.gov.ar/wp-content/uploads/2024/07/municipalidad_unquillo_-_cod_edif_modif.pdf` |
| Córdoba — Ordenanza Tarifaria (adicional 25% URE) | `https://boletinmunicipal.cordoba.gob.ar/static/publicaciones/publicacion_2021_00001503/pub_2021_00001503_vistaprevia.pdf` |
| Córdoba — Ord. 13439 (parcelas de uso común en URE) | `https://static01.cordoba.gob.ar/boe/publicaciones/publicacion_2023_00003836/pub_2023_00003836_vistaprevia.pdf` |

### Huecos municipales que quedan

🔴 **Alta**
- **Unquillo:** número y texto de la ordenanza de 2014 que prohíbe nuevos countries/barrios cerrados. Confirmado que existe y su alcance (solo hacia adelante), pero falta la norma.
- **Villa Allende:** número y texto de la ordenanza de cierre de calles (2025).
- **La Calera y Mendiolaza:** ordenanzas generales de uso, fraccionamiento y ocupación del suelo. No indexadas públicamente; probablemente haya que pedirlas al municipio.
- **La Calera:** por cada barrio-cliente, su **ordenanza particular de aprobación** (vía Dirección de Obras Privadas). Es un dato de onboarding, no una carga única.

🟡 **Media**
- Ordenanza Tarifaria **vigente** de cada municipio (las referencias localizadas son de años anteriores).
- Mendiolaza: zonificación del territorio incorporado con la ampliación de ejido de 2021 y normativa posterior.
- Mendiolaza: estado actual del proyecto El Terrón (judicializado en 2014).
- Río Ceballos: relevar si se amplía el alcance geográfico.

### Correcciones y hallazgos de esta pasada

4. **La Calera maneja ordenanzas por barrio**, no publicadas online. Implica que el **instrumento de aprobación de cada urbanización** es un dato de primera clase del modelo de datos, y un ítem de onboarding del cliente.

5. **Córdoba capital cobra un adicional del 25%** sobre la obligación tributaria a los inmuebles en URE, **excepto que la administración asuma la prestación de los servicios públicos internos**. Es la respuesta municipal a la superposición tasa/expensa, y obliga a registrar **quién presta cada servicio** en cada barrio.

6. **Los municipios divergen radicalmente entre sí**: Unquillo prohíbe, Mendiolaza triplicó su ejido, La Calera crece. La capa municipal no es un detalle de configuración: es un eje del producto.

---

## Parte 6 — Cierre del núcleo de dominio (4ª pasada)

Se completaron los bloques que faltaban: **asambleas y administración** (`nacional/05`) y **especificidades de conjuntos inmobiliarios** (`nacional/06`). Se agregó `REQUISITOS-MODELO-DATOS.md`, que consolida todas las reglas de negocio derivadas.

### Nuevas fuentes

| Recurso | Dónde |
|---------|-------|
| CCyC arts. 2073-2113 (acceso por artículo) | `https://codigocivilonline.com.ar/conjuntos-inmobiliarios-arts-2073-a-2113/` |
| PDF oficial arts. 2073-2113 | `https://www.rpba.gob.ar/files/Normas/Leyes/CCCN2073-2113.pdf` |
| Doctrina sobre asambleas y mayorías (Revista del Notariado) | `https://www.revista-notariado.org.ar/index.php/2019/11/la-asamblea-como-organo-del-consorcio-de-propiedad-horizontal-mayorias-para-resolver/` |
| Análisis de conjuntos inmobiliarios (Colegio de Escribanos BA) | `https://www.colescba.org.ar/servicios/comunidad/codigo/archivos/fc03v2-Conjuntos-inmobiliarios.pdf` |
| Criterio registral CABA sobre modificación de reglamento (2019) | `https://servicios.infoleg.gob.ar/infolegInternet/anexos/330000-334999/330848/norma.htm` |

### Huecos que quedan del núcleo

🟡 **Media**
- **Art. 2061** — cómputo respecto de propietarios ausentes. Afecta cómo se cierra una votación; falta el texto.
- **Art. 2082** — cesión de la unidad. Falta el texto y su alcance.
- **Art. 2056** — contenido obligatorio del reglamento. Conviene cargarlo completo: es la lista de lo que el sistema debe poder parametrizar por barrio.
- Criterio registral aplicable **en Córdoba** para la modificación del reglamento (el localizado es de CABA).
- Régimen de intereses por mora en expensas y criterios de morigeración en tribunales de Córdoba.

### Estado general de la base

| Capa | Estado |
|------|--------|
| Nacional | ✅ Núcleo cubierto (6 archivos). Faltan textos puntuales (2056, 2061, 2082). |
| Provincial | 🟡 Cubierto en lo estructural. Falta confirmar efecto del inciso fiscal y el criterio de adecuación de IPJ Córdoba. |
| Municipal | 🟡 Cinco municipios relevados. Faltan ordenanzas puntuales de Unquillo, Villa Allende, La Calera y Mendiolaza. |
| Jurisprudencia | 🔴 El más débil. Casi todo es de CABA/Buenos Aires; falta Córdoba. |

**Nada de esta base fue validada por un profesional matriculado.** Ese sigue siendo el paso pendiente más importante antes de que los agentes se usen en producción.
