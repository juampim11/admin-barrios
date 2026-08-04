import { describe, expect, it } from "vitest";
import { aCentavos, sumarMontos } from "./dinero.ts";
import {
  calcularLiquidacion,
  calcularMora,
  estadoDelCierre,
  evaluarSuficienciaDeLaCuota,
  PASOS_DEL_PERIODO,
  SITUACIONES_DEL_CIERRE,
  transicionValida,
  type HechosDelCierre,
  type GastoDelPeriodo,
  type UnidadAPRorratear,
} from "./liquidacion.ts";

const GASTOS: GastoDelPeriodo[] = [
  { gastoId: "g1", conceptoId: "c1", descripcion: "Seguridad", tipo: "ordinaria", esFondoReserva: false, monto: "4500000.00" },
  { gastoId: "g2", conceptoId: "c2", descripcion: "Mantenimiento de espacios verdes", tipo: "ordinaria", esFondoReserva: false, monto: "1234567.89" },
  { gastoId: "g3", conceptoId: "c3", descripcion: "Portón de acceso (asamblea 12/07)", tipo: "extraordinaria", esFondoReserva: false, monto: "980000.00" },
  { gastoId: "g4", conceptoId: "c4", descripcion: "Fondo de reserva", tipo: "ordinaria", esFondoReserva: true, monto: "500000.00" },
];

/** 37 unidades con coeficientes despatarrados: el caso que rompe los redondeos ingenuos. */
const UNIDADES: UnidadAPRorratear[] = Array.from({ length: 37 }, (_, i) => ({
  unidadFuncionalId: `uf-${i}`,
  coeficiente: (0.02 + (i % 11) * 0.003).toFixed(9),
}));

describe("liquidación del período", () => {
  it("lo repartido es EXACTAMENTE igual al gasto del período", () => {
    const { totalGastos, totalRepartido } = calcularLiquidacion({ modelo: "variable", gastos: GASTOS, unidades: UNIDADES });
    expect(totalRepartido).toBe(totalGastos);
    expect(totalGastos).toBe("7214567.89");
  });

  it("cada unidad recibe una línea por gasto, con su origen", () => {
    const { liquidaciones } = calcularLiquidacion({ modelo: "variable", gastos: GASTOS, unidades: UNIDADES });
    const primera = liquidaciones[0];
    expect(primera?.items).toHaveLength(GASTOS.length);
    expect(primera?.items[0]).toMatchObject({
      gastoId: "g1",
      descripcion: "Seguridad",
      baseMonto: "4500000.00",
    });
    // El total de la unidad es la suma de sus líneas: nada aparece de la nada.
    expect(sumarMontos(...(primera?.items.map((i) => i.monto) ?? []))).toBe(primera?.total);
  });

  it("separa fondo de reserva, ordinarias y extraordinarias", () => {
    const { liquidaciones } = calcularLiquidacion({ modelo: "variable", gastos: GASTOS, unidades: UNIDADES });
    for (const liq of liquidaciones) {
      expect(sumarMontos(liq.subtotalOrdinarias, liq.subtotalExtraordinarias, liq.subtotalFondoReserva)).toBe(
        liq.total,
      );
    }
    // El fondo del barrio entero es el gasto del fondo: no se mezcla con las ordinarias.
    const fondo = sumarMontos(...liquidaciones.map((l) => l.subtotalFondoReserva));
    expect(fondo).toBe("500000.00");
    const extraordinarias = sumarMontos(...liquidaciones.map((l) => l.subtotalExtraordinarias));
    expect(extraordinarias).toBe("980000.00");
  });

  it("una unidad con coeficiente chiquito igual recibe su parte (nadie liquida en cero por redondeo)", () => {
    const { liquidaciones } = calcularLiquidacion({
      modelo: "variable",
      gastos: [{ gastoId: "g", conceptoId: "c", descripcion: "Gasto", tipo: "ordinaria", esFondoReserva: false, monto: "1000000.00" }],
      unidades: [
        { unidadFuncionalId: "grande", coeficiente: "0.999" },
        { unidadFuncionalId: "chica", coeficiente: "0.001" },
      ],
    });
    expect(liquidaciones.find((l) => l.unidadFuncionalId === "chica")?.total).toBe("1000.00");
  });

  it("un período sin gastos liquida cero, no falla", () => {
    const { liquidaciones, totalGastos } = calcularLiquidacion({ modelo: "variable", gastos: [], unidades: UNIDADES });
    expect(totalGastos).toBe("0.00");
    expect(liquidaciones.every((l) => l.total === "0.00")).toBe(true);
  });

  it("no liquida si no hay unidades ni acepta gastos negativos", () => {
    expect(() => calcularLiquidacion({ modelo: "variable", gastos: GASTOS, unidades: [] })).toThrow(/no hay unidades/i);
    expect(() =>
      calcularLiquidacion({
        modelo: "variable",
        gastos: [{ gastoId: "g", conceptoId: "c", descripcion: "Reintegro", tipo: "ordinaria", esFondoReserva: false, monto: "-100.00" }],
        unidades: UNIDADES,
      }),
    ).toThrow(/negativo/i);
  });
});

describe("mora", () => {
  it("sin tasa cargada NO inventa un interés", () => {
    const resultado = calcularMora({ saldoVencido: "100000.00", tasaMensual: null, diasDeAtraso: 45 });
    expect(resultado.interes).toBeNull();
    expect(resultado).toMatchObject({ motivo: "mora pendiente de definición" });
  });

  it("calcula interés simple proporcional a los días", () => {
    // 3% mensual sobre 100.000 durante 30 días = 3.000.
    const treinta = calcularMora({ saldoVencido: "100000.00", tasaMensual: "0.03", diasDeAtraso: 30 });
    expect(treinta.interes).toBe("3000.00");
    // La mitad de los días, la mitad del interés.
    const quince = calcularMora({ saldoVencido: "100000.00", tasaMensual: "0.03", diasDeAtraso: 15 });
    expect(quince.interes).toBe("1500.00");
  });

  it("sin atraso o sin saldo, no hay interés", () => {
    expect(calcularMora({ saldoVencido: "100000.00", tasaMensual: "0.03", diasDeAtraso: 0 }).interes).toBe("0.00");
    expect(calcularMora({ saldoVencido: "0.00", tasaMensual: "0.03", diasDeAtraso: 60 }).interes).toBe("0.00");
  });

  it("rechaza tasas y atrasos inválidos", () => {
    expect(() => calcularMora({ saldoVencido: "100.00", tasaMensual: "tres por ciento", diasDeAtraso: 1 })).toThrow();
    expect(() => calcularMora({ saldoVencido: "100.00", tasaMensual: "0.03", diasDeAtraso: -1 })).toThrow();
  });
});

describe("estados del período", () => {
  it("el camino normal avanza hasta distribuida", () => {
    expect(transicionValida("borrador", "revisada")).toBe(true);
    expect(transicionValida("revisada", "emitida")).toBe(true);
    expect(transicionValida("emitida", "distribuida")).toBe(true);
  });

  it("una liquidación emitida no vuelve a borrador", () => {
    expect(transicionValida("emitida", "borrador")).toBe(false);
    expect(transicionValida("emitida", "revisada")).toBe(false);
    expect(transicionValida("distribuida", "emitida")).toBe(false);
  });

  it("antes de emitir sí se puede volver atrás", () => {
    expect(transicionValida("revisada", "borrador")).toBe(true);
  });
});

describe("modelo de expensa FIJA (la cuota la define el directorio)", () => {
  const CUOTAS = new Map(UNIDADES.map((u, i) => [u.unidadFuncionalId, `${120000 + i * 1000}.00`]));

  it("cada unidad paga su cuota, no el gasto del mes", () => {
    const { liquidaciones, totalCuotasFijas, totalRepartido, totalGastos } = calcularLiquidacion({
      modelo: "fija",
      gastos: GASTOS.filter((g) => g.tipo === "ordinaria"),
      unidades: UNIDADES,
      cuotasFijas: CUOTAS,
    });

    expect(liquidaciones[0]?.subtotalCuotaFija).toBe(CUOTAS.get("uf-0"));
    expect(liquidaciones[0]?.total).toBe(CUOTAS.get("uf-0"));
    expect(totalRepartido).toBe(totalCuotasFijas);
    // Los gastos ordinarios se registran igual (reporte, libro), pero no se cobran de nuevo.
    expect(Number(totalGastos)).toBeGreaterThan(0);
    expect(totalRepartido).not.toBe(totalGastos);
  });

  it("las EXTRAORDINARIAS se prorratean igual, además de la cuota", () => {
    const extraordinaria = GASTOS.filter((g) => g.tipo === "extraordinaria");
    const { liquidaciones, totalRepartido, totalCuotasFijas } = calcularLiquidacion({
      modelo: "fija",
      gastos: extraordinaria,
      unidades: UNIDADES,
      cuotasFijas: CUOTAS,
    });

    expect(totalRepartido).toBe(sumarMontos(totalCuotasFijas, "980000.00"));
    const primera = liquidaciones[0];
    expect(primera?.subtotalExtraordinarias).not.toBe("0.00");
    expect(primera?.total).toBe(sumarMontos(primera?.subtotalCuotaFija ?? "0.00", primera?.subtotalExtraordinarias ?? "0.00"));
  });

  it("la línea de cuota fija no tiene coeficiente: no sale de un prorrateo", () => {
    const { liquidaciones } = calcularLiquidacion({
      modelo: "fija",
      gastos: [],
      unidades: UNIDADES,
      cuotasFijas: CUOTAS,
    });
    const item = liquidaciones[0]?.items[0];
    expect(item?.esCuotaFija).toBe(true);
    expect(item?.coeficienteAplicado).toBeNull();
    expect(item?.gastoId).toBeNull();
    expect(item?.baseMonto).toBe(CUOTAS.get("uf-0"));
  });

  it("si falta la cuota de una unidad, NO liquida (nadie queda sin cobrar por error)", () => {
    const incompletas = new Map(CUOTAS);
    incompletas.delete("uf-3");
    expect(() =>
      calcularLiquidacion({ modelo: "fija", gastos: [], unidades: UNIDADES, cuotasFijas: incompletas }),
    ).toThrow(/falta la cuota fija/i);

    expect(() => calcularLiquidacion({ modelo: "fija", gastos: [], unidades: UNIDADES })).toThrow(
      /necesita la cuota vigente/i,
    );
  });
});

describe("extraordinaria sin acta de asamblea", () => {
  it("se liquida igual, y queda contada para avisar", () => {
    const resultado = calcularLiquidacion({
      modelo: "variable",
      gastos: [
        { gastoId: "g1", conceptoId: "c1", descripcion: "Bomba de agua rota", tipo: "extraordinaria", esFondoReserva: false, monto: "450000.00", sinRespaldoAsamblea: true },
        { gastoId: "g2", conceptoId: "c2", descripcion: "Portón (acta 12/07)", tipo: "extraordinaria", esFondoReserva: false, monto: "980000.00" },
      ],
      unidades: UNIDADES,
    });

    expect(resultado.totalRepartido).toBe("1430000.00");
    expect(resultado.extraordinariasSinRespaldo).toBe(1);
  });
});

describe("cada línea se puede verificar con una calculadora", () => {
  it("guarda el monto teórico y el ajuste, y el ajuste explica la diferencia", () => {
    const { liquidaciones } = calcularLiquidacion({ modelo: "variable", gastos: GASTOS, unidades: UNIDADES });
    for (const liq of liquidaciones) {
      for (const item of liq.items) {
        expect(sumarMontos(item.montoTeorico, item.ajusteRedondeo)).toBe(item.monto);
        // Ninguna unidad se come el resto de las demás: como mucho, un centavo.
        const ajuste = aCentavos(item.ajusteRedondeo);
        expect(ajuste >= -1n && ajuste <= 1n).toBe(true);
      }
    }
  });

  it("funciona con coeficientes que NO suman 1 (superficie, art. 2081)", () => {
    const porSuperficie = [
      { unidadFuncionalId: "uf-1", coeficiente: "420" },
      { unidadFuncionalId: "uf-2", coeficiente: "580" },
    ];
    const { liquidaciones, totalRepartido } = calcularLiquidacion({
      modelo: "variable",
      gastos: [{ gastoId: "g", conceptoId: "c", descripcion: "Gasto", tipo: "ordinaria", esFondoReserva: false, monto: "1000.00" }],
      unidades: porSuperficie,
    });
    expect(liquidaciones.map((l) => l.total)).toEqual(["420.00", "580.00"]);
    expect(liquidaciones[0]?.items[0]?.montoTeorico).toBe("420.00");
    expect(totalRepartido).toBe("1000.00");
  });

  it("la línea de cuota fija no tiene ajuste: no hubo prorrateo", () => {
    const { liquidaciones } = calcularLiquidacion({
      modelo: "fija",
      gastos: [],
      unidades: UNIDADES,
      cuotasFijas: new Map(UNIDADES.map((u) => [u.unidadFuncionalId, "150000.00"])),
    });
    const item = liquidaciones[0]?.items[0];
    expect(item?.ajusteRedondeo).toBe("0.00");
    expect(item?.montoTeorico).toBe("150000.00");
  });
});
// ────────────────────────────────────────────────────────────────────────────────────────────────
// El cierre del mes — relevamiento del 2026-08-04
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Un mes sano en curso: variable, con gastos, sin borrador todavía. */
const MES: HechosDelCierre = {
  estado: "borrador",
  editable: true,
  modelo: "variable",
  puedeEmitir: true,
  cantidadGastos: 3,
  cantidadLiquidaciones: 0,
  unidadesActivas: 50,
  aplicacionesVigentes: 0,
  aplicacionesSinResolver: 0,
  tieneCoeficientesVigentes: true,
  cuotaFijaVersionId: null,
  gastosCambiaronDespuesDelBorrador: false,
};

const conBorrador = (extra: Partial<HechosDelCierre> = {}): HechosDelCierre => ({
  ...MES,
  cantidadLiquidaciones: 50,
  ...extra,
});

describe("el cierre del mes: en qué punto está", () => {
  it("un mes recién creado está preparando, y manda a cargar el primer gasto", () => {
    const r = estadoDelCierre({ ...MES, cantidadGastos: 0 });
    expect(r.situacion).toBe("preparando");
    expect(r.accion.destino).toBe("gastos");
  });

  it("con gastos y sin borrador ofrece GENERAR, no emitir", () => {
    // El defecto que se veía en pantalla: "Revisar y emitir" sobre algo que todavía no se calculó.
    const r = estadoDelCierre(MES);
    expect(r.situacion).toBe("listoParaGenerar");
    expect(r.accion.verbo).toBe("Generar el borrador");
    expect(r.accion.verbo).not.toContain("emitir");
  });

  it("con el borrador al día y sin nada pendiente, ofrece revisar y emitir", () => {
    const r = estadoDelCierre(conBorrador());
    expect(r.situacion).toBe("listoParaEmitir");
    expect(r.bloqueos).toEqual([]);
    expect(r.accion.verbo).toBe("Revisar y emitir");
  });

  it("emitido y distribuido son dos situaciones distintas", () => {
    expect(estadoDelCierre({ ...conBorrador(), editable: false, estado: "emitida" }).situacion).toBe("emitido");
    expect(estadoDelCierre({ ...conBorrador(), editable: false, estado: "distribuida" }).situacion).toBe("distribuido");
  });

  it("la situación es total: para toda combinación devuelve exactamente una de la lista", () => {
    for (const editable of [true, false]) {
      for (const gastos of [0, 3]) {
        for (const liqs of [0, 50]) {
          for (const sinResolver of [0, 2]) {
            const r = estadoDelCierre({
              ...MES,
              editable,
              cantidadGastos: gastos,
              cantidadLiquidaciones: liqs,
              aplicacionesSinResolver: sinResolver,
            });
            expect(SITUACIONES_DEL_CIERRE).toContain(r.situacion);
            expect(r.accion.porque.length).toBeGreaterThan(10);
          }
        }
      }
    }
  });
});

describe("el cierre del mes: los bloqueos son los que verifica la base", () => {
  it("un cargo aplicado después del borrador bloquea, y la acción pasa a REGENERAR", () => {
    // Sin esto la pantalla ofrecía emitir y la persona recibía un error de Postgres.
    const r = estadoDelCierre(conBorrador({ aplicacionesVigentes: 1, aplicacionesSinResolver: 1 }));
    expect(r.situacion).toBe("borradorDesactualizado");
    expect(r.bloqueos.map((b) => b.clave)).toContain("cargos");
    expect(r.accion.verbo).toBe("Regenerar el borrador");
  });

  it("un gasto cargado después del borrador bloquea en variable", () => {
    const r = estadoDelCierre(conBorrador({ gastosCambiaronDespuesDelBorrador: true }));
    expect(r.bloqueos.map((b) => b.clave)).toContain("gastos");
  });

  it("en fija un gasto ordinario NO bloquea: la cuota no sale de los gastos", () => {
    const r = estadoDelCierre(
      conBorrador({ modelo: "fija", cuotaFijaVersionId: "v1", gastosCambiaronDespuesDelBorrador: true }),
    );
    expect(r.bloqueos.map((b) => b.clave)).not.toContain("gastos");
  });

  it("el padrón que cambió después de generar bloquea, con las dos cifras dichas", () => {
    const r = estadoDelCierre(conBorrador({ unidadesActivas: 51 }));
    const bloqueo = r.bloqueos.find((b) => b.clave === "padron");
    expect(bloqueo?.que).toContain("50");
    expect(bloqueo?.que).toContain("51");
  });

  it("sin borrador no hay bloqueos: lo que falta es trabajo, y lo dice la situación", () => {
    expect(estadoDelCierre({ ...MES, cantidadGastos: 0 }).bloqueos).toEqual([]);
  });

  it("todo bloqueo dice qué pasa Y cómo se levanta", () => {
    const r = estadoDelCierre(
      conBorrador({ unidadesActivas: 51, aplicacionesSinResolver: 2, gastosCambiaronDespuesDelBorrador: true }),
    );
    expect(r.bloqueos.length).toBeGreaterThan(1);
    for (const b of r.bloqueos) {
      expect(b.que.length).toBeGreaterThan(10);
      expect(b.como.length).toBeGreaterThan(10);
    }
  });
});

describe("el cierre del mes: los frentes abiertos (la observación del usuario)", () => {
  it("cargar un gasto y aplicar un cargo se ofrecen SIEMPRE mientras el período sea editable", () => {
    // Es el reclamo textual: "no me ofrece o me dice que el paso natural también es cargar un cargo".
    const casos = [{ ...MES, cantidadGastos: 0 }, MES, conBorrador(), conBorrador({ aplicacionesSinResolver: 1 })];
    for (const hechos of casos) {
      const r = estadoDelCierre(hechos);
      expect(r.frentesAbiertos, `situacion ${r.situacion}`).toEqual(["gastos", "cargos"]);
    }
  });

  it("un período cerrado no ofrece ningún frente de escritura", () => {
    expect(estadoDelCierre({ ...conBorrador(), editable: false, estado: "emitida" }).frentesAbiertos).toEqual([]);
  });

  it("cargos sin movimientos es sin-novedades, nunca falta ni listo", () => {
    // El estado que faltaba: no está hecho (no se hizo nada) y no está pendiente (no hay nada que
    // hacer). Entre esas dos afirmaciones, ambas falsas, el paso había desaparecido de la pantalla.
    expect(estadoDelCierre(MES).frentes.cargos).toBe("sinNovedades");
    expect(estadoDelCierre({ ...MES, aplicacionesVigentes: 3 }).frentes.cargos).toBe("listo");
  });

  it("revisar y emitir NUNCA queda en listo antes de emitir", () => {
    // El tilde de más: estaba puesto con solo existir el borrador, y hacía saltear el paso.
    expect(estadoDelCierre(conBorrador()).frentes.revision).toBe("falta");
    expect(estadoDelCierre({ ...conBorrador(), editable: false, estado: "emitida" }).frentes.revision).toBe("listo");
  });

  it("en fija, un mes sin gastos no está faltando nada: la cuota no sale de ahí", () => {
    expect(estadoDelCierre({ ...MES, cantidadGastos: 0 }).frentes.gastos).toBe("falta");
    expect(estadoDelCierre({ ...MES, modelo: "fija", cuotaFijaVersionId: "v1", cantidadGastos: 0 }).frentes.gastos).toBe(
      "sinNovedades",
    );
  });

  it("todo frente del recorrido tiene estado, siempre", () => {
    const r = estadoDelCierre(MES);
    for (const paso of PASOS_DEL_PERIODO) expect(r.frentes[paso]).toBeDefined();
  });
});

describe("el cierre del mes: quién puede emitir", () => {
  it("a un rol que no emite no se le ofrece emitir", () => {
    const r = estadoDelCierre(conBorrador({ puedeEmitir: false }));
    expect(r.accion.verbo).toBe("Revisar las cifras");
    expect(r.accion.porque).toContain("rol");
  });
});

describe("el cierre del mes: el barrio sin coeficientes", () => {
  it("sin versión de coeficientes cerrada no se puede ni generar, y manda al padrón", () => {
    const r = estadoDelCierre({ ...MES, tieneCoeficientesVigentes: false });
    expect(r.situacion).toBe("preparando");
    expect(r.accion.destino).toBe("padron");
  });

  it("con borrador y sin coeficientes vigentes, es un bloqueo de la emisión", () => {
    const r = estadoDelCierre(conBorrador({ tieneCoeficientesVigentes: false }));
    expect(r.bloqueos.map((b) => b.clave)).toContain("coeficientes");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// ¿La cuota alcanza? — requisito C-10 del usuario (2026-08-04)
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("suficiencia de la cuota fija", () => {
  /** El barrio sembrado: 510 unidades, cuota de $382.000, $160,7 M de gasto del mes. */
  const BARRIO = { cuota: "382000.00", unidadesActivas: 510, gastoDevengado: "160720278.54" } as const;

  it("el total a devengar es cuota × unidades, y no depende de ningún supuesto", () => {
    const r = evaluarSuficienciaDeLaCuota({ ...BARRIO, moraEstimada: "0.20" });
    expect(r.totalADevengar).toBe("194820000.00");
  });

  it("**nunca** divide el gasto por las unidades: la cuota es entrada, no resultado", () => {
    // Dos barrios con el MISMO gasto y distinta cuota tienen que dar totales distintos. Si el total
    // saliera de repartir el gasto, serían iguales — que es exactamente el error que C-10 prohíbe.
    const barato = evaluarSuficienciaDeLaCuota({ ...BARRIO, cuota: "100000.00", moraEstimada: "0" });
    const caro = evaluarSuficienciaDeLaCuota({ ...BARRIO, cuota: "500000.00", moraEstimada: "0" });
    expect(barato.totalADevengar).toBe("51000000.00");
    expect(caro.totalADevengar).toBe("255000000.00");
    expect(barato.gastoDevengado).toBe(caro.gastoDevengado);
  });

  it("con mora cero, la recaudación esperada es el total a devengar", () => {
    const r = evaluarSuficienciaDeLaCuota({ ...BARRIO, moraEstimada: "0" });
    expect(r.recaudacionEsperada).toBe(r.totalADevengar);
    expect(r.resultado).toBe(r.resultadoSiTodosPagaran);
  });

  it("la mora se descuenta del total, en centavos exactos", () => {
    const r = evaluarSuficienciaDeLaCuota({ ...BARRIO, moraEstimada: "0.10" });
    // 194.820.000 − 10 % = 175.338.000, exacto.
    expect(r.recaudacionEsperada).toBe("175338000.00");
  });

  it("el caso que el usuario pidió: alcanzaría si todos pagaran, y con la mora real no alcanza", () => {
    // Es el "no seas mentiroso": sin mora el mes cierra en verde; con la mora que el barrio tiene de
    // verdad, no. Un veredicto binario escondería justamente esto.
    const sinMora = evaluarSuficienciaDeLaCuota({ ...BARRIO, moraEstimada: "0" });
    expect(sinMora.veredicto).toBe("cubre");

    const conMora = evaluarSuficienciaDeLaCuota({ ...BARRIO, moraEstimada: "0.25" });
    expect(conMora.veredicto).toBe("cubre_solo_si_todos_pagan");
    expect(aCentavos(conMora.resultado) < 0n).toBe(true);
    expect(aCentavos(conMora.resultadoSiTodosPagaran) > 0n).toBe(true);
  });

  it("cuando no alcanza ni en el mejor caso, lo dice sin vueltas", () => {
    const r = evaluarSuficienciaDeLaCuota({ ...BARRIO, cuota: "100000.00", moraEstimada: "0" });
    expect(r.veredicto).toBe("no_cubre");
  });

  it("la mora aplicada se devuelve, para que la pantalla pueda declararla", () => {
    expect(evaluarSuficienciaDeLaCuota({ ...BARRIO, moraEstimada: "0.18" }).moraAplicada).toBe("0.18");
  });

  it("rechaza una mora que no sea una fracción entre 0 y 1", () => {
    for (const mora of ["1.5", "-0.1", "20", "veinte por ciento", ""]) {
      expect(() => evaluarSuficienciaDeLaCuota({ ...BARRIO, moraEstimada: mora })).toThrow();
    }
    // Los extremos sí son válidos: 0 = todos pagan, 1 = no cobra nadie.
    expect(() => evaluarSuficienciaDeLaCuota({ ...BARRIO, moraEstimada: "0" })).not.toThrow();
    expect(() => evaluarSuficienciaDeLaCuota({ ...BARRIO, moraEstimada: "1" })).not.toThrow();
  });

  it("un barrio sin unidades activas devenga cero, no falla", () => {
    const r = evaluarSuficienciaDeLaCuota({ ...BARRIO, unidadesActivas: 0, moraEstimada: "0" });
    expect(r.totalADevengar).toBe("0.00");
    expect(r.veredicto).toBe("no_cubre");
  });

  it("la estimación trunca hacia abajo: ante la duda, se espera cobrar de menos", () => {
    // Una alerta optimista es peor que ninguna: si hay que equivocarse, que sea avisando de más.
    const r = evaluarSuficienciaDeLaCuota({
      cuota: "333.33",
      unidadesActivas: 3,
      gastoDevengado: "0.00",
      moraEstimada: "0.333333333",
    });
    expect(aCentavos(r.recaudacionEsperada) <= aCentavos(r.totalADevengar)).toBe(true);
  });
});
