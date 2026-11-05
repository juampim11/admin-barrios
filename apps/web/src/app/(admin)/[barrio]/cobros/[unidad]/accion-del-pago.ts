/**
 * Qué se ofrece en la columna «Acciones» de un pago del estado de cuenta (encargo 11, `0070`).
 *
 * Es una función aparte, y no una condición dentro del JSX, para poder probar lo que el titular no
 * encontró en el ensayo de T2: que un **operador**, frente a un pago con interés condonado, ve «Lo anula
 * un administrador porque tiene interés condonado» en lugar del botón «Anular» (`accion-del-pago.test.ts`
 * y, con la base, `packages/data/test/circuito-deuda.test.ts`).
 */

export const LO_ANULA_UN_ADMINISTRADOR = "Lo anula un administrador porque tiene interés condonado";

export type AccionDelPago = "anular" | "lo_anula_un_administrador" | null;

export function accionDelPago(
  pago: { readonly interesCondonado: string; readonly anulado: boolean },
  permisos: {
    /** Registrar y anular pagos (operador, administración). */
    readonly puedeAnular: boolean;
    /** Condonar interés, y por eso anular un pago con interés condonado: la administración. */
    readonly puedeAnularConCondonacion: boolean;
  },
): AccionDelPago {
  if (pago.anulado || !permisos.puedeAnular) return null;
  if (pago.interesCondonado !== "0.00" && !permisos.puedeAnularConCondonacion) return "lo_anula_un_administrador";
  return "anular";
}
