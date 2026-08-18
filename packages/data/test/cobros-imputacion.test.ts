/**
 * `pago_imputacion` — sobre-imputación bloqueada (contra la liquidación y contra el pago),
 * concurrencia real (dos conexiones, un solo lock que gana), `app.resolver_imputacion()` fallando
 * cerrado sin `orden_imputacion`, y que un pago se registra igual sin ese criterio configurado.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/cobros-imputacion.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, crearDbRequest, type DbRequest } from "../src/client.ts";
import { registrarPago } from "../src/servicios/pagos.ts";
import { anularImputacion, imputarPago, resolverImputacionAutomatica } from "../src/servicios/cobros.ts";
import { borrarArbol, crearArbol, crearBarrio, crearUnidades, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let unidadA1: string;

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

let contadorPeriodo = 0;

/**
 * Un período EMITIDO con UNA liquidación de `total` dado, para la unidad de prueba.
 *
 * **Tiene que estar emitido**: `app.pago_imputacion_antes()` (0037) rechaza imputar contra una
 * liquidación de un período en borrador (puede desaparecer al regenerarse). Se fuerza la transición
 * con `session_replication_role = replica` — correr `app.validar_emision` de verdad es un escenario
 * completo que ya cubren `expensas-liquidacion.test.ts` y `ataques-escritura.test.ts`; acá lo único
 * que hace falta es que la vista y el trigger la consideren "emitida".
 */
async function crearLiquidacion(total: string): Promise<string> {
  contadorPeriodo += 1;
  const mes = String((contadorPeriodo % 12) + 1).padStart(2, "0");
  const anio = 2050 + Math.floor(contadorPeriodo / 12);
  const periodo = `${anio}-${mes}`;
  const { rows: p } = await admin.query<{ id: string }>(
    `insert into periodo_expensa (barrio_id, periodo) values ($1,$2) returning id`,
    [arbol.barrioA1.id, periodo],
  );
  const periodoId = p[0]?.id as string;
  // `interes_mora = 0` (y no NULL) para cumplir `liquidacion_mora_chk` junto con el default de
  // `mora_pendiente_definicion = false`: esta fixture no ejercita mora, solo necesita una liquidación
  // válida contra la que imputar.
  const { rows: l } = await admin.query<{ id: string }>(
    `insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, coeficiente_aplicado,
                              subtotal_ordinarias, subtotal_extraordinarias, subtotal_fondo_reserva, total,
                              interes_mora)
     values ($1,$2,$3, 0.5, $4, 0, 0, $4, 0) returning id`,
    [arbol.barrioA1.id, periodoId, unidadA1, total],
  );
  await admin.query("set session_replication_role = replica");
  await admin.query(`update periodo_expensa set estado = 'emitida', emitida_at = now() where id = $1`, [
    periodoId,
  ]);
  await admin.query("set session_replication_role = origin");
  return l[0]?.id as string;
}

async function crearPago(monto: string): Promise<string> {
  const p = await como(arbol.usuarios.operadorA1, (tx) =>
    registrarPago(tx, {
      unidadFuncionalId: unidadA1,
      obligadoId: null,
      monto,
      fecha: "2050-01-15",
      origen: "manual",
      comprobanteAdjunto: `barrios/${arbol.barrioA1.id}/pagos/comprobantes/AbCdEfGhIjKlMnOpQrStUv.pdf`,
    }),
  );
  return p.id;
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  const unidades = await crearUnidades(admin, arbol.barrioA1.id, 1);
  unidadA1 = unidades[0] as string;
});

// Limpieza POR TEST: cada `it()` de este archivo crea su propia liquidación/pago/imputación, y
// dejarlos entre tests contamina el fixture del siguiente — es la causa real por la que
// `resolver_imputacion()` había visto liquidaciones de tests anteriores. `saldo_uf` entra acá (no en
// el afterAll de más abajo) porque lo escribe CADA `imputarPago()` que tiene éxito, así que es tan
// "por test" como `pago_imputacion` mismo.
afterEach(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from pago_imputacion where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from saldo_uf where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from pago where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from liquidacion where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from periodo_expensa where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("set session_replication_role = origin");
});

// Limpieza DE ARCHIVO: `unidad_funcional`/`barrio` los crea una sola vez `beforeAll`, así que se
// borran una sola vez acá. Faltaban los dos — es la causa real del `FAIL` en el teardown:
// `barrio_barrio_id_tenant_node_id_fk` truena porque la fila de `barrio` seguía viva cuando
// `borrarArbol` intentaba borrar su `tenant_node`.
afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from unidad_funcional where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from barrio where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("un pago se registra igual sin `orden_imputacion` configurado", () => {
  it("registrarPago() no depende de la imputación", async () => {
    const pagoId = await crearPago("1000.00");
    expect(pagoId).toBeTruthy();
  });
});

describe("no se imputa contra una liquidación en borrador", () => {
  it("rechaza con `liquidacion_no_emitida`: podría desaparecer al regenerar el período", async () => {
    const { rows: p } = await admin.query<{ id: string }>(
      `insert into periodo_expensa (barrio_id, periodo) values ($1,'2049-01') returning id`,
      [arbol.barrioA1.id],
    );
    // `interes_mora = 0`: mismo motivo que en `crearLiquidacion` — cumplir `liquidacion_mora_chk`
    // junto con el default de `mora_pendiente_definicion = false`.
    const { rows: l } = await admin.query<{ id: string }>(
      `insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, coeficiente_aplicado,
                                subtotal_ordinarias, subtotal_extraordinarias, subtotal_fondo_reserva, total,
                                interes_mora)
       values ($1,$2,$3, 0.5, '400.00', 0, 0, '400.00', 0) returning id`,
      [arbol.barrioA1.id, p[0]?.id, unidadA1],
    );
    const pagoId = await crearPago("400.00");

    const err = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        imputarPago(tx, { pagoId, liquidacionId: l[0]?.id as string, montoImputado: "400.00" }),
      ),
    );
    expect(err.codigo).toBe("liquidacion_no_emitida");
  });
});

describe("imputación manual: contra `liquidacion`, no contra `item_liquidacion`", () => {
  it("imputarPago() escribe `liquidacion_id`, y el importe queda tal cual se pidió", async () => {
    const liqId = await crearLiquidacion("2000.00");
    const pagoId = await crearPago("2000.00");

    const imp = await como(arbol.usuarios.operadorA1, (tx) =>
      imputarPago(tx, { pagoId, liquidacionId: liqId, montoImputado: "2000.00" }),
    );
    expect(imp.liquidacionId).toBe(liqId);
    expect(imp.montoImputado).toBe("2000.00");
  });
});

describe("sobre-imputación bloqueada", () => {
  it("no se puede imputar más de lo que la liquidación tiene pendiente", async () => {
    const liqId = await crearLiquidacion("1000.00");
    const pagoId = await crearPago("5000.00"); // el pago sobra; la liquidación es chica

    const err = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        imputarPago(tx, { pagoId, liquidacionId: liqId, montoImputado: "1000.01" }),
      ),
    );
    expect(err.codigo).toBe("imputacion_supera_liquidacion");
  });

  it("no se puede imputar más de lo que le queda sin asignar al pago", async () => {
    const liqA = await crearLiquidacion("10000.00");
    const liqB = await crearLiquidacion("10000.00");
    const pagoId = await crearPago("1000.00"); // el pago es chico; las liquidaciones sobran

    await como(arbol.usuarios.operadorA1, (tx) => imputarPago(tx, { pagoId, liquidacionId: liqA, montoImputado: "900.00" }));

    const err = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        imputarPago(tx, { pagoId, liquidacionId: liqB, montoImputado: "100.01" }),
      ),
    );
    expect(err.codigo).toBe("imputacion_supera_pago");
  });

  it("anular una imputación libera el saldo, y se puede volver a imputar", async () => {
    const liqId = await crearLiquidacion("500.00");
    const pagoId = await crearPago("500.00");

    const imp = await como(arbol.usuarios.operadorA1, (tx) =>
      imputarPago(tx, { pagoId, liquidacionId: liqId, montoImputado: "500.00" }),
    );
    await como(arbol.usuarios.operadorA1, (tx) =>
      anularImputacion(tx, { imputacionId: imp.id, motivo: "Se cargó contra la liquidación equivocada" }),
    );
    // Con la anulación, el saldo de la liquidación vuelve a estar disponible entero.
    const segunda = await como(arbol.usuarios.operadorA1, (tx) =>
      imputarPago(tx, { pagoId, liquidacionId: liqId, montoImputado: "500.00" }),
    );
    expect(segunda.id).not.toBe(imp.id);
  });
});

describe("concurrencia real: dos conexiones, un solo lock", () => {
  function dosConexiones(): [DbRequest, DbRequest] {
    return [crearDbRequest(appPool), crearDbRequest(appPool)];
  }

  it("dos imputaciones simultáneas contra la MISMA liquidación: una gana, la suma nunca supera el total", async () => {
    const liqId = await crearLiquidacion("1000.00");
    const pagoA = await crearPago("1000.00");
    const pagoB = await crearPago("1000.00");

    const [a, b] = dosConexiones();
    const resultados = await Promise.allSettled([
      conUsuario(a, arbol.usuarios.operadorA1, (tx) =>
        imputarPago(tx, { pagoId: pagoA, liquidacionId: liqId, montoImputado: "1000.00" }),
      ),
      conUsuario(b, arbol.usuarios.adminBarrioA1, (tx) =>
        imputarPago(tx, { pagoId: pagoB, liquidacionId: liqId, montoImputado: "1000.00" }),
      ),
    ]);

    const ok = resultados.filter((r) => r.status === "fulfilled");
    const fallos = resultados.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(fallos).toHaveLength(1);
    if (fallos[0]?.status === "rejected") {
      expect(esErrorDeNegocio(fallos[0].reason) ? fallos[0].reason.codigo : null).toBe("imputacion_supera_liquidacion");
    }

    const { rows } = await admin.query<{ suma: string }>(
      `select coalesce(sum(monto_imputado),0)::text as suma from pago_imputacion
        where liquidacion_id = $1 and anulado_at is null`,
      [liqId],
    );
    // Nunca por encima del total: es lo que prueba que el `for update` de la liquidación sirvió de
    // algo, y no solo el `CHECK` aritmético (que un `insert` aislado también hubiera cumplido).
    expect(Number(rows[0]?.suma)).toBeLessThanOrEqual(1000);
    expect(rows[0]?.suma).toBe("1000.00");
  });
});

describe("`app.resolver_imputacion()` falla cerrado sin `orden_imputacion`", () => {
  it("rechaza con `orden_imputacion_no_configurado` cuando el barrio no lo tiene cargado", async () => {
    const liqId = await crearLiquidacion("300.00");
    const pagoId = await crearPago("300.00");
    void liqId;

    const err = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) => resolverImputacionAutomatica(tx, { pagoId })),
    );
    expect(err.codigo).toBe("orden_imputacion_no_configurado");
  });

  it("con el criterio configurado, imputa automáticamente contra las liquidaciones pendientes", async () => {
    await admin.query("update barrio set orden_imputacion = 'fifo_estricto' where barrio_id = $1", [
      arbol.barrioA1.id,
    ]);
    try {
      const liq1 = await crearLiquidacion("600.00");
      const liq2 = await crearLiquidacion("600.00");
      const pagoId = await crearPago("900.00"); // cubre la primera entera y la mitad de la segunda

      const imputaciones = await como(arbol.usuarios.operadorA1, (tx) =>
        resolverImputacionAutomatica(tx, { pagoId }),
      );
      const total = imputaciones.reduce((a, i) => a + Number(i.montoImputado), 0);
      expect(total).toBeCloseTo(900, 2);
      expect(imputaciones.some((i) => i.liquidacionId === liq1)).toBe(true);
    } finally {
      await admin.query("update barrio set orden_imputacion = null where barrio_id = $1", [arbol.barrioA1.id]);
    }
  });
});
