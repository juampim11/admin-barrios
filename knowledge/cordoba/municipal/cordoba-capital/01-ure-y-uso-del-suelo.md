---
name: ure-cordoba-capital
description: Régimen de Urbanizaciones Residenciales Especiales (URE) y ordenanzas de suelo de la Ciudad de Córdoba. El régimen de barrios cerrados acá es MUNICIPAL.
jurisdiccion: cordoba
nivel: municipal
municipio: cordoba-capital
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# Ciudad de Córdoba — URE y ordenanzas de suelo

## ⚠️ Corrección importante al supuesto de partida

La guía de carga original asumía que el régimen de urbanizaciones/barrios cerrados sería **provincial**. **No es así en la Ciudad de Córdoba: es municipal.**

`[VERIFICADO]` Esto es coherente con el **art. 2075, 1er párrafo del CCyC**, que remite expresamente todo lo urbanístico (zonas autorizadas, dimensiones, usos, cargas) a **las normas administrativas de cada jurisdicción**.

**Consecuencia para el sistema:** el conocimiento urbanístico es **por municipio**, y hay más de 400 municipios y comunas en la provincia. La carpeta debe organizarse como `municipal/<municipio>/`, y el sistema debe registrar **en qué municipio está cada barrio**.

## El régimen URE

`[VERIFICADO]` Las **Urbanizaciones Residenciales Especiales (URE)** están reguladas por la **Ordenanza N° 8606/91**, con modificatorias —entre ellas la **N° 10.760/04** y la **N° 12.108**—.

Notas verificadas del régimen:

- **Superficie mínima de lote.** Las URE se diferencian del loteo abierto por exigir lotes de **1.000 m² a 1.500 m² como mínimo según la zona**, perímetro cerrado, y constituirse como entidades jurídicas que administran internamente sus servicios.

- **Inseparabilidad de áreas (art. 3°).** Las superficies afectadas al **área recreativa** no pueden enajenarse ni cederse por separado del área residencial. Ambas constituyen **un conjunto inmobiliario**, garantizado a perpetuidad mediante relaciones jurídicas con la sub-administración.

- **Prohibición de publicidad engañosa (art. 21°, texto s/ Ord. 12.108).** Está **prohibido publicitar, ofrecer o comercializar** usando los términos **"privados", "cerrados", "cerrados en altura" o "country"** en emprendimientos que no estén autorizados bajo el régimen URE. La ordenanza prevé consecuencias: darlo a conocer públicamente, notificar al colegio profesional del profesional actuante, y no otorgar factibilidad a nuevas iniciativas en caso de reincidencia.

## La zona gris (relevante para el producto)

`[VERIFICADO]` Existe una tensión documentada: proliferaron emprendimientos que **cierran su perímetro y se promocionan como "barrio cerrado" pero tienen lotes menores a 1.000 m²**, por lo que **no encuadran en el régimen URE**. Al no encuadrar, en algunos casos reclaman al municipio la prestación de servicios (barrido, limpieza, mantenimiento) que una URE debe autoadministrar.

**Impacto en el sistema:** habrá clientes reales que son **"barrios cerrados de hecho" sin encuadre URE**. El modelo de datos debería distinguir:
- `figura_juridica` (SA, asociación civil, PH especial, fideicomiso) — el **quién administra**.
- `encuadre_urbanistico` (URE autorizada / loteo abierto / sin encuadre) — el **qué es urbanísticamente**.

Son dos ejes independientes. Un barrio puede ser SA sin ser URE, o URE administrada por asociación civil.

Este caso además cambia el análisis contable: si el municipio presta los servicios y además el barrio cobra por lo mismo, hay **superposición entre tasas municipales y expensas privadas** —un punto que aparece efectivamente litigado (ver `jurisprudencia/`)—.

## Marco de suelo de la ciudad

`[VERIFICADO]` El marco normativo urbano de la Ciudad de Córdoba se apoya en tres ordenanzas principales, todas de mediados de los '80, con numerosas modificaciones acumuladas:

| Materia | Ordenanza |
|---------|-----------|
| Ocupación del suelo | 8256/86 y 8057/85 |
| Uso del suelo | 8133/85 |
| Fraccionamiento del suelo | 8060/85 |

`[A VERIFICAR]` Una fuente secundaria atribuye a la **Ord. 8060/85** el rol de "normativa de suelo" general orientada a regular el crecimiento por expansión a baja densidad, lo que difiere levemente de la asignación del portal municipal. **Confirmar contra el Digesto** cuál regula qué antes de citar.

⚠️ Por la cantidad de modificatorias acumuladas, **siempre bajar el texto consolidado del Digesto**, nunca una copia suelta.

## Cómo cargar otros municipios

Para cada municipio donde el sistema tenga barrios, crear `municipal/<municipio>/` y cargar:
- Ordenanza de uso, ocupación y fraccionamiento del suelo.
- Régimen de urbanizaciones especiales/cerradas, si existe.
- Código de Edificación.
- Tasas municipales que inciden sobre los inmuebles del barrio.

Fuente típica: **Digesto Municipal** o sitio del **Concejo Deliberante** de la localidad.

## Fuentes

- **Digesto Municipal de Córdoba**: `https://static.cordoba.gov.ar/DigestoWeb/`
- Ordenanza 8606 (URE), PDF oficial:
  `https://static.cordoba.gov.ar/DigestoWeb/pdf/87ff95ad-5f06-4113-8917-ee80465c596f/ORD_8606.pdf`
- Marco normativo urbano de la ciudad (portal de gobierno abierto, con mapa interactivo por parcela):
  `https://gobiernoabierto.cordoba.gob.ar/data/datos-abiertos/categoria/geografia-y-mapas/planeamiento-urbano/3011`
- Análisis del debate URE / barrios cerrados fuera de encuadre (fuente secundaria):
  `https://cafedelasciudades.com.ar/articulos/cerrando-barrios/`

---

## 💰 Hallazgo fiscal municipal: adicional del 25% para inmuebles en URE

`[VERIFICADO]` La Ordenanza Tarifaria de la Ciudad de Córdoba establece que **por los inmuebles situados en urbanizaciones residenciales especiales se abona un adicional del veinticinco por ciento (25%) sobre el importe de la obligación tributaria**, conforme al **art. 7° de la Ordenanza 8606** y sus modificatorias.

**Y la excepción es lo más importante:** ese adicional **no se aplica cuando la administración asume la prestación de los servicios públicos internos** en el instrumento de aprobación de la urbanización.

**Por qué es un hallazgo grande:**
1. Es la **respuesta municipal a la superposición** entre tasa municipal y expensa privada. Si el barrio se autoabastece de servicios, no paga el recargo; si no, paga 25% más.
2. Confirma que **el instrumento de aprobación de cada urbanización define qué servicios presta quién**. Ese documento es un dato de primera clase por barrio.
3. Para el agente `contador`: al comparar la carga fiscal de un barrio, hay que saber **si le corresponde el adicional o la excepción**.

`[VERIFICADO]` También existe tratamiento tarifario específico para las **parcelas de uso común sin mejoras cubiertas ubicadas en urbanizaciones residenciales especiales**, destinadas a actividades deportivas, recreativas y sociales que no constituyan espacios verdes del Dominio Público Municipal (referencia al art. 1° inc. d) de la Ord. 8606).

`[A VERIFICAR]` **Confirmar el número y año de la Ordenanza Tarifaria vigente.** Las referencias localizadas corresponden a ordenanzas de años anteriores (13120 y 13439); la tarifaria se dicta anualmente.

**Regla de negocio:** el sistema debe registrar, por barrio, **quién presta cada servicio público interno** (municipio vs. urbanización). Determina el tratamiento tarifario y es una de las causas de conflicto con los propietarios.

Fuentes:
- Ordenanza Tarifaria (ejemplo con el art. del adicional del 25%):
  `https://boletinmunicipal.cordoba.gob.ar/static/publicaciones/publicacion_2021_00001503/pub_2021_00001503_vistaprevia.pdf`
- Ordenanza 13439 (parcelas de uso común en URE):
  `https://static01.cordoba.gob.ar/boe/publicaciones/publicacion_2023_00003836/pub_2023_00003836_vistaprevia.pdf`
- Digesto Municipal (buscador): `https://servicios2.cordoba.gov.ar/DigestoWeb/index.aspx`
