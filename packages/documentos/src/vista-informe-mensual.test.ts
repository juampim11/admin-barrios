/**
 * Los invariantes del informe mensual, que son los siete defectos del documento que reemplaza
 * convertidos en cosas que **no se pueden construir** (doc 10 §B.1).
 *
 * Acá se testea el dinero, no el PDF (ADR-0001 §8, capa 1): la aritmética vive en el modelo de vista
 * y es lo único que hay que probar para saber que las cifras cierran.
 */

import { describe, expect, it } from "vitest";
import { cifra, faltante, parsearVistaInformeMensual, participacion } from "@admin-barrios/shared/documentos";
import { aCentavos, deCentavos } from "@admin-barrios/shared/dinero";
import { informeMuestra } from "./fixtures/informes-muestra.ts";

/** Un fixture con un solo campo cambiado en profundidad. */
function con(ruta: string, valor: unknown): unknown {
  const base = informeMuestra() as Record<string, any>;
  const partes = ruta.split(".");
  let cursor: any = base;
  for (const parte of partes.slice(0, -1)) cursor = cursor[parte];
  cursor[partes.at(-1)!] = valor;
  return base;
}

describe("el informe mensual cierra o no se emite", () => {
  it("el fixture de referencia pasa entero", () => {
    const v = parsearVistaInformeMensual(informeMuestra());
    expect(v.devengado.resultado.texto).toBe("1.200.000,00");
  });

  it("el resultado del período TIENE que ser ingresos menos egresos", () => {
    // Es el defecto 1 del informe real: no calcula el resultado. Acá no se puede omitir —el campo es
    // obligatorio— y tampoco se puede poner cualquier número.
    expect(() => parsearVistaInformeMensual(con("devengado.resultado", cifra("1200000.01")))).toThrow(
      /ingresos menos egresos da 1200000.00/,
    );
  });

  it("los grupos tienen que sumar el total que se imprime", () => {
    const roto = informeMuestra() as any;
    roto.devengado.egresos[3].importe = cifra("300001.00");
    expect(() => parsearVistaInformeMensual(roto)).toThrow(/los grupos de gasto suman/);
  });

  it("un grupo que pesa más del 5 % del gasto no puede ir sin desagregar", () => {
    const roto = informeMuestra() as any;
    roto.devengado.egresos[0].desagregado = [];
    expect(() => parsearVistaInformeMensual(roto)).toThrow(/pesa 64,10 % del gasto y va sin desagregar/);
  });

  it("por debajo del 5 % sí puede ir agrupado", () => {
    const v = parsearVistaInformeMensual(informeMuestra());
    const servicios = v.devengado.egresos.find((g) => g.clave === "servicios");
    expect(servicios?.desagregado).toHaveLength(0);
    expect(servicios?.participacionTexto).toBe("3,85");
  });

  it("el desagregado de un grupo tiene que sumar el grupo", () => {
    const roto = informeMuestra() as any;
    roto.devengado.egresos[0].desagregado[1].importe = cifra("400001.00");
    expect(() => parsearVistaInformeMensual(roto)).toThrow(/el desagregado de .{0,4}Seguridad y control de acceso.{0,4} suma 5000001.00/);
  });

  it("una deducción NO puede ser un grupo de primer nivel: arriba hace que sus hermanos pasen el 100 %", () => {
    // El defecto salía impreso en el informe real: la bonificación como grupo hermano dejaba el
    // denominador en neto y la cuota de lista se publicaba al 102,93 %, con el total en 100,00 %.
    // Impecable, y para quien lo lee, un error. La bonificación va adentro de la cuota que deduce.
    const roto = informeMuestra() as any;
    roto.devengado.ingresos = [
      { ...roto.devengado.ingresos[0], importe: cifra("10000000.00"), participacionTexto: "111,11", desagregado: [] },
      {
        clave: "bonificacion",
        naturaleza: "ordinario",
        respaldo: null,
        etiqueta: "Bonificación por pago en término",
        importe: cifra("-1000000.00"),
        participacionTexto: "-11,11",
        desagregado: [],
        lineasDeOrigen: 1,
      },
    ];
    expect(() => parsearVistaInformeMensual(roto)).toThrow(/es un grupo negativo de primer nivel/);
  });

  it("y adentro del grupo que la origina sí, con el grupo publicando su neto", () => {
    const v = parsearVistaInformeMensual(informeMuestra());
    const cuota = v.devengado.ingresos.find((g) => g.clave === "cuota_ordinaria");
    expect(cuota?.importe.monto).toBe("9000000.00");
    expect(cuota?.participacionTexto).toBe("100,00");
    expect(cuota?.desagregado.map((l) => l.importe.monto)).toEqual(["10000000.00", "-1000000.00"]);
    // Ningún grupo de ingreso pasa del 100 %, que es lo único que el lector tenía que poder dar por
    // sentado.
    for (const g of v.devengado.ingresos) expect(Number(g.participacionTexto.replace(",", "."))).toBeLessThanOrEqual(100);
  });

  it("el desagregado de un grupo de INGRESO también tiene que sumar el grupo", () => {
    const roto = informeMuestra() as any;
    roto.devengado.ingresos[0].desagregado[1].importe = cifra("-999999.00");
    expect(() => parsearVistaInformeMensual(roto)).toThrow(/el desagregado de .{0,4}Cuota ordinaria del período/);
  });

  it("los honorarios de administración llevan renglón propio SIEMPRE", () => {
    const roto = informeMuestra() as any;
    roto.devengado.egresos = roto.devengado.egresos.filter((g: any) => g.clave !== "honorarios_administracion");
    roto.devengado.totalEgresos = cifra("7300000.00");
    roto.devengado.resultado = cifra("1700000.00");
    expect(() => parsearVistaInformeMensual(roto)).toThrow(/falta el grupo .{0,4}honorarios_administracion/);
  });

  it("la participación impresa sale del mismo denominador que el total impreso", () => {
    const roto = informeMuestra() as any;
    roto.devengado.egresos[0].participacionTexto = "60,00";
    expect(() => parsearVistaInformeMensual(roto)).toThrow(/la participación impresa dice 60,00 %/);
  });

  it("el proveedor persona humana NO tiene dónde poner un nombre", () => {
    const v = parsearVistaInformeMensual(informeMuestra());
    const linea = v.devengado.egresos
      .flatMap((g) => g.desagregado)
      .find((l) => l.proveedor.tipo === "persona_humana");
    expect(linea?.proveedor).toEqual({ tipo: "persona_humana", cantidad: 2 });
    // El schema es estricto en la unión: un `nombre` colado en la variante de persona no entra.
    const roto = informeMuestra() as any;
    roto.devengado.egresos[1].desagregado[0].proveedor = { tipo: "persona_humana", cantidad: 2, nombre: "PÉREZ, JUAN" };
    expect(() => parsearVistaInformeMensual(roto)).toThrow();
  });
});

describe("el puente entre lo devengado y lo percibido", () => {
  it("arranca en el resultado del período, no en otro número", () => {
    expect(() => parsearVistaInformeMensual(con("conciliacion.partida", cifra("999.00")))).toThrow(
      /el puente arranca en 999.00/,
    );
  });

  it("llega al movimiento de fondos, y si no llega lo declara", () => {
    const roto = informeMuestra() as any;
    roto.conciliacion.renglones[0].importe = cifra("400000.00");
    expect(() => parsearVistaInformeMensual(roto)).toThrow(/el puente deja -100000.00 sin explicar/);
  });

  it("el cuadro de fondos y el puente tienen que decir lo mismo", () => {
    const roto = informeMuestra() as any;
    roto.financiero.fondos.saldoFinal = cifra("1800000.00");
    roto.financiero.fondos.egresos = cifra("7700000.00");
    expect(() => parsearVistaInformeMensual(roto)).toThrow(/el cuadro de fondos se movió 800000.00/);
  });

  it("un renglón faltante NO es un cero: el puente no puede declararse cerrado", () => {
    const roto = informeMuestra() as any;
    roto.conciliacion.renglones[1].importe = faltante("el barrio no cerró el circuito de órdenes de pago");
    // Con el hueco tratado como cero el puente "cierra", que es exactamente la mentira a evitar.
    expect(() => parsearVistaInformeMensual(roto)).toThrow(/un hueco no es un cero/);
  });

  it("y tampoco vale declarar la diferencia como un cero explícito", () => {
    // `null` y `$ 0,00` afirman lo mismo. Sin este caso, el invariante se esquivaba con un renglón.
    const roto = informeMuestra() as any;
    roto.conciliacion.renglones[1].importe = faltante("el barrio no cerró el circuito de órdenes de pago");
    roto.conciliacion.diferenciaSinExplicar = cifra("0.00");
    expect(() => parsearVistaInformeMensual(roto)).toThrow(/un hueco no es un cero/);
  });

  it("con un hueco en el cuadro de fondos, el puente queda sin verificar y hay que decirlo", () => {
    const roto = informeMuestra() as any;
    roto.financiero.fondos.ingresos = faltante("el extracto del banco del período todavía no llegó");
    expect(() => parsearVistaInformeMensual(roto)).toThrow(/el puente entre A y B no se pudo verificar/);

    roto.financiero.fondos.marcadorObservacion = 1;
    roto.observaciones = [
      { clave: "sin_respaldo", ancla: "financiero.fondos", marcador: 1, texto: "Falta el extracto del período." },
    ];
    expect(() => parsearVistaInformeMensual(roto)).not.toThrow();
  });
});

describe("los bordes del piso de desagregación", () => {
  /** Un informe con un solo grupo de gasto del peso pedido, para tocar el borde exacto. */
  function conPeso(monto: string, desagregado: unknown[] = []) {
    const base = informeMuestra() as any;
    // 5,00 % exacto de 8.000.000 son 400.000: el resto va a un grupo que no llega al piso.
    base.devengado.egresos = [
      {
        clave: "seguridad",
        naturaleza: "ordinario",
        respaldo: null,
        etiqueta: "Seguridad y control de acceso",
        importe: cifra(monto),
        participacionTexto: participacion(monto, "8000000.00"),
        desagregado,
        lineasDeOrigen: 5,
      },
      {
        clave: "honorarios_administracion",
        naturaleza: "ordinario",
        respaldo: null,
        etiqueta: "Honorarios de administración",
        importe: cifra("300000.00"),
        participacionTexto: participacion("300000.00", "8000000.00"),
        desagregado: [],
        lineasDeOrigen: 1,
      },
      {
        clave: "resto",
        naturaleza: "ordinario",
        respaldo: null,
        etiqueta: "Resto",
        importe: cifra(deCentavos(aCentavos("7700000.00") - aCentavos(monto))),
        participacionTexto: participacion(deCentavos(aCentavos("7700000.00") - aCentavos(monto)), "8000000.00"),
        desagregado: [
          {
            concepto: "Varios",
            proveedor: { tipo: "sin_identificar" },
            importe: cifra(deCentavos(aCentavos("7700000.00") - aCentavos(monto))),
          },
        ],
        lineasDeOrigen: 9,
      },
    ];
    base.devengado.totalEgresos = cifra("8000000.00");
    base.devengado.resultado = cifra("1000000.00");
    // Los tres grupos de este escenario son ordinarios, así que el resultado ordinario acompaña al
    // total. Sin esto el invariante nuevo corta antes de llegar al piso de desagregación, que es lo
    // que estos tests están probando.
    base.devengado.resultadoOrdinario = cifra("1000000.00");
    base.conciliacion.partida = cifra("1000000.00");
    base.conciliacion.movimientoDeFondos = cifra("500000.00");
    base.financiero.fondos.egresos = cifra("8000000.00");
    base.financiero.fondos.saldoFinal = cifra("1500000.00");
    base.financiero.deudaProveedores.devengadoDelPeriodo = cifra("8000000.00");
    base.financiero.deudaProveedores.pagadoEnElPeriodo = cifra("8000000.00");
    return base;
  }

  it("en 5,00 % EXACTO ya hay que desagregar: el piso es «alcanza», no «supera»", () => {
    expect(() => parsearVistaInformeMensual(conPeso("400000.00"))).toThrow(/va sin desagregar/);
  });

  it("apenas por debajo del piso, no", () => {
    expect(() => parsearVistaInformeMensual(conPeso("399999.00"))).not.toThrow();
  });

  it("un grupo NEGATIVO grande no se escapa por el signo", () => {
    // Un recupero o una nota de crédito daban peso negativo y nunca superaban el piso, por grande
    // que fueran. El peso se mide en valor absoluto.
    const base = conPeso("-1000000.00");
    base.devengado.egresos[2].importe = cifra("8700000.00");
    base.devengado.egresos[2].participacionTexto = participacion("8700000.00", "8000000.00");
    base.devengado.egresos[2].desagregado = [
      { concepto: "Varios", proveedor: { tipo: "sin_identificar" }, importe: cifra("8700000.00") },
    ];
    expect(() => parsearVistaInformeMensual(base)).toThrow(/va sin desagregar/);
  });
});

describe("la rueda de proveedores", () => {
  it("devenga exactamente el gasto del período", () => {
    expect(() =>
      parsearVistaInformeMensual(con("financiero.deudaProveedores.devengadoDelPeriodo", cifra("7000000.00"))),
    ).toThrow(/la rueda de proveedores devenga 7000000.00/);
  });

  it("si abre distinto de como cerró el informe anterior, hay que señalarlo", () => {
    const roto = informeMuestra() as any;
    roto.financiero.deudaProveedores.cierreDelPeriodoAnterior = cifra("1900000.00");
    expect(() => parsearVistaInformeMensual(roto)).toThrow(/la diferencia se señala con una observación/);
  });

  it("con la observación puesta, se emite igual: el documento publica lo que no cierra", () => {
    const con2 = informeMuestra() as any;
    con2.financiero.deudaProveedores.cierreDelPeriodoAnterior = cifra("1900000.00");
    con2.financiero.deudaProveedores.marcadorObservacion = 1;
    con2.observaciones = [
      { clave: "no_concilia", ancla: "financiero.deudaProveedores", marcador: 1, texto: "Hay $ 100.000,00 sin explicar." },
    ];
    expect(parsearVistaInformeMensual(con2).observaciones).toHaveLength(1);
  });

  it("un marcador que no apunta a ninguna observación no pasa", () => {
    expect(() => parsearVistaInformeMensual(con("financiero.fondos.marcadorObservacion", 9))).toThrow(
      /el marcador \(9\) no tiene observación/,
    );
  });
});

describe("participacion()", () => {
  it("es exacta y no pasa por `number`", () => {
    expect(participacion("5000000.00", "7800000.00")).toBe("64,10");
    expect(participacion("-1000000.00", "9000000.00")).toBe("-11,11");
    expect(participacion("100.00", "0.00")).toBe("0,00");
  });
});

describe("figura jurídica", () => {
  it("un fideicomiso no emite: no hay fuente cargada de denominación ni órganos", () => {
    expect(() => parsearVistaInformeMensual(con("barrio", { nombre: "Los Aromos", figuraJuridica: "fideicomiso", domicilio: null }))).toThrow(
      /fideicomiso: la emisión se bloquea/,
    );
  });
});

/**
 * Art. 2048: las extraordinarias son las **dispuestas por resolución de la asamblea**. El invariante
 * vive en el esquema y no en el productor porque la vista congelada es lo que explica un documento
 * emitido sin volver a correr el período (ADR-0001 §6): si la regla la cumpliera solo el productor,
 * la saltearía cualquier segundo productor —una re-emisión, un fixture, un script.
 */
describe("toda erogación extraordinaria dice qué la aprobó", () => {
  const ACTA = { tipo: "acta" as const, referencia: "Acta 14/2026", fecha: { texto: "12/05/2026", iso: "2026-05-12" } };

  /** Convierte el primer egreso del fixture en extraordinario, con el respaldo que se le pase. */
  function conExtraordinario(respaldo: unknown): unknown {
    const base = informeMuestra() as any;
    base.devengado.egresos[0] = { ...base.devengado.egresos[0], naturaleza: "extraordinario", respaldo };
    // Al salir del ordinario, el resultado ordinario sube por el gasto que ya no cuenta.
    const gasto = aCentavos(base.devengado.egresos[0].importe.monto);
    base.devengado.resultadoOrdinario = cifra(deCentavos(aCentavos("1200000.00") + gasto));
    return base;
  }

  it("una extraordinaria SIN respaldo no se puede emitir", () => {
    expect(() => parsearVistaInformeMensual(conExtraordinario(null))).toThrow(/no declara el acto que lo aprobó/);
  });

  it("con el acta declarada, sí", () => {
    expect(() => parsearVistaInformeMensual(conExtraordinario(ACTA))).not.toThrow();
  });

  /**
   * El hueco declarado cuenta como respuesta: dice qué falta y quién lo carga. Bloquear la emisión
   * termina con alguien escribiendo "Acta s/n" para destrabarla, y un respaldo inventado se lee
   * igual que uno real.
   */
  it("un dato faltante declarado alcanza: lo que no se admite es el silencio", () => {
    const pendiente = faltante("el acta todavía no está cargada", "la administración");
    expect(() => parsearVistaInformeMensual(conExtraordinario(pendiente))).not.toThrow();
  });

  it("un ordinario CON acta tampoco pasa: o la naturaleza está mal, o el respaldo es de otro renglón", () => {
    const base = informeMuestra() as any;
    base.devengado.egresos[0] = { ...base.devengado.egresos[0], respaldo: ACTA };
    expect(() => parsearVistaInformeMensual(base)).toThrow(/es ordinario y trae un respaldo/);
  });

  it("el resultado ordinario sale de los grupos ordinarios y no se escribe a mano", () => {
    expect(() => parsearVistaInformeMensual(con("devengado.resultadoOrdinario", cifra("999.00")))).toThrow(
      /los grupos ordinarios dan/,
    );
  });
});

/**
 * Art. 2046 inc. d (*"si lo hay"*) y art. 2064 inc. c (autorización del consejo, **que puede no
 * existir**). Las dos mitades importan: la sección es opcional, y su regla de autorización admite
 * el hueco declarado o bloquearía a los barrios sin consejo.
 */
describe("el fondo de reserva", () => {
  const AUTORIZACION = {
    tipo: "acta" as const,
    referencia: "Acta de consejo 3/2026",
    fecha: { texto: "02/05/2026", iso: "2026-05-02" },
  };

  it("un barrio sin fondo emite igual: la sección es opcional, no un hueco", () => {
    expect(() => parsearVistaInformeMensual(con("financiero.fondoReserva", null))).not.toThrow();
  });

  it("si se aplicó el fondo, el documento dice con qué autorización", () => {
    const base = informeMuestra() as any;
    base.financiero.fondoReserva.aplicaciones = [{ concepto: "Reparación del portón", importe: cifra("500000.00") }];
    base.financiero.fondoReserva.saldoFinal = cifra("3000000.00");
    expect(() => parsearVistaInformeMensual(base)).toThrow(/no dice con qué autorización/);
  });

  it("con la autorización declarada, sí", () => {
    const base = informeMuestra() as any;
    base.financiero.fondoReserva.aplicaciones = [{ concepto: "Reparación del portón", importe: cifra("500000.00") }];
    base.financiero.fondoReserva.saldoFinal = cifra("3000000.00");
    base.financiero.fondoReserva.autorizacionDeUso = AUTORIZACION;
    expect(() => parsearVistaInformeMensual(base)).not.toThrow();
  });

  /** El barrio sin consejo no queda bloqueado: declara que no lo tiene y emite. */
  it("un barrio sin consejo declara el hueco y emite igual", () => {
    const base = informeMuestra() as any;
    base.financiero.fondoReserva.aplicaciones = [{ concepto: "Reparación del portón", importe: cifra("500000.00") }];
    base.financiero.fondoReserva.saldoFinal = cifra("3000000.00");
    base.financiero.fondoReserva.autorizacionDeUso = faltante("el barrio no tiene consejo de propietarios constituido");
    expect(() => parsearVistaInformeMensual(base)).not.toThrow();
  });

  it("una autorización sin uso no pasa: sin aplicaciones no hay nada que autorizar", () => {
    expect(() => parsearVistaInformeMensual(con("financiero.fondoReserva.autorizacionDeUso", AUTORIZACION))).toThrow(
      /sin uso no hay nada que autorizar/,
    );
  });

  it("la rueda tiene que cerrar: abre + aporte − aplicado = cierra", () => {
    expect(() => parsearVistaInformeMensual(con("financiero.fondoReserva.saldoFinal", cifra("9999999.00")))).toThrow(
      /la rueda del fondo no cierra/,
    );
  });

  /**
   * Si el fondo está en cuenta separada, marcar plata afectada en el saldo operativo descuenta dos
   * veces el mismo dinero.
   */
  it("en cuenta separada, el saldo operativo no puede declarar plata afectada", () => {
    expect(() => parsearVistaInformeMensual(con("financiero.fondos.afectadoAFondoReserva", cifra("100000.00")))).toThrow(
      /el fondo está en cuenta separada/,
    );
  });
});

describe("los denominadores que no pueden faltar", () => {
  it("sin las unidades alcanzadas, no se emite", () => {
    const base = informeMuestra() as any;
    base.denominadores = base.denominadores.filter((d: any) => d.clave !== "unidades_alcanzadas");
    expect(() => parsearVistaInformeMensual(base)).toThrow(/falta el denominador .*unidades_alcanzadas/);
  });

  /** Es el número que el vecino compara con la cuota que le llegó en el mismo email. */
  it("sin el gasto por unidad, tampoco", () => {
    const base = informeMuestra() as any;
    base.denominadores = base.denominadores.filter((d: any) => d.clave !== "gasto_por_unidad");
    expect(() => parsearVistaInformeMensual(base)).toThrow(/falta el denominador .*gasto_por_unidad/);
  });

  it("el renglón puede venir como faltante declarado: lo que no puede es no estar", () => {
    const base = informeMuestra() as any;
    const i = base.denominadores.findIndex((d: any) => d.clave === "gasto_por_unidad");
    base.denominadores[i].valorTexto = faltante("el barrio todavía no cargó el padrón", "la administración");
    expect(() => parsearVistaInformeMensual(base)).not.toThrow();
  });
});

/**
 * La sección de créditos con las unidades **es** el total de mora agregado, y su publicación es una
 * decisión del barrio, no un default del producto (mismo criterio que `orden_pago_cuatro_ojos`).
 */
describe("la rueda de créditos con las unidades", () => {
  it("viene apagada, y el informe se emite sin ella", () => {
    const v = parsearVistaInformeMensual(informeMuestra());
    expect(v.financiero.creditosConUnidades).toBeNull();
  });

  it("prendida, se emite con la rueda", () => {
    const base = informeMuestra() as any;
    base.financiero.creditosConUnidades = {
      saldoInicial: cifra("4000000.00"),
      devengadoDelPeriodo: cifra("9000000.00"),
      cobradoEnElPeriodo: cifra("8500000.00"),
      saldoFinal: cifra("4500000.00"),
      marcadorObservacion: null,
    };
    expect(() => parsearVistaInformeMensual(base)).not.toThrow();
  });
});
