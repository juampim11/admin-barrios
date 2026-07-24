---
name: villa-allende-uso-suelo
description: Villa Allende — ordenanzas de fraccionamiento, uso y ocupación del suelo, y el régimen de cierre de calles. Departamento Colón.
jurisdiccion: cordoba
nivel: municipal
municipio: villa-allende
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# Villa Allende (Dpto. Colón)

Es el municipio **mejor documentado públicamente** de los cuatro de Sierras Chicas relevados. Su Concejo Deliberante publica los PDF de ordenanzas online.

## Ordenanzas identificadas

`[VERIFICADO]`

| Ordenanza | Materia |
|-----------|---------|
| **43/18** | Fraccionamiento, uso y ocupación del suelo |
| **37/19** | Uso del suelo (+ planos anexos) |
| 36/19 | Creación de la Comisión de Urbanismo (proceso iniciado por la 43/18) |
| 05/02 | Área de Reserva |
| 20/96 | Boletín de Publicación de las Normas Municipales |

`[A VERIFICAR]` La relación exacta entre la **43/18** y la **37/19** —si la segunda sustituye parcialmente a la primera en materia de uso del suelo, o la complementa— debe confirmarse leyendo ambos textos. No asumir cuál está vigente para cada materia.

## Contenido relevante detectado

`[VERIFICADO]`
- La ordenanza de fraccionamiento organiza el ejido en **zonas identificadas por letras** (A, D1, D2, E1–E4, H, I, K, L, etc.), cada una con **dimensiones mínimas de parcela** propias (art. 8). → El sistema debe poder registrar **la zona** de cada barrio, porque determina el lote mínimo y por ende si encuadra como urbanización cerrada.
- El **Área de Reserva** está protegida (Ord. 05/02 + ley provincial de bosques).
- El territorio limita con **Unquillo** (al norte), **Mendiolaza** (al este/norte) y **Córdoba capital** (al sur), y hay áreas con **urbanizaciones residenciales cerradas dispersas**, sobre todo hacia la avenida Padre Luchesse.
- La normativa local reconoce expresamente que las **Leyes provinciales 9687 y 9841 alcanzan el territorio de la ciudad**, y que el municipio debe compatibilizar sus facultades con las políticas regionales. Ver `provincial/03-region-metropolitana-uso-suelo.md`.

## ⚠️ Cierre de calles en barrios abiertos — muy relevante para el producto

`[VERIFICADO]` En 2025 Villa Allende aprobó una **ordenanza que habilita el cierre nocturno de calles en algunos barrios**, presentada como parte de un "Programa integral de prevención del delito y seguridad vecinal". Generó debate público y reacciones divididas.

`[A VERIFICAR]` Identificar el **número de ordenanza**, su texto y su estado actual (puede haber sido modificada o judicializada).

**Por qué importa al sistema:** aparece una **cuarta categoría** de cliente, distinta de las tres que veníamos modelando:

| Tipo | Descripción |
|------|-------------|
| Barrio con encuadre formal de urbanización cerrada | URE u equivalente local |
| Barrio cerrado de hecho, sin encuadre | Cierra perímetro pero no encuadra |
| **Barrio abierto con cierre de calles autorizado por ordenanza** | **Calles públicas, cierre nocturno habilitado, consorcio vecinal de seguridad** |
| Propiedad horizontal clásica | Edificio |

El tercer caso es especialmente delicado: las calles siguen siendo **públicas**, el municipio presta los servicios, y sin embargo hay una **entidad vecinal que recauda** para seguridad. Eso tensiona directamente la ejecutabilidad del cobro — es el escenario del caso de Córdoba donde se rechazó la ejecución por no haber espacios comunes de uso exclusivo (ver `jurisprudencia/01-ejecutividad-expensas.md`).

## Fuentes

- Concejo Deliberante de Villa Allende: `http://cd.villaallende.gov.ar/`
- Ord. 43/18 — Fraccionamiento, Uso y Ocupación del Suelo (PDF):
  `http://cd.villaallende.gob.ar/ordenanzas/43-18%20Fraccionamiento%20Uso%20de%20Suelo.pdf`
- Ord. 37/19 — Uso de Suelo + planos anexos (PDF):
  `http://cd.villaallende.gov.ar/ordenanzas/37-19%20ORD.%20USO%20DE%20SUELO%20+%20PLANOS%20ANEXOS.pdf`
- Anteproyecto de Ordenanza de Ordenamiento Territorial (Consejo Municipal de Ambiente) — contexto y marco normativo:
  `http://cd.villaallende.gov.ar/proyectos/7-17_cma_anteproyecto_ordenanza_ord_territorial_-_final.pdf`
- Nota sobre la ordenanza de cierre de calles (fuente periodística; buscar el texto oficial):
  `https://mivalle.com.ar/villa-allende-polemica-por-la-ordenanza-que-autoriza-a-cerrar-calles-en-barrios-residenciales/`
