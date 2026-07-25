import { describe, expect, it } from "vitest";
import { sumarMontos } from "./dinero.ts";
import {
  calcularLiquidacion,
  calcularMora,
  transicionValida,
  type GastoDelPeriodo,
  type UnidadAPRorratear,
} from "./liquidacion.ts";

const GASTOS: GastoDelPeriodo[] = [
  { gastoId: "g1", conceptoId: "c1", descripcion: "Seguridad", tipo: "ordinaria", esFondoReserva: false, monto: "4500000.00" },
  { gastoId: "g2", conceptoId: "c2", descripcion: "Mantenimiento de espacios verdes", tipo: "ordinaria", esFondoReserva: false, monto: "1234567.89" },
  { gastoId: "g3", conceptoId: "c3", descripcion: "Portón de acceso (asamblea 12/07)", tipo: "extraordinaria", esFondoReserva: false, monto: "980000.00" },
  { gastoId: "g4", conceptoId: "c4", descripcion: "Fondo de reserva", tipo: "ordinaria", esFondoReserva: true, monto: "500000.00" },
];

/** 37 unidades con coeficientes despatarrados: el caso que rompe los redondeos ingenuos. */
const UNIDADES: UnidadAPRorratear[] = Array.from({ length: 37 }, (_, i) => ({
  unidadFuncionalId: `uf-${i}`,
  coeficiente: (0.02 + (i % 11) * 0.003).toFixed(9),
}));

describe("liquidación del período", () => {
  it("lo repartido es EXACTAMENTE igual al gasto del período", () => {
    const { totalGastos, totalRepartido } = calcularLiquidacion(GASTOS, UNIDADES);
    expect(totalRepartido).toBe(totalGastos);
    expect(totalGastos).toBe("7214567.89");
  });

  it("cada unidad recibe una línea por gasto, con su origen", () => {
    const { liquidaciones } = calcularLiquidacion(GASTOS, UNIDADES);
    const primera = liquidaciones[0];
    expect(primera?.items).toHaveLength(GASTOS.length);
    expect(primera?.items[0]).toMatchObject({
      gastoId: "g1",
      descripcion: "Seguridad",
      baseMonto: "4500000.00",
    });
    // El total de la unidad es la suma de sus líneas: nada aparece de la nada.
    expect(sumarMontos(...(primera?.items.map((i) => i.monto) ?? []))).toBe(primera?.total);
  });

  it("separa fondo de reserva, ordinarias y extraordinarias", () => {
    const { liquidaciones } = calcularLiquidacion(GASTOS, UNIDADES);
    for (const liq of liquidaciones) {
      expect(sumarMontos(liq.subtotalOrdinarias, liq.subtotalExtraordinarias, liq.subtotalFondoReserva)).toBe(
        liq.total,
      );
    }
    // El fondo del barrio entero es el gasto del fondo: no se mezcla con las ordinarias.
    const fondo = sumarMontos(...liquidaciones.map((l) => l.subtotalFondoReserva));
    expect(fondo).toBe("500000.00");
    const extraordinarias = sumarMontos(...liquidaciones.map((l) => l.subtotalExtraordinarias));
    expect(extraordinarias).toBe("980000.00");
  });

  it("una unidad con coeficiente chiquito igual recibe su parte (nadie liquida en cero por redondeo)", () => {
    const { liquidaciones } = calcularLiquidacion(
      [{ gastoId: "g", conceptoId: "c", descripcion: "Gasto", tipo: "ordinaria", esFondoReserva: false, monto: "1000000.00" }],
      [
        { unidadFuncionalId: "grande", coeficiente: "0.999" },
        { unidadFuncionalId: "chica", coeficiente: "0.001" },
      ],
    );
    expect(liquidaciones.find((l) => l.unidadFuncionalId === "chica")?.total).toBe("1000.00");
  });

  it("un período sin gastos liquida cero, no falla", () => {
    const { liquidaciones, totalGastos } = calcularLiquidacion([], UNIDADES);
    expect(totalGastos).toBe("0.00");
    expect(liquidaciones.every((l) => l.total === "0.00")).toBe(true);
  });

  it("no liquida si no hay unidades ni acepta gastos negativos", () => {
    expect(() => calcularLiquidacion(GASTOS, [])).toThrow(/no hay unidades/i);
    expect(() =>
      calcularLiquidacion(
        [{ gastoId: "g", conceptoId: "c", descripcion: "Reintegro", tipo: "ordinaria", esFondoReserva: false, monto: "-100.00" }],
        UNIDADES,
      ),
    ).toThrow(/negativo/i);
  });
});

describe("mora", () => {
  it("sin tasa cargada NO inventa un interés", () => {
    const resultado = calcularMora({ saldoVencido: "100000.00", tasaMensual: null, diasDeAtraso: 45 });
    expect(resultado.interes).toBeNull();
    expect(resultado).toMatchObject({ motivo: "mora pendiente de definición" });
  });

  it("calcula interés simple proporcional a los días", () => {
    // 3% mensual sobre 100.000 durante 30 días = 3.000.
    const treinta = calcularMora({ saldoVencido: "100000.00", tasaMensual: "0.03", diasDeAtraso: 30 });
    expect(treinta.interes).toBe("3000.00");
    // La mitad de los días, la mitad del interés.
    const quince = calcularMora({ saldoVencido: "100000.00", tasaMensual: "0.03", diasDeAtraso: 15 });
    expect(quince.interes).toBe("1500.00");
  });

  it("sin atraso o sin saldo, no hay interés", () => {
    expect(calcularMora({ saldoVencido: "100000.00", tasaMensual: "0.03", diasDeAtraso: 0 }).interes).toBe("0.00");
    expect(calcularMora({ saldoVencido: "0.00", tasaMensual: "0.03", diasDeAtraso: 60 }).interes).toBe("0.00");
  });

  it("rechaza tasas y atrasos inválidos", () => {
    expect(() => calcularMora({ saldoVencido: "100.00", tasaMensual: "tres por ciento", diasDeAtraso: 1 })).toThrow();
    expect(() => calcularMora({ saldoVencido: "100.00", tasaMensual: "0.03", diasDeAtraso: -1 })).toThrow();
  });
});

describe("estados del período", () => {
  it("el camino normal avanza hasta distribuida", () => {
    expect(transicionValida("borrador", "revisada")).toBe(true);
    expect(transicionValida("revisada", "emitida")).toBe(true);
    expect(transicionValida("emitida", "distribuida")).toBe(true);
  });

  it("una liquidación emitida no vuelve a borrador", () => {
    expect(transicionValida("emitida", "borrador")).toBe(false);
    expect(transicionValida("emitida", "revisada")).toBe(false);
    expect(transicionValida("distribuida", "emitida")).toBe(false);
  });

  it("antes de emitir sí se puede volver atrás", () => {
    expect(transicionValida("revisada", "borrador")).toBe(true);
  });
});
