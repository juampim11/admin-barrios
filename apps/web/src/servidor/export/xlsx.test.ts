import { describe, expect, it } from "vitest";
import { serializarLibro } from "./xlsx.ts";
import type { LibroParaPlanilla } from "./dataset.ts";

/**
 * Humo del serializador: que el cableado con `exceljs` funcione de punta a punta y produzca un
 * workbook real.
 *
 * **Este archivo NO abre el resultado, y no es pereza.** La regla EX-4 del gate prohíbe parsear un
 * `.xlsx` en todo el repo: `exceljs` entró para escribir, y leer un workbook es otro modelo de
 * amenaza (zip-bomb, XML hostil) que necesita su propio panel. Un test que hiciera `xlsx.load()`
 * para inspeccionar celdas sería el primer llamador de esa capacidad, y el gate lo rechazaría — con
 * razón.
 *
 * Lo que sí se verifica es la **firma del archivo**: un `.xlsx` es un ZIP, y todo ZIP empieza con los
 * bytes `PK`. Alcanza para saber que la librería corrió y escribió un contenedor válido. La lógica
 * —qué va en cada celda y con qué tipo— vive en `dataset.ts` y se prueba ahí, donde es dato puro y
 * se puede leer sin abrir nada.
 */

const LIBRO: LibroParaPlanilla = {
  nombreArchivo: "movimientos_prueba.xlsx",
  hojas: [
    {
      nombre: "Cobranzas (percibido)",
      bloquePrevio: ["Libro de movimientos — Barrio de prueba", "Extraído el: 2026-08-26T12:00:00Z"],
      columnas: [
        { header: "Fecha de pago", tipo: "fecha" },
        { header: "CUIT/CUIL", tipo: "identificador" },
        { header: "Importe cobrado", tipo: "monto" },
        { header: "Motivo", tipo: "texto" },
        { header: "Fondo de reserva", tipo: "bool" },
      ],
      filas: [
        ["2026-07-10", "27123456789", 1234.56, "'=1+1", true],
        ["2026-07-11", null, -4500, "Reversión", false],
      ],
      bloquePosterior: ["Total cobrado: 1234.56"],
    },
    {
      // Más largo que el máximo de Excel: el serializador tiene que recortarlo, no explotar.
      nombre: "Una solapa con un nombre larguísimo que Excel no acepta entero",
      bloquePrevio: [],
      columnas: [{ header: "Valor", tipo: "texto" }],
      filas: [["x"]],
      bloquePosterior: [],
    },
  ],
};

describe("serializarLibro", () => {
  it("produce un workbook con la firma de un ZIP", async () => {
    const bytes = await serializarLibro(LIBRO);
    expect(bytes.length).toBeGreaterThan(0);
    // `PK` — todo `.xlsx` es un contenedor ZIP.
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("no se cae con celdas nulas, montos negativos ni nombres de solapa demasiado largos", async () => {
    await expect(serializarLibro(LIBRO)).resolves.toBeInstanceOf(Buffer);
  });

  it("un libro sin filas sigue produciendo un archivo abrible", async () => {
    const vacio: LibroParaPlanilla = {
      nombreArchivo: "vacio.xlsx",
      hojas: [{ nombre: "Egresos", bloquePrevio: [], columnas: [{ header: "Período", tipo: "texto" }], filas: [], bloquePosterior: [] }],
    };
    const bytes = await serializarLibro(vacio);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  });
});
