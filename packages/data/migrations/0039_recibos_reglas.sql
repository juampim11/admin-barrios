-- =============================================================================================
-- 0039_recibos_reglas — el número de recibo, la RLS de las tablas de 0038, y dos ajustes al esquema
-- existente que este módulo necesita: `trabajo.tipo` deja de ser un enum nativo, y
-- `descarga_documento` se generaliza para poder auditar la descarga de un comprobante o de un
-- recibo, no solo de un `documento_emitido`.
--
-- ---------------------------------------------------------------------------------------------
-- SOBRE `trabajo.tipo`: por qué se convierte a `text` + `CHECK`, y por qué NO con
-- `ALTER TYPE … ADD VALUE`.
--
-- `ALTER TYPE app.tipo_trabajo ADD VALUE 'emitir_recibo_pago'` habría sido el cambio de una línea.
-- Postgres lo prohíbe si el valor nuevo se usa en la MISMA transacción en la que se agrega (no se
-- puede `ADD VALUE` y después `INSERT`/comparar contra él sin un `COMMIT` en el medio). El migrador
-- de este repo (`drizzle-orm/pg-core/dialect.js`) aplica TODAS las migraciones pendientes de una
-- corrida en una sola transacción — así que separar el `ADD VALUE` en un archivo y el primer uso en
-- el siguiente **tampoco alcanza**: los dos siguen cayendo dentro de la misma transacción de
-- despliegue. Por eso el panel lo descartó y se pasa a `text` + `CHECK`, que se amplía con un
-- `DROP CONSTRAINT` / `ADD CONSTRAINT` corriente, sin esa limitación.
--
-- El backfill es el propio `USING tipo::text` del `ALTER COLUMN … TYPE`: no hace falta un `UPDATE`
-- aparte, porque convertir el tipo de la columna ya reescribe cada valor existente
-- (`emitir_documentos_periodo`) a su representación en texto. Se verifica en
-- `packages/data/test/trabajo-tipo-migracion.test.ts`.
-- ---------------------------------------------------------------------------------------------

alter table trabajo alter column tipo type text using tipo::text;
--> statement-breakpoint

drop type app.tipo_trabajo;
--> statement-breakpoint

alter table trabajo add constraint trabajo_tipo_chk
  check (tipo in ('emitir_documentos_periodo', 'emitir_recibo_pago'));
--> statement-breakpoint

-- `app.trabajo_antes_insert()` (0027) se reescribe entera para agregar la derivación del barrio del
-- nuevo tipo. El resto del cuerpo es idéntico; el bloque nuevo está marcado `-- [0039]`. Este tipo
-- nace habilitado en el `CHECK` aunque hoy nada encole un `emitir_recibo_pago` (el motor de PDF del
-- recibo es trabajo posterior, fuera de esta tanda) — mismo criterio que `documento_emitido.tipo`,
-- que nació con sus tres valores cuando solo se emitía la boleta.
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

  if new.tipo = 'emitir_documentos_periodo' then
    select barrio_id, estado into v_barrio, v_estado
      from periodo_expensa where id = new.referencia_id;
  elsif new.tipo = 'emitir_recibo_pago' then -- [0039]
    select barrio_id into v_barrio
      from pago where id = new.referencia_id and anulado_at is null;
  end if;

  if v_barrio is null then
    raise exception 'no se pudo derivar el barrio de la referencia: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

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
end; $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- `descarga_documento` generalizada: se agregan `pago_id`/`recibo_emitido_id` (declaradas en
-- `schema/documentos.ts`, pero esa columna la crea a mano ESTE archivo: `0038` solo generó las
-- tablas nuevas, no el `ALTER` de una tabla existente — mismo criterio que separa `0036`/`0037` de
-- lo que `drizzle-kit generate` puede proponer solo). `documento_id` deja de ser `NOT NULL`, y
-- exactamente una de las tres referencias tiene que venir.
-- ---------------------------------------------------------------------------------------------
alter table descarga_documento add column pago_id uuid references pago (id) on delete restrict;
--> statement-breakpoint
alter table descarga_documento add column recibo_emitido_id uuid references recibo_emitido (id) on delete restrict;
--> statement-breakpoint

alter table descarga_documento alter column documento_id drop not null;
--> statement-breakpoint

alter table descarga_documento add constraint descarga_referencia_unica_chk
  check (num_nonnulls(documento_id, pago_id, recibo_emitido_id) = 1);
--> statement-breakpoint

create index idx_descarga_pago on descarga_documento (pago_id);
--> statement-breakpoint
create index idx_descarga_recibo on descarga_documento (recibo_emitido_id);
--> statement-breakpoint

-- `app.descarga_antes_insert()` (0027) se reescribe entera: ahora deriva el barrio de cualquiera de
-- las tres referencias. Sigue SIN `security definer` — corre con la RLS de quien pide la descarga,
-- que es lo que hace que "no existe" y "no es tuyo" sean el mismo caso (mismo criterio que 0027 §2).
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

  if new.documento_id is not null then
    select barrio_id into v_barrio from documento_emitido where id = new.documento_id;
  elsif new.pago_id is not null then
    select barrio_id into v_barrio from pago where id = new.pago_id;
  elsif new.recibo_emitido_id is not null then
    select barrio_id into v_barrio from recibo_emitido where id = new.recibo_emitido_id;
  end if;

  if v_barrio is null then
    raise exception 'no se pudo derivar el barrio de la referencia: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  new.barrio_id      := v_barrio;
  new.solicitado_por := v_usuario;
  new.url_firmada_at := now();
  return new;
end; $$;--> statement-breakpoint

-- Sin `grant` nuevo acá: `descarga_documento` ya tenía `select, insert` para `app_request` desde
-- `0027` (a nivel de TABLA, no por columna), y eso ya cubre las dos columnas nuevas.

-- ---------------------------------------------------------------------------------------------
-- `recibo_emitido` / `recibo_secuencia` — calcado del patrón de `documento_emitido` (0027): la firma
-- y el número los pone la base, la fila es append-only, y `vista` no se le concede al rol de request
-- (es el documento entero congelado; proyectarla es servirlo sin pasar por la ruta de descarga).
-- ---------------------------------------------------------------------------------------------
alter table recibo_emitido add constraint uq_recibo_emitido_id_barrio unique (id, barrio_id);
--> statement-breakpoint
alter table recibo_emitido
  add constraint fk_recibo_emitido_pago_barrio foreign key (pago_id, barrio_id)
  references pago (id, barrio_id) on delete restrict;
--> statement-breakpoint

-- El contador por barrio, bajo lock: dos emisiones concurrentes del mismo barrio se serializan al
-- disputarse esta única fila. `insert … on conflict do nothing` + `update … returning` en el mismo
-- trigger: la primera línea garantiza que la fila del contador exista (barrio nuevo, primer recibo);
-- la segunda toma el lock de fila implícito de un `UPDATE` — el mismo mecanismo de exclusión mutua
-- que usa el resto del repo, sin necesitar un `for update` explícito porque acá SE ESCRIBE, no se
-- lee antes de escribir.
create or replace function app.recibo_antes() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_usuario   uuid := app.current_user_id();
  v_barrio    uuid;
  v_siguiente bigint;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un recibo sin emisor no se registra'
      using errcode = 'P0001';
  end if;

  -- Bajo la RLS de quien emite (sin security definer): un pago que no puede leer no existe para él.
  select barrio_id into v_barrio from pago where id = new.pago_id;
  if v_barrio is null then
    raise exception 'no se pudo derivar el barrio del pago: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;
  new.barrio_id := v_barrio;

  insert into recibo_secuencia (barrio_id, ultimo_numero) values (v_barrio, 0)
    on conflict (barrio_id) do nothing;

  update recibo_secuencia set ultimo_numero = ultimo_numero + 1
   where barrio_id = v_barrio
  returning ultimo_numero into v_siguiente;

  new.numero_recibo := v_siguiente;
  new.emitido_por    := v_usuario;
  new.emitido_at      := now();
  return new;
end; $$;--> statement-breakpoint

create trigger trg_recibo_antes before insert on recibo_emitido
  for each row execute function app.recibo_antes();
--> statement-breakpoint

-- Reimprimir es servir el objeto guardado; regenerar es OTRO recibo, con otra fila. Nunca se pisa.
create trigger trg_recibo_append before update or delete on recibo_emitido
  for each row execute function app.solo_append();
--> statement-breakpoint

alter table recibo_emitido enable row level security;
--> statement-breakpoint
alter table recibo_emitido force row level security;
--> statement-breakpoint

create policy recibo_emitido_sel on recibo_emitido for select
  using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint

create policy recibo_emitido_ins on recibo_emitido for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

-- Grants por columna, mismo motivo que `documento_emitido` (0027): `vista` no se proyecta.
grant select (id, barrio_id, pago_id, numero_recibo, storage_key, sha256, bytes, vista_version,
              motor, plantilla_hash, emitido_at, emitido_por)
  on table recibo_emitido to app_request;
--> statement-breakpoint
grant insert (barrio_id, pago_id, storage_key, sha256, bytes, vista, vista_version, motor, plantilla_hash)
  on table recibo_emitido to app_request;
--> statement-breakpoint
grant select on table recibo_emitido to app_job;
--> statement-breakpoint

alter table recibo_secuencia enable row level security;
--> statement-breakpoint
alter table recibo_secuencia force row level security;
--> statement-breakpoint

create policy recibo_secuencia_sel on recibo_secuencia for select
  using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint

create policy recibo_secuencia_ins on recibo_secuencia for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

create policy recibo_secuencia_upd on recibo_secuencia for update
  using (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]))
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

grant select, insert, update on table recibo_secuencia to app_request;
--> statement-breakpoint
grant select, insert, update on table recibo_secuencia to app_job;
