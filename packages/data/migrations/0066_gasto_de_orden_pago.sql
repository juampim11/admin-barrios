-- =============================================================================================
-- 0066_gasto_de_orden_pago — los gastos que vienen de una orden de pago (encargo 8, T0).
--
-- Solo esquema (funciones y un trigger): no cambia ni una fila existente.
--
--   1. `app.orden_pago_transicion()`: al anular una OP cuyo período de origen está en `revisada`, el
--      gasto se borra igual que en `borrador` (los dos son editables; antes `revisada` caía en la
--      rama de "ya emitido" y asentaba un ajuste en otro período: P4). Y el ajuste que se asienta en
--      el borrador abierto se describe «Anulación de la OP de {proveedor}, factura {n.º}», sin el
--      uuid de la orden (P2). Las filas ya escritas con el texto viejo no se tocan.
--   2. `app.gasto_de_orden_pago_intacto()`: un gasto que vino de una OP (el cargo o el ajuste de su
--      anulación) no se borra ni se le cambia importe, concepto, período, proveedor ni la orden de la
--      que vino (P3); y desde la app no se inserta un gasto con marca de orden ni se le pone la marca a
--      uno manual (security-engineer, M1: se podría fabricar un ajuste negativo). Lo único que lo borra es la anulación de la propia orden, que lo hace desde el trigger
--      de `orden_pago` —por eso la excepción es `pg_trigger_depth() > 1`: un `delete` del request
--      corre a profundidad 1; el de la anulación, adentro de otro trigger—. Descripción y comprobante
--      siguen editables: no mueven plata. Vale para los roles de la aplicación (los miembros de
--      `app_request` y `app_job`); el dueño del esquema y los superusuarios no la pasan.
--
-- El resto de `app.orden_pago_transicion()` es idéntico a `0048_orden_pago_factura.sql`.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. La transición de la orden de pago
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

    -- Misma excepción para la factura del proveedor (0048) — mismo motivo que el comprobante.
    if old.factura_adjunta is not null
       and new.factura_adjunta is distinct from old.factura_adjunta then
      raise exception 'la factura ya adjunta no se reemplaza: anulá y cargá una nueva orden';
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
    -- por `admin_barrio` (`0047`).
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

      if v_estado_periodo_origen in ('borrador', 'revisada') then
        -- El período de origen sigue abierto (borrador o revisada, los dos editables para
        -- `app.periodo_editable()`; 0066, P4): se borra directo y el borrador se regenera.
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
               -- Sin el uuid (0066, P2): el texto lo lee el administrador en la lista de gastos.
               'Anulación de la OP de ' || p.razon_social || ', '
                 || coalesce('factura ' || nullif(btrim(new.numero_factura), ''), 'sin número de factura'),
               -new.monto, p.razon_social, new.id, v_gasto_original
          from proveedor p where p.id = new.proveedor_id;
      end if;
    end if;

  elsif new.estado = 'conciliada' then
    new.conciliada_at := now();
    new.conciliada_por := v_usuario;
  end if;

  return new;
end; $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. El gasto de una orden de pago queda como lo dejó la orden
-- ---------------------------------------------------------------------------------------------
create or replace function app.gasto_de_orden_pago_intacto() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, app
as $$
begin
  -- Solo para los roles de la aplicación: la migración, el seed y la limpieza de los tests corren con
  -- el dueño del esquema. Por PERTENENCIA y no por nombre: el login de la app es un rol miembro de
  -- `app_request` (`app_request_dev` en local) y comparar `current_user` con el nombre lo dejaría
  -- afuera. Un superusuario es miembro de todo, por eso se excluye aparte.
  if coalesce((select r.rolsuper from pg_roles r where r.rolname = current_user), false)
     or not (pg_has_role(current_user, 'app_request', 'member') or pg_has_role(current_user, 'app_job', 'member')) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- Lo que hace el trigger de `orden_pago` (el cargo al aprobar, el ajuste o el borrado al anular).
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    -- Un gasto con marca de orden de pago solo lo escribe la orden: a mano se podría fabricar un
    -- "ajuste" negativo (el CHECK de 0045 lo admite con las dos referencias).
    if new.orden_pago_id is not null or new.gasto_periodo_origen_id is not null then
      raise exception 'un gasto que vino de una orden de pago no se borra ni se modifica: se anula la orden';
    end if;
    return new;
  end if;

  if old.orden_pago_id is null and old.gasto_periodo_origen_id is null then
    -- Un gasto manual sigue siendo manual: no se le pone la marca de una orden.
    if tg_op = 'UPDATE' and (new.orden_pago_id is not null or new.gasto_periodo_origen_id is not null) then
      raise exception 'un gasto que vino de una orden de pago no se borra ni se modifica: se anula la orden';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'un gasto que vino de una orden de pago no se borra ni se modifica: se anula la orden';
  end if;
  -- El proveedor también: es el que nombra el ajuste en la boleta (security-engineer, M2).
  if (new.monto, new.concepto_id, new.periodo_id, new.orden_pago_id, new.gasto_periodo_origen_id, new.barrio_id, new.proveedor_nombre)
     is distinct from
     (old.monto, old.concepto_id, old.periodo_id, old.orden_pago_id, old.gasto_periodo_origen_id, old.barrio_id, old.proveedor_nombre) then
    raise exception 'un gasto que vino de una orden de pago no se borra ni se modifica: se anula la orden';
  end if;
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_gasto_de_orden_pago_intacto before insert or update or delete on gasto_periodo
  for each row execute function app.gasto_de_orden_pago_intacto();
