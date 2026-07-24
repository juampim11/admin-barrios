---
name: figuras-juridicas-panorama
description: Panorama de figuras jurídicas para barrios privados / consorcios / propiedad horizontal — base nacional + Córdoba. Base de conocimiento para el agente legal-ph.
jurisdiccion: cordoba
nivel: [nacional, provincial]
sources_status: borrador-para-validar
compilado: 2026-07
---

# Panorama de figuras jurídicas — barrios privados / consorcios (base nacional + Córdoba)

> **Cómo usar este archivo.** Es material de referencia para el agente `legal-ph`. Al ubicarlo en el repo, su contenido nacional va a `knowledge/cordoba/nacional/` y el provincial a `knowledge/cordoba/provincial/` (o dejalo entero como panorama y luego se separa).
>
> **Advertencias obligatorias.** (1) Esto NO es asesoramiento legal: es un resumen orientativo que **debe ser validado por un profesional matriculado** antes de usarse para cualquier acto. (2) La normativa cambia: **verificar vigencia** contra la fuente oficial en cada uso. (3) Los ítems marcados como `[fuente a cargar]` todavía no tienen la fuente oficial adjunta y deben completarse antes de darlos por buenos.

---

## 1. El cambio de marco (2015)

La antigua **Ley 13.512 de Propiedad Horizontal** fue derogada por la Ley 26.994, que sancionó el **Código Civil y Comercial (CCyC)**, vigente desde el 1° de agosto de 2015. Desde entonces:

- La **propiedad horizontal** está regulada en el CCyC (Libro Cuarto, Título V, a partir del art. 2037).
- Los **conjuntos inmobiliarios** (clubes de campo, barrios cerrados o privados, náuticos, etc.) se regulan como **"propiedad horizontal especial"** en el Título VI (arts. 2073 a 2086, con reenvíos hasta el 2113).

**Consecuencia práctica clave:** un agente que arranque razonando con la Ley 13.512 estaría desactualizado. La 13.512 solo sobrevive como antecedente de encuadres constituidos bajo su vigencia.

---

## 2. Las figuras jurídicas en la práctica

En el mundo real conviven varias figuras. **La figura de cada barrio es un dato del sistema** y condiciona reglas de negocio (sobre todo el cobro de expensas). Para cada una: qué es, cómo aparece, y qué implica.

### A. Propiedad horizontal especial / conjunto inmobiliario (CCyC, Título VI)
- Es el **régimen "destino"** que el CCyC prevé para los conjuntos inmobiliarios: un derecho real.
- Órganos y funcionamiento remiten a la propiedad horizontal (consorcio, administrador, asamblea, reglamento), con las particularidades del Título VI.
- Implica expensas comunes en su sentido técnico de PH; el administrador es figura central.

### B. Sociedad Anónima (Ley General de Sociedades 19.550)
- **Muy frecuente en barrios preexistentes.** Una sociedad (a menudo SA) es propietaria de los espacios comunes y de circulación; los propietarios de los lotes son a la vez **socios/accionistas** de esa sociedad, que administra el conjunto.
- Muchos de estos barrios **no se adecuaron** al régimen del CCyC y **no tienen previsto hacerlo** (ver sección 3).
- Los aportes de los propietarios suelen instrumentarse como contribuciones/"expensas" de base contractual o estatutaria, **no** como expensas de PH en sentido estricto. Esto impacta en cómo se reclama la mora (ver sección 4).
- `[fuente a cargar]` — artículos aplicables de la LGS 19.550 y modelo estatutario tipo.

### C. Asociación civil
- Otra forma bajo la que se organizan estos entes (la asociación nuclea a los propietarios y administra lo común).
- En Córdoba, las asociaciones civiles y fundaciones son autorizadas y fiscalizadas por la Inspección de Personas Jurídicas provincial (ver sección 5).
- `[fuente a cargar]` — régimen de asociaciones civiles en el CCyC y normas de IPJ Córdoba.

### D. Fideicomiso
- Aparece típicamente en la **etapa de desarrollo/construcción** (fideicomiso de construcción) y, a veces, en la **administración**.
- Regulado en el CCyC (contrato de fideicomiso). No siempre es la forma definitiva de administración una vez entregado el emprendimiento.
- `[fuente a cargar]` — articulado de fideicomiso del CCyC y uso concreto en emprendimientos.

### E. Geodesia / servidumbres (encuadre previo)
- Encuadre históricamente usado en algunas provincias (p. ej. Buenos Aires, Decreto 9404/86): parcelamiento por geodesia con servidumbres recíprocas, con una sociedad titular de las áreas comunes.
- Menos central en Córdoba, pero puede existir en emprendimientos antiguos. **Confirmar aplicabilidad real en Córdoba** antes de modelarlo como caso frecuente.
- `[fuente a cargar]` — verificar norma equivalente en Córdoba, si existe.

---

## 3. El deber de adecuación (art. 2075 CCyC) y su evolución

- El **art. 2075, párrafo 3°** del CCyC establece que los conjuntos preexistentes constituidos como derechos personales (o mezcla de reales y personales) **deben adecuarse** al régimen de propiedad horizontal especial.
- Es uno de los temas **más controvertidos** de la doctrina de derechos reales: hay posturas que van desde exigir la adecuación de forma inmediata hasta sostener su **inconstitucionalidad** por afectar retroactivamente derechos ya consolidados.
- A nivel **nacional (IGJ, jurisdicción CABA):** primero la Resolución General 25/2020 (con plazo luego extendido a 360 días por la 27/2020) intimó a los conjuntos organizados como sociedad o asociación a adecuarse; más tarde la **Resolución General 4/2024** encauzó una **"adecuación funcional"** voluntaria: adaptar estatutos y dictar un "Reglamento de Adecuación" que ajuste el funcionamiento al CCyC, sin necesariamente convertir el derecho real. Este giro hacia lo "funcional" es coherente con la realidad de que muchos barrios siguen como SA.
- **Importante para Córdoba:** la IGJ es un organismo **nacional (CABA)**. En Córdoba rige la **Inspección de Personas Jurídicas provincial** con sus propios criterios. `[fuente a cargar]` — resolución/criterio de adecuación específico de IPJ Córdoba (confirmar si existe una resolución provincial equivalente a la IGJ 4/2024).
- Como referencia comparada (NO aplicable a Córdoba): en Buenos Aires la Dirección Provincial de Personas Jurídicas dictó la Resolución 7826/2025 sobre adecuación funcional.

---

## 4. Por qué esto importa para el SISTEMA

El punto más operativo: **la figura jurídica condiciona cómo se cobra y ejecuta la mora de expensas.**

- La **jurisprudencia comercial** ha tendido a **negar la vía ejecutiva rápida** para el cobro de expensas cuando el conjunto está constituido como **SA y no se adecuó** (razonando que, sin adecuación, no puede invocar las prerrogativas del conjunto inmobiliario del CCyC).
- El **fuero civil** ha sido, en general, **más permisivo** con los pactos de ejecutividad en reglamentos de entes constituidos como sociedades/asociaciones o por geodesia.
- `[fuente a cargar]` — fallos concretos y su cita (ej. precedentes del fuero comercial; plenario "Sausalito Club S.A." mencionado en doctrina). Cargar en `knowledge/cordoba/jurisprudencia/`.

**Traducción a diseño:**
1. `figura_juridica` es un atributo de primera clase del **barrio**.
2. El módulo de **cobranzas/expensas** debe ramificar su comportamiento según la figura (instrumento del aporte, camino de reclamo, ejecutividad).
3. El agente `legal-ph` debe **preguntar/leer la figura del barrio** antes de opinar, nunca asumir PH especial por defecto.

---

## 5. Nivel Córdoba (provincial)

- **Organismo:** la **Inspección de Personas Jurídicas (IPJ) de Córdoba** es el órgano de aplicación del régimen de personas jurídicas provincial (Ley provincial 8652) y ejerce las funciones del Registro Público; autoriza y fiscaliza asociaciones civiles y fundaciones, y controla sociedades. Sitio: ipj.cba.gov.ar.
- **Trámites:** se gestionan digitalmente a través de **CiDi (Ciudadano Digital Córdoba)**.
- **A cargar/confirmar (`[fuente a cargar]`):**
  - Resolución o criterio de IPJ Córdoba sobre **adecuación de conjuntos inmobiliarios** (¿existe equivalente provincial a la IGJ 4/2024?).
  - Normas provinciales de **uso y fraccionamiento del suelo / urbanizaciones** aplicables a barrios cerrados en Córdoba.
  - **Régimen fiscal provincial** (Rentas Córdoba): ingresos brutos, sellos e inmobiliario según la figura del ente.
  - Normativa **municipal** de la localidad de cada barrio (uso/ocupación/fraccionamiento del suelo, código de edificación, tasas).

---

## 6. Fuentes (para verificar y adjuntar)

Oficiales / primarias a cargar:
- Código Civil y Comercial — Ley 26.994 (propiedad horizontal art. 2037+; conjuntos inmobiliarios arts. 2073-2086). Fuente oficial: InfoLEG / Boletín Oficial.
- Ley 13.512 (derogada) — InfoLEG, a modo de antecedente.
- IGJ Resolución General 4/2024 — Boletín Oficial (adecuación funcional; nacional/CABA).
- Ley provincial 8652 de Córdoba (régimen de personas jurídicas / IPJ).
- IPJ Córdoba — ipj.cba.gov.ar (trámites, guías, resoluciones).

Secundarias / doctrina (contexto, no citar como norma):
- Artículos de la Revista del Notariado sobre propiedad horizontal especial y adecuación de conjuntos preexistentes.

**Estado:** borrador inicial para validación profesional. Todo lo marcado `[fuente a cargar]` debe completarse con la fuente oficial vigente antes de darse por válido.
