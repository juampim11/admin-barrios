/**
 * El candado de "cada proceso recibe solo su credencial", verificado en el gate barato (`pnpm test`).
 *
 * Un arreglo sin candado se deshace solo en tres meses: el día que alguien necesite "probar una cosa"
 * y le agregue `DATABASE_URL` al servicio de la web, esto tiene que ponerse rojo antes del merge.
 *
 * Incluye **casos de control** con violaciones inyectadas: sin ellos, un lector que dejara de
 * encontrar los servicios daría verde con el compose roto, que es peor que no tener test.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CREDENCIALES_CRITICAS,
  REGLAS,
  SERVICIOS_GOBERNADOS,
  esGobernada,
  verificar,
} from "./credenciales.ts";
import {
  bloqueSinInterpolaciones,
  leerServicios,
  publicaEnTodasLasInterfaces,
  type ServicioCompose,
} from "./compose.ts";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const compose = readFileSync(resolve(raiz, "docker-compose.yml"), "utf8");
const servicios = leerServicios(compose);

/** Servicios del compose que corren código nuestro, con el rol que les toca. */
function gobernados(lista: readonly ServicioCompose[]) {
  return lista.flatMap((servicio) => {
    const rol = SERVICIOS_GOBERNADOS[servicio.nombre];
    return rol ? [{ servicio, rol }] : [];
  });
}

/**
 * La verificación completa de un servicio. Dos barridos distintos a propósito:
 *  - **estructural**: las claves declaradas bajo `environment:` contra la lista de permitidos.
 *  - **textual**: el bloque entero contra las credenciales críticas, sin depender de cómo esté
 *    escrito el YAML (mapa, lista, flow map en una línea, `x-` anchors).
 */
function violacionesDeServicio(servicio: ServicioCompose, rol: keyof typeof REGLAS): string[] {
  const problemas: string[] = [];

  if (servicio.tieneEnvFile) {
    problemas.push(
      `${servicio.nombre}: declara env_file, que le entrega el .env ENTERO (incluida la URL del dueño ` +
        `del esquema y la del rol con BYPASSRLS). Las variables se enumeran una por una.`,
    );
  }

  const entorno = Object.fromEntries(servicio.variables.map((v) => [v, "declarada"]));
  for (const violacion of verificar(rol, entorno, { exigirRequeridas: true })) {
    problemas.push(`${servicio.nombre}: ${violacion.variable} — ${violacion.motivo}`);
  }

  const texto = bloqueSinInterpolaciones(servicio);
  for (const critica of CREDENCIALES_CRITICAS) {
    if (REGLAS[rol].permitidas.includes(critica.nombre)) continue;
    // `\b` no alcanza: `DATABASE_URL` es prefijo de `DATABASE_URL_APP`, que sí está permitida.
    if (new RegExp(`\\b${critica.nombre}\\b(?![A-Z0-9_])`).test(texto)) {
      problemas.push(`${servicio.nombre}: menciona ${critica.nombre} — ${critica.porque}`);
    }
  }

  return problemas;
}

describe("docker-compose.yml — cada contenedor recibe solo su credencial", () => {
  it("el lector encuentra los servicios (si no, todo lo demás sería un falso verde)", () => {
    expect(servicios.map((s) => s.nombre)).toContain("postgres");
    expect(servicios.length).toBeGreaterThanOrEqual(3);
  });

  it("todo servicio que corre código nuestro tiene un rol declarado", () => {
    const sinRol = servicios
      .filter((s) => s.seConstruye && !SERVICIOS_GOBERNADOS[s.nombre])
      .map((s) => s.nombre);
    expect(
      sinRol,
      "un contenedor que se construye desde un Dockerfile nuestro tiene que declarar su rol en " +
        "tools/infra/credenciales.ts (SERVICIOS_GOBERNADOS), no heredar credenciales por olvido",
    ).toEqual([]);
  });

  it("ningún servicio gobernado recibe credenciales que no le tocan", () => {
    const problemas = gobernados(servicios).flatMap(({ servicio, rol }) =>
      violacionesDeServicio(servicio, rol),
    );
    expect(problemas).toEqual([]);
  });

  it("la web existe en el compose y está gobernada", () => {
    // Si alguien renombra el servicio, el test de arriba pasaría en vacío.
    expect(gobernados(servicios).some(({ rol }) => rol === "web")).toBe(true);
  });

  it("ningún puerto queda publicado en todas las interfaces de la máquina", () => {
    const expuestos = servicios.flatMap((s) =>
      s.puertos.filter(publicaEnTodasLasInterfaces).map((p) => `${s.nombre}: ${p}`),
    );
    expect(
      expuestos,
      "en la infra local los puertos se atan a 127.0.0.1: una base de desarrollo con contraseña de " +
        "desarrollo, alcanzable desde la red de la cafetería, es una base de desarrollo pública",
    ).toEqual([]);
  });
});

describe("casos de control — el detector detecta de verdad", () => {
  const limpio = `
services:
  app:
    build:
      context: .
    environment:
      DATABASE_URL_APP: postgres://\${APP_DB_USER}:\${APP_DB_PASSWORD}@postgres:5432/\${POSTGRES_DB}
      APP_ENTORNO: local
    ports:
      - "127.0.0.1:4000:4000"
`;

  it("un compose correcto no genera violaciones", () => {
    const [app] = leerServicios(limpio);
    expect(app).toBeDefined();
    expect(violacionesDeServicio(app!, "web")).toEqual([]);
  });

  it("detecta la URL del rol con BYPASSRLS en estilo mapa", () => {
    const sucio = limpio.replace(
      "      APP_ENTORNO: local",
      "      APP_ENTORNO: local\n      DATABASE_URL_JOB: postgres://app_job:x@postgres:5432/db",
    );
    const [app] = leerServicios(sucio);
    expect(violacionesDeServicio(app!, "web").join("\n")).toMatch(/DATABASE_URL_JOB/);
  });

  it("detecta la URL del dueño del esquema en estilo lista", () => {
    const sucio = limpio.replace(
      "    environment:\n",
      "    environment:\n      - DATABASE_URL=postgres://admin:x@postgres:5432/db\n",
    );
    const [app] = leerServicios(sucio);
    expect(violacionesDeServicio(app!, "web").join("\n")).toMatch(/DATABASE_URL/);
  });

  it("detecta env_file, que arrastra el .env entero", () => {
    const sucio = limpio.replace("    environment:", "    env_file:\n      - .env\n    environment:");
    const [app] = leerServicios(sucio);
    expect(violacionesDeServicio(app!, "web").join("\n")).toMatch(/env_file/);
  });

  it("detecta la credencial aunque el YAML esté escrito de una forma que el lector no parsea", () => {
    // El barrido textual es la red de seguridad del lector tosco.
    const sucio = limpio.replace(
      "    ports:",
      "    x-notas: { DATABASE_URL_JOB: postgres://app_job:x@postgres/db }\n    ports:",
    );
    const [app] = leerServicios(sucio);
    expect(violacionesDeServicio(app!, "web").join("\n")).toMatch(/DATABASE_URL_JOB/);
  });

  it("no confunde una interpolación de compose con una variable entregada al contenedor", () => {
    // El worker arma su URL con ${JOB_DB_PASSWORD}: compose la resuelve al leer el archivo, el
    // contenedor recibe el valor, no la variable. Un barrido ingenuo lo marcaría como violación.
    const worker = `
services:
  worker:
    build:
      context: .
    environment:
      DATABASE_URL_JOB: postgres://app_job:\${JOB_DB_PASSWORD}@postgres:5432/\${POSTGRES_DB}
      DATABASE_URL_APP: postgres://\${APP_DB_USER}:\${APP_DB_PASSWORD}@postgres:5432/\${POSTGRES_DB}
      APP_ENTORNO: local
`;
    const [servicio] = leerServicios(worker);
    expect(violacionesDeServicio(servicio!, "worker")).toEqual([]);
  });

  it("detecta un puerto publicado en todas las interfaces", () => {
    const sucio = limpio.replace('"127.0.0.1:4000:4000"', '"4000:4000"');
    const [app] = leerServicios(sucio);
    expect(app!.puertos.filter(publicaEnTodasLasInterfaces)).toEqual(["4000:4000"]);
  });
});

describe("la regla de credenciales", () => {
  it("la web no puede recibir la conexión con BYPASSRLS ni la del dueño del esquema", () => {
    const violaciones = verificar("web", {
      DATABASE_URL_APP: "postgres://app_request_dev:x@localhost/db",
      DATABASE_URL_JOB: "postgres://app_job:x@localhost/db",
      DATABASE_URL: "postgres://admin_barrios:x@localhost/db",
      APP_ENTORNO: "local",
    });
    expect(violaciones.map((v) => v.variable)).toEqual(["DATABASE_URL", "DATABASE_URL_JOB"]);
  });

  it("es lista de permitidos: una credencial nueva sin declarar también falla", () => {
    const violaciones = verificar("web", { S3_ADMIN_SECRET_KEY: "x" });
    expect(violaciones.map((v) => v.variable)).toEqual(["S3_ADMIN_SECRET_KEY"]);
  });

  it("el worker sí puede tener BYPASSRLS, pero nunca al dueño del esquema", () => {
    expect(verificar("worker", { DATABASE_URL_JOB: "x" })).toEqual([]);
    expect(verificar("worker", { DATABASE_URL: "x" }).map((v) => v.variable)).toEqual(["DATABASE_URL"]);
  });

  it("ignora la plomería del sistema operativo y las variables declaradas en vacío", () => {
    expect(esGobernada("PATH")).toBe(false);
    expect(esGobernada("HOSTNAME")).toBe(false);
    expect(esGobernada("DATABASE_URL_JOB")).toBe(true);
    expect(verificar("web", { DATABASE_URL_JOB: "", PATH: "/usr/bin" })).toEqual([]);
  });

  it("con --exigir-requeridas, faltar la credencial propia también es una falla", () => {
    const violaciones = verificar("web", {}, { exigirRequeridas: true });
    expect(violaciones.map((v) => v.variable)).toEqual(["APP_ENTORNO", "DATABASE_URL_APP"]);
  });
});
