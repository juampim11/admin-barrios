/**
 * **El ZIP tiene que ser reproducible, o el `sha256` que guardamos no significa nada.**
 *
 * Es la propiedad que este archivo existe para fijar, y es fácil de perder sin darse cuenta: basta
 * que alguien cambie el `mtime` por `new Date()` —que es lo natural de escribir— para que dos
 * empaquetados del mismo contenido den archivos distintos. El código sigue funcionando, el ZIP se
 * abre bien, y lo único que se rompe es que el hash deja de acreditar el contenido y pasa a
 * acreditar una corrida. Ningún otro test lo notaría.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { armarZipDeterministico, type EntradaDeZip } from "./paquete.ts";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const ENTRADAS: EntradaDeZip[] = [
  { nombre: "MZ-1-LOTE-1.pdf", contenido: Buffer.from("%PDF-1.7 boleta uno") },
  { nombre: "MZ-1-LOTE-2.pdf", contenido: Buffer.from("%PDF-1.7 boleta dos") },
  { nombre: "MZ-2-LOTE-10.pdf", contenido: Buffer.from("%PDF-1.7 boleta tres") },
];

describe("el ZIP es reproducible", () => {
  it("dos armados de las mismas entradas dan el MISMO hash", async () => {
    const primero = await armarZipDeterministico(ENTRADAS);
    // Con un `mtime` tomado del reloj, estos dos hashes difieren y nadie se entera.
    const segundo = await armarZipDeterministico(ENTRADAS);
    expect(hash(primero)).toBe(hash(segundo));
  });

  it("y siguen dando el mismo aunque pase el tiempo entre uno y otro", async () => {
    const primero = await armarZipDeterministico(ENTRADAS);
    await new Promise((r) => setTimeout(r, 1100));
    const segundo = await armarZipDeterministico(ENTRADAS);
    expect(hash(primero)).toBe(hash(segundo));
  });

  /**
   * El orden es parte del contenido: si cambia, el archivo es otro. Por eso la consulta que arma la
   * lista lleva un `order by` explícito por manzana y lote, y no confía en el orden natural.
   */
  it("un orden distinto da un archivo distinto", async () => {
    const enOrden = await armarZipDeterministico(ENTRADAS);
    const invertido = await armarZipDeterministico([...ENTRADAS].reverse());
    expect(hash(enOrden)).not.toBe(hash(invertido));
  });

  it("un contenido distinto da un archivo distinto", async () => {
    const original = await armarZipDeterministico(ENTRADAS);
    const cambiado = await armarZipDeterministico([
      ...ENTRADAS.slice(0, 2),
      { nombre: "MZ-2-LOTE-10.pdf", contenido: Buffer.from("%PDF-1.7 otra cosa") },
    ]);
    expect(hash(original)).not.toBe(hash(cambiado));
  });

  it("produce un ZIP de verdad, con su firma", async () => {
    const bytes = await armarZipDeterministico(ENTRADAS);
    // `PK\x03\x04`: el encabezado de una entrada local de ZIP.
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("un paquete sin entradas sigue siendo un ZIP válido", async () => {
    const bytes = await armarZipDeterministico([]);
    // El ZIP vacío es solo su directorio central: empieza con `PK\x05\x06`. Que no explote importa
    // porque el guard de "no hay boletas" vive en la base y en el trabajo, no acá.
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  });
});
