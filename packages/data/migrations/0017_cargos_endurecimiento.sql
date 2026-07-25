-- =============================================================================================
-- 0017_cargos_endurecimiento — invierte el modelo de confianza del bloque de cargos y descuentos.
--
-- La auditoría encontró que el problema no eran tres bugs sueltos sino UNO visto desde tres lados:
-- **la base confiaba en valores que mandaba el request** para la tabla que mueve plata. El "snapshot
-- del catálogo" lo escribía el cliente, así que un operador podía aplicar el concepto legítimo
-- "Alquiler de quincho ($38.000)" mandando `precio_unitario = 9.500.000`, y todos los controles
-- cerraban: el check verificaba la fila contra sí misma, y el cuadre comparaba la boleta contra ese
-- mismo importe inventado.
--
-- Acá el request pasa a poder mandar SOLO: qué concepto, a qué unidad, de qué período, cuándo,
-- cuántas unidades y por qué. **Todo lo demás lo escribe la base**, igual que ya hacía con la firma
-- del autor. Y el importe deja de ser escribible por el cliente: lo resuelve una función.
--
-- Fuente: docs/diseno/08-criterios-de-reparto.md §M, §N, §Y, §Z, §AA.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 0. Columnas y rellenos. Las tres últimas ya existen desde 0016 (escrita a mano): se declaran
--    igual para que el esquema TS y el snapshot no queden desincronizados y la próxima migración
--    generada no intente volver a crearlas.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "concepto_boleta_unidad" ADD COLUMN IF NOT EXISTS "financiamiento" "app"."financiamiento_descuento";--> statement-breakpoint
ALTER TABLE "concepto_boleta_unidad" ADD COLUMN IF NOT EXISTS "monto_resuelto" numeric(14, 2) GENERATED ALWAYS AS (case when clase = 'descuento' then -importe_resuelto else importe_resuelto end) STORED;--> statement-breakpoint
ALTER TABLE "periodo_expensa" ADD COLUMN IF NOT EXISTS "total_cargos" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "periodo_expensa" ADD COLUMN IF NOT EXISTS "total_descuentos" numeric(14, 2);--> statement-breakpoint

-- Relleno ANTES de los candados: si no, la migración rebota sobre cualquier base con datos.
UPDATE "concepto_boleta_unidad" cbu SET "financiamiento" = cb."financiamiento"
  FROM "concepto_boleta" cb
 WHERE cb."id" = cbu."concepto_boleta_id" AND cbu."financiamiento" IS NULL;--> statement-breakpoint
UPDATE "concepto_boleta_unidad" SET "origen_evaluacion" = 'carga_manual' WHERE "origen_evaluacion" IS NULL;--> statement-breakpoint
ALTER TABLE "concepto_boleta_unidad" ALTER COLUMN "origen_evaluacion" SET DEFAULT 'carga_manual';--> statement-breakpoint
ALTER TABLE "concepto_boleta_unidad" ALTER COLUMN "origen_evaluacion" SET NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 1. Los parámetros de la aplicación. El catálogo ya los validaba; **de esta tabla sale el dinero
--    de la boleta** y no los validaba nadie. Con `metodo = 'monto_fijo'` y `monto_fijo` nulo, el
--    `case` daba NULL y un CHECK que evalúa a NULL **pasa**: entraba un importe arbitrario. Y una
--    `cantidad` nula reventaba la liquidación del período entero al multiplicar por NULL.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "concepto_boleta_unidad" ADD CONSTRAINT "cbu_parametro_chk" CHECK (case "concepto_boleta_unidad"."metodo"
            when 'monto_fijo'        then "concepto_boleta_unidad"."monto_fijo" is not null and "concepto_boleta_unidad"."porcentaje" is null and "concepto_boleta_unidad"."precio_unitario" is null and "concepto_boleta_unidad"."cantidad" is null
            when 'porcentaje'        then "concepto_boleta_unidad"."porcentaje" is not null and "concepto_boleta_unidad"."monto_fijo" is null and "concepto_boleta_unidad"."precio_unitario" is null and "concepto_boleta_unidad"."cantidad" is null
            when 'precio_x_cantidad' then "concepto_boleta_unidad"."precio_unitario" is not null and "concepto_boleta_unidad"."cantidad" is not null and "concepto_boleta_unidad"."monto_fijo" is null and "concepto_boleta_unidad"."porcentaje" is null
          end);--> statement-breakpoint
-- El mismo rango que ya tenía el catálogo: acá faltaba, y un 100% de descuento entraba liso.
ALTER TABLE "concepto_boleta_unidad" ADD CONSTRAINT "cbu_porcentaje_chk" CHECK ("concepto_boleta_unidad"."porcentaje" is null or ("concepto_boleta_unidad"."porcentaje" >= 0.01 and "concepto_boleta_unidad"."porcentaje" <= 100));--> statement-breakpoint
-- El tope es el techo del DESCUENTO. En un cargo hace lo contrario de un control: recorta en
-- silencio lo que hay que cobrar, y el cuadre ni se entera porque compara contra el ya recortado.
ALTER TABLE "concepto_boleta_unidad" ADD CONSTRAINT "cbu_tope_clase_chk" CHECK ("concepto_boleta_unidad"."tope" is null or "concepto_boleta_unidad"."clase" = 'descuento');--> statement-breakpoint
ALTER TABLE "concepto_boleta_unidad" ADD CONSTRAINT "cbu_financiamiento_chk" CHECK (("concepto_boleta_unidad"."clase" = 'descuento') = ("concepto_boleta_unidad"."financiamiento" is not null));--> statement-breakpoint
-- `cuenta_corriente` NO está habilitado: hasta que exista el módulo de cobros, el sistema no puede
-- afirmar que verificó nada, y una boleta que dice "el sistema verificó" sin que nadie haya
-- verificado es peor que no decir nada.
ALTER TABLE "concepto_boleta_unidad" ADD CONSTRAINT "cbu_origen_chk" CHECK ("concepto_boleta_unidad"."origen_evaluacion" in ('carga_manual', 'override_administrador'));--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 2. UNA sola definición de la aritmética del dinero.
--
--    Estaba escrita cinco veces: tres en el servicio y dos en el check. Si divergen, o rebotan
--    filas correctas o se acepta un importe mal calculado, y nadie se entera hasta que un vecino
--    reclama. `immutable` es lo que permite usarla dentro de un CHECK.
-- ---------------------------------------------------------------------------------------------
create or replace function app.cbu_importe_bruto(
  p_metodo app.metodo_concepto_boleta,
  p_monto_fijo numeric, p_porcentaje numeric, p_precio numeric, p_cantidad numeric, p_base numeric
) returns numeric
  language sql immutable
as $$
  select case p_metodo
           when 'monto_fijo'        then p_monto_fijo
           when 'porcentaje'        then round(p_base * p_porcentaje / 100, 2)
           when 'precio_x_cantidad' then round(p_precio * p_cantidad, 2)
         end;
$$;--> statement-breakpoint

alter table concepto_boleta_unidad drop constraint cbu_aritmetica_chk;--> statement-breakpoint
alter table concepto_boleta_unidad add constraint cbu_aritmetica_chk check (
  importe_resuelto is null
  or importe_resuelto = case
       -- El tope solo recorta descuentos. Un cargo se cobra entero o no se cobra.
       when clase = 'descuento'
         then least(app.cbu_importe_bruto(metodo, monto_fijo, porcentaje, precio_unitario, cantidad, base_calculada),
                    coalesce(tope, app.cbu_importe_bruto(metodo, monto_fijo, porcentaje, precio_unitario, cantidad, base_calculada)))
       else app.cbu_importe_bruto(metodo, monto_fijo, porcentaje, precio_unitario, cantidad, base_calculada)
     end
);--> statement-breakpoint
-- `importe_sin_tope` es lo que se imprime cuando el tope muerde: tiene que ser el bruto de verdad.
alter table concepto_boleta_unidad add constraint cbu_sin_tope_chk check (
  importe_sin_tope is null
  or importe_sin_tope = app.cbu_importe_bruto(metodo, monto_fijo, porcentaje, precio_unitario, cantidad, base_calculada)
);--> statement-breakpoint

-- "Un descuento no supera su base" no controlaba nada cuando la base era nula — que es justo el
-- caso del descuento de monto fijo. Un descuento de $500.000 sobre una expensa de $20.000 entraba.
alter table concepto_boleta_unidad drop constraint cbu_no_supera_base_chk;--> statement-breakpoint
alter table concepto_boleta_unidad add constraint cbu_no_supera_base_chk check (
  clase <> 'descuento' or importe_resuelto is null
  or (base_calculada is not null and importe_resuelto <= base_calculada)
);--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 3. El catálogo: un cargo con tope cargado es una trampa esperando a que alguien la pise.
-- ---------------------------------------------------------------------------------------------
create or replace function app.cbv_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare v_clase app.clase_concepto_boleta;
begin
  select clase into v_clase from concepto_boleta where id = new.concepto_boleta_id;
  if new.tope is not null and v_clase <> 'descuento' then
    raise exception 'el tope es el techo de un descuento: en un cargo recortaría lo que hay que cobrar';
  end if;
  return new;
end; $$;--> statement-breakpoint
create trigger trg_cbv_antes before insert or update on concepto_boleta_valor
  for each row execute function app.cbv_antes();--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 4. `app.concepto_valor_vigente` era `security definer` sin filtro de tenant: con el uuid de un
--    concepto de otro barrio devolvía su valor. Se cierra al barrio accesible.
-- ---------------------------------------------------------------------------------------------
drop function app.concepto_valor_vigente(uuid, date);--> statement-breakpoint
create function app.concepto_valor_vigente(p_concepto uuid, p_fecha date)
  returns concepto_boleta_valor
  language sql stable security definer set search_path = public, app
as $$
  select v.* from concepto_boleta_valor v
    join concepto_boleta c on c.id = v.concepto_boleta_id
   where v.concepto_boleta_id = p_concepto
     and c.barrio_id in (select app.accessible_tenant_ids())
     and v.vigente_desde <= p_fecha
     and (v.vigente_hasta is null or v.vigente_hasta >= p_fecha)
   order by v.vigente_desde desc
   limit 1;
$$;--> statement-breakpoint
grant execute on function app.concepto_valor_vigente(uuid, date) to app_request, app_job;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 5. La inversión del modelo de confianza.
--
--    En el alta, el request manda solo: concepto, unidad, período, fecha, cantidad, detalle y
--    origen. **La base escribe el resto**, copiándolo del catálogo y del valor vigente a esa fecha.
--    Un `precio_unitario` mandado desde el cliente ya no se lee: se pisa.
--
--    El tope por rol del `operador` ahora se evalúa contra lo que sí se conoce en el alta y ya es
--    confiable porque lo puso la base: el monto fijo, o el tope obligatorio del porcentual (que es
--    lo máximo que ese descuento puede llegar a valer). Antes se evaluaba `importe_resuelto`, que
--    por diseño **siempre es nulo en el INSERT**: el límite cargado no limitaba nada.
-- ---------------------------------------------------------------------------------------------
create or replace function app.cbu_antes() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_limite  limite_aplicacion_barrio%rowtype;
  v_cat     concepto_boleta%rowtype;
  v_val     concepto_boleta_valor%rowtype;
  v_maximo  numeric(14,2);
  v_acum    numeric(14,2);
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: una aplicación sin autor no se registra';
  end if;

  if tg_op = 'INSERT' then
    select * into v_cat from concepto_boleta where id = new.concepto_boleta_id;
    if v_cat is null then
      raise exception 'el concepto de boleta no existe';
    end if;
    select * into v_val from concepto_boleta_valor
     where concepto_boleta_id = new.concepto_boleta_id
       and vigente_desde <= new.fecha_hecho
       and (vigente_hasta is null or vigente_hasta >= new.fecha_hecho)
     order by vigente_desde desc limit 1;
    if v_val is null then
      raise exception 'el concepto "%" no tiene valor vigente al %: cargá el valor antes de aplicarlo',
        v_cat.nombre, new.fecha_hecho;
    end if;

    -- El snapshot lo escribe la BASE, no el request. Lo que hubiera mandado el cliente se descarta.
    new.barrio_id           := v_cat.barrio_id;
    new.valor_id            := v_val.id;
    new.clase               := v_cat.clase;
    new.metodo              := v_val.metodo;
    new.nombre_concepto     := v_cat.nombre;
    new.base_calculo        := v_cat.base_calculo;
    new.clasificacion_fiscal := v_cat.clasificacion_fiscal;
    new.financiamiento      := v_cat.financiamiento;
    new.monto_fijo          := v_val.monto_fijo;
    new.porcentaje          := v_val.porcentaje;
    new.precio_unitario     := v_val.precio_unitario;
    new.tope                := v_val.tope;
    -- `cantidad` es lo único aritmético que decide la persona (cuántas reservas). Se acota igual.
    new.cantidad            := case when v_val.metodo = 'precio_x_cantidad'
                                    then coalesce(new.cantidad, 1) else null end;
    -- La resolución nace nula SIEMPRE: el importe no se manda, se calcula contra la liquidación.
    new.base_calculada      := null;
    new.importe_resuelto    := null;
    new.importe_sin_tope    := null;
    new.aplicado_por        := v_usuario;
    new.aplicado_at         := now();
    new.anulado_at          := null;
    new.anulado_por         := null;
    new.motivo_anulacion    := null;

    -- Tope por rol. **Falla cerrado**: sin límite cargado, un operador no aplica descuentos (los
    -- cargos sí: son tarifa del catálogo, no una decisión sobre la deuda de un vecino).
    if not app.has_role_on(new.barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
      if v_cat.requiere_admin then
        raise exception 'el concepto "%" solo lo puede aplicar un administrador del barrio', v_cat.nombre;
      end if;

      if new.clase = 'descuento' then
        select * into v_limite from limite_aplicacion_barrio
         where barrio_id = new.barrio_id
           and vigente_desde <= new.fecha_hecho
           and vigente_hasta is null
         limit 1;
        if v_limite is null then
          raise exception 'el barrio no tiene límite de aplicación vigente: un operador no puede aplicar descuentos';
        end if;

        -- Lo máximo que este descuento puede llegar a valer: el monto fijo, o el tope del
        -- porcentual (que es obligatorio justamente para que este número exista).
        v_maximo := coalesce(new.monto_fijo, new.tope);
        if v_maximo is null or v_maximo > v_limite.monto_max_operador then
          raise exception 'el descuento puede llegar a % y el tope del operador es %: lo tiene que aplicar un administrador',
            coalesce(v_maximo::text, 'un monto sin techo'), v_limite.monto_max_operador;
        end if;
        if new.porcentaje is not null and new.porcentaje > v_limite.porcentaje_max_operador then
          raise exception 'el % % supera el máximo del operador (% %)',
            'porcentaje', new.porcentaje, v_limite.porcentaje_max_operador, '%';
        end if;

        -- Y el tope AGREGADO: si no, el techo se evade partiendo el descuento en varios conceptos
        -- chicos. Se suma el máximo posible de lo ya aplicado a esa unidad en ese período.
        select coalesce(sum(coalesce(monto_fijo, tope)), 0) into v_acum
          from concepto_boleta_unidad
         where periodo_id = new.periodo_id and unidad_funcional_id = new.unidad_funcional_id
           and clase = 'descuento' and anulado_at is null;
        if v_acum + v_maximo > v_limite.monto_max_operador then
          raise exception 'los descuentos de esta unidad en el período ya suman hasta % y el tope del operador es %',
            v_acum + v_maximo, v_limite.monto_max_operador;
        end if;
      end if;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    -- El snapshot COMPLETO es inmutable: no se edita, se anula y se crea otra. Editar destruye la
    -- evidencia de qué se aprobó. `aplicado_at` incluido: era retrodatable.
    if (new.concepto_boleta_id, new.valor_id, new.unidad_funcional_id, new.periodo_id, new.barrio_id,
        new.clase, new.metodo, new.nombre_concepto, new.base_calculo, new.clasificacion_fiscal,
        new.financiamiento, new.porcentaje, new.precio_unitario, new.monto_fijo, new.cantidad,
        new.tope, new.fecha_hecho, new.detalle, new.origen_evaluacion, new.aplicado_at)
       is distinct from
       (old.concepto_boleta_id, old.valor_id, old.unidad_funcional_id, old.periodo_id, old.barrio_id,
        old.clase, old.metodo, old.nombre_concepto, old.base_calculo, old.clasificacion_fiscal,
        old.financiamiento, old.porcentaje, old.precio_unitario, old.monto_fijo, old.cantidad,
        old.tope, old.fecha_hecho, old.detalle, old.origen_evaluacion, old.aplicado_at)
    then
      raise exception 'una aplicación no se edita: se anula (con motivo) y se crea otra';
    end if;
    if old.anulado_at is not null and new.anulado_at is null then
      raise exception 'una anulación no se revierte';
    end if;
    if new.anulado_at is not null and old.anulado_at is null then
      new.anulado_at  := now();          -- la fecha de anulación no es retrodatable
      new.anulado_por := v_usuario;
    end if;
    new.aplicado_por := old.aplicado_por;   -- el autor original no se pisa nunca
  end if;

  return new;
end; $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 6. La resolución del importe deja de ser escribible por el cliente.
--
--    `app_request` pierde el UPDATE sobre la tabla y conserva solo las tres columnas de la
--    anulación. La base de cálculo y el importe los escribe esta función, que los deriva de la
--    liquidación de esa misma unidad — no de lo que diga el request.
-- ---------------------------------------------------------------------------------------------
create or replace function app.resolver_aplicaciones(p_periodo uuid) returns bigint
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_barrio uuid;
  v_huerf  record;
  v_n      bigint;
begin
  select barrio_id into v_barrio from periodo_expensa where id = p_periodo;
  if v_barrio is null then
    raise exception 'el período % no existe', p_periodo;
  end if;
  -- La función saltea la RLS: el control de acceso se hace acá, explícito.
  if not app.has_role_on(v_barrio, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) then
    raise exception 'no tenés permiso para liquidar este período';
  end if;

  -- Una aplicación sobre una unidad que no tiene liquidación (dada de baja, sin coeficiente) nunca
  -- se resolvería, y el período quedaría inemitible sin que nadie sepa por qué. Se avisa acá,
  -- nombrando unidad y concepto, en vez de dejar la bomba para el momento de emitir.
  select u.manzana || '-' || u.lote as unidad, c.nombre_concepto as concepto into v_huerf
    from concepto_boleta_unidad c
    join unidad_funcional u on u.id = c.unidad_funcional_id
   where c.periodo_id = p_periodo and c.anulado_at is null
     and not exists (select 1 from liquidacion l
                      where l.periodo_id = c.periodo_id and l.unidad_funcional_id = c.unidad_funcional_id)
   limit 1;
  if v_huerf is not null then
    raise exception 'la unidad % tiene aplicado "%" pero no se le liquidó nada (¿dada de baja?): anulá la aplicación o revisá el padrón',
      v_huerf.unidad, v_huerf.concepto;
  end if;

  -- La base del descuento es cuota fija + ordinarias: NUNCA el fondo de reserva ni la
  -- extraordinaria, que tienen destino propio (doc 08 §M). Sale de la liquidación, no del request.
  with base as (
    select c.id,
           case when c.clase = 'descuento' then l.subtotal_cuota_fija + l.subtotal_ordinarias end as base,
           app.cbu_importe_bruto(c.metodo, c.monto_fijo, c.porcentaje, c.precio_unitario, c.cantidad,
                                 l.subtotal_cuota_fija + l.subtotal_ordinarias) as bruto,
           c.clase, c.tope
      from concepto_boleta_unidad c
      join liquidacion l on l.periodo_id = c.periodo_id and l.unidad_funcional_id = c.unidad_funcional_id
     where c.periodo_id = p_periodo and c.anulado_at is null
  )
  update concepto_boleta_unidad c
     set base_calculada   = b.base,
         importe_sin_tope = b.bruto,
         importe_resuelto = case when b.clase = 'descuento'
                                 then least(b.bruto, coalesce(b.tope, b.bruto))
                                 else b.bruto end
    from base b where b.id = c.id;
  get diagnostics v_n = row_count;
  return v_n;
end; $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 7. Permisos: quién puede escribir qué.
--
--    * El importe ya no lo escribe el cliente (grant por columna, solo la anulación).
--    * El registro de eventos deja de ser escribible por el request: un log al que cualquiera le
--      agrega renglones firmados por otro no sirve como evidencia. Lo escribe el trigger.
--    * Se saca el DELETE de la aplicación: por el cascade al log chocaba contra el append-only, así
--      que la funcionalidad no existía en los hechos. El camino es la anulación, con motivo.
-- ---------------------------------------------------------------------------------------------
revoke update on table concepto_boleta_unidad from app_request;--> statement-breakpoint
grant update (anulado_at, anulado_por, motivo_anulacion) on table concepto_boleta_unidad to app_request;--> statement-breakpoint
drop policy concepto_boleta_unidad_del on concepto_boleta_unidad;--> statement-breakpoint
revoke delete on table concepto_boleta_unidad from app_request;--> statement-breakpoint

drop policy concepto_boleta_unidad_evento_ins on concepto_boleta_unidad_evento;--> statement-breakpoint
revoke insert on table concepto_boleta_unidad_evento from app_request;--> statement-breakpoint
revoke update, delete on table concepto_boleta_unidad_evento from app_job;--> statement-breakpoint
-- El trigger escribe el evento salteando la RLS. **Esto es lo que hace que funcione en un Postgres
-- administrado**: ahí el dueño del esquema no es superusuario y, con `force row level security`,
-- queda sujeto a las policies — cada cargo aplicado por un `operador` fallaría entero al no poder
-- escribir su evento de alta. `app_job` tiene BYPASSRLS, así que la definer corre sin ese problema.
alter function app.cbu_evento() owner to app_job;--> statement-breakpoint
alter function app.cbu_antes() owner to app_job;--> statement-breakpoint
alter function app.resolver_aplicaciones(uuid) owner to app_job;--> statement-breakpoint
grant execute on function app.resolver_aplicaciones(uuid) to app_request;--> statement-breakpoint

-- El evento se archiva bajo el barrio de SU aplicación, no bajo el que diga quien lo escribe.
alter table concepto_boleta_unidad_evento
  add constraint fk_cbu_evento_barrio foreign key (aplicacion_id, barrio_id)
  references concepto_boleta_unidad (id, barrio_id) on delete cascade;--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- 8. `validar_emision` v4: la tercera capa. Aunque alguien lograra escribir un snapshot infiel o
--    una base inflada, el período no se emite. Se verifica contra el catálogo y contra la propia
--    liquidación, que son las dos fuentes que el request no controla.
-- ---------------------------------------------------------------------------------------------
create or replace function app.validar_aplicaciones(p_periodo uuid) returns void
  language plpgsql security definer set search_path = public, app
as $$
declare v_mal bigint; v_infiel bigint;
begin
  -- La base del descuento es la de SU liquidación, no la que esté escrita en la fila.
  select count(*) into v_mal
    from concepto_boleta_unidad c
    join liquidacion l on l.periodo_id = c.periodo_id and l.unidad_funcional_id = c.unidad_funcional_id
   where c.periodo_id = p_periodo and c.anulado_at is null and c.clase = 'descuento'
     and c.base_calculada is distinct from (l.subtotal_cuota_fija + l.subtotal_ordinarias);
  if v_mal > 0 then
    raise exception 'hay % descuentos calculados sobre una base que no es la de su liquidación', v_mal;
  end if;

  -- El snapshot sigue siendo fiel al valor del catálogo que la propia fila dice haber usado.
  select count(*) into v_infiel
    from concepto_boleta_unidad c
    join concepto_boleta_valor v on v.id = c.valor_id
    join concepto_boleta cb on cb.id = c.concepto_boleta_id
   where c.periodo_id = p_periodo and c.anulado_at is null
     and (c.metodo, c.monto_fijo, c.porcentaje, c.precio_unitario, c.tope, c.clase)
         is distinct from
         (v.metodo, v.monto_fijo, v.porcentaje, v.precio_unitario, v.tope, cb.clase);
  if v_infiel > 0 then
    raise exception 'hay % aplicaciones cuyo importe no coincide con el valor aprobado del catálogo', v_infiel;
  end if;
end; $$;--> statement-breakpoint
alter function app.validar_aplicaciones(uuid) owner to app_job;--> statement-breakpoint

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
begin
  select barrio_id, modelo, coeficiente_version_id, cuota_fija_version_id
    into v_barrio, v_modelo, v_version, v_cuota_ver
    from periodo_expensa where id = p_periodo;

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
    select count(*) into v_sin_cuota
      from unidad_funcional u
     where u.barrio_id = v_barrio and u.baja_at is null
       and not exists (select 1 from cuota_fija c where c.version_id = v_cuota_ver and c.unidad_funcional_id = u.id);
    if v_sin_cuota > 0 then
      raise exception 'faltan % cuotas fijas: hay unidades activas sin importe asignado', v_sin_cuota;
    end if;
    select coalesce(sum(g.monto), 0) into v_esperado
      from gasto_periodo g join concepto co on co.id = g.concepto_id
     where g.periodo_id = p_periodo and co.tipo = 'extraordinaria';

    -- La cuota fija cuadra contra su propia versión.
    if (select coalesce(sum(i.monto), 0) from liquidacion l join item_liquidacion i on i.liquidacion_id = l.id
         where l.periodo_id = p_periodo and i.clase_item = 'cuota_fija')
       <> (select coalesce(sum(c.importe), 0) from cuota_fija c
            join unidad_funcional u on u.id = c.unidad_funcional_id and u.baja_at is null
           where c.version_id = v_cuota_ver) then
      raise exception 'el período no cuadra: las cuotas fijas cobradas no coinciden con la versión vigente';
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

  -- Piso de cero: una boleta negativa no es un descuento, es una nota de crédito (otro artefacto).
  if exists (
    select 1 from liquidacion
     where periodo_id = p_periodo
       and subtotal_cuota_fija + subtotal_ordinarias + subtotal_extraordinarias
           + subtotal_fondo_reserva + subtotal_cargos + subtotal_descuentos < 0
  ) then
    raise exception 'hay unidades cuyo neto del período quedaría negativo';
  end if;
end; $$;;--> statement-breakpoint
alter function app.validar_emision(uuid) owner to app_job;
