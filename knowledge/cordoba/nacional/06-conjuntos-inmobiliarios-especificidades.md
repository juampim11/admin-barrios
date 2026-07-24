---
name: conjuntos-inmobiliarios-especificidades
description: Arts. 2073-2086 CCyC — lo propio de los conjuntos inmobiliarios: partes comunes, régimen de invitados y usuarios no propietarios, restricciones, sanciones y transmisión. Base de los módulos de accesos, reservas y convivencia.
jurisdiccion: cordoba
nivel: nacional
sources_status: borrador-para-validar
compilado: 2026-07-22
---

# Conjuntos inmobiliarios — especificidades (arts. 2073-2086)

> Lo que sigue es lo **propio** del régimen de conjuntos inmobiliarios, más allá de la remisión general a propiedad horizontal. De acá salen los módulos de **control de accesos, reservas de espacios comunes y convivencia**.

## 1. Concepto y estructura

`[VERIFICADO]` **Art. 2073** — abarca clubes de campo, barrios cerrados o privados, parques industriales, empresariales o náuticos, y otros emprendimientos urbanísticos con independencia del destino de vivienda permanente o temporaria.

`[VERIFICADO]` **Art. 2074 — Características.** Las diversas partes, cosas y sectores comunes y privativos, así como las facultades que sobre ellas se tienen, son **interdependientes y conforman un todo no escindible**.

**Regla de negocio:** no se puede vender ni ceder un espacio común separado de lo residencial. Se conecta con la Ord. 8606 de Córdoba capital, que dice lo mismo en clave urbanística.

## 2. Partes comunes y privativas

`[VERIFICADO]` **Art. 2076 — Cosas y partes necesariamente comunes.** Son necesariamente comunes o de uso común:
- las partes y lugares del terreno destinadas a **vías de circulación, acceso y comunicación**;
- las **áreas específicas destinadas a actividades deportivas, recreativas y sociales**;
- las **instalaciones y servicios comunes**;
- todo otro bien afectado al uso comunitario que el reglamento califique como tal.

⚠️ **Regla supletoria importante:** las cosas y partes **cuyo carácter no esté determinado se consideran comunes**.

`[VERIFICADO]` **Art. 2077 — Cosas y partes privativas.** La unidad funcional **puede hallarse construida o en proceso de construcción**, y debe reunir los requisitos de **independencia funcional** según su destino y **salida a la vía pública** por vía directa o indirecta.

**Regla de negocio (padrón):** el sistema debe admitir unidades funcionales **en construcción o baldías** como parte del padrón. En un barrio nuevo, buena parte de los lotes puede estar sin construir — y **igual generan expensas**. El estado de la unidad (baldío / en construcción / construido) es un campo, y puede afectar el coeficiente si el reglamento lo prevé.

## 3. Convivencia, restricciones y sanciones

`[VERIFICADO]`
- **Art. 2078 — Facultades y obligaciones de los propietarios.** El ejercicio de los derechos del propietario está enmarcado por la ley y por los límites y restricciones del reglamento. Es la base de las **normas de convivencia**.
- **Art. 2080 — Limitaciones y restricciones reglamentarias.** El reglamento puede establecer limitaciones **edilicias y de tipo arquitectónico** (por ejemplo, prohibir casas prefabricadas o determinados materiales), en miras al beneficio de la comunidad urbanística y teniendo en cuenta las normas administrativas aplicables (planeamiento urbano, zonificación).
- **Art. 2079 — Localización y límites perimetrales.**
- **Art. 2086 — Sanciones.**

**Reglas de negocio:**
- El módulo de **reclamos/convivencia** debe poder tipificar infracciones contra el reglamento de cada barrio, y registrar el circuito sancionatorio.
- Las **restricciones arquitectónicas** implican un flujo de **aprobación de obras** dentro del barrio: el propietario presenta, el consorcio aprueba contra el reglamento. Es un módulo propio, no un caso de reclamos.

## 4. ⭐ Régimen de invitados y usuarios no propietarios (art. 2083)

Este es **el fundamento legal del módulo de control de accesos**, y merece atención especial.

`[VERIFICADO]` **Art. 2083.** El reglamento puede:
- establecer la **extensión del uso y goce** de los espacios e instalaciones comunes a **quienes integran el grupo familiar** del propietario;
- prever un **régimen de invitados** y de **admisión de usuarios no propietarios** de esos bienes, con las características y condiciones que dicte el consorcio.

`[VERIFICADO]` El uso de los bienes comunes por **terceras personas** puede ser:
- **pleno, parcial o limitado**;
- **temporario o permanente**;
- es **siempre personal** y **no susceptible de cesión ni transmisión**, total ni parcial.

**Reglas de negocio (control de accesos):**
1. Hay **al menos tres categorías** de persona con derecho de acceso, con reglas distintas: **propietario**, **grupo familiar**, e **invitado / usuario no propietario**. No es una lista plana de "autorizados".
2. El permiso es **personal e intransferible**: el sistema no debe permitir que un invitado delegue o transfiera su autorización.
3. El alcance debe modelarse en dos ejes: **amplitud** (pleno / parcial / limitado — a qué espacios) y **temporalidad** (temporario / permanente).
4. Las condiciones concretas **las dicta el consorcio de cada barrio** → es configuración por barrio, no una regla global del sistema.

Esto también alimenta el módulo de **reservas de espacios comunes**: quién puede reservar qué depende de su categoría y del alcance que el reglamento le dio.

## 5. Transmisión de unidades y derecho de admisión (art. 2085)

`[VERIFICADO]` **Art. 2085.** El reglamento **puede prever limitaciones pero NO impedir la libre transmisión** y consiguiente adquisición de unidades funcionales dentro del conjunto. Puede establecer un **derecho de preferencia** en la adquisición a favor del consorcio de propietarios o del resto de los propietarios.

`[VERIFICADO]` El CCyC aborda así el **derecho de admisión**, dándole legitimidad **en tanto prevea limitaciones y no impida la libre transmisión**.

**Regla de negocio:** si el barrio tiene derecho de preferencia, el sistema debe soportar el **circuito de notificación de una venta** y el plazo para que el consorcio o los propietarios ejerzan la preferencia. Es un flujo con plazos, no un simple cambio de titular en el padrón.

## 6. Servidumbres entre conjuntos (art. 2084)

`[VERIFICADO]` Con arreglo a las normas administrativas aplicables, pueden establecerse **servidumbres u otros derechos reales entre conjuntos inmobiliarios** o con terceros conjuntos, para permitir un mejor aprovechamiento de espacios e instalaciones comunes (drenaje, vías de acceso, uso de espacios comunes de conjuntos aledaños).

⚠️ **Estas decisiones conforman modificación del reglamento** y deben decidirse con la **mayoría propia de tal reforma**, según lo prevea el reglamento.

**Regla de negocio:** un barrio puede tener **relaciones jurídicas con otros barrios**. El modelo de datos no debe asumir que cada barrio es una isla — puede haber acuerdos entre tenants distintos. Y cualquier cambio en ellos dispara el flujo de reforma de reglamento (mayoría agravada), no una decisión ordinaria.

## 7. Cesión de la unidad (art. 2082)

`[A VERIFICAR]` Cargar el texto y confirmar su alcance. Se relaciona con el uso de la unidad por terceros (alquiler, préstamo) y con las obligaciones que ello genera frente al consorcio.

## Fuentes

- CCyC arts. 2073-2113 (recopilación con acceso por artículo):
  `https://codigocivilonline.com.ar/conjuntos-inmobiliarios-arts-2073-a-2113/`
- PDF oficial del articulado (Registro de la Propiedad de Buenos Aires):
  `https://www.rpba.gob.ar/files/Normas/Leyes/CCCN2073-2113.pdf`
- Material de análisis del Colegio de Escribanos de Buenos Aires:
  `https://www.colescba.org.ar/servicios/comunidad/codigo/archivos/fc03v2-Conjuntos-inmobiliarios.pdf`
- Texto actualizado — InfoLeg:
  `https://servicios.infoleg.gob.ar/infolegInternet/anexos/235000-239999/235975/texact.htm`
