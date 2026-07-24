---
name: personas-juridicas-ipj-cordoba
description: Organismo de personas jurídicas de Córdoba (IPJ), Ley 8652 y estado de la cuestión sobre adecuación de conjuntos inmobiliarios en la provincia.
jurisdiccion: cordoba
nivel: provincial
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# Personas jurídicas en Córdoba — IPJ

## El organismo

`[VERIFICADO]` En Córdoba, el órgano de aplicación del régimen de personas jurídicas es la **Dirección de Inspección de Personas Jurídicas (IPJ)**, creada como órgano de aplicación por la **Ley provincial 8652**. Entre sus funciones:

- Tiene a su cargo las **funciones del Registro Público** en el ámbito provincial.
- Respecto de **asociaciones civiles y fundaciones**: autoriza su funcionamiento, aprueba estatutos y reformas, y las fiscaliza de forma permanente.
- Controla sociedades constituidas en el extranjero o en otra jurisdicción que operen habitualmente en la provincia.

`[VERIFICADO]` Sitio oficial: **ipj.cba.gov.ar**. Los trámites se gestionan digitalmente a través de **CiDi (Ciudadano Digital Córdoba)**.

`[A VERIFICAR]` La dependencia ministerial del organismo ha cambiado entre gestiones (la Ley 8652 lo ubica bajo el entonces Ministerio de Asuntos Institucionales y Desarrollo Social). **Confirmar la dependencia y denominación vigentes** en el sitio oficial antes de citarlo formalmente.

## Detalle operativo útil

`[VERIFICADO]` La IPJ exige que la **sede social se fije de manera precisa e indubitable**. Para barrios cerrados, el formato aceptado es del tipo *Country "XX", Manzana 8, Lote 2, Villa Allende*. **No** admite referencias no perdurables (carteles, nombres de negocios, color de una casa) ni domicilios vagos ("zona rural", "calle pública s/n").

**Impacto en el sistema:** el modelo de datos del barrio y de las unidades funcionales debería contemplar **manzana y lote** como campos estructurados, no solo una dirección libre. Es el formato que la propia autoridad de contralor requiere.

## ⚠️ Hueco identificado: adecuación de conjuntos inmobiliarios en Córdoba

`[NO ENCONTRADO]` **No se localizó una resolución de la IPJ de Córdoba equivalente a las RG 25/2020, 27/2020 o 4/2024 de la IGJ nacional**, es decir, una norma provincial que intime o reglamente la adecuación de conjuntos inmobiliarios preexistentes.

Esto puede significar tres cosas distintas, y **no hay que asumir cuál**:
1. Que Córdoba no dictó una norma específica sobre el punto.
2. Que existe pero no está indexada públicamente de forma accesible.
3. Que el criterio se aplica por vía de dictámenes o resoluciones particulares, no de una resolución general.

**Acción pendiente (alta prioridad):** consultar directamente a la IPJ o a un abogado matriculado en Córdoba. Hasta entonces, el agente `legal-ph` debe responder **"no tengo fuente cargada sobre el criterio de adecuación en Córdoba"** y **no debe extrapolar el criterio de la IGJ nacional como si fuera aplicable**.

Este hueco es relevante para el producto: define si un barrio-SA cordobés está o no bajo presión regulatoria de adecuarse.

## Otras fuentes a cargar

`[A VERIFICAR]`
- Resoluciones generales de IPJ Córdoba sobre asociaciones civiles y sociedades (requisitos de estatuto, asambleas, presentación de estados contables).
- Requisitos de designación e inscripción de autoridades (relevante para modelar el órgano de administración de cada barrio).

## Fuentes

- Ley provincial 8652 — Régimen de las personas jurídicas en Córdoba:
  `https://www.argentina.gob.ar/normativa/provincial/ley-8652-123456789-0abc-defg-256-8000ovorpyel/actualizacion`
- IPJ Córdoba (sitio oficial): `https://ipj.cba.gov.ar/`
- Boletín Oficial de la Provincia de Córdoba: `https://boletinoficial.cba.gov.ar`
