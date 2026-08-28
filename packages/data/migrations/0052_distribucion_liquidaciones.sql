-- =============================================================================================
-- 0052_distribucion_liquidaciones — las formas del módulo de Distribución (doc 01 §4.8).
--
-- LAS FORMAS ACÁ, LAS REGLAS EN `0053`. Mismo reparto que `0043`/`0044`, `0026`/`0027` y
-- `0050`/`0051`.
--
-- Tres tablas nuevas y tres columnas agregadas. Cada una tiene su porqué escrito abajo; lo que
-- conviene retener de conjunto es **por qué el ZIP no entra en `documento_emitido`** y **por qué
-- la fila de envío nace antes del correo**, que son las dos decisiones que sostienen todo lo demás.
-- Panel `arquitecto-software` + `security-engineer`, 2026-08-27.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. `paquete_distribucion` — el ZIP con todas las boletas del período.
--
-- **POR QUÉ NO ES UNA FILA DE `documento_emitido`, evaluado de cero y no por analogía con el
-- ADR-0004.** Ahí el argumento fue que la exportación no dejaba artefacto; acá sí lo deja, así que
-- la pregunta se rehízo entera. La forma igual no coincide, y falla en cuatro puntos
-- independientes:
--
--   1. **Origen.** `documento_emitido` guarda lo que produjo el renderer, y lo acredita con `motor`
--      y `plantilla_hash`. El ZIP no lo produjo ningún renderer: **empaqueta objetos que ya
--      estaban guardados**.
--   2. **`vista jsonb not null`.** Su docstring dice que es "lo que permite explicar un documento
--      emitido sin volver a correr la liquidación". Un ZIP no tiene vista; lo que le corresponde es
--      un **manifiesto** de qué contiene, que es otra cosa y vive en la tabla hija de abajo.
--   3. **Reproducibilidad.** Una boleta es irreproducible por diseño (append-only, `{token}` nuevo
--      en cada emisión). El ZIP es **derivado**: se reconstruye de sus partes.
--   4. **El gate de descarga.** El de `documento_emitido` es por `tipo`, para un documento **de una
--      unidad**. Este objeto contiene N boletas de N unidades: su gate es el del período entero.
--
-- Meterlo adentro obligaba a relajar cuatro `not null` o a rellenarlos con valores fabricados —
-- exactamente la derogación que el ADR-0004 §3.1 describe: dejar un `CHECK` diciendo algo que ya no
-- garantiza. Y hay un quinto punto que sella la decisión: **la re-emisión rompe la semántica**. Si
-- después se emite una boleta más, el ZIP viejo quedó *incompleto* — un artefacto derivado tiene una
-- noción de "vigente / superado" que `documento_emitido` deliberadamente no tiene.
--
-- Precedente propio: `recibo_emitido` (`0038`) fue tabla nueva por el mismo tipo de motivo. La regla
-- del repo no es "generalizá siempre": es **"generalizá cuando la forma es la misma"**.
-- ---------------------------------------------------------------------------------------------
create table paquete_distribucion (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio(barrio_id) on delete restrict,
  periodo_id uuid not null references periodo_expensa(id) on delete restrict,

  storage_key text not null,
  sha256 char(64) not null,
  bytes integer not null,

  -- La escribe la base desde `app.current_user_id()` (`0053`), nunca el cliente.
  armado_por uuid not null,
  armado_at timestamptz not null default now(),

  -- Su propia clave, con su propio patrón: `…/periodos/{uuid}/paquetes/{token}.zip`. El alfabeto
  -- cerrado y el `barrio_id` adentro son el mismo candado que `documento_storage_key_chk` — y por
  -- el mismo motivo: la credencial que firma URLs alcanza al bucket entero, así que la única
  -- defensa real es que la clave haya salido de una fila leída bajo RLS.
  --
  -- `\\.` y no `\.`: en un template de TypeScript `\.` es una secuencia de escape inválida que
  -- colapsa a `.`, y un `.` en una regex acepta cualquier carácter (ver `schema/documentos.ts`).
  constraint paquete_storage_key_chk check (
    storage_key ~ ('^barrios/' || barrio_id::text || '/periodos/[0-9a-f-]{36}/paquetes/[A-Za-z0-9_-]{22,64}\.zip$')
  ),
  constraint paquete_bytes_chk check (bytes > 0)
);
--> statement-breakpoint

-- Un objeto de storage acredita UN paquete. Sin esto, dos filas podrían compartir la clave.
create unique index uq_paquete_storage_key on paquete_distribucion (storage_key);
--> statement-breakpoint
create index idx_paquete_periodo on paquete_distribucion (periodo_id, armado_at desc);
--> statement-breakpoint
create index idx_paquete_barrio on paquete_distribucion (barrio_id);
--> statement-breakpoint

comment on table paquete_distribucion is
  'El ZIP con las boletas de un período. Tabla propia y NO una fila de documento_emitido: no lo '
  'produjo un renderer (no tiene vista, motor ni plantilla_hash), es derivado —se reconstruye de sus '
  'partes— y su gate de descarga es el del período entero, no el de una unidad. Ver el encabezado de '
  '0052_distribucion_liquidaciones.sql.';
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. `paquete_distribucion_item` — el manifiesto.
--
-- **Tabla hija y no un `jsonb`**, por el mismo argumento con el que este repo ya rechazó lo
-- polimórfico en `descarga_documento`: conserva la **integridad referencial real**. Y compra algo
-- que un jsonb no puede dar: permite contestar *"¿a este paquete le faltan boletas emitidas después
-- de armarlo?"* con una consulta, que es la pregunta que vuelve legible el "vigente / superado".
-- ---------------------------------------------------------------------------------------------
create table paquete_distribucion_item (
  paquete_id uuid not null references paquete_distribucion(id) on delete cascade,
  documento_id uuid not null references documento_emitido(id) on delete restrict,
  primary key (paquete_id, documento_id)
);
--> statement-breakpoint

create index idx_paquete_item_documento on paquete_distribucion_item (documento_id);
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. `envio_liquidacion` — el registro de envíos, que es además el GUARD DE IDEMPOTENCIA.
--
-- **La diferencia con todo lo demás que hace este sistema:** generar un PDF de nuevo es gratis
-- —`liquidacionesConBoleta()` hace que "generar los que falten" sea cierto—, pero **reenviar un
-- email es un email más en la bandeja del vecino y no se puede retirar**. Con 510 destinatarios,
-- un reintento mal resuelto son cientos de duplicados irreversibles.
--
-- Por eso esta tabla no es solo trazabilidad: es lo que impide el segundo envío. El mecanismo
-- completo está en `0053` (claim atómico), y su regla de oro es que **la fila se commitea ANTES del
-- `sendMail()`** — con la consecuencia deliberada de que un envío que quedó `enviando` es *estado
-- desconocido* y **no se reintenta solo**. Se prefiere perder la certeza de que se mandó antes que
-- mandar dos veces.
--
-- **GRANO: `(periodo, unidad, dirección)`**, no `(periodo, obligado)`. `unidad_contacto` es 1..N por
-- unidad, la boleta es de la unidad, y "a quién se le escribió" tiene que poder contestarse por
-- dirección concreta.
-- ---------------------------------------------------------------------------------------------
create table envio_liquidacion (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio(barrio_id) on delete restrict,
  periodo_id uuid not null references periodo_expensa(id) on delete restrict,

  -- **El par que hace estructuralmente imposible el cruce** (B-1 del panel). No son dos datos
  -- sueltos: el trigger de `0053` deriva la UF desde la liquidación del documento y **rechaza la
  -- fila si no coincide con la del contacto**. Como el adjunto se resuelve leyendo la `storage_key`
  -- de este mismo `documento_id`, un par mal formado no se puede ni persistir ni enviar.
  unidad_funcional_id uuid not null references unidad_funcional(id) on delete restrict,
  unidad_contacto_id uuid not null references unidad_contacto(id) on delete restrict,
  -- La fila EXACTA de `documento_emitido` que viajó. Con reemisiones hay dos boletas de la misma
  -- unidad y el registro tiene que decir cuál recibió, no "la boleta de esa unidad".
  documento_id uuid not null references documento_emitido(id) on delete restrict,
  -- El informe mensual que acompañó. `null` si el barrio no lo adjunta.
  informe_documento_id uuid references documento_emitido(id) on delete restrict,

  /*
   * **LAS DOS COLUMNAS DE EMAIL, y por qué van las dos** (decisión del usuario, 2026-08-28).
   *
   * El panel se dividió: `arquitecto-software` propuso snapshot en claro —"el hecho sobrevive al
   * borrado del contacto"— y `security-engineer` propuso `sha256(barrio_id || lower(email))` para no
   * duplicar el padrón de casillas en una tabla más. Los dos buscaban lo mismo: que la fila no
   * dependa de `unidad_contacto`, que es mutable y no versionado.
   *
   * Van las dos porque resuelven cosas distintas, y porque solo el hash generaba una tensión con
   * B-1: el reenvío manual necesita una dirección, y con hash habría que volver a leerla de
   * `unidad_contacto` —o sea, a la dirección VIGENTE—, que es exactamente lo que B-1 prohíbe
   * ("nunca se re-apunta el envío a la dirección nueva: re-apuntar es cómo se filtra").
   *
   *   · `email_snapshot` — congelado. **Es la única dirección a la que un reenvío puede ir.**
   *   · `email_hash` — para contestar "¿se mandó a esta dirección?" sin exponer el claro.
   */
  email_snapshot text not null,
  email_hash char(64) not null,

  -- `text` + `CHECK` y NO enum nativo, desde el día uno: agregar `rebotado` el día que exista la
  -- fuente no puede exigir un `ALTER TYPE`, que el migrador de este repo no tolera (ver `0050`).
  estado text not null default 'pendiente',
  intento smallint not null default 0,

  /*
   * **El `Message-ID` lo genera el emisor, no el transporte**, y se guarda desde el día uno aunque
   * hoy nada lea rebotes. Es la única llave que va a permitir aparear un rebote con su envío —venga
   * de VERP, de IMAP o de un webhook—; sin ella habría que aparear por dirección y fecha, que es
   * adivinar. Y si lo pusiera el servidor, cambiaría con el proveedor y el registro dejaría de ser
   * estable en el tiempo.
   */
  mensaje_id text,

  -- Código corto y saneado, nunca el mensaje crudo del servidor SMTP: ese suele traer la dirección
  -- completa y a veces parte del cuerpo.
  error_codigo text,

  -- Qué versión del cuerpo se mandó. **Permite reconstruir qué decía sin guardar el cuerpo**, que es
  -- lo que mantiene la PII fuera de esta tabla.
  plantilla_version text not null,

  trabajo_id uuid references trabajo(id) on delete set null,
  solicitado_por uuid not null,
  encolado_at timestamptz not null default now(),
  -- **`aceptado_at`, no `enviado_at`.** Un `sendMail()` que resuelve significa que el servidor de
  -- correo ACEPTÓ el mensaje, no que llegó. Mismo criterio, textual, con el que
  -- `descarga_documento.url_firmada_at` no se llama `descargado_at`: si la columna dijera "enviado",
  -- en algún momento alguien va a declarar por escrito que el sistema registra que el vecino recibió
  -- su liquidación, y no es cierto.
  aceptado_at timestamptz,

  constraint envio_estado_chk check (
    estado in ('pendiente', 'enviando', 'aceptado', 'fallado', 'rebotado', 'sin_contacto', 'cancelado')
  ),
  constraint envio_intento_chk check (intento >= 0),
  constraint envio_hash_chk check (email_hash ~ '^[0-9a-f]{64}$'),
  -- `aceptado_at` va con el estado y no suelto: las dos formas de decir lo mismo no pueden
  -- contradecirse. Mismo patrón pareado que las ternas de anulación del resto del esquema.
  constraint envio_aceptado_chk check (
    (estado = 'aceptado' and aceptado_at is not null) or (estado <> 'aceptado' and aceptado_at is null)
  )
);
--> statement-breakpoint

-- **La reserva atómica.** Es lo que convierte el `insert` en un claim: si dos workers arman el lote
-- a la vez, el segundo rebota acá. Es `uq_trabajo_pendiente` aplicado por destinatario.
create unique index uq_envio_periodo_contacto on envio_liquidacion (periodo_id, unidad_contacto_id);
--> statement-breakpoint

-- El `mensaje_id` es único por barrio: es la llave con la que se va a aparear un rebote.
create unique index uq_envio_mensaje_id on envio_liquidacion (barrio_id, mensaje_id)
  where mensaje_id is not null;
--> statement-breakpoint

create index idx_envio_periodo_estado on envio_liquidacion (periodo_id, estado);
--> statement-breakpoint
create index idx_envio_barrio on envio_liquidacion (barrio_id);
--> statement-breakpoint
create index idx_envio_unidad on envio_liquidacion (unidad_funcional_id);
--> statement-breakpoint

comment on table envio_liquidacion is
  'Registro de envíos, y GUARD DE IDEMPOTENCIA del trabajo de distribución: la fila se commitea '
  'ANTES del sendMail(), porque un email no se puede retirar. Un envío en estado "enviando" es '
  'estado DESCONOCIDO y no se reintenta solo. No guarda el cuerpo, ni el asunto, ni los adjuntos, ni '
  'importes, ni IP/user-agent.';
--> statement-breakpoint

comment on column envio_liquidacion.aceptado_at is
  'Cuándo el servidor de correo ACEPTÓ el mensaje. NO es entrega: SMTP acepta y puede rebotar '
  'asincrónicamente después. El nombre es deliberado, igual que url_firmada_at en descarga_documento.';
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. `periodo_expensa.distribuida_por` — la firma que faltaba.
--
-- `app.periodo_transicion()` (`0013`) escribe `emitida_at` **y `emitida_por`**, y para `distribuida`
-- solo sella la fecha. Distribuir manda PII a cientos de casillas externas: es tanto o más imputable
-- que emitir. Es literalmente el mismo bug que `0013` §3 arregló para la emisión, sin arreglar
-- (`security-engineer`, B-6).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "periodo_expensa" ADD COLUMN "distribuida_por" uuid;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 5. La traza de `unidad_contacto` — B-2, el hallazgo más grave del panel.
--
-- **El vector, completo.** `unidad_contacto` recibe la policy genérica de `0003_dominio_rls.sql`:
-- `insert`/`update` habilitados a `admin_plataforma`, `admin_barrio` **y `operador`**. Y la tabla
-- tiene `created_at` y nada más.
--
-- Hoy eso es un dato de padrón editable. **Con la distribución se vuelve un canal de
-- auto-suscripción**: un `operador` agrega su casilla como contacto de cualquier UF de su barrio y
-- la liquidación de ese vecino le llega sola, con importes y titular. No hace falta descargarla, no
-- pasa por `descarga_documento`, y no queda registro de quién lo hizo.
--
-- **NO se le saca el permiso al `operador`**: cargar contactos es trabajo legítimo de padrón, y
-- quitárselo rompería la operatoria real para tapar un problema de auditoría. Lo que se corrige es
-- que deje de ser **silencioso**.
--
-- Columnas y no tabla de eventos (decisión del usuario, 2026-08-28): el caso de uso es *"quién es
-- responsable del contacto actual"*, no el historial completo. El día que aparezca una necesidad
-- real de historial se agrega entonces, con ese motivo en la mano.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "unidad_contacto" ADD COLUMN "creado_por" uuid;
--> statement-breakpoint
ALTER TABLE "unidad_contacto" ADD COLUMN "modificado_por" uuid;
--> statement-breakpoint
ALTER TABLE "unidad_contacto" ADD COLUMN "actualizado_at" timestamptz;
--> statement-breakpoint

comment on column unidad_contacto.creado_por is
  'Quién dio de alta este contacto. La escribe la base desde app.current_user_id(). Existe porque '
  'con la distribución de liquidaciones esta tabla decide a qué casilla se manda la boleta de una '
  'unidad: sin traza, agregar una casilla propia a la UF de un vecino no dejaba rastro.';
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 6. `descarga_documento.paquete_id` — la quinta referencia.
--
-- **Acá la generalización SÍ corresponde, y es el contraste exacto con `0050`.** Ahí se rechazó
-- sumar la exportación a esta tabla porque no había artefacto: el quinto caso habría tenido las
-- cuatro FK en `null` y habría obligado a relajar el `CHECK` de "exactamente una" a "una o ninguna",
-- derogándolo.
--
-- El paquete es lo contrario en las tres cosas que importaban: **hay fila a la cual apuntar** (con
-- `on delete restrict`), **hay URL firmada real** y **hay TTL real**. Es la misma forma que las
-- cuatro que ya están, así que ensanchar es lo correcto — y darle tabla de traza propia sería la
-- generalización rota al revés.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "descarga_documento" ADD COLUMN "paquete_id" uuid;
--> statement-breakpoint
ALTER TABLE "descarga_documento" ADD CONSTRAINT "descarga_documento_paquete_id_paquete_distribucion_id_fk"
  FOREIGN KEY ("paquete_id") REFERENCES "public"."paquete_distribucion"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_descarga_paquete" ON "descarga_documento" USING btree ("paquete_id");
--> statement-breakpoint

alter table descarga_documento drop constraint descarga_referencia_unica_chk;
--> statement-breakpoint

alter table descarga_documento add constraint descarga_referencia_unica_chk
  check (num_nonnulls(documento_id, pago_id, recibo_emitido_id, orden_pago_id, paquete_id) = 1);
