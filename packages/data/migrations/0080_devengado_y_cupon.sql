-- =============================================================================================
-- 0080_devengado_y_cupon — el esquema de «Cómo se devenga», la bonificación automática y el cupón
-- que cobra solo el mes (encargo 16, Etapa 1.3). **Solo DDL**: ninguna fila existente cambia.
--
--   1. `periodo_expensa`: cómo se devengó el mes (modo de cupón y bonificación), congelado al emitir.
--      `app.periodo_emitido_inmutable()` copiada ENTERA de `0078`; lo nuevo va marcado `[0080]`.
--   2. `liquidacion`: el importe del cupón, la deuda anterior mes por mes y la bonificación que la
--      unidad no recibió.
--   3. `cuota_fija_version.total_del_mes`: el importe definido por la administración y repartido
--      por coeficiente.
--   4. `concepto_boleta.regla_barrio` y el origen `regla_barrio` de una aplicación.
--   5. `bonificacion_excepcion`: «Dársela igual» y «Quitar», por unidad y por mes.
--   6. `padron_evento` acepta `excepcion_bonificacion` (queda en el historial de la unidad).
--
-- Todas las columnas nuevas son NULL en lo que ya existe, y NULL significa «anterior a este
-- encargo: como se hacía» —el cupón cobra el total, no hay desglose, no hay regla—.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. El período: cómo se devengó
-- ---------------------------------------------------------------------------------------------
alter table periodo_expensa add column cupon_cobra text;
--> statement-breakpoint
alter table periodo_expensa add column bonificacion_modo text;
--> statement-breakpoint
alter table periodo_expensa add column bonificacion_forma text;
--> statement-breakpoint
-- Un porcentaje (7.5 = 7,5 %) o un importe en pesos, según `bonificacion_forma`.
alter table periodo_expensa add column bonificacion_valor numeric(18,6);
--> statement-breakpoint
alter table periodo_expensa add column bonificacion_tope numeric(14,2);
--> statement-breakpoint
alter table periodo_expensa add constraint periodo_cupon_cobra_chk
  check (cupon_cobra is null or cupon_cobra in ('solo_mes', 'mes_mas_deuda'));
--> statement-breakpoint
alter table periodo_expensa add constraint periodo_bonificacion_modo_chk
  check (bonificacion_modo is null or bonificacion_modo in ('sola', 'a_mano', 'no'));
--> statement-breakpoint
alter table periodo_expensa add constraint periodo_bonificacion_forma_chk
  check (bonificacion_forma is null or bonificacion_forma in ('porcentaje', 'importe'));
--> statement-breakpoint
-- La bonificación que se aplica sola necesita con qué calcularse; forma y valor van juntos.
alter table periodo_expensa add constraint periodo_bonificacion_valor_chk
  check ((bonificacion_forma is null) = (bonificacion_valor is null)
         and (bonificacion_valor is null or bonificacion_valor > 0)
         and (bonificacion_tope is null or bonificacion_tope > 0)
         and (bonificacion_modo is distinct from 'sola' or bonificacion_forma is not null));
--> statement-breakpoint
comment on column periodo_expensa.cupon_cobra is
  'Qué cobra el cupón del mes: solo_mes (lo devengado en el mes) o mes_mas_deuda (el total). NULL = período anterior a 0080: el total. Se congela al emitir.';
--> statement-breakpoint
comment on column periodo_expensa.bonificacion_modo is
  'Cómo se bonificó el pago en término este mes: sola (regla del barrio al emitir), a_mano o no. NULL = período anterior a 0080. Se congela al emitir.';
--> statement-breakpoint

-- `app.periodo_emitido_inmutable` es copia de la versión de `0078`; lo único nuevo está marcado `[0080]`.
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

  /*
   * [0072] Los VENCIMIENTOS, que `0030` dejó afuera como «datos de gestión». No lo son: de
   * `primer_vencimiento` corre el interés por mora (`deudaALaFecha`, el interés devengado de `0064`).
   * Moverlo en un mes emitido cambia lo que se le cobra a cada unidad sin que la boleta emitida lo
   * diga (security-engineer, T2). El motivo del cambio (`0071`) se congela con ellos.
   */
  /*
   * [0078] La FECHA DE CORTE entra con los vencimientos: va impresa en la boleta («Se puede pagar
   * hasta el…»), así que moverla en un mes emitido cambiaría lo que dice un documento ya entregado.
   */
  if (new.primer_vencimiento, new.segundo_vencimiento, new.motivo_vencimientos, new.fecha_corte)
     is distinct from (old.primer_vencimiento, old.segundo_vencimiento, old.motivo_vencimientos, old.fecha_corte) then
    raise exception 'los vencimientos de un período % no se pueden cambiar: de ellos corre el interés', old.estado
      using errcode = '23514';
  end if;

  /*
   * [0080] CÓMO SE DEVENGÓ: qué cobra el cupón y cómo se bonificó. Se escriben al calcular (el
   * mismo acto que emite) y desde ahí no se tocan: de `cupon_cobra` sale el importe impreso en cada
   * cupón (`liquidacion.importe_cupon`) y de la bonificación, el descuento de cada unidad. Un cambio
   * en «Cómo se devenga» rige desde un mes sin emitir (`0079`); esto es el candado del otro lado.
   */
  if (new.cupon_cobra, new.bonificacion_modo, new.bonificacion_forma, new.bonificacion_valor, new.bonificacion_tope)
     is distinct from
     (old.cupon_cobra, old.bonificacion_modo, old.bonificacion_forma, old.bonificacion_valor, old.bonificacion_tope) then
    raise exception 'cómo se devengó un período % no se puede cambiar: el cupón y la bonificación ya se emitieron', old.estado
      using errcode = '23514';
  end if;

  return new;
end;
$$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. La liquidación: el cupón, la deuda anterior y la bonificación no recibida
--
-- `importe_cupon` NO es una columna generada porque depende del modo del período, que vive en otra
-- tabla. La escribe el cálculo y la verifica `app.validar_emision` (`0081`): con `solo_mes` es
-- `importe_exigible`; con `mes_mas_deuda`, `total`. Ni `total` ni `importe_exigible` cambian: la
-- cuenta corriente, el arrastre y la imputación siguen mirando lo mismo que antes.
-- ---------------------------------------------------------------------------------------------
alter table liquidacion add column importe_cupon numeric(14,2);
--> statement-breakpoint
alter table liquidacion add column deuda_anterior jsonb;
--> statement-breakpoint
alter table liquidacion add column bonificacion_no_aplicada numeric(14,2);
--> statement-breakpoint
alter table liquidacion add constraint liquidacion_importe_cupon_chk
  check (importe_cupon is null or importe_cupon >= 0);
--> statement-breakpoint
alter table liquidacion add constraint liquidacion_deuda_anterior_chk
  check (deuda_anterior is null or jsonb_typeof(deuda_anterior) = 'array');
--> statement-breakpoint
alter table liquidacion add constraint liquidacion_bonificacion_no_aplicada_chk
  check (bonificacion_no_aplicada is null or bonificacion_no_aplicada > 0);
--> statement-breakpoint
comment on column liquidacion.importe_cupon is
  'Lo que cobra el cupón de esta boleta. Con solo_mes, importe_exigible (lo devengado en el mes); con mes_mas_deuda, total. NULL = anterior a 0080: el total.';
--> statement-breakpoint
comment on column liquidacion.deuda_anterior is
  'La deuda de meses anteriores al calcular, mes por mes: [{periodo, vencimiento, capital, interes}], con el interés pegado al mes que lo generó. Suma el saldo anterior calculado y el interés por mora. NULL = sin desglose (anterior a 0080, o saldo cargado a mano).';
--> statement-breakpoint
comment on column liquidacion.bonificacion_no_aplicada is
  'La bonificación por pago en término que la unidad NO recibió este mes (no estaba al día, o se le quitó). NULL = la recibió, o el barrio no bonifica solo.';
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. La cuota: un total del mes repartido por coeficiente
--
-- Una versión con `total_del_mes` no tiene filas en `cuota_fija`: lo que paga cada unidad sale de
-- repartir el total por la versión de coeficientes que rige el mes, al calcular. Guardar además el
-- importe por unidad sería tener dos verdades: un coeficiente nuevo dejaría la guardada vieja.
-- ---------------------------------------------------------------------------------------------
alter table cuota_fija_version add column total_del_mes numeric(14,2);
--> statement-breakpoint
alter table cuota_fija_version add constraint cuota_fija_version_total_chk
  check (total_del_mes is null or total_del_mes >= 0);
--> statement-breakpoint
comment on column cuota_fija_version.total_del_mes is
  'El importe del mes para TODO el barrio, que se reparte por coeficiente al calcular. NULL = la versión define un importe por unidad (cuota_fija).';
--> statement-breakpoint

-- Una versión por total no lleva importes por unidad.
create or replace function app.cuota_fija_sin_total() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if exists (select 1 from cuota_fija_version v where v.id = new.version_id and v.total_del_mes is not null) then
    raise exception 'esta versión define un total del mes que se reparte por coeficiente: no lleva importes por unidad'
      using errcode = '23514';
  end if;
  return new;
end; $$;
--> statement-breakpoint
create trigger trg_cuota_fija_sin_total before insert or update on cuota_fija
  for each row execute function app.cuota_fija_sin_total();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. La regla del barrio en el catálogo y en la aplicación
--
-- La bonificación por pago en término es un `concepto_boleta` de clase descuento como cualquier
-- otro —mismo snapshot, mismos topes del operador, misma firma (`app.cbu_antes`, sin cambios)—. Lo
-- único que la distingue es que la aplica la regla del barrio al emitir, y eso se dice en dos
-- lugares: el concepto (`regla_barrio`) y cada aplicación (`origen_evaluacion = 'regla_barrio'`).
-- A lo sumo un concepto por regla y por método: el método del concepto no cambia (`0017`), así que
-- pasar de porcentaje a importe fijo usa otro concepto.
-- ---------------------------------------------------------------------------------------------
alter table concepto_boleta add column regla_barrio text;
--> statement-breakpoint
alter table concepto_boleta add constraint concepto_boleta_regla_chk
  check (regla_barrio is null or (regla_barrio in ('bonificacion_pago_en_termino') and clase = 'descuento'));
--> statement-breakpoint
create unique index uq_concepto_boleta_regla on concepto_boleta (barrio_id, regla_barrio, metodo)
  where regla_barrio is not null;
--> statement-breakpoint
comment on column concepto_boleta.regla_barrio is
  'El concepto lo aplica una regla del barrio al emitir (hoy solo bonificacion_pago_en_termino). NULL = se aplica a mano.';
--> statement-breakpoint

alter table concepto_boleta_unidad drop constraint cbu_origen_chk;
--> statement-breakpoint
alter table concepto_boleta_unidad add constraint cbu_origen_chk
  check (origen_evaluacion in ('carga_manual', 'override_administrador', 'regla_barrio'));
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 5. Las excepciones de la bonificación: por unidad y por mes, con motivo
--
-- Una fila por (mes, unidad): «dar» (dársela igual aunque no esté al día) o «quitar» (no dársela
-- aunque lo esté). No se edita: se saca y se carga otra, y las dos cosas quedan en el historial de
-- la unidad (`padron_evento`, que además exige que sea la administración del barrio). Se congela
-- con el mes: `app.periodo_editable()` rechaza cualquier cambio una vez emitido.
-- ---------------------------------------------------------------------------------------------
create table bonificacion_excepcion (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  periodo_id uuid not null,
  unidad_funcional_id uuid not null,
  tipo text not null,
  motivo text not null,
  creado_por uuid not null,
  created_at timestamptz not null default now(),
  constraint bonificacion_excepcion_tipo_chk check (tipo in ('dar', 'quitar')),
  constraint bonificacion_excepcion_motivo_chk check (length(btrim(motivo)) between 5 and 500),
  constraint uq_bonificacion_excepcion unique (periodo_id, unidad_funcional_id),
  constraint fk_bonificacion_excepcion_periodo foreign key (periodo_id, barrio_id)
    references periodo_expensa (id, barrio_id) on delete cascade,
  constraint fk_bonificacion_excepcion_uf foreign key (unidad_funcional_id, barrio_id)
    references unidad_funcional (id, barrio_id) on delete restrict
);
--> statement-breakpoint
create index idx_bonificacion_excepcion_barrio on bonificacion_excepcion (barrio_id);
--> statement-breakpoint

-- Quién y cuándo los pone la base. `security invoker`: no lee nada que quien escribe no pueda leer.
create or replace function app.bonificacion_excepcion_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'una excepción de la bonificación no se edita: se saca y se carga otra';
  end if;
  new.creado_por := app.current_user_id();
  if new.creado_por is null then
    raise exception 'una excepción de la bonificación se carga con una identidad';
  end if;
  new.created_at := now();
  return new;
end; $$;
--> statement-breakpoint
revoke execute on function app.bonificacion_excepcion_antes() from public;
--> statement-breakpoint
grant execute on function app.bonificacion_excepcion_antes() to app_request, app_job;
--> statement-breakpoint
create trigger trg_bonificacion_excepcion_antes before insert or update on bonificacion_excepcion
  for each row execute function app.bonificacion_excepcion_antes();
--> statement-breakpoint
create trigger trg_bonificacion_excepcion_editable before insert or update or delete on bonificacion_excepcion
  for each row execute function app.periodo_editable();
--> statement-breakpoint

alter table bonificacion_excepcion enable row level security;
--> statement-breakpoint
alter table bonificacion_excepcion force row level security;
--> statement-breakpoint
-- Lectura por rol de gestión (`app.readable_tenant_ids()`, `0018`): un propietario no lee las
-- excepciones de otras unidades ni sus motivos.
create policy bonificacion_excepcion_sel on bonificacion_excepcion for select
  using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy bonificacion_excepcion_ins on bonificacion_excepcion for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
create policy bonificacion_excepcion_del on bonificacion_excepcion for delete
  using (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]));
--> statement-breakpoint
grant select, insert, delete on table bonificacion_excepcion to app_request;
--> statement-breakpoint
grant select, insert, delete on table bonificacion_excepcion to app_job;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 6. El historial de la unidad registra la excepción (y cuando se saca)
-- ---------------------------------------------------------------------------------------------
alter table padron_evento drop constraint padron_evento_tipo_chk;
--> statement-breakpoint
alter table padron_evento add constraint padron_evento_tipo_chk check (tipo in (
  'alta_barrio', 'alta', 'alta_planilla', 'edicion', 'correccion_planilla', 'cambio_titular', 'baja',
  'version_coeficientes', 'exportacion', 'configuracion_barrio', 'excepcion_bonificacion'
));
