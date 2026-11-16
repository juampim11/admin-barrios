import { describe, expect, it } from "vitest";
import { lecturaDeLaCuenta, lecturaDeLosPapeles, quienesLoDeben, sobranteDelMes } from "./textos.ts";

describe("los textos del resultado del mes", () => {
  it("en los papeles: más, menos o lo mismo", () => {
    expect(lecturaDeLosPapeles("545000.00")).toBe("Se pidió más de lo que se gastó");
    expect(lecturaDeLosPapeles("-0.01")).toBe("Se gastó más de lo que se pidió");
    expect(lecturaDeLosPapeles("0.00")).toBe("Se pidió lo mismo que se gastó");
  });

  it("en la cuenta: más, menos o lo mismo", () => {
    expect(lecturaDeLaCuenta("0.01")).toBe("Entró más de lo que salió");
    expect(lecturaDeLaCuenta("-285000.00")).toBe("Salió más de lo que entró");
    expect(lecturaDeLaCuenta("0.00")).toBe("Entró lo mismo que salió");
  });

  it("cuántas unidades deben", () => {
    expect(quienesLoDeben(0)).toBe("Ninguna unidad lo debe");
    expect(quienesLoDeben(1)).toBe("1 unidad lo debe");
    expect(quienesLoDeben(5)).toBe("5 unidades lo deben");
  });

  it("el sobrante: solo el texto, con el monto si lo hubo", () => {
    expect(sobranteDelMes("2026-11", "-285000.00")).toBe("Noviembre no dejó sobrante en la cuenta.");
    expect(sobranteDelMes("2026-11", "0.00")).toBe("Noviembre no dejó sobrante en la cuenta.");
    const hubo = sobranteDelMes("2026-10", "120000.50");
    expect(hubo.startsWith("Octubre dejó $ 120.000,50 en la cuenta")).toBe(true);
    expect(hubo).toContain("se va a poder decidir acá más adelante");
  });
});
