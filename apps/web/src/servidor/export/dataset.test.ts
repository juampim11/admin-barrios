import { describe, expect, it } from "vitest";
import type { LibroDeMovimientos } from "@admin-barrios/data/servicios/exportaciones";
import { construirLibro, type Hoja } from "./dataset.ts";

/**
 * El dataset es puro, así que se puede probar sin base: lo que se verifica acá son las **decisiones
 * del panel de dominio**, no la consulta SQL.
 *
 * La más importante, y la razón de que este archivo exista: **la hoja B tiene que sumar exactamente
 * igual que la A**. Esa identidad es el producto de la exportación — es lo que le permite al
 * contador confiar en la vista imputada después de haber cuadrado la de caja contra el banco.
 */

const SELLO = "2026-08-26T12:00:00Z";
const RANGO = { periodoDesde: "2026-07", periodoHasta: "2026-08" } as const;

const CABECERA_BASE = {
  barrioNombre: "Los Álamos",
  barrioCuit: "30712345678",
  municipio: "villa-allende",
  figuraJuridica: "ph_especial",
  modelosDePeriodo: ["variable"],
  incluyeProvisorio: false,
} as const;

const LIBRO_VACIO: LibroDeMovimientos = {
  cabecera: CABECERA_BASE,
  ingresos: [],
  imputaciones: [],
  egresos: [],
  anulaciones: [],
};

function hojaLlamada(libro: LibroDeMovimientos, nombre: string): Hoja {
  const construido = construirLibro(libro, RANGO, SELLO);
  const hoja = construido.hojas.find((h) => h.nombre === nombre);
  if (!hoja) throw new Error(`no hay hoja ${nombre}`);
  return hoja;
}

/** Un pago con sus datos mínimos; `montoImputado` es lo que decide si queda algo "a cuenta". */
function pago(monto: string, montoImputado: string, periodos: string | null = null) {
  return {
    pagoId: `pago-${monto}-${montoImputado}`,
    fecha: "2026-07-10",
    monto,
    montoImputado,
    origen: "manual",
    estadoConciliacion: "pendiente",
    unidadEtiqueta: "MZ 1 — LOTE 5",
    obligadoNombre: "Pérez, Ana",
    obligadoCuit: "27123456789",
    periodosImputados: periodos,
  };
}

function imputacion(montoImputado: string, total: string, periodo = "2026-07") {
  return {
    imputacionId: `imp-${montoImputado}`,
    pagoId: "pago-x",
    fechaPago: "2026-07-10",
    montoImputado,
    unidadEtiqueta: "MZ 1 — LOTE 5",
    periodoOrigen: periodo,
    numeroComprobante: "0001-00000042",
    liquidacionTotal: total,
    subtotalOrdinarias: "800.00",
    subtotalExtraordinarias: "0.00",
    subtotalFondoReserva: "200.00",
    interesMora: null,
  };
}

function egreso(campos: Partial<LibroDeMovimientos["egresos"][number]> = {}) {
  return {
    gastoId: "gasto-1",
    periodo: "2026-07",
    descripcion: "Mantenimiento de bombas",
    monto: "15000.00",
    conceptoNombre: "Mantenimiento",
    conceptoTipo: "ordinaria",
    esFondoReserva: false,
    clasificacionFiscal: "sin_clasificar",
    origenClasificacion: "catalogo" as const,
    proveedorNombre: "Bombas del Sur SRL",
    proveedorCuit: "30712345678",
    comprobante: null,
    numeroFactura: "A-0001-00001234",
    fechaPago: "2026-07-15",
    fechaRegistracion: "2026-07-27",
    sinRespaldoDocumental: false,
    motivoSinRespaldo: null,
    sinRespaldoAsamblea: false,
    revierteDescripcion: null,
    revierteperiodo: null,
    ...campos,
  };
}

describe("la identidad entre las dos hojas de ingresos", () => {
  /**
   * **El invariante central del módulo.** Si esto se rompe, el contador cuadra la hoja de caja
   * contra el banco, pasa a la imputada y los números no coinciden — y desde la planilla no hay
   * forma de saber cuál de las dos está mal.
   */
  it("la hoja B suma igual que la A cuando todo está imputado", () => {
    const libro: LibroDeMovimientos = {
      ...LIBRO_VACIO,
      ingresos: [pago("1000.00", "1000.00", "2026-07")],
      imputaciones: [imputacion("1000.00", "1000.00")],
    };

    const a = hojaLlamada(libro, "Cobranzas (percibido)");
    const b = hojaLlamada(libro, "Cobranzas imputadas");

    expect(a.bloquePosterior.join(" ")).toContain("Total cobrado: 1000.00");
    expect(b.bloquePosterior.join(" ")).toContain("1000.00");
    expect(b.filas).toHaveLength(1);
  });

  /**
   * El caso que hace falta la fila residual: un pago que entró y todavía no se aplicó a ninguna
   * boleta. En una planilla puramente imputada **desaparecería**, y la planilla reportaría menos
   * caja de la que entró.
   */
  it("un pago sin imputar aparece en las dos hojas, como «a cuenta»", () => {
    const libro: LibroDeMovimientos = {
      ...LIBRO_VACIO,
      ingresos: [pago("1000.00", "0.00")],
      imputaciones: [],
    };

    const a = hojaLlamada(libro, "Cobranzas (percibido)");
    const b = hojaLlamada(libro, "Cobranzas imputadas");

    expect(a.filas).toHaveLength(1);
    expect(a.filas[0]).toContain("A cuenta — sin aplicar");
    // La residual existe: sin ella, la hoja B sumaría 0 y la A 1000.
    expect(b.filas).toHaveLength(1);
    expect(b.filas[0]).toContain("A cuenta — todavía no aplicado a una boleta");
    expect(a.bloquePosterior.join(" ")).toContain("Total a cuenta: 1000.00");
  });

  it("un pago aplicado a medias deja el resto «a cuenta» en la hoja B", () => {
    const libro: LibroDeMovimientos = {
      ...LIBRO_VACIO,
      ingresos: [pago("1000.00", "600.00", "2026-07")],
      imputaciones: [imputacion("600.00", "1500.00")],
    };

    const b = hojaLlamada(libro, "Cobranzas imputadas");
    expect(b.filas).toHaveLength(2);
    // La imputación real, más la residual de 400.
    expect(b.filas.some((f) => f.includes(600))).toBe(true);
    expect(b.filas.some((f) => f.includes(400))).toBe(true);
  });

  it("un pago que cubre dos boletas es UNA fila en la hoja A y dos en la B", () => {
    const libro: LibroDeMovimientos = {
      ...LIBRO_VACIO,
      ingresos: [pago("2000.00", "2000.00", "2026-07, 2026-08")],
      imputaciones: [imputacion("1000.00", "1000.00", "2026-07"), imputacion("1000.00", "1000.00", "2026-08")],
    };

    expect(hojaLlamada(libro, "Cobranzas (percibido)").filas).toHaveLength(1);
    expect(hojaLlamada(libro, "Cobranzas imputadas").filas).toHaveLength(2);
    expect(hojaLlamada(libro, "Cobranzas (percibido)").filas[0]).toContain("Aplicado a varios períodos");
  });
});

describe("la hoja B no promete lo que el modelo no registra", () => {
  it("dice si la imputación cubre la boleta completa o es parcial", () => {
    const completa = hojaLlamada(
      { ...LIBRO_VACIO, ingresos: [pago("1000.00", "1000.00")], imputaciones: [imputacion("1000.00", "1000.00")] },
      "Cobranzas imputadas",
    );
    expect(completa.filas[0]).toContain("Cubre la boleta completa");

    const parcial = hojaLlamada(
      { ...LIBRO_VACIO, ingresos: [pago("600.00", "600.00")], imputaciones: [imputacion("600.00", "1500.00")] },
      "Cobranzas imputadas",
    );
    expect(parcial.filas[0]).toContain("Aplicación parcial");
  });

  it("aclara que los subtotales son la composición de la boleta, no el detalle de la aplicación", () => {
    const b = hojaLlamada(LIBRO_VACIO, "Cobranzas imputadas");
    expect(b.bloquePrevio.join(" ")).toContain("COMPOSICIÓN DE LA BOLETA");
  });

  /** No es devengado: es caja asignada a un devengado anterior. El rótulo importa. */
  it("en ningún lado dice «devengado»", () => {
    const construido = construirLibro(LIBRO_VACIO, RANGO, SELLO);
    const texto = JSON.stringify(construido).toLowerCase();
    expect(texto).not.toContain("devengado");
  });
});

describe("los egresos", () => {
  /** CLAUDE.md §1.4: un negativo suelto es una cifra sin origen. */
  it("un ajuste de OP anulada sale como reversión, con el gasto que revierte a la vista", () => {
    const hoja = hojaLlamada(
      {
        ...LIBRO_VACIO,
        egresos: [
          egreso({
            monto: "-15000.00",
            revierteDescripcion: "Mantenimiento de bombas",
            revierteperiodo: "2026-07",
          }),
        ],
      },
      "Egresos",
    );

    expect(hoja.filas[0]).toContain("Reversión de una orden de pago anulada");
    expect(hoja.filas[0]?.some((c) => String(c).includes("Mantenimiento de bombas (período 2026-07)"))).toBe(true);
    // El signo viaja fiel: lo que lo explica es la columna «Revierte a», no darlo vuelta.
    expect(hoja.filas[0]).toContain(-15000);
  });

  /**
   * La fecha de la factura del proveedor **no existe en el modelo**. Sale vacía y el aviso lo dice:
   * suplirla con `created_at` mostraría cuarenta egresos el mismo día.
   */
  it("la fecha de comprobante va vacía y el aviso lo explica", () => {
    const hoja = hojaLlamada({ ...LIBRO_VACIO, egresos: [egreso()] }, "Egresos");
    const iFecha = hoja.columnas.findIndex((c) => c.header === "Fecha de comprobante");
    expect(hoja.filas[0]?.[iFecha]).toBeNull();
    expect(hoja.bloquePrevio.join(" ")).toContain("todavía no registra la fecha de la factura");
  });

  it("las tres fechas son columnas distintas y ninguna se llama solo «Fecha»", () => {
    const hoja = hojaLlamada(LIBRO_VACIO, "Egresos");
    const headers = hoja.columnas.map((c) => c.header);
    expect(headers).toContain("Fecha de pago");
    expect(headers).toContain("Fecha de comprobante");
    expect(headers).toContain("Fecha de carga");
    expect(headers).not.toContain("Fecha");
  });

  it("ordinaria/extraordinaria y fondo de reserva son columnas propias, no notas", () => {
    const headers = hojaLlamada(LIBRO_VACIO, "Egresos").columnas.map((c) => c.header);
    expect(headers).toContain("Tipo (art. 2048)");
    expect(headers).toContain("Fondo de reserva");
  });

  /** Un blanco se lee como "no corresponde", que es afirmar un encuadre que nadie declaró. */
  it("`sin_clasificar` sale con su literal y con subtotal propio arriba", () => {
    const hoja = hojaLlamada({ ...LIBRO_VACIO, egresos: [egreso({ monto: "15000.00" })] }, "Egresos");
    expect(hoja.filas[0]).toContain("SIN CLASIFICAR — requiere definición");
    expect(hoja.bloquePrevio.join(" ")).toContain("Conceptos pendientes de encuadre fiscal: 1 líneas, 15000.00");
  });

  it("el origen de la clasificación viaja por fila", () => {
    const hoja = hojaLlamada(
      {
        ...LIBRO_VACIO,
        egresos: [
          egreso({ gastoId: "g1", origenClasificacion: "snapshot", clasificacionFiscal: "alcanzado" }),
          egreso({ gastoId: "g2", origenClasificacion: "catalogo" }),
        ],
      },
      "Egresos",
    );
    expect(hoja.filas[0]).toContain("Congelada al emitir");
    expect(hoja.filas[1]).toContain("Catálogo vigente (borrador)");
  });
});

describe("el encabezado y el nombre del archivo", () => {
  it("un período no emitido marca PROVISORIO en el encabezado y en el nombre", () => {
    const libro = { ...LIBRO_VACIO, cabecera: { ...CABECERA_BASE, incluyeProvisorio: true } };
    const construido = construirLibro(libro, RANGO, SELLO);

    expect(construido.nombreArchivo).toContain("PROVISORIO");
    expect(construido.hojas[0]?.bloquePrevio.join(" ")).toContain("PROVISORIO");
  });

  it("un rango emitido no dice PROVISORIO en ninguna parte", () => {
    const construido = construirLibro(LIBRO_VACIO, RANGO, SELLO);
    expect(construido.nombreArchivo).not.toContain("PROVISORIO");
    expect(JSON.stringify(construido)).not.toContain("PROVISORIO");
  });

  it("lleva la figura vigente en el período, el sello y el disclaimer", () => {
    const encabezado = hojaLlamada(LIBRO_VACIO, "Egresos").bloquePrevio.join(" ");
    expect(encabezado).toContain("Figura jurídica vigente en el período: ph_especial");
    expect(encabezado).toContain(`Extraído el: ${SELLO}`);
    expect(encabezado).toContain("NO es una liquidación impositiva");
    expect(encabezado).toContain("Contiene datos personales");
  });

  it("el nombre del archivo no lleva el nombre de ninguna persona", () => {
    const libro = { ...LIBRO_VACIO, ingresos: [pago("100.00", "0.00")] };
    const construido = construirLibro(libro, RANGO, SELLO);
    expect(construido.nombreArchivo).not.toContain("Pérez");
    expect(construido.nombreArchivo).toContain("Los Álamos");
  });
});

describe("el saneado de fórmula llega a la planilla", () => {
  /**
   * El canal es real: lo escribe un `operador`, lo abre el contador en su máquina. El saneado vive
   * en `shared`, pero lo que este test cuida es que el dataset **lo aplique** — una función de
   * saneado que nadie llama no protege nada.
   */
  it("neutraliza una fórmula en el motivo de anulación", () => {
    const hoja = hojaLlamada(
      {
        ...LIBRO_VACIO,
        anulaciones: [
          {
            pagoId: "p1",
            fecha: "2026-07-01",
            monto: "500.00",
            unidadEtiqueta: "MZ 1 — LOTE 5",
            anuladoAt: "2026-07-20",
            motivoAnulacion: "=HYPERLINK(\"http://malo.test\",\"click\")",
          },
        ],
      },
      "Anulaciones",
    );
    expect(hoja.filas[0]?.some((c) => String(c).startsWith("'=HYPERLINK"))).toBe(true);
  });

  it("neutraliza una fórmula en la descripción y en el nombre del proveedor", () => {
    const hoja = hojaLlamada(
      {
        ...LIBRO_VACIO,
        egresos: [egreso({ descripcion: "=1+1", proveedorNombre: "@SUM(A1)" })],
      },
      "Egresos",
    );
    expect(hoja.filas[0]).toContain("'=1+1");
    expect(hoja.filas[0]).toContain("'@SUM(A1)");
  });
});

describe("las anulaciones", () => {
  it("van en su hoja y fuera de todo total", () => {
    const hoja = hojaLlamada(
      {
        ...LIBRO_VACIO,
        ingresos: [pago("1000.00", "1000.00")],
        anulaciones: [
          {
            pagoId: "p1",
            fecha: "2026-05-03",
            monto: "500.00",
            unidadEtiqueta: "MZ 2 — LOTE 1",
            anuladoAt: "2026-07-20",
            motivoAnulacion: "Duplicado",
          },
        ],
      },
      "Anulaciones",
    );

    expect(hoja.filas).toHaveLength(1);
    expect(hoja.bloquePrevio.join(" ")).toContain("NO están incluidos en ningún total");
    // El pago anulado es de mayo pero se anuló en julio: por eso aparece en este libro.
    expect(hoja.filas[0]).toContain("2026-05-03");
    expect(hoja.filas[0]).toContain("2026-07-20");
  });
});

describe("la hoja de leyenda", () => {
  it("explica que `sin clasificar` no afirma nada sobre IIBB", () => {
    const hoja = hojaLlamada(LIBRO_VACIO, "Leyenda");
    const texto = JSON.stringify(hoja);
    expect(texto).toContain("NO es una afirmación de que el concepto esté fuera del alcance");
    expect(hoja.bloquePrevio.join(" ")).toContain("NO constituye");
  });
});
