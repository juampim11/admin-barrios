---
name: ley-19550-barrio-sa
description: Ley General de Sociedades 19.550 aplicada al barrio organizado como SA. Art. 3 (asociaciones bajo forma de sociedad) y su tensión con el deber de adecuación.
jurisdiccion: cordoba
nivel: nacional
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# Ley General de Sociedades 19.550 — el barrio organizado como SA

Este archivo cubre la figura **más frecuente entre los barrios preexistentes** y la que más se aparta del régimen "de manual".

## Cómo se estructura un barrio-SA

`[VERIFICADO]` El esquema típico: una **sociedad (habitualmente SA) es titular de los espacios comunes y de circulación**, y los propietarios de los lotes son a la vez **accionistas** de esa sociedad, que administra el conjunto. Los aportes para gastos comunes se instrumentan por vía **societaria/estatutaria o contractual**, no como expensas de propiedad horizontal en sentido técnico.

## El artículo clave: art. 3° LGS

`[VERIFICADO]` El **art. 3° de la Ley 19.550** contempla expresamente las **"asociaciones bajo forma de sociedad"**: asociaciones que, cualquiera sea su objeto, adoptan una de las formas societarias, quedando sujetas a la ley de sociedades.

**Por qué es central:** es el sustento legal de que un barrio funcione como SA sin fin de lucro. Cuando la IGJ afirmó que estas entidades "carecen de validez", la crítica doctrinaria señaló que están **específicamente autorizadas y reguladas desde hace décadas por ese art. 3°**. Es decir: el barrio-SA no es una anomalía sin ley, es una figura prevista.

## Órganos y su equivalencia funcional

`[A VERIFICAR]` Mapeo orientativo entre la estructura societaria y la de PH, útil para el modelo de datos del sistema:

| En un barrio-SA (LGS) | Equivalente funcional en PH (CCyC) |
|-----------------------|-------------------------------------|
| Asamblea de accionistas | Asamblea de propietarios |
| Directorio | Consejo de propietarios / administración |
| Sindicatura (si existe) | Consejo de propietarios (control) |
| Estatuto + reglamento interno | Reglamento de propiedad y administración |
| Acción / participación societaria | Unidad funcional + porcentual |
| Aporte o cuota social periódica | Expensa común |

⚠️ **No es una equivalencia jurídica, es funcional.** No asumir que una regla de PH se aplica a la SA por analogía sin verificar: eso es precisamente lo que los tribunales discuten.

## Artículos de la LGS a cargar

`[A VERIFICAR — completar con el articulado vigente]`
- Art. 1° — concepto y tipicidad.
- **Art. 3° — asociaciones bajo forma de sociedad** (el más importante acá).
- Régimen de la SA: constitución, asamblea, directorio, sindicatura.
- Régimen de la documentación contable y de los estados contables (relevante para el agente `contador`).

`[VERIFICADO]` Nota de vigencia: el texto está ordenado por el Decreto 841/84 y fue modificado por normas posteriores, entre ellas la **Ley 26.994** (que además cambió la denominación a "Ley General de Sociedades" y derogó su Capítulo III y los arts. 361 a 366). Cargar siempre el **texto actualizado**.

## Consecuencia práctica para el sistema

Un barrio-SA **no genera "expensas" en sentido técnico de PH**. Genera **aportes/contribuciones de base societaria o contractual**. Esto impacta en:

1. **Denominación** de los conceptos en la liquidación (no llamarlos automáticamente "expensas").
2. **Instrumentación de la deuda**: de qué documento nace la obligación (estatuto, reglamento interno, pacto de ejecutividad en escritura).
3. **Camino de reclamo**: la vía ejecutiva no está garantizada. Ver `jurisprudencia/01-ejecutividad-expensas.md`.
4. **Órganos**: el sistema debe poder modelar directorio/asamblea de accionistas, no solo administrador/asamblea de propietarios.

## Fuentes

- Ley 19.550, texto actualizado — InfoLeg:
  `https://www.argentina.gob.ar/normativa/nacional/ley-19550-25553/actualizacion`
- Ficha InfoLeg: `https://servicios.infoleg.gob.ar/infolegInternet/verNorma.do?id=25553`
- Crítica doctrinaria a la postura de la IGJ sobre validez de estas figuras (nota periodística con fundamentos):
  `https://www.lanacion.com.ar/propiedades/adecuacion-conjuntos-inmobiliarios-nid2378591/`
