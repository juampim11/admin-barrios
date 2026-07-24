# Guía de carga de conocimiento — jurisdicción Córdoba

> Para que `legal-ph` y `contador` sirvan de algo, alguien (vos o un profesional matriculado) tiene que
> cargar contenido real en `knowledge/cordoba/`. Este documento dice **QUÉ** cargar y **DÓNDE**
> conseguirlo (fuente oficial) — **no transcribe normativa**: los artículos, alícuotas y criterios
> concretos hay que sacarlos de la fuente oficial vigente al momento de cargarlos, nunca de memoria ni
> de este documento.
>
> **Recordatorio permanente:** toda norma cambia con el tiempo (reformas, derogaciones, actualización de
> alícuotas). Al cargar cada archivo, anotar la **fecha de verificación de vigencia** y, si es posible,
> volver a revisar antes de que los agentes se apoyen en ella para algo con implicancia real.

---

## `knowledge/cordoba/nacional/` — normativa nacional aplicable

Aplica igual en cualquier provincia (se carga localmente para que el agente no tenga que salir a
buscar), pero **la Provincia y el Municipio sí varían** (secciones siguientes).

Qué cargar:
- **Código Civil y Comercial de la Nación (CCyC)** — articulado de:
  - **Propiedad horizontal** (régimen general de PH).
  - **Conjuntos inmobiliarios** (el régimen especial para barrios privados/clubes de campo).
  - **Asociaciones civiles** (Personas Jurídicas Privadas).
  - **Fideicomiso** (contrato de fideicomiso, especialmente el de administración).
- **Ley General de Sociedades 19.550** — al menos el régimen de Sociedad Anónima (constitución,
  órganos — asamblea/directorio/sindicatura, y lo relativo a sociedades que no distribuyen utilidades
  entre socios sino que administran un bien común, que es el caso atípico de un barrio-SA).

Dónde conseguirlo (fuente oficial, verificar el texto **actualizado con reformas**, no una edición
vieja):
- **InfoLeg** (`infoleg.gob.ar`) / portal de normativa de Argentina.gob.ar — texto del CCyC (Ley
  26.994) y de la Ley 19.550, con las modificaciones posteriores incorporadas.
- **SAIJ** (Sistema Argentino de Información Jurídica, `saij.gob.ar`) — alternativa con buscador y
  texto actualizado, y con relación a jurisprudencia asociada.
- **Boletín Oficial de la República Argentina** (`boletinoficial.gob.ar`) — para verificar la última
  modificación puntual de un artículo si hay dudas de vigencia.

⚠️ Verificar vigencia: la Ley 19.550 tuvo reformas puntuales (ej. sobre sociedades unipersonales,
digitalización de trámites); el CCyC también tuvo ajustes desde 2015. No asumir que una copia impresa o
un PDF viejo está actualizado.

---

## `knowledge/cordoba/provincial/` — Córdoba

Qué cargar:
- **Organismo de personas jurídicas de la provincia y sus resoluciones sobre adecuación de conjuntos
  inmobiliarios**: en Córdoba, el organismo de contralor de personas jurídicas (asociaciones civiles,
  fundaciones, y lo referido a la adecuación de barrios preexistentes al régimen de conjuntos
  inmobiliarios) depende del Ministerio de Justicia y Derechos Humanos de la Provincia. **Verificar el
  nombre exacto vigente del organismo** (ha cambiado de denominación entre gestiones — buscar
  "Inspección de Personas Jurídicas de Córdoba" o "IPJ Córdoba" como punto de partida) y cargar sus
  resoluciones sobre adecuación de conjuntos inmobiliarios y sobre asociaciones civiles.
- **Normas de uso y fraccionamiento del suelo / urbanizaciones** a nivel provincial: régimen provincial
  de ordenamiento territorial y urbanizaciones especiales/clubes de campo/barrios cerrados (suele
  regularse por decreto o ley provincial específica de "urbanizaciones especiales"). Buscar la norma
  provincial vigente sobre este punto.
- **Régimen fiscal provincial**: Ingresos Brutos, Sellos e Impuesto Inmobiliario de la Provincia de
  Córdoba — en particular, cómo tributa (o no) un consorcio/SA/asociación civil/fideicomiso que
  administra expensas (frecuentemente hay tratamientos diferenciales o exenciones parciales para la
  actividad de administración de consorcios; **no asumir cuál aplica sin la fuente**).

Dónde conseguirlo:
- **Boletín Oficial de la Provincia de Córdoba** (`boletinoficial.cba.gov.ar`) — leyes, decretos y
  resoluciones provinciales.
- **Dirección General de Rentas de Córdoba** (portal de Rentas Córdoba, dependiente del Ministerio de
  Finanzas) — normativa de Ingresos Brutos, Sellos e Inmobiliario, alícuotas vigentes y resoluciones.
- **Sitio oficial de la Provincia de Córdoba** (`cba.gov.ar`) — para ubicar el organismo de personas
  jurídicas vigente y sus resoluciones publicadas.

⚠️ Verificar vigencia: las alícuotas de Ingresos Brutos/Sellos se actualizan habitualmente por ley
impositiva anual — cargar la ley impositiva del año en curso, no una de un ejercicio anterior.

---

## `knowledge/cordoba/municipal/` — ordenanzas locales

Qué cargar (**varía según el municipio donde esté cada barrio** — no hay una única fuente para "Córdoba
municipal"; identificar primero en qué municipio/localidad está cada barrio del sistema):
- Ordenanzas de **uso, ocupación y fraccionamiento del suelo** de esa localidad (a menudo es el
  instrumento que autoriza/regula la existencia de un "barrio cerrado" o "club de campo" en ese
  territorio).
- **Código de Edificación** local, si aplica a obras dentro del barrio.
- **Tasas municipales** (ej. tasa de servicios a la propiedad, contribución que incide sobre inmuebles
  del barrio) — relevante para lo que el `contador` necesita distinguir de las expensas privadas.

Dónde conseguirlo:
- El **Digesto Municipal** o el sitio del **Concejo Deliberante** de cada localidad (cada municipio de
  Córdoba publica el suyo; buscar "digesto municipal <nombre de la localidad>").
- El **Boletín Oficial Municipal** de esa localidad, si lo tiene.

Organizar como `knowledge/cordoba/municipal/<municipio>/` si el sistema atiende barrios en más de una
localidad (ver nota en el `README.md` de esta carpeta).

⚠️ Verificar vigencia: las ordenanzas de uso del suelo se modifican con frecuencia por expansión
urbana; confirmar que la que se carga es la última ordenanza vigente sobre esa zona, no una derogada.

---

## `knowledge/cordoba/jurisprudencia/` — criterios de tribunales

Qué cargar:
- Criterios sobre **ejecutividad del cobro de expensas** según la figura jurídica — el punto donde más
  cambia la respuesta entre SA y PH especial (la vía ejecutiva típica de expensas de PH no aplica
  automáticamente si el ente es una SA; en SA la vía de cobro depende de cómo esté instrumentada la
  deuda — ej. si hay un título ejecutivo válido). **No asumir el criterio sin la fuente**: cargar el
  fallo/criterio concreto.
- Criterios sobre validez de asambleas, reglamentos internos, y facultades del administrador según la
  figura.
- Criterios sobre adecuación (o falta de adecuación) de una SA-barrio al régimen de conjuntos
  inmobiliarios y sus consecuencias.

Dónde conseguirlo:
- **Tribunal Superior de Justicia de Córdoba** y **Cámaras de Apelaciones en lo Civil y Comercial de
  Córdoba** — buscador de jurisprudencia provincial.
- **SAIJ** (`saij.gob.ar`) — buscador de jurisprudencia con filtro por materia/jurisdicción.
- **CIJ — Centro de Información Judicial** (`cij.gov.ar`) para criterios de alcance nacional que
  también se citan en fueros provinciales (buena parte de la jurisprudencia histórica sobre
  ejecutividad de expensas de PH viene de cámaras de CABA; sigue siendo relevante como criterio
  orientador, aclarando siempre que no es jurisprudencia de Córdoba).

Formato de carga: no transcribir el fallo completo salvo que sea corto — resumir el criterio en 2-3
líneas, citar tribunal + fecha + carátula/identificación, y referenciar dónde conseguir el texto
completo (ver `README.md` de la carpeta).

---

## Antes de que los agentes se apoyen en esto

1. Cargar al menos el CCyC (PH + conjuntos inmobiliarios) y la Ley 19.550 en `nacional/` — es la base
   mínima para que `legal-ph` distinga figuras.
2. Cargar el régimen fiscal provincial vigente en `provincial/` — es la base mínima para que `contador`
   responda algo sobre Córdoba.
3. Todo lo demás (municipal, jurisprudencia) se puede ir sumando de forma incremental: mientras falte,
   los agentes van a decir **"no tengo esa fuente cargada"** para esos temas puntuales — es el
   comportamiento esperado, no un bug.
4. Idealmente, que un profesional matriculado (abogado para `legal-ph`, contador para `contador`)
   revise la selección de fuentes antes de darla por buena — este documento la propone, no la valida.
