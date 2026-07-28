-- =============================================================================================
-- 0022_grants_explicitos — dos permisos que hoy funcionan por accidente.
--
-- `app.cbu_importe_bruto()` (0017 §2) es la **única definición de la aritmética del dinero** de los
-- cargos y descuentos: la usan el cálculo real y el `CHECK`. `aplicarConceptoAUnidad()` la llama
-- ahora en su `RETURNING`, para poder mostrarle a quien carga un cargo cuánto va a costar **con el
-- mismo cálculo que después lo escribe** (doc 08 §AC punto 1: si la pantalla estima el importe por
-- su cuenta, dos aritméticas distintas terminan en un vecino reclamando).
--
-- El problema no es que falte el permiso: es que **sobra**. Verificado en `pg_proc.proacl`:
--
--     cbu_importe_bruto      → (sin ACL: EXECUTE a PUBLIC por defecto)
--     resolver_aplicaciones  → =X/app_job | app_job=X/app_job | app_request=X/app_job
--
-- O sea que las dos son ejecutables por **PUBLIC**, y `app_request` llega a `cbu_importe_bruto` sin
-- que ningún grant lo diga. Eso tiene dos consecuencias distintas:
--
--   1. **Frágil.** El endurecimiento estándar de un esquema es `revoke execute on all functions in
--      schema app from public`. El día que alguien lo corra —una revisión de seguridad, un checklist
--      de un proveedor administrado— la carga de cargos deja de funcionar, y el motivo va a estar a
--      tres capas de distancia del síntoma.
--   2. **`resolver_aplicaciones` es peor**, y no es cosmético: es `security definer` con dueño
--      `app_job` (**BYPASSRLS**), o sea el único lugar del esquema donde el aislamiento no lo
--      garantiza una policy sino el cuerpo de la función. Tiene su propio control de rol adentro
--      (`app.has_role_on(... admin_plataforma, admin_barrio, operador)`), así que el `EXECUTE` a
--      PUBLIC no abre nada hoy — pero una función que saltea la RLS no tiene por qué ser invocable
--      por cualquier rol que exista o llegue a existir en la base.
--
-- Se hace explícito lo que ya pasa, y se saca lo que sobra. **No cambia el comportamiento** de
-- ningún camino actual: hay tests contra Postgres que lo verifican de los dos lados.
--
-- El HANDOFF ya tenía anotada una auditoría propia de `app.resolver_aplicaciones` para `dba-data` +
-- `security-engineer`; esto **no la reemplaza**, solo le saca de encima el grant a PUBLIC.
-- =============================================================================================

revoke execute on function app.cbu_importe_bruto(
  app.metodo_concepto_boleta, numeric, numeric, numeric, numeric, numeric
) from public;--> statement-breakpoint

grant execute on function app.cbu_importe_bruto(
  app.metodo_concepto_boleta, numeric, numeric, numeric, numeric, numeric
) to app_request, app_job;--> statement-breakpoint

comment on function app.cbu_importe_bruto(
  app.metodo_concepto_boleta, numeric, numeric, numeric, numeric, numeric
) is
  'La ÚNICA definición de la aritmética del dinero de cargos y descuentos. La usan el cálculo real '
  '(app.resolver_aplicaciones), el CHECK que lo verifica, y el servicio aplicarConceptoAUnidad para '
  'mostrar el importe antes de resolverlo. Si se escribe una segunda copia en otro lado, o rebotan '
  'filas correctas o se acepta un importe mal calculado, y nadie se entera hasta que un vecino '
  'reclama.';--> statement-breakpoint

-- La definer que saltea la RLS deja de ser invocable por PUBLIC. `app_request` conserva su grant
-- explícito (lo puso 0017 §7) porque `generarLiquidaciones()` la llama en cada borrador.
revoke execute on function app.resolver_aplicaciones(uuid) from public;
