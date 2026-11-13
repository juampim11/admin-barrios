/**
 * Encargo 14, contra Postgres real:
 *  - BL-035 a: una boleta por liquidación y un informe por período (`0075`), y que el registro del
 *    segundo vuelva «ya estaba» en vez de duplicar o romper.
 *  - BL-035 b: la espera de los botones de Envío, verificada en el servidor.
 *  - BL-033 del titular: quién abrió el período (`0076`), escrito por la base y fijo.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { sql } from "drizzle-orm";
import { claveDeDocumento, nuevoToken } from "@admin-barrios/almacenamiento";
import { esErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { puedeBajarLosPdfDelPeriodo, registrarDocumentoEmitido } from "../src/servicios/documentos.ts";
import { aQueEspera, exigirQueNingunOtroPasoCorra, type Trabajo } from "../src/servicios/trabajos.ts";
import { borrarArbol, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let barrioId: string;
let periodoId: string;

/** Un período en borrador, abierto por quien se indique (el trigger escribe `abierto_por`). */
async function abrirPeriodo(periodo: string, comoUsuario: string): Promise<string> {
  return conUsuario(db, comoUsuario, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(
      sql`insert into periodo_expensa (barrio_id, periodo) values (${barrioId}, ${periodo}) returning id`,
    );
    return rows[0]!.id;
  });
}

/**
 * Inserta filas **salteando los triggers** (`session_replication_role = replica`, solo el dueño de la
 * base): un trabajo `corriendo` o un documento de boleta sin armar una emisión entera. Las FK también
 * son triggers y no corren; los índices únicos sí, que es lo que se prueba.
 */
async function comoReplica(consulta: string, valores: unknown[]): Promise<void> {
  const cliente = await admin.connect();
  try {
    await cliente.query("begin");
    await cliente.query("set local session_replication_role = replica");
    await cliente.query(consulta, valores);
    await cliente.query("commit");
  } catch (e) {
    await cliente.query("rollback");
    throw e;
  } finally {
    cliente.release();
  }
}

const documento = (tipo: "boleta_unidad" | "informe_mensual", liquidacionId: string | null) => ({
  barrioId,
  periodoId,
  tipo,
  liquidacionId,
  storageKey: claveDeDocumento({ barrioId, periodoId, tipo, token: nuevoToken() }),
  sha256: "a".repeat(64),
  bytes: 1000,
  vista: {},
  vistaVersion: "prueba/1",
  motor: "prueba/1",
  plantillaHash: "b".repeat(64),
  medioCobranza: "no_aplica",
});

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  barrioId = arbol.barrioA1.id;
  await crearBarrio(admin, barrioId);
  periodoId = await abrirPeriodo("2026-01", arbol.usuarios.adminBarrioA1);
});

afterAll(async () => {
  for (const tabla of ["trabajo", "documento_emitido", "periodo_expensa", "barrio_atributo_vigencia", "barrio"]) {
    await comoReplica(`delete from ${tabla} where barrio_id = $1`, [barrioId]);
  }
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("un documento por boleta y un informe por período (BL-035 a, 0075)", () => {
  it("el segundo informe del mismo período vuelve `null` y no deja una segunda fila", async () => {
    const primero = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      registrarDocumentoEmitido(tx, documento("informe_mensual", null)),
    );
    const segundo = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      registrarDocumentoEmitido(tx, documento("informe_mensual", null)),
    );

    expect(primero).not.toBeNull();
    expect(segundo).toBeNull();
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from documento_emitido where periodo_id = $1 and tipo = 'informe_mensual'",
      [periodoId],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("un choque que no es el de `0075` (la misma clave en otro mes) no se toma por «ya estaba»", async () => {
    // Sin la hermana que justifica el conflicto, el worker contaría como emitido un documento sin fila.
    const otroPeriodo = await abrirPeriodo("2026-03", arbol.usuarios.adminBarrioA1);
    const { rows } = await admin.query<{ storage_key: string }>(
      "select storage_key from documento_emitido where periodo_id = $1 and tipo = 'informe_mensual'",
      [periodoId],
    );
    const repetida = { ...documento("informe_mensual", null), periodoId: otroPeriodo, storageKey: rows[0]!.storage_key };
    const error = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => registrarDocumentoEmitido(tx, repetida)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(esErrorDeNegocio(error), String(error)).toBe(true);
  });

  it("la base no acepta dos boletas de la misma liquidación", async () => {
    const liquidacionId = randomUUID();
    const insertar = `insert into documento_emitido
        (barrio_id, periodo_id, tipo, liquidacion_id, storage_key, sha256, bytes, vista,
         vista_version, motor, plantilla_hash, medio_cobranza, emitido_por)
      values ($1, $2, 'boleta_unidad', $3, $4, repeat('a', 64), 1000, '{}'::jsonb,
              'prueba/1', 'prueba/1', repeat('b', 64), 'generico-demo', $5)`;
    const clave = () => claveDeDocumento({ barrioId, periodoId, tipo: "boleta_unidad", token: nuevoToken() });
    const usuario = arbol.usuarios.adminBarrioA1;

    await comoReplica(insertar, [barrioId, periodoId, liquidacionId, clave(), usuario]);
    await expect(comoReplica(insertar, [barrioId, periodoId, liquidacionId, clave(), usuario])).rejects.toMatchObject({
      code: "23505",
      constraint: "uq_documento_boleta_por_liquidacion",
    });
    // Otra liquidación del mismo período, sí.
    await comoReplica(insertar, [barrioId, periodoId, randomUUID(), clave(), usuario]);
  });
});

describe("quién ve los enlaces de los PDF: los mismos roles que el paquete", () => {
  it("la administración del barrio sí; operador, contador y auditor no", async () => {
    const puede = (usuario: string) => conUsuario(db, usuario, (tx) => puedeBajarLosPdfDelPeriodo(tx, { periodoId }));
    expect(await puede(arbol.usuarios.adminBarrioA1)).toBe(true);
    expect(await puede(arbol.usuarios.operadorA1)).toBe(false);
    expect(await puede(arbol.usuarios.contadorA1)).toBe(false);
    expect(await puede(arbol.usuarios.auditorA1)).toBe(false);
    // De otro estudio: el período ni se ve.
    expect(await puede(arbol.usuarios.adminEstudioB)).toBe(false);
  });
});

describe("la espera de Envío, en el servidor (BL-035 b)", () => {
  const trabajo = (estado: Trabajo["estado"], sinLatido = false): Trabajo => ({
    id: randomUUID(),
    estado,
    hechos: 0,
    total: null,
    solicitadoAt: "",
    iniciadoAt: null,
    terminadoAt: null,
    error: null,
    sinLatido,
    demorado: false,
  });

  it("la regla: espera a otro paso que corre de verdad, nunca a uno en cola o interrumpido, ni a sí mismo", () => {
    expect(aQueEspera({ armar_paquete_periodo: trabajo("corriendo") }, "emitir_informe_periodo")).toBe(
      "Esperá a que termine el paquete.",
    );
    expect(aQueEspera({ armar_paquete_periodo: trabajo("encolado") }, "emitir_informe_periodo")).toBeNull();
    expect(aQueEspera({ armar_paquete_periodo: trabajo("corriendo", true) }, "emitir_informe_periodo")).toBeNull();
    expect(aQueEspera({ armar_paquete_periodo: trabajo("corriendo") }, "armar_paquete_periodo")).toBeNull();
  });

  const sembrarTrabajo = (tipo: string, latido: string) =>
    comoReplica(
      `insert into trabajo (barrio_id, tipo, referencia_id, estado, solicitado_por, iniciado_at, latido_at)
       values ($1, $2, $3, 'corriendo', $4, now(), ${latido})`,
      [barrioId, tipo, periodoId, arbol.usuarios.adminBarrioA1],
    );

  it("con el informe corriendo y latiendo, pedir el paquete se rechaza con `paso_en_espera`", async () => {
    await sembrarTrabajo("emitir_informe_periodo", "now()");
    const error = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      exigirQueNingunOtroPasoCorra(tx, { periodoId, tipo: "armar_paquete_periodo" }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(esErrorDeNegocio(error), String(error)).toBe(true);
    if (esErrorDeNegocio(error)) {
      expect(error.codigo).toBe("paso_en_espera");
      expect(error.message).toBe("Esperá a que termine el informe.");
    }
    await comoReplica("delete from trabajo where referencia_id = $1", [periodoId]);
  });

  it("si el informe dejó de latir (el proceso murió), no hace esperar a nadie", async () => {
    await sembrarTrabajo("emitir_informe_periodo", "now() - interval '5 minutes'");
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        exigirQueNingunOtroPasoCorra(tx, { periodoId, tipo: "armar_paquete_periodo" }),
      ),
    ).resolves.toBeUndefined();
    await comoReplica("delete from trabajo where referencia_id = $1", [periodoId]);
  });
});

describe("quién abrió el período (BL-033 del titular, 0076)", () => {
  it("lo escribe la base con quien inserta, aunque el insert diga otro", async () => {
    const { rows } = await admin.query<{ abierto_por: string | null }>(
      "select abierto_por from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(rows[0]?.abierto_por).toBe(arbol.usuarios.adminBarrioA1);

    const otro = await conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
      const r = await tx.execute<{ abierto_por: string }>(sql`
        insert into periodo_expensa (barrio_id, periodo, abierto_por)
        values (${barrioId}, '2026-02', ${arbol.usuarios.operadorA1}) returning abierto_por`);
      return r.rows[0]!.abierto_por;
    });
    expect(otro).toBe(arbol.usuarios.adminBarrioA1);
  });

  it("no se cambia después", async () => {
    await expect(
      admin.query("update periodo_expensa set abierto_por = $1 where id = $2", [arbol.usuarios.operadorA1, periodoId]),
    ).rejects.toThrow(/quién abrió el período no se cambia/);
  });
});
