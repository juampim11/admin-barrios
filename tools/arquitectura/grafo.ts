/**
 * Caminante del **grafo de imports** del monorepo — la herramienta con la que se verifican en CI las
 * reglas de acoplamiento (ADR-0001 §3 y ADR-0002 §5.3).
 *
 * Por qué un caminante y no un chequeo de imports directos: las reglas que importan se rompen sin
 * que nadie las escriba. Un `export *` de más en un `index.ts` alcanza para que la web termine
 * arrastrando Chromium o el pool de la base. Acá se camina el grafo **entero** desde las entradas,
 * atravesando los paquetes del workspace por su mapa de `exports` — que es el mismo mecanismo que
 * usa el bundler, así que lo que ve este módulo es lo que va a ver Next.
 *
 * Módulo **sin dependencias**, importado por ruta relativa desde los tests. No es un paquete del
 * workspace a propósito: es una herramienta de test, y meterla en `packages/shared` sería meter
 * utilidades de test adentro de un paquete de producción.
 *
 * Lo que este mecanismo **no** detecta, y conviene tenerlo escrito: una regla de negocio en prosa
 * adentro de un componente. Contra eso no hay grafo; hay revisión. Esto cubre los acoples
 * estructurales, que son los que se rompen en silencio.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Raíz del repo, calculada desde este archivo (`tools/arquitectura/`). */
export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export type Paquete = {
  readonly nombre: string;
  readonly raiz: string;
  readonly exports: Readonly<Record<string, string>>;
};

function leerPaquetes(): Paquete[] {
  const paquetes: Paquete[] = [];
  for (const carpeta of ["packages", "apps"]) {
    const base = join(RAIZ, carpeta);
    let entradas: string[];
    try {
      entradas = readdirSync(base);
    } catch {
      continue; // La carpeta puede no existir todavía (p. ej. `apps/worker`).
    }
    for (const nombre of entradas) {
      const ruta = join(base, nombre, "package.json");
      try {
        const json = JSON.parse(readFileSync(ruta, "utf8")) as {
          name?: string;
          exports?: Record<string, string>;
        };
        if (json.name) paquetes.push({ nombre: json.name, raiz: join(base, nombre), exports: json.exports ?? {} });
      } catch {
        // Sin package.json legible no es un paquete del workspace.
      }
    }
  }
  return paquetes;
}

export const PAQUETES: readonly Paquete[] = leerPaquetes();

/**
 * Devuelve el archivo del workspace al que apunta un especificador, o `null` si es externo.
 *
 * **Lanza** si el especificador apunta a un paquete del workspace por una subruta que no está en su
 * mapa de `exports`. Eso no es un detalle: la subruta es el mecanismo con el que se esconden las
 * piezas peligrosas (`/chromium`, `/client`, `/adapters/dev-suplantacion`), y un import que no
 * resuelve tiene que fallar ruidoso y no desaparecer del grafo.
 */
export function resolverWorkspace(especificador: string): string | null {
  const paquete = PAQUETES.find((p) => especificador === p.nombre || especificador.startsWith(`${p.nombre}/`));
  if (!paquete) return null;
  const subruta = especificador === paquete.nombre ? "." : `./${especificador.slice(paquete.nombre.length + 1)}`;
  const destino = paquete.exports[subruta];
  if (!destino) throw new Error(`"${especificador}" no está en el mapa de exports de ${paquete.nombre}`);
  return resolve(paquete.raiz, destino);
}

/**
 * Especificadores importados por un archivo TS/TSX. Alcanza con lo estático: no hay `require`.
 *
 * Las tres formas se reconocen **con las tres comillas**, backtick incluido. No es teórico: un
 * `import(\`@admin-barrios/auth/adapters/dev-suplantacion\`)` escrito con backticks evadía las
 * reglas 1, 2, 2b y 4 del test de arquitectura, que es justo el conjunto que protege el aislamiento.
 * Un template literal **con interpolación** (`${…}`) no se resuelve —no se puede, es dinámico— y por
 * eso no matchea: si algún día aparece uno apuntando a un paquete del workspace, es un caso para
 * revisar a mano, no para que este helper adivine.
 *
 * También se reconoce el import por efecto de lado (`import "pg"`), que no lleva `from` y por lo
 * tanto se le escapaba al patrón viejo.
 */
export function importsDe(archivo: string, importadoPor?: string): string[] {
  let fuente: string;
  try {
    fuente = readFileSync(archivo, "utf8");
  } catch {
    // Sin esto, un `from "./algo"` **sin extensión** —que es lo idiomático en Next y por lo tanto lo
    // que alguien va a escribir tarde o temprano— mata el test con un `ENOENT` crudo de
    // `readFileSync`, y el que lo lea va a pensar que el test está roto en vez de su import. El
    // proyecto usa extensión explícita a propósito (`allowImportingTsExtensions`), así que el
    // mensaje dice qué hacer.
    throw new Error(
      `no se pudo leer "${relativa(archivo)}"` +
        (importadoPor ? `, importado desde "${relativa(importadoPor)}"` : "") +
        ". En este repo los imports relativos llevan la extensión `.ts`/`.tsx` explícita (ver " +
        "tsconfig.base.json: `allowImportingTsExtensions`), que es lo que hace que el mismo import lo " +
        "resuelvan Node, Vitest y Next sin duplicar rutas.",
    );
  }
  const encontrados: string[] = [];
  const patrones = [
    // `import x from "…"`, `export … from "…"`, `import type { X } from "…"`
    /\bfrom\s+["'`]([^"'`]+)["'`]/g,
    // `import("…")` — dinámico, con cualquiera de las tres comillas
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    // `import "…";` — efecto de lado, sin `from` (así entra `import "server-only"`)
    /\bimport\s+["'`]([^"'`]+)["'`]/g,
  ];
  for (const patron of patrones) {
    for (const m of fuente.matchAll(patron)) if (m[1]) encontrados.push(m[1]);
  }
  return encontrados;
}

/**
 * Devuelve el código con los **comentarios de documentación** vaciados, conservando los saltos de
 * línea (así los números de línea no se corren).
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ HACE FALTA
 * Las reglas de estilo del ADR-0002 §5.2 (nada de `Number()`, `Intl`, `new Date()`, `process.env`)
 * se verifican con expresiones regulares, y una regex no distingue el código de la prosa. Sin esto,
 * **el comentario que explica la regla la rompe** — pasó de verdad la primera vez que corrió el
 * test. Y la alternativa, no comentar por qué existe cada regla, es peor que el problema.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTÁ ANCLADO A PRINCIPIO DE LÍNEA Y NO ES UN TOKENIZADOR
 *
 * La versión obvia —recorrer el archivo llevando estado de "estoy adentro de un string"— **se come
 * código**, y de la peor manera posible: en silencio. El caso testigo es un regex literal con
 * barras escapadas, cuyos dos últimos caracteres antes del cierre son dos barras seguidas:
 *
 *     const patron = new RegExp("https:" + BARRA + BARRA);   // equivalente a /https:\/\//
 *
 * Un tokenizador que no distinga un regex literal de una división ve ahí un comentario de línea y
 * borra el resto del renglón. Como estas reglas son de seguridad, ese falso negativo es una
 * violación **que el test deja pasar**, que es justo lo que no puede ocurrir. Y distinguir un regex
 * de una división exige saber si el token anterior era un operando: eso ya es un parser de
 * JavaScript, y meter uno acá para poder escribir comentarios es la cura peor que la enfermedad.
 *
 * Entonces se vacía **solo** lo que empieza al principio de una línea (con nada más que espacios
 * delante), que es la forma de todos los comentarios de documentación del repo:
 *
 *   · líneas que arrancan con dos barras;
 *   · bloques que arrancan con barra-asterisco, hasta el primer cierre.
 *
 * Un comentario **a mitad de línea nunca se toca**, así que es imposible que este helper corte
 * código. La contrapartida, explícita: un comentario al final de una línea con código no se vacía y
 * hace fallar la regla. Es el intercambio correcto —falla ruidoso, y se arregla moviendo el
 * comentario a su propia línea— y es la razón por la que este helper prefiere sub-limpiar antes que
 * sobre-limpiar.
 *
 * **A propósito NO se usa para resolver imports**: ahí conviene sobre-reportar todavía más, porque
 * la regla es "esto no puede aparecer" y un import comentado que dispara el test se discute en un
 * PR, mientras que un import real que el helper se comió se va a producción.
 */
export function sinComentarios(fuente: string): string {
  const salida: string[] = [];
  let enBloque = false;

  for (const linea of fuente.split("\n")) {
    if (enBloque) {
      const cierre = linea.indexOf("*/");
      if (cierre < 0) {
        salida.push("");
        continue;
      }
      enBloque = false;
      // Lo que venga DESPUÉS del cierre es código y se conserva, en su columna original.
      salida.push(" ".repeat(cierre + 2) + linea.slice(cierre + 2));
      continue;
    }

    const sangria = linea.length - linea.trimStart().length;
    const cuerpo = linea.slice(sangria);

    if (cuerpo.startsWith("//")) {
      salida.push("");
      continue;
    }

    if (cuerpo.startsWith("/*")) {
      const cierre = cuerpo.indexOf("*/", 2);
      if (cierre < 0) {
        enBloque = true;
        salida.push("");
        continue;
      }
      salida.push(" ".repeat(sangria + cierre + 2) + cuerpo.slice(cierre + 2));
      continue;
    }

    salida.push(linea);
  }

  return salida.join("\n");
}

export type OpcionesFuentes = {
  /** Incluir los `*.test.ts` / `*.test.tsx`. Por defecto **no**: un test no es código que se despliega. */
  readonly incluirTests?: boolean;
};

/** Todos los fuentes TS/TSX de una carpeta, recursivo. Devuelve `[]` si la carpeta no existe. */
export function archivosFuente(carpeta: string, opciones: OpcionesFuentes = {}): string[] {
  const salida: string[] = [];
  const recorrer = (dir: string) => {
    let entradas: string[];
    try {
      entradas = readdirSync(dir);
    } catch {
      return;
    }
    for (const entrada of entradas) {
      if (entrada === "node_modules" || entrada === ".next" || entrada === "dist") continue;
      const ruta = join(dir, entrada);
      if (statSync(ruta).isDirectory()) recorrer(ruta);
      else if (/\.(ts|tsx)$/.test(entrada) && (opciones.incluirTests || !/\.test\.tsx?$/.test(entrada))) {
        salida.push(ruta);
      }
    }
  };
  recorrer(carpeta);
  return salida;
}

export type Grafo = {
  /** Archivos del workspace alcanzables desde las entradas (rutas absolutas, resueltas). */
  readonly archivos: ReadonlySet<string>;
  /** Nombres de paquetes externos alcanzados (con scope si lo tienen). */
  readonly externos: ReadonlySet<string>;
};

/** Camina el grafo desde `entradas` y devuelve los archivos del workspace y los paquetes externos. */
export function grafo(entradas: readonly string[]): Grafo {
  const archivos = new Set<string>();
  const externos = new Set<string>();
  const pendientes = [...entradas];
  /** Quién trajo a cada archivo. Solo se usa para que un import roto diga desde dónde se lo pidió. */
  const importadoPor = new Map<string, string>();

  while (pendientes.length > 0) {
    const archivo = pendientes.pop();
    if (!archivo || archivos.has(archivo)) continue;
    archivos.add(archivo);

    for (const especificador of importsDe(archivo, importadoPor.get(archivo))) {
      if (especificador.startsWith(".")) {
        const destino = resolve(dirname(archivo), especificador);
        if (!importadoPor.has(destino)) importadoPor.set(destino, archivo);
        pendientes.push(destino);
        continue;
      }
      const delWorkspace = resolverWorkspace(especificador);
      if (delWorkspace) {
        if (!importadoPor.has(delWorkspace)) importadoPor.set(delWorkspace, archivo);
        pendientes.push(delWorkspace);
      }
      else {
        externos.add(
          especificador.startsWith("@")
            ? especificador.split("/").slice(0, 2).join("/")
            : (especificador.split("/")[0] ?? especificador),
        );
      }
    }
  }
  return { archivos, externos };
}

/**
 * Archivos del repo que importan un módulo dado, **directamente**.
 *
 * Complementa a `grafo()` y no lo reemplaza: hay reglas que no son "esto no puede estar en el grafo"
 * sino "esto lo puede nombrar un solo archivo". El caso testigo es
 * `adapters/dev-suplantacion.ts`: la fábrica **sí** lo importa —de ahí sale el provider en
 * desarrollo, y por lo tanto está en el grafo de la web—, pero nadie más puede nombrarlo, porque el
 * gate de entorno vive en la fábrica y llamarlo por afuera lo saltea.
 *
 * `carpetas` son rutas relativas a la raíz del repo. Los tests se incluyen a propósito: un test que
 * importa el adapter a mano es legítimo, pero tiene que estar declarado en la lista permitida y no
 * pasar desapercibido.
 */
export function importadoresDe(
  moduloAbsoluto: string,
  carpetas: readonly string[],
  opciones: OpcionesFuentes = { incluirTests: true },
): string[] {
  const objetivo = resolve(moduloAbsoluto);
  const importadores: string[] = [];

  for (const carpeta of carpetas) {
    for (const archivo of archivosFuente(join(RAIZ, carpeta), opciones)) {
      if (resolve(archivo) === objetivo) continue; // el módulo no se importa a sí mismo
      for (const especificador of importsDe(archivo)) {
        const destino = especificador.startsWith(".")
          ? resolve(dirname(archivo), especificador)
          : seguro(() => resolverWorkspace(especificador));
        if (destino && resolve(destino) === objetivo) {
          importadores.push(archivo);
          break;
        }
      }
    }
  }
  return importadores;
}

/** Un especificador que no resuelve no es un importador: acá no es el lugar donde eso tiene que fallar. */
function seguro(fn: () => string | null): string | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Ruta relativa a la raíz del repo, con `/`, para mensajes de error legibles en Windows y Linux. */
export function relativa(archivo: string): string {
  return resolve(archivo).slice(resolve(RAIZ).length + 1).replaceAll("\\", "/");
}
