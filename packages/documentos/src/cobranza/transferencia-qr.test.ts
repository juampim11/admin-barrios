/**
 * El adapter de transferencia + QR. **El test que más importa es el que afirma que esto NO puede
 * cobrar**: una boleta que se ve real, con un CBU real, es una boleta que alguien paga (doc 09
 * §E.15.4).
 *
 * Y hay una razón extra para mirarlo con lupa acá: este adapter **no tiene código de barras**, que es
 * de donde `generico-demo` sacaba tres de sus cinco afirmaciones de inercia. Al mudarse, esas tres se
 * caen; si nadie las reemplaza, queda un `verificar()` que corre, devuelve `ok` y no verifica nada.
 */

import { describe, expect, it } from "vitest";
import { bloquePagoSchema, cifra } from "@admin-barrios/shared/documentos";
import { cbuValido } from "./cbu.ts";
import { CVU_INEXISTENTE } from "./inercia.ts";
import { CLAVE_TRANSFERENCIA_QR, crearMedioTransferenciaQr } from "./adapters/transferencia-qr.ts";
import { registroPorDefecto, type EntradaBloquePago } from "./index.ts";

const entrada: EntradaBloquePago = {
  barrio: "Barrio Demo Los Talas",
  comprobante: "A-2026-07-00174",
  periodo: "2026-07",
  vencimiento: "2026-07-10",
  fechaTope: "2026-07-13",
  importe: "344500.00",
};

const medio = crearMedioTransferenciaQr();
const bloque = medio.armarBloquePago(entrada);

/** Un bloque con un cambio puntual, para probar que `verificar()` lo caza. */
function conCambio(mutar: (b: Record<string, unknown>) => void): ReturnType<typeof medio.verificar> {
  const copia = JSON.parse(JSON.stringify(bloque)) as Record<string, unknown>;
  mutar(copia);
  return medio.verificar(bloquePagoSchema.parse(copia));
}

describe("el bloque que arma", () => {
  it("se verifica contra su propio esquema y contra su adapter", () => {
    expect(() => bloquePagoSchema.parse(bloque)).not.toThrow();
    expect(medio.verificar(bloque)).toEqual({ ok: true });
  });

  it("NO lleva código de barras: es todo el punto del adapter", () => {
    const simbologias = bloque.instrumentos
      .filter((i) => i.tipo === "simbolo")
      .map((i) => (i.tipo === "simbolo" ? i.simbologia : ""));
    expect(simbologias).toEqual(["qrcode"]);
  });

  it("no dibuja troquel, porque no hay nada que llevar a una caja", () => {
    expect(bloque.presentacion.troquel).toBeNull();
    expect(bloque.presentacion.talon).not.toBeNull();
  });

  it("imprime las dos fechas con su importe", () => {
    expect(bloque.fechas.vencimiento.texto).toBe("10/07/2026");
    expect(bloque.fechas.tope?.texto).toBe("13/07/2026");
    // Iguales porque este medio no cobra recargo — política del adapter, no del esquema.
    expect(bloque.importes.alTope?.monto).toBe(bloque.importes.alVencimiento.monto);
  });

  it("se registra y se resuelve por clave, como cualquier otro medio", () => {
    expect(registroPorDefecto().resolver(CLAVE_TRANSFERENCIA_QR).clave).toBe(CLAVE_TRANSFERENCIA_QR);
  });

  it("sin número de comprobante no arma referencia: dos pagos iguales serían inimputables", () => {
    expect(() => medio.armarBloquePago({ ...entrada, comprobante: null })).toThrow(/comprobante/i);
  });
});

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE DE VERDAD IMPORTA: QUE NO PUEDA COBRAR
 *
 * Cada caso de acá afirma **en positivo** que un instrumento es inerte, y después comprueba que si
 * alguien lo "arreglara" la verificación falla. Lo segundo es la mitad que se olvida: una salvaguarda
 * que nunca se vio fallar no es una salvaguarda.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
describe("no puede mover un peso", () => {
  it("el CBU tiene los dos verificadores ROTOS", () => {
    const cbu = bloque.instrumentos.find((i) => i.tipo === "texto" && i.etiqueta === "CBU");
    if (cbu?.tipo !== "texto") throw new Error("falta el CBU");
    expect(cbu.valor).toMatch(/^\d{22}$/);
    expect(cbuValido(cbu.valor)).toBe(false);
  });

  it("y si alguien lo arreglara, la verificación FALLA", () => {
    // `00000031000000000000` + los dos verificadores correctos: un CBU que el banco aceptaría.
    const resultado = conCambio((b) => {
      const insts = b["instrumentos"] as { tipo: string; etiqueta: string; valor?: string }[];
      const cbu = insts.find((i) => i.etiqueta === "CBU");
      if (cbu) cbu.valor = "0170099220000067797370";
    });
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.motivos.join(" ")).toMatch(/VÁLIDOS/);
  });

  it("el QR codifica el CVU inexistente, y no una URL", () => {
    const qr = bloque.instrumentos.find((i) => i.tipo === "simbolo" && i.simbologia === "qrcode");
    if (qr?.tipo !== "simbolo") throw new Error("falta el QR");
    expect(qr.carga).toContain(CVU_INEXISTENTE);
    expect(qr.carga).not.toMatch(/https?:\/\//i);
  });

  it("un QR con una URL adentro FALLA: del PDF no sale nada que abra", () => {
    const resultado = conCambio((b) => {
      const insts = b["instrumentos"] as { tipo: string; simbologia?: string; carga?: string }[];
      const qr = insts.find((i) => i.simbologia === "qrcode");
      if (qr) qr.carga = "https://pagar.example.com/boleta/00174";
    });
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.motivos.join(" ")).toMatch(/URL/);
  });

  it("un QR sobre una cuenta que podría existir FALLA", () => {
    const resultado = conCambio((b) => {
      const insts = b["instrumentos"] as { tipo: string; simbologia?: string; carga?: string }[];
      const qr = insts.find((i) => i.simbologia === "qrcode");
      // Sintácticamente igual, pero sin el CVU inerte adentro.
      if (qr) qr.carga = "00020126260122017009922000006779737053032035403100630445D2";
    });
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.motivos.join(" ")).toMatch(/CVU inexistente/);
  });

  it("agregarle un código de barras FALLA: este medio no tiene convenio con ninguna red", () => {
    const resultado = conCambio((b) => {
      const insts = b["instrumentos"] as unknown[];
      const carga = "0".repeat(58);
      insts.push({ tipo: "simbolo", etiqueta: "Código de barras", simbologia: "interleaved2of5", carga, leible: null });
    });
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.motivos.join(" ")).toMatch(/convenio con ninguna red/);
  });

  it("apagar la marca de agua FALLA", () => {
    const resultado = conCambio((b) => {
      b["sinValorDePago"] = false;
    });
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.motivos.join(" ")).toMatch(/marca de agua/);
  });

  it("un bloque de otro medio no lo valida éste", () => {
    const resultado = conCambio((b) => {
      b["medio"] = "generico-demo";
    });
    expect(resultado.ok).toBe(false);
  });
});

describe("las leyendas", () => {
  it("pasan la lista de lenguaje prohibido", () => {
    expect(medio.verificar(bloque)).toEqual({ ok: true });
  });

  it("declaran que es una muestra sin valor comercial", () => {
    expect(bloque.leyendas.join(" ")).toMatch(/MUESTRA SIN VALOR COMERCIAL/);
  });

  it("no citan la Ley 13.512, que está derogada", () => {
    const todo = [...bloque.leyendas, ...bloque.presentacion.instrucciones].join(" ");
    expect(todo).not.toMatch(/13\.?512/);
  });
});

describe("el importe del cupón cuadra con la boleta", () => {
  it("el importe al vencimiento es el que se pidió", () => {
    expect(bloque.importes.alVencimiento).toEqual(cifra("344500.00"));
  });
});
