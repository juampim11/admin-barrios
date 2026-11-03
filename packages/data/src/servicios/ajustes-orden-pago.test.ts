import { describe, expect, it } from "vitest";
import { compensarAjustesDeOrdenPago, textoDeAnulacion, type GastoLeido } from "./ajustes-orden-pago.ts";

const base = { tipo: "ordinaria" as const, esFondoReserva: false, sinRespaldoAsamblea: false };
const gasto = (gastoId: string, conceptoId: string, monto: string, descripcion = gastoId): GastoLeido => ({
  ...base,
  gastoId,
  conceptoId,
  descripcion,
  monto,
  conceptoNombre: conceptoId === "c1" ? "Mantenimiento" : "Seguridad",
  ajusteDeOrdenPago: null,
});
const ajuste = (gastoId: string, conceptoId: string, monto: string, numeroFactura: string | null = "F-1"): GastoLeido => ({
  ...gasto(gastoId, conceptoId, monto),
  ajusteDeOrdenPago: { ordenPagoId: `op-${gastoId}`, proveedor: "Jardines SRL", numeroFactura },
});

describe("compensarAjustesDeOrdenPago", () => {
  it("sin ajustes devuelve los gastos tal cual", () => {
    const r = compensarAjustesDeOrdenPago([gasto("g1", "c1", "100.00"), gasto("g2", "c2", "50.00")]);
    expect(r).toEqual({ ok: true, gastos: [expect.objectContaining({ gastoId: "g1", monto: "100.00", descripcion: "g1" }), expect.objectContaining({ gastoId: "g2", monto: "50.00" })] });
  });

  it("descuenta del gasto más grande del concepto y no toca los de otros conceptos", () => {
    const r = compensarAjustesDeOrdenPago([
      gasto("chico", "c1", "20.00"),
      gasto("grande", "c1", "80.00"),
      gasto("otro", "c2", "500.00"),
      ajuste("a", "c1", "-30.00"),
    ]);
    if (!r.ok) throw new Error("no tenía que rechazar");
    expect(r.gastos.map((g) => [g.gastoId, g.monto])).toEqual([
      ["chico", "20.00"],
      ["grande", "50.00"],
      ["otro", "500.00"],
    ]);
    expect(r.gastos[1]!.descripcion).toBe("grande (se descontaron $ 30,00 por la anulación de la OP de Jardines SRL, factura F-1)");
  });

  it("si un gasto no alcanza sigue con el siguiente, y el que queda en cero no se reparte", () => {
    const r = compensarAjustesDeOrdenPago([gasto("g1", "c1", "60.00"), gasto("g2", "c1", "40.00"), ajuste("a", "c1", "-70.00")]);
    if (!r.ok) throw new Error("no tenía que rechazar");
    expect(r.gastos.map((g) => [g.gastoId, g.monto])).toEqual([["g2", "30.00"]]);
  });

  it("lo repartido es la suma de los gastos con el ajuste incluido (lo que cuadra al emitir)", () => {
    const leidos = [gasto("g1", "c1", "100.00"), gasto("g2", "c2", "10.00"), ajuste("a", "c1", "-33.33"), ajuste("b", "c1", "-0.67")];
    const r = compensarAjustesDeOrdenPago(leidos);
    if (!r.ok) throw new Error("no tenía que rechazar");
    expect(r.gastos.map((g) => g.monto)).toEqual(["66.00", "10.00"]);
  });

  it("si el concepto queda en negativo rechaza, con la orden, el proveedor, el concepto y lo que falta", () => {
    const r = compensarAjustesDeOrdenPago([gasto("g1", "c1", "10.00"), gasto("g2", "c2", "999.00"), ajuste("a", "c1", "-50.00", null)]);
    expect(r).toEqual({
      ok: false,
      ordenPagoId: "op-a",
      proveedor: "Jardines SRL",
      numeroFactura: null,
      concepto: "Mantenimiento",
      faltante: "40.00",
    });
  });

  it("en cuota fija, un ajuste ordinario que supera su concepto no rechaza (las ordinarias no se cobran)", () => {
    const r = compensarAjustesDeOrdenPago([gasto("g1", "c1", "10.00"), ajuste("a", "c1", "-50.00")], "fija");
    expect(r).toEqual({ ok: true, gastos: [] });
    const extra = { ...ajuste("b", "c1", "-50.00"), tipo: "extraordinaria" as const };
    expect(compensarAjustesDeOrdenPago([{ ...gasto("g1", "c1", "10.00"), tipo: "extraordinaria" }, extra], "fija").ok).toBe(false);
  });

  it("nombra el ajuste sin el id de la orden", () => {
    expect(textoDeAnulacion("Jardines SRL", "0001-00001234")).toBe("Anulación de la OP de Jardines SRL, factura 0001-00001234");
    expect(textoDeAnulacion("Jardines SRL", null)).toBe("Anulación de la OP de Jardines SRL, sin número de factura");
  });
});
