---
name: municipal-readme
description: Índice y cuadro comparativo de los municipios relevados. Leer antes de dar de alta un barrio.
jurisdiccion: cordoba
nivel: municipal
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# Municipios — índice y comparativo

## Por qué esta capa importa

`[VERIFICADO]` El **art. 2075, 1er párrafo del CCyC** remite todo lo urbanístico (zonas autorizadas, dimensiones, usos, cargas) a **las normas administrativas de cada jurisdicción**. Por eso el encuadre urbanístico de un barrio es **municipal**, y varía radicalmente entre localidades vecinas.

Recordar el modelo de **tres capas**: nacional (CCyC) → provincial RMC (Leyes 9841 y 9687) → municipal (ordenanzas). Ver `provincial/03-region-metropolitana-uso-suelo.md`.

## Cuadro comparativo

| Municipio | ¿Permite nuevas urbanizaciones cerradas? | Régimen identificado | Normativa publicada online | Potencial de mercado |
|-----------|------------------------------------------|----------------------|----------------------------|----------------------|
| **Córdoba capital** | Sí, bajo régimen URE | **Ord. 8606/91** (URE) + Ord. 8060, 8133, 8256 | ✅ Digesto completo | Alto (ciudad grande) |
| **La Calera** | Sí | Sin régimen general identificado; **ordenanzas por barrio** | ⚠️ Parcial — las de barrios no se publican | **El más alto** |
| **Mendiolaza** | Sí | Sin régimen general identificado | ⚠️ Parcial | Medio-alto (ejido ampliado 2021) |
| **Villa Allende** | Sí | **Ord. 43/18 y 37/19** + ordenanza de cierre de calles (2025) | ✅ PDFs en el Concejo | Medio |
| **Unquillo** | ❌ **No — prohibido desde 2014** | Código de Edificación y Urbanización | ✅ Parcial | Bajo (mercado cerrado) |

`[A VERIFICAR]` **Río Ceballos** aparece como el otro municipio del corredor que nunca aprobó countries ni barrios cerrados, aunque en la práctica hay barrios sobre la ruta E-53 con características de urbanización privada. Candidato a relevar si se expande el alcance.

## Lo que hay que registrar por barrio

De este relevamiento salen los campos municipales que el sistema debe guardar:

| Campo | Por qué |
|-------|---------|
| `municipio` | Determina toda la capa normativa aplicable |
| `encuadre_urbanistico` | URE / loteo abierto / cierre de calles autorizado / sin encuadre |
| `instrumento_aprobacion` | La ordenanza particular que aprobó esa urbanización (clave en La Calera) |
| `servicios_internos_a_cargo_de` | Municipio vs. urbanización — define tratamiento tarifario |
| `tiene_espacios_comunes_exclusivos` | Hecho valorado por los tribunales en juicios de cobro |
| `manzana` y `lote` | Formato que exige la IPJ para fijar sede social |
| `nomenclatura_catastral` | Permite validar contra IDECOR/MapasCórdoba |

⚠️ Nótese que **`encuadre_urbanistico` es independiente de `figura_juridica`**. Un barrio puede ser SA sin ser URE, o URE administrada por asociación civil.

## Los cuatro tipos de cliente identificados

1. **Urbanización con encuadre formal** (URE u equivalente local).
2. **Barrio cerrado de hecho, sin encuadre** — cierra perímetro pero no encuadra (lotes chicos).
3. **Barrio abierto con cierre de calles autorizado** — calles públicas, ordenanza de seguridad vecinal (caso Villa Allende 2025).
4. **Propiedad horizontal clásica** — edificio.

Los tipos 2 y 3 son los más delicados: el cobro puede no ser ejecutable. Ver `jurisprudencia/01-ejecutividad-expensas.md`.

## Para agregar un municipio nuevo

Copiar `_PLANTILLA-municipio.md` a `<municipio>/01-uso-del-suelo.md` y responder sus seis preguntas.
