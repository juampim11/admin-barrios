-- 0096 · Planes de pago: el modelo de cláusulas y los documentos del plan (encargo P2a-3). Solo
-- estructura: dos tablas nuevas, constraints, funciones, triggers y dos tipos de trabajo. No borra ni
-- reescribe datos.
--
--   1. El modelo de cláusulas (`plan_modelo_clausulas`): uno por administración y por estudio, y el
--      general de la administración (estudio nulo) como respaldo. Lo edita la administración en
--      Configuración › Estudios jurídicos. Nace con el borrador de tres cláusulas (lo escribe el servicio,
--      `@admin-barrios/shared/planes-documentos`) y con «Texto a validar por el estudio» hasta que se
--      marque validado.
--   2. Los documentos del plan (`plan_documento`), **append-only**: el PDF que arma el sistema (camino a:
--      el modelo completado más el anexo; camino b: solo el anexo, para acompañar el documento del
--      estudio), el firmado y el del estudio. Un documento no se reemplaza: se agrega otro y queda la
--      historia. Cada uno deja su SHA-256 en un evento `documento_agregado` de `plan_evento`.
--   3. Dos trabajos de la cola (`emitir_acuerdo_plan`, camino a, y `emitir_anexo_plan`, camino b): el PDF
--      lo arma el worker con el generador de siempre (ADR-0001). Son dos tipos y no uno con un parámetro
--      porque `trabajo` no tiene dónde llevarlo, y el índice de un pendiente por (referencia, tipo) deja
--      armar los dos caminos a la vez.

-- ---------------------------------------------------------------------------------------------
-- 1. El modelo de cláusulas
-- ---------------------------------------------------------------------------------------------
create table plan_modelo_clausulas (
  id uuid primary key default gen_random_uuid(),
  administracion_id uuid not null references tenant_node (id) on delete restrict,
  -- Nulo: el general de la administración, el que se usa cuando el estudio del plan no tiene uno propio
  -- (o el plan lo cobra el barrio).
  estudio_id uuid references estudio_juridico (id) on delete restrict,
  -- `[{"titulo": "…", "texto": "…"}, …]`: de 1 a 20 cláusulas. La forma de cada una la controla el trigger.
  clausulas jsonb not null,
  -- Mientras es `false`, el PDF y la pantalla dicen «Texto a validar por el estudio».
  texto_validado boolean not null default false,
  actualizado_por uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plan_modelo_clausulas_chk check (jsonb_typeof(clausulas) = 'array' and jsonb_array_length(clausulas) between 1 and 20)
);
--> statement-breakpoint
create unique index uq_plan_modelo_general on plan_modelo_clausulas (administracion_id) where estudio_id is null;
--> statement-breakpoint
create unique index uq_plan_modelo_estudio on plan_modelo_clausulas (administracion_id, estudio_id) where estudio_id is not null;
--> statement-breakpoint
comment on table plan_modelo_clausulas is
  'El modelo de cláusulas del convenio de un plan de pagos: uno por administración y estudio, y el general (estudio nulo) como respaldo.';
--> statement-breakpoint

-- La forma de cada cláusula, quién y cuándo, y que el estudio trabaje con la administración. Dueño
-- `app_job`, como los controles del estudio de `0095`, y con el mismo cuidado: si quien escribe no
-- administra esa administración, el control no corre y frena la RLS con su mensaje.
create or replace function app.plan_modelo_antes() returns trigger
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
declare c jsonb;
begin
  if tg_op = 'UPDATE' and (new.administracion_id <> old.administracion_id or new.estudio_id is distinct from old.estudio_id) then
    raise exception 'el modelo no cambia de administración ni de estudio';
  end if;
  for c in select * from jsonb_array_elements(new.clausulas) loop
    if jsonb_typeof(c) <> 'object' or jsonb_typeof(c -> 'titulo') <> 'string' or jsonb_typeof(c -> 'texto') <> 'string'
       or (select count(*) from jsonb_object_keys(c)) <> 2
       or length(btrim(c ->> 'titulo')) not between 1 and 120 or length(btrim(c ->> 'texto')) not between 1 and 4000 then
      raise exception 'cada cláusula lleva un título (hasta 120 letras) y un texto (hasta 4000)';
    end if;
  end loop;
  if new.estudio_id is not null and new.administracion_id in (select app.administraciones_administradas())
     and not exists (select 1 from estudio_administracion ea
                      where ea.estudio_id = new.estudio_id and ea.administracion_id = new.administracion_id) then
    raise exception 'el estudio del modelo no trabaja con la administración';
  end if;
  new.actualizado_por := app.current_user_id();
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_plan_modelo_antes before insert or update on plan_modelo_clausulas
  for each row execute function app.plan_modelo_antes();
--> statement-breakpoint

-- La historia del modelo (revisión de seguridad, M2): cada alta y cada cambio queda con quién y cuándo,
-- y con el texto entero. «Validado» saca la leyenda del PDF y las cláusulas no pasan por el filtro de
-- lenguaje: quién lo marcó y qué decía tiene que poder leerse después.
create table plan_modelo_clausulas_historia (
  id uuid primary key default gen_random_uuid(),
  modelo_id uuid not null references plan_modelo_clausulas (id) on delete restrict,
  administracion_id uuid not null references tenant_node (id) on delete restrict,
  clausulas jsonb not null,
  texto_validado boolean not null,
  registrado_por uuid not null,
  registrado_at timestamptz not null default clock_timestamp()
);
--> statement-breakpoint
create index idx_plan_modelo_historia on plan_modelo_clausulas_historia (modelo_id, registrado_at);
--> statement-breakpoint
create or replace function app.plan_modelo_a_la_historia() returns trigger
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
begin
  insert into plan_modelo_clausulas_historia (modelo_id, administracion_id, clausulas, texto_validado, registrado_por)
  values (new.id, new.administracion_id, new.clausulas, new.texto_validado, new.actualizado_por);
  return null;
end; $$;
--> statement-breakpoint
create trigger trg_plan_modelo_historia after insert or update on plan_modelo_clausulas
  for each row execute function app.plan_modelo_a_la_historia();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. Los documentos del plan
-- ---------------------------------------------------------------------------------------------
create table plan_documento (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null,
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  -- `acuerdo`: el PDF del sistema, camino a (modelo completado + anexo). `anexo`: el PDF del sistema,
  -- camino b (solo el anexo). `firmado`: el acuerdo firmado, escaneado. `del_estudio`: el documento que
  -- redactó el estudio (camino b).
  clase text not null,
  storage_key text not null,
  sha256 char(64) not null,
  bytes integer not null,
  content_type text not null,
  -- El nombre del archivo que se subió (solo los subidos).
  nombre text,
  -- Cómo estaba el plan cuando se armó o se subió: un PDF de la propuesta no dice las cifras de la firma.
  estado_plan text not null,
  -- Solo los que arma el sistema: el modelo de vista congelado (ADR-0001 §6), el motor y la plantilla.
  vista jsonb,
  vista_version text,
  motor text,
  plantilla_hash char(64),
  registrado_por uuid not null,
  registrado_at timestamptz not null default clock_timestamp(),
  constraint fk_plan_documento_plan foreign key (plan_id, barrio_id) references plan_pago (id, barrio_id) on delete restrict,
  constraint uq_plan_documento_clave unique (storage_key),
  constraint plan_documento_clase_chk check (clase in ('acuerdo', 'anexo', 'firmado', 'del_estudio')),
  constraint plan_documento_sha_chk check (sha256 ~ '^[0-9a-f]{64}$' and bytes > 0),
  constraint plan_documento_tipo_chk check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  -- Cuelga del propio barrio y del propio plan (mismo alfabeto cerrado que el resto de las claves).
  constraint plan_documento_clave_chk check (
    storage_key ~ ('^barrios/' || barrio_id::text || '/planes/' || plan_id::text || '/[A-Za-z0-9_-]{22,64}\.(pdf|jpg|jpeg|png)$')),
  -- Lo que arma el sistema es un PDF con su vista; lo subido lleva el nombre del archivo y no tiene vista.
  constraint plan_documento_origen_chk check (
    case when clase in ('acuerdo', 'anexo')
      then vista is not null and vista_version is not null and motor is not null and plantilla_hash is not null
           and nombre is null and content_type = 'application/pdf'
      else vista is null and vista_version is null and motor is null and plantilla_hash is null
           and nombre is not null and length(nombre) between 1 and 200
    end),
  constraint plan_documento_estado_chk check (estado_plan in ('pendiente', 'vigente', 'cumplido', 'caido'))
);
--> statement-breakpoint
create index idx_plan_documento_plan on plan_documento (plan_id, registrado_at);
--> statement-breakpoint
create index idx_plan_documento_barrio on plan_documento (barrio_id);
--> statement-breakpoint
comment on table plan_documento is
  'Los documentos de un plan de pagos, append-only: el PDF que arma el sistema (acuerdo o anexo), el firmado y el del estudio. Cada alta deja su SHA-256 en plan_evento.';
--> statement-breakpoint

alter table plan_evento drop constraint plan_evento_tipo_chk;
--> statement-breakpoint
alter table plan_evento add constraint plan_evento_tipo_chk
  check (tipo in ('propuesto', 'firmado', 'cuota_emitida', 'rechazado', 'retirado', 'cumplido', 'caido', 'acta_cargada', 'documento_agregado'));
--> statement-breakpoint

-- La única puerta para agregar un documento: la administración del barrio, con el plan sin rechazar ni
-- retirar. Escribe el documento y su evento juntos (el SHA-256 queda en los dos). La usan el worker (lo
-- que arma el sistema, con la identidad de quien lo pidió) y la acción de subir.
create or replace function app.plan_agregar_documento(
  p_plan uuid, p_clase text, p_storage_key text, p_sha256 text, p_bytes integer, p_content_type text, p_nombre text,
  p_vista jsonb, p_vista_version text, p_motor text, p_plantilla_hash text
) returns uuid
  language plpgsql security definer set search_path = public, app, pg_temp
as $$
declare
  v_plan plan_pago;
  v_id   uuid;
begin
  -- El rol va en el mismo `where` que el candado (revisión de seguridad, M1): un plan de otro barrio no
  -- se bloquea ni demora, y responde igual que uno que no existe.
  select * into v_plan from plan_pago
   where id = p_plan and app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[])
     for update;
  if v_plan.id is null then
    raise exception 'el plan no existe o no es de un barrio que administres' using errcode = '42501';
  end if;
  if v_plan.estado in ('rechazado', 'retirado') then
    raise exception 'el plan está rechazado o retirado: no lleva documentos nuevos';
  end if;
  if p_clase in ('acuerdo', 'anexo') then
    -- Lo que arma el sistema lo registra solo el trabajo que lo está armando (revisión de seguridad, A1):
    -- un trabajo `corriendo` lo pone la cola (`app_job`), nunca el request, y es de quien llama.
    if not exists (select 1 from trabajo t
                    where t.referencia_id = p_plan and t.estado = 'corriendo' and t.solicitado_por = app.current_user_id()
                      and t.tipo = case p_clase when 'acuerdo' then 'emitir_acuerdo_plan' else 'emitir_anexo_plan' end) then
      raise exception 'el PDF del plan lo registra solo el trabajo que lo arma';
    end if;
    -- Si el plan cambió de estado mientras se armaba (se aprobó), el PDF dice las cifras de antes: no se
    -- registra con un estado que no es el suyo (code-reviewer, 3). El trabajo se vuelve a pedir.
    if p_vista ->> 'version' is null or (p_vista -> 'plan' ->> 'estado') is distinct from v_plan.estado then
      raise exception 'el plan cambió mientras se armaba el PDF';
    end if;
  end if;
  -- El documento del estudio se acepta aunque el plan lo cobre el barrio: un estudio puede redactar el
  -- convenio sin cobrarlo.
  insert into plan_documento (plan_id, barrio_id, clase, storage_key, sha256, bytes, content_type, nombre, estado_plan,
                              vista, vista_version, motor, plantilla_hash, registrado_por)
  values (p_plan, v_plan.barrio_id, p_clase, p_storage_key, p_sha256, p_bytes, p_content_type, nullif(btrim(p_nombre), ''), v_plan.estado,
          p_vista, p_vista_version, p_motor, p_plantilla_hash, app.current_user_id())
  returning id into v_id;
  insert into plan_evento (plan_id, barrio_id, tipo, detalle)
  values (p_plan, v_plan.barrio_id, 'documento_agregado',
          jsonb_build_object('documentoId', v_id, 'clase', p_clase, 'sha256', p_sha256, 'bytes', p_bytes,
                             'nombre', nullif(btrim(p_nombre), ''), 'estadoPlan', v_plan.estado));
  return v_id;
end; $$;
--> statement-breakpoint

-- El modelo que usa un plan: el del estudio del plan (el que cobra o, si es del catálogo, el del plan
-- del catálogo) en la administración del barrio; si no tiene uno, el general. Corre con la identidad de
-- quien llama (sin `security definer`): un modelo que esa persona no puede leer no existe para ella.
create or replace function app.plan_modelo_del_plan(p_plan uuid) returns uuid
  language sql stable set search_path = public, app, pg_temp
as $$
  with p as (
    select coalesce(pp.estudio_id, c.estudio_id) as estudio_id, b.parent_id as administracion_id
      from plan_pago pp
      join tenant_node b on b.id = pp.barrio_id
      left join plan_catalogo c on c.id = pp.catalogo_id
     where pp.id = p_plan
  )
  select m.id from plan_modelo_clausulas m, p
   where m.administracion_id = p.administracion_id and (m.estudio_id = p.estudio_id or m.estudio_id is null)
   order by m.estudio_id is null
   limit 1
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Los trabajos que arman el PDF del plan
-- ---------------------------------------------------------------------------------------------
alter table trabajo drop constraint trabajo_tipo_chk;
--> statement-breakpoint
alter table trabajo add constraint trabajo_tipo_chk check (
  tipo in (
    'emitir_documentos_periodo',
    'emitir_recibo_pago',
    'emitir_informe_periodo',
    'armar_paquete_periodo',
    'distribuir_liquidaciones',
    'emitir_acuerdo_plan',
    'emitir_anexo_plan'
  )
);
--> statement-breakpoint

-- `app.trabajo_antes_insert()` de `0055`, entero y sin cambios, más la rama de los planes ([0096]). El
-- gate de encolar es el mismo que el de la tabla que el trabajo va a escribir (regla de `0055` §4): la
-- administración del barrio, el plan sin rechazar ni retirar y, para el camino a, un modelo de cláusulas
-- que se pueda usar. Un trabajo que siempre falla es peor que uno prohibido.
create or replace function app.trabajo_antes_insert() returns trigger
  language plpgsql
  set search_path = public, app, pg_temp
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_barrio  uuid;
  v_estado  app.estado_periodo;
  v_boletas int;
  v_informes int;
  v_paquetes int;
  v_plan    plan_pago;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un trabajo sin autor no se encola'
      using errcode = 'P0001';
  end if;

  if new.tipo in ('emitir_documentos_periodo', 'emitir_informe_periodo',
                  'armar_paquete_periodo', 'distribuir_liquidaciones') then
    select barrio_id, estado into v_barrio, v_estado
      from periodo_expensa where id = new.referencia_id;
  elsif new.tipo = 'emitir_recibo_pago' then
    select barrio_id into v_barrio
      from pago where id = new.referencia_id and anulado_at is null;
  elsif new.tipo in ('emitir_acuerdo_plan', 'emitir_anexo_plan') then                    -- [0096]
    select * into v_plan from plan_pago where id = new.referencia_id;
    v_barrio := v_plan.barrio_id;
  end if;

  if v_barrio is null then
    raise exception 'no se pudo derivar el barrio de la referencia: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  if new.tipo in ('emitir_documentos_periodo', 'emitir_informe_periodo',
                  'armar_paquete_periodo', 'distribuir_liquidaciones')
     and v_estado not in ('emitida', 'distribuida') then
    raise exception 'el período no está emitido: los documentos salen de lo que quedó emitido'
      using errcode = 'P0001';
  end if;

  if new.tipo in ('emitir_acuerdo_plan', 'emitir_anexo_plan') then                       -- [0096]
    if not app.has_role_on(v_barrio, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
      raise exception 'no tenés permiso para armar los documentos de este plan'
        using errcode = 'P0001';
    end if;
    if v_plan.estado in ('rechazado', 'retirado') then
      raise exception 'el plan está rechazado o retirado: no lleva documentos nuevos'
        using errcode = 'P0001';
    end if;
    if new.tipo = 'emitir_acuerdo_plan' and app.plan_modelo_del_plan(v_plan.id) is null then
      raise exception 'no hay un modelo de cláusulas para este plan: se carga en Configuración › Estudios jurídicos'
        using errcode = 'P0001';
    end if;
  end if;

  if new.tipo = 'distribuir_liquidaciones' then
    if not app.has_role_on(v_barrio, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
      raise exception 'no tenés permiso para distribuir: la distribución envía datos personales fuera del sistema'
        using errcode = 'P0001';
    end if;

    select count(*) into v_boletas from documento_emitido
      where periodo_id = new.referencia_id and tipo = 'boleta_unidad';
    if v_boletas = 0 then
      raise exception 'el período no tiene boletas emitidas: no hay qué distribuir'
        using errcode = 'P0001';
    end if;

    select count(*) into v_informes from documento_emitido
      where periodo_id = new.referencia_id and tipo = 'informe_mensual';
    if v_informes = 0 then
      raise exception 'el período no tiene informe mensual emitido: es el segundo adjunto del envío'
        using errcode = 'P0001';
    end if;
  end if;

  if new.tipo = 'armar_paquete_periodo' then
    if not app.has_role_on(v_barrio, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
      raise exception 'no tenés permiso para armar el paquete del período'
        using errcode = 'P0001';
    end if;

    select count(*) into v_boletas from documento_emitido
      where periodo_id = new.referencia_id and tipo = 'boleta_unidad';
    if v_boletas = 0 then
      raise exception 'el período no tiene boletas emitidas: no hay qué empaquetar'
        using errcode = 'P0001';
    end if;
  end if;

  if new.tipo = 'distribuir_liquidaciones' then
    select count(*) into v_paquetes from paquete_distribucion
      where periodo_id = new.referencia_id;
    if v_paquetes = 0 then
      raise exception 'todavía no se armó el paquete del período: se distribuye después de empaquetar'
        using errcode = 'P0001';
    end if;
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
end;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Seguridad, dueños y permisos
-- ---------------------------------------------------------------------------------------------
do $bloque$
declare t text;
begin
  foreach t in array array['plan_modelo_clausulas', 'plan_documento'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end
$bloque$;
--> statement-breakpoint

-- El modelo vive en la administración (como el catálogo y el criterio de mora). Sin borrar.
create policy plan_modelo_clausulas_sel on plan_modelo_clausulas for select
  using (administracion_id in (select app.readable_tenant_ids()) or administracion_id in (select app.readable_admin_ancestros()));
--> statement-breakpoint
create policy plan_modelo_clausulas_ins on plan_modelo_clausulas for insert
  with check (administracion_id in (select app.administraciones_administradas()));
--> statement-breakpoint
create policy plan_modelo_clausulas_upd on plan_modelo_clausulas for update
  using (administracion_id in (select app.administraciones_administradas()))
  with check (administracion_id in (select app.administraciones_administradas()));
--> statement-breakpoint
grant select, insert on table plan_modelo_clausulas to app_request;
--> statement-breakpoint
grant update (clausulas, texto_validado) on table plan_modelo_clausulas to app_request;
--> statement-breakpoint
grant select on table plan_modelo_clausulas to app_job;
--> statement-breakpoint

-- Los documentos los lee quien lee el plan; se agregan solo por `app.plan_agregar_documento` (sin grant
-- de insert, update ni delete: append-only también para la administración). La vista congelada no se
-- proyecta desde el request (mismo criterio que `documento_emitido.vista`): grant por columna.
create policy plan_documento_sel on plan_documento for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
grant select (id, plan_id, barrio_id, clase, storage_key, sha256, bytes, content_type, nombre, estado_plan, registrado_por, registrado_at)
  on table plan_documento to app_request;
--> statement-breakpoint
grant select, insert on table plan_documento to app_job;
--> statement-breakpoint
alter table plan_modelo_clausulas_historia enable row level security;
--> statement-breakpoint
alter table plan_modelo_clausulas_historia force row level security;
--> statement-breakpoint
create policy plan_modelo_historia_sel on plan_modelo_clausulas_historia for select
  using (administracion_id in (select app.readable_tenant_ids()) or administracion_id in (select app.readable_admin_ancestros()));
--> statement-breakpoint
grant select on table plan_modelo_clausulas_historia to app_request;
--> statement-breakpoint
grant select, insert on table plan_modelo_clausulas_historia to app_job;
--> statement-breakpoint
grant select on table trabajo to app_job;
--> statement-breakpoint

do $bloque$
declare f text;
begin
  -- Dueño `app_job` (BYPASSRLS): el control del estudio ve todos los vínculos, y el alta del documento
  -- escribe en dos tablas sin grant para el request.
  foreach f in array array['plan_modelo_antes()', 'plan_modelo_a_la_historia()',
                           'plan_agregar_documento(uuid, text, text, text, integer, text, text, jsonb, text, text, text)'] loop
    execute format('alter function app.%s owner to app_job', f);
    execute format('revoke execute on function app.%s from public', f);
    execute format('grant execute on function app.%s to app_request, app_job', f);
  end loop;
  revoke execute on function app.plan_modelo_del_plan(uuid) from public;
  grant execute on function app.plan_modelo_del_plan(uuid) to app_request, app_job;
end
$bloque$;
