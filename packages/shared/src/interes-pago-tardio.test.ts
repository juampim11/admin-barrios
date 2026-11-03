/**
 * Propiedades del interés por pago fuera de término y del reparto del pago (ADR-0009). Mil casos
 * aleatorios por propiedad: nunca negativo, cero dentro de la gracia, monótono en los días, el reparto
 * suma exactamente el pago, y paridad con el cálculo de T1 cuando el pago cubre todo.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { aCentavos, deCentavos } from "./dinero.ts";
import { calcularInteresMora, fechaDeDia, numeroDeDia, sumarDias, vigenciasConstantes } from "./interes-mora.ts";
import { millonesimasATasa } from "./parametros-mora.ts";
import { interesCobrable, interesDelTramo, repartirPago } from "./interes-pago-tardio.ts";

const RUNS = { numRuns: 1000 };
const capitalArb = fc.bigInt({ min: 1n, max: 50_000_000_00n }).map(deCentavos);
const montoArb = fc.bigInt({ min: 0n, max: 80_000_000_00n }).map(deCentavos);
const tasaArb = fc.bigInt({ min: 0n, max: 200_000n }).map(millonesimasATasa);
const fechaArb = fc.integer({ min: numeroDeDia("2020-01-01"), max: numeroDeDia("2030-12-31") }).map(fechaDeDia);
const parametrosArb = fc.record({
  cobra: fc.constant(true),
  tasaCompensatoria: tasaArb,
  tasaPunitoria: tasaArb,
  graciaDias: fc.integer({ min: 0, max: 30 }),
  formaGracia: fc.constantFrom("corre_inicio" as const, "escalon" as const),
  tolerancia: fc.bigInt({ min: 0n, max: 500_00n }).map(deCentavos),
});
const ordenArb = fc.constantFrom("intereses_primero_capital_antiguo" as const, "capital_primero" as const);

describe("interesDelTramo", () => {
  it("nunca da un interés negativo", () => {
    fc.assert(
      fc.property(capitalArb, fechaArb, fc.integer({ min: 0, max: 1500 }), parametrosArb, fc.boolean(), (base, inicio, dias, p, desdeVto) => {
        const r = interesDelTramo({ base, inicio, fin: sumarDias(inicio, dias), desdeVencimiento: desdeVto, vigencias: vigenciasConstantes(p) });
        expect(aCentavos(interesCobrable(r)) >= 0n).toBe(true);
      }),
      RUNS,
    );
  });

  it("un tramo «calculado» siempre tiene interés (nunca $ 0,00: no se podría registrar)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 500n }).map(deCentavos), fechaArb, fc.integer({ min: 0, max: 60 }), parametrosArb, fc.boolean(), (base, inicio, dias, p, desdeVto) => {
        const r = interesDelTramo({ base, inicio, fin: sumarDias(inicio, dias), desdeVencimiento: desdeVto, vigencias: vigenciasConstantes({ ...p, tolerancia: "0.00" }) });
        if (r.estado === "calculado") expect(aCentavos(r.interes) > 0n).toBe(true);
      }),
      RUNS,
    );
  });

  it("da cero si el pago cae dentro de la gracia", () => {
    fc.assert(
      fc.property(capitalArb, fechaArb, parametrosArb, fc.nat(), (base, vto, p, k) => {
        const dias = p.graciaDias === 0 ? 0 : k % (p.graciaDias + 1);
        const r = interesDelTramo({ base, inicio: vto, fin: sumarDias(vto, dias), desdeVencimiento: true, vigencias: vigenciasConstantes(p) });
        expect(interesCobrable(r)).toBe("0.00");
      }),
      RUNS,
    );
  });

  it("es monótono en los días: pagar más tarde nunca cuesta menos interés", () => {
    fc.assert(
      fc.property(capitalArb, fechaArb, fc.integer({ min: 0, max: 800 }), fc.integer({ min: 0, max: 800 }), parametrosArb, (base, vto, a, b, p) => {
        const [antes, despues] = a <= b ? [a, b] : [b, a];
        const v = vigenciasConstantes(p);
        const i1 = interesCobrable(interesDelTramo({ base, inicio: vto, fin: sumarDias(vto, antes), desdeVencimiento: true, vigencias: v }));
        const i2 = interesCobrable(interesDelTramo({ base, inicio: vto, fin: sumarDias(vto, despues), desdeVencimiento: true, vigencias: v }));
        expect(aCentavos(i2) >= aCentavos(i1)).toBe(true);
      }),
      RUNS,
    );
  });

  it("paridad con T1: el pago total, desde el vencimiento, da el mismo interés que calcularInteresMora", () => {
    fc.assert(
      fc.property(capitalArb, fechaArb, fc.integer({ min: 0, max: 1500 }), parametrosArb, (base, vto, dias, p) => {
        // Sin tolerancia: la regla nueva («menor que la tolerancia no se cobra») es lo único que agrega.
        const v = vigenciasConstantes({ ...p, tolerancia: "0.00" });
        const fin = sumarDias(vto, dias);
        const t1 = calcularInteresMora({ saldoVencido: base, fechaCorte: fin, diasDeAtraso: dias, vigencias: v });
        const tramo = interesDelTramo({ base, inicio: vto, fin, desdeVencimiento: true, vigencias: v });
        expect(interesCobrable(tramo)).toBe(t1.estado === "calculado" ? t1.interes : "0.00");
      }),
      RUNS,
    );
  });

  it("con «No se cobra», nada; con un interés menor que la tolerancia, no se cobra pero queda dicho", () => {
    const base = { tasaCompensatoria: "0.03", tasaPunitoria: "0", graciaDias: 0, formaGracia: "corre_inicio" as const };
    expect(
      interesDelTramo({ base: "100000.00", inicio: "2026-10-10", fin: "2026-10-25", desdeVencimiento: true, vigencias: vigenciasConstantes({ ...base, cobra: false, tolerancia: "0.00" }) }),
    ).toEqual({ estado: "no_se_cobra" });
    // 1.000 × 3 % × 2/30 = 2,00 < 100 de tolerancia.
    expect(
      interesDelTramo({ base: "1000.00", inicio: "2026-10-10", fin: "2026-10-12", desdeVencimiento: true, vigencias: vigenciasConstantes({ ...base, cobra: true, tolerancia: "100.00" }) }),
    ).toEqual({ estado: "tolerancia", interesCalculado: "2.00", dias: 2 });
  });
});

describe("repartirPago", () => {
  it("interés + capital + sobrante = pago, y nada sale negativo ni excede lo pendiente", () => {
    fc.assert(
      fc.property(montoArb, capitalArb, capitalArb, ordenArb, (monto, interes, capital, orden) => {
        const r = repartirPago({ monto, interes, capital, orden });
        expect(aCentavos(r.aInteres) + aCentavos(r.aCapital) + aCentavos(r.sobrante)).toBe(aCentavos(monto));
        expect(aCentavos(r.aInteres) <= aCentavos(interes) && aCentavos(r.aCapital) <= aCentavos(capital)).toBe(true);
        expect([r.aInteres, r.aCapital, r.sobrante].every((m) => aCentavos(m) >= 0n)).toBe(true);
        // Si el pago no alcanza para todo, se imputa entero: nada queda a cuenta.
        if (aCentavos(monto) <= aCentavos(interes) + aCentavos(capital)) expect(r.sobrante).toBe("0.00");
      }),
      RUNS,
    );
  });

  it("«Intereses primero» cubre el interés antes que el capital; «Capital primero», al revés", () => {
    expect(repartirPago({ monto: "100.00", interes: "30.00", capital: "100.00", orden: "intereses_primero_capital_antiguo" })).toEqual({
      aInteres: "30.00",
      aCapital: "70.00",
      sobrante: "0.00",
    });
    expect(repartirPago({ monto: "100.00", interes: "30.00", capital: "100.00", orden: "capital_primero" })).toEqual({
      aInteres: "0.00",
      aCapital: "100.00",
      sobrante: "0.00",
    });
  });

  it("con el interés en cero (no cobrar interés), los dos órdenes imputan igual: todo a capital", () => {
    fc.assert(
      fc.property(montoArb, capitalArb, (monto, capital) => {
        const a = repartirPago({ monto, interes: "0.00", capital, orden: "intereses_primero_capital_antiguo" });
        const b = repartirPago({ monto, interes: "0.00", capital, orden: "capital_primero" });
        expect(a).toEqual(b);
      }),
      RUNS,
    );
  });
});
