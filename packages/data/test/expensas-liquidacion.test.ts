/**
 * La liquidación mensual de punta a punta contra Postgres real: cargar gastos, prorratear, emitir.
 *
 * Lo que se prueba acá es lo que la BASE impide, más el servicio completo:
 * extraordinaria sin acta, período emitido inmutable, emisión descuadrada, mora sin tasa cargada.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import {
  borrarArbol,
  crearArbol,
  crearBarrio,
  crearCoeficientes,
  crearUnidades,
  dbDe,
  poolAdmin,
  poolApp,
  type Arbol,
} from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let unidades: string[];
let barrioId: string;
let conceptoOrdinario: string;
let conceptoExtraordinario: string;
let conceptoFondo: string;
let actaId: string;

/** Crea un período nuevo en borrador y devuelve su id. */
async function crearPeriodo(periodo: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into periodo_expensa (barrio_id, periodo, primer_vencimiento)
     values ($1, $2, current_date + 10) returning id`,
    [barrioId, periodo],
  );
  const fila = rows[0];
  if (!fila) throw new Error("no se pudo crear el período");
  return fila.id;
}

async function cargarGasto(periodoId: string, conceptoId: string, monto: string, acta?: string): Promise<void> {
  await admin.query(
    `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto, acta_documento_id)
     values ($1,$2,$3,$4,$5,$6)`,
    [barrioId, periodoId, conceptoId, `Gasto de ${monto}`, monto, acta ?? null],
  );
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  barrioId = arbol.barrioA1.id;
  await crearBarrio(admin, barrioId);
  unidades = await crearUnidades(admin, barrioId, 8);
  const version = await crearCoeficientes(admin, barrioId, unidades);
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [version]);

  const crearConcepto = async (nombre: string, tipo: string, fondo = false) => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into concepto (barrio_id, nombre, tipo, es_fondo_reserva) values ($1,$2,$3,$4) returning id`,
      [barrioId, nombre, tipo, fondo],
    );
    return rows[0]?.id as string;
  };
  conceptoOrdinario = await crearConcepto("Seguridad", "ordinaria");
  conceptoExtraordinario = await crearConcepto("Portón de acceso", "extraordinaria");
  conceptoFondo = await crearConcepto("Fondo de reserva", "ordinaria", true);

  const { rows } = await admin.query<{ id: string }>(
    `insert into documento_barrio (barrio_id, tipo, titulo) values ($1,'acta_asamblea','Acta 12/07 (test)') returning id`,
    [barrioId],
  );
  actaId = rows[0]?.id as string;
});

afterAll(async () => {
  // Un período emitido es inmutable a propósito, así que la limpieza de los tests entra por la
  // puerta de mantenimiento: `session_replication_role = replica` desactiva triggers (solo puede el
  // superusuario, y solo se usa acá).
  await admin.query("set session_replication_role = replica");
  for (const tabla of [
    "item_liquidacion", "liquidacion", "gasto_periodo", "periodo_expensa", "concepto", "tasa_mora",
    "cuota_fija", "cuota_fija_version",
    "coeficiente", "coeficiente_version", "unidad_obligado", "unidad_contacto", "obligado",
    "unidad_funcional", "mandato_administracion", "barrio_atributo_vigencia", "documento_barrio", "barrio",
  ]) {
    await admin.query(`delete from ${tabla} where barrio_id = $1`, [barrioId]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

beforeEach(async () => {
  await admin.query("delete from tasa_mora where barrio_id = $1", [barrioId]);
});

describe("carga de gastos", () => {
  it("una EXTRAORDINARIA sin acta se carga igual, pero queda marcada", async () => {
    // Pasa en la operatoria real (se rompe una bomba y no se espera a la asamblea): el sistema no
    // lo impide. La falta de respaldo pesa después, al reclamar la deuda, no al cargar el gasto.
    const periodoId = await crearPeriodo("2026-01");
    await cargarGasto(periodoId, conceptoExtraordinario, "100000.00");
    await cargarGasto(periodoId, conceptoExtraordinario, "200000.00", actaId);

    const { rows } = await admin.query<{ monto: string; sin_respaldo: boolean }>(
      "select monto::text, sin_respaldo_asamblea as sin_respaldo from gasto_periodo where periodo_id = $1 order by monto",
      [periodoId],
    );
    expect(rows[0]).toMatchObject({ monto: "100000.00", sin_respaldo: true });
    expect(rows[1]).toMatchObject({ monto: "200000.00", sin_respaldo: false });

    // El resumen de la liquidación lo informa, para que la UI pueda avisar.
    const resumen = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      generarLiquidaciones(tx, { periodoId }),
    );
    expect(resumen.extraordinariasSinRespaldo).toBe(1);

    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });

  it("la marca la pone la base: no depende de que la app la mande bien", async () => {
    const periodoId = await crearPeriodo("2027-02");
    await admin.query(
      `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto, sin_respaldo_asamblea)
       values ($1,$2,$3,'Intento de mentirle a la base','1000.00', false)`,
      [barrioId, periodoId, conceptoExtraordinario],
    );
    const { rows } = await admin.query<{ sin_respaldo: boolean }>(
      "select sin_respaldo_asamblea as sin_respaldo from gasto_periodo where periodo_id = $1",
      [periodoId],
    );
    expect(rows[0]?.sin_respaldo).toBe(true);
    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });

  it("un gasto negativo se rechaza", async () => {
    const periodoId = await crearPeriodo("2026-02");
    await expect(cargarGasto(periodoId, conceptoOrdinario, "-5000.00")).rejects.toThrow(/gasto_monto_chk/i);
    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });

  it("no hay dos períodos con el mismo mes en un barrio", async () => {
    const periodoId = await crearPeriodo("2026-03");
    await expect(crearPeriodo("2026-03")).rejects.toThrow(/uq_periodo_barrio|duplicate key/i);
    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });
});

describe("liquidación de punta a punta", () => {
  it("reparte los gastos y la suma cierra exacta con el total del período", async () => {
    const periodoId = await crearPeriodo("2026-04");
    await cargarGasto(periodoId, conceptoOrdinario, "4500000.00");
    await cargarGasto(periodoId, conceptoOrdinario, "1234567.89");
    await cargarGasto(periodoId, conceptoExtraordinario, "980000.00", actaId);
    await cargarGasto(periodoId, conceptoFondo, "500000.00");

    const resumen = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      generarLiquidaciones(tx, { periodoId }),
    );

    expect(resumen.unidadesLiquidadas).toBe(unidades.length);
    expect(resumen.totalRepartido).toBe(resumen.totalGastos);
    expect(resumen.totalGastos).toBe("7214567.89");

    const { rows } = await admin.query<{ suma_items: string; suma_totales: string; fondo: string }>(
      `select (select sum(i.monto) from item_liquidacion i join liquidacion l on l.id = i.liquidacion_id where l.periodo_id = $1)::text as suma_items,
              (select sum(total) from liquidacion where periodo_id = $1)::text as suma_totales,
              (select sum(subtotal_fondo_reserva) from liquidacion where periodo_id = $1)::text as fondo`,
      [periodoId],
    );
    expect(rows[0]?.suma_items).toBe("7214567.89");
    expect(rows[0]?.suma_totales).toBe("7214567.89"); // sin saldo anterior ni mora
    expect(rows[0]?.fondo).toBe("500000.00"); // el fondo de reserva va separado

    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });

  it("cada línea guarda de qué gasto sale y con qué coeficiente (dinero trazable)", async () => {
    const periodoId = await crearPeriodo("2026-05");
    await cargarGasto(periodoId, conceptoOrdinario, "1000000.00");
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    const { rows } = await admin.query<{ base_monto: string; coeficiente_aplicado: string; monto: string }>(
      `select i.base_monto::text, i.coeficiente_aplicado::text, i.monto::text
         from item_liquidacion i join liquidacion l on l.id = i.liquidacion_id
        where l.periodo_id = $1 limit 1`,
      [periodoId],
    );
    expect(rows[0]?.base_monto).toBe("1000000.00");
    expect(Number(rows[0]?.coeficiente_aplicado)).toBeGreaterThan(0);
    expect(Number(rows[0]?.monto)).toBeGreaterThan(0);

    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });

  it("regenerar la liquidación de un borrador no duplica nada", async () => {
    const periodoId = await crearPeriodo("2026-06");
    await cargarGasto(periodoId, conceptoOrdinario, "300000.00");
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from liquidacion where periodo_id = $1",
      [periodoId],
    );
    expect(rows[0]?.n).toBe(String(unidades.length));
    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });
});

describe("mora", () => {
  it("sin tasa cargada, la liquidación sale marcada como 'mora pendiente de definición'", async () => {
    const periodoId = await crearPeriodo("2026-07");
    await cargarGasto(periodoId, conceptoOrdinario, "800000.00");

    const saldos = new Map(unidades.map((u) => [u, "50000.00"]));
    const resumen = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      generarLiquidaciones(tx, {
        periodoId,
        saldosAnteriores: saldos,
        diasDeAtraso: 30,
        fechaCorteMora: "2026-07-31",
      }),
    );
    expect(resumen.conMoraPendiente).toBe(unidades.length);

    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from liquidacion where periodo_id = $1 and mora_pendiente_definicion and interes_mora is null",
      [periodoId],
    );
    expect(rows[0]?.n).toBe(String(unidades.length));
    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });

  it("con tasa cargada, cobra el interés y lo suma al total", async () => {
    await admin.query(
      `insert into tasa_mora (barrio_id, tasa_mensual, vigente_desde) values ($1, 0.030000, current_date - 30)`,
      [barrioId],
    );
    const periodoId = await crearPeriodo("2026-08");
    await cargarGasto(periodoId, conceptoOrdinario, "800000.00");

    const saldos = new Map(unidades.map((u) => [u, "50000.00"]));
    const resumen = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      generarLiquidaciones(tx, {
        periodoId,
        saldosAnteriores: saldos,
        diasDeAtraso: 30,
        fechaCorteMora: "2026-07-31",
      }),
    );
    expect(resumen.conMoraPendiente).toBe(0);

    const { rows } = await admin.query<{ interes: string; total: string; saldo: string; base: string }>(
      `select interes_mora::text as interes, total::text, saldo_anterior::text as saldo,
              (subtotal_ordinarias + subtotal_extraordinarias + subtotal_fondo_reserva)::text as base
         from liquidacion where periodo_id = $1 limit 1`,
      [periodoId],
    );
    // 3% mensual sobre 50.000 durante 30 días = 1.500.
    expect(rows[0]?.interes).toBe("1500.00");
    expect(Number(rows[0]?.total)).toBeCloseTo(
      Number(rows[0]?.base) + Number(rows[0]?.saldo) + Number(rows[0]?.interes),
      2,
    );
    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });
});

describe("emisión del período", () => {
  it("emite cuando cuadra, y después NO se puede editar nada", async () => {
    const periodoId = await crearPeriodo("2026-09");
    await cargarGasto(periodoId, conceptoOrdinario, "1000000.00");
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      emitirPeriodo(tx, periodoId, arbol.usuarios.adminBarrioA1),
    );

    const { rows } = await admin.query<{ estado: string; emitida_at: string | null; total_gastos: string }>(
      "select estado, emitida_at, total_gastos::text from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(rows[0]?.estado).toBe("emitida");
    expect(rows[0]?.emitida_at).not.toBeNull();
    expect(rows[0]?.total_gastos).toBe("1000000.00");

    await expect(cargarGasto(periodoId, conceptoOrdinario, "1.00")).rejects.toThrow(/ya está emitida/i);
    await expect(
      admin.query("update liquidacion set total = 0 where periodo_id = $1", [periodoId]),
    ).rejects.toThrow(/ya está emitida/i);
    await expect(
      admin.query("update periodo_expensa set estado = 'borrador' where id = $1", [periodoId]),
    ).rejects.toThrow(/transición de estado inválida/i);

    // Distribuir sí es el paso siguiente válido.
    await admin.query("update periodo_expensa set estado = 'distribuida' where id = $1", [periodoId]);
    const { rows: d } = await admin.query<{ estado: string; distribuida_at: string | null }>(
      "select estado, distribuida_at from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(d[0]?.estado).toBe("distribuida");
    expect(d[0]?.distribuida_at).not.toBeNull();
  });

  it("NO emite un período descuadrado", async () => {
    const periodoId = await crearPeriodo("2026-10");
    await cargarGasto(periodoId, conceptoOrdinario, "1000000.00");
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    // Se agrega un gasto DESPUÉS de liquidar: lo repartido ya no coincide con el gasto del período.
    await cargarGasto(periodoId, conceptoOrdinario, "77000.00");

    await expect(
      admin.query("update periodo_expensa set estado = 'emitida' where id = $1", [periodoId]),
    ).rejects.toThrow(/no cuadra/i);
    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });

  it("NO emite si falta liquidar alguna unidad activa", async () => {
    const periodoId = await crearPeriodo("2026-11");
    await cargarGasto(periodoId, conceptoOrdinario, "500000.00");
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await admin.query(
      "delete from liquidacion where id = (select id from liquidacion where periodo_id = $1 limit 1)",
      [periodoId],
    );

    await expect(
      admin.query("update periodo_expensa set estado = 'emitida' where id = $1", [periodoId]),
    ).rejects.toThrow(/faltan liquidaciones/i);
    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });
});

describe("aislamiento", () => {
  it("un administrador ajeno no ve ni un período ni una liquidación", async () => {
    const periodoId = await crearPeriodo("2026-12");
    await cargarGasto(periodoId, conceptoOrdinario, "10000.00");
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    const cuenta = await conUsuario(db, arbol.usuarios.adminEstudioB, async (tx) => {
      const res = await tx.execute<{ p: string; l: string }>(sql`
        select (select count(*) from periodo_expensa)::text as p, (select count(*) from liquidacion)::text as l
      `);
      return res.rows[0];
    });
    expect(cuenta).toEqual({ p: "0", l: "0" });

    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });

  it("un propietario ve su liquidación pero no puede tocarla", async () => {
    const periodoId = await crearPeriodo("2027-01");
    await cargarGasto(periodoId, conceptoOrdinario, "10000.00");
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    const visibles = await conUsuario(db, arbol.usuarios.propietarioA1, async (tx) => {
      const res = await tx.execute<{ n: string }>(
        sql`select count(*)::text as n from liquidacion where periodo_id = ${periodoId}`,
      );
      return res.rows[0]?.n;
    });
    expect(visibles).toBe(String(unidades.length));

    // La RLS no "explota" en un UPDATE: filtra las filas, así que la operación afecta CERO filas.
    const afectadas = await conUsuario(db, arbol.usuarios.propietarioA1, async (tx) => {
      const res = await tx.execute(sql`update liquidacion set total = 0 where periodo_id = ${periodoId}`);
      return res.rowCount;
    });
    expect(afectadas).toBe(0);

    const { rows: intactas } = await admin.query<{ n: string }>(
      "select count(*)::text as n from liquidacion where periodo_id = $1 and total = 0",
      [periodoId],
    );
    expect(intactas[0]?.n).toBe("0");

    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });
});


describe("modelo de expensa FIJA (cuota mensual del directorio)", () => {
  /** Crea una versión de cuota fija con el mismo importe para todas las unidades. */
  async function crearCuotaFija(importe: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into cuota_fija_version (barrio_id, descripcion, vigente_desde)
       values ($1,'Cuota aprobada por el directorio', current_date) returning id`,
      [barrioId],
    );
    const versionId = rows[0]?.id as string;
    for (const unidad of unidades) {
      await admin.query(
        `insert into cuota_fija (barrio_id, version_id, unidad_funcional_id, importe) values ($1,$2,$3,$4)`,
        [barrioId, versionId, unidad, importe],
      );
    }
    return versionId;
  }

  it("cada unidad paga la cuota, no el gasto del mes", async () => {
    await crearCuotaFija("150000.00");
    const periodoId = await crearPeriodo("2027-03");
    await admin.query("update periodo_expensa set modelo = 'fija' where id = $1", [periodoId]);
    await cargarGasto(periodoId, conceptoOrdinario, "9999999.00"); // se registra, no se cobra

    const resumen = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      generarLiquidaciones(tx, { periodoId }),
    );

    expect(resumen.modelo).toBe("fija");
    expect(resumen.totalCuotasFijas).toBe("1200000.00"); // 8 unidades x 150.000
    expect(resumen.totalRepartido).toBe("1200000.00");
    expect(resumen.totalGastos).toBe("9999999.00"); // el gasto quedó registrado igual

    const { rows } = await admin.query<{ total: string; cuota: string; ordinarias: string }>(
      `select total::text, subtotal_cuota_fija::text as cuota, subtotal_ordinarias::text as ordinarias
         from liquidacion where periodo_id = $1 limit 1`,
      [periodoId],
    );
    expect(rows[0]).toMatchObject({ total: "150000.00", cuota: "150000.00", ordinarias: "0.00" });

    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });

  it("las extraordinarias se prorratean ADEMÁS de la cuota, y el período emite", async () => {
    await crearCuotaFija("100000.00");
    const periodoId = await crearPeriodo("2027-04");
    await admin.query("update periodo_expensa set modelo = 'fija' where id = $1", [periodoId]);
    await cargarGasto(periodoId, conceptoOrdinario, "500000.00");
    await cargarGasto(periodoId, conceptoExtraordinario, "400000.00", actaId);

    const resumen = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      generarLiquidaciones(tx, { periodoId }),
    );
    // 8 x 100.000 de cuota + 400.000 de la extraordinaria repartida.
    expect(resumen.totalRepartido).toBe("1200000.00");

    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      emitirPeriodo(tx, periodoId, arbol.usuarios.adminBarrioA1),
    );
    const { rows } = await admin.query<{ estado: string }>(
      "select estado from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(rows[0]?.estado).toBe("emitida");
  });

  it("la línea de cuota fija no tiene gasto ni coeficiente (y la base lo exige)", async () => {
    await crearCuotaFija("90000.00");
    const periodoId = await crearPeriodo("2027-05");
    await admin.query("update periodo_expensa set modelo = 'fija' where id = $1", [periodoId]);
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n
         from item_liquidacion i join liquidacion l on l.id = i.liquidacion_id
        where l.periodo_id = $1 and i.es_cuota_fija and i.gasto_id is null and i.coeficiente_aplicado is null`,
      [periodoId],
    );
    expect(rows[0]?.n).toBe(String(unidades.length));

    // Una línea de cuota fija CON gasto sería una mezcla sin sentido: la base la rechaza.
    const { rows: liq } = await admin.query<{ id: string }>(
      "select id from liquidacion where periodo_id = $1 limit 1",
      [periodoId],
    );
    await expect(
      admin.query(
        `insert into item_liquidacion (barrio_id, liquidacion_id, descripcion, tipo, es_cuota_fija, base_monto, coeficiente_aplicado, monto)
         values ($1,$2,'Mezcla inválida','ordinaria',true,'100.00','0.5','100.00')`,
        [barrioId, liq[0]?.id],
      ),
    ).rejects.toThrow(/item_liquidacion_origen_chk/i);

    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });

  it("si falta la cuota de una unidad, no liquida", async () => {
    const versionId = await crearCuotaFija("80000.00");
    await admin.query(
      "delete from cuota_fija where version_id = $1 and unidad_funcional_id = $2",
      [versionId, unidades[0]],
    );
    const periodoId = await crearPeriodo("2027-06");
    await admin.query("update periodo_expensa set modelo = 'fija' where id = $1", [periodoId]);

    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId })),
    ).rejects.toThrow(/falta la cuota fija/i);

    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
  });

  it("una versión nueva de cuota cierra la anterior (aumento con historia)", async () => {
    await crearCuotaFija("110000.00");
    await crearCuotaFija("130000.00");
    const { rows } = await admin.query<{ abiertas: string; total: string }>(
      `select count(*) filter (where vigente_hasta is null)::text as abiertas, count(*)::text as total
         from cuota_fija_version where barrio_id = $1`,
      [barrioId],
    );
    expect(rows[0]?.abiertas).toBe("1");
    expect(Number(rows[0]?.total)).toBeGreaterThan(1);
  });
});
