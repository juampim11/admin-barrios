-- =============================================================================================
-- 0091 · Mora y estudios jurídicos (encargo E-a, BL-050). Solo DDL.
--
-- Qué agrega, sin tocar ninguna tabla ni política existente:
--   1. `estudio_juridico`: una cuenta propia, que NO cuelga de ninguna administración (nombre, CUIT
--      único). Una administración lo ve solo a través de su vínculo.
--   2. `estudio_administracion` (N:N): con qué estudios trabaja cada administración, el correo de los
--      avisos, el teléfono que va en la boleta, la preferencia de aviso y si está activo.
--   3. `estudio_barrio` (N:N): qué estudios trabajan en cada barrio, uno solo «por defecto».
--   4. El criterio para PROPONER derivaciones: en la administración (`mora_criterio_administracion`) y,
--      opcional, en el barrio (`mora_barrio`). La figura y el pacto de ejecutividad del barrio NO se
--      duplican: son `barrio.figura_juridica` y `barrio.pacto_ejecutividad` (null = a confirmar), que ya
--      existen desde `0002` y la aplicación ya puede escribir (`0050`).
--   5. `derivacion` + `derivacion_foto`: una unidad derivada a un estudio, con la foto inmutable de su
--      deuda mes por mes al momento de derivar, y el retiro.
--   6. `gestion` + `gestion_anulacion`: portadas de Aclade (`0014_gestiones_reclamo_legal.sql`,
--      241-421). Solo se agregan filas; una gestión equivocada se anula con motivo.
--
-- Qué NO hace: nada que calcule plata. La deuda de la foto la calcula el código que ya existe
-- (`deudaALaFecha`) y se guarda como dato; ninguna tabla de acá entra al cupón, al interés ni a la
-- imputación. Derivar no cambia la boleta (eso es E-c).
--
-- RLS sobre la forma de `0018`: lectura con `barrio_id in (select app.readable_tenant_ids())` y, para
-- lo que vive en la administración, también `app.readable_admin_ancestros()` (`0057`), que ya abre la
-- administración de los barrios que el usuario lee. Escritura con `app.has_role_on(...)`.
-- Regla del repo: una migración ya aplicada NO se edita; se agrega la siguiente con prefijo mayor.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. El estudio jurídico: una cuenta que cruza administraciones.
-- ---------------------------------------------------------------------------------------------
create table estudio_juridico (
  id uuid primary key default gen_random_uuid(),
  -- El nombre con el que se dio de alta la cuenta. **Ninguna administración lo edita** (lo va a editar
  -- el estudio, E-b): cada administración muestra el suyo, `estudio_administracion.nombre`. Si no, una
  -- administración renombraba el estudio para todas las demás (security-engineer, bloqueante).
  nombre text not null,
  -- Sin guiones, 11 dígitos. Único: es lo que identifica al estudio entre administraciones.
  cuit text not null,
  creado_por uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint estudio_juridico_nombre_chk check (length(nombre) between 1 and 160 and nombre = btrim(nombre)),
  constraint estudio_juridico_cuit_chk check (cuit ~ '^\d{11}$'),
  constraint uq_estudio_juridico_cuit unique (cuit)
);
--> statement-breakpoint
comment on table estudio_juridico is
  'Un estudio jurídico: cuenta propia, no pertenece a ninguna administración. Una administración lo ve solo por su vínculo (estudio_administracion), con el nombre que ella le da.';
--> statement-breakpoint

-- Quién lo creó y cuándo, lo fija la base.
create or replace function app.estudio_juridico_antes_insert() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  new.creado_por := app.current_user_id();
  if new.creado_por is null then
    raise exception 'un estudio se da de alta con una identidad';
  end if;
  new.created_at := now();
  new.updated_at := now();
  return new;
end; $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. El vínculo con cada administración.
-- ---------------------------------------------------------------------------------------------
create table estudio_administracion (
  estudio_id uuid not null references estudio_juridico (id) on delete restrict,
  administracion_id uuid not null references tenant_node (id) on delete restrict,
  -- El nombre con el que ESTA administración ve al estudio (en sus pantallas, su CSV y, en E-c, su boleta).
  nombre text not null,
  correo_avisos text not null,
  telefono_boleta text,
  preferencia_aviso text not null default 'cada_derivacion',
  activo boolean not null default true,
  vinculado_por uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (estudio_id, administracion_id),
  constraint estudio_administracion_nombre_chk check (length(nombre) between 1 and 160 and nombre = btrim(nombre)),
  constraint estudio_administracion_correo_chk check (correo_avisos ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and correo_avisos = lower(correo_avisos)),
  constraint estudio_administracion_telefono_chk check (telefono_boleta is null or length(telefono_boleta) between 6 and 40),
  constraint estudio_administracion_aviso_chk check (preferencia_aviso in ('cada_derivacion', 'cada_derivacion_y_resumen', 'solo_resumen'))
);
--> statement-breakpoint
create index idx_estudio_administracion_admin on estudio_administracion (administracion_id);
--> statement-breakpoint
-- La búsqueda por correo es exacta, sin importar mayúsculas (se guarda en minúsculas).
create index idx_estudio_administracion_correo on estudio_administracion (correo_avisos);
--> statement-breakpoint

-- El vínculo es con un nodo de tipo administrador, y no se muda de estudio ni de administración.
create or replace function app.estudio_administracion_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'un vínculo con un estudio no se borra: se da de baja';
  end if;
  if tg_op = 'UPDATE' then
    if (new.estudio_id, new.administracion_id) is distinct from (old.estudio_id, old.administracion_id) then
      raise exception 'un vínculo no se muda de estudio ni de administración';
    end if;
    new.created_at := old.created_at;
    new.vinculado_por := old.vinculado_por;
    -- La baja no puede dejar unidades derivadas sin estudio: primero se retiran o se pasan a otro.
    if old.activo and not new.activo and exists (
      select 1 from derivacion d join tenant_node n on n.id = d.barrio_id
       where d.estudio_id = new.estudio_id and n.parent_id = new.administracion_id and d.retirada_at is null
    ) then
      raise exception 'el estudio tiene unidades derivadas: primero se retiran o se pasan a otro estudio';
    end if;
    if old.activo and not new.activo then
      delete from estudio_barrio eb using tenant_node n
       where eb.estudio_id = new.estudio_id and n.id = eb.barrio_id and n.parent_id = new.administracion_id;
    end if;
  else
    if not exists (select 1 from tenant_node where id = new.administracion_id and tipo = 'administrador' and deleted_at is null) then
      raise exception 'un estudio se vincula con una administración';
    end if;
    new.vinculado_por := app.current_user_id();
    if new.vinculado_por is null then
      raise exception 'un vínculo se hace con una identidad';
    end if;
    new.created_at := now();
  end if;
  new.updated_at := now();
  return new;
end; $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Qué estudios trabajan en cada barrio.
-- ---------------------------------------------------------------------------------------------
create table estudio_barrio (
  estudio_id uuid not null references estudio_juridico (id) on delete restrict,
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  por_defecto boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (estudio_id, barrio_id)
);
--> statement-breakpoint
create index idx_estudio_barrio_barrio on estudio_barrio (barrio_id);
--> statement-breakpoint
-- Un solo estudio por defecto por barrio.
create unique index uq_estudio_barrio_por_defecto on estudio_barrio (barrio_id) where por_defecto;
--> statement-breakpoint

-- El estudio tiene que estar vinculado (y activo) con la administración del barrio. Sacarlo del
-- barrio con unidades derivadas ahí, no.
create or replace function app.estudio_barrio_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from derivacion d where d.estudio_id = old.estudio_id and d.barrio_id = old.barrio_id and d.retirada_at is null) then
      raise exception 'el estudio tiene unidades derivadas en este barrio: primero se retiran o se pasan a otro estudio';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.estudio_id, new.barrio_id) is distinct from (old.estudio_id, old.barrio_id) then
    raise exception 'un estudio no se muda de barrio: se saca y se agrega';
  end if;
  if not exists (
    select 1 from estudio_administracion ea join tenant_node n on n.parent_id = ea.administracion_id
     where n.id = new.barrio_id and ea.estudio_id = new.estudio_id and ea.activo
  ) then
    raise exception 'el estudio no está vinculado con la administración de este barrio';
  end if;
  if tg_op = 'INSERT' then new.created_at := now(); else new.created_at := old.created_at; end if;
  return new;
end; $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. El criterio para proponer derivaciones: administración y, opcional, barrio.
-- ---------------------------------------------------------------------------------------------
create table mora_criterio_administracion (
  administracion_id uuid primary key references tenant_node (id) on delete restrict,
  -- «Más de N meses» de deuda vencida.
  meses smallint not null,
  monto_minimo numeric(14, 2) not null,
  -- Avisar al derivar si la unidad no tiene una intimación registrada.
  pedir_intimacion boolean not null default true,
  -- Texto base del aviso de la boleta de una unidad derivada (lo usa E-c). `{estudio}` y `{telefono}`.
  leyenda_boleta text not null,
  cargado_por uuid not null,
  updated_at timestamptz not null default now(),
  constraint mora_criterio_administracion_meses_chk check (meses between 0 and 120),
  constraint mora_criterio_administracion_monto_chk check (monto_minimo >= 0),
  constraint mora_criterio_administracion_leyenda_chk check (length(leyenda_boleta) between 1 and 600)
);
--> statement-breakpoint

create table mora_barrio (
  barrio_id uuid primary key references barrio (barrio_id) on delete restrict,
  -- Los dos en null = usa el criterio de la administración. Los dos con valor = criterio propio.
  meses smallint,
  monto_minimo numeric(14, 2),
  pedir_intimacion boolean,
  -- null = usa el texto base de la administración.
  leyenda_boleta text,
  cargado_por uuid not null,
  updated_at timestamptz not null default now(),
  constraint mora_barrio_criterio_chk check ((meses is null) = (monto_minimo is null)),
  constraint mora_barrio_meses_chk check (meses is null or meses between 0 and 120),
  constraint mora_barrio_monto_chk check (monto_minimo is null or monto_minimo >= 0),
  constraint mora_barrio_leyenda_chk check (leyenda_boleta is null or length(leyenda_boleta) between 1 and 600)
);
--> statement-breakpoint

create or replace function app.mora_criterio_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  -- Anidado y no con `and`: plpgsql evalúa la expresión entera, y `mora_barrio` no tiene esa columna.
  if tg_table_name = 'mora_criterio_administracion' then
    if not exists (select 1 from tenant_node where id = new.administracion_id and tipo = 'administrador') then
      raise exception 'el criterio general es de una administración';
    end if;
  end if;
  new.cargado_por := app.current_user_id();
  if new.cargado_por is null then
    raise exception 'el criterio se carga con una identidad';
  end if;
  new.updated_at := now();
  return new;
end; $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. La derivación y su foto.
-- ---------------------------------------------------------------------------------------------
create table derivacion (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  unidad_funcional_id uuid not null,
  estudio_id uuid not null references estudio_juridico (id) on delete restrict,
  -- Las derivaciones que se hacen juntas comparten la tanda (un correo por estudio y tanda, E-b).
  tanda_id uuid not null,
  motivo text not null,
  nota text,
  derivada_por uuid not null,
  derivada_at timestamptz not null default now(),
  retiro_motivo text,
  retiro_nota text,
  retirada_por uuid,
  retirada_at timestamptz,
  constraint fk_derivacion_unidad foreign key (unidad_funcional_id, barrio_id)
    references unidad_funcional (id, barrio_id) on delete restrict,
  constraint derivacion_motivo_chk check (motivo in ('criterio_cumplido', 'incumplio_plan', 'incumplio_promesa', 'otro')),
  constraint derivacion_nota_chk check (nota is null or (length(nota) between 1 and 500 and nota = btrim(nota))),
  constraint derivacion_otro_chk check (motivo <> 'otro' or nota is not null),
  constraint derivacion_retiro_motivo_chk check (retiro_motivo is null or retiro_motivo in
    ('pago', 'plan_administracion', 'acuerdo_juicio', 'venta', 'error', 'cambio_estudio', 'otro')),
  constraint derivacion_retiro_nota_chk check (retiro_nota is null or (length(retiro_nota) between 1 and 500 and retiro_nota = btrim(retiro_nota))),
  -- El retiro va entero o no va: motivo, quién y cuándo.
  constraint derivacion_retiro_chk check (
    (retirada_at is null and retirada_por is null and retiro_motivo is null and retiro_nota is null)
    or (retirada_at is not null and retirada_por is not null and retiro_motivo is not null)),
  constraint derivacion_retiro_otro_chk check (retiro_motivo is distinct from 'otro' or retiro_nota is not null),
  constraint uq_derivacion_id_barrio unique (id, barrio_id),
  -- Para que el renglón «Derivación» de las gestiones apunte a una derivación de SU unidad.
  constraint uq_derivacion_id_unidad_barrio unique (id, unidad_funcional_id, barrio_id)
);
--> statement-breakpoint
-- Una sola derivación vigente por unidad.
create unique index uq_derivacion_vigente on derivacion (unidad_funcional_id) where retirada_at is null;
--> statement-breakpoint
create index idx_derivacion_barrio on derivacion (barrio_id);
--> statement-breakpoint
create index idx_derivacion_estudio on derivacion (estudio_id) where retirada_at is null;
--> statement-breakpoint

-- Al derivar, el estudio tiene que trabajar en ese barrio. Una derivación no se borra ni se edita:
-- lo único que cambia, una vez, es el retiro.
create or replace function app.derivacion_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'una derivación no se borra: se retira';
  end if;
  if tg_op = 'INSERT' then
    -- Primero quién: derivar es de la administración. La policy lo vuelve a exigir, pero corre después
    -- de este trigger, y sin esto el lock de abajo le contestaría «no trabaja acá» a un operador.
    if not app.has_role_on(new.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) then
      raise exception 'derivar es de la administración' using errcode = 'insufficient_privilege';
    end if;
    -- `for key share`: si a la vez alguien saca al estudio del barrio, su trigger espera este lock y
    -- después ve la derivación (dba-data). Sin el lock, quedaba una derivación con un estudio que ya
    -- no trabaja en el barrio.
    perform 1 from estudio_barrio eb where eb.estudio_id = new.estudio_id and eb.barrio_id = new.barrio_id for key share;
    if not found then
      raise exception 'el estudio no trabaja en este barrio';
    end if;
    new.derivada_por := app.current_user_id();
    if new.derivada_por is null then
      raise exception 'una derivación se hace con una identidad';
    end if;
    new.derivada_at := now();
    if new.retirada_at is not null or new.retiro_motivo is not null then
      raise exception 'una derivación nace vigente';
    end if;
    return new;
  end if;
  -- UPDATE: solo el retiro, una vez.
  if old.retirada_at is not null then
    raise exception 'la derivación ya se retiró';
  end if;
  if (new.id, new.barrio_id, new.unidad_funcional_id, new.estudio_id, new.tanda_id, new.motivo, new.nota, new.derivada_por, new.derivada_at)
     is distinct from (old.id, old.barrio_id, old.unidad_funcional_id, old.estudio_id, old.tanda_id, old.motivo, old.nota, old.derivada_por, old.derivada_at) then
    raise exception 'una derivación no se edita: solo se retira';
  end if;
  if new.retiro_motivo is null then
    raise exception 'el retiro lleva motivo';
  end if;
  new.retirada_por := app.current_user_id();
  if new.retirada_por is null then
    raise exception 'un retiro se hace con una identidad';
  end if;
  new.retirada_at := now();
  return new;
end; $$;
--> statement-breakpoint

-- El renglón «Derivación» del historial de gestiones lo escribe la base, no el servicio: así nadie lo
-- inventa ni lo anula (security-engineer). Va con el nombre que esta administración le da al estudio.
create or replace function app.derivacion_despues_insert() returns trigger
  language plpgsql set search_path = public, app
as $$
declare
  v_nombre text;
begin
  select coalesce(ea.nombre, e.nombre) into v_nombre
    from estudio_juridico e
    join tenant_node n on n.id = new.barrio_id
    left join estudio_administracion ea on ea.estudio_id = e.id and ea.administracion_id = n.parent_id
   where e.id = new.estudio_id;
  insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, nota, fecha, derivacion_id, registrado_por)
  values (new.barrio_id, new.unidad_funcional_id, 'administracion', 'derivacion',
          left('Derivada a ' || coalesce(v_nombre, 'un estudio') || '. Foto del estado de cuenta guardada.', 500),
          current_date, new.id, new.derivada_por);
  return null;
end; $$;
--> statement-breakpoint

create table derivacion_foto (
  derivacion_id uuid primary key,
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  -- La deuda mes por mes al momento de derivar: `{ fecha, meses: [{ periodo, vencimiento, vencido,
  -- capital, interes }], capital, capitalVencido, interes, total }`. La calcula `deudaALaFecha`; acá no
  -- se recalcula nada. Sin datos personales: solo esas claves (security-engineer).
  foto jsonb not null,
  created_at timestamptz not null default now(),
  constraint fk_derivacion_foto foreign key (derivacion_id, barrio_id) references derivacion (id, barrio_id) on delete restrict,
  constraint derivacion_foto_forma_chk check (
    jsonb_typeof(foto) = 'object' and jsonb_typeof(foto -> 'meses') = 'array'
    and (foto - array['fecha', 'meses', 'capital', 'capitalVencido', 'interes', 'total']) = '{}'::jsonb)
);
--> statement-breakpoint
create index idx_derivacion_foto_barrio on derivacion_foto (barrio_id);
--> statement-breakpoint

create or replace function app.derivacion_foto_antes_insert() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  new.created_at := now();
  return new;
end; $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 6. Gestiones (portado de Aclade 0014: 241-421).
--
-- Diferencias con el original, por el modelo de acá:
--   · `obra_id`/`uf_id` → `barrio_id`/`unidad_funcional_id`; la FK compuesta es la del padrón.
--   · `autor_tipo`: la administración o el estudio. Una gestión del estudio lleva su `estudio_id`.
--   · El canal suma `carta_documento` y `derivacion` (la que deja la derivación en el historial).
--   · El resultado suma `intimacion_entregada` y `enviada`. Con canal `derivacion` no hay resultado.
--   · `promesa_monto` en `numeric(14,2)`, como todo el dinero de este repo (Aclade usa centavos).
--   · Adjunto opcional, guardado en el almacenamiento (clave + sha256 + nombre + tipo): obligatorio
--     para la carta documento y la nota firmada (canal `nota`). La clave va atada al prefijo del barrio,
--     como los comprobantes de pago (`0032`).
--   · `fecha` y `registrado_at` las fija la base (Aclade: `app.hoy()`), y el renglón `derivacion` lo
--     escribe solo el trigger de `derivacion`.
--   · Los permisos van por RLS (`has_role_on`) y no por `app.puede`; la validación de la promesa contra
--     el plazo y el doble clic quedan en el servicio (E-a2), como en el diálogo de Aclade.
-- ---------------------------------------------------------------------------------------------
create table gestion (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  unidad_funcional_id uuid not null,
  autor_tipo text not null,
  estudio_id uuid references estudio_juridico (id) on delete restrict,
  canal text not null,
  resultado text,
  nota text,
  -- El día del alta en la hora del barrio: desde ahí cuenta lo pagado para una promesa.
  fecha date not null,
  promesa_fecha date,
  promesa_monto numeric(14, 2),
  adjunto_clave text,
  adjunto_sha256 text,
  adjunto_nombre text,
  adjunto_tipo text,
  derivacion_id uuid,
  registrado_por uuid not null,
  registrado_at timestamptz not null default clock_timestamp(),
  constraint fk_gestion_unidad foreign key (unidad_funcional_id, barrio_id)
    references unidad_funcional (id, barrio_id) on delete restrict,
  constraint fk_gestion_derivacion foreign key (derivacion_id, unidad_funcional_id, barrio_id)
    references derivacion (id, unidad_funcional_id, barrio_id) on delete restrict,
  constraint uq_gestion_id_barrio unique (id, barrio_id),
  constraint gestion_autor_chk check (autor_tipo in ('administracion', 'estudio')),
  constraint gestion_estudio_chk check ((autor_tipo = 'estudio') = (estudio_id is not null)),
  constraint gestion_canal_chk check (canal in ('llamada', 'whatsapp', 'mail', 'visita', 'nota', 'carta_documento', 'derivacion')),
  constraint gestion_resultado_chk check (resultado is null or resultado in
    ('contactado', 'no_contesta', 'dato_equivocado', 'promesa_de_pago', 'se_niega', 'intimacion_entregada', 'enviada', 'otro')),
  constraint gestion_resultado_canal_chk check ((canal = 'derivacion') = (resultado is null)),
  constraint gestion_derivacion_chk check ((canal = 'derivacion') = (derivacion_id is not null)),
  constraint gestion_nota_chk check (nota is null or (length(nota) between 1 and 500 and nota = btrim(nota))),
  constraint gestion_fecha_chk check (fecha between '2000-01-01' and '2200-12-31'),
  constraint gestion_promesa_fecha_chk check (promesa_fecha is null or promesa_fecha <= '2200-12-31'),
  constraint gestion_promesa_monto_chk check (promesa_monto is null or promesa_monto > 0),
  -- `is not distinct from`: con canal `derivacion` el resultado es null y tampoco puede haber promesa (dba-data).
  constraint gestion_promesa_chk check ((resultado is not distinct from 'promesa_de_pago') = (promesa_fecha is not null)),
  constraint gestion_promesa_par_chk check ((promesa_fecha is null) = (promesa_monto is null)),
  constraint gestion_promesa_orden_chk check (promesa_fecha is null or promesa_fecha >= fecha),
  constraint gestion_otro_chk check (resultado is distinct from 'otro' or nota is not null),
  constraint gestion_adjunto_par_chk check (
    (adjunto_clave is null and adjunto_sha256 is null and adjunto_nombre is null and adjunto_tipo is null)
    or (adjunto_clave is not null and adjunto_sha256 is not null and adjunto_nombre is not null and adjunto_tipo is not null)),
  constraint gestion_adjunto_sha_chk check (adjunto_sha256 is null or adjunto_sha256 ~ '^[0-9a-f]{64}$'),
  constraint gestion_adjunto_clave_chk check (adjunto_clave is null or adjunto_clave ~
    ('^barrios/' || barrio_id::text || '/gestiones/[A-Za-z0-9_-]{22,64}\.(pdf|jpg|jpeg|png)$')),
  constraint gestion_adjunto_fehaciente_chk check (canal not in ('carta_documento', 'nota') or adjunto_clave is not null)
);
--> statement-breakpoint
create index idx_gestion_unidad on gestion (unidad_funcional_id, registrado_at desc);
--> statement-breakpoint
create index idx_gestion_barrio on gestion (barrio_id, registrado_at desc);
--> statement-breakpoint
create index idx_gestion_promesas on gestion (barrio_id, promesa_fecha) where promesa_fecha is not null;
--> statement-breakpoint
create index idx_gestion_derivacion on gestion (derivacion_id) where derivacion_id is not null;
--> statement-breakpoint

create table gestion_anulacion (
  gestion_id uuid primary key,
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  autor_tipo text not null,
  motivo text not null,
  anulada_por uuid not null,
  anulada_at timestamptz not null default clock_timestamp(),
  constraint fk_gestion_anulacion foreign key (gestion_id, barrio_id) references gestion (id, barrio_id) on delete restrict,
  constraint gestion_anulacion_autor_chk check (autor_tipo in ('administracion', 'estudio')),
  constraint gestion_anulacion_motivo_chk check (length(motivo) between 1 and 300 and motivo = btrim(motivo))
);
--> statement-breakpoint
create index idx_gestion_anulacion_barrio on gestion_anulacion (barrio_id);
--> statement-breakpoint

-- Solo se agregan filas (Aclade `public.solo_agregar`).
create or replace function app.mora_solo_agregar() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  raise exception 'las gestiones no se editan ni se borran: una cargada por error se anula con motivo';
end; $$;
--> statement-breakpoint

create or replace function app.gestion_antes_insert() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  -- El renglón «Derivación» solo lo escribe `app.derivacion_despues_insert()` (anidado: profundidad 2).
  if new.canal = 'derivacion' and pg_trigger_depth() < 2 then
    raise exception 'el renglón de una derivación lo escribe la derivación';
  end if;
  new.registrado_por := app.current_user_id();
  if new.registrado_por is null then
    raise exception 'una gestión se registra con una identidad';
  end if;
  new.registrado_at := clock_timestamp();
  -- El día del alta, en la hora del barrio (Aclade `app.hoy()`): desde ahí cuenta lo pagado para una
  -- promesa, así que no lo elige quien la carga.
  select (now() at time zone b.zona_horaria)::date into new.fecha from barrio b where b.barrio_id = new.barrio_id;
  if new.fecha is null then
    raise exception 'el barrio de la gestión no existe';
  end if;
  -- Una gestión del estudio es de un estudio que trabaja en ese barrio.
  if new.autor_tipo = 'estudio' and not exists (
    select 1 from estudio_barrio eb where eb.estudio_id = new.estudio_id and eb.barrio_id = new.barrio_id
  ) then
    raise exception 'el estudio no trabaja en este barrio';
  end if;
  return new;
end; $$;
--> statement-breakpoint

-- Cada parte anula solo las suyas, y una sola vez (la PK lo asegura).
create or replace function app.gestion_anulacion_antes_insert() returns trigger
  language plpgsql set search_path = public, app
as $$
declare
  v_autor text;
begin
  select g.autor_tipo into v_autor from gestion g where g.id = new.gestion_id and g.barrio_id = new.barrio_id;
  if v_autor is null then
    raise exception 'la anulación no es del barrio de la gestión';
  end if;
  if v_autor <> new.autor_tipo then
    raise exception 'cada parte anula solo sus gestiones';
  end if;
  if exists (select 1 from gestion g where g.id = new.gestion_id and g.canal = 'derivacion') then
    raise exception 'el renglón de una derivación no se anula: la derivación se retira';
  end if;
  new.anulada_por := app.current_user_id();
  if new.anulada_por is null then
    raise exception 'una anulación se registra con una identidad';
  end if;
  new.anulada_at := clock_timestamp();
  return new;
end; $$;
--> statement-breakpoint

-- La foto de una derivación tampoco se toca.
create or replace function app.derivacion_foto_solo_agregar() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  raise exception 'la foto de una derivación no se edita ni se borra';
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 7. Triggers.
-- ---------------------------------------------------------------------------------------------
create trigger trg_estudio_juridico_antes_insert before insert on estudio_juridico
  for each row execute function app.estudio_juridico_antes_insert();
--> statement-breakpoint
create trigger trg_estudio_administracion_antes before insert or update or delete on estudio_administracion
  for each row execute function app.estudio_administracion_antes();
--> statement-breakpoint
create trigger trg_estudio_barrio_antes before insert or update or delete on estudio_barrio
  for each row execute function app.estudio_barrio_antes();
--> statement-breakpoint
create trigger trg_mora_criterio_administracion_antes before insert or update on mora_criterio_administracion
  for each row execute function app.mora_criterio_antes();
--> statement-breakpoint
create trigger trg_mora_barrio_antes before insert or update on mora_barrio
  for each row execute function app.mora_criterio_antes();
--> statement-breakpoint
create trigger trg_derivacion_antes before insert or update or delete on derivacion
  for each row execute function app.derivacion_antes();
--> statement-breakpoint
create trigger trg_derivacion_despues_insert after insert on derivacion
  for each row execute function app.derivacion_despues_insert();
--> statement-breakpoint
create trigger trg_derivacion_foto_antes_insert before insert on derivacion_foto
  for each row execute function app.derivacion_foto_antes_insert();
--> statement-breakpoint
create trigger trg_derivacion_foto_solo_agregar before update or delete on derivacion_foto
  for each row execute function app.derivacion_foto_solo_agregar();
--> statement-breakpoint
create trigger trg_derivacion_foto_sin_truncate before truncate on derivacion_foto
  for each statement execute function app.derivacion_foto_solo_agregar();
--> statement-breakpoint
create trigger trg_gestion_antes_insert before insert on gestion
  for each row execute function app.gestion_antes_insert();
--> statement-breakpoint
create trigger trg_gestion_solo_agregar before update or delete on gestion
  for each row execute function app.mora_solo_agregar();
--> statement-breakpoint
create trigger trg_gestion_sin_truncate before truncate on gestion
  for each statement execute function app.mora_solo_agregar();
--> statement-breakpoint
create trigger trg_gestion_anulacion_antes_insert before insert on gestion_anulacion
  for each row execute function app.gestion_anulacion_antes_insert();
--> statement-breakpoint
create trigger trg_gestion_anulacion_solo_agregar before update or delete on gestion_anulacion
  for each row execute function app.mora_solo_agregar();
--> statement-breakpoint
create trigger trg_gestion_anulacion_sin_truncate before truncate on gestion_anulacion
  for each statement execute function app.mora_solo_agregar();
--> statement-breakpoint

do $bloque$
declare
  f text;
begin
  foreach f in array array['estudio_juridico_antes_insert', 'estudio_administracion_antes', 'estudio_barrio_antes', 'mora_criterio_antes',
                           'derivacion_antes', 'derivacion_despues_insert', 'derivacion_foto_antes_insert', 'derivacion_foto_solo_agregar',
                           'gestion_antes_insert', 'mora_solo_agregar', 'gestion_anulacion_antes_insert'] loop
    execute format('revoke execute on function app.%I() from public', f);
    execute format('grant execute on function app.%I() to app_request, app_job', f);
  end loop;
end
$bloque$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 8. Las administraciones que el usuario ADMINISTRA, y buscar un estudio para vincularlo.
-- ---------------------------------------------------------------------------------------------

-- Admin (plataforma o administración) en el nodo de la administración o arriba. Por conjunto y sin
-- llamar a `has_role_on` por cada administración de la plataforma (dba-data): la misma forma que
-- `app.readable_tenant_ids()` (`0018`).
create or replace function app.administraciones_administradas() returns setof uuid
  language sql stable security definer set search_path = public, app
as $$
  select distinct d.id
    from membership m
    join tenant_node n on n.id = m.tenant_node_id
    join tenant_node d on d.path = n.path or d.path like n.path || '.%'
   where m.user_id = app.current_user_id()
     and m.activo
     and m.rol = any (array['admin_plataforma', 'admin_barrio']::app.rol_membership[])
     and n.deleted_at is null
     and d.deleted_at is null
     and d.tipo = 'administrador';
$$;
--> statement-breakpoint
revoke execute on function app.administraciones_administradas() from public;
--> statement-breakpoint
grant execute on function app.administraciones_administradas() to app_request, app_job;
--> statement-breakpoint

-- Cada búsqueda queda registrada: quién, cuándo, el sha256 del dato (no el dato) y si encontró. Es la
-- única excepción al aislamiento entre administraciones, y deja rastro (security-engineer).
create table estudio_busqueda (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null,
  dato_sha256 text not null,
  encontrado boolean not null,
  buscada_at timestamptz not null default now(),
  constraint estudio_busqueda_sha_chk check (dato_sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
create index idx_estudio_busqueda_usuario on estudio_busqueda (usuario_id, buscada_at desc);
--> statement-breakpoint
alter table estudio_busqueda enable row level security;
--> statement-breakpoint
alter table estudio_busqueda force row level security;
--> statement-breakpoint
-- Sin políticas para `app_request`: solo la escribe la función de abajo y la lee el job/auditoría.
grant select on table estudio_busqueda to app_job;
--> statement-breakpoint

-- Un estudio que ya trabaja con otra administración no es visible por RLS (todavía no hay vínculo).
-- Esta función es la única puerta: devuelve **solo el id y el nombre de la cuenta**, y **solo si
-- coincide exacto** el CUIT (11 dígitos) o el correo de avisos de un vínculo ACTIVO (sin mayúsculas).
-- Nada parcial, nada de la otra administración (ni con quién trabaja, ni su correo, ni su teléfono).
-- Solo pregunta quien administra una administración (y por lo tanto puede vincular).
create or replace function app.buscar_estudio_exacto(p_dato text)
  returns table (id uuid, nombre text)
  language plpgsql volatile security definer set search_path = public, app
as $$
declare
  v_dato text := lower(btrim(coalesce(p_dato, '')));
  v_cuit text := regexp_replace(v_dato, '[\s-]', '', 'g');
  v_n int;
begin
  if not exists (select 1 from app.administraciones_administradas()) then
    return;
  end if;
  if v_cuit ~ '^\d{11}$' then
    return query select e.id, e.nombre from estudio_juridico e where e.cuit = v_cuit;
  elsif v_dato ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return query select distinct e.id, e.nombre
      from estudio_juridico e join estudio_administracion ea on ea.estudio_id = e.id
     where ea.correo_avisos = v_dato and ea.activo;
  end if;
  get diagnostics v_n = row_count;
  insert into estudio_busqueda (usuario_id, dato_sha256, encontrado)
  values (app.current_user_id(), encode(sha256(convert_to(v_dato, 'UTF8')), 'hex'), v_n > 0);
end; $$;
--> statement-breakpoint
revoke execute on function app.buscar_estudio_exacto(text) from public;
--> statement-breakpoint
grant execute on function app.buscar_estudio_exacto(text) to app_request;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 9. RLS.
-- ---------------------------------------------------------------------------------------------
do $bloque$
declare
  t text;
begin
  foreach t in array array['estudio_juridico', 'estudio_administracion', 'estudio_barrio', 'mora_criterio_administracion',
                           'mora_barrio', 'derivacion', 'derivacion_foto', 'gestion', 'gestion_anulacion'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end
$bloque$;
--> statement-breakpoint

-- El estudio: lo ve quien ve alguna administración vinculada con él. Lo crea un administrador (la
-- fila sin vínculo no la ve nadie: el servicio crea las dos en la misma transacción).
-- `estudio_administracion` ya está bajo RLS: alcanza con que se vea algún vínculo (dba-data).
create policy estudio_juridico_sel on estudio_juridico for select using (
  exists (select 1 from estudio_administracion ea where ea.estudio_id = estudio_juridico.id));
--> statement-breakpoint
create policy estudio_juridico_ins on estudio_juridico for insert
  with check (exists (select 1 from app.administraciones_administradas()));
--> statement-breakpoint
-- Sin política de UPDATE: ninguna administración edita la cuenta del estudio.

create policy estudio_administracion_sel on estudio_administracion for select
  using (administracion_id in (select app.readable_tenant_ids()) or administracion_id in (select app.readable_admin_ancestros()));
--> statement-breakpoint
create policy estudio_administracion_ins on estudio_administracion for insert
  with check (administracion_id in (select app.administraciones_administradas()));
--> statement-breakpoint
create policy estudio_administracion_upd on estudio_administracion for update
  using (administracion_id in (select app.administraciones_administradas()))
  with check (administracion_id in (select app.administraciones_administradas()));
--> statement-breakpoint

create policy estudio_barrio_sel on estudio_barrio for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy estudio_barrio_ins on estudio_barrio for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
create policy estudio_barrio_upd on estudio_barrio for update
  using (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]))
  with check (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
create policy estudio_barrio_del on estudio_barrio for delete
  using (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]));
--> statement-breakpoint

create policy mora_criterio_administracion_sel on mora_criterio_administracion for select
  using (administracion_id in (select app.readable_tenant_ids()) or administracion_id in (select app.readable_admin_ancestros()));
--> statement-breakpoint
create policy mora_criterio_administracion_ins on mora_criterio_administracion for insert
  with check (administracion_id in (select app.administraciones_administradas()));
--> statement-breakpoint
create policy mora_criterio_administracion_upd on mora_criterio_administracion for update
  using (administracion_id in (select app.administraciones_administradas()))
  with check (administracion_id in (select app.administraciones_administradas()));
--> statement-breakpoint

create policy mora_barrio_sel on mora_barrio for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy mora_barrio_ins on mora_barrio for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
create policy mora_barrio_upd on mora_barrio for update
  using (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]))
  with check (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]));
--> statement-breakpoint

-- Derivar y retirar es una decisión de la administración.
create policy derivacion_sel on derivacion for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy derivacion_ins on derivacion for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
create policy derivacion_upd on derivacion for update
  using (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]))
  with check (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
create policy derivacion_foto_sel on derivacion_foto for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy derivacion_foto_ins on derivacion_foto for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]));
--> statement-breakpoint

-- Las gestiones las registra también el operador (es quien llama y cobra).
create policy gestion_sel on gestion for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy gestion_ins on gestion for insert
  with check (autor_tipo = 'administracion'
              and app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio', 'operador']::app.rol_membership[]));
--> statement-breakpoint
create policy gestion_anulacion_sel on gestion_anulacion for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy gestion_anulacion_ins on gestion_anulacion for insert
  with check (autor_tipo = 'administracion'
              and app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio', 'operador']::app.rol_membership[]));
--> statement-breakpoint

grant select, insert on table estudio_juridico to app_request;
--> statement-breakpoint
grant select, insert on table estudio_administracion to app_request;
--> statement-breakpoint
grant update (nombre, correo_avisos, telefono_boleta, preferencia_aviso, activo) on table estudio_administracion to app_request;
--> statement-breakpoint
grant select, insert, delete on table estudio_barrio to app_request;
--> statement-breakpoint
grant update (por_defecto) on table estudio_barrio to app_request;
--> statement-breakpoint
grant select, insert on table mora_criterio_administracion, mora_barrio to app_request;
--> statement-breakpoint
grant update (meses, monto_minimo, pedir_intimacion, leyenda_boleta) on table mora_criterio_administracion to app_request;
--> statement-breakpoint
grant update (meses, monto_minimo, pedir_intimacion, leyenda_boleta) on table mora_barrio to app_request;
--> statement-breakpoint
grant select, insert on table derivacion to app_request;
--> statement-breakpoint
grant update (retiro_motivo, retiro_nota) on table derivacion to app_request;
--> statement-breakpoint
grant select, insert on table derivacion_foto, gestion, gestion_anulacion to app_request;
--> statement-breakpoint
grant select on table estudio_juridico, estudio_administracion, estudio_barrio, mora_criterio_administracion, mora_barrio,
  derivacion, derivacion_foto, gestion, gestion_anulacion to app_job;
