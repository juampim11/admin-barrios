import { defineConfig } from "vitest/config";
import { config as cargarEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const raiz = dirname(fileURLToPath(import.meta.url));

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
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tools/**/*.test.ts"],
          environment: "node",
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
          include: ["packages/documentos/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
