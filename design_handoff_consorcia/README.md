> # ⛔ ESTATUS: INSUMO DE PRODUCTO — NO ES FUENTE DE VERDAD
>
> **Decisión del usuario, 2026-08-03.** Vinculante: `docs/arquitectura/03-sistema-de-ui.md` §9.
>
> Esta carpeta sirve como **inventario de pantallas, referencia visual y batería de reglas para
> contrastar**. **No** se implementa tal cual, y **`PROMPT.md` no se ejecuta**.
>
> **Donde este material difiera del repo, gana el repo, siempre:**
>
> | Este material dice | El repo manda |
> |---|---|
> | consorcio · unidad funcional (UF) · expensas · consejo | barrio · unidad · **denominación configurable por figura jurídica** (aporte/cuota social/expensa) · órgano según figura (directorio en S.A.) |
> | `ADMIN_TENANT`, `OPERADOR_CONTABLE`, `CONSEJO`, `VECINO` | `app.rol_membership`: `admin_plataforma`, `admin_barrio`, `operador`, `contador`, `auditor`, `propietario`, `residente` |
> | `BORRADOR → CERRADA → EMITIDA → ANULADA` | `borrador → revisada → emitida → distribuida` (máquina de estados con triggers en la base) |
> | `schemas.ts` / `fixtures.ts` | `packages/data/src/schema/` + las migraciones |
> | dinero como `number` (centavos) · `Intl.NumberFormat` | `numeric(14,2)` como string + aritmética `bigint` de `shared/dinero`. **`Intl` está PROHIBIDO y verificado en CI** |
> | coeficientes que suman 100% exacto o no se emite | cinco bases de reparto; el invariante es `repartido = gastado` (doc 08 §L) |
> | pagos imputados a (período, unidad) | **la deuda se imputa al comprobante** (doc 08 §E) |
> | `design-tokens.json` (azul `#2f4fa8`) | **Verdemar** (teal), `packages/design-tokens`, ratificado 2026-08-03 |
>
> **Lo único adoptado:** el **modelo de navegación** — ADR-0003 §6 y `docs/diseno/06-direccion-visual.md` §c.6.
>
> **El análisis completo, con el porqué de cada descarte:** `docs/producto/analisis-handoff-consorcia.md`.

---

# Handoff: Consorcia — administración multitenant de consorcios (AR)

## Overview
UI de un sistema **multitenant / multi-cliente** para administradoras de consorcios y barrios privados en Argentina: registro de gastos con comprobantes, registro de pagos y conciliación bancaria, emisión de boletas de expensas (liquidación), padrón de UF, cuentas corrientes, mora y reportes contables. Un *tenant* es la administradora (~20 consorcios, hasta ~300 UF cada uno); cada consorcio es un cliente con sus propias reglas, cuentas bancarias y usuarios.

## About the design files
`Consorcia - Mockups (standalone).html` es una **referencia de diseño** hecha en HTML: un prototipo de alta fidelidad que muestra el aspecto y el comportamiento buscados. **No es código de producción y no debe copiarse.** La tarea es **recrear esas pantallas en este repo** con su stack y sus patrones (Next.js App Router + React + TypeScript estricto + Zod; monorepo con paquete compartido para la futura app React Native + Expo).

Abrilo en el navegador: cada opción tiene un badge con su id (`1a`, `2a`, `3b`, …). Los ids son la nomenclatura usada en todo este paquete.

## Fidelity
**Alta fidelidad.** Colores, tipografía, espaciado y densidad son finales. Si el repo tiene un token equivalente, usá el token; si no, usá los valores de `design-tokens.json`. Los datos son ficticios pero coherentes: los de `fixtures.ts` cuadran exactamente.

## Archivos del paquete

| Archivo | Para qué sirve |
|---|---|
| `PROMPT.md` | Prompt listo para pegar en Claude Code: contexto, orden de trabajo y criterios. **Empezá por acá.** |
| `screens.md` | Inventario de pantallas: id del mockup, propósito, layout, componentes, estados, ruta sugerida. |
| `business-rules.md` | Reglas de negocio y matriz de permisos por rol. |
| `design-tokens.json` | Colores, tipografía, radios, espaciado, formatos AR. Importable. |
| `schemas.ts` | Schemas Zod + tipos inferidos del dominio (referencia; adaptar a los nombres reales del repo). |
| `fixtures.ts` | Dataset de prueba que **cuadra**: un consorcio con 8 UF, gastos, liquidación, movimientos bancarios. |
| `acceptance.md` | Criterios de aceptación como checklist testeable. |
| `Consorcia - Mockups (standalone).html` | Los mockups, en un solo archivo offline. |

## Cómo validar (esto es lo importante)
1. `fixtures.ts` exporta `validarLiquidacion()`: los coeficientes suman exactamente `100.000%` y la suma de los totales por UF iguala el total emitido. Cualquier implementación del prorrateo debe reproducir esos números **al peso**.
2. `acceptance.md` está escrito como asserts: convertilos en tests (unitarios para prorrateo/intereses/imputación, de integración para permisos por rol y para el aislamiento entre consorcios).
3. Reglas no negociables: período emitido inmutable, conciliación por cuenta bancaria sin cruce entre consorcios, y el rol consejo sin deuda individualizada ni datos personales del padrón.

## Assets
No hay imágenes reales. Donde va una foto, un logo, un comprobante escaneado o un QR de pago, el mockup usa un **placeholder rayado** con leyenda monoespaciada. Reemplazar por los assets reales del producto. No hay íconos: la jerarquía se resuelve con tipografía, color y puntos/chips de estado.

## Notas
- Terminología argentina obligatoria en la UI: consorcio, unidad funcional (UF), coeficiente, expensas ordinarias / extraordinarias, liquidación, prorrateo, fondo de reserva, cuenta corriente, CUIT, retenciones, comprobante A/B/C.
- Formatos: `$1.234.567` (miles con punto, sin decimales en listados), porcentajes con coma, coeficientes con 3 decimales, fechas `dd/mm/aaaa`, períodos `mm/aaaa`.
- Los importes se muestran con `tabular-nums` y alineados a la derecha, siempre.
