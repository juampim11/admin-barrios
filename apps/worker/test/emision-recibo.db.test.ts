/**
 * `reservarNumeroDeRecibo()` / `registrarReciboEmitido()` / `reciboYaEmitido()`
 * (`@admin-barrios/data/servicios/documentos`) — el paso 1 y el paso 4 de `emitirReciboDePago()`
 * (`../src/emision-recibo.ts`), ejercitados a través de `conUsuario()` con una conexión de request
 * REAL (`app_request`, sujeta a RLS) y un usuario con membresía real — el mismo par
 * (conexión, identidad) que `ctx.db`/`trabajo.solicitadoPor` en el handler de verdad.
 *
 * **No es una llamada SQL aislada.** `app.reservar_numero_recibo()` (migración `0042`) se ejecuta con
 * `grant execute ... to app_request`, y el `insert` de `registrarReciboEmitido()` nombra
 * `numero_recibo` explícito contra el grant de columna que la migración `0042` ensanchó (`0039`
 * grant original no la incluía). Los dos son grants que solo se validan de verdad bajo el rol
 * `app_request` — una consulta con la conexión de administración (dueño del esquema) los pasaría
 * igual sin decir nada del caso real. Por eso este archivo usa `crearPoolRequest`/`crearDbRequest`,
 * no la de administración, para la parte que ejercita.
 *
 * Correr con: pnpm vitest run --project db apps/worker/test/emision-recibo.db.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { conUsuario, crearDbRequest, crearPoolRequest, type DbRequest } from "@admin-barrios/data/client";
import { registrarPago } from "@admin-barrios/data/servicios/pagos";
import {
  reciboYaEmitido,
  registrarReciboEmitido,
  reservarNumeroDeRecibo,
} from "@admin-barrios/data/servicios/documentos";

let admin: pg.Pool;
let poolRequest: pg.Pool;
let dbRequest: DbRequest;
let adminNodeId: string;
let barrioId: string;
let unidadId: string;
let operadorId: string;

const como = <T>(fn: (tx: DbRequest) => Promise<T>): Promise<T> => conUsuario(dbRequest, operadorId, fn);

function comprobanteValido(): string {
  return `barrios/${barrioId}/pagos/comprobantes/${randomUUID().replace(/-/g, "")}.pdf`;
}

async function crearPago(monto = "1000.00"): Promise<string> {
  const pago = await como((tx) =>
    registrarPago(tx, {
      unidadFuncionalId: unidadId,
      obligadoId: null,
      monto,
      fecha: "2052-01-10",
      origen: "manual",
      comprobanteAdjunto: comprobanteValido(),
    }),
  );
  return pago.id;
}

beforeAll(async () => {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("Falta DATABASE_URL: los tests de base necesitan `pnpm db:up` y un .env");
  admin = new pg.Pool({ connectionString: url, max: 4 });
  poolRequest = crearPoolRequest();
  dbRequest = crearDbRequest(poolRequest);

  // `tenant_node_root_chk`: todo nodo que no sea `administrador` necesita `parent_id`.
  const raiz = await admin.query<{ id: string }>(
    "insert into tenant_node (tipo, nombre) values ('administrador', 'Estudio de prueba (recibos)') returning id",
  );
  adminNodeId = raiz.rows[0]?.id ?? "";
  if (!adminNodeId) throw new Error("no se pudo crear el nodo administrador de prueba");

  const nodo = await admin.query<{ id: string }>(
    "insert into tenant_node (tipo, nombre, parent_id) values ('barrio', 'Reserva de recibos', $1) returning id",
    [adminNodeId],
  );
  barrioId = nodo.rows[0]?.id ?? "";
  if (!barrioId) throw new Error("no se pudo crear el barrio de prueba");
  await admin.query(
    `insert into barrio (barrio_id, figura_juridica, adecuado_art_2075, encuadre_urbanistico,
                         municipio, servicios_internos_a_cargo_de)
     values ($1, 'ph_especial', 'en_tramite', 'ure', 'villa-allende', 'urbanizacion')`,
    [barrioId],
  );
  const uf = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
     values ($1, '1', '1', 'construido') returning id`,
    [barrioId],
  );
  unidadId = uf.rows[0]?.id ?? "";
  if (!unidadId) throw new Error("no se pudo crear la unidad de prueba");

  // `operador` está en `ROLES_QUE_EMITEN` — el mismo rol que necesita `armarVistaDeRecibo()`/
  // `emitirReciboDePago()` para emitir. Se crea acá, no en `beforeAll` de arriba, porque la
  // membresía necesita el `barrioId` recién creado.
  operadorId = randomUUID();
  await admin.query("insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'operador')", [
    operadorId,
    barrioId,
  ]);
});

afterEach(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from recibo_emitido where barrio_id = $1", [barrioId]);
  await admin.query("delete from recibo_secuencia where barrio_id = $1", [barrioId]);
  await admin.query("delete from pago where barrio_id = $1", [barrioId]);
  await admin.query("set session_replication_role = origin");
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from unidad_funcional where barrio_id = $1", [barrioId]);
  await admin.query("delete from membership where tenant_node_id = $1", [barrioId]);
  await admin.query("delete from barrio where barrio_id = $1", [barrioId]);
  await admin.query("set session_replication_role = origin");
  await admin.query("delete from tenant_node where id = $1", [barrioId]);
  await admin.query("delete from tenant_node where id = $1", [adminNodeId]);
  await Promise.all([admin.end(), poolRequest.end()]);
});

describe("reservarNumeroDeRecibo() bajo conUsuario, con la conexión y el rol reales", () => {
  it("reserva números crecientes para el mismo barrio", async () => {
    const pagoId = await crearPago();

    const primero = await como((tx) => reservarNumeroDeRecibo(tx, pagoId));
    const segundo = await como((tx) => reservarNumeroDeRecibo(tx, pagoId));

    expect(Number(segundo)).toBe(Number(primero) + 1);
  });
});

describe("reciboYaEmitido() / registrarReciboEmitido() — el flujo completo del paso 1 y el paso 4", () => {
  it("es null antes de emitir, y registrarReciboEmitido() respeta el número YA reservado (no lo reasigna)", async () => {
    const pagoId = await crearPago();

    expect(await como((tx) => reciboYaEmitido(tx, pagoId))).toBeNull();

    const numeroReservado = await como((tx) => reservarNumeroDeRecibo(tx, pagoId));

    const reciboId = await como((tx) =>
      registrarReciboEmitido(tx, {
        barrioId,
        pagoId,
        numeroRecibo: numeroReservado,
        storageKey: `barrios/${barrioId}/pagos/${pagoId}/recibos/${randomUUID().replace(/-/g, "")}.pdf`,
        sha256: "a".repeat(64),
        bytes: 500,
        vista: {},
        vistaVersion: "recibo/1",
        motor: "prueba/1",
        plantillaHash: "b".repeat(64),
      }),
    );

    const { rows } = await admin.query<{ numero_recibo: string }>(
      "select numero_recibo::text from recibo_emitido where id = $1",
      [reciboId],
    );
    // La aserción central: el trigger `app.recibo_antes()` (0042) tenía que RESPETAR el número
    // reservado en el paso 1, no reasignar uno propio — si lo reasignara, este número no coincidiría.
    expect(rows[0]?.numero_recibo).toBe(numeroReservado);

    const existente = await como((tx) => reciboYaEmitido(tx, pagoId));
    expect(existente?.id).toBe(reciboId);
  });
});
