/**
 * Las tres tablas de la emisión de documentos: la **cola de trabajos**, el **documento emitido** y el
 * **registro de acuñación de URLs de descarga**.
 *
 * Diseño y decisiones: ADR-0002 §6 (`docs/arquitectura/02-aplicacion-web-del-administrador.md`) y
 * ADR-0001 §5 y §6 (`docs/arquitectura/01-generacion-de-documentos.md`).
 *
 * Las reglas que hacen que esto sea seguro **no están acá**: viven en la migración de reglas, porque
 * son triggers, policies y grants. Este archivo declara la forma; el de reglas declara quién puede
 * escribir y leer qué. Lo que sí conviene retener leyendo esta declaración:
 *
 *  - **`solicitado_por` no es una firma de auditoría: es la identidad bajo la cual corre el lote**
 *    (ADR-0002 §6.4 punto 2). Por eso la escribe la base desde `app.current_user_id()` y la fila no
 *    es actualizable por el rol de request. Una fila cuya identidad de ejecución la puede escribir
 *    quien la creó es una escalada de privilegios, no un campo más.
 *  - **`storage_key` lleva el `barrio_id` de su propia fila adentro**, verificado por un `check`. Una
 *    clave que apunta a otro barrio no entra, venga del worker, de un script o de una consola.
 *  - **`vista jsonb` es lo que permite explicar un documento emitido sin volver a correr la
 *    liquidación** (ADR-0001 §6): es contra eso que se comparan los tests, no contra bytes de PDF. Y
 *    por lo mismo **el rol de request no puede leer esa columna** (grant por columna, en las reglas):
 *    proyectarla es servir el documento entero sin descargar nada.
 *
 * ### Tres divergencias respecto del texto de los ADR, tomadas a propósito
 *
 * 1. **La tabla se llama `documento_emitido`, no `documento_liquidacion`.** Los ADR la nombraban por
 *    la boleta porque era el único documento que existía; el informe mensual y el listado de saldos
 *    pendientes son **del período**, no de una unidad, y con `liquidacion_id not null` no tendrían
 *    dónde guardarse. Un nombre que miente sobre lo que la tabla contiene es una trampa para el
 *    próximo que la lea.
 * 2. **La `storage_key` lleva un segmento de tipo y no el `liquidacion_id`.** ADR-0001 §6 y el
 *    `check` de ADR-0002 §6.4 se contradicen entre sí (uno lleva `liquidaciones/{id}/`, el otro no);
 *    había que elegir uno solo, porque el patrón de la base y el del validador de storage tienen que
 *    ser el mismo. Un uuid de liquidación en la ruta no explica nada mirando la consola del bucket;
 *    `…/boletas/…` sí. La trazabilidad a la unidad la da la fila, que es donde se puede consultar.
 * 3. **`tipo` nace con los tres valores aunque hoy solo se emita la boleta.** No es prolijidad: es la
 *    columna contra la que se escribe el gate de rol de la descarga, y sin ella el gate no se puede
 *    expresar en una policy.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { CONTENT_TYPES_COMPROBANTE } from "@admin-barrios/shared/cobros";
import { app } from "./tenancy.ts";
import { barrio, unidadContacto, unidadFuncional } from "./dominio.ts";
import { liquidacion, periodoExpensa } from "./expensas.ts";
import { pago } from "./cobros.ts";
import { ordenPago } from "./proveedores.ts";

const listaSql = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(","));

/**
 * Qué código corre el worker.
 *
 * **`text` + `CHECK`, y NO enum nativo — cambió en la migración `0039`.** Nació como `app.enum(...)`
 * con un solo valor (`emitir_documentos_periodo`); agregar `emitir_recibo_pago` (el trabajo que
 * emite el PDF del recibo, `0039_recibos_reglas.sql`) hubiera exigido `ALTER TYPE … ADD VALUE`, que
 * Postgres **no permite dentro de la misma transacción en que se usa el valor nuevo** — y el
 * migrador de este repo (`drizzle-orm/pg-core/dialect.js`) aplica TODAS las migraciones pendientes
 * de una corrida en una sola transacción. Separar en dos archivos tampoco alcanzaba: el `ADD VALUE`
 * y el primer `insert` que lo usa quedan igual dentro de la misma transacción de despliegue. Mismo
 * criterio que `barrio.medio_cobranza_clave` y `pago.origen`: el valor se valida en Zod del lado de
 * la app, no en un tipo de Postgres.
 */
export const TIPOS_TRABAJO = [
  "emitir_documentos_periodo",
  "emitir_recibo_pago",
  /**
   * Los tres de Distribución (`0053`). **Son tres y no uno** porque `MAX_INTENTOS_TRABAJO` y
   * `estado = 'fallado'` son **por fila**: con un solo trabajo, un fallo al armar el ZIP quemaría un
   * intento del envío, y reintentarlo volvería a recorrer destinatarios — que en el caso del correo
   * es irreversible. Separados, "reintentá el ZIP" no toca un email.
   */
  "emitir_informe_periodo",
  "armar_paquete_periodo",
  "distribuir_liquidaciones",
] as const;
export type TipoTrabajo = (typeof TIPOS_TRABAJO)[number];

export const estadoTrabajo = app.enum("estado_trabajo", ["encolado", "corriendo", "terminado", "fallado"]);

/**
 * Qué documento es. El listado nominado de saldos pendientes es cualitativamente distinto de una
 * boleta —una copia es la deuda con nombre de todo el barrio— y `app.readable_tenant_ids()` incluye
 * `contador` y `auditor` (0018). Con una sola tabla y sin `tipo`, el día que se guarde el primer
 * listado lo lee toda la membresía de gestión y nadie se va a acordar de que había que cerrarlo.
 */
export const tipoDocumento = app.enum("tipo_documento", [
  "boleta_unidad",
  "informe_mensual",
  "listado_saldos_pendientes",
]);

/**
 * La cola. Un `insert` la crea, el worker la avanza, y nadie más la toca: el rol de request no tiene
 * ni policy ni grant de `update` (ADR-0002 §6.2).
 *
 * `barrio_id` **no viene en el insert**: lo deriva el trigger desde `referencia_id`, bajo RLS, y
 * falla cerrado si no lo puede resolver. Es el mismo mecanismo del que ya dependen
 * `app.periodo_transicion()` (0013) y `app.cbu_antes()` (0017).
 */
export const trabajo = pgTable(
  "trabajo",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    tipo: text("tipo").$type<TipoTrabajo>().notNull(),
    /**
     * Para `emitir_documentos_periodo`, el `periodo_expensa.id`; para `emitir_recibo_pago`, el
     * `pago.id`. Sin FK: el tipo decide a qué apunta.
     */
    referenciaId: uuid("referencia_id").notNull(),
    estado: estadoTrabajo("estado").notNull().default("encolado"),
    /**
     * Progreso **para la pantalla, y nada más**. Lo avanza el worker con la conexión de jobs, por
     * chunk y no por documento. La fuente de verdad del avance es `count(documento_emitido)`: si el
     * proceso muere entre escribir las 50 filas y avanzar el contador, `hechos` queda un chunk
     * atrasado. Es la consecuencia aceptada de que el rol de request no pueda tocar esta tabla, y es
     * la resolución de la contradicción entre ADR-0002 §6.2a (ni update ni grant para `app_request`)
     * y §6.4 punto 3 (que mandaba avanzarlo dentro del mismo `conUsuario`).
     */
    hechos: integer("hechos").notNull().default(0),
    /** Lo escribe el worker al arrancar el lote. Mientras es `null`, la pantalla dice "preparando". */
    total: integer("total"),
    intento: smallint("intento").notNull().default(0),
    /** La identidad con la que el worker corre el lote. La escribe la base, nunca el request. */
    solicitadoPor: uuid("solicitado_por").notNull(),
    solicitadoAt: timestamp("solicitado_at", { withTimezone: true }).notNull().defaultNow(),
    iniciadoAt: timestamp("iniciado_at", { withTimezone: true }),
    terminadoAt: timestamp("terminado_at", { withTimezone: true }),
    /**
     * El motivo de la falla, tal como lo va a leer una pantalla. **No es `e.message`**: rige la misma
     * regla que `mensajeDeError` de ADR-0002 §4.2 — los `raise exception` del esquema interpolan
     * valores de filas que quien lee el trabajo puede no tener derecho a ver.
     */
    error: text("error"),
  },
  (t) => [
    // Idempotencia (ADR-0001 §5.3): un solo trabajo pendiente por (referencia, tipo). Un segundo
    // "generar los documentos" mientras el primero corre no encola nada: rebota acá.
    uniqueIndex("uq_trabajo_pendiente")
      .on(t.referenciaId, t.tipo)
      .where(sql`estado in ('encolado', 'corriendo')`),
    // El barrido de rezagados del worker toca este índice y en un día normal devuelve cero filas:
    // es el "guard de early-exit barato" que pide el presupuesto de recursos §5.
    index("idx_trabajo_encolado").on(t.solicitadoAt).where(sql`estado = 'encolado'`),
    index("idx_trabajo_barrio").on(t.barrioId),
    index("idx_trabajo_referencia").on(t.referenciaId),
  ],
);

/**
 * Un documento emitido. **Append-only**: se persiste y no se regenera (ADR-0001 §6). Reimprimir es
 * servir el objeto guardado; regenerar produce un documento **distinto** del que se envió, con
 * `{token}` nuevo y fila nueva, y nunca pisa al anterior.
 */
export const documentoEmitido = pgTable(
  "documento_emitido",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Redundante a propósito: es lo que el `check` de `storage_key` compara contra la clave. */
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    periodoId: uuid("periodo_id")
      .notNull()
      .references(() => periodoExpensa.id, { onDelete: "restrict" }),
    tipo: tipoDocumento("tipo").notNull(),
    /**
     * **Nullable, y el `check` lo ata al `tipo`**: solo la boleta es de una unidad. El informe
     * mensual y el listado de saldos pendientes son del período entero.
     */
    liquidacionId: uuid("liquidacion_id").references(() => liquidacion.id, { onDelete: "restrict" }),
    storageKey: text("storage_key").notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    bytes: integer("bytes").notNull(),
    /** El modelo de vista congelado (ADR-0001 §4.1): unos pocos KB que explican el documento entero. */
    vista: jsonb("vista").notNull(),
    vistaVersion: text("vista_version").notNull(),
    /** El motor que lo midió. Una versión distinta de Chromium mide el texto distinto. */
    motor: text("motor").notNull(),
    plantillaHash: char("plantilla_hash", { length: 64 }).notNull(),
    medioCobranza: text("medio_cobranza").notNull(),
    emitidoAt: timestamp("emitido_at", { withTimezone: true }).notNull().defaultNow(),
    /** La escribe la base con `app.current_user_id()`, igual que `periodo_expensa.emitida_por`. */
    emitidoPor: uuid("emitido_por").notNull(),
  },
  (t) => [
    // `storage_key unique` protege la FILA, no el OBJETO. El objeto lo protege el `put` condicional
    // del storage (`If-None-Match: *`): sin él, una segunda corrida cambia el PDF y deja intacto el
    // `sha256` que lo acredita — un documento cuya integridad declarada es mentira.
    uniqueIndex("uq_documento_storage_key").on(t.storageKey),
    // Prefijo `doc_emi` y no `documento`: `idx_documento_barrio` ya es de `documento_barrio` (0002),
    // que es otra cosa — el acta de una asamblea, no la boleta de una unidad.
    index("idx_doc_emi_liquidacion").on(t.liquidacionId),
    index("idx_doc_emi_periodo_tipo").on(t.periodoId, t.tipo),
    index("idx_doc_emi_barrio").on(t.barrioId),
    check(
      "documento_emitido_liquidacion_chk",
      sql`(${t.tipo} = 'boleta_unidad' and ${t.liquidacionId} is not null)
          or (${t.tipo} <> 'boleta_unidad' and ${t.liquidacionId} is null)`,
    ),
    // La clave lleva adentro el barrio de su propia fila (ADR-0002 §6.4 punto 4). Esto NO es "una
    // validación más": es lo que hace que no exista un control que haya que acordarse de hacer antes
    // de cada escritura. Y el alfabeto cerrado descarta `barrios/{A}/../{B}/x.pdf`, que satisface
    // cualquier `startsWith` y resuelve a otro lado apenas alguien haga un `path.join`.
    //
    // `\\.` y no `\.`: en un template de TypeScript `\.` es una secuencia de escape inválida que se
    // colapsa a `.` — y un `.` en una expresión regular acepta CUALQUIER carácter, así que `…/xpdf`
    // pasaría el control. Se ve idéntico en el diff y no lo atrapa ningún test de tipos.
    //
    // El patrón está duplicado a propósito (acá en SQL, y en `packages/almacenamiento` en TypeScript)
    // porque son dos lenguajes. Que no diverjan **no es una convención**: hay un test que le pide a
    // la base su propia definición del `check` y la compara con la del validador.
    check(
      "documento_storage_key_chk",
      sql`${t.storageKey} ~ ('^barrios/' || ${t.barrioId}::text || '/periodos/[0-9a-f-]{36}/(boletas|informes|listados)/[A-Za-z0-9_-]{22,64}\\.pdf$')`,
    ),
  ],
);

/**
 * Cada vez que se acuña una URL firmada de descarga.
 *
 * **El nombre de la columna es `url_firmada_at` y no `descargado_at`, y la diferencia importa:** con
 * una URL firmada el objeto lo sirve el storage directo, sin pasar por nosotros. Registramos que
 * alguien pidió el link, no que lo bajó. Si esto queda mal nombrado, en algún momento alguien va a
 * declarar por escrito que el sistema registra que el vecino descargó su boleta, y no es cierto.
 *
 * La fila se escribe **antes** de firmar, en la misma transacción que leyó el documento bajo RLS: si
 * el registro falla, no hay URL. Una auditoría que se puede saltear con un error no es una auditoría.
 *
 * **Sin IP ni user-agent**, a propósito: suman un dato personal sobre un empleado del estudio y no
 * compran nada. Lo que hace falta saber es qué usuario del sistema pidió qué documento y cuándo.
 *
 * **Generalizada en la migración `0039`** para poder registrar también la descarga de un
 * `comprobante_adjunto` de `pago` o de un `recibo_emitido`, no solo de `documento_emitido`. Se
 * eligió una FK NULLABLE por cada tipo de documento (`documento_id`/`pago_id`/`recibo_emitido_id`,
 * con un `CHECK` de "exactamente uno") y no una columna polimórfica (`tipo_referencia` +
 * `referencia_id` sin FK física): esta forma **conserva la integridad referencial real** de cada
 * caso —el candado estructural que el resto del esquema usa en todos lados—, y `documento_emitido`
 * sigue funcionando exactamente igual que antes (su columna no cambió de tipo ni de FK, solo dejó de
 * ser `NOT NULL`).
 */
export const descargaDocumento = pgTable(
  "descarga_documento",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Redundante a propósito, igual que en el documento: la RLS filtra por acá. */
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    /** Exactamente una de las cuatro referencias viaja (ver `descarga_referencia_unica_chk`, 0049). */
    documentoId: uuid("documento_id").references(() => documentoEmitido.id, { onDelete: "restrict" }),
    /** Descarga del comprobante adjunto de un pago manual. */
    pagoId: uuid("pago_id").references(() => pago.id, { onDelete: "restrict" }),
    reciboEmitidoId: uuid("recibo_emitido_id").references(() => reciboEmitido.id, { onDelete: "restrict" }),
    /** Descarga del comprobante de pago O de la factura de una orden de pago — las dos cuelgan de la
     *  misma `ordenPagoId`; cuál de las dos storage keys se pidió lo dice la ruta, no esta columna
     *  (generalizada, no gemela — mismo precedente que las otras tres, `0049`). */
    ordenPagoId: uuid("orden_pago_id").references(() => ordenPago.id, { onDelete: "restrict" }),
    /**
     * Descarga del ZIP de distribución (`0052`).
     *
     * **Acá la generalización SÍ corresponde, y es el contraste exacto con `exportacion_movimientos`.**
     * Al XLSX se le negó la entrada porque no dejaba artefacto: su caso habría tenido las cuatro FK
     * en `null` y habría obligado a relajar el `CHECK` de "exactamente una" a "una o ninguna",
     * derogándolo. El paquete es lo contrario en las tres cosas que importaban — hay fila a la cual
     * apuntar, hay URL firmada real y hay TTL real —, así que es la misma forma que las otras cuatro.
     */
    paqueteId: uuid("paquete_id").references(() => paqueteDistribucion.id, { onDelete: "restrict" }),
    /** La escribe la base con `app.current_user_id()`. */
    solicitadoPor: uuid("solicitado_por").notNull(),
    urlFirmadaAt: timestamp("url_firmada_at", { withTimezone: true }).notNull().defaultNow(),
    ttlSegundos: integer("ttl_segundos").notNull(),
  },
  (t) => [
    index("idx_descarga_documento").on(t.documentoId),
    index("idx_descarga_pago").on(t.pagoId),
    index("idx_descarga_recibo").on(t.reciboEmitidoId),
    index("idx_descarga_orden_pago").on(t.ordenPagoId),
    index("idx_descarga_barrio_fecha").on(t.barrioId, t.urlFirmadaAt),
    check("descarga_ttl_chk", sql`${t.ttlSegundos} > 0 and ${t.ttlSegundos} <= 600`),
  ],
);

/**
 * Contador del número de recibo, **uno por barrio** (migración `0038`/`0039`). El número de recibo
 * es dato legal impreso, así que es secuencial POR BARRIO —no un `nid` global de tenancía— y se
 * actualiza bajo `for update` de esta fila, dentro del mismo trigger que emite el recibo
 * (`app.recibo_antes()`, `0039_recibos_reglas.sql`): la fila de este contador es el único punto que
 * dos emisiones concurrentes del mismo barrio tienen que disputarse.
 */
export const reciboSecuencia = pgTable("recibo_secuencia", {
  barrioId: uuid("barrio_id")
    .primaryKey()
    .references(() => barrio.barrioId, { onDelete: "restrict" }),
  ultimoNumero: bigint("ultimo_numero", { mode: "number" }).notNull().default(0),
});

/**
 * El recibo emitido de un pago. **Tabla propia y NO se reusa `documento_emitido`** (decisión final
 * del panel): esa tabla tiene `periodo_id NOT NULL` y su `storage_key` atada a
 * `…/periodos/{uuid}/…` — un recibo no cuelga de un período, cuelga de un `pago`. Mismo criterio de
 * append-only que `documento_emitido`: se emite y no se regenera, `{token}` nuevo y fila nueva.
 */
export const reciboEmitido = pgTable(
  "recibo_emitido",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    pagoId: uuid("pago_id")
      .notNull()
      .references(() => pago.id, { onDelete: "restrict" }),
    /** Secuencial por barrio, lo asigna `app.recibo_antes()` desde `recibo_secuencia`. */
    numeroRecibo: bigint("numero_recibo", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    bytes: integer("bytes").notNull(),
    vista: jsonb("vista").notNull(),
    vistaVersion: text("vista_version").notNull(),
    motor: text("motor").notNull(),
    plantillaHash: char("plantilla_hash", { length: 64 }).notNull(),
    emitidoAt: timestamp("emitido_at", { withTimezone: true }).notNull().defaultNow(),
    emitidoPor: uuid("emitido_por").notNull(),
  },
  (t) => [
    uniqueIndex("uq_recibo_barrio_numero").on(t.barrioId, t.numeroRecibo),
    uniqueIndex("uq_recibo_storage_key").on(t.storageKey),
    index("idx_recibo_pago").on(t.pagoId),
    index("idx_recibo_barrio").on(t.barrioId),
    // `\\.` y no `\.` — ver la nota de `documento_storage_key_chk` más arriba.
    check(
      "recibo_storage_key_chk",
      sql`${t.storageKey} ~ ('^barrios/' || ${t.barrioId}::text || '/pagos/' || ${t.pagoId}::text ||
          '/recibos/[A-Za-z0-9_-]{22,64}\\.pdf$')`,
    ),
  ],
);

/**
 * Una solicitud de URL de subida para un comprobante — de un pago manual (`unidad_funcional_id`) o
 * de una orden de pago (`orden_pago_id`, `0046`). **Se escribe antes de firmar el POST presignado,
 * en la misma transacción que leyó la referencia bajo RLS** (`prepararSubidaDeComprobante`,
 * `prepararSubidaDeComprobanteDeOP`, `servicios/documentos.ts`) — mismo principio de auditoría que
 * `descarga_documento`: sin este registro, no hay firma.
 *
 * **Generalizada, no gemela**: mismo precedente que `descarga_documento` (`0039`), que se ensanchó
 * con una tercera referencia en vez de nacer una `descarga_pago`/`descarga_recibo` — conserva la
 * integridad referencial real de cada caso sin duplicar la tabla de auditoría entera por cada tipo
 * de documento nuevo (hallazgo de `arquitecto-software`, panel de Proveedores/OP, 2026-08-21).
 *
 * **No es el pago ni la orden de pago.** `pago_manual_exige_registrador_chk` (`0032`) sigue
 * exigiendo su propio `comprobante_adjunto`; esta tabla es la traza de que alguien pidió subir algo
 * — el objeto puede terminar sin usarse nunca (huérfano, ver el docstring de
 * `ObjectStorage.urlFirmadaDeSubida` en `packages/almacenamiento`) o el documento final puede
 * registrarse después con esta misma clave.
 *
 * **`barrio_id` es redundante a propósito**, igual que en `descarga_documento`/`pago_imputacion`:
 * lo verifican las FKs compuestas anti-cruce contra `unidad_funcional (id, barrio_id)` /
 * `orden_pago (id, barrio_id)` (agregadas a mano en la migración de reglas correspondiente, mismo
 * patrón que `fk_pago_uf_barrio` en `0034`).
 */
export const subidaComprobanteSolicitada = pgTable(
  "subida_comprobante_solicitada",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    /** Exactamente una de las dos referencias viaja (`subida_comprobante_referencia_unica_chk`, `0046`). */
    unidadFuncionalId: uuid("unidad_funcional_id").references(() => unidadFuncional.id, { onDelete: "restrict" }),
    ordenPagoId: uuid("orden_pago_id").references(() => ordenPago.id, { onDelete: "restrict" }),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    /** La escribe la base desde `app.current_user_id()`, igual que `descarga_documento.solicitado_por`. */
    solicitadoPor: uuid("solicitado_por").notNull(),
    solicitadoAt: timestamp("solicitado_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Un token de 128 bits no colisiona en la práctica, pero la clave es la identidad del objeto:
    // dos filas con la misma sería dos solicitudes creyendo que firman el mismo POST.
    uniqueIndex("uq_subida_comprobante_storage_key").on(t.storageKey),
    index("idx_subida_comprobante_barrio").on(t.barrioId),
    index("idx_subida_comprobante_unidad").on(t.unidadFuncionalId),
    index("idx_subida_comprobante_orden_pago").on(t.ordenPagoId),
    check(
      "subida_comprobante_content_type_chk",
      sql`${t.contentType} in (${listaSql(CONTENT_TYPES_COMPROBANTE)})`,
    ),
    // Mismo patrón que `descarga_referencia_unica_chk` (`0039`): exactamente una de las dos.
    check(
      "subida_comprobante_referencia_unica_chk",
      sql`(${t.unidadFuncionalId} is not null)::int + (${t.ordenPagoId} is not null)::int = 1`,
    ),
    // Mismo patrón y misma nota sobre `\\.` que `pago_comprobante_storage_key_chk` (`schema/cobros.ts`):
    // en un template de TypeScript, `\.` es una secuencia de escape inválida que colapsa a `.`. Las
    // DOS formas posibles de clave, condicionadas a cuál de las dos referencias trajo la fila.
    check(
      "subida_comprobante_storage_key_chk",
      sql`(${t.unidadFuncionalId} is not null and ${t.storageKey} ~
            ('^barrios/' || ${t.barrioId}::text || '/pagos/comprobantes/[A-Za-z0-9_-]{22,64}\\.(pdf|jpg|jpeg|png)$'))
          or
          (${t.ordenPagoId} is not null and ${t.storageKey} ~
            ('^barrios/' || ${t.barrioId}::text || '/ordenes-pago/' || ${t.ordenPagoId}::text ||
             '/[A-Za-z0-9_-]{22,64}\\.(pdf|jpg|jpeg|png)$'))`,
    ),
  ],
);

/**
 * La traza de cada extracción del **libro de movimientos** (doc 01 §4.8). Declarada acá porque es
 * la familia de la emisión/entrega de artefactos, aunque este no deje ninguno.
 *
 * **No es `descarga_documento` con un caso más, y esa fue la decisión difícil de este módulo**
 * (panel `arquitecto-software` + `security-engineer`, 2026-08-26). Aquella tabla se generalizó dos
 * veces (`0039`, `0049`) con FKs nullables y un `CHECK` de "exactamente una referencia"; el quinto
 * caso tendría las cuatro en `null` y obligaría a relajar ese `CHECK` a "exactamente una **o
 * ninguna**" — que no lo extiende, lo **deroga**: deja la tabla en la forma polimórfica sin FK que
 * su propio docstring dice que se rechazó. Sumado a que `url_firmada_at`/`ttl_segundos` no aplican
 * (no hay URL que acuñar) y a que lo que se registra es otra cosa —*qué datos salieron del
 * sistema*, no *qué documento se pidió*—, la analogía se rompe entera. El precedente propio es
 * `reciboEmitido`: tabla nueva cuando la forma no es la misma.
 *
 * **La fila se escribe ANTES de serializar, en la misma transacción que lee bajo RLS.** Si el
 * registro falla, no hay planilla — mismo principio que `descargaDocumento`, y acá se sostiene
 * mejor: sin cola de por medio, traza y lectura comparten transacción de verdad.
 *
 * **El `insert` es además el gate de rol** (`0051`): como la exportación no deja artefacto, no hay
 * dónde poner una policy de `select` que decida quién puede exportar. Poniéndolo acá, no se puede
 * exportar sin dejar rastro ni dejar rastro sin tener el rol.
 *
 * Sin PII, sin montos, sin totales, sin IP ni user-agent, sin nombre de archivo ni hash — y con
 * columnas tipadas en vez de un `jsonb` libre, para que el próximo filtro que se agregue no
 * arrastre el nombre de un proveedor adentro de la auditoría.
 */
export const exportacionMovimientos = pgTable(
  "exportacion_movimientos",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    /** La escribe la base desde `app.current_user_id()` (`app.exportacion_antes_insert()`, `0051`). */
    solicitadoPor: uuid("solicitado_por").notNull(),
    solicitadoAt: timestamp("solicitado_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * El rango, inclusivo, como `YYYY-MM` y **no** como FK a `periodo_expensa`: un export abarca N
     * períodos, y tiene que poder registrar un rango que incluya meses **sin período creado** — un
     * barrio atrasado en emitir exporta igual sus movimientos, que es el caso que el panel de
     * dominio pidió sostener. Una FK obligaría a inventar filas de período para poder auditar.
     */
    periodoDesde: text("periodo_desde").notNull(),
    periodoHasta: text("periodo_hasta").notNull(),
    /** `text` + `CHECK`, no enum nativo — mismo motivo que `pago.origen` y `trabajo.tipo`. */
    alcance: text("alcance").notNull(),
    formato: text("formato").notNull(),
    /** Control de volumen. Nunca montos ni totales: una auditoría con plata adentro es un objetivo. */
    filasIngresos: integer("filas_ingresos").notNull(),
    filasImputaciones: integer("filas_imputaciones").notNull(),
    filasEgresos: integer("filas_egresos").notNull(),
    /**
     * El rango incluía al menos un período no emitido: la planilla salió `PROVISORIO` y su
     * clasificación fiscal vino del catálogo vigente, no del snapshot congelado al emitir. Sin este
     * dato no se puede explicar, meses después, por qué dos extracciones del mismo rango difieren
     * legítimamente.
     */
    incluyoProvisorio: boolean("incluyo_provisorio").notNull(),
  },
  (t) => [
    index("idx_exportacion_barrio_fecha").on(t.barrioId, t.solicitadoAt.desc()),
    index("idx_exportacion_usuario").on(t.solicitadoPor, t.solicitadoAt.desc()),
    check("exportacion_periodo_desde_chk", sql`${t.periodoDesde} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("exportacion_periodo_hasta_chk", sql`${t.periodoHasta} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    // `YYYY-MM` ordena igual como texto que como fecha: por eso se eligió ese formato en `periodo_expensa`.
    check("exportacion_rango_chk", sql`${t.periodoHasta} >= ${t.periodoDesde}`),
    check("exportacion_alcance_chk", sql`${t.alcance} in ('movimientos')`),
    check("exportacion_formato_chk", sql`${t.formato} in ('xlsx')`),
    check(
      "exportacion_filas_chk",
      sql`${t.filasIngresos} >= 0 and ${t.filasImputaciones} >= 0 and ${t.filasEgresos} >= 0`,
    ),
  ],
);

/**
 * El ZIP con todas las boletas de un período (`0052`).
 *
 * **Tabla propia y NO una fila de `documento_emitido`**, evaluado de cero y no por analogía con el
 * ADR-0004: ahí el argumento fue que la exportación no dejaba artefacto, y acá sí lo deja. La forma
 * igual no coincide, en cuatro puntos independientes — no lo produjo un renderer (no tiene `vista`,
 * `motor` ni `plantilla_hash`), es **derivado** (se reconstruye de sus partes), y su gate de
 * descarga es el del período entero y no el de una unidad. Sumado a que la re-emisión rompe la
 * semántica: si después se emite una boleta más, el ZIP viejo quedó **incompleto**, y un artefacto
 * derivado tiene una noción de "vigente / superado" que `documento_emitido` no tiene.
 *
 * Precedente: `reciboEmitido` fue tabla nueva por el mismo tipo de motivo.
 */
export const paqueteDistribucion = pgTable(
  "paquete_distribucion",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    periodoId: uuid("periodo_id")
      .notNull()
      .references(() => periodoExpensa.id, { onDelete: "restrict" }),
    storageKey: text("storage_key").notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    bytes: integer("bytes").notNull(),
    /** La escribe la base desde `app.current_user_id()` (`0053`). */
    armadoPor: uuid("armado_por").notNull(),
    armadoAt: timestamp("armado_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_paquete_storage_key").on(t.storageKey),
    index("idx_paquete_periodo").on(t.periodoId, t.armadoAt.desc()),
    index("idx_paquete_barrio").on(t.barrioId),
    // `\\.` y no `\.` — ver la nota de `documento_storage_key_chk`.
    check(
      "paquete_storage_key_chk",
      sql`${t.storageKey} ~ ('^barrios/' || ${t.barrioId}::text || '/periodos/[0-9a-f-]{36}/paquetes/[A-Za-z0-9_-]{22,64}\\.zip$')`,
    ),
    check("paquete_bytes_chk", sql`${t.bytes} > 0`),
  ],
);

/**
 * Qué contiene el paquete. **Tabla hija y no un `jsonb`**: conserva la integridad referencial real
 * —mismo argumento con el que el repo ya rechazó lo polimórfico— y permite contestar con una
 * consulta *"¿a este paquete le faltan boletas emitidas después de armarlo?"*.
 */
export const paqueteDistribucionItem = pgTable(
  "paquete_distribucion_item",
  {
    paqueteId: uuid("paquete_id")
      .notNull()
      .references(() => paqueteDistribucion.id, { onDelete: "cascade" }),
    documentoId: uuid("documento_id")
      .notNull()
      .references(() => documentoEmitido.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ columns: [t.paqueteId, t.documentoId] }),
    index("idx_paquete_item_documento").on(t.documentoId),
  ],
);

/**
 * El registro de envíos — **y el guard de idempotencia del trabajo de distribución**.
 *
 * La diferencia con todo lo demás que hace este sistema: generar un PDF de nuevo es gratis, pero
 * **reenviar un email es un email más en la bandeja del vecino y no se puede retirar**. Por eso la
 * fila se commitea ANTES del `sendMail()` (claim atómico en `0053`), con la consecuencia deliberada
 * de que un envío en `enviando` es **estado desconocido** y no se reintenta solo: se prefiere perder
 * la certeza de que se mandó antes que mandar dos veces.
 *
 * **Grano `(periodo, unidad, dirección)`**, no `(periodo, obligado)`: `unidad_contacto` es 1..N por
 * unidad y "a quién se le escribió" tiene que poder contestarse por dirección concreta.
 *
 * No guarda el cuerpo, ni el asunto, ni los adjuntos, ni importes, ni IP/user-agent.
 */
export const envioLiquidacion = pgTable(
  "envio_liquidacion",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    barrioId: uuid("barrio_id")
      .notNull()
      .references(() => barrio.barrioId, { onDelete: "restrict" }),
    periodoId: uuid("periodo_id")
      .notNull()
      .references(() => periodoExpensa.id, { onDelete: "restrict" }),
    /**
     * El par que hace estructuralmente imposible el cruce entre destinatarios: el trigger de `0053`
     * deriva la unidad **desde la liquidación del documento** y rechaza si no es la del contacto.
     * Como el adjunto se lee de este mismo `documentoId`, el sobre con la boleta de otro vecino no
     * se puede ni persistir ni enviar.
     */
    unidadFuncionalId: uuid("unidad_funcional_id")
      .notNull()
      .references(() => unidadFuncional.id, { onDelete: "restrict" }),
    unidadContactoId: uuid("unidad_contacto_id")
      .notNull()
      .references(() => unidadContacto.id, { onDelete: "restrict" }),
    /** La fila EXACTA que viajó: con reemisiones hay dos boletas de la misma unidad. */
    documentoId: uuid("documento_id")
      .notNull()
      .references(() => documentoEmitido.id, { onDelete: "restrict" }),
    informeDocumentoId: uuid("informe_documento_id").references(() => documentoEmitido.id, {
      onDelete: "restrict",
    }),
    /**
     * **Las dos columnas de email, y van las dos** (decisión del usuario, 2026-08-28). El snapshot
     * congelado es **la única dirección a la que un reenvío puede ir** — con solo el hash habría que
     * volver a leerla de `unidad_contacto`, o sea la dirección VIGENTE, que es exactamente lo que el
     * aislamiento prohíbe ("re-apuntar es cómo se filtra"). El hash contesta "¿se mandó a esta
     * dirección?" sin exponer el claro.
     */
    emailSnapshot: text("email_snapshot").notNull(),
    emailHash: char("email_hash", { length: 64 }).notNull(),
    /** `text` + `CHECK` desde el día uno: agregar `rebotado` no puede exigir un `ALTER TYPE`. */
    estado: text("estado").notNull().default("pendiente"),
    intento: smallint("intento").notNull().default(0),
    /**
     * El `Message-ID`, **generado por el emisor y no por el transporte**. Se guarda desde el día uno
     * aunque nada lea rebotes todavía: es la única llave que va a permitir aparear un rebote con su
     * envío, y si lo pusiera el servidor cambiaría con el proveedor.
     */
    mensajeId: text("mensaje_id"),
    /** Código corto y saneado, nunca el mensaje crudo del SMTP (suele traer la dirección completa). */
    errorCodigo: text("error_codigo"),
    /** Permite reconstruir qué decía el cuerpo **sin guardarlo**, que es lo que deja la PII afuera. */
    plantillaVersion: text("plantilla_version").notNull(),
    trabajoId: uuid("trabajo_id").references(() => trabajo.id, { onDelete: "set null" }),
    solicitadoPor: uuid("solicitado_por").notNull(),
    encoladoAt: timestamp("encolado_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * **`aceptadoAt`, no `enviadoAt`.** Un `sendMail()` que resuelve significa que el servidor de
     * correo aceptó el mensaje, no que llegó — mismo criterio con el que
     * `descargaDocumento.urlFirmadaAt` no se llama `descargadoAt`.
     */
    aceptadoAt: timestamp("aceptado_at", { withTimezone: true }),
  },
  (t) => [
    // La reserva atómica: si dos workers arman el lote a la vez, el segundo rebota acá.
    uniqueIndex("uq_envio_periodo_contacto").on(t.periodoId, t.unidadContactoId),
    uniqueIndex("uq_envio_mensaje_id").on(t.barrioId, t.mensajeId).where(sql`mensaje_id is not null`),
    index("idx_envio_periodo_estado").on(t.periodoId, t.estado),
    index("idx_envio_barrio").on(t.barrioId),
    index("idx_envio_unidad").on(t.unidadFuncionalId),
    /**
     * Sin `sin_contacto` (`0054`): `unidadContactoId` es `not null`, así que una unidad sin contacto
     * no tiene fila y ningún registro puede llevar ese estado. El hecho no se pierde — "a quién no
     * se le escribió" es la diferencia entre las boletas del período y sus envíos, y las dos tablas
     * son append-only.
     */
    check(
      "envio_estado_chk",
      sql`${t.estado} in ('pendiente','enviando','aceptado','fallado','rebotado','cancelado')`,
    ),
    check("envio_intento_chk", sql`${t.intento} >= 0`),
    check("envio_hash_chk", sql`${t.emailHash} ~ '^[0-9a-f]{64}$'`),
    /**
     * `aceptado_at` **sobrevive al rebote** (`0054`): un mensaje que rebota es uno que el servidor
     * aceptó primero y devolvió después. Las dos cosas pasaron y la segunda no deroga a la primera.
     */
    check(
      "envio_aceptado_chk",
      sql`(${t.estado} in ('aceptado','rebotado')) = (${t.aceptadoAt} is not null)`,
    ),
    /**
     * **ENV-1 (`0055`): una fila en `pendiente` NUNCA fue entregada al transporte.**
     *
     * Es lo que convierte a `enviando` en una **puerta de una vía**. `0054` validaba las transiciones
     * salto por salto y no la historia, así que `enviando → fallado → pendiente` devolvía a la cola
     * una fila en estado *desconocido* —el correo pudo haber salido— y eso es un segundo correo al
     * vecino.
     *
     * Va como `CHECK` y no como guarda del trigger a propósito: **no depende de la lista de
     * transiciones**. Aunque alguien reponga `fallado → pendiente`, una fila fallada tiene
     * `intento >= 1` y esto la rechaza igual. Y no hizo falta ninguna columna nueva: `intento` ya era
     * el registro de "estuvo en vuelo" —sube solo en el claim—, lo que faltaba era atarlo al estado.
     */
    check(
      "envio_pendiente_virgen_chk",
      sql`${t.estado} <> 'pendiente' or (${t.mensajeId} is null and ${t.intento} = 0)`,
    ),
    /**
     * `error_codigo` lo lee una pantalla, y el `slice(0, 60)` que lo acota vive **solo en el
     * servicio** — o sea, del lado que un `update` directo no atraviesa (`security-engineer`, B-3).
     */
    check("envio_error_codigo_chk", sql`${t.errorCodigo} is null or length(${t.errorCodigo}) <= 60`),
  ],
);

export type ReciboSecuenciaRow = typeof reciboSecuencia.$inferSelect;
export type PaqueteDistribucionRow = typeof paqueteDistribucion.$inferSelect;
export type EnvioLiquidacionRow = typeof envioLiquidacion.$inferSelect;
export type ReciboEmitidoRow = typeof reciboEmitido.$inferSelect;
export type SubidaComprobanteSolicitadaRow = typeof subidaComprobanteSolicitada.$inferSelect;
export type ExportacionMovimientosRow = typeof exportacionMovimientos.$inferSelect;
