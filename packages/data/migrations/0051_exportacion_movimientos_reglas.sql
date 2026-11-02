-- =============================================================================================
-- 0051_exportacion_movimientos_reglas — RLS, triggers y grants de `exportacion_movimientos`.
--
-- La forma está en `0050`; acá está **quién puede escribir y leer qué**, que es lo que hace que la
-- traza valga algo. Mismo reparto que `0043`/`0044` y `0026`/`0027`.
--
-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- LA IDEA CENTRAL: EL GATE DE ROL Y LA TRAZA SON EL MISMO CONTROL
--
-- La exportación es síncrona y no tiene tabla de artefacto sobre la cual poner una policy de
-- `select`. Entonces el gate de "quién puede exportar" **vive en el `insert` de la fila de
-- auditoría** (hallazgo de `security-engineer`, panel 2026-08-26), y como esa fila se escribe antes
-- de serializar, las dos garantías se sostienen entre sí:
--
--   · no se puede exportar sin dejar rastro, y
--   · no se puede dejar rastro sin tener el rol.
--
-- El gate va del lado de la BASE y no en un `if` de la ruta: es el mecanismo que el repo ya usa y
-- testea, y un gate en TypeScript es un gate que la próxima ruta se olvida.
--
-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- POR QUÉ ESTE AGREGADO NECESITA UN GATE DE ROL PROPIO, ADEMÁS DE LA RLS
--
-- `pago_sel` (`0034`), `orden_pago_sel` y `proveedor_sel` (`0044`) son `barrio_id in (select
-- app.readable_tenant_ids())` a secas. Eso está bien **fila por fila**, que es como las leen las
-- pantallas.
--
-- Pero el repo YA decidió —y lo puso en una policy— que un agregado del barrio entero es
-- cualitativamente distinto de sus filas: `documento_emitido_sel` (`0027`) agrega un gate por tipo,
-- y su comentario lo dice textual: *"el listado de saldos pendientes NO, porque una copia es la
-- deuda con nombre de todo el barrio y readable_tenant_ids() incluye contador y auditor"*.
--
-- El libro de movimientos es un agregado **estrictamente mayor** que ese listado: todos los cobros
-- con su obligado, todos los egresos con su proveedor, y todos los motivos de anulación en texto
-- libre, en un archivo que sale del sistema y viaja por mail. Que no tuviera gate sería una
-- **incoherencia del propio esquema**, no una laguna.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. El trigger que hace confiable a `solicitado_por`.
--
-- Mismo patrón exacto que `app.descarga_antes_insert()` (`0027`): la identidad la escribe la base,
-- nunca el cliente. Una firma de auditoría que puede escribir quien la genera no es una firma.
--
-- **No deriva `barrio_id`**, a diferencia de su hermana de `descarga_documento`: allá el barrio sale
-- de la fila referenciada (el documento), acá el barrio ES el parámetro de la extracción — no hay
-- referencia de la cual derivarlo. Quien mande un barrio que no le corresponde no pasa el `with
-- check` de la policy de abajo, que es donde corresponde atajarlo.
-- ---------------------------------------------------------------------------------------------
create or replace function app.exportacion_antes_insert() returns trigger
  language plpgsql security invoker
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: no se registra una exportación anónima'
      using errcode = 'P0001';
  end if;

  new.solicitado_por := v_usuario;
  new.solicitado_at  := now();
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_exportacion_antes_insert before insert on exportacion_movimientos
  for each row execute function app.exportacion_antes_insert();
--> statement-breakpoint

-- Append-only real: una traza que se puede editar o borrar no es una traza. `app.solo_append()` ya
-- existe desde `0016` y la reusan `documento_emitido`, `recibo_emitido` y `descarga_documento`.
create trigger trg_exportacion_append before update or delete on exportacion_movimientos
  for each row execute function app.solo_append();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. RLS.
-- ---------------------------------------------------------------------------------------------
alter table exportacion_movimientos enable row level security;
--> statement-breakpoint
alter table exportacion_movimientos force row level security;
--> statement-breakpoint

-- LECTURA — quién puede ver qué se extrajo del barrio.
--
-- Las DOS condiciones, nunca solo la del rol: `readable_tenant_ids()` es la definición única de
-- "sobre qué barrios este usuario ve datos", y una policy que la saltea deja de heredar lo que esa
-- función aprenda después (la baja lógica de un nodo, un cambio en el subárbol). El gate de rol va
-- **encima**, no en su lugar. Hay un test que verifica que ninguna tabla con `barrio_id` se olvide
-- de la primera mitad.
--
-- **Quiénes, y por qué esos** (decisión explícita, pedida por `security-engineer` para que no quede
-- por default):
--   · `admin_plataforma`, `admin_barrio` — administración, igual que `descarga_documento_sel`.
--   · `auditor` — **siempre, aunque el barrio no lo habilite a exportar**. Auditar el uso del
--     sistema es literalmente su función, y las dos cosas son distintas: este flag gobierna si
--     puede SACAR el libro, no si puede ver QUIÉN lo sacó.
--   · `contador` **no**. Es el destinatario del entregable (doc 01 §4.8), no un supervisor del uso
--     del sistema: puede exportar, y no necesita saber quién más exportó.
--   · `operador` **no**. No puede exportar; no tiene por qué leer quién exportó.
create policy exportacion_movimientos_sel on exportacion_movimientos for select
  using (
    barrio_id in (select app.readable_tenant_ids())
    and app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','auditor']::app.rol_membership[])
  );
--> statement-breakpoint

-- ESCRITURA — **este es el gate de "quién puede exportar"**.
--
-- `admin_plataforma`, `admin_barrio` y `contador` siempre. `operador` nunca (no aparece en ningún
-- brazo). `auditor` solo si el barrio lo habilitó con `auditor_exporta_movimientos` (`0050`).
--
-- El `coalesce(..., false)` es deliberado y **falla cerrado**: si el subselect no devolviera fila
-- —un barrio que este usuario no puede leer— la comparación daría `null`, y `null` en un `with
-- check` no habilita, pero conviene que la intención esté escrita y no dependa de la semántica
-- ternaria. Sin `readable_tenant_ids()` acá tampoco: el barrio ajeno no llega ni a evaluarse.
create policy exportacion_movimientos_ins on exportacion_movimientos for insert
  with check (
    barrio_id in (select app.readable_tenant_ids())
    and (
      app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','contador']::app.rol_membership[])
      or (
        app.has_role_on(barrio_id, array['auditor']::app.rol_membership[])
        and coalesce((select b.auditor_exporta_movimientos from barrio b where b.barrio_id = exportacion_movimientos.barrio_id), false)
      )
    )
  );
--> statement-breakpoint

-- Sin policy de UPDATE ni de DELETE, y sin grant de ninguna de las dos: append-only por permisos,
-- no por convención. El trigger de arriba es la segunda vuelta de llave.
grant select, insert on table exportacion_movimientos to app_request;
--> statement-breakpoint
grant select on table exportacion_movimientos to app_job;
--> statement-breakpoint

comment on policy exportacion_movimientos_ins on exportacion_movimientos is
  'El gate de "quién puede exportar el libro de movimientos". Vive en el INSERT de la traza y no en '
  'una policy de select, porque la exportación es síncrona y no deja artefacto: como la fila se '
  'escribe antes de serializar, no se puede exportar sin dejar rastro ni dejar rastro sin el rol. '
  'admin_plataforma/admin_barrio/contador siempre; operador nunca; auditor según '
  'barrio.auditor_exporta_movimientos.';
--> statement-breakpoint

comment on policy exportacion_movimientos_sel on exportacion_movimientos is
  'Quién ve qué se extrajo: administración y auditor. El auditor lee esta tabla SIEMPRE, aunque el '
  'barrio no lo habilite a exportar — ver el libro y ver quién lo sacó son cosas distintas. El '
  'contador queda afuera a propósito: es el destinatario del entregable, no supervisor del uso.';
