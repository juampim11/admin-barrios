-- =============================================================================================
-- 0059_codigo_pago_uf — el código de pago de cada unidad funcional (BL-012).
--
-- Cada UF recibe un NÚMERO estable dentro de su barrio (`unidad_funcional.codigo_pago_numero`): no
-- cambia aunque cambie el titular, ni aunque cambie el formato. Lo que se imprime —en la boleta, en
-- todos los medios de cobro, y en la referencia del QR de transferencia— es ese número con el
-- FORMATO DEL BARRIO (largo, prefijo, separador) más un dígito verificador de Damm, que se calcula en
-- `@admin-barrios/shared/codigo-pago` y no se guarda: es función del número y del formato.
--
-- Por qué el formato es configuración y el número es dato: para alinearlo después con el
-- identificador de cliente de una red de cobranza (p. ej. SIRO) alcanza con cambiar el largo o el
-- prefijo del barrio. **No hay que migrar datos**: el número de cada UF queda igual.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. El formato, por barrio. Las tres columnas NACEN CERRADAS (mismo criterio que
--    `auditor_exporta_movimientos`, 0050): no entran en el grant por columna de `barrio` para
--    `app_request`. Cambiar cómo se escribe el código de todas las boletas de un barrio es
--    configuración de la cuenta, no algo que se edite desde la pantalla del día a día.
-- ---------------------------------------------------------------------------------------------
alter table barrio
  add column codigo_pago_largo smallint not null default 6,
  add column codigo_pago_prefijo text not null default '',
  add column codigo_pago_separador text not null default '-';
--> statement-breakpoint
alter table barrio add constraint barrio_codigo_pago_largo_chk check (codigo_pago_largo between 3 and 12);
--> statement-breakpoint
alter table barrio add constraint barrio_codigo_pago_prefijo_chk check (codigo_pago_prefijo ~ '^[0-9]{0,6}$');
--> statement-breakpoint
alter table barrio add constraint barrio_codigo_pago_separador_chk check (codigo_pago_separador in ('-', ''));
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. El contador por barrio. Mismo mecanismo que `recibo_secuencia` (0038/0039): `insert … on
--    conflict do nothing` asegura la fila y el `update … returning` toma su lock — dos altas
--    concurrentes del mismo barrio se serializan, y un `insert` de varias filas numera fila por fila.
-- ---------------------------------------------------------------------------------------------
-- `on delete cascade` y no `restrict`: el contador no significa nada sin su barrio (un barrio no se
-- borra en el producto —se da de baja—, pero los tests y el seed sí lo borran, y un `restrict` acá los
-- obligaría a todos a conocer esta tabla).
create table codigo_pago_secuencia (
  barrio_id uuid primary key references barrio (barrio_id) on delete cascade,
  ultimo_numero bigint not null default 0,
  constraint codigo_pago_secuencia_no_negativo_chk check (ultimo_numero >= 0)
);
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. El número de cada UF. Las existentes lo reciben ACÁ, en un orden determinístico: por manzana y
--    lote en orden natural (la parte numérica como número: "2" antes que "10"), y después por id.
--    `trg_uf_updated` se apaga durante el relleno: asignar el código no es una edición de la unidad
--    y no tiene que mover su `updated_at`.
-- ---------------------------------------------------------------------------------------------
alter table unidad_funcional add column codigo_pago_numero bigint;
--> statement-breakpoint
alter table unidad_funcional disable trigger trg_uf_updated;
--> statement-breakpoint
with orden as (
  select u.id,
         row_number() over (
           partition by u.barrio_id
           -- `collate "C"` en el desempate de texto: sin él, el orden de "a" contra "B" depende de la
           -- collation de cada base y el relleno dejaría de ser el mismo en todos los entornos.
           order by nullif(regexp_replace(u.manzana, '[^0-9]', '', 'g'), '')::numeric nulls last, u.manzana collate "C",
                    nullif(regexp_replace(u.lote, '[^0-9]', '', 'g'), '')::numeric nulls last, u.lote collate "C",
                    u.id
         ) as n
    from unidad_funcional u
)
update unidad_funcional u set codigo_pago_numero = o.n from orden o where o.id = u.id;
--> statement-breakpoint
alter table unidad_funcional enable trigger trg_uf_updated;
--> statement-breakpoint
insert into codigo_pago_secuencia (barrio_id, ultimo_numero)
select b.barrio_id, coalesce((select max(u.codigo_pago_numero) from unidad_funcional u where u.barrio_id = b.barrio_id), 0)
  from barrio b;
--> statement-breakpoint
alter table unidad_funcional alter column codigo_pago_numero set not null;
--> statement-breakpoint
alter table unidad_funcional add constraint uf_codigo_pago_numero_chk check (codigo_pago_numero >= 1);
--> statement-breakpoint
create unique index uq_uf_barrio_codigo_pago on unidad_funcional (barrio_id, codigo_pago_numero);
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. Una UF nueva recibe el siguiente número de su barrio, **siempre** (un valor que venga en el
--    insert se ignora: el número no se elige), y nunca lo cambia. Sin `security definer`: corre bajo
--    la RLS de quien da de alta la unidad, igual que `app.recibo_antes()`.
-- ---------------------------------------------------------------------------------------------
create or replace function app.uf_codigo_pago_antes_insert() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_siguiente bigint;
  v_largo     smallint;
begin
  insert into codigo_pago_secuencia (barrio_id, ultimo_numero) values (new.barrio_id, 0)
    on conflict (barrio_id) do nothing;
  update codigo_pago_secuencia set ultimo_numero = ultimo_numero + 1
   where barrio_id = new.barrio_id
  returning ultimo_numero into v_siguiente;
  if v_siguiente is null then
    raise exception 'no se pudo asignar el código de pago de la unidad: se rechaza por seguridad';
  end if;
  select codigo_pago_largo into v_largo from barrio where barrio_id = new.barrio_id;
  if v_largo is not null and length(v_siguiente::text) > v_largo then
    raise exception 'el código de pago del barrio no entra en % dígitos: hay que agrandar su largo', v_largo;
  end if;
  new.codigo_pago_numero := v_siguiente;
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_uf_codigo_pago_antes_insert before insert on unidad_funcional
  for each row execute function app.uf_codigo_pago_antes_insert();
--> statement-breakpoint

create or replace function app.uf_codigo_pago_inmutable() returns trigger
  language plpgsql
  set search_path = public, app
as $$
begin
  if new.codigo_pago_numero is distinct from old.codigo_pago_numero then
    raise exception 'el código de pago de una unidad no cambia: es estable aunque cambie el titular';
  end if;
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_uf_codigo_pago_inmutable before update on unidad_funcional
  for each row execute function app.uf_codigo_pago_inmutable();
--> statement-breakpoint

-- El largo del barrio no se achica por debajo del número más alto que ya asignó: si no, la UF más
-- nueva no entraría en el código y no saldría ninguna boleta del barrio (revisión de código).
create or replace function app.barrio_codigo_pago_largo_alcanza() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_maximo bigint;
begin
  if new.codigo_pago_largo is distinct from old.codigo_pago_largo then
    select max(codigo_pago_numero) into v_maximo from unidad_funcional where barrio_id = new.barrio_id;
    if v_maximo is not null and length(v_maximo::text) > new.codigo_pago_largo then
      raise exception 'el largo del código de pago no alcanza para las unidades que ya tienen número: el más alto es %', v_maximo;
    end if;
  end if;
  return new;
end; $$;
--> statement-breakpoint

create trigger trg_barrio_codigo_pago_largo before update of codigo_pago_largo on barrio
  for each row execute function app.barrio_codigo_pago_largo_alcanza();
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 5. RLS del contador: calcada de `recibo_secuencia`. Lo escribe solo el trigger, con la identidad
--    de quien da de alta la unidad.
-- ---------------------------------------------------------------------------------------------
alter table codigo_pago_secuencia enable row level security;
--> statement-breakpoint
alter table codigo_pago_secuencia force row level security;
--> statement-breakpoint
create policy codigo_pago_secuencia_sel on codigo_pago_secuencia for select
  using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
create policy codigo_pago_secuencia_ins on codigo_pago_secuencia for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint
create policy codigo_pago_secuencia_upd on codigo_pago_secuencia for update
  using (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]))
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint
grant select, insert, update on table codigo_pago_secuencia to app_request;
--> statement-breakpoint
grant select, insert, update on table codigo_pago_secuencia to app_job;
--> statement-breakpoint
revoke execute on function app.uf_codigo_pago_antes_insert() from public;
--> statement-breakpoint
revoke execute on function app.uf_codigo_pago_inmutable() from public;
--> statement-breakpoint
revoke execute on function app.barrio_codigo_pago_largo_alcanza() from public;
