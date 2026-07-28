/**
 * Qué credencial recibe cada proceso — **fuente de verdad única**.
 *
 * El aislamiento multi-tenant lo hace cumplir la base (RLS con `app.current_user_id()`), y solo vale
 * si el proceso que atiende usuarios se conecta con el rol `app_request`, que **no** tiene
 * `BYPASSRLS`. Si la web recibiera la URL del dueño del esquema o la del rol de jobs, las policies
 * directamente no se evalúan: el código se leería aislado y no aislaría nada
 * (ADR-0002 §3.2, cerrojo 5).
 *
 * Los cuatro cerrojos anteriores (tipos, grafo de imports, `server-only`, la propia RLS) dificultan
 * **escribir** el código que abre la conexión equivocada. Ninguno impide que la credencial **esté**
 * en el entorno del proceso. Este módulo es ese cerrojo, y es el único que sigue valiendo frente a
 * algo que no escribimos nosotros (una dependencia comprometida, un `postinstall`, un SSRF que lea
 * `/proc/self/environ`).
 *
 * Se usa desde dos lugares, y por eso vive acá y no adentro de una app:
 *  - `tools/infra/verificar-credenciales.ts` — guard de arranque del contenedor (runtime).
 *  - `tools/infra/credenciales.test.ts` — verifica el `docker-compose.yml` en el gate de CI (estático).
 *
 * Módulo sin dependencias a propósito: lo importa un test y lo ejecuta un contenedor.
 */

/** Cada proceso que corre código nuestro tiene un rol, y el rol determina su credencial. */
export type RolDeProceso = "web" | "worker";

export type ReglaDeRol = {
  readonly descripcion: string;
  /** Sin estas no puede trabajar. Se exigen solo con `--exigir-requeridas` (ver el guard). */
  readonly requeridas: readonly string[];
  /**
   * **Lista de permitidos, no de prohibidos.** Toda variable gobernada (§`esGobernada`) que no esté
   * acá es una violación. Una credencial nueva que alguien agregue mañana falla sola.
   */
  readonly permitidas: readonly string[];
};

/**
 * Prefijos de las variables **de este proyecto**. Lo que empieza así está gobernado por la lista de
 * permitidos del rol; lo demás (`PATH`, `HOME`, `NODE_VERSION`…) se ignora.
 *
 * Si mañana aparece una integración nueva (pagos, email, OCR), su variable tiene que empezar con uno
 * de estos prefijos o sumarse acá — si no, el candado no la ve.
 */
export const PREFIJOS_GOBERNADOS = [
  "DATABASE_URL",
  "POSTGRES_",
  "APP_",
  "JOB_DB_",
  "MINIO_",
  "S3_",
  "AUTH_",
  "WEB_",
  "CRON_",
  "NEXT_PUBLIC_",
] as const;

/**
 * Las que rompen el aislamiento si llegan al proceso equivocado. Es un subconjunto de "todo lo no
 * permitido": existe aparte para dar un mensaje de error que diga **por qué** importa, y para el
 * barrido textual del `docker-compose.yml` (que no depende de cómo esté estructurado el YAML).
 */
export const CREDENCIALES_CRITICAS: readonly { readonly nombre: string; readonly porque: string }[] = [
  { nombre: "DATABASE_URL", porque: "es el dueño del esquema: puede hacer DDL y escribir cualquier tabla" },
  { nombre: "DATABASE_URL_JOB", porque: "el rol app_job tiene BYPASSRLS: las policies no se evalúan" },
  { nombre: "POSTGRES_USER", porque: "es el superusuario de la instancia local" },
  { nombre: "POSTGRES_PASSWORD", porque: "es la contraseña del superusuario de la instancia local" },
  { nombre: "JOB_DB_PASSWORD", porque: "permite armar a mano la conexión con BYPASSRLS" },
  { nombre: "MINIO_ROOT_USER", porque: "es el administrador del storage: puede borrar buckets enteros" },
  { nombre: "MINIO_ROOT_PASSWORD", porque: "es la clave del administrador del storage" },
];

export const REGLAS: Readonly<Record<RolDeProceso, ReglaDeRol>> = {
  web: {
    descripcion:
      "apps/web (Next.js). Atiende personas: se conecta SOLO con app_request, que está sujeto a RLS.",
    requeridas: ["DATABASE_URL_APP", "APP_ENTORNO"],
    permitidas: [
      "DATABASE_URL_APP",
      "APP_ENTORNO",
      "APP_TIMEZONE",
      "AUTH_PROVIDER",
      "WEB_PORT",
      // Storage: la web firma URLs de descarga (ADR-0002 §6.5). Credencial de solo lectura, distinta
      // de la del worker (que escribe) y del root de MinIO (que administra).
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_FORCE_PATH_STYLE",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ],
  },
  worker: {
    descripcion:
      "apps/worker. Único proceso que legítimamente tiene BYPASSRLS, y solo para tomar el trabajo de " +
      "la cola: el trabajo real corre con conUsuario() sobre la conexión de request (ADR-0002 §6.4).",
    requeridas: ["DATABASE_URL_JOB", "DATABASE_URL_APP", "APP_ENTORNO"],
    permitidas: [
      "DATABASE_URL_JOB",
      "DATABASE_URL_APP",
      "APP_ENTORNO",
      "APP_TIMEZONE",
      "CRON_SECRET",
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_FORCE_PATH_STYLE",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ],
  },
};

/**
 * Servicios de `docker-compose.yml` que corren código nuestro, y con qué rol.
 *
 * El test exige que **todo** servicio con `build:` esté acá: agregar un contenedor nuevo con nuestro
 * código obliga a declarar qué credencial le toca, en vez de heredarla por olvido.
 */
export const SERVICIOS_GOBERNADOS: Readonly<Record<string, RolDeProceso>> = {
  app: "web",
  web: "web",
  worker: "worker",
};

/** ¿Esta variable la gobierna la lista de permitidos, o es plomería del sistema operativo? */
export function esGobernada(nombre: string): boolean {
  return PREFIJOS_GOBERNADOS.some((prefijo) => nombre.startsWith(prefijo));
}

export type Violacion = {
  readonly variable: string;
  readonly motivo: string;
};

/**
 * Verifica un conjunto de variables contra la regla del rol.
 *
 * `exigirRequeridas` se separa a propósito: en el contenedor sí se exigen (compose las garantiza),
 * pero en `pnpm dev` sobre el host la web todavía no tiene pantallas con base y exigirlas dejaría al
 * proyecto sin arrancar. Lo que se verifica **siempre** es lo que no le toca tener.
 */
export function verificar(
  rol: RolDeProceso,
  entorno: Readonly<Record<string, string | undefined>>,
  opciones: { readonly exigirRequeridas?: boolean } = {},
): Violacion[] {
  const regla = REGLAS[rol];
  const violaciones: Violacion[] = [];
  const criticas = new Map(CREDENCIALES_CRITICAS.map((c) => [c.nombre, c.porque]));

  for (const [nombre, valor] of Object.entries(entorno)) {
    // Una variable declarada en vacío no aporta credencial: no se trata como violación, así el
    // patrón "declarada pero apagada" de algunos orquestadores no rompe el arranque.
    if (valor === undefined || valor === "") continue;
    if (!esGobernada(nombre)) continue;
    if (regla.permitidas.includes(nombre)) continue;

    const porque = criticas.get(nombre);
    violaciones.push({
      variable: nombre,
      motivo: porque
        ? `el proceso "${rol}" no debe recibirla: ${porque}`
        : `no está en la lista de permitidos del proceso "${rol}"`,
    });
  }

  if (opciones.exigirRequeridas) {
    for (const nombre of regla.requeridas) {
      const valor = entorno[nombre];
      if (valor === undefined || valor === "") {
        violaciones.push({ variable: nombre, motivo: `falta, y el proceso "${rol}" la necesita` });
      }
    }
  }

  return violaciones.sort((a, b) => a.variable.localeCompare(b.variable));
}
