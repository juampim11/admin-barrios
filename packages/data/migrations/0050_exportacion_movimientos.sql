-- =============================================================================================
-- 0050_exportacion_movimientos — la traza de la exportación de movimientos (doc 01 §4.8), MÁS el
-- flag por barrio que decide si el `auditor` puede exportar, con su grant de columna desde el
-- primer día.
--
-- LA FORMA ACÁ, LAS REGLAS EN `0051`. Mismo criterio que `0043`/`0044` y `0026`/`0027`: esta
-- migración declara la tabla y la columna; las policies, los triggers y los grants de
-- `exportacion_movimientos` viven en `0051_exportacion_movimientos_reglas.sql`. La excepción
-- deliberada es el grant de columna de `barrio` (sección 3), que va acá **porque va pegado a la
-- columna que lo necesita** — ver abajo.
--
-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- POR QUÉ ESTA TABLA EXISTE, Y POR QUÉ NO ES UN QUINTO VALOR DE `descarga_documento`
--
-- La exportación de movimientos es **síncrona**: no encola un trabajo, no persiste un archivo, no
-- acuña una URL firmada. Lee bajo RLS, arma un XLSX en memoria y lo devuelve en la misma respuesta.
-- No hay nada en reposo — que es, además, su mejor propiedad de seguridad: este archivo lleva el
-- dinero completo de un barrio más la PII de sus propietarios, y una boleta filtrada es una unidad
-- mientras que esto filtrado es el barrio entero.
--
-- La tentación era registrar la extracción en `descarga_documento`, que ya se generalizó DOS veces
-- (`0039`, `0049`) con FKs nullables y un `CHECK` de "exactamente una referencia". **La analogía se
-- rompe**, y se rompe en el punto exacto que hacía valiosa a esa generalización (panel
-- `arquitecto-software` + `security-engineer`, 2026-08-26):
--
--   1. **El `CHECK` se derogaría, no se extendería.** Las cuatro referencias de esa tabla apuntan a
--      filas que existen, con `on delete restrict`. Una exportación no tiene fila a la cual
--      apuntar: el quinto caso serían las cuatro en `null`, o sea relajar
--      `descarga_referencia_unica_chk` de "exactamente una" a "exactamente una **o ninguna**". Eso
--      deja la tabla en la forma polimórfica sin FK que su propio docstring dice que se rechazó
--      para conservar la integridad referencial real.
--   2. **`url_firmada_at` y `ttl_segundos` no aplican.** `descarga_ttl_chk` exige `> 0 and <= 600`.
--      Acá no hay URL firmada ni TTL: habría que inventar un TTL falso para satisfacer un `CHECK`
--      sobre algo que no existe. Y el docstring de esa columna advierte —textual— que si queda mal
--      nombrada "alguien va a declarar por escrito que el sistema registra que el vecino descargó
--      su boleta, y no es cierto". Meter una extracción ahí hace que la tabla signifique dos cosas.
--   3. **Se registra otra cosa.** De una descarga interesa *quién pidió qué documento*. De un
--      export interesa *quién sacó qué datos del sistema, con qué alcance y cuántas filas*: eso es
--      traza de **exfiltración**, no de descarga.
--
-- El precedente propio y decisivo es `recibo_emitido` (`0038`): tuvo que ser tabla propia porque
-- `documento_emitido` no lo albergaba. La regla del repo no es "generalizá siempre", es
-- **"generalizá cuando la forma es la misma"**. Acá no lo es.
--
-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- EL NOMBRE ES `exportacion_movimientos` Y NO `exportacion_solicitada`
--
-- No es una solicitud que se encola y después se atiende (esa es `trabajo`): es una extracción que
-- **ocurrió**. La fila se escribe ANTES de serializar, en la misma transacción que lee los datos
-- bajo RLS — si el insert falla, no hay planilla. Es el mismo principio que `descarga_documento`
-- ("si el registro falla, no hay URL. Una auditoría que se puede saltear con un error no es una
-- auditoría"), y acá se puede sostener mejor todavía: sin cola de por medio, la traza y la lectura
-- comparten transacción de verdad.
--
-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- QUÉ NO LLEVA ESTA TABLA, Y ES A PROPÓSITO
--
--   · **Ni IP ni user-agent.** Precedente explícito de `descarga_documento`: "suman un dato personal
--     sobre un empleado del estudio y no compran nada".
--   · **Ninguna PII, ningún monto, ningún total, ninguna lista.** Ni nombres, ni CUIT, ni las UF
--     alcanzadas. Un total de dinero en la tabla de auditoría convierte a la auditoría en objetivo.
--   · **Ni el archivo, ni su hash, ni su nombre.** No hay archivo: hashear algo que no se guarda es
--     un hash que no acredita nada.
--   · **Nada de `detalle jsonb` libre.** Columnas tipadas: si no, el próximo filtro que se agregue
--     arrastra el nombre de un proveedor adentro de la tabla de auditoría.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. El flag por barrio — quién puede exportar el libro de movimientos.
--
-- `admin_plataforma`, `admin_barrio` y `contador` pueden siempre (el contador es literalmente el
-- destinatario del entregable, doc 01 §4.8). `operador` **nunca**: es el rol de carga, y un
-- agregado exportable del barrio entero no es lo mismo que las filas que carga de a una.
--
-- El `auditor` queda **configurable por barrio**, y no es indecisión: un auditor que no puede
-- exportar el libro no puede auditar, pero también es un rol de lectura amplia sobre un archivo que
-- sale del sistema y viaja por mail. La decisión es del barrio, no del producto (decisión del
-- usuario, 2026-08-26). Mismo patrón exacto que `orden_pago_cuatro_ojos` (`0047`).
--
-- Nace en `false`: el default no puede ser una habilitación que nadie pidió.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "barrio" ADD COLUMN "auditor_exporta_movimientos" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

comment on column barrio.auditor_exporta_movimientos is
  'Si el rol `auditor` puede exportar el libro de movimientos de este barrio. Dato de gobierno del '
  'barrio: NO es autoconfigurable por `admin_barrio` — ver el grant de columna de esta misma '
  'migración. Los otros roles no dependen de este flag (admin_plataforma/admin_barrio/contador '
  'siempre pueden; operador nunca).';
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. La tabla de traza.
--
-- `barrio_id` redundante a propósito, igual que en `descarga_documento`/`pago_imputacion`: la RLS
-- filtra por ahí sin pasar por ninguna otra tabla.
--
-- **El rango va como `YYYY-MM` y no como FK a `periodo_expensa`.** Un export abarca un RANGO de
-- períodos, que no es una fila sino N; y además tiene que poder registrar un rango que incluya
-- meses **sin período creado** (un barrio atrasado en emitir exporta igual sus movimientos, que es
-- el caso que el panel de dominio pidió sostener). Una FK obligaría a inventar filas de período
-- para poder auditar una lectura. Mismo formato y mismo `CHECK` que `periodo_expensa.periodo`.
--
-- `filas_*` son enteros de control: permiten detectar una extracción anómala por volumen sin
-- guardar ni una fila del contenido.
-- ---------------------------------------------------------------------------------------------
create table exportacion_movimientos (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio(barrio_id) on delete restrict,

  -- La identidad de quien extrajo. La escribe la BASE desde `app.current_user_id()` (trigger en
  -- `0051`), nunca el cliente: una firma de auditoría que puede escribir quien la genera no es una
  -- firma. Mismo criterio que `trabajo.solicitado_por` y `descarga_documento.solicitado_por`.
  solicitado_por uuid not null,
  solicitado_at timestamptz not null default now(),

  -- El alcance temporal, inclusivo en los dos extremos.
  periodo_desde text not null,
  periodo_hasta text not null,

  -- Qué se pidió. `text` + `CHECK` y no enum nativo, mismo motivo que `pago.origen` y `trabajo.tipo`:
  -- el migrador aplica todas las migraciones pendientes en UNA transacción, y `ALTER TYPE … ADD
  -- VALUE` no sirve el día que el catálogo crezca.
  alcance text not null,
  formato text not null,

  -- Control de volumen, sin contenido. Nunca montos ni totales.
  filas_ingresos integer not null,
  filas_imputaciones integer not null,
  filas_egresos integer not null,

  -- Si el rango incluía al menos un período NO emitido: la planilla salió marcada `PROVISORIO` y
  -- su clasificación fiscal vino del catálogo vigente, no del snapshot congelado al emitir. Sin
  -- este dato no se puede explicar, meses después, por qué dos extracciones del mismo rango
  -- difieren legítimamente.
  incluyo_provisorio boolean not null,

  constraint exportacion_periodo_desde_chk check (periodo_desde ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  constraint exportacion_periodo_hasta_chk check (periodo_hasta ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- Comparación lexicográfica: `YYYY-MM` ordena igual como texto que como fecha, que es justamente
  -- por lo que se eligió ese formato en `periodo_expensa`.
  constraint exportacion_rango_chk check (periodo_hasta >= periodo_desde),
  constraint exportacion_alcance_chk check (alcance in ('movimientos')),
  constraint exportacion_formato_chk check (formato in ('xlsx')),
  constraint exportacion_filas_chk check (
    filas_ingresos >= 0 and filas_imputaciones >= 0 and filas_egresos >= 0
  )
);
--> statement-breakpoint

-- La consulta natural de auditoría es "qué se extrajo de este barrio, y cuándo".
create index idx_exportacion_barrio_fecha on exportacion_movimientos (barrio_id, solicitado_at desc);
--> statement-breakpoint

-- "Qué extrajo esta persona" — la otra pregunta que se hace mirando esta tabla.
create index idx_exportacion_usuario on exportacion_movimientos (solicitado_por, solicitado_at desc);
--> statement-breakpoint

comment on table exportacion_movimientos is
  'Traza de cada extracción del libro de movimientos (doc 01 §4.8). La fila se escribe ANTES de '
  'serializar, en la misma transacción que lee los datos bajo RLS: si el registro falla, no hay '
  'planilla. NO guarda PII, ni montos, ni totales, ni IP/user-agent, ni el archivo ni su hash — '
  'ver el encabezado de 0050_exportacion_movimientos.sql.';
--> statement-breakpoint

comment on column exportacion_movimientos.solicitado_por is
  'Quién extrajo. La escribe la base desde app.current_user_id() (trigger en 0051); el rol de '
  'request no puede escribirla ni actualizarla.';
--> statement-breakpoint

comment on column exportacion_movimientos.incluyo_provisorio is
  'El rango incluía al menos un período no emitido: la planilla salió PROVISORIO y su clasificación '
  'fiscal vino del catálogo vigente, no del snapshot congelado al emitir.';
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. El grant de columna de `barrio` — la columna nace cerrada.
--
-- **Por qué esto va acá y no en la migración de reglas.** Es la tercera vez que el repo se topa con
-- el mismo agujero: `0003_dominio_rls.sql` deja `barrio` con `grant update` de TABLA ENTERA a
-- `app_request`, con policy de UPDATE que habilita a `admin_plataforma`, `admin_barrio` **y**
-- `operador` por igual. Postgres distingue roles de BASE (`app_request` vs `app_job`), no los roles
-- de NEGOCIO que viajan adentro de `app_request` — así que la única forma real de sacarle una
-- columna a "admin_barrio" es sacársela a TODO `app_request`.
--
--   · `orden_imputacion` (`0036`) quedó abierta **sin querer**, y se descubrió un módulo después.
--   · `orden_pago_cuatro_ojos` (`0047`) se cerró **a tiempo**, porque un panel la auditó.
--   · `auditor_exporta_movimientos` nace cerrada **en la misma migración que la crea** (decisión del
--     usuario, 2026-08-26): no se espera a que un panel la encuentre por tercera vez.
--
-- **Se reescribe la lista ENTERA de `0047`, que sigue siendo la vigente** (verificado: ninguna
-- migración posterior tocó `barrio`). `revoke` + `grant` no es incremental: hay que volver a
-- nombrar todas las columnas escribibles. Si falta una, la escritura correspondiente se rompe **en
-- silencio** — no falla al migrar, falla recién al escribir. Hay un test que verifica las 17
-- (`packages/data/test/ataques-escritura.test.ts`).
-- ---------------------------------------------------------------------------------------------
revoke update on table barrio from app_request;
--> statement-breakpoint

grant update (
  jurisdiccion, figura_juridica, adecuado_art_2075, encuadre_urbanistico, municipio,
  servicios_internos_a_cargo_de, titularidad_espacios_comunes, denominacion_concepto,
  medio_cobranza_clave, reglamento_inscripto, pacto_ejecutividad, tiene_espacios_comunes_exclusivos,
  tiene_consejo, tiene_fondo_reserva, cuit, domicilio_sede, updated_at
) on table barrio to app_request;
-- `orden_imputacion`, `orden_pago_cuatro_ojos` y `auditor_exporta_movimientos` NO están en esta
-- lista — a propósito, las tres. Son dato de mandato/gobierno del barrio y se escriben vía
-- `app_job`/soporte. No las agregues de vuelta sin volver a leer el comentario de la sección 3.
