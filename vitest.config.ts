import { defineConfig } from "vitest/config";
import { config as cargarEnv } from "dotenv";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const raiz = dirname(fileURLToPath(import.meta.url));

/*
 * `server-only` es un paquete-marcador: su entrada por defecto **lanza**, para que un componente de
 * cliente no pueda importar por error un módulo de servidor. Bajo Vitest no existe la condición
 * `react-server`, así que se resolvía a esa entrada y los archivos de `apps/web/src/servidor/` ni se
 * cargaban — territorio sin tests, y es justo donde vive el cerrojo de credenciales.
 *
 * Se apunta a `empty.js`, que es **el mismo archivo que React resuelve del lado del servidor**, no un
 * doble escrito por nosotros. Se ubica desde el paquete instalado en vez de escribir la ruta: con
 * pnpm el directorio lleva versión y hash en el nombre. Y no se puede pedir `server-only/empty.js`
 * directo porque su mapa de `exports` no lo publica.
 */
const servidorSoloVacio = createRequire(import.meta.url).resolve("server-only").replace(/index\.js$/, "empty.js");

// Las variables locales (DATABASE_URL, credenciales de los roles de BD) viven en .env — nunca en el
// repo (CLAUDE.md §1.5). Si no existe, los tests `db` avisan y no corren.
cargarEnv({ path: resolve(raiz, ".env"), quiet: true });

export default defineConfig({
  test: {
    // Opción de raíz (no se puede declarar por proyecto): los tests de base comparten una única
    // base local, así que los archivos corren de a uno — si no, el fixture de uno pisa al del otro.
    fileParallelism: false,
    projects: [
      {
        // Tests puros: sin base de datos, sin red. Corren siempre (gate de CI barato).
        test: {
          name: "unit",
          // `tools/` incluye los tests de infraestructura (qué credencial recibe cada contenedor):
          // son de archivos, sin base ni red, y tienen que fallar el gate barato.
          // `packages/*/*.test.ts` sin `src/` porque `design-tokens` no tiene esa carpeta: sus
          // tokens viven en la raíz del paquete, y el test de contraste al lado de ellos.
          include: [
            "packages/*/src/**/*.test.ts",
            "packages/*/*.test.ts",
            "apps/*/src/**/*.test.ts",
            "tools/**/*.test.ts",
          ],
          environment: "node",
          alias: { "server-only": servidorSoloVacio },
        },
      },
      {
        // Tests contra Postgres real (aislamiento multi-tenant / RLS). Requieren `pnpm db:up`.
        // Serializados: comparten una base y crean/limpian datos de fixture.
        test: {
          name: "db",
          include: ["packages/data/test/**/*.test.ts"],
          environment: "node",
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Tests caros de documentos (ADR-0001 §8): round-trip real del código de barras con un
        // lector de verdad y humo del PDF con Chromium. **Fuera del gate barato**: `pnpm test` no
        // los incluye, así el ciclo normal no paga Chromium. En CI van en un paso propio.
        test: {
          name: "pdf",
          include: ["packages/documentos/test/**/*.test.ts", "apps/worker/test/**/*.pdf.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Tests contra MinIO real. **Fuera del gate barato, y no por costumbre**: una URL firmada
        // que el almacenamiento rechaza es una falla silenciosa de la misma familia que las tres del
        // ADR-0001 §7.1 —el código se ve bien y el vecino no puede descargar nada— y un doble de
        // prueba no la atrapa, porque lo que falla es el acuerdo con el proveedor, no nuestra
        // lógica. Requiere `pnpm db:up` (que levanta MinIO y crea el bucket y las cuentas).
        test: {
          name: "storage",
          include: ["packages/almacenamiento/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
    ],
  },
});
