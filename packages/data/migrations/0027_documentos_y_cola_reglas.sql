-- =============================================================================================
-- 0027_documentos_y_cola_reglas — quién puede escribir y leer las tres tablas de 0026.
--
-- La forma la declara 0026; acá viven las reglas, que es donde está el valor. Cuatro decisiones que
-- conviene entender antes de tocar una línea:
--
-- 1. **`trabajo.solicitado_por` es la identidad bajo la cual el worker corre el lote**, no una firma
--    de auditoría (ADR-0002 §6.4 punto 2). Si quien crea la fila pudiera escribirla —o editarla
--    después— un `operador` encolaría con el uuid de un `admin_plataforma` y la emisión entera
--    correría con esa identidad. Por eso: la escribe la base, y el rol de request **no tiene
--    `update` sobre `trabajo`, ni policy ni grant**. Es el mismo bug que 0013 §3 arregló para
--    `emitida_por`.
--
-- 2. **El trigger que deriva el barrio NO es `security definer`.** El precedente del repo
--    (`app.resolver_aplicaciones`, dueño `app_job` con BYPASSRLS, ver 0022) es justo el que no hay
--    que copiar acá: un definer que saltea la RLS derivaría el barrio de un período que el
--    solicitante no puede ver, y aunque el `with check` de la policy lo rechazara igual, la
--    diferencia de mensajes convierte al endpoint en un **oráculo** ("ese período no existe" vs.
--    "existe y no es tuyo"). Este repo ya tiene una migración llamada
--    `0023_carrera_de_emision_y_oraculos.sql`: la sensibilidad está instalada. Corriendo como
--    invoker, el `select` pasa por la RLS del solicitante y los dos casos son **el mismo caso**.
--
-- 3. **`documento_emitido.vista` no se le concede a `app_request` para lectura.** El grant es por
--    columna, no por tabla, y no es una precaución teórica: la `vista` congelada es el documento
--    entero. Una pantalla que la proyecte sirve la boleta —o, el día que exista, el listado nominado
--    de morosos— **sin descargar nada y sin pasar por la ruta de descarga**. Escribirla sí puede
--    (el worker inserta bajo la identidad de quien pidió la emisión); leerla no.
--
-- 4. **El gate de la descarga es por `tipo`, y `listado_saldos_pendientes` falla cerrado.**
--    `app.readable_tenant_ids()` incluye `contador` y `auditor` (0018). Para la boleta y el informe
--    está bien. Para el listado de saldos pendientes no: una copia es la deuda con nombre de todo el
--    barrio (doc 10 §E). Hasta que la fila declare si es nominado o agregado, **el tipo entero queda
--    en `admin_plataforma`/`admin_barrio`**: la versión agregada, que sí podría abrirse a `operador`
--    y `contador`, se abre el día que haya con qué distinguirla, no antes.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. `trabajo` — el trigger que hace confiable a `solicitado_por`.
--
-- El request manda `tipo` y `referencia_id`. TODO lo demás lo escribe la base. Y falla cerrado si
-- no puede derivar el barrio: misma regla que `app.periodo_editable` (0013) y `app.cbu_antes` (0017).
--
-- El orden de evaluación no es casualidad y de él depende la seguridad de esto: en Postgres el
-- `with check` de la policy de `insert` se evalúa sobre la fila **final**, después de los triggers
-- `before`. La policy ve el `barrio_id` derivado, nunca el que mandó el cliente.
-- ---------------------------------------------------------------------------------------------
create or replace function app.trabajo_antes_insert() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_barrio  uuid;
  v_estado  app.estado_periodo;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un trabajo sin autor no se encola'
      using errcode = 'P0001';
  end if;

  -- Bajo la RLS del solicitante, a propósito (ver nota 2 del encabezado). Un período que no existe
  -- y un período que no es suyo devuelven exactamente lo mismo: cero filas.
  if new.tipo = 'emitir_documentos_periodo' then
    select barrio_id, estado into v_barrio, v_estado
      from periodo_expensa where id = new.referencia_id;
  end if;

  if v_barrio is null then
    raise exception 'no se pudo derivar el barrio de la referencia: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  -- **La regla del período emitido vive acá y no en el servicio.**
  --
  -- El servicio también la comprueba, pero solo para dar un mensaje que sirva ("todavía está en
  -- borrador" es accionable). Si el control existiera únicamente ahí, bastaba un
  -- `insert into trabajo (tipo, referencia_id) values (…)` —que el rol de request puede hacer— para
  -- generar los documentos de un **borrador**: se renderizarían y se registrarían como emitidos.
  -- Y un borrador se sigue editando, así que dos vecinos podrían tener impresa la misma boleta con
  -- cifras distintas. Es exactamente lo que la pantalla promete que no puede pasar.
  --
  -- Todas las demás reglas de este módulo las hace cumplir la base; esta no tenía por qué ser la
  -- excepción.
  if new.tipo = 'emitir_documentos_periodo' and v_estado not in ('emitida', 'distribuida') then
    raise exception 'el período no está emitido: los documentos salen de lo que quedó emitido'
      using errcode = 'P0001';
  end if;

  new.barrio_id      := v_barrio;
  new.solicitado_por := v_usuario;
  new.solicitado_at  := now();
  new.estado         := 'encolado';
  new.hechos         := 0;
  new.total          := null;
  new.intento        := 0;
  new.iniciado_at    := null;
  new.terminado_at   := null;
  new.error          := null;
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_trabajo_antes_insert before insert on trabajo
  for each row execute function app.trabajo_antes_insert();
--> statement-breakpoint

-- El aviso al worker. Disparo por evento y no por cron (`03-reglas-desarrollo-optimizado.md` §5): un
-- cron ancho correría en vacío 364 días. El payload es el uuid del trabajo y nada más — un `notify`
-- viaja al log de Postgres y a cualquier suscriptor, así que no lleva ni barrio, ni período, ni
-- identidad. El worker lo usa como "andá a mirar la cola", no como fuente de datos.
create or replace function app.trabajo_avisar() returns trigger
  language plpgsql
  set search_path = public, app
as $$
begin
  perform pg_notify('trabajo_nuevo', new.id::text);
  return null;
end; $$;
--> statement-breakpoint

create trigger trg_trabajo_avisar after insert on trabajo
  for each row execute function app.trabajo_avisar();
--> statement-breakpoint

-- Lo que el worker NO puede cambiar aunque tenga `update`. `app_job` corre con BYPASSRLS: ninguna
-- policy lo alcanza, y su grant de `update` es sobre la tabla entera. Esto acota qué significa
-- "avanzar un trabajo": mover el estado y el progreso, nunca el alcance ni la identidad. Sin esto,
-- un error en el worker —o un `update` a mano en una consola— convierte la delegación acotada
-- ("hacer esta cosa, sobre esta referencia, en este barrio, en nombre de esta persona") en algo
-- bastante peor.
create or replace function app.trabajo_alcance_inmutable() returns trigger
  language plpgsql
  set search_path = public, app
as $$
begin
  if new.barrio_id      is distinct from old.barrio_id
  or new.tipo           is distinct from old.tipo
  or new.referencia_id  is distinct from old.referencia_id
  or new.solicitado_por is distinct from old.solicitado_por
  or new.solicitado_at  is distinct from old.solicitado_at then
    raise exception 'el alcance y la identidad de un trabajo no se modifican después de encolarlo'
      using errcode = 'P0001';
  end if;
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_trabajo_alcance_inmutable before update on trabajo
  for each row execute function app.trabajo_alcance_inmutable();
--> statement-breakpoint

alter table trabajo enable row level security;--> statement-breakpoint
alter table trabajo force row level security;--> statement-breakpoint

-- Lectura: los cinco roles de gestión. Un trabajo no tiene datos de nadie — es un estado y un
-- progreso — y quien mira el período tiene que poder ver si la emisión terminó.
create policy trabajo_sel on trabajo for select
  using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint

-- Escritura: los mismos tres roles que pueden emitir. NO se usa `readable_tenant_ids()` acá: leer y
-- emitir son dos autorizaciones distintas, y `contador`/`auditor` leen sin poder disparar nada.
create policy trabajo_ins on trabajo for insert
  with check (app.has_role_on(barrio_id,
    array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

-- Ni `update` ni `delete` para el rol de request: ni policy ni grant. Con `insert` + `select`
-- solamente, la única forma de encolar es la prevista y la única forma de cambiar el estado es el
-- worker. Sin esto el trigger no alcanza: se inserta limpio y **después** se hace
-- `update trabajo set solicitado_por = …` antes de que el worker lo tome, o se vuelve
-- `fallado → encolado` para re-ejecutar, o se mueven `hechos`/`total` para falsear el progreso.
grant select, insert on table trabajo to app_request;--> statement-breakpoint
grant select, update on table trabajo to app_job;--> statement-breakpoint

comment on column trabajo.solicitado_por is
  'La identidad bajo la cual el worker corre el lote, NO una firma de auditoría. La escribe '
  'app.trabajo_antes_insert() desde app.current_user_id(), y la fila no es actualizable por el rol '
  'de request. Si cualquiera de esas dos garantías se afloja, el worker deja de "correr en nombre '
  'de alguien" y pasa a "correr como quien diga el atacante" (ADR-0002 §6.4).';
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. `documento_emitido` — append-only, con la firma escrita por la base y el gate por tipo.
-- ---------------------------------------------------------------------------------------------
create or replace function app.documento_antes_insert() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un documento sin emisor no se registra'
      using errcode = 'P0001';
  end if;
  -- Igual que `periodo_expensa.emitida_por` (0013): la firma la pone la base, nunca la aplicación.
  new.emitido_por := v_usuario;
  new.emitido_at  := now();
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_documento_antes_insert before insert on documento_emitido
  for each row execute function app.documento_antes_insert();
--> statement-breakpoint

-- Reimprimir es servir el objeto guardado; regenerar es un documento NUEVO, con su token, su fila y
-- su hash. Nunca se pisa el anterior: la URL emitida ayer sigue apuntando al PDF que se auditó ayer.
create trigger trg_documento_append before update or delete on documento_emitido
  for each row execute function app.solo_append();
--> statement-breakpoint

alter table documento_emitido enable row level security;--> statement-breakpoint
alter table documento_emitido force row level security;--> statement-breakpoint

create policy documento_emitido_sel on documento_emitido for select
  using (
    barrio_id in (select app.readable_tenant_ids())
    and (
      tipo <> 'listado_saldos_pendientes'
      or app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[])
    )
  );
--> statement-breakpoint

create policy documento_emitido_ins on documento_emitido for insert
  with check (app.has_role_on(barrio_id,
    array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

comment on policy documento_emitido_sel on documento_emitido is
  'Gate de descarga por tipo. La boleta y el informe los lee la membresía de gestión; el listado de '
  'saldos pendientes NO, porque una copia es la deuda con nombre de todo el barrio y '
  'readable_tenant_ids() incluye contador y auditor. Deliberadamente NO consulta tenant_grant: una '
  'servidumbre entre barrios (art. 2084) no es motivo para que un barrio lea los documentos del otro.';
--> statement-breakpoint

-- **Grants por columna, no por tabla.** `vista` queda fuera del `select`: es el documento entero, y
-- proyectarla es servirlo sin pasar por la ruta de descarga ni por su registro. Es el único lugar
-- del esquema donde un grant por columna se gana el sueldo.
--
-- Consecuencia para quien escriba consultas: un `select *` sobre esta tabla **falla** con permission
-- denied desde el rol de request. Es a propósito: enumerar las columnas obliga a decidir si se
-- quiere la vista, y la respuesta es que no.
grant select (id, barrio_id, periodo_id, tipo, liquidacion_id, storage_key, sha256, bytes,
              vista_version, motor, plantilla_hash, medio_cobranza, emitido_at, emitido_por)
  on table documento_emitido to app_request;
--> statement-breakpoint

grant insert (barrio_id, periodo_id, tipo, liquidacion_id, storage_key, sha256, bytes, vista,
              vista_version, motor, plantilla_hash, medio_cobranza)
  on table documento_emitido to app_request;
--> statement-breakpoint

-- `app_job` solo lee, y solo para diagnóstico: el worker **escribe los documentos con la conexión de
-- request y la identidad de quien pidió la emisión** (ADR-0002 §6.4 punto 2). Si esta tabla llegara
-- a tener `insert` para `app_job`, el camino de escritura podría dejar de pasar por la RLS sin que
-- nada se rompiera — que es exactamente el modo de falla que todo este diseño existe para evitar.
grant select on table documento_emitido to app_job;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. `descarga_documento` — el registro de acuñación de URLs firmadas.
--
-- El barrio se deriva del documento **bajo RLS**, con el mismo patrón que `trabajo`: si el documento
-- no es accesible para quien pide la descarga, no hay fila y no hay URL.
-- ---------------------------------------------------------------------------------------------
create or replace function app.descarga_antes_insert() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_barrio  uuid;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: no se firma una descarga anónima'
      using errcode = 'P0001';
  end if;

  select barrio_id into v_barrio from documento_emitido where id = new.documento_id;
  if v_barrio is null then
    raise exception 'no se pudo derivar el barrio del documento: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  new.barrio_id      := v_barrio;
  new.solicitado_por := v_usuario;
  new.url_firmada_at := now();
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_descarga_antes_insert before insert on descarga_documento
  for each row execute function app.descarga_antes_insert();
--> statement-breakpoint

create trigger trg_descarga_append before update or delete on descarga_documento
  for each row execute function app.solo_append();
--> statement-breakpoint

alter table descarga_documento enable row level security;--> statement-breakpoint
alter table descarga_documento force row level security;--> statement-breakpoint

-- Leer el registro es una función de administración, no de operación: dice quién pidió qué documento
-- y cuándo, sobre gente del estudio.
--
-- Las DOS condiciones, y no solo la del rol: `readable_tenant_ids()` es la definición única de "sobre
-- qué barrios este usuario ve datos", y una policy que la saltea es una que deja de heredar lo que
-- esa función aprenda después (la baja lógica de un nodo, un cambio en el subárbol). El gate de rol
-- va **encima**, no en su lugar. Hay un test que verifica que ninguna tabla con `barrio_id` se
-- olvide de la primera mitad.
create policy descarga_documento_sel on descarga_documento for select
  using (
    barrio_id in (select app.readable_tenant_ids())
    and app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[])
  );
--> statement-breakpoint

-- Escribir lo puede cualquiera que pueda leer el documento: es el acto de descargarlo. El trigger ya
-- verificó, bajo RLS, que el documento es accesible.
create policy descarga_documento_ins on descarga_documento for insert
  with check (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint

grant select, insert on table descarga_documento to app_request;--> statement-breakpoint
grant select on table descarga_documento to app_job;--> statement-breakpoint

comment on table descarga_documento is
  'Registro de ACUÑACIÓN de URLs firmadas, no de descargas. Con una URL firmada el objeto lo sirve '
  'el storage directo, sin pasar por nosotros: sabemos que alguien pidió el link, no que lo bajó. '
  'La columna se llama url_firmada_at por eso. Si algún día hace falta probar que un vecino '
  'descargó su boleta, ese es el gatillo para pasar a servir el archivo por la aplicación — no se '
  'puede sacar del diseño actual.';
--> statement-breakpoint

comment on column descarga_documento.solicitado_por is
  'Quién pidió el link. Sin IP ni user-agent a propósito: suman un dato personal sobre un empleado '
  'del estudio y no compran nada que esta columna no diga ya.';
