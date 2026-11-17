import { describe, expect, it } from "vitest";
import {
  boletasVencidas,
  botonesDeContacto,
  enlaceLlamar,
  enlaceMail,
  enlaceWhatsApp,
  etiquetasDeLaFicha,
  motivosDeContacto,
  numeroDeWhatsApp,
  textoDeLaFranja,
  textoDeLaPromesa,
} from "./ficha.ts";

describe("el número de WhatsApp", () => {
  it("deja solo dígitos y le pone el 54 si no lo trae", () => {
    expect(numeroDeWhatsApp("351 555-1234")).toBe("543515551234");
    expect(numeroDeWhatsApp("(0351) 4-555-123")).toBe("543514555123");
  });

  it("no duplica el 54 ni deja el + o los ceros de adelante", () => {
    expect(numeroDeWhatsApp("+54 9 351 555 1234")).toBe("5493515551234");
    expect(numeroDeWhatsApp("0054 9 351 5551234")).toBe("5493515551234");
  });

  it("sin teléfono o con menos de seis dígitos, no hay número", () => {
    expect(numeroDeWhatsApp(null)).toBeNull();
    expect(numeroDeWhatsApp("")).toBeNull();
    expect(numeroDeWhatsApp("12-34")).toBeNull();
    expect(numeroDeWhatsApp("sin dato")).toBeNull();
  });

  it("el enlace es wa.me con el número normalizado", () => {
    expect(enlaceWhatsApp("351 555-1234")).toBe("https://wa.me/543515551234");
    expect(enlaceWhatsApp(null)).toBeNull();
  });
});

describe("llamar y mail", () => {
  it("tel: sin espacios ni guiones, conservando el +", () => {
    expect(enlaceLlamar("+54 (351) 555-1234")).toBe("tel:+543515551234");
    expect(enlaceLlamar("123")).toBeNull();
  });

  it("mailto: solo con la forma nombre@dominio", () => {
    expect(enlaceMail(" vecino@ejemplo.com ")).toBe("mailto:vecino@ejemplo.com");
    expect(enlaceMail("vecino@ejemplo")).toBeNull();
    expect(enlaceMail(null)).toBeNull();
  });

  it("mailto: no deja colar destinatarios ocultos ni un cuerpo", () => {
    expect(enlaceMail("vecino@x.com?bcc=otro@y.com")).toBeNull();
    expect(enlaceMail("vecino@x.com&cc=otro@y.com")).toBeNull();
    expect(enlaceMail("vecino@x.com#asunto")).toBeNull();
    expect(enlaceMail("ve%63ino@x.com")).toBeNull();
    expect(enlaceMail("vecino@x.com,otro@y.com")).toBeNull();
    expect(enlaceMail("vecino;otro@x.com")).toBeNull();
    expect(enlaceMail("vecino@x.com/ruta")).toBeNull();
    expect(enlaceMail("vecino+mora@x.com.ar")).toBe("mailto:vecino+mora@x.com.ar");
  });

  it("cada botón apagado dice por qué, y el motivo no se repite", () => {
    const botones = botonesDeContacto({ telefono: null, email: "vecino@ejemplo.com" });
    expect(botones.map((b) => [b.accion, b.href !== null])).toEqual([
      ["llamar", false],
      ["whatsapp", false],
      ["mail", true],
    ]);
    expect(motivosDeContacto(botones)).toEqual(["El titular no tiene teléfono cargado en el padrón."]);
    expect(motivosDeContacto(botonesDeContacto(null))).toEqual(["La unidad no tiene titular cargado en el padrón."]);
  });
});

describe("la promesa de una gestión", () => {
  it("vencida, con lo que pagó", () => {
    expect(textoDeLaPromesa({ fecha: "2026-11-10", monto: "250000.00", pagado: "50000.00", estado: "vencida" })).toEqual({
      chip: { tono: "peligro", texto: "⚠ Vencida" },
      detalle: "10/11\u00A0·\u00A0$\u00A0250.000,00",
      pagado: "pagó\u00A0$\u00A050.000,00",
    });
  });

  it("pendiente sin pagos no dice «pagó»", () => {
    const t = textoDeLaPromesa({ fecha: "2026-11-30", monto: "300000.00", pagado: "0.00", estado: "pendiente" });
    expect(t.chip).toEqual({ tono: "alerta", texto: "Pendiente" });
    expect(t.pagado).toBeNull();
  });

  it("cumplida", () => {
    expect(textoDeLaPromesa({ fecha: "2026-11-30", monto: "1000.00", pagado: "1000.00", estado: "cumplida" }).chip).toEqual({
      tono: "exito",
      texto: "✓ Cumplida",
    });
  });
});

describe("las etiquetas de la cabecera", () => {
  it("deuda, derivación y promesa vencida, en ese orden", () => {
    expect(
      etiquetasDeLaFicha({
        meses: 5,
        derivacionVigente: { estudio: "Estudio Demo", derivadaAt: "2026-11-16 12:05:00+00" },
        promesa: { fecha: "2026-11-10", monto: "250000.00", estado: "vencida" },
      }),
    ).toEqual([
      { tono: "peligro", texto: "5 meses de deuda" },
      { tono: "derivada", texto: "Derivada a Estudio Demo desde el 16/11/2026" },
      { tono: "peligro", texto: "⚠ Promesa vencida el 10/11" },
    ]);
  });

  it("una promesa pendiente va en alerta, como en la tabla", () => {
    expect(etiquetasDeLaFicha({ meses: 0, derivacionVigente: null, promesa: { fecha: "2026-11-30", monto: "300000.00", estado: "pendiente" } })).toEqual([
      { tono: "alerta", texto: "Promesa de pago al 30/11\u00A0·\u00A0$\u00A0300.000,00" },
    ]);
  });

  it("una promesa cumplida no lleva etiqueta; sin meses vencidos, tampoco la deuda", () => {
    expect(etiquetasDeLaFicha({ meses: 0, derivacionVigente: null, promesa: { fecha: "2026-11-10", monto: "1.00", estado: "cumplida" } })).toEqual([]);
  });
});

describe("la franja «¿Registrás la gestión?»", () => {
  it("nombra el canal y a quién", () => {
    expect(textoDeLaFranja("whatsapp", "Lucía Benítez")).toEqual({
      titulo: "¿Registrás la gestión por WhatsApp?",
      detalle:
        "Abriste WhatsApp con Lucía Benítez. El canal ya queda cargado (WhatsApp). Si no hubo respuesta, registralo igual: «No contesta» también es una gestión.",
    });
    expect(textoDeLaFranja("llamada", "Mza 3 · Lote 14")).toEqual({
      titulo: "¿Registrás la gestión por llamada?",
      detalle:
        "Llamaste a Mza 3 · Lote 14. El canal ya queda cargado (llamada). Si no hubo respuesta, registralo igual: «No contesta» también es una gestión.",
    });
    expect(textoDeLaFranja("mail", "Lucía").titulo).toBe("¿Registrás la gestión por mail?");
    expect(textoDeLaFranja("nota", "Lucía").detalle.startsWith("Entregaste una nota a Lucía.")).toBe(true);
  });
});

describe("el origen del capital vencido", () => {
  it("dice cuántas boletas y de qué períodos", () => {
    expect(boletasVencidas(["2026-09"])).toBe("1 boleta vencida sin cubrir\u00A0·\u00A009/2026");
    expect(boletasVencidas(["2026-10", "2026-09"])).toBe("2 boletas vencidas sin cubrir\u00A0·\u00A009/2026, 10/2026");
    expect(boletasVencidas(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"])).toBe(
      "5 boletas vencidas sin cubrir\u00A0·\u00A0desde 06/2026",
    );
    expect(boletasVencidas([])).toBe("ninguna boleta vencida sin cubrir");
  });
});
