import "server-only";

/**
 * **La única puerta al entorno de `apps/web`** (ADR-0002 §5.2, violación 8).
 *
 * Ningún otro archivo del app lee `process.env`. No es orden: es lo que hace posible el candado de
 * §2.4 vuelta 1 — un solo lugar donde `APP_ENTORNO` se valida, con Zod, al arrancar, y del que
 * salen ya tipados los valores que el resto del proceso consume.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL CERROJO 5: LA CREDENCIAL QUE NO TIENE QUE ESTAR
 *
 * Los otros cuatro cerrojos del §3.2 —los tipos, el grafo de imports, `server-only` y la propia
 * RLS— dificultan **escribir** el código que abre la conexión equivocada. Ninguno impide que la
 * credencial **esté** en el entorno del proceso. Este archivo es ese cerrojo, y es el único que
 * sigue valiendo frente a algo que no escribimos nosotros: una dependencia comprometida, un
 * `postinstall` malicioso, un SSRF que alcance `/proc/self/environ`. Contra eso, los cerrojos 1–3
 * son estáticos y de tiempo de build (no valen nada en runtime) y el 4 tampoco sirve, porque
 * `app_job` saltea la RLS por definición.
 *
 * Por eso `DATABASE_URL` (dueño del esquema) y `DATABASE_URL_JOB` (BYPASSRLS) no son campos
 * opcionales de este esquema: **si aparecen, el proceso lanza**. Y no es solo por el aislamiento
 * entre barrios: con la credencial del dueño del esquema en el entorno de la web, "`usuario_demo` la
 * escribe solo el seed" —la vuelta 3 del candado, la única que aguanta sola— deja de ser cierta.
 *
 * La contraparte está en `tools/infra/credenciales.ts`, que verifica lo mismo sobre el
 * `docker-compose.yml` en el gate de CI, y en `tools/infra/verificar-credenciales.ts`, que lo
 * verifica al arrancar el contenedor. Este archivo es la tercera línea, adentro del proceso.
 */

import { z } from "zod";
import { entornoSchema, type Entorno } from "@admin-barrios/auth";

/**
 * Las que rompen el aislamiento si llegan a este proceso. La lista corta y el porqué de cada una;
 * la larga (lista de permitidos completa, por rol de proceso) vive en `tools/infra/credenciales.ts`.
 */
const CREDENCIALES_PROHIBIDAS: readonly { readonly nombre: string; readonly porque: string }[] = [
  {
    nombre: "DATABASE_URL",
    porque:
      "es el dueño del esquema: puede hacer DDL, escribir cualquier tabla y —lo peor— llenar " +
      "`usuario_demo`, que es el candado del sustituto de identidad (ADR-0002 §2.4 vuelta 3)",
  },
  {
    nombre: "DATABASE_URL_JOB",
    porque: "el rol `app_job` tiene BYPASSRLS: las policies directamente no se evalúan",
  },
];

const configuracionSchema = z.object({
  entorno: entornoSchema,
  /** La ÚNICA conexión que recibe la web: `app_request`, sujeto a RLS, usado solo vía `conUsuario`. */
  urlBaseApp: z.string().min(1, "falta DATABASE_URL_APP: es la única conexión que la web puede tener"),
  proveedorAuth: z.string().min(1, "falta AUTH_PROVIDER (ver apps/web/.env.local.example)"),
  /**
   * Techo del pool. Arranca en 10 por proceso: Postgres 16 admite 100 conexiones por defecto y dos
   * instancias × 10 = 20 sobran. En serverless esto **no sirve** y hace falta un pooler externo con
   * `max: 1` (ADR-0002 §3.3); es configuración, no código, pero hay que acordarse.
   */
  maxConexiones: z.coerce.number().int().positive().max(50).default(10),
  /**
   * El almacenamiento de documentos. La web recibe la cuenta de **solo lectura**: firma URLs de
   * descarga y nada más. Escribir es del worker, con otra credencial (`docker-compose.yml`).
   *
   * Son opcionales en el esquema y **el motivo no es comodidad**: hasta que exista la pantalla de
   * documentos, una instancia de la web sin storage configurado tiene que poder arrancar. Lo que no
   * puede pasar es que arranque a medias — por eso la ruta de descarga lanza con un mensaje propio
   * si le faltan, en vez de fallar con un error del SDK tres capas más abajo.
   */
  s3: z
    .object({
      endpoint: z.string().min(1),
      /**
       * La dirección que va a seguir **el navegador** cuando reciba el `302`. Con la aplicación en un
       * contenedor no es la misma que `endpoint` (`minio:9000` no existe fuera de la red de
       * contenedores), y firmar con la equivocada deja el botón de descargar apuntando a la nada.
       */
      endpointPublico: z.string().min(1).optional(),
      region: z.string().min(1),
      bucket: z.string().min(1),
      rutaDeBucket: z.boolean(),
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
    })
    .nullable(),
});

export type Configuracion = z.infer<typeof configuracionSchema>;

/**
 * Lee y valida el entorno. **Lanza** si algo falta o si aparece una credencial que no le toca.
 *
 * Se exporta como función y no como constante evaluada al importar para que
 * `instrumentation.ts` la pueda disparar explícitamente al levantar el servidor: Next carga los
 * módulos de ruta perezosamente, así que un `throw` de módulo aparecería recién en el primer request
 * que toque esa ruta —como un 500, con el contenedor "sano" para el orquestador— en vez de al
 * arrancar.
 */
export function leerConfiguracion(entorno: NodeJS.ProcessEnv = process.env): Configuracion {
  const presentes = CREDENCIALES_PROHIBIDAS.filter((c) => {
    const valor = entorno[c.nombre];
    // Declarada en vacío no aporta credencial: es el patrón "declarada pero apagada" de algunos
    // orquestadores, y tratarlo como violación rompería despliegues legítimos.
    return valor !== undefined && valor !== "";
  });

  if (presentes.length > 0) {
    throw new Error(
      "apps/web recibió credenciales que no le corresponden y se niega a arrancar:\n" +
        presentes.map((c) => `  · ${c.nombre} — ${c.porque}`).join("\n") +
        "\nLa web recibe UNA sola URL de base: DATABASE_URL_APP. Sacar las otras del entorno del " +
        "proceso (docker-compose.yml, apps/web/.env.local, manifiestos de despliegue). " +
        "Ver ADR-0002 §3.2 cerrojo 5 y tools/infra/credenciales.ts.",
    );
  }

  // Las seis o ninguna: media configuración de storage es peor que ninguna, porque falla recién
  // cuando alguien aprieta "descargar" y con un error del SDK.
  const s3Crudo = {
    endpoint: entorno["S3_ENDPOINT"],
    endpointPublico: entorno["S3_ENDPOINT_PUBLICO"],
    region: entorno["S3_REGION"],
    bucket: entorno["S3_BUCKET"],
    rutaDeBucket: entorno["S3_FORCE_PATH_STYLE"] === "true",
    accessKeyId: entorno["S3_ACCESS_KEY_ID"],
    secretAccessKey: entorno["S3_SECRET_ACCESS_KEY"],
  };
  // `endpointPublico` no cuenta para decidir si "hay configuración de storage": es opcional, y en un
  // entorno real ni se declara.
  const hayAlgoDeS3 = Object.entries(s3Crudo).some(
    ([k, v]) => k !== "rutaDeBucket" && k !== "endpointPublico" && v,
  );

  const resultado = configuracionSchema.safeParse({
    entorno: entorno["APP_ENTORNO"],
    urlBaseApp: entorno["DATABASE_URL_APP"],
    proveedorAuth: entorno["AUTH_PROVIDER"],
    maxConexiones: entorno["APP_DB_MAX_CONEXIONES"],
    s3: hayAlgoDeS3 ? s3Crudo : null,
  });

  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((i) => `  · ${i.path.join(".") || "(raíz)"}: ${i.message}`)
      .join("\n");
    throw new Error(`la configuración de apps/web es inválida y el proceso no atiende:\n${detalle}`);
  }

  return resultado.data;
}

/** ¿Este proceso está en la máquina de alguien? Lo usa la aserción de arranque del elenco de demo. */
export function esEntornoLocal(entorno: Entorno): boolean {
  return entorno === "local";
}
