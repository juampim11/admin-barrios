/**
 * `orden_pago` — aislamiento entre barrios, y el gate de rol por transición: `operador` puede
 * cargar y ejecutar un pago ya aprobado, pero no aprobar ni rechazar (reservado a
 * `admin_barrio`/`admin_plataforma` — `administrador-consorcios`, panel 2026-08-21).
 *
 * Correr con: pnpm vitest run --project db packages/data/test/ordenes-pago-rls.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { registrarProveedor } from "../src/servicios/proveedores.ts";
import { aprobarOrdenPago, listarOrdenesPago, rechazarOrdenPago, registrarOrdenPago } from "../src/servicios/ordenes-pago.ts";
import { borrarArbol, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let proveedorA1: string;
let proveedorB1: string;
let conceptoA1: string;
let conceptoB1: string;

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>): Promise<T> => conUsuario(db, usuario, fn);

let contadorPeriodo = 0;
function proximoPeriodo(): string {
  contadorPeriodo += 1;
  const mes = String((contadorPeriodo % 12) + 1).padStart(2, "0");
  const anio = 2070 + Math.floor(contadorPeriodo / 12);
  return `${anio}-${mes}`;
}

async function crearPeriodo(barrioId: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo) values ($1,$2) returning id",
    [barrioId, proximoPeriodo()],
  );
  return rows[0]?.id as string;
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioB1.id);

  const datosProveedor = { cuit: null, condicionFiscal: null, contacto: null, cbu: null, alias: null } as const;
  proveedorA1 = (
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarProveedor(tx, { barrioId: arbol.barrioA1.id, razonSocial: "Proveedor A1", ...datosProveedor }),
    )
  ).id;
  proveedorB1 = (
    await como(arbol.usuarios.adminEstudioB, (tx) =>
      registrarProveedor(tx, { barrioId: arbol.barrioB1.id, razonSocial: "Proveedor B1", ...datosProveedor }),
    )
  ).id;

  const conceptoDe = async (barrioId: string, nombre: string) => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal)
       values ($1,$2,'ordinaria','sin_clasificar') returning id`,
      [barrioId, nombre],
    );
    return rows[0]?.id as string;
  };
  conceptoA1 = await conceptoDe(arbol.barrioA1.id, "Concepto A1");
  conceptoB1 = await conceptoDe(arbol.barrioB1.id, "Concepto B1");
});

afterEach(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from gasto_periodo where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("delete from orden_pago where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("delete from periodo_expensa where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("set session_replication_role = origin");
});

afterAll(async () => {
  await admin.query("delete from concepto where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("delete from proveedor where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("delete from barrio_atributo_vigencia where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("delete from barrio where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("aislamiento entre barrios", () => {
  it("un usuario de otro barrio no ve las órdenes de pago de este", async () => {
    const periodoId = await crearPeriodo(arbol.barrioA1.id);
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarOrdenPago(tx, { proveedorId: proveedorA1, periodoId, conceptoId: conceptoA1, numeroFactura: null, descripcion: "x", monto: "100.00" }),
    );

    const lista = await como(arbol.usuarios.adminEstudioB, (tx) => listarOrdenesPago(tx, { barrioId: arbol.barrioA1.id }));
    expect(lista).toEqual([]);
  });

  it("una orden de pago no puede cargarse contra un proveedor de otro barrio (FK compuesta anti-cruce)", async () => {
    const periodoId = await crearPeriodo(arbol.barrioA1.id);
    await expect(
      como(arbol.usuarios.operadorA1, (tx) =>
        registrarOrdenPago(tx, { proveedorId: proveedorB1, periodoId, conceptoId: conceptoA1, numeroFactura: null, descripcion: "x", monto: "100.00" }),
      ),
    ).rejects.toThrow();
  });

  it("una orden de pago no puede cargarse contra un concepto de otro barrio (FK compuesta anti-cruce)", async () => {
    const periodoId = await crearPeriodo(arbol.barrioA1.id);
    await expect(
      como(arbol.usuarios.operadorA1, (tx) =>
        registrarOrdenPago(tx, { proveedorId: proveedorA1, periodoId, conceptoId: conceptoB1, numeroFactura: null, descripcion: "x", monto: "100.00" }),
      ),
    ).rejects.toThrow();
  });
});

describe("gate de rol por transición", () => {
  it("operador puede cargar una orden de pago", async () => {
    const periodoId = await crearPeriodo(arbol.barrioA1.id);
    const op = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarOrdenPago(tx, { proveedorId: proveedorA1, periodoId, conceptoId: conceptoA1, numeroFactura: null, descripcion: "x", monto: "100.00" }),
    );
    expect(op.estado).toBe("pendiente");
  });

  it("operador NO puede aprobar una orden de pago", async () => {
    const periodoId = await crearPeriodo(arbol.barrioA1.id);
    const op = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarOrdenPago(tx, { proveedorId: proveedorA1, periodoId, conceptoId: conceptoA1, numeroFactura: null, descripcion: "x", monto: "100.00" }),
    );
    await expect(
      como(arbol.usuarios.operadorA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: op.id })),
    ).rejects.toThrow(/administrador del barrio/);
  });

  it("operador NO puede rechazar una orden de pago", async () => {
    const periodoId = await crearPeriodo(arbol.barrioA1.id);
    const op = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarOrdenPago(tx, { proveedorId: proveedorA1, periodoId, conceptoId: conceptoA1, numeroFactura: null, descripcion: "x", monto: "100.00" }),
    );
    await expect(
      como(arbol.usuarios.operadorA1, (tx) => rechazarOrdenPago(tx, { ordenPagoId: op.id })),
    ).rejects.toThrow(/administrador del barrio/);
  });

  it("contador (solo lectura) no puede cargar una orden de pago", async () => {
    const periodoId = await crearPeriodo(arbol.barrioA1.id);
    await expect(
      como(arbol.usuarios.contadorA1, (tx) =>
        registrarOrdenPago(tx, { proveedorId: proveedorA1, periodoId, conceptoId: conceptoA1, numeroFactura: null, descripcion: "x", monto: "100.00" }),
      ),
    ).rejects.toThrow();
  });
});
