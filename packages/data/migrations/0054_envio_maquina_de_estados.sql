-- =============================================================================================
-- 0054_envio_maquina_de_estados — el `update` de `envio_liquidacion`, gobernado.
--
-- **Por qué existe esta migración y no está adentro de `0053`.** `0053` habilitó `update` sobre
-- `envio_liquidacion` con un argumento correcto —el ciclo de vida del envío ES una secuencia de
-- estados, y el claim atómico que impide el doble envío se hace con un `update` condicional— y
-- escribió al lado que "lo que no se puede es borrar ni reescribir la identidad, que el trigger fija
-- en el `insert`". Eso último era falso: `app.envio_antes_insert()` corre en el `insert` y nada
-- gobernaba el `update`.
--
-- La consecuencia no es teórica, y toca justo el invariante que sostiene el módulo:
--
--     update envio_liquidacion set estado = 'pendiente', aceptado_at = null where id = $1;
--
-- devuelve a la cola un envío YA ACEPTADO, y el siguiente recorrido del lote lo manda de nuevo. La
-- tabla entera existe para que eso no pueda pasar (`0052` §3: "reenviar un email es un email más en
-- la bandeja del vecino y no se puede retirar"). Con la misma llave se podía reescribir
-- `documento_id` —la boleta que viaja— o `email_snapshot`, que es la dirección congelada y la única
-- a la que B-1 permite reenviar.
--
-- Se arregla acá y no editando `0053` porque `0053` ya está aplicada. Tres cosas:
--   1. Las transiciones permitidas, y solo esas.
--   2. Las columnas de identidad, congeladas.
--   3. Dos correcciones de los `CHECK` de `0052`, explicadas abajo.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. `sin_contacto` sale del `CHECK`: es un estado que NINGUNA fila puede tener.
--
-- Quedó escrito en `0052` pensando en "la unidad a la que no se le pudo escribir", sin ver que en
-- esa misma tabla `unidad_contacto_id` es `not null`. Una unidad sin contacto no tiene contacto: no
-- hay fila que pueda llevar ese estado, y un valor permitido que nada puede producir es un `CHECK`
-- que describe un mundo que no existe.
--
-- **Y el hecho no se pierde por sacarlo**, que es lo que lo vuelve una corrección y no una renuncia:
-- las boletas del período (`documento_emitido`) y los envíos del período son las dos append-only, así
-- que "a qué unidades no se les escribió" es la DIFERENCIA entre esos dos conjuntos — y esa
-- diferencia queda congelada sola, sin necesidad de una fila que la declare.
-- ---------------------------------------------------------------------------------------------
alter table envio_liquidacion drop constraint envio_estado_chk;
--> statement-breakpoint

alter table envio_liquidacion add constraint envio_estado_chk check (
  estado in ('pendiente', 'enviando', 'aceptado', 'fallado', 'rebotado', 'cancelado')
);
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 2. `aceptado_at` sobrevive al rebote.
--
-- El `CHECK` pareado de `0052` decía `estado = 'aceptado'` ⟺ `aceptado_at is not null`, y con eso
-- pasar una fila a `rebotado` obligaba a poner `aceptado_at` en `null`. Eso **borra un hecho**: un
-- mensaje que rebota es un mensaje que el servidor aceptó primero y devolvió después — las dos cosas
-- pasaron, y la segunda no deroga a la primera. Es el mismo criterio con el que ningún otro par de
-- esta base "corrige" un sello anterior: se agrega el hecho nuevo al lado.
-- ---------------------------------------------------------------------------------------------
alter table envio_liquidacion drop constraint envio_aceptado_chk;
--> statement-breakpoint

alter table envio_liquidacion add constraint envio_aceptado_chk check (
  (estado in ('aceptado', 'rebotado')) = (aceptado_at is not null)
);
--> statement-breakpoint


-- ---------------------------------------------------------------------------------------------
-- 3. `app.envio_antes_update()` — las transiciones, y el congelamiento de la identidad.
--
-- **Las transiciones permitidas**, con el porqué de cada una:
--
--   · `pendiente → enviando`   El claim. Se commitea ANTES del `sendMail()`.
--   · `pendiente → cancelado`  El administrador decide no escribirle a esa casilla este período.
--   · `enviando  → aceptado`   El servidor de correo aceptó el mensaje.
--   · `enviando  → fallado`    El `sendMail()` levantó.
--   · `fallado   → pendiente`  Reintento, y **solo a mano**. Ver abajo.
--   · `cancelado → pendiente`  Cancelar no es definitivo.
--   · `aceptado  → rebotado`   El día que exista la fuente de rebotes. Hoy nada lo produce.
--
-- **Lo que NO está, y es la decisión que sostiene todo:** no hay salida de `enviando` salvo la que
-- escribe el mismo trabajo que lo reclamó. Si el proceso muere entre el claim y el `sendMail()`, la
-- fila queda en `enviando` para siempre y **nadie la reintenta sola**. Es estado desconocido: el
-- mensaje puede haber salido o no. Se prefiere perder la certeza de que se mandó antes que mandarlo
-- dos veces, porque de las dos pérdidas solo una llega a la bandeja del vecino.
--
-- `fallado → pendiente` merece su propia nota: un `sendMail()` que levanta **no prueba** que el
-- mensaje no salió (puede haber cortado después de que el servidor lo aceptó). Por eso el reintento
-- no es automático: lo pide una persona, que es quien puede mirar el error y decidir.
-- ---------------------------------------------------------------------------------------------
create or replace function app.envio_antes_update() returns trigger
  language plpgsql security invoker
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
  or new.solicitado_por       is distinct from old.solicitado_por
  or new.encolado_at          is distinct from old.encolado_at then
    raise exception 'la identidad de un envío no se puede cambiar: el destinatario, el documento y la dirección quedan congelados al registrarlo'
      using errcode = '23514';
  end if;

  /*
   * El `Message-ID` se escribe UNA vez, en el claim y antes de mandar. Una vez puesto no se
   * reescribe: es la llave con la que se va a aparear un rebote, y una llave que cambia no aparea
   * nada. Ponerlo en `null` de vuelta tampoco — por eso `is distinct from` y no `<>`.
   */
  if old.mensaje_id is not null and new.mensaje_id is distinct from old.mensaje_id then
    raise exception 'el Message-ID de un envío ya emitido no se puede cambiar'
      using errcode = '23514';
  end if;

  -- El contador de intentos no baja: es el registro de cuántas veces se tocó esta casilla.
  if new.intento < old.intento then
    raise exception 'el contador de intentos de un envío no puede retroceder'
      using errcode = '23514';
  end if;

  if new.estado = old.estado then
    return new;
  end if;

  if not (
       (old.estado = 'pendiente' and new.estado in ('enviando', 'cancelado'))
    or (old.estado = 'enviando'  and new.estado in ('aceptado', 'fallado'))
    or (old.estado = 'fallado'   and new.estado = 'pendiente')
    or (old.estado = 'cancelado' and new.estado = 'pendiente')
    or (old.estado = 'aceptado'  and new.estado = 'rebotado')
  ) then
    raise exception 'transición de envío inválida: % → %', old.estado, new.estado
      using errcode = '23514';
  end if;

  /*
   * El sello de aceptación lo pone la base, no el llamador — mismo criterio que `emitida_at` en
   * `app.periodo_transicion()`. Y **no se borra al rebotar**: ver el punto 2 de arriba.
   */
  if new.estado = 'aceptado' then
    new.aceptado_at := now();
  end if;

  return new;
end; $$;
--> statement-breakpoint

create trigger trg_envio_antes_update before update on envio_liquidacion
  for each row execute function app.envio_antes_update();
--> statement-breakpoint

comment on function app.envio_antes_update() is
  'La máquina de estados del envío y el congelamiento de su identidad. Sin esto, el update que 0053 '
  'habilitó para el claim atómico servía también para devolver a "pendiente" un envío ya aceptado — '
  'o sea, para volver a mandar un correo que no se puede retirar. No hay salida automática de '
  '"enviando": es estado desconocido a propósito.';
