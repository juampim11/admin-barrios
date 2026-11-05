-- =============================================================================================
-- 0072_vencimientos_congelados_al_emitir — T2 (ADR-0011), lo que pidió `security-engineer`.
--
-- Solo una función: no cambia ni una fila.
--
-- Los vencimientos de un período emitido ya no se pueden cambiar. `0030` los había dejado afuera
-- del congelamiento como «datos de gestión», pero el interés por mora corre desde el primer
-- vencimiento: cambiarlo después de emitir cambia lo que se cobra. Antes de emitir se siguen
-- cambiando (el diálogo «Cambiar los vencimientos» del mes, `cambiarVencimientos`).
--
-- `app.periodo_emitido_inmutable` es copia de la versión de `0053`; lo único nuevo está marcado
-- `[0072]`.
-- =============================================================================================

create or replace function app.periodo_emitido_inmutable() returns trigger
  language plpgsql set search_path = public, app
as $$
begin
  if old.estado not in ('emitida', 'distribuida')
     and new.estado not in ('emitida', 'distribuida') then
    return new;
  end if;

  /*
   * La guarda del MODELO va primera, y es la que más importa de todas: sin ella,
   *
   *     update periodo_expensa set estado = 'emitida', modelo = 'fija' where id = $1;
   *
   * emite validando un modelo y deja escrito el otro — `app.validar_emision()` corre en un `before`
   * y lee la fila vieja. El motivo completo está en el docstring de `0030`, que no se repite acá.
   *
   * `is distinct from` y no `<>`: con un `null` de por medio, `<>` da `null` y el `if` no entra, o
   * sea que poner en `null` una versión ya fijada pasaría de largo.
   */
  if new.modelo is distinct from old.modelo then
    raise exception
      'el modelo de un período % no se puede cambiar (era %, se intentó %)',
      old.estado, old.modelo, new.modelo
      using errcode = '23514';
  end if;

  if new.periodo is distinct from old.periodo then
    raise exception 'el mes de un período % no se puede cambiar', old.estado using errcode = '23514';
  end if;

  if new.barrio_id is distinct from old.barrio_id then
    raise exception 'un período % no se puede mover de barrio', old.estado using errcode = '23514';
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

  /*
   * [0053] La firma de DISTRIBUCIÓN, que quedaba afuera. `old.distribuida_at is not null` acota la
   * guarda a la fila que ya la tiene: mientras es `null`, `app.periodo_transicion()` puede
   * escribirla (corre después, por orden alfabético del nombre del trigger). Una vez sellada, no se
   * reescribe.
   */
  if old.distribuida_at is not null
     and (new.distribuida_at is distinct from old.distribuida_at
          or new.distribuida_por is distinct from old.distribuida_por) then
    raise exception 'la firma de distribución de un período no se puede cambiar'
      using errcode = '23514';
  end if;

  /*
   * [0072] Los VENCIMIENTOS, que `0030` dejó afuera como «datos de gestión». No lo son: de
   * `primer_vencimiento` corre el interés por mora (`deudaALaFecha`, el interés devengado de `0064`).
   * Moverlo en un mes emitido cambia lo que se le cobra a cada unidad sin que la boleta emitida lo
   * diga (security-engineer, T2). El motivo del cambio (`0071`) se congela con ellos.
   */
  if (new.primer_vencimiento, new.segundo_vencimiento, new.motivo_vencimientos)
     is distinct from (old.primer_vencimiento, old.segundo_vencimiento, old.motivo_vencimientos) then
    raise exception 'los vencimientos de un período % no se pueden cambiar: de ellos corre el interés', old.estado
      using errcode = '23514';
  end if;

  return new;
end;
$$;
