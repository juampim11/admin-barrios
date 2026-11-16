/**
 * Lo que el panel «Cómo se devenga» **dice** (encargo 16): el renglón de ejemplo del reparto, el
 * resumen de un cambio programado y el «Qué cambió» del historial.
 *
 * El renglón de ejemplo muestra plata y depende de dos elecciones: el modo de falla es una cuenta que
 * no cierra («$ X × N = $ T» con una unidad sin importe) o un texto que asume un modelo que el barrio
 * no tiene. Queda fijado acá.
 */

import { describe, expect, it } from "vitest";
import type { ComoSeDevenga } from "@admin-barrios/shared/devengado";
import { ejemploDeReparto, resumenCorto, textoDeBonificacion, textoDeCuanto, textoDelCambio, type FilaDeCambio } from "./devengado-textos.ts";

const sinReferencia = { importePorUnidad: null, totalDelMes: null };

describe("el renglón de ejemplo del reparto", () => {
  it("administración + igual, con una sola cuota: la cuenta entera", () => {
    const e = ejemploDeReparto({
      origen: "administracion",
      reparto: "igual",
      unidades: 50,
      referencia: { importePorUnidad: "380000.00", totalDelMes: "19000000.00" },
    });
    expect(e).toEqual({ texto: "$ 380.000,00 por unidad × 50 unidades = $ 19.000.000,00", cargarEnCuota: false });
  });

  it("si la cuenta no cierra (una unidad sin importe), no se escribe como una multiplicación", () => {
    const e = ejemploDeReparto({
      origen: "administracion",
      reparto: "igual",
      unidades: 51,
      referencia: { importePorUnidad: "380000.00", totalDelMes: "19000000.00" },
    });
    expect(e.texto).not.toContain("×");
    expect(e.texto).toContain("$ 19.000.000,00");
  });

  it("administración + igual sin cuota cargada: manda a la cuota", () => {
    const e = ejemploDeReparto({ origen: "administracion", reparto: "igual", unidades: 50, referencia: sinReferencia });
    expect(e).toEqual({ texto: "El importe por unidad se carga en Configuración → Cuota.", cargarEnCuota: true });
  });

  it("administración + igual con importes distintos: dice el total, no inventa un importe por unidad", () => {
    const e = ejemploDeReparto({
      origen: "administracion",
      reparto: "igual",
      unidades: 50,
      referencia: { importePorUnidad: null, totalDelMes: "19000000.00" },
    });
    expect(e.texto).toContain("$ 19.000.000,00 por mes en total");
    expect(e.cargarEnCuota).toBe(true);
  });

  it("administración + coeficiente: el total, con y sin cuota", () => {
    expect(
      ejemploDeReparto({
        origen: "administracion",
        reparto: "coeficiente",
        unidades: 50,
        referencia: { importePorUnidad: null, totalDelMes: "19000000.00" },
      }).texto,
    ).toBe("$ 19.000.000,00 en total; cada unidad paga según su coeficiente.");
    expect(ejemploDeReparto({ origen: "administracion", reparto: "coeficiente", unidades: 50, referencia: sinReferencia }).cargarEnCuota).toBe(true);
  });

  it("gastos: nunca muestra la cuota, aunque haya una cargada", () => {
    const referencia = { importePorUnidad: "380000.00", totalDelMes: "19000000.00" };
    expect(ejemploDeReparto({ origen: "gastos", reparto: "coeficiente", unidades: 50, referencia }).texto).toBe(
      "Los gastos del mes, repartidos por coeficiente.",
    );
    expect(ejemploDeReparto({ origen: "gastos", reparto: "igual", unidades: 50, referencia }).texto).toContain("en partes iguales");
  });
});

describe("la bonificación y el resumen", () => {
  const config: ComoSeDevenga = {
    origen: "administracion",
    reparto: "igual",
    cuponCobra: "solo_mes",
    bonificacion: { modo: "sola", cuanto: { forma: "porcentaje", valor: "7.5", tope: "20000.00" as never } },
  };

  it("un porcentaje se dice con su tope; un importe, por unidad", () => {
    expect(textoDeCuanto(config.bonificacion.cuanto)).toBe("7,5 % de la expensa, hasta $ 20.000,00 por unidad");
    expect(textoDeCuanto({ forma: "importe", valor: "15000.00", tope: null })).toBe("$ 15.000,00 por unidad");
    expect(textoDeCuanto(null)).toBeNull();
  });

  it("«no bonifica» no arrastra un valor viejo", () => {
    expect(textoDeBonificacion({ modo: "no", cuanto: config.bonificacion.cuanto })).toBe("Este barrio no bonifica");
  });

  it("el resumen de un cambio programado dice los cuatro puntos", () => {
    expect(resumenCorto(config)).toBe(
      "Importe definido por la administración, igual para todas; el cupón cobra solo el mes; bonificación sola, a quien está al día (7,5 % de la expensa, hasta $ 20.000,00 por unidad).",
    );
    expect(resumenCorto({ ...config, bonificacion: { modo: "no", cuanto: null } })).toContain("; no bonifica.");
  });
});

describe("«Qué cambió» en el historial", () => {
  const historial: FilaDeCambio[] = [
    { rigeDesde: "2027-01", clave: "bonificacion.valor", valor: "15000.00" },
    { rigeDesde: "2027-01", clave: "bonificacion.forma", valor: "importe" },
    { rigeDesde: "2026-12", clave: "bonificacion.tope", valor: "20000.00" },
    { rigeDesde: "2026-12", clave: "bonificacion.valor", valor: "7.5" },
    { rigeDesde: "2026-12", clave: "bonificacion.forma", valor: "porcentaje" },
    { rigeDesde: "2026-12", clave: "cupon.cobra", valor: "solo_mes" },
    { rigeDesde: "2027-03", clave: "cupon.cobra", valor: null },
  ];
  const texto = (i: number) => textoDelCambio(historial[i]!, historial);

  it("el valor de la bonificación se lee con la forma que regía ese mes", () => {
    expect(texto(0)).toBe("Valor de la bonificación: $ 15.000,00");
    expect(texto(3)).toBe("Valor de la bonificación: 7,5 %");
  });

  it("el tope es un importe y una opción se dice con su nombre", () => {
    expect(texto(2)).toBe("Tope de la bonificación por unidad: $ 20.000,00");
    expect(texto(5)).toBe("Qué cobra el cupón del mes: Solo el mes");
  });

  it("un valor sin forma conocida se muestra como está, sin inventarle unidad", () => {
    expect(textoDelCambio({ rigeDesde: "2026-01", clave: "bonificacion.valor", valor: "7.5" }, [])).toBe("Valor de la bonificación: 7,5");
  });

  it("volver a como era antes se dice así", () => {
    expect(texto(6)).toBe("Qué cobra el cupón del mes: vuelve a como era antes de configurarlo");
  });
});
