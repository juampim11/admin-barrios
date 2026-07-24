---
name: requisitos-modelo-datos
description: Consolidado — todas las reglas de negocio y campos que se derivan de la base de conocimiento. Insumo directo para el diseño del modelo de datos (Fase 6B).
jurisdiccion: cordoba
sources_status: derivado-de-fuentes
compilado: 2026-07-22
---

# Requisitos para el modelo de datos

> **Qué es este archivo.** Un consolidado de todo lo que la base de conocimiento implica para el diseño del sistema. **No es una fuente**: es la traducción a requisitos de lo investigado. Cada punto remite al archivo donde está su fundamento.
>
> Sirve como insumo directo para `docs/diseno/03-modelo-datos.md` de la Fase 6B.

---

## 1. Los cinco ejes independientes de un barrio

El error más caro sería tratar esto como un solo campo "tipo de barrio". Son **cinco dimensiones ortogonales** y cualquier combinación es posible:

| Eje | Valores | Determina | Fuente |
|-----|---------|-----------|--------|
| `figura_juridica` | SA · asociación civil · PH especial/conjunto inmobiliario · fideicomiso · geodesia | Órganos, instrumentación de aportes, vía de cobro | `00-panorama`, `nacional/02` |
| `adecuado_art_2075` | sí · no · en trámite · no aplica | Ejecutividad del certificado de deuda | `nacional/01`, `nacional/03` |
| `encuadre_urbanistico` | URE/equivalente · loteo abierto · cierre de calles autorizado · sin encuadre | Obligaciones municipales, tasas | `municipal/README` |
| `municipio` | La Calera · Villa Allende · Mendiolaza · Unquillo · Córdoba capital · … | Toda la capa normativa local | `municipal/` |
| `servicios_internos_a_cargo_de` | municipio · urbanización · mixto | Adicional tarifario, superposición tasa/expensa | `municipal/cordoba-capital` |

⚠️ Un barrio puede ser **SA + no adecuado + sin encuadre URE + en La Calera + con servicios a cargo del municipio**. Ninguna combinación debe estar prohibida por el modelo.

**Todos estos campos deben versionarse con vigencia temporal**: un barrio puede adecuarse, cambiar de figura o de encuadre. Lo que importa para un acto es el valor **vigente en ese momento**.

---

## 2. Multi-tenancy jerárquica

Ver detalle en el prompt de Fase 6B. Resumen de lo que la investigación agregó:

- El **administrador es el cliente** del sistema, y su vínculo con cada barrio es un **mandato con fecha de inicio y de cese**, ligado a un acta de asamblea (arts. 2065/2066: nombrado y removido por asamblea, removible sin causa). → La relación administrador↔barrio **no es permanente**: es un mandato versionado.
- Un barrio puede tener **relaciones jurídicas con otros barrios** (servidumbres entre conjuntos, art. 2084). El aislamiento entre tenants debe admitir **excepciones explícitas y auditadas**, no ser absoluto por diseño.

---

## 3. Padrón y unidades funcionales

| Requisito | Fundamento |
|-----------|------------|
| La UF puede estar **en construcción o baldía** y aun así integrar el padrón y generar expensas | art. 2077 |
| Campo `estado_unidad`: baldío / en construcción / construido | art. 2077 |
| **`manzana` y `lote`** como campos estructurados (no dirección libre) | Exigencia de la IPJ para fijar sede social |
| `nomenclatura_catastral` | Permite validar contra IDECOR/MapasCórdoba |
| **Múltiples obligados por unidad** (propietario + poseedor por cualquier título), sin liberar al propietario | art. 2050 |
| Histórico de titulares; **la deuda no se reinicia** al cambiar de dueño | art. 2049 |
| Coeficiente **versionado**, definido por el reglamento, con validación de que la suma cierre | arts. 2046 inc. c, 2081 |
| Soportar prorrateos **distintos al porcentual de parte indivisa** (por lote, superficie, mixto) | art. 2081 (remite al reglamento) |

---

## 4. Expensas y liquidación

| Requisito | Fundamento |
|-----------|------------|
| Distinguir **ordinarias vs. extraordinarias**; las extraordinarias **exigen respaldo de asamblea** | art. 2048 |
| **Fondo de reserva** como cuenta separada, opcional ("si lo hay"), con autorización del consejo antes de imputar | arts. 2046 inc. d, 2064 inc. c |
| Tasa de **mora configurable y versionada** por barrio | `nacional/04` (surge del reglamento) |
| Separar **conceptos alcanzados y no alcanzados** por IIBB | `provincial/02` |
| Separar **ingresos ajenos a las expensas** (alquileres, antenas, publicidad) | `provincial/02` |
| En barrio-SA: los conceptos **no se llaman "expensas"** sino aportes/cuotas sociales | `nacional/02`, `provincial/02` |

---

## 5. Cobranzas y certificado de deuda

| Requisito | Fundamento |
|-----------|------------|
| Certificado emitido por el **administrador** y **aprobado por el consejo** cuando existe | art. 2048 |
| Trazabilidad completa: quién, cuándo, qué períodos, sobre qué instrumento | art. 2048 |
| Registrar por barrio: **reglamento inscripto (s/n)**, **pacto de ejecutividad (s/n)**, `adecuado_art_2075` | `jurisprudencia/01` |
| Registrar `tiene_espacios_comunes_exclusivos` — hecho valorado por los tribunales | `jurisprudencia/01` |
| Modelar **al menos dos caminos de reclamo** (ejecutivo / ordinario) y sugerir el aplicable, siempre con aviso de validación profesional | `jurisprudencia/01` |

⚠️ **El sistema nunca debe asumir que la deuda es ejecutable.** Es la conclusión más importante de toda la investigación jurídica.

---

## 6. Asambleas y votaciones

| Requisito | Fundamento |
|-----------|------------|
| Motor de **doble mayoría simultánea**: nº de unidades **y** partes proporcionales indivisas | art. 2060 |
| Base de cómputo = **totalidad del padrón**, no los presentes | art. 2060 |
| Mayorías **por tipo de decisión**: absoluta · 2/3 (reforma de reglamento, autoconvocatoria) · unanimidad (temas fuera de orden del día, decisiones fuera de asamblea) | arts. 2057, 2059, 2060 |
| **Quórum configurable y posiblemente ausente** — no imponer default | art. 2059 |
| **Orden del día estructurado**; bloquear decisiones sobre temas no incluidos salvo presencia total + unanimidad | art. 2059 |
| Tres modalidades: convocada · autoconvocada (2/3) · decisión unánime fuera de asamblea | art. 2059 |
| Calcular si un grupo alcanza el **5% de partes indivisas** para forzar tratamiento de un tema | art. 2058 inc. b |
| **Libro de Actas** y **Libro de Registro de Firmas**, exportables; identidad verificada del votante | art. 2062 |
| Convocatoria por el administrador; **el consejo puede convocar ante su omisión** | arts. 2067 inc. a, 2064 inc. a |
| Soportar barrios **con y sin consejo de propietarios** | "si lo hay", passim |

---

## 7. Control de accesos y reservas

| Requisito | Fundamento |
|-----------|------------|
| **Tres categorías** con reglas distintas: propietario · grupo familiar · invitado/usuario no propietario | art. 2083 |
| Permiso **personal e intransferible**: prohibir delegación o cesión de la autorización | art. 2083 |
| Alcance en dos ejes: **amplitud** (pleno/parcial/limitado, a qué espacios) y **temporalidad** (temporario/permanente) | art. 2083 |
| Condiciones **configurables por barrio** (las dicta cada consorcio) | art. 2083 |
| Espacios comunes tipificados: vías de circulación · áreas deportivas/recreativas/sociales · instalaciones y servicios | art. 2076 |

---

## 8. Convivencia, obras y transmisión

| Requisito | Fundamento |
|-----------|------------|
| Tipificar infracciones contra el reglamento de cada barrio + circuito sancionatorio | arts. 2078, 2080, 2086 |
| Flujo de **aprobación de obras** dentro del barrio contra restricciones arquitectónicas | art. 2080 |
| Si hay **derecho de preferencia**: circuito de notificación de venta con plazos | art. 2085 |
| No permitir enajenar espacios comunes por separado (todo no escindible) | art. 2074 |
| Regla supletoria: lo **no determinado se considera común** | art. 2076 |

---

## 9. Documentos que el sistema debe guardar por barrio

De todo lo relevado, estos documentos son **datos de primera clase**, no adjuntos sueltos:

1. **Reglamento de propiedad horizontal** (o estatuto + reglamento interno, si es SA) — es la fuente de coeficientes, quórum, mayorías, mora, restricciones.
2. **Instrumento municipal de aprobación** de la urbanización — define qué servicios presta quién. **Crítico en La Calera**, donde hay ordenanza por barrio.
3. **Actas de asamblea** — respaldan extraordinarias, designación de administrador, reformas.
4. **Acta de designación del administrador** vigente.
5. **Constancia de adecuación** (art. 2075), si la hay.
6. **Pacto de ejecutividad**, si existe (reglamento o escritura).

---

## 10. Lo que el sistema NO debe hacer

- No asumir que todo barrio es propiedad horizontal.
- No asumir que la deuda de expensas es ejecutable.
- No imponer quórum por defecto.
- No calcular mayorías sobre los presentes.
- No tratar el coeficiente como porcentual de parte indivisa en todos los casos.
- No permitir que un invitado transfiera su autorización de acceso.
- No dar por buena una respuesta legal o fiscal sin el aviso de **validación por profesional matriculado**.
