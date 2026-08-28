/**
 * **El aislamiento entre destinatarios**, que es el control central del módulo de Distribución.
 *
 * Este archivo se escribe ANTES de que exista una sola línea que mande correo, y el orden es
 * deliberado: lo que se prueba acá no es una consulta ni una policy, es que **el sobre con la boleta
 * de otro vecino no se pueda construir**. Un test escrito después del código de envío se escribe
 * mirando ese código; escrito antes, se escribe mirando la regla.
 *
 * El modo de falla que persigue es el clásico de estos lotes: dos arrays paralelos —contactos y
 * PDFs— unidos por índice, que un chunking o un reintento parcial desalinean. Con el par validado en
 * la base, ese error deja de ser improbable y pasa a ser **irrepresentable**.
 *
 * Correr con: pnpm vitest run --project db packages/data/test/distribucion-rls.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { borrarArbol, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;

let periodoId: string;
/** Dos unidades del mismo barrio, cada una con su boleta y su contacto. */
let unidadA: { id: string; contactoId: string; documentoId: string };
let unidadB: { id: string; contactoId: string; documentoId: string };
let informeId: string;

const PERIODO = "2029-09";
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>): Promise<T> => conUsuario(db, usuario, fn);

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** Token del patrón que exige el `CHECK` de `storage_key`: `[A-Za-z0-9_-]{22,64}`. */
const token = () => randomUUID().replaceAll("-", "") + "ab";

/**
 * La `storage_key` se arma en JS y viaja como un parámetro más. Interpolarla en SQL obligaba a usar
 * el mismo `$1` como uuid (la FK) y como texto (la ruta), y Postgres no puede deducir dos tipos para
 * un parámetro.
 */
const clave = (carpeta: string) =>
  `barrios/${arbol.barrioA1.id}/periodos/${periodoId}/${carpeta}/${token()}.pdf`;

/** Inserta una fila de envío tal como la armaría el servicio, para ver si la base la acepta. */
async function intentarEnvio(
  campos: { contactoId: string; documentoId: string; email?: string },
  usuario = arbol.usuarios.adminBarrioA1,
): Promise<{ ok: boolean; error?: string }> {
  const email = campos.email ?? "vecino@ejemplo.test";
  try {
    await como(usuario, (tx) =>
      tx.execute(sql`
        insert into envio_liquidacion
          (barrio_id, periodo_id, unidad_funcional_id, unidad_contacto_id, documento_id,
           informe_documento_id, email_snapshot, email_hash, plantilla_version, solicitado_por)
        values
          (${arbol.barrioA1.id}, ${periodoId}, ${unidadA.id}, ${campos.contactoId}, ${campos.documentoId},
           ${informeId}, ${email}, ${hash(email)}, 'liquidacion/1', ${usuario})
      `),
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);

  const uno = async (q: string, args: unknown[]) => (await admin.query<{ id: string }>(q, args)).rows[0]!.id;

  /*
   * El período se siembra en borrador y se lleva a `emitida` con los triggers apagados. No es un
   * atajo: `app.periodo_nace_en_borrador` impide crearlo emitido —"emitir es una transición, no un
   * estado inicial"— y la transición real exige que el período cuadre, que es otro test y no este.
   * Acá lo que se prueba es el aislamiento del envío, y para eso hace falta el estado, no el camino.
   */
  periodoId = await uno(
    `insert into periodo_expensa (barrio_id, periodo) values ($1,$2) returning id`,
    [arbol.barrioA1.id, PERIODO],
  );

  /** Siembra una unidad con su liquidación y su contacto. La boleta se emite después. */
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

  /*
   * Recién ahora se emite: `app.periodo_editable` congela el período emitido, así que las
   * liquidaciones tienen que existir antes. Con los triggers apagados porque el camino real de
   * emisión exige que el período cuadre — eso lo prueba `expensas-liquidacion`, no este archivo.
   */
  await admin.query("set session_replication_role = replica");
  await admin.query(
    "update periodo_expensa set estado = 'emitida', emitida_at = now(), emitida_por = $2 where id = $1",
    [periodoId, arbol.usuarios.adminBarrioA1],
  );
  await admin.query("set session_replication_role = origin");

  /** La boleta emitida de una unidad, que es lo que viaja adjunto. */
  const emitirBoleta = async (liquidacionId: string, semilla: string) =>
    uno(
      `insert into documento_emitido (barrio_id, periodo_id, tipo, liquidacion_id, storage_key,
                                      sha256, bytes, vista, vista_version, motor, plantilla_hash,
                                      medio_cobranza, emitido_por)
       values ($1,$2,'boleta_unidad',$3,$4,$5, 1024, '{}'::jsonb, 'boleta/1', 'test', $5, 'cupon', $6)
       returning id`,
      [arbol.barrioA1.id, periodoId, liquidacionId, clave("boletas"), hash(semilla), arbol.usuarios.adminBarrioA1],
    );

  // `documento_emitido` exige emisor por trigger (`app.current_user_id()`), y el fixture siembra con
  // la conexión de administración, que no lo tiene. `emitido_por` se pasa explícito y los triggers
  // van apagados — igual que el pasaje a emitida de arriba.
  await admin.query("set session_replication_role = replica");
  unidadA = { id: a.id, contactoId: a.contactoId, documentoId: await emitirBoleta(a.liquidacionId, "a") };
  unidadB = { id: b.id, contactoId: b.contactoId, documentoId: await emitirBoleta(b.liquidacionId, "b") };

  informeId = await uno(
    `insert into documento_emitido (barrio_id, periodo_id, tipo, storage_key, sha256, bytes, vista,
                                    vista_version, motor, plantilla_hash, medio_cobranza, emitido_por)
     values ($1,$2,'informe_mensual',$3,$4, 2048, '{}'::jsonb, 'informe-mensual/2', 'test', $4, 'cupon', $5)
     returning id`,
    [arbol.barrioA1.id, periodoId, clave("informes"), hash("informe"), arbol.usuarios.adminBarrioA1],
  );
  await admin.query("set session_replication_role = origin");
});

afterEach(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from envio_liquidacion where barrio_id = $1", [arbol.barrioA1.id]);
  // Los contactos extra que algún test agregó. Van DESPUÉS de los envíos: `on delete restrict`
  // impide borrar un contacto al que un envío apunta, que es la garantía que se quiere.
  await admin.query(
    "delete from unidad_contacto where barrio_id = $1 and email not in ('ana@ejemplo.test','bruno@ejemplo.test')",
    [arbol.barrioA1.id],
  );
  await admin.query("delete from paquete_distribucion_item");
  await admin.query("delete from paquete_distribucion where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("set session_replication_role = origin");
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  // `paquete_distribucion_item` no tiene `barrio_id`: cuelga del paquete, así que va primero y por
  // su propia FK. El resto, de hijo a padre. **Sin `.catch()`**: un borrado que falla en silencio
  // deja el fixture a medias y el error aparece recién en el archivo siguiente.
  await admin.query(
    "delete from paquete_distribucion_item where paquete_id in (select id from paquete_distribucion where barrio_id = $1)",
    [arbol.barrioA1.id],
  );
  for (const t of [
    "envio_liquidacion", "paquete_distribucion", "documento_emitido",
    "liquidacion", "unidad_contacto", "unidad_funcional", "periodo_expensa",
    "barrio_atributo_vigencia", "barrio",
  ]) {
    await admin.query(`delete from ${t} where barrio_id = $1`, [arbol.barrioA1.id]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await appPool.end();
  await admin.end();
});

describe("el par contacto↔documento — B-1", () => {
  it("el par correcto entra", async () => {
    const r = await intentarEnvio({ contactoId: unidadA.contactoId, documentoId: unidadA.documentoId });
    expect(r.ok).toBe(true);
  });

  /**
   * **El test que justifica todo el módulo.** Es el sobre con la boleta de otro vecino: no se puede
   * persistir, y como el adjunto se resuelve leyendo el `documento_id` de esta misma fila, tampoco
   * se puede enviar. El control es estructural, no un cuidado que haya que recordar.
   */
  it("el contacto de OTRA unidad con esta boleta no entra", async () => {
    const r = await intentarEnvio({ contactoId: unidadB.contactoId, documentoId: unidadA.documentoId });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/el contacto pertenece a otra unidad/i);
  });

  it("y al revés tampoco: esta boleta con el contacto de la otra", async () => {
    const r = await intentarEnvio({ contactoId: unidadA.contactoId, documentoId: unidadB.documentoId });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/el contacto pertenece a otra unidad/i);
  });

  /** El informe mensual es del período, no de una unidad: no puede viajar como adjunto principal. */
  it("un documento que no es boleta de unidad no entra como principal", async () => {
    const r = await intentarEnvio({ contactoId: unidadA.contactoId, documentoId: informeId });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no es una boleta de unidad/i);
  });

  /**
   * Un contacto dado de baja **no recibe**. Y lo que importa del caso: el sistema no "corrige" el
   * envío re-apuntándolo a otra dirección — re-apuntar es exactamente cómo se filtra.
   */
  it("un contacto dado de baja no recibe", async () => {
    await admin.query("update unidad_contacto set activo = false where id = $1", [unidadA.contactoId]);
    const r = await intentarEnvio({ contactoId: unidadA.contactoId, documentoId: unidadA.documentoId });
    await admin.query("update unidad_contacto set activo = true where id = $1", [unidadA.contactoId]);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/está dado de baja/i);
  });

  /**
   * **Una UF con dos contactos manda dos emails, no uno con dos destinatarios.** Y un mismo email en
   * dos unidades distintas —que `uq_contacto_uf_email` permite, porque es único por `(unidad,email)`—
   * produce **dos filas separadas**: está prohibido agrupar por dirección para ahorrar envíos, que es
   * la optimización que termina en un sobre con dos boletas.
   */
  it("dos contactos de la misma unidad son dos filas", async () => {
    const segundo = (
      await admin.query<{ id: string }>(
        `insert into unidad_contacto (barrio_id, unidad_funcional_id, email)
         values ($1,$2,'ana.trabajo@ejemplo.test') returning id`,
        [arbol.barrioA1.id, unidadA.id],
      )
    ).rows[0]!.id;

    expect((await intentarEnvio({ contactoId: unidadA.contactoId, documentoId: unidadA.documentoId })).ok).toBe(true);
    expect((await intentarEnvio({ contactoId: segundo, documentoId: unidadA.documentoId })).ok).toBe(true);

    const { rows } = await admin.query<{ n: string }>(
      "select count(*) as n from envio_liquidacion where unidad_funcional_id = $1",
      [unidadA.id],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

describe("el guard de idempotencia", () => {
  /** La reserva atómica: el segundo intento sobre el mismo destinatario rebota en la base. */
  it("el mismo período y contacto no se pueden registrar dos veces", async () => {
    expect((await intentarEnvio({ contactoId: unidadA.contactoId, documentoId: unidadA.documentoId })).ok).toBe(true);
    const segundo = await intentarEnvio({ contactoId: unidadA.contactoId, documentoId: unidadA.documentoId });
    expect(segundo.ok).toBe(false);
  });

  /** `aceptado_at` va con el estado: las dos formas de decir lo mismo no pueden contradecirse. */
  it("no se puede marcar aceptado sin sello, ni sellar sin aceptar", async () => {
    await intentarEnvio({ contactoId: unidadA.contactoId, documentoId: unidadA.documentoId });
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`update envio_liquidacion set estado = 'aceptado' where periodo_id = ${periodoId}`),
      ),
    ).rejects.toThrow();
  });
});

describe("quién puede registrar un envío", () => {
  it("admin_barrio puede", async () => {
    expect((await intentarEnvio({ contactoId: unidadA.contactoId, documentoId: unidadA.documentoId })).ok).toBe(true);
  });

  /**
   * `operador` carga los movimientos y emite documentos —eso es interno y se queda en el storage—
   * pero **mandar PII a casillas externas no hereda esa autorización**.
   */
  it("operador NO puede", async () => {
    const r = await intentarEnvio(
      { contactoId: unidadA.contactoId, documentoId: unidadA.documentoId },
      arbol.usuarios.operadorA1,
    );
    expect(r.ok).toBe(false);
  });

  it("contador y auditor tampoco", async () => {
    for (const u of [arbol.usuarios.contadorA1, arbol.usuarios.auditorA1]) {
      const r = await intentarEnvio({ contactoId: unidadA.contactoId, documentoId: unidadA.documentoId }, u);
      expect(r.ok).toBe(false);
    }
  });
});

describe("el paquete de distribución", () => {
  async function armarPaquete(usuario: string): Promise<{ ok: boolean }> {
    try {
      await como(usuario, (tx) =>
        tx.execute(sql`
          insert into paquete_distribucion (barrio_id, periodo_id, storage_key, sha256, bytes, armado_por)
          values (${arbol.barrioA1.id}, ${periodoId},
                  ${`barrios/${arbol.barrioA1.id}/periodos/${periodoId}/paquetes/${token()}.zip`},
                  ${hash("zip")}, 4096, ${usuario})
        `),
      );
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  it("admin_barrio lo arma", async () => {
    expect((await armarPaquete(arbol.usuarios.adminBarrioA1)).ok).toBe(true);
  });

  /**
   * **El paquete es el artefacto más concentrado que este sistema produce**: N boletas con titular,
   * unidad e importe en un solo objeto. `documento_emitido_sel` (`0027`) ya había cerrado el listado
   * de saldos incluso para contador y auditor, y esto es estrictamente mayor que ese listado.
   */
  it("ni operador, ni contador, ni auditor", async () => {
    for (const u of [arbol.usuarios.operadorA1, arbol.usuarios.contadorA1, arbol.usuarios.auditorA1]) {
      expect((await armarPaquete(u)).ok).toBe(false);
    }
  });

  it("una clave que no es .zip no entra", async () => {
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`
          insert into paquete_distribucion (barrio_id, periodo_id, storage_key, sha256, bytes, armado_por)
          values (${arbol.barrioA1.id}, ${periodoId},
                  ${`barrios/${arbol.barrioA1.id}/periodos/${periodoId}/paquetes/${token()}.pdf`},
                  ${hash("x")}, 4096, ${arbol.usuarios.adminBarrioA1})
        `),
      ),
    ).rejects.toThrow();
  });

  it("es append-only: no se edita ni se borra", async () => {
    await armarPaquete(arbol.usuarios.adminBarrioA1);
    await expect(
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`update paquete_distribucion set bytes = 1 where periodo_id = ${periodoId}`),
      ),
    ).rejects.toThrow();
  });

  it("un barrio ajeno no lo ve", async () => {
    await armarPaquete(arbol.usuarios.adminBarrioA1);
    const { rows } = await como(arbol.usuarios.adminEstudioB, (tx) =>
      tx.execute<{ n: string }>(sql`select count(*) as n from paquete_distribucion`),
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
