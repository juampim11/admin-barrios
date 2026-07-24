# Próximo proyecto — sub-agentes para administración de barrios privados / consorcios

> **Actualización 2026-07-22:** este archivo es la propuesta original (nivel producto) hecha desde el
> template. Fase 6A ya dio de alta tres agentes de dominio de nivel **experto** —
> `administrador-consorcios`, `legal-ph`, `contador` (ver `agents/README.md` y
> `docs/arquitectura/00-stack-infra.md`) — que no reemplazan esta propuesta sino que son la capa
> convocable desde ya. Las 5 personas de grano fino de abajo (`expensas-contabilidad`,
> `reservas-espacios`, `control-accesos`, `comunicacion-residentes`, `reclamos-tickets`) siguen siendo
> candidatas para cuando exista el modelo de producto (Fase 6B en adelante).

> **Propuesta lista para completar.** Cada sub-agente sigue la **estructura portable** del template
> (`agents/README.md`): una **persona** (fuente de verdad, neutral) + un **wrapper fino** para Claude
> Code, con **el mismo nombre**. Acá van los roles de **dominio** propuestos; los de propósito general
> (`code-reviewer`, `documentador`, `tester`) ya vienen en el template.
>
> Todo está como **placeholder** (`<ASI>`): completá las reglas de negocio reales al arrancar. Los
> advisors de dominio (contable/legal) **no escriben código de producción** y llevan disclaimer.

---

## Cómo dar de alta cada uno (recordatorio)

Por cada sub-agente de esta lista:
1. Crear `agents/personas/<nombre>.md` con el contenido propuesto abajo (completando los `<ASI>`).
2. Crear `agents/wrappers-claude/<nombre>.md` (wrapper fino que apunta a la persona) y copiarlo a
   `.claude/agents/`.
3. Sumarlo al roster de `agents/README.md` y a la matriz de convocatoria del proyecto.

---

## 1. `expensas-contabilidad` — Advisor de expensas y contabilidad

- **Qué haría:** define cómo se **liquidan las expensas** (prorrateo por coeficiente/unidad, ordinarias
  vs extraordinarias, fondo de reserva, intereses por mora), cómo se registran cobros y qué datos
  contables debe capturar el sistema. **Consultivo:** aporta reglas y checklists; no liquida ni firma.
- **Límites:** no escribe código de producción; no da asesoramiento contable/impositivo vinculante
  (eso es del contador humano); lleva disclaimer.
- **Archivos:**
  - Persona: `agents/personas/expensas-contabilidad.md`
  - Wrapper: `agents/wrappers-claude/expensas-contabilidad.md`
- **Placeholders a completar:** `<METODO_PRORRATEO>`, `<REGLA_MORA_E_INTERES>`, `<FONDO_RESERVA>`,
  `<PERIODICIDAD_LIQUIDACION>`, `<TRATAMIENTO_EXTRAORDINARIAS>`.

## 2. `reservas-espacios` — Reservas de espacios comunes

- **Qué haría:** modela la **reserva de amenities** (SUM, quincho, canchas, piscina): disponibilidad,
  turnos, cupos, reglas de prioridad, cancelaciones, cargos/depósitos y conflictos de solapamiento.
- **Límites:** define el "qué" y las reglas; no diseña la UI (eso es de un rol UX) ni decide la
  política del consorcio (eso lo fija la administración).
- **Archivos:**
  - Persona: `agents/personas/reservas-espacios.md`
  - Wrapper: `agents/wrappers-claude/reservas-espacios.md`
- **Placeholders:** `<ESPACIOS_RESERVABLES>`, `<REGLAS_DE_TURNO>`, `<POLITICA_CANCELACION>`,
  `<CARGOS_O_DEPOSITOS>`, `<LIMITES_POR_UNIDAD>`.

## 3. `control-accesos` — Control de accesos y visitas

- **Qué haría:** define el flujo de **ingreso de personas y vehículos**: registro de visitas,
  autorizaciones de residentes, proveedores, patentes, invitados recurrentes, y el **registro
  auditable** de entradas/salidas. Cruza con seguridad de datos (PII sensible).
- **Límites:** no opera hardware de barreras/molinetes (el sistema **registra y autoriza**, no acciona
  físicamente por su cuenta salvo integración explícita); no expone datos de accesos fuera de los
  roles autorizados.
- **Archivos:**
  - Persona: `agents/personas/control-accesos.md`
  - Wrapper: `agents/wrappers-claude/control-accesos.md`
- **Placeholders:** `<TIPOS_DE_VISITA>`, `<QUIEN_AUTORIZA>`, `<DATOS_A_REGISTRAR>`,
  `<RETENCION_DE_REGISTROS>`, `<INTEGRACION_HARDWARE>`.

## 4. `comunicacion-residentes` — Comunicación a residentes

- **Qué haría:** define los **canales y reglas de aviso** a residentes (novedades, cortes, asambleas,
  urgencias): segmentación (por unidad/manzana/todos), plantillas, prioridad, y registro de
  entrega/lectura. Cuida el **consentimiento** y los horarios.
- **Límites:** no redacta contenido oficial del consorcio (lo hace la administración); no envía a
  terceros ni fuera de los canales autorizados; respeta opt-out.
- **Archivos:**
  - Persona: `agents/personas/comunicacion-residentes.md`
  - Wrapper: `agents/wrappers-claude/comunicacion-residentes.md`
- **Placeholders:** `<CANALES>` (email/push/SMS/cartelera), `<SEGMENTOS>`, `<REGLAS_URGENCIA>`,
  `<CONSENTIMIENTO_Y_OPTOUT>`, `<REGISTRO_DE_ENTREGA>`.

## 5. `reclamos-tickets` — Reclamos y tickets

- **Qué haría:** modela el **ciclo de vida de un reclamo** (alta → categorización → asignación →
  seguimiento → resolución → cierre/satisfacción): SLAs, prioridades, derivación a proveedores y
  trazabilidad de cada estado. Base para reportes de gestión.
- **Límites:** no resuelve el reclamo (eso es operativo/humano); no cierra un ticket sin registro del
  motivo; no expone datos de un reclamo fuera de los involucrados y la administración.
- **Archivos:**
  - Persona: `agents/personas/reclamos-tickets.md`
  - Wrapper: `agents/wrappers-claude/reclamos-tickets.md`
- **Placeholders:** `<CATEGORIAS_DE_RECLAMO>`, `<SLA_POR_CATEGORIA>`, `<FLUJO_DE_ESTADOS>`,
  `<REGLAS_DE_DERIVACION>`, `<METRICAS_DE_GESTION>`.

---

## Plantilla de persona (copiar por cada sub-agente)

```markdown
# Persona: <NOMBRE_LEGIBLE>

## Rol
<Qué resultado habilita este agente en el sistema de barrios/consorcios.>

## Cuándo se lo convoca
- <Situación 1> · <Situación 2> · <Situación 3>

## Cómo trabaja
1. <Paso / criterio> ...

## Qué decide
<Qué define este rol y qué eleva a la administración / a un profesional humano.>

## Qué NO hace
<Límites explícitos. Si es advisor: no escribe código de producción, lleva disclaimer.>

## Reglas duras que respeta
- <Regla de dominio / privacidad / plata que nunca rompe.>
```

## Plantilla de wrapper (copiar por cada sub-agente)

```markdown
---
name: <nombre-kebab>
description: <una línea: qué hace y cuándo usarlo>
---

Sos <NOMBRE_LEGIBLE> de **<NOMBRE_PROYECTO>**. Leé `agents/personas/<nombre-kebab>.md`.
<2-3 frases con el método y los límites del rol.>
```

---

## Panel sugerido (matriz de convocatoria del proyecto de barrios)

| Si la necesidad toca… | Convocar |
|---|---|
| Liquidación de expensas, cobros, mora, fondo de reserva | `expensas-contabilidad` (+ contador humano) |
| Reserva de amenities / espacios comunes | `reservas-espacios` (+ UX) |
| Ingreso de visitas/proveedores, patentes, registro de accesos | `control-accesos` (+ seguridad de datos) |
| Avisos y comunicación a residentes | `comunicacion-residentes` (+ seguridad de datos por consentimiento/PII) |
| Reclamos, tickets, SLAs, derivaciones | `reclamos-tickets` |
| Cualquier cosa que toque **datos personales** o **dinero** | panel obligatorio antes de codear |
