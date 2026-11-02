-- =============================================================================================
-- 0034_pagos_reglas — quién puede escribir y leer `pago`, y el candado anti-cruce entre barrios.
--
-- Calco del patrón de anulación pareada/congelada de `app.cbu_antes()`
-- (`0021_anulacion_y_fuga_de_catalogo.sql`): las tres columnas de la anulación se congelan juntas y
-- no se revierten.
--
-- **`app.pago_antes()` NO es `security definer`, a diferencia de `app.cbu_antes()`.** La diferencia
-- es a propósito y sigue el criterio de `0027` §2 (`app.trabajo_antes_insert()` tampoco lo es): esta
-- función no lee NINGUNA tabla de otro barrio — no hay un catálogo que resolver, ni un período que
-- consultar — así que no necesita saltear la RLS para nada. `app.has_role_on()` es en sí misma
-- `security definer`, así que el corte de rol funciona igual sin que este trigger cargue un
-- privilegio que no usa. Un `security definer` de más no es inofensivo por default: es superficie
-- que hay que volver a auditar cada vez que la función cambia.
--
-- **`barrio_id` NO lo deriva este trigger.** El servicio (`registrarPago`,
-- `packages/data/src/servicios/pagos.ts`) lo deriva de la propia `unidad_funcional` con un
-- `insert … select … from unidad_funcional where id = $1` — el mismo patrón que `registrarGasto`
-- deriva el barrio del período. Con eso, un `barrio_id` que no coincida con el de la unidad ni
-- siquiera llega a este trigger: lo rechaza la FK COMPUESTA `fk_pago_uf_barrio` de más abajo,
-- estructuralmente, sin necesidad de un `raise` que pudiera filtrar algo. El corte de rol de acá
-- autoriza la ESCRITURA sobre el barrio ya resuelto; no repite la comprobación de cruce, que ya la
-- hace la FK.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. FKs compuestas anti-cruce (patrón de 0003/0005/0016): un pago de un barrio no puede colgar de
--    una unidad ni de un obligado de otro barrio, ni con el rol que saltea la RLS.
-- ---------------------------------------------------------------------------------------------
alter table pago add constraint uq_pago_id_barrio unique (id, barrio_id);
--> statement-breakpoint

alter table pago
  add constraint fk_pago_uf_barrio foreign key (unidad_funcional_id, barrio_id)
  references unidad_funcional (id, barrio_id) on delete restrict;
--> statement-breakpoint

-- Sin `on delete` propio: la baja de un obligado la resuelve la FK simple de `obligado_id`
-- (`on delete set null`, en `schema/cobros.ts`), que deja `obligado_id` en `NULL` dentro de la MISMA
-- sentencia de borrado. Esta FK compuesta, bajo `MATCH SIMPLE` (el default), no evalúa una fila con
-- cualquiera de sus dos columnas en `NULL` — así que al terminar esa sentencia ya no tiene nada que
-- objetar. Ponerle acá también `on delete set null` intentaría anular `barrio_id`, que es `NOT NULL`
-- en la tabla y no puede vaciarse: sería un `on delete` que rompe el propio borrado que dice resolver.
alter table pago
  add constraint fk_pago_obligado_barrio foreign key (obligado_id, barrio_id)
  references obligado (id, barrio_id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. El trigger: identidad del registrador, y la anulación pareada/congelada.
-- ---------------------------------------------------------------------------------------------
create or replace function app.pago_antes() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_roles_escritura constant app.rol_membership[] :=
    array['admin_plataforma','admin_barrio','operador']::app.rol_membership[];
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un pago sin autor no se registra';
  end if;

  if tg_op = 'INSERT' then
    -- Corte temprano de rol: lo primero que se evalúa, antes de tocar ninguna otra columna. No hay
    -- acá ninguna lectura de otra tabla que pudiera filtrar un dato de otro barrio (a diferencia de
    -- `app.cbu_antes()`), pero el orden se mantiene igual por ser el mismo idioma en todo el repo.
    if not app.has_role_on(new.barrio_id, v_roles_escritura) then
      raise exception 'no tenés permiso para registrar pagos en este barrio';
    end if;

    -- El registrador de un pago MANUAL lo pone la base, nunca el cliente — mismo criterio que
    -- `aplicado_por` en `app.cbu_antes()`. Pero un `extracto` con `usuario_registrador` NO se corrige
    -- en silencio acá: se deja pasar tal cual llegó para que `pago_manual_exige_registrador_chk` lo
    -- rechace. Falla cerrado, no se inventa/corrige — el mismo principio que ya rige
    -- `orden_imputacion` (sin default) y el bloqueo de sobre-imputación; corregirlo en silencio en
    -- este único lugar sería la excepción, no la regla.
    if new.origen = 'manual' then
      new.usuario_registrador := v_usuario;
    end if;
    new.anulado_at       := null;
    new.anulado_por      := null;
    new.motivo_anulacion := null;
  end if;

  if tg_op = 'UPDATE' then
    if not app.has_role_on(new.barrio_id, v_roles_escritura) then
      raise exception 'no tenés permiso para modificar pagos en este barrio';
    end if;

    -- El pago no se edita: se anula (con motivo) y se carga de nuevo. Igual que `app.cbu_antes()`,
    -- la única transición permitida es la terna de anulación.
    if (new.barrio_id, new.unidad_funcional_id, new.obligado_id, new.monto, new.fecha, new.origen,
        new.estado_conciliacion, new.usuario_registrador, new.comprobante_adjunto)
       is distinct from
       (old.barrio_id, old.unidad_funcional_id, old.obligado_id, old.monto, old.fecha, old.origen,
        old.estado_conciliacion, old.usuario_registrador, old.comprobante_adjunto)
    then
      raise exception 'un pago no se edita: se anula (con motivo) y se carga de nuevo';
    end if;

    -- Mensajes DISTINTOS de los de `concepto_boleta_unidad` (0021) a propósito: `errores.ts` traduce
    -- por patrón de texto, y dos dominios que levantan el mismo mensaje literal harían que la
    -- traducción del primero que matchea le gane al segundo (el pago se explicaría como "ese cargo…").
    if old.anulado_at is not null and new.anulado_at is null then
      raise exception 'la anulación de un pago no se revierte';
    end if;

    -- Una vez anulado, las TRES columnas de la anulación quedan congeladas (mismo AGUJERO 1 que
    -- cerró 0021 para `concepto_boleta_unidad`).
    if old.anulado_at is not null
       and (new.anulado_at, new.anulado_por, new.motivo_anulacion)
           is distinct from (old.anulado_at, old.anulado_por, old.motivo_anulacion) then
      raise exception 'el motivo de la anulación de un pago no se reescribe: quedó registrado el % y es '
                      'la única explicación de por qué ese cobro se dejó sin efecto', old.anulado_at::date;
    end if;

    if new.anulado_at is not null and old.anulado_at is null then
      new.anulado_at  := now();
      new.anulado_por := v_usuario;
    end if;
  end if;

  return new;
end; $$;--> statement-breakpoint

create trigger trg_pago_antes before insert or update on pago
  for each row execute function app.pago_antes();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. RLS. Lectura por `readable_tenant_ids()` (conjunto, no `has_role_on` por fila — ver 0018);
--    escritura (alta y anulación) para los tres roles de gestión. Sin policy de DELETE: un pago no
--    se borra, se anula.
-- ---------------------------------------------------------------------------------------------
alter table pago enable row level security;
--> statement-breakpoint
alter table pago force row level security;
--> statement-breakpoint

create policy pago_sel on pago for select
  using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint

create policy pago_ins on pago for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

create policy pago_upd on pago for update
  using (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]))
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint

grant select, insert, update on table pago to app_request;
--> statement-breakpoint
grant select, insert, update, delete on table pago to app_job;
