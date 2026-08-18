/**
 * El recibo de un pago: encolar su emisión (`encolarEmisionDeRecibo`, `cobros.ts`) y descargarlo una
 * vez emitido (`prepararDescargaDeRecibo`, `documentos.ts`).
 *
 * El motor que RENDERIZA el PDF del recibo es trabajo posterior (fuera de esta tanda, ver
 * `0039_recibos_reglas.sql`), así que acá no hay worker: los `recibo_emitido` de prueba se siembran
 * directo, con la identidad de quien puede emitir en ese barrio — mismo patrón que
 * `documentos-rls.test.ts` siembra `documento_emitido`.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/recibos.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { registrarPago, anularPago } from "../src/servicios/pagos.ts";
import { encolarEmisionDeRecibo } from "../src/servicios/cobros.ts";
import { prepararDescargaDeRecibo } from "../src/servicios/documentos.ts";
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

async function crearPago(unidadId: string, comoUsuario: string, barrioId: string, monto = "1000.00"): Promise<string> {
  const pago = await conUsuario(db, comoUsuario, (tx) =>
    registrarPago(tx, {
      unidadFuncionalId: unidadId,
      obligadoId: null,
      monto,
      fecha: "2052-01-10",
      origen: "manual",
      comprobanteAdjunto: comprobanteValido(barrioId),
    }),
  );
  return pago.id;
}

/**
 * Siembra un `recibo_emitido` con la identidad de alguien que puede emitir en ese barrio — el trigger
 * `app.recibo_antes()` deriva `barrio_id`/`numero_recibo`/`emitido_por`/`emitido_at`, así que estas
 * columnas no se mandan (el trigger las pisaría igual).
 */
let tokens = 0;
async function sembrarRecibo(pool: pg.Pool, d: { pagoId: string; barrioId: string; comoUsuario: string }): Promise<{ id: string }> {
  tokens += 1;
  const storageKey = `barrios/${d.barrioId}/pagos/${d.pagoId}/recibos/AbCdEfGhIjKlMnOpQrStU${tokens}.pdf`;
  const cliente = await pool.connect();
  try {
    await cliente.query("begin");
    await cliente.query("select set_config('app.user_id', $1, true)", [d.comoUsuario]);
    const { rows } = await cliente.query<{ id: string }>(
      `insert into recibo_emitido (pago_id, storage_key, sha256, bytes, vista, vista_version, motor, plantilla_hash)
       values ($1, $2, repeat('a', 64), 500, '{}'::jsonb, 'recibo/1', 'prueba/1', repeat('b', 64))
       returning id`,
      [d.pagoId, storageKey],
    );
    await cliente.query("commit");
    const id = rows[0]?.id;
    if (!id) throw new Error("no se pudo sembrar el recibo de prueba");
    return { id };
  } catch (e) {
    await cliente.query("rollback");
    throw e;
  } finally {
    cliente.release();
  }
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioB1.id);
  unidadA1 = (await crearUnidades(admin, arbol.barrioA1.id, 1))[0] as string;
  unidadB1 = (await crearUnidades(admin, arbol.barrioB1.id, 1))[0] as string;
});

// Por test: cada `it()` de acá crea su propio pago (y a veces su propio recibo/trabajo), y dejarlos
// entre tests haría que `uq_trabajo_pendiente` rebotara un `it()` por lo que dejó otro.
afterEach(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from trabajo where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  for (const t of ["descarga_documento", "recibo_emitido"]) {
    await admin.query(`alter table ${t} disable trigger user`);
    await admin.query(`delete from ${t}`);
    await admin.query(`alter table ${t} enable trigger user`);
  }
  await admin.query("delete from recibo_secuencia where barrio_id = any($1::uuid[])", [
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

describe("encolarEmisionDeRecibo()", () => {
  it("encola contra un pago válido", async () => {
    const pagoId = await crearPago(unidadA1, arbol.usuarios.operadorA1, arbol.barrioA1.id);
    const trabajo = await como(arbol.usuarios.operadorA1, (tx) => encolarEmisionDeRecibo(tx, { pagoId }));
    expect(trabajo.estado).toBe("encolado");
  });

  it("rechaza contra un pago anulado", async () => {
    const pagoId = await crearPago(unidadA1, arbol.usuarios.operadorA1, arbol.barrioA1.id);
    await como(arbol.usuarios.operadorA1, (tx) => anularPago(tx, { pagoId, motivo: "Se cargó por error" }));

    const err = await capturar(() => como(arbol.usuarios.operadorA1, (tx) => encolarEmisionDeRecibo(tx, { pagoId })));
    expect(err.codigo).toBe("pago_ya_anulado");
  });

  it("rechaza un pago de otro barrio con el MISMO criterio que uno inexistente (sin oráculo)", async () => {
    const pagoB1 = await crearPago(unidadB1, arbol.usuarios.adminEstudioB, arbol.barrioB1.id);

    const errAjeno = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) => encolarEmisionDeRecibo(tx, { pagoId: pagoB1 })),
    );
    expect(errAjeno.codigo).toBe("pago_no_encontrado");

    const errInexistente = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        encolarEmisionDeRecibo(tx, { pagoId: "00000000-0000-4000-8000-000000000000" }),
      ),
    );
    expect(errInexistente.codigo).toBe("pago_no_encontrado");
    expect(errInexistente.message).toBe(errAjeno.message);
  });

  it("rebota con `trabajo_ya_encolado` si ya hay un trabajo pendiente para ese pago", async () => {
    const pagoId = await crearPago(unidadA1, arbol.usuarios.operadorA1, arbol.barrioA1.id);
    await como(arbol.usuarios.operadorA1, (tx) => encolarEmisionDeRecibo(tx, { pagoId }));

    const err = await capturar(() => como(arbol.usuarios.operadorA1, (tx) => encolarEmisionDeRecibo(tx, { pagoId })));
    expect(err.codigo).toBe("trabajo_ya_encolado");
  });
});

describe("prepararDescargaDeRecibo()", () => {
  it("un recibo propio devuelve la clave, con el nombre por número de recibo, y deja el registro escrito", async () => {
    const pagoId = await crearPago(unidadA1, arbol.usuarios.operadorA1, arbol.barrioA1.id);
    const recibo = await sembrarRecibo(admin, {
      pagoId,
      barrioId: arbol.barrioA1.id,
      comoUsuario: arbol.usuarios.adminBarrioA1,
    });

    const preparada = await como(arbol.usuarios.operadorA1, (tx) =>
      prepararDescargaDeRecibo(tx, { reciboId: recibo.id, ttlSegundos: 90 }),
    );
    expect(preparada.storageKey).toContain(`barrios/${arbol.barrioA1.id}/pagos/${pagoId}/recibos/`);
    expect(preparada.nombreArchivo).toMatch(/^Recibo-\d+\.pdf$/);

    const { rows } = await admin.query<{ solicitado_por: string; ttl_segundos: number }>(
      "select solicitado_por, ttl_segundos from descarga_documento where recibo_emitido_id = $1",
      [recibo.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.solicitado_por).toBe(arbol.usuarios.operadorA1);
    expect(rows[0]?.ttl_segundos).toBe(90);
  });

  it("un recibo de otro barrio da el MISMO rechazo que uno inexistente (sin oráculo), y no deja registro", async () => {
    const pagoB1 = await crearPago(unidadB1, arbol.usuarios.adminEstudioB, arbol.barrioB1.id);
    const reciboB1 = await sembrarRecibo(admin, {
      pagoId: pagoB1,
      barrioId: arbol.barrioB1.id,
      comoUsuario: arbol.usuarios.adminEstudioB,
    });

    const errAjeno = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) => prepararDescargaDeRecibo(tx, { reciboId: reciboB1.id, ttlSegundos: 90 })),
    );
    expect(errAjeno.codigo).toBe("recibo_no_encontrado");

    const errInexistente = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        prepararDescargaDeRecibo(tx, { reciboId: "00000000-0000-4000-8000-0000000000ff", ttlSegundos: 90 }),
      ),
    );
    expect(errInexistente.codigo).toBe("recibo_no_encontrado");
    expect(errInexistente.message).toBe(errAjeno.message);

    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from descarga_documento where recibo_emitido_id = $1",
      [reciboB1.id],
    );
    expect(rows[0]?.n).toBe("0");
  });
});
