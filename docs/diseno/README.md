# Diseño de producto (Fase 6B)

Fuente de verdad del **diseño de producto** de `admin-barrios`. Se produce antes de scaffoldear el
monorepo y el esquema real (Fase 6C). Todo el contenido legal/fiscal cita `knowledge/cordoba/` con su
marca de confianza; cerrar con "Validar con profesional matriculado".

| Doc | Contenido |
|---|---|
| [`01-alcance-modulos.md`](01-alcance-modulos.md) | Alcance, módulos por etapa, **corte del MVP**, operatoria por módulo, multi-figura (5 ejes), mobile |
| [`02-reuso-conciliacion.md`](02-reuso-conciliacion.md) | Qué se reusa/adapta/descarta del sistema de gas + **pasos de migración** |
| [`03-modelo-datos.md`](03-modelo-datos.md) | **Multi-tenancy jerárquica + RLS** (materialized path) + dominio del barrio + generación de PDF |
| [`04-requisitos-dominio.md`](04-requisitos-dominio.md) | Requisitos **legales y fiscales por figura** (Córdoba), con fuente y marca de confianza |
| [`05-roadmap.md`](05-roadmap.md) | Plan por etapas (MVP → incrementos → mobile), modo demo, multi-banco, **resumen ejecutivo** |
| [`06-direccion-visual.md`](06-direccion-visual.md) | **Dirección visual**: principios, design tokens (paleta + modo oscuro), navegación multi-barrio, wireframes de las 5 pantallas clave, patrones y accesibilidad (WCAG AA) |

**Decisiones cerradas:** MVP básico y mostrable (Core + egresos como registro, conciliación de ingresos
no bloqueante); tenancy por **materialized path** (portable, `ltree` opcional a futuro); mobile
**residente primero**. **Roster técnico super-senior** dado de alta (ver `agents/README.md`).
| [`07-liquidacion-pdf.md`](07-liquidacion-pdf.md) | Decisiones del panel de agentes sobre la liquidación en PDF: motor, estructura, alcance, respaldo de la extraordinaria, lenguaje prohibido y seguridad del módulo. |
| [`08-criterios-de-reparto.md`](08-criterios-de-reparto.md) | Cómo se reparte la expensa (partes iguales, superficie, escalas, % de reglamento, por concepto) y la boleta separada de la extraordinaria: decisiones del panel y orden de construcción. |
| [`09-boleta-de-expensas.md`](09-boleta-de-expensas.md) | El diseño del documento impreso: zonas, escala de papel, tintas, símbolos de pago y marca de dos niveles. |
| [`10-informe-mensual-y-mora.md`](10-informe-mensual-y-mora.md) | El **informe mensual** (qué es hoy y qué le falta), el **desfasaje de dos meses** y hasta dónde se acorta, informe cerrado vs. tablero vivo, qué se publica del gasto y qué no, y la **política de publicación de la mora** (nominada o agregada, configurable). |

---

## Navegación: qué se adoptó del prototipo "Consorcia" (2026-08-03)

El **modelo de navegación** del prototipo `design_handoff_consorcia/` **se adopta** (decisión del
usuario) y está escrito en **[`06-direccion-visual.md` §c.6](06-direccion-visual.md)**: dos alcances
con un solo chrome, el selector que se adapta a 1 / 2–9 / 10+ barrios, cambiar de barrio conserva la
sección, no se muestran acciones que el rol no puede ejecutar, y la entrada a un período es su
resumen.

**Todo lo demás de ese material NO se adopta** — modelo de datos, roles, estados, vocabulario de PH,
paleta y criterios de aceptación. El estatus vinculante está en
[`../arquitectura/03-sistema-de-ui.md`](../arquitectura/03-sistema-de-ui.md) §9 y el análisis completo
en [`../producto/analisis-handoff-consorcia.md`](../producto/analisis-handoff-consorcia.md).
