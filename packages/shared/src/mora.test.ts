import { describe, expect, it } from "vitest";
import {
  amenazaEnLeyenda,
  celdaCsv,
  CRITERIO_POR_DEFECTO,
  criterioAdministracionSchema,
  criterioEfectivo,
  csvMora,
  derivarSchema,
  estadoPromesa,
  evaluarCriterio,
  LEYENDA_BASE,
  moraBarrioSchema,
  situacionMora,
  agregarEstudioSchema,
} from "./mora.ts";

const ADMIN = { meses: 3, montoMinimo: "300000.00", pedirIntimacion: true } as const;
const ID = "00000000-0000-4000-9000-000000000001";

describe("criterio efectivo", () => {
  it("sin nada cargado, el de por defecto", () => {
    expect(criterioEfectivo(null, null)).toEqual({ criterio: CRITERIO_POR_DEFECTO, origen: "por_defecto" });
  });

  it("el de la administración, si el barrio no tiene uno propio", () => {
    expect(criterioEfectivo(ADMIN, null)).toEqual({ criterio: ADMIN, origen: "administracion" });
    expect(criterioEfectivo(ADMIN, { meses: null, montoMinimo: null, pedirIntimacion: null })).toEqual({ criterio: ADMIN, origen: "administracion" });
  });

  it("el propio del barrio pisa meses y monto; «pedir intimación» se hereda por separado", () => {
    expect(criterioEfectivo(ADMIN, { meses: 2, montoMinimo: "500000.00", pedirIntimacion: null })).toEqual({
      criterio: { meses: 2, montoMinimo: "500000.00", pedirIntimacion: true },
      origen: "barrio",
    });
    expect(criterioEfectivo(ADMIN, { meses: null, montoMinimo: null, pedirIntimacion: false }).criterio.pedirIntimacion).toBe(false);
  });

  it("propuesta: MÁS de N meses y AL MENOS el monto mínimo (capital + interés)", () => {
    expect(evaluarCriterio({ meses: 3, deuda: "900000.00" }, ADMIN)).toEqual({ porMeses: false, porMonto: true, cumple: false });
    expect(evaluarCriterio({ meses: 4, deuda: "300000.00" }, ADMIN)).toEqual({ porMeses: true, porMonto: true, cumple: true });
    expect(evaluarCriterio({ meses: 4, deuda: "299999.99" }, ADMIN)).toEqual({ porMeses: true, porMonto: false, cumple: false });
  });
});

describe("situación en la lista", () => {
  const cumple = { porMeses: true, cumple: true };
  const debajo = { porMeses: true, cumple: false };
  const poco = { porMeses: false, cumple: false };
  it("derivada antes que todo; la promesa pendiente frena la propuesta; la vencida no", () => {
    expect(situacionMora({ derivada: true, promesa: "pendiente", criterio: cumple })).toBe("derivada");
    expect(situacionMora({ derivada: false, promesa: "pendiente", criterio: cumple })).toBe("promesa");
    expect(situacionMora({ derivada: false, promesa: "vencida", criterio: cumple })).toBe("para_derivar");
    expect(situacionMora({ derivada: false, promesa: null, criterio: debajo })).toBe("debajo_del_minimo");
    expect(situacionMora({ derivada: false, promesa: "cumplida", criterio: poco })).toBe("con_deuda");
  });
});

describe("estado de la promesa (la cuenta de Aclade)", () => {
  it("cumplida si lo pagado llega al monto, aun antes de la fecha", () => {
    expect(estadoPromesa({ monto: "1000.00", pagado: "1000.00", fecha: "2026-11-20" }, "2026-11-16")).toBe("cumplida");
    expect(estadoPromesa({ monto: "1000.00", pagado: "1200.00", fecha: "2026-11-10" }, "2026-11-16")).toBe("cumplida");
  });
  it("pendiente hasta la fecha prometida inclusive; vencida al día siguiente", () => {
    expect(estadoPromesa({ monto: "1000.00", pagado: "999.99", fecha: "2026-11-16" }, "2026-11-16")).toBe("pendiente");
    expect(estadoPromesa({ monto: "1000.00", pagado: "999.99", fecha: "2026-11-16" }, "2026-11-17")).toBe("vencida");
  });
});

describe("CSV de mora", () => {
  it("neutraliza lo que una planilla tomaría por fórmula (Aclade estudio-csv.ts:28-31)", () => {
    for (const peligrosa of ["=1+1", "+54 351", "-2", "@SUM(A1)", "−3", "  =HYPERLINK(\"x\")", "\tcosa", "\rcosa"]) {
      expect(celdaCsv(peligrosa).replace(/^"/, "").startsWith("'"), peligrosa).toBe(true);
    }
    expect(celdaCsv("Lucía Benítez")).toBe("Lucía Benítez");
    expect(celdaCsv('dice "hola"; chau')).toBe('"dice ""hola""; chau"');
  });

  it("«;», coma decimal sin miles, deuda = capital + interés, CRLF", () => {
    const csv = csvMora([
      {
        barrio: "Los Aromos",
        unidad: "Mza 3 · Lote 14",
        titular: "=cmd|' /C calc'!A0",
        meses: 5,
        capital: "1112400.00",
        interes: "96210.15",
        situacion: "Para derivar",
        estudio: null,
        ultimaGestion: "Llamada · 09/11",
      },
    ]);
    const [encabezado, fila, fin] = csv.split("\r\n");
    expect(encabezado).toBe("Barrio;Unidad;Titular;Meses;Capital;Interés a hoy;Deuda a hoy;Situación;Estudio;Última gestión");
    expect(fila).toBe("Los Aromos;Mza 3 · Lote 14;'=cmd|' /C calc'!A0;5;1112400,00;96210,15;1208610,15;Para derivar;;Llamada · 09/11");
    expect(fin).toBe("");
  });
});

describe("el aviso de la boleta no amenaza con medidas no decididas", () => {
  it("el texto base pasa", () => {
    expect(amenazaEnLeyenda(LEYENDA_BASE)).toBeNull();
  });
  it.each([
    ["Se procederá al EMBARGO de la unidad.", "embargo"],
    ["Podrá cortarse el servicio de agua.", "corte de servicios"],
    ["Se prohibirá el ingreso de visitas.", "prohibir el ingreso"],
    ["La unidad irá a remate.", "remate"],
    ["Se informará al Veraz.", "informe comercial"],
    ["Se iniciará la ejecución judicial.", "acción judicial"],
    ["Se pedirá la inhibición del titular.", "inhibición"],
    ["Se suspenderá la reserva del quincho.", "restringir el uso de lo común"],
    ["Figurará en la lista de morosos.", "difundir la deuda"],
  ])("«%s» → %s", (texto, medida) => {
    expect(amenazaEnLeyenda(texto)).toBe(medida);
    const r = criterioAdministracionSchema.safeParse({ administracionId: ID, meses: "3", montoMinimo: "300000.00", pedirIntimacion: "si", leyendaBoleta: texto });
    expect(r.success).toBe(false);
  });
});

describe("esquemas de las pantallas", () => {
  it("el criterio propio del barrio pide meses y monto; el heredado no", () => {
    const base = { barrioId: ID, pactoEjecutividad: "a_confirmar", aviso: "administracion", leyendaBoleta: "" } as const;
    expect(moraBarrioSchema.safeParse({ ...base, criterio: "administracion", meses: "", montoMinimo: "" }).success).toBe(true);
    expect(moraBarrioSchema.safeParse({ ...base, criterio: "propio", meses: "", montoMinimo: "" }).success).toBe(false);
    expect(moraBarrioSchema.parse({ ...base, criterio: "propio", meses: "3", montoMinimo: "500000.00" })).toMatchObject({ meses: 3, montoMinimo: "500000.00" });
  });

  it("derivar: al menos una unidad, ninguna repetida, y «Otro» con nota", () => {
    const u = { unidadFuncionalId: ID, barrioId: ID, estudioId: ID };
    expect(derivarSchema.safeParse({ unidades: [], motivo: "criterio_cumplido", nota: "" }).success).toBe(false);
    expect(derivarSchema.safeParse({ unidades: [u, u], motivo: "criterio_cumplido", nota: "" }).success).toBe(false);
    expect(derivarSchema.safeParse({ unidades: [u], motivo: "otro", nota: "" }).success).toBe(false);
    expect(derivarSchema.parse({ unidades: [u], motivo: "criterio_cumplido", nota: "  " }).nota).toBeNull();
  });

  it("el CUIT del estudio se valida con su verificador y se guarda sin guiones", () => {
    const base = { administracionId: ID, nombre: "Estudio", correoAvisos: "A@B.test", telefonoBoleta: "", preferenciaAviso: "cada_derivacion" } as const;
    expect(agregarEstudioSchema.parse({ ...base, cuit: "30-71000001-4" })).toMatchObject({ cuit: "30710000014", correoAvisos: "a@b.test", telefonoBoleta: null });
    expect(agregarEstudioSchema.safeParse({ ...base, cuit: "30-71000001-1" }).success).toBe(false);
  });
});
