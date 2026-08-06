export * from "./medio-cobranza.ts";
export * from "./cbu.ts";
export * from "./inercia.ts";
export * from "./adapters/generico-demo.ts";
export * from "./adapters/transferencia-qr.ts";

import { crearRegistroMediosCobranza, type RegistroMediosCobranza } from "./medio-cobranza.ts";
import { crearMedioGenericoDemo } from "./adapters/generico-demo.ts";
import { crearMedioTransferenciaQr } from "./adapters/transferencia-qr.ts";

/**
 * Los adapters que existen hoy.
 *
 * **Son dos, y el segundo es el que prueba que la abstracción sirve.** Hasta el 2026-08-05 había uno
 * solo —el ADR-0001 §3.3 no mandaba implementar dos— y con uno solo la portabilidad era una promesa
 * sin evidencia. `transferencia-qr` la cobra: se agregó un archivo y se registró acá, y **cambia el
 * pie de la boleta sin tocar la plantilla ni el generador**.
 *
 * Cuál usa cada barrio sale de `barrio.medio_cobranza_clave`, no de este orden ni de un literal en el
 * worker.
 */
export function registroPorDefecto(): RegistroMediosCobranza {
  return crearRegistroMediosCobranza([crearMedioGenericoDemo(), crearMedioTransferenciaQr()]);
}
