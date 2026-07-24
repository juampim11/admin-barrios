---
name: region-metropolitana-uso-suelo
description: Capa provincial de uso del suelo en la Región Metropolitana de Córdoba — Leyes 9841 y 9687, IPLAM e IDECOR. Aplica a La Calera, Villa Allende, Mendiolaza y Unquillo.
jurisdiccion: cordoba
nivel: provincial
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# Región Metropolitana de Córdoba — capa provincial de uso del suelo

## Corrección a la corrección anterior

En `municipal/cordoba-capital/01-ure-y-uso-del-suelo.md` señalé que el régimen de urbanizaciones cerradas es **municipal**. Eso sigue siendo cierto **para el régimen URE específico**, pero está incompleto: **existe además una capa provincial** que alcanza a toda la Región Metropolitana, y que es directamente aplicable a los municipios de interés (La Calera, Villa Allende, Mendiolaza, Unquillo).

**Modelo mental correcto — tres capas superpuestas:**

| Capa | Qué regula | Norma |
|------|-----------|-------|
| Nacional | Derecho real, expensas, órganos | CCyC |
| **Provincial (RMC)** | **Usos del suelo a escala metropolitana** | **Leyes 9841 y 9687** |
| Municipal | Fraccionamiento, uso, ocupación, régimen de urbanizaciones cerradas | Ordenanzas de cada localidad |

## Las normas provinciales

`[VERIFICADO]`

**Ley 9841 (2011) — Regulación de los usos del suelo en la Región Metropolitana de Córdoba.** Establece el **Plan Metropolitano de Usos del Suelo**, con **13 categorías** de uso (área urbana consolidada, urbanización diferida, industrial incompatible, natural protegida, entre otras).

**Ley 9687 (2009) — Plan Director / Plan Vial Director para la Región Metropolitana de Córdoba.** `[A VERIFICAR]` La denominación exacta aparece de dos formas en las fuentes consultadas ("Plan Director" y "Plan Vial Director"). Confirmar el título oficial en el Boletín Oficial provincial antes de citarla formalmente.

`[VERIFICADO]` Ambas leyes **alcanzan con sus disposiciones y recomendaciones el territorio de los municipios de la RMC**, que deben compatibilizar su normativa local con las políticas regionales. La RMC comprende del orden de **56 localidades**.

**Organismo:** el **IPLAM (Instituto de Planificación del Área Metropolitana)** es el que materializa esta planificación a escala regional.

## Herramienta operativa muy valiosa para el sistema

`[VERIFICADO]` El **mapa del Plan Metropolitano de Usos del Suelo está publicado en IDECOR / MapasCórdoba**, y —clave— **está integrado con el catastro parcelario**: permite buscar una propiedad por **nomenclatura catastral o número de cuenta** y obtener en qué **jurisdicción (localidad)** está y en qué **categoría de uso del suelo** cae.

**Impacto directo en el producto:** al dar de alta un barrio o una unidad funcional, el sistema puede **validar y enriquecer** los datos contra esta fuente pública: confirmar el municipio, la categoría de uso del suelo, y la nomenclatura catastral. Es una integración de alto valor y bajo costo.

`[A VERIFICAR]` Confirmar si IDECOR expone una **API o servicio WMS/WFS** además del visor web, para automatizar la consulta en vez de hacerla manual.

## Otras normas provinciales relacionadas

`[A VERIFICAR]` Aparecieron mencionadas en ordenanzas municipales y conviene cargarlas:
- **Ley 10208** — política ambiental provincial (Córdoba).
- **Ley 9814** — Ordenamiento Territorial de Bosques Nativos de Córdoba.
- **Ley 25675** (nacional) — Ley General del Ambiente.

⚠️ **Cuidado con una confusión detectada:** una ordenanza municipal consultada se refiere a "la ley provincial de bosques 9841". Eso parece un **error de la propia ordenanza**: 9841 es la de usos del suelo metropolitanos, y la de bosques nativos sería la **9814** (números muy parecidos). **Verificar antes de citar cualquiera de las dos.** Es un buen ejemplo de por qué el agente no debe copiar números de artículo o de ley sin contrastar la fuente primaria.

## Fuentes

- Ley 9841 en SAIJ:
  `https://www.saij.gob.ar/legislacion/ley-cordoba-9841-regulacion_usos_suelo_puesta.htm`
- Mapa del Plan Metropolitano de Usos del Suelo (visor):
  `https://mapascordoba.gob.ar/viewer/mapa/43`
- IDECOR — nota de publicación del mapa, con explicación de categorías e integración catastral:
  `https://www.idecor.gob.ar/accede-al-mapa-del-plan-metropolitano-de-usos-del-suelo-de-cordoba/`
- Boletín Oficial de Córdoba (para textos oficiales de 9841 y 9687):
  `https://boletinoficial.cba.gov.ar`
