/**
 * Constantes de PROVEEDORES / ÓRDENES DE PAGO — compartidas entre `packages/data` (checks, RLS) y
 * `apps/web` (formularios). El catálogo de content-types/tamaño máximo de comprobante se reusa tal
 * cual de `@admin-barrios/shared/cobros` (`CONTENT_TYPES_COMPROBANTE`,
 * `TAMANO_MAXIMO_COMPROBANTE_BYTES`) — no se redefine acá.
 */

import { z } from "zod";

/**
 * El circuito completo. `text` + `CHECK` en la base, no enum nativo — mismo motivo que
 * `pago.origen`/`trabajo.tipo`: el migrador de este repo aplica todas las migraciones pendientes en
 * una sola transacción, y `ALTER TYPE … ADD VALUE` no sirve el día que el catálogo crezca.
 */
export const ESTADOS_ORDEN_PAGO = [
  "pendiente",
  "aprobada",
  "rechazada",
  "pagada",
  "anulada",
  "conciliada",
] as const;
export type EstadoOrdenPago = (typeof ESTADOS_ORDEN_PAGO)[number];
export const estadoOrdenPagoSchema = z.enum(ESTADOS_ORDEN_PAGO);

/**
 * Cómo se ejecutó ESTE pago puntual — no confundir con `proveedor.cbu`/`alias`, que son datos de
 * contacto del proveedor y no cambian pago a pago.
 */
export const MEDIOS_PAGO_OP = ["transferencia", "cheque", "efectivo", "otro"] as const;
export type MedioPagoOP = (typeof MEDIOS_PAGO_OP)[number];
export const medioPagoOPSchema = z.enum(MEDIOS_PAGO_OP);
