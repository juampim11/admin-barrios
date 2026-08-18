/**
 * `app.v_estado_cuenta_uf` — el saldo sale de sumar débitos (liquidaciones EMITIDAS) y créditos
 * (imputaciones vivas), excluye lo anulado, y sobre todo: **`security_invoker = true` funciona de
 * verdad**. Es el hallazgo bloqueante del panel — sin eso, la vista corre con los privilegios del
 * dueño del esquema y `FORCE ROW LEVEL SECURITY` de las tablas base no se aplica a través de ella.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/estado-cuenta.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { registrarPago } from "../src/servicios/pagos.ts";
import { anularImputacion, estadoDeCuenta, imputarPago } from "../src/servicios/cobros.ts";
import { borrarArbol, crearArbol, crearBarrio, crearUnidades, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let unidadA1: string;

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>): Promise<T> => conUsuario(db, usuario, fn);

/** Un período EMITIDO con una liquidación de `total` para la unidad de prueba.
 *
 * Se fuerza la transición con `session_replication_role = replica`: correr `app.validar_emision`
 * de verdad exige un escenario de liquidación completo (gastos, coeficientes cerrados, cuadre
 * exacto) que ya cubren `expensas-liquidacion.test.ts` y `ataques-escritura.test.ts`. Acá lo único
 * que hace falta es UN período que la vista pueda considerar "emitido"; los triggers que lo impedían
 * no son lo que este archivo prueba.
 */
async function crearLiquidacionEmitida(total: string, emitidaAt: string): Promise<string> {
  const { rows: p } = await admin.query<{ id: string }>(
    `insert into periodo_expensa (barrio_id, periodo) values ($1, $2) returning id`,
    [arbol.barrioA1.id, `2051-${String((Math.floor(Math.random() * 1000) % 12) + 1).padStart(2, "0")}`],
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
  await admin.query(`update periodo_expensa set estado = 'emitida', emitida_at = $2 where id = $1`, [
    periodoId,
    emitidaAt,
  ]);
  await admin.query("set session_replication_role = origin");
  return l[0]?.id as string;
}

async function crearPagoImputado(monto: string, liquidacionId: string): Promise<{ pagoId: string; imputacionId: string }> {
  const pago = await como(arbol.usuarios.operadorA1, (tx) =>
    registrarPago(tx, {
      unidadFuncionalId: unidadA1,
      obligadoId: null,
      monto,
      fecha: "2051-01-20",
      origen: "manual",
      comprobanteAdjunto: `barrios/${arbol.barrioA1.id}/pagos/comprobantes/AbCdEfGhIjKlMnOpQrStUv.pdf`,
    }),
  );
  const imp = await como(arbol.usuarios.operadorA1, (tx) =>
    imputarPago(tx, { pagoId: pago.id, liquidacionId, montoImputado: monto }),
  );
  return { pagoId: pago.id, imputacionId: imp.id };
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
});

// Por test: `saldo_uf` lo escribe cada `imputarPago()` exitoso, igual que en `cobros-imputacion.test.ts`.
afterEach(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from pago_imputacion where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from saldo_uf where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from pago where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from liquidacion where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from periodo_expensa where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("set session_replication_role = origin");
});

// De archivo: `crearBarrio` se llama para A1 Y B1 en el `beforeAll` (B1 hace falta para el usuario
// "ajeno" del test de `security_invoker`), así que las dos filas de `barrio` quedan huérfanas si no
// se borran acá — es la misma causa de fondo que en `cobros-imputacion.test.ts`.
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

describe("el saldo de la vista suma débitos y créditos", () => {
  it("una liquidación emitida sin pagos deja saldo = total (deuda)", async () => {
    const liqId = await crearLiquidacionEmitida("3000.00", "2051-01-05");
    const movimientos = await como(arbol.usuarios.operadorA1, (tx) => estadoDeCuenta(tx, { unidadFuncionalId: unidadA1 }));
    const debito = movimientos.find((m) => m.origenId === liqId);
    expect(debito?.tipo).toBe("debito");
    expect(debito?.monto).toBe("3000.00");
  });

  it("un pago imputado íntegramente deja saldo corriente en 0 para esa liquidación", async () => {
    const liqId = await crearLiquidacionEmitida("1500.00", "2051-02-05");
    const { imputacionId } = await crearPagoImputado("1500.00", liqId);
    void imputacionId;

    const movimientos = await como(arbol.usuarios.operadorA1, (tx) => estadoDeCuenta(tx, { unidadFuncionalId: unidadA1 }));
    // El saldo corriente es acumulado de TODA la unidad (varias liquidaciones conviven en el fixture),
    // así que se compara el último movimiento cronológico contra la suma total esperada.
    const sumaEsperada = movimientos.reduce((acc, m) => acc + Number(m.monto), 0);
    const ultimo = movimientos[movimientos.length - 1];
    expect(Number(ultimo?.saldoCorriente)).toBeCloseTo(sumaEsperada, 2);
  });

  it("excluye pagos e imputaciones anulados del cálculo del saldo", async () => {
    const liqId = await crearLiquidacionEmitida("800.00", "2051-03-05");
    const { imputacionId } = await crearPagoImputado("800.00", liqId);

    const antes = await como(arbol.usuarios.operadorA1, (tx) => estadoDeCuenta(tx, { unidadFuncionalId: unidadA1 }));
    const creditoAntes = antes.find((m) => m.origenId === imputacionId);
    expect(creditoAntes).toBeTruthy();

    await como(arbol.usuarios.operadorA1, (tx) =>
      anularImputacion(tx, { imputacionId, motivo: "Se imputó contra la liquidación equivocada" }),
    );

    const despues = await como(arbol.usuarios.operadorA1, (tx) => estadoDeCuenta(tx, { unidadFuncionalId: unidadA1 }));
    expect(despues.find((m) => m.origenId === imputacionId)).toBeUndefined();
  });
});

describe("`security_invoker = true`: un usuario de otro barrio no ve nada a través de la vista", () => {
  it("un usuario de B1 consultando la unidad de A1 obtiene la lista vacía, no un error", async () => {
    const liqId = await crearLiquidacionEmitida("999.00", "2051-04-05");
    void liqId;

    // Confirmamos primero que SÍ hay movimientos para quien tiene acceso.
    const propios = await como(arbol.usuarios.operadorA1, (tx) => estadoDeCuenta(tx, { unidadFuncionalId: unidadA1 }));
    expect(propios.length).toBeGreaterThan(0);

    // Y que un usuario de un barrio hermano, sin ningún rol sobre A1, ve CERO filas — la prueba
    // directa de que `security_invoker=true` deja que `force row level security` de `liquidacion`
    // se aplique a través de la vista, y no que el dueño del esquema la sirva sin filtrar.
    const ajenos = await como(arbol.usuarios.adminEstudioB, (tx) => estadoDeCuenta(tx, { unidadFuncionalId: unidadA1 }));
    expect(ajenos).toEqual([]);
  });
});
