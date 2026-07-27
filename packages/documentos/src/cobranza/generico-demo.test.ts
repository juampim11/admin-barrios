/**
 * El adapter de demostración. **El test que más importa es el que afirma que esto NO puede cobrar**:
 * una boleta que se ve real, con un CBU real, es una boleta que alguien paga (doc 09 §E.15.4).
 */

import { describe, expect, it } from "vitest";
import { bloquePagoSchema, cifra } from "@admin-barrios/shared/documentos";
import { cbuValido, verificadorBloque1, verificadorBloque2 } from "./cbu.ts";
import {
  CLAVE_GENERICO_DEMO,
  LARGO_CARGA_BARRAS,
  cbuInerte,
  crearMedioGenericoDemo,
  digitoVerificadorDemo,
  payloadQrPago,
} from "./adapters/generico-demo.ts";
import { crearRegistroMediosCobranza, registroPorDefecto, type EntradaBloquePago } from "./index.ts";

const entrada: EntradaBloquePago = {
  barrio: "Barrio Demo Los Aromos",
  comprobante: "A-2026-07-00174",
  periodo: "2026-07",
  vencimiento: "2026-08-10",
  fechaTope: null,
  importe: "358998.17",
};

const medio = crearMedioGenericoDemo();
const bloque = medio.armarBloquePago(entrada);

describe("el bloque que arma", () => {
  it("declara el medio y pasa su propia verificación", () => {
    expect(bloque.medio).toBe(CLAVE_GENERICO_DEMO);
    expect(medio.verificar(bloque)).toEqual({ ok: true });
  });

  it("obliga a la marca de agua: `sinValorDePago` es true y no es configurable", () => {
    expect(bloque.sinValorDePago).toBe(true);
  });

  it("el importe del cupón sale tal cual del total, por el mismo helper de formato", () => {
    expect(bloque.importes.alVencimiento).toEqual(cifra("358998.17"));
    expect(bloque.importes.alVencimiento.texto).toBe("358.998,17");
  });

  it("el número impreso es exactamente el codificado, salvo los espacios de agrupación", () => {
    for (const inst of bloque.instrumentos) {
      if (inst.tipo !== "simbolo" || inst.leible === null) continue;
      expect(inst.leible.replace(/\s+/g, "")).toBe(inst.carga);
    }
  });

  it("el código de barras tiene una cantidad PAR de dígitos, siempre", () => {
    const barras = bloque.instrumentos.find((i) => i.tipo === "simbolo" && i.simbologia === "interleaved2of5");
    expect(barras?.tipo).toBe("simbolo");
    if (barras?.tipo !== "simbolo") return;
    expect(barras.carga).toHaveLength(LARGO_CARGA_BARRAS);
    expect(LARGO_CARGA_BARRAS % 2).toBe(0);
    expect(barras.carga).toMatch(/^\d+$/);
  });

  it("no lleva nombres de clientes: el alias se deriva del barrio que le pasan", () => {
    const alias = bloque.instrumentos.find((i) => i.tipo === "texto" && i.etiqueta === "Alias");
    expect(alias?.tipo === "texto" && alias.valor).toBe("BARRIO.DEMO.MUESTRA");
    const otro = medio.armarBloquePago({ ...entrada, barrio: "Altos del Sur" });
    const aliasOtro = otro.instrumentos.find((i) => i.tipo === "texto" && i.etiqueta === "Alias");
    expect(aliasOtro?.tipo === "texto" && aliasOtro.valor).toBe("ALTOS.DEL.MUESTRA");
  });

  it("sin número de comprobante NO arma el instrumento: dos unidades tendrían el mismo código", () => {
    expect(() => medio.armarBloquePago({ ...entrada, comprobante: null })).toThrow(/sin número de comprobante/);
    expect(() => medio.armarBloquePago({ ...entrada, comprobante: "   " })).toThrow(/sin número de comprobante/);
  });

  it("un saldo a favor no se codifica como una deuda del mismo monto", () => {
    expect(() => medio.armarBloquePago({ ...entrada, importe: "-358997.97" })).toThrow(/negativo|saldo a favor/);
  });

  it("dos unidades con el mismo importe reciben instrumentos DISTINTOS", () => {
    const a = medio.armarBloquePago({ ...entrada, comprobante: "2026-06-M1L1" });
    const b = medio.armarBloquePago({ ...entrada, comprobante: "2026-06-M1L2" });
    const carga = (x: typeof a) => x.instrumentos.find((i) => i.tipo === "simbolo")?.tipo === "simbolo"
      ? (x.instrumentos.find((i) => i.tipo === "simbolo") as { carga: string }).carga
      : "";
    expect(carga(a)).not.toBe(carga(b));
  });
});

describe("no puede mover un peso — y se afirma en positivo", () => {
  it("el dígito verificador del código de barras es INCORRECTO a propósito", () => {
    const barras = bloque.instrumentos.find((i) => i.tipo === "simbolo" && i.simbologia === "interleaved2of5");
    if (barras?.tipo !== "simbolo") throw new Error("falta el código de barras");
    const cuerpo = barras.carga.slice(0, -1);
    expect(Number(barras.carga.slice(-1))).not.toBe(digitoVerificadorDemo(cuerpo));
  });

  it("el CBU tiene los DOS verificadores rotos: el home banking lo rechaza antes de confirmar", () => {
    const cbu = cbuInerte();
    expect(cbu).toMatch(/^\d{22}$/);
    expect(cbuValido(cbu)).toBe(false);
    expect(Number(cbu[7])).not.toBe(verificadorBloque1(cbu.slice(0, 7)));
    expect(Number(cbu[21])).not.toBe(verificadorBloque2(cbu.slice(8, 21)));
  });

  it("el algoritmo del CBU es correcto (si no, el test de arriba no probaría nada)", () => {
    // Un CBU armado con los verificadores BIEN calculados tiene que dar válido.
    const b1 = "0001234";
    const b2 = "0000000000174";
    expect(cbuValido(`${b1}${verificadorBloque1(b1)}${b2}${verificadorBloque2(b2)}`)).toBe(true);
  });

  it("el QR trae un payload con CRC y un CVU inexistente", () => {
    const payload = payloadQrPago(entrada);
    expect(payload).toMatch(/^000201/);
    expect(payload).toContain("6304");
    expect(payload).toContain("0000003100000000000000");
  });

  it("la verificación FALLA si alguien arreglara el dígito verificador", () => {
    const arreglado = bloquePagoSchema.parse({
      ...bloque,
      instrumentos: bloque.instrumentos.map((i) => {
        if (i.tipo !== "simbolo" || i.simbologia !== "interleaved2of5") return i;
        const cuerpo = i.carga.slice(0, -1);
        const carga = `${cuerpo}${digitoVerificadorDemo(cuerpo)}`;
        return { ...i, carga, leible: carga };
      }),
    });
    const r = medio.verificar(arreglado);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivos.join(" ")).toMatch(/VÁLIDO/);
  });

  it("la verificación FALLA si alguien apagara `sinValorDePago`", () => {
    const r = medio.verificar({ ...bloque, sinValorDePago: false });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivos.join(" ")).toMatch(/marca de agua/);
  });

  it("la verificación FALLA con lenguaje prohibido en una leyenda del cliente", () => {
    const r = medio.verificar({
      ...bloque,
      leyendas: [...bloque.leyendas, "Bajo apercibimiento de iniciar acciones legales."],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivos.join(" ")).toMatch(/lenguaje prohibido/);
  });
});

describe("el registro de medios", () => {
  it("resuelve el adapter por clave", () => {
    expect(registroPorDefecto().resolver(CLAVE_GENERICO_DEMO).clave).toBe(CLAVE_GENERICO_DEMO);
  });

  it("un barrio sin medio configurado NO emite: P0 es una decisión, no un hueco", () => {
    expect(() => registroPorDefecto().resolver("banco-x")).toThrow(/no se imprime una boleta impagable/);
  });

  it("no admite dos adapters con la misma clave", () => {
    expect(() => crearRegistroMediosCobranza([crearMedioGenericoDemo(), crearMedioGenericoDemo()])).toThrow();
  });
});
