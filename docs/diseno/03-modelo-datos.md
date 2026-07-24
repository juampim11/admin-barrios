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

- `pago`: `barrio_id`, UF/obligado, monto, fecha, **`origen`** (`extracto` | `manual`),
  **`estado_conciliacion`**. Los **manuales** exigen **`usuario_registrador`** + **comprobante
  adjunto** (dinero trazable) y un **flag antiduplicado** (dedupe si luego aparece en un extracto —
  alerta, **nunca imputar dos veces**).
- Tablas del motor de conciliación (con `barrio_id` y RLS): `movimiento`/`transferencia`, `conciliacion`,
  `alias_ordenante`, `comprobante`, `conciliacion_imputacion`, `ordenante_reparte` (ver doc 02).
- `envio_liquidacion`: registro de envíos (destinatario, fecha, **estado** enviado/rebotado/pendiente).

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
