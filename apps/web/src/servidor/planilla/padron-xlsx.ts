import "server-only";

/**
 * La planilla del padrón en Excel (T3): **leer** el archivo que sube la administración y **escribir**
 * la exportación y la plantilla. Es, con el serializador de la exportación de movimientos, el único
 * archivo que nombra `exceljs` (EX-3), y **el único que lee un workbook** (EX-4). La lectura salió del
 * panel `security-engineer` del 2026-11-03 (ADR-0010 §6), que exigió lo que sigue antes de que la
 * librería toque un archivo de un tercero:
 *
 *   - **tope de tamaño** del archivo (`MAX_BYTES_PLANILLA`) y los bytes mágicos de un ZIP (`PK\x03\x04`):
 *     la extensión y el MIME no cuentan; un `.xls` viejo (CFB) se rechaza con su mensaje;
 *   - **cada entrada del ZIP se descomprime de verdad, con tope de salida** (`inflateRawSync` con
 *     `maxOutputLength`), y lo real tiene que coincidir con lo declarado. `exceljs` usa JSZip, que
 *     descomprime entero y recién después compara: confiar en el directorio central no frena una
 *     zip-bomb (bloqueante B2). Se rechazan ZIP64, entradas cifradas, métodos que no sean 0 u 8,
 *     nombres repetidos y datos antes del primer encabezado (archivos políglotas);
 *   - **tope de lo descomprimido** (`MAX_DESCOMPRIMIDO`), de celdas y de textos compartidos: `exceljs`
 *     arma un objeto por celda de TODAS las hojas, así que el tope va sobre el XML, antes de cargarlo;
 *   - cualquier `<!DOCTYPE` se rechaza (un OOXML nunca lo trae);
 *   - **una lectura por vez** en el proceso (`semaforo`): el proceso web es de todos los barrios;
 *   - se lee la **primera hoja visible**, con tope de filas y columnas; cada celda se convierte a texto
 *     (el resultado cacheado de una fórmula, nunca se evalúa; sin resultado, vacía), normalizada a
 *     NFC y sin caracteres de control ni de dirección de texto (U+202E). Un número de más de 15
 *     dígitos —un CBU que Excel guardó como número— perdió precisión: no se usa (G1).
 * Lo que queda son filas de texto: las valida `@admin-barrios/shared/padron` igual que si fueran CSV.
 *
 * **La carga de `exceljs` corre en un `worker_thread`** (`hilo/lector-xlsx.ts`, BL-023 f) con límite de memoria
 * y de tiempo, **después** de todas las revisiones de arriba, que corren acá en el hilo del servidor (son
 * acotadas: descompresión con tope y una pasada de regex sobre lo descomprimido). Si el hilo se pasa de
 * memoria o de tiempo, se termina y la persona ve «La planilla es demasiado grande o está dañada…»; el
 * proceso web no se entera. Con los topes de arriba, el peor caso aceptado son ~150.000 celdas.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, type ResourceLimits } from "node:worker_threads";
import { inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { MAX_FILAS_PADRON } from "@admin-barrios/shared/padron";
import { sanearTextoDePlanilla } from "@admin-barrios/shared/planilla";
import { INVISIBLES } from "./hilo/lectura-de-celdas.ts";

export const MAX_BYTES_PLANILLA = 5 * 1024 * 1024;
const MAX_ENTRADAS_ZIP = 500;
const MAX_DESCOMPRIMIDO = 15 * 1024 * 1024;
const MAX_CELDAS = 150_000;
const MAX_TEXTOS_COMPARTIDOS = 150_000;
// 30 y no 20 (encargo 17b): la planilla del padrón ya tiene 20 columnas propias, y con el tope justo una
// columna de más de la persona (unas observaciones) dejaba afuera la última sin avisar.
const MAX_COLUMNAS = 30;

/** Un archivo que no se lee (formato, tamaño, estructura). El mensaje es para la persona. */
export class ArchivoRechazado extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "ArchivoRechazado";
  }
}

const NO_ES_XLSX = "El archivo no es un Excel (.xlsx) válido. Guardalo de nuevo como .xlsx, o como CSV.";

/** Cuántas veces aparece `aguja` en `texto`, sin armar arreglos. */
function contar(texto: string, aguja: RegExp): number {
  let n = 0;
  for (const _ of texto.matchAll(aguja)) n++;
  return n;
}

/**
 * Recorre el ZIP y descomprime cada entrada con tope (APPNOTE 4.3.7, 4.3.12, 4.3.16). Si algo no
 * cuadra, `ArchivoRechazado`. No devuelve nada: deja el archivo "aprobado" para que lo lea `exceljs`.
 */
function revisarZip(buf: Buffer): void {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0) {
    throw new ArchivoRechazado("Es un Excel viejo (.xls): guardalo como .xlsx o como CSV.");
  }
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new ArchivoRechazado(NO_ES_XLSX);
  const desde = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= desde; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchivoRechazado(NO_ES_XLSX);
  const entradas = buf.readUInt16LE(eocd + 10);
  const tamanoDirectorio = buf.readUInt32LE(eocd + 12);
  const inicio = buf.readUInt32LE(eocd + 16);
  if (entradas === 0xffff || inicio === 0xffffffff || tamanoDirectorio === 0xffffffff) {
    throw new ArchivoRechazado("El Excel es demasiado grande para un padrón: partilo o guardalo como CSV.");
  }
  if (entradas === 0 || entradas > MAX_ENTRADAS_ZIP || inicio + tamanoDirectorio > eocd) throw new ArchivoRechazado(NO_ES_XLSX);

  const nombres = new Set<string>();
  let p = inicio;
  let total = 0;
  let celdas = 0;
  let textos = 0;
  let menorDesplazamiento = Number.POSITIVE_INFINITY;
  for (let n = 0; n < entradas; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new ArchivoRechazado(NO_ES_XLSX);
    const banderas = buf.readUInt16LE(p + 8);
    const metodo = buf.readUInt16LE(p + 10);
    const comprimido = buf.readUInt32LE(p + 20);
    const descomprimido = buf.readUInt32LE(p + 24);
    const largoNombre = buf.readUInt16LE(p + 28);
    const largoExtra = buf.readUInt16LE(p + 30);
    const largoComentario = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nombre = buf.toString("utf8", p + 46, p + 46 + largoNombre);
    p += 46 + largoNombre + largoExtra + largoComentario;

    if (comprimido === 0xffffffff || descomprimido === 0xffffffff || local === 0xffffffff) {
      throw new ArchivoRechazado("El Excel es demasiado grande para un padrón: partilo o guardalo como CSV.");
    }
    if ((banderas & 0x1) !== 0) throw new ArchivoRechazado("El Excel está protegido con contraseña: guardalo sin contraseña.");
    if (metodo !== 0 && metodo !== 8) throw new ArchivoRechazado(NO_ES_XLSX);
    if (nombres.has(nombre) || nombre.includes("..") || nombre.startsWith("/")) throw new ArchivoRechazado(NO_ES_XLSX);
    nombres.add(nombre);
    total += descomprimido;
    if (total > MAX_DESCOMPRIMIDO) throw new ArchivoRechazado("El Excel es demasiado grande para un padrón: partilo o guardalo como CSV.");
    menorDesplazamiento = Math.min(menorDesplazamiento, local);

    // El encabezado local y los datos de ESTA entrada, descomprimidos con tope.
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new ArchivoRechazado(NO_ES_XLSX);
    const datos = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (datos + comprimido > buf.length) throw new ArchivoRechazado(NO_ES_XLSX);
    const crudo = buf.subarray(datos, datos + comprimido);
    let contenido: Buffer;
    if (metodo === 0) {
      contenido = crudo;
    } else {
      try {
        contenido = inflateRawSync(crudo, { maxOutputLength: Math.max(1, descomprimido) });
      } catch {
        throw new ArchivoRechazado(NO_ES_XLSX);
      }
    }
    if (contenido.length !== descomprimido) throw new ArchivoRechazado(NO_ES_XLSX);

    if (nombre.endsWith(".xml") || nombre.endsWith(".rels")) {
      const xml = contenido.toString("utf8");
      if (/<!DOCTYPE/i.test(xml)) throw new ArchivoRechazado(NO_ES_XLSX);
      if (/^xl\/worksheets\/[^/]+\.xml$/.test(nombre)) celdas += contar(xml, /<c[\s>/]/g);
      if (nombre === "xl/sharedStrings.xml") textos += contar(xml, /<si[\s>/]/g);
    }
  }
  if (menorDesplazamiento !== 0) throw new ArchivoRechazado(NO_ES_XLSX);
  if (celdas > MAX_CELDAS || textos > MAX_TEXTOS_COMPARTIDOS) {
    throw new ArchivoRechazado("El Excel tiene demasiadas celdas para un padrón de hasta 5.000 filas: dejá una sola hoja con el padrón.");
  }
}

/** Una lectura por vez en el proceso (ver la cabecera). */
let semaforo: Promise<unknown> = Promise.resolve();
/** Lecturas que hay en el proceso ahora: la que está leyendo más las que esperan su turno. */
let enCurso = 0;

/** Lo que ve la persona si ya hay demasiadas planillas esperando (ver `LIMITES_DE_LECTURA.maxEsperando`). */
const COLA_LLENA = "Hay otras planillas procesándose. Probá de nuevo en un minuto.";

/** Lo que ve la persona cuando el hilo se pasa de memoria o de tiempo, o el Excel está roto por dentro. */
const DEMASIADO_PESADO =
  "La planilla es demasiado grande o está dañada: guardala de nuevo como .xlsx con menos filas, o como CSV.";

/**
 * Los límites del hilo de lectura. **Medidos, no adivinados** (HANDOFF, BL-023 f): la planilla más grande que
 * pasa las revisiones de arriba (5.000 filas × 30 columnas = 150.000 celdas, el peor caso aceptado) se lee con
 * un mínimo de entre 64 y 96 MB de heap (con 64 MB el hilo muere por falta de memoria, con 96 anda) y en ~2 s
 * en esta máquina. Se dan **256 MB** (más del doble del peor caso real) y **15 s** (siete veces el tiempo
 * medido, para una máquina más lenta o cargada): no cortan una planilla legítima y sí una que se pasa. El heap
 * del hilo es aparte del heap del proceso web: pasarse mata al hilo, no a la web. (`resourceLimits` acota el heap
 * de V8; la memoria de los buffers está acotada antes, por los 15 MB descomprimidos de `revisarZip`.)
 *
 * **`maxEsperando: 4`** (S7b): cuántas lecturas pueden esperar su turno detrás de la que está leyendo. La cola
 * del semáforo es de todos los barrios y cada lectura puede ocupar hasta `tiempoMs`: sin tope, alguien con
 * permiso de padrón encadena subidas hostiles de 15 s y deja esperando a todos los demás. Con 4, el peor
 * tiempo de espera de una lectura legítima es 4 × ~2 s (lo medido) y el de una detrás de cuatro hostiles,
 * 4 × 15 s; la quinta en la fila se rechaza **en el acto**, antes de tocar el archivo, y la persona vuelve a
 * probar. Es un número de seguridad, no un cálculo: una administración sube una planilla por vez.
 */
export const LIMITES_DE_LECTURA = {
  memoriaMb: 256,
  tiempoMs: 15_000,
  maxEsperando: 4,
} as const;
export type LimitesDeLectura = {
  readonly memoriaMb: number;
  readonly tiempoMs: number;
  /** Opcional: si falta, `LIMITES_DE_LECTURA.maxEsperando`. */
  readonly maxEsperando?: number;
};

/**
 * El cuerpo del hilo (`hilo/lector-xlsx.ts`). Ver ahí por qué es un archivo suelto y no se importa.
 *
 * Dónde está: junto a este archivo. Ojo, en el bundle de Next `import.meta.url` **queda fijado al archivo
 * fuente del momento del build** (`file:///…/src/servidor/planilla/padron-xlsx.ts`, verificado en
 * `.next/server/chunks`): sirve mientras el código fuente esté donde se compiló, que es el caso de `next
 * start` y de `next dev` en este repo (no hay `output: "standalone"`). Si se compila en un lugar y se corre en
 * otro, se busca también desde el directorio de trabajo (`apps/web`, o la raíz del monorepo); y si no está en
 * ninguno el error lo dice (no se disfraza de «planilla dañada»). Con `output: "standalone"` habría que
 * copiar ese archivo (`outputFileTracingIncludes`).
 */
function rutaDelHilo(): string {
  const relativa = join("src", "servidor", "planilla", "hilo", "lector-xlsx.ts");
  const candidatas = [
    join(dirname(fileURLToPath(import.meta.url)), "hilo", "lector-xlsx.ts"),
    join(process.cwd(), relativa),
    join(process.cwd(), "apps", "web", relativa),
  ];
  const ruta = candidatas.find((c) => existsSync(c));
  if (!ruta) throw new Error(`no se encuentra el hilo de lectura del Excel; se buscó en: ${candidatas.join(", ")}`);
  return ruta;
}

/** Cuánto se espera, después de pedir `terminate()`, a que el hilo cierre antes de entregar igual el resultado. */
const ESPERA_DE_CIERRE_MS = 2_000;

let hilosVivos = 0;
/** Cuántos hilos de lectura siguen corriendo. Para los tests (que no queden colgados) y para diagnóstico. */
export const hilosDeLecturaVivos = (): number => hilosVivos;

/**
 * Carga el Excel y devuelve sus filas en un `worker_thread` con límite de memoria y de tiempo.
 * **Resuelve recién cuando el hilo terminó** (evento `exit`), pase lo que pase: resultado, rechazo, falta de
 * memoria, tiempo agotado o error. Así no queda ningún hilo colgado.
 */
function leerEnHilo(buf: Buffer, limites: LimitesDeLectura): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    // Una copia que se transfiere (no se clona): un `Buffer` del pool de Node puede apoyarse en un ArrayBuffer enorme.
    const bytes = Uint8Array.from(buf);
    const recursos: ResourceLimits = {
      maxOldGenerationSizeMb: limites.memoriaMb,
      maxYoungGenerationSizeMb: Math.max(16, Math.floor(limites.memoriaMb / 8)),
      stackSizeMb: 4,
    };
    let hilo: Worker;
    try {
      hilo = new Worker(rutaDelHilo(), {
        workerData: {
          bytes,
          maxFilas: MAX_FILAS_PADRON,
          maxColumnas: MAX_COLUMNAS,
          mensajes: {
            noEsXlsx: NO_ES_XLSX,
            sinHoja: "El Excel no tiene ninguna hoja visible.",
            demasiadasFilas: "La planilla tiene más de 5.000 filas: partila en varias.",
          },
        },
        transferList: [bytes.buffer],
        resourceLimits: recursos,
        // El hilo no hereda opciones del proceso (p. ej. `--inspect`), ni escribe en su salida, ni ve las variables
        // de entorno del servidor (`DATABASE_URL*`, claves): lo único que necesita es `exceljs`.
        execArgv: [],
        env: {},
        stdout: false,
        stderr: false,
      });
    } catch (e) {
      reject(e);
      return;
    }
    hilosVivos++;

    let resultado: { ok: string[][] } | { error: Error } | null = null;
    let entregado = false;
    /** Entrega el resultado una sola vez: lo normal es desde `exit`; el respaldo de abajo es el plan B. */
    const entregar = () => {
      if (entregado) return;
      entregado = true;
      clearTimeout(reloj);
      const r = resultado ?? { error: new Error("el hilo de lectura del Excel terminó sin devolver nada") };
      if ("ok" in r) resolve(r.ok);
      else reject(r.error);
    };
    const fijar = (r: { ok: string[][] } | { error: Error }) => {
      if (resultado !== null) return; // el primero gana; lo que llegue después (p. ej. el `exit`) no lo pisa
      resultado = r;
      clearTimeout(reloj);
      void hilo.terminate(); // idempotente; si ya terminó, no hace nada
      // Plan B: si el hilo estuviera clavado en código nativo y `terminate()` no pudiera interrumpirlo, la lectura
      // (y con ella el semáforo, que es de todos los barrios) no quedaría esperando para siempre. El contador de
      // hilos vivos sigue contándolo hasta su `exit` real.
      setTimeout(entregar, ESPERA_DE_CIERRE_MS).unref();
    };
    const reloj = setTimeout(() => fijar({ error: new ArchivoRechazado(DEMASIADO_PESADO) }), limites.tiempoMs);

    hilo.once("message", (m: { filas: string[][] } | { rechazo: string }) => {
      fijar("filas" in m ? { ok: m.filas } : { error: new ArchivoRechazado(m.rechazo) });
    });
    hilo.once("error", (e: Error & { code?: string }) => {
      // Sin memoria: el hilo muere, la web no. Cualquier otro error del hilo es un fallo del sistema (el archivo
      // del hilo no está, una dependencia no carga): se deja visible, no se disfraza de «planilla dañada».
      fijar({ error: e.code === "ERR_WORKER_OUT_OF_MEMORY" ? new ArchivoRechazado(DEMASIADO_PESADO) : e });
    });
    hilo.once("exit", () => {
      hilosVivos--;
      entregar();
    });
  });
}

/**
 * Lee un `.xlsx` y devuelve sus filas como texto (la primera es el encabezado). Lanza
 * `ArchivoRechazado` si el archivo no pasa las revisiones o tiene más filas que el tope, o si la carga se pasa
 * de memoria o de tiempo. `limites` es para los tests; en producción, `LIMITES_DE_LECTURA`.
 */
export function filasDeXlsx(buf: Buffer, limites: LimitesDeLectura = LIMITES_DE_LECTURA): Promise<string[][]> {
  // `enCurso` cuenta la que está leyendo: las que esperan son `enCurso - 1`. Con la fila llena se rechaza en el acto.
  if (enCurso - 1 >= (limites.maxEsperando ?? LIMITES_DE_LECTURA.maxEsperando)) {
    return Promise.reject(new ArchivoRechazado(COLA_LLENA));
  }
  enCurso++;
  const lectura = semaforo.then(async () => {
    if (buf.length > MAX_BYTES_PLANILLA) throw new ArchivoRechazado("El archivo pasa de 5 MB: partilo en varios.");
    revisarZip(buf);
    return leerEnHilo(buf, limites);
  });
  semaforo = lectura.catch(() => undefined);
  return lectura.finally(() => {
    enCurso--;
  });
}

/** Un CSV a texto: UTF-8 (con o sin BOM) o, si no es UTF-8 válido, Windows-1252 (Excel en castellano). */
export function textoDeCsv(bytes: Uint8Array): string {
  if (bytes.length > MAX_BYTES_PLANILLA) throw new ArchivoRechazado("El archivo pasa de 5 MB: partilo en varios.");
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new ArchivoRechazado("El CSV está en UTF-16: guardalo como «CSV UTF-8».");
  }
  let texto: string;
  try {
    texto = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    texto = new TextDecoder("windows-1252").decode(bytes);
  }
  return texto.normalize("NFC").replace(INVISIBLES, "");
}

/**
 * Escribe filas de texto como `.xlsx`: todas las celdas como texto (así un CBU de 22 dígitos o un CUIT
 * no se vuelven números con exponente), con el saneado anti-fórmula de toda planilla del sistema.
 */
export async function xlsxDeFilas(filas: readonly (readonly string[])[], hojaNombre: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "admin-barrios";
  wb.lastModifiedBy = "admin-barrios";
  const hoja = wb.addWorksheet(hojaNombre.slice(0, 31));
  filas.forEach((f, i) => {
    const fila = hoja.addRow(f.map((c) => (i === 0 ? c : sanearTextoDePlanilla(c))));
    fila.eachCell((celda) => {
      celda.numFmt = "@";
    });
    if (i === 0) fila.font = { bold: true };
  });
  hoja.columns.forEach((col) => {
    col.width = 18;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
