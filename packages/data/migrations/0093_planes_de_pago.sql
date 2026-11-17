-- =============================================================================================
-- 0093 · Planes de pago: el motor (encargo P1, BL-051). La aplica el titular.
--
-- Qué hace, en una frase: un plan saca de la deuda las liquidaciones vencidas que se eligen (con su
-- capital y su mora hasta la firma) y la vuelve a poner como cuotas, que se emiten de a una con el
-- mes en que vencen. **Nada recalcula hacia atrás y nada se cuenta dos veces.**
--
--   · La firma (`app.plan_firmar`) imputa a esas liquidaciones un PAGO NO MONETARIO de origen `plan`
--     (el precedente es el saldo a favor de la activación, `0086`): la deuda incluida queda cubierta,
--     sus tramos de interés quedan cerrados a la fecha de firma y dejan de correr.
--   · Cada cuota se emite como una LIQUIDACIÓN de un período de origen `plan`, con vencimiento
--     propio, junto con la emisión del mes en que vence (`app.plan_emitir_cuotas`), nunca antes.
--   · La cuota impaga devenga mora sobre su capital (la amortización), nunca sobre el interés de
--     financiación: `liquidacion.interes_financiacion` y `app.capitales_pendientes` (no hay interés
--     sobre interés).
--   · Al caer (`app.plan_caer_*`, orquestado por el servicio): se anula la firma (vuelve la deuda
--     original, con su quita), lo pagado de las cuotas se vuelve a imputar a la deuda, las cuotas
--     impagas se cancelan con otro pago no monetario y el interés que no corrió (de la firma a la
--     caída, sobre el capital que seguía impago) lo calcula el código de siempre.
--
-- Cambios sobre lo existente (ninguno borra datos):
--   · `periodo_expensa.origen` admite `plan`, y la unicidad (barrio, mes) es solo de lo que no es
--     plan (`uq_periodo_barrio`, ahora índice parcial: el mes de una cuota convive con su mes mensual).
--   · `liquidacion`: el vencimiento propio también es de las cuotas; columna `interes_financiacion`.
--   · `item_liquidacion`: la línea `plan_cuota`.
--   · `pago.origen` admite `plan` (solo lo escriben las funciones de esta migración).
--   · `app.validar_emision` (v8: un período de plan tiene su propia verificación),
--     `app.capitales_pendientes`/`app.capital_pendiente` (el capital de una cuota) y
--     `app.resolver_imputacion` (v3: la cuota del plan según el parámetro, sin `created_at`).
-- Regla del repo: una migración ya aplicada NO se edita; se agrega la siguiente con prefijo mayor.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. El período y la liquidación de una cuota
-- ---------------------------------------------------------------------------------------------
alter table periodo_expensa drop constraint periodo_origen_chk;
--> statement-breakpoint
alter table periodo_expensa add constraint periodo_origen_chk check (origen in ('mensual', 'historico', 'plan'));
--> statement-breakpoint
comment on column periodo_expensa.origen is
  'mensual: un mes que devenga el sistema. historico: deuda anterior a la activación. plan: una cuota de un plan de pagos, emitida con el mes en que vence (0093); no reparte gastos ni tiene boleta propia.';
--> statement-breakpoint
-- Un mes del barrio es uno solo, salvo los de las cuotas: cada cuota tiene su período (que se emite
-- solo), y convive con el mensual del mismo mes. Mismo nombre del índice: el catálogo de errores lo usa.
drop index uq_periodo_barrio;
--> statement-breakpoint
create unique index uq_periodo_barrio on periodo_expensa (barrio_id, periodo) where origen <> 'plan';
--> statement-breakpoint
create index idx_periodo_plan on periodo_expensa (barrio_id, periodo) where origen = 'plan';
--> statement-breakpoint

alter table liquidacion add column interes_financiacion numeric(14,2) not null default 0;
--> statement-breakpoint
alter table liquidacion add constraint liquidacion_interes_financiacion_chk check (interes_financiacion = 0 or (interes_financiacion > 0 and interes_financiacion <= total));
--> statement-breakpoint
comment on column liquidacion.interes_financiacion is
  'Solo en una cuota de plan de pagos (0093): la parte del total que es interés (de financiación, más la mora original que amortiza: plan_cuota.mora_incluida). La mora de la cuota corre sobre el resto (su capital): no hay interés sobre interés.';
--> statement-breakpoint

-- Quién escribe un período o una liquidación de plan: solo las funciones de esta migración (dueño
-- `app_job`), como la deuda anterior a la activación.
create or replace function app.periodo_historico_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if tg_op = 'DELETE' then
    if old.origen in ('historico', 'plan') and current_user::text <> 'app_job' then
      raise exception 'la deuda anterior y las cuotas de un plan no se borran a mano'
        using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and new.origen is distinct from old.origen then
    raise exception 'el origen de un período no se cambia' using errcode = '23514';
  end if;
  if new.origen = 'historico' then
    if current_user::text <> 'app_job' then
      raise exception 'la deuda anterior a la activación se carga con la planilla de deuda, no a mano'
        using errcode = '42501';
    end if;
    if tg_op = 'INSERT' and not exists (
        select 1 from barrio b
         where b.barrio_id = new.barrio_id and b.primer_periodo is not null and new.periodo < b.primer_periodo) then
      raise exception 'un período histórico es anterior al primer mes a devengar del barrio' using errcode = '23514';
    end if;
  end if;
  -- [0093] Las cuotas de un plan las emite el plan.
  if new.origen = 'plan' and current_user::text <> 'app_job' then
    raise exception 'las cuotas de un plan de pagos las emite el plan, no se cargan a mano' using errcode = '42501';
  end if;
  return new;
end; $$;
--> statement-breakpoint

create or replace function app.liquidacion_historica_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
declare v_origen text;
begin
  select origen into v_origen from periodo_expensa where id = new.periodo_id;
  -- [0093] El vencimiento propio es de la deuda anterior y de las cuotas de un plan.
  if (new.vencimiento is not null) is distinct from (v_origen in ('historico', 'plan')) then
    raise exception 'el vencimiento propio es de la deuda anterior a la activación y de las cuotas de un plan, y solo de ellas' using errcode = '23514';
  end if;
  if v_origen in ('historico', 'plan') and current_user::text <> 'app_job' then
    raise exception 'la deuda anterior y las cuotas de un plan no se cargan a mano' using errcode = '42501';
  end if;
  if new.interes_financiacion <> 0 and v_origen is distinct from 'plan' then
    raise exception 'el interés de financiación es de las cuotas de un plan' using errcode = '23514';
  end if;
  return new;
end; $$;
--> statement-breakpoint

alter table item_liquidacion drop constraint item_liquidacion_origen_chk;
--> statement-breakpoint
alter table item_liquidacion add constraint item_liquidacion_origen_chk check (
     (clase_item::text = 'prorrateo' and gasto_id is not null and coeficiente_aplicado is not null and aplicacion_id is null and tipo is not null and concepto_boleta_id is null)
  or (clase_item::text = 'cuota_fija' and gasto_id is null and coeficiente_aplicado is null and aplicacion_id is null and tipo is not null and concepto_boleta_id is null)
  or (clase_item::text in ('cargo', 'descuento') and gasto_id is null and coeficiente_aplicado is null and aplicacion_id is not null and tipo is null and concepto_boleta_id is null)
  or (clase_item::text = 'historico' and gasto_id is null and coeficiente_aplicado is null and aplicacion_id is null
      and num_nonnulls(concepto_id, concepto_boleta_id) = 1 and (tipo is not null) = (concepto_id is not null))
  -- [0093] La cuota de un plan: sin gasto, coeficiente, aplicación ni concepto.
  or (clase_item::text = 'plan_cuota' and gasto_id is null and coeficiente_aplicado is null and aplicacion_id is null
      and tipo is null and concepto_id is null and concepto_boleta_id is null)
);
--> statement-breakpoint

-- El pago no monetario de un plan: lo escriben solo las funciones de esta migración (dueño `app_job`).
alter table pago drop constraint pago_origen_chk;
--> statement-breakpoint
alter table pago add constraint pago_origen_chk check (origen in ('extracto', 'manual', 'activacion', 'plan'));
--> statement-breakpoint
alter table pago drop constraint pago_manual_exige_registrador_chk;
--> statement-breakpoint
alter table pago add constraint pago_manual_exige_registrador_chk check (
     (origen = 'manual' and usuario_registrador is not null and comprobante_adjunto is not null)
  or (origen = 'extracto' and usuario_registrador is null)
  or (origen in ('activacion', 'plan') and usuario_registrador is not null and comprobante_adjunto is null)
);
--> statement-breakpoint
create or replace function app.pago_de_plan_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if new.origen = 'plan' then
    if current_user::text <> 'app_job' then
      raise exception 'un pago de plan lo registra el plan (la firma o la caída), no se carga a mano' using errcode = '42501';
    end if;
    new.usuario_registrador := app.current_user_id();
  end if;
  return new;
end; $$;
--> statement-breakpoint
-- Corre después de `trg_pago_antes` (orden alfabético): `pago_antes` deja el registrador como vino
-- para lo que no es manual ni activación, y acá se fija.
create trigger trg_pago_zz_plan before insert on pago for each row execute function app.pago_de_plan_antes();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. Las tablas del plan
-- ---------------------------------------------------------------------------------------------

-- El catálogo: los planes estándar de una administración (pantalla 1 de la maqueta, en P2).
create table plan_catalogo (
  id uuid primary key default gen_random_uuid(),
  administracion_id uuid not null references tenant_node (id) on delete restrict,
  nombre text not null,
  sistema text not null,
  tasa_mensual numeric(9,6) not null default 0,
  cuotas_min smallint not null,
  cuotas_max smallint not null,
  anticipo text not null default 'no',
  anticipo_max_pct numeric(5,2),
  deuda_maxima numeric(14,2),
  estudio_id uuid references estudio_juridico (id) on delete restrict,
  modo_cobro text not null default 'barrio',
  activo boolean not null default true,
  creado_por uuid not null,
  created_at timestamptz not null default now(),
  constraint plan_catalogo_nombre_chk check (length(nombre) between 1 and 120 and nombre = btrim(nombre)),
  constraint plan_catalogo_sistema_chk check (sistema in ('fija', 'frances')),
  constraint plan_catalogo_tasa_chk check (tasa_mensual >= 0 and tasa_mensual <= 0.1 and (sistema = 'frances') = (tasa_mensual > 0)),
  constraint plan_catalogo_cuotas_chk check (cuotas_min between 1 and 60 and cuotas_max between cuotas_min and 60),
  constraint plan_catalogo_anticipo_chk check (anticipo in ('no', 'opcional', 'obligatorio')
    and (anticipo_max_pct is null or anticipo_max_pct between 0 and 100) and ((anticipo = 'no') = (anticipo_max_pct is null))),
  constraint plan_catalogo_deuda_chk check (deuda_maxima is null or deuda_maxima > 0),
  constraint plan_catalogo_modo_chk check (modo_cobro in ('barrio', 'estudio'))
);
--> statement-breakpoint
create index idx_plan_catalogo_admin on plan_catalogo (administracion_id);
--> statement-breakpoint
create table plan_catalogo_barrio (
  catalogo_id uuid not null references plan_catalogo (id) on delete restrict,
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  primary key (catalogo_id, barrio_id)
);
--> statement-breakpoint
create index idx_plan_catalogo_barrio_barrio on plan_catalogo_barrio (barrio_id);
--> statement-breakpoint

-- Los parámetros del barrio: con cuántas cuotas impagas se puede declarar caído y qué va primero
-- cuando un pago no dice a qué va.
create table plan_parametro_barrio (
  barrio_id uuid primary key references barrio (barrio_id) on delete restrict,
  cuotas_para_caer smallint not null default 2,
  orden_imputacion text not null default 'cuota_primero',
  cargado_por uuid not null,
  updated_at timestamptz not null default now(),
  constraint plan_parametro_cuotas_chk check (cuotas_para_caer between 1 and 12),
  constraint plan_parametro_orden_chk check (orden_imputacion in ('cuota_primero', 'expensa_primero'))
);
--> statement-breakpoint

create table plan_pago (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  unidad_funcional_id uuid not null,
  catalogo_id uuid references plan_catalogo (id) on delete restrict,
  tipo text not null,
  sistema text not null,
  tasa_mensual numeric(9,6) not null default 0,
  modo_cobro text not null default 'barrio',
  estudio_id uuid references estudio_juridico (id) on delete restrict,
  estado text not null default 'pendiente',
  motivo text,
  -- La deuda que entra (capital + interés de mora a la fecha de firma; antes de firmar, a la del alta).
  deuda_capital numeric(14,2) not null,
  deuda_interes numeric(14,2) not null,
  -- El cronograma: anticipo + cuotas. `total_cuotas` = suma de `plan_cuota.importe`.
  anticipo numeric(14,2) not null default 0,
  total_cuotas numeric(14,2) not null,
  interes_financiacion numeric(14,2) not null default 0,
  quita_interes numeric(14,2) not null default 0,
  quita_capital numeric(14,2) not null default 0,
  cantidad_cuotas smallint not null,
  fecha_firma date,
  pago_firma_id uuid,
  cargo_caida numeric(14,2),
  creado_por uuid not null,
  created_at timestamptz not null default now(),
  cerrado_at timestamptz,
  constraint fk_plan_pago_unidad foreign key (unidad_funcional_id, barrio_id) references unidad_funcional (id, barrio_id) on delete restrict,
  constraint uq_plan_pago_id_barrio unique (id, barrio_id),
  constraint fk_plan_pago_firma foreign key (pago_firma_id, barrio_id) references pago (id, barrio_id) on delete restrict,
  constraint plan_pago_tipo_chk check (tipo in ('catalogo', 'a_medida') and (tipo = 'catalogo') = (catalogo_id is not null)),
  constraint plan_pago_sistema_chk check (sistema in ('fija', 'frances', 'libre')
    and (tipo = 'a_medida') = (sistema = 'libre') and (sistema = 'frances') = (tasa_mensual > 0)),
  constraint plan_pago_modo_chk check (modo_cobro in ('barrio', 'estudio') and (modo_cobro = 'estudio') = (estudio_id is not null)),
  constraint plan_pago_estado_chk check (estado in ('pendiente', 'vigente', 'rechazado', 'retirado', 'cumplido', 'caido')),
  constraint plan_pago_motivo_chk check (motivo is null or (length(motivo) between 1 and 1000 and motivo = btrim(motivo))),
  constraint plan_pago_montos_chk check (deuda_capital >= 0 and deuda_interes >= 0 and deuda_capital + deuda_interes > 0
    and anticipo >= 0 and total_cuotas > 0 and interes_financiacion >= 0 and quita_interes >= 0 and quita_capital >= 0
    and quita_interes <= deuda_interes and quita_capital <= deuda_capital and cantidad_cuotas between 1 and 61),
  -- El cuadre: deuda + interés de financiación = cronograma + lo que se perdona.
  constraint plan_pago_cuadre_chk check (deuda_capital + deuda_interes + interes_financiacion = total_cuotas + quita_interes + quita_capital),
  -- El perdón va primero al interés: no hay quita de capital con interés sin perdonar.
  constraint plan_pago_perdon_chk check (quita_capital = 0 or quita_interes = deuda_interes),
  -- Un plan con quita es a medida.
  constraint plan_pago_quita_tipo_chk check (tipo = 'a_medida' or (quita_interes = 0 and quita_capital = 0)),
  constraint plan_pago_firma_chk check ((estado in ('vigente', 'cumplido', 'caido')) = (fecha_firma is not null and pago_firma_id is not null)),
  constraint plan_pago_caida_chk check ((estado = 'caido') = (cargo_caida is not null))
);
--> statement-breakpoint
-- Un solo plan vigente por unidad.
create unique index uq_plan_pago_vigente on plan_pago (unidad_funcional_id) where estado = 'vigente';
--> statement-breakpoint
-- La ficha y la lista de planes de una unidad, en cualquier estado.
create index idx_plan_pago_unidad on plan_pago (barrio_id, unidad_funcional_id, estado);
--> statement-breakpoint

create table plan_liquidacion (
  plan_id uuid not null,
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  liquidacion_id uuid not null,
  -- Lo que entró de esa liquidación a la firma (antes, a la del alta).
  capital numeric(14,2) not null,
  interes numeric(14,2) not null,
  primary key (plan_id, liquidacion_id),
  constraint fk_plan_liquidacion_plan foreign key (plan_id, barrio_id) references plan_pago (id, barrio_id) on delete restrict,
  constraint fk_plan_liquidacion_liq foreign key (liquidacion_id, barrio_id) references liquidacion (id, barrio_id) on delete restrict,
  constraint plan_liquidacion_montos_chk check (capital >= 0 and interes >= 0 and capital + interes > 0)
);
--> statement-breakpoint
create index idx_plan_liquidacion_liq on plan_liquidacion (liquidacion_id);
--> statement-breakpoint
create index idx_plan_liquidacion_barrio on plan_liquidacion (barrio_id);
--> statement-breakpoint

create table plan_cuota (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null,
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  -- 0 = anticipo.
  numero smallint not null,
  vencimiento date not null,
  importe numeric(14,2) not null,
  capital numeric(14,2) not null,
  interes numeric(14,2) not null default 0,
  -- La parte de `capital` (la amortización) que es mora de la deuda original —la que entró al plan y no
  -- se perdonó—. La reparte la firma, de la primera cuota en adelante. Tampoco devenga mora: si la
  -- cuota queda impaga, la mora corre solo sobre el capital original (sin interés sobre interés).
  mora_incluida numeric(14,2) not null default 0,
  liquidacion_id uuid unique,
  constraint fk_plan_cuota_plan foreign key (plan_id, barrio_id) references plan_pago (id, barrio_id) on delete restrict,
  constraint fk_plan_cuota_liq foreign key (liquidacion_id, barrio_id) references liquidacion (id, barrio_id) on delete restrict,
  constraint uq_plan_cuota_numero unique (plan_id, numero),
  constraint plan_cuota_montos_chk check (importe > 0 and capital >= 0 and interes >= 0 and capital + interes = importe and numero between 0 and 60
                                          and mora_incluida >= 0 and mora_incluida <= capital)
);
--> statement-breakpoint
create index idx_plan_cuota_barrio on plan_cuota (barrio_id, vencimiento) where liquidacion_id is null;
--> statement-breakpoint

create table plan_evento (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null,
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  tipo text not null,
  detalle jsonb not null default '{}'::jsonb,
  registrado_por uuid not null,
  registrado_at timestamptz not null default clock_timestamp(),
  constraint fk_plan_evento_plan foreign key (plan_id, barrio_id) references plan_pago (id, barrio_id) on delete restrict,
  constraint plan_evento_tipo_chk check (tipo in ('propuesto', 'firmado', 'cuota_emitida', 'rechazado', 'retirado', 'cumplido', 'caido')),
  constraint plan_evento_detalle_chk check (jsonb_typeof(detalle) = 'object')
);
--> statement-breakpoint
create index idx_plan_evento_plan on plan_evento (plan_id, registrado_at);
--> statement-breakpoint
create index idx_plan_evento_barrio on plan_evento (barrio_id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. Quién escribe qué: el alta (pendiente) la hace la administración bajo RLS; todo cambio de
--    estado, la emisión y los eventos, solo las funciones de abajo (dueño `app_job`).
-- ---------------------------------------------------------------------------------------------
create or replace function app.plan_pago_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'un plan no se borra: se rechaza o se retira';
  end if;
  if tg_op = 'INSERT' then
    if current_user::text <> 'app_job' then
      if new.estado <> 'pendiente' or new.fecha_firma is not null or new.pago_firma_id is not null or new.cargo_caida is not null then
        raise exception 'un plan nace pendiente: se firma al aprobarlo';
      end if;
    end if;
    new.creado_por := app.current_user_id();
    if new.creado_por is null then
      raise exception 'un plan se propone con una identidad';
    end if;
    new.created_at := now();
    return new;
  end if;
  if current_user::text <> 'app_job' then
    raise exception 'un plan cambia por sus acciones (aprobar, rechazar, retirar, declarar caído), no se edita';
  end if;
  return new;
end; $$;
--> statement-breakpoint

-- Las cuotas y las liquidaciones de un plan se cargan con el plan pendiente; después, solo el plan.
create or replace function app.plan_parte_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
declare v_estado text;
begin
  if current_user::text = 'app_job' then
    return coalesce(new, old);
  end if;
  select estado into v_estado from plan_pago where id = coalesce(new.plan_id, old.plan_id);
  if v_estado is distinct from 'pendiente' then
    raise exception 'las cuotas y la deuda de un plan se cargan mientras está pendiente';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'las cuotas y la deuda de un plan pendiente se reemplazan, no se editan';
  end if;
  if tg_table_name = 'plan_cuota' and tg_op = 'INSERT' and new.liquidacion_id is not null then
    raise exception 'una cuota se emite con el plan vigente';
  end if;
  return coalesce(new, old);
end; $$;
--> statement-breakpoint

create or replace function app.plan_solo_agregar() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  raise exception 'los eventos de un plan no se editan ni se borran';
end; $$;
--> statement-breakpoint

create or replace function app.plan_evento_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if current_user::text <> 'app_job' then
    raise exception 'los eventos de un plan los escribe el plan' using errcode = '42501';
  end if;
  new.registrado_por := app.current_user_id();
  if new.registrado_por is null then
    raise exception 'un evento de un plan se registra con una identidad';
  end if;
  new.registrado_at := clock_timestamp();
  return new;
end; $$;
--> statement-breakpoint

create or replace function app.plan_config_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if tg_table_name = 'plan_catalogo' then
    if tg_op = 'INSERT' then
      new.creado_por := app.current_user_id();
      new.created_at := now();
    else
      new.creado_por := old.creado_por;
      new.created_at := old.created_at;
      new.administracion_id := old.administracion_id;
    end if;
    if new.creado_por is null then raise exception 'el catálogo se carga con una identidad'; end if;
    if not exists (select 1 from tenant_node where id = new.administracion_id and tipo = 'administrador') then
      raise exception 'el catálogo de planes es de una administración';
    end if;
  else
    new.cargado_por := app.current_user_id();
    if new.cargado_por is null then raise exception 'los parámetros se cargan con una identidad'; end if;
    new.updated_at := now();
  end if;
  return new;
end; $$;
--> statement-breakpoint

-- Un plan del catálogo solo en sus barrios; un estudio, solo si trabaja en el barrio.
create or replace function app.plan_catalogo_barrio_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if not exists (select 1 from plan_catalogo c join tenant_node n on n.parent_id = c.administracion_id
                  where c.id = new.catalogo_id and n.id = new.barrio_id) then
    raise exception 'el plan del catálogo es de otra administración';
  end if;
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_plan_pago_antes before insert or update or delete on plan_pago
  for each row execute function app.plan_pago_antes();
--> statement-breakpoint
create trigger trg_plan_cuota_antes before insert or update or delete on plan_cuota
  for each row execute function app.plan_parte_antes();
--> statement-breakpoint
create trigger trg_plan_liquidacion_antes before insert or update or delete on plan_liquidacion
  for each row execute function app.plan_parte_antes();
--> statement-breakpoint
create trigger trg_plan_evento_antes before insert on plan_evento
  for each row execute function app.plan_evento_antes();
--> statement-breakpoint
create trigger trg_plan_evento_solo_agregar before update or delete on plan_evento
  for each row execute function app.plan_solo_agregar();
--> statement-breakpoint
create trigger trg_plan_evento_sin_truncate before truncate on plan_evento
  for each statement execute function app.plan_solo_agregar();
--> statement-breakpoint
create trigger trg_plan_catalogo_antes before insert or update on plan_catalogo
  for each row execute function app.plan_config_antes();
--> statement-breakpoint
create trigger trg_plan_parametro_antes before insert or update on plan_parametro_barrio
  for each row execute function app.plan_config_antes();
--> statement-breakpoint
create trigger trg_plan_catalogo_barrio_antes before insert on plan_catalogo_barrio
  for each row execute function app.plan_catalogo_barrio_antes();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. El capital de una cuota: la mora no corre sobre el interés de financiación
--
-- Dentro de una cuota, lo que se paga va primero al interés de financiación (CCyC 903). El capital
-- pendiente es lo que falta menos el interés que todavía no se cubrió: `greatest(interes - imputado, 0)`.
-- Para todo lo que no es cuota `interes_financiacion` es 0 y la cuenta es la de siempre: el resto de
-- la expresión vale 0 (`greatest(0 - imputado, 0)`).
-- ---------------------------------------------------------------------------------------------
create or replace function app.capital_pendiente(p_liquidacion uuid) returns numeric
  language sql stable security invoker set search_path = public, app
as $$
  select l.importe_exigible - coalesce(i.imputado, 0) - greatest(l.interes_financiacion - coalesce(i.imputado, 0), 0)
    from liquidacion l
    left join lateral (
      select sum(pi.monto_imputado) as imputado from pago_imputacion pi
       where pi.liquidacion_id = l.id and pi.anulado_at is null
    ) i on true
   where l.id = p_liquidacion
$$;
--> statement-breakpoint
create or replace function app.capitales_pendientes(p_barrio uuid)
  returns table (liquidacion_id uuid, pendiente numeric)
  language sql stable security invoker set search_path = public, app
as $$
  select l.id,
         l.importe_exigible - coalesce(i.imputado, 0) - greatest(l.interes_financiacion - coalesce(i.imputado, 0), 0)
    from liquidacion l
    left join lateral (
      select sum(pi.monto_imputado) as imputado
        from pago_imputacion pi
       where pi.liquidacion_id = l.id and pi.anulado_at is null
    ) i on true
   where l.barrio_id = p_barrio
$$;
--> statement-breakpoint

-- Lo que falta pagar de una liquidación (capital + interés de financiación): la cuota impaga entera.
create or replace function app.saldo_de_liquidacion(p_liquidacion uuid) returns numeric
  language sql stable security invoker set search_path = public, app
as $$
  select l.importe_exigible - coalesce((select sum(pi.monto_imputado) from pago_imputacion pi
                                          where pi.liquidacion_id = l.id and pi.anulado_at is null), 0)
    from liquidacion l where l.id = p_liquidacion
$$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 5. La emisión de las cuotas: con el mes en que vencen, nunca antes
--
-- Una cuota se emite cuando su mes ya se emitió en el barrio (el último período mensual emitido):
-- al firmar (si vence en un mes ya emitido, por ejemplo el anticipo) y cada vez que se emite un mes
-- (trigger de abajo). Cada cuota es un período `plan` con una liquidación de vencimiento propio.
-- ---------------------------------------------------------------------------------------------
create or replace function app.plan_emitir_cuotas(p_barrio uuid) returns integer
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_ultimo  text;
  v_periodo uuid;
  v_liq     uuid;
  v_n       integer := 0;
  c         record;
begin
  -- Un solo emisor por barrio a la vez (la firma y la emisión del mes pueden cruzarse).
  perform pg_advisory_xact_lock(hashtextextended('plan-emision:' || p_barrio::text, 0));
  select max(periodo) into v_ultimo from periodo_expensa
   where barrio_id = p_barrio and origen = 'mensual' and estado in ('emitida', 'distribuida');
  if v_ultimo is null then
    return 0;
  end if;
  for c in
    select pc.id, pc.plan_id, pc.numero, pc.vencimiento, pc.importe, pc.interes, pc.mora_incluida, pp.unidad_funcional_id, pp.cantidad_cuotas,
           (select count(*) from plan_cuota x where x.plan_id = pp.id and x.numero > 0) as cuotas
      from plan_cuota pc join plan_pago pp on pp.id = pc.plan_id
     where pc.barrio_id = p_barrio and pc.liquidacion_id is null and pp.estado = 'vigente'
       and to_char(pc.vencimiento, 'YYYY-MM') <= v_ultimo
     order by pc.vencimiento, pc.plan_id, pc.numero
       for update of pc
  loop
    insert into periodo_expensa (barrio_id, periodo, origen, notas)
    values (p_barrio, to_char(c.vencimiento, 'YYYY-MM'), 'plan',
            case when c.numero = 0 then 'Plan de pagos: anticipo' else 'Plan de pagos: cuota ' || c.numero || ' de ' || c.cuotas end)
    returning id into v_periodo;
    insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, coeficiente_aplicado,
                             subtotal_ordinarias, subtotal_extraordinarias, subtotal_fondo_reserva, subtotal_cargos,
                             interes_mora, total, vencimiento, saldo_anterior_origen, interes_financiacion)
    values (p_barrio, v_periodo, c.unidad_funcional_id, 0, 0, 0, 0, 0, 0, c.importe, c.vencimiento, 'sin_movimientos', c.interes + c.mora_incluida)
    returning id into v_liq;
    insert into item_liquidacion (barrio_id, liquidacion_id, descripcion, base_monto, monto, clase_item)
    values (p_barrio, v_liq,
            case when c.numero = 0 then 'Plan de pagos · anticipo' else 'Plan de pagos · cuota ' || c.numero || ' de ' || c.cuotas end,
            c.importe, c.importe, 'plan_cuota');
    update plan_cuota set liquidacion_id = v_liq where id = c.id and liquidacion_id is null;
    if not found then
      raise exception 'la cuota % del plan ya se emitió', c.numero;
    end if;
    update periodo_expensa set estado = 'emitida' where id = v_periodo;
    insert into plan_evento (plan_id, barrio_id, tipo, detalle)
    values (c.plan_id, p_barrio, 'cuota_emitida',
            jsonb_build_object('numero', c.numero, 'vencimiento', c.vencimiento, 'importe', c.importe, 'liquidacionId', v_liq));
    v_n := v_n + 1;
  end loop;
  return v_n;
end; $$;
--> statement-breakpoint

-- Al emitirse un mes, se emiten las cuotas que vencen en él (o antes y quedaron sin emitir).
create or replace function app.plan_cuotas_al_emitir() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  if new.origen = 'mensual' and new.estado = 'emitida' and old.estado is distinct from 'emitida' then
    perform app.plan_emitir_cuotas(new.barrio_id);
  end if;
  return null;
end; $$;
--> statement-breakpoint
create trigger trg_plan_cuotas_al_emitir after update on periodo_expensa
  for each row when (new.origen = 'mensual' and new.estado = 'emitida' and old.estado is distinct from 'emitida') execute function app.plan_cuotas_al_emitir();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 6. El pago no monetario del plan, la firma, rechazar y retirar
-- ---------------------------------------------------------------------------------------------
create or replace function app.plan_crear_pago(p_plan uuid, p_monto numeric, p_fecha date) returns uuid
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_plan plan_pago;
  v_hoy  date;
  v_id   uuid;
begin
  select * into v_plan from plan_pago where id = p_plan for update;
  if v_plan.id is null or not app.has_role_on(v_plan.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) then
    raise exception 'el plan no existe o no es de un barrio que administres' using errcode = '42501';
  end if;
  if v_plan.estado not in ('pendiente', 'caido') then
    raise exception 'el plan no está para firmar ni para caer';
  end if;
  if p_monto is null or p_monto <= 0 or p_monto <> round(p_monto, 2) then
    raise exception 'el pago de un plan es un importe mayor que cero';
  end if;
  select (now() at time zone b.zona_horaria)::date into v_hoy from barrio b where b.barrio_id = v_plan.barrio_id;
  if p_fecha is null or p_fecha > v_hoy then
    raise exception 'la fecha de un plan no es futura';
  end if;
  insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen, estado_conciliacion)
  values (v_plan.barrio_id, v_plan.unidad_funcional_id, p_monto, p_fecha, 'plan', 'conciliado')
  returning id into v_id;
  return v_id;
end; $$;
--> statement-breakpoint

-- La firma. La llama el servicio en la misma transacción en que: tomó el candado de la unidad, creó
-- el pago del plan (`app.plan_crear_pago`) y cerró con él los tramos de interés de la deuda incluida
-- (`registrarTramos`, el código de siempre). Acá: la deuda incluida se cubre con ese pago, el plan
-- queda vigente, la derivación se retira y se emiten las cuotas cuyo mes ya se emitió.
create or replace function app.plan_firmar(p_plan uuid, p_pago uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_plan    plan_pago;
  v_pago    pago;
  v_capital numeric(14,2) := 0;
  v_interes numeric(14,2) := 0;
  v_perdon  numeric(14,2);
  v_qi      numeric(14,2);
  v_qc      numeric(14,2);
  v_fin     numeric(14,2);
  v_cuotas  numeric(14,2);
  r         record;
begin
  select * into v_plan from plan_pago where id = p_plan for update;
  if v_plan.id is null or not app.has_role_on(v_plan.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) then
    raise exception 'el plan no existe o no es de un barrio que administres' using errcode = '42501';
  end if;
  if v_plan.estado <> 'pendiente' then
    raise exception 'el plan ya no está pendiente: se firma una sola vez';
  end if;
  perform app.serializar_cobros_de_unidad(v_plan.unidad_funcional_id);
  perform pg_advisory_xact_lock(hashtextextended('deuda-anterior:' || v_plan.barrio_id::text, 0));

  select * into v_pago from pago where id = p_pago for update;
  if v_pago.id is null or v_pago.origen <> 'plan' or v_pago.unidad_funcional_id <> v_plan.unidad_funcional_id
     or v_pago.anulado_at is not null
     or exists (select 1 from pago_imputacion where pago_id = p_pago)
     or exists (select 1 from pago_imputacion_interes where pago_id = p_pago) then
    raise exception 'el pago de la firma no es de este plan';
  end if;
  -- La firma con fecha pasada no reescribe la historia: no puede haber pagos de la unidad posteriores.
  if exists (select 1 from pago where unidad_funcional_id = v_plan.unidad_funcional_id and anulado_at is null
                and origen <> 'plan' and fecha > v_pago.fecha) then
    raise exception 'la unidad tiene pagos posteriores a la fecha de firma';
  end if;
  if exists (select 1 from plan_cuota where plan_id = p_plan and vencimiento <= v_pago.fecha) then
    raise exception 'las cuotas vencen después de la firma: corregí el cronograma';
  end if;

  -- La deuda que entra: cada liquidación vencida a la fecha de firma, su capital y su mora pendientes
  -- (los tramos ya se cerraron a esa fecha).
  for r in
    select pl.liquidacion_id, l.unidad_funcional_id, pe.origen, pe.estado,
           coalesce(l.vencimiento, pe.primer_vencimiento) as vence,
           app.capital_pendiente(l.id) as capital,
           coalesce((select sum(app.interes_pendiente(d.id)) from interes_devengado d where d.liquidacion_id = l.id and d.monto > 0), 0) as interes,
           (select max(d.hasta) from interes_devengado d where d.liquidacion_id = l.id) as ultimo
      from plan_liquidacion pl
      join liquidacion l on l.id = pl.liquidacion_id
      join periodo_expensa pe on pe.id = l.periodo_id
     where pl.plan_id = p_plan
  loop
    if r.unidad_funcional_id <> v_plan.unidad_funcional_id or r.origen = 'plan' or r.estado not in ('emitida', 'distribuida')
       or r.vence is null or r.vence >= v_pago.fecha then
      raise exception 'al plan entran liquidaciones emitidas y vencidas de la unidad (no cuotas de otro plan)';
    end if;
    if r.capital + r.interes <= 0 then
      raise exception 'una de las liquidaciones elegidas ya no debe nada: recalculá el plan';
    end if;
    -- Los tramos de mora ya se cerraron a la fecha de firma: los cierra el servicio, con el código de
    -- siempre (`registrarTramos`) y este mismo pago, en la misma transacción. Un tramo posterior a la
    -- firma no puede existir: la base no lo acepta en el futuro ni fuera de orden (`0064`).
    if r.ultimo is not null and r.ultimo > v_pago.fecha then
      raise exception 'la deuda incluida tiene mora registrada después de la fecha de firma';
    end if;
    update plan_liquidacion set capital = r.capital, interes = r.interes where plan_id = p_plan and liquidacion_id = r.liquidacion_id;
    if r.capital > 0 then
      insert into pago_imputacion (pago_id, liquidacion_id, monto_imputado) values (p_pago, r.liquidacion_id, r.capital);
    end if;
    insert into pago_imputacion_interes (pago_id, interes_id, monto_imputado)
    select p_pago, d.id, app.interes_pendiente(d.id) from interes_devengado d
     where d.liquidacion_id = r.liquidacion_id and d.monto > 0 and app.interes_pendiente(d.id) > 0;
    v_capital := v_capital + r.capital;
    v_interes := v_interes + r.interes;
  end loop;
  if v_capital + v_interes <= 0 then
    raise exception 'el plan no tiene deuda incluida';
  end if;
  if v_capital + v_interes <> v_pago.monto then
    raise exception 'el pago de la firma (%) no es la deuda incluida (%): recalculá', v_pago.monto, v_capital + v_interes;
  end if;

  -- El cuadre, con la deuda de la firma. A medida: lo que no cubre el cronograma se perdona, primero
  -- el interés y después el capital; si lo supera, el excedente es interés de financiación pactado.
  select coalesce(sum(importe), 0), coalesce(sum(interes), 0) into v_cuotas, v_fin from plan_cuota where plan_id = p_plan;
  if v_plan.tipo = 'a_medida' then
    v_perdon := v_capital + v_interes - v_cuotas;
    v_fin := greatest(-v_perdon, 0);
    v_perdon := greatest(v_perdon, 0);
    v_qi := least(v_perdon, v_interes);
    v_qc := v_perdon - v_qi;
    -- El interés de financiación pactado se reparte con la deuda de la FIRMA (la del alta pudo cambiar):
    -- va a las primeras cuotas, y lo que sigue de cada una es amortización.
    update plan_cuota pc set interes = least(x.importe, greatest(v_fin - x.antes, 0)),
                             capital = x.importe - least(x.importe, greatest(v_fin - x.antes, 0))
      from (select id, importe, coalesce(sum(importe) over (order by numero rows between unbounded preceding and 1 preceding), 0) as antes
              from plan_cuota where plan_id = p_plan) x
     where pc.id = x.id;
  else
    v_qi := 0;
    v_qc := 0;
    if v_capital + v_interes + v_fin <> v_cuotas then
      raise exception 'la deuda cambió desde que se armó el plan: recalculá las cuotas';
    end if;
  end if;

  -- Sin interés sobre interés: la mora original que queda en el plan (la que no se perdonó) se reparte
  -- en la amortización de las cuotas, de la primera en adelante (lo pagado va primero al interés). Esa
  -- parte de cada cuota no devenga mora si la cuota queda impaga.
  update plan_cuota pc set mora_incluida = least(x.capital, greatest(x.resto - x.antes, 0))
    from (select id, capital, v_interes - v_qi as resto,
                 coalesce(sum(capital) over (order by numero rows between unbounded preceding and 1 preceding), 0) as antes
            from plan_cuota where plan_id = p_plan) x
   where pc.id = x.id;

  update plan_pago
     set estado = 'vigente', fecha_firma = v_pago.fecha, pago_firma_id = p_pago,
         deuda_capital = v_capital, deuda_interes = v_interes, total_cuotas = v_cuotas, interes_financiacion = v_fin,
         quita_interes = v_qi, quita_capital = v_qc
   where id = p_plan;

  -- La unidad sale del estudio: la gestiona el plan.
  update derivacion set retiro_motivo = 'plan_administracion', retiro_nota = 'Se firmó un plan de pagos.'
   where unidad_funcional_id = v_plan.unidad_funcional_id and retirada_at is null;

  insert into plan_evento (plan_id, barrio_id, tipo, detalle)
  values (p_plan, v_plan.barrio_id, 'firmado',
          jsonb_build_object('fecha', v_pago.fecha, 'pagoId', p_pago, 'capital', v_capital, 'interes', v_interes,
                             'totalCuotas', v_cuotas, 'interesFinanciacion', v_fin, 'quitaInteres', v_qi, 'quitaCapital', v_qc));
  perform app.plan_emitir_cuotas(v_plan.barrio_id);
end; $$;
--> statement-breakpoint

create or replace function app.plan_cerrar_pendiente(p_plan uuid, p_estado text, p_motivo text) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare v_plan plan_pago;
begin
  select * into v_plan from plan_pago where id = p_plan for update;
  if v_plan.id is null or not app.has_role_on(v_plan.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) then
    raise exception 'el plan no existe o no es de un barrio que administres' using errcode = '42501';
  end if;
  if p_estado not in ('rechazado', 'retirado') then
    raise exception 'un plan pendiente se rechaza o se retira';
  end if;
  if v_plan.estado <> 'pendiente' then
    raise exception 'solo un plan pendiente se rechaza o se retira';
  end if;
  if p_motivo is null or length(btrim(p_motivo)) = 0 then
    raise exception 'rechazar o retirar un plan lleva motivo';
  end if;
  update plan_pago set estado = p_estado, cerrado_at = now() where id = p_plan;
  insert into plan_evento (plan_id, barrio_id, tipo, detalle)
  values (p_plan, v_plan.barrio_id, p_estado, jsonb_build_object('motivo', left(btrim(p_motivo), 500)));
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 7. Cumplido: al quedar paga la última cuota
-- ---------------------------------------------------------------------------------------------
create or replace function app.plan_cumplir_si_corresponde() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_plan uuid;
  v_barrio uuid;
begin
  select pc.plan_id, pc.barrio_id into v_plan, v_barrio
    from plan_cuota pc join plan_pago pp on pp.id = pc.plan_id
   where pc.liquidacion_id = new.liquidacion_id and pp.estado = 'vigente';
  if v_plan is null then
    return null;
  end if;
  if not exists (select 1 from plan_cuota c where c.plan_id = v_plan
                  and (c.liquidacion_id is null or app.saldo_de_liquidacion(c.liquidacion_id) > 0)) then
    update plan_pago set estado = 'cumplido', cerrado_at = now() where id = v_plan;
    insert into plan_evento (plan_id, barrio_id, tipo, detalle)
    values (v_plan, v_barrio, 'cumplido', jsonb_build_object('pagoId', new.pago_id));
  end if;
  return null;
end; $$;
--> statement-breakpoint
create trigger trg_plan_cumplir after insert on pago_imputacion
  for each row execute function app.plan_cumplir_si_corresponde();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 8. La caída (la orquesta el servicio; ver el encabezado)
-- ---------------------------------------------------------------------------------------------

-- Paso 1: el plan cae. Se anulan las imputaciones que los pagos reales hicieron a las cuotas (se
-- vuelven a imputar a la deuda original) y la firma (vuelve la deuda original, con su quita).
-- Devuelve los pagos reales a reimputar.
create or replace function app.plan_caer_preparar(p_plan uuid) returns setof uuid
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_plan  plan_pago;
  v_hoy   date;
  v_n     integer;
  v_min   smallint;
  v_mot   constant text := 'Cayó el plan de pagos: lo pagado vuelve a la deuda original';
begin
  select * into v_plan from plan_pago where id = p_plan for update;
  if v_plan.id is null or not app.has_role_on(v_plan.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) then
    raise exception 'el plan no existe o no es de un barrio que administres' using errcode = '42501';
  end if;
  if v_plan.estado <> 'vigente' then
    raise exception 'solo un plan vigente se declara caído';
  end if;
  perform app.serializar_cobros_de_unidad(v_plan.unidad_funcional_id);
  select (now() at time zone b.zona_horaria)::date into v_hoy from barrio b where b.barrio_id = v_plan.barrio_id;
  select coalesce((select cuotas_para_caer from plan_parametro_barrio where barrio_id = v_plan.barrio_id), 2) into v_min;
  select count(*) into v_n from plan_cuota c join liquidacion l on l.id = c.liquidacion_id
   where c.plan_id = p_plan and l.vencimiento < v_hoy and app.saldo_de_liquidacion(l.id) > 0;
  if v_n < v_min then
    raise exception 'el plan cae con % cuotas impagas vencidas: hay %', v_min, v_n;
  end if;

  update plan_pago set estado = 'caido', cargo_caida = 0, cerrado_at = now() where id = p_plan;

  return query
    select distinct pi.pago_id from pago_imputacion pi join pago p on p.id = pi.pago_id
     where pi.liquidacion_id in (select liquidacion_id from plan_cuota where plan_id = p_plan and liquidacion_id is not null)
       and pi.anulado_at is null and p.origen <> 'plan'
    union
    select distinct pii.pago_id from pago_imputacion_interes pii join interes_devengado d on d.id = pii.interes_id
      join pago p on p.id = pii.pago_id
     where d.liquidacion_id in (select liquidacion_id from plan_cuota where plan_id = p_plan and liquidacion_id is not null)
       and pii.anulado_at is null and p.origen <> 'plan';

  update pago_imputacion set anulado_at = now(), anulado_por = app.current_user_id(), motivo_anulacion = v_mot
   where liquidacion_id in (select liquidacion_id from plan_cuota where plan_id = p_plan and liquidacion_id is not null)
     and anulado_at is null;
  update pago_imputacion_interes set anulado_at = now(), anulado_por = app.current_user_id(), motivo_anulacion = v_mot
   where interes_id in (select d.id from interes_devengado d
                         where d.liquidacion_id in (select liquidacion_id from plan_cuota where plan_id = p_plan and liquidacion_id is not null))
     and anulado_at is null;
  -- La firma: vuelve la deuda original (capital, mora hasta la firma y la quita, si la hubo).
  update pago_imputacion set anulado_at = now(), anulado_por = app.current_user_id(), motivo_anulacion = v_mot
   where pago_id = v_plan.pago_firma_id and anulado_at is null;
  update pago_imputacion_interes set anulado_at = now(), anulado_por = app.current_user_id(), motivo_anulacion = v_mot
   where pago_id = v_plan.pago_firma_id and anulado_at is null;
  update pago set anulado_at = now(), anulado_por = app.current_user_id(), motivo_anulacion = v_mot
   where id = v_plan.pago_firma_id and anulado_at is null;
end; $$;
--> statement-breakpoint

-- Paso 2: las cuotas emitidas e impagas (y su mora) se cancelan con un pago no monetario del plan,
-- para que nada se cuente dos veces: la deuda volvió entera en las liquidaciones originales.
create or replace function app.plan_caer_cancelar_cuotas(p_plan uuid, p_pago uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_plan plan_pago;
  v_pago pago;
  v_total numeric(14,2) := 0;
  r record;
begin
  select * into v_plan from plan_pago where id = p_plan for update;
  if v_plan.id is null or v_plan.estado <> 'caido' or not app.has_role_on(v_plan.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) then
    raise exception 'el plan no está cayendo';
  end if;
  select * into v_pago from pago where id = p_pago for update;
  if v_pago.id is null or v_pago.origen <> 'plan' or v_pago.unidad_funcional_id <> v_plan.unidad_funcional_id or v_pago.anulado_at is not null
     or exists (select 1 from pago_imputacion where pago_id = p_pago)
     or exists (select 1 from pago_imputacion_interes where pago_id = p_pago) then
    raise exception 'el pago de la cancelación no es de este plan';
  end if;
  for r in select c.liquidacion_id, app.saldo_de_liquidacion(c.liquidacion_id) as saldo
             from plan_cuota c where c.plan_id = p_plan and c.liquidacion_id is not null
  loop
    if r.saldo > 0 then
      insert into pago_imputacion (pago_id, liquidacion_id, monto_imputado) values (p_pago, r.liquidacion_id, r.saldo);
      v_total := v_total + r.saldo;
    end if;
  end loop;
  for r in select d.id, app.interes_pendiente(d.id) as pend from interes_devengado d
            where d.liquidacion_id in (select liquidacion_id from plan_cuota where plan_id = p_plan and liquidacion_id is not null)
              and d.monto > 0
  loop
    if r.pend > 0 then
      insert into pago_imputacion_interes (pago_id, interes_id, monto_imputado) values (p_pago, r.id, r.pend);
      v_total := v_total + r.pend;
    end if;
  end loop;
  if v_total <> v_pago.monto then
    raise exception 'la cancelación de las cuotas (%) no es lo que quedaba de ellas (%)', v_pago.monto, v_total;
  end if;
end; $$;
--> statement-breakpoint

-- Paso 3 (después de reimputar los pagos y cerrar los tramos de la deuda original): el cargo.
create or replace function app.plan_caer_cerrar(p_plan uuid, p_cargo numeric, p_detalle jsonb) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare v_plan plan_pago;
begin
  select * into v_plan from plan_pago where id = p_plan for update;
  if v_plan.id is null or v_plan.estado <> 'caido' or not app.has_role_on(v_plan.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) then
    raise exception 'el plan no está cayendo';
  end if;
  if p_cargo is null or p_cargo < 0 then
    raise exception 'el cargo de la caída no es negativo';
  end if;
  -- Una sola vez: el cargo y su evento no se pisan.
  if exists (select 1 from plan_evento where plan_id = p_plan and tipo = 'caido') then
    raise exception 'la caída de este plan ya se cerró';
  end if;
  update plan_pago set cargo_caida = p_cargo where id = p_plan;
  insert into plan_evento (plan_id, barrio_id, tipo, detalle)
  values (p_plan, v_plan.barrio_id, 'caido', coalesce(p_detalle, '{}'::jsonb) || jsonb_build_object('cargo', p_cargo));
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 9. El bloqueo: con un plan vigente, lo que cubrió su deuda no se anula
-- ---------------------------------------------------------------------------------------------
create or replace function app.plan_bloqueo_anulacion() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if not (new.anulado_at is not null and old.anulado_at is null) or current_user::text = 'app_job' then
    return new;
  end if;
  if tg_table_name = 'pago' then
    if old.origen = 'plan' then
      raise exception 'el pago de un plan no se anula: el plan se declara caído' using errcode = '42501';
    end if;
    if exists (select 1 from pago_imputacion pi join plan_liquidacion pl on pl.liquidacion_id = pi.liquidacion_id
                 join plan_pago pp on pp.id = pl.plan_id
                where pi.pago_id = old.id and pi.anulado_at is null and pp.estado in ('vigente', 'cumplido'))
       or exists (select 1 from pago_imputacion_interes pii join interes_devengado d on d.id = pii.interes_id
                    join plan_liquidacion pl on pl.liquidacion_id = d.liquidacion_id join plan_pago pp on pp.id = pl.plan_id
                   where pii.pago_id = old.id and pii.anulado_at is null and pp.estado in ('vigente', 'cumplido')) then
      raise exception 'ese pago cubrió deuda que está en un plan vigente o cumplido: no se anula' using errcode = '42501';
    end if;
  elsif tg_table_name = 'pago_imputacion' then
    if exists (select 1 from pago p where p.id = old.pago_id and p.origen = 'plan')
       or exists (select 1 from plan_liquidacion pl join plan_pago pp on pp.id = pl.plan_id
                   where pl.liquidacion_id = old.liquidacion_id and pp.estado in ('vigente', 'cumplido')) then
      raise exception 'esa imputación cubrió deuda que está en un plan vigente o cumplido: no se anula' using errcode = '42501';
    end if;
  else
    if exists (select 1 from pago p where p.id = old.pago_id and p.origen = 'plan')
       or exists (select 1 from interes_devengado d join plan_liquidacion pl on pl.liquidacion_id = d.liquidacion_id
                    join plan_pago pp on pp.id = pl.plan_id
                   where d.id = old.interes_id and pp.estado in ('vigente', 'cumplido')) then
      raise exception 'esa imputación cubrió deuda que está en un plan vigente o cumplido: no se anula' using errcode = '42501';
    end if;
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_pago_zz_plan_bloqueo before update on pago
  for each row execute function app.plan_bloqueo_anulacion();
--> statement-breakpoint
create trigger trg_pago_imputacion_zz_plan_bloqueo before update on pago_imputacion
  for each row execute function app.plan_bloqueo_anulacion();
--> statement-breakpoint
create trigger trg_pago_imputacion_interes_zz_plan_bloqueo before update on pago_imputacion_interes
  for each row execute function app.plan_bloqueo_anulacion();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 10. `app.validar_emision` v8: copia ENTERA de la v7 (`0087`) con la rama de las cuotas `[0093]`,
--     después de la de la deuda anterior. Para todo lo demás, las verificaciones de siempre.
-- ---------------------------------------------------------------------------------------------
create or replace function app.validar_emision(p_periodo uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_barrio        uuid;
  v_modelo        app.modelo_expensa;
  v_esperado      numeric(14,2);
  v_prorrateo     numeric(14,2);
  v_cargos        numeric(14,2);
  v_descuentos    numeric(14,2);
  v_n_items       bigint;
  v_liquidaciones bigint;
  v_unidades      bigint;
  v_version       uuid;
  v_cuota_ver     uuid;
  v_cerrada       boolean;
  v_sin_cuota     bigint;
  v_n_aplic       bigint;
  v_s_aplic       numeric(14,2);
  v_sin_resolver  bigint;
  -- [0081]
  v_total_mes     numeric(14,2);
  v_cupon         text;
  v_bonif_modo    text;
  v_bonif_forma   text;
  v_bonif_valor   numeric;
  v_bonif_tope    numeric;
  v_mal           bigint;
  -- [0087]
  v_origen        text;
  v_primer        text;
  v_periodo       text;
  v_hoy           date;
begin
  select barrio_id, modelo, coeficiente_version_id, cuota_fija_version_id, cupon_cobra, bonificacion_modo,
         bonificacion_forma, bonificacion_valor, bonificacion_tope
    into v_barrio, v_modelo, v_version, v_cuota_ver, v_cupon, v_bonif_modo, v_bonif_forma, v_bonif_valor, v_bonif_tope
    from periodo_expensa where id = p_periodo;

  -- [0087] La deuda anterior a la activación: un período histórico no reparte nada, así que no lleva
  -- coeficientes ni cuadre contra gastos. Lo que sí se verifica es que sea lo que dice ser.
  select pe.origen, pe.periodo, b.primer_periodo, (now() at time zone b.zona_horaria)::date
    into v_origen, v_periodo, v_primer, v_hoy
    from periodo_expensa pe join barrio b on b.barrio_id = pe.barrio_id
   where pe.id = p_periodo;

  if v_origen = 'historico' then
    if v_primer is null or v_periodo >= v_primer then
      raise exception 'un período histórico es anterior al primer mes a devengar del barrio';
    end if;
    if not exists (select 1 from liquidacion where periodo_id = p_periodo) then
      raise exception 'el período histórico no tiene ninguna deuda cargada';
    end if;
    select count(*) into v_mal
      from liquidacion l
      join unidad_funcional u on u.id = l.unidad_funcional_id
     where l.periodo_id = p_periodo
       and (l.vencimiento is null or l.vencimiento > v_hoy
            or l.numero_comprobante is not null
            or l.saldo_anterior <> 0 or l.interes_mora is distinct from 0
            or l.saldo_anterior_origen <> 'sin_movimientos'
            or l.importe_cupon is not null or l.deuda_anterior is not null
            or l.total <= 0
            or l.total <> (select coalesce(sum(i.monto), 0) from item_liquidacion i where i.liquidacion_id = l.id)
            or exists (select 1 from item_liquidacion i
                        where i.liquidacion_id = l.id and (i.clase_item::text <> 'historico' or i.monto <= 0))
            -- Saldo inicial y deuda mes por mes son dos formas de traer lo mismo: no van juntas.
            or u.saldo_inicial <> 0);
    if v_mal > 0 then
      raise exception 'la deuda anterior no cuadra: hay % liquidaciones históricas mal formadas', v_mal;
    end if;
    return;
  end if;

  -- [0093] La cuota de un plan de pagos: una liquidación, la de su cuota, bien formada, y su mes ya
  -- emitido en el barrio (nunca antes).
  if v_origen = 'plan' then
    if (select count(*) from liquidacion where periodo_id = p_periodo) <> 1 then
      raise exception 'un período de plan es una cuota: lleva una sola liquidación';
    end if;
    select count(*) into v_mal
      from liquidacion l
      left join plan_cuota pc on pc.liquidacion_id = l.id
      left join plan_pago pp on pp.id = pc.plan_id
     where l.periodo_id = p_periodo
       and (pc.id is null or pp.estado <> 'vigente'
            or l.unidad_funcional_id <> pp.unidad_funcional_id
            or l.vencimiento is distinct from pc.vencimiento
            or to_char(l.vencimiento, 'YYYY-MM') <> v_periodo
            or l.total <> pc.importe or l.interes_financiacion <> pc.interes + pc.mora_incluida
            or l.numero_comprobante is not null
            or l.saldo_anterior <> 0 or l.interes_mora is distinct from 0
            or l.saldo_anterior_origen <> 'sin_movimientos'
            or l.importe_cupon is not null or l.deuda_anterior is not null
            or l.total <> (select coalesce(sum(i.monto), 0) from item_liquidacion i where i.liquidacion_id = l.id)
            or exists (select 1 from item_liquidacion i where i.liquidacion_id = l.id and i.clase_item::text <> 'plan_cuota'));
    if v_mal > 0 then
      raise exception 'la cuota del plan no está bien formada';
    end if;
    if not exists (select 1 from periodo_expensa pe
                    where pe.barrio_id = v_barrio and pe.origen = 'mensual' and pe.estado in ('emitida', 'distribuida')
                      and pe.periodo >= v_periodo) then
      raise exception 'una cuota se emite con el mes en que vence, nunca antes';
    end if;
    return;
  end if;

  -- [0087] Un barrio sin activar no emite: primero se trae lo que venía de antes.
  if (select b.activacion from barrio b where b.barrio_id = v_barrio) <> 'activo' then
    raise exception 'el barrio todavía no está activado: no se puede emitir';
  end if;
  -- [0087] Y una línea histórica no entra en un mes del sistema.
  if exists (select 1 from liquidacion l join item_liquidacion i on i.liquidacion_id = l.id
              where l.periodo_id = p_periodo and i.clase_item::text = 'historico') then
    raise exception 'el período no cuadra: tiene líneas de deuda anterior, que son solo de un período histórico';
  end if;

  if v_version is null then
    raise exception 'el período no tiene versión de coeficientes: no se puede emitir';
  end if;
  select cerrada into v_cerrada from coeficiente_version where id = v_version;
  if not coalesce(v_cerrada, false) then
    raise exception 'la versión de coeficientes del período no está cerrada';
  end if;

  select count(*) into v_unidades
    from unidad_funcional where barrio_id = v_barrio and baja_at is null;
  select count(*) into v_liquidaciones from liquidacion where periodo_id = p_periodo;
  if v_liquidaciones <> v_unidades then
    raise exception 'faltan liquidaciones: % unidades activas y % liquidaciones', v_unidades, v_liquidaciones;
  end if;

  -- Una sola pasada para las tres clases (medido: 5 ms con 288.000 líneas).
  select coalesce(sum(i.monto) filter (where i.clase_item = 'prorrateo'), 0),
         coalesce(sum(i.monto) filter (where i.clase_item = 'cargo'), 0),
         coalesce(sum(i.monto) filter (where i.clase_item = 'descuento'), 0),
         count(*) filter (where i.clase_item in ('cargo','descuento'))
    into v_prorrateo, v_cargos, v_descuentos, v_n_items
    from liquidacion l join item_liquidacion i on i.liquidacion_id = l.id
   where l.periodo_id = p_periodo;

  -- Lo repartido tiene que ser el gasto. **Idéntico a antes**, con el filtro por clase.
  if v_modelo = 'variable' then
    select coalesce(sum(monto), 0) into v_esperado from gasto_periodo where periodo_id = p_periodo;
  else
    if v_cuota_ver is null then
      raise exception 'el período liquida por cuota fija pero no tiene una versión de cuota asignada';
    end if;
    -- [0081] La versión define un importe por unidad, o un total del mes que se reparte por coeficiente.
    select total_del_mes into v_total_mes from cuota_fija_version where id = v_cuota_ver;

    if v_total_mes is null then
      -- Importe por unidad: idéntico a la v4.
      select count(*) into v_sin_cuota
        from unidad_funcional u
       where u.barrio_id = v_barrio and u.baja_at is null
         and not exists (select 1 from cuota_fija c where c.version_id = v_cuota_ver and c.unidad_funcional_id = u.id);
      if v_sin_cuota > 0 then
        raise exception 'faltan % cuotas fijas: hay unidades activas sin importe asignado', v_sin_cuota;
      end if;
    end if;
    select coalesce(sum(g.monto), 0) into v_esperado
      from gasto_periodo g join concepto co on co.id = g.concepto_id
     where g.periodo_id = p_periodo and co.tipo = 'extraordinaria';

    if v_total_mes is null then
      -- La cuota fija cuadra contra su propia versión (idéntico a la v4).
      if (select coalesce(sum(i.monto), 0) from liquidacion l join item_liquidacion i on i.liquidacion_id = l.id
           where l.periodo_id = p_periodo and i.clase_item = 'cuota_fija')
         <> (select coalesce(sum(c.importe), 0) from cuota_fija c
              join unidad_funcional u on u.id = c.unidad_funcional_id and u.baja_at is null
             where c.version_id = v_cuota_ver) then
        raise exception 'el período no cuadra: las cuotas fijas cobradas no coinciden con la versión vigente';
      end if;
    else
      -- [0081] Por coeficiente: lo repartido es el total del mes, AL CENTAVO. Y cada unidad tiene su
      -- parte: una sola línea de cuota, con el total del mes como base (el coeficiente con que se
      -- repartió es el de su liquidación, `liquidacion.coeficiente_aplicado`).
      if (select coalesce(sum(i.monto), 0) from liquidacion l join item_liquidacion i on i.liquidacion_id = l.id
           where l.periodo_id = p_periodo and i.clase_item = 'cuota_fija')
         <> v_total_mes then
        raise exception 'el período no cuadra: lo repartido por coeficiente no es el total del mes (%)', v_total_mes;
      end if;
      select count(*) into v_mal
        from liquidacion l
       where l.periodo_id = p_periodo
         and (select count(*) from item_liquidacion i
               where i.liquidacion_id = l.id and i.clase_item = 'cuota_fija'
                 and i.base_monto = v_total_mes) <> 1;
      if v_mal > 0 then
        raise exception 'el período no cuadra: hay % unidades sin su parte del total del mes', v_mal;
      end if;
    end if;
  end if;

  if v_esperado <> v_prorrateo then
    raise exception 'el período no cuadra (modelo %): esperado % y repartido % (diferencia %)',
      v_modelo, v_esperado, v_prorrateo, v_esperado - v_prorrateo;
  end if;

  -- Tercera capa: el snapshot sigue siendo fiel al catálogo y la base es la de la liquidación.
  perform app.validar_aplicaciones(p_periodo);

  -- Cargos y descuentos: biyección 1 a 1 contra sus aplicaciones, en las dos direcciones.
  select count(*), coalesce(sum(monto_resuelto), 0) into v_n_aplic, v_s_aplic
    from concepto_boleta_unidad where periodo_id = p_periodo and anulado_at is null;

  select count(*) into v_sin_resolver
    from concepto_boleta_unidad
   where periodo_id = p_periodo and anulado_at is null and importe_resuelto is null;
  if v_sin_resolver > 0 then
    raise exception 'hay % conceptos aplicados sin resolver: el período no se puede emitir', v_sin_resolver;
  end if;

  if v_n_items <> v_n_aplic then
    raise exception 'el período no cuadra: % líneas de cargo/descuento contra % aplicaciones', v_n_items, v_n_aplic;
  end if;
  if (v_cargos + v_descuentos) <> v_s_aplic then
    raise exception 'el período no cuadra: cargos y descuentos suman % y las aplicaciones %',
      v_cargos + v_descuentos, v_s_aplic;
  end if;

  -- Por UNIDAD, no por barrio: un cargo en la boleta equivocada no mueve el total del período.
  if exists (
    select 1 from liquidacion l
     where l.periodo_id = p_periodo
       and (l.subtotal_cargos <> (select coalesce(sum(i.monto), 0) from item_liquidacion i
                                   where i.liquidacion_id = l.id and i.clase_item = 'cargo')
         or l.subtotal_descuentos <> (select coalesce(sum(i.monto), 0) from item_liquidacion i
                                       where i.liquidacion_id = l.id and i.clase_item = 'descuento'))
  ) then
    raise exception 'el período no cuadra: hay liquidaciones cuyos subtotales no coinciden con sus líneas';
  end if;

  if exists (
    select 1 from liquidacion l
     where l.periodo_id = p_periodo
       and l.total <> (select coalesce(sum(i.monto), 0) from item_liquidacion i where i.liquidacion_id = l.id)
                      + l.saldo_anterior + coalesce(l.interes_mora, 0)
  ) then
    raise exception 'el período no cuadra: hay liquidaciones cuyo total no coincide con sus líneas';
  end if;

  -- [0081] El cupón cobra lo que dice el modo del período, ni un centavo más ni uno menos. `solo_mes`:
  -- lo que la boleta suma a la deuda (`importe_exigible`); `mes_mas_deuda`: el total. Un período sin
  -- modo (calculado antes de `0080`) no tiene cupón propio y no se verifica.
  if v_cupon is not null then
    select count(*) into v_mal
      from liquidacion l
     where l.periodo_id = p_periodo
       and l.importe_cupon is distinct from (case when v_cupon = 'solo_mes' then l.importe_exigible else l.total end);
    if v_mal > 0 then
      raise exception 'el período no cuadra: hay % cupones cuyo importe no es el del modo del período (%)', v_mal, v_cupon;
    end if;
  elsif exists (select 1 from liquidacion l where l.periodo_id = p_periodo and l.importe_cupon is not null) then
    raise exception 'el período no cuadra: hay cupones con importe propio y el período no tiene modo de cupón';
  end if;

  -- [0081] La bonificación que aplica la regla del barrio existe solo si el mes bonifica solo, y es
  -- siempre el concepto de la regla: nadie la cuela a mano con ese rótulo.
  select count(*) into v_mal
    from concepto_boleta_unidad c
    join concepto_boleta cb on cb.id = c.concepto_boleta_id
   where c.periodo_id = p_periodo and c.anulado_at is null and c.origen_evaluacion = 'regla_barrio'
     and (v_bonif_modo is distinct from 'sola' or cb.regla_barrio is null);
  if v_mal > 0 then
    raise exception 'el período no cuadra: hay % bonificaciones marcadas como regla del barrio que la regla no aplicó', v_mal;
  end if;

  -- [0081] En un mes que bonifica solo, la bonificación la decide la regla y nadie más (panel
  -- `security-engineer`, 1 y 2): no se carga a mano con el concepto de la regla, no la tiene una unidad
  -- a la que la administración se la quitó, y su valor es el de «Cómo se devenga» congelado en el
  -- período —no otro que alguien haya cargado en el catálogo sin motivo ni firma—.
  if v_bonif_modo = 'sola' then
    select count(*) into v_mal
      from concepto_boleta_unidad c
      join concepto_boleta cb on cb.id = c.concepto_boleta_id
     where c.periodo_id = p_periodo and c.anulado_at is null
       and cb.regla_barrio is not null and c.origen_evaluacion <> 'regla_barrio';
    if v_mal > 0 then
      raise exception 'el período no cuadra: hay % bonificaciones por pago en término cargadas a mano en un mes que las aplica solo', v_mal;
    end if;

    select count(*) into v_mal
      from concepto_boleta_unidad c
      join concepto_boleta cb on cb.id = c.concepto_boleta_id
      join bonificacion_excepcion e on e.periodo_id = c.periodo_id and e.unidad_funcional_id = c.unidad_funcional_id
     where c.periodo_id = p_periodo and c.anulado_at is null
       and cb.regla_barrio is not null and e.tipo = 'quitar';
    if v_mal > 0 then
      raise exception 'el período no cuadra: hay % unidades con la bonificación aplicada y una excepción que se la quita', v_mal;
    end if;

    select count(*) into v_mal
      from concepto_boleta_unidad c
     where c.periodo_id = p_periodo and c.anulado_at is null and c.origen_evaluacion = 'regla_barrio'
       and ((c.metodo = 'porcentaje') is distinct from (v_bonif_forma = 'porcentaje')
            or coalesce(c.porcentaje, c.monto_fijo) is distinct from v_bonif_valor
            or c.tope is distinct from v_bonif_tope);
    if v_mal > 0 then
      raise exception 'el período no cuadra: hay % bonificaciones cuyo valor no es el de cómo se devenga este mes', v_mal;
    end if;
  end if;

  -- [0084] Lo que vino de una planilla de usos: la cantidad del renglón es la suma de sus usos, ni un
  -- uso más ni uno menos. Y un renglón de planilla sin usos no existe.
  select count(*) into v_mal
    from concepto_boleta_unidad c
   where c.periodo_id = p_periodo and c.anulado_at is null and c.origen_evaluacion = 'planilla'
     and c.cantidad is distinct from (select sum(u.cantidad) from concepto_boleta_unidad_uso u where u.aplicacion_id = c.id);
  if v_mal > 0 then
    raise exception 'el período no cuadra: hay % renglones de planilla cuya cantidad no es la suma de sus usos', v_mal;
  end if;

  -- [0084] Lo que el catálogo aplicó solo es de un concepto que se aplica solo: nadie lo carga a mano
  -- con ese rótulo.
  select count(*) into v_mal
    from concepto_boleta_unidad c
    join concepto_boleta cb on cb.id = c.concepto_boleta_id
   where c.periodo_id = p_periodo and c.anulado_at is null and c.origen_evaluacion = 'catalogo_sola'
     and cb.modo_mes is distinct from 'sola';
  if v_mal > 0 then
    raise exception 'el período no cuadra: hay % conceptos marcados como aplicados solos que el catálogo no aplica solos', v_mal;
  end if;

  -- Piso de cero: una boleta negativa no es un descuento, es una nota de crédito (otro artefacto).
  if exists (
    select 1 from liquidacion
     where periodo_id = p_periodo
       and subtotal_cuota_fija + subtotal_ordinarias + subtotal_extraordinarias
           + subtotal_fondo_reserva + subtotal_cargos + subtotal_descuentos < 0
  ) then
    raise exception 'hay unidades cuyo neto del período quedaría negativo';
  end if;
end; $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 11. La imputación automática (v3): la cuota del plan según el parámetro del barrio
--
-- Copia de `0088` con dos cambios marcados `[0093]`:
--   · Después de la regla de intereses de siempre, el grupo: con `cuota_primero` (el default) las
--     cuotas del plan van antes que el resto; con `expensa_primero`, después.
--   · El desempate es determinístico y no depende del orden de creación: vencimiento, mes y el id
--     (antes, `created_at`). Una cuota y una expensa del mismo día se imputan igual las cree quien
--     las cree primero.
-- La imputación manual no pasa por acá: sigue siendo la que elige el deudor.
-- ---------------------------------------------------------------------------------------------
create or replace function app.resolver_imputacion(p_pago_id uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_barrio      uuid;
  v_unidad      uuid;
  v_monto       numeric(14,2);
  v_fecha       date;
  v_anulado     timestamptz;
  v_orden       text;
  v_plan_orden  text; -- [0093]
  v_remanente   numeric(14,2);
  v_a_imputar   numeric(14,2);
  v_pasada      int;
  r             record;
begin
  select barrio_id, unidad_funcional_id, monto, fecha, anulado_at
    into v_barrio, v_unidad, v_monto, v_fecha, v_anulado
    from pago where id = p_pago_id for update;

  if v_barrio is null or not app.has_role_on(v_barrio,
      array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) then
    raise exception 'el pago no existe o no es de este barrio';
  end if;
  if v_anulado is not null then
    raise exception 'ese pago está anulado: no se le puede imputar nada';
  end if;
  -- [0093] El pago de un plan lo imputa solo su plan (la firma o la caída), con el monto que calculan.
  if exists (select 1 from pago where id = p_pago_id and origen = 'plan') then
    raise exception 'el pago de un plan lo imputa solo su plan';
  end if;

  select x.valor #>> '{}' into v_orden
    from app.parametro_resuelto_interno(v_barrio, 'imputacion.orden', v_fecha) x;
  if v_orden is null then
    raise exception 'el barrio no tiene orden de imputación configurado: cargalo antes de imputar este pago';
  end if;
  -- [0093]
  v_plan_orden := coalesce((select orden_imputacion from plan_parametro_barrio where barrio_id = v_barrio), 'cuota_primero');

  v_remanente := v_monto
    - coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = p_pago_id and anulado_at is null), 0)
    - coalesce((select sum(monto_imputado) from pago_imputacion_interes where pago_id = p_pago_id and anulado_at is null), 0);
  if v_remanente <= 0 then
    return;
  end if;

  for v_pasada in 1..2 loop
    exit when v_remanente <= 0;
    if (v_pasada = 1) = (v_orden = 'intereses_primero_capital_antiguo') then
      for r in
        select d.id, app.interes_pendiente(d.id) as saldo
          from interes_devengado d
         where d.unidad_funcional_id = v_unidad and d.monto > 0
         order by d.hasta asc, d.created_at asc, d.id asc
      loop
        exit when v_remanente <= 0;
        continue when r.saldo <= 0;
        v_a_imputar := least(v_remanente, r.saldo);
        insert into pago_imputacion_interes (pago_id, interes_id, monto_imputado) values (p_pago_id, r.id, v_a_imputar);
        v_remanente := v_remanente - v_a_imputar;
      end loop;
    else
      for r in
        select l.id,
               l.importe_exigible - coalesce((
                 select sum(pi.monto_imputado) from pago_imputacion pi
                  where pi.liquidacion_id = l.id and pi.anulado_at is null
               ), 0) as saldo
          from liquidacion l
          join periodo_expensa pe on pe.id = l.periodo_id
         where l.unidad_funcional_id = v_unidad
           and pe.estado in ('emitida', 'distribuida')
         order by
           case when v_orden = 'intereses_primero_capital_antiguo' and coalesce(l.interes_mora, 0) > 0
                     and l.saldo_anterior_origen <> 'calculado'
                then 0 else 1 end,
           -- [0093] La cuota del plan, antes o después del resto según el barrio.
           case when pe.origen = 'plan' then (case when v_plan_orden = 'cuota_primero' then 0 else 2 end) else 1 end,
           coalesce(l.vencimiento, pe.primer_vencimiento, (pe.periodo || '-01')::date) asc,
           pe.periodo asc,
           l.id asc
      loop
        exit when v_remanente <= 0;
        continue when r.saldo <= 0;
        v_a_imputar := least(v_remanente, r.saldo);
        insert into pago_imputacion (pago_id, liquidacion_id, monto_imputado) values (p_pago_id, r.id, v_a_imputar);
        v_remanente := v_remanente - v_a_imputar;
      end loop;
    end if;
  end loop;
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 12. Dueños, permisos y RLS (forma de `0018`)
-- ---------------------------------------------------------------------------------------------
do $bloque$
declare f text;
begin
  -- Las que escriben lo que nadie más puede escribir: dueño `app_job` (el `current_user` de adentro).
  foreach f in array array['plan_emitir_cuotas(uuid)', 'plan_cuotas_al_emitir()', 'plan_crear_pago(uuid, numeric, date)',
                           'plan_firmar(uuid, uuid)', 'plan_cerrar_pendiente(uuid, text, text)', 'plan_cumplir_si_corresponde()',
                           'plan_caer_preparar(uuid)', 'plan_caer_cancelar_cuotas(uuid, uuid)', 'plan_caer_cerrar(uuid, numeric, jsonb)'] loop
    execute format('alter function app.%s owner to app_job', f);
    execute format('revoke execute on function app.%s from public', f);
    execute format('grant execute on function app.%s to app_request, app_job', f);
  end loop;
  foreach f in array array['plan_pago_antes()', 'plan_parte_antes()', 'plan_solo_agregar()', 'plan_evento_antes()',
                           'plan_config_antes()', 'plan_catalogo_barrio_antes()', 'plan_bloqueo_anulacion()', 'pago_de_plan_antes()',
                           'saldo_de_liquidacion(uuid)'] loop
    execute format('revoke execute on function app.%s from public', f);
    execute format('grant execute on function app.%s to app_request, app_job', f);
  end loop;
end
$bloque$;
--> statement-breakpoint

-- Lo que las funciones dueñas `app_job` escriben fuera de sus tablas.
grant select, insert, update on table pago, pago_imputacion, pago_imputacion_interes to app_job;
--> statement-breakpoint
grant select, insert, update on table periodo_expensa, liquidacion, item_liquidacion to app_job;
--> statement-breakpoint
grant update (retiro_motivo, retiro_nota) on table derivacion to app_job;
--> statement-breakpoint
grant select, insert, update on table plan_pago, plan_cuota, plan_liquidacion, plan_evento to app_job;
--> statement-breakpoint
grant select on table plan_catalogo, plan_catalogo_barrio, plan_parametro_barrio to app_job;
--> statement-breakpoint

do $bloque$
declare t text;
begin
  foreach t in array array['plan_catalogo', 'plan_catalogo_barrio', 'plan_parametro_barrio', 'plan_pago', 'plan_liquidacion',
                           'plan_cuota', 'plan_evento'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end
$bloque$;
--> statement-breakpoint

-- El catálogo vive en la administración (como el criterio de mora, `0091`).
create policy plan_catalogo_sel on plan_catalogo for select
  using (administracion_id in (select app.readable_tenant_ids()) or administracion_id in (select app.readable_admin_ancestros()));
--> statement-breakpoint
create policy plan_catalogo_ins on plan_catalogo for insert with check (administracion_id in (select app.administraciones_administradas()));
--> statement-breakpoint
create policy plan_catalogo_upd on plan_catalogo for update
  using (administracion_id in (select app.administraciones_administradas()))
  with check (administracion_id in (select app.administraciones_administradas()));
--> statement-breakpoint
create policy plan_catalogo_barrio_sel on plan_catalogo_barrio for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy plan_catalogo_barrio_ins on plan_catalogo_barrio for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
create policy plan_catalogo_barrio_del on plan_catalogo_barrio for delete
  using (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
create policy plan_parametro_barrio_sel on plan_parametro_barrio for select using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy plan_parametro_barrio_ins on plan_parametro_barrio for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
create policy plan_parametro_barrio_upd on plan_parametro_barrio for update
  using (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]))
  with check (app.has_role_on(barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]));
--> statement-breakpoint

-- El plan: lo lee la gestión del barrio; lo propone la administración (los cambios, sus funciones).
do $bloque$
declare t text;
begin
  foreach t in array array['plan_pago', 'plan_liquidacion', 'plan_cuota', 'plan_evento'] loop
    execute format('create policy %I on %I for select using (barrio_id in (select app.readable_tenant_ids()))', t || '_sel', t);
  end loop;
  foreach t in array array['plan_pago', 'plan_liquidacion', 'plan_cuota'] loop
    execute format('create policy %I on %I for insert with check (app.has_role_on(barrio_id, array[''admin_plataforma'', ''admin_barrio'']::app.rol_membership[]))', t || '_ins', t);
  end loop;
  foreach t in array array['plan_liquidacion', 'plan_cuota'] loop
    execute format('create policy %I on %I for delete using (app.has_role_on(barrio_id, array[''admin_plataforma'', ''admin_barrio'']::app.rol_membership[]))', t || '_del', t);
  end loop;
end
$bloque$;
--> statement-breakpoint
grant select, insert on table plan_pago to app_request;
--> statement-breakpoint
grant select, insert, delete on table plan_liquidacion, plan_cuota to app_request;
--> statement-breakpoint
grant select on table plan_evento to app_request;
--> statement-breakpoint
grant select, insert on table plan_catalogo, plan_parametro_barrio to app_request;
--> statement-breakpoint
grant update (nombre, sistema, tasa_mensual, cuotas_min, cuotas_max, anticipo, anticipo_max_pct, deuda_maxima, estudio_id, modo_cobro, activo)
  on table plan_catalogo to app_request;
--> statement-breakpoint
grant update (cuotas_para_caer, orden_imputacion) on table plan_parametro_barrio to app_request;
--> statement-breakpoint
grant select, insert, delete on table plan_catalogo_barrio to app_request;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 13. Cerrojos (revisión de seguridad): el pago no monetario no se puede fabricar ni usar suelto
--
--   · `plan_emitir_cuotas` la llama solo el trigger de emisión y la firma (como `app_job`): sin
--     permiso para `app_request`, nadie la invoca sobre un barrio ajeno.
--   · Una imputación de un pago de origen `plan` la escribe solo `app_job` (la firma y la caída, que
--     calculan el monto). Ni `resolver_imputacion` ni una imputación manual lo tocan.
--   · Al terminar la transacción (diferido): un pago de origen `plan` está anulado o imputado entero;
--     y un plan caído no tiene cuotas emitidas con saldo y tiene su evento `caido`. Un pedazo de la
--     secuencia, suelto, no se puede confirmar.
-- ---------------------------------------------------------------------------------------------
revoke execute on function app.plan_emitir_cuotas(uuid) from app_request;
--> statement-breakpoint

create or replace function app.plan_imputacion_de_su_plan() returns trigger
  language plpgsql security invoker set search_path = public, app
as $$
begin
  if current_user::text <> 'app_job' and exists (select 1 from pago where id = new.pago_id and origen = 'plan') then
    raise exception 'el pago de un plan lo imputa solo su plan' using errcode = '42501';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_pago_imputacion_zz_de_su_plan before insert on pago_imputacion
  for each row execute function app.plan_imputacion_de_su_plan();
--> statement-breakpoint
create trigger trg_pago_imputacion_interes_zz_de_su_plan before insert on pago_imputacion_interes
  for each row execute function app.plan_imputacion_de_su_plan();
--> statement-breakpoint

create or replace function app.plan_pago_cerrado() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare v_pago pago;
begin
  select * into v_pago from pago where id = new.id;
  if v_pago.id is null or v_pago.origen <> 'plan' or v_pago.anulado_at is not null then
    return null;
  end if;
  if v_pago.monto <> coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = v_pago.id and anulado_at is null), 0)
                  + coalesce((select sum(monto_imputado) from pago_imputacion_interes where pago_id = v_pago.id and anulado_at is null), 0) then
    raise exception 'el pago de un plan se imputa entero en la misma operación';
  end if;
  return null;
end; $$;
--> statement-breakpoint
create constraint trigger trg_pago_zz_plan_cerrado after insert on pago deferrable initially deferred
  for each row when (new.origen = 'plan') execute function app.plan_pago_cerrado();
--> statement-breakpoint

create or replace function app.plan_caida_completa() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
begin
  if (select estado from plan_pago where id = new.id) <> 'caido' then
    return null;
  end if;
  if not exists (select 1 from plan_evento where plan_id = new.id and tipo = 'caido')
     or exists (select 1 from plan_cuota c where c.plan_id = new.id and c.liquidacion_id is not null
                   and app.saldo_de_liquidacion(c.liquidacion_id) > 0) then
    raise exception 'la caída de un plan se hace entera en la misma operación';
  end if;
  return null;
end; $$;
--> statement-breakpoint
create constraint trigger trg_plan_pago_zz_caida_completa after update on plan_pago deferrable initially deferred
  for each row when (new.estado = 'caido' and old.estado is distinct from 'caido') execute function app.plan_caida_completa();
--> statement-breakpoint

do $bloque$
declare f text;
begin
  foreach f in array array['plan_pago_cerrado()', 'plan_caida_completa()'] loop
    execute format('alter function app.%s owner to app_job', f);
    execute format('revoke execute on function app.%s from public', f);
  end loop;
  revoke execute on function app.plan_imputacion_de_su_plan() from public;
  grant execute on function app.plan_imputacion_de_su_plan() to app_request, app_job;
end
$bloque$;
