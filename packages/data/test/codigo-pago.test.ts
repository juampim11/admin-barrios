/**
 * El código de pago de la UF en la base (BL-012, migración `0059`): el número lo asigna la base al dar
 * de alta la unidad —siempre, aunque el insert traiga otro—, es único dentro del barrio, no cambia
 * nunca (tampoco si cambia el titular), y una unidad que da de alta un operador bajo RLS lo recibe
 * igual. Lo impreso se arma con el formato del barrio, que es configuración: cambiarlo no toca el
 * número.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { codigoDePago, leerCodigoDePago } from "@admin-barrios/shared/codigo-pago";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { borrarArbol, crearArbol, crearBarrio, crearUnidades, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;

async function numeros(barrioId: string): Promise<number[]> {
  const { rows } = await admin.query<{ n: string }>(
    "select codigo_pago_numero::text as n from unidad_funcional where barrio_id = $1 order by codigo_pago_numero",
    [barrioId],
  );
  return rows.map((r) => Number(r.n));
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioA2.id);
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  for (const tabla of ["unidad_obligado", "obligado", "unidad_funcional", "codigo_pago_secuencia", "barrio"]) {
    await admin.query(`delete from ${tabla} where barrio_id = any($1::uuid[])`, [[arbol.barrioA1.id, arbol.barrioA2.id]]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("el número del código de pago", () => {
  it("cada barrio numera desde 1, sin huecos ni repetidos, y un barrio no pisa al otro", async () => {
    await crearUnidades(admin, arbol.barrioA1.id, 5);
    await crearUnidades(admin, arbol.barrioA2.id, 3);
    expect(await numeros(arbol.barrioA1.id)).toEqual([1, 2, 3, 4, 5]);
    expect(await numeros(arbol.barrioA2.id)).toEqual([1, 2, 3]);
  });

  it("un insert de varias filas numera fila por fila; un número que venga en el insert se ignora", async () => {
    await admin.query(
      `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad, codigo_pago_numero)
       select $1, '9', g::text, 'construido', 1 from generate_series(1, 4) g`,
      [arbol.barrioA2.id],
    );
    expect(await numeros(arbol.barrioA2.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("un operador que da de alta una unidad bajo RLS también la recibe con su número", async () => {
    const { rows } = await conUsuario(db, arbol.usuarios.operadorA1, (tx) =>
      tx.execute<{ n: string }>(sql`
        insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
        values (${arbol.barrioA1.id}, '7', '1', 'construido') returning codigo_pago_numero::text as n
      `),
    );
    expect(rows[0]?.n).toBe("6");
  });

  it("no cambia nunca: ni a mano, ni porque cambie el titular de la unidad", async () => {
    const { rows } = await admin.query<{ id: string; n: string }>(
      "select id, codigo_pago_numero::text as n from unidad_funcional where barrio_id = $1 order by codigo_pago_numero limit 1",
      [arbol.barrioA1.id],
    );
    const uf = rows[0]!;
    await expect(
      admin.query("update unidad_funcional set codigo_pago_numero = 999 where id = $1", [uf.id]),
    ).rejects.toThrow(/no cambia/);

    // Un titular nuevo: el código sigue siendo el mismo.
    const { rows: o } = await admin.query<{ id: string }>(
      "insert into obligado (barrio_id, nombre) values ($1, 'Titular Nuevo') returning id",
      [arbol.barrioA1.id],
    );
    await admin.query(
      `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
       values ($1, $2, $3, 'propietario', current_date, true)`,
      [arbol.barrioA1.id, uf.id, o[0]!.id],
    );
    const { rows: despues } = await admin.query<{ n: string }>(
      "select codigo_pago_numero::text as n from unidad_funcional where id = $1",
      [uf.id],
    );
    expect(despues[0]?.n).toBe(uf.n);
  });

  it("cambiar el formato del barrio no toca el número: lo impreso cambia, y se lee de vuelta a la misma UF", async () => {
    const antes = await numeros(arbol.barrioA1.id);
    await admin.query(
      "update barrio set codigo_pago_largo = 8, codigo_pago_prefijo = '42', codigo_pago_separador = '' where barrio_id = $1",
      [arbol.barrioA1.id],
    );
    expect(await numeros(arbol.barrioA1.id)).toEqual(antes);
    const formato = { largo: 8, prefijo: "42", separador: "" as const };
    const impreso = codigoDePago(antes[0]!, formato);
    expect(impreso).toMatch(/^4200000001\d$/);
    expect(leerCodigoDePago(impreso, formato)).toBe(antes[0]);
  });

  it("el formato del barrio no lo cambia un rol de la aplicación: las columnas nacen cerradas", async () => {
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`update barrio set codigo_pago_largo = 9 where barrio_id = ${arbol.barrioA1.id}`),
      ),
    ).rejects.toThrow(/permission denied|permiso/);
  });
});
