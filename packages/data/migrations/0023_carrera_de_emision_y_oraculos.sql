-- =============================================================================================
-- 0023_carrera_de_emision_y_oraculos — tres agujeros que encontró `tester` ejercitando los
-- servicios de escritura contra la base real. Los tres son de la misma familia: **un control que
-- mira un dato que otra transacción está por cambiar, o que responde distinto según lo que vio**.
--
-- Fuente: auditoría adversarial de `tester` (2026-07-28), reproducida con transacciones
-- deterministas (sin `sleep`), en `packages/data/test/ataques-escritura.test.ts`.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- AGUJERO 1 (CRÍTICO, dinero) — se emite un período que NO cuadra, y no hay vuelta atrás.
--
-- CÓMO SE REPRODUCE, sin carrera de laboratorio:
--   T1: begin; insert into gasto_periodo (…);            -- no commitea todavía
--   T2: begin; update periodo_expensa set estado='emitida'; commit;
--   T1: commit;
--   → período EMITIDO con $77.000 de gasto que ninguna boleta cobra.
--
-- POR QUÉ PASABA. Ninguno de los dos lados tomaba un lock que el otro viera:
--   · `app.periodo_editable()` hacía `select estado into v_estado … where id = v_periodo` — una
--     lectura pelada. En su snapshot el período seguía en `borrador`, así que dejaba entrar el gasto.
--   · `app.validar_emision` suma `gasto_periodo` bajo READ COMMITTED y **no ve el gasto sin
--     commitear**, así que esperado = repartido y el cuadre cerraba.
--   Cada uno era correcto respecto de lo que veía. El problema es que no se veían entre ellos.
--
-- Y no se autorepara: el período queda `emitida`, o sea inmutable, y `generarLiquidaciones` lo
-- rechaza. No hay camino de vuelta desde la aplicación.
--
-- No es un caso raro: dos personas del mismo estudio, una cargando la última factura y otra
-- apretando "Emitir", es la operatoria normal de un fin de mes.
--
-- EL ARREGLO: **`for share`**, o sea la escalera de locks que faltaba.
--   · quien ESCRIBE en el período (gasto, liquidación, línea, aplicación) toma `for share` sobre la
--     fila del período: varios pueden escribir a la vez —`share` no conflictúa con `share`—, que es
--     el caso normal;
--   · quien EMITE hace `update periodo_expensa`, que toma un lock exclusivo de fila y por lo tanto
--     **espera** a que los escritores commiteen;
--   · quien REGENERA toma `for no key update` explícito al principio (ver `liquidacion.ts`), así dos
--     regeneraciones se serializan arriba en vez de deadlockear al final.
--
-- Con esto, la secuencia de arriba termina bien de las dos formas posibles:
--   · si el gasto llegó primero, la emisión espera, ve el gasto y **rechaza por no cuadrar**;
--   · si la emisión llegó primero, el gasto espera, re-lee el estado bajo READ COMMITTED y ve
--     `emitida` → **lo rechaza el trigger**, como corresponde.
--
-- El resto del cuerpo es idéntico al de 0013 §1.
-- ---------------------------------------------------------------------------------------------
create or replace function app.periodo_editable() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_estado  app.estado_periodo;
  v_periodo uuid;
begin
  -- IF/ELSIF y no CASE: plpgsql prepara cada sentencia por separado, así solo se resuelven los
  -- campos de la tabla que disparó el trigger.
  if tg_table_name = 'item_liquidacion' then
    select periodo_id into v_periodo from liquidacion where id = coalesce(new.liquidacion_id, old.liquidacion_id);
  else
    v_periodo := coalesce(new.periodo_id, old.periodo_id);
  end if;

  -- FALLA CERRADO: si no se puede determinar el período, se rechaza. Única excepción: un DELETE en
  -- cascada, donde el padre ya desapareció.
  if v_periodo is null then
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'no se pudo determinar el período de la fila: se rechaza por seguridad';
  end if;

  -- [0023] `for share` y no una lectura pelada. Es lo único que cambió, y es lo que serializa a este
  -- escritor con quien esté emitiendo. Bajo READ COMMITTED, si otra transacción tiene la fila
  -- bloqueada, esto ESPERA y después re-lee la versión ya commiteada — que es exactamente lo que
  -- hace falta para no decidir sobre un estado viejo.
  select estado into v_estado from periodo_expensa where id = v_periodo for share;

  if v_estado is null then
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'el período % no existe: se rechaza por seguridad', v_periodo;
  end if;

  if v_estado in ('emitida', 'distribuida') then
    raise exception 'el período ya está % : no se edita (se corrige en el período siguiente)', v_estado;
  end if;

  return coalesce(new, old);
end; $$;--> statement-breakpoint
alter function app.periodo_editable() owner to app_job;--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- AGUJERO 2 (ALTO, aislamiento) — el estado de un período de otro estudio, servido por el error.
--
-- Un `operador` de A1 aplicaba un concepto **legítimo de su propio barrio** pasando un `periodo_id`
-- ajeno, y distinguía tres desenlaces:
--
--     uuid inexistente        → periodo_no_editable        {}
--     período de B1 borrador  → referencia_de_otro_barrio  {}
--     período de B1 emitido   → periodo_no_editable        { estado: "emitida" }
--
-- O sea: **oráculo de existencia de uuids arbitrarios, más el estado de un período de otro tenant**,
-- y llegando a la pantalla como `codigo` + `datos`, no solo al log.
--
-- POR QUÉ SE ESCAPÓ DE LA 0021. El corte temprano que agregó esa migración protege el barrio **del
-- concepto**. Acá el concepto es propio: lo que se sondea es el **período**. `trg_cbu_antes` pasaba
-- limpio y después corría `trg_cbu_editable` → `app.periodo_editable()`, que es `security definer`,
-- lee `periodo_expensa` **sin RLS** e interpola el estado. Es la misma familia del agujero 2 de la
-- 0021, en la tabla de al lado. Y el orden importa: los dos triggers `before` corren **antes** que
-- las FK compuestas, así que la FK no llegaba a taparlo.
--
-- Los tres servicios de gasto no tienen el problema: `registrarGasto` entra por
-- `insert … select from periodo_expensa`, así que sin fila legible no hay insert; corregir y borrar
-- parten de una fila ya visible. `aplicarConceptoAUnidad` es el único que le pasa un `periodo_id`
-- crudo al trigger.
--
-- EL ARREGLO: verificar el período **y la unidad** en `app.cbu_antes()`, antes de que cualquier otro
-- control pueda contestar distinto. Con un detalle que conserva la utilidad del mensaje: si el
-- usuario **sí** tiene acceso al barrio del período, se le dice exactamente qué pasó (es el caso real
-- de un administrador de estudio que se equivocó de barrio); si no lo tiene, todos los casos dan el
-- mismo mensaje y no hay nada que sondear.
--
-- AGUJERO 3 (MEDIO, dinero) — dos valores del catálogo vigentes el mismo día.
--
-- Subir el precio con `vigente_desde` igual a la fecha del valor abierto dejaba DOS filas matcheando:
-- `app.concepto_boleta_valor_antes` cierra el anterior con `vigente_hasta = new.vigente_desde`, y
-- esta función filtraba con `vigente_hasta >= fecha_hecho` (**inclusivo**). El `order by … limit 1`
-- desempataba solo, y se llegó a congelar **el precio viejo el día en que ya regía el nuevo**.
--
-- El repo ya tiene la convención escrita (0018 §6: *"`hasta` es EXCLUSIVO, igual que `vigente_hasta`
-- en todo el resto del modelo"*) y `app.concepto_valor_vigente()` ya usa `>` estricto. El `>=` de acá
-- era el outlier. Se corrige a `>`: con eso el rango cerrado no matchea su propio día de cierre y
-- queda **una sola** fila vigente, siempre la nueva.
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
  v_barrio_periodo uuid;
  v_barrio_unidad  uuid;
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

    -- [0023] `vigente_hasta > fecha` (estricto), no `>=`. Ver AGUJERO 3.
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
end; $$;--> statement-breakpoint
alter function app.cbu_antes() owner to app_job;--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- El mismo borde de vigencia, en la lectura del catálogo.
--
-- `app.concepto_valor_vigente()` ya usaba `>` estricto en 0016, y 0017 §4 lo reescribió con `>=` al
-- cerrarlo por tenant. Quedaba siendo la tercera definición distinta de "vigente" en el mismo
-- módulo: la pantalla podía mostrar un precio y la boleta congelar el otro. Vuelve a `>`.
-- ---------------------------------------------------------------------------------------------
create or replace function app.concepto_valor_vigente(p_concepto uuid, p_fecha date)
  returns concepto_boleta_valor
  language sql stable security definer set search_path = public, app
as $$
  select v.* from concepto_boleta_valor v
    join concepto_boleta c on c.id = v.concepto_boleta_id
   where v.concepto_boleta_id = p_concepto
     and c.barrio_id in (select app.accessible_tenant_ids())
     and v.vigente_desde <= p_fecha
     and (v.vigente_hasta is null or v.vigente_hasta > p_fecha)
   order by v.vigente_desde desc
   limit 1;
$$;
