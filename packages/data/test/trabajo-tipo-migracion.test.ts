/**
 * `trabajo.tipo` — la migración `0039` lo convierte de `app.enum` a `text` + `CHECK` (para poder
 * agregar `emitir_recibo_pago` sin `ALTER TYPE … ADD VALUE`, que el migrador de este repo no puede
 * usar dentro de su propia transacción — ver el encabezado de `0039_recibos_reglas.sql`).
 *
 * Este archivo verifica la migración en sí, no la autorización de negocio de `trabajo` (esa la cubre
 * `documentos-rls.test.ts`): que la columna sea `text` de verdad, que el valor que ya existía como
 * enum siga siendo un valor válido, que el nuevo valor entre, y que el `CHECK` rechace cualquier otra
 * cosa. Se inserta con `session_replication_role = replica` a propósito: lo que se está probando es
 * la FORMA de la columna y el `CHECK`, no el trigger de negocio (`app.trabajo_antes_insert()`, que
 * exige un período emitido y ya tiene su propia batería en `ataques-escritura.test.ts`).
 *
 * Correr con: pnpm vitest run --project db packages/data/test/trabajo-tipo-migracion.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { borrarArbol, crearArbol, crearBarrio, poolAdmin, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let arbol: Arbol;

async function insertarTrabajoCrudo(tipo: string): Promise<{ id: string } | null> {
  await admin.query("set session_replication_role = replica");
  try {
    const { rows } = await admin.query<{ id: string }>(
      `insert into trabajo (barrio_id, tipo, referencia_id, solicitado_por)
       values ($1, $2, gen_random_uuid(), gen_random_uuid())
       returning id`,
      [arbol.barrioA1.id, tipo],
    );
    return rows[0] ?? null;
  } finally {
    await admin.query("set session_replication_role = origin");
  }
}

beforeAll(async () => {
  admin = poolAdmin();
  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from trabajo where barrio_id = $1", [arbol.barrioA1.id]);
  // Faltaba: sin esto, `barrio_barrio_id_tenant_node_id_fk` truena en `borrarArbol` porque la fila
  // de `barrio` (creada en `beforeAll` vía `crearBarrio`) seguía viva.
  await admin.query("delete from barrio where barrio_id = $1", [arbol.barrioA1.id]);
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await admin.end();
});

describe("la columna dejó de ser un enum nativo", () => {
  it("`trabajo.tipo` es `text` en el catálogo de Postgres", async () => {
    const { rows } = await admin.query<{ data_type: string }>(
      `select data_type from information_schema.columns where table_name = 'trabajo' and column_name = 'tipo'`,
    );
    expect(rows[0]?.data_type).toBe("text");
  });

  it("el tipo `app.tipo_trabajo` ya no existe", async () => {
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'app' and t.typname = 'tipo_trabajo'`,
    );
    expect(rows[0]?.n).toBe("0");
  });
});

describe("el ALTER COLUMN ... USING no perdió el valor original", () => {
  it("`emitir_documentos_periodo` (el único valor del enum viejo) se sigue pudiendo insertar", async () => {
    const fila = await insertarTrabajoCrudo("emitir_documentos_periodo");
    expect(fila?.id).toBeTruthy();
  });

  it("`emitir_recibo_pago` (el valor nuevo) también entra", async () => {
    const fila = await insertarTrabajoCrudo("emitir_recibo_pago");
    expect(fila?.id).toBeTruthy();
  });
});

describe("`trabajo_tipo_chk` rechaza un valor inventado", () => {
  it("un tipo que no está en la lista no se inserta", async () => {
    await expect(insertarTrabajoCrudo("emitir_algo_que_no_existe")).rejects.toThrow(/trabajo_tipo_chk/);
  });
});
