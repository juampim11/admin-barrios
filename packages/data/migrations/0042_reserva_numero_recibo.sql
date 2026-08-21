-- =============================================================================================
-- 0042_reserva_numero_recibo — separa "reservar el próximo número" de "insertar la fila", para que
-- el número pueda imprimirse DENTRO del PDF del recibo antes de que exista la fila que lo registra.
--
-- ---------------------------------------------------------------------------------------------
-- POR QUÉ HACÍA FALTA
--
-- `app.recibo_antes()` (`0039_recibos_reglas.sql`, aplicada — no se edita, se reemplaza el cuerpo
-- acá) asigna `numero_recibo` al insertar la fila. Pero el número tiene que estar impreso adentro
-- del PDF, y el PDF se genera con el motor Chromium **fuera de transacción** (mismo patrón que
-- `apps/worker/src/emision.ts`: "objeto primero, fila después" — `sha256`/`bytes`/`vista` son
-- `NOT NULL` y se calculan del PDF ya renderizado, y `trg_recibo_append` prohíbe cualquier `UPDATE`
-- posterior). No hay forma de tener el número ANTES del insert sin separar la reserva del insert.
--
-- Ya estaba anotado como pendiente antes de que este módulo existiera: doc 01
-- (`docs/arquitectura/01-generacion-de-documentos.md` §13) dice *"si el número lo asigna una
-- fuente externa, hace falta un paso previo de `reservarNumeracion()`"* — esto es esa pieza,
-- aplicada al recibo en vez de a la boleta.
--
-- ---------------------------------------------------------------------------------------------
-- PANEL: arquitecto-software + dba-data + security-engineer (evaluación técnica) y legal-ph +
-- contador (evaluación de dominio), 2026-08-20 — convocados porque separar la reserva del insert
-- abre una ventana real: si el proceso muere entre reservar el número y completar el insert de la
-- fila, ese número queda consumido sin ningún recibo asociado (un salto en la secuencia).
--
-- **Riesgo aceptado, Nivel 1 (decisión del usuario, no de este código):** un hueco raro por fallo
-- de proceso entre reservar el número y completar la emisión NO fue identificado como riesgo
-- legal/fiscal por `legal-ph` ni por el agente contable — el recibo de pago **no** es el documento
-- que el CCyC reviste de formalidad especial (ese es el certificado de deuda, art. 2048 CCyC — un
-- documento distinto, que habilita a ejecutar una deuda; el recibo solo prueba que se cobró), y el
-- recibo ya es explícitamente **no fiscal** por decisión de producto
-- (`docs/diseno/07-liquidacion-pdf.md` §C.1: la clasificación fiscal no va en este documento).
-- Ambos agentes señalan esto como un **vacío de fuente, no una autorización normativa** — ninguno
-- encontró una norma que EXIJA correlatividad estricta para este documento, pero tampoco una que la
-- autorice a saltear explícitamente — y piden **validar con profesional matriculado** antes de
-- tratar esta decisión como definitiva. No se implementa acá la garantía de cero huecos (Nivel 2:
-- idempotencia completa vía columnas `numero_reservado`/`reservado_at` en `trabajo`) porque ningún
-- agente de dominio la exigió y agrega superficie real (schema + lógica de reintento) para cerrar
-- un riesgo que nadie marcó como grave. Si la validación profesional cambia esta conclusión, hay
-- que revisar esta decisión — no es una migración más, es la que registra por qué se aceptó el
-- riesgo.
--
-- El hueco, si ocurre, queda auditable igual: `trabajo.error` registra el motivo de la falla, y
-- `recibo_secuencia.ultimo_numero` avanzado sin una fila correspondiente en `recibo_emitido` es
-- reconstruible cruzando las dos tablas — no hace falta una tabla de reservas nueva para eso.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. La función de reserva, extraída del trigger. Sin `security definer` — mismo criterio que
--    `app.recibo_antes()` hoy: deriva el barrio bajo la RLS de quien reserva, así que un pago que
--    no puede leer no existe para él. El `UPDATE` sobre `recibo_secuencia` ya está protegido por la
--    policy `recibo_secuencia_upd` (`0039`), que exige `has_role_on(barrio_id, ['admin_plataforma',
--    'admin_barrio','operador'])` — los mismos tres roles que `recibo_emitido_ins`. No hace falta
--    un chequeo de rol propio acá: la policy ya existente lo cubre.
-- ---------------------------------------------------------------------------------------------
create or replace function app.reservar_numero_recibo(pago_id uuid) returns bigint
  language plpgsql
  set search_path = public, app
as $$
declare
  v_usuario   uuid := app.current_user_id();
  v_barrio    uuid;
  v_siguiente bigint;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: no se reserva un número de recibo sin sesión'
      using errcode = 'P0001';
  end if;

  -- Bajo la RLS de quien reserva (sin security definer): un pago que no puede leer no existe.
  select barrio_id into v_barrio from pago where id = pago_id;
  if v_barrio is null then
    raise exception 'no se pudo derivar el barrio del pago: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  insert into recibo_secuencia (barrio_id, ultimo_numero) values (v_barrio, 0)
    on conflict (barrio_id) do nothing;

  update recibo_secuencia set ultimo_numero = ultimo_numero + 1
   where barrio_id = v_barrio
  returning ultimo_numero into v_siguiente;

  return v_siguiente;
end; $$;--> statement-breakpoint

grant execute on function app.reservar_numero_recibo(uuid) to app_request;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. `app.recibo_antes()` reescrita: si el servicio ya reservó el número (`new.numero_recibo` no
--    nulo), lo respeta. Si no —un insert directo que no pasó por la reserva previa, por ejemplo una
--    migración de datos o una consola— lo asigna acá mismo, como siempre. El resto del cuerpo
--    (derivar `barrio_id`, `emitido_por`, `emitido_at`) no cambia.
-- ---------------------------------------------------------------------------------------------
create or replace function app.recibo_antes() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_barrio  uuid;
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

  -- [0042] Reservado de antemano (el camino normal desde `emitirReciboDePago`, para poder imprimir
  -- el número dentro del PDF antes de esta inserción): se respeta tal cual. Si no, se asigna acá.
  if new.numero_recibo is null then
    new.numero_recibo := app.reservar_numero_recibo(new.pago_id);
  end if;

  new.emitido_por := v_usuario;
  new.emitido_at  := now();
  return new;
end; $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. El grant de columna de `recibo_emitido` (`0039`) no incluía `numero_recibo`: hasta acá,
--    ningún `insert` de `app_request` la mencionaba explícitamente (el trigger la asignaba entera).
--    Ahora el servicio SÍ la pasa en el `insert` (el número ya reservado, para que el trigger lo
--    respete) — y Postgres exige privilegio de columna sobre lo que el `insert` nombra
--    explícitamente, no sobre lo que el trigger toca después. Sin este grant, el `insert` del
--    servicio falla con 42501 en cuanto intenta nombrar la columna.
-- ---------------------------------------------------------------------------------------------
grant insert (barrio_id, pago_id, numero_recibo, storage_key, sha256, bytes, vista, vista_version,
              motor, plantilla_hash)
  on table recibo_emitido to app_request;
--> statement-breakpoint

comment on function app.recibo_antes() is
  'Asigna barrio_id/emitido_por/emitido_at siempre; numero_recibo solo si no vino ya reservado por '
  'app.reservar_numero_recibo() (ver 0042). Riesgo aceptado, Nivel 1: un hueco raro en la secuencia '
  'por fallo de proceso entre reservar y completar el insert no fue identificado como riesgo legal '
  'ni fiscal por legal-ph/contador (2026-08-20) — vacío de fuente, no autorización normativa; '
  'validar con profesional matriculado antes de tratarlo como definitivo. Ver el comentario de '
  'cabecera de esta migración para el detalle completo.';
