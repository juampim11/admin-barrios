/**
 * Encargo 8, T0 — los arreglos de plata de la liquidación, contra Postgres real.
 *
 *  - P2: anular una OP después de emitir su mes deja un ajuste negativo en el borrador siguiente; la
 *    generación lo compensa con los gastos del mismo concepto y el mes se emite. Si el concepto queda
 *    en negativo, la generación se frena nombrando la OP, el proveedor y el concepto.
 *  - P3: un gasto que vino de una OP no se borra (servicio y base) y la lista dice de qué orden vino.
 *  - P4: anular una OP cuyo mes de origen está en `revisada` lo trata como editable (borra el gasto).
 *  - Piso de cero: una unidad con un descuento mayor que su expensa no deja emitir.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/plata-liquidacion.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, type DbConIdentidad, type DbRequest } from "../src/client.ts";
import { crearPeriodo, leerPeriodo } from "../src/servicios/periodos.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { borrarGasto, registrarGasto } from "../src/servicios/gastos.ts";
import { registrarProveedor } from "../src/servicios/proveedores.ts";
import { anularOrdenPago, aprobarOrdenPago, registrarOrdenPago } from "../src/servicios/ordenes-pago.ts";
import { crearConceptoBoleta } from "../src/servicios/conceptos-boleta.ts";
import { aplicarConceptoAUnidad } from "../src/servicios/cargos.ts";
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
let barrioId: string;
let unidades: string[];
let proveedorId: string;
let mantenimiento: string;
let seguridad: string;

const como = <T>(usuario: string, fn: (tx: DbConIdentidad) => Promise<T>): Promise<T> => conUsuario(db, usuario, fn);

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

async function periodo(mes: string, modelo: "variable" | "fija" = "variable"): Promise<string> {
  const { id } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
    crearPeriodo(tx, {
      barrioId, periodo: mes, modelo,
      primerVencimiento: `${mes}-10`, segundoVencimiento: null, notas: null,
    }),
  );
  return id;
}

async function gasto(periodoId: string, conceptoId: string, descripcion: string, monto: string): Promise<string> {
  const g = await como(arbol.usuarios.operadorA1, (tx) =>
    registrarGasto(tx, {
      periodoId, conceptoId, descripcion, monto,
      proveedorNombre: null, comprobante: null, actaDocumentoId: null,
    }),
  );
  return g.id;
}

/** Una OP cargada por el operador y aprobada por la administradora: su gasto entra al período. */
async function opAprobada(periodoId: string, monto: string, numeroFactura: string | null, conceptoId = mantenimiento): Promise<string> {
  const op = await como(arbol.usuarios.operadorA1, (tx) =>
    registrarOrdenPago(tx, {
      proveedorId, periodoId, conceptoId, numeroFactura,
      descripcion: "Corte de pasto", monto,
    }),
  );
  await como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: op.id }));
  return op.id;
}

const generar = (periodoId: string) => como(arbol.usuarios.operadorA1, (tx) => generarLiquidaciones(tx, { periodoId }));
const emitir = (periodoId: string) => como(arbol.usuarios.adminBarrioA1, (tx) => emitirPeriodo(tx, { periodoId }));
const anular = (ordenPagoId: string) =>
  como(arbol.usuarios.adminBarrioA1, (tx) => anularOrdenPago(tx, { ordenPagoId, motivo: "La factura estaba duplicada" }));

async function estado(periodoId: string): Promise<string> {
  const { rows } = await admin.query<{ estado: string }>("select estado::text as estado from periodo_expensa where id = $1", [periodoId]);
  return rows[0]!.estado;
}

/** Deja el barrio sin períodos, gastos, órdenes ni aplicaciones (cada caso arranca de cero). */
async function limpiar(): Promise<void> {
  await admin.query("set session_replication_role = replica");
  for (const consulta of [
    `delete from item_liquidacion i using liquidacion l where l.id = i.liquidacion_id and l.barrio_id = $1`,
    `delete from liquidacion where barrio_id = $1`,
    `delete from concepto_boleta_unidad_evento where barrio_id = $1`,
    `delete from concepto_boleta_unidad where barrio_id = $1`,
    `delete from gasto_periodo where barrio_id = $1 and gasto_periodo_origen_id is not null`,
    `delete from gasto_periodo where barrio_id = $1`,
    `delete from orden_pago where barrio_id = $1`,
    `delete from periodo_expensa where barrio_id = $1`,
  ]) {
    await admin.query(consulta, [barrioId]);
  }
  await admin.query("set session_replication_role = origin");
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  barrioId = arbol.barrioA1.id;
  await crearBarrio(admin, barrioId);
  unidades = await crearUnidades(admin, barrioId, 4);
  const version = await crearCoeficientes(admin, barrioId, unidades);
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [version]);

  const concepto = async (nombre: string) =>
    (
      await admin.query<{ id: string }>(
        `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1,$2,'ordinaria','sin_clasificar') returning id`,
        [barrioId, nombre],
      )
    ).rows[0]!.id;
  mantenimiento = await concepto("Mantenimiento de espacios verdes");
  seguridad = await concepto("Seguridad");

  // Una cuota fija para los meses `fija` de este archivo (a los `variable` no les cambia nada).
  const { rows: cv } = await admin.query<{ id: string }>(
    "insert into cuota_fija_version (barrio_id, descripcion, vigente_desde) values ($1, 'Cuota', '2048-01-01') returning id",
    [barrioId],
  );
  for (const u of unidades) {
    await admin.query("insert into cuota_fija (barrio_id, version_id, unidad_funcional_id, importe) values ($1,$2,$3,'25000.00')", [barrioId, cv[0]!.id, u]);
  }

  const p = await como(arbol.usuarios.operadorA1, (tx) =>
    registrarProveedor(tx, {
      barrioId, razonSocial: "Jardines del Sur SRL", cuit: null, condicionFiscal: null,
      contacto: null, cbu: null, alias: null,
    }),
  );
  proveedorId = p.id;
});

beforeEach(limpiar);

afterAll(async () => {
  await limpiar();
  await admin.query("set session_replication_role = replica");
  for (const tabla of [
    "concepto_boleta_valor", "concepto_boleta", "cuota_fija", "cuota_fija_version", "proveedor", "concepto", "coeficiente", "coeficiente_version",
    "unidad_funcional", "barrio_atributo_vigencia", "barrio",
  ]) {
    await admin.query(`delete from ${tabla} where barrio_id = $1`, [barrioId]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// P2 — la OP anulada después de emitir
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("P2: anular una OP después de emitir su mes", () => {
  it("el mes siguiente se genera y se emite con el ajuste descontado del mismo concepto", async () => {
    const enero = await periodo("2048-01");
    const op = await opAprobada(enero, "30000.00", "0001-00001234");
    await generar(enero);
    await emitir(enero);

    const febrero = await periodo("2048-02");
    await gasto(febrero, mantenimiento, "Corte de pasto de febrero", "100000.00");
    await gasto(febrero, seguridad, "Vigilancia", "50000.00");
    await anular(op);

    // El ajuste quedó en febrero, con un texto legible y sin el uuid de la orden.
    const { rows: ajuste } = await admin.query<{ descripcion: string; monto: string }>(
      "select descripcion, monto::text from gasto_periodo where periodo_id = $1 and gasto_periodo_origen_id is not null",
      [febrero],
    );
    expect(ajuste).toEqual([
      { descripcion: "Anulación de la OP de Jardines del Sur SRL, factura 0001-00001234", monto: "-30000.00" },
    ]);

    const resumen = await generar(febrero);
    // Lo repartido es el neto: 100.000 − 30.000 de mantenimiento, más 50.000 de seguridad.
    expect(resumen.totalRepartido).toBe("120000.00");
    expect(resumen.totalGastos).toBe("120000.00");

    // La línea del concepto compensado explica de dónde sale la diferencia.
    const { rows: lineas } = await admin.query<{ descripcion: string; base: string }>(
      `select distinct i.descripcion, i.base_monto::text as base
         from item_liquidacion i join liquidacion l on l.id = i.liquidacion_id
        where l.periodo_id = $1 order by 1`,
      [febrero],
    );
    expect(lineas).toEqual([
      {
        descripcion:
          "Corte de pasto de febrero (se descontaron $ 30.000,00 por la anulación de la OP de Jardines del Sur SRL, factura 0001-00001234)",
        base: "70000.00",
      },
      { descripcion: "Vigilancia", base: "50000.00" },
    ]);

    await emitir(febrero);
    expect(await estado(febrero)).toBe("emitida");
  });

  it("si el concepto queda en negativo, no se genera, y el mensaje nombra la OP, el proveedor y el concepto", async () => {
    const enero = await periodo("2048-03");
    const op = await opAprobada(enero, "50000.00", null);
    await generar(enero);
    await emitir(enero);

    const febrero = await periodo("2048-04");
    await gasto(febrero, mantenimiento, "Riego", "10000.00");
    await gasto(febrero, seguridad, "Vigilancia", "80000.00");
    await anular(op);

    const err = await capturar(() => generar(febrero));
    expect(err.codigo).toBe("ajuste_supera_concepto");
    expect(err.message).toContain("Anulación de la OP de Jardines del Sur SRL, sin número de factura");
    expect(err.message).toContain("«Mantenimiento de espacios verdes»");
    expect(err.datos["ordenPagoId"]).toBe(op);

    // Nunca se prorrateó un negativo: no quedó ninguna liquidación.
    const { rows } = await admin.query<{ n: string }>("select count(*)::text as n from liquidacion where periodo_id = $1", [febrero]);
    expect(rows[0]!.n).toBe("0");
  });
});

describe("P2: más de un ajuste, y el modelo de cuota fija", () => {
  it("dos órdenes anuladas del mismo concepto se descuentan las dos, y la línea que queda en cero no se reparte", async () => {
    const enero = await periodo("2048-11");
    const op1 = await opAprobada(enero, "20000.00", "C-1");
    const op2 = await opAprobada(enero, "10000.00", "C-2");
    await generar(enero);
    await emitir(enero);

    const febrero = await periodo("2048-12");
    await gasto(febrero, mantenimiento, "Riego", "20000.00");
    await gasto(febrero, mantenimiento, "Poda", "15000.00");
    await anular(op1);
    await anular(op2);

    const resumen = await generar(febrero);
    expect(resumen.totalRepartido).toBe("5000.00");
    const { rows } = await admin.query<{ base: string }>(
      `select distinct i.base_monto::text as base from item_liquidacion i join liquidacion l on l.id = i.liquidacion_id where l.periodo_id = $1`,
      [febrero],
    );
    expect(rows).toEqual([{ base: "5000.00" }]);
    await emitir(febrero);
    expect(await estado(febrero)).toBe("emitida");
  });

  it("en cuota fija, el ajuste de una orden ORDINARIA no frena el mes aunque no haya ordinarias cargadas", async () => {
    const enero = await periodo("2049-01", "fija");
    const op = await opAprobada(enero, "30000.00", "D-1");
    await generar(enero);
    await emitir(enero);

    const febrero = await periodo("2049-02", "fija");
    await anular(op);
    const resumen = await generar(febrero);
    expect(resumen.totalCuotasFijas).toBe("100000.00");
    await emitir(febrero);
    expect(await estado(febrero)).toBe("emitida");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// P3 — el gasto de una OP no se borra desde la lista de gastos
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("P3: un gasto que vino de una OP", () => {
  it("el servicio no lo borra, y la lista dice de qué orden vino", async () => {
    const mes = await periodo("2048-05");
    const op = await opAprobada(mes, "12000.00", "A-1");
    const detalle = await como(arbol.usuarios.adminBarrioA1, (tx) => leerPeriodo(tx, { periodoId: mes }));
    const delaOp = detalle!.gastos.find((g) => g.ordenPagoId === op);
    expect(delaOp?.proveedorNombre).toBe("Jardines del Sur SRL");

    const err = await capturar(() => como(arbol.usuarios.adminBarrioA1, (tx) => borrarGasto(tx, { gastoId: delaOp!.id })));
    expect(err.codigo).toBe("gasto_de_orden_pago");
    expect(err.message).toContain("Jardines del Sur SRL");
  });

  it("la base tampoco: ni un delete directo ni cambiarle el importe; la descripción sí", async () => {
    const mes = await periodo("2048-06");
    const op = await opAprobada(mes, "12000.00", "A-2");
    const { rows } = await admin.query<{ id: string }>("select id from gasto_periodo where orden_pago_id = $1", [op]);
    const gastoId = rows[0]!.id;

    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) => tx.execute(sql`delete from gasto_periodo where id = ${gastoId}`)),
    ).rejects.toThrow(/un gasto que vino de una orden de pago no se borra ni se modifica/);
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) => tx.execute(sql`update gasto_periodo set monto = 1 where id = ${gastoId}`)),
    ).rejects.toThrow(/un gasto que vino de una orden de pago no se borra ni se modifica/);
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) => tx.execute(sql`update gasto_periodo set orden_pago_id = null where id = ${gastoId}`)),
    ).rejects.toThrow(/un gasto que vino de una orden de pago no se borra ni se modifica/);

    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) => tx.execute(sql`update gasto_periodo set proveedor_nombre = 'Otro' where id = ${gastoId}`)),
    ).rejects.toThrow(/un gasto que vino de una orden de pago no se borra ni se modifica/);
    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      tx.execute(sql`update gasto_periodo set descripcion = 'Corte de pasto, sector norte' where id = ${gastoId}`),
    );

    // Tampoco se fabrica un "ajuste" a mano: ni insertándolo, ni poniéndole la marca a un gasto manual.
    const manual = await gasto(mes, mantenimiento, "Riego", "500.00");
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`update gasto_periodo set orden_pago_id = ${op}, gasto_periodo_origen_id = ${gastoId}, monto = -500 where id = ${manual}`),
      ),
    ).rejects.toThrow(/un gasto que vino de una orden de pago no se borra ni se modifica/);
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto, orden_pago_id, gasto_periodo_origen_id)
                       values (${barrioId}, ${mes}, ${mantenimiento}, 'Ajuste falso', -500, ${op}, ${gastoId})`),
      ),
    ).rejects.toThrow(/un gasto que vino de una orden de pago no se borra ni se modifica/);

    // Y anular la orden con el mes en borrador lo sigue borrando: esa es la corrección prevista.
    await anular(op);
    const { rows: quedan } = await admin.query("select 1 from gasto_periodo where orden_pago_id = $1", [op]);
    expect(quedan).toHaveLength(0);
  });

  it("un gasto cargado a mano se sigue quitando", async () => {
    const mes = await periodo("2048-07");
    const id = await gasto(mes, seguridad, "Vigilancia", "1000.00");
    await como(arbol.usuarios.adminBarrioA1, (tx) => borrarGasto(tx, { gastoId: id }));
    const { rows } = await admin.query("select 1 from gasto_periodo where id = $1", [id]);
    expect(rows).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// P4 — el mes de origen en «revisada»
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("P4: anular una OP con el mes de origen en revisada", () => {
  it("se trata como editable: el gasto se borra del mismo mes y no se busca otro período", async () => {
    const mes = await periodo("2048-08");
    const op = await opAprobada(mes, "9000.00", "B-1");
    await generar(mes);
    await admin.query("update periodo_expensa set estado = 'revisada' where id = $1", [mes]);
    expect(await estado(mes)).toBe("revisada");

    await anular(op);

    const { rows } = await admin.query("select 1 from gasto_periodo where orden_pago_id = $1", [op]);
    expect(rows).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El piso de cero, contra la base
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("piso de cero", () => {
  /** Un descuento de monto fijo, aplicado por la administradora a una unidad del mes. */
  async function descuento(periodoId: string, unidadId: string, nombre: string, monto: string): Promise<void> {
    const { conceptoId } = await como(arbol.usuarios.adminEstudioA, (tx) =>
      crearConceptoBoleta(tx, {
        barrioId,
        nombre,
        clase: "descuento",
        metodo: "monto_fijo",
        baseCalculo: "sin_base",
        clasificacionFiscal: "no_alcanzado",
        financiamiento: "partida_presupuestada",
        requiereAdmin: false,
        ordenImpresion: 0,
        vigenteDesde: "2020-01-01",
        montoFijo: monto,
        porcentaje: null,
        precioUnitario: null,
        tope: null,
      }),
    );
    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId,
        unidadFuncionalId: unidadId,
        conceptoBoletaId: conceptoId,
        fechaHecho: null,
        cantidad: null,
        detalle: "Bonificación decidida por el directorio",
        origenEvaluacion: "carga_manual",
      }),
    );
  }

  it("un descuento mayor que la expensa de su unidad no deja generar, y dice por qué", async () => {
    const mes = await periodo("2048-09");
    // 40.000 entre cuatro unidades de igual coeficiente: cada una paga 10.000.
    await gasto(mes, seguridad, "Vigilancia", "40000.00");
    await descuento(mes, unidades[0]!, "Bonificación grande", "50000.00");

    const err = await capturar(() => generar(mes));
    expect(err.codigo).toBe("neto_negativo");
    expect(await estado(mes)).toBe("borrador");
  });

  it("dos descuentos que juntos superan la expensa no dejan emitir", async () => {
    const mes = await periodo("2048-10");
    await gasto(mes, seguridad, "Vigilancia", "40000.00");
    // Cada uno entra (7.000 ≤ 10.000); juntos dejan la boleta en −4.000.
    await descuento(mes, unidades[0]!, "Bonificación A", "7000.00");
    await descuento(mes, unidades[0]!, "Bonificación B", "7000.00");
    await generar(mes);

    const err = await capturar(() => emitir(mes));
    expect(err.codigo).toBe("neto_negativo");
    expect(await estado(mes)).toBe("borrador");
  });
});
