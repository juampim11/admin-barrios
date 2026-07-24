/**
 * Tenancía jerárquica — tipos y reglas puras compartidas.
 *
 * Fuente: `docs/diseno/03-modelo-datos.md` §A. Dos jerarquías que NO se mezclan:
 *  - TENANCÍA (`tenant_node`: administrador → barrio → subsector) — gobierna el aislamiento.
 *  - DOMINIO (unidad funcional, expensa, pago…) — datos DENTRO de un barrio, llevan `barrio_id`.
 *
 * El `path` es un materialized path de segmentos numéricos (`nid`), ej. `1`, `1.7`, `1.7.30`.
 * Estos helpers son la versión TS del predicado de subárbol que la base resuelve en SQL
 * (`path = X or path like X || '.%'`) — misma semántica, para poder razonar/testear sin base.
 */

import { z } from "zod";

/** Tipos de nodo de tenancía (espejo del enum `app.tipo_tenant`). */
export const TIPOS_TENANT = ["administrador", "barrio", "subsector"] as const;
export type TipoTenant = (typeof TIPOS_TENANT)[number];
export const tipoTenantSchema = z.enum(TIPOS_TENANT);

/**
 * Roles de membresía (espejo del enum `app.rol_membership`).
 * El permiso es POR MEMBRESÍA sobre un nodo (y su subárbol), nunca global: alguien puede ser
 * `admin_barrio` en un barrio y `propietario` en otro (doc 03 §A.3).
 */
export const ROLES_MEMBERSHIP = [
  "admin_plataforma",
  "admin_barrio",
  "operador",
  "contador",
  "auditor",
  "propietario",
  "residente",
] as const;
export type RolMembership = (typeof ROLES_MEMBERSHIP)[number];
export const rolMembershipSchema = z.enum(ROLES_MEMBERSHIP);

/** Roles con permiso de escritura sobre datos operativos del barrio (expensas, pagos, padrón). */
export const ROLES_ESCRITURA_BARRIO: readonly RolMembership[] = [
  "admin_plataforma",
  "admin_barrio",
  "operador",
];

/** Un path válido: segmentos numéricos separados por punto, sin ceros a la izquierda. */
export const pathTenantSchema = z
  .string()
  .regex(/^[1-9]\d*(\.[1-9]\d*)*$/, "path de tenancía inválido (esperado: '1', '1.7', '1.7.30')");

export const tenantNodeSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  tipo: tipoTenantSchema,
  nombre: z.string().min(1),
  path: pathTenantSchema,
});
export type TenantNode = z.infer<typeof tenantNodeSchema>;

/**
 * ¿`path` está dentro del subárbol de `ancestro` (incluyéndolo)?
 * Compara por segmento para evitar el falso positivo `1.7` vs `1.70` (doc 03 §A.2).
 */
export function esDescendienteOIgual(path: string, ancestro: string): boolean {
  return path === ancestro || path.startsWith(`${ancestro}.`);
}

/** Path del padre, o `null` si es raíz (un administrador). */
export function pathPadre(path: string): string | null {
  const corte = path.lastIndexOf(".");
  return corte === -1 ? null : path.slice(0, corte);
}

/** Profundidad del nodo (1 = raíz/administrador). La jerarquía es de profundidad variable. */
export function profundidad(path: string): number {
  return path.split(".").length;
}
