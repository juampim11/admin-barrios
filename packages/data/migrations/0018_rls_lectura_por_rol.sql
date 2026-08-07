-- =============================================================================================
-- 0018_rls_lectura_por_rol — cierra la precondición de seguridad del ADR-0002 §3.5.
--
-- EL AGUJERO QUE SE CIERRA
-- Las policies de `select` de dominio (0003), expensas (0005), modelos de expensa (0007) y
-- trazabilidad (0009) eran `barrio_id in (select app.accessible_tenant_ids())`, **sin mirar el rol**.
-- `accessible_tenant_ids()` solo mira `user_id`, `activo` y el subárbol. Resultado:
--
--   · "barrios hermanos no se ven"  → SÍ se cumplía.
--   · "vecinos no se ven"           → NO se cumplía. Dentro de un barrio, CUALQUIER membresía
--                                     (incluida `propietario`) leía el padrón entero con la PII de
--                                     todos los propietarios, todos los gastos y todas las
--                                     liquidaciones de todas las unidades.
--
-- Hoy es teórico porque no hay login; el incremento que viene lo entrega. Por eso se cierra AHORA.
--
-- Fuentes: docs/arquitectura/02-aplicacion-web-del-administrador.md §3.5 (precondición) ·
--          0016_cargos_descuentos_reglas.sql §6 (que ya lo había resuelto para su módulo).
--
-- Regla del repo: una migración ya aplicada NO se edita; se agrega la siguiente con prefijo mayor.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. `app.readable_tenant_ids()` — el gemelo de `accessible_tenant_ids()` que SÍ mira el rol.
--
-- POR QUÉ UN CONJUNTO Y NO `has_role_on()` POR FILA (que es lo que hace 0016).
-- `has_role_on()` es SECURITY DEFINER, y Postgres **nunca inlinea** una función SECURITY DEFINER:
-- es una llamada real por cada fila evaluada. Medido en esta base (Postgres 16, fixture de 20
-- barrios · 6.000 unidades · 6.000 obligados · 48.000 ítems de liquidación, todo en caché):
--
--   tabla              filas    sin gate    gate por fila (has_role_on)   gate por conjunto (esta)
--   item_liquidacion   48.000    21,6 ms      4.518,8 ms   (×209)           32,2 ms   (×1,5)
--   obligado            6.000     5,9 ms        737,8 ms   (×124)            8,5 ms   (×1,4)
--
-- Copiar el patrón de 0016 tal cual habría cerrado el agujero y entregado una regresión de dos
-- órdenes de magnitud en la grilla de revisión y en el padrón — justo las dos pantallas del ADR-0002.
--
-- Escrita como STABLE y sin parámetros, se usa como `barrio_id in (select app.readable_tenant_ids())`:
-- la subconsulta no referencia la fila, así que el planificador la resuelve como **InitPlan hasheado
-- y la evalúa UNA vez por query** (se ve como `Filter: (hashed SubPlan 1)` en el EXPLAIN). Es
-- exactamente la forma que ya usa `accessible_tenant_ids()` en todo el repo, y por eso no hace falta
-- índice nuevo: el trabajo interno lo resuelven `idx_membership_user_activo` e
-- `idx_tenant_node_path_prefix` (text_pattern_ops), que ya existen desde 0000.
--
-- Sin parámetro de roles A PROPÓSITO: "quién puede leer los datos de un barrio" tiene que tener UNA
-- definición, en un solo lugar, imposible de invocar con la lista equivocada desde una policy.
-- SECURITY DEFINER con `search_path` fijo, igual que sus hermanas (si no, un search_path del cliente
-- podría secuestrar la resolución de `membership`).
-- ---------------------------------------------------------------------------------------------
create or replace function app.readable_tenant_ids() returns setof uuid
  language sql stable security definer
  set search_path = public, app
as $$
  select distinct d.id
  from membership m
  join tenant_node n on n.id = m.tenant_node_id
  join tenant_node d on d.path = n.path or d.path like n.path || '.%'   -- el nodo y su subárbol
  where m.user_id = app.current_user_id()
    and m.activo
    -- Los roles de GESTIÓN. `propietario` y `residente` quedan afuera: ver §4.
    and m.rol = any (array['admin_plataforma','admin_barrio','operador','contador','auditor']::app.rol_membership[])
    and n.deleted_at is null
    and d.deleted_at is null;
$$;
--> statement-breakpoint

-- Una función SECURITY DEFINER no queda ejecutable por cualquiera.
revoke execute on function app.readable_tenant_ids() from public;
--> statement-breakpoint
grant execute on function app.readable_tenant_ids() to app_request, app_job;
--> statement-breakpoint

comment on function app.readable_tenant_ids() is
  'Subárbol de tenants sobre el que el usuario actual tiene un rol de GESTIÓN (admin_plataforma, '
  'admin_barrio, operador, contador, auditor). Es la fuente única de la lectura del dominio: toda '
  'policy de SELECT con datos de barrio la usa. Subconjunto estricto de app.accessible_tenant_ids(), '
  'que NO mira el rol y solo sirve para tenancía (tenant_node).';
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. Se reescriben las 19 policies de SELECT que no miraban el rol.
--
-- `alter policy` y no `drop`+`create`: no hay ventana —ni de un statement— en la que la tabla quede
-- sin policy de lectura. Los nombres y los grants no se tocan.
--
-- El `using` nuevo NO es "lo de antes AND el rol": `readable_tenant_ids()` ya es un subconjunto
-- estricto de `accessible_tenant_ids()` (mismo recorrido de subárbol, más el filtro de rol), así que
-- reemplazarlo entero es equivalente y deja un solo InitPlan en vez de dos.
-- ---------------------------------------------------------------------------------------------
do $bloque$
declare
  t text;
  tablas text[] := array[
    -- 0003_dominio_rls (padrón)
    'barrio', 'barrio_atributo_vigencia', 'unidad_funcional', 'unidad_contacto', 'obligado',
    'unidad_obligado', 'coeficiente_version', 'coeficiente', 'documento_barrio',
    'mandato_administracion',
    -- 0005_expensas_rls (liquidación)
    'concepto', 'tasa_mora', 'periodo_expensa', 'gasto_periodo', 'liquidacion', 'item_liquidacion',
    -- 0007_modelos_expensa_reglas (cuota fija)
    'cuota_fija_version', 'cuota_fija',
    -- 0009_trazabilidad_reglas (medios de pago)
    'medio_pago_barrio'
  ];
begin
  foreach t in array tablas loop
    execute format(
      'alter policy %I on %I using (barrio_id in (select app.readable_tenant_ids()))',
      t || '_sel', t);
  end loop;
end
$bloque$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. Las 5 tablas de 0016 pasan a la misma forma.
--
-- 0016 ya era CORRECTO en seguridad (fue el que dio el patrón); lo que cambia acá es solo la FORMA:
-- de `... in (select accessible) and has_role_on(barrio_id, roles_lectura)` a
-- `... in (select readable)`. Mismas filas visibles para los mismos usuarios, sin la llamada por
-- fila. `concepto_boleta_unidad` crece como `liquidacion` (una fila por unidad y período): hoy es
-- chica, y por eso el costo no se veía, pero el ×124 medido arriba la estaba esperando.
-- ---------------------------------------------------------------------------------------------
do $bloque$
declare t text;
begin
  foreach t in array array['concepto_boleta', 'concepto_boleta_valor', 'concepto_boleta_unidad',
                           'concepto_boleta_unidad_evento', 'limite_aplicacion_barrio'] loop
    execute format(
      'alter policy %I on %I using (barrio_id in (select app.readable_tenant_ids()))',
      t || '_sel', t);
  end loop;
end
$bloque$;
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 4. `propietario` y `residente`: SIN ACCESO, explícitamente y por ahora.
--
-- Con §2 y §3, una membresía `propietario`/`residente` no lee NI UNA FILA de padrón, expensas,
-- cuota fija, medios de pago ni cargos/descuentos. Es una restricción TEMPORAL y deliberadamente
-- gruesa, no la respuesta final.
--
-- POR QUÉ NO SE APROXIMA "QUE VEA LO SUYO"
-- Para que un propietario vea su unidad hace falta un vínculo **usuario → unidad funcional**, y ese
-- vínculo NO EXISTE en el modelo. Lo que hay es `unidad_obligado`, que liga una unidad con un
-- `obligado` (una persona del padrón), no con un `user_id` de la plataforma; y todavía no hay tabla
-- de usuarios. Cualquier policy que hoy intente aproximarlo —por email del obligado, por nombre, por
-- lo que sea— sería una regla de identidad inventada en la capa de datos: o filtra de más (rompe) o
-- filtra de menos (vuelve a abrir el agujero, y esta vez en silencio).
--
-- QUÉ HACE FALTA PARA LEVANTARLA (prerequisito del PORTAL DEL RESIDENTE, que la va a necesitar sí o sí)
--   1. La tabla de usuarios de la plataforma, que el ADR-0002 §2.3 recién introduce.
--   2. Una tabla de vínculo `usuario_unidad` (user_id, unidad_funcional_id, barrio_id, vigencia),
--      con FK compuesta `(unidad_funcional_id, barrio_id)` como el resto del padrón, y quién/cuándo
--      lo otorgó — es una habilitación de acceso a datos personales, se audita.
--   3. Una `app.unidades_del_usuario()` con la misma forma de conjunto que esta función (InitPlan,
--      una evaluación por query), y policies de SELECT partidas en dos ramas:
--         gestión   → barrio_id in (select app.readable_tenant_ids())
--         residente → unidad_funcional_id in (select app.unidades_del_usuario())
--      Las tablas SIN `unidad_funcional_id` (gasto_periodo, concepto, documento_barrio…) NO se
--      abren: el residente ve su boleta, no la contabilidad del barrio.
--   4. Decidir aparte `concepto_boleta_unidad`: ahí lo que se filtra no es un monto sino el MOTIVO
--      del descuento ("jubilado", "eximición social") — dato sensible sobre un tercero. Ver 0016 §6.
--
-- Referencias: ADR-0002 §3.5 punto 4 · doc 07 §G.3 · doc 08 · doc 09 §E.
-- ---------------------------------------------------------------------------------------------


-- ---------------------------------------------------------------------------------------------
-- 5. Tenancía: `membership` y `tenant_grant`.
--
-- `membership` filtraba solo por subárbol: un `propietario` leía el padrón de USUARIOS del barrio
-- (quién tiene acceso y con qué rol). Pasa a: cada quien ve SIEMPRE sus propias membresías —lo
-- necesita el login para saber a qué barrios entra y con qué rol—, y el elenco completo lo ve solo
-- la gestión.
--
-- `tenant_grant` es la excepción de aislamiento auditada (art. 2084): metadato de administración
-- entre tenants. No tiene nada que hacer del lado del residente.
--
-- `tenant_node` se deja como está, A PROPÓSITO: es el único lugar donde un futuro residente puede
-- averiguar el nombre del barrio al que pertenece, y no contiene ni PII ni dinero (tipo, nombre,
-- path). Cerrarlo rompería el portal del residente antes de que exista, sin proteger nada.
-- ---------------------------------------------------------------------------------------------
alter policy membership_sel on membership
  using (
    (user_id = app.current_user_id() and tenant_node_id in (select app.accessible_tenant_ids()))
    or tenant_node_id in (select app.readable_tenant_ids())
  );
--> statement-breakpoint

alter policy tenant_grant_sel on tenant_grant
  using (
    origen_id in (select app.readable_tenant_ids())
    or destino_id in (select app.readable_tenant_ids())
  );
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 6. Mandatos de administración que no se pueden solapar.
--
-- `uq_mandato_vigente` (0002) impide DOS MANDATOS ABIERTOS por barrio, y nada más: dos mandatos con
-- fechas cerradas que se pisan entraban igual. Con eso, "quién administraba este barrio el día que
-- se emitió este comprobante" deja de estar determinado — y ese dato va IMPRESO en el documento
-- (doc 09 §E.14 punto 8: la boleta la firma el administrador con mandato vigente al emitir).
-- Una restricción de unicidad no puede expresar "estos dos rangos no se tocan"; una **restricción
-- de exclusión** sí, y la hace cumplir un índice, no un trigger que se puede correr en paralelo.
--
-- SOBRE LA EXTENSIÓN (regla del repo: sin extensiones salvo justificación explícita).
-- `btree_gist` es un módulo **contrib estándar** de Postgres —no una feature de un proveedor— y
-- desde Postgres 13 es una extensión **trusted**: la puede instalar cualquier rol con CREATE sobre
-- la base, sin superusuario. Por eso se puede crear en un Postgres administrado (RDS, Cloud SQL,
-- Azure Database y Supabase la traen en la lista de permitidas). Hace falta porque GiST solo no sabe
-- comparar `barrio_id` (uuid) por igualdad dentro de una restricción de exclusión.
-- SI NO SE PUDIERA CREAR (un proveedor que no la habilite): el `do` de abajo aborta la migración con
-- un mensaje explícito, en vez de dejar los barrios sin la garantía. El plan B sería un trigger
-- BEFORE INSERT/UPDATE que tome `pg_advisory_xact_lock(hashtext(barrio_id::text))` y recién ahí
-- busque solapamientos — correcto, pero más lento y más fácil de romper; por eso no es el plan A.
-- ---------------------------------------------------------------------------------------------
do $bloque$
begin
  create extension if not exists btree_gist;
exception when others then
  raise exception
    'no se pudo crear la extensión btree_gist (%), necesaria para impedir mandatos de administración '
    'solapados. Es contrib estándar y trusted desde Postgres 13. Si el proveedor no la habilita, hay '
    'que reemplazar la restricción de exclusión de esta migración por el trigger con advisory lock '
    'descripto en el comentario de arriba.', sqlerrm;
end
$bloque$;
--> statement-breakpoint

-- `hasta` es EXCLUSIVO, igual que `vigente_hasta` en todo el resto del modelo (`valor_eje_vigente` y
-- `tasa_mora_vigente` filtran con `vigente_hasta > fecha`, y los triggers de vigencia cierran la
-- anterior con `vigente_hasta = nueva.vigente_desde`). O sea: el traspaso normal se escribe con el
-- `hasta` del saliente IGUAL al `desde` del entrante, y eso NO es un solapamiento.
--
-- Por eso `mandato_rango_chk` (0002) queda corto: permite `hasta = desde`, que bajo esta semántica es
-- un rango VACÍO — y un rango vacío no se solapa con nada, así que se colaría por debajo de la
-- restricción de exclusión. Se prohíbe el mandato de duración cero.
alter table mandato_administracion
  add constraint mandato_rango_no_vacio_chk check (hasta is null or hasta > desde);
--> statement-breakpoint

-- `[)` = incluye `desde`, excluye `hasta`. `hasta is null` ⇒ rango abierto hacia arriba, así que dos
-- mandatos abiertos también chocan acá (esta restricción implica `uq_mandato_vigente`).
--
-- Se DEJA `uq_mandato_vigente` en su lugar: sacarlo sería una baja destructiva en la misma migración
-- que agrega el reemplazo (regla expand/contract), da un mensaje de error más claro para el caso
-- frecuente —"ya hay un mandato abierto"— y la tabla tiene una fila por barrio, así que el costo de
-- escritura del índice de más es irrelevante. Si alguna vez molesta, se saca en una contracción.
--
-- Si una base existente ya tuviera mandatos solapados, esta sentencia FALLA y hay que corregir los
-- datos antes de migrar. Es intencional: son exactamente las filas que hacen indeterminado quién
-- firmaba un comprobante ya emitido.
alter table mandato_administracion
  add constraint mandato_sin_solape
  exclude using gist (
    barrio_id with =,
    daterange(desde, hasta, '[)') with &&
  );
--> statement-breakpoint

comment on constraint mandato_sin_solape on mandato_administracion is
  'Dos mandatos de administración del mismo barrio no pueden pisarse en el tiempo: si se pisan, deja '
  'de estar determinado quién administraba el barrio cuando se emitió un comprobante, y ese dato va '
  'impreso en el documento. `hasta` es exclusivo: el traspaso se escribe con hasta(saliente) = desde(entrante).';
