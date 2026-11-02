/**
 * Parámetros de mora e imputación (tanda T1, ADR-0006). Migraciones `0056` (formas), `0057` (reglas,
 * RLS, migración de datos) y `0058` (se van `tasa_mora` y `barrio.orden_imputacion`).
 *
 * Dos niveles —la administración (`tenant_node` tipo `administrador`) y el barrio— en una sola
 * columna `nodo_id`: la administración de un barrio es su padre en la tenancía y se resuelve al
 * consultar, nunca se copia (panel de arquitectura). Append-only: un valor no se edita; se fija otro
 * con su fecha, o se anula uno programado. La escritura pasa SOLO por `app.fijar_parametro()` y
 * `app.anular_parametro_programado()`; esta capa no tiene grant de insert.
 *
 * El registro de claves, sus tipos y sus textos viven en `@admin-barrios/shared/parametros-mora`.
 */

import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, date } from "drizzle-orm/pg-core";
import { tenantNode } from "./tenancy.ts";

export const parametroRegistro = pgTable(
  "parametro_registro",
  {
    clave: text("clave").primaryKey(),
    /** Lo que recibe una administración NUEVA (trigger de `0057`). */
    valorInicial: jsonb("valor_inicial").notNull(),
    requiereRespaldo: boolean("requiere_respaldo").notNull(),
  },
  (t) => [check("parametro_registro_clave_chk", sql`${t.clave} ~ '^[a-z_]+\\.[a-z_]+$'`)],
);

export const parametroValor = pgTable(
  "parametro_valor",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Con la misma vigencia gana la última creada. */
    orden: bigint("orden", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    nodoId: uuid("nodo_id")
      .notNull()
      .references(() => tenantNode.id, { onDelete: "restrict" }),
    clave: text("clave")
      .notNull()
      .references(() => parametroRegistro.clave, { onDelete: "restrict" }),
    /** NULL solo en el barrio: "vuelve a heredar de la administración". */
    valor: jsonb("valor"),
    vigenteDesde: date("vigente_desde", { mode: "string" }).notNull(),
    motivo: text("motivo").notNull(),
    /** `usuario` | `inicial` (siembra de una administración nueva) | `migrado` (`0057`). */
    carga: text("carga").notNull().default("usuario"),
    respaldoTipo: text("respaldo_tipo"),
    respaldoReferencia: text("respaldo_referencia"),
    /** Storage key del adjunto del respaldo: cuelga del propio nodo (`check` en `0056`). */
    respaldoAdjunto: text("respaldo_adjunto"),
    creadoPor: uuid("creado_por"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    uniqueIndex("uq_parametro_valor_orden").on(t.orden),
    index("idx_parametro_valor_resolver").on(t.nodoId, t.clave, t.vigenteDesde.desc(), t.orden.desc()),
    check("parametro_valor_desde_chk", sql`${t.vigenteDesde} between '2000-01-01' and '2200-12-31'`),
    check("parametro_valor_motivo_chk", sql`length(btrim(${t.motivo})) between 1 and 500`),
    check("parametro_valor_carga_chk", sql`${t.carga} in ('usuario', 'inicial', 'migrado')`),
    check("parametro_valor_firma_chk", sql`(${t.carga} = 'usuario') = (${t.creadoPor} is not null)`),
    check(
      "parametro_valor_respaldo_tipo_chk",
      sql`${t.respaldoTipo} is null or ${t.respaldoTipo} in ('reglamento', 'acta_asamblea', 'acta_comision', 'otro')`,
    ),
    check("parametro_valor_respaldo_par_chk", sql`(${t.respaldoTipo} is null) = (${t.respaldoReferencia} is null)`),
    check("parametro_valor_respaldo_adjunto_chk", sql`${t.respaldoAdjunto} is null or ${t.respaldoTipo} is not null`),
    check(
      "parametro_valor_respaldo_referencia_chk",
      sql`${t.respaldoReferencia} is null or length(btrim(${t.respaldoReferencia})) between 3 and 300`,
    ),
    check(
      "parametro_valor_respaldo_storage_key_chk",
      sql`${t.respaldoAdjunto} is null or ${t.respaldoAdjunto} ~
          ('^(barrios|administraciones)/' || ${t.nodoId}::text || '/parametros/respaldos/[A-Za-z0-9_-]{22,64}\\.(pdf|jpg|jpeg|png)$')`,
    ),
  ],
);

/** Anulación de un cambio PROGRAMADO (todavía no rige). Append-only, con motivo. */
export const parametroAnulacion = pgTable(
  "parametro_anulacion",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    filaId: uuid("fila_id")
      .notNull()
      .references(() => parametroValor.id, { onDelete: "restrict" }),
    nodoId: uuid("nodo_id")
      .notNull()
      .references(() => tenantNode.id, { onDelete: "restrict" }),
    motivo: text("motivo").notNull(),
    anuladoPor: uuid("anulado_por").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    uniqueIndex("uq_parametro_anulacion_fila").on(t.filaId),
    index("idx_parametro_anulacion_nodo").on(t.nodoId),
    check("parametro_anulacion_motivo_chk", sql`length(btrim(${t.motivo})) between 1 and 500`),
  ],
);

/** El pedido de subida de un adjunto de respaldo: mismo patrón que `subida_comprobante_solicitada`. */
export const subidaRespaldoSolicitada = pgTable(
  "subida_respaldo_solicitada",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    nodoId: uuid("nodo_id")
      .notNull()
      .references(() => tenantNode.id, { onDelete: "restrict" }),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    /** La escribe la base desde `app.current_user_id()`. */
    solicitadoPor: uuid("solicitado_por").notNull(),
    solicitadoAt: timestamp("solicitado_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_subida_respaldo_storage_key").on(t.storageKey),
    index("idx_subida_respaldo_nodo").on(t.nodoId),
    check("subida_respaldo_content_type_chk", sql`${t.contentType} in ('application/pdf','image/jpeg','image/png')`),
    check(
      "subida_respaldo_storage_key_chk",
      sql`${t.storageKey} ~
          ('^(barrios|administraciones)/' || ${t.nodoId}::text || '/parametros/respaldos/[A-Za-z0-9_-]{22,64}\\.(pdf|jpg|jpeg|png)$')`,
    ),
  ],
);

export type ParametroValorRow = typeof parametroValor.$inferSelect;
export type ParametroAnulacionRow = typeof parametroAnulacion.$inferSelect;
