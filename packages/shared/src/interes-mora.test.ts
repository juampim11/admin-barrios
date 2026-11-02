/**
 * Propiedades del interés por mora con vigencias (ADR-0006). Lo que importa no es un caso a mano: es
 * que la propiedad valga para cualquier saldo, tasa, días y fecha que genere `fast-check`.
 *
 * La primera es la que sostiene la migración: **con gracia 0, tolerancia 0, punitoria 0 y «Cobra: Sí»,
 * el resultado es idéntico al centavo al de `calcularMora`**. Es lo que garantiza que un barrio que
 * venía cobrando con `tasa_mora` liquida lo mismo después de `0057`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { calcularMora } from "./liquidacion.ts";
import { deCentavos, aCentavos } from "./dinero.ts";
import {
  calcularInteresMora,
  fechaDeDia,
  numeroDeDia,
  sumarDias,
  vigenciasConstantes,
  type ParametrosMora,
  type VigenciasMora,
} from "./interes-mora.ts";
import { millonesimasATasa, tasaAMillonesimas } from "./parametros-mora.ts";

const RUNS = { numRuns: 500 };

const saldoArb = fc.bigInt({ min: -1_000_00n, max: 50_000_000_00n }).map(deCentavos);
const saldoPositivoArb = fc.bigInt({ min: 1n, max: 50_000_000_00n }).map(deCentavos);
const millonesimasArb = fc.bigInt({ min: 0n, max: 1_000_000n });
const tasaArb = millonesimasArb.map(millonesimasATasa);
const diasArb = fc.integer({ min: 0, max: 3650 });
const fechaArb = fc.integer({ min: numeroDeDia("2000-01-01"), max: numeroDeDia("2100-12-31") }).map(fechaDeDia);
const formaArb = fc.constantFrom("corre_inicio" as const, "escalon" as const);

function paridad(tasa: string, forma: ParametrosMora["formaGracia"]): ParametrosMora {
  return { cobra: true, tasaCompensatoria: tasa, tasaPunitoria: "0", graciaDias: 0, formaGracia: forma, tolerancia: "0.00" };
}

function interesDe(r: ReturnType<typeof calcularInteresMora>): bigint {
  return r.estado === "calculado" ? aCentavos(r.interes) : 0n;
}

describe("fechas como número de día", () => {
  it("ida y vuelta, para cualquier día entre 1900 y 2200", () => {
    fc.assert(
      fc.property(fc.integer({ min: numeroDeDia("1900-01-01"), max: numeroDeDia("2200-12-31") }), (n) => {
        expect(numeroDeDia(fechaDeDia(n))).toBe(n);
      }),
      RUNS,
    );
  });

  it("conoce los bisiestos y rechaza fechas que no existen", () => {
    expect(sumarDias("2024-02-28", 1)).toBe("2024-02-29");
    expect(sumarDias("2026-02-28", 1)).toBe("2026-03-01");
    expect(sumarDias("2000-02-28", 1)).toBe("2000-02-29");
    expect(sumarDias("2100-02-28", 1)).toBe("2100-03-01");
    expect(() => numeroDeDia("2026-02-30")).toThrow();
    expect(() => numeroDeDia("2026-13-01")).toThrow();
  });
});

describe("propiedades del interés", () => {
  it("PARIDAD — con gracia 0, tolerancia 0, punitoria 0 y «Cobra: Sí» da lo mismo que calcularMora, al centavo", () => {
    fc.assert(
      fc.property(saldoArb, tasaArb, diasArb, fechaArb, formaArb, (saldo, tasa, dias, corte, forma) => {
        const anterior = calcularMora({ saldoVencido: saldo, tasaMensual: tasa, diasDeAtraso: dias });
        const nuevo = calcularInteresMora({
          saldoVencido: saldo,
          fechaCorte: corte,
          diasDeAtraso: dias,
          vigencias: vigenciasConstantes(paridad(tasa, forma)),
        });
        expect(nuevo.estado).toBe("calculado");
        if (nuevo.estado === "calculado") expect(nuevo.interes).toBe(anterior.interes);
      }),
      RUNS,
    );
  });

  it("NUNCA NEGATIVO — ni el total ni sus dos partes, con cualquier combinación de parámetros", () => {
    fc.assert(
      fc.property(
        saldoArb,
        tasaArb,
        tasaArb,
        diasArb,
        fechaArb,
        fc.integer({ min: 0, max: 365 }),
        formaArb,
        fc.bigInt({ min: 0n, max: 1_000_000n }).map(deCentavos),
        (saldo, comp, pun, dias, corte, gracia, forma, tol) => {
          const r = calcularInteresMora({
            saldoVencido: saldo,
            fechaCorte: corte,
            diasDeAtraso: dias,
            vigencias: vigenciasConstantes({
              cobra: true,
              tasaCompensatoria: comp,
              tasaPunitoria: pun,
              graciaDias: gracia,
              formaGracia: forma,
              tolerancia: tol,
            }),
          });
          if (r.estado !== "calculado") throw new Error("con «Cobra: Sí» siempre se calcula");
          expect(aCentavos(r.interes) >= 0n).toBe(true);
          expect(aCentavos(r.compensatorio) >= 0n).toBe(true);
          expect(aCentavos(r.punitorio) >= 0n).toBe(true);
          expect(aCentavos(r.compensatorio) + aCentavos(r.punitorio)).toBe(aCentavos(r.interes));
        },
      ),
      RUNS,
    );
  });

  it("MONÓTONO EN DÍAS — más atraso nunca da menos interés (con cualquier gracia y forma)", () => {
    fc.assert(
      fc.property(
        saldoPositivoArb,
        tasaArb,
        diasArb,
        diasArb,
        fechaArb,
        fc.integer({ min: 0, max: 60 }),
        formaArb,
        (saldo, tasa, a, b, corte, gracia, forma) => {
          const [menos, mas] = a <= b ? [a, b] : [b, a];
          const v = vigenciasConstantes({ ...paridad(tasa, forma), graciaDias: gracia });
          const ri = calcularInteresMora({ saldoVencido: saldo, fechaCorte: corte, diasDeAtraso: menos, vigencias: v });
          const rj = calcularInteresMora({ saldoVencido: saldo, fechaCorte: corte, diasDeAtraso: mas, vigencias: v });
          expect(interesDe(rj) >= interesDe(ri)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("MONÓTONO EN TASA — más tasa (compensatoria o punitoria) nunca da menos interés", () => {
    fc.assert(
      fc.property(saldoPositivoArb, millonesimasArb, millonesimasArb, tasaArb, diasArb, fechaArb, (saldo, a, b, otra, dias, corte) => {
        const [baja, alta] = a <= b ? [a, b] : [b, a];
        const con = (comp: bigint, pun: string) =>
          interesDe(
            calcularInteresMora({
              saldoVencido: saldo,
              fechaCorte: corte,
              diasDeAtraso: dias,
              vigencias: vigenciasConstantes({ ...paridad(millonesimasATasa(comp), "corre_inicio"), tasaPunitoria: pun }),
            }),
          );
        expect(con(alta, otra) >= con(baja, otra)).toBe(true);
        expect(con(0n, millonesimasATasa(alta)) >= con(0n, millonesimasATasa(baja))).toBe(true);
      }),
      RUNS,
    );
  });

  it("«COBRA: NO» — interés 0: no se calcula, y se dice que no se cobra", () => {
    fc.assert(
      fc.property(saldoArb, tasaArb, tasaArb, diasArb, fechaArb, (saldo, comp, pun, dias, corte) => {
        const r = calcularInteresMora({
          saldoVencido: saldo,
          fechaCorte: corte,
          diasDeAtraso: dias,
          vigencias: vigenciasConstantes({ ...paridad(comp, "corre_inicio"), tasaPunitoria: pun, cobra: false }),
        });
        expect(r.estado).toBe("no_se_cobra");
        expect(interesDe(r)).toBe(0n);
      }),
      RUNS,
    );
  });

  it("VIGENCIAS — partir la ventana en un cambio de tasa da la suma exacta de las dos mitades (antes de truncar)", () => {
    fc.assert(
      fc.property(
        saldoPositivoArb,
        tasaArb,
        tasaArb,
        fc.integer({ min: 1, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        fechaArb,
        (saldo, t1, t2, antes, despues, cambio) => {
          // Ventana: `antes` días con t1 y después `despues` días con t2 (el cambio rige DESDE `cambio`).
          const corte = sumarDias(cambio, despues - 1);
          const dias = antes + despues;
          const v: VigenciasMora = {
            en: (f) => paridad(f < cambio ? t1 : t2, "corre_inicio"),
            cambios: [cambio],
          };
          const r = calcularInteresMora({ saldoVencido: saldo, fechaCorte: corte, diasDeAtraso: dias, vigencias: v });
          const s = aCentavos(saldo);
          const esperado =
            (s * tasaAMillonesimas(t1) * BigInt(antes) + s * tasaAMillonesimas(t2) * BigInt(despues)) / (1_000_000n * 30n);
          expect(interesDe(r)).toBe(esperado);
        },
      ),
      RUNS,
    );
  });

  it("NO RETROACTIVO — un cambio de tasa posterior al corte no mueve el interés", () => {
    fc.assert(
      fc.property(saldoPositivoArb, tasaArb, tasaArb, diasArb, fechaArb, fc.integer({ min: 1, max: 500 }), (saldo, t1, t2, dias, corte, despues) => {
        const cambio = sumarDias(corte, despues);
        const sinCambio = vigenciasConstantes(paridad(t1, "corre_inicio"));
        const conCambio: VigenciasMora = { en: (f) => paridad(f < cambio ? t1 : t2, "corre_inicio"), cambios: [cambio] };
        const base = { saldoVencido: saldo, fechaCorte: corte, diasDeAtraso: dias };
        expect(interesDe(calcularInteresMora({ ...base, vigencias: conCambio }))).toBe(
          interesDe(calcularInteresMora({ ...base, vigencias: sinCambio })),
        );
      }),
      RUNS,
    );
  });
});

describe("casos a mano", () => {
  const corte = "2026-07-31";
  const base: ParametrosMora = paridad("0.03", "corre_inicio");

  it("3 % mensual sobre 50.000 durante 30 días = 1.500 (el mismo caso del test de la base)", () => {
    const r = calcularInteresMora({ saldoVencido: "50000.00", fechaCorte: corte, diasDeAtraso: 30, vigencias: vigenciasConstantes(base) });
    expect(r).toMatchObject({ estado: "calculado", interes: "1500.00", compensatorio: "1500.00", punitorio: "0.00", diasDevengados: 30 });
  });

  it("corre el inicio: 5 días de gracia sobre 30 de atraso devengan 25", () => {
    const r = calcularInteresMora({
      saldoVencido: "50000.00",
      fechaCorte: corte,
      diasDeAtraso: 30,
      vigencias: vigenciasConstantes({ ...base, graciaDias: 5 }),
    });
    expect(r).toMatchObject({ interes: "1250.00", diasDevengados: 25 });
  });

  it("escalón: dentro de la gracia no devenga; pasada, corre completo desde el día siguiente al inicio", () => {
    const v = vigenciasConstantes({ ...base, graciaDias: 5, formaGracia: "escalon" });
    expect(calcularInteresMora({ saldoVencido: "50000.00", fechaCorte: corte, diasDeAtraso: 5, vigencias: v })).toMatchObject({
      interes: "0.00",
      motivoCero: "gracia",
    });
    expect(calcularInteresMora({ saldoVencido: "50000.00", fechaCorte: corte, diasDeAtraso: 6, vigencias: v })).toMatchObject({
      interes: "300.00",
      diasDevengados: 6,
    });
  });

  it("tolerancia: un saldo igual a la tolerancia se da por saldado", () => {
    const v = vigenciasConstantes({ ...base, tolerancia: "100.00" });
    expect(calcularInteresMora({ saldoVencido: "100.00", fechaCorte: corte, diasDeAtraso: 30, vigencias: v })).toMatchObject({
      interes: "0.00",
      motivoCero: "tolerancia",
    });
    expect(calcularInteresMora({ saldoVencido: "100.01", fechaCorte: corte, diasDeAtraso: 30, vigencias: v })).toMatchObject({
      interes: "3.00",
    });
  });

  it("punitoria: se suma y se desglosa, y las partes suman el total", () => {
    const r = calcularInteresMora({
      saldoVencido: "50000.00",
      fechaCorte: corte,
      diasDeAtraso: 30,
      vigencias: vigenciasConstantes({ ...base, tasaPunitoria: "0.01" }),
    });
    expect(r).toMatchObject({ interes: "2000.00", compensatorio: "1500.00", punitorio: "500.00" });
  });

  it("días con «Cobra: No» en el medio de la ventana no devengan", () => {
    // Cobra los primeros 10 días de julio; del 12 en adelante no (rige "No" desde el 12).
    const v: VigenciasMora = { en: (f) => ({ ...base, cobra: f < "2026-07-12" }), cambios: ["2026-07-12"] };
    const r = calcularInteresMora({ saldoVencido: "30000.00", fechaCorte: corte, diasDeAtraso: 30, vigencias: v });
    // Ventana: 2 al 31 de julio. Cobra del 2 al 11 = 10 días → 30.000 × 3 % × 10 / 30 = 300.
    expect(r).toMatchObject({ estado: "calculado", interes: "300.00", diasDevengados: 10 });
  });
});
