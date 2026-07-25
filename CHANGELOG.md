# CHANGELOG

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) + [SemVer](https://semver.org/lang/es/).
La versión se corta al desplegar a producción (ver `docs/devops/02-sdlc-git-flow.md` §5).

## [Sin desplegar]

### Security
- **Tres agujeros cerrados**, encontrados por el panel de implementación en código ya mergeado
  (`0013_seguridad_periodo.sql`):
  - **La firma de quién emitió un período era autoatribuible**: se escribía desde un argumento de la
    aplicación y nada verificaba que fuera el usuario de la sesión. Ahora la pone la base con
    `app.current_user_id()`, y `emitirPeriodo()` **ya no recibe el usuario**.
  - **`app.periodo_editable` fallaba ABIERTO**: si no lograba resolver el período, `NULL in (...)` daba
    NULL, el `if` no entraba y la escritura pasaba. Ahora rechaza — con la única excepción del borrado
    en cascada, donde el padre ya desapareció legítimamente.
  - **Un período podía nacer `emitida`**, saltándose la validación de cuadre por completo: el control
    de transiciones solo corría en UPDATE. Ahora nace en borrador y las marcas de emisión las pone la
    base, no quien inserta.

### Changed
- **Dar de alta un concepto exige declarar su encuadre fiscal** (`0012` + `0014`). El default era
  `no_alcanzado`: cada concepto nuevo afirmaba **por omisión** que no está alcanzado por IIBB, sin que
  nadie lo hubiera mirado — contra la regla del proyecto de no presuponer encuadre. Se agrega
  `sin_clasificar` como valor explícito y se elimina el default.

### Added
- **Base de prorrateo `partes_iguales`** (`0010` + `0011`): con `parte_indivisa` era **imposible de
  cerrar** cuando N no divide exacto en 9 decimales (3 unidades → 0,999999999 ≠ 1). Ahora la versión
  cierra, y la validación exige que **todos los coeficientes sean iguales** — si una unidad quedó con
  otro valor, el barrio cree que reparte en partes iguales y no lo está haciendo.
- Decisiones del usuario sobre el financiamiento de los descuentos y la regla de "vecino cumplidor"
  (doc 08 §N.bis).

### Added
- **`docs/diseno/08-criterios-de-reparto.md`**: decisiones del panel sobre cómo se reparte la expensa
  (partes iguales, superficie lineal, escalas por tramos, % de reglamento, monto fijo, por concepto) y
  sobre la extraordinaria en comprobante separado. Incluye el orden de construcción en 7 pasos y las
  dos decisiones estructurales que hay que fijar antes del módulo de cobros: **la mora se computa por
  obligación con su propio vencimiento**, y **la deuda se imputa al comprobante, nunca al par
  (período, unidad)**.

### Added
- **Trazabilidad de la liquidación** (`0008_trazabilidad.sql` + `0009_trazabilidad_reglas.sql`), de los
  hallazgos del panel de agentes: cada línea guarda **`monto_teorico`** (`base × coeficiente`, lo que da
  la calculadora) y **`ajuste_redondeo`** explícito; snapshots de `clasificacion_fiscal`,
  `sin_respaldo_asamblea` y título del acta (el catálogo de conceptos es editable después de emitir);
  **días de atraso y fecha de corte** de la mora (sin eso el interés no se puede rehacer a mano);
  **número de comprobante** legible; **origen del saldo anterior**; y la **denominación del concepto
  congelada en el período** (la figura jurídica se versiona: no puede cambiar retroactivamente la
  etiqueta de lo ya emitido).
- **`medio_pago_barrio`**: dónde paga el propietario. Faltaba, y sin eso el campo más leído del PDF
  sale vacío.
- **`docs/diseno/07-liquidacion-pdf.md`**: decisiones del panel (motor, estructura, alcance, respaldo
  de la extraordinaria, lenguaje prohibido, seguridad del módulo).

### Fixed
- **El reparto de los centavos sobrantes ya no cae entero en la última unidad**: se distribuye por
  mayor residuo, así ninguna unidad se desvía más de un centavo de lo que da la cuenta a mano (antes,
  con 37 unidades, la última podía recibir 36 centavos de golpe).

### Security
- **La conexión de jobs (BYPASSRLS) ya no puede usarse como si estuviera aislada.** `conUsuario()`
  aceptaba cualquier conexión: el `set_config` se ejecutaba, el código **se leía** aislado y no aislaba
  nada. Ahora los tipos lo impiden (`DbRequest` / `DbJob` / `DbMantenimiento`).

### Changed
- **Dos modelos de expensa** (corrección del usuario, 2026-07-24): además del **variable** (lo que se
  cobra sale de los gastos del mes), ahora existe el **fijo** — una **cuota mensual** que fija el
  directorio o el administrador, versionada (`cuota_fija_version` + importe por unidad). El modelo se
  elige **por período**, así un barrio puede cambiar de criterio sin perder cómo se liquidó cada mes.
  En el modelo fijo las **extraordinarias se prorratean aparte** y los gastos ordinarios se registran
  sin volver a cobrarse. El control de cuadre al emitir se adaptó a cada modelo.
- **Una expensa extraordinaria ya NO exige acta de asamblea** (corrección del usuario): pasa en la
  operatoria real. Se carga igual y la base la **marca** (`sin_respaldo_asamblea`, puesta por trigger)
  para que la liquidación y el resumen lo informen; el respaldo pesa al **reclamar** la deuda, no al
  registrar el gasto.

### Added
- **Expensas y liquidación mensual (Fase 6C)** — migraciones `0004_expensas.sql` y
  `0005_expensas_rls.sql`: `concepto` (con clasificación fiscal y fondo de reserva), `tasa_mora`
  versionada, `periodo_expensa` con estados `borrador -> revisada -> emitida -> distribuida`,
  `gasto_periodo`, `liquidacion` e `item_liquidacion` **con el origen de cada línea** (de qué gasto
  sale y con qué coeficiente).
- **Controles en la base**: una extraordinaria **exige el acta** que la respalda (art. 2048); un
  período **emitido no se edita**; **no se emite descuadrado**, ni con unidades sin liquidar, ni con
  una versión de coeficientes abierta.
- **Cálculo puro en `@admin-barrios/shared/liquidacion`**: prorrateo por coeficiente donde la suma de
  lo cobrado es **exactamente** el gasto del período, subtotales separados (ordinarias /
  extraordinarias / fondo de reserva) e **interés de mora simple**. Sin tasa cargada, la liquidación
  sale marcada como **"mora pendiente de definición"** en vez de inventar una tasa.
- **Servicio de liquidación** (`packages/data/src/servicios/liquidacion.ts`): genera y regenera las
  liquidaciones de un período en borrador y emite el período.
- **El modo demo ahora incluye un período liquidado y emitido** de punta a punta (5 conceptos, tasa de
  mora del reglamento, 50 liquidaciones), generado con el mismo servicio que usa la app.
- 13 tests nuevos contra Postgres real (60 en total) + 13 unitarios del cálculo (30 en total).
- **Padrón del barrio (Fase 6C)** — migraciones `0002_dominio.sql` y `0003_dominio_rls.sql`: `barrio`
  con los **5 ejes versionados** (`barrio_atributo_vigencia` como fuente de verdad + columnas cache
  sincronizadas por trigger y `app.valor_eje_vigente()` para consultar a una fecha), `unidad_funcional`
  (baldías incluidas, art. 2077), `unidad_contacto`, `obligado` y `unidad_obligado` **multi-obligado con
  histórico** (arts. 2049/2050), `coeficiente_version`/`coeficiente` con **cierre que exige cuadre**
  (exacto = 1 en parte indivisa; pesos relativos en superficie/lote/mixto, art. 2081),
  `documento_barrio` y `mandato_administracion` versionado (arts. 2065/2066).
- **FKs compuestas `(id, barrio_id)`** en todo el dominio: mezclar datos de dos barrios es imposible a
  nivel base, incluso para el rol que saltea la RLS.
- **`packages/shared/barrio`**: los 5 ejes como constantes y esquemas Zod compartidos,
  `sugerirDenominacionConcepto()` (devuelve `null` cuando no hay fuente cargada, en vez de inventar) y
  `faltantesParaViaEjecutiva()` (nunca afirma que la deuda sea ejecutable: dice qué falta).
- **Modo demo** (`pnpm db:seed`): barrio ficticio de 50 unidades con baldías, propietarios, un poseedor
  cada diez unidades, coeficientes cerrados que suman exactamente 1 y documentos del barrio. Idempotente.
- 20 tests nuevos contra Postgres real (47 en total).
- **Fundación de código (Fase 6C, Etapa 0)** — monorepo **pnpm workspaces** con `apps/web` (Next.js
  App Router 15 + React 19), `packages/shared` (dominio puro: dinero exacto en centavos con prorrateo
  que siempre cierra, jerarquía de tenancía, Zod), `packages/data` (Drizzle + Postgres) y
  `packages/design-tokens` (ahora con `package.json` y generador de variables CSS).
- **Aislamiento multi-tenant real y probado**: migraciones `0000_tenancy.sql` (tablas `tenant_node`,
  `membership`, `tenant_grant`, enums, índices con `text_pattern_ops`) y `0001_tenancy_rls.sql`
  (`app.current_user_id()`, `accessible_tenant_ids()`, `has_role_on()`, triggers de materialized path
  y de re-parentado, roles `app_request`/`app_job` y todas las policies). **27 tests contra Postgres
  real**: barrios hermanos que no se ven, membresía inactiva, soft-delete, prefijo `1.7` vs `1.70`,
  escritura por rol, baja lógica, `tenant_grant`, re-parentado con reescritura de paths, y
  `app.current_user_id()` **en sus dos modos** (`SET LOCAL` y `auth.uid()` de Supabase) incluida la
  no-fuga de identidad entre requests del pool.
- Gate local y en **CI (GitHub Actions)**: `pnpm typecheck`, `pnpm test`, `pnpm test:db`, tokens al
  día y `pnpm build`, con un Postgres real en el runner; corre en cada push de rama y en el PR.
  Servicio `app` del `docker-compose.yml` activado (Dockerfile de desarrollo con pnpm).

### Decided
- **Gestor de monorepo: pnpm workspaces** (cerrando el punto abierto del ADR-0000 §10).
- **El módulo contable queda FUERA del MVP** (decisión del usuario, 2026-07-24): libro contable,
  resumen fiscal por concepto y balance por figura son, en la práctica, un ERP. El MVP entrega una
  **exportación de movimientos** (planilla de ingresos/egresos con su concepto) para que el
  administrador se la pase a su contador. La clasificación fiscal se sigue guardando en el dato, así
  que evaluarlo más adelante no obliga a recargar nada. Docs 01 §1.1/§4.8 y 05 actualizados.

### Added (fases 6A y 6B)
- **Diseño de producto (Fase 6B)** en `docs/diseno/`: alcance y módulos con corte de MVP básico y
  mostrable (`01`), reúso del motor de conciliación del sistema de gas con pasos de migración (`02`),
  modelo de datos con multi-tenancy jerárquica por materialized path + RLS por subárbol (`03`),
  requisitos legales y fiscales por figura citando `knowledge/cordoba/` (`04`), roadmap por etapas con
  modo demo y multi-banco (`05`), y **dirección visual** (principios, design tokens con modo oscuro,
  navegación multi-barrio, wireframes de las 5 pantallas clave, patrones y accesibilidad AA) (`06`).
- Revisión 6B: conciliación de egresos **confirmada** en Inc. 2; **modelo híbrido** de los 5 ejes del
  barrio (columna enum vigente + `barrio_atributo_vigencia` como historial); nota de `unidad_obligado`
  multi-obligado desde el día uno en el esquema.
- **Tokens de diseño materializados** en `packages/design-tokens/` (`tokens.ts`, `semantic.ts` con
  modo claro y oscuro, `barrio-accent.ts`, `README.md`) — dirección "Verdemar" (teal + ámbar), Geist +
  Geist Mono con `tabular-nums`, acento por barrio acotado. Ratificada la dirección visual (paleta A,
  tipografía Geist, acento por barrio); doc 06 actualizado.
- **Roster técnico de ingeniería (perfiles super-senior)**: `product-owner`, `analista-funcional`,
  `arquitecto-software`, `tech-lead`, `ux-designer`, `backend-dev`, `frontend-dev`, `devops`,
  `qa-funcional`, `qa-automation`, `security-engineer`, `dba-data` (persona + wrapper, activados en
  `.claude/agents/`); tablas de roster sincronizadas en `agents/README.md`, `CLAUDE.md` §3 y `AGENTS.md`.
- Andamiaje de arquitectura (Fase 6A): ADR de stack e infraestructura agnóstica de proveedor
  (`docs/arquitectura/00-stack-infra.md`), `docker-compose.yml` (Postgres + MinIO local).
- Tres agentes de dominio: `administrador-consorcios`, `legal-ph`, `contador` (persona + wrapper,
  activados en `.claude/agents/`).
- Estructura de conocimiento jurisdiccional `knowledge/cordoba/{nacional,provincial,municipal,jurisprudencia}/`
  (placeholders, sin normativa real cargada todavía) y guía de carga (`docs/agents/guia-carga-conocimiento.md`).
