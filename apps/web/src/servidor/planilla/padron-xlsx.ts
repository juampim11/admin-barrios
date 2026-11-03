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
 * Pendiente anotado (ADR-0010 §9): correr la lectura en un `worker_thread` con `resourceLimits`. Con
 * los topes de arriba, el peor caso aceptado son ~150.000 celdas.
 */

import { inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { MAX_FILAS_PADRON } from "@admin-barrios/shared/padron";
import { sanearTextoDePlanilla } from "@admin-barrios/shared/planilla";

export const MAX_BYTES_PLANILLA = 5 * 1024 * 1024;
const MAX_ENTRADAS_ZIP = 500;
const MAX_DESCOMPRIMIDO = 15 * 1024 * 1024;
const MAX_CELDAS = 150_000;
const MAX_TEXTOS_COMPARTIDOS = 150_000;
const MAX_COLUMNAS = 20;
const MAX_CELDA = 300;

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

/** Caracteres de control y de dirección de texto: no aportan nada a un dato y pueden disfrazarlo. */
const INVISIBLES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮⁦-⁩]/g;

/** Una celda de exceljs → texto, sin evaluar nada. */
function textoDeCelda(valor: ExcelJS.CellValue): string {
  if (valor === null || valor === undefined) return "";
  if (typeof valor === "string") return valor;
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) return "";
    // Un número de más de 15 cifras perdió precisión en el double (un CBU guardado como número):
    // se devuelve algo que la validación rechaza con el motivo, en vez de un dato corrido.
    if (Math.abs(valor) >= 1e15) return "(número demasiado largo: guardá esa columna como texto)";
    return String(valor);
  }
  if (typeof valor === "boolean") return valor ? "sí" : "";
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? "" : valor.toISOString().slice(0, 10);
  if (typeof valor === "object") {
    if ("richText" in valor && Array.isArray(valor.richText)) return valor.richText.map((r) => r.text).join("");
    if ("formula" in valor || "sharedFormula" in valor) {
      const resultado = (valor as { result?: ExcelJS.CellValue }).result;
      return resultado === undefined || (typeof resultado === "object" && resultado !== null && "error" in resultado) ? "" : textoDeCelda(resultado);
    }
    if ("text" in valor && typeof valor.text === "string") return valor.text;
  }
  return "";
}

const limpiar = (t: string) => t.normalize("NFC").replace(INVISIBLES, "").trim().slice(0, MAX_CELDA);

/** Una lectura por vez en el proceso (ver la cabecera). */
let semaforo: Promise<unknown> = Promise.resolve();

/**
 * Lee un `.xlsx` y devuelve sus filas como texto (la primera es el encabezado). Lanza
 * `ArchivoRechazado` si el archivo no pasa las revisiones o tiene más filas que el tope.
 */
export function filasDeXlsx(buf: Buffer): Promise<string[][]> {
  const lectura = semaforo.then(async () => {
    if (buf.length > MAX_BYTES_PLANILLA) throw new ArchivoRechazado("El archivo pasa de 5 MB: partilo en varios.");
    revisarZip(buf);
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
    } catch {
      throw new ArchivoRechazado(NO_ES_XLSX);
    }
    const hoja = wb.worksheets.find((h) => h.state === "visible");
    if (!hoja) throw new ArchivoRechazado("El Excel no tiene ninguna hoja visible.");
    if (hoja.rowCount > MAX_FILAS_PADRON + 1) throw new ArchivoRechazado("La planilla tiene más de 5.000 filas: partila en varias.");
    const filas: string[][] = [];
    for (let r = 1; r <= hoja.rowCount; r++) {
      const fila = hoja.getRow(r);
      const celdas: string[] = [];
      const columnas = Math.min(fila.cellCount, MAX_COLUMNAS);
      for (let c = 1; c <= columnas; c++) celdas.push(limpiar(textoDeCelda(fila.getCell(c).value)));
      filas.push(celdas);
    }
    return filas;
  });
  semaforo = lectura.catch(() => undefined);
  return lectura;
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
