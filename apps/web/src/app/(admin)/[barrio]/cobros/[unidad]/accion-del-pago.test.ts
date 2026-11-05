import { describe, expect, it } from "vitest";
import { accionDelPago } from "./accion-del-pago.ts";

const OPERADOR = { puedeAnular: true, puedeAnularConCondonacion: false };
const ADMINISTRACION = { puedeAnular: true, puedeAnularConCondonacion: true };
const CONTADOR = { puedeAnular: false, puedeAnularConCondonacion: false };

describe("la columna «Acciones» de un pago (encargo 11; ensayo de T2)", () => {
  it("un operador frente a un pago con interés condonado ve «Lo anula un administrador…», no «Anular»", () => {
    expect(accionDelPago({ interesCondonado: "3533.51", anulado: false }, OPERADOR)).toBe("lo_anula_un_administrador");
  });
  it("la administración sí lo anula", () => {
    expect(accionDelPago({ interesCondonado: "3533.51", anulado: false }, ADMINISTRACION)).toBe("anular");
  });
  it("un pago sin condonación lo anula también el operador", () => {
    expect(accionDelPago({ interesCondonado: "0.00", anulado: false }, OPERADOR)).toBe("anular");
  });
  it("quien no anula pagos, o un pago ya anulado, no tiene acción", () => {
    expect(accionDelPago({ interesCondonado: "3533.51", anulado: false }, CONTADOR)).toBeNull();
    expect(accionDelPago({ interesCondonado: "0.00", anulado: true }, ADMINISTRACION)).toBeNull();
  });
});
