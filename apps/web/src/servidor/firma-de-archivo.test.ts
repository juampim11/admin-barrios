import { describe, expect, it } from "vitest";
import { firmaCoincideConLaClave } from "./firma-de-archivo.ts";

const bytes = (...b: number[]) => Uint8Array.from(b);
const CLAVE = "barrios/x/gestiones/abc";

describe("la firma del adjunto contra la extensión de la clave", () => {
  it("acepta un PDF, un JPG y un PNG de verdad", () => {
    expect(firmaCoincideConLaClave(bytes(0x25, 0x50, 0x44, 0x46, 0x2d), `${CLAVE}.pdf`)).toBe(true);
    expect(firmaCoincideConLaClave(bytes(0xff, 0xd8, 0xff, 0xe0), `${CLAVE}.jpg`)).toBe(true);
    expect(firmaCoincideConLaClave(bytes(0xff, 0xd8, 0xff, 0xe1), `${CLAVE}.jpeg`)).toBe(true);
    expect(firmaCoincideConLaClave(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d), `${CLAVE}.png`)).toBe(true);
  });

  it("rechaza un PNG con extensión .pdf, un ejecutable y un archivo vacío", () => {
    expect(firmaCoincideConLaClave(bytes(0x89, 0x50, 0x4e, 0x47), `${CLAVE}.pdf`)).toBe(false);
    expect(firmaCoincideConLaClave(bytes(0x4d, 0x5a, 0x90, 0x00), `${CLAVE}.pdf`)).toBe(false);
    expect(firmaCoincideConLaClave(bytes(), `${CLAVE}.png`)).toBe(false);
  });

  it("rechaza una extensión fuera de la lista", () => {
    expect(firmaCoincideConLaClave(bytes(0x25, 0x50, 0x44, 0x46), `${CLAVE}.exe`)).toBe(false);
  });
});
