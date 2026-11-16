/**
 * Las planillas **como las deja Excel en castellano** (encargo 17b). Los archivos de `fixtures/` los
 * guardó Excel 16 con configuración es-AR (separador de listas `;`, coma decimal), no este repo:
 *
 *   · `deuda-excel.xlsx` / `usos-excel.xlsx`: el libro, con celdas de fecha de verdad —con formato
 *     «mmm-aa», «mmm-aaaa», «d/m/aaaa», «dd/mm/aa» y «General» (ahí se ve el número de serie)— y los
 *     importes como números;
 *   · `*-excel.csv`: el mismo libro con «Guardar como → CSV (delimitado por comas)»: sale en
 *     Windows-1252, con `;`, y cada celda **como se ve** («ago-26», «sept-26», «10/10/26», «72500,5»);
 *   · `*-excel-utf8.csv`: lo mismo con «CSV UTF-8», que agrega el BOM.
 *
 * Los tres tienen que leerse igual. Es lo que falló en el ensayo: la planilla de deuda rechazaba el mes
 * «ago-26».
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { leerPlanillaDeDeuda } from "@admin-barrios/shared/activacion";
import { leerPlanillaUsos } from "@admin-barrios/shared/conceptos";
import { filasDeCsv } from "@admin-barrios/shared/padron";
import { filasDeXlsx, textoDeCsv } from "./padron-xlsx.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
const archivo = (nombre: string) => readFileSync(resolve(aqui, "fixtures", nombre));
const leer = async (nombre: string): Promise<string[][]> =>
  nombre.endsWith(".xlsx") ? filasDeXlsx(archivo(nombre)) : filasDeCsv(textoDeCsv(new Uint8Array(archivo(nombre))));

describe("la planilla de deuda guardada por Excel", () => {
  it("el CSV trae cada celda como se ve: el mes abreviado, el año de dos cifras y el número de serie", async () => {
    const filas = await leer("deuda-excel.csv");
    expect(filas.map((f) => f[2])).toEqual(["mes", "ago-26", "oct-26", "oct-2026", "sept-26", "46296", "09/2026", ""]);
    expect(filas.map((f) => f[4])).toEqual(["vencimiento", "10/8/2026", "10/10/26", "10/10/2026", "10/9/2026", "46305", "25/9/2026", ""]);
    expect(filas[3]![5]).toBe("72500,5");
  });

  for (const nombre of ["deuda-excel.xlsx", "deuda-excel.csv", "deuda-excel-utf8.csv"]) {
    it(`${nombre}: se lee entera, sin errores, con el mes y el vencimiento de cada renglón`, async () => {
      const { deudas, aFavor, errores } = leerPlanillaDeDeuda(await leer(nombre));
      expect(errores).toEqual([]);
      expect(deudas.map((d) => `${d.manzana}-${d.lote} ${d.periodo} ${d.concepto} ${d.vencimiento} ${d.importe}`)).toEqual([
        "1-7 2026-08 Expensa 2026-08-10 172000.00",
        "1-7 2026-10 Expensa 2026-10-10 185000.00",
        "1-3 2026-10 Expensa 2026-10-10 72500.50",
        "2-4 2026-09 Expensa 2026-09-10 178000.00",
        "1-5 2026-10 Expensa 2026-10-10 185000.00", // las dos celdas con formato «General»: número de serie
        "2-4 2026-09 Obra de la red de agua 2026-09-25 60000.00", // el mes tipeado como texto «09/2026»
      ]);
      expect(aFavor.map((f) => `${f.manzana}-${f.lote} ${f.importe}`)).toEqual(["2-6 18000.00"]);
    });
  }
});

describe("la planilla de usos guardada por Excel", () => {
  for (const nombre of ["usos-excel.xlsx", "usos-excel.csv", "usos-excel-utf8.csv"]) {
    it(`${nombre}: la fecha se lee de la celda de fecha, del año de dos cifras y del número de serie`, async () => {
      const { usos, errores } = leerPlanillaUsos(await leer(nombre));
      expect(errores).toEqual([]);
      expect(usos.map((u) => `${u.manzana}-${u.lote} ${u.concepto} ${u.fecha} ${u.cantidad}`)).toEqual([
        "1-4 Cancha de pádel 2026-11-08 1",
        "2-15 Uso del club house 2026-11-22 1.5",
        "3-1 Cancha de pádel 2026-11-03 2",
      ]);
    });
  }
});
