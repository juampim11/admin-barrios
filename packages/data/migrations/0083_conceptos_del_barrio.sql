-- =============================================================================================
-- 0083_conceptos_del_barrio — el catálogo «Conceptos del barrio», los grupos de unidades, la
-- aplicación automática y la planilla de usos (encargo 16b, Etapa 1.3). **Solo DDL.**
--
--   1. Grupos de unidades: `grupo_unidades` y `grupo_unidades_miembro`.
--   2. `concepto_boleta`: a quién va, cómo entra cada mes y la unidad de uso.
--   3. El método «importe a cargar cada vez» (`importe_libre`, `0082`): checks, la aritmética, el
--      límite propio del operador y `app.cbu_antes` (copiada ENTERA de `0025`, lo nuevo `[0083]`).
--   4. Orígenes nuevos de una aplicación: `catalogo_sola` y `planilla`.
--   5. `concepto_boleta_unidad_uso`: el detalle de cada uso de una planilla, solo se agrega.
--   6. `app.validar_aplicaciones` (copiada ENTERA de `0017`) exceptúa el importe libre.
--
-- Las columnas nuevas quedan en NULL en lo que ya existe, y NULL significa «como hasta ahora»: el
-- concepto va a una unidad y se aplica a mano. Los dos catálogos (`concepto`, de gastos, y
-- `concepto_boleta`, de cargos y descuentos) NO se unen: la pantalla los muestra juntos.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. Grupos de unidades (el patrón de `bonificacion_excepcion`, `0080`)
-- ---------------------------------------------------------------------------------------------
create table grupo_unidades (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  nombre text not null,
  creado_por uuid not null,
  created_at timestamptz not null default now(),
  constraint grupo_unidades_nombre_chk check (length(btrim(nombre)) between 1 and 80),
  constraint uq_grupo_unidades_id_barrio unique (id, barrio_id)
);
--> statement-breakpoint
create unique index uq_grupo_unidades_nombre on grupo_unidades (barrio_id, lower(btrim(nombre)));
--> statement-breakpoint

create table grupo_unidades_miembro (
  grupo_id uuid not null,
  unidad_funcional_id uuid not null,
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  creado_por uuid not null,
  created_at timestamptz not null default now(),
  constraint pk_grupo_unidades_miembro primary key (grupo_id, unidad_funcional_id),
  constraint fk_grupo_miembro_grupo foreign key (grupo_id, barrio_id)
    references grupo_unidades (id, barrio_id) on delete cascade,
  constraint fk_grupo_miembro_uf foreign key (unidad_funcional_id, barrio_id)
    references unidad_funcional (id, barrio_id) on delete restrict
);
--> statement-breakpoint
create index idx_grupo_unidades_miembro_barrio on grupo_unidades_miembro (barrio_id);
--> statement-breakpoint

-- Quién y cuándo los pone la base. `security invoker`: no lee nada que quien escribe no pueda leer.
create or replace function app.grupo_unidades_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if tg_op = 'UPDATE' and tg_table_name = 'grupo_unidades_miembro' then
    raise exception 'un miembro de un grupo no se edita: se saca y se agrega';
  end if;
  if tg_op = 'UPDATE' then
    if (new.id, new.barrio_id, new.creado_por, new.created_at) is distinct from (old.id, old.barrio_id, old.creado_por, old.created_at) then
      raise exception 'de un grupo de unidades solo se cambia el nombre';
    end if;
    return new;
  end if;
  new.creado_por := app.current_user_id();
  if new.creado_por is null then
    raise exception 'un grupo de unidades se carga con una identidad';
  end if;
  new.created_at := now();
  return new;
end; $$;
--> statement-breakpoint
revoke execute on function app.grupo_unidades_antes() from public;
--> statement-breakpoint
grant execute on function app.grupo_unidades_antes() to app_request, app_job;
--> statement-breakpoint
create trigger trg_grupo_unidades_antes before insert or update on grupo_unidades
  for each row execute function app.grupo_unidades_antes();
--> statement-breakpoint
create trigger trg_grupo_unidades_miembro_antes before insert or update on grupo_unidades_miembro
  for each row execute function app.grupo_unidades_antes();
--> statement-breakpoint

do $bloque$
declare
  t text;
  admin constant text := 'array[''admin_plataforma'',''admin_barrio'']::app.rol_membership[]';
begin
  foreach t in array array['grupo_unidades', 'grupo_unidades_miembro'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    -- Lectura por rol de gestión (`app.readable_tenant_ids()`, `0018`); escritura, la administración.
    execute format('create policy %I on %I for select using (barrio_id in (select app.readable_tenant_ids()))', t || '_sel', t);
    execute format('create policy %I on %I for insert with check (app.has_role_on(barrio_id, %s))', t || '_ins', t, admin);
    execute format('create policy %I on %I for delete using (app.has_role_on(barrio_id, %s))', t || '_del', t, admin);
    execute format('grant select, insert, delete on table %I to app_request', t);
    execute format('grant select, insert, delete on table %I to app_job', t);
  end loop;
  execute format('create policy grupo_unidades_upd on grupo_unidades for update using (app.has_role_on(barrio_id, %s)) with check (app.has_role_on(barrio_id, %s))', admin, admin);
end
$bloque$;
--> statement-breakpoint
-- Del grupo solo se cambia el nombre.
grant update (nombre) on table grupo_unidades to app_request;
--> statement-breakpoint
grant update (nombre) on table grupo_unidades to app_job;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. El concepto de boleta: a quién va y cómo entra cada mes
--
-- Texto con check, al estilo de `regla_barrio` (`0080`). NULL = como hasta ahora (una unidad, a
-- mano). `sola` se aplica al calcular el mes, a todas las unidades o a las de un grupo; por eso
-- exige un destinatario que se pueda expandir sin que nadie elija unidades.
-- ---------------------------------------------------------------------------------------------
alter table concepto_boleta add column destinatario text;
--> statement-breakpoint
alter table concepto_boleta add column grupo_id uuid;
--> statement-breakpoint
alter table concepto_boleta add column modo_mes text;
--> statement-breakpoint
alter table concepto_boleta add column unidad_uso text;
--> statement-breakpoint
alter table concepto_boleta add constraint concepto_boleta_destinatario_chk
  check (destinatario is null or destinatario in ('todas', 'grupo', 'por_uso', 'una_unidad'));
--> statement-breakpoint
alter table concepto_boleta add constraint concepto_boleta_modo_mes_chk
  check (modo_mes is null or modo_mes in ('sola', 'planilla_o_mano', 'mano'));
--> statement-breakpoint
alter table concepto_boleta add constraint concepto_boleta_unidad_uso_chk
  check (unidad_uso is null or unidad_uso in ('turno', 'jornada'));
--> statement-breakpoint
alter table concepto_boleta add constraint fk_concepto_boleta_grupo foreign key (grupo_id, barrio_id)
  references grupo_unidades (id, barrio_id) on delete restrict;
--> statement-breakpoint
-- El grupo va si y solo si el destinatario es un grupo.
alter table concepto_boleta add constraint concepto_boleta_grupo_chk
  check ((destinatario is not distinct from 'grupo') = (grupo_id is not null));
--> statement-breakpoint
-- «Sola»: a todas o a un grupo, y con un importe que no depende de nada que haya que cargar
-- (ni una cantidad de usos ni un importe a mano). «Planilla»: solo lo que se cobra por uso.
alter table concepto_boleta add constraint concepto_boleta_sola_chk
  check (modo_mes is distinct from 'sola'
         or (coalesce(destinatario in ('todas', 'grupo'), false) and metodo::text in ('monto_fijo', 'porcentaje')));
--> statement-breakpoint
alter table concepto_boleta add constraint concepto_boleta_planilla_chk
  check (modo_mes is distinct from 'planilla_o_mano' or metodo::text = 'precio_x_cantidad');
--> statement-breakpoint
alter table concepto_boleta add constraint concepto_boleta_uso_metodo_chk
  check (unidad_uso is null or metodo::text = 'precio_x_cantidad');
--> statement-breakpoint
-- El importe libre es de un cargo (una multa): un descuento a mano alzada no existe.
alter table concepto_boleta add constraint concepto_boleta_importe_libre_chk
  check (metodo::text <> 'importe_libre' or clase = 'cargo');
--> statement-breakpoint
comment on column concepto_boleta.modo_mes is
  'Cómo entra el concepto cada mes: sola (se aplica al calcular), planilla_o_mano (usos) o mano. NULL = a mano, como antes de 0083.';
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. «Importe a cargar cada vez»
-- ---------------------------------------------------------------------------------------------
-- El valor del catálogo de un importe libre no lleva ningún parámetro: el importe va en la aplicación.
alter table concepto_boleta_valor drop constraint concepto_boleta_valor_parametro_chk;
--> statement-breakpoint
alter table concepto_boleta_valor add constraint concepto_boleta_valor_parametro_chk check (
  case metodo::text
    when 'monto_fijo'        then monto_fijo is not null and porcentaje is null and precio_unitario is null
    when 'porcentaje'        then porcentaje is not null and monto_fijo is null and precio_unitario is null
    when 'precio_x_cantidad' then precio_unitario is not null and monto_fijo is null and porcentaje is null
    when 'importe_libre'     then monto_fijo is null and porcentaje is null and precio_unitario is null
  end
);
--> statement-breakpoint
-- En la aplicación, el importe libre va en `monto_fijo` (lo escribe quien la carga).
alter table concepto_boleta_unidad drop constraint cbu_parametro_chk;
--> statement-breakpoint
alter table concepto_boleta_unidad add constraint cbu_parametro_chk check (
  case metodo::text
    when 'monto_fijo'        then monto_fijo is not null and porcentaje is null and precio_unitario is null and cantidad is null
    when 'porcentaje'        then porcentaje is not null and monto_fijo is null and precio_unitario is null and cantidad is null
    when 'precio_x_cantidad' then precio_unitario is not null and cantidad is not null and monto_fijo is null and porcentaje is null
    when 'importe_libre'     then monto_fijo is not null and monto_fijo > 0 and porcentaje is null and precio_unitario is null and cantidad is null
  end
);
--> statement-breakpoint

-- La única definición de la aritmética (`0017` §2), con el método nuevo. Compara como texto: el
-- valor del enum es de esta misma transacción (`0082`).
create or replace function app.cbu_importe_bruto(
  p_metodo app.metodo_concepto_boleta,
  p_monto_fijo numeric, p_porcentaje numeric, p_precio numeric, p_cantidad numeric, p_base numeric
) returns numeric
  language sql immutable
as $$
  select case p_metodo::text
           when 'monto_fijo'        then p_monto_fijo
           when 'porcentaje'        then round(p_base * p_porcentaje / 100, 2)
           when 'precio_x_cantidad' then round(p_precio * p_cantidad, 2)
           when 'importe_libre'     then p_monto_fijo
         end;
$$;
--> statement-breakpoint

-- El límite propio del operador para importes libres. NULL = el operador no carga importes a mano
-- (falla cerrado, como los otros dos topes).
alter table limite_aplicacion_barrio add column monto_max_importe_libre_operador numeric(14,2);
--> statement-breakpoint
alter table limite_aplicacion_barrio add constraint limite_importe_libre_chk
  check (monto_max_importe_libre_operador is null or monto_max_importe_libre_operador >= 0);
--> statement-breakpoint

-- `app.cbu_antes` v6: copia de la v5 de `0025`; lo nuevo va marcado `[0083]`.
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
  v_importe numeric(14,2);
  -- `numeric` sin precisión, a diferencia de las de arriba: el acumulado de varios cargos y el
  -- umbral (expensa × múltiplo) son **productos y sumas**, no importes que vayan a una columna. Con
  -- `numeric(14,2)` un barrio con expensas grandes y un múltiplo alto haría desbordar la variable en
  -- vez de comparar, y el control se caería con un error de tipo justo donde tiene que decidir.
  v_total   numeric;
  v_ref     numeric(14,2);
  v_umbral  numeric;
  v_inusual boolean;
  v_barrio_periodo uuid;
  v_barrio_unidad  uuid;
  v_es_admin boolean;
  v_libre   numeric;   -- [0083] lo ya cargado como importe libre a la unidad en el período
  v_aplica  constant app.rol_membership[] :=
    array['admin_plataforma','admin_barrio','operador']::app.rol_membership[];
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: una aplicación sin autor no se registra';
  end if;

  if tg_op = 'INSERT' then
    select * into v_cat from concepto_boleta where id = new.concepto_boleta_id;
    if v_cat is null then
      raise exception 'el concepto de boleta no existe';
    end if;

    -- [0021] El mensaje es idéntico al de un concepto inexistente: para quien no tiene acceso al
    -- barrio, "no existe" y "no podés" tienen que ser indistinguibles, o el uuid es un oráculo.
    if not app.has_role_on(v_cat.barrio_id, v_aplica) then
      raise exception 'el concepto de boleta no existe';
    end if;

    -- [0023] El período y la unidad, verificados ACÁ — antes de `app.periodo_editable()` y antes de
    -- las FK compuestas, que son los dos que contestaban distinto según el caso.
    select barrio_id into v_barrio_periodo from periodo_expensa where id = new.periodo_id;
    select barrio_id into v_barrio_unidad  from unidad_funcional where id = new.unidad_funcional_id;

    -- Sin acceso al barrio de la referencia: **un solo mensaje para todos los casos**. No se
    -- distingue "no existe" de "es de otro barrio" de "está emitido", porque esa diferencia es
    -- exactamente el oráculo.
    if v_barrio_periodo is null or not app.has_role_on(v_barrio_periodo, v_aplica) then
      raise exception 'el período no existe o no es de este barrio';
    end if;
    if v_barrio_unidad is null or not app.has_role_on(v_barrio_unidad, v_aplica) then
      raise exception 'la unidad no existe o no es de este barrio';
    end if;

    -- Con acceso a las dos puntas, el mensaje sí puede ser preciso: es el caso real del
    -- administrador de un estudio que se equivocó de barrio, y no tiene nada que sondear porque ya
    -- puede leer los dos. Las FK compuestas de 0016 §1 siguen siendo el candado; esto es el mensaje.
    if v_barrio_periodo <> v_cat.barrio_id then
      raise exception 'el período no es del mismo barrio que el concepto elegido';
    end if;
    if v_barrio_unidad <> v_cat.barrio_id then
      raise exception 'la unidad no es del mismo barrio que el concepto elegido';
    end if;

    -- [0023] `vigente_hasta > fecha` (estricto), no `>=`.
    select * into v_val from concepto_boleta_valor
     where concepto_boleta_id = new.concepto_boleta_id
       and vigente_desde <= new.fecha_hecho
       and (vigente_hasta is null or vigente_hasta > new.fecha_hecho)
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
    -- [0083] «Importe a cargar cada vez» (una multa): el importe NO sale del catálogo, lo escribe quien
    -- la carga. Es el único dato de dinero que viaja en el pedido, y por eso tiene su propio límite de
    -- operador más abajo. En todos los demás métodos, lo que mande el pedido se descarta como siempre.
    if v_val.metodo::text = 'importe_libre' then
      if new.monto_fijo is null or new.monto_fijo <= 0 then
        raise exception 'el concepto "%" lleva el importe a cargar cada vez: escribí un importe mayor que cero', v_cat.nombre;
      end if;
      new.monto_fijo        := round(new.monto_fijo, 2);
    else
      new.monto_fijo        := v_val.monto_fijo;
    end if;
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

    -- [0025] El límite del barrio, UNA vez: el tope de descuentos y el de cargos lo usan por rol, y
    -- el múltiplo de confirmación rige para todos.
    select * into v_limite from limite_aplicacion_barrio
     where barrio_id = new.barrio_id
       and vigente_desde <= new.fecha_hecho
       and vigente_hasta is null
     limit 1;

    v_es_admin := app.has_role_on(new.barrio_id,
                                  array['admin_plataforma','admin_barrio']::app.rol_membership[]);

    if not v_es_admin and v_cat.requiere_admin then
      raise exception 'el concepto "%" solo lo puede aplicar un administrador del barrio', v_cat.nombre;
    end if;

    -- ── Descuentos: tope por rol (0016/0017, sin cambios) ───────────────────────────────────
    if new.clase = 'descuento' then
      new.confirmacion_monto_inusual := false;   -- este candado es de los cargos

      if not v_es_admin then
        -- **Falla cerrado**: sin límite cargado, un operador no aplica descuentos.
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

    -- ── [0025] Cargos: tope del operador (autorización) + confirmación (anti-tipeo) ─────────
    if new.clase = 'cargo' then
      v_importe := app.cbu_importe_bruto(new.metodo, new.monto_fijo, new.porcentaje,
                                         new.precio_unitario, new.cantidad, null);
      -- Falla cerrado: un cargo cuyo importe no se puede determinar no se aplica. Hoy es
      -- inalcanzable (`cbu_parametro_chk` garantiza el parámetro del método), y por eso mismo el
      -- día que se agregue un método nuevo el modo de falla tiene que ser este y no "pasa igual".
      if v_importe is null then
        raise exception 'no se puede determinar el importe de este cargo: no se aplica sin saber cuánto es';
      end if;

      -- Lo ya cargado a ESTA unidad en ESTE período. El control es acumulado porque el agujero de
      -- los $3.100.000 no fue un cargo enorme: fueron veinte cargos chicos, todos válidos de a uno.
      select coalesce(sum(app.cbu_importe_bruto(metodo, monto_fijo, porcentaje, precio_unitario,
                                                cantidad, null)), 0)
        into v_acum
        from concepto_boleta_unidad
       where periodo_id = new.periodo_id and unidad_funcional_id = new.unidad_funcional_id
         and clase = 'cargo' and anulado_at is null;
      v_total := v_acum + v_importe;

      -- 1. AUTORIZACIÓN. No se levanta con una confirmación: es un "lo tiene que aplicar un
      --    administrador", igual que con los descuentos.
      if not v_es_admin and new.metodo::text = 'importe_libre' then
        -- [0083] El importe libre tiene SU límite de operador, aparte del tope de cargos: acá el
        -- importe lo tipea la persona, no lo fija el catálogo. Falla cerrado: sin límite cargado, un
        -- operador no carga importes libres. Y es acumulado por unidad y por mes, para que no se
        -- evada partiendo una multa en varias.
        if v_limite is null or v_limite.monto_max_importe_libre_operador is null then
          raise exception 'el barrio no tiene límite de importe libre vigente: un operador no puede cargar un importe a mano';
        end if;
        select coalesce(sum(monto_fijo), 0) into v_libre
          from concepto_boleta_unidad
         where periodo_id = new.periodo_id and unidad_funcional_id = new.unidad_funcional_id
           and metodo::text = 'importe_libre' and anulado_at is null;
        if v_libre + v_importe > v_limite.monto_max_importe_libre_operador then
          raise exception 'el importe de % (con lo ya cargado a esta unidad en el período, %) supera el límite de importe libre del operador (%): lo tiene que cargar un administrador',
            v_importe, v_libre + v_importe, v_limite.monto_max_importe_libre_operador;
        end if;
      elsif not v_es_admin then
        if v_limite is null or v_limite.monto_max_cargo_operador is null then
          raise exception 'el barrio no tiene tope de cargos vigente: un operador no puede aplicar cargos';
        end if;
        if v_importe > v_limite.monto_max_cargo_operador then
          raise exception 'el cargo de % supera el tope de cargos del operador (%): lo tiene que aplicar un administrador',
            v_importe, v_limite.monto_max_cargo_operador;
        end if;
        if v_total > v_limite.monto_max_cargo_operador then
          raise exception 'los cargos de esta unidad en el período ya suman % y el tope de cargos del operador es %',
            v_total, v_limite.monto_max_cargo_operador;
        end if;
      end if;

      -- 2. CONFIRMACIÓN. Para todos los roles: el error de tipeo no distingue jerarquía.
      v_ref := app.cbu_expensa_de_referencia(new.periodo_id, new.unidad_funcional_id);
      if v_ref is not null then
        v_umbral := round(v_ref * coalesce(v_limite.multiplo_confirmacion_cargo, 3), 2);
        v_inusual := v_total > v_umbral;
        if v_inusual and not coalesce(new.confirmacion_monto_inusual, false) then
          if v_acum = 0 then
            raise exception 'este cargo es % veces la expensa de esta unidad (% contra %): confirmá el importe para aplicarlo',
              trim_scale(round(v_importe / v_ref, 1)), v_importe, v_ref;
          else
            raise exception 'los cargos de esta unidad en el período suman % veces su expensa (% contra %): confirmá el importe para aplicarlo',
              trim_scale(round(v_total / v_ref, 1)), v_total, v_ref;
          end if;
        end if;
      else
        -- Sin ninguna boleta de esta unidad todavía. La única cifra que el barrio declaró sobre qué
        -- es un cargo de rutina es su tope de cargos; sin eso, el umbral es cero y **todo** cargo
        -- pide confirmación. Es incómodo el primer mes de un barrio, y es a propósito: es justo
        -- cuando nadie tiene todavía el ojo hecho a los números de ese barrio.
        v_umbral := coalesce(v_limite.monto_max_cargo_operador, 0);
        v_inusual := v_total > v_umbral;
        if v_inusual and not coalesce(new.confirmacion_monto_inusual, false) then
          raise exception 'esta unidad todavía no tiene ninguna boleta contra la cual comparar y los cargos del período suman % (referencia del barrio: %): confirmá el importe para aplicarlo',
            v_total, coalesce(v_limite.monto_max_cargo_operador::text, 'ninguna');
        end if;
      end if;

      -- La marca la escribe la BASE, no el request: queda en `true` solo si el cargo de verdad
      -- superó el umbral. Así la columna se puede auditar ("mostrame los cargos confirmados por
      -- monto inusual del trimestre") sin que la ensucien las casillas tildadas de más.
      new.confirmacion_monto_inusual := v_inusual;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    -- El snapshot COMPLETO es inmutable: no se edita, se anula y se crea otra. Editar destruye la
    -- evidencia de qué se aprobó. `aplicado_at` incluido: era retrodatable. Y desde 0025, la
    -- confirmación: si se pudiera apagar después, la evidencia de que alguien la dio se borraría.
    if (new.concepto_boleta_id, new.valor_id, new.unidad_funcional_id, new.periodo_id, new.barrio_id,
        new.clase, new.metodo, new.nombre_concepto, new.base_calculo, new.clasificacion_fiscal,
        new.financiamiento, new.porcentaje, new.precio_unitario, new.monto_fijo, new.cantidad,
        new.tope, new.fecha_hecho, new.detalle, new.origen_evaluacion, new.aplicado_at,
        new.confirmacion_monto_inusual)
       is distinct from
       (old.concepto_boleta_id, old.valor_id, old.unidad_funcional_id, old.periodo_id, old.barrio_id,
        old.clase, old.metodo, old.nombre_concepto, old.base_calculo, old.clasificacion_fiscal,
        old.financiamiento, old.porcentaje, old.precio_unitario, old.monto_fijo, old.cantidad,
        old.tope, old.fecha_hecho, old.detalle, old.origen_evaluacion, old.aplicado_at,
        old.confirmacion_monto_inusual)
    then
      raise exception 'una aplicación no se edita: se anula (con motivo) y se crea otra';
    end if;
    if old.anulado_at is not null and new.anulado_at is null then
      raise exception 'una anulación no se revierte';
    end if;

    -- [0021] Una vez anulada, las TRES columnas de la anulación quedan congeladas.
    if old.anulado_at is not null
       and (new.anulado_at, new.anulado_por, new.motivo_anulacion)
           is distinct from (old.anulado_at, old.anulado_por, old.motivo_anulacion) then
      raise exception 'el motivo de una anulación no se reescribe: quedó registrado el % y es la única '
                      'explicación de por qué ese importe no se cobró', old.anulado_at::date;
    end if;

    if new.anulado_at is not null and old.anulado_at is null then
      new.anulado_at  := now();          -- la fecha de anulación no es retrodatable
      new.anulado_por := v_usuario;
    end if;
    new.aplicado_por := old.aplicado_por;   -- el autor original no se pisa nunca
  end if;

  return new;
end; $$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. De dónde salió una aplicación: suma «la aplicó el catálogo sola» y «vino de una planilla»
--
-- `regla_barrio` (`0080`) queda para la bonificación por pago en término, que `validar_emision`
-- ata a «Cómo se devenga». Los conceptos del catálogo que se aplican solos llevan `catalogo_sola`.
-- ---------------------------------------------------------------------------------------------
alter table concepto_boleta_unidad drop constraint cbu_origen_chk;
--> statement-breakpoint
alter table concepto_boleta_unidad add constraint cbu_origen_chk
  check (origen_evaluacion in ('carga_manual', 'override_administrador', 'regla_barrio', 'catalogo_sola', 'planilla'));
--> statement-breakpoint
-- Lo que entra solo o por planilla es UN renglón vivo por unidad, concepto y mes. El servicio ya lo
-- cuida; esto es el candado para dos cálculos o dos subidas a la vez (panel `security-engineer`, 1).
create unique index uq_cbu_automatico_unico on concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id, origen_evaluacion)
  where origen_evaluacion in ('catalogo_sola', 'planilla') and anulado_at is null;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 5. El detalle de los usos de una planilla
--
-- Una planilla trae un renglón por uso (unidad, concepto, fecha, cantidad). La aplicación es UNA
-- por unidad, concepto y mes, con la cantidad sumada; acá queda cada uso, para imprimirlo en la
-- boleta y para poder rehacer la suma. Solo se agrega (`app.solo_append`, `0016`), y solo mientras
-- el mes no esté emitido.
-- ---------------------------------------------------------------------------------------------
create table concepto_boleta_unidad_uso (
  id uuid primary key default gen_random_uuid(),
  barrio_id uuid not null references barrio (barrio_id) on delete restrict,
  aplicacion_id uuid not null,
  fecha date not null,
  cantidad numeric(12,3) not null,
  archivo text not null,
  fila integer,
  creado_por uuid not null,
  created_at timestamptz not null default now(),
  constraint cbu_uso_cantidad_chk check (cantidad > 0 and cantidad <= 100),
  constraint cbu_uso_archivo_chk check (length(btrim(archivo)) between 1 and 200),
  constraint fk_cbu_uso_aplicacion foreign key (aplicacion_id, barrio_id)
    references concepto_boleta_unidad (id, barrio_id) on delete cascade
);
--> statement-breakpoint
create index idx_cbu_uso_aplicacion on concepto_boleta_unidad_uso (aplicacion_id);
--> statement-breakpoint
create index idx_cbu_uso_barrio on concepto_boleta_unidad_uso (barrio_id);
--> statement-breakpoint

create or replace function app.cbu_uso_antes() returns trigger
  language plpgsql set search_path = public, app
as $$
declare
  v_estado app.estado_periodo;
  v_origen text;
begin
  select pe.estado, c.origen_evaluacion into v_estado, v_origen
    from concepto_boleta_unidad c join periodo_expensa pe on pe.id = c.periodo_id
   where c.id = new.aplicacion_id and c.barrio_id = new.barrio_id;
  if v_estado is null then
    raise exception 'la aplicación del uso no existe o no es de este barrio';
  end if;
  if v_estado in ('emitida', 'distribuida') then
    raise exception 'el período ya está % : no se edita (se corrige en el período siguiente)', v_estado;
  end if;
  if v_origen <> 'planilla' then
    raise exception 'el detalle de usos es de una aplicación que vino de una planilla';
  end if;
  new.creado_por := app.current_user_id();
  if new.creado_por is null then
    raise exception 'un uso se carga con una identidad';
  end if;
  new.created_at := now();
  return new;
end; $$;
--> statement-breakpoint
revoke execute on function app.cbu_uso_antes() from public;
--> statement-breakpoint
grant execute on function app.cbu_uso_antes() to app_request, app_job;
--> statement-breakpoint
create trigger trg_cbu_uso_antes before insert on concepto_boleta_unidad_uso
  for each row execute function app.cbu_uso_antes();
--> statement-breakpoint
create trigger trg_cbu_uso_append before update or delete on concepto_boleta_unidad_uso
  for each row execute function app.solo_append();
--> statement-breakpoint

alter table concepto_boleta_unidad_uso enable row level security;
--> statement-breakpoint
alter table concepto_boleta_unidad_uso force row level security;
--> statement-breakpoint
create policy concepto_boleta_unidad_uso_sel on concepto_boleta_unidad_uso for select
  using (barrio_id in (select app.readable_tenant_ids()));
--> statement-breakpoint
-- Los usos los carga quien aplica cargos: la administración o un operador (con sus topes, que
-- valen sobre la aplicación, `app.cbu_antes`).
create policy concepto_boleta_unidad_uso_ins on concepto_boleta_unidad_uso for insert
  with check (app.has_role_on(barrio_id, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]));
--> statement-breakpoint
grant select, insert on table concepto_boleta_unidad_uso to app_request;
--> statement-breakpoint
grant select, insert on table concepto_boleta_unidad_uso to app_job;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 6. `app.validar_aplicaciones`: copia de `0017` §8; lo nuevo va marcado `[0083]`.
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
     -- [0083] Con «importe a cargar cada vez» el importe no está en el catálogo: lo escribió quien
     -- cargó la aplicación (con su límite, `app.cbu_antes`). Se compara todo lo demás.
     and (c.metodo, case when c.metodo::text = 'importe_libre' then null else c.monto_fijo end,
          c.porcentaje, c.precio_unitario, c.tope, c.clase)
         is distinct from
         (v.metodo, v.monto_fijo, v.porcentaje, v.precio_unitario, v.tope, cb.clase);
  if v_infiel > 0 then
    raise exception 'hay % aplicaciones cuyo importe no coincide con el valor aprobado del catálogo', v_infiel;
  end if;
end; $$;
