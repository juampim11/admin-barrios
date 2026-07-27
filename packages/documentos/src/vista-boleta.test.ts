/**
 * Capa 1 de ADR-0001 §8: **el dinero se verifica acá, en el modelo de vista — nunca sobre el PDF.**
 *
 * Los tests importantes de este archivo son los que **deben fallar**: una vista que no cierra no
 * tiene que llegar a la plantilla, y menos al motor.
 */

import { describe, expect, it } from "vitest";
import { aCentavos, coeficienteAEntero, sumarMontos } from "@admin-barrios/shared/dinero";
import { cifra, parsearVistaBoleta, vistaBoletaSchema } from "@admin-barrios/shared/documentos";
import { vistaBoletaDeMuestra } from "./fixtures/boleta-muestra.ts";

const muestra = vistaBoletaDeMuestra();

/** Clona la vista y le aplica un cambio, para probar que el invariante lo atrapa. */
function conCambio(mutar: (v: Record<string, unknown>) => void): () => void {
  return () => {
    const copia = structuredClone(muestra) as unknown as Record<string, unknown>;
    mutar(copia);
    parsearVistaBoleta(copia);
  };
}

describe("la cuenta se puede rehacer", () => {
  it("gasto del período × coeficiente = importe, línea por línea", () => {
    const lineas = muestra.detalle.lineas.filter((l) => l.clase === "prorrateo");
    expect(lineas.length).toBeGreaterThan(0);
    for (const l of lineas) {
      const gasto = aCentavos(l.gastoDelPeriodo?.monto ?? "0.00");
      // Se usa el helper de producción: la conversión a entero es la MISMA regla de escalado y
      // truncado con la que reparte el prorrateo, y funciona con parte entera distinta de cero
      // (la base superficie/lote del art. 2081), que es donde una regex sobre el string fallaba.
      const coefEntero = coeficienteAEntero(l.coeficiente?.valor ?? "0");
      const teorico = (gasto * coefEntero * 2n + 1_000_000_000n) / (2n * 1_000_000_000n);
      expect(aCentavos(l.importeTeorico?.monto ?? "0.00")).toBe(teorico);
      expect(aCentavos(l.importe.monto)).toBe(teorico + aCentavos(l.ajusteRedondeo.monto));
    }
  });

  it("las líneas suman el total del período (las cuatro clases juntas)", () => {
    const suma = sumarMontos(...muestra.detalle.lineas.map((l) => l.importe.monto));
    expect(suma).toBe(muestra.totales.delPeriodo.monto);
    expect(new Set(muestra.detalle.lineas.map((l) => l.clase))).toEqual(
      new Set(["prorrateo", "cargo", "descuento"]),
    );
  });

  it("la composición de la zona 2 suma exactamente lo mismo que el detalle", () => {
    const suma = sumarMontos(...muestra.composicion.filter((r) => !r.informativo).map((r) => r.importe.monto));
    expect(suma).toBe(muestra.totales.delPeriodo.monto);
  });

  it("total del período + saldo anterior + interés = TOTAL A PAGAR", () => {
    expect(
      sumarMontos(
        muestra.totales.delPeriodo.monto,
        muestra.totales.saldoAnterior.monto,
        muestra.totales.interes?.monto ?? "0.00",
      ),
    ).toBe(muestra.totales.aPagar.monto);
  });

  it("el importe del cupón es el MISMO que el del titular (doc 09 §E.6)", () => {
    expect(muestra.bloquePago.importes.alVencimiento.monto).toBe(muestra.totales.aPagar.monto);
    expect(muestra.bloquePago.importes.alVencimiento.texto).toBe(muestra.totales.aPagar.texto);
  });
});

describe("lo que la vista NO deja pasar", () => {
  it("un total que no cierra", () => {
    expect(conCambio((v) => {
      (v["totales"] as { aPagar: unknown }).aPagar = cifra("999999.99");
    })).toThrow(/TOTAL A PAGAR|total del período/i);
  });

  it("un cupón con un importe distinto del titular — el bug que §E.6 llama bug y no caso", () => {
    expect(conCambio((v) => {
      const bp = v["bloquePago"] as { importes: { alVencimiento: unknown } };
      bp.importes.alVencimiento = cifra("1.00");
    })).toThrow(/cupón|mismo/i);
  });

  it("una cifra cuyo texto impreso no sale de su monto (el bug de ICU)", () => {
    expect(conCambio((v) => {
      const t = v["totales"] as { aPagar: { monto: string; texto: string } };
      t.aPagar = { monto: t.aPagar.monto, texto: "358,998.17" }; // formato en-US
    })).toThrow(/texto impreso/i);
  });

  it("un interés sin base, tasa, días y fecha de corte", () => {
    expect(conCambio((v) => {
      v["interes"] = null;
    })).toThrow(/base, tasa, días/i);
  });

  it("un interés pendiente de definición que igual trae cifras", () => {
    expect(conCambio((v) => {
      (v["totales"] as { interes: unknown }).interes = null;
    })).toThrow();
  });

  it("un descuento impreso en positivo", () => {
    expect(conCambio((v) => {
      const lineas = (v["detalle"] as { lineas: { clase: string; importe: unknown }[] }).lineas;
      const descuento = lineas.find((l) => l.clase === "descuento");
      if (descuento) descuento.importe = cifra("34000.00");
    })).toThrow(/negativo/i);
  });

  it("un marcador de nota que no tiene nota que lo explique", () => {
    expect(conCambio((v) => {
      v["notas"] = [];
    })).toThrow(/marcador/i);
  });

  it("un prorrateo sin coeficiente, o un cargo con coeficiente", () => {
    expect(conCambio((v) => {
      const lineas = (v["detalle"] as { lineas: { clase: string; coeficiente: unknown }[] }).lineas;
      const linea = lineas.find((l) => l.clase === "prorrateo");
      if (linea) linea.coeficiente = null;
    })).toThrow(/coeficiente/i);
  });

  it("más de tres bandas (los slots de la zona 1 son tres y tienen altura reservada)", () => {
    expect(conCambio((v) => {
      const bandas = v["bandas"] as unknown[];
      v["bandas"] = [...bandas, ...bandas];
    })).toThrow(/array|elemento|4|most/i);
  });

  it("un logo por URL en vez de data: — la red está apagada en el renderizador", () => {
    expect(conCambio((v) => {
      const marca = v["marca"] as { barrio: { logo: unknown } };
      marca.barrio.logo = { dataUri: "https://cdn.ejemplo.test/logo.png", altoMaxMm: 20, anchoMaxMm: 45 };
    })).toThrow(/data:/i);
  });

  it("un barrio con figura jurídica fideicomiso: la emisión se bloquea (doc 07 §E)", () => {
    expect(conCambio((v) => {
      (v["barrio"] as { figuraJuridica: string }).figuraJuridica = "fideicomiso";
    })).toThrow(/fideicomiso/i);
  });

  it("un número impreso debajo del código que no es el codificado (ADR-0001 §7.1)", () => {
    expect(conCambio((v) => {
      const bp = v["bloquePago"] as { instrumentos: { tipo: string; leible?: string | null }[] };
      const simbolo = bp.instrumentos.find((i) => i.tipo === "simbolo");
      if (simbolo) simbolo.leible = "1234 5678";
    })).toThrow(/impreso no es|codifica/i);
  });

  it("una fecha tope con un importe distinto: no es un segundo vencimiento con recargo", () => {
    expect(conCambio((v) => {
      const bp = v["bloquePago"] as {
        fechas: { tope: unknown };
        importes: { alTope: unknown };
      };
      bp.fechas.tope = { iso: "2026-08-20", texto: "20/08/2026" };
      bp.importes.alTope = cifra("400000.00");
    })).toThrow(/mismo importe/i);
  });
});

describe("lo que el sistema todavía no guarda", () => {
  it("el rol del destinatario es opcional y la muestra no lo trae: hoy sería una suposición", () => {
    expect(muestra.unidad.rolDestinatario).toBeUndefined();
    expect(vistaBoletaSchema.safeParse({ ...muestra, unidad: { ...muestra.unidad, rolDestinatario: "propietaria" } }).success).toBe(true);
  });

  it("los huecos de modelo viajan declarados con el documento, no se inventan", () => {
    expect(muestra.faltantes.length).toBeGreaterThan(0);
    expect(muestra.faltantes.join(" ")).toMatch(/fecha tope/i);
  });

  it("el renglón informativo (bonificación NO aplicada) está en el contrato y no suma al total", () => {
    const conInformativo = vistaBoletaDeMuestra({
      composicion: [
        ...muestra.composicion,
        {
          etiqueta: "Bonificación por pago en término",
          importe: cifra("0.00"),
          informativo: true,
          aclaracion: "no aplicada · evaluada al 30/06/2026",
          marcadorNota: null,
        },
      ],
    });
    expect(conInformativo.totales.delPeriodo.monto).toBe(muestra.totales.delPeriodo.monto);
  });
});
