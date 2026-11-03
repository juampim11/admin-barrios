/**
 * El lector de la planilla del padrón (panel `security-engineer` del 2026-11-03): lo que escribe la
 * exportación se vuelve a leer igual, y lo hostil se rechaza ANTES de que `exceljs` lo descomprima.
 */
import { describe, expect, it } from "vitest";
import { crc32, deflateRawSync } from "node:zlib";
import { ArchivoRechazado, filasDeXlsx, textoDeCsv, xlsxDeFilas } from "./padron-xlsx.ts";

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
