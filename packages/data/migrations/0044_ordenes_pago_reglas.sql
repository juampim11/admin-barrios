-- =============================================================================================
-- 0044_ordenes_pago_reglas — quién puede escribir y leer `orden_pago`, el candado anti-cruce entre
-- barrios, y el trigger de transición: congelamiento, gates de rol por transición, cuatro-ojos
-- configurable, y la generación/reversión de `gasto_periodo`.
--
-- Diseño: panel `arquitecto-software` + `dba-data` + `security-engineer` (revisión técnica) +
-- `administrador-consorcios` + `legal-ph` (autoridad de aprobación/cuatro-ojos), 2026-08-21.
--
-- **`app.orden_pago_transicion()` NO es `security definer`**, mismo criterio que `app.pago_antes()`
-- (`0034` §"NO es security definer"): no lee ninguna tabla de OTRO barrio — `barrio`,
-- `periodo_expensa` y `proveedor` se consultan siempre con el `barrio_id` ya validado de la propia
-- fila, y quien puede escribir esta fila ya tiene `has_role_on()` sobre ese barrio, así que también
-- puede leerlas bajo su propia RLS. `app.has_role_on()` es en sí misma `security definer`; no hace
-- falta que este trigger cargue un privilegio que no usa.
--
-- **El fail-closed contra un período ya emitido NO se duplica acá.** `app.periodo_editable()`
-- (`0023`) ya es `before insert or update or delete` sobre `gasto_periodo` y lanza sola si el
-- período de destino está `emitida`/`distribuida`. Como este trigger corre en la MISMA transacción
-- que el `insert`/`delete` sobre `gasto_periodo`, si ese candado dispara, la transacción entera
-- (incluida la propia transición de `orden_pago`) se revierte — la orden queda tal como estaba.
-- Repetir el chequeo acá sería una segunda fuente de verdad para la misma regla.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. FKs compuestas anti-cruce (patrón de 0003/0005/0016/0034): una orden de pago de un barrio no
--    puede colgar de un proveedor, un período o un concepto de otro barrio.
-- ---------------------------------------------------------------------------------------------
alter table orden_pago
  add constraint fk_orden_pago_proveedor_barrio foreign key (proveedor_id, barrio_id)
  references proveedor (id, barrio_id) on delete restrict;
--> statement-breakpoint

alter table orden_pago
  add constraint fk_orden_pago_periodo_barrio foreign key (periodo_id, barrio_id)
  references periodo_expensa (id, barrio_id) on delete restrict;
--> statement-breakpoint

alter table orden_pago
  add constraint fk_orden_pago_concepto_barrio foreign key (concepto_id, barrio_id)
  references concepto (id, barrio_id) on delete restrict;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. El trigger de transición.
-- ---------------------------------------------------------------------------------------------
create or replace function app.orden_pago_transicion() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_roles_aprobar constant app.rol_membership[] := array['admin_plataforma','admin_barrio']::app.rol_membership[];
  v_roles_gestion constant app.rol_membership[] := array['admin_plataforma','admin_barrio','operador']::app.rol_membership[];
  v_cuatro_ojos boolean;
  v_gasto_original uuid;
  v_estado_periodo_origen text;
  v_periodo_destino uuid;
  v_count integer;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: una orden de pago sin autor no se registra';
  end if;

  if tg_op = 'INSERT' then
    if not app.has_role_on(new.barrio_id, v_roles_gestion) then
      raise exception 'no tenés permiso para cargar órdenes de pago en este barrio';
    end if;
    -- El autor lo pone la base, nunca el cliente: es la columna que sostiene el control de
    -- cuatro-ojos al aprobar (mismo criterio que `usuario_registrador` en `app.pago_antes()`).
    new.creada_por := v_usuario;
    new.estado := 'pendiente';
    new.aprobada_at := null; new.aprobada_por := null;
    new.rechazada_at := null; new.rechazada_por := null;
    new.pagada_at := null; new.pagada_por := null;
    new.anulada_at := null; new.anulada_por := null; new.motivo_anulacion := null;
    new.conciliada_at := null; new.conciliada_por := null;
    return new;
  end if;

  -- De acá en más, tg_op = 'UPDATE'.

  if not app.has_role_on(new.barrio_id, v_roles_gestion) then
    raise exception 'no tenés permiso para modificar órdenes de pago en este barrio';
  end if;

  -- Congelamiento: fuera de `pendiente`, ninguna columna de negocio se edita. La única corrección
  -- post-aprobación es anular (con motivo) y cargar una orden nueva (administrador-consorcios,
  -- 2026-08-20) — mismo idioma que `app.pago_antes()` con la tupla completa de columnas.
  if old.estado <> 'pendiente' then
    if (new.proveedor_id, new.periodo_id, new.concepto_id, new.numero_factura, new.descripcion,
        new.monto, new.creada_por, new.creada_at)
       is distinct from
       (old.proveedor_id, old.periodo_id, old.concepto_id, old.numero_factura, old.descripcion,
        old.monto, old.creada_por, old.creada_at)
    then
      raise exception 'una orden de pago fuera de pendiente no se edita: anulá y cargá una nueva';
    end if;

    -- Excepción puntual: `medio_pago` llega recién en la transición a `pagada` (a diferencia de
    -- `pago`, donde llega resuelto en el insert) — se permite null → valor, nunca valor → otro.
    if old.medio_pago is not null and new.medio_pago is distinct from old.medio_pago then
      raise exception 'el medio de pago ya registrado no se reemplaza: anulá y cargá una nueva orden';
    end if;

    -- Misma excepción para el comprobante: se puede adjuntar DESPUÉS del alta, pero nunca se
    -- reemplaza uno ya adjunto.
    if old.comprobante_adjunto is not null
       and new.comprobante_adjunto is distinct from old.comprobante_adjunto then
      raise exception 'el comprobante ya adjunto no se reemplaza: anulá y cargá una nueva orden';
    end if;
  end if;

  if new.estado = old.estado then
    -- Nada más que validar: lo que había que congelar ya se congeló arriba.
    return new;
  end if;

  -- Lista blanca de transiciones (administrador-consorcios, 2026-08-20 — no hay vuelta atrás en
  -- ningún punto, y `pendiente` no es una transición: se edita en el lugar).
  if not (
       (old.estado = 'pendiente' and new.estado in ('aprobada','rechazada'))
    or (old.estado = 'aprobada'  and new.estado in ('pagada','anulada'))
    or (old.estado = 'pagada'    and new.estado in ('conciliada','anulada'))
  ) then
    -- Texto propio, distinto del de `app.periodo_transicion()` (`0011`): comparten la misma forma
    -- ("transición de estado inválida: % → %"), y `errores.ts` traduce por texto — si coincidieran,
    -- la regla de período (la primera en el catálogo) le robaría el match a esta.
    raise exception 'transición de estado inválida para una orden de pago: % → %', old.estado, new.estado;
  end if;

  if new.estado = 'aprobada' then
    -- Gate de rol: aprobar es decidir gastar. Reservado a admin_barrio/admin_plataforma —
    -- `operador` puede cargar pero no aprobar (security-engineer, panel).
    if not app.has_role_on(new.barrio_id, v_roles_aprobar) then
      raise exception 'aprobar una orden de pago es de un administrador del barrio';
    end if;

    -- Cuatro-ojos: configurable por barrio (administrador-consorcios + legal-ph, 2026-08-21 —
    -- ningún requisito normativo lo vuelve obligatorio para PH; el barrio de un solo admin_barrio
    -- es un caso real y común, no de borde). `barrio.orden_pago_cuatro_ojos` no es autoconfigurable
    -- por `admin_barrio` (`0048`).
    select orden_pago_cuatro_ojos into v_cuatro_ojos from barrio where barrio_id = new.barrio_id;
    if coalesce(v_cuatro_ojos, false) and old.creada_por = v_usuario then
      raise exception 'quien aprueba no puede ser quien cargó la orden (control de cuatro ojos activo en este barrio)';
    end if;

    new.aprobada_at := now();
    new.aprobada_por := v_usuario;

    -- El efecto contable: genera el gasto del período (criterio devengado, doc 10 §B — cuenta en el
    -- prorrateo aunque el pago físico todavía no se concretó). Si el período de destino ya no es
    -- editable, `app.periodo_editable()` lanza sola y la transacción entera se revierte.
    insert into gasto_periodo
      (barrio_id, periodo_id, concepto_id, descripcion, monto, proveedor_nombre, orden_pago_id)
    select new.barrio_id, new.periodo_id, new.concepto_id, new.descripcion, new.monto,
           p.razon_social, new.id
      from proveedor p where p.id = new.proveedor_id;

  elsif new.estado = 'rechazada' then
    if not app.has_role_on(new.barrio_id, v_roles_aprobar) then
      raise exception 'rechazar una orden de pago es de un administrador del barrio';
    end if;
    new.rechazada_at := now();
    new.rechazada_por := v_usuario;

  elsif new.estado = 'pagada' then
    -- Abierto a los tres roles de gestión: ejecutar un pago ya aprobado es tarea mecánica, no una
    -- decisión de gasto nueva (administrador-consorcios, 2026-08-21) — reservarla también a
    -- admin_barrio genera el mismo cuello de botella que termina resuelto compartiendo credenciales.
    new.pagada_at := now();
    new.pagada_por := v_usuario;

  elsif new.estado = 'anulada' then
    if new.motivo_anulacion is null then
      raise exception 'una anulación de orden de pago necesita motivo';
    end if;
    new.anulada_at := now();
    new.anulada_por := v_usuario;

    -- Reversión del gasto ya generado (si lo hay: una anulación desde `pagada` con OP que ya generó
    -- su cargo). El cargo original es la fila SIN `gasto_periodo_origen_id` producida por esta OP.
    select id into v_gasto_original
      from gasto_periodo
     where orden_pago_id = new.id and gasto_periodo_origen_id is null
     limit 1;

    if v_gasto_original is not null then
      select estado into v_estado_periodo_origen from periodo_expensa where id = new.periodo_id;

      if v_estado_periodo_origen = 'borrador' then
        -- El período de origen sigue abierto: se borra directo. `app.periodo_editable()` ya lo
        -- permite en este estado; no hace falta guardia propia acá.
        delete from gasto_periodo where id = v_gasto_original;
      else
        -- El período de origen ya no es editable: el ajuste va al período ABIERTO actual del
        -- barrio, nunca al de origen (dba-data, panel). Bloquear, no inventar, si no hay exactamente
        -- uno: elegir "el más nuevo" o crear uno de la nada es una decisión de negocio que un
        -- trigger de base no toma en silencio.
        select count(*) into v_count
          from periodo_expensa where barrio_id = new.barrio_id and estado = 'borrador';

        if v_count = 0 then
          raise exception 'no hay un período en borrador para asentar la reversión de esta orden de pago: abrí el período corriente antes de anular';
        elsif v_count > 1 then
          raise exception 'hay más de un período en borrador en este barrio: no se puede determinar dónde asentar la reversión de esta orden de pago';
        end if;

        select id into v_periodo_destino
          from periodo_expensa where barrio_id = new.barrio_id and estado = 'borrador';

        insert into gasto_periodo
          (barrio_id, periodo_id, concepto_id, descripcion, monto, proveedor_nombre,
           orden_pago_id, gasto_periodo_origen_id)
        select new.barrio_id, v_periodo_destino, new.concepto_id,
               'Reversión OP ' || new.id::text || ' — ' || new.descripcion,
               -new.monto, p.razon_social, new.id, v_gasto_original
          from proveedor p where p.id = new.proveedor_id;
      end if;
    end if;

  elsif new.estado = 'conciliada' then
    new.conciliada_at := now();
    new.conciliada_por := v_usuario;
  end if;

  return new;
end; $$;--> statement-breakpoint

create trigger trg_orden_pago_transicion before insert or update on orden_pago
  for each row execute function app.orden_pago_transicion();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. RLS. Lectura por `readable_tenant_ids()` (conjunto, no `has_role_on` por fila — mismo criterio
--    que `0018`); escritura (alta y transiciones) para los tres roles de gestión — los gates MÁS
--    finos por transición (quién aprueba/rechaza, cuatro-ojos) viven en el trigger, no en la policy,
--    porque dependen de la transición puntual, no de "puede tocar la fila en general"
--    (security-engineer, panel). Sin policy de DELETE: una orden de pago no se borra, se anula.
-- ---------------------------------------------------------------------------------------------
alter table orden_pago enable row level security;
--> statement-breakpoint
alter table orden_pago force row level security;
--> statement-breakpoint

create policy orden_pago_sel on orden_pago for select
  using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint

create policy orden_pago_ins on orden_pago for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

create policy orden_pago_upd on orden_pago for update
  using (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]))
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

grant select, insert, update on table orden_pago to app_request;
--> statement-breakpoint
grant select, insert, update, delete on table orden_pago to app_job;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. RLS de `proveedor` — mismo patrón que el resto del catálogo del barrio (`concepto`): lectura
--    por `readable_tenant_ids()`, escritura por los tres roles de gestión.
-- ---------------------------------------------------------------------------------------------
alter table proveedor enable row level security;
--> statement-breakpoint
alter table proveedor force row level security;
--> statement-breakpoint

create policy proveedor_sel on proveedor for select
  using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint

create policy proveedor_ins on proveedor for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

create policy proveedor_upd on proveedor for update
  using (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]))
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

grant select, insert, update on table proveedor to app_request;
--> statement-breakpoint
grant select, insert, update, delete on table proveedor to app_job;
