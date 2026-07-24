/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Los paquetes del monorepo se publican como TS fuente (una sola fuente de verdad, sin build previo).
  transpilePackages: ["@admin-barrios/shared", "@admin-barrios/design-tokens"],
  // Nota de portabilidad (ADR-0000 §4): acá NO va el `outputFileTracingIncludes` de pdfjs que usaba el
  // sistema de gas — era un parche del bundle serverless de Vercel. En Docker el archivo ya está en
  // disco. Si algún día se compila con `output: "standalone"`, reevaluar.
};

export default nextConfig;
