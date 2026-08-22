-- =============================================================================================
-- 0048_orden_pago_factura — la factura del proveedor, distinta del comprobante de pago del barrio
-- (gap 2), y la declaración deliberada de "esta orden nunca va a tener factura" (gap 3).
--
-- Diseño: auditoría de dominio + panel `administrador-consorcios` + `contador` (2026-08-22).
--
-- **`facturaAdjunta`** — el documento que el proveedor entregó. Distinto de `comprobanteAdjunto`
-- (prueba de que EL BARRIO pagó, no de que hubo una compra) y de `numeroFactura` (un número en
-- texto, ya existía, nunca un archivo). Mismo patrón de adjunto tardío que `comprobanteAdjunto`:
-- se sube en cualquier estado, sin pasar por la máquina de transiciones, salvo la excepción de
-- "una vez adjunta, no se reemplaza" que sí vive en el trigger (sección 2, abajo).
--
-- **`facturaNoDisponible`/`motivoFacturaNoDisponible`** — NO es lo mismo que "todavía no llegó".
-- `administrador-consorcios` fue explícito: forzar un flag+motivo en el caso normal (factura que
-- llega una semana después) es fricción sin contrapartida — `facturaAdjunta is null` ya lo dice,
-- sin marca. El campo es para la declaración DELIBERADA de que nunca va a haber una (proveedor
-- informal, sin CUIT) — `contador` confirmó que lo necesita como insumo del libro de egresos (doc
-- `04-requisitos-dominio.md`, que hoy solo tiene `potencial_sellos`/`potencial_retencion`, misma
-- lógica de "marcar, no calcular"). A diferencia de `gasto_periodo.sinRespaldoAsamblea` —que se
-- snapshotea en la boleta de un propietario y por eso se congela para siempre—, acá no hay ningún
-- tercero cuyo reclamo dependa de que el dato quede fijo: nunca se congela y se puede sanear.
--
-- **La mutua exclusión vive en un `CHECK`, no en lógica de aplicación** (instrucción explícita del
-- usuario, 2026-08-22): no se puede declarar "no va a haber factura" mientras hay una adjunta,
-- pase lo que pase por el código que escriba la fila. `marcarFacturaNoDisponibleDeOP()` limpia
-- `facturaAdjunta` en el MISMO `UPDATE` que pone el flag; `adjuntarFacturaDeOP()` limpia el flag
-- (y su motivo) en el mismo `UPDATE` que adjunta — las dos direcciones son simétricas y las hace
-- cumplir el mismo `orden_pago_factura_exclusiva_chk`, no un `if` de servicio que se pueda saltear.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. Las columnas y sus CHECK — generado por drizzle-kit desde `schema/proveedores.ts`.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "orden_pago" ADD COLUMN "factura_adjunta" text;--> statement-breakpoint
ALTER TABLE "orden_pago" ADD COLUMN "factura_no_disponible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orden_pago" ADD COLUMN "motivo_factura_no_disponible" text;--> statement-breakpoint
ALTER TABLE "orden_pago" ADD CONSTRAINT "orden_pago_factura_storage_key_chk" CHECK ("orden_pago"."factura_adjunta" is null or "orden_pago"."factura_adjunta" ~
          ('^barrios/' || "orden_pago"."barrio_id"::text || '/ordenes-pago/' || "orden_pago"."id"::text ||
           '/factura/[A-Za-z0-9_-]{22,64}\.(pdf|jpg|jpeg|png)$'));--> statement-breakpoint
ALTER TABLE "orden_pago" ADD CONSTRAINT "orden_pago_factura_no_disponible_chk" CHECK (("orden_pago"."factura_no_disponible" = false and "orden_pago"."motivo_factura_no_disponible" is null)
          or ("orden_pago"."factura_no_disponible" = true and "orden_pago"."motivo_factura_no_disponible" is not null));--> statement-breakpoint
ALTER TABLE "orden_pago" ADD CONSTRAINT "orden_pago_factura_exclusiva_chk" CHECK (not ("orden_pago"."factura_no_disponible" = true and "orden_pago"."factura_adjunta" is not null));
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. `app.orden_pago_transicion()` — una sola excepción nueva de congelamiento, para
--    `factura_adjunta` (null → valor sí, valor → otro no, mismo patrón que `comprobante_adjunto`).
--    `factura_no_disponible`/`motivo_factura_no_disponible` NO entran a este bloque a propósito:
--    no están en la tupla congelada ni tienen excepción propia, así que quedan libres en cualquier
--    estado — es exactamente el "nunca se congela, se puede sanear" del comentario de cabecera.
--    El resto de la función es idéntico a `0044_ordenes_pago_reglas.sql`.
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
end; $$;
