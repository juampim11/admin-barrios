/**
 * **El ciclo de vida del envío, y el guard que impide el segundo correo.**
 *
 * `distribucion-rls.test.ts` fija que el sobre con la boleta de otro vecino no se pueda *construir*.
 * Este archivo fija lo otro: que el mismo sobre no se pueda mandar *dos veces*.
 *
 * Los dos son necesarios y persiguen fallas distintas. Un lote de 510 correos con un reintento mal
 * resuelto no filtra datos de nadie — manda cientos de duplicados irreversibles, que es un daño
 * distinto y no menor: el vecino recibe dos liquidaciones y no sabe cuál rige.
 *
 * Lo que se prueba acá vive **en la base** (`0054`), y esa es la decisión que el archivo verifica:
 * la RLS de `0053` habilita `update` sobre esta tabla porque el claim atómico lo necesita, así que
 * un guard escrito solo en TypeScript sería un guard que la próxima ruta se olvida.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/distribucion-envio.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { conUsuario, type DbRequest } from "../src/client.ts";
import {
  crearLoteDeEnvios,
  enviosPendientes,
  hashDeDireccion,
  marcarEnvioAceptado,
  marcarEnvioFallado,
  marcarPeriodoDistribuido,
  reclamarEnvio,
  resumenDeEnvios,
} from "../src/servicios/distribucion.ts";
import { borrarArbol, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;

let periodoId: string;
let unidadA: { id: string; contactoId: string; documentoId: string };
let unidadB: { id: string; contactoId: string; documentoId: string };
let informeId: string;

const PERIODO = "2029-11";
const como = <T>(fn: (tx: DbRequest) => Promise<T>, usuario = arbol.usuarios.adminBarrioA1) =>
  conUsuario(db, usuario, fn);

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomUUID().replaceAll("-", "") + "ab";
const clave = (carpeta: string) =>
  `barrios/${arbol.barrioA1.id}/periodos/${periodoId}/${carpeta}/${token()}.pdf`;

/** El estado y los sellos de una fila, leídos con la conexión de administración. */
async function estadoDe(envioId: string) {
  const { rows } = await admin.query<{
    estado: string;
    intento: number;
    mensaje_id: string | null;
    aceptado_at: Date | null;
    error_codigo: string | null;
  }>("select estado, intento, mensaje_id, aceptado_at, error_codigo from envio_liquidacion where id = $1", [
    envioId,
  ]);
  return rows[0]!;
}

/** Un `update` crudo, para ver si la BASE lo permite — no si el servicio lo ofrece. */
async function forzar(envioId: string, set: string): Promise<{ ok: boolean; error: string }> {
  try {
    await como((tx) => tx.execute(sql.raw(`update envio_liquidacion set ${set} where id = '${envioId}'`)));
    return { ok: true, error: "" };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

async function crearLote() {
  return como((tx) =>
    crearLoteDeEnvios(tx, {
      periodoId,
      barrioId: arbol.barrioA1.id,
      informeDocumentoId: informeId,
      plantillaVersion: "liquidacion/1",
      trabajoId: trabajoId,
      destinatarios: [
        {
          unidadContactoId: unidadA.contactoId,
          documentoId: unidadA.documentoId,
          email: "ana@ejemplo.test",
          nombre: "Ana",
          unidadEtiqueta: "Mza 1 · Lote 1",
        },
        {
          unidadContactoId: unidadB.contactoId,
          documentoId: unidadB.documentoId,
          email: "bruno@ejemplo.test",
          nombre: null,
          unidadEtiqueta: "Mza 1 · Lote 2",
        },
      ],
    }),
  );
}

let trabajoId: string;

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);

  const uno = async (q: string, args: unknown[]) => (await admin.query<{ id: string }>(q, args)).rows[0]!.id;

  periodoId = await uno(
    `insert into periodo_expensa (barrio_id, periodo) values ($1,$2) returning id`,
    [arbol.barrioA1.id, PERIODO],
  );

  const armarUnidad = async (lote: string, email: string) => {
    const id = await uno(
      `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
       values ($1,'1',$2,'construido') returning id`,
      [arbol.barrioA1.id, lote],
    );
    const liquidacionId = await uno(
      `insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, coeficiente_aplicado,
                                subtotal_ordinarias, subtotal_extraordinarias, subtotal_fondo_reserva,
                                interes_mora, total)
       values ($1,$2,$3,'0.500000000','100000.00','0.00','0.00','0.00','100000.00') returning id`,
      [arbol.barrioA1.id, periodoId, id],
    );
    const contactoId = await uno(
      `insert into unidad_contacto (barrio_id, unidad_funcional_id, email, principal)
       values ($1,$2,$3,true) returning id`,
      [arbol.barrioA1.id, id, email],
    );
    return { id, contactoId, liquidacionId };
  };

  const a = await armarUnidad("1", "ana@ejemplo.test");
  const b = await armarUnidad("2", "bruno@ejemplo.test");

  // Mismo motivo que en `distribucion-rls`: el período no puede nacer emitido y la transición real
  // exige que cuadre, que se prueba en otro archivo. Acá hace falta el estado, no el camino.
  await admin.query("set session_replication_role = replica");
  await admin.query(
    "update periodo_expensa set estado = 'emitida', emitida_at = now(), emitida_por = $2 where id = $1",
    [periodoId, arbol.usuarios.adminBarrioA1],
  );

  const emitirBoleta = async (liquidacionId: string, semilla: string) =>
    uno(
      `insert into documento_emitido (barrio_id, periodo_id, tipo, liquidacion_id, storage_key,
                                      sha256, bytes, vista, vista_version, motor, plantilla_hash,
                                      medio_cobranza, emitido_por)
       values ($1,$2,'boleta_unidad',$3,$4,$5, 1024, '{}'::jsonb, 'boleta/1', 'test', $5, 'cupon', $6)
       returning id`,
      [arbol.barrioA1.id, periodoId, liquidacionId, clave("boletas"), hash(semilla), arbol.usuarios.adminBarrioA1],
    );

  unidadA = { id: a.id, contactoId: a.contactoId, documentoId: await emitirBoleta(a.liquidacionId, "a") };
  unidadB = { id: b.id, contactoId: b.contactoId, documentoId: await emitirBoleta(b.liquidacionId, "b") };

  informeId = await uno(
    `insert into documento_emitido (barrio_id, periodo_id, tipo, storage_key, sha256, bytes, vista,
                                    vista_version, motor, plantilla_hash, medio_cobranza, emitido_por)
     values ($1,$2,'informe_mensual',$3,$4, 2048, '{}'::jsonb, 'informe-mensual/2', 'test', $4, 'cupon', $5)
     returning id`,
    [arbol.barrioA1.id, periodoId, clave("informes"), hash("informe"), arbol.usuarios.adminBarrioA1],
  );

  trabajoId = await uno(
    `insert into trabajo (barrio_id, tipo, referencia_id, solicitado_por, estado)
     values ($1,'distribuir_liquidaciones',$2,$3,'corriendo') returning id`,
    [arbol.barrioA1.id, periodoId, arbol.usuarios.adminBarrioA1],
  );
  await admin.query("set session_replication_role = origin");
});

afterEach(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from envio_liquidacion where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query(
    "update periodo_expensa set estado = 'emitida', distribuida_at = null, distribuida_por = null where id = $1",
    [periodoId],
  );
  await admin.query("set session_replication_role = origin");
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  /*
   * De hijo a padre, y **`barrio` incluido**: `borrarArbol` borra el `tenant_node`, y la fila de
   * `barrio` lo referencia con `on delete restrict`. Sin este borrado el archivo pasa igual y lo que
   * falla es el `afterAll`, o sea que el error aparece como una suite rota sin un solo test en rojo.
   * Sin `.catch()`, por lo mismo: un cleanup que falla en silencio deja el fixture a medias.
   */
  for (const t of [
    "envio_liquidacion", "trabajo", "documento_emitido", "liquidacion",
    "unidad_contacto", "unidad_funcional", "periodo_expensa",
    "barrio_atributo_vigencia", "barrio",
  ]) {
    await admin.query(`delete from ${t} where barrio_id = $1`, [arbol.barrioA1.id]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await admin.end();
  await appPool.end();
});

describe("el lote nace antes de que salga un correo", () => {
  it("registra una fila por destinatario, en estado pendiente", async () => {
    expect(await crearLote()).toBe(2);

    const resumen = await como((tx) => resumenDeEnvios(tx, { periodoId }));
    expect(resumen.pendientes).toBe(2);
    expect(resumen.aceptados).toBe(0);
  });

  /**
   * El guard de idempotencia del lote entero. Sin el `on conflict do nothing`, un reintento del
   * trabajo duplicaría cada destinatario — y con él, cada correo.
   */
  it("correrlo dos veces no duplica ninguna fila", async () => {
    expect(await crearLote()).toBe(2);
    expect(await crearLote()).toBe(0);

    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from envio_liquidacion where periodo_id = $1",
      [periodoId],
    );
    expect(rows[0]!.n).toBe("2");
  });

  it("congela la dirección, y el hash lleva el barrio adentro", async () => {
    await crearLote();
    const { rows } = await admin.query<{ email_snapshot: string; email_hash: string }>(
      "select email_snapshot, email_hash from envio_liquidacion where unidad_contacto_id = $1",
      [unidadA.contactoId],
    );
    expect(rows[0]!.email_snapshot).toBe("ana@ejemplo.test");
    expect(rows[0]!.email_hash).toBe(hashDeDireccion(arbol.barrioA1.id, "ana@ejemplo.test"));
    // El mismo correo en otro barrio da otro hash: si no, la columna sería un índice global de
    // "en qué barrios está esta persona".
    expect(hashDeDireccion(arbol.barrioA2.id, "ana@ejemplo.test")).not.toBe(rows[0]!.email_hash);
  });
});

describe("el claim es lo que impide el segundo correo", () => {
  it("reclamar deja la fila en enviando, con su Message-ID puesto ANTES de mandar", async () => {
    await crearLote();
    const [primero] = await como((tx) => enviosPendientes(tx, { periodoId }));

    expect(await como((tx) => reclamarEnvio(tx, { envioId: primero!.id, mensajeId: "<uno@test>" }))).toBe(
      true,
    );

    const fila = await estadoDe(primero!.id);
    expect(fila.estado).toBe("enviando");
    expect(fila.mensaje_id).toBe("<uno@test>");
    expect(fila.intento).toBe(1);
  });

  /**
   * **El corazón del módulo.** Dos workers sobre el mismo lote: el segundo tiene que irse con las
   * manos vacías, no reintentar. Si esto devolviera `true` dos veces, el vecino recibe dos correos.
   */
  it("un segundo claim de la misma fila devuelve false", async () => {
    await crearLote();
    const [primero] = await como((tx) => enviosPendientes(tx, { periodoId }));

    expect(await como((tx) => reclamarEnvio(tx, { envioId: primero!.id, mensajeId: "<uno@test>" }))).toBe(
      true,
    );
    expect(await como((tx) => reclamarEnvio(tx, { envioId: primero!.id, mensajeId: "<dos@test>" }))).toBe(
      false,
    );
    // Y el Message-ID del primero sigue en pie: es la llave con la que se aparea un rebote.
    expect((await estadoDe(primero!.id)).mensaje_id).toBe("<uno@test>");
  });

  it("un envío ya reclamado no vuelve a aparecer entre los pendientes", async () => {
    await crearLote();
    const antes = await como((tx) => enviosPendientes(tx, { periodoId }));
    await como((tx) => reclamarEnvio(tx, { envioId: antes[0]!.id, mensajeId: "<uno@test>" }));

    const despues = await como((tx) => enviosPendientes(tx, { periodoId }));
    expect(despues).toHaveLength(1);
    expect(despues[0]!.id).not.toBe(antes[0]!.id);
  });

  it("los pendientes traen la dirección CONGELADA, no la vigente del contacto", async () => {
    await crearLote();
    // El padrón cambia después de armado el lote: es el caso real que B-1 persigue.
    await admin.query("update unidad_contacto set email = $2 where id = $1", [
      unidadA.contactoId,
      "otro@atacante.test",
    ]);

    const pendientes = await como((tx) => enviosPendientes(tx, { periodoId }));
    const deA = pendientes.find((p) => p.documentoId === unidadA.documentoId);
    expect(deA!.email).toBe("ana@ejemplo.test");

    await admin.query("update unidad_contacto set email = $2 where id = $1", [
      unidadA.contactoId,
      "ana@ejemplo.test",
    ]);
  });
});

describe("la máquina de estados vive en la base (0054)", () => {
  async function unoEnviando(): Promise<string> {
    await crearLote();
    const [primero] = await como((tx) => enviosPendientes(tx, { periodoId }));
    await como((tx) => reclamarEnvio(tx, { envioId: primero!.id, mensajeId: `<${randomUUID()}@test>` }));
    return primero!.id;
  }

  it("aceptar sella la fecha, y la sella la BASE", async () => {
    const id = await unoEnviando();
    await como((tx) => marcarEnvioAceptado(tx, { envioId: id }));

    const fila = await estadoDe(id);
    expect(fila.estado).toBe("aceptado");
    expect(fila.aceptado_at).not.toBeNull();
  });

  /**
   * **El ataque que `0054` existe para cerrar.** `0053` habilitó `update` para el claim; sin la
   * máquina de estados, esta línea devolvía a la cola un envío ya aceptado y el siguiente recorrido
   * lo mandaba de nuevo.
   */
  it("un envío ACEPTADO no puede volver a pendiente", async () => {
    const id = await unoEnviando();
    await como((tx) => marcarEnvioAceptado(tx, { envioId: id }));

    const r = await forzar(id, "estado = 'pendiente', aceptado_at = null");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/transición de envío inválida/);
    expect((await estadoDe(id)).estado).toBe("aceptado");
  });

  it("de enviando no se sale a pendiente: es estado desconocido a propósito", async () => {
    const id = await unoEnviando();
    const r = await forzar(id, "estado = 'pendiente'");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/transición de envío inválida/);
  });

  it("fallado SÍ puede volver a pendiente: el reintento es una decisión de una persona", async () => {
    const id = await unoEnviando();
    await como((tx) => marcarEnvioFallado(tx, { envioId: id, codigo: "EENVELOPE" }));
    expect((await estadoDe(id)).error_codigo).toBe("EENVELOPE");

    expect((await forzar(id, "estado = 'pendiente'")).ok).toBe(true);
    expect((await estadoDe(id)).estado).toBe("pendiente");
  });

  it("el documento que viaja no se puede reescribir después de registrado", async () => {
    await crearLote();
    const [primero] = await como((tx) => enviosPendientes(tx, { periodoId }));

    // Apuntar el envío de una unidad a la boleta de la otra: la fuga que B-1 cierra en el insert y
    // que sin `0054` se podía hacer con un update.
    const otro = primero!.documentoId === unidadA.documentoId ? unidadB.documentoId : unidadA.documentoId;
    const r = await forzar(primero!.id, `documento_id = '${otro}'`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/la identidad de un envío no se puede cambiar/);
  });

  it("la dirección congelada tampoco: reenviar solo puede ir a donde ya se escribió", async () => {
    await crearLote();
    const [primero] = await como((tx) => enviosPendientes(tx, { periodoId }));

    const r = await forzar(primero!.id, "email_snapshot = 'atacante@ejemplo.test'");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/la identidad de un envío no se puede cambiar/);
  });

  it("el Message-ID no se reescribe una vez puesto", async () => {
    const id = await unoEnviando();
    const r = await forzar(id, "mensaje_id = '<otro@test>'");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Message-ID/);
  });

  it("el contador de intentos no retrocede", async () => {
    const id = await unoEnviando();
    const r = await forzar(id, "intento = 0");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no puede retroceder/);
  });
});

describe("el período se sella distribuido solo cuando terminó de verdad", () => {
  it("no se sella con envíos todavía en vuelo", async () => {
    await crearLote();
    expect(await como((tx) => marcarPeriodoDistribuido(tx, { periodoId }))).toBe(false);

    const { rows } = await admin.query<{ estado: string }>(
      "select estado from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(rows[0]!.estado).toBe("emitida");
  });

  it("se sella cuando no queda ninguno pendiente ni enviando, y firma quién lo hizo", async () => {
    await crearLote();
    for (const envio of await como((tx) => enviosPendientes(tx, { periodoId }))) {
      await como((tx) => reclamarEnvio(tx, { envioId: envio.id, mensajeId: `<${randomUUID()}@test>` }));
      await como((tx) => marcarEnvioAceptado(tx, { envioId: envio.id }));
    }

    expect(await como((tx) => marcarPeriodoDistribuido(tx, { periodoId }))).toBe(true);

    const { rows } = await admin.query<{ estado: string; distribuida_por: string | null }>(
      "select estado, distribuida_por from periodo_expensa where id = $1",
      [periodoId],
    );
    expect(rows[0]!.estado).toBe("distribuida");
    // La firma que `0053` agregó: distribuir manda PII afuera y es tan imputable como emitir.
    expect(rows[0]!.distribuida_por).toBe(arbol.usuarios.adminBarrioA1);
  });

  /**
   * Un correo que rebotó por una casilla mal cargada **no** puede dejar el período sin sellar para
   * siempre: es un resultado, no un pendiente. La pantalla lo muestra y una persona decide.
   */
  it("un envío FALLADO no impide el sello", async () => {
    await crearLote();
    const pendientes = await como((tx) => enviosPendientes(tx, { periodoId }));
    for (const [i, envio] of pendientes.entries()) {
      await como((tx) => reclamarEnvio(tx, { envioId: envio.id, mensajeId: `<${randomUUID()}@test>` }));
      if (i === 0) await como((tx) => marcarEnvioFallado(tx, { envioId: envio.id, codigo: "EENVELOPE" }));
      else await como((tx) => marcarEnvioAceptado(tx, { envioId: envio.id }));
    }

    expect(await como((tx) => marcarPeriodoDistribuido(tx, { periodoId }))).toBe(true);
  });
});
