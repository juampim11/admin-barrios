/**
 * El único lector de fechas y meses de una planilla (encargo 17b). Los formatos de acá son los que
 * dejó Excel en castellano al guardar los archivos de `apps/web/src/servidor/planilla/fixtures/`
 * (`excel.test.ts` los lee enteros).
 */
import { describe, expect, it } from "vitest";
import { leerFechaDePlanilla, leerMesDePlanilla } from "./fechas-de-planilla.ts";

describe("el mes de una celda", () => {
  it("mm/aaaa, m/aaaa, mm-aaaa y aaaa-mm", () => {
    expect(["08/2026", "8/2026", "12-2025", "2026-08", " 09/2026 "].map(leerMesDePlanilla)).toEqual(["2026-08", "2026-08", "2025-12", "2026-08", "2026-09"]);
  });

  it("el mes abreviado en castellano, con el año de dos o de cuatro cifras, como lo deja Excel en un CSV", () => {
    expect(["ago-26", "sept-26", "sep-2026", "oct-2026", "Ene-27", "DIC-26", "set-26"].map(leerMesDePlanilla)).toEqual([
      "2026-08", "2026-09", "2026-09", "2026-10", "2027-01", "2026-12", "2026-09",
    ]);
    // Con punto, con espacio, con barra o con el nombre entero.
    expect(["ago.-26", "ago 2026", "ago/26", "agosto 2026", "Agosto de 2026", "setiembre-26"].map(leerMesDePlanilla)).toEqual([
      "2026-08", "2026-08", "2026-08", "2026-08", "2026-08", "2026-09",
    ]);
    const abreviados = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    expect(abreviados.map((m) => leerMesDePlanilla(`${m}-26`))).toEqual(abreviados.map((_, i) => `2026-${String(i + 1).padStart(2, "0")}`));
  });

  it("una celda de fecha: de la fecha completa o de su número de serie se toma el mes", () => {
    expect(["2026-08-01", "2026-08-15T00:00:00.000Z", "1/8/2026", "15/08/26", "46296", "46235"].map(leerMesDePlanilla)).toEqual([
      "2026-08", "2026-08", "2026-08", "2026-08", "2026-10", "2026-08",
    ]);
  });

  it("lo que no es un mes no se adivina", () => {
    // «08/26»: ¿agosto de 2026 o el 8 del mes 26? Con el mes en números, el año va entero.
    for (const malo of ["", "13/2026", "0/2026", "08/26", "2026/08", "08/1999", "=A1", "agu-26", "ago-6", "ago", "26-ago", "7", "172000", "31/02/2026", "ago-26-27"]) {
      expect([malo, leerMesDePlanilla(malo)]).toEqual([malo, null]);
    }
  });
});

describe("la fecha de una celda", () => {
  it("dd/mm/aaaa, d/m/aaaa y dd/mm/aa: día primero", () => {
    expect(["10/08/2026", "10/8/2026", "1/8/2026", "10/10/26", "8/11/26", "10-08-2026", "10.08.2026"].map(leerFechaDePlanilla)).toEqual([
      "2026-08-10", "2026-08-10", "2026-08-01", "2026-10-10", "2026-11-08", "2026-08-10", "2026-08-10",
    ]);
  });

  it("la celda de fecha: fecha completa (con o sin hora) y número de serie", () => {
    expect(["2026-08-10", "2026-08-10T00:00:00.000Z", "2026-08-10 00:00:00", "10/8/2026 0:00", "10/08/2026 00:00:00"].map(leerFechaDePlanilla)).toEqual(
      Array.from({ length: 5 }, () => "2026-08-10"),
    );
    // Los que guardó Excel: 46296 = 1/10/2026, 46305 = 10/10/2026, 46329 = 3/11/2026.
    expect(["46296", "46305", "46329", "36526", "73415"].map(leerFechaDePlanilla)).toEqual([
      "2026-10-01", "2026-10-10", "2026-11-03", "2000-01-01", "2100-12-31",
    ]);
    // Un mes escrito sin separador («082026», «102026») no es un número de serie de este siglo.
    expect(["082026", "102026", "73416"].map(leerFechaDePlanilla)).toEqual([null, null, null]);
    // Con decimales no es un número de serie: es mucho más probable un importe en la columna equivocada.
    expect(["46305,5", "46305.75", "46296,00"].map(leerFechaDePlanilla)).toEqual([null, null, null]);
  });

  it("la fecha tiene que existir, y un número cualquiera no es una fecha", () => {
    expect(leerFechaDePlanilla("29/02/2024")).toBe("2024-02-29");
    for (const mala of ["29/02/2025", "31/04/2026", "00/01/2026", "15/13/2026", "2026-02-30", "32/01/2026", "", "1/1/1999", "=HOY()", "2026-11-081", "36525", "109940", "73416", "7", "172000", "1234567", "ago-26", "ayer"]) {
      expect([mala, leerFechaDePlanilla(mala)]).toEqual([mala, null]);
    }
  });
});
