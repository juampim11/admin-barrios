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
