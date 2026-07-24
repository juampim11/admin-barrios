# 02 — Reutilización del sistema de gas (motor de conciliación)

> **Fase 6B — diseño de producto.** Qué reutilizar del sistema `trazabilidad-obra-gas`, qué adaptar y
> qué descartar para conciliar **cobros de expensas** (ingresos) y, más adelante, **pagos a
> proveedores** (egresos). Incluye los **pasos de migración** para ejecutar.
>
> Origen analizado: `C:\Proyectos_Desa\trazabilidad-obra-gas` (Next.js 15 + React 19 + Supabase + Zod;
> **no** usa Drizzle — esquema en 104 migraciones SQL). El motor de conciliación tiene una arquitectura
> **limpia en 3 capas** (motor puro sin I/O → servicio de I/O → orquestador), lo que lo hace muy
> reutilizable.

## 1. Arquitectura del motor en el gas (para entender qué se reusa)

- **Motor puro** (`src/services/conciliacion/matcher.ts`): funciones puras que reciben la transferencia
  + índices de candidatos ya cargados y devuelven una sugerencia. **No toca DB, ni Next, ni Supabase.**
- **Parámetros** (`src/services/conciliacion/reglas.ts`): todos los umbrales/scores en un objeto `REGLAS`.
- **Servicio de I/O** (`conciliacion-service.ts`): carga candidatos de la DB, invoca el matcher, persiste.
- **Orquestador** (`src/services/pipeline/run-conciliacion.ts`): punto de entrada único (cron/CLI/manual),
  con job-lock.

El algoritmo de matching identifica la UF de un pago con prioridad **alias por CUIT > CUIT de
propietario > DNI derivado del CUIT > nombre fuzzy** (Levenshtein + Jaccard, umbral 0.82), con
tolerancias de monto (±$50 o ±2%) y una regla de **auto-validación fuerte** (solo si método ∈
{cuit, alias} **y** score ≥ 0.8 **y** el monto calza contra la cuota esperada). Nunca auto-valida por
nombre, DNI ni comprobante. Un pagador que "reparte" entre varias UF nunca se auto-valida (va a cola
humana). Hay un motor paralelo de **reversas** (débitos de devolución) que nunca auto-confirma.

## 2. Qué se reutiliza TAL CUAL (motor puro, agnóstico de DB)

| Pieza (origen) | Qué es | Acción |
|---|---|---|
| `src/services/conciliacion/matcher.ts` | Motor de matching puro (identidad, tolerancias, ambigüedad) | **Copiar**; renombrar `uf_id` → `unidad_id`/`cuenta_id` |
| `src/services/conciliacion/reglas.ts` | Umbrales/scores (config pura) | **Copiar** tal cual; ajustar valores si el negocio lo pide |
| `src/services/conciliacion/reversas.ts` | Motor de reversas puro (devoluciones) | **Copiar** (aplica a devoluciones de expensas/proveedores) |
| `src/services/conciliacion/imputacion-service.ts` → `repartirFIFO` | Reparto FIFO de un pago a cuotas (cuota vencida más antigua primero) | **Copiar** el algoritmo; depende de la forma `EstadoCuentaCorriente` |
| `src/domain/cuit.ts`, `src/lib/normalizar-texto.ts` | Helpers puros de identidad (CUIT/DNI, unaccent+lower) | **Copiar** |
| `src/domain/finanzas.ts` (bloques Cuentas, Transferencia, Comprobante, Conciliación, MovimientoFondos) | Esquemas Zod canónicos financieros | **Copiar** esos bloques |
| **`nodemailer`** (dependencia) | Envío de emails | **Reusar** para el pipeline de distribución de liquidaciones (doc 01 §4.8) |
| **`exceljs`** (dependencia) | Lectura/escritura XLSX | **Reusar** para la exportación contable (doc 01 §4.8) y la ingesta de extractos |
| Patrón de **parseo AR** de la ingesta (`allaria-xlsx.ts`) | `num()`/`fechaISO()` para `1.234,56` y `dd/mm/aaaa`; parser CSV propio | **Reusar** el patrón (no el mapeo de columnas de Allaria) |

Los **tests-spec** del gas documentan el comportamiento esperado y sirven como red de seguridad al
portar: `tests/conciliacion/matcher.test.ts`, `tests/conciliacion/ambiguedad-multi-uf.test.ts`,
`tests/ingestion/allaria-xlsx.test.ts`, `tests/seguridad/concurrencia-conciliacion.test.ts`.

## 3. Qué se ADAPTA (reescribir contra el esquema de barrios + tenant)

| Pieza | Por qué se adapta | Cómo |
|---|---|---|
| `conciliacion-service.ts`, `reversas-service.ts` | Cargan candidatos y persisten en el esquema **de gas** con Supabase | **Reescribir** contra Drizzle + el esquema de barrios, con **`barrio_id`** en cada tabla y RLS por subárbol (doc 03). El motor puro que invocan **no cambia**. |
| `cuenta-corriente/proyeccion.ts` | Proyecta el cronograma a partir del **plan de pago de la obra de gas** (anticipo, ICC, vencimiento fijo) — es la definición de "deuda" del dominio gas | **Reemplazar** por la generación de **expensas mensuales por coeficiente**, **conservando la interfaz `EstadoCuentaCorriente`** que el matcher consume (`cuotaVencidaMasAntiguaImpaga`, `real`, `cronograma`). |
| `cuenta-corriente-service.ts` | Lee `plan_pago`, vistas y overrides específicos de la obra | **Reescribir** contra las expensas del barrio. |
| Ingesta de extractos (`allaria*.ts`) | Está pegada al formato de **Allaria+ (ALyC)** | Conservar el **patrón adapter** (`AllariaSource` → una interfaz `ExtractoBancarioSource`) y escribir **un adapter por banco** (mapeo de columnas + clasificación de fila). Ver §6 multi-banco del roadmap. |

## 4. Qué se DESCARTA (100% específico de la obra de gas)

- Pata **Aclade** (constructora): `pago_constructora`, `factura_aclade*`, `endoso*` (echeqs Banco
  Roela), `contrato_aclade_icc`, `fondo_reparo`.
- `money_market` / `rendimiento` / `impuesto_ley25413` (la plata en un FCI de Allaria).
- `plan_pago` de obra, y `unidad_funcional` con semántica de gas (manzana/lote con `codigo=MZ-x-L-y`
  ligado a la obra).

## 5. ⚠️ Multi-tenancy: el punto que NO se puede copiar

El sistema de gas **es single-tenant** (una sola obra) y aísla **por rol**, no por tenant: usa
**`auth.uid()` de Supabase directo** (136 ocurrencias en 69 migraciones), sin ningún concepto de
`tenant_id`/`barrio_id`, y el pipeline automático **bypassa RLS** con la `service_role` key.

En barrios esto se **rehace por completo**: cada tabla del motor (`transferencia`, `conciliacion`,
`alias_ordenante`, `comprobante`, `conciliacion_imputacion`, `ordenante_reparte`) lleva **`barrio_id`**
y **RLS por subárbol de tenant** con `app.current_user_id()` (nunca `auth.uid()` directo); el bypass
server-side usa el rol `app_job` (`BYPASSRLS`), no una service-role key expuesta. Ver
[`03-modelo-datos.md`](03-modelo-datos.md). **El motor puro es agnóstico a esto** (no toca DB), así que
la parte cara de rehacer es la capa de servicio/SQL, no el algoritmo.

## 6. Pasos de migración (para ejecutar)

> Ejecutar en la Fase 6C, tras scaffoldear el monorepo. Cada paso es chico y verificable.

1. **Copiar el motor puro** a `packages/shared/conciliacion` (o `packages/data/conciliacion`):
   `matcher.ts`, `reglas.ts`, `reversas.ts`, el `repartirFIFO` de `imputacion-service.ts`, y los
   helpers `cuit.ts` / `normalizar-texto.ts`. Renombrar identificadores de dominio gas
   (`uf_id` → `unidad_id`/`cuenta_id`); **no** tocar la lógica.
2. **Portar los tests-spec** (`matcher.test.ts`, `ambiguedad-multi-uf.test.ts`, `allaria-xlsx.test.ts`)
   como red de seguridad; deben pasar en verde con el motor copiado antes de seguir.
3. **Copiar los bloques financieros** de `src/domain/finanzas.ts` (Transferencia, Comprobante,
   Conciliación, MovimientoFondos) a `packages/shared`; adaptar los nombres de dominio.
4. **Definir la interfaz `EstadoCuentaCorriente`** y escribir su **implementación "expensas"** (genera
   el cronograma/saldo a partir de las expensas mensuales por coeficiente del barrio), reemplazando
   `proyeccion.ts`. El matcher consume esta interfaz sin cambios.
5. **Escribir la capa de I/O** contra Drizzle + Postgres con **`barrio_id`** en todas las tablas del
   motor y RLS por subárbol (nuevo `conciliacion-service.ts`); dedupe contra **pagos manuales** (doc 01
   §4.5/4.7). Manejar concurrencia (códigos `23505`/`P0100`) salteando la transferencia, nunca
   abortando la corrida.
6. **Escribir el adapter de banco** (`ExtractoBancarioSource`): reusar el parseo AR (montos/fechas/CSV/
   XLSX); un adapter por banco (mapeo de columnas + clasificación de fila).
7. **Cablear el orquestador** (`run-conciliacion`) detrás del **job-runner neutral** (interfaz, no
   `vercel.json`), con job-lock; disparo por evento (subida de extracto) + red de seguridad por cron
   poco frecuente (ver `03-reglas-desarrollo-optimizado.md`).

## 7. Mapa de archivos de origen (rutas absolutas)

- Motor puro (reusar): `trazabilidad-obra-gas/src/services/conciliacion/{matcher,reglas,reversas,imputacion-service}.ts`,
  `src/domain/cuit.ts`, `src/lib/normalizar-texto.ts`, `src/domain/finanzas.ts`.
- Capa I/O (reescribir): `src/services/conciliacion/conciliacion-service.ts`,
  `src/services/conciliacion/reversas-service.ts`, `src/services/cuenta-corriente/cuenta-corriente-service.ts`.
- Reemplazar: `src/services/cuenta-corriente/proyeccion.ts` (cronograma de obra → expensas).
- Ingesta (patrón adapter): `src/services/ingestion/allaria-xlsx.ts`, `allaria.ts`, `allaria-ingesta-service.ts`, `ingestion-service.ts`.
- Orquestación: `src/services/pipeline/run-conciliacion.ts`.
- Referencia de lo que **NO** copiar (RLS role-based + `auth.uid()`): `supabase/migrations/0002_rls_policies.sql`.
