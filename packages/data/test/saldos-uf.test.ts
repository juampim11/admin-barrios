/**
 * `listarSaldosUF()` — la grilla "todas las unidades del barrio, con su saldo": aislamiento entre
 * barrios, el flag `puedeRegistrarPago` por rol, y que el saldo que devuelve coincide con lo que
 * dejaron las imputaciones (no solo lectura de una tabla vacía).
 *
 * Correr con: pnpm vitest run --project db packages/data/test/saldos-uf.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { registrarPago } from "../src/servicios/pagos.ts";
import { imputarPago, listarSaldosUF } from "../src/servicios/cobros.ts";
import { borrarArbol, crearArbol, crearBarrio, crearUnidades, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let unidadesA1: string[];

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>): Promise<T> => conUsuario(db, usuario, fn);

/**
 * Un período EMITIDO con una liquidación de `total`, para la primera unidad de A1. Mismo patrón
 * (forzado con `session_replication_role = replica`) que `estado-cuenta.test.ts`.
 *
 * **`replica` suspende TODOS los triggers de usuario sobre `periodo_expensa`**, incluido
 * `trg_saldo_uf_por_emision` (`0037_estado_cuenta.sql`) — el que escribe el lado del DÉBITO en
 * `saldo_uf` cuando un período pasa a emitido. Como este archivo sí lee `saldo_uf` (a diferencia de
 * `estado-cuenta.test.ts`, que lee `app.v_estado_cuenta_uf` y no depende de esta tabla), hay que
 * reponer a mano lo que ese trigger hubiera escrito — calcado literal de su cuerpo (mismo `on
 * conflict`, mismo `greatest` de fecha), no un atajo aparte.
 */
async function crearLiquidacionEmitida(total: string): Promise<string> {
  const { rows: p } = await admin.query<{ id: string }>(
    `insert into periodo_expensa (barrio_id, periodo) values ($1, $2) returning id`,
    [arbol.barrioA1.id, `2052-${String((Math.floor(Math.random() * 1000) % 12) + 1).padStart(2, "0")}`],
  );
  const periodoId = p[0]?.id as string;
  const { rows: l } = await admin.query<{ id: string }>(
    `insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, coeficiente_aplicado,
                              subtotal_ordinarias, subtotal_extraordinarias, subtotal_fondo_reserva, total,
                              interes_mora)
     values ($1,$2,$3, 0.5, $4, 0, 0, $4, 0) returning id`,
    [arbol.barrioA1.id, periodoId, unidadesA1[0], total],
  );
  await admin.query("set session_replication_role = replica");
  await admin.query(`update periodo_expensa set estado = 'emitida', emitida_at = now() where id = $1`, [periodoId]);
  await admin.query("set session_replication_role = origin");

  // El débito que `trg_saldo_uf_por_emision` habría escrito — replica no lo dejó correr.
  await admin.query(
    `insert into saldo_uf (barrio_id, unidad_funcional_id, saldo_actual, fecha_ultimo_movimiento)
     values ($1, $2, $3, current_date)
     on conflict (barrio_id, unidad_funcional_id) do update
        set saldo_actual = saldo_uf.saldo_actual + excluded.saldo_actual,
            fecha_ultimo_movimiento = greatest(
              coalesce(saldo_uf.fecha_ultimo_movimiento, excluded.fecha_ultimo_movimiento),
              excluded.fecha_ultimo_movimiento)`,
    [arbol.barrioA1.id, unidadesA1[0], total],
  );

  return l[0]?.id as string;
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioB1.id);
  // Dos unidades: una va a tener movimientos (crédito real), la otra queda "sin fila" en `saldo_uf`.
  unidadesA1 = await crearUnidades(admin, arbol.barrioA1.id, 2);
});

afterEach(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from pago_imputacion where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from saldo_uf where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from pago where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from liquidacion where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from periodo_expensa where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("set session_replication_role = origin");
});

// `unidad_funcional`/`barrio` de A1 Y B1 (B1 hace falta para el usuario "ajeno"), igual que en
// `pagos-rls.test.ts`/`estado-cuenta.test.ts`: si no se borran acá, `borrarArbol` truena al intentar
// tirar abajo el `tenant_node` con la fila de `barrio` todavía viva.
afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from unidad_funcional where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from barrio where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("aislamiento entre barrios", () => {
  it("un usuario de otro barrio no ve ninguna unidad de A1, y `puedeRegistrarPago` es false", async () => {
    const resultado = await como(arbol.usuarios.adminEstudioB, (tx) =>
      listarSaldosUF(tx, { barrioId: arbol.barrioA1.id }),
    );
    expect(resultado.saldos).toEqual([]);
    expect(resultado.puedeRegistrarPago).toBe(false);
  });
});

describe("el flag `puedeRegistrarPago`", () => {
  it("es `true` para operador y admin_barrio", async () => {
    const comoOperador = await como(arbol.usuarios.operadorA1, (tx) => listarSaldosUF(tx, { barrioId: arbol.barrioA1.id }));
    expect(comoOperador.puedeRegistrarPago).toBe(true);
    expect(comoOperador.saldos.length).toBeGreaterThan(0);

    const comoAdminBarrio = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      listarSaldosUF(tx, { barrioId: arbol.barrioA1.id }),
    );
    expect(comoAdminBarrio.puedeRegistrarPago).toBe(true);
  });

  it("es `false` para contador y auditor (ven la grilla, pero de solo lectura)", async () => {
    const comoContador = await como(arbol.usuarios.contadorA1, (tx) => listarSaldosUF(tx, { barrioId: arbol.barrioA1.id }));
    expect(comoContador.puedeRegistrarPago).toBe(false);
    // Los ve: `readable_tenant_ids()` (0018) incluye contador/auditor en la lectura de `unidad_funcional`.
    expect(comoContador.saldos.length).toBeGreaterThan(0);

    const comoAuditor = await como(arbol.usuarios.auditorA1, (tx) => listarSaldosUF(tx, { barrioId: arbol.barrioA1.id }));
    expect(comoAuditor.puedeRegistrarPago).toBe(false);
  });

  it("es `false` para propietario, que además no ve ninguna fila", async () => {
    const comoPropietario = await como(arbol.usuarios.propietarioA1, (tx) =>
      listarSaldosUF(tx, { barrioId: arbol.barrioA1.id }),
    );
    expect(comoPropietario.puedeRegistrarPago).toBe(false);
    expect(comoPropietario.saldos).toEqual([]);
  });
});

describe("el saldo devuelto coincide con lo que dejaron las imputaciones", () => {
  it("una unidad con crédito parcial imputado queda con saldo = total - imputado", async () => {
    const liqId = await crearLiquidacionEmitida("1000.00");
    const pago = await como(arbol.usuarios.operadorA1, (tx) =>
      registrarPago(tx, {
        unidadFuncionalId: unidadesA1[0] as string,
        obligadoId: null,
        monto: "400.00",
        fecha: "2052-01-20",
        origen: "manual",
        comprobanteAdjunto: `barrios/${arbol.barrioA1.id}/pagos/comprobantes/AbCdEfGhIjKlMnOpQrStUv.pdf`,
      }),
    );
    await como(arbol.usuarios.operadorA1, (tx) =>
      imputarPago(tx, { pagoId: pago.id, liquidacionId: liqId, montoImputado: "400.00" }),
    );

    const { saldos } = await como(arbol.usuarios.operadorA1, (tx) => listarSaldosUF(tx, { barrioId: arbol.barrioA1.id }));

    const conMovimiento = saldos.find((s) => s.unidadFuncionalId === unidadesA1[0]);
    expect(conMovimiento?.saldoActual).toBe("600.00");
    expect(conMovimiento?.fechaUltimoMovimiento).toBeTruthy();

    // La segunda unidad nunca tuvo un movimiento: no tiene fila en `saldo_uf`, y la grilla igual la
    // muestra, con saldo 0.00 y sin fecha — "sin fila" y "saldo cero" son el mismo hecho (0037).
    const sinMovimiento = saldos.find((s) => s.unidadFuncionalId === unidadesA1[1]);
    expect(sinMovimiento?.saldoActual).toBe("0.00");
    expect(sinMovimiento?.fechaUltimoMovimiento).toBeNull();
  });
});
