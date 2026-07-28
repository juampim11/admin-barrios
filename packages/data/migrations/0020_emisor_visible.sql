-- =============================================================================================
-- 0020_emisor_visible — el nombre del administrador que va IMPRESO en la boleta, visible para
-- quien la emite.
--
-- EL DEFECTO
-- `administrador.nombre` vuelve `null` para un usuario cuya membresía está solo en el barrio y no en
-- el nodo del estudio. `tenant_node_sel` (0001) alcanza al nodo del usuario, su SUBÁRBOL y los HIJOS
-- DIRECTOS — no a los ANCESTROS, y el estudio está por encima del barrio.
--
-- POR QUÉ NO ES COSMÉTICO
-- Un `operador` SÍ puede emitir (`ROLES_QUE_EMITEN`). Hoy generaría los PDF con el emisor cayendo al
-- nombre del barrio: un dato legal impreso, equivocado, en un comprobante. Estaba anotado como
-- hallazgo en `servicios/barrios.ts` y en `servicios/vista-boleta.ts`, con un test que lo fijaba.
--
-- POR QUÉ SE ABRE Y NO SE FILTRA EN TYPESCRIPT
-- El nombre de un estudio es razón social, no PII ni dinero — y es exactamente el dato que ese mismo
-- operador imprime en la boleta que emite. No se protege nada ocultándoselo; lo único que se logra es
-- que el documento salga mal.
--
-- QUÉ **NO** RESUELVE ESTA MIGRACIÓN, Y HAY QUE DECIRLO
-- No resuelve la reimpresión de una boleta vieja. `vista-boleta.ts` lee el mandato con `hasta is
-- null`, así que una boleta de 2024 sigue mostrando la administración de hoy. Eso se arregla
-- **congelando** la marca del emisor en la liquidación al emitir
-- (`FALTANTES_CONOCIDOS.mandatoNoCongelado`), que además es la única salida para el CUIT, el
-- domicilio y el contacto del emisor: `tenant_node` no tiene esas columnas y ninguna policy las va a
-- traer nunca. Esta migración hace el sistema **usable**; el congelado lo hace **correcto**. Queda
-- como pendiente explícito para `arquitecto-software`.
--
-- Fuentes: ADR-0002 §3.4 y §3.5 · doc 09 §E.14 punto 8 · dictamen de `security-engineer` (2026-07-28).
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. Integridad de `mandato_administracion`, que hasta hoy no existía.
--
-- `administrador_id` solo tenía FK a `tenant_node` (0002): ni tipo, ni relación con el barrio. O sea
-- que un mandato podía apuntar a CUALQUIER nodo del sistema, incluido el barrio de otro estudio.
-- Mientras nadie leyera por ahí, era basura inofensiva; la policy de §2 la convertiría en un oráculo,
-- así que el candado va PRIMERO y la policy se apoya en él.
--
-- Trigger y no CHECK: un check no puede consultar otra tabla. Mismo patrón que `app.barrio_nodo_valido()`
-- (0003 §1). `security definer` porque tiene que ver los dos nodos aunque la RLS del que escribe no
-- alcance al ancestro — que es, literalmente, el problema que esta migración arregla.
-- ---------------------------------------------------------------------------------------------
create or replace function app.mandato_administrador_valido() returns trigger
  language plpgsql security definer set search_path = public, app
as $$
declare
  v_tipo_admin app.tipo_tenant;
  v_path_admin text;
  v_path_barrio text;
begin
  select tipo, path into v_tipo_admin, v_path_admin from tenant_node where id = new.administrador_id;
  select path into v_path_barrio from tenant_node where id = new.barrio_id;

  -- FALLA CERRADO: si no se puede resolver alguno de los dos nodos, se rechaza.
  if v_tipo_admin is null or v_path_barrio is null then
    raise exception 'no se pudo resolver el nodo del mandato: se rechaza por seguridad';
  end if;
  if v_tipo_admin <> 'administrador' then
    raise exception 'el mandato tiene que apuntar a un nodo de tipo administrador (llegó %)', v_tipo_admin;
  end if;
  -- El punto del `like` es literal y no un comodín de prefijo: con path `7`, `'7.%'` no matchea `70.5`.
  if v_path_barrio not like v_path_admin || '.%' then
    raise exception 'el administrador del mandato tiene que ser un ancestro del barrio: '
                    'administrar un barrio de otro árbol es una excepción de aislamiento y va por tenant_grant, '
                    'que audita quién la otorgó y por qué';
  end if;
  return new;
end; $$;--> statement-breakpoint
alter function app.mandato_administrador_valido() owner to app_job;--> statement-breakpoint
create trigger trg_mandato_administrador_valido before insert or update on mandato_administracion
  for each row execute function app.mandato_administrador_valido();--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. El conjunto de administradores legibles, con sus tres guardas.
--
-- POR QUÉ UNA FUNCIÓN Y NO UNA SUBCONSULTA CRUDA EN LA POLICY
-- La policy es de `tenant_node` y el filtro necesita leer `tenant_node` (el `path` del ancestro):
-- una subconsulta cruda da `infinite recursion detected in policy for relation "tenant_node"`. El
-- `security definer` es lo que corta la recursión, no una comodidad.
--
-- POR QUÉ LA OWNEA `app_job`
-- Misma trampa que 0017 §7: una `security definer` cuyo dueño no sea superusuario queda sujeta a
-- `force row level security`. En dev no se nota (el dueño del esquema ES superusuario); en un
-- Postgres administrado la función devolvería cero filas y el emisor volvería a caer al nombre del
-- barrio — el mismo bug, reaparecido solo en producción. `app_job` tiene BYPASSRLS.
--
-- LAS TRES GUARDAS, cada una tapando algo distinto:
--   · `tipo = 'administrador'` y ancestría real (`b.path like a.path || '.%'`) — sin ellas hay una
--     escalada de ESCRITURA a LECTURA: un `operador` puede escribir `mandato_administracion` (0003),
--     así que apuntaría un mandato de su barrio al uuid de un barrio ajeno y leería su nombre y su
--     path. Sería un oráculo de existencia de uuids arbitrarios, justo lo que el resto del esquema
--     evita. Con las dos guardas, la rama abre exactamente el nodo cuyo `nid` ya está impreso en el
--     `path` del propio barrio: no revela NADA estructural que el usuario no tuviera.
--   · `hasta is null` — solo el mandato abierto. Con los históricos, el operador acumula mandatos
--     cerrados sin límite (`mandato_sin_solape` prohíbe solapes, no cantidad) y vuelve a enumerar.
--   · `readable_tenant_ids()` y no `accessible_tenant_ids()` — roles de GESTIÓN. `propietario` y
--     `residente` quedaron sin una sola fila de dominio en 0018 §4, a propósito y por escrito;
--     devolverles un dato de otro tenant por la puerta de `tenant_node` contradiría esa decisión sin
--     que nadie la revisara. Y como acá la envoltura es definer, la diferencia deja de ser cosmética:
--     el definer saltea la RLS de `mandato_administracion`, así que el gate de rol tiene que estar
--     escrito, no heredado.
-- ---------------------------------------------------------------------------------------------
create or replace function app.administradores_con_mandato_vigente() returns setof uuid
  language sql stable security definer set search_path = public, app
as $$
  select distinct a.id
    from mandato_administracion m
    join tenant_node b on b.id = m.barrio_id
    join tenant_node a on a.id = m.administrador_id
   where m.hasta is null
     and a.tipo = 'administrador'
     and b.path like a.path || '.%'
     and a.deleted_at is null
     and b.deleted_at is null
     and m.barrio_id in (select app.readable_tenant_ids());
$$;--> statement-breakpoint
alter function app.administradores_con_mandato_vigente() owner to app_job;--> statement-breakpoint
revoke execute on function app.administradores_con_mandato_vigente() from public;--> statement-breakpoint
grant execute on function app.administradores_con_mandato_vigente() to app_request, app_job;--> statement-breakpoint

comment on function app.administradores_con_mandato_vigente() is
  'Nodos de administrador cuyo mandato ABIERTO alcanza a un barrio que el usuario puede leer con rol '
  'de gestión, y que además son ancestros reales de ese barrio. Existe solo para que quien emite una '
  'boleta pueda leer el nombre que va impreso como emisor. NO se agrega a accessible_tenant_ids(): '
  'ver el comentario de la policy.';--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. La rama nueva de `tenant_node_sel`.
--
-- ⚠ LA RAMA VA EN LA POLICY Y **NO** DENTRO DE `app.accessible_tenant_ids()`.
-- Es la parte más fácil de "simplificar" y la más cara: la segunda rama de esta misma policy abre los
-- HIJOS DIRECTOS de todo nodo accesible. Si el estudio entrara al conjunto, esa rama se dispararía
-- sobre todos sus barrios y **los barrios hermanos se verían entre sí** — el invariante central del
-- producto, roto en una línea. Entrando por la policy, el nodo del estudio se abre y sus otros hijos
-- no, porque `accessible_tenant_ids()` se sigue calculando desde `membership`.
--
-- `alter policy` y no `drop`+`create`: no hay ni un statement en el que la tabla quede sin policy de
-- lectura (precedente de 0018 §2). Las dos ramas viejas quedan textualmente iguales.
-- ---------------------------------------------------------------------------------------------
alter policy tenant_node_sel on tenant_node
  using (
    id in (select app.accessible_tenant_ids())
    or (
      deleted_at is null                 -- un tenant dado de baja no reaparece por la puerta del padre
      and parent_id is not null
      and parent_id in (select app.accessible_tenant_ids())
    )
    or (
      deleted_at is null
      and tipo = 'administrador'
      and id in (select app.administradores_con_mandato_vigente())
    )
  );
