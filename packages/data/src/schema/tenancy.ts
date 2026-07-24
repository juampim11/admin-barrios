/**
 * Esquema de TENANCÍA (jerarquía de acceso). Ver `docs/diseno/03-modelo-datos.md` §A.
 *
 * Acá vive el aislamiento: `tenant_node` (administrador → barrio → subsector) + `membership`.
 * La estructura de DOMINIO de un barrio (unidades, expensas, pagos) NO son nodos de tenancía:
 * son datos con `barrio_id`, y llegan en `0002_dominio.sql`.
 *
 * Lo que Drizzle NO modela (funciones `app.*`, triggers, RLS/policies, roles de BD) vive en la
 * migración SQL `0001_tenancy_rls.sql`, escrita a mano y versionada.
 */

import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { bigint, boolean, check, index, pgSchema, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ROLES_MEMBERSHIP, TIPOS_TENANT } from "@admin-barrios/shared/tenancy";

/** Schema `app`: funciones y enums de plataforma, separados de las tablas de negocio (`public`). */
export const app = pgSchema("app");

export const tipoTenant = app.enum("tipo_tenant", [...TIPOS_TENANT] as [string, ...string[]]);
export const rolMembership = app.enum("rol_membership", [...ROLES_MEMBERSHIP] as [string, ...string[]]);

/**
 * Nodo de la jerarquía de tenancía. `id` (uuid) es la clave pública: estable ante re-parentado, y a
 * la que apuntan todas las FKs de dominio (`barrio_id`). `path` es el materialized path por `nid`,
 * mantenido por trigger (nunca por la app) — ver doc 03 §A.2.
 */
export const tenantNode = pgTable(
  "tenant_node",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Segmento del path: compacto e inmutable (renombrar el barrio no toca el path). */
    nid: bigint("nid", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => tenantNode.id, { onDelete: "restrict" }),
    tipo: tipoTenant("tipo").notNull(),
    nombre: text("nombre").notNull(),
    /** '1', '1.7', '1.7.30'. Lo escribe el trigger `app.tenant_node_set_path()`. */
    path: text("path").notNull(),
    /** Soft-delete: un tenant con datos financieros nunca se borra físicamente. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_tenant_node_nid").on(t.nid),
    uniqueIndex("uq_tenant_node_path").on(t.path),
    // `text_pattern_ops`: sin esto, `path LIKE 'x.%'` no usa índice si la collation no es C
    // (caso RDS/Supabase). Es la consulta de subárbol — ver doc 03 §D.
    index("idx_tenant_node_path_prefix").on(t.path.op("text_pattern_ops")),
    index("idx_tenant_node_parent").on(t.parentId),
    // Solo el administrador es raíz; todo lo demás cuelga de alguien.
    check(
      "tenant_node_root_chk",
      sql`(${t.tipo} = 'administrador' and ${t.parentId} is null) or (${t.tipo} <> 'administrador' and ${t.parentId} is not null)`,
    ),
  ],
);

/**
 * Membresía: acceso de un usuario a un nodo **y a todo su subárbol**. Los permisos son POR MEMBRESÍA
 * (no globales): el mismo usuario puede ser `admin_barrio` en un barrio y `propietario` en otro.
 *
 * `user_id` es el id del usuario de la capa de Auth (agnóstico, sin FK a `auth.users`) — ADR §3.2.
 */
export const membership = pgTable(
  "membership",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id").notNull(),
    tenantNodeId: uuid("tenant_node_id")
      .notNull()
      .references(() => tenantNode.id, { onDelete: "cascade" }),
    rol: rolMembership("rol").notNull(),
    activo: boolean("activo").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_membership_user_node_rol").on(t.userId, t.tenantNodeId, t.rol),
    index("idx_membership_user_activo").on(t.userId).where(sql`activo`),
    index("idx_membership_node").on(t.tenantNodeId),
  ],
);

/**
 * Excepción de aislamiento **explícita y auditada** entre tenants (doc 03 §A.8): un barrio puede
 * tener relaciones jurídicas con otro (servidumbres entre conjuntos, art. 2084). Nunca un cruce
 * silencioso: queda registrado quién lo otorgó, sobre qué alcance y desde/hasta cuándo.
 */
export const tenantGrant = pgTable(
  "tenant_grant",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    origenId: uuid("origen_id")
      .notNull()
      .references(() => tenantNode.id, { onDelete: "restrict" }),
    destinoId: uuid("destino_id")
      .notNull()
      .references(() => tenantNode.id, { onDelete: "restrict" }),
    /** Qué puede ver el destino sobre el origen (ej. 'servidumbre:lectura_expensas'). */
    alcance: text("alcance").notNull(),
    motivo: text("motivo").notNull(),
    otorgadoPor: uuid("otorgado_por").notNull(),
    vigenteDesde: timestamp("vigente_desde", { withTimezone: true }).notNull().defaultNow(),
    vigenteHasta: timestamp("vigente_hasta", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_tenant_grant_origen").on(t.origenId),
    index("idx_tenant_grant_destino").on(t.destinoId),
    check("tenant_grant_distinto_chk", sql`${t.origenId} <> ${t.destinoId}`),
  ],
);

export type TenantNodeRow = typeof tenantNode.$inferSelect;
export type MembershipRow = typeof membership.$inferSelect;
export type TenantGrantRow = typeof tenantGrant.$inferSelect;
