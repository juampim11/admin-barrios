-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 0055 · `enviando` es una puerta de una vía, y las referencias que faltaban
--
-- Cierra los hallazgos del panel que revisó la Fase 2 completa del módulo de Distribución
-- (`security-engineer` + `code-reviewer`, 2026-08-30), más la decisión de `arquitecto-software`
-- sobre la máquina de estados del envío.
--
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- ⚠ ESTA MIGRACIÓN CORRIGE POR ESCRITO DOS RENGLONES DE `0054` QUE QUEDAN FALSOS
--
-- `0054` no se edita —nunca se edita una migración aplicada— y alguien la va a leer. Dice:
--
--   · `fallado → pendiente   Reintento, y solo a mano`
--   · y que de `enviando` no se sale solo.
--
-- **Las dos afirmaciones eran falsas juntas.** El trigger de `0054` valida **salto por salto, no la
-- historia**, así que `enviando → fallado → pendiente` devolvía a la cola una fila en estado
-- *desconocido* —el correo pudo haber salido— con dos sentencias que cualquier `admin_barrio` puede
-- emitir. Eso es un segundo correo al vecino, que es exactamente lo que la regla de oro del módulo
-- prohíbe.
--
-- Que no se haya visto un duplicado **no era por la máquina de estados: era por un bug**. El claim
-- (`reclamarEnvio()`) siempre escribía un `mensaje_id` nuevo, y `0054` lo congela una vez puesto, así
-- que el segundo reclamo de una fila reintentada **lanzaba** en vez de devolver `false`. Y como el
-- claim está fuera del `try` del bucle, esa excepción subía y marcaba fallado **el trabajo entero**:
-- los destinatarios que venían después no recibían nada. Una fila envenenada, 400 vecinos sin su
-- liquidación.
--
-- Arreglar uno solo empeoraba las cosas: con el `coalesce` obvio en el claim, el camino de dos saltos
-- pasaba de "revienta el lote" a "le manda el segundo correo al vecino". Por eso se cierran juntos, y
-- por eso el arreglo va en el esquema y no en el servicio: la RLS de `0053` le habilita el `update`
-- de esta tabla a `admin_barrio`, así que un guard escrito en TypeScript es un guard que la próxima
-- ruta se olvida.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Reparación previa: filas que ya caminaron el camino que se cierra.
--
-- En un entorno donde nadie lo caminó esto afecta **cero filas** (verificado contra la base de
-- desarrollo antes de escribir la migración). Va igual, porque el `CHECK` de la sección 2 aborta la
-- transacción entera del migrador si encuentra una, y este repo aplica todas las pendientes en UNA
-- transacción: una fila así dejaría el despliegue a mitad de camino.
--
-- Se apaga el trigger porque `pendiente → fallado` no es —ni pasa a ser— una arista legal: esta fila
-- es el artefacto de un invariante que no existía, no una transición del negocio. `fallado` es la
-- verdad de esa fila: se la entregó al transporte y no se sabe cómo terminó.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
alter table envio_liquidacion disable trigger trg_envio_antes_update;--> statement-breakpoint

update envio_liquidacion set estado = 'fallado'
 where estado = 'pendiente' and (mensaje_id is not null or intento > 0);--> statement-breakpoint

alter table envio_liquidacion enable trigger trg_envio_antes_update;--> statement-breakpoint


-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 2. ENV-1 — la invariante que sostiene todo lo demás.
--
-- **Es un `CHECK` y no una guarda del trigger, a propósito.** Un `CHECK` lo verifican **todos** los
-- caminos de escritura, incluida una migración futura que se olvide del motivo. Aunque alguien
-- reponga la arista `fallado → pendiente` en un `0060`, una fila fallada tiene `intento >= 1` y este
-- `CHECK` la rechaza igual: **la regla no depende de que nadie toque la lista de transiciones.**
--
-- Y es lo que vuelve el bug del `Message-ID` **inalcanzable en vez de parcheado**: el claim filtra
-- por `estado = 'pendiente'`, ENV-1 garantiza que esa fila tiene `mensaje_id is null`, y el `raise`
-- del congelamiento no puede dispararse desde ahí. Sin `coalesce`, sin caso especial.
--
-- No hace falta ninguna columna nueva: **`intento` ya es el registro de "esta fila estuvo en
-- vuelo"** —sube solo en el claim— y lo que faltaba era atarlo al estado con un `CHECK` pareado.
-- Es el mismo patrón que esta tabla ya usa en `envio_aceptado_chk`.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
alter table envio_liquidacion add constraint envio_pendiente_virgen_chk check (
  estado <> 'pendiente' or (mensaje_id is null and intento = 0)
);--> statement-breakpoint

comment on constraint envio_pendiente_virgen_chk on envio_liquidacion is
  'ENV-1: una fila en "pendiente" NUNCA fue entregada al transporte. Es lo que convierte a "enviando" '
  'en una puerta de una vía, y no depende de la lista de transiciones: aunque alguien reponga la '
  'arista fallado -> pendiente, una fila fallada tiene intento >= 1 y este CHECK la rechaza. Es '
  'ademas lo que hace estructuralmente imposible que el claim choque contra el congelamiento del '
  'Message-ID.';--> statement-breakpoint


-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 3. `app.descarga_antes_insert()` — las DOS ramas que faltaban.
--
-- La función derivaba el barrio de `documento_id`, `pago_id` o `recibo_emitido_id` **y de nada más**.
-- Pero la tabla tiene cinco referencias posibles:
--
--   · `0049` agregó `orden_pago_id` (columna, índice y `CHECK`) y **no tocó esta función**.
--   · `0052` agregó `paquete_id` y **repitió la misma omisión**.
--
-- Consecuencia: las descargas del comprobante y de la factura de una orden de pago, y la del ZIP de
-- distribución, **fallan siempre** con "no se pudo derivar el barrio de la referencia" — un 500 para
-- todo el mundo. Verificado con filas reales de las tres clases: `documento_id` inserta, las otras
-- dos rebotan.
--
-- El principio de fondo aguantó —*"si el registro falla, no hay URL"*, así que no se filtró ninguna
-- URL firmada— pero la funcionalidad estaba muerta. Nada lo agarró porque ningún test ejercita
-- `prepararDescargaDePaquete()` ni la descarga de una orden de pago.
--
-- **Sin `security definer`**, igual que hoy: corre con los privilegios de quien inserta, así que las
-- cuatro derivaciones respetan la RLS del solicitante y "no existe" y "no es tuyo" siguen siendo el
-- mismo caso.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
create or replace function app.descarga_antes_insert() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_barrio  uuid;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: no se firma una descarga anónima'
      using errcode = 'P0001';
  end if;

  if new.documento_id is not null then
    select barrio_id into v_barrio from documento_emitido where id = new.documento_id;
  elsif new.pago_id is not null then
    select barrio_id into v_barrio from pago where id = new.pago_id;
  elsif new.recibo_emitido_id is not null then
    select barrio_id into v_barrio from recibo_emitido where id = new.recibo_emitido_id;
  elsif new.orden_pago_id is not null then                                    -- [0055] faltaba desde 0049
    select barrio_id into v_barrio from orden_pago where id = new.orden_pago_id;
  elsif new.paquete_id is not null then                                       -- [0055] faltaba desde 0052
    select barrio_id into v_barrio from paquete_distribucion where id = new.paquete_id;
  end if;

  if v_barrio is null then
    raise exception 'no se pudo derivar el barrio de la referencia: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  new.barrio_id      := v_barrio;
  new.solicitado_por := v_usuario;
  new.url_firmada_at := now();
  return new;
end;
$$;--> statement-breakpoint


-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 4. `app.trabajo_antes_insert()` — el gate de rol de `armar_paquete_periodo`.
--
-- **La asimetría que cierra:** el trigger dejaba encolar el armado del paquete a cualquier rol que
-- pudiera insertar en `trabajo` (incluido `operador`), pero la policy `paquete_distribucion_ins`
-- (`0053`) exige `admin_plataforma`/`admin_barrio`. Como el worker corre con la identidad de quien
-- encoló, la secuencia real era: baja las 510 boletas, arma el ZIP, **lo sube al storage**, y recién
-- ahí el `insert` rebota por RLS. El objeto queda **huérfano para siempre** — `ObjectStorage` no
-- expone `remove()`, a propósito.
--
-- Y no era solo desperdicio: `tomarTrabajo()` cuenta el histórico de `(referencia_id, tipo)` contra
-- `MAX_INTENTOS_TRABAJO`, así que **cinco encolados dejaban el período sin poder empaquetarse nunca
-- más**, ni por un administrador. Sin paquete tampoco se distribuye. Un insider de bajo privilegio,
-- cinco clicks, período muerto.
--
-- La regla general que esto instancia: **el gate de encolar tiene que ser el mismo que el de la
-- tabla que el trabajo va a escribir.** Un trabajo que siempre falla es peor que uno prohibido.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
create or replace function app.trabajo_antes_insert() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_barrio  uuid;
  v_estado  app.estado_periodo;
  v_boletas int;
  v_informes int;
  v_paquetes int;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un trabajo sin autor no se encola'
      using errcode = 'P0001';
  end if;

  if new.tipo in ('emitir_documentos_periodo', 'emitir_informe_periodo',
                  'armar_paquete_periodo', 'distribuir_liquidaciones') then
    select barrio_id, estado into v_barrio, v_estado
      from periodo_expensa where id = new.referencia_id;
  elsif new.tipo = 'emitir_recibo_pago' then
    select barrio_id into v_barrio
      from pago where id = new.referencia_id and anulado_at is null;
  end if;

  if v_barrio is null then
    raise exception 'no se pudo derivar el barrio de la referencia: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  if new.tipo in ('emitir_documentos_periodo', 'emitir_informe_periodo',
                  'armar_paquete_periodo', 'distribuir_liquidaciones')
     and v_estado not in ('emitida', 'distribuida') then
    raise exception 'el período no está emitido: los documentos salen de lo que quedó emitido'
      using errcode = 'P0001';
  end if;

  if new.tipo = 'distribuir_liquidaciones' then
    if not app.has_role_on(v_barrio, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
      raise exception 'no tenés permiso para distribuir: la distribución envía datos personales fuera del sistema'
        using errcode = 'P0001';
    end if;

    select count(*) into v_boletas from documento_emitido
      where periodo_id = new.referencia_id and tipo = 'boleta_unidad';
    if v_boletas = 0 then
      raise exception 'el período no tiene boletas emitidas: no hay qué distribuir'
        using errcode = 'P0001';
    end if;

    select count(*) into v_informes from documento_emitido
      where periodo_id = new.referencia_id and tipo = 'informe_mensual';
    if v_informes = 0 then
      raise exception 'el período no tiene informe mensual emitido: es el segundo adjunto del envío'
        using errcode = 'P0001';
    end if;
  end if;

  if new.tipo = 'armar_paquete_periodo' then
    /*
     * [0055] **El gate que faltaba, y es el mismo que la policy de `paquete_distribucion`.**
     * Sin esto el trabajo se encolaba y siempre fallaba, dejando el ZIP huérfano en el storage y
     * quemando intentos hasta bloquear el período. Ver el encabezado de la sección 4.
     */
    if not app.has_role_on(v_barrio, array['admin_plataforma','admin_barrio']::app.rol_membership[]) then
      raise exception 'no tenés permiso para armar el paquete del período'
        using errcode = 'P0001';
    end if;

    select count(*) into v_boletas from documento_emitido
      where periodo_id = new.referencia_id and tipo = 'boleta_unidad';
    if v_boletas = 0 then
      raise exception 'el período no tiene boletas emitidas: no hay qué empaquetar'
        using errcode = 'P0001';
    end if;
  end if;

  if new.tipo = 'distribuir_liquidaciones' then
    select count(*) into v_paquetes from paquete_distribucion
      where periodo_id = new.referencia_id;
    if v_paquetes = 0 then
      raise exception 'todavía no se armó el paquete del período: se distribuye después de empaquetar'
        using errcode = 'P0001';
    end if;
  end if;

  new.barrio_id      := v_barrio;
  new.solicitado_por := v_usuario;
  new.solicitado_at  := now();
  new.estado         := 'encolado';
  new.hechos         := 0;
  new.total          := null;
  new.intento        := 0;
  new.iniciado_at    := null;
  new.terminado_at   := null;
  new.error          := null;
  return new;
end;
$$;--> statement-breakpoint


-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 5. `app.envio_antes_insert()` — el resto de la tupla deja de creerle al llamador.
--
-- `0053` blindó **el par contacto↔documento**, que es la fuga grave (mandarle a un vecino la boleta
-- de otro), y confiaba en el llamador para todo lo demás. Tres columnas quedaban declaradas desde
-- afuera, y las tres se derivan de datos que el trigger ya tiene en la mano:
--
--   · **M-2 · `email_snapshot` / `email_hash`.** El congelamiento de la dirección (`0054`) impedía
--     re-apuntar un envío por `update`, pero en el `insert` se congelaba **lo que el llamador
--     declarara**. Hoy el único llamador lee la dirección bajo RLS del mismo contacto, así que no
--     hay ruta explotable — es defensa en profundidad, el mismo criterio con el que el gate de rol
--     vive en la base y no en el servicio. El hash se calcula acá con la misma fórmula que
--     `hashDeDireccion()` en TypeScript (verificado byte a byte antes de escribir esto), así que
--     ninguna fila existente cambia de valor.
--   · **M-3 · `periodo_id`.** Se aceptaba el que viniera. Como el guard de idempotencia es
--     `uq_envio_periodo_contacto`, un `periodo_id` distinto admitía **una segunda fila** para el
--     mismo contacto y el mismo documento — y `enviosPendientes()` la iba a recorrer al distribuir
--     *ese otro* período, mandándole al vecino la boleta de otro mes rotulada como la del mes que se
--     está distribuyendo. Ahora se deriva del documento, igual que el barrio y la unidad.
--   · **B-2 · `informe_documento_id`.** No se validaba ni el barrio, ni el tipo, ni el período: se
--     podía apuntar a la boleta de otra unidad o al informe de otro barrio. Hoy la columna es de
--     sólo escritura (el adjunto sale de `contexto.informeStorageKey`, leído bajo RLS), así que el
--     daño era que **el registro mintiera sobre qué se adjuntó**. Un registro que miente no sirve
--     para lo único que existe: contestar después qué recibió cada vecino.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
create or replace function app.envio_antes_insert() returns trigger
  language plpgsql
  set search_path = public, app
as $$
declare
  v_usuario uuid := app.current_user_id();
  v_unidad_doc uuid;
  v_barrio_doc uuid;
  v_periodo_doc uuid;
  v_unidad_contacto uuid;
  v_contacto_activo boolean;
  v_contacto_email text;
  v_informe_ok boolean;
begin
  if v_usuario is null then
    raise exception 'no hay usuario en la sesión: un envío sin autor no se registra'
      using errcode = 'P0001';
  end if;

  -- La unidad SALE DEL DOCUMENTO, atravesando su liquidación. Es la única fuente que no depende de
  -- lo que el llamador arme. [0055] Y con ella el período, por el mismo motivo.
  select l.unidad_funcional_id, d.barrio_id, d.periodo_id
    into v_unidad_doc, v_barrio_doc, v_periodo_doc
    from documento_emitido d
    join liquidacion l on l.id = d.liquidacion_id
   where d.id = new.documento_id and d.tipo = 'boleta_unidad';

  if v_unidad_doc is null then
    raise exception 'el documento del envío no es una boleta de unidad accesible: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  select unidad_funcional_id, activo, email
    into v_unidad_contacto, v_contacto_activo, v_contacto_email
    from unidad_contacto where id = new.unidad_contacto_id;

  if v_unidad_contacto is null then
    raise exception 'el contacto del envío no existe o no es accesible'
      using errcode = 'P0001';
  end if;

  /*
   * **La comparación que impide la fuga.** Si el contacto es de otra unidad, la fila no entra — y
   * como el adjunto se resuelve leyendo `documento_id` de esta misma fila, el sobre con la boleta
   * de otro vecino no se puede armar ni por error de código ni por un lote mal construido.
   */
  if v_unidad_doc <> v_unidad_contacto then
    raise exception 'el contacto pertenece a otra unidad que el documento: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  if not v_contacto_activo then
    raise exception 'el contacto está dado de baja: no se le escribe'
      using errcode = 'P0001';
  end if;

  /*
   * [0055 · B-2] El segundo adjunto tiene que ser **el informe de este mismo período**. No alcanza
   * con que exista: una boleta de otra unidad o el informe de otro barrio entraban igual.
   */
  select true into v_informe_ok
    from documento_emitido
   where id = new.informe_documento_id
     and tipo = 'informe_mensual'
     and periodo_id = v_periodo_doc;

  if v_informe_ok is not true then
    raise exception 'el informe del envío no es el informe mensual de ese período: se rechaza por seguridad'
      using errcode = 'P0001';
  end if;

  new.barrio_id           := v_barrio_doc;
  new.periodo_id          := v_periodo_doc;                                   -- [0055 · M-3]
  new.unidad_funcional_id := v_unidad_doc;
  -- [0055 · M-2] La dirección y su hash los escribe la base, no el llamador. Misma fórmula que
  -- `hashDeDireccion()`: barrio, dos puntos, y la dirección normalizada.
  new.email_snapshot      := v_contacto_email;
  new.email_hash          := encode(
                               sha256((v_barrio_doc::text || ':' || lower(trim(v_contacto_email)))::bytea),
                               'hex');
  new.solicitado_por      := v_usuario;
  new.encolado_at         := now();
  new.estado              := 'pendiente';
  new.intento             := 0;
  new.aceptado_at         := null;
  return new;
end;
$$;--> statement-breakpoint


-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 6. `paquete_item_ins` — el manifiesto deja de aceptar documentos de otro barrio.
--
-- **B-1.** La policy sólo verificaba que el paquete padre fuera visible; no decía nada del
-- `documento_id`. Y como los chequeos de FK corren **por fuera de la RLS**, se podía meter en el
-- manifiesto de un paquete de un barrio un documento de otro — uno que ese mismo usuario no puede
-- leer.
--
-- No había fuga de contenido: el ZIP se arma desde una consulta bajo RLS con aserción de barrio, no
-- desde el manifiesto. Lo que se corrompía era **la respuesta a "¿qué boletas tenía ese archivo?"** y
-- el cálculo de `boletasFaltantes`, que es lo que decide si el paquete está vigente o superado.
--
-- Se exige además que el documento sea **del mismo período que el paquete**, que es más fuerte que
-- pedir sólo que exista y no cuesta nada.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
drop policy paquete_item_ins on paquete_distribucion_item;--> statement-breakpoint

create policy paquete_item_ins on paquete_distribucion_item for insert to app_request
  with check (
    exists (
      select 1
        from paquete_distribucion p
        join documento_emitido d on d.id = paquete_distribucion_item.documento_id
       where p.id = paquete_distribucion_item.paquete_id
         and d.periodo_id = p.periodo_id
         and d.tipo = 'boleta_unidad'
    )
  );--> statement-breakpoint


-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- 7. `app.envio_antes_update()` — la puerta de una vía, y dos congelamientos que faltaban.
--
-- **`fallado` pasa a ser TERMINAL.** Se elimina la arista `fallado → pendiente`, que `0054` había
-- puesto como "reintento, y solo a mano" sin ver que encadenaba con `enviando → fallado`.
--
-- ¿Y qué pasa con el vecino cuyo correo no salió? **No hay reintento por fila, y es a propósito.**
-- Reintentar el mismo envío mandaría a `email_snapshot`, que está congelada — o sea, a la misma
-- dirección que ya se sabe que no anda. Lo que sí funciona sin tocar nada: **una casilla nueva en esa
-- unidad es otro `unidad_contacto_id`**, así que al reencolar la distribución nace una fila nueva, con
-- su propio `Message-ID`, sin conflicto con `uq_envio_periodo_contacto` y sin reabrir la fallada.
--
-- `cancelado → pendiente` **se conserva**, y ahora es segura por construcción y no por confianza: una
-- fila cancelada viene siempre de `pendiente`, así que tiene `intento = 0` y `mensaje_id is null`, y
-- ENV-1 la deja volver. Una que hubiera pasado por `enviando` no podría, porque el `CHECK` la
-- rechaza. **La arista es legal exactamente cuando la fila nunca se reclamó, decidido por el dato y
-- no por una lista mantenida a mano.**
--
-- ⚠ **Y de ahí la regla para el próximo que toque esto:** mientras `cancelado → pendiente` exista,
-- **no se puede agregar `enviando → cancelado` ni `fallado → cancelado`**. Sería reabrir la puerta en
-- dos saltos — el mismo bug que esta migración cierra, con otro nombre. ENV-1 lo bloquea igual
-- (`intento` sería ≥ 1), pero el motivo queda escrito acá para que no se descubra por el `raise`.
--
-- Se suman dos congelamientos que `0054` no había cubierto (`security-engineer`, B-3):
--   · **`trabajo_id`** entra a la lista de identidad: es la traza de qué corrida escribió esta fila, y
--     poder ponerla en `null` borra esa traza sin dejar rastro.
--   · **`error_codigo`** gana un tope de largo. Lo lee una pantalla, y el `slice(0, 60)` que hoy lo
--     acota vive **solo en el servicio** — o sea, en el lado que un `update` directo no atraviesa.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
alter table envio_liquidacion add constraint envio_error_codigo_chk
  check (error_codigo is null or length(error_codigo) <= 60);--> statement-breakpoint

create or replace function app.envio_antes_update() returns trigger
  language plpgsql
  set search_path = public, app
as $$
begin
  /*
   * **La identidad no se toca, y `documento_id` es la que más importa.** El adjunto que viaja se
   * resuelve leyendo `documento_id` de esta fila; si se pudiera reescribir, el control estructural
   * de B-1 —el trigger de `insert` que verifica que el contacto y el documento sean de la misma
   * unidad— se saltearía con un `update` posterior, que es exactamente la fuga que ese control
   * existe para cerrar.
   *
   * `email_snapshot` va en la misma lista por el otro lado del mismo argumento: es la única
   * dirección a la que un reenvío puede ir, y congelarla es lo que impide que un reenvío termine
   * yendo a la dirección VIGENTE del contacto.
   *
   * [0055] `trabajo_id` se suma: es la traza de qué corrida escribió esta fila.
   */
  if new.barrio_id            is distinct from old.barrio_id
  or new.periodo_id           is distinct from old.periodo_id
  or new.unidad_funcional_id  is distinct from old.unidad_funcional_id
  or new.unidad_contacto_id   is distinct from old.unidad_contacto_id
  or new.documento_id         is distinct from old.documento_id
  or new.informe_documento_id is distinct from old.informe_documento_id
  or new.email_snapshot       is distinct from old.email_snapshot
  or new.email_hash           is distinct from old.email_hash
  or new.plantilla_version    is distinct from old.plantilla_version
  or new.trabajo_id           is distinct from old.trabajo_id            -- [0055 · B-3]
  or new.solicitado_por       is distinct from old.solicitado_por
  or new.encolado_at          is distinct from old.encolado_at then
    raise exception 'la identidad de un envío no se puede cambiar: el destinatario, el documento y la dirección quedan congelados al registrarlo'
      using errcode = '23514';
  end if;

  /*
   * El `Message-ID` se escribe UNA vez, en el claim y antes de mandar. Una vez puesto no se
   * reescribe: es la llave con la que se va a aparear un rebote, y una llave que cambia no aparea
   * nada. Ponerlo en `null` de vuelta tampoco — por eso `is distinct from` y no `<>`.
   *
   * [0055] Con ENV-1, este `raise` **dejó de ser alcanzable desde el claim**: una fila `pendiente`
   * tiene `mensaje_id is null` garantizado, así que el claim nunca lo reescribe. Antes sí era
   * alcanzable, y como el claim vive fuera del `try` del worker, esa excepción mataba el lote entero.
   */
  if old.mensaje_id is not null and new.mensaje_id is distinct from old.mensaje_id then
    raise exception 'el Message-ID de un envío ya emitido no se puede cambiar'
      using errcode = '23514';
  end if;

  /*
   * [0055] **`intento` es el registro de "esta fila ya estuvo en vuelo", y ENV-1 se apoya en él.**
   * Que solo lo moviera el claim era convención de código; acá pasa a ser regla de la base. Un
   * `update` que lo suba por afuera lo convertiría en un número y dejaría de ser un hecho — y con él
   * se caería la invariante. Subsume el "no retrocede" de `0054`.
   */
  if new.intento is distinct from old.intento then
    if not (old.estado = 'pendiente' and new.estado = 'enviando'
            and new.intento = old.intento + 1) then
      raise exception 'el contador de intentos de un envío solo lo mueve el claim, y de a uno'
        using errcode = '23514';
    end if;
  end if;

  -- [0055] No se pasa a `enviando` sin la llave: el `Message-ID` se escribe ANTES de mandar
  -- (ADR-0005 §3), y una fila en vuelo sin llave es un mensaje que ningún rebote va a poder aparear.
  if old.estado = 'pendiente' and new.estado = 'enviando' and new.mensaje_id is null then
    raise exception 'un envío no pasa a "enviando" sin su Message-ID'
      using errcode = '23514';
  end if;

  if new.estado = old.estado then
    return new;
  end if;

  if not (
       (old.estado = 'pendiente' and new.estado in ('enviando', 'cancelado'))
    or (old.estado = 'enviando'  and new.estado in ('aceptado', 'fallado'))
    -- [0055] `fallado → pendiente` ELIMINADA. Ver el encabezado de esta sección.
    or (old.estado = 'cancelado' and new.estado = 'pendiente')
    or (old.estado = 'aceptado'  and new.estado = 'rebotado')
  ) then
    raise exception 'transición de envío inválida: % → %', old.estado, new.estado
      using errcode = '23514';
  end if;

  /*
   * El sello de aceptación lo pone la base, no el llamador — mismo criterio que `emitida_at` en
   * `app.periodo_transicion()`. Y **no se borra al rebotar**: un mensaje que rebota es uno que el
   * servidor aceptó primero y devolvió después.
   */
  if new.estado = 'aceptado' then
    new.aceptado_at := now();
  end if;

  return new;
end;
$$;--> statement-breakpoint
