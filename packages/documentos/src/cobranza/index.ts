export * from "./medio-cobranza.ts";
export * from "./cbu.ts";
export * from "./adapters/generico-demo.ts";

import { crearRegistroMediosCobranza, type RegistroMediosCobranza } from "./medio-cobranza.ts";
import { crearMedioGenericoDemo } from "./adapters/generico-demo.ts";

/**
 * Registro con los adapters que existen hoy. **Uno solo, y la interfaz que permite el otro**
 * (ADR-0001 §3.3): este ADR no manda implementar dos.
 */
export function registroPorDefecto(): RegistroMediosCobranza {
  return crearRegistroMediosCobranza([crearMedioGenericoDemo()]);
}
