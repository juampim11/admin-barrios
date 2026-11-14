-- =============================================================================================
-- 0078_vencimientos_y_padron — encargo 15 (Etapa 1.1 y 1.2 del plan de la demo del 12/11).
--
-- Solo DDL: columnas nuevas (todas nulas), checks, un índice, un trigger de guarda, la función de
-- congelamiento del período y el `check` del historial del padrón. **No cambia ni una fila.**
--
--   1. El barrio configura sus vencimientos una vez: días del primero al segundo vencimiento y días
--      de corte desde el último (vacío = no usa). Junto a `dia_vencimiento`, que hasta acá solo se
--      cargaba en el alta: las tres columnas se abren para escribir y las cuida un trigger (solo la
--      administración del barrio), porque el grant de columna no distingue roles de negocio (`0050` §3).
--   2. El representante de un barrio «Sin entidad constituida» (`0077`): nombre y carácter.
--   3. `periodo_expensa.fecha_corte`: hasta cuándo se puede pagar la boleta del período. No puede ser
--      anterior al último vencimiento, y se congela al emitir como los vencimientos (`0072`).
--   4. La unidad gana su número de acción (único en el barrio cuando está cargado) y un residente o
--      inquilino informativo. **El residente es solo un dato**: la boleta, el envío y la deuda van
--      siempre al propietario. No se lo usa como destinatario de nada.
--   5. `padron_evento` acepta `configuracion_barrio` (el cambio de vencimientos del barrio).
--
-- `fecha_corte` NO entra en el cálculo de mora ni en `fechaTope` de la boleta (encargo 15, paso 2.f):
-- el interés sigue corriendo desde `primer_vencimiento`.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. Los vencimientos del barrio
-- ---------------------------------------------------------------------------------------------
alter table barrio
  add column dias_segundo_vencimiento smallint,
  add column dias_corte smallint;
--> statement-breakpoint
alter table barrio add constraint barrio_dias_segundo_vencimiento_chk
  check (dias_segundo_vencimiento is null or dias_segundo_vencimiento between 1 and 60);
--> statement-breakpoint
-- 0 = el corte es el mismo día del último vencimiento.
alter table barrio add constraint barrio_dias_corte_chk
  check (dias_corte is null or dias_corte between 0 and 180);
--> statement-breakpoint
comment on column barrio.dias_segundo_vencimiento is
  'Días del primer al segundo vencimiento (mismo importe). NULL: el barrio no usa segundo vencimiento.';
--> statement-breakpoint
comment on column barrio.dias_corte is
  'Días de corte, contados desde el último vencimiento. NULL: sin corte.';
--> statement-breakpoint

-- `grant` de columna es incremental (lo que rehace la lista entera es el `revoke`, `0050` §3): estas
-- tres se suman a las que ya tenía `app_request` sin tocar las otras. ⚠ Una migración futura que haga
-- `revoke update on barrio` + lista (el patrón de `0047`/`0050`) tiene que volver a nombrar estas tres;
-- lo vigila `exportaciones-rls.test.ts` («las 20 columnas escribibles»).
grant update (dia_vencimiento, dias_segundo_vencimiento, dias_corte) on table barrio to app_request;
--> statement-breakpoint

-- La policy de UPDATE de `barrio` (`0003`) habilita también a `operador`. Los vencimientos del
-- barrio son de la administración: un trigger lo hace cumplir (el mismo patrón que la cuenta de la
-- unidad, `app.uf_cuenta_unica`). Las cargas sin identidad (seed, mantenimiento) no tienen usuario.
-- `security invoker` (panel `security-engineer`, I1): no lee nada que quien escribe no pueda leer, y
-- `app.has_role_on` ya es ejecutable por `app_request`. Sin dueño `app_job` no hay privilegio de más.
create or replace function app.barrio_vencimientos_de_la_administracion() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if (new.dia_vencimiento, new.dias_segundo_vencimiento, new.dias_corte)
     is not distinct from (old.dia_vencimiento, old.dias_segundo_vencimiento, old.dias_corte) then
    return new;
  end if;
  if app.current_user_id() is not null
     and not app.has_role_on(new.barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
    raise exception 'los vencimientos del barrio los configura la administración (admin_barrio o admin_plataforma)'
      using errcode = '42501';
  end if;
  return new;
end; $$;
--> statement-breakpoint
revoke execute on function app.barrio_vencimientos_de_la_administracion() from public;
--> statement-breakpoint
create trigger trg_barrio_vencimientos before update of dia_vencimiento, dias_segundo_vencimiento, dias_corte on barrio
  for each row execute function app.barrio_vencimientos_de_la_administracion();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. El representante de un barrio sin entidad constituida
-- ---------------------------------------------------------------------------------------------
alter table barrio
  add column representante_nombre text,
  add column representante_caracter text;
--> statement-breakpoint
alter table barrio add constraint barrio_representante_nombre_chk
  check (representante_nombre is null or length(btrim(representante_nombre)) between 1 and 200);
--> statement-breakpoint
alter table barrio add constraint barrio_representante_caracter_chk
  check (representante_caracter is null or representante_caracter in ('delegado', 'comision'));
--> statement-breakpoint
-- `::text` contra el literal y no contra el enum: el valor de `0077` todavía no se puede usar como
-- enum en esta transacción (ver el encabezado de `0077`).
alter table barrio add constraint barrio_sin_entidad_con_representante_chk
  check (figura_juridica::text <> 'sin_entidad' or (representante_nombre is not null and representante_caracter is not null));
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. La fecha de corte del período
-- ---------------------------------------------------------------------------------------------
alter table periodo_expensa add column fecha_corte date;
--> statement-breakpoint
-- No antes del último vencimiento; y sin vencimiento no hay corte del que hablar.
alter table periodo_expensa add constraint periodo_fecha_corte_chk
  check (fecha_corte is null
         or (primer_vencimiento is not null and fecha_corte >= coalesce(segundo_vencimiento, primer_vencimiento)));
--> statement-breakpoint
comment on column periodo_expensa.fecha_corte is
  'Hasta cuándo se puede pagar la boleta del período (se imprime). No entra en la mora: el interés corre desde primer_vencimiento.';
--> statement-breakpoint

-- `app.periodo_emitido_inmutable` es copia de la versión de `0072` (que a su vez copiaba la de
-- `0053`); lo único nuevo está marcado `[0078]`.
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

  return new;
end;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. La unidad: número de acción y residente informativo
-- ---------------------------------------------------------------------------------------------
alter table unidad_funcional
  add column numero_accion text,
  add column residente_nombre text,
  add column residente_caracter text,
  add column residente_telefono text,
  add column residente_email text;
--> statement-breakpoint
alter table unidad_funcional add constraint uf_numero_accion_chk
  check (numero_accion is null or length(btrim(numero_accion)) between 1 and 30);
--> statement-breakpoint
-- Único dentro del barrio cuando está cargado, sin importar mayúsculas ni espacios de los costados
-- (el mismo criterio que manzana y lote, `0065`).
create unique index uq_uf_barrio_numero_accion on unidad_funcional (barrio_id, upper(btrim(numero_accion)))
  where numero_accion is not null;
--> statement-breakpoint
alter table unidad_funcional add constraint uf_residente_nombre_chk
  check (residente_nombre is null or length(btrim(residente_nombre)) between 1 and 200);
--> statement-breakpoint
alter table unidad_funcional add constraint uf_residente_caracter_chk
  check (residente_caracter is null or residente_caracter in ('inquilino', 'residente', 'otro'));
--> statement-breakpoint
alter table unidad_funcional add constraint uf_residente_telefono_chk
  check (residente_telefono is null or residente_telefono ~ '^\+?[0-9 ()-]{6,25}$');
--> statement-breakpoint
alter table unidad_funcional add constraint uf_residente_email_chk
  check (residente_email is null or (length(residente_email) <= 120 and residente_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));
--> statement-breakpoint
-- Sin nombre no hay residente: un carácter, un teléfono o un mail sueltos se guardarían sin que
-- ninguna pantalla los muestre (la ficha muestra el residente por su nombre).
alter table unidad_funcional add constraint uf_residente_con_nombre_chk
  check (residente_nombre is not null or (residente_caracter is null and residente_telefono is null and residente_email is null));
--> statement-breakpoint
comment on column unidad_funcional.residente_nombre is
  'Residente o inquilino, SOLO informativo: la boleta, el envío y la deuda van siempre al propietario.';
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. El historial del padrón registra el cambio de vencimientos del barrio
-- ---------------------------------------------------------------------------------------------
alter table padron_evento drop constraint padron_evento_tipo_chk;
--> statement-breakpoint
alter table padron_evento add constraint padron_evento_tipo_chk check (tipo in (
  'alta_barrio', 'alta', 'alta_planilla', 'edicion', 'correccion_planilla', 'cambio_titular', 'baja',
  'version_coeficientes', 'exportacion', 'configuracion_barrio'
));
--> statement-breakpoint
alter table padron_evento drop constraint padron_evento_unidad_chk;
--> statement-breakpoint
alter table padron_evento add constraint padron_evento_unidad_chk
  check ((unidad_funcional_id is null) = (tipo in ('alta_barrio', 'version_coeficientes', 'exportacion', 'configuracion_barrio')));
