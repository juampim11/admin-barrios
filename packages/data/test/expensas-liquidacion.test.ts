/**
 * La liquidación mensual de punta a punta contra Postgres real: cargar gastos, prorratear, emitir.
 *
 * Lo que se prueba acá es lo que la BASE impide, más el servicio completo:
 * extraordinaria sin acta, período emitido inmutable, emisión descuadrada, mora sin tasa cargada.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
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
      `insert into concepto (barrio_id, nombre, tipo, es_fondo_reserva, clasificacion_fiscal)
       values ($1,$2,$3,$4,'sin_clasificar') returning id`,
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
    "concepto_boleta_unidad_evento", "item_liquidacion", "liquidacion", "concepto_boleta_unidad",
    "concepto_boleta_valor", "concepto_boleta", "limite_aplicacion_barrio",
    "gasto_periodo", "periodo_expensa", "concepto", "tasa_mora",
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
      emitirPeriodo(tx, { periodoId }),
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

  it("un propietario NO ve las liquidaciones del barrio, ni la suya", async () => {
    const periodoId = await crearPeriodo("2027-01");
    await cargarGasto(periodoId, conceptoOrdinario, "10000.00");
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    // Desde 0018: sin rol de gestión no se lee ni una fila. Que vea LA SUYA necesita el vínculo
    // usuario→unidad, que no existe todavía (ADR-0002 §3.5, migración 0018 §4).
    const visibles = await conUsuario(db, arbol.usuarios.propietarioA1, async (tx) => {
      const res = await tx.execute<{ n: string }>(
        sql`select count(*)::text as n from liquidacion where periodo_id = ${periodoId}`,
      );
      return res.rows[0]?.n;
    });
    expect(visibles).toBe("0");

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

  /** Crea una versión de cuota fija con una fecha de vigencia explícita. */
  async function crearCuotaFijaDesde(importe: string, vigenteDesde: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into cuota_fija_version (barrio_id, descripcion, vigente_desde)
       values ($1,'Cuota con vigencia explícita', $2::date) returning id`,
      [barrioId, vigenteDesde],
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

  it("el borrador usa la cuota vigente AL MES DEL PERÍODO, no la última abierta", async () => {
    /*
     * La regresión del hallazgo ALTA-1 de la revisión de seguridad del 2026-08-04.
     *
     * El camino normal de la pantalla de la cuota es definir en un mes la cuota **del mes que
     * viene**: a partir de ahí, la versión abierta es la futura. Si el borrador tomara "la abierta",
     * la boleta del mes en curso saldría con la cuota del mes siguiente, `app.validar_emision`
     * cuadraría igual —compara contra la misma versión equivocada— y nadie se enteraría hasta que un
     * vecino comparara dos boletas.
     */
    const mayo = await crearCuotaFijaDesde("100000.00", "2027-05-01");
    const junio = await crearCuotaFijaDesde("130000.00", "2027-06-01"); // la del mes que viene: ABIERTA

    const periodoId = await crearPeriodo("2027-05");
    await admin.query("update periodo_expensa set modelo = 'fija' where id = $1", [periodoId]);

    const resumen = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      generarLiquidaciones(tx, { periodoId }),
    );

    // 8 unidades × 100.000, la cuota de MAYO. Con la versión abierta habría dado 1.040.000.
    expect(resumen.totalCuotasFijas).toBe("800000.00");

    // Se limpian las dos versiones: quedan con vigencia en 2027 y los tests que siguen crean la suya
    // con `current_date`, que es anterior — el trigger no la cerraría y chocarían contra
    // `uq_cuota_fija_version_abierta`.
    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
    await admin.query("delete from cuota_fija where version_id = any($1::uuid[])", [[mayo, junio]]);
    await admin.query("delete from cuota_fija_version where id = any($1::uuid[])", [[mayo, junio]]);
  });

  it("un aumento cargado DESPUÉS de generar el borrador se aplica al regenerarlo", async () => {
    /*
     * La regresión del defecto que el usuario encontró en pantalla el 2026-08-04.
     *
     * El período de agosto estaba en borrador y ya generado una vez, así que su
     * `cuota_fija_version_id` había quedado apuntando a la versión vieja. Se cargó el aumento con
     * vigencia desde agosto y **no pasó nada**: ni el resumen ni la regeneración lo tomaban, porque
     * el cálculo respetaba la versión ya fijada en la fila.
     *
     * Un borrador es derivado y regenerable — es lo que la propia pantalla promete. Congelar es
     * correcto al **emitir**, no antes.
     */
    const vieja = await crearCuotaFijaDesde("100000.00", "2027-08-01");
    const periodoId = await crearPeriodo("2027-08");
    await admin.query("update periodo_expensa set modelo = 'fija' where id = $1", [periodoId]);

    const primera = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      generarLiquidaciones(tx, { periodoId }),
    );
    expect(primera.totalCuotasFijas).toBe("800000.00"); // 8 × 100.000

    // El aumento, con vigencia desde el MISMO mes que ya se generó.
    const nueva = await crearCuotaFijaDesde("130000.00", "2027-08-01");

    const segunda = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      generarLiquidaciones(tx, { periodoId }),
    );
    // 8 × 130.000. Antes daba 800.000: el valor de la corrida anterior.
    expect(segunda.totalCuotasFijas).toBe("1040000.00");

    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
    await admin.query("delete from cuota_fija where version_id = any($1::uuid[])", [[vieja, nueva]]);
    await admin.query("delete from cuota_fija_version where id = any($1::uuid[])", [[vieja, nueva]]);
  });

  it("un período EMITIDO conserva el valor con el que se liquidó, pase lo que pase después", async () => {
    // La otra mitad de la regla: lo que ya se le comunicó a alguien no se recalcula nunca.
    const usada = await crearCuotaFijaDesde("100000.00", "2027-09-01");
    const periodoId = await crearPeriodo("2027-09");
    await admin.query("update periodo_expensa set modelo = 'fija' where id = $1", [periodoId]);
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => emitirPeriodo(tx, { periodoId }));

    const posterior = await crearCuotaFijaDesde("999999.00", "2027-09-01");

    const { rows } = await admin.query<{ version: string }>(
      "select app.cuota_fija_version_del_periodo($1)::text as version",
      [periodoId],
    );
    expect(rows[0]?.version).toBe(usada);

    await admin.query("set session_replication_role = replica");
    await admin.query("delete from item_liquidacion i using liquidacion l where l.id = i.liquidacion_id and l.periodo_id = $1", [periodoId]);
    await admin.query("delete from liquidacion where periodo_id = $1", [periodoId]);
    await admin.query("delete from periodo_expensa where id = $1", [periodoId]);
    await admin.query("set session_replication_role = origin");
    await admin.query("delete from cuota_fija where version_id = any($1::uuid[])", [[usada, posterior]]);
    await admin.query("delete from cuota_fija_version where id = any($1::uuid[])", [[usada, posterior]]);
  });

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
      emitirPeriodo(tx, { periodoId }),
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

    // Una línea que dice ser de cuota fija pero trae coeficiente es una mezcla sin sentido: la base
    // la rechaza (hoy por el check de coherencia entre `es_cuota_fija` y `clase_item`).
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
    ).rejects.toThrow(/item_liquidacion_origen_chk|item_clase_legacy_chk|clase_item/i);

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

describe("seguridad del período (hallazgos del panel de implementación)", () => {
  it("un período NO puede nacer emitido", async () => {
    // Sin esto, `validar_emision` nunca corre para ese período: nadie verificó que cuadre.
    await expect(
      admin.query(
        `insert into periodo_expensa (barrio_id, periodo, estado) values ($1,'2027-11','emitida')`,
        [barrioId],
      ),
    ).rejects.toThrow(/nace en borrador/i);
  });

  it("las marcas de emisión no se pueden falsear al insertar", async () => {
    const { rows } = await admin.query<{ emitida_at: string | null; emitida_por: string | null }>(
      `insert into periodo_expensa (barrio_id, periodo, emitida_at, emitida_por)
       values ($1,'2027-12', now(), $2) returning emitida_at, emitida_por`,
      [barrioId, arbol.usuarios.adminBarrioA1],
    );
    expect(rows[0]?.emitida_at).toBeNull();
    expect(rows[0]?.emitida_por).toBeNull();
    await admin.query("delete from periodo_expensa where barrio_id = $1 and periodo = '2027-12'", [barrioId]);
  });

  it("la firma de quién emitió sale de la sesión, no del request", async () => {
    const periodoId = await crearPeriodo("2028-01");
    await cargarGasto(periodoId, conceptoOrdinario, "100000.00");
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => emitirPeriodo(tx, { periodoId }));

    const { rows } = await admin.query<{ emitida_por: string }>(
      "select emitida_por from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(rows[0]?.emitida_por).toBe(arbol.usuarios.adminBarrioA1);
  });

  it("sin identidad de sesión no se puede emitir", async () => {
    const periodoId = await crearPeriodo("2028-02");
    await cargarGasto(periodoId, conceptoOrdinario, "50000.00");
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    // La conexión de mantenimiento (sin `set_config`) no tiene usuario: la base lo rechaza.
    await expect(
      admin.query("update periodo_expensa set estado = 'emitida' where id = $1", [periodoId]),
    ).rejects.toThrow(/no hay usuario en la sesión/i);
  });

  it("el candado del período falla CERRADO si no se puede determinar el período", async () => {
    // Antes: `NULL in ('emitida','distribuida')` daba NULL, el if no entraba y la escritura pasaba.
    await expect(
      admin.query(
        `insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto)
         values ($1, '00000000-0000-4000-8000-00000000dead', $2, 'Periodo inexistente', '1.00')`,
        [barrioId, conceptoOrdinario],
      ),
    ).rejects.toThrow(/no existe|se rechaza por seguridad|foreign key/i);
  });

  it("dar de alta un concepto EXIGE declarar el encuadre fiscal", async () => {
    // Antes el default era `no_alcanzado`: cada concepto afirmaba por omisión que no está alcanzado
    // por IIBB, sin que nadie lo hubiera mirado. Ahora hay que decirlo — y `sin_clasificar` es la
    // opción honesta cuando todavía no se sabe.
    await expect(
      admin.query(`insert into concepto (barrio_id, nombre, tipo) values ($1,'Sin encuadre','ordinaria')`, [
        barrioId,
      ]),
    ).rejects.toThrow(/clasificacion_fiscal|not-null|null value/i);

    const { rows } = await admin.query<{ clasificacion_fiscal: string }>(
      `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal)
       values ($1,'Encuadre pendiente','ordinaria','sin_clasificar') returning clasificacion_fiscal`,
      [barrioId],
    );
    expect(rows[0]?.clasificacion_fiscal).toBe("sin_clasificar");
  });
});

describe("cargos y descuentos por unidad", () => {
  /** Un `operador`: el rol que aplica cargos todos los días y el que más incentivo de fraude tiene. */
  let operador: string;

  beforeAll(async () => {
    operador = randomUUID();
    await admin.query(
      "insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'operador')",
      [operador, barrioId],
    );
  });

  /** Da de alta un concepto del catálogo con su valor vigente. */
  async function crearConceptoBoleta(opciones: {
    nombre: string;
    clase: "cargo" | "descuento";
    metodo: "monto_fijo" | "porcentaje" | "precio_x_cantidad";
    base?: "expensa_ordinaria" | "sin_base";
    financiamiento?: string;
    monto?: string;
    porcentaje?: string;
    precio?: string;
    tope?: string;
    requiereAdmin?: boolean;
  }): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo, clasificacion_fiscal,
                                    financiamiento, requiere_admin)
       values ($1,$2,$3,$4,$5,'sin_clasificar',$6,$7) returning id`,
      [
        barrioId,
        opciones.nombre,
        opciones.clase,
        opciones.metodo,
        opciones.base ?? "sin_base",
        opciones.clase === "descuento" ? (opciones.financiamiento ?? "partida_presupuestada") : null,
        opciones.requiereAdmin ?? false,
      ],
    );
    const conceptoId = rows[0]?.id as string;
    await admin.query(
      `insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, monto_fijo, porcentaje,
                                          precio_unitario, tope, vigente_desde)
       values ($1,$2,$3,$4,$5,$6,$7, current_date - 30)`,
      [
        barrioId,
        conceptoId,
        opciones.metodo,
        opciones.monto ?? null,
        opciones.porcentaje ?? null,
        opciones.precio ?? null,
        opciones.tope ?? null,
      ],
    );
    return conceptoId;
  }

  /**
   * Aplica un concepto a una unidad. El request manda SOLO esto: qué concepto, a quién, cuándo,
   * cuántas unidades y por qué. El importe y el resto del snapshot los escribe la base.
   */
  async function aplicar(
    usuario: string,
    periodoId: string,
    unidadId: string,
    conceptoId: string,
    cantidad?: string,
    // Migración 0025: un cargo que supera el umbral de monto inusual del barrio se **rechaza** si no
    // viene confirmado. Los fixtures de este archivo reparten gastos chicos entre muchas unidades
    // (expensas de $ 6.250), así que un quincho de $ 45.000 es legítimamente "inusual" contra esa
    // boleta. Los tests que lo necesitan lo dicen en la llamada, en vez de que el helper confirme
    // todo por default y tape la regla — que se ejercita entera en `ataques-escritura` §8.
    confirmar = false,
  ): Promise<void> {
    await conUsuario(db, usuario, async (tx) => {
      await tx.execute(sql`
        insert into concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id,
                                            fecha_hecho, cantidad, detalle, confirmacion_monto_inusual)
        values (${periodoId}, ${unidadId}, ${conceptoId}, current_date, ${cantidad ?? null},
                'detalle de prueba', ${confirmar})
      `);
    });
  }

  it("un cargo y un descuento entran en la boleta, y el prorrateo sigue cerrando exacto", async () => {
    const periodoId = await crearPeriodo("2029-01");
    await cargarGasto(periodoId, conceptoOrdinario, "800000.00");
    const quincho = await crearConceptoBoleta({
      nombre: "Quincho A", clase: "cargo", metodo: "precio_x_cantidad", precio: "45000.00",
    });
    const bonificacion = await crearConceptoBoleta({
      nombre: "Cumplidor A", clase: "descuento", metodo: "porcentaje", base: "expensa_ordinaria",
      porcentaje: "5.000000", tope: "15000.00",
    });

    // `confirmar`: $ 45.000 contra una expensa de fixture de $ 6.250 es "inusual" para la base (0025).
    await aplicar(arbol.usuarios.adminBarrioA1, periodoId, unidades[0] as string, quincho, "1", true);
    await aplicar(arbol.usuarios.adminBarrioA1, periodoId, unidades[0] as string, bonificacion);

    const resumen = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      generarLiquidaciones(tx, { periodoId }),
    );
    expect(resumen.totalCargos).toBe("45000.00");
    expect(Number(resumen.totalDescuentos)).toBeLessThan(0);

    // El invariante viejo no se aflojó: la suma del PRORRATEO sigue siendo el gasto, exacto.
    const { rows } = await admin.query<{ prorrateo: string; cargos: string; descuentos: string }>(
      `select (select sum(i.monto) from item_liquidacion i join liquidacion l on l.id = i.liquidacion_id
                where l.periodo_id = $1 and i.clase_item = 'prorrateo')::text as prorrateo,
              (select subtotal_cargos from liquidacion where periodo_id = $1 and unidad_funcional_id = $2)::text as cargos,
              (select subtotal_descuentos from liquidacion where periodo_id = $1 and unidad_funcional_id = $2)::text as descuentos`,
      [periodoId, unidades[0]],
    );
    expect(rows[0]?.prorrateo).toBe("800000.00");
    expect(rows[0]?.cargos).toBe("45000.00");
    expect(Number(rows[0]?.descuentos)).toBeLessThan(0);

    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => emitirPeriodo(tx, { periodoId }));
    const { rows: periodo } = await admin.query<{ estado: string; total_cargos: string }>(
      "select estado, total_cargos::text from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(periodo[0]?.estado).toBe("emitida");
    expect(periodo[0]?.total_cargos).toBe("45000.00");
  });

  it("el importe lo pone el CATÁLOGO, aunque el cliente mande otro", async () => {
    // El ataque: aplicar el concepto legítimo "quincho $38.000" mandando precio_unitario $9.500.000.
    // Antes entraba y todos los controles cerraban, porque el check verificaba la fila contra sí
    // misma y el cuadre comparaba la boleta contra ese mismo importe inventado.
    const periodoId = await crearPeriodo("2029-06");
    await cargarGasto(periodoId, conceptoOrdinario, "100000.00");
    const quincho = await crearConceptoBoleta({
      nombre: "Quincho tarifado", clase: "cargo", metodo: "precio_x_cantidad", precio: "38000.00",
    });

    await conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
      await tx.execute(sql`
        insert into concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id,
          fecha_hecho, cantidad, detalle, clase, metodo, nombre_concepto, base_calculo,
          clasificacion_fiscal, precio_unitario, importe_resuelto, confirmacion_monto_inusual)
        values (${periodoId}, ${unidades[6]}, ${quincho}, current_date, 2, 'ataque',
                'cargo', 'precio_x_cantidad', 'Quincho vip', 'sin_base', 'sin_clasificar',
                '9500000.00', '19000000.00', true)
      `);
    });

    const { rows } = await admin.query<{ precio: string; nombre: string; resuelto: string | null }>(
      `select precio_unitario::text as precio, nombre_concepto as nombre, importe_resuelto::text as resuelto
         from concepto_boleta_unidad where periodo_id = $1`,
      [periodoId],
    );
    expect(rows[0]?.precio).toBe("38000.00");        // lo pisó el catálogo
    expect(rows[0]?.nombre).toBe("Quincho tarifado"); // el nombre que se imprime, también
    expect(rows[0]?.resuelto).toBeNull();             // el importe nace nulo: no se manda, se calcula

    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    const { rows: item } = await admin.query<{ monto: string }>(
      `select i.monto::text from item_liquidacion i join liquidacion l on l.id = i.liquidacion_id
        where l.periodo_id = $1 and i.clase_item = 'cargo'`,
      [periodoId],
    );
    expect(item[0]?.monto).toBe("76000.00"); // 38.000 × 2, la tarifa real
  });

  it("el importe resuelto NO es escribible por el cliente", async () => {
    const periodoId = await crearPeriodo("2029-07");
    const quincho = await crearConceptoBoleta({
      nombre: "Quincho F", clase: "cargo", metodo: "precio_x_cantidad", precio: "1000.00",
    });
    await aplicar(arbol.usuarios.adminBarrioA1, periodoId, unidades[7] as string, quincho, "1");

    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
        await tx.execute(sql`
          update concepto_boleta_unidad set importe_resuelto = '999999.00' where periodo_id = ${periodoId}
        `);
      }),
    ).rejects.toThrow(/permission denied|permiso/i);
  });

  it("cuando el tope muerde, la boleta imprime el bruto y no lo esconde", async () => {
    const periodoId = await crearPeriodo("2029-08");
    await cargarGasto(periodoId, conceptoOrdinario, "2000000.00");
    const bonificacion = await crearConceptoBoleta({
      nombre: "Cumplidor con techo", clase: "descuento", metodo: "porcentaje",
      base: "expensa_ordinaria", porcentaje: "50.000000", tope: "1000.00",
    });
    await aplicar(arbol.usuarios.adminBarrioA1, periodoId, unidades[0] as string, bonificacion);
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    const { rows } = await admin.query<{ resuelto: string; sin_tope: string; base_item: string; monto: string }>(
      `select c.importe_resuelto::text as resuelto, c.importe_sin_tope::text as sin_tope,
              i.base_monto::text as base_item, i.monto::text as monto
         from concepto_boleta_unidad c
         join item_liquidacion i on i.aplicacion_id = c.id
        where c.periodo_id = $1`,
      [periodoId],
    );
    expect(rows[0]?.resuelto).toBe("1000.00");
    expect(Number(rows[0]?.sin_tope)).toBeGreaterThan(1000);   // el bruto real quedó guardado
    expect(rows[0]?.monto).toBe("-1000.00");
    expect(Number(rows[0]?.base_item)).toBeGreaterThan(1000);  // la línea explica su cifra
  });

  it("dos cargos a la misma unidad suman en el subtotal", async () => {
    const periodoId = await crearPeriodo("2029-09");
    await cargarGasto(periodoId, conceptoOrdinario, "100000.00");
    const quincho = await crearConceptoBoleta({
      nombre: "Quincho G", clase: "cargo", metodo: "precio_x_cantidad", precio: "10000.00",
    });
    const padel = await crearConceptoBoleta({
      nombre: "Cancha de pádel", clase: "cargo", metodo: "monto_fijo", monto: "7500.00",
    });
    await aplicar(arbol.usuarios.adminBarrioA1, periodoId, unidades[1] as string, quincho, "3");
    await aplicar(arbol.usuarios.adminBarrioA1, periodoId, unidades[1] as string, padel);
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    const { rows } = await admin.query<{ cargos: string }>(
      "select subtotal_cargos::text as cargos from liquidacion where periodo_id = $1 and unidad_funcional_id = $2",
      [periodoId, unidades[1]],
    );
    expect(rows[0]?.cargos).toBe("37500.00"); // 10.000 × 3 + 7.500
  });

  it("el total de la boleta cierra con saldo anterior y cargos juntos", async () => {
    const periodoId = await crearPeriodo("2029-10");
    await cargarGasto(periodoId, conceptoOrdinario, "400000.00");
    const quincho = await crearConceptoBoleta({
      nombre: "Quincho H", clase: "cargo", metodo: "monto_fijo", monto: "12345.00",
    });
    await aplicar(arbol.usuarios.adminBarrioA1, periodoId, unidades[2] as string, quincho);

    const saldos = new Map(unidades.map((u) => [u, "50000.00"]));
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      generarLiquidaciones(tx, { periodoId, saldosAnteriores: saldos }),
    );

    const { rows } = await admin.query<{ descuadre: string }>(
      `select count(*)::text as descuadre from liquidacion l
        where l.periodo_id = $1
          and l.total <> (select coalesce(sum(i.monto), 0) from item_liquidacion i where i.liquidacion_id = l.id)
                         + l.saldo_anterior + coalesce(l.interes_mora, 0)`,
      [periodoId],
    );
    expect(rows[0]?.descuadre).toBe("0");
  });

  it("los cargos SOBREVIVEN a regenerar el borrador", async () => {
    // Si la aplicación colgara de `liquidacion` con cascade, cada regeneración evaporaría en
    // silencio el trabajo del administrador y el período cuadraría igual: nadie se enteraría.
    const periodoId = await crearPeriodo("2029-02");
    await cargarGasto(periodoId, conceptoOrdinario, "300000.00");
    const quincho = await crearConceptoBoleta({
      nombre: "Quincho B", clase: "cargo", metodo: "precio_x_cantidad", precio: "20000.00",
    });
    await aplicar(arbol.usuarios.adminBarrioA1, periodoId, unidades[1] as string, quincho, "1", true);

    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    const { rows } = await admin.query<{ aplicaciones: string; items: string }>(
      `select (select count(*) from concepto_boleta_unidad where periodo_id = $1)::text as aplicaciones,
              (select count(*) from item_liquidacion i join liquidacion l on l.id = i.liquidacion_id
                where l.periodo_id = $1 and i.clase_item = 'cargo')::text as items`,
      [periodoId],
    );
    expect(rows[0]?.aplicaciones).toBe("1");
    expect(rows[0]?.items).toBe("1");
  });

  it("anular un cargo y regenerar lo saca de la boleta", async () => {
    const periodoId = await crearPeriodo("2029-11");
    await cargarGasto(periodoId, conceptoOrdinario, "100000.00");
    const quincho = await crearConceptoBoleta({
      nombre: "Quincho I", clase: "cargo", metodo: "monto_fijo", monto: "5000.00",
    });
    await aplicar(arbol.usuarios.adminBarrioA1, periodoId, unidades[3] as string, quincho);
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    await conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
      await tx.execute(sql`
        update concepto_boleta_unidad
           set anulado_at = now(), anulado_por = ${arbol.usuarios.adminBarrioA1},
               motivo_anulacion = 'la reserva se canceló'
         where periodo_id = ${periodoId}
      `);
    });
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    const { rows } = await admin.query<{ n: string; cargos: string }>(
      `select (select count(*) from item_liquidacion i join liquidacion l on l.id = i.liquidacion_id
                where l.periodo_id = $1 and i.clase_item = 'cargo')::text as n,
              (select subtotal_cargos from liquidacion where periodo_id = $1 and unidad_funcional_id = $2)::text as cargos`,
      [periodoId, unidades[3]],
    );
    expect(rows[0]?.n).toBe("0");
    expect(rows[0]?.cargos).toBe("0.00");
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => emitirPeriodo(tx, { periodoId }));
  });

  it("la firma de quién aplicó la pone la base, no el request", async () => {
    const periodoId = await crearPeriodo("2029-03");
    const quincho = await crearConceptoBoleta({
      nombre: "Quincho C", clase: "cargo", metodo: "monto_fijo", monto: "10000.00",
    });
    await conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
      await tx.execute(sql`
        insert into concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id,
          fecha_hecho, detalle, aplicado_por)
        values (${periodoId}, ${unidades[2]}, ${quincho}, current_date, 'firma falsa',
                '00000000-0000-4000-8000-000000000999')
      `);
    });
    const { rows } = await admin.query<{ aplicado_por: string }>(
      "select aplicado_por from concepto_boleta_unidad where periodo_id = $1",
      [periodoId],
    );
    expect(rows[0]?.aplicado_por).toBe(arbol.usuarios.adminBarrioA1);
  });

  it("un cargo NO puede terminar en la boleta de otra unidad", async () => {
    const periodoId = await crearPeriodo("2029-04");
    await cargarGasto(periodoId, conceptoOrdinario, "100000.00");
    const quincho = await crearConceptoBoleta({
      nombre: "Quincho D", clase: "cargo", metodo: "monto_fijo", monto: "5000.00",
    });
    await aplicar(arbol.usuarios.adminBarrioA1, periodoId, unidades[3] as string, quincho);
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId }));

    // Mudar la línea a la boleta de otra unidad no cambia el total del barrio: el cuadre global no
    // lo ve. Lo frena la FK de tres columnas, en el propio UPDATE.
    const { rows: otra } = await admin.query<{ id: string }>(
      "select id from liquidacion where periodo_id = $1 and unidad_funcional_id = $2",
      [periodoId, unidades[4]],
    );
    await expect(
      admin.query(
        `update item_liquidacion set liquidacion_id = $1
          where clase_item = 'cargo' and aplicacion_periodo_id = $2`,
        [otra[0]?.id, periodoId],
      ),
    ).rejects.toThrow(/trio|foreign key|llave foránea/i);
  });

  it("una aplicación no se edita: se anula y queda el rastro", async () => {
    const periodoId = await crearPeriodo("2029-05");
    const quincho = await crearConceptoBoleta({
      nombre: "Quincho E", clase: "cargo", metodo: "precio_x_cantidad", precio: "7000.00",
    });
    await aplicar(arbol.usuarios.adminBarrioA1, periodoId, unidades[5] as string, quincho, "1");
    const { rows } = await admin.query<{ id: string }>(
      "select id from concepto_boleta_unidad where periodo_id = $1",
      [periodoId],
    );
    const aplicacionId = rows[0]?.id;

    // El cliente ni siquiera tiene permiso de escritura sobre las columnas del parámetro.
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
        await tx.execute(sql`update concepto_boleta_unidad set cantidad = 5 where id = ${aplicacionId}`);
      }),
    ).rejects.toThrow(/permission denied|permiso|no se edita/i);

    await conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
      await tx.execute(sql`
        update concepto_boleta_unidad
           set anulado_at = now(), anulado_por = ${arbol.usuarios.adminBarrioA1},
               motivo_anulacion = 'cargado por error'
         where id = ${aplicacionId}
      `);
    });

    const { rows: eventos } = await admin.query<{ n: string }>(
      "select count(*)::text as n from concepto_boleta_unidad_evento where aplicacion_id = $1",
      [aplicacionId],
    );
    expect(Number(eventos[0]?.n)).toBeGreaterThanOrEqual(2); // alta + anulación
  });

  it("el registro de eventos no lo escribe el cliente ni se reescribe", async () => {
    // Un log al que cualquiera le agrega renglones firmados por otro no sirve como evidencia.
    const { rows } = await admin.query<{ id: string; barrio_id: string }>(
      "select id, barrio_id from concepto_boleta_unidad limit 1",
    );
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
        await tx.execute(sql`
          insert into concepto_boleta_unidad_evento (barrio_id, aplicacion_id, evento, actor, motivo)
          values (${rows[0]?.barrio_id}, ${rows[0]?.id}, 'anulacion', ${operador}, 'anulación falsa')
        `);
      }),
    ).rejects.toThrow(/permission denied|permiso/i);

    await expect(
      admin.query("update concepto_boleta_unidad_evento set motivo = 'reescrito' where barrio_id = $1", [barrioId]),
    ).rejects.toThrow(/append-only|no se modifica/i);
  });

  it("un propietario no ve ninguna fila de este módulo", async () => {
    const visibles = await conUsuario(db, arbol.usuarios.propietarioA1, async (tx) => {
      const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from concepto_boleta`);
      return res.rows[0]?.n;
    });
    expect(visibles).toBe("0");
  });

  describe("el tope del operador", () => {
    /** `montoCargo` en `null` = el barrio no declaró tope de cargos → el operador no aplica cargos. */
    async function ponerLimite(
      monto: string,
      porcentaje: string,
      montoCargo: string | null = null,
    ): Promise<void> {
      await admin.query("delete from limite_aplicacion_barrio where barrio_id = $1", [barrioId]);
      await admin.query(
        `insert into limite_aplicacion_barrio (barrio_id, monto_max_operador, porcentaje_max_operador,
                                               monto_max_cargo_operador, vigente_desde)
         values ($1,$2,$3,$4, current_date - 10)`,
        [barrioId, monto, porcentaje, montoCargo],
      );
    }

    it("sin límite cargado, un operador no aplica descuentos (falla cerrado)", async () => {
      await admin.query("delete from limite_aplicacion_barrio where barrio_id = $1", [barrioId]);
      const periodoId = await crearPeriodo("2030-01");
      const bonif = await crearConceptoBoleta({
        nombre: "Bonif operador 1", clase: "descuento", metodo: "monto_fijo", monto: "100.00",
      });
      await expect(aplicar(operador, periodoId, unidades[0] as string, bonif)).rejects.toThrow(
        /no tiene límite de aplicación/i,
      );
    });

    it("con límite cargado, el límite LIMITA", async () => {
      await ponerLimite("500.00", "5.000000");
      const periodoId = await crearPeriodo("2030-02");
      const grande = await crearConceptoBoleta({
        nombre: "Bonif grande", clase: "descuento", metodo: "monto_fijo", monto: "250000.00",
      });
      await expect(aplicar(operador, periodoId, unidades[0] as string, grande)).rejects.toThrow(
        /tope del operador/i,
      );
    });

    it("el tope no se evade partiendo el descuento en varios chicos", async () => {
      await ponerLimite("500.00", "5.000000");
      const periodoId = await crearPeriodo("2030-03");
      const a = await crearConceptoBoleta({
        nombre: "Bonif chica A", clase: "descuento", metodo: "monto_fijo", monto: "400.00",
      });
      const b = await crearConceptoBoleta({
        nombre: "Bonif chica B", clase: "descuento", metodo: "monto_fijo", monto: "400.00",
      });
      await aplicar(operador, periodoId, unidades[0] as string, a);
      await expect(aplicar(operador, periodoId, unidades[0] as string, b)).rejects.toThrow(
        /ya suman hasta/i,
      );
    });

    it("un concepto marcado `requiere_admin` no lo aplica un operador", async () => {
      await ponerLimite("500000.00", "100.000000");
      const periodoId = await crearPeriodo("2030-04");
      const sensible = await crearConceptoBoleta({
        nombre: "Eximición social", clase: "descuento", metodo: "monto_fijo", monto: "100.00",
        requiereAdmin: true,
      });
      await expect(aplicar(operador, periodoId, unidades[0] as string, sensible)).rejects.toThrow(
        /solo lo puede aplicar un administrador/i,
      );
      await admin.query("delete from limite_aplicacion_barrio where barrio_id = $1", [barrioId]);
    });

    it("sin tope de cargos cargado, un operador tampoco aplica CARGOS (0025, falla cerrado)", async () => {
      // Hasta la 0025 este era el único camino sin techo del módulo: el cargo no consultaba nada.
      // Por ahí se emitió una boleta de $ 3.100.000 sobre una expensa de $ 100.000.
      await admin.query("delete from limite_aplicacion_barrio where barrio_id = $1", [barrioId]);
      const periodoId = await crearPeriodo("2030-07");
      const quincho = await crearConceptoBoleta({
        nombre: "Quincho sin tope", clase: "cargo", metodo: "monto_fijo", monto: "3000.00",
      });
      await expect(aplicar(operador, periodoId, unidades[0] as string, quincho)).rejects.toThrow(
        /no tiene tope de cargos/i,
      );
    });

    it("con tope de cargos, el operador aplica dentro de él (y la base le escribe el evento)", async () => {
      // Es el camino de todos los días. En un Postgres administrado, donde el dueño del esquema no
      // es superusuario, este test es el que detecta que el trigger de auditoría no pueda escribir.
      await ponerLimite("500.00", "5.000000", "10000.00");
      const periodoId = await crearPeriodo("2030-05");
      const quincho = await crearConceptoBoleta({
        nombre: "Quincho operador", clase: "cargo", metodo: "monto_fijo", monto: "3000.00",
      });
      await aplicar(operador, periodoId, unidades[0] as string, quincho);
      const { rows } = await admin.query<{ actor: string }>(
        `select e.actor from concepto_boleta_unidad_evento e
           join concepto_boleta_unidad c on c.id = e.aplicacion_id
          where c.periodo_id = $1 and e.evento = 'alta'`,
        [periodoId],
      );
      expect(rows[0]?.actor).toBe(operador);
    });
  });

  it("una unidad dada de baja con un cargo vivo se avisa con nombre y apellido", async () => {
    const periodoId = await crearPeriodo("2030-06");
    await cargarGasto(periodoId, conceptoOrdinario, "100000.00");
    const quincho = await crearConceptoBoleta({
      nombre: "Quincho huérfano", clase: "cargo", metodo: "monto_fijo", monto: "1000.00",
    });
    await aplicar(arbol.usuarios.adminBarrioA1, periodoId, unidades[6] as string, quincho);
    await admin.query("update unidad_funcional set baja_at = now() where id = $1", [unidades[6]]);

    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId })),
    ).rejects.toThrow(/Quincho huérfano/);

    await admin.query("update unidad_funcional set baja_at = null where id = $1", [unidades[6]]);
  });

  it("un descuento porcentual EXIGE tope", async () => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo, clasificacion_fiscal, financiamiento)
       values ($1,'Sin tope','descuento','porcentaje','expensa_ordinaria','sin_clasificar','absorbe_barrio') returning id`,
      [barrioId],
    );
    await expect(
      admin.query(
        `insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, porcentaje, vigente_desde)
         values ($1,$2,'porcentaje','5.000000',current_date)`,
        [barrioId, rows[0]?.id],
      ),
    ).rejects.toThrow(/tope/i);
  });

  it("un CARGO no puede tener tope: recortaría lo que hay que cobrar", async () => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo, clasificacion_fiscal)
       values ($1,'Cargo con techo','cargo','monto_fijo','sin_base','sin_clasificar') returning id`,
      [barrioId],
    );
    await expect(
      admin.query(
        `insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, monto_fijo, tope, vigente_desde)
         values ($1,$2,'monto_fijo','1000.00','500.00',current_date)`,
        [barrioId, rows[0]?.id],
      ),
    ).rejects.toThrow(/tope es el techo de un descuento/i);
  });

  it("un descuento sin declarar quién lo financia no se puede crear", async () => {
    await expect(
      admin.query(
        `insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo, clasificacion_fiscal)
         values ($1,'Sin financiamiento','descuento','monto_fijo','sin_base','sin_clasificar')`,
        [barrioId],
      ),
    ).rejects.toThrow(/financiamiento/i);
  });

  it("el porcentaje se expresa en puntos: 0 y 101 rebotan", async () => {
    // La base NO puede distinguir un 0,05 % legítimo de un 5 % mal tipeado como fracción: prohibirlo
    // rompería descuentos chicos reales. Ese aviso es de la UI (confirmar si el valor es < 1). Acá se
    // asegura lo que sí es siempre un error: cero, negativo o más de cien.
    const { rows } = await admin.query<{ id: string }>(
      `insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo, clasificacion_fiscal, financiamiento)
       values ($1,'Fuera de rango','descuento','porcentaje','expensa_ordinaria','sin_clasificar','absorbe_barrio') returning id`,
      [barrioId],
    );
    for (const porcentaje of ["0.000000", "-5.000000", "101.000000"]) {
      await expect(
        admin.query(
          `insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, porcentaje, tope, vigente_desde)
           values ($1,$2,'porcentaje',$3,'1000.00',current_date)`,
          [barrioId, rows[0]?.id, porcentaje],
        ),
      ).rejects.toThrow(/porcentaje/i);
    }
  });
});
