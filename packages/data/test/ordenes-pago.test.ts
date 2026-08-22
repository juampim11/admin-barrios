/**
 * El circuito de la orden de pago: las seis transiciones, el congelamiento fuera de `pendiente`, el
 * fail-closed contra un período ya emitido, y la generación/reversión de `gasto_periodo` — incluido
 * el ajuste cuando el período de origen ya no es editable.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/ordenes-pago.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { registrarProveedor } from "../src/servicios/proveedores.ts";
import {
  adjuntarFacturaDeOP,
  anularOrdenPago,
  aprobarOrdenPago,
  listarOrdenesPago,
  marcarFacturaNoDisponibleDeOP,
  marcarOrdenPagada,
  rechazarOrdenPago,
  registrarOrdenPago,
} from "../src/servicios/ordenes-pago.ts";
import { borrarArbol, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let proveedorId: string;
let conceptoId: string;

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
/** Mismo mecanismo que `crearLiquidacion()` de `cobros-imputacion.test.ts`: nunca repite un
 *  período, sin depender de `Math.random()` (deuda 6.bis del HANDOFF, cerrada 2026-08-20). */
function proximoPeriodo(): string {
  contadorPeriodo += 1;
  const mes = String((contadorPeriodo % 12) + 1).padStart(2, "0");
  const anio = 2060 + Math.floor(contadorPeriodo / 12);
  return `${anio}-${mes}`;
}

async function crearPeriodo(estado: "borrador" | "emitida" = "borrador"): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo) values ($1,$2) returning id",
    [arbol.barrioA1.id, proximoPeriodo()],
  );
  const id = rows[0]?.id as string;
  if (estado === "emitida") {
    await admin.query("set session_replication_role = replica");
    await admin.query("update periodo_expensa set estado = 'emitida', emitida_at = now() where id = $1", [id]);
    await admin.query("set session_replication_role = origin");
  }
  return id;
}

async function crearOrdenPago(
  comoUsuario: string,
  periodoId: string,
  monto = "1000.00",
): Promise<string> {
  const op = await como(comoUsuario, (tx) =>
    registrarOrdenPago(tx, {
      proveedorId,
      periodoId,
      conceptoId,
      numeroFactura: null,
      descripcion: "Trabajo de prueba",
      monto,
    }),
  );
  return op.id;
}

/** Corre `fn` con `app.user_id` seteado en la sesión, sin pasar por `conUsuario()`/RLS — para
 *  ejercitar guardias del trigger directamente contra la conexión de `admin` (mismo patrón que
 *  `sembrarRecibo()` en `recibos.test.ts`). Por default hace rollback (son pruebas de rechazo);
 *  `commit: true` para el único caso legítimo (la transición a `conciliada`, sin servicio propio). */
async function conIdentidadCruda<T>(
  comoUsuario: string,
  fn: (cliente: pg.PoolClient) => Promise<T>,
  opciones: { commit?: boolean } = {},
): Promise<T> {
  const cliente = await admin.connect();
  try {
    await cliente.query("begin");
    await cliente.query("select set_config('app.user_id', $1, true)", [comoUsuario]);
    const resultado = await fn(cliente);
    await cliente.query(opciones.commit ? "commit" : "rollback");
    return resultado;
  } catch (e) {
    await cliente.query("rollback").catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

async function gastoDe(ordenPagoId: string): Promise<{ id: string; monto: string; periodo_id: string; gasto_periodo_origen_id: string | null }[]> {
  const { rows } = await admin.query<{ id: string; monto: string; periodo_id: string; gasto_periodo_origen_id: string | null }>(
    "select id, monto::text, periodo_id, gasto_periodo_origen_id from gasto_periodo where orden_pago_id = $1 order by created_at",
    [ordenPagoId],
  );
  return rows;
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioB1.id);

  const p = await como(arbol.usuarios.operadorA1, (tx) =>
    registrarProveedor(tx, {
      barrioId: arbol.barrioA1.id,
      razonSocial: "Proveedor de prueba",
      cuit: null,
      condicionFiscal: null,
      contacto: null,
      cbu: null,
      alias: null,
    }),
  );
  proveedorId = p.id;

  const { rows } = await admin.query<{ id: string }>(
    `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal)
     values ($1,'Mantenimiento','ordinaria','sin_clasificar') returning id`,
    [arbol.barrioA1.id],
  );
  conceptoId = rows[0]?.id as string;
});

afterEach(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from gasto_periodo where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from orden_pago where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("delete from periodo_expensa where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("update barrio set orden_pago_cuatro_ojos = false where barrio_id = $1", [arbol.barrioA1.id]);
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

describe("el circuito feliz completo", () => {
  it("pendiente → aprobada genera gasto_periodo; → pagada guarda el medio; → conciliada", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId, "1500.00");

    const aprobada = await como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId }));
    expect(aprobada.estado).toBe("aprobada");

    const gastos = await gastoDe(opId);
    expect(gastos).toHaveLength(1);
    expect(gastos[0]?.monto).toBe("1500.00");
    expect(gastos[0]?.periodo_id).toBe(periodoId);
    expect(gastos[0]?.gasto_periodo_origen_id).toBeNull();

    const pagada = await como(arbol.usuarios.operadorA1, (tx) =>
      marcarOrdenPagada(tx, { ordenPagoId: opId, medioPago: "transferencia" }),
    );
    expect(pagada.estado).toBe("pagada");
    expect(pagada.medioPago).toBe("transferencia");

    const { rows: conciliada } = await conIdentidadCruda(
      arbol.usuarios.adminBarrioA1,
      (cliente) =>
        cliente.query<{ estado: string }>(
          "update orden_pago set estado = 'conciliada' where id = $1 returning estado",
          [opId],
        ),
      { commit: true },
    );
    expect(conciliada[0]?.estado).toBe("conciliada");
  });

  it("pendiente → rechazada NO genera gasto_periodo", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);

    const rechazada = await como(arbol.usuarios.adminBarrioA1, (tx) => rechazarOrdenPago(tx, { ordenPagoId: opId }));
    expect(rechazada.estado).toBe("rechazada");
    expect(await gastoDe(opId)).toHaveLength(0);
  });
});

describe("congelamiento fuera de pendiente y lista blanca de transiciones", () => {
  it("una orden aprobada no se edita: el monto/descripcion quedan congelados", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);
    await como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId }));

    await expect(
      conIdentidadCruda(arbol.usuarios.adminBarrioA1, (cliente) =>
        cliente.query("update orden_pago set monto = 999.00 where id = $1", [opId]),
      ),
    ).rejects.toThrow(/no se edita/);
  });

  it("pendiente → pagada directo (saltando aprobada) es una transición inválida", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);

    await expect(
      conIdentidadCruda(arbol.usuarios.adminBarrioA1, (cliente) =>
        cliente.query("update orden_pago set estado = 'pagada' where id = $1", [opId]),
      ),
    ).rejects.toThrow(/transición de estado inválida/);
  });

  it("una anulación sin motivo se rechaza a nivel de base (guardia independiente del schema de TS)", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);
    await como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId }));

    await expect(
      conIdentidadCruda(arbol.usuarios.adminBarrioA1, (cliente) =>
        cliente.query("update orden_pago set estado = 'anulada' where id = $1", [opId]),
      ),
    ).rejects.toThrow(/necesita motivo/);
  });
});

describe("fail-closed: aprobar contra un período ya emitido", () => {
  it("no reabre app.periodo_editable() por un costado lateral — la transición se cae entera", async () => {
    const periodoEmitido = await crearPeriodo("emitida");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoEmitido);

    // El mensaje crudo de `app.periodo_editable()` (0023) SÍ dice "no se edita" — pero acá se pasa
    // por el servicio, y `errores.ts` ya tiene una regla para ese mensaje (`periodo_no_editable`)
    // que lo reescribe como "no se puede modificar": es la traducción existente, no un mensaje nuevo.
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId })),
    ).rejects.toThrow(/no se puede modificar/);

    // La orden queda tal como estaba: la transacción entera se revirtió, no solo el insert interno.
    const { rows } = await admin.query<{ estado: string; aprobada_at: string | null }>(
      "select estado, aprobada_at from orden_pago where id = $1",
      [opId],
    );
    expect(rows[0]?.estado).toBe("pendiente");
    expect(rows[0]?.aprobada_at).toBeNull();
  });
});

describe("anulación: reversión del gasto ya generado", () => {
  it("con el período de origen todavía en borrador, el gasto se borra", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);
    await como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId }));
    expect(await gastoDe(opId)).toHaveLength(1);

    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      anularOrdenPago(tx, { ordenPagoId: opId, motivo: "Factura duplicada, se anula" }),
    );
    expect(await gastoDe(opId)).toHaveLength(0);
  });

  it("con el período de origen ya emitido y OTRO en borrador, genera el ajuste en negativo ahí", async () => {
    const periodoOrigen = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoOrigen, "800.00");
    await como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId }));
    const [cargo] = await gastoDe(opId);

    // El período de origen se emite DESPUÉS de aprobar la OP — mismo escenario que "factura tardía"
    // del panel de security-engineer, del otro lado: acá el período se cierra con la OP ya aprobada.
    await admin.query("set session_replication_role = replica");
    await admin.query("update periodo_expensa set estado = 'emitida', emitida_at = now() where id = $1", [
      periodoOrigen,
    ]);
    await admin.query("set session_replication_role = origin");

    const periodoAbierto = await crearPeriodo("borrador");

    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      anularOrdenPago(tx, { ordenPagoId: opId, motivo: "Proveedor no entregó, se anula" }),
    );

    const filas = await gastoDe(opId);
    expect(filas).toHaveLength(2);
    const ajuste = filas.find((f) => f.id !== cargo?.id);
    expect(ajuste?.monto).toBe("-800.00");
    expect(ajuste?.periodo_id).toBe(periodoAbierto);
    expect(ajuste?.gasto_periodo_origen_id).toBe(cargo?.id);

    // El cargo original NO se tocó: el período que lo aloja sigue emitido/inmutable.
    const { rows: original } = await admin.query<{ monto: string }>("select monto::text from gasto_periodo where id = $1", [
      cargo?.id,
    ]);
    expect(original[0]?.monto).toBe("800.00");
  });

  it("sin NINGÚN período en borrador para asentar el ajuste, la anulación se bloquea", async () => {
    const periodoOrigen = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoOrigen);
    await como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId }));

    await admin.query("set session_replication_role = replica");
    await admin.query("update periodo_expensa set estado = 'emitida', emitida_at = now() where id = $1", [
      periodoOrigen,
    ]);
    await admin.query("set session_replication_role = origin");
    // Sin crear ningún otro período: no queda ninguno en borrador para este barrio.

    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        anularOrdenPago(tx, { ordenPagoId: opId, motivo: "No hay dónde asentar esto" }),
      ),
    ).rejects.toThrow(/no hay un período en borrador/i);
  });
});

describe("cuatro-ojos, configurable por barrio", () => {
  it("con el barrio en false (default): la misma persona puede crear y aprobar", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.adminBarrioA1, periodoId);
    const aprobada = await como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId }));
    expect(aprobada.estado).toBe("aprobada");
  });

  it("con el barrio en true, la misma persona NO puede aprobar lo que cargó", async () => {
    await admin.query("update barrio set orden_pago_cuatro_ojos = true where barrio_id = $1", [arbol.barrioA1.id]);
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.adminBarrioA1, periodoId);

    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId })),
    ).rejects.toThrow(/cuatro ojos/);
  });

  it("con el barrio en true, OTRA persona sí puede aprobar", async () => {
    await admin.query("update barrio set orden_pago_cuatro_ojos = true where barrio_id = $1", [arbol.barrioA1.id]);
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);

    const aprobada = await como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId }));
    expect(aprobada.estado).toBe("aprobada");
  });

  it("app_request no puede escribir orden_pago_cuatro_ojos — el grant de columna lo impide", async () => {
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`update barrio set orden_pago_cuatro_ojos = true where barrio_id = ${arbol.barrioA1.id}`),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("listarOrdenesPago(): los flags puedeXxx", () => {
  async function flagsDe(comoUsuario: string, ordenPagoId: string) {
    const lista = await como(comoUsuario, (tx) => listarOrdenesPago(tx, { barrioId: arbol.barrioA1.id }));
    const fila = lista.find((op) => op.id === ordenPagoId);
    if (!fila) throw new Error("la orden no aparece en la lista");
    return {
      puedeAprobar: fila.puedeAprobar,
      puedeRechazar: fila.puedeRechazar,
      puedeMarcarPagada: fila.puedeMarcarPagada,
      puedeAnular: fila.puedeAnular,
    };
  }

  it("pendiente: operador no puede aprobar/rechazar, admin_barrio (no creador) sí", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);

    expect(await flagsDe(arbol.usuarios.operadorA1, opId)).toEqual({
      puedeAprobar: false,
      puedeRechazar: false,
      puedeMarcarPagada: false,
      puedeAnular: false,
    });
    expect(await flagsDe(arbol.usuarios.adminBarrioA1, opId)).toEqual({
      puedeAprobar: true,
      puedeRechazar: true,
      puedeMarcarPagada: false,
      puedeAnular: false,
    });
  });

  it("pendiente + cuatro-ojos activo: quien la cargó no puede aprobar, pero sí rechazar", async () => {
    await admin.query("update barrio set orden_pago_cuatro_ojos = true where barrio_id = $1", [arbol.barrioA1.id]);
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.adminBarrioA1, periodoId);

    expect(await flagsDe(arbol.usuarios.adminBarrioA1, opId)).toEqual({
      puedeAprobar: false,
      puedeRechazar: true,
      puedeMarcarPagada: false,
      puedeAnular: false,
    });
  });

  it("aprobada: los tres roles de gestión pueden marcar pagada y anular; aprobar/rechazar ya no", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);
    await como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId }));

    expect(await flagsDe(arbol.usuarios.operadorA1, opId)).toEqual({
      puedeAprobar: false,
      puedeRechazar: false,
      puedeMarcarPagada: true,
      puedeAnular: true,
    });
  });

  it("pagada: puedeAnular sigue en true, puedeMarcarPagada ya no", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);
    await como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId }));
    await como(arbol.usuarios.operadorA1, (tx) => marcarOrdenPagada(tx, { ordenPagoId: opId, medioPago: "transferencia" }));

    expect(await flagsDe(arbol.usuarios.operadorA1, opId)).toEqual({
      puedeAprobar: false,
      puedeRechazar: false,
      puedeMarcarPagada: false,
      puedeAnular: true,
    });
  });

  it("contador (solo lectura) no tiene ningún flag en true, en ningún estado", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);

    expect(await flagsDe(arbol.usuarios.contadorA1, opId)).toEqual({
      puedeAprobar: false,
      puedeRechazar: false,
      puedeMarcarPagada: false,
      puedeAnular: false,
    });
  });
});

/** Clave válida contra `orden_pago_factura_storage_key_chk` (`0048`): `/factura/` en la ruta. */
function claveFacturaValida(ordenPagoId: string): string {
  return `barrios/${arbol.barrioA1.id}/ordenes-pago/${ordenPagoId}/factura/AbCdEfGhIjKlMnOpQrStUv.pdf`;
}

describe("factura del proveedor (0048): distinta del comprobante de pago", () => {
  it("adjuntarFacturaDeOP() la guarda, en cualquier estado", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);
    await como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId }));

    const conFactura = await como(arbol.usuarios.operadorA1, (tx) =>
      adjuntarFacturaDeOP(tx, { ordenPagoId: opId, storageKey: claveFacturaValida(opId) }),
    );
    expect(conFactura.facturaAdjunta).toBe(claveFacturaValida(opId));
    expect(conFactura.comprobanteAdjunto).toBeNull();
  });

  it("una factura ya adjunta no se reemplaza", async () => {
    // El congelamiento de `orden_pago_transicion()` solo corre fuera de `pendiente` — mismo motivo
    // por el que la excepción de `comprobante_adjunto` tampoco aplicaría dentro de `pendiente`.
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);
    await como(arbol.usuarios.adminBarrioA1, (tx) => aprobarOrdenPago(tx, { ordenPagoId: opId }));
    await como(arbol.usuarios.operadorA1, (tx) =>
      adjuntarFacturaDeOP(tx, { ordenPagoId: opId, storageKey: claveFacturaValida(opId) }),
    );

    await expect(
      conIdentidadCruda(arbol.usuarios.operadorA1, (cliente) =>
        cliente.query("update orden_pago set factura_adjunta = $1 where id = $2", [
          `barrios/${arbol.barrioA1.id}/ordenes-pago/${opId}/factura/ZzYyXxWwVvUuTtSsRrQqPpOo.pdf`,
          opId,
        ]),
      ),
    ).rejects.toThrow(/la factura ya adjunta no se reemplaza/);
  });

  it("marcarFacturaNoDisponibleDeOP() exige motivo — lo hace cumplir el propio Zod", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);

    await expect(
      como(arbol.usuarios.operadorA1, (tx) =>
        marcarFacturaNoDisponibleDeOP(tx, { ordenPagoId: opId, motivo: "" }),
      ),
    ).rejects.toThrow();
  });

  it("el CHECK de exclusión mutua rechaza facturaNoDisponible=true con factura_adjunta no nulo", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);
    await como(arbol.usuarios.operadorA1, (tx) =>
      adjuntarFacturaDeOP(tx, { ordenPagoId: opId, storageKey: claveFacturaValida(opId) }),
    );

    // Directo por SQL, salteando el servicio a propósito: el candado tiene que vivir en el CHECK,
    // no en `marcarFacturaNoDisponibleDeOP()` — así no importa qué código escriba la fila.
    await expect(
      conIdentidadCruda(arbol.usuarios.operadorA1, (cliente) =>
        cliente.query(
          "update orden_pago set factura_no_disponible = true, motivo_factura_no_disponible = $1 where id = $2",
          ["nunca va a llegar", opId],
        ),
      ),
    ).rejects.toThrow(/orden_pago_factura_exclusiva_chk/);
  });

  it("marcarFacturaNoDisponibleDeOP() limpia una factura ya adjunta (saneado, dirección 1)", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);
    await como(arbol.usuarios.operadorA1, (tx) =>
      adjuntarFacturaDeOP(tx, { ordenPagoId: opId, storageKey: claveFacturaValida(opId) }),
    );

    const marcada = await como(arbol.usuarios.operadorA1, (tx) =>
      marcarFacturaNoDisponibleDeOP(tx, { ordenPagoId: opId, motivo: "Proveedor informal, sin CUIT" }),
    );
    expect(marcada.facturaAdjunta).toBeNull();
    expect(marcada.facturaNoDisponible).toBe(true);
    expect(marcada.motivoFacturaNoDisponible).toBe("Proveedor informal, sin CUIT");
  });

  it("adjuntarFacturaDeOP() limpia facturaNoDisponible/motivo ya marcados (saneado, dirección 2)", async () => {
    const periodoId = await crearPeriodo("borrador");
    const opId = await crearOrdenPago(arbol.usuarios.operadorA1, periodoId);
    await como(arbol.usuarios.operadorA1, (tx) =>
      marcarFacturaNoDisponibleDeOP(tx, { ordenPagoId: opId, motivo: "Se creía que no iba a llegar" }),
    );

    const adjuntada = await como(arbol.usuarios.operadorA1, (tx) =>
      adjuntarFacturaDeOP(tx, { ordenPagoId: opId, storageKey: claveFacturaValida(opId) }),
    );
    expect(adjuntada.facturaAdjunta).toBe(claveFacturaValida(opId));
    expect(adjuntada.facturaNoDisponible).toBe(false);
    expect(adjuntada.motivoFacturaNoDisponible).toBeNull();
  });
});
