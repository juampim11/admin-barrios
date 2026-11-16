/**
 * El presupuesto del mes y el resultado del mes (encargo 16c). Dominio puro: lo que toca Postgres está
 * en `packages/data/src/servicios/presupuesto.ts`.
 *
 * **El presupuesto no calcula el cupón.** Propone un importe y se compara contra lo gastado. El importe
 * del mes se sigue grabando por la cuota del barrio (`definirCuotaFija`), con su confirmación.
 */
import { z } from "zod";
import { idSchema } from "./consultas.ts";
import { aCentavos, deCentavos, montoSchema, type Monto } from "./dinero.ts";

/** Cómo se pide el importe del mes en el panel: por unidad, o el total del mes si el barrio reparte por coeficiente. */
export type ModoDelImporte = "por_unidad" | "total_del_mes";

/**
 * El importe por unidad que alcanza a cubrir `total` entre `unidades`: la división redondeada **hacia
 * arriba** al centavo (con hacia abajo, la suma quedaría corta por centavos). Sin unidades, `null`.
 */
export function importePorUnidadQueCubre(total: Monto, unidades: number): Monto | null {
  if (!Number.isSafeInteger(unidades) || unidades <= 0) return null;
  const centavos = aCentavos(total);
  if (centavos <= 0n) return "0.00";
  const n = BigInt(unidades);
  return deCentavos((centavos + n - 1n) / n);
}

/** Lo que junta el importe: por unidad, `importe × unidades`; por total, el total. En centavos exactos. */
export function loQueJuntaElImporte(modo: ModoDelImporte, importe: Monto, unidades: number): Monto {
  return modo === "por_unidad" ? deCentavos(aCentavos(importe) * BigInt(Math.max(0, unidades))) : importe;
}

/** Si lo que junta el importe alcanza para el total a pedir. */
export function cubreElPresupuesto(modo: ModoDelImporte, importe: Monto, unidades: number, totalAPedir: Monto): boolean {
  return aCentavos(loQueJuntaElImporte(modo, importe, unidades)) >= aCentavos(totalAPedir);
}

/** El avance de lo gastado contra lo presupuestado, en porcentaje entero (redondeado). `null` sin presupuesto. */
export function avanceDelRubro(presupuesto: Monto | null, gastado: Monto): number | null {
  if (presupuesto === null) return null;
  const p = aCentavos(presupuesto);
  if (p <= 0n) return null;
  const g = aCentavos(gastado);
  // Redondeo al entero más cercano, en enteros: (g * 200 + p) / (2p).
  const doble = g * 200n + (g >= 0n ? p : -p);
  return Number(doble / (2n * p));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Escrituras
// ────────────────────────────────────────────────────────────────────────────────────────────────

const montoNoNegativoSchema = montoSchema.refine((m) => !m.startsWith("-"), "El importe no puede ser negativo.");

export const guardarPresupuestoSchema = z
  .object({
    periodoId: idSchema,
    rubros: z
      .array(z.object({ conceptoId: idSchema, monto: montoNoNegativoSchema }))
      .max(200)
      .refine((r) => new Set(r.map((x) => x.conceptoId)).size === r.length, "Un rubro está dos veces."),
    margen: montoNoNegativoSchema,
  })
  .strict();
export type GuardarPresupuesto = z.input<typeof guardarPresupuestoSchema>;

export const copiarPresupuestoSchema = z.object({ periodoId: idSchema }).strict();
export type CopiarPresupuesto = z.input<typeof copiarPresupuestoSchema>;
