/**
 * La regla de importación del ADR-0001 §3, verificada en CI:
 *
 * > `apps/web` puede importar `plantillas/` y `simbolos.ts`; **no puede importar
 * > `adapters/chromium.ts`**. Si Chromium entra al bundle de Next, la imagen de la app se infla
 * > +734 MB y volvemos al problema que este ADR evita.
 *
 * Es fácil de romper sin darse cuenta —un `export *` de más en un `index.ts` alcanza—, así que en
 * vez de mirar los imports directos se camina el **grafo entero** desde las entradas de la web,
 * atravesando los paquetes del workspace por su mapa de `exports`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Paquetes que **no pueden** aparecer en el grafo de la app web. */
const VETADOS = ["puppeteer-core", "puppeteer", "playwright", "pdf-lib"];

type Paquete = { nombre: string; raiz: string; exports: Record<string, string> };

function leerPaquetes(): Paquete[] {
  const paquetes: Paquete[] = [];
  for (const carpeta of ["packages", "apps"]) {
    const base = join(RAIZ, carpeta);
    for (const nombre of readdirSync(base)) {
      const ruta = join(base, nombre, "package.json");
      try {
        const json = JSON.parse(readFileSync(ruta, "utf8")) as { name?: string; exports?: Record<string, string> };
        if (json.name) paquetes.push({ nombre: json.name, raiz: join(base, nombre), exports: json.exports ?? {} });
      } catch {
        // Sin package.json legible no es un paquete del workspace.
      }
    }
  }
  return paquetes;
}

const PAQUETES = leerPaquetes();

/** Devuelve el archivo del workspace al que apunta un especificador, o `null` si es externo. */
function resolverWorkspace(especificador: string): string | null {
  const paquete = PAQUETES.find((p) => especificador === p.nombre || especificador.startsWith(`${p.nombre}/`));
  if (!paquete) return null;
  const subruta = especificador === paquete.nombre ? "." : `./${especificador.slice(paquete.nombre.length + 1)}`;
  const destino = paquete.exports[subruta];
  if (!destino) throw new Error(`"${especificador}" no está en el mapa de exports de ${paquete.nombre}`);
  return resolve(paquete.raiz, destino);
}

/** Especificadores importados por un archivo TS/TSX. Alcanza con lo estático: no hay `require` acá. */
function importsDe(archivo: string): string[] {
  const fuente = readFileSync(archivo, "utf8");
  const encontrados: string[] = [];
  for (const patron of [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const m of fuente.matchAll(patron)) if (m[1]) encontrados.push(m[1]);
  }
  return encontrados;
}

function archivosFuente(carpeta: string): string[] {
  const salida: string[] = [];
  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      if (entrada === "node_modules" || entrada === ".next") continue;
      const ruta = join(dir, entrada);
      if (statSync(ruta).isDirectory()) recorrer(ruta);
      else if (/\.(ts|tsx)$/.test(entrada) && !/\.test\.tsx?$/.test(entrada)) salida.push(ruta);
    }
  };
  recorrer(carpeta);
  return salida;
}

/** Camina el grafo desde `entradas` y devuelve los archivos del workspace y los paquetes externos. */
function grafo(entradas: readonly string[]): { archivos: Set<string>; externos: Set<string> } {
  const archivos = new Set<string>();
  const externos = new Set<string>();
  const pendientes = [...entradas];

  while (pendientes.length > 0) {
    const archivo = pendientes.pop();
    if (!archivo || archivos.has(archivo)) continue;
    archivos.add(archivo);

    for (const especificador of importsDe(archivo)) {
      if (especificador.startsWith(".")) {
        pendientes.push(resolve(dirname(archivo), especificador));
        continue;
      }
      const delWorkspace = resolverWorkspace(especificador);
      if (delWorkspace) pendientes.push(delWorkspace);
      // Paquete externo: se guarda el nombre (con scope si lo tiene).
      else externos.add(especificador.startsWith("@") ? especificador.split("/").slice(0, 2).join("/") : especificador.split("/")[0] ?? especificador);
    }
  }
  return { archivos, externos };
}

const CHROMIUM = resolve(RAIZ, "packages/documentos/src/adapters/chromium.ts");

describe("regla de importación: la web no arrastra el motor", () => {
  it("el caminante detecta de verdad el motor (si no, todo lo demás sería un falso verde)", () => {
    const { archivos, externos } = grafo([CHROMIUM]);
    expect(archivos.has(CHROMIUM)).toBe(true);
    expect(externos).toContain("puppeteer-core");
    expect(externos).toContain("pdf-lib");
  });

  it("apps/web no llega a `adapters/chromium.ts` por ningún camino", () => {
    const { archivos, externos } = grafo(archivosFuente(join(RAIZ, "apps/web/src")));
    expect(archivos.has(CHROMIUM)).toBe(false);
    for (const vetado of VETADOS) expect(externos).not.toContain(vetado);
  });

  it("la entrada pública de `documentos` tampoco lo exporta: `.` es seguro para la web", () => {
    const { archivos, externos } = grafo([resolve(RAIZ, "packages/documentos/src/index.ts")]);
    expect(archivos.has(CHROMIUM)).toBe(false);
    for (const vetado of VETADOS) expect(externos).not.toContain(vetado);
  });

  it("el adapter vive detrás de su propia subruta de `exports`", () => {
    expect(resolverWorkspace("@admin-barrios/documentos/chromium")).toBe(CHROMIUM);
  });
});
