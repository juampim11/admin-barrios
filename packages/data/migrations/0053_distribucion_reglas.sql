-- =============================================================================================
-- 0053_distribucion_reglas — RLS, triggers y gates del módulo de Distribución.
--
-- La forma está en `0052`; acá está **quién puede escribir qué, y qué es imposible construir**.
--
-- Las tres piezas que sostienen el módulo, en orden de importancia:
--
--   1. **El par contacto↔documento se valida en la base** (§3). Es el control estructural del
--      aislamiento entre destinatarios: una fila que apunte a la boleta de otra unidad no se puede
--      persistir, y como el adjunto se resuelve leyendo esa misma fila, tampoco se puede enviar.
--   2. **El estado no dispara el envío** (§5). `distribuida` se sella cuando el recorrido terminó;
--      encolar la distribución es un acto explícito con su propio gate.
--   3. **La traza de `unidad_contacto`** (§6): el `operador` sigue pudiendo cargar contactos —es
--      trabajo legítimo de padrón— pero deja de poder hacerlo en silencio.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. Los tres tipos de trabajo nuevos.
--
-- **Cuesta un renglón, y ese es el punto.** `trabajo.tipo` es `text` + `CHECK` desde `0039`
-- justamente para esto: agregar valores no exige un `ALTER TYPE`, que el migrador de este repo no
-- tolera (aplica todas las migraciones pendientes en UNA transacción). Es el argumento **inverso**
-- al del ZIP en `0052`: allá ensanchar era caro porque `tipo_documento` es enum nativo y nadie había
-- pagado ese costo; acá el `0039` ya lo pagó.
--
-- **Son tres y no uno**, y el motivo es operativo: `MAX_INTENTOS_TRABAJO` y `estado = 'fallado'` son
-- **por fila**. Con un solo trabajo, un fallo al armar el ZIP quemaría un intento del envío, y
-- reintentarlo volvería a recorrer destinatarios. Separados, "reintentá el ZIP" no toca un email.
-- ---------------------------------------------------------------------------------------------
alter table trabajo drop constraint trabajo_tipo_chk;
--> statement-breakpoint

alter table trabajo add constraint trabajo_tipo_chk check (
  tipo in (
    'emitir_documentos_periodo',
    'emitir_recibo_pago',
    'emitir_informe_periodo',
    'armar_paquete_periodo',
    'distribuir_liquidaciones'
  )
);
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. `app.trabajo_antes_insert()` — se reescribe entera para los tres tipos nuevos.
--
-- **Las precondiciones viven acá y no en el servicio, y no es preferencia de capa.** El propio
-- `0027` lo dejó escrito sobre la regla del período emitido: *"si el control existiera únicamente
-- ahí, bastaba un `insert into trabajo (tipo, referencia_id) values (…)`"*. El rol de request puede
-- insertar en `trabajo` directo, así que un gate en TypeScript es un gate que la próxima ruta se
-- olvida (`security-engineer`, B-5).
--
-- El bloque nuevo va marcado `-- [0053]`; el resto es idéntico a `0039`.
-- ---------------------------------------------------------------------------------------------
create or replace function app.trabajo_antes_insert() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_barrio  uuid;
  v_estado  app.estado_periodo;
  v_boletas int;
  v_informes int;
  v_paquetes int;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un trabajo sin autor no se encola'
      using errcode = 'P0001';
  end if;

  if new.tipo in ('emitir_documentos_periodo', 'emitir_informe_periodo',      -- [0053]
                  'armar_paquete_periodo', 'distribuir_liquidaciones') then
    select barrio_id, estado into v_barrio, v_estado
      from periodo_expensa where id = new.referencia_id;
  elsif new.tipo = 'emitir_recibo_pago' then
    select barrio_id into v_barrio
      from pago where id = new.referencia_id and anulado_at is null;
  end if;

  if v_barrio is null then
    raise exception 'no se pudo derivar el barrio de la referencia: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  -- Los cuatro trabajos que salen de un período exigen que el período esté emitido: lo que se
  -- publica sale de lo que quedó emitido, no de un borrador que todavía puede cambiar.
  if new.tipo in ('emitir_documentos_periodo', 'emitir_informe_periodo',      -- [0053]
                  'armar_paquete_periodo', 'distribuir_liquidaciones')
     and v_estado not in ('emitida', 'distribuida') then
    raise exception 'el período no está emitido: los documentos salen de lo que quedó emitido'
      using errcode = 'P0001';
  end if;

  /*
   * [0053] **El gate de rol de la distribución, y por qué es más chico que el de emitir.**
   *
   * `operador` puede emitir documentos (`0027`): eso es interno y se queda en el storage. **Mandar
   * PII a cientos de casillas externas no es lo mismo y no hereda esa autorización**
   * (`security-engineer`, B-6). Mismo criterio con el que `0051` puso el gate de la exportación en
   * el `insert` de su traza: es el único lugar que no se puede saltear.
   */
  if new.tipo = 'distribuir_liquidaciones' then                               -- [0053]
    if not app.has_role_on(v_barrio, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
      raise exception 'no tenés permiso para distribuir: la distribución envía datos personales fuera del sistema'
        using errcode = 'P0001';
    end if;

    /*
     * **Las precondiciones materiales.** Distribuir sin boletas manda un email sin su adjunto
     * principal; sin paquete, el ZIP que la pantalla ofrece no existe. Se verifica acá y no en el
     * servicio por el mismo motivo que el gate de rol.
     */
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

  -- [0053] Armar el paquete exige que haya boletas: un ZIP vacío es un archivo que miente.
  if new.tipo = 'armar_paquete_periodo' then                                  -- [0053]
    select count(*) into v_boletas from documento_emitido
      where periodo_id = new.referencia_id and tipo = 'boleta_unidad';
    if v_boletas = 0 then
      raise exception 'el período no tiene boletas emitidas: no hay qué empaquetar'
        using errcode = 'P0001';
    end if;
  end if;

  -- [0053] Sin paquete previo no se distribuye: la pantalla ofrece el ZIP y el email en el mismo
  -- recorrido, y un envío sin paquete deja al administrador sin la copia que archiva.
  if new.tipo = 'distribuir_liquidaciones' then                               -- [0053]
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
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. El par contacto↔documento — **el control estructural del aislamiento** (B-1).
--
-- La unidad de trabajo del envío no es "un contacto" ni "un PDF": es una **fila que ya trae los
-- dos**, y este trigger es lo que garantiza que el par sea coherente. Deriva la unidad desde la
-- **liquidación del documento** —no desde lo que el llamador diga— y rechaza si no es la del
-- contacto.
--
-- Con eso, el modo de falla clásico de estos lotes —arrays paralelos de contactos y PDFs unidos por
-- índice, que un chunking desalinea— deja de ser posible: no hay arrays, y el adjunto se lee de la
-- fila ya validada.
-- ---------------------------------------------------------------------------------------------
create or replace function app.envio_antes_insert() returns trigger
  language plpgsql security invoker
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_unidad_doc uuid;
  v_barrio_doc uuid;
  v_unidad_contacto uuid;
  v_contacto_activo boolean;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un envío sin autor no se registra'
      using errcode = 'P0001';
  end if;

  -- La unidad SALE DEL DOCUMENTO, atravesando su liquidación. Es la única fuente que no depende de
  -- lo que el llamador arme.
  select l.unidad_funcional_id, d.barrio_id into v_unidad_doc, v_barrio_doc
    from documento_emitido d
    join liquidacion l on l.id = d.liquidacion_id
   where d.id = new.documento_id and d.tipo = 'boleta_unidad';

  if v_unidad_doc is null then
    raise exception 'el documento del envío no es una boleta de unidad accesible: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  select unidad_funcional_id, activo into v_unidad_contacto, v_contacto_activo
    from unidad_contacto where id = new.unidad_contacto_id;

  if v_unidad_contacto is null then
    raise exception 'el contacto del envío no existe o no es accesible'
      using errcode = 'P0001';
  end if;

  /*
   * **La comparación que impide la fuga.** Si el contacto es de otra unidad, la fila no entra — y
   * como el adjunto se resuelve leyendo `documento_id` de esta misma fila, el sobre con la boleta
   * de otro vecino no se puede armar ni por error de código ni por un lote mal construido.
   */
  if v_unidad_doc <> v_unidad_contacto then
    raise exception 'el contacto pertenece a otra unidad que el documento: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  if not v_contacto_activo then
    raise exception 'el contacto está dado de baja: no se le escribe'
      using errcode = 'P0001';
  end if;

  new.barrio_id           := v_barrio_doc;
  new.unidad_funcional_id := v_unidad_doc;
  new.solicitado_por      := v_usuario;
  new.encolado_at         := now();
  new.estado              := 'pendiente';
  new.intento             := 0;
  new.aceptado_at         := null;
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_envio_antes_insert before insert on envio_liquidacion
  for each row execute function app.envio_antes_insert();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. La identidad del paquete.
-- ---------------------------------------------------------------------------------------------
create or replace function app.paquete_antes_insert() returns trigger
  language plpgsql security invoker
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_barrio uuid;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un paquete sin autor no se registra'
      using errcode = 'P0001';
  end if;

  select barrio_id into v_barrio from periodo_expensa where id = new.periodo_id;
  if v_barrio is null then
    raise exception 'no se pudo derivar el barrio del período: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  new.barrio_id  := v_barrio;
  new.armado_por := v_usuario;
  new.armado_at  := now();
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_paquete_antes_insert before insert on paquete_distribucion
  for each row execute function app.paquete_antes_insert();
--> statement-breakpoint

-- Append-only: un paquete emitido no se edita ni se borra. `app.solo_append()` existe desde `0016`.
create trigger trg_paquete_append before update or delete on paquete_distribucion
  for each row execute function app.solo_append();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 5. `distribuida_por`, y el congelamiento de la firma de distribución.
--
-- Dos arreglos que van juntos porque de a uno no sirven:
--
--   a. `app.periodo_transicion()` escribe la firma (antes solo sellaba la fecha).
--   b. `app.periodo_emitido_inmutable()` la congela. Sin esto, `distribuida_at` era reescribible por
--      un `update` posterior: "terminal" lo era en la transición, **no en la fila**
--      (`security-engineer`, B-6).
--
-- ⚠ **El orden de los triggers importa y ya está resuelto por sus nombres.** Postgres los corre
-- alfabéticamente: `trg_periodo_emitido_inmutable` < `trg_periodo_transicion`, o sea que el
-- congelamiento corre PRIMERO y ve la fila sin la firma nueva — que es lo que permite que la
-- transición la escriba. Es la misma dependencia que `0030` documentó para `emitida_por`. **No se
-- renombra ninguno de los dos.**
-- ---------------------------------------------------------------------------------------------
create or replace function app.periodo_transicion() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare v_usuario uuid;
begin
  if new.estado = old.estado then
    return new;
  end if;

  if not (
       (old.estado = 'borrador'  and new.estado in ('revisada', 'emitida'))
    or (old.estado = 'revisada'  and new.estado in ('borrador', 'emitida'))
    or (old.estado = 'emitida'   and new.estado = 'distribuida')
  ) then
    raise exception 'transición de estado inválida: % → %', old.estado, new.estado;
  end if;

  if new.estado = 'emitida' then
    perform app.validar_emision(new.id);

    v_usuario := app.current_user_id();
    if v_usuario is null then
      raise exception 'no hay usuario en la sesión: emitir un período requiere identidad';
    end if;

    new.emitida_at := now();
    new.emitida_por := v_usuario;
    new.total_gastos := (select coalesce(sum(monto), 0) from gasto_periodo where periodo_id = new.id);
  elsif new.estado = 'distribuida' then
    -- [0053] La firma, que antes no existía. Distribuir manda PII a cientos de casillas externas:
    -- es tanto o más imputable que emitir, que sí la tenía.
    v_usuario := app.current_user_id();
    if v_usuario is null then
      raise exception 'no hay usuario en la sesión: distribuir un período requiere identidad';
    end if;

    new.distribuida_at := now();
    new.distribuida_por := v_usuario;
  end if;

  return new;
end; $$;
--> statement-breakpoint

-- El congelamiento: se agrega la guarda de la firma de distribución a la función de `0030`. El
-- resto del cuerpo no cambia, así que se parchea solo ese bloque agregando una condición más.
create or replace function app.periodo_emitido_inmutable() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if old.estado not in ('emitida', 'distribuida')
     and new.estado not in ('emitida', 'distribuida') then
    return new;
  end if;

  /*
   * La guarda del MODELO va primera, y es la que más importa de todas: sin ella,
   *
   *     update periodo_expensa set estado = 'emitida', modelo = 'fija' where id = $1;
   *
   * emite validando un modelo y deja escrito el otro — `app.validar_emision()` corre en un `before`
   * y lee la fila vieja. El motivo completo está en el docstring de `0030`, que no se repite acá.
   *
   * `is distinct from` y no `<>`: con un `null` de por medio, `<>` da `null` y el `if` no entra, o
   * sea que poner en `null` una versión ya fijada pasaría de largo.
   */
  if new.modelo is distinct from old.modelo then
    raise exception
      'el modelo de un período % no se puede cambiar (era %, se intentó %)',
      old.estado, old.modelo, new.modelo
      using errcode = '23514';
  end if;

  if new.periodo is distinct from old.periodo then
    raise exception 'el mes de un período % no se puede cambiar', old.estado using errcode = '23514';
  end if;

  if new.barrio_id is distinct from old.barrio_id then
    raise exception 'un período % no se puede mover de barrio', old.estado using errcode = '23514';
  end if;

  if new.coeficiente_version_id is distinct from old.coeficiente_version_id then
    raise exception 'la versión de coeficientes de un período % no se puede cambiar', old.estado
      using errcode = '23514';
  end if;

  if new.cuota_fija_version_id is distinct from old.cuota_fija_version_id then
    raise exception 'la versión de valor fijo de un período % no se puede cambiar', old.estado
      using errcode = '23514';
  end if;

  if new.denominacion_concepto is distinct from old.denominacion_concepto then
    raise exception
      'la denominación impresa de un período % no se puede cambiar (era %)', old.estado,
      coalesce(old.denominacion_concepto, '(sin declarar)')
      using errcode = '23514';
  end if;

  if new.emitida_at is distinct from old.emitida_at
     or new.emitida_por is distinct from old.emitida_por then
    raise exception 'la firma de emisión de un período % no se puede cambiar', old.estado
      using errcode = '23514';
  end if;

  /*
   * [0053] La firma de DISTRIBUCIÓN, que quedaba afuera. `old.distribuida_at is not null` acota la
   * guarda a la fila que ya la tiene: mientras es `null`, `app.periodo_transicion()` puede
   * escribirla (corre después, por orden alfabético del nombre del trigger). Una vez sellada, no se
   * reescribe.
   */
  if old.distribuida_at is not null
     and (new.distribuida_at is distinct from old.distribuida_at
          or new.distribuida_por is distinct from old.distribuida_por) then
    raise exception 'la firma de distribución de un período no se puede cambiar'
      using errcode = '23514';
  end if;

  return new;
end;
$$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 6. La traza de `unidad_contacto` — B-2.
--
-- El `operador` **sigue pudiendo** cargar y editar contactos: es trabajo legítimo de padrón, y
-- quitárselo rompería la operatoria real para tapar un problema de auditoría. Lo que cambia es que
-- ya no puede hacerlo en silencio.
--
-- `security invoker` y no definer: la identidad sale de la sesión, y la RLS de la tabla sigue
-- decidiendo qué filas se pueden tocar.
-- ---------------------------------------------------------------------------------------------
create or replace function app.unidad_contacto_traza() returns trigger
  language plpgsql security invoker
  set search_path = public, app
as $$
declare v_usuario uuid := app.current_user_id();
begin
  /*
   * **No exige identidad, la registra si la hay** — y la diferencia importa.
   *
   * El vector de B-2 es un `operador` escribiendo por `app_request`, y ahí `conUsuario()` **siempre**
   * pone identidad: la traza queda completa justo en el caso que este trigger existe para cubrir.
   * Un `null` solo puede venir de la conexión de administración —siembra de fixtures, un script de
   * migración, soporte—, que no es el vector y que además ya está fuera de la RLS.
   *
   * Exigirla habría obligado a que cada fixture que carga un contacto se siembre con los triggers
   * apagados, y eso es peor: acostumbra a apagarlos, que es lo que después esconde un problema real.
   */
  if tg_op = 'INSERT' then
    new.creado_por := v_usuario;
    new.modificado_por := null;
    new.actualizado_at := null;
  else
    -- El alta no se puede reescribir: quién creó el contacto es un hecho.
    new.creado_por := old.creado_por;
    new.modificado_por := v_usuario;
    new.actualizado_at := now();
  end if;

  return new;
end; $$;
--> statement-breakpoint

create trigger trg_unidad_contacto_traza before insert or update on unidad_contacto
  for each row execute function app.unidad_contacto_traza();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 7. RLS de las tres tablas nuevas.
--
-- **Lectura por `readable_tenant_ids()` MÁS el rol**, nunca solo por rol: esa función es la
-- definición única de "sobre qué barrios ve datos este usuario", y una policy que la saltea deja de
-- heredar lo que aprenda después. El gate de rol va encima.
-- ---------------------------------------------------------------------------------------------
alter table paquete_distribucion enable row level security;
--> statement-breakpoint
alter table paquete_distribucion force row level security;
--> statement-breakpoint

/*
 * **El paquete es el artefacto más concentrado que este sistema produce**: N boletas con titular,
 * unidad e importe en un solo objeto. `documento_emitido_sel` (`0027`) ya decidió que un agregado
 * del barrio entero es distinto de sus filas, y cerró el listado de saldos incluso para `contador` y
 * `auditor`. Este es estrictamente mayor que ese listado, así que hereda el gate más chico:
 * administración y nadie más. `contador` recibe el libro de movimientos, no el paquete de boletas.
 */
create policy paquete_distribucion_sel on paquete_distribucion for select
  using (
    barrio_id in (select app.readable_tenant_ids())
    and app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[])
  );
--> statement-breakpoint

create policy paquete_distribucion_ins on paquete_distribucion for insert
  with check (
    barrio_id in (select app.readable_tenant_ids())
    and app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[])
  );
--> statement-breakpoint

grant select, insert on table paquete_distribucion to app_request;
--> statement-breakpoint
grant select on table paquete_distribucion to app_job;
--> statement-breakpoint

alter table paquete_distribucion_item enable row level security;
--> statement-breakpoint
alter table paquete_distribucion_item force row level security;
--> statement-breakpoint

-- La hija hereda la visibilidad del paquete: sin `barrio_id` propio, la RLS se apoya en el padre.
create policy paquete_item_sel on paquete_distribucion_item for select
  using (exists (select 1 from paquete_distribucion p where p.id = paquete_id));
--> statement-breakpoint

create policy paquete_item_ins on paquete_distribucion_item for insert
  with check (exists (select 1 from paquete_distribucion p where p.id = paquete_id));
--> statement-breakpoint

grant select, insert on table paquete_distribucion_item to app_request;
--> statement-breakpoint
grant select on table paquete_distribucion_item to app_job;
--> statement-breakpoint

alter table envio_liquidacion enable row level security;
--> statement-breakpoint
alter table envio_liquidacion force row level security;
--> statement-breakpoint

-- Leer el registro de envíos es función de administración: dice a qué casilla se le escribió a cada
-- vecino. Mismo conjunto que el paquete.
create policy envio_liquidacion_sel on envio_liquidacion for select
  using (
    barrio_id in (select app.readable_tenant_ids())
    and app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[])
  );
--> statement-breakpoint

create policy envio_liquidacion_ins on envio_liquidacion for insert
  with check (
    barrio_id in (select app.readable_tenant_ids())
    and app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[])
  );
--> statement-breakpoint

/*
 * **`update` habilitado, a diferencia de las otras tablas de traza del repo.** No es una excepción
 * caprichosa: el ciclo de vida del envío ES la secuencia de estados —`pendiente → enviando →
 * aceptado|fallado`—, y el claim atómico que impide el doble envío se hace justamente con un
 * `update` condicional. Lo que no se puede es borrar ni reescribir la identidad, que el trigger fija
 * en el `insert`.
 */
create policy envio_liquidacion_upd on envio_liquidacion for update
  using (
    barrio_id in (select app.readable_tenant_ids())
    and app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[])
  )
  with check (
    barrio_id in (select app.readable_tenant_ids())
    and app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[])
  );
--> statement-breakpoint

grant select, insert, update on table envio_liquidacion to app_request;
--> statement-breakpoint
grant select on table envio_liquidacion to app_job;
--> statement-breakpoint

comment on policy paquete_distribucion_sel on paquete_distribucion is
  'Gate más chico que el de documento_emitido: el paquete contiene TODAS las boletas del período en '
  'un objeto. Es estrictamente mayor que el listado de saldos pendientes, que 0027 ya cerró para '
  'contador y auditor.';
