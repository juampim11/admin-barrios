/**
 * `verificarArranque()` (`apps/web/src/servidor/db.ts`) contra Postgres real — la deuda 1 de
 * `HANDOFF.md` ("`instrumentation.ts` no lo verifica nadie", ADR-0002 §2.4 vuelta 1).
 *
 * Mismo patrón que `packages/data/test/usuario-demo.test.ts`: conexión de administración (dueño del
 * esquema) para armar/limpiar el fixture, y las conexiones reales de la app para lo que se está
 * probando — nada de dobles de prueba para la base.
 *
 * **Por qué `vi.resetModules()` + import dinámico por caso.** `servidor/db.ts` memoiza sus recursos
 * en un singleton de módulo (`recursosMemo`) para no reabrir el pool en cada request — correcto en
 * producción, un problema acá: sin resetear el registro de módulos de Vitest, el primer `it()` que
 * corre deja el singleton armado y todos los siguientes heredan su configuración, sin importar qué
 * `process.env` se cambie después. Cada caso muta `process.env`, resetea el registro de módulos, y
 * recién ahí importa `db.ts` de nuevo — así cada uno arranca con su propio singleton, igual que un
 * proceso nuevo.
 *
 * **Por qué los casos "no-local" mockean `crearAuthProvider` (`@admin-barrios/auth`).** Hallazgo real,
 * encontrado leyendo `packages/auth/src/registro.ts` antes de escribir el primer caso:
 * `crearAuthProvider()` LANZA para cualquier `APP_ENTORNO` que no sea `"local"`, sin importar qué
 * tenga `AUTH_PROVIDER` — hoy no existe ningún adapter real implementado (ADR-0002 §2.5 punto 1,
 * abierto), así que el único (`dev-suplantacion`) se niega fuera de `local`, y cualquier otro nombre
 * "no tiene adapter implementado". `recursos()` arma el `AuthProvider` ANTES que el pool, así que
 * **hoy, en este código, un entorno no-local nunca llega vivo al cuerpo de `verificarArranque()`** —
 * se corta en la vuelta 1, un paso antes de que el chequeo de `usuario_demo` (vuelta 3) corra.
 *
 * Sin mockear `crearAuthProvider`, "no-local con `usuario_demo` presente: lanza" pasaría igual que
 * hoy, pero **por el motivo equivocado** — re-probaría la vuelta 1 (ya cubierta en
 * `packages/auth/src/registro.test.ts`) y no ejercitaría ni una línea del chequeo de `usuario_demo`
 * que este archivo existe para proteger. El mock no es un atajo cómodo: es lo único que permite
 * llegar a código que hoy es inalcanzable por cualquier otro camino. El caso local (arriba) queda
 * 100% real, sin mocks, porque ahí sí se alcanza con el código de producción tal cual corre.
 *
 * Correr con: pnpm vitest run --project db apps/web/test/db.db.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";

// `DATABASE_URL`/`DATABASE_URL_JOB` entran acá también, y no solo `DATABASE_URL_APP`: el `.env` de
// la raíz los deja seteados para el resto de los tests `db` (`packages/data/test/helpers.ts` los
// necesita), pero `leerConfiguracion()` los rechaza si están presentes — es el cerrojo 5
// (`configuracion.ts`), y sin borrarlos acá `verificarArranque()` lanzaría siempre por ESE motivo,
// antes de llegar a lo que cada caso quiere probar. Encontrado corriendo el primer intento del test:
// el caso 2 (RLS rota) "pasaba" con `DATABASE_URL_JOB` todavía puesto, pero por el error EQUIVOCADO
// — el texto del cerrojo 5 menciona "BYPASSRLS" de pasada al explicar por qué esa variable es
// peligrosa, y el `toThrow(/BYPASSRLS/)` coincidía con eso, no con el chequeo de RLS real.
//
// Las `S3_*` entran por el mismo motivo, encontrado en la segunda corrida: el `.env` de la raíz
// tiene ALGUNAS seteadas (para otros tests) pero no las cuatro obligatorias juntas
// (`endpoint`/`bucket`/`accessKeyId`/`secretAccessKey`) — `hayAlgoDeS3` da `true` con eso y Zod
// rechaza por las que faltan. Este test no es sobre storage: se limpian todas para que `s3` quede
// `null`, el camino válido de "no hay configuración de storage".
const S3_KEYS = [
  "S3_ENDPOINT",
  "S3_ENDPOINT_PUBLICO",
  "S3_REGION",
  "S3_BUCKET",
  "S3_FORCE_PATH_STYLE",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_SUBIDA_COMPROBANTE_ACCESS_KEY_ID",
  "S3_SUBIDA_COMPROBANTE_SECRET_ACCESS_KEY",
] as const;
const ENV_KEYS = [
  "APP_ENTORNO",
  "AUTH_PROVIDER",
  "DATABASE_URL_APP",
  "DATABASE_URL",
  "DATABASE_URL_JOB",
  ...S3_KEYS,
] as const;

let admin: pg.Pool;
let urlAppReal: string;
let urlJobReal: string;
let envOriginal: Partial<Record<(typeof ENV_KEYS)[number], string>>;

beforeAll(() => {
  const url = process.env["DATABASE_URL"];
  urlAppReal = process.env["DATABASE_URL_APP"] ?? "";
  urlJobReal = process.env["DATABASE_URL_JOB"] ?? "";
  if (!url) throw new Error("Falta DATABASE_URL: los tests de base necesitan `pnpm db:up` y un .env");
  if (!urlAppReal) throw new Error("Falta DATABASE_URL_APP: correr `pnpm db:setup`");
  if (!urlJobReal) throw new Error("Falta DATABASE_URL_JOB: correr `pnpm db:setup`");
  admin = new pg.Pool({ connectionString: url, max: 4 });
  envOriginal = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

/** Vuelve el `process.env` al estado de antes del `it()`, y limpia el registro de módulos. */
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envOriginal[k] === undefined) delete process.env[k];
    else process.env[k] = envOriginal[k];
  }
  vi.doUnmock("@admin-barrios/auth");
  vi.resetModules();
});

afterAll(async () => {
  await admin.end();
});

/** Un `AuthProvider` mínimo, sin `pg` ni nada de infraestructura — solo lo que el tipo exige. */
function providerFalso() {
  return {
    clave: "falso-para-test",
    aptoParaProduccion: true,
    sesionDe: vi.fn(async () => null),
    iniciarSesion: vi.fn(async () => ({ ok: false as const, motivo: "no implementado en el test" })),
    cerrarSesion: vi.fn(async () => ({ nombre: "sesion", valor: "", secure: true, sameSite: "lax" as const, path: "/", maxEdad: 0 })),
  };
}

/**
 * Resetea el registro de módulos e importa `db.ts` de cero — un singleton nuevo por caso.
 *
 * Borra `DATABASE_URL`/`DATABASE_URL_JOB` del entorno antes de importar: el cerrojo 5 de
 * `configuracion.ts` rechaza el proceso si están presentes, sin importar qué tenga
 * `DATABASE_URL_APP`, y el `.env` de la raíz los deja seteados para el resto de los tests `db`.
 */
async function cargarModulo() {
  delete process.env["DATABASE_URL"];
  delete process.env["DATABASE_URL_JOB"];
  for (const k of S3_KEYS) delete process.env[k];
  vi.resetModules();
  return import("../src/servidor/db.ts");
}

async function sembrarUsuarioDemo(): Promise<string> {
  const id = randomUUID();
  await admin.query("insert into usuario_demo (user_id, email, nombre, descripcion) values ($1,$2,$3,$4)", [
    id,
    `verificar-arranque-${id}@ejemplo.test`,
    "Elenco de prueba",
    "sembrado por db.db.test.ts",
  ]);
  return id;
}

async function borrarUsuarioDemo(id: string): Promise<void> {
  await admin.query("delete from usuario_demo where user_id = $1", [id]);
}

type FilaUsuarioDemo = { user_id: string; email: string; nombre: string; descripcion: string | null };

/**
 * Vacía `usuario_demo` por completo y devuelve una función que restaura EXACTAMENTE las filas que
 * había. Hace falta para el caso "vacía": la base local de desarrollo tiene el elenco real del seed
 * (`pnpm db:seed`) — es lo esperado para que `local` funcione — así que `contarUsuariosDemo()` no da
 * cero por default. Sin restaurar, este test le rompería la sesión de desarrollo a quien lo corra.
 */
async function vaciarUsuarioDemoTemporalmente(): Promise<() => Promise<void>> {
  const { rows } = await admin.query<FilaUsuarioDemo>(
    "select user_id, email, nombre, descripcion from usuario_demo",
  );
  await admin.query("delete from usuario_demo");
  return async () => {
    for (const fila of rows) {
      await admin.query(
        "insert into usuario_demo (user_id, email, nombre, descripcion) values ($1,$2,$3,$4)",
        [fila.user_id, fila.email, fila.nombre, fila.descripcion],
      );
    }
  };
}

describe("verificarArranque() — entorno local (código real, sin mocks)", () => {
  it("el chequeo de usuario_demo se SALTEA: no lanza aunque haya filas (vuelta 3 no aplica en local)", async () => {
    const id = await sembrarUsuarioDemo();
    try {
      process.env["APP_ENTORNO"] = "local";
      process.env["AUTH_PROVIDER"] = "dev-suplantacion";
      process.env["DATABASE_URL_APP"] = urlAppReal;

      const { verificarArranque } = await cargarModulo();
      await expect(verificarArranque()).resolves.toBeUndefined();
    } finally {
      await borrarUsuarioDemo(id);
    }
  });

  it("el chequeo de RLS corre SIEMPRE, incluso en local — no depende de si hay usuario_demo", async () => {
    // El orden de los dos chequeos importa en un sentido concreto: el de RLS no está condicionado
    // por `entorno`, así que una conexión mal configurada se detecta en local igual que en
    // cualquier otro lado. `DATABASE_URL_APP` apuntando a la conexión BYPASSRLS (`app_job`) es
    // exactamente el despliegue mal configurado que este chequeo existe para atajar.
    process.env["APP_ENTORNO"] = "local";
    process.env["AUTH_PROVIDER"] = "dev-suplantacion";
    process.env["DATABASE_URL_APP"] = urlJobReal;

    const { verificarArranque } = await cargarModulo();
    await expect(verificarArranque()).rejects.toThrow(/BYPASSRLS/);
  });
});

describe("verificarArranque() — entorno no-local (crearAuthProvider mockeado, ver nota de cabecera)", () => {
  it("RLS ok y usuario_demo vacía: no lanza", async () => {
    // La base local de desarrollo tiene el elenco real del seed — `contarUsuariosDemo()` no da cero
    // por default acá. Se vacía y se restaura, no se asume vacía.
    const restaurar = await vaciarUsuarioDemoTemporalmente();
    try {
      vi.doMock("@admin-barrios/auth", async (importOriginal) => {
        const real = await importOriginal<typeof import("@admin-barrios/auth")>();
        return { ...real, crearAuthProvider: vi.fn(() => providerFalso()) };
      });
      process.env["APP_ENTORNO"] = "staging";
      process.env["AUTH_PROVIDER"] = "dev-suplantacion";
      process.env["DATABASE_URL_APP"] = urlAppReal;

      const { verificarArranque } = await cargarModulo();
      await expect(verificarArranque()).resolves.toBeUndefined();
    } finally {
      await restaurar();
    }
  });

  it("usuario_demo con filas: lanza — la vuelta 3, ejercitada en aislamiento de la vuelta 1", async () => {
    const id = await sembrarUsuarioDemo();
    try {
      vi.doMock("@admin-barrios/auth", async (importOriginal) => {
        const real = await importOriginal<typeof import("@admin-barrios/auth")>();
        return { ...real, crearAuthProvider: vi.fn(() => providerFalso()) };
      });
      process.env["APP_ENTORNO"] = "staging";
      process.env["AUTH_PROVIDER"] = "dev-suplantacion";
      process.env["DATABASE_URL_APP"] = urlAppReal;

      const { verificarArranque } = await cargarModulo();
      await expect(verificarArranque()).rejects.toThrow(/usuario_demo/);
    } finally {
      await borrarUsuarioDemo(id);
    }
  });
});
