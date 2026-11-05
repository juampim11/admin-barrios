/**
 * El circuito de la deuda contra Postgres real (ADR-0009, migración `0062`): el saldo arrastrado desde
 * el servicio, el interés por pago fuera de término con los dos órdenes de imputación, la tolerancia,
 * «No se cobra», «No cobrar interés de este pago», la condonación (topes, saldo y quién puede) y que
 * nada se recalcula hacia atrás.
 *
 * El escenario es chico a propósito para que las cuentas se hagan a mano: dos unidades con
 * coeficiente 0,5 y $ 2.000 de gasto, o sea **$ 1.000 por boleta**; tasa 3 % mensual, sin punitoria.
 * Interés de $ 1.000 en 15 días: 1.000 × 0,03 × 15/30 = **$ 15,00**.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { nuevoToken } from "@admin-barrios/almacenamiento";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { condonarInteres, imputarPagoConInteres, registrarEImputarPago } from "../src/servicios/deuda.ts";
import { anularPago, registrarPago } from "../src/servicios/pagos.ts";
import {
  borrarArbol,
  borrarParametrosDe,
  cargarParametro,
  crearArbol,
  crearBarrio,
  dbDe,
  poolAdmin,
  poolApp,
  type Arbol,
} from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf1: string;
let uf2: string;
let conceptoId: string;

const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminB = () => arbol.usuarios.adminBarrioA1;

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

/** Los parámetros de mora del barrio para un caso: 3 % mensual, sin gracia ni punitoria, salvo lo que se pida. */
async function parametros(p: { orden: string; tolerancia?: string; cobra?: boolean; gracia?: number }) {
  await borrarParametrosDe(admin, [barrio()]);
  const n = barrio();
  await cargarParametro(admin, n, "interes.cobra", p.cobra ?? true);
  await cargarParametro(admin, n, "interes.tasa_compensatoria", "0.03");
  await cargarParametro(admin, n, "interes.tasa_punitoria", "0");
  await cargarParametro(admin, n, "interes.gracia_dias", p.gracia ?? 0);
  await cargarParametro(admin, n, "interes.forma_gracia", "corre_inicio");
  await cargarParametro(admin, n, "interes.tolerancia", p.tolerancia ?? "0.00");
  await cargarParametro(admin, n, "imputacion.orden", p.orden);
}

/** Un mes de $ 2.000 de gasto (= $ 1.000 por unidad), generado con saldo arrastrado al `corte` y emitido. */
async function emitirMes(periodo: string, vencimiento: string, corte: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, $2, $3) returning id",
    [barrio(), periodo, vencimiento],
  );
  const periodoId = rows[0]!.id;
  await admin.query(
    "insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '2000.00')",
    [barrio(), periodoId, conceptoId],
  );
  await como(adminB(), (tx) => generarLiquidaciones(tx, { periodoId, origenSaldo: "calculado", fechaCorteMora: corte }));
  await como(adminB(), (tx) => emitirPeriodo(tx, { periodoId }));
  return periodoId;
}

const pagar = (unidad: string, monto: string, fecha: string, noCobrar = false) =>
  como(adminB(), (tx) =>
    registrarEImputarPago(tx, {
      pago: { unidadFuncionalId: unidad, obligadoId: null, monto, fecha, origen: "manual", comprobanteAdjunto: `barrios/${barrio()}/pagos/comprobantes/${nuevoToken()}.pdf` },
      confirmarPagoConInteres: true,
      noCobrarInteres: noCobrar ? { motivo: "negociacion", detalle: "Acordado con el vecino por teléfono", respaldoTipo: null, respaldoReferencia: null, respaldoAdjunto: null } : null,
    }),
  );

async function liquidacionDe(periodoId: string, unidad: string) {
  const { rows } = await admin.query<{ saldo: string; interes: string | null; total: string; exigible: string; dias: number | null }>(
    `select saldo_anterior::text as saldo, interes_mora::text as interes, total::text, importe_exigible::text as exigible, dias_atraso as dias
       from liquidacion where periodo_id = $1 and unidad_funcional_id = $2`,
    [periodoId, unidad],
  );
  return rows[0]!;
}
const saldoUf = async (unidad: string) =>
  (await admin.query<{ s: string }>("select coalesce((select saldo_actual::text from saldo_uf where unidad_funcional_id = $1), '0.00') as s", [unidad])).rows[0]!.s;
const imputado = async (tabla: "pago_imputacion" | "pago_imputacion_interes", unidad: string) =>
  (
    await admin.query<{ s: string }>(
      `select coalesce(sum(i.monto_imputado), 0)::numeric(14,2)::text as s from ${tabla} i join pago p on p.id = i.pago_id
        where p.unidad_funcional_id = $1 and i.anulado_at is null`,
      [unidad],
    )
  ).rows[0]!.s;

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, barrio(), { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  await admin.query("update barrio set denominacion_concepto = 'cuota social' where barrio_id = $1", [barrio()]);
  const { rows: ufs } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad) values ($1,'1','1','construido'), ($1,'1','2','construido') returning id`,
    [barrio()],
  );
  [uf1, uf2] = [ufs[0]!.id, ufs[1]!.id];
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [barrio()],
  );
  await admin.query(
    "insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,0.5), ($1,$2,$4,0.5)",
    [barrio(), v[0]!.id, uf1, uf2],
  );
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
  const { rows: c } = await admin.query<{ id: string }>(
    "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
    [barrio()],
  );
  conceptoId = c[0]!.id;
});

afterEach(async () => {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["interes_condonacion", "pago_imputacion_interes", "pago_imputacion", "interes_devengado", "saldo_uf", "pago",
      "item_liquidacion", "liquidacion", "gasto_periodo", "periodo_expensa"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("commit");
  } finally {
    c.release();
  }
});

afterAll(async () => {
  await borrarParametrosDe(admin, [barrio()]);
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["concepto", "coeficiente", "coeficiente_version", "unidad_funcional", "codigo_pago_secuencia", "barrio_atributo_vigencia", "barrio"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("el saldo arrastrado desde el servicio", () => {
  it("emitir un mes, pagar una parte, generar el siguiente: saldo anterior e importe exigible al centavo", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    await pagar(uf1, "600.00", "2025-01-05"); // en término: sin interés, quedan $ 400 de capital
    const febrero = await emitirMes("2025-02", "2025-02-10", "2025-02-01");

    // UF 1: $ 400 de capital impago del 10/01 al 01/02 (22 días): 400 × 0,03 × 22/30 = 8,80.
    expect(await liquidacionDe(febrero, uf1)).toEqual({ saldo: "400.00", interes: "8.80", total: "1408.80", exigible: "1000.00", dias: 22 });
    // UF 2: no pagó nada: $ 1.000 × 0,03 × 22/30 = 22,00.
    expect(await liquidacionDe(febrero, uf2)).toEqual({ saldo: "1000.00", interes: "22.00", total: "2022.00", exigible: "1000.00", dias: 22 });
    // La cuenta corriente debe exactamente lo que dice la boleta: nada contado dos veces.
    expect(await saldoUf(uf1)).toBe("1408.80");
    expect(await saldoUf(uf2)).toBe("2022.00");
  });

  it("si la deuda cambia después de generar el borrador, no se emite: hay que regenerarlo", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const { rows } = await admin.query<{ id: string }>(
      "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, '2025-02', '2025-02-10') returning id",
      [barrio()],
    );
    const febrero = rows[0]!.id;
    await admin.query(
      "insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '2000.00')",
      [barrio(), febrero, conceptoId],
    );
    await como(adminB(), (tx) => generarLiquidaciones(tx, { periodoId: febrero, origenSaldo: "calculado", fechaCorteMora: "2025-02-01" }));
    await pagar(uf1, "100.00", "2025-01-05");
    const e = await capturar(() => como(adminB(), (tx) => emitirPeriodo(tx, { periodoId: febrero })));
    expect(e.codigo).toBe("borrador_desactualizado");
  });
});

describe("«Generar el borrador» desde la pantalla (sin fecha de corte)", () => {
  it("arrastra a hoy en la hora del barrio y guarda ese corte: la boleta se puede emitir", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const { rows } = await admin.query<{ id: string }>(
      "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, '2025-02', '2025-02-10') returning id",
      [barrio()],
    );
    const febrero = rows[0]!.id;
    await admin.query(
      "insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '2000.00')",
      [barrio(), febrero, conceptoId],
    );
    // Lo mismo que manda `generarBorradorAction`: el período y el origen, nada más.
    await como(adminB(), (tx) => generarLiquidaciones(tx, { periodoId: febrero, origenSaldo: "calculado" }));
    const { rows: l } = await admin.query<{ corte: string; hoy: string; interes: string }>(
      `select l.fecha_corte_mora::text as corte, (now() at time zone b.zona_horaria)::date::text as hoy, l.interes_mora::text as interes
         from liquidacion l join barrio b on b.barrio_id = l.barrio_id
        where l.periodo_id = $1 and l.unidad_funcional_id = $2`,
      [febrero, uf1],
    );
    expect(l[0]!.corte).toBe(l[0]!.hoy);
    expect(Number(l[0]!.interes)).toBeGreaterThan(0);
    await como(adminB(), (tx) => emitirPeriodo(tx, { periodoId: febrero }));
  });
});

describe("el interés por pago fuera de término", () => {
  it("«Intereses primero»: el pago cubre el interés y el resto va al capital; lo pendiente pasa a la boleta siguiente", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const r = await pagar(uf1, "1000.00", "2025-01-25"); // 15 días tarde
    expect(r).toMatchObject({ interesDevengado: "15.00", aInteres: "15.00", aCapital: "985.00" });

    const febrero = await emitirMes("2025-02", "2025-02-10", "2025-02-01");
    // Quedan $ 15 de capital, que devengan del 25/01 al 01/02 (7 días, sin gracia: no es el primer tramo):
    // 15 × 0,03 × 7/30 = 0,105 → 0,10.
    expect(await liquidacionDe(febrero, uf1)).toMatchObject({ saldo: "15.00", interes: "0.10" });
  });

  it("«Capital primero»: el pago cancela el capital y el interés queda como deuda en la boleta siguiente", async () => {
    await parametros({ orden: "capital_primero" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const r = await pagar(uf1, "1000.00", "2025-01-25");
    expect(r).toMatchObject({ interesDevengado: "15.00", aInteres: "0.00", aCapital: "1000.00" });

    const febrero = await emitirMes("2025-02", "2025-02-10", "2025-02-01");
    expect(await liquidacionDe(febrero, uf1)).toMatchObject({ saldo: "0.00", interes: "15.00", total: "1015.00", exigible: "1000.00" });
    expect(await saldoUf(uf1)).toBe("1015.00");
  });

  it("un interés menor que la tolerancia no se cobra, pero queda registrado como no cobrado", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo", tolerancia: "100.00" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const r = await pagar(uf1, "1000.00", "2025-01-25");
    expect(r).toMatchObject({ interesDevengado: "0.00", aCapital: "1000.00" });
    const { rows } = await admin.query<{ calculado: string; tolerancia: boolean }>(
      "select interes_calculado::text as calculado, no_cobrado_por_tolerancia as tolerancia from interes_devengado where unidad_funcional_id = $1",
      [uf1],
    );
    expect(rows).toEqual([{ calculado: "15.00", tolerancia: true }]);
  });

  it("con «No se cobra», nada: ni interés ni registro", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo", cobra: false });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const r = await pagar(uf1, "1000.00", "2025-01-25");
    expect(r).toMatchObject({ interesDevengado: "0.00", aCapital: "1000.00" });
    const { rows } = await admin.query("select 1 from interes_devengado where unidad_funcional_id = $1", [uf1]);
    expect(rows).toHaveLength(0);
  });

  it("dentro de la gracia no hay interés", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo", gracia: 20 });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const r = await pagar(uf1, "1000.00", "2025-01-25");
    expect(r).toMatchObject({ interesDevengado: "0.00", aCapital: "1000.00" });
  });

  it("un pago con fecha anterior al último tramo no recalcula hacia atrás", async () => {
    await parametros({ orden: "capital_primero" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    await pagar(uf1, "500.00", "2025-01-25"); // cierra el tramo al 25/01
    const r = await pagar(uf1, "100.00", "2025-01-20"); // llega con fecha anterior
    expect(r.interesDevengado).toBe("0.00");
  });
});

describe("«No cobrar interés de este pago» y la condonación", () => {
  it("con «No cobrar interés», la imputación es la misma que si el interés fuera cero, y el interés queda condonado", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const r = await pagar(uf1, "1000.00", "2025-01-25", true);
    expect(r).toMatchObject({ interesDevengado: "15.00", interesCondonado: "15.00", aInteres: "0.00", aCapital: "1000.00" });
    // Lo mismo que con «No se cobra»: todo a capital, y la unidad queda en cero.
    expect(await saldoUf(uf1)).toBe("0.00");
    const { rows } = await admin.query<{ motivo: string; origen: string }>(
      "select motivo, origen from interes_condonacion where unidad_funcional_id = $1",
      [uf1],
    );
    expect(rows).toEqual([{ motivo: "negociacion", origen: "pago" }]);
  });

  it("condonar baja el saldo exactamente lo condonado, nunca más que lo pendiente, y pide confirmación", async () => {
    await parametros({ orden: "capital_primero" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    await pagar(uf1, "1000.00", "2025-01-25"); // quedan $ 15 de interés pendiente
    expect(await saldoUf(uf1)).toBe("15.00");

    const datos = { unidadFuncionalId: uf1, motivo: "comision_asamblea" as const, detalle: "Lo resolvió la comisión en la reunión de enero", respaldoTipo: "acta_comision" as const, respaldoReferencia: "Acta de comisión 3/2025", respaldoAdjunto: null };
    const sinConfirmar = await capturar(() => como(adminB(), (tx) => condonarInteres(tx, { ...datos, monto: "10.00" })));
    expect(sinConfirmar.codigo).toBe("condonacion_requiere_confirmacion");

    await como(adminB(), (tx) => condonarInteres(tx, { ...datos, monto: "10.00", confirmarCondonacion: true }));
    expect(await saldoUf(uf1)).toBe("5.00");

    const demasiado = await capturar(() => como(adminB(), (tx) => condonarInteres(tx, { ...datos, monto: "6.00", confirmarCondonacion: true })));
    expect(demasiado.codigo).toBe("condonacion_excede_pendiente");
  });

  it("el interés ya pagado no se condona", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    await pagar(uf1, "1000.00", "2025-01-25"); // el pago cubrió los $ 15 de interés
    const e = await capturar(() =>
      como(adminB(), (tx) =>
        condonarInteres(tx, { unidadFuncionalId: uf1, monto: "15.00", motivo: "error", detalle: "Se cobró de más por error", respaldoTipo: null, respaldoReferencia: null, respaldoAdjunto: null, confirmarCondonacion: true }),
      ),
    );
    expect(e.codigo).toBe("condonacion_excede_pendiente");
  });

  it("solo la administración condona: un operador y un contador no pueden (lo decide la base)", async () => {
    await parametros({ orden: "capital_primero" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    await pagar(uf1, "1000.00", "2025-01-25");
    const { rows } = await admin.query<{ id: string }>("select id from interes_devengado where unidad_funcional_id = $1 and monto > 0", [uf1]);
    const interesId = rows[0]!.id;
    for (const usuario of [arbol.usuarios.operadorA1, arbol.usuarios.contadorA1, arbol.usuarios.adminEstudioB]) {
      await expect(
        como(usuario, (tx) =>
          tx.execute(sql`
            insert into interes_condonacion (barrio_id, unidad_funcional_id, interes_id, monto, motivo, detalle, origen, rol_al_condonar, creado_por)
            values (${barrio()}, ${uf1}, ${interesId}, 1, 'otro', 'Intento sin permiso de condonar', 'estado_cuenta', 'x', ${usuario})
          `),
        ),
      ).rejects.toThrow();
    }
    // La administración del estudio (rol en la administración, hereda el barrio) sí.
    await como(arbol.usuarios.adminEstudioA, (tx) =>
      condonarInteres(tx, { unidadFuncionalId: uf1, monto: "1.00", motivo: "otro", detalle: "Prueba de permiso de la administración", respaldoTipo: null, respaldoReferencia: null, respaldoAdjunto: null, confirmarCondonacion: true }),
    );
    expect(await saldoUf(uf1)).toBe("14.00");
  });

  it("el interés devengado, las imputaciones y las condonaciones no se editan ni se borran", async () => {
    await parametros({ orden: "capital_primero" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    await pagar(uf1, "1000.00", "2025-01-25");
    await expect(
      como(adminB(), (tx) => tx.execute(sql`update interes_devengado set monto = 0 where unidad_funcional_id = ${uf1}`)),
    ).rejects.toThrow();
    await expect(
      como(adminB(), (tx) => tx.execute(sql`delete from interes_devengado where unidad_funcional_id = ${uf1}`)),
    ).rejects.toThrow();
  });

  it("imputarPagoConInteres sobre un pago ya registrado da lo mismo que el registro con imputación", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const pago = await como(adminB(), (tx) =>
      registrarPago(tx, { unidadFuncionalId: uf2, obligadoId: null, monto: "1000.00", fecha: "2025-01-25", origen: "manual", comprobanteAdjunto: `barrios/${barrio()}/pagos/comprobantes/${nuevoToken()}.pdf` }),
    );
    const r = await como(adminB(), (tx) => imputarPagoConInteres(tx, { pagoId: pago.id }));
    expect(r).toMatchObject({ interesDevengado: "15.00", aInteres: "15.00", aCapital: "985.00" });
    expect(await imputado("pago_imputacion_interes", uf2)).toBe("15.00");
    expect(await imputado("pago_imputacion", uf2)).toBe("985.00");
  });
});

describe("lo que encontró la revisión de seguridad (0064)", () => {
  it("un pago con fecha futura no se registra: el interés no corre hasta una fecha que no llegó", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const e = await capturar(() => pagar(uf1, "1000.00", "2099-01-01"));
    expect(e.codigo).toBe("dato_invalido");
  });

  it("el saldo y el interés pendiente de otro barrio no se pueden averiguar por su id", async () => {
    await parametros({ orden: "capital_primero" });
    const enero = await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    await pagar(uf1, "1000.00", "2025-01-25");
    const { rows: l } = await admin.query<{ id: string }>("select id from liquidacion where periodo_id = $1 limit 1", [enero]);
    const { rows: d } = await admin.query<{ id: string }>("select id from interes_devengado where unidad_funcional_id = $1 limit 1", [uf1]);
    const { rows: unaLiq } = await admin.query<{ id: string }>("select id from liquidacion where barrio_id = $1 limit 1", [barrio()]);
    const ajeno = await como(arbol.usuarios.adminEstudioB, (tx) =>
      tx.execute<{ capital: string | null; interes: string | null }>(sql`
        select app.capital_pendiente(${l[0]!.id}::uuid)::text as capital, app.interes_pendiente(${d[0]!.id}::uuid)::text as interes
      `),
    );
    expect(ajeno.rows[0]).toEqual({ capital: null, interes: null });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Encargo 11 (BL-030 j): «No cobrar interés» condona dos partes — el interés de este atraso y el
// interés anterior que la unidad todavía debe (todo lo pendiente antes del pago, haya salido o no en
// una boleta: decisión del titular, 2026-11-04). Al centavo.
// ────────────────────────────────────────────────────────────────────────────────────────────────

const NO_COBRAR = { motivo: "negociacion" as const, detalle: "Acordado con el vecino por teléfono", respaldoTipo: null, respaldoReferencia: null, respaldoAdjunto: null };

const pagarCondonando = (
  unidad: string,
  monto: string,
  fecha: string,
  condonar: { delPago: boolean; anterior: boolean },
  confirmar = true,
) =>
  como(adminB(), (tx) =>
    registrarEImputarPago(tx, {
      pago: { unidadFuncionalId: unidad, obligadoId: null, monto, fecha, origen: "manual", comprobanteAdjunto: `barrios/${barrio()}/pagos/comprobantes/${nuevoToken()}.pdf` },
      confirmarPagoConInteres: confirmar,
      noCobrarInteres: NO_COBRAR,
      condonar,
    }),
  );

const interesPendiente = async (unidad: string) =>
  (
    await admin.query<{ s: string }>(
      "select coalesce(sum(app.interes_pendiente(id)), 0)::numeric(14,2)::text as s from interes_devengado where unidad_funcional_id = $1",
      [unidad],
    )
  ).rows[0]!.s;

/**
 * La unidad 1 debe $ 15,00 de interés ya facturado: pagó enero tarde con «Capital primero» y la boleta
 * de febrero se los facturó. Febrero ($ 1.000) vence el 10/02; pagado el 25/02, el atraso de ese pago
 * es 1.000 × 0,03 × 15/30 = **$ 15,00**. Las dos partes valen $ 15,00 cada una.
 */
async function conInteresYaFacturado(orden: "capital_primero" | "intereses_primero_capital_antiguo") {
  await parametros({ orden: "capital_primero" });
  await emitirMes("2025-01", "2025-01-10", "2025-01-01");
  await pagar(uf1, "1000.00", "2025-01-25"); // capital primero: quedan $ 15 de interés pendiente
  const febrero = await emitirMes("2025-02", "2025-02-10", "2025-02-01");
  const boleta = await liquidacionDe(febrero, uf1);
  expect(boleta).toMatchObject({ saldo: "0.00", interes: "15.00", total: "1015.00" });
  expect(await saldoUf(uf1)).toBe("1015.00");
  if (orden !== "capital_primero") await parametros({ orden });
  return { febrero, boleta };
}

describe("«No cobrar interés» en dos partes (encargo 11, BL-030 j)", () => {
  it("pago total con las dos partes: se condonan $ 15,00 + $ 15,00, todo va a capital y la unidad queda en cero; la boleta emitida no cambia", async () => {
    const { febrero, boleta } = await conInteresYaFacturado("capital_primero");
    const r = await pagarCondonando(uf1, "1000.00", "2025-02-25", { delPago: true, anterior: true });
    expect(r).toMatchObject({
      interesDevengado: "15.00",
      interesCondonado: "30.00",
      interesCondonadoDelPago: "15.00",
      interesCondonadoAnterior: "15.00",
      aInteres: "0.00",
      aCapital: "1000.00",
    });
    expect(await saldoUf(uf1)).toBe("0.00");
    expect(await interesPendiente(uf1)).toBe("0.00");
    // Las boletas emitidas no se tocan: lo condonado es una condonación, no una boleta corregida.
    expect(await liquidacionDe(febrero, uf1)).toEqual(boleta);
    const { rows } = await admin.query<{ monto: string; origen: string; pago: string | null }>(
      "select monto::text, origen, pago_id as pago from interes_condonacion where unidad_funcional_id = $1 order by monto",
      [uf1],
    );
    expect(rows).toEqual([
      { monto: "15.00", origen: "pago", pago: r.id },
      { monto: "15.00", origen: "pago", pago: r.id },
    ]);
  });

  it("pago parcial con las dos partes («Intereses primero»): los $ 400 van enteros a capital y quedan $ 600 de capital", async () => {
    await conInteresYaFacturado("intereses_primero_capital_antiguo");
    const r = await pagarCondonando(uf1, "400.00", "2025-02-25", { delPago: true, anterior: true });
    expect(r).toMatchObject({
      interesCondonado: "30.00",
      interesCondonadoDelPago: "15.00",
      interesCondonadoAnterior: "15.00",
      aInteres: "0.00",
      aCapital: "400.00",
    });
    expect(await saldoUf(uf1)).toBe("600.00");
    expect(await interesPendiente(uf1)).toBe("0.00");
  });

  it("solo el renglón de este atraso («Intereses primero»): el interés anterior se cobra primero", async () => {
    await conInteresYaFacturado("intereses_primero_capital_antiguo");
    const r = await pagarCondonando(uf1, "1000.00", "2025-02-25", { delPago: true, anterior: false });
    expect(r).toMatchObject({
      interesCondonado: "15.00",
      interesCondonadoDelPago: "15.00",
      interesCondonadoAnterior: "0.00",
      aInteres: "15.00",
      aCapital: "985.00",
    });
    expect(await saldoUf(uf1)).toBe("15.00");
    expect(await interesPendiente(uf1)).toBe("0.00");
  });

  it("solo el renglón del interés ya facturado («Intereses primero»): el de este atraso se cobra", async () => {
    await conInteresYaFacturado("intereses_primero_capital_antiguo");
    const r = await pagarCondonando(uf1, "1000.00", "2025-02-25", { delPago: false, anterior: true });
    expect(r).toMatchObject({
      interesDevengado: "15.00",
      interesCondonado: "15.00",
      interesCondonadoDelPago: "0.00",
      interesCondonadoAnterior: "15.00",
      aInteres: "15.00",
      aCapital: "985.00",
    });
    expect(await saldoUf(uf1)).toBe("15.00");
    expect(await interesPendiente(uf1)).toBe("0.00");
  });

  it("anular el pago anula las dos condonaciones: el saldo vuelve a $ 1.030,00 y el interés vuelve a deberse", async () => {
    await conInteresYaFacturado("capital_primero");
    const r = await pagarCondonando(uf1, "1000.00", "2025-02-25", { delPago: true, anterior: true });
    expect(await saldoUf(uf1)).toBe("0.00");
    await como(adminB(), (tx) => anularPago(tx, { pagoId: r.id, motivo: "La transferencia vino rebotada" }));
    const { rows } = await admin.query<{ anulada: boolean; motivo: string | null }>(
      "select anulado_at is not null as anulada, motivo_anulacion as motivo from interes_condonacion where pago_id = $1",
      [r.id],
    );
    expect(rows).toEqual([
      { anulada: true, motivo: "La transferencia vino rebotada" },
      { anulada: true, motivo: "La transferencia vino rebotada" },
    ]);
    // La boleta de febrero ($ 1.000), el interés ya facturado ($ 15) y el de este atraso ($ 15).
    expect(await saldoUf(uf1)).toBe("1030.00");
    expect(await interesPendiente(uf1)).toBe("30.00");
    const { rows: cuenta } = await admin.query<{ s: string }>(
      "select sum(monto)::numeric(14,2)::text as s from app.v_estado_cuenta_uf where unidad_funcional_id = $1",
      [uf1],
    );
    expect(cuenta[0]!.s).toBe("1030.00");
  });

  it("la deuda por barrio (0074) da lo mismo que las escalares, con pago y condonaciones anuladas y vivas", async () => {
    // Compara, fila por fila, las funciones de todo el barrio contra las de una sola fila, que son
    // las de siempre. Es lo que permite que la vista previa y la emisión usen las de barrio.
    const mismas = async () => {
      const { rows } = await admin.query<{ distintas: string; filas: string }>(
        `select (select count(*) from liquidacion l join app.capitales_pendientes($1) cp on cp.liquidacion_id = l.id
                  where cp.pendiente is distinct from app.capital_pendiente(l.id))
              + (select count(*) from interes_devengado d join app.intereses_pendientes($1) ip on ip.interes_id = d.id
                  where ip.pendiente is distinct from app.interes_pendiente(d.id) or ip.unidad_funcional_id <> d.unidad_funcional_id)
                as distintas,
                (select count(*) from app.capitales_pendientes($1)) + (select count(*) from app.intereses_pendientes($1)) as filas`,
        [barrio()],
      );
      expect(Number(rows[0]!.distintas)).toBe(0);
      return Number(rows[0]!.filas);
    };
    await conInteresYaFacturado("capital_primero");
    const r = await pagarCondonando(uf1, "1000.00", "2025-02-25", { delPago: true, anterior: true });
    expect(await mismas()).toBeGreaterThan(0);
    await como(adminB(), (tx) => anularPago(tx, { pagoId: r.id, motivo: "La transferencia vino rebotada" }));
    await mismas();
    await pagarCondonando(uf1, "1030.00", "2025-02-26", { delPago: true, anterior: true });
    await mismas();

    // BL-033: quien no es del barrio no ve ni una fila, ni con las de barrio ni con las escalares.
    const { rows: unaLiq } = await admin.query<{ id: string }>("select id from liquidacion where barrio_id = $1 limit 1", [barrio()]);
    const ajeno = await como(arbol.usuarios.adminEstudioB, (tx) =>
      tx.execute<{ filas: number; capital: string | null }>(sql`
        select (select count(*)::int from app.capitales_pendientes(${barrio()}::uuid))
             + (select count(*)::int from app.intereses_pendientes(${barrio()}::uuid)) as filas,
               (select app.capital_pendiente(l.id)::text from (select ${unaLiq[0]!.id}::uuid as id) l) as capital`),
    );
    expect(ajeno.rows[0]).toEqual({ filas: 0, capital: null });
  });

  it("«todo lo anterior» incluye el interés de un pago parcial que todavía no salió en una boleta", async () => {
    // Enero vence el 10/01. El 25/01 paga $ 10: devengó $ 15 y cubre $ 10, quedan $ 5 de interés que
    // ninguna boleta mostró todavía. El 30/01 paga el resto: el atraso de ese pago es
    // 1.000 × 0,03 × 5/30 = $ 5,00. Los dos renglones: $ 5,00 de este atraso y $ 5,00 anterior.
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const parcial = await pagar(uf1, "10.00", "2025-01-25");
    expect(parcial).toMatchObject({ interesDevengado: "15.00", aInteres: "10.00", aCapital: "0.00" });
    const r = await pagarCondonando(uf1, "1000.00", "2025-01-30", { delPago: true, anterior: true });
    expect(r).toMatchObject({
      interesDevengado: "5.00",
      interesCondonadoDelPago: "5.00",
      interesCondonadoAnterior: "5.00",
      aInteres: "0.00",
      aCapital: "1000.00",
    });
    expect(await saldoUf(uf1)).toBe("0.00");
  });

  it("condonar solo el interés anterior en un pago sin atraso también pide confirmación, con el importe", async () => {
    await parametros({ orden: "capital_primero" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    await pagar(uf1, "1000.00", "2025-01-25"); // queda $ 15 de interés y nada de capital
    const e = await capturar(() => pagarCondonando(uf1, "1.00", "2025-01-26", { delPago: true, anterior: true }, false));
    expect(e.codigo).toBe("pago_con_interes_requiere_confirmacion");
    expect(e.message).toMatch(/no devengó interés nuevo/);
    expect(e.message).toMatch(/se condonan \$ 15,00 de interés anterior/);
    const r = await pagarCondonando(uf1, "1.00", "2025-01-26", { delPago: true, anterior: true });
    expect(r).toMatchObject({ interesCondonado: "15.00", interesCondonadoAnterior: "15.00", aInteres: "0.00", aCapital: "0.00" });
    expect(await interesPendiente(uf1)).toBe("0.00");
  });

  it("«No cobrar interés» sin ninguna parte se rechaza en el servicio, no solo en la pantalla (code-reviewer)", async () => {
    await conInteresYaFacturado("intereses_primero_capital_antiguo");
    const e = await capturar(() => pagarCondonando(uf1, "1000.00", "2025-02-25", { delPago: false, anterior: false }));
    expect(e.codigo).toBe("dato_invalido");
    expect(await saldoUf(uf1)).toBe("1015.00");
  });

  it("sin «No cobrar interés», nada se condona aunque se pidan las partes", async () => {
    await conInteresYaFacturado("intereses_primero_capital_antiguo");
    const r = await como(adminB(), (tx) =>
      registrarEImputarPago(tx, {
        pago: { unidadFuncionalId: uf1, obligadoId: null, monto: "1000.00", fecha: "2025-02-25", origen: "manual", comprobanteAdjunto: `barrios/${barrio()}/pagos/comprobantes/${nuevoToken()}.pdf` },
        confirmarPagoConInteres: true,
        noCobrarInteres: null,
        condonar: { delPago: true, anterior: true },
      }),
    );
    expect(r).toMatchObject({ interesCondonado: "0.00", aInteres: "30.00", aCapital: "970.00" });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Encargo 11 (permiso, `0070`): un pago con interés condonado vigente lo anula la administración.
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("anular un pago con interés condonado es de la administración (encargo 11, 0070)", () => {
  const operador = () => arbol.usuarios.operadorA1;

  it("un operador es rechazado, por el servicio y yendo directo a la tabla; no se anula nada", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const pago = await pagar(uf1, "1000.00", "2025-01-25", true); // $ 15 condonados
    const saldo = await saldoUf(uf1);

    const e = await capturar(() => como(operador(), (tx) => anularPago(tx, { pagoId: pago.id, motivo: "Se cargó por error" })));
    expect(e.codigo).toBe("pago_con_condonacion_solo_admin");
    expect(e.message).toBe("Lo anula un administrador porque tiene interés condonado.");

    await expect(
      como(operador(), (tx) => tx.execute(sql`update pago set anulado_at = now(), motivo_anulacion = 'Directo a la tabla' where id = ${pago.id}`)),
    ).rejects.toThrow(/anular un pago con interés condonado es de la administración/);

    const { rows } = await admin.query<{ pago: boolean; condonacion: boolean; imputaciones: number }>(
      `select (select anulado_at is null from pago where id = $1) as pago,
              (select bool_and(anulado_at is null) from interes_condonacion where pago_id = $1) as condonacion,
              (select count(*)::int from pago_imputacion where pago_id = $1 and anulado_at is not null) as imputaciones`,
      [pago.id],
    );
    expect(rows[0]).toEqual({ pago: true, condonacion: true, imputaciones: 0 });
    expect(await saldoUf(uf1)).toBe(saldo);
  });

  it("«¿tiene condonación vigente?» no responde por un pago de otro barrio (security-engineer)", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const pago = await pagar(uf1, "1000.00", "2025-01-25", true);
    const propio = await como(operador(), (tx) => tx.execute<{ r: boolean }>(sql`select app.pago_tiene_condonacion_vigente(${pago.id}::uuid) as r`));
    expect(propio.rows[0]!.r).toBe(true);
    const { rows: unaLiq } = await admin.query<{ id: string }>("select id from liquidacion where barrio_id = $1 limit 1", [barrio()]);
    const ajeno = await como(arbol.usuarios.adminEstudioB, (tx) =>
      tx.execute<{ r: boolean }>(sql`select app.pago_tiene_condonacion_vigente(${pago.id}::uuid) as r`),
    );
    expect(ajeno.rows[0]!.r).toBe(false);
  });

  it("un administrador sí lo anula, con su condonación", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const pago = await pagar(uf1, "1000.00", "2025-01-25", true);
    await como(adminB(), (tx) => anularPago(tx, { pagoId: pago.id, motivo: "Se cargó por error" }));
    const { rows } = await admin.query<{ anulada: boolean }>("select anulado_at is not null as anulada from interes_condonacion where pago_id = $1", [pago.id]);
    expect(rows).toEqual([{ anulada: true }]);
    expect(await saldoUf(uf1)).toBe("1015.00");
  });

  it("un operador sigue anulando un pago sin condonación", async () => {
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const pago = await pagar(uf1, "1000.00", "2025-01-25");
    await como(operador(), (tx) => anularPago(tx, { pagoId: pago.id, motivo: "Se cargó por error" }));
    const { rows } = await admin.query<{ anulado: boolean }>("select anulado_at is not null as anulado from pago where id = $1", [pago.id]);
    expect(rows[0]!.anulado).toBe(true);
  });

  it("un operador tampoco anula la condonación suelta de un pago ya anulado", async () => {
    // Una condonación que quedó viva con su pago anulado (las de antes de 0068 no se anularon).
    await parametros({ orden: "intereses_primero_capital_antiguo" });
    await emitirMes("2025-01", "2025-01-10", "2025-01-01");
    const pago = await pagar(uf1, "1000.00", "2025-01-25", true);
    await admin.query("set session_replication_role = replica");
    await admin.query("update pago set anulado_at = now(), anulado_por = $2, motivo_anulacion = 'Anulado antes de 0068' where id = $1", [pago.id, adminB()]);
    await admin.query("set session_replication_role = origin");
    await expect(
      como(operador(), (tx) => tx.execute(sql`update interes_condonacion set anulado_at = now(), motivo_anulacion = 'x' where pago_id = ${pago.id}`)),
    ).rejects.toThrow(/anular un pago con interés condonado es de la administración/);
  });
});
