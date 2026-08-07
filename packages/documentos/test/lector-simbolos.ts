/**
 * El lector de símbolos de los tests, **apuntado al WebAssembly que ya está en el disco**.
 *
 * `zxing-wasm` documenta que, por omisión, su `locateFile` **se baja el `.wasm` del CDN de jsDelivr**
 * la primera vez que se decodifica algo. O sea que la suite de tests salía a internet, y eso rompió
 * el gate el 2026-08-07 con `wasm streaming compile failed: TypeError: fetch failed`: seis tests en
 * rojo, ninguno por un defecto del código, todos porque el runner no llegó a un servidor de terceros.
 *
 * **Que un test dependa de la red es un falso rojo esperando su turno**, y acá duele doble: estos son
 * los tests que verifican que el símbolo impreso se puede *leer*, o sea la última barrera antes de que
 * un vecino no pueda pagar. Un rojo que se explica con "habrá sido la red" es un rojo que se empieza a
 * ignorar.
 *
 * El binario ya viene en `node_modules` —lo instala el mismo paquete—, así que se lee del disco y se
 * pasa como `wasmBinary`. Cero red, y el byte es exactamente el de la versión que declara el
 * `package.json`, no el que el CDN sirva ese día.
 *
 * Es coherente con el resto de la familia: el renderizador de PDF **intercepta y aborta toda salida a
 * la red** (`packages/documentos/src/render.ts`). Los tests no tenían por qué ser la excepción.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { prepareZXingModule } from "zxing-wasm/reader";

/**
 * Ruta del `.wasm` del lector, resuelta desde el paquete instalado.
 *
 * Se resuelve `zxing-wasm/reader` —que sí está en los `exports`, a diferencia de `package.json`— y se
 * sube hasta la raíz del paquete. Nada de rutas relativas a `node_modules`: con pnpm el paquete vive
 * en un directorio con la versión y el hash en el nombre, y escribirlo a mano se rompe al actualizar.
 */
function rutaDelWasm(): string {
  const require = createRequire(import.meta.url);
  // .../zxing-wasm/dist/cjs/reader/index.js  →  .../zxing-wasm
  const raiz = join(dirname(require.resolve("zxing-wasm/reader")), "..", "..", "..");
  return join(raiz, "dist", "reader", "zxing_reader.wasm");
}

let preparado: Promise<unknown> | null = null;

/**
 * Deja el lector listo para decodificar, sin salir a la red. Idempotente: se puede llamar desde el
 * `beforeAll` de cada archivo de test y el módulo se instancia una sola vez por proceso.
 */
export function prepararLectorSinRed(): Promise<unknown> {
  preparado ??= (async () => {
    const binario = await readFile(rutaDelWasm());
    // `wasmBinary` de Emscripten espera los bytes; con esto `locateFile` no llega a ejecutarse.
    return prepareZXingModule({
      overrides: { wasmBinary: binario.buffer.slice(binario.byteOffset, binario.byteOffset + binario.byteLength) },
      fireImmediately: true,
    });
  })();
  return preparado;
}
