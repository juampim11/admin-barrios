-- =============================================================================================
-- 0024_mandato_sin_oraculo — deuda propia de la 0020, y la validación de las filas que ya estaban.
--
-- El trigger `app.mandato_administrador_valido()` que agregó la 0020 §1 arregló un agujero real (un
-- mandato podía apuntar a cualquier nodo del sistema, incluido el barrio de otro estudio) pero se
-- trajo dos problemas propios, los dos señalados por la auditoría adversarial:
--
--   1. **Es un oráculo.** Contesta distinto según el uuid que le pasen:
--        nodo de otro estudio → 'el mandato tiene que apuntar a un nodo de tipo administrador (llegó barrio)'
--        uuid inexistente     → 'no se pudo resolver el nodo del mandato: se rechaza por seguridad'
--      O sea: **existencia y TIPO de cualquier `tenant_node`**, con solo probar uuids. Y
--      `mandato_administracion` la puede escribir un `operador` (0003), así que el día que exista una
--      pantalla de mandatos esto se enciende solo. Es exactamente la familia que la 0021 y la 0023
--      vinieron a cerrar en las tablas de al lado; sería incoherente dejarla abierta en la que esta
--      misma rama agregó.
--
--   2. **No mira hacia atrás.** La 0020 afirma que el candado va "PRIMERO", pero un trigger
--      `before insert or update` solo alcanza a lo que se escriba desde entonces. Si una base ya
--      tenía un mandato apuntando a donde no debía, seguía ahí — y es justo la fila que hace que
--      `administradores_con_mandato_vigente()` tenga que re-verificar tipo y ancestría al leer.
--
-- Hoy ninguno de los dos es explotable desde la aplicación: ningún servicio escribe
-- `mandato_administracion`. Se cierran igual, porque el costo de cerrarlos ahora es este archivo y el
-- de cerrarlos después es acordarse.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. El trigger deja de contestar distinto según lo que encuentre.
--
-- Un solo mensaje para todo lo que el usuario no puede ver, y el `tipo` deja de interpolarse. El
-- mensaje preciso —el que sirve— se reserva para el caso en que el usuario **sí** puede leer el nodo:
-- ahí no hay nada que sondear, porque ya lo tiene.
-- ---------------------------------------------------------------------------------------------
create or replace function app.mandato_administrador_valido() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_tipo_admin app.tipo_tenant;
  v_path_admin text;
  v_path_barrio text;
  v_visible boolean;
begin
  select tipo, path into v_tipo_admin, v_path_admin from tenant_node where id = new.administrador_id;
  select path into v_path_barrio from tenant_node where id = new.barrio_id;

  -- ¿El usuario puede ver el nodo que está proponiendo? `accessible_tenant_ids()` y no
  -- `readable_tenant_ids()`: acá se pregunta por tenancía (¿este nodo está en mi árbol?), que es
  -- justamente para lo que existe la primera.
  v_visible := new.administrador_id in (select app.accessible_tenant_ids());

  -- FALLA CERRADO, y con el MISMO texto para las tres formas de "no": el nodo no existe, no es un
  -- administrador, o no es ancestro de este barrio. Distinguirlas es el oráculo.
  if v_tipo_admin is null or v_path_barrio is null
     or v_tipo_admin <> 'administrador'
     or v_path_barrio not like v_path_admin || '.%' then

    if v_visible and v_tipo_admin is not null and v_tipo_admin <> 'administrador' then
      raise exception 'el mandato tiene que apuntar a un estudio administrador, no a un barrio ni a un sector';
    end if;
    if v_visible and v_path_barrio is not null and v_path_admin is not null then
      raise exception 'ese estudio no administra este barrio: administrar un barrio de otro árbol es '
                      'una excepción de aislamiento y va por tenant_grant, que audita quién la otorgó';
    end if;
    raise exception 'el administrador del mandato no existe o no es accesible';
  end if;

  return new;
end; $$;--> statement-breakpoint
alter function app.mandato_administrador_valido() owner to app_job;--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. Las filas que ya estaban.
--
-- No se puede "validar" un trigger como se valida un `check not valid`, así que se comprueba a mano y
-- la migración **aborta** si encuentra alguna. Es intencional que aborte: una fila así hace
-- indeterminado quién administraba un barrio cuando se emitió un comprobante, y ese dato va impreso
-- en el documento. Corregir los datos es parte de migrar, no algo para después.
-- ---------------------------------------------------------------------------------------------
do $bloque$
declare v_malas bigint;
begin
  select count(*) into v_malas
    from mandato_administracion m
    join tenant_node b on b.id = m.barrio_id
    left join tenant_node a on a.id = m.administrador_id
   where a.id is null
      or a.tipo <> 'administrador'
      or b.path not like a.path || '.%';

  if v_malas > 0 then
    raise exception 'hay % mandatos de administración que apuntan a un nodo que no es un estudio '
                    'ancestro del barrio. Hay que corregirlos antes de migrar: mientras existan, '
                    'no está determinado quién administraba el barrio al emitir un comprobante.', v_malas;
  end if;
end
$bloque$;
