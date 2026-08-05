/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ────────────────────────────────────────────────────────────────────────────────────────────
  // PARA QUE UN BUILD NO PISE AL SERVIDOR DE DESARROLLO
  //
  // `next dev` y `next build` escriben el **mismo** directorio `.next`. Correr un build de
  // verificación con el `dev` levantado le reescribe los artefactos por debajo, y el síntoma en la
  // pantalla no dice una palabra de eso: *"Jest worker encountered N child process exceptions,
  // exceeding retry limit"*, con la aplicación devolviendo 500 en **toda** ruta —incluido el
  // `favicon.ico`— hasta que alguien borra `.next` a mano. Pasó dos veces el 2026-08-04 y las dos
  // veces el rato se fue buscando el problema en el código.
  //
  // El default **no cambia**: el pipeline, el Dockerfile y `next start` siguen usando `.next` sin
  // enterarse de esto. Lo que se agrega es la palanca: quien quiera compilar mientras alguien está
  // usando la aplicación lo hace con el directorio aparte y no toca nada.
  //
  //     NEXT_DIST_DIR=.next-build pnpm --filter @admin-barrios/web build
  //
  // Y si igual quedó roto, `pnpm dev:limpio` borra `.next` y levanta de cero — que es la salida
  // cuando el error no tiene nada que ver con lo que uno estaba escribiendo.
  // ────────────────────────────────────────────────────────────────────────────────────────────
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Los paquetes del monorepo se publican como TS fuente (una sola fuente de verdad, sin build previo).
  transpilePackages: [
    "@admin-barrios/shared",
    "@admin-barrios/design-tokens",
    "@admin-barrios/ui",
    "@admin-barrios/data",
    "@admin-barrios/auth",
  ],
  // `pg` NO se empaqueta: se resuelve en runtime desde node_modules. Sin esto, el bundler intenta
  // seguir sus `require` condicionales (`require("fs")` según haya certificados TLS, `pg-native`) y
  // el arranque falla con "Module not found: Can't resolve 'fs'" — verificado, rompía `pnpm dev` con
  // un 500 en toda la app.
  //
  // Va de la mano con `pg` declarado en las dependencias de ESTE package.json, y las dos cosas se
  // necesitan: marcarlo externo hace que el bundle emita un `require("pg")` que Node resuelve desde
  // `apps/web/node_modules`, y en un workspace de pnpm ese symlink **solo existe si el paquete lo
  // declara**. Con `serverExternalPackages` a secas —que fue el primer intento— compila pero revienta
  // en runtime, que es la peor de las dos fallas.
  //
  // Que `apps/web` dependa del driver no contradice la regla 1 del test de arquitectura: esa prohíbe
  // **importar** `pg` desde el código del app (y lo sigue prohibiendo, sin excepciones). Acá se
  // declara porque este es el proceso que abre el pool, y un proceso que abre un pool tiene que poder
  // resolver su driver. Lo que llega a `pg` es un solo módulo, `servidor/db.ts`, que es `server-only`.
  serverExternalPackages: ["pg"],
  // `serverExternalPackages` **no alcanza al bundle de `instrumentation.ts`**, que Next compila en
  // una capa aparte ("Compiling /instrumentation"). Como el hook de arranque llega a `servidor/db.ts`
  // —a propósito: es lo que hace que un despliegue mal configurado falle al levantar y no en el
  // primer request—, sin esta línea `pg` se empaqueta ahí igual y `pnpm dev` sirve 500 en toda la
  // app. Verificado: con solo `serverExternalPackages` el síntoma es
  // "Module not found: Can't resolve 'fs'" y un 500 en `/`.
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals ?? []), "pg", "pg-native"];
    }
    return config;
  },
  // Nota de portabilidad (ADR-0000 §4): acá NO va el `outputFileTracingIncludes` de pdfjs que usaba el
  // sistema de gas — era un parche del bundle serverless de Vercel. En Docker el archivo ya está en
  // disco. Si algún día se compila con `output: "standalone"`, reevaluar.
};

export default nextConfig;
