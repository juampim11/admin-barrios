/**
 * La **distribución**: a quién se le escribe, y el registro que impide escribirle dos veces.
 *
 * Este servicio no manda ningún correo —eso es del worker, que es el único proceso con credenciales
 * SMTP— y esa separación no es de capas: es lo que hace que el registro exista **antes** que el
 * envío.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LA REGLA DE ORO, Y TODO LO DEMÁS SE DEDUCE DE ELLA
 *
 * **Un email no se puede retirar.** Todo lo que este sistema hace es reversible o repetible sin
 * costo —un PDF se genera de nuevo, un ZIP se rearma, una URL firmada vence— menos esto. Con 510
 * destinatarios, un reintento mal resuelto son cientos de duplicados irreversibles en las bandejas
 * de entrada de vecinos reales.
 *
 * De ahí las tres decisiones que se ven en las funciones de abajo:
 *
 *  1. **La fila nace antes del `sendMail()`**, en su propia transacción, y se commitea. Si el
 *     proceso muere en el medio, lo que queda escrito es "se intentó", que es la verdad.
 *  2. **El claim es un `update` condicional** (`… where estado = 'pendiente'`), no una lectura
 *     seguida de una escritura. Dos workers sobre el mismo lote: uno gana la fila, el otro recibe
 *     cero filas y sigue de largo. La condición está en la base, no en el `if` de nadie.
 *  3. **De `enviando` no se sale solo.** Es estado desconocido a propósito: el mensaje puede haber
 *     salido. Reintentar automáticamente convierte una duda en un duplicado seguro.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL PAR CONTACTO↔DOCUMENTO NO SE ARMA ACÁ
 *
 * `crearLoteDeEnvios()` inserta filas que ya traen los dos juntos, y el trigger
 * `app.envio_antes_insert()` (`0053`) deriva la unidad **desde la liquidación del documento** y
 * rechaza la fila si no coincide con la del contacto. Por eso este archivo nunca arma arrays
 * paralelos de contactos y PDFs unidos por índice: ese es el modo de falla clásico de estos lotes,
 * y un chunking desalineado le manda a un vecino la boleta de otro.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { consultaPeriodoSchema, idSchema } from "@admin-barrios/shared/consultas";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { formatearPeriodo } from "@admin-barrios/shared/fechas";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar, rechazarPeriodoInaccesible } from "../errores.ts";
import { SQL_ROLES_QUE_DISTRIBUYEN } from "./roles.ts";

/**
 * El hash de una dirección, **con el barrio adentro**.
 *
 * Sin el `barrio_id`, el mismo `sha256` de una casilla sería igual en todos los barrios del sistema
 * y la columna se volvería un índice global de "en qué barrios está esta persona" — justamente el
 * cruce que el aislamiento multi-tenant existe para impedir. Con el barrio adentro, el hash contesta
 * "¿se le escribió a esta dirección en ESTE barrio?" y nada más.
 *
 * `lower()` porque la parte de dominio de un email no distingue mayúsculas y el padrón las carga
 * como venga; sin normalizar, dos filas de la misma casilla darían hashes distintos.
 */
export function hashDeDireccion(barrioId: string, email: string): string {
  return createHash("sha256").update(`${barrioId}:${email.trim().toLowerCase()}`).digest("hex");
}

export type DestinatarioDelPeriodo = {
  readonly unidadContactoId: string;
  readonly documentoId: string;
  readonly email: string;
  readonly nombre: string | null;
  readonly unidadEtiqueta: string;
};

export type ContextoDeDistribucion = {
  readonly barrioId: string;
  readonly barrioNombre: string;
  readonly periodoEtiqueta: string;
  readonly denominacion: string;
  /** El informe mensual del período. Es el segundo adjunto, y es el mismo para todos. */
  readonly informeDocumentoId: string;
  readonly informeStorageKey: string;
  readonly destinatarios: readonly DestinatarioDelPeriodo[];
  /**
   * Unidades con boleta emitida y **sin ninguna casilla activa cargada**. No son filas de
   * `envio_liquidacion` —no podrían serlo, la tabla exige un contacto— y por eso viajan aparte: la
   * pantalla tiene que poder decir "a estas N no se les escribió" en vez de callarlo.
   */
  readonly unidadesSinContacto: number;
};

type FilaContexto = {
  barrio_id: string;
  barrio_nombre: string;
  periodo: string;
  denominacion_concepto: string | null;
  informe_id: string;
  informe_storage_key: string;
};

type FilaDestinatario = {
  unidad_contacto_id: string;
  documento_id: string;
  email: string;
  nombre: string | null;
  manzana: string;
  lote: string;
};

/**
 * Todo lo que hace falta para armar el lote, leído bajo RLS en una sola pasada.
 *
 * **La boleta que viaja es la ÚLTIMA emitida de cada unidad**, y por eso hay un `distinct on`: con
 * una reemisión hay dos filas de la misma unidad en el mismo período, y mandar la vieja es mandar
 * importes que ya se corrigieron. La fila de `envio_liquidacion` guarda cuál viajó justamente
 * porque "la boleta de esa unidad" es ambiguo.
 */
export async function leerContextoDeDistribucion(
  tx: DbConIdentidad,
  parametros: { readonly periodoId: string },
): Promise<ContextoDeDistribucion> {
  const { periodoId } = consultaPeriodoSchema.parse(parametros);

  return enBase(async () => {
    const contexto = (
      await tx.execute<FilaContexto>(sql`
        select p.barrio_id, n.nombre as barrio_nombre, p.periodo, p.denominacion_concepto,
               d.id as informe_id, d.storage_key as informe_storage_key
          from periodo_expensa p
          join tenant_node n on n.id = p.barrio_id and n.deleted_at is null
          -- El informe más reciente del período: si se reemitió, viaja el corregido.
          join lateral (
            select id, storage_key from documento_emitido
             where periodo_id = p.id and tipo = 'informe_mensual'
             order by emitido_at desc, id
             limit 1
          ) d on true
         where p.id = ${periodoId}
      `)
    ).rows[0];

    if (!contexto) {
      /*
       * Un solo mensaje para "el período no existe", "no es de un barrio que puedas ver" y "no tiene
       * informe emitido". Distinguirlos convertiría esto en un oráculo de existencia de períodos
       * ajenos; la precondición material la verifica igual el trigger de `trabajo` (`0053`), que es
       * el que no se puede saltear.
       */
      rechazar(
        "periodo_incompleto",
        "No encontramos el período o todavía no tiene su informe mensual emitido.",
        "El informe mensual es el segundo adjunto del envío: emitilo antes de distribuir.",
      );
    }

    const { rows: destinatarios } = await tx.execute<FilaDestinatario>(sql`
      select distinct on (c.id)
             c.id as unidad_contacto_id, d.id as documento_id, c.email, c.nombre,
             u.manzana, u.lote
        from documento_emitido d
        join liquidacion l on l.id = d.liquidacion_id
        join unidad_funcional u on u.id = l.unidad_funcional_id
        join unidad_contacto c on c.unidad_funcional_id = u.id and c.activo
       where d.periodo_id = ${periodoId} and d.tipo = 'boleta_unidad'
       -- Por contacto, la boleta más reciente de SU unidad. El distinct on exige que el orden
       -- empiece por la misma expresión que agrupa.
       order by c.id, d.emitido_at desc, d.id
    `);

    const { rows: sinContacto } = await tx.execute<{ n: string }>(sql`
      select count(*)::text as n
        from documento_emitido d
        join liquidacion l on l.id = d.liquidacion_id
       where d.periodo_id = ${periodoId} and d.tipo = 'boleta_unidad'
         and not exists (
           select 1 from unidad_contacto c
            where c.unidad_funcional_id = l.unidad_funcional_id and c.activo
         )
    `);

    return {
      barrioId: contexto.barrio_id,
      barrioNombre: contexto.barrio_nombre,
      periodoEtiqueta: formatearPeriodo(contexto.periodo),
      // El fallback vive acá y no en la plantilla: es un dato del barrio, no del correo.
      denominacion: contexto.denominacion_concepto ?? "expensa",
      informeDocumentoId: contexto.informe_id,
      informeStorageKey: contexto.informe_storage_key,
      destinatarios: destinatarios.map((f) => ({
        unidadContactoId: f.unidad_contacto_id,
        documentoId: f.documento_id,
        email: f.email,
        nombre: f.nombre,
        unidadEtiqueta: etiquetaUnidad(f.manzana, f.lote),
      })),
      unidadesSinContacto: Number.parseInt(sinContacto[0]?.n ?? "0", 10),
    };
  });
}

/**
 * Registra el lote entero **antes de que salga un solo correo**.
 *
 * `on conflict do nothing` sobre `uq_envio_periodo_contacto` es lo que hace que esta función sea
 * segura de correr dos veces: el segundo intento no duplica nada y no pisa el estado del primero. Es
 * el mismo mecanismo que `uq_trabajo_pendiente`, aplicado por destinatario en vez de por trabajo.
 *
 * Devuelve cuántas filas **nacieron acá**, que no es lo mismo que cuántas hay: la diferencia son las
 * que ya existían de un intento anterior, y esas se recorren igual pero no se vuelven a crear.
 */
export async function crearLoteDeEnvios(
  tx: DbConIdentidad,
  entrada: {
    readonly periodoId: string;
    readonly barrioId: string;
    readonly informeDocumentoId: string;
    readonly plantillaVersion: string;
    readonly trabajoId: string;
    readonly destinatarios: readonly DestinatarioDelPeriodo[];
  },
): Promise<number> {
  const { periodoId } = consultaPeriodoSchema.parse({ periodoId: entrada.periodoId });
  idSchema.parse(entrada.informeDocumentoId);

  if (entrada.destinatarios.length === 0) {
    /*
     * No es un caso borde silencioso: significa que el período tiene boletas y **ninguna unidad
     * tiene casilla cargada**. Mandar cero correos y declarar el período distribuido sería la peor
     * de las salidas — el administrador creería que los vecinos la recibieron.
     */
    rechazar(
      "periodo_incompleto",
      "Ninguna unidad del período tiene un correo activo cargado.",
      "Cargá al menos un contacto en el padrón antes de distribuir.",
    );
  }

  return enBase(async () => {
    /*
     * `barrio_id`, `unidad_funcional_id`, `solicitado_por`, `encolado_at`, `estado` e `intento` se
     * **omiten a propósito**: los escribe `app.envio_antes_insert()`. La unidad en particular NO
     * puede venir de acá — el trigger la deriva de la liquidación del documento, y esa derivación es
     * el control que impide el par cruzado.
     */
    const tuplas = sql.join(
      entrada.destinatarios.map(
        (d) => sql`(
          ${periodoId}, ${d.unidadContactoId}, ${d.documentoId}, ${entrada.informeDocumentoId},
          ${d.email}, ${hashDeDireccion(entrada.barrioId, d.email)},
          ${entrada.plantillaVersion}, ${entrada.trabajoId}
        )`,
      ),
      sql`, `,
    );

    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into envio_liquidacion (
        periodo_id, unidad_contacto_id, documento_id, informe_documento_id,
        email_snapshot, email_hash, plantilla_version, trabajo_id
      ) values ${tuplas}
      on conflict (periodo_id, unidad_contacto_id) do nothing
      returning id
    `);

    return rows.length;
  });
}

export type EnvioPendiente = {
  readonly id: string;
  readonly documentoId: string;
  readonly email: string;
  readonly nombre: string | null;
  readonly unidadEtiqueta: string;
  readonly boletaStorageKey: string;
};

/**
 * Los envíos del período que todavía esperan.
 *
 * **Solo `pendiente`.** Un `enviando` no se devuelve nunca —es estado desconocido y reintentarlo es
 * fabricar un duplicado— y un `fallado` tampoco: reintentar es una decisión de una persona que miró
 * el error, no del bucle.
 */
export async function enviosPendientes(
  tx: DbConIdentidad,
  parametros: { readonly periodoId: string },
): Promise<readonly EnvioPendiente[]> {
  const { periodoId } = consultaPeriodoSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<{
      id: string;
      documento_id: string;
      email_snapshot: string;
      nombre: string | null;
      manzana: string;
      lote: string;
      storage_key: string;
    }>(sql`
      select e.id, e.documento_id, e.email_snapshot, c.nombre,
             u.manzana, u.lote, d.storage_key
        from envio_liquidacion e
        join unidad_contacto c on c.id = e.unidad_contacto_id
        join unidad_funcional u on u.id = e.unidad_funcional_id
        join documento_emitido d on d.id = e.documento_id
       where e.periodo_id = ${periodoId} and e.estado = 'pendiente'
       order by u.manzana, u.lote, e.id
    `);

    return rows.map((f) => ({
      id: f.id,
      documentoId: f.documento_id,
      /*
       * **La dirección congelada, nunca `c.email`.** El `join` con `unidad_contacto` está para el
       * nombre de cortesía, no para la casilla: leer la dirección VIGENTE sería re-apuntar el envío
       * a donde el contacto apunte hoy, que es exactamente cómo se filtra la boleta de un vecino a
       * la casilla de quien editó el padrón después (B-1).
       */
      email: f.email_snapshot,
      nombre: f.nombre,
      unidadEtiqueta: etiquetaUnidad(f.manzana, f.lote),
      boletaStorageKey: f.storage_key,
    }));
  });
}

/**
 * **El claim.** Pasa un envío de `pendiente` a `enviando` y le fija su `Message-ID`, todo en el
 * mismo `update` condicional.
 *
 * Quien llama tiene que **commitear esto antes de mandar el correo**. Devuelve `false` si la fila ya
 * no estaba `pendiente` —otro worker la tomó, o alguien la canceló—, y ese `false` significa "no la
 * toques", nunca "reintentá".
 */
export async function reclamarEnvio(
  tx: DbConIdentidad,
  entrada: { readonly envioId: string; readonly mensajeId: string },
): Promise<boolean> {
  idSchema.parse(entrada.envioId);

  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      update envio_liquidacion
         set estado = 'enviando',
             intento = intento + 1,
             mensaje_id = ${entrada.mensajeId},
             error_codigo = null
       where id = ${entrada.envioId} and estado = 'pendiente'
      returning id
    `);
    return rows.length === 1;
  });
}

/** El servidor aceptó el mensaje. El sello de fecha lo pone la base (`app.envio_antes_update()`). */
export async function marcarEnvioAceptado(
  tx: DbConIdentidad,
  entrada: { readonly envioId: string },
): Promise<void> {
  idSchema.parse(entrada.envioId);

  await enBase(async () => {
    await tx.execute(sql`
      update envio_liquidacion set estado = 'aceptado'
       where id = ${entrada.envioId} and estado = 'enviando'
    `);
  });
}

/**
 * El `sendMail()` levantó.
 *
 * `codigo` es un código corto y ya saneado por quien llama, **nunca el mensaje crudo del servidor
 * SMTP**: ese suele traer la dirección completa del destinatario y a veces un pedazo del cuerpo, y
 * esta tabla la lee una pantalla.
 */
export async function marcarEnvioFallado(
  tx: DbConIdentidad,
  entrada: { readonly envioId: string; readonly codigo: string },
): Promise<void> {
  idSchema.parse(entrada.envioId);

  await enBase(async () => {
    await tx.execute(sql`
      update envio_liquidacion set estado = 'fallado', error_codigo = ${entrada.codigo.slice(0, 60)}
       where id = ${entrada.envioId} and estado = 'enviando'
    `);
  });
}

export type ResumenDeEnvios = {
  readonly pendientes: number;
  readonly enviando: number;
  readonly aceptados: number;
  readonly fallados: number;
  readonly cancelados: number;
  readonly rebotados: number;
};

/** El recuento por estado del período. Es lo que mira la pantalla y lo que decide si ya terminó. */
export async function resumenDeEnvios(
  tx: DbConIdentidad,
  parametros: { readonly periodoId: string },
): Promise<ResumenDeEnvios> {
  const { periodoId } = consultaPeriodoSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<{ estado: string; n: string }>(sql`
      select estado, count(*)::text as n
        from envio_liquidacion where periodo_id = ${periodoId}
       group by estado
    `);

    const de = (estado: string) => Number.parseInt(rows.find((f) => f.estado === estado)?.n ?? "0", 10);
    return {
      pendientes: de("pendiente"),
      enviando: de("enviando"),
      aceptados: de("aceptado"),
      fallados: de("fallado"),
      cancelados: de("cancelado"),
      rebotados: de("rebotado"),
    };
  });
}

/**
 * Marca el período como distribuido.
 *
 * **Solo si no quedó nada en vuelo**, y esa condición no es cosmética: `distribuida` es un estado
 * terminal con firma congelada (`0053`), o sea una declaración de que el período se le mandó a los
 * vecinos. Sellarlo con envíos todavía `pendiente` o `enviando` sería firmar algo que no terminó de
 * pasar.
 *
 * Los `fallado` **no** lo impiden: son un resultado, no un pendiente. La pantalla los muestra y una
 * persona decide si reintenta.
 */
export async function marcarPeriodoDistribuido(
  tx: DbConIdentidad,
  parametros: { readonly periodoId: string },
): Promise<boolean> {
  const { periodoId } = consultaPeriodoSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      update periodo_expensa set estado = 'distribuida'
       where id = ${periodoId}
         and estado = 'emitida'
         and not exists (
           select 1 from envio_liquidacion
            where periodo_id = ${periodoId} and estado in ('pendiente', 'enviando')
         )
      returning id
    `);
    return rows.length === 1;
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El panorama: todo lo que la pantalla de distribución necesita, en una sola pasada
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** El paquete ya armado de un período, si hay alguno. */
export type PaqueteDelPeriodo = {
  readonly id: string;
  /**
   * Cuándo se armó, **en UTC** y con el formato `YYYY-MM-DD HH:MM` que
   * `@admin-barrios/shared/fechas` sabe imprimir.
   *
   * ⚠ **Va en UTC porque no hay zona horaria por barrio en el esquema**, y elegir una sería hornear
   * la del barrio piloto (regla del producto: esto sirve a barrios de cualquier lado). La pantalla
   * lo rotula como UTC en vez de mostrarlo como si fuera la hora local — que es lo que hacía antes,
   * y por eso un paquete armado a las 21:30 de Argentina se veía con la fecha del día siguiente.
   * Cuando exista `barrio.zona_horaria`, se convierte acá y se saca el rótulo.
   */
  readonly armadoAt: string;
  readonly bytes: number;
  readonly documentos: number;
  /**
   * Boletas emitidas del período que **no** están en el ZIP. Distinto de cero significa que el
   * paquete quedó **superado** —se emitieron boletas después de armarlo— y hay que rearmarlo.
   */
  readonly boletasFaltantes: number;
};

/**
 * El estado de los tres pasos de la distribución, leído de una vez.
 *
 * **Existe aparte de `leerContextoDeDistribucion()` porque no lanza.** Aquella arma el lote y por eso
 * exige que el informe esté emitido; ésta es la que dibuja la pantalla, y "todavía no hay informe" es
 * justamente uno de los estados que tiene que poder mostrar. Una que rechace no puede pintar el
 * checklist que dice qué falta.
 */
export type PanoramaDeDistribucion = {
  /** Boletas (`boleta_unidad`) emitidas del período. Paso 0: sin esto no hay nada que distribuir. */
  readonly boletas: number;
  /** ¿Ya se emitió el informe mensual? Es el segundo adjunto de cada correo. */
  readonly informeEmitido: boolean;
  readonly paquete: PaqueteDelPeriodo | null;
  /**
   * Unidades con boleta emitida que tienen **al menos una casilla activa**. Es el conteo real de
   * destinatarios, no una estimación sobre el padrón: sale de las mismas tablas que recorre
   * `crearLoteDeEnvios()`.
   */
  readonly destinatarios: number;
  /**
   * Unidades con boleta emitida y **sin ninguna casilla activa**. No van a recibir nada, y la
   * pantalla lo dice antes de mandar en vez de callarlo (mismo criterio que `ContextoDeDistribucion`).
   */
  readonly unidadesSinContacto: number;
  readonly envios: ResumenDeEnvios;
  /** El usuario tiene un rol que puede distribuir. Es para la UI; el trigger lo vuelve a verificar. */
  readonly puedeDistribuir: boolean;
};

export async function panoramaDeDistribucion(
  tx: DbConIdentidad,
  parametros: { readonly periodoId: string },
): Promise<PanoramaDeDistribucion> {
  const { periodoId } = consultaPeriodoSchema.parse(parametros);

  return enBase(async () => {
    /*
     * Una sola consulta y no seis: son seis agregados sobre las mismas tres tablas, y partirlos
     * serían seis round-trips por cada carga de la pantalla. Cada subconsulta va con su propio
     * `select` escalar en vez de un `join` porque cuentan cosas distintas y un `join` entre ellas
     * multiplicaría filas — el modo de falla clásico de contar dos cosas a la vez.
     */
    const fila = (
      await tx.execute<{
        boletas: string;
        informes: string;
        destinatarios: string;
        sin_contacto: string;
        puede_distribuir: boolean;
      }>(sql`
        select
          (select count(*) from documento_emitido d
            where d.periodo_id = p.id and d.tipo = 'boleta_unidad')::text as boletas,
          (select count(*) from documento_emitido d
            where d.periodo_id = p.id and d.tipo = 'informe_mensual')::text as informes,
          -- Unidades CON boleta y con al menos un contacto activo. El distinct va sobre la unidad
          -- y no sobre el contacto: una unidad con dos casillas es un destinatario por casilla en
          -- el lote, pero acá se cuenta a quién le llega, y son las mismas unidades.
          (select count(distinct l.unidad_funcional_id)
             from documento_emitido d
             join liquidacion l on l.id = d.liquidacion_id
            where d.periodo_id = p.id and d.tipo = 'boleta_unidad'
              and exists (select 1 from unidad_contacto c
                           where c.unidad_funcional_id = l.unidad_funcional_id and c.activo))::text
            as destinatarios,
          (select count(distinct l.unidad_funcional_id)
             from documento_emitido d
             join liquidacion l on l.id = d.liquidacion_id
            where d.periodo_id = p.id and d.tipo = 'boleta_unidad'
              and not exists (select 1 from unidad_contacto c
                               where c.unidad_funcional_id = l.unidad_funcional_id and c.activo))::text
            as sin_contacto,
          app.has_role_on(p.barrio_id, ${SQL_ROLES_QUE_DISTRIBUYEN}) as puede_distribuir
        from periodo_expensa p
       where p.id = ${periodoId}
      `)
    ).rows[0];

    // Cero filas bajo RLS = "no existe" y "no es tuyo" son el mismo caso, a propósito.
    if (!fila) rechazarPeriodoInaccesible();

    const { rows: paquetes } = await tx.execute<{
      id: string;
      armado_at: string;
      bytes: number;
      documentos: string;
      faltantes: string;
    }>(sql`
      select q.id,
             -- Conversión explícita a UTC, en vez de un cast a texto: el texto de un timestamptz
             -- depende del TimeZone de la sesión, así que el mismo dato se veía distinto según cómo
             -- estuviera configurado el pool. Se fija a UTC y la pantalla lo rotula como UTC: no hay
             -- zona horaria por barrio en el esquema, y hornear la del piloto sería exactamente lo
             -- que la regla del producto prohíbe. El porqué completo está en PaqueteDelPeriodo.
             to_char(q.armado_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as armado_at,
             q.bytes,
             (select count(*) from paquete_distribucion_item i where i.paquete_id = q.id)::text
               as documentos,
             (select count(*) from documento_emitido d
               where d.periodo_id = q.periodo_id and d.tipo = 'boleta_unidad'
                 and not exists (select 1 from paquete_distribucion_item i
                                  where i.paquete_id = q.id and i.documento_id = d.id))::text
               as faltantes
        from paquete_distribucion q
       where q.periodo_id = ${periodoId}
       order by q.armado_at desc
       limit 1
    `);

    const q = paquetes[0];

    return {
      boletas: Number.parseInt(fila.boletas, 10),
      informeEmitido: Number.parseInt(fila.informes, 10) > 0,
      paquete: q
        ? {
            id: q.id,
            armadoAt: q.armado_at,
            bytes: q.bytes,
            documentos: Number.parseInt(q.documentos, 10),
            boletasFaltantes: Number.parseInt(q.faltantes, 10),
          }
        : null,
      destinatarios: Number.parseInt(fila.destinatarios, 10),
      unidadesSinContacto: Number.parseInt(fila.sin_contacto, 10),
      envios: await resumenDeEnvios(tx, { periodoId }),
      puedeDistribuir: fila.puede_distribuir,
    };
  });
}
