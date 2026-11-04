import { describe, expect, it } from "vitest";
import {
  listoDeLaAnulacion,
  listoDeLaCondonacion,
  listoDelPago,
  resumenDeAnulacion,
  type ImputacionDePago,
} from "./textos-de-cobros.ts";

/** El pago del ensayo del titular (encargo 10, BL-030 b). */
const PAGO: ImputacionDePago = {
  monto: "353902.48",
  fecha: "2026-11-04",
  aCapital: "351420.61",
  aInteres: "2481.87",
  interesCondonado: "0.00",
};

describe("«Listo:» del estado de cuenta (BL-030 b)", () => {
  it("el pago, en una sola línea: importe, fecha, capital e interés", () => {
    expect(listoDelPago(PAGO)).toBe(
      "Listo: se registró el pago de $ 353.902,48 del 04/11/2026: $ 351.420,61 a capital y $ 2.481,87 a interés.",
    );
  });

  it("con «No cobrar interés», agrega lo no cobrado antes del punto", () => {
    expect(listoDelPago({ ...PAGO, aCapital: "353902.48", aInteres: "0.00", interesCondonado: "2481.87" })).toBe(
      "Listo: se registró el pago de $ 353.902,48 del 04/11/2026: $ 353.902,48 a capital y $ 0,00 a interés, $ 2.481,87 de interés no cobrado.",
    );
  });

  it("la condonación, en una sola línea", () => {
    expect(listoDeLaCondonacion("15.00")).toBe("Listo: se condonaron $ 15,00 de interés de esta unidad.");
  });

  it("la anulación nombra el pago", () => {
    expect(listoDeLaAnulacion(PAGO)).toMatch(/^Listo: se anuló el pago de \$ 353\.902,48 del 04\/11\/2026/);
  });
});

describe("diálogo de anular un pago (BL-029)", () => {
  it("dice el importe, cómo se imputó y el saldo antes y después", () => {
    const r = resumenDeAnulacion(PAGO, "1000.00");
    expect(r.titulo).toBe("¿Anular el pago de $ 353.902,48 del 04/11/2026?");
    expect(r.lineas).toEqual([
      "Importe del pago: $ 353.902,48, del 04/11/2026.",
      "Se imputó $ 351.420,61 a capital y $ 2.481,87 a interés: las dos imputaciones se anulan con el pago.",
    ]);
    // Después de anular, la base devuelve a `saldo_uf` lo imputado: 1000 + 351420,61 + 2481,87.
    expect(r.saldoAntes).toBe("1000.00");
    expect(r.saldoDespues).toBe("354902.48");
  });

  it("si el pago se registró con «No cobrar interés», dice que esa condonación también se anula y la suma", () => {
    const r = resumenDeAnulacion({ ...PAGO, aInteres: "0.00", aCapital: "353902.48", interesCondonado: "15.00" }, "0.00");
    expect(r.lineas).toHaveLength(3);
    expect(r.lineas[2]).toMatch(/condonaron \$ 15,00 de interés .*esa condonación también se anula/);
    expect(r.saldoDespues).toBe("353917.48");
  });
});
