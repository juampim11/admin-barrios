/**
 * **B-2: `unidad_contacto` deja de ser mutable en silencio.**
 *
 * El hallazgo, en una línea: esa tabla decide **a qué casilla se manda la boleta de una unidad**, su
 * policy de escritura viene del bucle genérico de `0003` y habilita también a `operador`, y no
 * guardaba quién. Con la distribución eso deja de ser un dato de padrón y se vuelve un **canal de
 * auto-suscripción**: se agrega una casilla propia a la UF de cualquier vecino y su liquidación
 * llega sola, con importes y titular, sin descargar nada y sin pasar por `descarga_documento`.
 *
 * Lo que estos tests fijan es la forma de la corrección, que tiene dos mitades igual de importantes:
 *
 *   1. **El `operador` SIGUE pudiendo cargar contactos.** Es trabajo legítimo de padrón, y quitarle
 *      el permiso habría roto la operatoria real para tapar un problema de auditoría.
 *   2. **Pero ya no puede hacerlo sin dejar rastro.**
 *
 * Correr con: pnpm vitest run --project db packages/data/test/unidad-contacto-traza.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { sql } from "drizzle-orm";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { borrarArbol, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let unidadId: string;

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>): Promise<T> => conUsuario(db, usuario, fn);

/** Agrega un contacto como `usuario`, tal como lo haría la pantalla del padrón. */
async function agregarContacto(usuario: string, email: string): Promise<{ ok: boolean }> {
  try {
    await como(usuario, (tx) =>
      tx.execute(sql`
        insert into unidad_contacto (barrio_id, unidad_funcional_id, email)
        values (${arbol.barrioA1.id}, ${unidadId}, ${email})
      `),
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function leerTraza(email: string) {
  const { rows } = await admin.query<{
    creado_por: string | null;
    modificado_por: string | null;
    actualizado_at: string | null;
  }>("select creado_por, modificado_por, actualizado_at from unidad_contacto where email = $1", [email]);
  return rows[0]!;
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);

  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);

  const { rows } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
     values ($1,'3','7','construido') returning id`,
    [arbol.barrioA1.id],
  );
  unidadId = rows[0]!.id;
});

afterEach(async () => {
  await admin.query("delete from unidad_contacto where barrio_id = $1", [arbol.barrioA1.id]);
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  for (const t of ["unidad_contacto", "unidad_funcional", "barrio_atributo_vigencia", "barrio"]) {
    await admin.query(`delete from ${t} where barrio_id = $1`, [arbol.barrioA1.id]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await appPool.end();
  await admin.end();
});

describe("el operador sigue pudiendo cargar contactos", () => {
  /**
   * La mitad que se protege: cargar el mail de un vecino es trabajo de padrón, y el `operador` es
   * quien lo hace. Sacarle el permiso habría "resuelto" B-2 rompiendo la operatoria.
   */
  it("un operador agrega un contacto sin problemas", async () => {
    expect((await agregarContacto(arbol.usuarios.operadorA1, "vecino@ejemplo.test")).ok).toBe(true);
  });

  it("un admin_barrio también", async () => {
    expect((await agregarContacto(arbol.usuarios.adminBarrioA1, "otro@ejemplo.test")).ok).toBe(true);
  });
});

describe("pero ya no puede hacerlo en silencio", () => {
  it("el alta queda firmada por quien la hizo", async () => {
    await agregarContacto(arbol.usuarios.operadorA1, "vecino@ejemplo.test");
    const t = await leerTraza("vecino@ejemplo.test");

    expect(t.creado_por).toBe(arbol.usuarios.operadorA1);
    // Un alta no es una modificación: las dos columnas dicen cosas distintas y no se pisan.
    expect(t.modificado_por).toBeNull();
    expect(t.actualizado_at).toBeNull();
  });

  it("una edición queda firmada por quien la hizo, sin borrar quién lo creó", async () => {
    await agregarContacto(arbol.usuarios.adminBarrioA1, "vecino@ejemplo.test");
    await como(arbol.usuarios.operadorA1, (tx) =>
      tx.execute(sql`update unidad_contacto set nombre = 'Ana' where email = 'vecino@ejemplo.test'`),
    );

    const t = await leerTraza("vecino@ejemplo.test");
    expect(t.creado_por).toBe(arbol.usuarios.adminBarrioA1);
    expect(t.modificado_por).toBe(arbol.usuarios.operadorA1);
    expect(t.actualizado_at).not.toBeNull();
  });

  /**
   * **Quién creó el contacto es un hecho, no un campo.** Si se pudiera reescribir, la traza serviría
   * exactamente hasta el momento en que alguien quisiera borrar su rastro.
   */
  it("el autor del alta no se puede reescribir", async () => {
    await agregarContacto(arbol.usuarios.operadorA1, "vecino@ejemplo.test");
    await como(arbol.usuarios.operadorA1, (tx) =>
      tx.execute(sql`
        update unidad_contacto set creado_por = ${arbol.usuarios.adminBarrioA1}
         where email = 'vecino@ejemplo.test'
      `),
    );

    // El trigger repone el valor original: el update no falla, pero no cambia el hecho.
    const t = await leerTraza("vecino@ejemplo.test");
    expect(t.creado_por).toBe(arbol.usuarios.operadorA1);
  });

  /**
   * El vector completo de B-2, escrito como test para que se lea: el operador puede hacerlo, y
   * ahora **queda dicho que fue él**. Eso es lo que convierte una fuga silenciosa en un hallazgo de
   * auditoría.
   */
  it("agregar la casilla propia a la unidad de un vecino queda registrado", async () => {
    await agregarContacto(arbol.usuarios.operadorA1, "el-operador@sucasilla.test");
    const t = await leerTraza("el-operador@sucasilla.test");
    expect(t.creado_por).toBe(arbol.usuarios.operadorA1);
  });
});

describe("el aislamiento entre barrios no cambió", () => {
  it("un admin de otro estudio no puede agregar contactos acá", async () => {
    expect((await agregarContacto(arbol.usuarios.adminEstudioB, "ajeno@ejemplo.test")).ok).toBe(false);
  });

  it("ni un propietario, que desde 0018 no lee ni una fila", async () => {
    expect((await agregarContacto(arbol.usuarios.propietarioA1, "propietario@ejemplo.test")).ok).toBe(false);
  });
});
