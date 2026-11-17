/**
 * Tests de `planes.ts`. Portados de `aclade-cobranzas`, adaptados de centavos `number` a `Monto`:
 *  - `tests/domain/dinero/reparto.test.ts` L14-58: propiedades de R3 (la suma da el total, N−1 al
 *    piso y la última difiere en menos de N centavos, ninguna negativa, determinístico, rechazos).
 *  - `tests/domain/plan/convenio.test.ts` L23-31: 12 cuotas sin interés con la última llevando el
 *    redondeo (100.000,01 → 8.333,33 × 11 + 8.333,38); L33-38: anticipo + 4 cuotas; L64-76: rechazos
 *    (anticipo ≥ deuda, 61 cuotas); L78-82: fin de mes en los vencimientos.
 *  - `tests/domain/dinero/cronograma.test.ts` L182-199: el francés da cuotas iguales que amortizan lo
 *    financiado (error ≤ medio centavo por cuota); L201-204: financiado demasiado chico; L206-214:
 *    con tasa 0 el francés es el reparto R3.
 * Nuevos: los dos casos de la maqueta (francés 12 × 2 % y cuadre a medida con quita) y `validarCronograma`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { aCentavos, deCentavos } from "./dinero.ts";
import {
  cronogramaDeCatalogo,
  cronogramaCuotaFija,
  cronogramaFrances,
  cuadreAMedida,
  PlanInvalido,
  repartirEnCuotas,
  validarCronograma,
  vencimientoDeCuota,
} from "./planes.ts";

const suma = (montos: readonly string[]): bigint => montos.reduce((s, m) => s + aCentavos(m), 0n);
const centavosArb = (max: number) => fc.bigInt({ min: 0n, max: BigInt(max) }).map(deCentavos);

describe("repartirEnCuotas — propiedades (Aclade reparto.test.ts)", () => {
  const total = centavosArb(1_000_000_000_000);
  const n = fc.integer({ min: 1, max: 60 });

  it("la suma de las cuotas da el total: ningún centavo se pierde ni se crea", () => {
    fc.assert(
      fc.property(total, n, (t, k) => {
        const cuotas = repartirEnCuotas(t, k);
        expect(cuotas).toHaveLength(k);
        expect(suma(cuotas)).toBe(aCentavos(t));
      }),
    );
  });

  it("las N−1 primeras son iguales al piso; la última es mayor o igual y difiere en menos de N centavos", () => {
    fc.assert(
      fc.property(total, n, (t, k) => {
        const cuotas = repartirEnCuotas(t, k).map(aCentavos);
        const piso = aCentavos(t) / BigInt(k);
        for (const c of cuotas.slice(0, -1)) expect(c).toBe(piso);
        const diferencia = cuotas[k - 1]! - piso;
        expect(diferencia >= 0n && diferencia < BigInt(k)).toBe(true);
      }),
    );
  });

  it("determinístico", () => {
    fc.assert(
      fc.property(total, n, (t, k) => {
        expect(repartirEnCuotas(t, k)).toEqual(repartirEnCuotas(t, k));
      }),
    );
  });

  it("rechaza cantidades inválidas y totales negativos", () => {
    expect(() => repartirEnCuotas("1.00", 0)).toThrow(PlanInvalido);
    expect(() => repartirEnCuotas("1.00", 1.5)).toThrow(PlanInvalido);
    expect(() => repartirEnCuotas("1.00", 61)).toThrow(/1 a 60/);
    expect(() => repartirEnCuotas("-0.01", 3)).toThrow(PlanInvalido);
  });
});

describe("vencimientoDeCuota (Aclade convenio.test.ts L78-82)", () => {
  it("las fechas de las cuotas no se pasan de fin de mes", () => {
    expect(vencimientoDeCuota("2026-01-31", 1)).toBe("2026-02-28");
    expect(vencimientoDeCuota("2026-01-31", 2)).toBe("2026-03-31");
    expect(vencimientoDeCuota("2027-11-30", 3)).toBe("2028-02-29");
    expect(vencimientoDeCuota("2026-11-10", 2)).toBe("2027-01-10");
  });
});

describe("cronogramaCuotaFija", () => {
  it("12 cuotas: la última lleva el redondeo y el plan suma la deuda (Aclade convenio.test.ts L23-31)", () => {
    const p = cronogramaCuotaFija({ deuda: "100000.01", anticipo: null, cuotas: 12, primerVencimiento: "2026-11-10" });
    expect(p.cuotas).toHaveLength(12);
    expect(p.cuotas[0]).toEqual({ numero: 1, vencimiento: "2026-11-10", importe: "8333.33", capital: "8333.33", interes: "0.00" });
    expect(p.cuotas[11]).toEqual({ numero: 12, vencimiento: "2027-10-10", importe: "8333.38", capital: "8333.38", interes: "0.00" });
    expect(p.total).toBe("100000.01");
    expect(p.interesFinanciacion).toBe("0.00");
  });

  it("con anticipo: la cuota 0 vence en su fecha y el resto financia la diferencia (Aclade L33-38)", () => {
    const p = cronogramaCuotaFija({
      deuda: "50000.00",
      anticipo: "10000.00",
      cuotas: 4,
      primerVencimiento: "2026-11-10",
      vencimientoAnticipo: "2026-10-21",
    });
    expect(p.cuotas[0]).toEqual({ numero: 0, vencimiento: "2026-10-21", importe: "10000.00", capital: "10000.00", interes: "0.00" });
    expect(p.cuotas.slice(1).map((c) => c.importe)).toEqual(["10000.00", "10000.00", "10000.00", "10000.00"]);
    expect(p.total).toBe("50000.00");
  });

  it("rechaza lo inválido con un mensaje en castellano (Aclade L64-76)", () => {
    const base = { deuda: "10000.00", anticipo: null, cuotas: 12, primerVencimiento: "2026-11-10" };
    expect(() => cronogramaCuotaFija({ ...base, anticipo: "10000.00", vencimientoAnticipo: "2026-10-21" })).toThrow(/anticipo/);
    expect(() => cronogramaCuotaFija({ ...base, anticipo: "100.00" })).toThrow(/fecha de vencimiento del anticipo/);
    expect(() => cronogramaCuotaFija({ ...base, cuotas: 61 })).toThrow(/1 a 60/);
    expect(() => cronogramaCuotaFija({ ...base, deuda: "0.00" })).toThrow(/deuda/);
    expect(() => cronogramaCuotaFija({ ...base, primerVencimiento: "2026-02-30" })).toThrow(PlanInvalido);
    // El anticipo tiene que vencer antes que la primera cuota.
    expect(() => cronogramaCuotaFija({ ...base, anticipo: "100.00", vencimientoAnticipo: "2026-11-10" })).toThrow(/después/);
    // Menos de un centavo por cuota: alguna queda en cero.
    expect(() => cronogramaCuotaFija({ ...base, deuda: "0.05" })).toThrow(/mayor a cero/);
  });

  it("propiedad: anticipo + cuotas = deuda, capital = importe, vencimientos crecientes", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 6000n, max: 100_000_000_00n }), fc.integer({ min: 1, max: 60 }), fc.integer({ min: 0, max: 50 }), (d, n, pctAnticipo) => {
        const anticipo = (d * BigInt(pctAnticipo)) / 100n;
        const p = cronogramaCuotaFija({
          deuda: deCentavos(d),
          anticipo: anticipo === 0n ? null : deCentavos(anticipo),
          cuotas: n,
          primerVencimiento: "2027-01-31",
          vencimientoAnticipo: "2026-12-15",
        });
        expect(aCentavos(p.total)).toBe(d);
        expect(suma(p.cuotas.map((c) => c.importe))).toBe(d);
        for (const c of p.cuotas) expect(c.capital).toBe(c.importe);
        expect(() => validarCronograma(p.cuotas)).not.toThrow();
      }),
    );
  });
});

describe("cronogramaFrances", () => {
  it("caso de la maqueta: $ 1.208.610,15 en 12 cuotas al 2 % mensual, sin anticipo", () => {
    const p = cronogramaFrances({ deuda: "1208610.15", anticipo: null, cuotas: 12, primerVencimiento: "2026-12-10", tasaMensual: "0.02" });
    expect(p.cuotas).toHaveLength(12);
    for (const c of p.cuotas) expect(c.importe).toBe("114285.69");
    expect(p.total).toBe("1371428.28");
    expect(p.interesFinanciacion).toBe("162818.13");
    // Primera cuota: interés = 2 % del saldo inicial; el resto amortiza.
    expect(p.cuotas[0]).toMatchObject({ interes: "24172.20", capital: "90113.49" });
    expect(suma(p.cuotas.map((c) => c.capital))).toBe(aCentavos("1208610.15"));
    expect(suma(p.cuotas.map((c) => c.interes))).toBe(aCentavos("162818.13"));
    expect(p.cuotas[11]!.vencimiento).toBe("2027-11-10");
  });

  it("con tasa 0 da lo mismo que la cuota fija (Aclade cronograma.test.ts L206-214)", () => {
    const entrada = { deuda: "100000.01", anticipo: null, cuotas: 12, primerVencimiento: "2026-11-10" };
    expect(cronogramaFrances({ ...entrada, tasaMensual: "0" })).toEqual(cronogramaCuotaFija(entrada));
    expect(cronogramaFrances({ ...entrada, tasaMensual: "0.000" })).toEqual(cronogramaCuotaFija(entrada));
  });

  it("financiado demasiado chico para N cuotas es error, no una cuota en 0 (Aclade L201-204)", () => {
    expect(() => cronogramaFrances({ deuda: "0.01", anticipo: null, cuotas: 3, primerVencimiento: "2026-11-10", tasaMensual: "0.01" })).toThrow(PlanInvalido);
  });

  it("rechaza una tasa mal escrita", () => {
    const base = { deuda: "1000.00", anticipo: null, cuotas: 3, primerVencimiento: "2026-11-10" };
    expect(() => cronogramaFrances({ ...base, tasaMensual: "2%" })).toThrow(/decimal/);
    expect(() => cronogramaFrances({ ...base, tasaMensual: "-0.02" })).toThrow(/decimal/);
    expect(() => cronogramaFrances({ ...base, tasaMensual: "0,02" })).toThrow(/decimal/);
  });

  it("propiedad: cuotas iguales que amortizan lo financiado (error ≤ medio centavo por cuota, Aclade L182-199)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 6000n, max: 100_000_000_00n }), fc.bigInt({ min: 1n, max: 10n }), fc.integer({ min: 1, max: 60 }), (t, pct, n) => {
        // Cuotas de al menos $ 100: por debajo, el redondeo puede bajar la última (ver el test de abajo).
        fc.pre(t >= BigInt(n) * 10_000n);
        const p = cronogramaFrances({ deuda: deCentavos(t), anticipo: null, cuotas: n, primerVencimiento: "2026-11-10", tasaMensual: `0.${String(pct).padStart(2, "0")}` });
        const importes = p.cuotas.map((c) => aCentavos(c.importe));
        expect(new Set(importes).size).toBe(1);
        const a = pct;
        const b = 100n;
        const c = importes[0]!;
        let T = 0n;
        for (let k = 0; k < n; k++) T += (a + b) ** BigInt(k) * b ** BigInt(n - k);
        const saldo = t * (a + b) ** BigInt(n) - c * T;
        expect(2n * (saldo < 0n ? -saldo : saldo) <= T).toBe(true);
      }),
    );
  });

  it("propiedad: capital suma lo financiado, capital + interés = importe y total = deuda + interés", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 6000n, max: 100_000_000_00n }),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 60 }),
        (d, pctAnticipo, tasaDiezMil, n) => {
          const anticipo = (d * BigInt(pctAnticipo)) / 100n;
          // Cuotas de al menos $ 100; con menos, una tasa alta puede no amortizar y es PlanInvalido.
          fc.pre(d - anticipo >= BigInt(n) * 10_000n);
          const p = cronogramaFrances({
            deuda: deCentavos(d),
            anticipo: anticipo === 0n ? null : deCentavos(anticipo),
            cuotas: n,
            primerVencimiento: "2027-01-31",
            vencimientoAnticipo: "2026-12-15",
            tasaMensual: `0.${String(tasaDiezMil).padStart(4, "0")}`,
          });
          const financiadas = p.cuotas.filter((c) => c.numero > 0);
          expect(suma(financiadas.map((c) => c.capital))).toBe(d - anticipo);
          for (const c of p.cuotas) {
            expect(aCentavos(c.capital) + aCentavos(c.interes)).toBe(aCentavos(c.importe));
            expect(aCentavos(c.interes) >= 0n).toBe(true);
            expect(aCentavos(c.capital) > 0n).toBe(true);
          }
          expect(aCentavos(p.total)).toBe(d + aCentavos(p.interesFinanciacion));
          expect(aCentavos(p.interesFinanciacion) >= 0n).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("cuadreAMedida", () => {
  it("caso de la maqueta: el perdón va primero al interés y después al capital", () => {
    const r = cuadreAMedida({ capital: "1112400.00", interes: "96210.15" }, [
      { vencimiento: "2026-12-10", importe: "400000.00" },
      { vencimiento: "2027-01-10", importe: "300000.00" },
      { vencimiento: "2027-02-10", importe: "300000.00" },
    ]);
    expect(r).toEqual({
      financiado: "1000000.00",
      quitaInteres: "96210.15",
      quitaCapital: "112400.00",
      quitaTotal: "208610.15",
      porcentajeQuita: "17.3",
      excede: false,
    });
  });

  it("si la quita no llega a cubrir el interés, el capital queda entero", () => {
    const r = cuadreAMedida({ capital: "1000.00", interes: "200.00" }, [{ vencimiento: "2026-12-10", importe: "1100.00" }]);
    expect(r).toMatchObject({ quitaInteres: "100.00", quitaCapital: "0.00", quitaTotal: "100.00", porcentajeQuita: "8.3", excede: false });
  });

  it("si el cronograma cubre la deuda justa, no hay quita", () => {
    const r = cuadreAMedida({ capital: "1000.00", interes: "200.00" }, [{ vencimiento: "2026-12-10", importe: "1200.00" }]);
    expect(r).toMatchObject({ quitaTotal: "0.00", porcentajeQuita: "0.0", excede: false });
  });

  it("si el cronograma supera la deuda, las quitas quedan en 0 y lo informa", () => {
    const r = cuadreAMedida({ capital: "1000.00", interes: "200.00" }, [{ vencimiento: "2026-12-10", importe: "1300.00" }]);
    expect(r).toEqual({ financiado: "1300.00", quitaInteres: "0.00", quitaCapital: "0.00", quitaTotal: "0.00", porcentajeQuita: "0.0", excede: true });
  });

  it("propiedad: deuda = financiado + quitaInteres + quitaCapital cuando no excede", () => {
    fc.assert(
      fc.property(centavosArb(1_000_000_000), centavosArb(100_000_000), fc.array(centavosArb(500_000_000), { minLength: 1, maxLength: 12 }), (capital, interes, importes) => {
        const r = cuadreAMedida({ capital, interes }, importes.map((importe, i) => ({ vencimiento: vencimientoDeCuota("2026-12-10", i), importe })));
        const deuda = aCentavos(capital) + aCentavos(interes);
        if (r.excede) {
          expect(aCentavos(r.quitaTotal)).toBe(0n);
        } else {
          expect(aCentavos(r.financiado) + aCentavos(r.quitaInteres) + aCentavos(r.quitaCapital)).toBe(deuda);
          expect(aCentavos(r.quitaInteres) <= aCentavos(interes)).toBe(true);
          if (aCentavos(r.quitaCapital) > 0n) expect(r.quitaInteres).toBe(interes);
        }
      }),
    );
  });
});

describe("validarCronograma", () => {
  const cuota = (vencimiento: string, importe = "100.00") => ({ vencimiento, importe });

  it("acepta un cronograma bien formado, con el anticipo fuera de la cuenta de cuotas", () => {
    expect(() => validarCronograma([cuota("2026-11-10"), cuota("2026-12-10")])).not.toThrow();
    const sesenta = Array.from({ length: 60 }, (_, i) => ({ numero: i + 1, ...cuota(vencimientoDeCuota("2026-12-10", i)) }));
    expect(() => validarCronograma([{ numero: 0, ...cuota("2026-11-01") }, ...sesenta])).not.toThrow();
  });

  it("rechaza vacío o más de 60 cuotas", () => {
    expect(() => validarCronograma([])).toThrow(/1 a 60/);
    const sesentaYUna = Array.from({ length: 61 }, (_, i) => cuota(vencimientoDeCuota("2026-12-10", i)));
    expect(() => validarCronograma(sesentaYUna)).toThrow(PlanInvalido);
  });

  it("rechaza importes en cero, negativos o mal escritos", () => {
    expect(() => validarCronograma([cuota("2026-11-10", "0.00")])).toThrow(/mayor a cero/);
    expect(() => validarCronograma([cuota("2026-11-10", "-5.00")])).toThrow(/mayor a cero/);
    expect(() => validarCronograma([cuota("2026-11-10", "5")])).toThrow(/no es válido/);
  });

  it("rechaza vencimientos que no crecen o fechas que no existen", () => {
    expect(() => validarCronograma([cuota("2026-12-10"), cuota("2026-12-10")])).toThrow(/después/);
    expect(() => validarCronograma([cuota("2026-12-10"), cuota("2026-11-10")])).toThrow(/después/);
    expect(() => validarCronograma([cuota("2026-13-01")])).toThrow(PlanInvalido);
    expect(PlanInvalido.prototype).toBeInstanceOf(RangeError);
  });
});

/*
 * P2a-1 (0094): `financia_mora` del barrio. El caso de la maqueta: 5 meses, capital 1.112.400,00 +
 * mora 96.210,15 = 1.208.610,15, en 12 cuotas al 2 % mensual. Las cifras de `false` se calcularon
 * aparte (Python, `Decimal`, medio centavo hacia arriba):
 *   cuota francesa sobre el capital = 1.112.400 × 0,02 / (1 − 1,02⁻¹²) = 105.188,10;
 *   interés total 149.857,20 (la última cuota: capital 103.125,53 + interés 2.062,57);
 *   mora por cuota 96.210,15 / 12 = 8.017,51 (× 11) y la última 8.017,54;
 *   cuota 1 = 105.188,10 + 8.017,51 = 113.205,61; total 1.358.467,35.
 */
describe("cronogramaDeCatalogo: financia_mora", () => {
  const base = { deuda: "1208610.15", mora: "96210.15", anticipo: null, cuotas: 12, primerVencimiento: "2026-12-10", sistema: "frances", tasaMensual: "0.02" } as const;

  it("true: se financia capital + mora (P1, sin cambios) y la mora va de la primera cuota en adelante", () => {
    const p = cronogramaDeCatalogo({ ...base, financiaMora: true });
    expect(p.total).toBe("1371428.28");
    expect(p.interesFinanciacion).toBe("162818.13");
    // La cuota 1 amortiza 114.285,69 − 24.172,20 (2 % de 1.208.610,15) = 90.113,49: entra hasta ahí; el
    // resto de la mora (6.096,66) va en la cuota 2.
    expect(p.cuotas[0]).toMatchObject({ importe: "114285.69", interes: "24172.20", capital: "90113.49", moraIncluida: "90113.49" });
    expect(p.cuotas[1]).toMatchObject({ moraIncluida: "6096.66" });
    expect(p.cuotas.slice(2).every((c) => c.moraIncluida === "0.00")).toBe(true);
  });

  it("false: el interés corre solo sobre el capital y la mora va en partes iguales, sin interés", () => {
    const p = cronogramaDeCatalogo({ ...base, financiaMora: false });
    expect(p.interesFinanciacion).toBe("149857.20");
    expect(p.total).toBe("1358467.35");
    expect(p.cuotas[0]).toMatchObject({ numero: 1, importe: "113205.61", interes: "22248.00", moraIncluida: "8017.51" });
    expect(p.cuotas[11]).toMatchObject({ numero: 12, importe: "113205.64", capital: "111143.07", interes: "2062.57", moraIncluida: "8017.54" });
    expect(p.cuotas.reduce((s, c) => s + aCentavos(c.moraIncluida!), 0n)).toBe(aCentavos("96210.15"));
    expect(p.cuotas.reduce((s, c) => s + aCentavos(c.capital), 0n)).toBe(aCentavos("1208610.15"));
  });

  it("false con anticipo: el anticipo cubre primero la mora", () => {
    // Anticipo 100.000: cubre los 96.210,15 de mora y 3.789,85 de capital; se financian 1.108.610,15 de capital, sin mora.
    const p = cronogramaDeCatalogo({ ...base, financiaMora: false, anticipo: "100000.00", vencimientoAnticipo: "2026-11-30" });
    expect(p.cuotas[0]).toMatchObject({ numero: 0, importe: "100000.00", moraIncluida: "96210.15" });
    expect(p.cuotas.slice(1).every((c) => c.moraIncluida === "0.00")).toBe(true);
    const solo = cronogramaFrances({ deuda: "1108610.15", anticipo: null, cuotas: 12, primerVencimiento: "2026-12-10", tasaMensual: "0.02" });
    expect(p.interesFinanciacion).toBe(solo.interesFinanciacion);
  });

  it("bordes de false: toda la deuda es mora, y capital de unos centavos (sin cuota en cero)", () => {
    const todaMora = cronogramaDeCatalogo({ ...base, deuda: "1200.00", mora: "1200.00", financiaMora: false });
    expect(todaMora.interesFinanciacion).toBe("0.00");
    expect(todaMora.cuotas.map((c) => c.importe)).toEqual(Array.from({ length: 12 }, () => "100.00"));
    const centavos = cronogramaDeCatalogo({ ...base, deuda: "1200.05", mora: "1200.00", financiaMora: false });
    expect(centavos.total).toBe("1200.05");
    expect(centavos.interesFinanciacion).toBe("0.00");
    expect(centavos.cuotas.every((c) => aCentavos(c.importe) > 0n)).toBe(true);
  });

  it("cuota fija sin interés: los importes no cambian; cambia solo dónde va la mora", () => {
    const fija = { deuda: "2050.00", mora: "50.00", anticipo: null, cuotas: 4, primerVencimiento: "2026-08-10", sistema: "fija" } as const;
    const si = cronogramaDeCatalogo({ ...fija, financiaMora: true });
    const no = cronogramaDeCatalogo({ ...fija, financiaMora: false });
    expect(si.cuotas.map((c) => c.importe)).toEqual(no.cuotas.map((c) => c.importe));
    expect(si.cuotas.map((c) => c.moraIncluida)).toEqual(["50.00", "0.00", "0.00", "0.00"]);
    expect(no.cuotas.map((c) => c.moraIncluida)).toEqual(["12.50", "12.50", "12.50", "12.50"]);
  });
});
