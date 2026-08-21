/**
 * `tomarTrabajo()` — el tope de reintentos manuales (`MAX_INTENTOS_TRABAJO`,
 * `packages/shared/src/trabajos.ts`).
 *
 * Corre contra Postgres real con la conexión BYPASSRLS (`DbJob`) — la misma que usa `cola.ts` en
 * producción; ningún doble de prueba la reproduce sin mentir sobre lo que se está probando (mismo
 * criterio que `packages/data/test/recibos.test.ts`).
 *
 * **Por qué el tope cuenta el histórico y no `trabajo.intento` de una sola fila**: un reencolado
 * manual inserta una fila NUEVA (con `intento` en 0 otra vez — `uq_trabajo_pendiente` solo bloquea
 * mientras hay una fila `encolado`/`corriendo`), así que el contador por-fila nunca ve el historial
 * completo de reintentos de un mismo `(referencia_id, tipo)`. Este archivo siembra ese historial a
 * mano —varias filas `fallado` más una `encolado`— para probar exactamente ese caso.
 *
 * **Por qué cada fila necesita un `pago` real**: `app.trabajo_antes_insert()` (`0027`/`0039`)
 * DERIVA `barrio_id` de `referencia_id` (`select barrio_id from pago where id = referencia_id`
 * para `emitir_recibo_pago`) y rechaza el insert si no encuentra nada — `referencia_id` no tiene FK
 * (el tipo decide a qué apunta), pero el trigger sí exige que exista. Y fuerza `estado = 'encolado'`
 * en TODO insert, así que una fila `fallado` de prueba se arma insertando y recién después
 * actualizando el estado a mano (lo mismo que hace el worker de verdad al terminar un trabajo).
 *
 * Correr con: pnpm vitest run --project db apps/worker/test/cola.db.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  conUsuario,
  crearDbJob,
  crearDbRequest,
  crearPoolJob,
  crearPoolRequest,
  type DbJob,
  type DbRequest,
} from "@admin-barrios/data/client";
import { registrarPago } from "@admin-barrios/data/servicios/pagos";
import { MAX_INTENTOS_TRABAJO } from "@admin-barrios/shared/trabajos";
import { tomarTrabajo, type TipoTrabajo } from "../src/servidor/cola.ts";

let admin: pg.Pool;
let poolCola: pg.Pool;
let dbCola: DbJob;
let poolRequest: pg.Pool;
let dbRequest: DbRequest;
let adminNodeId: string;
let barrioId: string;
let unidadId: string;
let operadorId: string;

beforeAll(async () => {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("Falta DATABASE_URL: los tests de base necesitan `pnpm db:up` y un .env");
  admin = new pg.Pool({ connectionString: url, max: 4 });
  poolCola = crearPoolJob();
  dbCola = crearDbJob(poolCola);
  poolRequest = crearPoolRequest();
  dbRequest = crearDbRequest(poolRequest);

  // `tenant_node_root_chk`: todo nodo que no sea `administrador` necesita `parent_id`.
  const raiz = await admin.query<{ id: string }>(
    "insert into tenant_node (tipo, nombre) values ('administrador', 'Estudio de prueba (cola)') returning id",
  );
  adminNodeId = raiz.rows[0]?.id ?? "";
  if (!adminNodeId) throw new Error("no se pudo crear el nodo administrador de prueba");

  const nodo = await admin.query<{ id: string }>(
    "insert into tenant_node (tipo, nombre, parent_id) values ('barrio', 'Tope de reintentos', $1) returning id",
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

  operadorId = randomUUID();
  await admin.query("insert into membership (user_id, tenant_node_id, rol) values ($1, $2, 'operador')", [
    operadorId,
    barrioId,
  ]);
});

afterEach(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from trabajo where barrio_id = $1", [barrioId]);
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
  await Promise.all([admin.end(), poolCola.end(), poolRequest.end()]);
});

async function crearPagoDePrueba(): Promise<string> {
  const pago = await conUsuario(dbRequest, operadorId, (tx) =>
    registrarPago(tx, {
      unidadFuncionalId: unidadId,
      obligadoId: null,
      monto: "1000.00",
      fecha: "2052-01-10",
      origen: "manual",
      comprobanteAdjunto: `barrios/${barrioId}/pagos/comprobantes/${randomUUID().replace(/-/g, "")}.pdf`,
    }),
  );
  return pago.id;
}

/** Siembra una fila de `trabajo` real (vía `admin` + `set_config`, mismo patrón que `sembrarRecibo()`
 *  en `packages/data/test/recibos.test.ts`) y, si hace falta, la marca `fallado` DESPUÉS: el trigger
 *  de insert fuerza `estado = 'encolado'` sin importar lo que se mande. */
async function sembrarTrabajo(estado: "fallado" | "encolado", referenciaId: string, tipo: TipoTrabajo = "emitir_recibo_pago"): Promise<string> {
  const cliente = await admin.connect();
  let id: string;
  try {
    await cliente.query("begin");
    await cliente.query("select set_config('app.user_id', $1, true)", [operadorId]);
    const { rows } = await cliente.query<{ id: string }>(
      "insert into trabajo (tipo, referencia_id) values ($1, $2) returning id",
      [tipo, referenciaId],
    );
    const fila = rows[0];
    if (!fila) throw new Error("no se pudo sembrar el trabajo de prueba");
    id = fila.id;
    await cliente.query("commit");
  } catch (e) {
    await cliente.query("rollback");
    throw e;
  } finally {
    cliente.release();
  }

  if (estado === "fallado") {
    // `trg_trabajo_alcance_inmutable` (0027) no protege `estado`/`terminado_at`/`error` — es
    // exactamente lo que hace `terminarTrabajo()` (`cola.ts`) al cerrar un trabajo de verdad.
    await admin.query(
      "update trabajo set estado = 'fallado', terminado_at = now(), error = 'fallo de prueba' where id = $1",
      [id],
    );
  }
  return id;
}

describe("tomarTrabajo() — tope de reintentos manuales", () => {
  it(`no toma un trabajo cuyo (referencia, tipo) ya acumuló más de ${MAX_INTENTOS_TRABAJO} filas históricas, y lo marca fallado`, async () => {
    const pagoId = await crearPagoDePrueba();
    for (let i = 0; i < MAX_INTENTOS_TRABAJO; i++) {
      await sembrarTrabajo("fallado", pagoId);
    }
    const sobreElTope = await sembrarTrabajo("encolado", pagoId);

    const tomado = await tomarTrabajo(dbCola);
    expect(tomado).toBeNull();

    const { rows } = await admin.query<{ estado: string; error: string | null }>(
      "select estado, error from trabajo where id = $1",
      [sobreElTope],
    );
    expect(rows[0]?.estado).toBe("fallado");
    expect(rows[0]?.error).toContain(`${MAX_INTENTOS_TRABAJO}`);
  });

  it(`toma normalmente un trabajo con exactamente ${MAX_INTENTOS_TRABAJO} filas históricas en total (no está POR ENCIMA del tope)`, async () => {
    const pagoId = await crearPagoDePrueba();
    for (let i = 0; i < MAX_INTENTOS_TRABAJO - 1; i++) {
      await sembrarTrabajo("fallado", pagoId);
    }
    const enElTope = await sembrarTrabajo("encolado", pagoId);

    const tomado = await tomarTrabajo(dbCola);
    expect(tomado?.id).toBe(enElTope);
    expect(tomado?.intento).toBe(1);
  });

  it("un trabajo sobre el tope no bloquea a otro trabajo encolado detrás en la misma pasada", async () => {
    const pagoAgotado = await crearPagoDePrueba();
    for (let i = 0; i < MAX_INTENTOS_TRABAJO; i++) {
      await sembrarTrabajo("fallado", pagoAgotado);
    }
    await sembrarTrabajo("encolado", pagoAgotado);

    const pagoSano = await crearPagoDePrueba();
    const trabajoSano = await sembrarTrabajo("encolado", pagoSano);

    const tomado = await tomarTrabajo(dbCola);
    expect(tomado?.id).toBe(trabajoSano);
  });
});
