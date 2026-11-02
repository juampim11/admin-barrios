/**
 * `pago` — aislamiento entre barrios, gate de rol de lectura, anulación pareada/congelada y el
 * `CHECK` de origen/registrador/comprobante.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/pagos-rls.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { nuevoToken } from "@admin-barrios/almacenamiento";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { anularPago, registrarPago } from "../src/servicios/pagos.ts";
import {
  borrarArbol,
  crearArbol,
  crearBarrio,
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
let unidadesA1: string[];
let unidadesB1: string[];

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

async function filasVisibles(userId: string): Promise<number> {
  return como(userId, async (tx) => {
    const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from pago`);
    return Number(res.rows[0]?.n ?? "-1");
  });
}

/**
 * Comprobante con storage key válida — la exige `pago_manual_exige_registrador_chk`. **Token nuevo
 * en cada llamada, nunca un literal fijo**: este archivo no tiene `afterEach` (los `pago` se
 * acumulan hasta el `afterAll`), así que dos tests que registraran la misma key chocarían contra
 * `uq_pago_comprobante_adjunto` (`0041`) — un comprobante acredita UN SOLO pago, mismo criterio que
 * en la base real, donde cada subida es un objeto distinto.
 */
function comprobanteValido(barrioId: string): string {
  return `barrios/${barrioId}/pagos/comprobantes/${nuevoToken()}.pdf`;
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioB1.id);
  unidadesA1 = await crearUnidades(admin, arbol.barrioA1.id, 3);
  unidadesB1 = await crearUnidades(admin, arbol.barrioB1.id, 2);
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from pago where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  // `unidad_funcional`/`barrio` de A1 y B1: faltaban acá, y son la causa real del `FAIL` en el
  // teardown (`barrio_barrio_id_tenant_node_id_fk`) — ninguna de las dos filas se borraba antes de
  // que `borrarArbol` intentara tirar abajo el `tenant_node` de cada barrio.
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

describe("aislamiento entre barrios", () => {
  it("un pago de A1 no lo ve un usuario de otro barrio", async () => {
    const pago = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarPago(tx, {
        unidadFuncionalId: unidadesA1[0] as string,
        obligadoId: null,
        monto: "15000.00",
        fecha: "2050-01-10",
        origen: "manual",
        comprobanteAdjunto: comprobanteValido(arbol.barrioA1.id),
      }),
    );
    expect(pago.id).toBeTruthy();

    // El barrio hermano (B1) no ve NI ESTE ni ningún pago de A1.
    const visiblesEnB1 = await como(arbol.usuarios.adminEstudioB, async (tx) => {
      const res = await tx.execute<{ n: string }>(sql`select count(*)::text as n from pago where id = ${pago.id}`);
      return Number(res.rows[0]?.n ?? "-1");
    });
    expect(visiblesEnB1).toBe(0);
  });

  it("un estudio ajeno no ve ninguna fila de `pago`", async () => {
    expect(await filasVisibles(arbol.usuarios.adminEstudioB)).toBe(0);
  });
});

describe("gate de rol de lectura (0018: readable_tenant_ids)", () => {
  it("contador y auditor ven los pagos del barrio", async () => {
    expect(await filasVisibles(arbol.usuarios.contadorA1)).toBeGreaterThan(0);
    expect(await filasVisibles(arbol.usuarios.auditorA1)).toBeGreaterThan(0);
  });

  it("propietario y residente no ven ni una fila", async () => {
    expect(await filasVisibles(arbol.usuarios.propietarioA1)).toBe(0);
    expect(await filasVisibles(arbol.usuarios.residenteA1)).toBe(0);
  });

  it("contador y auditor no pueden registrar un pago (solo lectura)", async () => {
    const err = await capturar(() =>
      como(arbol.usuarios.contadorA1, (tx) =>
        registrarPago(tx, {
          unidadFuncionalId: unidadesA1[1] as string,
          obligadoId: null,
          monto: "1000.00",
          fecha: "2050-01-10",
          origen: "manual",
          comprobanteAdjunto: comprobanteValido(arbol.barrioA1.id),
        }),
      ),
    );
    expect(err.codigo).toBe("sin_permiso");
  });
});

describe("anulación: motivo se congela, no se revierte", () => {
  it("anularPago() anula, y una segunda anulación rebota", async () => {
    const pago = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarPago(tx, {
        unidadFuncionalId: unidadesA1[2] as string,
        obligadoId: null,
        monto: "5000.00",
        fecha: "2050-01-10",
        origen: "manual",
        comprobanteAdjunto: comprobanteValido(arbol.barrioA1.id),
      }),
    );

    await como(arbol.usuarios.operadorA1, (tx) =>
      anularPago(tx, { pagoId: pago.id, motivo: "Se cargó por error de tipeo" }),
    );

    const err = await capturar(() =>
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        anularPago(tx, { pagoId: pago.id, motivo: "Segundo intento de anular" }),
      ),
    );
    expect(err.codigo).toBe("pago_ya_anulado");
  });

  it("el motivo archivado no se puede reescribir con un UPDATE directo (el candado vive en la base)", async () => {
    const pago = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarPago(tx, {
        unidadFuncionalId: unidadesA1[0] as string,
        obligadoId: null,
        monto: "800.00",
        fecha: "2050-01-11",
        origen: "manual",
        comprobanteAdjunto: comprobanteValido(arbol.barrioA1.id),
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) =>
      anularPago(tx, { pagoId: pago.id, motivo: "Motivo original de la anulación" }),
    );

    // Un `update` que NO pasa por `anularPago()` (que filtra `anulado_at is null`): el candado tiene
    // que estar en la base, no solo en el servicio.
    await expect(
      como(arbol.usuarios.operadorA1, (tx) =>
        tx.execute(sql`update pago set motivo_anulacion = 'motivo reescrito' where id = ${pago.id}`),
      ),
    ).rejects.toThrow(/el motivo de la anulación de un pago no se reescribe/);

    await expect(
      como(arbol.usuarios.operadorA1, (tx) =>
        tx.execute(sql`update pago set anulado_at = null, anulado_por = null, motivo_anulacion = null where id = ${pago.id}`),
      ),
    ).rejects.toThrow(/la anulación de un pago no se revierte/);
  });
});

describe("el CHECK pareado origen/registrador/comprobante", () => {
  it("un `manual` sin comprobante lo rechaza la base, no solo Zod", async () => {
    // Se saltea `registrarPago()` (que ya lo frena con Zod) para probar el candado de la base: un
    // `insert` crudo con `origen = 'manual'` y sin comprobante.
    await expect(
      como(arbol.usuarios.operadorA1, (tx) =>
        tx.execute(sql`
          insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen)
          select uf.barrio_id, uf.id, '100.00', current_date, 'manual'
            from unidad_funcional uf where uf.id = ${unidadesA1[0]}
        `),
      ),
    ).rejects.toThrow(/pago_manual_exige_registrador_chk/);
  });

  it("una storage key de comprobante que apunta a OTRO barrio la rechaza el CHECK", async () => {
    await expect(
      como(arbol.usuarios.operadorA1, (tx) =>
        tx.execute(sql`
          insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen, comprobante_adjunto)
          select uf.barrio_id, uf.id, '100.00', current_date, 'manual', ${comprobanteValido(arbol.barrioB1.id)}
            from unidad_funcional uf where uf.id = ${unidadesA1[0]}
        `),
      ),
    ).rejects.toThrow(/pago_comprobante_storage_key_chk/);
  });

  it("un `extracto` con `usuario_registrador` lo rechaza el CHECK (nadie lo pisa a NULL)", async () => {
    // El trigger solo pisa `usuario_registrador` a la identidad de sesión cuando `origen = 'manual'`;
    // para `extracto` lo deja tal como llegó. Un valor no-nulo ahí viola el pareo.
    await expect(
      como(arbol.usuarios.operadorA1, (tx) =>
        tx.execute(sql`
          insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen, usuario_registrador)
          select uf.barrio_id, uf.id, '100.00', current_date, 'extracto', app.current_user_id()
            from unidad_funcional uf where uf.id = ${unidadesA1[0]}
        `),
      ),
    ).rejects.toThrow(/pago_manual_exige_registrador_chk/);
  });
});

describe("`unidadFuncionalId` inaccesible no es un oráculo", () => {
  it("una unidad de otro barrio da el mismo mensaje que una inexistente", async () => {
    const err = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        registrarPago(tx, {
          unidadFuncionalId: unidadesB1[0] as string, // existe, pero es de B1
          obligadoId: null,
          monto: "100.00",
          fecha: "2050-01-10",
          origen: "manual",
          comprobanteAdjunto: comprobanteValido(arbol.barrioA1.id),
        }),
      ),
    );
    expect(err.codigo).toBe("unidad_no_encontrada");

    const errInexistente = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        registrarPago(tx, {
          unidadFuncionalId: "00000000-0000-0000-0000-000000000000",
          obligadoId: null,
          monto: "100.00",
          fecha: "2050-01-10",
          origen: "manual",
          comprobanteAdjunto: comprobanteValido(arbol.barrioA1.id),
        }),
      ),
    );
    expect(errInexistente.codigo).toBe("unidad_no_encontrada");
    expect(errInexistente.message).toBe(err.message);
  });
});
