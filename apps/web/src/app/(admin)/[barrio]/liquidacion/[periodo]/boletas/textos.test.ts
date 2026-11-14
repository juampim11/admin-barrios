/**
 * Lo que la pestaña Boletas **afirma** desde el encargo 16: qué boleta se marca y cómo se agrupa
 * «Ver quién». Son textos sobre plata y sobre la situación de una unidad: un «Con cargos» en una
 * unidad que solo tiene la bonificación, o una unidad al día listada como que debe, son afirmaciones
 * falsas que no rompen nada y solo se ven mirando.
 */

import { describe, expect, it } from "vitest";
import type { UnidadEnLaBonificacion } from "@admin-barrios/data/servicios/devengado";
import {
  detalleDeBonificacion,
  fraseDeEvaluacion,
  marcasDeLaBoleta,
  mesesConNombre,
  textoDeLoQueDebe,
  type BoletaParaMarcar,
} from "./textos.ts";

const boleta = (cambios: Partial<BoletaParaMarcar> = {}): BoletaParaMarcar => ({
  otrosCargos: "0.00",
  saldoAnterior: "0.00",
  interes: "0.00",
  bonificada: false,
  bonificacionNoAplicada: null,
  ...cambios,
});

function unidad(etiqueta: string, cambios: Partial<UnidadEnLaBonificacion> = {}): UnidadEnLaBonificacion {
  return {
    unidadFuncionalId: `id-${etiqueta}`,
    etiqueta,
    alDia: true,
    mesesAdeudados: [],
    conSaldoInicial: false,
    excepcion: null,
    recibe: true,
    importe: null,
    ...cambios,
  };
}

describe("las marcas de una boleta", () => {
  it("una boleta sin nada fuera de lo común no lleva marcas", () => {
    expect(marcasDeLaBoleta(boleta())).toEqual([]);
  });

  it("una unidad bonificada no se marca «Con cargos» por el descuento de la bonificación", () => {
    expect(marcasDeLaBoleta(boleta({ otrosCargos: "0.00", bonificada: true }))).toEqual([]);
    // Y si además tiene un cargo propio, sí.
    expect(marcasDeLaBoleta(boleta({ otrosCargos: "24000.00", bonificada: true }))).toEqual(["con_cargos"]);
  });

  it("un cargo en una unidad sin bonificación sí se marca", () => {
    expect(marcasDeLaBoleta(boleta({ otrosCargos: "8000.00" }))).toEqual(["con_cargos"]);
  });

  it("sin bonificación y con deuda: las dos marcas, en ese orden", () => {
    expect(marcasDeLaBoleta(boleta({ bonificacionNoAplicada: "15000.00", saldoAnterior: "120000.00", interes: "3600.00" }))).toEqual([
      "sin_bonificacion",
      "deuda",
    ]);
  });

  it("un saldo a favor no es deuda", () => {
    expect(marcasDeLaBoleta(boleta({ saldoAnterior: "-5000.00" }))).toEqual([]);
  });
});

describe("los meses adeudados, con nombre", () => {
  it("del mismo año se dice el año una vez", () => {
    expect(mesesConNombre(["2026-09"])).toBe("septiembre de 2026");
    expect(mesesConNombre(["2026-09", "2026-10"])).toBe("septiembre y octubre de 2026");
    expect(mesesConNombre(["2026-08", "2026-09", "2026-10"])).toBe("agosto, septiembre y octubre de 2026");
  });

  it("de años distintos, cada mes con su año", () => {
    expect(mesesConNombre(["2026-12", "2027-01"])).toBe("diciembre de 2026 y enero de 2027");
  });

  it("más de tres se resumen: va en un chip", () => {
    expect(mesesConNombre(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"])).toBe("5 meses, desde junio de 2026");
  });

  it("lo que debe una unidad: los meses, la deuda de antes del sistema, o deuda vencida sin más", () => {
    expect(textoDeLoQueDebe({ mesesAdeudados: ["2026-10"], conSaldoInicial: false })).toBe("Debe octubre de 2026");
    expect(textoDeLoQueDebe({ mesesAdeudados: [], conSaldoInicial: true })).toBe("Deuda anterior al sistema");
    expect(textoDeLoQueDebe({ mesesAdeudados: [], conSaldoInicial: false })).toBe("Con deuda vencida");
  });
});

describe("a qué fecha se evaluó", () => {
  it("antes de emitir, a hoy", () => {
    expect(fraseDeEvaluacion({ emitido: false, evaluadaAl: "2026-11-14" })).toBe(
      "Están al día las unidades sin deuda vencida al 14/11/2026, con los pagos imputados hasta hoy.",
    );
  });

  it("después de emitir, a la emisión", () => {
    expect(fraseDeEvaluacion({ emitido: true, evaluadaAl: "2026-11-03" })).toContain("al emitir (03/11/2026)");
  });

  it("sin fecha no inventa una", () => {
    expect(fraseDeEvaluacion({ emitido: true, evaluadaAl: "" })).not.toContain("(");
  });
});

describe("«Ver quién»: cómo se agrupan las unidades", () => {
  const unidades = [
    unidad("MZ 1-1"),
    unidad("MZ 1-2"),
    unidad("MZ 1-3", { alDia: false, recibe: false, mesesAdeudados: ["2026-09", "2026-10"] }),
    unidad("MZ 1-4", {
      alDia: false,
      recibe: true,
      mesesAdeudados: ["2026-10"],
      excepcion: { tipo: "dar", motivo: "Plan de pagos al día", cargoNombre: "Ana", cargadaEl: "2026-11-02" },
    }),
    unidad("MZ 1-5", {
      alDia: true,
      recibe: false,
      excepcion: { tipo: "quitar", motivo: "Pago rechazado", cargoNombre: null, cargadaEl: "2026-11-05" },
    }),
  ];

  it("las al día sin excepción van agrupadas; cada excepción y cada una que no la recibe, por separado", () => {
    const d = detalleDeBonificacion({ unidades, puedeExceptuar: true });
    expect(d.alDia).toBe(2);
    expect(d.paraQuitar.map((u) => u.etiqueta)).toEqual(["MZ 1-1", "MZ 1-2"]);
    expect(d.sinBonificacion).toEqual([
      { unidadFuncionalId: "id-MZ 1-3", etiqueta: "MZ 1-3", debe: "Debe septiembre y octubre de 2026", importe: null },
    ]);
    expect(d.excepciones.map((e) => [e.etiqueta, e.recibe, e.detalle])).toEqual([
      ["MZ 1-4", true, "Plan de pagos al día · Ana, 02/11/2026"],
      ["MZ 1-5", false, "Pago rechazado · 05/11/2026"],
    ]);
  });

  it("a quien no puede cargar excepciones no le viaja la lista de unidades al día", () => {
    const d = detalleDeBonificacion({ unidades, puedeExceptuar: false });
    expect(d.alDia).toBe(2);
    expect(d.paraQuitar).toEqual([]);
  });

  it("después de emitir, el importe va formateado", () => {
    const d = detalleDeBonificacion({
      unidades: [unidad("MZ 2-1", { alDia: false, recibe: false, mesesAdeudados: ["2026-10"], importe: "15000.00" as never })],
      puedeExceptuar: false,
    });
    expect(d.sinBonificacion[0]?.importe).toBe("$ 15.000,00");
  });
});
