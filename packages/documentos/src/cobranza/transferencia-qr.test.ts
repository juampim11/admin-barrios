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
import { CVU_INEXISTENTE, aliasDeDemostracion, cuentaDeDemostracion } from "./inercia.ts";
import { conCrc, leerEmv, leerTlv, tlv } from "./emvco.ts";
import { CLAVE_TRANSFERENCIA_QR, crearMedioTransferenciaQr } from "./adapters/transferencia-qr.ts";
import { registroPorDefecto, type EntradaBloquePago } from "./index.ts";

const entrada: EntradaBloquePago = {
  barrio: "Barrio Demo Los Talas",
  comprobante: "A-2026-07-00174",
  codigoPago: "000174-0",
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
    // Banco `000` (código que no tiene asignado ningún banco) + los dos verificadores correctos: `cbuValido()` lo da por bueno, porque solo mira los verificadores.
    const resultado = conCambio((b) => {
      const insts = b["instrumentos"] as { tipo: string; etiqueta: string; valor?: string }[];
      const cbu = insts.find((i) => i.etiqueta === "CBU");
      if (cbu) cbu.valor = "0000017800000000042420";
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
      // Armado con los mismos helpers EMVCo que el generador (moneda 032, CRC válido): antes era un
      // literal con la moneda en "203" (BL-013), un error solo del fixture.
      if (qr) qr.carga = conCrc(tlv("00", "01") + tlv("26", tlv("01", "0000017800000000042420")) + tlv("53", "032") + tlv("54", "100"));
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

describe("el código de pago de la UF (BL-012)", () => {
  it("se imprime para tipear, con la instrucción de indicarlo en la transferencia", () => {
    const codigo = bloque.instrumentos.find((i) => i.tipo === "texto" && i.etiqueta === "Código de pago");
    expect(codigo).toMatchObject({ valor: "000174-0", nota: "Indicá este código en la transferencia" });
  });

  it("va en la referencia del QR (campo 62, `05`), sin separador; el comprobante va como factura (`01`)", () => {
    const qr = bloque.instrumentos.find((i) => i.tipo === "simbolo" && i.simbologia === "qrcode");
    if (qr?.tipo !== "simbolo") throw new Error("falta el QR");
    const adicionales = leerTlv(leerEmv(qr.carga).get("62") ?? "");
    expect(adicionales.get("05")).toBe("0001740");
    expect(adicionales.get("01")).toBe("A-2026-07-00174");
  });

  it("sin el código de pago, la verificación FALLA: la transferencia no tendría a quién imputarse", () => {
    const resultado = conCambio((b) => {
      b["instrumentos"] = (b["instrumentos"] as { etiqueta: string }[]).filter((i) => i.etiqueta !== "Código de pago");
    });
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.motivos.join(" ")).toMatch(/código de pago/);
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

describe("con la cuenta del barrio o de la unidad (T3)", () => {
  // De la lista cerrada de demostración (`inercia.ts`): las únicas que este medio imprime.
  const DE_LA_UNIDAD = cuentaDeDemostracion(1);
  const PADRE = cuentaDeDemostracion(2);

  const conCuenta = (cuenta: EntradaBloquePago["cuenta"]) => medio.armarBloquePago({ ...entrada, cuenta });
  const texto = (b: ReturnType<typeof conCuenta>, etiqueta: string) => {
    const i = b.instrumentos.find((x) => x.tipo === "texto" && x.etiqueta === etiqueta);
    return i?.tipo === "texto" ? i : null;
  };
  const cuentaDelQr = (b: ReturnType<typeof conCuenta>) => {
    const qr = b.instrumentos.find((x) => x.tipo === "simbolo");
    return qr?.tipo === "simbolo" ? leerTlv(leerEmv(qr.carga).get("26") ?? "").get("01") : undefined;
  };

  it("con cuenta por unidad, imprime la de la unidad (también en el QR) y el código queda de respaldo", () => {
    const b = conCuenta({ cbu: DE_LA_UNIDAD, alias: aliasDeDemostracion(1), deLaUnidad: true });
    expect(medio.verificar(b)).toEqual({ ok: true });
    expect(texto(b, "CBU")).toMatchObject({ valor: DE_LA_UNIDAD, nota: "Cuenta de tu unidad" });
    expect(texto(b, "Alias")?.valor).toBe(aliasDeDemostracion(1));
    expect(cuentaDelQr(b)).toBe(DE_LA_UNIDAD);
    expect(texto(b, "Código de pago")?.nota).toMatch(/Respaldo/);
  });

  it("sin cuenta propia, imprime la cuenta padre con el código de pago", () => {
    const b = conCuenta({ cbu: PADRE, alias: null, deLaUnidad: false });
    expect(medio.verificar(b)).toEqual({ ok: true });
    expect(texto(b, "CBU")).toMatchObject({ valor: PADRE, nota: "Cuenta del barrio" });
    expect(texto(b, "Alias")).toBeNull();
    expect(cuentaDelQr(b)).toBe(PADRE);
    expect(texto(b, "Código de pago")?.nota).toBe("Indicá este código en la transferencia");
  });

  it("una cuenta real NO se imprime en este medio de demostración: ni de un banco ni un CVU de billetera", () => {
    // Un CBU de banco y un CVU (prefijo 000, el de las billeteras) con los verificadores bien.
    for (const real of ["2850590940090418135201", "0000003100012345678907"]) {
      expect(cbuValido(real)).toBe(true);
      const r = medio.verificar(conCuenta({ cbu: real, alias: null, deLaUnidad: true }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivos.join(" ")).toMatch(/medio es de demostración/);
    }
  });

  it("un alias cargado a mano que termina en «.MUESTRA» tampoco: con cuenta declarada, solo la lista cerrada", () => {
    const r = medio.verificar(conCuenta({ cbu: DE_LA_UNIDAD, alias: "cobros.MUESTRA", deLaUnidad: true }));
    expect(r.ok).toBe(false);
  });

  it("un alias real NO se imprime: se paga aunque el CBU sea de demostración", () => {
    const r = medio.verificar(conCuenta({ cbu: DE_LA_UNIDAD, alias: "mi.alias.real", deLaUnidad: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join(" ")).toMatch(/alias/);
  });

  it("si el CBU impreso no es la cuenta del QR, FALLA", () => {
    const b = conCuenta({ cbu: DE_LA_UNIDAD, alias: null, deLaUnidad: true });
    const copia = JSON.parse(JSON.stringify(b)) as Record<string, unknown>;
    const insts = copia["instrumentos"] as { tipo: string; etiqueta: string; valor?: string }[];
    const cbu = insts.find((i) => i.etiqueta === "CBU");
    if (cbu) cbu.valor = PADRE;
    expect(medio.verificar(bloquePagoSchema.parse(copia)).ok).toBe(false);
  });
});

describe("el importe del cupón cuadra con la boleta", () => {
  it("el importe al vencimiento es el que se pidió", () => {
    expect(bloque.importes.alVencimiento).toEqual(cifra("344500.00"));
  });
});
