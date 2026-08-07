/**
 * **La única puerta al entorno de `apps/worker`.** Mismo patrón que `apps/web/src/servidor/
 * configuracion.ts` (ADR-0002 §5.2, violación 8), y acá pesa más: éste es el proceso que
 * legítimamente tiene la conexión con **BYPASSRLS** y la cuenta de almacenamiento con permiso de
 * escritura. Es el que más tiene para perder si una credencial de más entra a su entorno.
 *
 * La credencial prohibida es una sola, y no es la misma que en la web: `DATABASE_URL`, el dueño del
 * esquema. El worker **sí** recibe `DATABASE_URL_JOB` —es su razón de existir— pero no tiene ningún
 * motivo para poder hacer DDL ni para escribir `usuario_demo`.
 */

import { z } from "zod";
import { entornoSchema } from "@admin-barrios/auth";

const configuracionSchema = z.object({
  entorno: entornoSchema,
  /** BYPASSRLS. **Solo** para tomar y avanzar un trabajo de la cola. */
  urlBaseJob: z.string().min(1, "falta DATABASE_URL_JOB: es con lo que el worker toma la cola"),
  /** Sujeta a RLS. Es con la que corre TODO el trabajo real, con la identidad de quien lo pidió. */
  urlBaseApp: z.string().min(1, "falta DATABASE_URL_APP: es con lo que el worker hace el trabajo real"),
  s3Endpoint: z.string().min(1, "falta S3_ENDPOINT"),
  s3Region: z.string().min(1, "falta S3_REGION"),
  s3Bucket: z.string().min(1, "falta S3_BUCKET"),
  s3RutaDeBucket: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  s3AccessKeyId: z.string().min(1, "falta S3_ACCESS_KEY_ID"),
  s3SecretAccessKey: z.string().min(1, "falta S3_SECRET_ACCESS_KEY"),
  /**
   * Cuántos documentos por pasada del navegador. **50 es el número medido** (ADR-0001 §3.2): con
   * chunk de 50 el techo de memoria queda en ~520 MB, que es el presupuesto de 1 GB del contenedor
   * con margen. Subirlo es subir la memoria, no la velocidad.
   */
  chunk: z.coerce.number().int().positive().max(200).default(50),
  timeoutMs: z.coerce.number().int().positive().default(120_000),
  /**
   * Cada cuánto barre la cola buscando rezagados. El disparo normal es `pg_notify`; esto es la red
   * de seguridad para lo que se perdió por una reconexión, y en un día típico devuelve **cero
   * filas** — es el "guard de early-exit barato" del presupuesto de recursos §5.
   */
  intervaloBarridoMs: z.coerce.number().int().positive().default(60_000),
});

export type Configuracion = z.infer<typeof configuracionSchema>;

export function leerConfiguracion(entorno: NodeJS.ProcessEnv = process.env): Configuracion {
  const duenio = entorno["DATABASE_URL"];
  if (duenio !== undefined && duenio !== "") {
    throw new Error(
      "apps/worker recibió DATABASE_URL (el dueño del esquema) y se niega a arrancar.\n" +
        "El worker recibe DOS conexiones y ninguna es esa: DATABASE_URL_JOB para tomar la cola y " +
        "DATABASE_URL_APP para hacer el trabajo bajo RLS. Con el dueño del esquema en el entorno, " +
        "este proceso podría hacer DDL y escribir `usuario_demo`, que es el candado del sustituto " +
        "de identidad (ADR-0002 §2.4 vuelta 3).\n" +
        "Sacala del entorno del proceso (docker-compose.yml, apps/worker/.env.local).",
    );
  }

  const resultado = configuracionSchema.safeParse({
    entorno: entorno["APP_ENTORNO"],
    urlBaseJob: entorno["DATABASE_URL_JOB"],
    urlBaseApp: entorno["DATABASE_URL_APP"],
    s3Endpoint: entorno["S3_ENDPOINT"],
    s3Region: entorno["S3_REGION"],
    s3Bucket: entorno["S3_BUCKET"],
    s3RutaDeBucket: entorno["S3_FORCE_PATH_STYLE"],
    s3AccessKeyId: entorno["S3_ACCESS_KEY_ID"],
    s3SecretAccessKey: entorno["S3_SECRET_ACCESS_KEY"],
    chunk: entorno["APP_WORKER_CHUNK"],
    timeoutMs: entorno["APP_WORKER_TIMEOUT_MS"],
    intervaloBarridoMs: entorno["APP_WORKER_INTERVALO_MS"],
  });

  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((i) => `  · ${i.path.join(".") || "(raíz)"}: ${i.message}`)
      .join("\n");
    throw new Error(`la configuración de apps/worker es inválida y el proceso no arranca:\n${detalle}`);
  }

  return resultado.data;
}
