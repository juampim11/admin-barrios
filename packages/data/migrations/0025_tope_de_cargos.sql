-- =============================================================================================
-- 0025_tope_de_cargos — el cargo deja de ser la puerta sin candado del módulo de boleta.
--
-- QUÉ ENCONTRÓ `tester` (2026-07-28, `ataques-escritura.test.ts` §8). `limite_aplicacion_barrio`
-- existía desde 0016, pero `app.cbu_antes()` **solo lo consultaba para los descuentos**. Un cargo no
-- consultaba nada: ni tope por rol, ni acumulado, ni relación con la expensa de la unidad. Por el
-- camino legítimo —el concepto real "Quincho", el precio real del catálogo, un `operador` con su rol
-- normal— se llegó a **emitir una boleta de $3.100.000 sobre una expensa de $100.000**: veinte
-- aplicaciones de $150.000 a la misma unidad, todas válidas de a una.
--
-- El razonamiento de 0016/0017 para dejar el cargo libre está escrito y era razonable: *"los cargos
-- sí: son tarifa del catálogo, no una decisión sobre la deuda de un vecino"*. Es cierto que el
-- **precio** es tarifa; lo que no es tarifa es **cuántas veces se cobra a la misma unidad en el mismo
-- período**, que es exactamente lo que quedó sin techo.
--
-- LA DECISIÓN DEL USUARIO (2026-07-28), textual:
--
--   > "Un operador tiene tope por unidad y período, igual que con los descuentos. Un administrador no
--   > tiene tope, pero el sistema le pide confirmar cuando el cargo supera varias veces la expensa de
--   > esa unidad. Frena el error de tipeo sin trabar la operatoria."
--
-- Son dos controles distintos y conviene no confundirlos:
--
--   · **El tope del operador es AUTORIZACIÓN.** Es un "no podés", y no se levanta con un clic: lo
--     tiene que aplicar un administrador. Vive en la base, por unidad y período, **acumulado** (si no,
--     se evade partiendo el cargo en varios chicos, que es literalmente cómo se llegó a los $3.100.000)
--     y **falla cerrado**: sin tope de cargos cargado, el operador no aplica cargos.
--
--   · **La confirmación es un CANDADO CONTRA EL TIPEO**, y aplica a todos los roles. No es un cartel
--     que la pantalla decide mostrar: el `insert` se **rechaza** salvo que traiga
--     `confirmacion_monto_inusual = true`. Que el control viva acá y no en la pantalla es lo que hace
--     que un script, un job o una consola no lo puedan saltear — y que la pantalla no pueda decidir
--     por su cuenta que un importe es normal, que sería autorización en el cliente.
--
-- POR QUÉ EL CANDADO ESTÁ EN EL TRIGGER Y NO EN EL SERVICIO. La confirmación llega como una columna
-- más del `insert`, y el trigger la exige. Así hay **una sola aritmética** (la de `cbu_importe_bruto`,
-- la misma que ya usan el cálculo real y el CHECK — la lección de 0017 §2), la decisión queda
-- **archivada en la fila** (quién lo aplicó, cuándo, y que lo confirmó explícitamente: un cargo de
-- $3.000.000 tiene que poder explicarse tres meses después) y ninguna vía de escritura la esquiva.
--
-- Fuente: docs/diseno/08-criterios-de-reparto.md §Y y §AC.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. Los dos parámetros nuevos, en la tabla que ya existe.
--
--    **Los dos son nullable a propósito, y ninguno tiene default permisivo** — es la regla declarada
--    de esta tabla ("Sin default permisivo", 0016 §5) y el motivo por el que el tope de descuentos
--    falla cerrado. Un `NOT NULL` obligaría a inventar un número para los barrios que ya existen, que
--    es justo el "$X hasta que lo configuren" que el diseño rechaza.
--
--    Nulo significa cosas distintas en cada columna, y las dos son seguras:
--      · `monto_max_cargo_operador` nulo  → el operador NO aplica cargos (falla cerrado).
--      · `multiplo_confirmacion_cargo` nulo → se usa el default del sistema (3), que es un umbral de
--        confirmación, no un permiso: fallar a un default acá no abre nada, solo pregunta más.
-- ---------------------------------------------------------------------------------------------
alter table limite_aplicacion_barrio add column monto_max_cargo_operador numeric(14,2);
--> statement-breakpoint
alter table limite_aplicacion_barrio add column multiplo_confirmacion_cargo numeric(6,2);
--> statement-breakpoint
alter table limite_aplicacion_barrio add constraint limite_monto_cargo_chk
  check (monto_max_cargo_operador is null or monto_max_cargo_operador >= 0);
--> statement-breakpoint
-- El rango tiene las dos puntas y las dos importan:
--   · abajo, un múltiplo de 0 haría que TODO cargo pida confirmación, y un control que salta siempre
--     es un control que la gente aprende a despachar sin leer. Un múltiplo de 1 es legítimo (un
--     barrio estricto: cualquier cargo mayor que la propia expensa se confirma).
--   · arriba, **el parámetro no puede ser la forma de apagar el control**. Un cargo de 100 veces la
--     expensa de una unidad no es una política de barrio, es un cero de más; sin este techo, cargar
--     9999 en esta columna desactivaría el candado sin que quedara dicho en ningún lado.
alter table limite_aplicacion_barrio add constraint limite_multiplo_chk
  check (multiplo_confirmacion_cargo is null
         or (multiplo_confirmacion_cargo >= 1 and multiplo_confirmacion_cargo <= 100));
--> statement-breakpoint

comment on column limite_aplicacion_barrio.monto_max_cargo_operador is
  'Hasta cuánto puede aplicar un operador en CARGOS a una misma unidad en un mismo período (acumulado). '
  'NULL = el operador no aplica cargos (falla cerrado, igual que el tope de descuentos). '
  'Es además la referencia de "cargo de rutina" del barrio cuando la unidad todavía no tiene ninguna boleta.';
--> statement-breakpoint
comment on column limite_aplicacion_barrio.multiplo_confirmacion_cargo is
  'Cuántas veces la expensa de la unidad puede sumar un cargo antes de pedir confirmación explícita. '
  'NULL = 3 (el default del sistema, escrito en app.cbu_antes). No es un permiso: por encima del '
  'umbral el cargo entra igual, pero solo con confirmación.';
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. La confirmación, archivada en la fila.
--
--    Es **lo único nuevo que el request tiene permitido mandar** desde 0017 §5. El trigger la
--    normaliza: queda en `true` solo si el cargo de verdad superó el umbral, así que la columna se
--    puede leer como "este cargo se aplicó por encima de lo normal y alguien lo confirmó" y no como
--    "alguien tildó una casilla". Es parte del snapshot inmutable: no se edita después.
-- ---------------------------------------------------------------------------------------------
alter table concepto_boleta_unidad
  add column confirmacion_monto_inusual boolean not null default false;
--> statement-breakpoint
-- Un descuento no pasa por este control (tiene el suyo, y no puede superar su propia base).
alter table concepto_boleta_unidad add constraint cbu_confirmacion_clase_chk
  check (not confirmacion_monto_inusual or clase = 'cargo');
--> statement-breakpoint
comment on column concepto_boleta_unidad.confirmacion_monto_inusual is
  'true = el cargo superó el umbral de monto inusual del barrio y quien lo aplicó lo confirmó '
  'explícitamente. Lo escribe app.cbu_antes(), no el request: lo que manda el request es la intención.';
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. La expensa de referencia de una unidad: qué es "la expensa de esa unidad" cuando el cargo se
--    carga, que es **antes** de que exista la liquidación del período.
--
--    Es el punto delicado del pedido, y la cadena de referencias es explícita para que se pueda
--    explicar en una pantalla:
--
--      1. la liquidación de esa unidad EN ESE período, si el borrador ya se generó;
--      2. si no, la última liquidación de esa unidad en un período ANTERIOR (el caso normal: los
--         cargos se cargan durante el mes, antes de liquidar);
--      3. si la unidad no tiene ninguna boleta todavía, esta función devuelve NULL y el trigger cae a
--         la única cifra que el barrio declaró sobre qué es un cargo de rutina: su propio tope de
--         cargos. Y si tampoco hay tope cargado, **no hay con qué comparar y se pide confirmación
--         siempre**. Nunca se asume "es normal": eso sería fallar abierto justo en el caso del barrio
--         recién dado de alta, que es cuando nadie tiene todavía el ojo hecho a los números.
--
--    La base es `cuota fija + ordinarias`, la MISMA que la de un descuento (doc 08 §M): sin fondo de
--    reserva ni extraordinaria. Un mes con una obra no puede volver "normal" un cargo que no lo es.
--
--    `p.periodo <= …` (texto 'YYYY-MM', que ordena bien) hace las dos cosas de un saque: prefiere la
--    liquidación del propio período y, si no está, la más reciente anterior — sin mirar el futuro, que
--    haría que el mismo cargo se juzgue distinto según cuándo se lo mire.
--
--    **SECURITY INVOKER a propósito.** Llamada desde `app.cbu_antes()` corre como `app_job` y ve todo
--    lo que necesita; llamada desde afuera queda sujeta a la RLS de `liquidacion`. Definer la
--    convertiría en un oráculo del saldo de una unidad de otro tenant. Se le revoca PUBLIC igual
--    (la lección de 0022): nadie la necesita desde afuera.
--    Índice: `idx_liquidacion_uf` sobre `liquidacion (unidad_funcional_id)`, que ya existe (0004).
-- ---------------------------------------------------------------------------------------------
create or replace function app.cbu_expensa_de_referencia(p_periodo uuid, p_unidad uuid)
  returns numeric
  language sql stable set search_path = public, app
as $$
  select l.subtotal_cuota_fija + l.subtotal_ordinarias
    from liquidacion l
    join periodo_expensa p on p.id = l.periodo_id
   where l.unidad_funcional_id = p_unidad
     -- Redundante por construcción (una unidad es de un solo barrio) y barato (dos lookups por PK):
     -- deja el aislamiento escrito en la consulta y no confiado a una invariante de otra tabla.
     and p.barrio_id = (select barrio_id from periodo_expensa where id = p_periodo)
     and p.periodo  <= (select periodo   from periodo_expensa where id = p_periodo)
     and l.subtotal_cuota_fija + l.subtotal_ordinarias > 0
   order by p.periodo desc
   limit 1;
$$;
--> statement-breakpoint
alter function app.cbu_expensa_de_referencia(uuid, uuid) owner to app_job;
--> statement-breakpoint
revoke execute on function app.cbu_expensa_de_referencia(uuid, uuid) from public;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. `app.cbu_antes()` v5.
--
--    Todo lo de 0023 queda igual (verificación de tenant sin oráculo, snapshot escrito por la base,
--    tope de descuentos, inmutabilidad de la anulación). Lo nuevo es el bloque del cargo, y un cambio
--    de estructura menor: el límite del barrio se lee **una sola vez, antes de la rama por rol**,
--    porque ahora lo necesitan las dos ramas — el múltiplo de confirmación rige también para un
--    administrador, que es justamente a quien el usuario quiso frenarle el error de tipeo.
--
--    **Por qué el importe de un cargo se conoce exacto en el alta** (y por lo tanto se puede topear
--    ahí, a diferencia del descuento porcentual): un cargo nunca es porcentual. La combinación es
--    inexpresable en el catálogo desde 0017 — `cbv_tope_obligatorio_chk` exige tope en todo valor
--    porcentual y `app.cbv_antes()` prohíbe el tope fuera de un descuento. O sea que un cargo es
--    siempre `monto_fijo` o `precio_x_cantidad`, y `app.cbu_importe_bruto(..., base => null)` devuelve
--    su importe definitivo, no una estimación.
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
      if not v_es_admin then
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
alter function app.cbu_antes() owner to app_job;
