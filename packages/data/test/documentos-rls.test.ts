/**
 * Los controles que, si se olvidan, convierten la descarga de documentos en una filtración.
 *
 * Salieron del modelado de amenazas que se hizo **antes** de escribir la tanda C. Cada uno tiene su
 * nombre en el título, para que el día que uno falle se entienda qué se rompió sin leer el código.
 *
 * El escenario de fondo es siempre el mismo y es el que importa: **la credencial con la que la
 * aplicación firma URLs alcanza al bucket entero.** Presignar no consulta a nadie, se calcula
 * localmente. Lo único entre "la boleta de esta unidad" y "todas las boletas de todos los barrios"
 * son estas policies.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { conUsuario } from "../src/client.ts";
import { prepararDescarga } from "../src/servicios/documentos.ts";
import { SUFIJO_PATRON_CLAVE, claveDeDocumento, revisarClave } from "@admin-barrios/almacenamiento";
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
import type pg from "pg";

const admin = poolAdmin();
const app = poolApp();
const db = dbDe(app);

let arbol: Arbol;
/** Un documento de cada tipo en A1, y uno en B1 (el barrio del "otro estudio"). */
let docs: { propioA1: string; listadoA1: string; ajenoB1: string; claveB1: string };

/**
 * Siembra un documento **con la identidad de alguien que puede emitir en ese barrio**, no salteando
 * los controles: el `emitido_por` lo escribe el trigger y la policy de `insert` se evalúa de verdad.
 * Es la forma de que el fixture no pruebe un camino que en producción no existe.
 *
 * Un token distinto por documento porque `storage_key` es único.
 */
let tokens = 0;
async function sembrarDocumento(
  pool: pg.Pool,
  d: { barrioId: string; periodoId: string; tipo: string; liquidacionId: string | null; comoUsuario: string },
): Promise<{ id: string; clave: string }> {
  tokens += 1;
  const clave = claveDeDocumento({
    barrioId: d.barrioId,
    periodoId: d.periodoId,
    tipo: d.tipo as "boleta_unidad",
    token: `AAAAAAAAAAAAAAAAAAAA${String(tokens).padStart(2, "0")}`,
  });
  const cliente = await pool.connect();
  try {
    await cliente.query("begin");
    await cliente.query("select set_config('app.user_id', $1, true)", [d.comoUsuario]);
    const { rows } = await cliente.query<{ id: string }>(
      `insert into documento_emitido
         (barrio_id, periodo_id, tipo, liquidacion_id, storage_key, sha256, bytes, vista,
          vista_version, motor, plantilla_hash, medio_cobranza, emitido_por)
       values ($1, $2, $3::app.tipo_documento, $4, $5, repeat('a', 64), 1000, '{}'::jsonb,
               'boleta/1', 'prueba/1', repeat('b', 64), 'generico-demo',
               '00000000-0000-4000-8000-000000000000')
       returning id`,
      [d.barrioId, d.periodoId, d.tipo, d.liquidacionId, clave],
    );
    await cliente.query("commit");
    const id = rows[0]?.id;
    if (!id) throw new Error("no se pudo sembrar el documento de prueba");
    return { id, clave };
  } catch (e) {
    await cliente.query("rollback");
    throw e;
  } finally {
    cliente.release();
  }
}

async function sembrarPeriodo(pool: pg.Pool, barrioId: string, periodo: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    // Nace en borrador: emitir es una transición, no un estado inicial (0013). Para estos tests da
    // igual — el gate de la descarga mira el **tipo de documento** y el barrio, nunca el estado del
    // período.
    `insert into periodo_expensa (barrio_id, periodo) values ($1, $2) returning id`,
    [barrioId, periodo],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no se pudo sembrar el período de prueba");
  return id;
}

beforeAll(async () => {
  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioB1.id);
  await crearUnidades(admin, arbol.barrioA1.id, 1);

  const periodoA1 = await sembrarPeriodo(admin, arbol.barrioA1.id, "2026-01");
  const periodoB1 = await sembrarPeriodo(admin, arbol.barrioB1.id, "2026-01");

  // Se usa el informe y no la boleta: la boleta exige `liquidacion_id` por el `check`, y armar una
  // liquidación completa no aporta nada a lo que estos tests verifican, que es el gate de acceso.
  const documentoDeA1 = await sembrarDocumento(admin, {
    barrioId: arbol.barrioA1.id,
    periodoId: periodoA1,
    tipo: "informe_mensual",
    liquidacionId: null,
    comoUsuario: arbol.usuarios.adminBarrioA1,
  });

  const listadoA1 = await sembrarDocumento(admin, {
    barrioId: arbol.barrioA1.id,
    periodoId: periodoA1,
    tipo: "listado_saldos_pendientes",
    liquidacionId: null,
    comoUsuario: arbol.usuarios.adminBarrioA1,
  });

  const enB1 = await sembrarDocumento(admin, {
    barrioId: arbol.barrioB1.id,
    periodoId: periodoB1,
    tipo: "informe_mensual",
    liquidacionId: null,
    comoUsuario: arbol.usuarios.adminEstudioB,
  });

  docs = {
    // `propio` / `ajeno` y no `boleta`: lo que se siembra es un informe mensual, y llamarlo boleta
    // haría creer que este archivo cubre un caso que no cubre.
    propioA1: documentoDeA1.id,
    listadoA1: listadoA1.id,
    ajenoB1: enB1.id,
    claveB1: enB1.clave,
  };
});

afterAll(async () => {
  // Las dos tablas son append-only por trigger, **también para el dueño del esquema**. Limpiar el
  // fixture exige apagarlo explícitamente: que borrar cueste un renglón de más es exactamente lo que
  // esa regla existe para lograr.
  for (const t of ["descarga_documento", "documento_emitido"]) {
    await admin.query(`alter table ${t} disable trigger user`);
    await admin.query(`delete from ${t}`);
    await admin.query(`alter table ${t} enable trigger user`);
  }
  await admin.query("delete from trabajo");
  await admin.query("delete from periodo_expensa where periodo in ('2026-01', '2026-02', '2026-03')");
  const barrios = [arbol.barrioA1.id, arbol.barrioB1.id];
  await admin.query("delete from unidad_funcional where barrio_id = any($1::uuid[])", [barrios]);
  await admin.query("delete from barrio_atributo_vigencia where barrio_id = any($1::uuid[])", [barrios]);
  await admin.query("delete from barrio where barrio_id = any($1::uuid[])", [
    [arbol.barrioA1.id, arbol.barrioB1.id],
  ]);
  await borrarArbol(admin, arbol);
  await admin.end();
  await app.end();
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// C1 — Ninguna clave sale de una fila que la RLS no dejó leer
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("C1 — la clave de almacenamiento solo sale de una fila leída bajo RLS", () => {
  it("un documento de otro estudio no devuelve clave: rechaza sin decir si existe", async () => {
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        prepararDescarga(tx, { documentoId: docs.ajenoB1, ttlSegundos: 90 }),
      ),
    ).rejects.toMatchObject({ codigo: "documento_no_encontrado" });
  });

  it("un documento que no existe da EXACTAMENTE el mismo rechazo: sin oráculo", async () => {
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        prepararDescarga(tx, {
          documentoId: "00000000-0000-4000-8000-0000000000ff",
          ttlSegundos: 90,
        }),
      ),
    ).rejects.toMatchObject({ codigo: "documento_no_encontrado" });
  });

  it("no queda registro de descarga cuando el documento no era accesible", async () => {
    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from descarga_documento where documento_id = $1",
      [docs.ajenoB1],
    );
    expect(rows[0]?.n).toBe("0");
  });

  it("el documento propio sí devuelve la clave, y deja el registro escrito ANTES de firmar", async () => {
    const preparada = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      prepararDescarga(tx, { documentoId: docs.propioA1, ttlSegundos: 90 }),
    );
    expect(preparada.storageKey).toContain(`barrios/${arbol.barrioA1.id}/`);
    // El nombre de archivo NO lleva el nombre de ninguna persona: viaja en el querystring de la URL
    // firmada, que va al log de acceso del proveedor igual que la clave.
    expect(preparada.nombreArchivo).toMatch(/^(Expensas|Informe|Saldos-pendientes)-2026-01/);

    const { rows } = await admin.query<{ solicitado_por: string; ttl_segundos: number }>(
      "select solicitado_por, ttl_segundos from descarga_documento where documento_id = $1",
      [docs.propioA1],
    );
    expect(rows).toHaveLength(1);
    // La escribe la base desde `app.current_user_id()`, no la aplicación.
    expect(rows[0]?.solicitado_por).toBe(arbol.usuarios.adminBarrioA1);
    expect(rows[0]?.ttl_segundos).toBe(90);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// C3 — El listado nominado no se le sirve a nadie fuera de admin_plataforma/admin_barrio
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("C3 — el gate por tipo de documento", () => {
  // El caso que importa es `auditor`: es el que HOY pasaría si la policy fuera la genérica del repo,
  // porque `app.readable_tenant_ids()` lo incluye.
  for (const rol of ["operadorA1", "contadorA1", "auditorA1"] as const) {
    it(`un ${rol.replace("A1", "")} no ve el listado de saldos pendientes`, async () => {
      const filas = await conUsuario(db, arbol.usuarios[rol], (tx) =>
        tx.execute<{ id: string }>(
          sql`select id from documento_emitido where tipo = 'listado_saldos_pendientes'`,
        ),
      );
      expect(filas.rows).toHaveLength(0);
    });
  }

  it("un admin_barrio sí lo ve", async () => {
    const filas = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from documento_emitido where tipo = 'listado_saldos_pendientes'`,
      ),
    );
    expect(filas.rows).toHaveLength(1);
  });

  it("nadie del rol de request puede leer la columna `vista`, ni siquiera un admin", async () => {
    // El grant es por columna: la vista congelada es el documento entero, y proyectarla es servirlo
    // sin pasar por la ruta de descarga ni por su registro.
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`select vista from documento_emitido limit 1`),
      ),
    ).rejects.toThrow(/permission denied|permiso denegado/i);
  });

  it("un `select *` falla, que es la consecuencia buscada del grant por columna", async () => {
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`select * from documento_emitido limit 1`),
      ),
    ).rejects.toThrow(/permission denied|permiso denegado/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// C2 — La regla del "período emitido" la hace cumplir la base, no el servicio
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("C2 — no se encola la emisión de un borrador", () => {
  it("el `insert` directo sobre un período en borrador lo rechaza la base", async () => {
    // El servicio también lo comprueba, pero solo para dar un mensaje que sirva. Si el control
    // viviera únicamente ahí, este `insert` —que el rol de request puede hacer— generaría los
    // documentos de un borrador: se renderizarían y se registrarían como emitidos, sobre cifras que
    // todavía se pueden editar. Es exactamente lo que la pantalla promete que no puede pasar.
    const periodo = await sembrarPeriodo(admin, arbol.barrioA1.id, "2026-03");
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`
          insert into trabajo (tipo, referencia_id)
          values ('emitir_documentos_periodo', ${periodo})
        `),
      ),
    ).rejects.toThrow(/el período no está emitido/);

    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from trabajo where referencia_id = $1",
      [periodo],
    );
    expect(rows[0]?.n).toBe("0");
    await admin.query("delete from periodo_expensa where id = $1", [periodo]);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// La clave: un patrón, dos lenguajes, y un test que los ata
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("el patrón de la clave de almacenamiento", () => {
  it("el `check` de la base contiene EXACTAMENTE el patrón que valida el código", async () => {
    // Están escritos dos veces porque son dos lenguajes. Que no diverjan no puede ser una convención:
    // si divergen, o rebotan claves correctas o entra una que apunta a otro barrio.
    const { rows } = await admin.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'documento_storage_key_chk'`,
    );
    // Sin `.replace`: la constante ya tiene UNA barra invertida en runtime (`\.pdf$`), porque el
    // `\\.` del fuente es el escape de TypeScript. El `.replace("\\\\", "\\")` que había acá no
    // reemplazaba nada y hacía que la aserción pasara por casualidad y no por lo que dice probar.
    expect(SUFIJO_PATRON_CLAVE).toContain("\\.pdf$");
    expect(rows[0]?.def).toContain(SUFIJO_PATRON_CLAVE);
  });

  it("la base rechaza una clave que apunta a otro barrio", async () => {
    // La clave de B1, en una fila de A1. Es el escenario que el `check` existe para cortar: venga
    // del worker, de un script o de una consola, una clave que no corresponde al barrio de su
    // propia fila no entra.
    const periodo = await sembrarPeriodo(admin, arbol.barrioA1.id, "2026-02");
    const cliente = await admin.connect();
    try {
      await cliente.query("begin");
      await cliente.query("select set_config('app.user_id', $1, true)", [arbol.usuarios.adminBarrioA1]);
      await expect(
        cliente.query(
          `insert into documento_emitido
             (barrio_id, periodo_id, tipo, liquidacion_id, storage_key, sha256, bytes, vista,
              vista_version, motor, plantilla_hash, medio_cobranza, emitido_por)
           values ($1, $2, 'informe_mensual', null, $3, repeat('a', 64), 1, '{}'::jsonb,
                   'boleta/1', 'x', repeat('b', 64), 'generico-demo',
                   '00000000-0000-4000-8000-000000000000')`,
          [arbol.barrioA1.id, periodo, docs.claveB1],
        ),
      ).rejects.toThrow(/documento_storage_key_chk/);
      await cliente.query("rollback");
    } finally {
      cliente.release();
    }
    await admin.query("delete from periodo_expensa where periodo = '2026-02'");
  });

  it("el validador rechaza el recorrido de rutas que un `startsWith` dejaría pasar", () => {
    const a = "0fc84fbc-4072-4506-a066-b7a670bf6943";
    const b = "1fc84fbc-4072-4506-a066-b7a670bf6943";
    // Satisface el prefijo `barrios/{A}/` y resuelve al barrio B apenas alguien haga un `path.join`.
    expect(() => revisarClave(`barrios/${a}/../${b}/periodos/x/boletas/y.pdf`)).toThrow();
    expect(() => revisarClave(`/barrios/${a}/periodos/${b}/boletas/AAAAAAAAAAAAAAAAAAAAAA.pdf`)).toThrow();
    expect(() => revisarClave(`barrios/${a}/periodos/${b}/boletas/AAAAAAAAAAAAAAAAAAAAAAxpdf`)).toThrow();
    // Y acepta la buena, que es la otra mitad de la prueba.
    expect(() =>
      revisarClave(`barrios/${a}/periodos/${b}/boletas/AAAAAAAAAAAAAAAAAAAAAA.pdf`),
    ).not.toThrow();
  });
});
