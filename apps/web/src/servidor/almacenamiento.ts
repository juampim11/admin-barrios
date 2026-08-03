import "server-only";

/**
 * **El único camino de `apps/web` al almacenamiento de objetos.**
 *
 * Mismo patrón que `db.ts`: un solo archivo conoce el adapter concreto, y el test de arquitectura
 * (regla 12) falla si `@admin-barrios/almacenamiento/s3` se nombra desde cualquier otro lado. La
 * regla dura de `CLAUDE.md` §1 no es "no usar S3": es que ningún servicio de negocio lo llame
 * directo.
 *
 * **La credencial de la web es de solo lectura y aun así alcanza al bucket entero.** Eso hay que
 * tenerlo presente cada vez que se toque este archivo: presignar una URL **no consulta a nadie**, se
 * calcula localmente con la clave. Lo único que separa "la boleta de esta unidad" de "todas las
 * boletas de todos los barrios" es que la `storage_key` haya salido de una fila leída bajo RLS —
 * `prepararDescarga()` en `@admin-barrios/data/servicios/documentos`. Una ruta que acepte una clave
 * por parámetro convierte esta credencial en una llave maestra.
 */

import { crearAlmacenamientoS3 } from "@admin-barrios/almacenamiento/s3";
import type { ObjectStorage } from "@admin-barrios/almacenamiento";
import { leerConfiguracion } from "./configuracion.ts";

let instancia: ObjectStorage | null = null;

/**
 * Devuelve el almacenamiento, o **lanza con un mensaje propio** si el proceso no lo tiene
 * configurado. El mensaje importa: sin esto, una instancia sin `S3_*` falla con un error del SDK de
 * AWS en el medio de una descarga, y el motivo queda a tres capas del síntoma.
 */
export function almacenamiento(): ObjectStorage {
  if (instancia) return instancia;
  const config = leerConfiguracion();
  if (!config.s3) {
    throw new Error(
      "esta instancia de la web no tiene configurado el almacenamiento de documentos: faltan las " +
        "variables S3_* (ver apps/web/.env.local.example). La descarga no puede funcionar sin ellas.",
    );
  }
  instancia = crearAlmacenamientoS3({
    endpoint: config.s3.endpoint,
    endpointPublico: config.s3.endpointPublico,
    region: config.s3.region,
    bucket: config.s3.bucket,
    forzarRutaDeBucket: config.s3.rutaDeBucket,
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  });
  return instancia;
}
