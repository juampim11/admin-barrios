# 03 — Modelo de datos, multi-tenancy jerárquica y RLS

> **Fase 6B — diseño de producto.** Diseño (no implementación). El SQL es **ilustrativo**; el esquema
> real se escribe con Drizzle + migraciones `drizzle-kit` en SQL plano en la Fase 6C. Lo marcado
> **[validar]** es propuesta a confirmar. Insumo obligatorio verificado y referenciado (no re-derivado):
> `knowledge/cordoba/REQUISITOS-MODELO-DATOS.md`. Constraints duros del ADR-0000 (§3.1, §5, §7) y de
> `03-reglas-desarrollo-optimizado.md` respetados: Postgres agnóstico (sin features propietarias),
> `app.current_user_id()`, rol de app con `BYPASSRLS` solo server-side, índices en `WHERE`/`JOIN`.

## 0. Principios de cabecera

1. **Dos jerarquías separadas y nunca confundidas** (requisito duro):
   - **Jerarquía de TENANCÍA/acceso** — `tenant_node` (administrador → barrio → subsector). Gobierna
     aislamiento, membresías y permisos. **Profundidad variable.**
   - **Estructura de DOMINIO dentro de un barrio** — `unidad_funcional → propietario/obligado`,
     `expensa`, etc. Son **datos dentro de un tenant**, NO nodos de tenancy. Cada fila de dominio
     "cuelga" de exactamente un nodo barrio.
   - Regla mental: si dos personas de barrios distintos jamás deben verse, la frontera es un **nodo de
     tenancy**; si es estructura interna de un mismo barrio, es **dominio** y lleva la columna de tenant.
2. **Modelo base recomendado:** base y esquema **compartidos**, aislamiento **por fila** vía RLS
   (pooled). Endurecer un tenant grande/sensible es una migración/movimiento de datos, **no un
   rediseño** (§A.7), porque toda fila de dominio nace con su `barrio_id`.
3. **Clave de aislamiento primaria:** igualdad indexada `barrio_id ∈ (conjunto accesible)`. El
   **materialized path** se usa para resolver ese conjunto (consulta de subárbol sobre `tenant_node`,
   tabla chica), no para escanear tablas grandes.
4. **Sin extensiones:** materialized path en `text` con `text_pattern_ops`. `ltree` documentado como
   alternativa (requiere `CREATE EXTENSION`), **no elegida** (§A.6).

---

## A. Multi-tenancy jerárquica + RLS

### A.1 Las dos jerarquías (conceptual)

```
TENANCÍA / ACCESO  (tabla tenant_node — la RLS vive acá)
  Administrador "Estudio Pérez"          tipo=administrador  path=1
   ├─ Barrio "Los Álamos"                 tipo=barrio         path=1.7    figura=ph_especial
   │    └─ Subsector "Náutica interna"    tipo=subsector      path=1.7.30
   └─ Barrio "San Isidro"                 tipo=barrio         path=1.9    figura=sa
DOMINIO (datos DENTRO de un barrio; NO son nodos de tenancy)
  Barrio "Los Álamos" (tenant_node 1.7)
   ├─ unidad_funcional MZ-3-L-12 ── obligado (propietario/poseedor)
   ├─ expensa (período 2026-07, por UF, por coeficiente)
   └─ pago / envío / documento ...
```

### A.2 Tabla de nodos de tenancy — `tenant_node`

```sql
create schema if not exists app;
create extension if not exists pgcrypto;   -- gen_random_uuid()

create type app.tipo_tenant as enum ('administrador', 'barrio', 'subsector');

create table tenant_node (
  id          uuid primary key default gen_random_uuid(),   -- clave pública; FKs de dominio apuntan acá
  nid         bigint generated always as identity unique,     -- segmento de path, inmutable y compacto
  parent_id   uuid references tenant_node(id) on delete restrict,
  tipo        app.tipo_tenant not null,
  nombre      text not null,
  path        text not null,               -- '1', '1.7', '1.7.30' — mantenido por trigger
  deleted_at  timestamptz,                 -- soft-delete (nunca borrado físico de un tenant con datos)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint tenant_node_root_chk check (
    (tipo = 'administrador' and parent_id is null) or
    (tipo <> 'administrador' and parent_id is not null)
  )
);
```

- **Segmento = `nid`** (bigint identity), no el UUID ni el nombre: compacto (`1.7.30` vs 3 UUIDs),
  **inmutable** (renombrar el barrio no toca el path), y numérico (sin `%`/`_` que escapar; válido como
  `ltree` si algún día se migra).
- **Consulta de subárbol** (evita el falso match `1.7` vs `1.70`): `path = '1.7' or path like '1.7.' || '%'`.
- **El path se mantiene por trigger `BEFORE INSERT`** (no en la app): es un invariante de integridad; si
  lo calcula la app, un INSERT por fuera (job, migración, consola) lo corrompe y rompe el aislamiento.

```sql
create or replace function app.tenant_node_set_path() returns trigger language plpgsql as $$
declare v_parent_path text;
begin
  if new.parent_id is null then new.path := new.nid::text;
  else
    select path into v_parent_path from tenant_node where id = new.parent_id;
    if v_parent_path is null then raise exception 'parent_id % inexistente', new.parent_id; end if;
    new.path := v_parent_path || '.' || new.nid::text;
  end if;
  return new;
end; $$;
create trigger trg_tenant_node_path before insert on tenant_node
  for each row execute function app.tenant_node_set_path();
```

### A.3 Membresías, roles y herencia de acceso

Una membresía en el nodo N otorga acceso a **N y a todo su subárbol** (no se enumeran barrios uno a
uno). Un usuario del **administrador** ve todos sus barrios; un usuario de un **barrio** ve solo ese
barrio y sus subsectores; **los barrios hermanos jamás se ven**.

```sql
-- [validar] roles tentativos — a confirmar con producto/seguridad
create type app.rol_membership as enum (
  'admin_plataforma',   -- staff del SaaS (posiblemente rol de BD, no membership — ver A.5)
  'admin_barrio', 'operador', 'contador', 'auditor', 'propietario', 'residente'
);

create table membership (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,             -- id del usuario de la capa de Auth (agnóstico; sin FK a auth.users)
  tenant_node_id uuid not null references tenant_node(id) on delete cascade,
  rol            app.rol_membership not null,
  activo         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (user_id, tenant_node_id, rol)
);
create index idx_membership_user on membership(user_id) where activo;
create index idx_membership_node on membership(tenant_node_id);
```

Los **permisos son por membresía, no globales**: un usuario puede ser `admin_barrio` en `1.7` y
`propietario` en `1.9`. Por eso las escrituras verifican el rol **en el subárbol de esa fila**
(`has_role_on`, §A.5), a diferencia del `auth_rol()` global del sistema de gas (single-tenant).

### A.4 Cómo las tablas de dominio llevan el tenant

Toda tabla de dominio lleva **`barrio_id uuid not null references tenant_node(id)`** (clave de RLS por
igualdad, **estable ante re-parentado**) y, **opcionalmente [validar]**, `tenant_path text`
desnormalizado (solo para analítica de subárbol directa; se acepta el costo de reescritura al mover un
subárbol). El predicado RLS caliente usa **`barrio_id`**, no `tenant_path LIKE` (el `LIKE` con prefijo
no-constante desde un join no usa índice sobre tablas grandes).

### A.5 Funciones helper de RLS y políticas

```sql
-- Del ADR-0000 §3.1 (textual). En Postgres puro sin schema auth, instalar un stub auth.uid() no-op.
create or replace function app.current_user_id() returns uuid as $$
  select coalesce(nullif(current_setting('app.user_id', true), '')::uuid, auth.uid())
$$ language sql stable;

-- Subárbol accesible del usuario actual. STABLE => se evalúa una vez por query (no por fila).
-- SECURITY DEFINER para leer membership/tenant_node sin recursión de políticas.
create or replace function app.accessible_tenant_ids() returns setof uuid
  language sql stable security definer set search_path = public, app as $$
  select distinct d.id
  from membership m
  join tenant_node n on n.id = m.tenant_node_id
  join tenant_node d on d.path = n.path or d.path like n.path || '.%'   -- nodo + su subárbol
  where m.user_id = app.current_user_id() and m.activo
    and n.deleted_at is null and d.deleted_at is null;
$$;

-- Permiso por rol SOBRE un nodo (para escrituras finas).
create or replace function app.has_role_on(target_node uuid, roles app.rol_membership[]) returns boolean
  language sql stable security definer set search_path = public, app as $$
  select exists (
    select 1 from membership m
    join tenant_node mn on mn.id = m.tenant_node_id
    join tenant_node tn on tn.id = target_node
    where m.user_id = app.current_user_id() and m.activo and m.rol = any(roles)
      and (tn.path = mn.path or tn.path like mn.path || '.%')
  );
$$;
```

El `LIKE` de subárbol corre sobre `tenant_node` (**tabla chica**, con índice `text_pattern_ops`), una
vez por query. Las tablas grandes de dominio se filtran por **igualdad** `barrio_id IN (…)`.

Política de ejemplo sobre `expensa` (lectura por tenant; escritura por tenant + rol):

```sql
alter table expensa enable row level security;
alter table expensa force row level security;   -- que ni el owner bypasee

create policy expensa_sel on expensa for select
  using ( barrio_id in (select app.accessible_tenant_ids()) );

create policy expensa_wr on expensa for all
  using     ( barrio_id in (select app.accessible_tenant_ids())
              and app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) )
  with check ( barrio_id in (select app.accessible_tenant_ids())
              and app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) );
```

`tenant_node` y `membership` también llevan RLS (un usuario solo ve nodos/membresías de su subárbol).

**Roles de BD** (equivalente neutral al `service_role` del gas, ADR §4):

```sql
create role app_request nologin;         -- sujeto a RLS; la app hace set_config('app.user_id',$1,true) por transacción
create role app_job login bypassrls;     -- jobs server-side (ingesta multi-barrio, reescritura de paths). NUNCA al cliente.
```

Las tablas las **posee** un rol de esquema distinto de `app_request` (por eso `force row level
security`, ya que el owner ignora RLS por defecto). `app_request` recibe `GRANT` y queda sujeto a RLS.

### A.6 Materialized path (elegido) vs `ltree`

| Criterio | Materialized path (`text` + `text_pattern_ops`) | `ltree` (extensión contrib) |
|---|---|---|
| **Agnóstico de proveedor** | ✅ Núcleo de Postgres, **cero extensiones**; igual en Docker/RDS/Supabase | ⚠️ Requiere `CREATE EXTENSION ltree` — dependencia extra que el constraint desaconseja |
| **Query de subárbol** | `path = X or path like X || '.%'` | `path <@ 'X'` (más ergonómico) |
| **Índice** | btree `text_pattern_ops` | GiST |
| **Portar a ltree después** | Trivial (el path es numérico → `ltree` válido; columna generada `path::ltree`) | — |

**Elegido: materialized path.** El sistema debe correr idéntico en Docker/RDS/Supabase "sin features
propietarias"; `ltree` suma una precondición de despliegue (`CREATE EXTENSION`) que puede no estar
garantizada en todo host. La puerta a `ltree` queda abierta sin rediseñar si un árbol enorme lo
justificara.

### A.7 Endurecer el aislamiento sin rediseñar

El modelo lógico no cambia en ninguno de estos niveles; extraer un tenant es un **copiado filtrado por
`barrio_id`**, no un rediseño:

| Nivel | Qué es | Qué cambia |
|---|---|---|
| **0 — Pooled (default)** | Base+schema compartidos, RLS por fila | — |
| **1 — Rol dedicado por tenant** | ROLE de BD + conexión propia para un tenant grande | Credencial/rol por tenant; RLS igual |
| **2 — Schema-per-tenant** | Tablas del tenant en un schema propio (misma definición) | `search_path`; la capa de datos elige schema |
| **3 — DB-per-tenant** | `DATABASE_URL` propio (aislamiento físico) | Enrutamiento tenant→conexión detrás de `packages/data` |

### A.8 Ajustes que agrega la base de conocimiento

- **Mandato de administración versionado** (no permanente): el vínculo administrador↔barrio es un
  **mandato con inicio y cese**, ligado a un acta de asamblea (arts. 2065/2066: nombrado y removido por
  asamblea, removible sin causa) `[VERIFICADO]` (`nacional/05`, `REQUISITOS §2`). Se modela como una
  entidad `mandato_administracion` versionada; el **árbol** encoda la administración vigente. Cambiar de
  administrador = re-parentar el nodo barrio (caso raro, ver A.9) + cerrar/abrir mandato.
- **Excepciones de aislamiento auditadas:** un barrio puede tener relaciones jurídicas con otros
  (servidumbres entre conjuntos, art. 2084) `[VERIFICADO]` (`REQUISITOS §2`). El aislamiento **no es
  absoluto por diseño**: una tabla `tenant_grant` registra **grants cross-tenant explícitos y
  auditados** (origen, destino, alcance, quién y cuándo), y las políticas los contemplan como excepción
  acotada — nunca un cruce silencioso.

### A.9 Riesgos y edge cases

1. **Mover un subárbol (re-parentado):** reescribe el `path` del nodo y de todos sus descendientes en
   `tenant_node` (y de `tenant_path` en dominio, si se denormalizó). **`barrio_id` NO cambia** (UUID
   estable) → la RLS por `barrio_id` sigue correcta sin tocar el dominio (argumento fuerte para no basar
   el predicado RLS caliente en `tenant_path`). Ejecutar con `app_job`, en transacción, en ventana de
   bajo tráfico. **[validar]** si el producto siquiera permite mover un barrio entre administradores
   (probablemente raro → el caso caro casi no ocurre).
2. **Borrado con hijos/datos:** `on delete restrict` en `parent_id` y en `barrio_id` de dominio impide
   huérfanos; **soft-delete** (`deleted_at`) para tenants. **Nunca** cascada de tenancy a dominio
   financiero (borrar un administrador no borra sus barrios y su plata).
3. **Usuario con membresías en nodos no relacionados:** `accessible_tenant_ids()` devuelve la **unión**
   de subárboles disjuntos; los permisos son por membresía (escrituras via `has_role_on(barrio_id,…)`).
4. **`SET LOCAL app.user_id` + connection pooling (transaction mode):** usar `set_config('app.user_id',
   $1, true)` **dentro de una transacción explícita** (compatible con pgBouncer/Supavisor en transaction
   mode). **Nunca** `SET` de sesión sin `LOCAL` → el valor se pega a una conexión reutilizada por otro
   request/tenant = **fuga de tenant**. Reusar un cliente por request.
5. **Recursión de políticas:** `accessible_tenant_ids()`/`has_role_on()` leen `membership`/`tenant_node`
   (que tienen RLS) → `SECURITY DEFINER` con `search_path` fijo.

---

## B. Dominio del barrio (fundado en `REQUISITOS-MODELO-DATOS.md`)

> Cada entidad remite a su artículo. El modelo **contempla** todo el dominio (incluida la estructura
> forward-compat de Inc. 2), aunque el MVP implemente un subconjunto.

### B.1 Barrio — 5 ejes versionados

El barrio no es un "tipo": lleva **cinco dimensiones ortogonales** (`REQUISITOS §1`), **cualquier
combinación válida**, **versionadas con vigencia temporal**:

| Eje | Valores | Determina |
|---|---|---|
| `figura_juridica` | sa · asociacion_civil · ph_especial · fideicomiso · geodesia | Órganos, instrumentación, vía de cobro |
| `adecuado_art_2075` | si · no · en_tramite · no_aplica | Ejecutividad del certificado de deuda |
| `encuadre_urbanistico` | ure · loteo_abierto · cierre_calles · sin_encuadre | Obligaciones municipales, tasas |
| `municipio` | la-calera · villa-allende · mendiolaza · unquillo · cordoba-capital · … | Capa normativa local |
| `servicios_internos_a_cargo_de` | municipio · urbanizacion · mixto | Adicional tarifario, superposición tasa/expensa |

Se registra también `titularidad_espacios_comunes` (ente vs. propietarios — insumo del Inmobiliario,
`provincial/02`) y la `jurisdiccion` (hoy `cordoba`; multi-jurisdicción por barrio a futuro).

**Modelo híbrido (decisión tomada).** El **valor vigente** de cada eje se guarda como **columna tipada
(enum)** en la entidad `barrio` (lectura caliente sin join y con validación por enum a nivel de base),
y la tabla **`barrio_atributo_vigencia`** (`barrio_id`, `eje`, `valor`, `vigente_desde`, `vigente_hasta`)
guarda el **historial de vigencias** (auditoría + consultar "valor vigente en tal fecha" — ej. liquidar
un período pasado con la figura que regía entonces). Un **trigger** (o la capa de datos, en la misma
transacción) mantiene la columna `barrio.<eje>` sincronizada con la **última vigencia**.

*Tradeoff resuelto:* "solo tabla de vigencias" evita duplicar el dato pero obliga a un join + filtro por
fecha en cada lectura caliente (caro y sin validación por enum); "solo columnas" es rápido pero **pierde
el histórico** (y liquidar un período viejo con el valor de hoy es un error de encuadre). El **híbrido**
da lectura rápida y validada para el "ahora" y trazabilidad temporal para los actos con fecha, al costo
de una sincronización controlada por trigger (la columna es un **cache derivado**; la tabla de vigencias
es la fuente de verdad histórica).

### B.2 Unidad funcional y obligados

- `unidad_funcional`: `barrio_id`, **`manzana`/`lote` estructurados**, `nomenclatura_catastral`,
  **`estado_unidad`** (baldío/en construcción/construido — art. 2077, **generan expensas igual**),
  **`1..N` emails de contacto** (para distribución). `unique (barrio_id, manzana, lote)` (por barrio,
  no global).
- `obligado` / `unidad_obligado`: **múltiples obligados por UF** (propietario + poseedor por cualquier
  título, art. 2050, **sin liberar al propietario**); **histórico de titulares** — la **deuda no se
  reinicia** al cambiar de dueño (art. 2049).
- `coeficiente`: **versionado** por UF (arts. 2046 inc. c, 2081), con **validación de que la suma
  cierre**; soporta prorrateos **no proporcionales** (por lote/superficie/mixto).

### B.3 Expensa, liquidación y conceptos

- `periodo_expensa` (barrio, `YYYY-MM`, estado `borrador→revisada→emitida→distribuida`).
- `concepto`: `tipo` ordinaria/extraordinaria (extraordinaria **exige `respaldo_asamblea`**, art. 2048);
  `clasificacion_fiscal` (expensa alcanzada/no alcanzada IIBB · ingreso_ajeno:&lt;tipo&gt; · no_gravado —
  `provincial/02`); `es_fondo_reserva` (cuenta separada, arts. 2046 inc. d / 2064 inc. c);
  `denominacion_segun_figura` (expensa vs. cuota social/aporte).
- `expensa` / `item_liquidacion`: por UF y período; `coeficiente` aplicado; `monto` (`numeric(14,2)`);
  cada línea con su **origen**. `mora` con tasa **versionada** por barrio.

### B.4 Pagos, conciliación y envíos

> **Implementado (Cobros, migraciones `0032`–`0040`, 2026-08-17/18).** Lo que sigue es el modelo
> **real**, no el boceto de Fase 6B — se revisó en panel (`arquitecto-software`, `security-engineer`,
> `dba-data`) antes de construirse y difiere del texto original en tres puntos, con motivo:

- `pago`: `barrio_id`, `unidad_funcional_id` (**no** `unidad_obligado_id` — la deuda se ancla a la UF,
  mismo criterio que `liquidacion`), `obligado_id` nullable, monto, fecha, **`origen`**
  (`extracto`|`manual`), **`estado_conciliacion`** (`pendiente`|`conciliado` — el segundo valor es un
  gancho para el motor de conciliación futuro, todavía no se setea desde ningún lado de esta tanda).
  Los **manuales** exigen `usuario_registrador` + `comprobante_adjunto` (storage key con el
  `barrio_id` adentro, mismo endurecimiento que `documento_emitido`). **Sin `flag_antiduplicado`**:
  se evaluó y se sacó — se solapaba enteramente con `estado_conciliacion` sin agregar información
  distinta.
- `pago_imputacion`: puente `pago_id` + **`liquidacion_id`** (**no** `item_liquidacion_id` — cambio
  de grano respecto del boceto original: "débitos (liquidaciones)" ya lo decía el doc 01 §4.4, y
  `liquidacion.total`/`interes_mora` traen el agregado que hacía falta sin reconstruirlo por
  concepto), `monto_imputado`, con su propia anulación (no solo la del `pago`). El candado de
  concurrencia es `for update` de `pago` y después de `liquidacion`, siempre en ese orden — sobre-
  imputación bloqueada contra los dos lados, verificado con un test de dos conexiones reales.
- `barrio.orden_imputacion`: **nullable, sin default, a propósito** (doc 01 §3 punto 4: "el sistema
  nunca inventa un orden de imputación"). `app.resolver_imputacion()` falla cerrado si no está
  configurado — un pago se puede registrar igual, la imputación automática es lo único que espera el
  criterio. **Pendiente de hablar con `administrador-consorcios`:** con el grano en `liquidacion`,
  `capital_primero` y `fifo_estricto` se comportan igual hoy (no hay desglose capital/interés por
  liquidación); solo `intereses_primero_capital_antiguo` difiere.
- `app.v_estado_cuenta_uf`: vista SQL (no materializada) para el detalle de UNA unidad —
  **`security_invoker = true` es obligatorio**, hallazgo bloqueante del panel (sin eso, la vista
  corre con los privilegios del dueño del esquema y filtra el estado de cuenta de todos los
  barrios). Para la grilla de "todas las unidades del barrio" existe `saldo_uf`, el saldo mantenido
  **incrementalmente por trigger** — la vista con `window function` sobre todo el historial mide
  350 ms con sort a disco en un barrio de 510 UF, y ese costo crece con los años.
- `recibo_emitido` + `recibo_secuencia`: el recibo de un pago. **No se reusa `documento_emitido`**
  (su `periodo_id` es `NOT NULL` y su `storage_key` está atada a `.../periodos/{uuid}/...`; un
  recibo cuelga de un `pago`, que puede repartirse en varios períodos). El número de recibo es
  **secuencial por barrio** (no un `IDENTITY` global de plataforma como `tenant_node.nid`): es dato
  legal impreso, y un administrador no espera que su numeración salte por actividad de otro barrio.
  La descarga reusa `descarga_documento`, generalizada con FK nullable por tipo de documento (URL
  firmada, TTL≤600s — nunca se sirve la `storage_key` cruda).
- **Migración `0042` — reserva del número separada del `insert` (riesgo aceptado, Nivel 1).** El
  número tiene que estar impreso DENTRO del PDF, y el PDF se renderiza **fuera de transacción**
  (mismo patrón "objeto primero, fila después" que la boleta). Por eso `app.reservar_numero_recibo()`
  extrae la reserva de `app.recibo_antes()`: el servicio reserva el número ANTES de renderizar, y el
  trigger lo respeta si ya viene seteado en el `insert` (en vez de reasignarlo) — mismo criterio que
  ya anotaba ADR-0001 §13. Esto abre una ventana real: si el proceso muere entre reservar el número y
  completar el `insert` de la fila, ese número queda consumido sin recibo asociado — un hueco en la
  secuencia del barrio.
  Panel `arquitecto-software` + `dba-data` + `security-engineer` (evaluación técnica) y `legal-ph` +
  `contador` (evaluación de dominio), 2026-08-20. **La distinción exacta, tal como la dieron los dos
  agentes de dominio — no "está permitido tener huecos"**: un hueco raro por fallo de proceso entre
  reservar el número y completar la emisión no fue identificado como riesgo legal/fiscal por
  `legal-ph` ni por el agente contable (recibo no es documento con formalidad especial bajo CCyC —
  art. 2048 es el certificado de deuda, no el recibo — y el recibo ya es explícitamente no fiscal por
  decisión de producto en `07-liquidacion-pdf.md` §C.1); ambos señalan que esto es un **vacío de
  fuente, no una autorización normativa**, y piden **validar con profesional matriculado** antes de
  tratarlo como definitivo. No se implementó la garantía de cero huecos (Nivel 2: columnas
  `numero_reservado`/`reservado_at` en `trabajo`, reintento reusa el número ya reservado) porque
  ningún agente de dominio la exigió y agrega superficie real para cerrar un riesgo que nadie marcó
  como grave. Mitigación operacional aparte, independiente de esta pregunta legal: `MAX_INTENTOS_TRABAJO`
  (`packages/shared/src/trabajos.ts`) le pone techo a cuántas veces se puede reintentar a mano la
  emisión de un mismo pago, para que un dato que nunca va a renderizar no queme la numeración del
  barrio indefinidamente. Detalle completo en el comentario de cabecera de
  `packages/data/migrations/0042_reserva_numero_recibo.sql`.
- `trabajo.tipo` pasó de enum nativo a `text` + `CHECK` (mismo patrón que
  `liquidacion.saldo_anterior_origen`). **Regla de repo nueva, de acá en más:** ningún enum nativo se
  hace crecer después de creado — `pnpm db:migrate` aplica todas las migraciones pendientes de una
  corrida en una sola transacción (confirmado leyendo `drizzle-orm/pg-core/dialect.js` y contra
  Postgres real), así que un `ALTER TYPE … ADD VALUE` seguido de su uso en la misma corrida falla.
  Un catálogo que se espera abierto nace `text`+`CHECK` desde el día uno.
- Motor de conciliación automática (`movimiento`/`transferencia`, `conciliacion`, `alias_ordenante`,
  `comprobante`, `conciliacion_imputacion`, `ordenante_reparte`) y `envio_liquidacion`: **fuera de
  esta tanda**, siguen como boceto de Fase 6B (ver doc 02). `estado_conciliacion = 'conciliado'` es
  el único gancho que ya existe para cuando se construyan.

**Backend probado, UI sin empezar.** `packages/data` (migraciones, schema, servicios
`pagos.ts`/`cobros.ts`) con 388/388 tests contra Postgres real (aislamiento, anulación, sobre-
imputación, concurrencia real con dos conexiones, `security_invoker`). Sin pantallas en `apps/web`
todavía. Detalle completo: `HANDOFF.md`, entrada del cierre del backend de Cobros.

### B.4bis Proveedores y órdenes de pago

> **Implementado (migraciones `0043`–`0047`, 2026-08-21).** Doc 01 §4.6, sin boceto previo en este
> archivo — el diseño de datos partió de cero, en panel doble (`administrador-consorcios` + `legal-ph`
> para estados/transiciones; `arquitecto-software` + `dba-data` + `security-engineer` para la revisión
> técnica) antes de escribir ninguna migración.

- `orden_pago`: el circuito, con seis estados y una lista blanca de transiciones sin vuelta atrás —
  `pendiente → aprobada|rechazada`, `aprobada → pagada|anulada`, `pagada → conciliada|anulada`. La
  corrección post-`pendiente` es **anular con motivo y cargar de nuevo**, nunca editar (mismo criterio
  que `pago`/`aplicacion`). `app.orden_pago_transicion()` (un solo trigger `before insert or update`,
  no `security definer` — mismo motivo que `app.pago_antes()`) hace: congelamiento de columnas de
  negocio fuera de `pendiente` (con excepción null→valor para `medio_pago` y `comprobante_adjunto`,
  que llegan después del alta), los gates de rol por transición, el control de cuatro-ojos, y la
  generación/reversión de `gasto_periodo`.
- **`orden_pago` PRODUCE una fila de `gasto_periodo`, nunca al revés** — la FK vive en el efecto
  (`gasto_periodo.orden_pago_id`), igual que `pago` → `pago_imputacion`. Se genera al llegar a
  **`aprobada`**, no a `pagada`: es el criterio **devengado** (doc `10-informe-mensual-y-mora.md` §B —
  el gasto cuenta en el prorrateo del período aunque el pago físico todavía no se concretó), y el
  fail-closed contra un período ya emitido **no se duplica**: como el `insert` en `gasto_periodo` corre
  en la misma transacción que la transición, si `app.periodo_editable()` (`0023`) dispara, la
  transacción entera se revierte y la orden queda como estaba. `gasto_periodo` sigue existiendo tal
  cual para el caso simple sin proveedor (una única fila, sin `orden_pago_id`).
- **Anulación con reversión, "bloquear, no inventar" (dba-data, panel):** si la OP ya generó su cargo y
  el período de origen sigue en `borrador`, se borra directo. Si el período de origen ya no es
  editable, el ajuste (monto negativo, `gasto_periodo_origen_id` apuntando al cargo) va al período
  **abierto actual** del barrio — nunca al de origen. Si no hay **exactamente uno** en `borrador` (cero
  o más de uno), la anulación se rechaza en vez de elegir: es una decisión de negocio que un trigger no
  toma en silencio.
- **Cuatro-ojos, configurable por barrio, no universal** (`barrio.orden_pago_cuatro_ojos`, default
  `false`): quien carga la orden no puede ser quien la aprueba, si el barrio lo tiene activo.
  `administrador-consorcios` + `legal-ph` (consulta acotada, 2026-08-21): no hay requisito normativo
  que lo vuelva obligatorio para PH especial (con cita); para SA/asociación civil/fideicomiso,
  `legal-ph` no tiene fuente cargada y lo dice en vez de asumir. Un barrio de un solo `admin_barrio` es
  caso real, no de borde — por eso configurable y con default `false`, no obligatorio.
- **`operador` excluido solo de `pendiente → aprobada`, no de `→ pagada`**: aprobar es decidir gastar
  (reservado a `admin_barrio`/`admin_plataforma`); ejecutar un pago ya aprobado es tarea mecánica —
  reservarla también a `admin_barrio` genera el mismo cuello de botella que termina resuelto
  compartiendo credenciales (`administrador-consorcios`, panel).
- **`barrio.orden_pago_cuatro_ojos` no es autoconfigurable por `admin_barrio`** — igual que
  `barrio.orden_imputacion` no depende de un rol de negocio, sino de que la columna en sí no sea
  escribible desde `app_request`. **Hallazgo lateral real, no hipotético**, al resolver esto: `barrio`
  tenía `grant update` de TABLA ENTERA a `app_request` desde `0003_dominio_rls.sql`, sin restricción de
  columna — `admin_barrio`/`operador` ya podían escribir cualquier columna, incluida `orden_imputacion`
  (`0036`, tanda de Cobros, ya commiteada, con el mismo agujero desde que se agregó). El fix
  (`revoke`/`grant update` con lista explícita, mismo patrón que `0017_cargos_endurecimiento.sql`) va
  en commit separado de la feature — es un bug preexistente en código ya commiteado, no una
  consecuencia de esta tanda. Detalle completo: comentario de cabecera de
  `0047_barrio_orden_pago_cuatro_ojos.sql` y `HANDOFF.md`.
- `proveedor`: reusa el patrón CBU/alias de `medio_pago_barrio` (columnas propias, mismo `CHECK` de 22
  dígitos). Nunca se borra — se desactiva (`activo`), mismo criterio que el resto del catálogo del
  barrio.
- `subida_comprobante_solicitada` **generalizada** (mismo patrón que `0039`, aplicado ahí a
  `descarga_documento`) en vez de una tabla gemela: `unidad_funcional_id` pasa a nullable,
  `orden_pago_id` nuevo, `CHECK` de "exactamente uno de los dos", y el `CHECK` de `storage_key` admite
  las dos formas de ruta. `claveDeComprobanteDeOP()` (`packages/almacenamiento`) arma
  `barrios/{barrioId}/ordenes-pago/{ordenPagoId}/{token}.{ext}`.
- **`facturaAdjunta` (0048) — el documento del proveedor, distinto del comprobante de pago del
  barrio.** Auditoría de dominio (2026-08-22) encontró que `comprobanteAdjunto` es la prueba de que
  el barrio pagó (mismo concepto que en Cobros) y `numeroFactura` es solo un número en texto — no
  había forma de adjuntar la factura/ticket en sí. `facturaAdjunta` cierra ese hueco con el mismo
  patrón de adjunto tardío (`claveDeFacturaDeOP()`, ruta con `/factura/` para no confundirse con la
  del comprobante) y la misma excepción de congelamiento (null → valor sí, valor → otro no).
  **`facturaNoDisponible`/`motivoFacturaNoDisponible`** — panel `administrador-consorcios` +
  `contador`: NO es lo mismo que "todavía no llegó" (eso es solo `facturaAdjunta is null`, sin marca,
  para no meter fricción en el caso normal); es la declaración deliberada de que esta orden nunca va
  a tener factura (proveedor informal), insumo del libro de egresos (doc `04-requisitos-dominio.md`).
  A diferencia de `sinRespaldoAsamblea` (que se snapshotea en una boleta y por eso se congela para
  siempre), acá no hay ningún tercero cuyo reclamo dependa del dato: nunca se congela, se puede
  sanear. **La mutua exclusión de los dos vive en `orden_pago_factura_exclusiva_chk`, no en lógica de
  aplicación** — `adjuntarFacturaDeOP()`/`marcarFacturaNoDisponibleDeOP()` se limpian el uno al otro
  en el mismo `UPDATE` por eso, no porque sea buena costumbre: el `CHECK` rechaza cualquier fila que
  no lo respete, la escriba el código que la escriba.

**Backend probado, UI sin empezar.** `packages/data` (migraciones, schema, servicios
`proveedores.ts`/`ordenes-pago.ts`) con 25 tests nuevos contra Postgres real (circuito completo,
congelamiento, fail-closed, reversión con y sin período destino, cuatro-ojos, aislamiento). Detalle
completo: `HANDOFF.md`, entrada del cierre de esta tanda.

### B.4ter Exportación de movimientos (traza)

> Implementado 2026-08-26. Decisión completa: **ADR-0004**
> (`docs/arquitectura/04-exportacion-de-movimientos.md`). Migraciones `0050`/`0051`.

- **`exportacion_movimientos`** — la traza de cada extracción del libro de movimientos (doc 01 §4.8).
  `barrio_id`, `solicitado_por` (la escribe la base desde `app.current_user_id()`), `solicitado_at`,
  `periodo_desde`/`periodo_hasta` (`YYYY-MM`, **no** FK a `periodo_expensa`: un rango puede incluir
  meses sin período creado), `alcance`, `formato`, `filas_ingresos`/`filas_imputaciones`/
  `filas_egresos`, `incluyo_provisorio`. **Append-only** (`app.solo_append()`), sin `update` ni
  `delete` en los grants.
- **Sin PII, sin montos, sin totales, sin IP ni user-agent, sin nombre de archivo ni hash**, y con
  columnas tipadas en vez de `jsonb` libre: si no, el próximo filtro que se agregue arrastra el
  nombre de un proveedor adentro de la tabla de auditoría. Lo de IP/user-agent sigue el precedente
  explícito de `descarga_documento`.
- **No es un quinto caso de `descarga_documento`, y la analogía se rompe a propósito** (ADR-0004 §3.1):
  esa tabla exige "exactamente una referencia" a una fila que existe, y tiene `ttl_segundos NOT NULL`.
  Una exportación **no tiene artefacto ni URL firmada**. Precedente propio de tabla nueva cuando la
  forma no es la misma: `recibo_emitido` (`0038`).
- **El `insert` es el gate de rol de la feature.** Como la exportación es síncrona y no deja
  artefacto, no hay tabla sobre la cual poner una policy de `select` que decida quién exporta:
  poniéndolo acá, *no se puede exportar sin dejar rastro ni dejar rastro sin tener el rol*.
  `admin_plataforma`/`admin_barrio`/`contador` siempre; `operador` **nunca**; `auditor` según
  `barrio.auditor_exporta_movimientos`.
- **`barrio.auditor_exporta_movimientos`** (`0050`) — tercera columna de gobierno del barrio, y la
  primera que **nace cerrada**: su `revoke`/`grant` de columna va en la misma migración que la crea,
  junto a `orden_imputacion` y `orden_pago_cuatro_ojos`. Ninguna de las tres es escribible por
  `app_request`. ⚠ `revoke` + `grant (columnas)` **no es incremental**: toda migración que lo toque
  tiene que volver a nombrar las 17 columnas escribibles, y hay un test que verifica el conjunto
  exacto.

### B.4quater Distribución de liquidaciones (paquete, manifiesto y envíos)

> Implementado 2026-08-29/30. Decisión completa: **ADR-0005**
> (`docs/arquitectura/05-distribucion-de-liquidaciones.md`). Migraciones `0052`/`0053`/`0054`.

- **`paquete_distribucion`** — el ZIP con las boletas de un período. `barrio_id` y `armado_por` **los
  escribe la base** (trigger `before insert`), no viajan en el `insert`. `storage_key` con su propio
  `CHECK` (`paquete_storage_key_chk`), espejo de `SUFIJO_PATRON_CLAVE_PAQUETE`: carpeta `/paquetes/`
  propia, y **no** una alternancia más de la de documentos. Dos motivos que se refuerzan: es la única
  extensión que no es `.pdf`, y es **el prefijo sobre el que va a apuntar la regla de expiración del
  bucket** — un objeto que expira mezclado con los que no expiran es un accidente esperando.
- **`paquete_distribucion_item`** — el manifiesto. **Tabla hija y no un `jsonb`**, por el mismo
  argumento con el que este repo ya rechazó lo polimórfico en `descarga_documento`: conserva la
  integridad referencial real, y permite contestar *"¿a este paquete le faltan boletas emitidas
  después de armarlo?"* con **una consulta** y no con una interpretación. Es lo que vuelve legible el
  "vigente / superado", noción que `documento_emitido` deliberadamente no tiene porque un paquete es
  un artefacto **derivado**. **Sin `barrio_id` propio:** el tenant lo hereda del paquete
  (`paquete_id`, `on delete cascade`), que es lo que impide que un ítem quede apuntando a otro barrio
  que el de su propio ZIP.
- **`envio_liquidacion`** — el registro por destinatario, que **además es el guard de idempotencia**.
  Clave `uq_envio_periodo_contacto`; la fila **nace y se commitea antes del `sendMail()`**, con
  `on conflict do nothing`. Guarda **cuál** boleta viajó (`documento_id`), porque con una reemisión
  "la boleta de esa unidad" es ambiguo. El trigger `app.envio_antes_insert()` deriva la unidad **desde
  la liquidación del documento** y rechaza la fila si no coincide con la del contacto — es lo que
  impide el modo de falla clásico del lote, que es mandarle a un vecino la boleta de otro.
  - **Estados y transiciones** (`0054`). Son **cinco** cláusulas, leídas de la función viva:
    `pendiente → enviando | cancelado`, `enviando → aceptado | fallado`, `fallado → pendiente`,
    `cancelado → pendiente`, `aceptado → rebotado`. Invariante acompañante:
    `aceptado_at is not null` ⇔ estado ∈ (`aceptado`, `rebotado`).
    > ⚠ **Corrección (2026-08-30).** Este renglón decía "verificadas en la base" y listaba solo las
    > dos primeras, afirmando que **de `enviando` no se sale solo**. Es falso: `enviando → fallado`
    > y después `fallado → pendiente` son dos saltos legales, y el trigger valida **salto por salto,
    > no la historia**, así que una fila en estado *desconocido* —el correo puede haber salido—
    > vuelve a la cola. Hoy eso no produce un duplicado **solo porque lo tapa otro bug** (el claim
    > siempre reescribe `mensaje_id`, que `0054` congela, y el reclamo revienta). Los dos se cierran
    > juntos en `0055`, con `enviando` como puerta de una vía y `fallado` terminal. El detalle está
    > en el ADR-0005 y en `HANDOFF.md`.
  - **`0055` cierra la puerta.** Transiciones finales: `pendiente → enviando | cancelado`,
    `enviando → aceptado | fallado`, `cancelado → pendiente`, `aceptado → rebotado`. **`fallado` es
    terminal** y `fallado → pendiente` **se eliminó**. Lo sostiene una invariante y no la lista:
    **ENV-1** (`envio_pendiente_virgen_chk`) — `estado <> 'pendiente' or (mensaje_id is null and
    intento = 0)`, o sea *una fila en `pendiente` nunca fue entregada al transporte*. Al ser un
    `CHECK`, vale aunque alguien reponga la arista. No hizo falta columna nueva: `intento` ya era ese
    registro, y `0055` lo vuelve un hecho (**solo lo mueve el claim, y de a uno**). Se suman: no se
    pasa a `enviando` sin `mensaje_id`, `trabajo_id` entra al congelamiento de identidad, y
    `error_codigo` gana tope de 60 caracteres.
  - **`0055` también cierra tres agujeros del `insert`**: `periodo_id`, `email_snapshot` y
    `email_hash` **los escribe la base** (los declaraba el llamador), y `informe_documento_id` se
    valida contra `documento_emitido` con `tipo = 'informe_mensual'` **y el mismo período**.
    `paquete_distribucion_item` deja de aceptar documentos de otro barrio o de otro período.
  - **Y la omisión que se repitió dos veces**: `app.descarga_antes_insert()` derivaba el barrio de
    tres de sus **cinco** referencias. `0049` agregó `orden_pago_id` y `0052` agregó `paquete_id`, y
    ninguna de las dos tocó la función — así que la descarga del ZIP y la del comprobante/factura de
    una orden de pago **fallaban siempre** con un 500. `0055` agrega las dos ramas.
  - **`sin_contacto` estaba en el `CHECK` de `0052` y `0054` lo sacó**: `unidad_contacto_id` es
    `not null`, así que una unidad sin casilla **no puede tener fila acá**. Se cuenta aparte
    (`unidadesSinContacto` del panorama), que es lo que permite que la pantalla diga "a estas N no se
    les escribió" en vez de callarlo.
  - ⚠ **`rebotado` existe en el enum y NINGÚN productor lo escribe.** El manejo de rebotes está
    recortado con su motivo escrito (ADR-0005 §6.1, doc 01 §4.8): parsear correo entrante es
    superficie de entrada nueva y un DSN falsificado marcaría `rebotado` un envío que sí llegó. Los
    ganchos puestos son **`mensaje_id`** (correlaciona el DSN con la fila) y **`SMTP_DOMINIO_REBOTES`**
    para VERP. La regla **DIST-2** del gate prohíbe `imapflow`/`mailparser` mientras tanto.
  - **`aceptado` significa "aceptado por el servidor SMTP"**, que no es lo mismo que "llegó a la
    casilla". La diferencia importa y por eso el estado no se llama `entregado`.
- **Los tres tipos de trabajo nuevos** (`emitir_informe_periodo`, `armar_paquete_periodo`,
  `distribuir_liquidaciones`) entraron como **un renglón** del `trabajo_tipo_chk`, porque
  `trabajo.tipo` es `text` + `CHECK` desde `0039` y no un enum nativo. Son tres y no uno porque el
  tope de reintentos y `fallado` son **por fila**: con un solo trabajo, un fallo al armar el ZIP
  quemaría un intento del envío.
- **El gate de rol de la distribución vive en `app.trabajo_antes_insert()`**, junto con las cuatro
  precondiciones materiales (período emitido, boletas, informe, paquete). `operador` **no** puede
  distribuir aunque sí pueda emitir documentos: mandar PII a casillas externas no hereda la
  autorización de escribir un PDF adentro del sistema. Está en el trigger y no en el servicio porque
  el rol de request inserta en `trabajo` directo — mismo criterio que `0051` con la exportación.

### B.5 Cobranzas, certificado y documentos

- `certificado_deuda`: emitido por el **administrador** y **aprobado por el consejo si existe**
  (art. 2048); trazabilidad (quién, cuándo, qué períodos, sobre qué instrumento).
- Flags por barrio (para no asumir ejecutabilidad): `reglamento_inscripto`, `pacto_ejecutividad`,
  `adecuado_art_2075`, `tiene_espacios_comunes_exclusivos` (`jurisprudencia/01`). **Al menos dos caminos
  de reclamo** (ejecutivo/ordinario), **sugerir** el aplicable con aviso de validación. **El sistema
  nunca asume que la deuda es ejecutable.**
- `documento_barrio` (**datos de primera clase**, no adjuntos sueltos): reglamento/estatuto, instrumento
  municipal de aprobación (crítico en La Calera), actas, acta de designación del administrador,
  constancia de adecuación, pacto de ejecutividad (`REQUISITOS §9`).

### B.6 Forward-compat (Inc. 2, el modelo los contempla)

- **Asambleas:** `asamblea`, `orden_del_dia`, `voto` — motor de **doble mayoría** (unidades **y** partes
  indivisas) sobre **la totalidad del padrón** (art. 2060), **quórum configurable y posiblemente ausente**
  (no imponer default), mayorías por tipo de decisión (arts. 2057/2059/2060), 5% para forzar tratamiento
  (art. 2058), libro de actas y de firmas (art. 2062).
- **Accesos/reservas:** tres categorías (propietario/familiar/invitado), permiso **personal e
  intransferible** (art. 2083), alcance en amplitud + temporalidad, condiciones por barrio; espacios
  comunes tipificados (art. 2076).
- **Convivencia/obras/transmisión:** infracciones + circuito sancionatorio (arts. 2078/2080/2086),
  aprobación de obras (art. 2080), derecho de preferencia (art. 2085).

### B.7 Guardrails de diseño ("lo que el sistema NO debe hacer", `REQUISITOS §10`)

No asumir que todo barrio es PH · **no asumir que la deuda es ejecutable** · no imponer quórum por
defecto · no calcular mayorías sobre los presentes · no tratar el coeficiente como porcentual de parte
indivisa en todos los casos · no permitir que un invitado transfiera su autorización · no dar por buena
una respuesta legal/fiscal sin "**Validar con profesional matriculado**".

---

## C. Generación de PDF (decisión documentada)

Como el sistema corre en **Docker** (sin las limitaciones serverless del sistema de gas, que forzaban
hacks de bundle para fuentes de pdfjs), la liquidación PDF por UF se genera **server-side con HTML→PDF
vía Chromium headless (Playwright)**: da **fidelidad** y **reusa las plantillas y design-tokens** de la
web (una sola fuente visual). Alternativa pura-JS `@react-pdf/renderer` si se prefiere evitar el binario
de navegador en la imagen. La generación corre en un **job con presupuesto de tiempo** (no en cada
request; regla de recursos), y el resultado se guarda vía `ObjectStorage`. **[validar]** elección final
Playwright vs `@react-pdf/renderer` al construir el módulo.

---

## D. Índices (alineado con `03-reglas-desarrollo-optimizado.md`)

```sql
create unique index uq_tenant_node_path on tenant_node(path);
create index idx_tenant_node_path_prefix on tenant_node(path text_pattern_ops);   -- subárbol
create index idx_tenant_node_parent on tenant_node(parent_id);
-- membership: hot path por usuario
create index idx_membership_user_activo on membership(user_id) where activo;
-- Dominio: FK barrio_id SIEMPRE indexada (patrón obligatorio en cada tabla)
create index idx_expensa_barrio on expensa(barrio_id);
create index idx_uf_barrio on unidad_funcional(barrio_id);
-- ... una por tabla de dominio
```

`text_pattern_ops` es necesario para que `LIKE 'prefijo%'` use índice cuando la collation no es `C`
(caso RDS/Supabase). Índices **parciales** (`where activo`, `where deleted_at is null`) para bajar Disk
IO. **[medir antes de optimizar]**: validar con `pg_stat_statements`/`EXPLAIN ANALYZE` con carga real.

---

## E. Nota de implementación (Drizzle)

El esquema (`tenant_node`, `membership`, dominio) se define en TS de Drizzle (tipos inferidos, sin
`supabase gen types`). Enums, RLS, triggers y funciones `app.*` van en las **migraciones SQL planas** de
`drizzle-kit` (Drizzle no modela RLS/policies/funciones nativamente). Migración inicial sugerida
**[validar]**: `0001_tenancy.sql` (schema `app`, enums, `tenant_node`, `membership`, triggers,
funciones, roles) separada de `0002_dominio.sql`.

## F. Abierto / a validar

- Enum `rol_membership` y si `admin_plataforma` es membership o rol de BD.
- `tenant_path` denormalizado en dominio (sí/no según analítica).
- Tabla local `app_user` con FK vs `user_id` suelto contra la capa de Auth.
- Policies fila-a-fila para `propietario`/`residente` (ver solo lo suyo) por encima del aislamiento de tenant.
- Si el producto permite mover barrios entre administradores (define si el caso caro de A.9.1 importa).
- Motor de PDF (Playwright vs `@react-pdf/renderer`).
