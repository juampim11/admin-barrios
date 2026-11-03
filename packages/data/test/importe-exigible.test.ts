/**
 * `liquidacion.importe_exigible` (migración `0060`): cuando el saldo anterior de una boleta sale de la
 * propia cuenta corriente (`saldo_anterior_origen = 'calculado'`), esa deuda ya es un débito —la
 * liquidación vieja, sin pagar— y no se vuelve a sumar. La boleta sigue diciendo "a pagar" el total;
 * el estado de cuenta, el débito al emitir, el tope de la imputación y la imputación automática usan lo
 * exigible. Con cualquier otro origen, exigible = total (ninguna fila existente cambia).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { nuevoToken } from "@admin-barrios/almacenamiento";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { registrarPago } from "../src/servicios/pagos.ts";
import { resolverImputacionAutomatica } from "../src/servicios/cobros.ts";
import {
  borrarArbol,
  borrarParametrosDe,
  cargarParametro,
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
let unidad: string;

/**
 * Un período con una liquidación, EMITIDO por el camino que dispara el débito real
 * (`trg_saldo_uf_por_emision`): se apagan solo la máquina de estados (que exige un período armado de
 * punta a punta) y la guarda de su firma, no todos los triggers como hace `replica`.
 */
async function emitirLiquidacion(
  periodo: string,
  total: string,
  saldo: { monto: string; origen: "calculado" | "carga_manual" } | null,
): Promise<string> {
  const { rows: p } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo) values ($1,$2) returning id",
    [arbol.barrioA1.id, periodo],
  );
  const periodoId = p[0]!.id;
  const { rows: l } = await admin.query<{ id: string }>(
    `insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, coeficiente_aplicado,
                              subtotal_ordinarias, subtotal_extraordinarias, subtotal_fondo_reserva,
                              saldo_anterior, saldo_anterior_origen, interes_mora, total)
     values ($1,$2,$3, 1, $4, 0, 0, $5, $6, 0, $4::numeric + $5::numeric) returning id`,
    [arbol.barrioA1.id, periodoId, unidad, total, saldo?.monto ?? "0.00", saldo?.origen ?? "sin_movimientos"],
  );
  // La guarda de la firma (`trg_periodo_emitido_inmutable`) cuenta con que la firma la escriba la
  // máquina de estados; apagada esa, la firma se escribe acá y se apagan las dos.
  const guardas = ["trg_periodo_emitido_inmutable", "trg_periodo_transicion"];
  for (const g of guardas) await admin.query(`alter table periodo_expensa disable trigger ${g}`);
  try {
    await admin.query("update periodo_expensa set estado = 'emitida', emitida_at = now() where id = $1", [periodoId]);
  } finally {
    for (const g of guardas) await admin.query(`alter table periodo_expensa enable trigger ${g}`);
  }
  return l[0]!.id;
}

const saldoDeLaUnidad = async (): Promise<string> =>
  (
    await admin.query<{ s: string }>(
      "select coalesce((select saldo_actual::text from saldo_uf where unidad_funcional_id = $1), '0.00') as s",
      [unidad],
    )
  ).rows[0]!.s;

const saldoDeLaVista = async (): Promise<string> =>
  (
    await admin.query<{ s: string }>(
      "select coalesce(sum(monto), 0)::numeric(14,2)::text as s from app.v_estado_cuenta_uf where unidad_funcional_id = $1",
      [unidad],
    )
  ).rows[0]!.s;

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  unidad = (await crearUnidades(admin, arbol.barrioA1.id, 1))[0]!;
  await cargarParametro(admin, arbol.barrioA1.id, "imputacion.orden", "capital_primero");
});

afterEach(async () => {
  await admin.query("set session_replication_role = replica");
  for (const t of ["pago_imputacion", "saldo_uf", "pago", "liquidacion", "periodo_expensa"]) {
    await admin.query(`delete from ${t} where barrio_id = $1`, [arbol.barrioA1.id]);
  }
  await admin.query("set session_replication_role = origin");
});

afterAll(async () => {
  await borrarParametrosDe(admin, [arbol.barrioA1.id]);
  await admin.query("set session_replication_role = replica");
  for (const t of ["unidad_funcional", "codigo_pago_secuencia", "barrio"]) {
    await admin.query(`delete from ${t} where barrio_id = $1`, [arbol.barrioA1.id]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("el saldo anterior calculado no se cobra dos veces", () => {
  it("una unidad que no pagó un mes debe ese mes más el siguiente, no el doble", async () => {
    await emitirLiquidacion("2051-01", "1000.00", null);
    const segunda = await emitirLiquidacion("2051-02", "1100.00", { monto: "1000.00", origen: "calculado" });

    const { rows } = await admin.query<{ total: string; exigible: string }>(
      "select total::text, importe_exigible::text as exigible from liquidacion where id = $1",
      [segunda],
    );
    // La boleta dice "a pagar" 2.100; lo que la segunda agrega a la deuda es solo lo suyo.
    expect(rows[0]).toEqual({ total: "2100.00", exigible: "1100.00" });
    expect(await saldoDeLaUnidad()).toBe("2100.00");
    expect(await saldoDeLaVista()).toBe("2100.00");
  });

  it("pagar el total de la boleta deja la unidad en cero, y el pago se reparte entre las dos", async () => {
    const primera = await emitirLiquidacion("2051-01", "1000.00", null);
    const segunda = await emitirLiquidacion("2051-02", "1100.00", { monto: "1000.00", origen: "calculado" });

    const imputaciones = await conUsuario(db, arbol.usuarios.operadorA1, async (tx) => {
      const pago = await registrarPago(tx, {
        unidadFuncionalId: unidad,
        obligadoId: null,
        monto: "2100.00",
        fecha: "2051-02-12",
        origen: "manual",
        comprobanteAdjunto: `barrios/${arbol.barrioA1.id}/pagos/comprobantes/${nuevoToken()}.pdf`,
      });
      return resolverImputacionAutomatica(tx, { pagoId: pago.id });
    });

    // Sin depender del orden: las dos imputaciones nacen en la misma transacción (mismo `created_at`).
    expect(new Map(imputaciones.map((i) => [i.liquidacionId, i.montoImputado]))).toEqual(
      new Map([
        [primera, "1000.00"],
        [segunda, "1100.00"],
      ]),
    );
    expect(await saldoDeLaUnidad()).toBe("0.00");
    expect(await saldoDeLaVista()).toBe("0.00");
  });

  it("una deuda traída de afuera (carga manual) sí es un débito nuevo: exigible = total", async () => {
    const unica = await emitirLiquidacion("2051-01", "1000.00", { monto: "500.00", origen: "carga_manual" });
    const { rows } = await admin.query<{ exigible: string }>(
      "select importe_exigible::text as exigible from liquidacion where id = $1",
      [unica],
    );
    expect(rows[0]?.exigible).toBe("1500.00");
    expect(await saldoDeLaUnidad()).toBe("1500.00");
  });
});
