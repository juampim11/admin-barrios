/**
 * El cuerpo del `worker_thread` que lee el Excel (BL-023 f). Lo lanza `padron-xlsx.ts` con límite de
 * memoria y de tiempo, **después** de las revisiones del ZIP (tamaño, descompresión con tope, celdas,
 * DOCTYPE): este hilo es lo único que carga `exceljs` sobre un archivo de un tercero.
 *
 * **Por qué un hilo.** `exceljs` arma un objeto por celda de TODAS las hojas y parsea el XML en el hilo que
 * lo llama. Con los topes de entrada, el peor caso aceptado son ~150.000 celdas; igual, un Excel armado para
 * inflar la memoria o trabar el CPU frenaba la web para todos los barrios. En un hilo aparte con
 * `resourceLimits`, lo peor que pasa es que ese hilo muere y el usuario ve un error en criollo.
 *
 * **Por qué este archivo es TypeScript sin compilar, está en su propia carpeta (con un `package.json` de tipo
 * `module`, para que Node no avise por cada lectura que el módulo no declara su tipo) y no se importa desde ningún lado.** Next (webpack) no
 * bundlea un `new Worker(...)` de servidor de forma confiable, y un worker «inline» (`eval`) no resuelve
 * `exceljs` fuera de su `cwd`. Entonces el hilo es un archivo suelto que Node corre tal cual
 * (`worker_threads` + *type stripping*, Node >= 22.18, el mismo que ya usan los scripts del repo), y quien
 * lo lanza lo ubica por su ruta junto a sí mismo. Por eso acá: solo sintaxis que Node sabe borrar (nada de
 * `enum`, `namespace` ni propiedades en el constructor), imports con extensión `.ts`, y **ningún** import del
 * monorepo ni de `server-only`: lo único que trae es `exceljs` y `lectura-de-celdas.ts`.
 */
import { parentPort, workerData } from "node:worker_threads";
import ExcelJS from "exceljs";
import { limpiar, textoDeCelda } from "./lectura-de-celdas.ts";

type Entrada = {
  readonly bytes: Uint8Array;
  readonly maxFilas: number;
  readonly maxColumnas: number;
  readonly mensajes: { readonly noEsXlsx: string; readonly sinHoja: string; readonly demasiadasFilas: string };
};
type Salida = { readonly filas: string[][] } | { readonly rechazo: string };

async function leer(e: Entrada): Promise<Salida> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(e.bytes as unknown as ArrayBuffer);
  } catch {
    return { rechazo: e.mensajes.noEsXlsx };
  }
  const hoja = wb.worksheets.find((h) => h.state === "visible");
  if (!hoja) return { rechazo: e.mensajes.sinHoja };
  if (hoja.rowCount > e.maxFilas + 1) return { rechazo: e.mensajes.demasiadasFilas };
  const filas: string[][] = [];
  for (let r = 1; r <= hoja.rowCount; r++) {
    const fila = hoja.getRow(r);
    const celdas: string[] = [];
    const columnas = Math.min(fila.cellCount, e.maxColumnas);
    for (let c = 1; c <= columnas; c++) celdas.push(limpiar(textoDeCelda(fila.getCell(c).value)));
    filas.push(celdas);
  }
  return { filas };
}

if (parentPort === null) throw new Error("lector-xlsx.ts es el cuerpo de un worker_thread: no se importa");
const salida = await leer(workerData as Entrada);
parentPort.postMessage(salida);
