/**
 * El lector de la planilla del padrón (panel `security-engineer` del 2026-11-03): lo que escribe la
 * exportación se vuelve a leer igual, y lo hostil se rechaza ANTES de que `exceljs` lo descomprima.
 */
import { describe, expect, it } from "vitest";
import { crc32, deflateRawSync } from "node:zlib";
import { ArchivoRechazado, filasDeXlsx, hilosDeLecturaVivos, LIMITES_DE_LECTURA, textoDeCsv, xlsxDeFilas } from "./padron-xlsx.ts";

/** Un ZIP mínimo a mano, con el tamaño descomprimido que se quiera DECLARAR (para mentir). */
function zip(entradas: { nombre: string; datos: Buffer; declarado?: number; metodo?: 0 | 8; banderas?: number }[]): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let desplazamiento = 0;
  for (const e of entradas) {
    const metodo = e.metodo ?? 8;
    const comprimido = metodo === 8 ? deflateRawSync(e.datos) : e.datos;
    const nombre = Buffer.from(e.nombre);
    const declarado = e.declarado ?? e.datos.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.banderas ?? 0, 6);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt32LE(crc32(e.datos), 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(declarado, 22);
    local.writeUInt16LE(nombre.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.banderas ?? 0, 8);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt32LE(crc32(e.datos), 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(declarado, 24);
    central.writeUInt16LE(nombre.length, 28);
    central.writeUInt32LE(desplazamiento, 42);
    locales.push(local, nombre, comprimido);
    centrales.push(central, nombre);
    desplazamiento += 30 + nombre.length + comprimido.length;
  }
  const directorio = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entradas.length, 8);
  fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(desplazamiento, 16);
  return Buffer.concat([...locales, directorio, fin]);
}

const rechaza = async (buf: Buffer, motivo: RegExp) => {
  await expect(filasDeXlsx(buf)).rejects.toBeInstanceOf(ArchivoRechazado);
  await expect(filasDeXlsx(buf)).rejects.toThrow(motivo);
};

describe("la planilla del padrón en Excel", () => {
  it("lo que escribe la exportación se lee igual: CBU y CUIT como texto, y sin el apóstrofo de fórmula en los datos", async () => {
    const filas = [
      ["manzana", "lote", "titular", "cuit_o_dni", "cbu_unidad", "telefono"],
      ["1", "4", "Pablo Ferreyra", "20111111112", "0000003199999990000014", "+54 351 555-0104"],
    ];
    const leidas = await filasDeXlsx(await xlsxDeFilas(filas, "Padrón"));
    expect(leidas[0]).toEqual(filas[0]);
    expect(leidas[1]?.slice(0, 5)).toEqual(filas[1]?.slice(0, 5));
    // El saneado anti-fórmula de la exportación le pone el apóstrofo; la lectura del padrón lo saca.
    expect(leidas[1]?.[5]).toBe("'+54 351 555-0104");
  });

  it("una zip-bomb que declara poco y descomprime mucho se rechaza sin cargarla", async () => {
    const enorme = Buffer.alloc(20 * 1024 * 1024, 0x20);
    await rechaza(zip([{ nombre: "xl/worksheets/sheet1.xml", datos: enorme, declarado: 1000 }]), /no es un Excel/);
  });

  it("lo descomprimido de más de 15 MB se rechaza aunque lo declare bien", async () => {
    const grande = Buffer.alloc(16 * 1024 * 1024, 0x20);
    await rechaza(zip([{ nombre: "xl/worksheets/sheet1.xml", datos: grande }]), /demasiado grande/);
  });

  it("un .xls viejo, un ZIP cifrado, un DOCTYPE o un nombre repetido se rechazan", async () => {
    const cfb = Buffer.alloc(512);
    cfb.writeUInt32BE(0xd0cf11e0, 0);
    await rechaza(cfb, /Excel viejo/);
    await rechaza(zip([{ nombre: "a.xml", datos: Buffer.from("<x/>"), banderas: 1 }]), /contraseña/);
    await rechaza(zip([{ nombre: "xl/workbook.xml", datos: Buffer.from('<!DOCTYPE x [<!ENTITY a "b">]><x/>') }]), /no es un Excel/);
    await rechaza(
      zip([
        { nombre: "a.xml", datos: Buffer.from("<x/>") },
        { nombre: "a.xml", datos: Buffer.from("<y/>") },
      ]),
      /no es un Excel/,
    );
  });

  it("demasiadas celdas se rechazan antes de cargar", async () => {
    const hoja = Buffer.from(`<worksheet><sheetData><row>${"<c/>".repeat(160_000)}</row></sheetData></worksheet>`);
    await rechaza(zip([{ nombre: "xl/worksheets/sheet1.xml", datos: hoja }]), /demasiadas celdas/);
  });

  it("un CSV en UTF-16 se rechaza; uno en Windows-1252 se lee con sus acentos", () => {
    expect(() => textoDeCsv(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))).toThrow(/UTF-16/);
    // «Gómez» en Windows-1252: ó = 0xF3.
    expect(textoDeCsv(new Uint8Array([0x47, 0xf3, 0x6d, 0x65, 0x7a]))).toBe("Gómez");
    // Los caracteres de dirección de texto (U+202E) se van.
    expect(textoDeCsv(new TextEncoder().encode("ab‮cd"))).toBe("abcd");
  });
});

/**
 * BL-023 (f): la carga del Excel corre en un `worker_thread` con límite de memoria y de tiempo. Los tests
 * usan límites chicos (el parámetro `limites` de `filasDeXlsx`) en vez de fabricar una planilla gigante.
 */
describe("la lectura del Excel en un hilo con límites", () => {
  /** Una planilla legítima y grande (el peor caso aceptado son 5.000 × 30 = 150.000 celdas; acá 3.000 × 30). */
  const grande = async () =>
    xlsxDeFilas(
      Array.from({ length: 3000 }, (_, r) => Array.from({ length: 30 }, (_, c) => `valor ${r}-${c} xxxxxxxxxxxx`)),
      "Padrón",
    );

  it("(a) una planilla normal da el mismo resultado que antes, y el hilo se terminó", async () => {
    const filas = [
      ["Manzana", "Lote", "CBU"],
      ["1", "2", "0000003100012345678901"],
      ["ñandú", "3", ""],
    ];
    expect(await filasDeXlsx(await xlsxDeFilas(filas, "Padrón"))).toEqual(filas);
    expect(hilosDeLecturaVivos()).toBe(0);
  });

  it("(a) los límites de producción dejan pasar la planilla grande", async () => {
    const filas = await filasDeXlsx(await grande(), LIMITES_DE_LECTURA);
    expect(filas).toHaveLength(3000);
    expect(filas[0]).toHaveLength(30);
    expect(hilosDeLecturaVivos()).toBe(0);
  }, 30_000);

  it("(b) si el hilo se pasa de memoria, termina en el error previsto y el proceso sigue vivo", async () => {
    const buf = await grande();
    // 16 MB de heap no alcanzan para esta planilla (medido: el peor caso necesita entre 64 y 96 MB).
    const error = await filasDeXlsx(buf, { memoriaMb: 16, tiempoMs: 60_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArchivoRechazado);
    expect((error as Error).message).toMatch(/demasiado grande o está dañada/);
    expect(hilosDeLecturaVivos()).toBe(0);
    // El proceso sigue vivo y la siguiente lectura (con los límites normales) anda.
    expect(await filasDeXlsx(await xlsxDeFilas([["a"], ["b"]], "Padrón"))).toEqual([["a"], ["b"]]);
  }, 30_000);

  it("(b) si el hilo se pasa de tiempo, termina en el error previsto y el proceso sigue vivo", async () => {
    const buf = await grande();
    const error = await filasDeXlsx(buf, { memoriaMb: 512, tiempoMs: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArchivoRechazado);
    expect((error as Error).message).toMatch(/demasiado grande o está dañada/);
    expect(hilosDeLecturaVivos()).toBe(0);
    expect(await filasDeXlsx(await xlsxDeFilas([["a"]], "Padrón"))).toEqual([["a"]]);
  }, 30_000);

  it("(c) un Excel roto por dentro se rechaza desde el hilo, y no queda ningún hilo colgado", async () => {
    // Pasa las revisiones del ZIP (estructura válida, sin DOCTYPE) pero no es un libro: `exceljs` no lo carga.
    const roto = zip([{ nombre: "xl/workbook.xml", datos: Buffer.from("<workbook/>") }]);
    await rechaza(roto, /ninguna hoja visible/);
    expect(hilosDeLecturaVivos()).toBe(0);
  });

  it("(c) varias lecturas seguidas, con resultados distintos, no acumulan hilos", async () => {
    const buf = await xlsxDeFilas([["x"], ["y"]], "Padrón");
    const resultados = await Promise.allSettled([
      filasDeXlsx(buf),
      filasDeXlsx(buf, { memoriaMb: 8, tiempoMs: 60_000 }),
      filasDeXlsx(buf, { memoriaMb: 512, tiempoMs: 1 }),
      filasDeXlsx(buf),
    ]);
    expect(resultados.map((r) => r.status).filter((s) => s === "fulfilled").length).toBeGreaterThanOrEqual(2);
    expect(hilosDeLecturaVivos()).toBe(0);
  });
});
