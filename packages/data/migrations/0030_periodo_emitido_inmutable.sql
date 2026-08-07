-- =============================================================================================
-- 0030_periodo_emitido_inmutable — lo que define QUÉ se cobró no se reescribe después de emitir
--
-- ⚠ EL AGUJERO QUE ESTO CIERRA, ENCONTRADO POR `security-engineer` EL 2026-08-04
--
-- `app.periodo_transicion()` (0013 §3) arranca con `if new.estado = old.estado then return new`.
-- O sea: un `update` que **no toca el estado** pasa entero, en cualquier estado, sin validación y
-- sin dejar rastro. Y la policy `periodo_expensa_upd` (0005 §5) habilita `update` sobre la fila a
-- los tres roles de gestión mirando solo `barrio_id`.
--
-- Hasta hoy eso era teórico: ningún servicio escribía `modelo`. Deja de serlo con el alta que ahora
-- deja elegirlo — el campo se vuelve visible en la aplicación, y "editar el período" es el pedido
-- siguiente.
--
-- POR QUÉ IMPORTA, CONCRETAMENTE
--
-- La boleta **no guarda el modelo**: lo vuelve a leer de `periodo_expensa.modelo` cada vez que se
-- arma (`vista-boleta.ts`, que con ese valor decide si imprime la línea de valor fijo). Cambiarle el
-- modelo a un período ya emitido cambia lo que dice un documento que el vecino ya recibió, y
-- `app.validar_emision` **no vuelve a correr** —el estado no cambió—, así que todos los controles
-- siguen cuadrando. Es el patrón textual del defecto que documenta la 0029: *"sin error, sin aviso,
-- y con todos los controles cuadrando — contra la versión equivocada"*.
--
-- QUÉ SE CONGELA Y QUÉ NO
--
-- Se congelan las columnas que **definen qué se cobró**: el modelo, el mes, el barrio, las dos
-- versiones (coeficientes y valor fijo) contra las que se calculó, la palabra que sale impresa, y la
-- firma de quién emitió y cuándo. Es la misma promesa que la 0029 ya hacía para
-- `cuota_fija_version_id` —*"un período emitido conserva la suya y no se recalcula nunca"*—
-- extendida a los campos de al lado, que estaban desprotegidos.
--
-- Las dos últimas se sumaron en la revisión del diff, y las dos por el mismo argumento que las
-- demás:
--
--   * **`denominacion_concepto`** la escribe `generarLiquidaciones` como snapshot y el esquema ya la
--     declara congelada ("si el barrio cambia de figura no puede cambiar retroactivamente la
--     etiqueta de todas las liquidaciones ya emitidas"). Pero nada la congelaba: la boleta la vuelve
--     a leer de la fila cada vez que se arma, así que un `update` la hacía decir otra palabra que la
--     que el vecino ya recibió.
--   * **`emitida_at` / `emitida_por`** las pone `app.periodo_transicion` desde `app.current_user_id()`
--     —la 0013 documenta que antes venían del request y "cualquiera podía firmar con el nombre de
--     otro"—. Esa función es justamente la del early-return, así que reescribir la firma de una
--     emisión ya hecha no la despertaba. Congelarlas es seguro: en la transición legítima
--     `old.estado` es `borrador` o `revisada` y este trigger ya devolvió antes de mirarlas.
--
-- **En borrador no se congela nada**, y es deliberado: el borrador es derivado y regenerable por
-- diseño, y `generarLiquidaciones()` reescribe esas mismas columnas en cada corrida. Congelarlas
-- antes de emitir rompería el recorrido normal.
--
-- Los totales (`total_gastos`, `total_cargos`, `total_descuentos`) **no entran acá**: los escribe
-- `generarLiquidaciones()` y ya están fuera de alcance una vez emitido, porque el trigger
-- `app.periodo_editable` congela `liquidacion` e `item_liquidacion`. Sumarlos daría una falsa
-- sensación de cobertura sobre algo que ya está cubierto por otro lado.
--
-- `notas` y los vencimientos tampoco: son datos de gestión, no la base de cálculo. Corregir una nota
-- interna de un mes ya emitido es operatoria legítima.
-- =============================================================================================

create or replace function app.periodo_emitido_inmutable() returns trigger
  language plpgsql
as $$
begin
  /*
   * Antes de emitir no se congela nada: el borrador se regenera y reescribe estas mismas columnas.
   *
   * ⚠ **Se miran los DOS estados, el viejo y el nuevo, y mirar solo `old` era un agujero.** Lo
   * encontró `tester` el 2026-08-04 con el exploit escrito: una sola sentencia que **emite y muta a
   * la vez** entra con `old.estado = 'borrador'`, así que con la guarda vieja el trigger devolvía en
   * la primera línea y la fila se escribía con el valor nuevo **y** el estado `emitida`.
   *
   *     update periodo_expensa set estado = 'emitida', modelo = 'fija' where id = $1;
   *
   * Y `app.validar_emision(new.id)` no lo compensa: corre en un `before`, o sea que lee de la tabla
   * la fila **vieja**. Valida un modelo y queda escrito el otro. La versión de dinero del mismo
   * ataque es peor —emitir apuntando a una versión de valor distinta de aquella con la que se
   * calcularon los `item_liquidacion`—: el período declara un valor que nadie cobró, y es
   * exactamente el patrón que documenta la 0029, "todos los controles cuadrando contra la versión
   * equivocada".
   */
  if old.estado not in ('emitida', 'distribuida')
     and new.estado not in ('emitida', 'distribuida') then
    return new;
  end if;

  -- `is distinct from` y no `<>`: con un `null` de por medio, `<>` da `null` y el `if` no entra —
  -- o sea que poner en `null` una versión ya fijada pasaría de largo, que es justo el caso peor.
  if new.modelo is distinct from old.modelo then
    raise exception
      'el modelo de un período % no se puede cambiar (era %, se intentó %)',
      old.estado, old.modelo, new.modelo
      using errcode = '23514';
  end if;

  if new.periodo is distinct from old.periodo then
    raise exception 'el mes de un período % no se puede cambiar', old.estado
      using errcode = '23514';
  end if;

  if new.barrio_id is distinct from old.barrio_id then
    raise exception 'un período % no se puede mover de barrio', old.estado
      using errcode = '23514';
  end if;

  if new.coeficiente_version_id is distinct from old.coeficiente_version_id then
    raise exception 'la versión de coeficientes de un período % no se puede cambiar', old.estado
      using errcode = '23514';
  end if;

  if new.cuota_fija_version_id is distinct from old.cuota_fija_version_id then
    raise exception 'la versión de valor fijo de un período % no se puede cambiar', old.estado
      using errcode = '23514';
  end if;

  if new.denominacion_concepto is distinct from old.denominacion_concepto then
    raise exception
      'la denominación impresa de un período % no se puede cambiar (era %)', old.estado,
      coalesce(old.denominacion_concepto, '(sin declarar)')
      using errcode = '23514';
  end if;

  if new.emitida_at is distinct from old.emitida_at
     or new.emitida_por is distinct from old.emitida_por then
    raise exception 'la firma de emisión de un período % no se puede cambiar', old.estado
      using errcode = '23514';
  end if;

  return new;
end;
$$;
--> statement-breakpoint

-- `before update` y no `after`: tiene que abortar antes de que la fila cambie.
--
-- ⚠⚠ **EL NOMBRE DE ESTE TRIGGER NO SE CAMBIA, Y NO ES UNA CUESTIÓN DE ESTILO.**
--
-- Postgres corre los triggers de la misma etapa **por orden alfabético del nombre**, y acá eso es una
-- dependencia funcional: `trg_periodo_emitido_inmutable` < `trg_periodo_transicion`, o sea que este
-- corre PRIMERO. Tiene que ser así porque la guarda de arriba ahora entra también cuando el período
-- **se está emitiendo** (`new.estado = 'emitida'`), y `app.periodo_transicion` es justamente la que
-- escribe `emitida_at` y `emitida_por` — que este trigger congela. Si corriera después, encontraría
-- la firma ya cambiada y **emitir fallaría siempre**.
--
-- Renombrar cualquiera de los dos de forma que se invierta el orden rompe la emisión entera. Si
-- alguna vez hay que reordenarlos, la salida es mover la comparación de la firma a un `when` o
-- excluirla cuando `old.estado` todavía no era emitida.
--
-- **Trigger propio y no una rama adentro de `app.periodo_transicion`**, aunque ahí también hubiera
-- funcionado: aquella función existe para validar el CAMBIO de estado y arranca devolviendo cuando
-- el estado no cambió. Meter esto adentro obligaría a mover ese early-return, que es el que hace
-- barato el camino normal. Dos responsabilidades, dos triggers.
drop trigger if exists trg_periodo_emitido_inmutable on periodo_expensa;
--> statement-breakpoint

create trigger trg_periodo_emitido_inmutable
  before update on periodo_expensa
  for each row execute function app.periodo_emitido_inmutable();
--> statement-breakpoint

comment on function app.periodo_emitido_inmutable() is
  'Congela lo que define qué se cobró (modelo, mes, barrio y las dos versiones de cálculo) una vez que el período se emitió. En borrador no congela nada: el borrador es regenerable.';
