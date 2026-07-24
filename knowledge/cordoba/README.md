---
name: cordoba-knowledge-readme
description: Índice y convenciones de la base de conocimiento de la jurisdicción Córdoba. Leer primero.
jurisdiccion: cordoba
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# Base de conocimiento — jurisdicción Córdoba

> **ESTADO: BORRADOR PARA VALIDACIÓN PROFESIONAL.** Todo el contenido de esta carpeta fue compilado a partir de fuentes públicas y **no ha sido validado por un abogado ni por un contador matriculado**. No es asesoramiento legal ni fiscal. Antes de que el sistema tome cualquier decisión con efecto real (liquidar, reclamar, tributar), un profesional matriculado debe revisar el punto aplicable.

## Cómo leer esta carpeta

- `00-panorama-figuras-juridicas.md` — **empezar por acá**. Panorama transversal de las figuras jurídicas.
- `REQUISITOS-MODELO-DATOS.md` — consolidado de reglas de negocio y campos derivados de toda la base. Insumo directo del diseño.
- `nacional/` — normativa nacional aplicable (rige igual en cualquier provincia):
  - `01` CCyC: PH y conjuntos inmobiliarios · `02` Ley 19.550 y el barrio-SA · `03` adecuación (IGJ), asociaciones civiles y fideicomiso · `04` régimen de expensas · `05` asambleas y administración · `06` especificidades de conjuntos inmobiliarios
- `provincial/` — Córdoba: `01` personas jurídicas (IPJ) · `02` fiscal (IIBB y expensas) · `03` Región Metropolitana (uso del suelo)
- `municipal/` — ordenanzas locales. **Varía por municipio**. Ver `municipal/README.md` para el cuadro comparativo y `_PLANTILLA-municipio.md` para agregar uno nuevo.
- `jurisprudencia/` — criterios de tribunales.
- `_FUENTES.md` — manifiesto de descargas y registro de huecos pendientes.

## Convenciones

**Marcas de confianza.** Cada afirmación lleva una de estas:
- `[VERIFICADO]` — contrastado contra fuente oficial o secundaria confiable, con URL en el archivo.
- `[A VERIFICAR]` — plausible pero sin fuente oficial confirmada. **No usar como base de una decisión.**
- `[NO ENCONTRADO]` — se buscó y no se halló fuente. Puede significar que no existe, o que está en una fuente no pública.

**Numeración de artículos.** Los códigos se renumeran entre textos ordenados (pasa mucho con el Código Tributario de Córdoba). Cuando se cite un número de artículo, verificar contra el **texto ordenado vigente**, no contra una copia vieja.

**Fecha de verificación.** Cada archivo indica cuándo se compiló. Toda norma cambia: revalidar antes de apoyarse en ella.

**No transcribir.** Estos archivos **resumen y apuntan**; no reemplazan al texto oficial. Los textos completos se descargan según `_FUENTES.md` y se guardan junto a cada archivo.

## Regla de oro para los agentes

Si un tema no está cubierto acá, o está marcado `[A VERIFICAR]` / `[NO ENCONTRADO]`, el agente responde **"no tengo esa fuente cargada"** y no completa con conocimiento propio. Ese es el comportamiento correcto, no una falla.
