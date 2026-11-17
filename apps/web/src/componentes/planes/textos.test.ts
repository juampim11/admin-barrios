import { describe, expect, it } from "vitest";
import type { CuotaDeUnidad } from "@admin-barrios/data/servicios/planes";
import { avisoDeCaida, descripcionDelPlan, etiquetasDelPlan, numeroDeCuota, rangoDeMeses } from "./textos.ts";

const cuota = (numero: number, vencimiento: string, estado: CuotaDeUnidad["estado"]): CuotaDeUnidad => ({
  numero,
  vencimiento,
  importe: "114285.69",
  pagado: estado === "pagada" ? "114285.69" : estado === "sin_emitir" ? null : "0.00",
  estado,
});

const plan = {
  estado: "vigente" as const,
  nombre: "12 cuotas al 2 %",
  cuotasParaCaer: 2,
  cuotasVencidas: 1,
  cuotas: [
    cuota(1, "2026-12-10", "pagada"),
    cuota(2, "2027-01-10", "pagada"),
    cuota(3, "2027-02-10", "pagada"),
    cuota(4, "2027-03-10", "vencida"),
    ...Array.from({ length: 8 }, (_, i) => cuota(5 + i, `2027-${String(4 + i).padStart(2, "0")}-10`, "sin_emitir")),
  ],
};

describe("textos del plan en la ficha (pantalla 4)", () => {
  it("los chips: en plan con las pagadas, y las vencidas", () => {
    expect(etiquetasDelPlan(plan)).toEqual([
      { tono: "info", texto: "En plan · 12 cuotas al 2 % · 3 de 12 pagadas" },
      { tono: "alerta", texto: "1 cuota vencida" },
    ]);
    expect(etiquetasDelPlan({ ...plan, estado: "cumplido" })).toEqual([]);
  });

  it("el aviso: cuál venció y cuántas faltan para que caiga (el de la maqueta)", () => {
    expect(avisoDeCaida(plan)).toBe("La cuota 4 venció el 10/03/2027 y no está paga. Con 2 cuotas impagas el plan cae: falta 1.");
    const dos = { ...plan, cuotasVencidas: 2, cuotas: plan.cuotas.map((c) => (c.numero === 5 ? { ...c, estado: "vencida" as const } : c)) };
    expect(avisoDeCaida(dos)).toBe("2 cuotas vencidas sin pagar, la primera el 10/03/2027. Con 2 cuotas impagas el plan cae: ya se puede declarar caído.");
    expect(avisoDeCaida({ ...plan, cuotasVencidas: 0 })).toBeNull();
  });

  it("el anticipo y el rango de meses", () => {
    expect(numeroDeCuota({ numero: 0 }, 12)).toBe("Anticipo");
    expect(rangoDeMeses(["2026-10", "2026-06", "2026-08"])).toBe("junio a octubre 2026");
    expect(rangoDeMeses(["2026-11", "2027-01"])).toBe("noviembre 2026 a enero 2027");
    expect(rangoDeMeses(["2026-06"])).toBe("junio 2026");
  });

  it("la descripción depende de quién acordó y quién cobra", () => {
    expect(descripcionDelPlan({ tipo: "catalogo", estudio: "Estudio Jurídico Demo", modoCobro: "estudio" })).toBe(
      "Del catálogo · acordado con Estudio Jurídico Demo · cobra el estudio y rinde.",
    );
    expect(descripcionDelPlan({ tipo: "a_medida", estudio: null, modoCobro: "barrio" })).toBe(
      "A medida · acordado por la administración · cobra el barrio, en la boleta.",
    );
  });
});
