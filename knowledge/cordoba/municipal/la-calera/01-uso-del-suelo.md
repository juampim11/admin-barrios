---
name: la-calera-uso-suelo
description: La Calera — mayor mercado de urbanizaciones cerradas de los cuatro. Ojo: las ordenanzas de barrios particulares no se publican online.
jurisdiccion: cordoba
nivel: municipal
municipio: la-calera
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# La Calera (Dpto. Colón)

## ⚠️ Hallazgo operativo clave: ordenanzas por barrio

`[VERIFICADO]` El sitio oficial de la Dirección de Obras Privadas indica que **para las ordenanzas de barrios particulares y otras normativas hay que consultar en la Dirección de Obras Privadas** — es decir, **no están publicadas online**.

**Esto es muy relevante y cambia el modelo de datos:** implica que **cada barrio puede tener su propia ordenanza específica** de aprobación, con sus condiciones particulares (qué servicios presta el municipio y cuáles la urbanización, qué se cedió al dominio público, qué obligaciones asumió el desarrollador).

**Consecuencia de diseño:** el sistema debe permitir adjuntar, **por barrio**, su **instrumento municipal de aprobación** y registrar sus condiciones particulares. No alcanza con conocer la ordenanza general del municipio.

**Consecuencia operativa:** para cada barrio-cliente en La Calera hay que **pedirle al administrador su ordenanza de aprobación**, o gestionarla en la Dirección de Obras Privadas. Es un dato de alta que conviene incorporar al onboarding del cliente.

## Contexto de mercado

`[VERIFICADO]` Es una de las localidades con **mayor peso relativo de urbanizaciones cerradas** de la región. Reportes de 2017 indicaban alrededor de un **25% de la población** viviendo en superficies cerradas, con una proyección —atribuida al entonces intendente Rodrigo Rufeil— de que hacia **2030 podría rondar el 40%**.

⚠️ Datos de 2017 con proyecciones; el intendente actual es otro (Fernando Rambaldi). **Contexto de mercado, no dato duro.**

**Lectura comercial:** por volumen y crecimiento, es probablemente el municipio de **mayor potencial** de los cuatro.

`[VERIFICADO]` El municipio participa del **Ente Metropolitano** de la región de Córdoba, lo que refuerza la aplicabilidad de la capa provincial de planificación.

## Marco aplicable

Aplica la capa provincial: Leyes 9841 y 9687 (ver `provincial/03-region-metropolitana-uso-suelo.md`).

## Dónde está la normativa

`[VERIFICADO]` El sitio oficial publica:
- **Boletines Oficiales por año** (sección de descargas).
- Una sección de **Normativa** y las **Ordenanzas Tarifarias** anuales (relevantes para el agente `contador`: definen las tasas municipales sobre inmuebles).
- Formato de numeración de ordenanzas: `Nº 018/CD./2013` (CD = Concejo Deliberante).
- La **Dirección de Obras Privadas** tiene una plataforma online de trámites, desarrollada con el Colegio de Arquitectos de Córdoba.

## Qué cargar

- [ ] Ordenanza de uso del suelo
- [ ] Ordenanza de fraccionamiento del suelo
- [ ] Ordenanza de ocupación del suelo
- [ ] Régimen de urbanizaciones cerradas, si existe uno general
- [ ] **Ordenanza Tarifaria vigente** (tasas sobre inmuebles) <- prioridad para `contador`
- [ ] Código de Edificación
- [ ] **Por cada barrio-cliente: su ordenanza particular de aprobación** <- vía Obras Privadas

## Fuentes

- Sitio oficial: `https://lacalera.gob.ar/`
- Dirección de Obras Privadas: `https://lacalera.gob.ar/direccion-de-obras-privadas/`
- Boletines Oficiales: `https://lacalera.gob.ar/boton-descargar/boletines-oficiales-2025/`
- Contexto regional (fuente secundaria, no citar como norma):
  `https://www.launionregional.com.ar/lo-que-ocupa-un-country/`
