import { describe, expect, it } from "vitest";
import { aCentavos, sumarMontos } from "./dinero.ts";
import { definirCuotaFijaSchema, esPorcentajeDeAjusteValido } from "./escrituras.ts";
import {
  ajustarCuota,
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
    // El verbo empieza con "Ir a" porque el botón navega: lleva a la pantalla de revisión, donde se
    // genera. Prometer "Generar el borrador" y navegar era el defecto que el usuario marcó. Lo que
    // sigue importando —y lo verifica la línea de abajo— es que **no** diga "emitir".
    expect(r.accion.verbo).toBe("Ir a generar el borrador");
    expect(r.accion.verbo).not.toContain("emitir");
  });

  it("con el borrador al día y sin nada pendiente, ofrece revisar y emitir", () => {
    const r = estadoDelCierre(conBorrador());
    expect(r.situacion).toBe("listoParaEmitir");
    expect(r.bloqueos).toEqual([]);
    expect(r.accion.verbo).toBe("Ir a revisar y emitir");
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
    expect(r.accion.verbo).toBe("Ir a regenerar el borrador");
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
    expect(r.accion.verbo).toBe("Ir a revisar las cifras");
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

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EL BARRIO DE VALOR FIJO AL QUE LE FALTA EL VALOR
 *
 * El destino `cuota` entró el 2026-08-04 con el alta de período con modelo elegible, y hasta hoy
 * ningún caso lo miraba: era un camino inalcanzable —nadie podía crear un período `fija` desde la
 * aplicación— y con el alta se volvió el camino normal del primer mes de un barrio que cobra un
 * valor fijo. Antes mandaba al **padrón**, que es el lugar equivocado: el padrón no tiene nada que
 * ver con cuánto se cobra.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
describe("el cierre del mes: valor fijo sin valor cargado", () => {
  const FIJA_SIN_VALOR: HechosDelCierre = {
    ...MES,
    modelo: "fija",
    cantidadGastos: 0,
    cuotaFijaVersionId: null,
  };

  it("manda al valor de la expensa, no al padrón", () => {
    const r = estadoDelCierre(FIJA_SIN_VALOR);
    expect(r.situacion).toBe("preparando");
    expect(r.accion.destino).toBe("cuota");
    // Y el motivo habla del valor, no del reparto: en este modelo lo ordinario no se prorratea.
    expect(r.accion.porque).toMatch(/valor/i);
    expect(r.accion.porque).not.toMatch(/prorrate|reparte/i);
  });

  it("los gastos NO son lo que falta: no manda ahí aunque el mes esté vacío", () => {
    expect(estadoDelCierre(FIJA_SIN_VALOR).accion.destino).not.toBe("gastos");
    expect(estadoDelCierre(FIJA_SIN_VALOR).frentes.gastos).toBe("sinNovedades");
  });

  it("faltando las DOS cosas, primero el padrón: sin unidades no hay a quién cobrarle", () => {
    const r = estadoDelCierre({ ...FIJA_SIN_VALOR, tieneCoeficientesVigentes: false });
    expect(r.accion.destino).toBe("padron");
    // Y el motivo no dice "define cómo se reparte", que en este modelo es falso.
    expect(r.accion.porque).toMatch(/qué unidades entran/i);
  });

  it("con el valor cargado ya se puede generar, aunque no haya un solo gasto", () => {
    const r = estadoDelCierre({ ...FIJA_SIN_VALOR, cuotaFijaVersionId: "v1" });
    expect(r.situacion).toBe("listoParaGenerar");
    expect(r.accion.destino).toBe("revision");
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

describe("ajustarCuota", () => {
  it("aplica el porcentaje sobre la cuota vigente y redondea al peso", () => {
    // El caso del piloto: una cuota de seis cifras con un aumento de un decimal.
    const r = ajustarCuota({ cuotaVigente: "372000.00", porcentaje: "3.2", redondeo: "peso" });
    expect(r.sinRedondear).toBe("383904.00");
    expect(r.nueva).toBe("383904.00");
    expect(r.diferencia).toBe("11904.00");
    expect(r.efectoDelRedondeo).toBe("0.00");
  });

  it("el redondeo cambia lo que se cobra, y lo dice", () => {
    const r = ajustarCuota({ cuotaVigente: "360500.00", porcentaje: "3.19", redondeo: "centena" });
    expect(r.sinRedondear).toBe("371999.95");
    expect(r.nueva).toBe("372000.00");
    // La cifra que hace visible el redondeo: cinco centavos por unidad, que en 510 unidades no es cero.
    expect(r.efectoDelRedondeo).toBe("0.05");
  });

  it("redondea a la mitad alejándose del cero, como una persona con calculadora", () => {
    expect(ajustarCuota({ cuotaVigente: "100.00", porcentaje: "0.5", redondeo: "peso" }).nueva).toBe("101.00");
    expect(ajustarCuota({ cuotaVigente: "1000.00", porcentaje: "0.005", redondeo: "centavo" }).nueva).toBe("1000.05");
  });

  it("una cuota puede bajar", () => {
    const r = ajustarCuota({ cuotaVigente: "372000.00", porcentaje: "-10", redondeo: "peso" });
    expect(r.nueva).toBe("334800.00");
    expect(r.diferencia).toBe("-37200.00");
  });

  it("el 0 % no mueve la cuota", () => {
    const r = ajustarCuota({ cuotaVigente: "382000.55", porcentaje: "0", redondeo: "centavo" });
    expect(r.nueva).toBe("382000.55");
    expect(r.diferencia).toBe("0.00");
  });

  it("no pierde precisión en centavos donde el punto flotante la perdería", () => {
    // 0.1 + 0.2 en punto flotante no da 0.3; acá la cuenta es entera y cierra exacta.
    const r = ajustarCuota({ cuotaVigente: "0.10", porcentaje: "200", redondeo: "centavo" });
    expect(r.nueva).toBe("0.30");
  });

  it("rechaza un porcentaje que no es un número", () => {
    expect(() => ajustarCuota({ cuotaVigente: "100.00", porcentaje: "3,2", redondeo: "peso" })).toThrow();
    expect(() => ajustarCuota({ cuotaVigente: "100.00", porcentaje: "", redondeo: "peso" })).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Ataque adversarial a la pantalla de cuota fija (tester, 2026-08-04)
//
// **Dónde vive cada candado**, porque es lo que estos tests fijan y es lo que se rompe al refactorizar:
//
// - El **rango** del porcentaje (techo 1000 %, piso −100 %) → `porcentajeDeAjusteSchema`, en el borde.
//   `ajustarCuota` es aritmética pura y **no** valida rango: a `-200` le devuelve un negativo.
// - La **cuota en cero** → `definirCuotaFija` (`packages/data/src/servicios/cuota-fija.ts`), que
//   rechaza con `cuota_en_cero` y se reintenta con `confirmarCuotaEnCero`. Mira el importe **final**
//   de cada unidad, que es la única forma de atrapar las tres puertas: el −100 %, el redondeo que
//   redondea a cero y el importe cargado en 0,00.
// - Los casos que quedan marcados **BUG** fallan a propósito: son agujeros abiertos al 2026-08-04.
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Lo mínimo que un ajuste puede valer: nadie factura en negativo. */
const noNegativo = (m: string) => aCentavos(m) >= 0n;

describe("ajustarCuota — límites que mueven plata", () => {
  it("el redondeo al mil lleva a cero una cuota chica, y el freno está aguas arriba", () => {
    // Un consorcio urbano con expensa de $400 (un PH de 4 unidades sin personal) elige «Al mil»
    // porque suena a prolijo: 412,80 al mil da 0,00. **Es la aritmética correcta**, y la base lo
    // aceptaría —`cuota_fija_importe_chk` solo exige `importe >= 0`—, así que el dominio no puede
    // ser el que frene. Lo frena `definirCuotaFija` con `cuota_en_cero`, que mira el importe final.
    const r = ajustarCuota({ cuotaVigente: "400.00", porcentaje: "3.2", redondeo: "mil" });
    expect(r.sinRedondear).toBe("412.80");
    expect(r.nueva).toBe("0.00");
    // El efecto del redondeo lo dice con todas las letras: se comió el aumento y la cuota entera.
    expect(r.efectoDelRedondeo).toBe("-412.80");
  });

  it("la misma puerta sin porcentaje de por medio: 0 % a la centena sobre $49 da cero", () => {
    // Importa que sea 0 %: el cero no siempre viene de una baja. Un test que solo cubriera el
    // −100 % dejaría pasar este, y `cuota_en_cero` lo atrapa porque mira el resultado, no la causa.
    expect(ajustarCuota({ cuotaVigente: "49.00", porcentaje: "0", redondeo: "centena" }).nueva).toBe("0.00");
  });

  it("el otro lado del redondeo NO tiene puerta: 0 % al mil DUPLICA una cuota de $500", () => {
    // `cuota_en_cero` cubre el redondeo que se come la cuota. El redondeo que la **duplica** no
    // tiene ninguna: 500,00 al mil da 1.000,00 con un ajuste del 0 %, y en 510 unidades eso es
    // +$255.000 por mes que nadie decidió. La previa lo muestra, pero mostrar no es confirmar y el
    // resto del módulo ya estableció que un número multiplicado por todo el barrio pide puerta.
    const r = ajustarCuota({ cuotaVigente: "500.00", porcentaje: "0", redondeo: "mil" });
    expect(r.nueva).toBe("1000.00");
    expect(r.efectoDelRedondeo).toBe("500.00");
  });

  it("el piso de −100 % también vive en el dominio: por debajo, lanza", () => {
    // El esquema frena el borde de la pantalla; esta función es «la única aritmética del ajuste» y
    // el día que la llame una importación masiva o un job, ese borde no está en el camino. Sin este
    // piso devolvía -191.000,00 por unidad — el número que la pantalla llegó a mostrar bajo el
    // rótulo «Cuota nueva».
    for (const porcentaje of ["-150", "-1000", "-100.0001"]) {
      expect(() => ajustarCuota({ cuotaVigente: "382000.00", porcentaje, redondeo: "peso" })).toThrow(
        /una baja no puede pasar del 100 %/,
      );
    }
    // El borde exacto NO lanza: −100 % es una cuota suspendida, no un sinsentido.
    expect(noNegativo(ajustarCuota({ cuotaVigente: "382000.00", porcentaje: "-100", redondeo: "peso" }).nueva))
      .toBe(true);
  });

  it("ningún ajuste que la función acepte puede terminar en negativo", () => {
    // La propiedad que el piso tiene que garantizar, barrida sobre los dos extremos y los redondeos.
    for (const porcentaje of ["-100", "-99.9999", "-50", "0", "1000"]) {
      for (const redondeo of ["centavo", "peso", "centena", "mil"] as const) {
        for (const cuota of ["0.00", "0.01", "49.00", "500.00", "382000.55"]) {
          const r = ajustarCuota({ cuotaVigente: cuota, porcentaje, redondeo });
          expect([cuota, porcentaje, redondeo, noNegativo(r.nueva)]).toEqual([cuota, porcentaje, redondeo, true]);
        }
      }
    }
  });

  it("-100 % deja la cuota exactamente en cero, sin arrastre de centavos", () => {
    const r = ajustarCuota({ cuotaVigente: "382000.55", porcentaje: "-100", redondeo: "centavo" });
    expect(r.nueva).toBe("0.00");
    expect(r.diferencia).toBe("-382000.55");
  });

  it("una cuota de 0,00 se queda en cero cualquiera sea el porcentaje", () => {
    // Correcto aritméticamente. Se pinea porque es el estado al que llegan los dos bugs de arriba:
    // una vez en cero, ningún aumento porcentual saca al barrio de ahí. La única salida es cargar
    // un importe, y nada en la pantalla lo dice.
    expect(ajustarCuota({ cuotaVigente: "0.00", porcentaje: "9999", redondeo: "centavo" }).nueva).toBe("0.00");
    expect(ajustarCuota({ cuotaVigente: "0.00", porcentaje: "1000", redondeo: "mil" }).nueva).toBe("0.00");
  });

  it("los centavos raros no se pierden: 0,01 + 50 % es 0,02 al centavo y 0,00 al peso", () => {
    expect(ajustarCuota({ cuotaVigente: "0.01", porcentaje: "50", redondeo: "centavo" }).nueva).toBe("0.02");
    // Al peso el mismo ajuste da cero. Es coherente con el redondeo elegido, y es otra puerta al
    // mismo estado: cuota cero sin que nadie lo haya decidido.
    expect(ajustarCuota({ cuotaVigente: "0.01", porcentaje: "50", redondeo: "peso" }).nueva).toBe("0.00");
  });

  it("trunca el porcentaje más allá de 9 decimales en vez de redondearlo", () => {
    // `ajustarCuota` acepta cualquier cantidad de decimales (su regex es `\d+(\.\d+)?`), pero
    // `coeficienteAEntero` corta en 9. Con 4 decimales —lo único que el esquema deja entrar— no
    // hay diferencia; se pinea para que un cambio de escala no pase inadvertido.
    const r = ajustarCuota({ cuotaVigente: "100.00", porcentaje: "3.20000000005", redondeo: "centavo" });
    expect(r.nueva).toBe("103.20");
    expect(ajustarCuota({ cuotaVigente: "372000.00", porcentaje: "0.00000000001", redondeo: "centavo" }).nueva)
      .toBe("372000.00");
  });

  it("un porcentaje enorme no desborda: sigue siendo aritmética entera", () => {
    // 1.000.000 % sobre la cuota del piloto. El resultado entra en `numeric(14,2)`, así que la base
    // no protege de nada acá: el único freno es el tope de 1000 del esquema.
    const r = ajustarCuota({ cuotaVigente: "372000.00", porcentaje: "1000000", redondeo: "peso" });
    expect(r.nueva).toBe("3720372000.00");
  });

  it("el resultado siempre cierra consigo mismo, incluso en los casos hostiles", () => {
    // Invariante que tiene que valer siempre: nueva = sinRedondear + efectoDelRedondeo, y
    // diferencia = nueva - anterior. Si alguna vez no cierra, la pantalla explica mal un número.
    const casos = [
      ["400.00", "3.2", "mil"],
      ["382000.00", "-100", "peso"],
      ["0.01", "50", "peso"],
      ["382000.00", "1000", "centena"],
      ["0.00", "3.2", "centavo"],
    ] as const;
    for (const [cuota, porcentaje, redondeo] of casos) {
      const r = ajustarCuota({ cuotaVigente: cuota, porcentaje, redondeo });
      expect(sumarMontos(r.sinRedondear, r.efectoDelRedondeo)).toBe(r.nueva);
      expect(sumarMontos(r.anterior, r.diferencia)).toBe(r.nueva);
    }
  });
});

describe("definirCuotaFijaSchema — lo que entra por el borde", () => {
  const BASE = {
    barrioId: "3f1e5b6a-0000-4000-8000-000000000001",
    rigeDesde: "2026-09",
    descripcion: "Acta de directorio 112",
  };

  it("un FormData realista (con claves de más) parsea y descarta lo que sobra", () => {
    // El formulario manda además `_forma` (los radios, que no llevan `value` y viajan como "on").
    // La `intersection` de un objeto con un `discriminatedUnion` los descarta, que es lo esperado.
    const r = definirCuotaFijaSchema.safeParse({
      ...BASE,
      forma: "porcentaje",
      porcentaje: "3.2",
      redondeo: "peso",
      _forma: "on",
      $ACTION_ID_abc: "x",
    });
    expect(r.success).toBe(true);
    expect(r.success && Object.keys(r.data).sort()).toEqual(
      ["barrioId", "descripcion", "forma", "porcentaje", "redondeo", "rigeDesde"].sort(),
    );
  });

  it("forma=porcentaje descarta un importe colado, y forma=importe descarta porcentaje y redondeo", () => {
    // Nada se cuela por el cruce de las dos formas: la unión discriminada gana.
    const a = definirCuotaFijaSchema.safeParse({
      ...BASE,
      forma: "porcentaje",
      porcentaje: "3.2",
      redondeo: "peso",
      importe: "999999.00",
    });
    expect(a.success && "importe" in a.data).toBe(false);

    const b = definirCuotaFijaSchema.safeParse({
      ...BASE,
      forma: "importe",
      importe: "1000.00",
      porcentaje: "3.2",
      redondeo: "mil",
    });
    expect(b.success && ("porcentaje" in b.data || "redondeo" in b.data)).toBe(false);
  });

  it("el rango se valida acá: piso de −100 % y techo de 1000 %, en los dos bordes exactos", () => {
    // Regresión del agujero encontrado el 2026-08-04: `-200` producía `-384000.00`, la pantalla lo
    // mostraba bajo el rótulo «Cuota nueva» y recién lo frenaba `cuota_fija_importe_chk` con el
    // mensaje genérico de un constraint. Ahora rebota acá, con un texto que dice qué pasa.
    const parse = (porcentaje: string) =>
      definirCuotaFijaSchema.safeParse({ ...BASE, forma: "porcentaje", porcentaje, redondeo: "peso" }).success;

    for (const fuera of ["-150", "-1000", "-100.0001", "1000.0001", "9999"]) {
      expect([fuera, parse(fuera)]).toEqual([fuera, false]);
    }
    // Los extremos inclusive, y sus formas escritas distinto: la comparación es en `bigint` sobre la
    // escala de 4 decimales, así que "-100" y "-100.0000" tienen que decidirse igual. -100 % entra
    // porque la cuota queda en cero, que es un valor decidido y no un sinsentido — y ahí se lo lleva
    // la puerta de `cuota_en_cero`, no el rango.
    for (const dentro of ["-100", "-100.0000", "-99.9999", "0", "1000", "1000.0000", "999.9999"]) {
      expect([dentro, parse(dentro)]).toEqual([dentro, true]);
    }
  });

  it("confirmarCuotaEnCero no existe en el primer intento y viaja en el reintento", () => {
    // El campo es opcional a propósito: en el primer envío nadie preguntó nada todavía. Si fuera
    // requerido, el reintento sería la única forma de guardar y la puerta dejaría de ser una puerta.
    const primero = definirCuotaFijaSchema.safeParse({ ...BASE, forma: "importe", importe: "0.00" });
    expect(primero.success && "confirmarCuotaEnCero" in primero.data).toBe(false);

    const reintento = definirCuotaFijaSchema.safeParse({
      ...BASE,
      forma: "importe",
      importe: "0.00",
      confirmarCuotaEnCero: "1",
    });
    expect(reintento.success && reintento.data.confirmarCuotaEnCero).toBe(true);
  });

  it("un porcentaje vacío da un solo mensaje, y no uno sobre un número que no se escribió", () => {
    // El campo es `requerido` en la pantalla, pero si llega vacío (autocompletado, JS apagado, un
    // reintento) el validador corre igual sobre "". La versión con dos `.refine` encadenados
    // contestaba «revisá el número, parece un cero de más» a un campo en blanco; con un solo
    // predicado sale un mensaje solo. Se pinea el conteo, no el texto: el texto se interpola desde
    // `PORCENTAJE_MINIMO`/`PORCENTAJE_MAXIMO` y cambiarlo no debe romper este test.
    const r = definirCuotaFijaSchema.safeParse({ ...BASE, forma: "porcentaje", porcentaje: "", redondeo: "peso" });
    expect(r.success).toBe(false);
    const mensajes = r.success === false ? r.error.issues.map((i) => i.message) : [];
    expect(mensajes).toHaveLength(1);
    expect(mensajes[0]).not.toMatch(/cero de más/);
  });

  it("un porcentaje no numérico se rechaza, no explota", () => {
    // Regresión de un bug que vivió unos minutos y era el peor de todos: la primera versión del piso
    // de −100 % comparaba con `BigInt(ent)` **sin validar antes la forma**, y los `.refine` de una
    // cadena de string en zod v3 corren aunque el `.regex()` previo ya haya fallado. Con "3,2" el
    // `BigInt` tiraba `SyntaxError: Cannot convert 3,2 to a BigInt`; `safeParse` no atrapa una
    // excepción del validador, así que salía por arriba de `definirCuotaFijaAction` y el usuario
    // veía el error genérico de la Server Action.
    //
    // Y la entrada que lo disparaba es la más probable de todas: la coma decimal argentina.
    for (const porcentaje of ["3,2", "3.2.5", "1e3", "abc", "-", "+3", "٣.٢"]) {
      let r: ReturnType<typeof definirCuotaFijaSchema.safeParse> | "TIRÓ";
      try {
        r = definirCuotaFijaSchema.safeParse({ ...BASE, forma: "porcentaje", porcentaje, redondeo: "peso" });
      } catch {
        r = "TIRÓ";
      }
      expect([porcentaje, r === "TIRÓ" ? "TIRÓ" : r.success]).toEqual([porcentaje, false]);
    }
  });

  it("un importe de 0,00 pasa el esquema: «positivo» es en realidad «no negativo»", () => {
    // Y está bien que pase: un barrio puede suspender la cuota un mes. Es la tercera puerta a la
    // cuota cero —junto al −100 % y al redondeo— y las tres desembocan en `cuota_en_cero`, que es
    // exactamente el motivo por el que esa puerta mira el importe final y no la forma de carga.
    expect(definirCuotaFijaSchema.safeParse({ ...BASE, forma: "importe", importe: "0.00" }).success).toBe(true);
  });
});

describe("paridad entre la vista previa y el servidor", () => {
  /**
   * **Por qué este bloque existe.** `VistaPrevia`
   * (`apps/web/src/app/(admin)/[barrio]/liquidacion/cuota/formulario.tsx`) decide si muestra una
   * cifra, y su comentario promete: «lo que no pasaría el borde tampoco se previsualiza». La primera
   * versión copiaba **solo la regex** del esquema, así que con `9999` la pantalla afirmaba «el barrio
   * pasa a facturar 19.674.871.800,00 por mes» y el servidor lo rechazaba al confirmar; con `-150`
   * mostraba una «Cuota nueva» de -191.000,00. Ahora las dos puntas llaman a
   * `esPorcentajeDeAjusteValido`, y esto lo verifica: la pantalla no puede volver a tener su propia
   * copia de la regla sin que este test se ponga rojo.
   */
  const elServidorLoAcepta = (porcentaje: string) =>
    definirCuotaFijaSchema.safeParse({
      barrioId: "3f1e5b6a-0000-4000-8000-000000000001",
      rigeDesde: "2026-09",
      descripcion: null,
      forma: "porcentaje",
      porcentaje,
      redondeo: "peso",
    }).success;

  it("el predicado de la previa decide exactamente igual que el esquema", () => {
    const entradas = [
      // Los que rompían la paridad cuando la previa tenía su propia regex.
      "9999", "1001", "1000.9999", "-150", "-9999", "-100.0001",
      // Bordes exactos, por los dos lados.
      "1000", "1000.0000", "999.9999", "-100", "-100.0000", "-99.9999", "0", "-0", "0.0001",
      // Formas escritas distinto que tienen que decidirse igual.
      " 3.2 ", "0003.2", "3.2",
      // Basura: la previa se calla y el borde rechaza, ninguna de las dos explota.
      "3,2", "abc", "", "-", "1e3", "3.2.5", "12345", "1.23456",
    ];
    for (const porcentaje of entradas) {
      expect([porcentaje, esPorcentajeDeAjusteValido(porcentaje)]).toEqual([
        porcentaje,
        elServidorLoAcepta(porcentaje),
      ]);
    }
  });

  it("la coma decimal se rechaza en las dos puntas — el campo la traduce ANTES de llegar acá", () => {
    /*
     * La regla —solo punto, para que "3,2" y "3.2" no convivan en la base como textos distintos— la
     * aplican igual las dos puntas. Lo que hacía falta era la **traducción**, y estaba faltando: un
     * teclado es-AR con `inputMode="decimal"` ofrece coma, así que el camino por omisión en el
     * celular escribía "3,2", la previa desaparecía sin decir por qué y el error llegaba recién al
     * confirmar. Ahora `CampoTexto` con `modoDeTeclado="decimal"` traduce la coma mientras se
     * escribe, igual que `CampoMonto`. Este test fija el contrato del borde: acá abajo la coma no
     * llega nunca, y si llegara se rechaza sin explotar.
     */
    expect(esPorcentajeDeAjusteValido("3,2")).toBe(false);
    expect(elServidorLoAcepta("3,2")).toBe(false);
    expect(elServidorLoAcepta("3.2")).toBe(true);
  });
});
