-- =============================================================================================
-- 0103_padron_solo_administracion — el padrón no se escribe por fuera del camino con historial (BL-023 a, S6).
--
-- Solo esquema: policies. No cambia ni una fila existente.
--
-- El hueco. `0003` dejó las policies de escritura de las tablas del padrón iguales a las de todo el dominio:
-- `admin_plataforma`, `admin_barrio` **y `operador`**. `0065` las dejó así a propósito (un test de RLS fijaba
-- que un operador da de alta una unidad por SQL directo) y puso la regla de quién escribe solo en lo que
-- pasa por `padron_evento`. Pero **ninguna pantalla ni servicio** del padrón es del operador: todas las
-- operaciones de `padron-edicion.ts` empiezan con `exigirAdministracion` y escriben su evento en la misma
-- transacción. Lo único que el operador podía hacer era escribir por SQL directo, sin evento: dar de alta
-- una unidad, cambiar a su titular o sus coeficientes.
--
-- El cambio. Las policies de INSERT y UPDATE de cinco tablas del padrón pasan a `admin_plataforma` y
-- `admin_barrio` (los mismos que escriben `padron_evento`):
--
--   unidad_funcional   la unidad (y su saldo inicial, su cuenta y su baja)
--   unidad_obligado    las titularidades (quién es titular, desde cuándo)
--   obligado           la persona titular
--   coeficiente_version, coeficiente   la distribución de coeficientes
--
-- **`unidad_contacto` queda como estaba, a propósito.** `unidad-contacto-traza.test.ts` (B-2) fija que el
-- operador sigue pudiendo cargar contactos —«trabajo legítimo de padrón»— y que lo que se cerró fue hacerlo
-- sin rastro (un trigger firma cada alta y edición). Sacarle ese permiso es una decisión de producto que no
-- es de este cambio.
--
-- `alter policy` y no `drop` + `create`: no hay ventana en la que la tabla quede sin policy (el patrón de
-- `0018`). Los nombres y los grants no se tocan. La lectura tampoco: el operador sigue viendo el padrón
-- (lo necesita para cargar cobros). No hay policy de DELETE (0003).
--
-- Lo que **no** cambia: lo que un rol hace desde la pantalla. Ninguna operación de estas cinco tablas era
-- del operador (todas empiezan con `exigirAdministracion`); `contador` y `residente` no escribían (no
-- estaban en la lista). `app_job` (seed, importadores, el worker) y los scripts de mantenimiento son otros
-- roles de base de datos y no pasan por estas policies.
--
-- Quedan sin tocar los triggers de `0059` y `0065` (`uf_saldo_inicial_una_vez`, `uf_cuenta_unica`): ya
-- exigen rol de administración para el saldo inicial, la baja y la cuenta, y siguen siendo la segunda
-- barrera. Fuera de alcance: el modelo común de roles (BL-005) y la cuota de la unidad nueva (BL-023 d).
-- =============================================================================================

do $bloque$
declare
  t text;
  solo_administracion constant text :=
    'app.has_role_on(barrio_id, array[''admin_plataforma'',''admin_barrio'']::app.rol_membership[])';
begin
  foreach t in array array[
    'unidad_funcional', 'unidad_obligado', 'obligado', 'coeficiente_version', 'coeficiente'
  ] loop
    execute format('alter policy %I on %I with check (%s)', t || '_ins', t, solo_administracion);
    execute format('alter policy %I on %I using (%s) with check (%s)', t || '_upd', t, solo_administracion, solo_administracion);
  end loop;
end
$bloque$;
