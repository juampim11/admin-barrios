/**
 * Encargo 16c (PR 2), contra Postgres real (`0090`): el presupuesto del mes, los gastos contra
 * presupuesto y el resultado del mes. **Cada número, al centavo, sobre un caso armado a mano.**
 *
 * El caso (tres unidades, coeficientes 0,5 / 0,3 / 0,2, el barrio no cobra interés):
 *
 *   Octubre 2026 (emitido): gastos Vigilancia $ 1.000 (a mano), Mantenimiento $ 500 (orden 1) y
 *   Mantenimiento $ 200 (orden 2). Boletas: $ 850 / $ 510 / $ 340 = $ 1.700.
 *     · Pagos: la 1 paga $ 850 el 15/10; la 2, $ 200 el 20/10; la 3, $ 100 el 02/11. Un pago de
 *       $ 999 del 21/10, anulado.
 *     · La orden 1 se paga el 20/10. La orden 2 se anula ya emitido octubre: su ajuste de −$ 200 va
 *       a noviembre.
 *   Noviembre 2026 (en preparación): Vigilancia $ 1.100 y Mantenimiento $ 700, a mano, más el ajuste
 *   de −$ 200. Presupuesto: Vigilancia $ 1.200, Mantenimiento $ 450, margen $ 150.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { registrarEImputarPago } from "../src/servicios/deuda.ts";
import { anularPago } from "../src/servicios/pagos.ts";
import { emitirMes, avisosDelMes } from "../src/servicios/circuito-del-mes.ts";
import { registrarProveedor } from "../src/servicios/proveedores.ts";
import { anularOrdenPago, aprobarOrdenPago, marcarOrdenPagada, registrarOrdenPago } from "../src/servicios/ordenes-pago.ts";
import { definirCuotaFija } from "../src/servicios/cuota-fija.ts";
import {
  copiarPresupuestoDelMesAnterior,
  gastosContraPresupuesto,
  guardarPresupuesto,
  presupuestoDelMes,
  resultadoDelMes,
} from "../src/servicios/presupuesto.ts";
import { borrarArbol, borrarParametrosDe, cargarParametro, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf: [string, string, string];
let vigilancia: string;
let mantenimiento: string;
let octubre: string;
let noviembre: string;

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

async function sinTriggers(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await fn(c);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

const crearPeriodo = async (periodo: string, vencimiento: string) =>
  (
    await admin.query<{ id: string }>(
      "insert into periodo_expensa (barrio_id, periodo, modelo, primer_vencimiento) values ($1, $2, 'variable', $3) returning id",
      [barrio(), periodo, vencimiento],
    )
  ).rows[0]!.id;

const gastoAMano = (periodoId: string, conceptoId: string, descripcion: string, monto: string) =>
  admin.query("insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, $4, $5)", [
    barrio(),
    periodoId,
    conceptoId,
    descripcion,
    monto,
  ]);

const emitir = (periodoId: string) =>
  como(adminB(), (tx) => emitirMes(tx, { periodoId, huellaVista: null, vistaCalculadaEl: null, confirmarCambios: false }));

const pagar = (unidad: string, monto: string, fecha: string) =>
  como(adminB(), (tx) =>
    registrarEImputarPago(tx, {
      pago: { unidadFuncionalId: unidad, obligadoId: null, monto, fecha, origen: "extracto", comprobanteAdjunto: null },
      confirmarPagoConInteres: true,
      noCobrarInteres: null,
    }),
  );

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, barrio());
  const { rows: u } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
     values ($1,'1','1','construido'), ($1,'1','2','construido'), ($1,'1','3','construido') returning id`,
    [barrio()],
  );
  uf = [u[0]!.id, u[1]!.id, u[2]!.id];
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [barrio()],
  );
  await admin.query(
    "insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,0.5), ($1,$2,$4,0.3), ($1,$2,$5,0.2)",
    [barrio(), v[0]!.id, ...uf],
  );
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
  const { rows: c } = await admin.query<{ id: string; nombre: string }>(
    `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal)
     values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar'), ($1, 'Mantenimiento', 'ordinaria', 'sin_clasificar') returning id, nombre`,
    [barrio()],
  );
  vigilancia = c.find((x) => x.nombre === "Vigilancia")!.id;
  mantenimiento = c.find((x) => x.nombre === "Mantenimiento")!.id;
  for (const [clave, valor] of [
    ["interes.cobra", false], ["interes.tasa_compensatoria", "0.03"], ["interes.tasa_punitoria", "0"], ["interes.gracia_dias", 0],
    ["interes.forma_gracia", "corre_inicio"], ["interes.tolerancia", "0.00"], ["imputacion.orden", "intereses_primero_capital_antiguo"],
  ] as const) {
    await cargarParametro(admin, barrio(), clave, valor);
  }
  const proveedor = await como(adminB(), (tx) =>
    registrarProveedor(tx, { barrioId: barrio(), razonSocial: "Proveedor de prueba", cuit: null, condicionFiscal: null, contacto: null, cbu: null, alias: null }),
  );
  const orden = async (periodoId: string, monto: string) =>
    (
      await como(adminB(), (tx) =>
        registrarOrdenPago(tx, { proveedorId: proveedor.id, periodoId, conceptoId: mantenimiento, numeroFactura: null, descripcion: "Trabajo de prueba", monto }),
      )
    ).id;

  // Octubre: tres gastos, se emite.
  octubre = await crearPeriodo("2026-10", "2026-10-10");
  await gastoAMano(octubre, vigilancia, "Vigilancia de octubre", "1000.00");
  const orden1 = await orden(octubre, "500.00");
  const orden2 = await orden(octubre, "200.00");
  await como(adminB(), (tx) => aprobarOrdenPago(tx, { ordenPagoId: orden1 }));
  await como(adminB(), (tx) => aprobarOrdenPago(tx, { ordenPagoId: orden2 }));
  await emitir(octubre);

  // Los cobros y los pagos.
  await pagar(uf[0], "850.00", "2026-10-15");
  await pagar(uf[1], "200.00", "2026-10-20");
  await pagar(uf[2], "100.00", "2026-11-02");
  const anulado = await pagar(uf[1], "999.00", "2026-10-21");
  await como(adminB(), (tx) => anularPago(tx, { pagoId: anulado.id, motivo: "El banco revirtió la transferencia" }));
  await como(adminB(), (tx) => marcarOrdenPagada(tx, { ordenPagoId: orden1, medioPago: "transferencia" }));
  await sinTriggers(async (cl) => {
    await cl.query("update orden_pago set pagada_at = '2026-10-20 15:00:00+00' where id = $1", [orden1]);
  });

  // Noviembre: en preparación. La orden 2 se anula ahora: su ajuste negativo cae acá.
  noviembre = await crearPeriodo("2026-11", "2026-11-25");
  await gastoAMano(noviembre, vigilancia, "Vigilancia de noviembre", "1100.00");
  await gastoAMano(noviembre, mantenimiento, "Reparación de la bomba", "700.00");
  await como(adminB(), (tx) => anularOrdenPago(tx, { ordenPagoId: orden2, motivo: "El proveedor no entregó el trabajo" }));
});

afterAll(async () => {
  await sinTriggers(async (c) => {
    for (const t of [
      "presupuesto_rubro", "presupuesto_margen", "padron_evento", "pago_imputacion_interes", "pago_imputacion", "interes_devengado",
      "interes_condonacion", "saldo_uf", "pago", "item_liquidacion", "liquidacion", "gasto_periodo", "orden_pago", "periodo_expensa",
      "proveedor", "cuota_fija", "cuota_fija_version", "trabajo", "concepto", "coeficiente", "coeficiente_version", "unidad_funcional",
      "codigo_pago_secuencia", "barrio_atributo_vigencia", "barrio",
    ]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
  });
  await borrarParametrosDe(admin, [barrio()]);
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("el presupuesto del mes", () => {
  it("sin presupuesto, muestra los rubros con lo gastado el mes anterior, y «Copiar» trae lo gastado", async () => {
    const vacio = await como(adminB(), (tx) => presupuestoDelMes(tx, { periodoId: noviembre }));
    expect(vacio).toMatchObject({ periodo: "2026-11", mesAnterior: "2026-10", editable: true, enPreparacion: true, sePuedeCopiar: true });
    expect(vacio.rubros).toEqual([
      { conceptoId: mantenimiento, nombre: "Mantenimiento", gastadoMesAnterior: "700.00", presupuesto: null },
      { conceptoId: vigilancia, nombre: "Vigilancia", gastadoMesAnterior: "1000.00", presupuesto: null },
    ]);
    expect(vacio).toMatchObject({ gastoMesAnterior: "1700.00", gastoEsperado: "0.00", margen: "0.00", totalAPedir: "0.00", importe: null });

    // Octubre no tuvo presupuesto: se copia lo gastado por rubro, sin margen.
    expect(await como(adminB(), (tx) => copiarPresupuestoDelMesAnterior(tx, { periodoId: noviembre }))).toEqual({ rubros: 2 });
    const copiado = await como(adminB(), (tx) => presupuestoDelMes(tx, { periodoId: noviembre }));
    expect(copiado.rubros.map((r) => [r.nombre, r.presupuesto])).toEqual([["Mantenimiento", "700.00"], ["Vigilancia", "1000.00"]]);
    expect(copiado).toMatchObject({ gastoEsperado: "1700.00", totalAPedir: "1700.00", sePuedeCopiar: false });
    // Sobre un presupuesto cargado, copiar no pisa nada.
    expect((await capturar(() => como(adminB(), (tx) => copiarPresupuestoDelMesAnterior(tx, { periodoId: noviembre })))).message).toBe(
      "Este mes ya tiene presupuesto cargado.",
    );
  });

  it("se guarda exactamente como viene, y el total a pedir es el gasto esperado más el margen", async () => {
    await como(adminB(), (tx) =>
      guardarPresupuesto(tx, {
        periodoId: noviembre,
        rubros: [{ conceptoId: vigilancia, monto: "1200.00" }, { conceptoId: mantenimiento, monto: "450.00" }],
        margen: "150.00",
      }),
    );
    const p = await como(adminB(), (tx) => presupuestoDelMes(tx, { periodoId: noviembre }));
    expect(p.rubros.map((r) => [r.nombre, r.gastadoMesAnterior, r.presupuesto])).toEqual([
      ["Mantenimiento", "700.00", "450.00"],
      ["Vigilancia", "1000.00", "1200.00"],
    ]);
    expect(p).toMatchObject({ gastoEsperado: "1650.00", margen: "150.00", totalAPedir: "1800.00" });
    expect(p.paraAgregar).toEqual([]);

    // Sacar un rubro y volver a ponerlo: queda lo último que se guardó, una fila por rubro.
    await como(adminB(), (tx) => guardarPresupuesto(tx, { periodoId: noviembre, rubros: [{ conceptoId: vigilancia, monto: "1200.00" }], margen: "150.00" }));
    expect((await como(adminB(), (tx) => presupuestoDelMes(tx, { periodoId: noviembre }))).paraAgregar.map((c) => c.nombre)).toEqual(["Mantenimiento"]);
    await como(adminB(), (tx) =>
      guardarPresupuesto(tx, {
        periodoId: noviembre,
        rubros: [{ conceptoId: vigilancia, monto: "1200.00" }, { conceptoId: mantenimiento, monto: "450.00" }],
        margen: "150.00",
      }),
    );
    const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from presupuesto_rubro where periodo_id = $1", [noviembre]);
    expect(rows[0]!.n).toBe(2);
  });

  it("el panel del importe: por unidad, por total del mes, y nada en un barrio cuyo importe son los gastos", async () => {
    // Por gastos (lo de siempre): sin panel.
    expect((await como(adminB(), (tx) => presupuestoDelMes(tx, { periodoId: noviembre }))).importe).toBeNull();

    await cargarParametro(admin, barrio(), "devengado.origen", "administracion");
    await cargarParametro(admin, barrio(), "devengado.reparto", "igual");
    try {
      // $ 1.800 entre 3 unidades: $ 600,00 cada una.
      expect((await como(adminB(), (tx) => presupuestoDelMes(tx, { periodoId: noviembre }))).importe).toEqual({
        modo: "por_unidad", unidades: 3, vigente: null, mesAnterior: null, queCubre: "600.00",
      });
      await como(adminB(), (tx) => definirCuotaFija(tx, { barrioId: barrio(), rigeDesde: "2026-11", forma: "importe", importe: "650.00", descripcion: "Acta de prueba" }));
      expect((await como(adminB(), (tx) => presupuestoDelMes(tx, { periodoId: noviembre }))).importe).toMatchObject({ vigente: "650.00", mesAnterior: null });

      await cargarParametro(admin, barrio(), "devengado.reparto", "coeficiente");
      expect((await como(adminB(), (tx) => presupuestoDelMes(tx, { periodoId: noviembre }))).importe).toMatchObject({
        modo: "total_del_mes", queCubre: "1800.00", vigente: null,
      });
    } finally {
      await sinTriggers(async (c) => {
        await c.query("delete from cuota_fija where barrio_id = $1", [barrio()]);
        await c.query("delete from cuota_fija_version where barrio_id = $1", [barrio()]);
        await c.query("delete from parametro_valor where nodo_id = $1 and clave like 'devengado.%'", [barrio()]);
      });
    }
    expect((await como(adminB(), (tx) => presupuestoDelMes(tx, { periodoId: noviembre }))).importe).toBeNull();
  });

  it("lo carga solo la administración, y nadie de otro estudio lo ve", async () => {
    const operador = arbol.usuarios.operadorA1;
    expect((await como(operador, (tx) => presupuestoDelMes(tx, { periodoId: noviembre }))).editable).toBe(false);
    expect((await capturar(() => como(operador, (tx) => guardarPresupuesto(tx, { periodoId: noviembre, rubros: [], margen: "0.00" })))).codigo).toBe("sin_permiso");
    await expect(
      como(operador, (tx) =>
        tx.execute(sql`insert into presupuesto_rubro (barrio_id, periodo_id, concepto_id, monto, cargado_por) values (${barrio()}, ${noviembre}, ${vigilancia}, 1, ${operador}::uuid)`),
      ),
    ).rejects.toThrow(/row-level security|duplicate key/);
    const ajeno = arbol.usuarios.adminEstudioB;
    expect((await capturar(() => como(ajeno, (tx) => presupuestoDelMes(tx, { periodoId: noviembre })))).codigo).toBe("periodo_no_encontrado");
    const { rows } = await como(ajeno, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from presupuesto_rubro where barrio_id = ${barrio()}`));
    expect(rows[0]!.n).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("los gastos contra el presupuesto", () => {
  it("por rubro, al centavo, con el ajuste negativo restando, y el aviso del rubro que se pasó", async () => {
    const g = await como(adminB(), (tx) => gastosContraPresupuesto(tx, { periodoId: noviembre }));
    expect(g).toEqual({
      hayPresupuesto: true,
      rubros: [
        // $ 700 a mano − $ 200 del ajuste = $ 500 contra $ 450: se pasó $ 50 (111 %).
        { conceptoId: mantenimiento, nombre: "Mantenimiento", presupuesto: "450.00", gastado: "500.00", diferencia: "-50.00", avance: 111, excedido: true },
        // $ 1.100 contra $ 1.200: 92 % (91,67 redondeado).
        { conceptoId: vigilancia, nombre: "Vigilancia", presupuesto: "1200.00", gastado: "1100.00", diferencia: "100.00", avance: 92, excedido: false },
      ],
      totalPresupuesto: "1650.00",
      totalGastado: "1600.00",
      totalDiferencia: "50.00",
    });
    const avisos = await como(adminB(), (tx) => avisosDelMes(tx, { periodoId: noviembre }));
    const delPresupuesto = avisos.filter((a) => /del presupuesto/.test(a.titulo));
    expect(delPresupuesto).toHaveLength(1);
    expect(delPresupuesto[0]).toMatchObject({ tipo: "avisa", titulo: "Mantenimiento se pasó $ 50,00 del presupuesto", donde: "gastos" });
    // El último gasto positivo del rubro (el ajuste negativo no explica un exceso).
    expect(delPresupuesto[0]!.detalle).toMatch(/^El último gasto: «Reparación de la bomba», \$ 700,00, cargado el \d{2}\/\d{2}\/\d{4}\.$/);
  });

  it("un mes emitido conserva el presupuesto y el aviso, y el presupuesto ya no se cambia", async () => {
    await emitir(noviembre);
    const avisos = await como(adminB(), (tx) => avisosDelMes(tx, { periodoId: noviembre }));
    expect(avisos.map((a) => a.titulo)).toContain("Mantenimiento se pasó $ 50,00 del presupuesto");
    expect((await como(adminB(), (tx) => presupuestoDelMes(tx, { periodoId: noviembre }))).editable).toBe(false);
    expect(
      (await capturar(() => como(adminB(), (tx) => guardarPresupuesto(tx, { periodoId: noviembre, rubros: [], margen: "0.00" })))).codigo,
    ).toBe("periodo_no_editable");
    // Ni yendo directo a la tabla.
    await expect(
      como(adminB(), (tx) => tx.execute(sql`update presupuesto_rubro set monto = 1 where periodo_id = ${noviembre}`)),
    ).rejects.toThrow(/el mes ya se emitió/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("el resultado del mes", () => {
  it("octubre: en los papeles, en la cuenta y lo que falta cobrar, al centavo", async () => {
    const r = await como(adminB(), (tx) => resultadoDelMes(tx, { periodoId: octubre }));
    expect(r).toEqual({
      periodo: "2026-10",
      // $ 850 + $ 510 + $ 340 contra $ 1.000 + $ 500 + $ 200.
      enLosPapeles: { devengado: "1700.00", gastado: "1700.00", diferencia: "0.00" },
      // $ 850 (15/10) + $ 200 (20/10); el de $ 999 anulado no cuenta y el de $ 100 es de noviembre.
      // Pagado: la orden 1, el 20/10. La orden 2 se anuló sin pagarse.
      enLaCuenta: { cobrado: "1050.00", pagado: "500.00", diferencia: "550.00" },
      // La 2 debe $ 310 y la 3, $ 240 (pagó $ 100 en noviembre, imputados a octubre).
      faltaCobrar: { monto: "550.00", unidades: 2 },
    });
  });

  it("noviembre: lo devengado no incluye la deuda que arrastra cada boleta", async () => {
    const r = await como(adminB(), (tx) => resultadoDelMes(tx, { periodoId: noviembre }));
    // Gastado: $ 1.100 + $ 700 − $ 200. Las boletas suman $ 2.150 porque arrastran los $ 550 de octubre;
    // lo devengado del mes es lo de noviembre, $ 1.600.
    const { rows } = await admin.query<{ total: string }>("select sum(total)::text as total from liquidacion where periodo_id = $1", [noviembre]);
    expect(rows[0]!.total).toBe("2150.00");
    expect(r).toEqual({
      periodo: "2026-11",
      enLosPapeles: { devengado: "1600.00", gastado: "1600.00", diferencia: "0.00" },
      enLaCuenta: { cobrado: "100.00", pagado: "0.00", diferencia: "100.00" },
      faltaCobrar: { monto: "1600.00", unidades: 3 },
    });
  });

  it("es de un mes emitido, y lo ve quien lee el barrio", async () => {
    const borrador = await crearPeriodo("2026-12", "2026-12-10");
    expect((await capturar(() => como(adminB(), (tx) => resultadoDelMes(tx, { periodoId: borrador })))).codigo).toBe("periodo_no_editable");
    expect((await como(arbol.usuarios.contadorA1, (tx) => resultadoDelMes(tx, { periodoId: octubre }))).enLosPapeles.devengado).toBe("1700.00");
    expect((await capturar(() => como(arbol.usuarios.adminEstudioB, (tx) => resultadoDelMes(tx, { periodoId: octubre })))).codigo).toBe(
      "periodo_no_encontrado",
    );
  });
});
