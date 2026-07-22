# 03 · Reglas de desarrollo optimizado (permanentes)

> **Plantilla neutral.** Para que un proyecto **nazca ya optimizado** y ningún cambio futuro degrade
> el consumo. Neutral respecto del proveedor: aplica a cualquier hosting serverless
> (`<PROVEEDOR_HOSTING>`) + base gestionada (`<PROVEEDOR_BD>`). Reemplazá `<ASI>` por lo tuyo.

---

## 0. Regla madre — MEDIR antes de optimizar

> Una lista de optimizaciones escrita **leyendo el código** encuentra todo lo que *parece* caro
> (full scans, vistas sin materializar, render dinámico) y **no ve lo único que importa** si el
> problema no está en el código (un proceso descontrolado, una función en loop).

**Antes de tocar nada por "performance": medí.** Herramientas de diagnóstico #1:
- Base: el equivalente a `pg_stat_statements` / *Query Performance* / *slow query log* del proveedor
  → las queries más caras y frecuentes.
- Procesos: actividad en vivo (`pg_stat_activity` o similar) y los **logs**.
- Cómputo: CPU delta (¿plano = I/O-bound, o sube = loop?) antes de asumir "es lento".

Un plan de optimización sin una medición que lo respalde es **una lista de sospechas, no un
diagnóstico**.

---

## 1. Presupuesto de recursos por entorno (budget con margen)

**Regla:** definí un **umbral de alerta por debajo del límite** del plan (actuar al **70 %**, freno
al **85 %**), por recurso y por entorno. Revisá contra el dashboard, **no de memoria**. Si hay 2
entornos en el mismo plan, presupuestá **los dos**.

| Recurso (ejemplo) | Límite del plan | 🟡 Alerta (70 %) | 🔴 Freno (85 %) | Acción al cruzar |
|---|---|---|---|---|
| Tamaño de base | `<LIMITE_DB_SIZE>` | 70 % | 85 % | archivar/limpiar datos de prueba |
| Egress de base | `<LIMITE_EGRESS>` | 70 % | 85 % | revisar selects anchos / vistas |
| Storage de archivos | `<LIMITE_STORAGE>` | 70 % | 85 % | limpiar archivos procesados |
| **Disk IO / IOPS** de la instancia | `<LIMITE_DISK_IO>` | IO sostenido cerca del baseline | throttle activo | atacar full scans / cachear vistas |
| Invocaciones de función | `<LIMITE_INVOCACIONES>` | 70 % | 85 % | revisar polling/crons/refresh |
| Bandwidth del hosting | `<LIMITE_BANDWIDTH>` | 70 % | 85 % | reducir payloads / caché (ISR) |
| Duración/memoria de función | `<LIMITE_FUNCION>` | p95 > 66 % del techo | timeouts | partir el trabajo / mover a job |
| Crons | `<LIMITE_CRONS>` | — | — | no agregar más frecuentes de lo soportado |

> **Nota:** en muchos free tiers el cuello de botella real **no** es la cantidad de requests, sino el
> **Disk IO** de la instancia chica. Cualquier patrón que lea tablas enteras o recompute agregados en
> cada carga quema el burst de disco → sube el CPU por *IO-wait* → alerta. Identificá **tu** recurso
> más escaso y presupuestalo primero.

---

## 2. Checklist pre-merge (bloqueante, se integra al DoD)

> Se suma a `<CHECKLIST_SEGURIDAD>` (si aplica), no lo reemplaza. Ningún PR se aprueba con un ❌ sin
> justificación explícita.

- [ ] ¿Agrego una **query** en un `WHERE`/`JOIN` por una columna **sin índice**? → agregar índice o justificar.
- [ ] ¿Introduje un **N+1** (query dentro de `map`/`for`)? → batchear con `IN (...)` / `.in(...)`.
- [ ] ¿Traigo **tablas enteras** sin límite/paginación o `select("*")` en ruta caliente? → acotar/angostar.
- [ ] ¿Sumo un **cron**, **polling** o **refetch** nuevo? → justificar frecuencia; preferir disparo por evento.
- [ ] ¿La página nueva necesita **render dinámico** o puede ser **cacheada/estática (ISR)**? → la más barata que sirva.
- [ ] ¿Agrego una **función pesada** (parse/OCR/export)? → ¿corre en job con presupuesto de tiempo, no en cada request?
- [ ] ¿Subo un archivo a **Storage** sin TTL/limpieza previstos?
- [ ] ¿Aumento el **payload/egress** (más columnas, más filas al cliente)?
- [ ] ¿Toca **autenticación**? → validar sin debilitar el rechazo de tokens vencidos.
- [ ] `<REGLA_ESPECIFICA_DEL_STACK>` (ej.: gotchas de binding del cliente de tu ORM/SDK).

---

## 3. Monitoreo (rutina + señales tempranas)

- **Frecuencia:** mirada **semanal** a los reportes de cómputo/IO/egress del hosting y la base;
  revisión **mensual** de tamaño de datos y tendencia de egress.
- **Señales de actuar YA (antes de saturar):**
  - Disk IO sostenido cerca del baseline (throttle inminente) → suele ser la señal más importante.
  - CPU alto **sin** una operación en curso (import/batch) → algo corre de más.
  - Egress creciendo > 70 % antes de fin de mes.
  - Duración p95 de una función acercándose a su techo.
  - **Mails de alerta del proveedor** → tratar como **incidente**, no como aviso.

---

## 4. Patrones vs anti-patrones

| Tema | ✅ Patrón | ❌ Anti-patrón |
|---|---|---|
| Agregación | Agregar en la base (vista/función), materializar si es caro | Traer la tabla y agregar en la app |
| Frescura de agregados | Materializar + refresh **por evento** (al cambiar datos) | Recomputar el agregado en **cada** carga |
| Disparo de trabajo | Por **evento** (import, webhook) | Cron ancho "por las dudas" que corre en vacío |
| Contar | `count` a nivel base (solo el número) | Traer todas las filas para hacer `.length` |
| Lectura repetida | Caché por request; caché/ISR para páginas sin sesión | Render dinámico en todo + refetch en cascada |
| Columnas | Seleccionar solo las necesarias | `select("*")` en rutas calientes |
| Relaciones | Batch con `IN (ids)` | Query por ítem dentro de `map`/`for` (N+1) |
| Cliente de base | Reusar 1 por request; admin singleton | Crear varios clientes por request |
| Conexión directa (si se usa) | Pooler en modo transaction | Conexión directa desde serverless |
| Progreso en UI | Polling espaciado + refresh al final | Polling de pocos segundos + refresh por vuelta |
| Realtime / websockets | Solo si el negocio lo exige | Suscripciones "porque queda lindo" |
| Imágenes | Estáticas / ya optimizadas | Optimización remota sin necesidad (gasta bandwidth) |
| Builds | Saltar builds de solo-docs | Rebuild completo por cada cambio de markdown |

---

## 5. Modelo de disparo de procesos automáticos

Para **cada cron/job**, preguntate: **¿qué trabajo real atrapa en un día típico y cuál es su
disparador natural?** Si corre "en vacío" la mayoría de las veces:
- Preferí **disparo por evento** (import, webhook) sobre el cron ancho.
- Si necesitás una red de seguridad, un cron **poco frecuente** (semanal) suele alcanzar.
- En todos los casos, agregá un **guard de early-exit barato** al inicio del job: si no hay trabajo
  pendiente, `return` sin escanear nada.

---

_Plantilla del template `<NOMBRE_PROYECTO>`. Ver `01-entornos.md` y `02-sdlc-git-flow.md`._
