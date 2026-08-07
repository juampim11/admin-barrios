# `packages/data`

Capa de datos **neutral** (ADR-0000 §3.1): Drizzle sobre Postgres, sin SDK de ningún proveedor. Acá
vive el **aislamiento entre barrios** — la pieza que, si falla, hace fallar todo lo demás.

## Puesta en marcha (local)

```bash
pnpm db:up        # postgres + minio en Docker
cp .env.example .env
pnpm db:migrate   # aplica las migraciones SQL planas
pnpm db:setup     # crea los roles de login locales (app_request_dev / app_job)
pnpm db:seed      # barrio de demostración: 50 unidades + un período liquidado y emitido
pnpm test:db      # 60 tests de aislamiento y reglas de negocio contra la base real
```

`pnpm db:reset` borra y recrea la base local (se niega a correr contra una URL que no sea local).

## Las tres conexiones

| Variable | Rol de Postgres | Para qué |
|---|---|---|
| `DATABASE_URL` | dueño del esquema | **solo** migraciones y administración |
| `DATABASE_URL_APP` | `app_request` (vía `app_request_dev`) | atender requests — **sujeto a RLS** |
| `DATABASE_URL_JOB` | `app_job` (`BYPASSRLS`) | jobs server-side. **Nunca** para un request de usuario |

Los roles nacen **sin contraseña** en la migración (un secreto jamás va al repo); cada entorno se
las asigna. En local lo hace `pnpm db:setup` leyendo el `.env`.

## Cómo se usa desde el negocio

```ts
const db = crearDb(crearPoolRequest());

await conUsuario(db, sesion.userId, async (tx) => {
  // Todo lo de adentro corre con la identidad del usuario: la RLS decide qué ve y qué toca.
  return tx.select().from(schema.tenantNode);
});
```

`conUsuario` abre una transacción y hace `set_config('app.user_id', …, **true**)`. El `true` es lo
que hace el valor **local a la transacción**: sin él, la identidad quedaría pegada a la conexión del
pool y el siguiente request vería el tenant anterior (hay un test que lo verifica).

## Migraciones

SQL plano versionado, aplicable con `drizzle-kit migrate` contra cualquier Postgres (Docker, RDS,
Supabase, Neon).

| Archivo | Qué trae |
|---|---|
| `0000_tenancy.sql` | Generada desde el esquema TS: `tenant_node`, `membership`, `tenant_grant`, enums e índices |
| `0001_tenancy_rls.sql` | Escrita a mano: `app.current_user_id()`, `accessible_tenant_ids()`, `has_role_on()`, triggers de path, roles y **todas las policies** |
| `0002_dominio.sql` | Generada: padrón del barrio — `barrio` (5 ejes) + `barrio_atributo_vigencia`, `unidad_funcional`, `unidad_contacto`, `obligado`, `unidad_obligado`, `coeficiente_version`, `coeficiente`, `documento_barrio`, `mandato_administracion` |
| `0003_dominio_rls.sql` | Escrita a mano: FKs compuestas anti-cruce, vigencia de los 5 ejes, cuadre de coeficientes y RLS del dominio |
| `0004_expensas.sql` | Generada: `concepto`, `tasa_mora`, `periodo_expensa`, `gasto_periodo`, `liquidacion`, `item_liquidacion` |
| `0005_expensas_rls.sql` | Escrita a mano: período emitido inmutable, cuadre al emitir, transiciones de estado y RLS |
| `0006_modelos_expensa.sql` | Generada: `cuota_fija_version`, `cuota_fija`, `periodo_expensa.modelo`, marca de extraordinaria sin acta |
| `0007_modelos_expensa_reglas.sql` | Escrita a mano: cuadre por modelo, vigencia de la cuota fija, la extraordinaria sin acta se marca (ya no se bloquea) |
| `0008`–`0017` | Trazabilidad de la liquidación, partes iguales, seguridad del período y el módulo de cargos/descuentos. El encabezado de cada archivo dice qué trae y por qué |
| `0018_rls_lectura_por_rol.sql` | Escrita a mano: **la lectura del dominio pasa a exigir rol de gestión** (`app.readable_tenant_ids()`), `propietario`/`residente` quedan sin acceso, y los mandatos de administración no se pueden solapar (`btree_gist`) |

**Regla:** una migración ya aplicada no se edita — se agrega la siguiente con prefijo mayor. Las
tablas se modelan en `src/schema/*.ts` y se regeneran con `pnpm db:generate`; lo que Drizzle no
modela (funciones, triggers, RLS, roles) se escribe a mano con `drizzle-kit generate --custom`.

## Decisiones que conviene no re-descubrir

- **El gate de rol en la RLS se escribe como CONJUNTO, no como función por fila.** Toda policy de
  `select` con datos de barrio usa `barrio_id in (select app.readable_tenant_ids())`. La forma
  importa: `app.has_role_on()` es `SECURITY DEFINER` y Postgres **nunca inlinea** una función
  `SECURITY DEFINER`, así que se llama una vez por fila. Medido sobre 48.000 ítems de liquidación:
  21,6 ms sin gate · **4.518,8 ms** con `has_role_on` por fila · 32,2 ms con el conjunto (InitPlan
  hasheado, una evaluación por query). Si alguien agrega una tabla de barrio, la policy va con la
  función de conjunto — y hay un test de catálogo que falla si no.
- **`app.accessible_tenant_ids()` NO mira el rol y no sirve para autorizar lecturas de negocio.**
  Solo sirve para tenancía (`tenant_node`, y la rama "mi propia membresía" de `membership`). Para
  cualquier tabla con `barrio_id` va `readable_tenant_ids()`. Confundirlas es exactamente el bug que
  cerró 0018.
- **La política de lectura de `tenant_node` mira también al padre.** No amplía el acceso (si se ve el
  padre, el hijo ya está en su subárbol): es lo que hace posible `insert … returning`, porque
  `accessible_tenant_ids()` es `STABLE` y no "ve" la fila recién insertada.
- **El trigger de path lee bajo RLS.** Colgar un nodo de un barrio ajeno falla con "parent_id
  inexistente" en vez de un error de policy: para ese usuario, el barrio ajeno no existe. Es
  deliberado — el sistema no confirma la existencia de tenants ajenos.
- **No hay policy de `DELETE` ni privilegio de DELETE para `app_request`.** La baja de un tenant es
  lógica (`deleted_at`): un dato financiero no se evapora desde la app.
- **Las funciones `app.*` son `SECURITY DEFINER` con `search_path` fijo**: leen `membership` sin caer
  en recursión de políticas y sin que un `search_path` del cliente pueda secuestrarlas.

### Del padrón (0002/0003)

- **FKs compuestas `(id, barrio_id)`**: un obligado del barrio A no puede engancharse a una unidad del
  barrio B ni con el rol que saltea la RLS. El aislamiento no depende de que la app se porte bien.
- **Los 5 ejes del barrio viven en `barrio_atributo_vigencia`**; las columnas de `barrio` son un cache
  que mantiene un trigger. Para cualquier acto **con fecha** (liquidar un período viejo) se usa
  `app.valor_eje_vigente(barrio, eje, fecha)`, no la columna.
  - La columna refleja el valor vigente **al momento de escribir**: si se carga una vigencia futura, se
    sincroniza recién cuando algo vuelva a escribir ese eje. La consulta con fecha siempre es exacta.
- **Una versión de coeficientes no se cierra si no cuadra** y, una vez cerrada, no se modifica ni se
  reabre: se crea una versión nueva. Con base `parte_indivisa` la suma tiene que dar **exactamente 1**;
  con `superficie`/`lote`/`mixto` son pesos relativos (art. 2081) y solo se exige masa positiva.
  Todas las unidades activas necesitan coeficiente, **incluidas las baldías** (art. 2077).
- **Sin `DELETE` para `app_request`** salvo en `gasto_periodo`/`liquidacion`/`item_liquidacion`, y solo
  porque un período **en borrador** tiene que poder corregirse: el trigger bloquea el borrado apenas se
  emite. En el resto, las bajas son lógicas (`baja_at`, `hasta`, `vigente_hasta`, `deleted_at`).

### De expensas (0004/0005)

- **Dos modelos de expensa, elegidos por período**: `variable` (lo que se cobra sale de los gastos) y
  `fija` (cuota mensual del directorio, versionada en `cuota_fija_version`). En el modelo fijo, los
  gastos ordinarios se registran pero no se cobran de nuevo; las **extraordinarias sí se prorratean**.
- **Una extraordinaria sin acta se carga igual**: la base pone `sin_respaldo_asamblea = true` (lo hace
  el trigger, no la app, así vale para cualquier vía de carga) y el resumen de la liquidación lo
  informa. No se bloquea: el respaldo pesa al **reclamar** la deuda, no al registrar el gasto.
- **Un período emitido es inmutable**: no se editan sus gastos, ni sus liquidaciones, ni sus líneas. Se
  corrige en el período siguiente.
- **No se emite un período descuadrado** ni con unidades sin liquidar, ni con una versión de
  coeficientes que no esté cerrada. El cuadre depende del modelo: `variable` → repartido = gastos;
  `fija` → repartido = cuotas fijas + extraordinarias (y toda unidad activa necesita su cuota).
- Los estados van `borrador ⇄ revisada → emitida → distribuida`, y de `emitida` no se vuelve.
- **La mora sale de `app.tasa_mora_vigente()`**. Si el barrio no tiene tasa cargada, la liquidación
  guarda `mora_pendiente_definicion = true` e `interes_mora = NULL`: el sistema **no inventa** una tasa.
- El **cálculo** (prorrateo, subtotales, interés) vive en `@admin-barrios/shared/liquidacion`, sin base
  de datos; `src/servicios/liquidacion.ts` solo lee, llama al cálculo y escribe.

Diseño completo: [`docs/diseno/03-modelo-datos.md`](../../docs/diseno/03-modelo-datos.md) §A y §B.
