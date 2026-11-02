/**
 * El catálogo de proveedores del barrio: listarlos, darlos de alta, corregirlos, desactivarlos y
 * reactivarlos. "Se desactiva, nunca se borra" es reversible por diseño — `reactivarProveedor()` es
 * la mitad simétrica de `desactivarProveedor()`, agregada después de una regresión real: la primera
 * pantalla de este catálogo salió sin ella pese a que el prototipo aprobado ya mostraba "Reactivar"
 * (hallazgo del usuario, 2026-08-26).
 *
 * Mismo patrón que `gastos.ts` (leer el docstring de cabecera de ese archivo para el detalle
 * completo): Zod parsea la forma, la base decide el fondo; el `barrioId` no viaja en el parámetro
 * — se deriva bajo RLS de la propia fila cuando corresponde; `enBase()` traduce cualquier fallo de
 * la base a un `ErrorDeNegocio`.
 */

import { sql } from "drizzle-orm";
import {
  registrarProveedorSchema,
  corregirProveedorSchema,
  desactivarProveedorSchema,
  reactivarProveedorSchema,
  type RegistrarProveedor,
  type CorregirProveedor,
  type DesactivarProveedor,
  type ReactivarProveedor,
} from "@admin-barrios/shared/escrituras";
import { consultaBarrioSchema } from "@admin-barrios/shared/consultas";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";

export type Proveedor = {
  readonly id: string;
  readonly razonSocial: string;
  readonly cuit: string | null;
  readonly condicionFiscal: string | null;
  readonly contacto: string | null;
  readonly cbu: string | null;
  readonly alias: string | null;
  readonly activo: boolean;
};

type FilaProveedor = {
  id: string;
  razon_social: string;
  cuit: string | null;
  condicion_fiscal: string | null;
  contacto: string | null;
  cbu: string | null;
  alias: string | null;
  activo: boolean;
};

const filaAProveedor = (f: FilaProveedor): Proveedor => ({
  id: f.id,
  razonSocial: f.razon_social,
  cuit: f.cuit,
  condicionFiscal: f.condicion_fiscal,
  contacto: f.contacto,
  cbu: f.cbu,
  alias: f.alias,
  activo: f.activo,
});

/**
 * El catálogo del barrio, activos primero. Trae también los inactivos —mismo criterio que
 * `listarConceptos()` (`gastos.ts`): una orden de pago vieja puede referenciar un proveedor que
 * después se desactivó, y la pantalla que la muestre tiene que poder nombrarlo.
 */
export async function listarProveedores(
  tx: DbConIdentidad,
  parametros: { barrioId: string },
): Promise<Proveedor[]> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<FilaProveedor>(sql`
      select id, razon_social, cuit, condicion_fiscal, contacto, cbu, alias, activo
        from proveedor
       where barrio_id = ${barrioId}
       order by activo desc, razon_social
    `);
    return rows.map(filaAProveedor);
  });
}

/** Alta de un proveedor. `barrioId` lo manda quien llama, adentro de `RegistrarProveedor` —
 *  a diferencia de `registrarGasto`, un proveedor no cuelga de ningún período del que derivarlo — la
 *  RLS de `insert` igual lo verifica. */
export async function registrarProveedor(
  tx: DbConIdentidad,
  parametros: RegistrarProveedor,
): Promise<Proveedor> {
  const p = registrarProveedorSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<FilaProveedor>(sql`
      insert into proveedor (barrio_id, razon_social, cuit, condicion_fiscal, contacto, cbu, alias)
      values (${p.barrioId}, ${p.razonSocial}, ${p.cuit}, ${p.condicionFiscal}, ${p.contacto}, ${p.cbu}, ${p.alias})
      returning id, razon_social, cuit, condicion_fiscal, contacto, cbu, alias, activo
    `);
    const fila = rows[0];
    if (!fila) {
      rechazar(
        "desconocido",
        "No se pudo registrar el proveedor.",
        "Volvé a intentar. Si sigue pasando, avisá con el código de referencia.",
      );
    }
    return filaAProveedor(fila);
  });
}

export async function corregirProveedor(
  tx: DbConIdentidad,
  parametros: CorregirProveedor,
): Promise<Proveedor> {
  const p = corregirProveedorSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<FilaProveedor>(sql`
      update proveedor
         set razon_social = ${p.razonSocial}, cuit = ${p.cuit}, condicion_fiscal = ${p.condicionFiscal},
             contacto = ${p.contacto}, cbu = ${p.cbu}, alias = ${p.alias}
       where id = ${p.proveedorId}
      returning id, razon_social, cuit, condicion_fiscal, contacto, cbu, alias, activo
    `);
    const fila = rows[0];
    if (!fila) {
      rechazar(
        "desconocido",
        "Ese proveedor no existe, o no tenés permiso para modificarlo.",
        "Recargá la lista de proveedores del barrio.",
      );
    }
    return filaAProveedor(fila);
  });
}

/** Se desactiva, nunca se borra: una orden de pago vieja sigue necesitando poder nombrarlo. */
export async function desactivarProveedor(
  tx: DbConIdentidad,
  parametros: DesactivarProveedor,
): Promise<void> {
  const { proveedorId } = desactivarProveedorSchema.parse(parametros);

  await enBase(async () => {
    const resultado = await tx.execute(sql`
      update proveedor set activo = false where id = ${proveedorId}
    `);
    if ((resultado.rowCount ?? 0) === 0) {
      rechazar(
        "desconocido",
        "Ese proveedor no existe, o no tenés permiso para desactivarlo.",
        "Recargá la lista de proveedores del barrio.",
      );
    }
  });
}

/** La mitad simétrica de `desactivarProveedor()`. Nada que impida volver a activarlo: "se
 *  desactiva, nunca se borra" es reversible por diseño, no un camino de una sola vía. */
export async function reactivarProveedor(
  tx: DbConIdentidad,
  parametros: ReactivarProveedor,
): Promise<void> {
  const { proveedorId } = reactivarProveedorSchema.parse(parametros);

  await enBase(async () => {
    const resultado = await tx.execute(sql`
      update proveedor set activo = true where id = ${proveedorId}
    `);
    if ((resultado.rowCount ?? 0) === 0) {
      rechazar(
        "desconocido",
        "Ese proveedor no existe, o no tenés permiso para reactivarlo.",
        "Recargá la lista de proveedores del barrio.",
      );
    }
  });
}
