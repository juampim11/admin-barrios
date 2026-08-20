/**
 * `listarPagosDeUnidad()` (`pagos.ts`), `prepararDescargaDeComprobante()` y
 * `prepararSubidaDeComprobante()` (`documentos.ts`) — el panel "Pagos registrados" del estado de
 * cuenta, la descarga del comprobante que sube el operador, y el pedido de la URL para subirlo.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/comprobantes.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { sql } from "drizzle-orm";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { registrarPago } from "../src/servicios/pagos.ts";
import { listarPagosDeUnidad } from "../src/servicios/pagos.ts";
import { prepararDescargaDeComprobante, prepararSubidaDeComprobante } from "../src/servicios/documentos.ts";
import { borrarArbol, crearArbol, crearBarrio, crearUnidades, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let unidadA1: string;
let unidadB1: string;

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>): Promise<T> => conUsuario(db, usuario, fn);

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

function comprobanteValido(barrioId: string): string {
  return `barrios/${barrioId}/pagos/comprobantes/AbCdEfGhIjKlMnOpQrStUv.pdf`;
}

/** Un pago de `origen = 'extracto'`, sin comprobante — el caso que hoy solo puede sembrar un fixture:
 * no hay servicio de ingesta de extracto todavía (queda fuera de esta tanda, doc §4.7). */
async function crearPagoDeExtracto(unidadId: string, barrioId: string, monto: string): Promise<string> {
  await admin.query("set session_replication_role = replica");
  try {
    const { rows } = await admin.query<{ id: string }>(
      `insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen)
       values ($1, $2, $3, current_date, 'extracto') returning id`,
      [barrioId, unidadId, monto],
    );
    return rows[0]?.id as string;
  } finally {
    await admin.query("set session_replication_role = origin");
  }
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioB1.id);
  const unidades = await crearUnidades(admin, arbol.barrioA1.id, 1);
  unidadA1 = unidades[0] as string;
  const unidadesB = await crearUnidades(admin, arbol.barrioB1.id, 1);
  unidadB1 = unidadesB[0] as string;
});

afterEach(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from descarga_documento where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("delete from subida_comprobante_solicitada where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("delete from pago where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("set session_replication_role = origin");
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from unidad_funcional where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("delete from barrio where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("listarPagosDeUnidad()", () => {
  it("lista los pagos vivos de la unidad, con tieneComprobante según el origen", async () => {
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarPago(tx, {
        unidadFuncionalId: unidadA1,
        obligadoId: null,
        monto: "1000.00",
        fecha: "2052-01-10",
        origen: "manual",
        comprobanteAdjunto: comprobanteValido(arbol.barrioA1.id),
      }),
    );
    await crearPagoDeExtracto(unidadA1, arbol.barrioA1.id, "2000.00");

    const pagos = await como(arbol.usuarios.operadorA1, (tx) => listarPagosDeUnidad(tx, { unidadFuncionalId: unidadA1 }));

    expect(pagos).toHaveLength(2);
    const manual = pagos.find((p) => p.origen === "manual");
    const extracto = pagos.find((p) => p.origen === "extracto");
    expect(manual?.tieneComprobante).toBe(true);
    expect(extracto?.tieneComprobante).toBe(false);
  });

  it("un usuario de otro barrio no ve los pagos de esta unidad", async () => {
    await como(arbol.usuarios.operadorA1, (tx) =>
      registrarPago(tx, {
        unidadFuncionalId: unidadA1,
        obligadoId: null,
        monto: "500.00",
        fecha: "2052-01-10",
        origen: "manual",
        comprobanteAdjunto: comprobanteValido(arbol.barrioA1.id),
      }),
    );

    const pagos = await como(arbol.usuarios.adminEstudioB, (tx) => listarPagosDeUnidad(tx, { unidadFuncionalId: unidadA1 }));
    expect(pagos).toEqual([]);
  });
});

describe("prepararDescargaDeComprobante()", () => {
  it("descarga el comprobante de un pago manual", async () => {
    const pago = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarPago(tx, {
        unidadFuncionalId: unidadA1,
        obligadoId: null,
        monto: "800.00",
        fecha: "2052-02-01",
        origen: "manual",
        comprobanteAdjunto: comprobanteValido(arbol.barrioA1.id),
      }),
    );

    const descarga = await como(arbol.usuarios.operadorA1, (tx) =>
      prepararDescargaDeComprobante(tx, { pagoId: pago.id, ttlSegundos: 90 }),
    );
    expect(descarga.storageKey).toBe(comprobanteValido(arbol.barrioA1.id));
    expect(descarga.nombreArchivo).toBe("Comprobante-2052-02-01.pdf");

    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from descarga_documento where pago_id = $1",
      [pago.id],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("rechaza con `comprobante_no_adjunto` un pago de extracto, sin filtrar que el pago existe de otra forma", async () => {
    const pagoId = await crearPagoDeExtracto(unidadA1, arbol.barrioA1.id, "300.00");

    const err = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) => prepararDescargaDeComprobante(tx, { pagoId, ttlSegundos: 90 })),
    );
    expect(err.codigo).toBe("comprobante_no_adjunto");
  });

  it("un id inexistente da 'pago_no_encontrado', no un 500 por un uuid mal formado", async () => {
    const err = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        prepararDescargaDeComprobante(tx, { pagoId: "00000000-0000-0000-0000-000000000000", ttlSegundos: 90 }),
      ),
    );
    expect(err.codigo).toBe("pago_no_encontrado");

    // El aislamiento entre barrios de `pago` (que un id de OTRO barrio da el mismo código que uno
    // inexistente) ya está cubierto exhaustivamente en `pagos-rls.test.ts` — `prepararDescarga*`
    // reusa la misma tabla bajo la misma RLS, así que no se duplica la matriz acá.
  });
});

describe("prepararSubidaDeComprobante()", () => {
  it("arma la clave contra el patrón que exige `pago`, y registra el pedido ANTES de devolverla", async () => {
    const preparada = await como(arbol.usuarios.operadorA1, (tx) =>
      prepararSubidaDeComprobante(tx, { unidadFuncionalId: unidadA1, contentType: "application/pdf" }),
    );

    expect(preparada.storageKey).toMatch(
      new RegExp(`^barrios/${arbol.barrioA1.id}/pagos/comprobantes/[A-Za-z0-9_-]{22,64}\\.pdf$`),
    );

    const { rows } = await admin.query<{ n: string; content_type: string; unidad_funcional_id: string }>(
      "select count(*)::text as n, min(content_type) as content_type, min(unidad_funcional_id::text) as unidad_funcional_id" +
        " from subida_comprobante_solicitada where storage_key = $1",
      [preparada.storageKey],
    );
    expect(rows[0]?.n).toBe("1");
    expect(rows[0]?.content_type).toBe("application/pdf");
    expect(rows[0]?.unidad_funcional_id).toBe(unidadA1);
  });

  it("una imagen jpeg arma la clave con extensión .jpg, no .pdf", async () => {
    const preparada = await como(arbol.usuarios.operadorA1, (tx) =>
      prepararSubidaDeComprobante(tx, { unidadFuncionalId: unidadA1, contentType: "image/jpeg" }),
    );
    expect(preparada.storageKey).toMatch(/\.jpg$/);
  });

  it("un uuid inexistente da `unidad_no_encontrada`, no un 500", async () => {
    const err = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        prepararSubidaDeComprobante(tx, {
          unidadFuncionalId: "00000000-0000-0000-0000-000000000000",
          contentType: "application/pdf",
        }),
      ),
    );
    expect(err.codigo).toBe("unidad_no_encontrada");
  });

  it("una unidad de OTRO barrio da el mismo `unidad_no_encontrada`, sin filtrar que existe", async () => {
    const err = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        prepararSubidaDeComprobante(tx, { unidadFuncionalId: unidadB1, contentType: "application/pdf" }),
      ),
    );
    expect(err.codigo).toBe("unidad_no_encontrada");
  });

  it("un contador (solo lectura) no puede pedir una subida", async () => {
    const err = await capturar(() =>
      como(arbol.usuarios.contadorA1, (tx) =>
        prepararSubidaDeComprobante(tx, { unidadFuncionalId: unidadA1, contentType: "application/pdf" }),
      ),
    );
    expect(err.codigo).toBe("sin_permiso");
  });
});

describe("RLS de `subida_comprobante_solicitada`", () => {
  it("un admin del propio barrio ve la fila que dejó el pedido de subida", async () => {
    const preparada = await como(arbol.usuarios.operadorA1, (tx) =>
      prepararSubidaDeComprobante(tx, { unidadFuncionalId: unidadA1, contentType: "application/pdf" }),
    );

    const res = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      tx.execute<{ n: string }>(
        sql`select count(*)::text as n from subida_comprobante_solicitada where storage_key = ${preparada.storageKey}`,
      ),
    );
    expect(res.rows[0]?.n).toBe("1");
  });

  it("un usuario de OTRO barrio no ve la fila, aunque conozca la storage key exacta", async () => {
    const preparada = await como(arbol.usuarios.operadorA1, (tx) =>
      prepararSubidaDeComprobante(tx, { unidadFuncionalId: unidadA1, contentType: "application/pdf" }),
    );

    const res = await como(arbol.usuarios.adminEstudioB, (tx) =>
      tx.execute<{ n: string }>(
        sql`select count(*)::text as n from subida_comprobante_solicitada where storage_key = ${preparada.storageKey}`,
      ),
    );
    expect(res.rows[0]?.n).toBe("0");
  });
});
