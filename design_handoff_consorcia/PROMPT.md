# ⛔ NO EJECUTAR ESTE PROMPT — decisión del usuario, 2026-08-03

> **Este archivo quedó SUPERSEDIDO y su prompt NO debe ejecutarse, ni por Claude Code, ni por
> Codex, ni por ninguna otra herramienta.** Ejecutarlo tal cual arrancaría un segundo producto
> dentro del repo, con otro vocabulario, otros roles, otros estados y otro modelo de datos.
>
> **El estatus vinculante de esta carpeta está en `docs/arquitectura/03-sistema-de-ui.md` §9:**
> es **insumo de producto** (inventario de pantallas, referencia visual, reglas para contrastar),
> **no fuente de verdad**. Donde este material difiera del repo, **el repo gana siempre**:
> nomenclatura (barrio/unidad/aporte configurable por figura jurídica — no consorcio/UF/expensas),
> roles (`app.rol_membership` — no `ADMIN_TENANT`…), estados del período
> (`borrador→revisada→emitida→distribuida` — no `CERRADA`/`ANULADA`), modelo de datos
> (`packages/data/src/schema/` — no `schemas.ts`), dinero (string + `bigint` de `shared/dinero` —
> no `number`; `Intl` está PROHIBIDO por CI), tokens (Verdemar, `packages/design-tokens` — no
> `design-tokens.json`).
>
> **Lo único adoptado de este material** está enumerado en ADR-0003 §6 y en
> `docs/diseno/06-direccion-visual.md` §c.6 (el modelo de navegación). El análisis completo, con el
> porqué de cada descarte: `docs/producto/analisis-handoff-consorcia.md`.

---

# ~~Prompt para Claude Code (pegar dentro del repo)~~ — HISTÓRICO, NO USAR

> Antes de pegarlo: copiá esta carpeta completa (`design_handoff_consorcia/`) a la raíz del repo. Contiene el HTML de referencia, tokens, schemas, fixtures que cuadran y criterios de aceptación.

---

## PROMPT

Voy a implementar la UI de un sistema multitenant de administración de consorcios/barrios privados (Argentina). Todo el material está en `design_handoff_consorcia/`. Leé en este orden: `README.md`, `business-rules.md`, `screens.md`, `design-tokens.json`, `schemas.ts`, `fixtures.ts`, `acceptance.md`, y abrí `Consorcia - Mockups (standalone).html` como **referencia visual** de alta fidelidad. **No copies ese HTML a producción**: es un prototipo. Tu tarea es **recrear esas pantallas en este repo**, con nuestros patrones, componentes y convenciones.

### Reglas de trabajo

1. Primero explorá el repo y decime en un resumen corto: stack de estilos, componentes ya existentes que sirven, estructura de rutas, modelo de datos (tipos/schemas Zod) y qué de estas pantallas ya existe. **No escribas código hasta que confirme el plan.**
2. TypeScript estricto de punta a punta. Zod para validar los límites (entrada de datos, contratos entre capas).
3. Toda lógica de negocio, tipos y validaciones que vaya a compartir con la futura app React Native + Expo va al paquete compartido del monorepo, no dentro de `app/`. Los componentes de UI web quedan en la app web.
4. Datos: usá fixtures/mocks tipados con los mismos schemas Zod (los números y nombres de los mockups sirven como fixture). No inventes endpoints; si falta un dato, marcalo con un TODO y avisame.
5. Cada pantalla es un server component por defecto; client component sólo donde hay interacción real (wizard, conciliación, filtros, formularios).
6. Fidelidad: **alta**. Respetá jerarquía, densidad, alineación de números a la derecha y `tabular-nums`. Si nuestro sistema de estilos tiene un token equivalente, usá el token; si no, usá los valores exactos de la sección "Tokens" de abajo.

### Modelo mental del producto (es lo que define la IA de la app)

- **Tenant** = la administradora (estudio). Administra ~20 **consorcios**, hasta ~300 **unidades funcionales (UF)** cada uno.
- **Dos alcances, un solo chrome**: contexto "Toda la cartera" (consolidado) y contexto "un consorcio". Lo único que cambia es el **selector de contexto** del header y algunos ítems del nav. No hay dos navegaciones distintas.
- **Alcance por perfil**: el selector muestra sólo los consorcios asignados al usuario.
  - 1 consorcio → no es selector, es título fijo.
  - 2–9 → lista simple, y el home son tarjetas de trabajo por consorcio (no el consolidado).
  - 10+ → buscador + fijados + opción "Toda la cartera" **sólo si el rol la tiene**.
- **Roles**: administrador del tenant (todo), operador contable (N consorcios, sin cartera consolidada), consejo/presidente (1 consorcio, sólo lectura, puede aprobar u observar la liquidación, **no ve deuda con nombre y apellido ni datos personales del padrón**), propietario/vecino (portal self-service de su UF).
- Al cambiar de consorcio se **conserva la sección actual** (si estabas en Gastos, entrás a los gastos del otro consorcio). Atajo `⌘K` abre el selector.

### Reglas de negocio que la UI debe reflejar

- **Liquidación**: estados borrador → cerrada → emitida; los ajustes de un período emitido van al mes siguiente (o reemisión/anulación con nota de crédito, siempre con autor y motivo en historial).
- **Prorrateo**: base por defecto por coeficiente del reglamento; alternativas por m², partes iguales y mixto por rubro. Excepciones por rubro (ej. piscina sólo al sector B, agua por medidor). **La suma de coeficientes debe dar 100,000%** y la liquidación debe cuadrar sin resto: mostrar el control de cuadratura en vivo.
- **Intereses por mora**: configurables por consorcio (ej. 4,5% mensual directo), 2.º vencimiento con recargo, imputación de pagos a la deuda más antigua primero.
- **Fondo de reserva**: % sobre expensas ordinarias (ej. 3%), cuenta bancaria propia; no se le imputan gastos ordinarios.
- **Extraordinarias**: en cuotas (ej. ascensores 2/6), se muestran separadas del gasto ordinario en boleta y reportes.
- **Multibanco**: cada consorcio tiene sus propias cuentas (CA $, CC $ del fondo, billetera de links de pago). La conciliación es **por cuenta**; el disponible del consorcio suma todas. Los movimientos nunca cruzan consorcios; una transferencia entre cuentas del mismo consorcio es movimiento interno y no impacta expensas.
- **Conciliación**: match sugerido por CUIT + importe ±$500 dentro de 5 días del vencimiento; en billetera, match exacto por ID de link de pago. Acciones: conciliar, dividir entre varias UF, registrar como pago a cuenta / cobranza a identificar.
- **Gastos con OCR**: revisión lado a lado (visor del comprobante + campos leídos), validación de CUIT en AFIP, rubro sugerido por historial, retenciones a practicar, imputación a período / extraordinario / fondo de reserva.
- **Mora**: acción sugerida por tramo (1–30 recordatorio automático; 31–60 aviso formal; 61–90 intimación; +90 carta documento/legales — **estas tres siempre con confirmación humana**). Plan de pago: anticipo + cuotas, suspende intereses mientras esté al día, caduca con 2 cuotas impagas.
- **Reclamos**: SLA por categoría (urgente 4 h, mantenimiento 48 h, administrativo 72 h). Un reclamo puede vincularse a un presupuesto y luego al comprobante del gasto.
- **Portal del vecino**: total a pagar con desglose, "¿por qué pago esto?" con la composición del gasto del consorcio, pago por link, adhesión a débito automático, e **informar un pago hecho por fuera** (queda como "pago informado" y entra a la conciliación de la administración).

### Pantallas a implementar (id del mockup → ruta sugerida)

Contexto cartera (tenant):
- `1a` Home consolidado de cartera → `/(app)/cartera`
- `2b` Selector de contexto (dropdown + ⌘K) → componente global del header
- `2c` Home de operador con N consorcios y vista del consejo (sólo lectura) → variantes del home según rol
- `5c` Cierre masivo del mes, cola por consorcio → `/(app)/cartera/cierre/[periodo]`

Contexto consorcio:
- `2a` Resumen del consorcio → `/(app)/c/[consorcioId]`
- `4a` Liquidaciones: lista de períodos, historial, reemisión/anulación → `/(app)/c/[consorcioId]/liquidaciones`
- `1d` Wizard de liquidación (gastos → prorrateo → revisión y emisión) → `/(app)/c/[consorcioId]/liquidaciones/[periodo]`
- `1e` Alternativa: planilla editable de prorrateo con cuadratura fija → variante del paso 2 (implementar sólo si lo pido)
- `1g` Gastos y comprobantes con OCR, revisión lado a lado → `/(app)/c/[consorcioId]/gastos`
- `2d` Caja y bancos · conciliación multibanco → `/(app)/c/[consorcioId]/bancos`
- `3a` Padrón de UF + panel de la UF → `/(app)/c/[consorcioId]/padron`
- `1h` Estado de cuenta por UF → `/(app)/c/[consorcioId]/padron/[ufId]`
- `4b` Cobranza y mora: tramos, deudores +90, plan de pago → `/(app)/c/[consorcioId]/mora`
- `3b` Reportes (libro de gastos + índice de reportes) → `/(app)/c/[consorcioId]/reportes`
- `5a` Reclamos: bandeja + detalle → `/(app)/c/[consorcioId]/reclamos`
- `3c` Alta y configuración del consorcio (paso 3: reglas de liquidación) → `/(app)/c/[consorcioId]/config` y `/(app)/consorcios/nuevo`

Portal del vecino:
- `1h` (columna derecha) y `5b` mobile: inicio, "¿por qué pago esto?", informar pago → `/(portal)/mi/[ufId]`

### Tokens del diseño

> Los valores completos y machine-readable están en `design-tokens.json`. Resumen:

Superficies y texto
- Fondo de página `#f5f4f1`; superficie `#ffffff`; fila alterna `#fcfbf9`; header de tabla `#faf9f7`
- Sidebar `#1b1c1e`, texto de sidebar `#cfcdc8`, activo `rgba(255,255,255,.10)`
- Texto principal `#1b1c1e`; secundario `#4a4844`; terciario `#6b6a67`; apagado `#8a8781`; deshabilitado `#a3a19b`
- Bordes `rgba(0,0,0,.09)` (contenedores), `rgba(0,0,0,.12)` (inputs), `rgba(0,0,0,.06)` (filas)

Semánticos
- Acento (primario): `#2f4fa8` — el mockup permite alternar a `#1f8a8a`, `#9b3b32`, `#3f4b3a`; usá el token de marca del repo si existe
- Negativo / mora: `#a04a3c` (punto `#c2705f`, fondo suave `#fdf3f1`)
- Positivo: `#3d6b4a` (punto `#5d9a70`, fondo suave `#f0f4ee`)
- Atención: `#8a6a2e` (punto `#c2a05f`, fondo suave `#fdf6e8` / chip `#f4efdf`)

Tipografía
- UI: Helvetica Neue / Helvetica / Arial (mapear a la font del repo)
- Números, códigos, comprobantes, IDs: monospace (IBM Plex Mono en el mockup)
- Escala: 22px/500 título de página · 17–19px/500 título de card grande · 14px/500 título de sección · 13px/400 cuerpo y tablas · 12,5px/500 botones · 11–11,5px/400 labels y metadatos · 10–10,5px monospace mayúsculas para etiquetas de sistema
- Todo importe con `font-variant-numeric: tabular-nums` y alineado a la derecha

Espaciado, radios, sombras
- Radios: 6px chips · 7px botones/inputs · 9px cards · 12–14px cards de mobile · 22px marco de teléfono
- Padding: cards 15–20px · celdas de tabla 10–14px vertical / 10–18px horizontal · header 12–16px vertical / 22–26px horizontal
- Gaps: 10–14px entre cards, 16–22px entre bloques de sección
- Sombras: casi ninguna; jerarquía por borde y color, no por elevación
- Alto de fila cómodo ≈ 44–48px (existe variante compacta con padding 9px)

Formatos AR
- Moneda: `$1.234.567` (punto de miles, sin decimales en listados)
- Porcentajes con coma: `78,4%`; coeficientes con 3 decimales: `0,380%`
- Fechas cortas `05/08`, largas `05/08/2026`; períodos `07/2026`
- CUIT `30-71422908-4`; comprobantes `A 0003-00018492`

### Criterios de aceptación

> La lista completa y testeable está en `acceptance.md`, y `fixtures.ts` exporta `validarLiquidacion()` con los números de referencia. Convertí esos criterios en tests. Resumen:

- Los coeficientes del padrón suman 100,000% y la UI lo verifica visiblemente; una liquidación con resto ≠ 0 no se puede emitir.
- El selector de contexto respeta el alcance del usuario y nunca ofrece "Toda la cartera" a quien no la tiene.
- Un usuario del consejo no ve deuda individualizada ni datos personales del padrón, y no ve botones que no puede usar.
- La conciliación opera por cuenta bancaria y jamás mezcla movimientos de consorcios distintos.
- Un período emitido es inmutable: la UI ofrece ajuste al mes siguiente, reemisión o anulación, no edición.
- Todas las tablas de importes usan números tabulares alineados a la derecha.

### Cómo quiero que avances

Primero escribí los tests de `acceptance.md` que puedan correr contra `fixtures.ts` (prorrateo, cuadratura, intereses, imputación) y recién después la UI.

Andá pantalla por pantalla, en este orden, con un commit por pantalla y un resumen corto de decisiones al final de cada una:
1. Shell + selector de contexto + roles (`1a`, `2b`, `2c`)
2. Consorcio: resumen y padrón (`2a`, `3a`, `1h`)
3. Gastos y bancos (`1g`, `2d`)
4. Liquidación (`4a`, `1d`)
5. Mora y reportes (`4b`, `3b`)
6. Reclamos, configuración y portal (`5a`, `3c`, `5b`, `5c`)

Si algo del mockup choca con un patrón del repo, seguí el repo y decímelo.
