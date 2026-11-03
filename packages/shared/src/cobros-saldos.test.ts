/**
 * `resumirSaldosPendientes`: la misma cifra para el tablero y para Cobros. Un saldo a favor no es
 * deuda y no resta del total; un saldo en cero no cuenta.
 */
import { describe, expect, it } from "vitest";
import { resumirSaldosPendientes } from "./cobros.ts";

describe("resumirSaldosPendientes", () => {
  it("cuenta solo los saldos mayores a cero y los suma al centavo", () => {
    const saldos = [
      { id: "a", saldoActual: "1500.10" },
      { id: "b", saldoActual: "0.00" },
      { id: "c", saldoActual: "-200.00" },
      { id: "d", saldoActual: "0.05" },
    ];
    const { conSaldo, total } = resumirSaldosPendientes(saldos);
    expect(conSaldo.map((s) => s.id)).toEqual(["a", "d"]);
    expect(total).toBe("1500.15");
  });

  it("sin saldos pendientes, el total es cero (no vacío)", () => {
    expect(resumirSaldosPendientes([{ saldoActual: "0.00" }]).total).toBe("0.00");
    expect(resumirSaldosPendientes([]).total).toBe("0.00");
  });
});
