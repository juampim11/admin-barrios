-- =============================================================================================
-- 0021_anulacion_y_fuga_de_catalogo — dos agujeros que aparecieron al escribir los servicios de
-- escritura del primer recorrido. Los dos están en `app.cbu_antes()`, y los dos son de la misma
-- familia que 0017: **algo que parecía estar cerrado y estaba cerrado en el lugar equivocado**.
--
-- Se reescribe la función entera (`create or replace`) porque es el patrón del repo (0013 hizo lo
-- mismo con `app.periodo_editable`): una función que se lee de arriba abajo vale más que un parche
-- que hay que ir a buscar a tres migraciones de distancia. El cuerpo es **idéntico al de 0017 §5**
-- salvo los dos bloques marcados con `-- [0021]`.
--
-- Fuentes: auditoría de `dba-data` y de `security-engineer` (2026-07-28), verificadas contra la base
-- real, no deducidas del SQL.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- AGUJERO 1 — el motivo de una anulación se podía reescribir sin dejar rastro.
--
-- `app_request` conserva el UPDATE sobre `(anulado_at, anulado_por, motivo_anulacion)`, que es lo que
-- permite anular. Pero la comprobación de inmutabilidad de 0017 §5 **no incluye `motivo_anulacion`**
-- (correctamente: es la columna que la anulación escribe), y `app.cbu_evento()` solo registra un
-- evento en la **transición** de "no anulada" a "anulada":
--
--     elsif new.anulado_at is not null and old.anulado_at is null then  -- inserta 'anulacion'
--
-- O sea: un segundo `update` sobre una fila **ya anulada** cambiaba el motivo archivado y **no
-- disparaba ningún evento**. El registro append-only quedaba diciendo una cosa y la fila otra, sin
-- que nada lo delatara. En una tabla cuyo único propósito es explicar por qué esa plata no se cobró,
-- eso vacía la explicación.
--
-- El servicio `anularAplicacion()` filtra con `anulado_at is null`, pero eso es un candado en
-- TypeScript sobre un permiso que la base concede: un script, un job o el próximo servicio que toque
-- la tabla no lo tienen. El candado va acá.
--
-- AGUJERO 2 — el nombre de un concepto de OTRO barrio, servido en un mensaje de error.
--
-- `app.cbu_antes()` es `security definer` con dueño `app_job` (BYPASSRLS): su cuerpo ve el catálogo de
-- **todos** los barrios, y corre **antes** del `with check` de la policy, que es quien rechaza la
-- fila. En el medio hay dos `raise exception` que interpolan `v_cat.nombre` y uno que interpola
-- `v_limite.monto_max_operador`. Medido contra la base: un `operador` sin ninguna relación con un
-- barrio ajeno recibía
--
--     P0001  el concepto "Multa por obra sin permiso — expediente Perez" solo lo puede aplicar un
--            administrador del barrio
--
-- La policy hacía su trabajo —la fila no entraba— pero el dato ya había salido por el canal de error.
-- Es exactamente la fuga que la capa de traducción de errores (`packages/data/src/errores.ts`) existe
-- para evitar del lado de la app, y que del lado de la base no se puede tapar traduciendo: hay que no
-- generarla.
--
-- **Esto no duplica la policy.** La autorización la sigue decidiendo `concepto_boleta_unidad_ins`,
-- que es la que rechaza la escritura. Lo que se agrega acá es un **corte temprano de información**:
-- si el usuario no tiene rol de aplicación sobre el barrio del concepto, se corta con un mensaje que
-- no dice nada de ese barrio, antes de leer el valor vigente y antes de cualquier `raise` que
-- interpole. Si algún día las dos listas divergieran, la que decide sigue siendo la policy.
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

    -- [0021] AGUJERO 2. Va acá y no más abajo: es el primer punto en el que se conoce el barrio del
    -- concepto y el último antes de que un `raise` interpole su nombre. El mensaje es deliberadamente
    -- idéntico al de un concepto inexistente: para quien no tiene acceso al barrio, "no existe" y "no
    -- podés" tienen que ser indistinguibles, o el uuid del concepto se vuelve un oráculo.
    if not app.has_role_on(v_cat.barrio_id,
                           array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) then
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

    -- [0021] AGUJERO 1. Una vez anulada, las TRES columnas de la anulación quedan congeladas. Sin
    -- esto, el motivo archivado se podía reescribir con un segundo update, y `app.cbu_evento()` no
    -- registraba nada porque solo mira la transición no-anulada → anulada.
    --
    -- Se levanta una excepción en vez de pisar los valores en silencio: un `update` que dice haber
    -- funcionado y no cambió nada es el mismo modo de falla invisible que los servicios de escritura
    -- tienen que evitar del otro lado.
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

-- `create or replace` conserva el dueño, pero se repite por si esta migración corre sobre una base
-- reconstruida desde cero con otro orden: sin dueño `app_job` (BYPASSRLS) la función queda sujeta a
-- `force row level security` en un Postgres administrado y cada cargo aplicado por un `operador`
-- falla entero (la trampa que documentó 0017 §7).
alter function app.cbu_antes() owner to app_job;
