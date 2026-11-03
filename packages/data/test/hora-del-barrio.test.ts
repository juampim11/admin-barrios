/**
 * La hora del barrio (BL-010, migración `0061`): los sellos de tiempo se muestran en la zona del
 * barrio con un solo helper, `app.en_hora_del_barrio`, que usan las cinco lecturas con hora
 * (documentos, recibos, órdenes de pago —lista y detalle— y el paquete de distribución). El texto no
 * depende del `TimeZone` de la sesión, la zona es dato del barrio y nace cerrada para `app_request`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { formatearFechaHora } from "@admin-barrios/shared/fechas";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { borrarArbol, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;

/** 00:30 UTC del 30/08: en Argentina (UTC−3) todavía es el 29 a las 21:30. */
const INSTANTE = "2026-08-30 00:30:00+00";

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioA2.id);
});

afterAll(async () => {
  for (const t of ["barrio_atributo_vigencia", "barrio"]) {
    await admin.query(`delete from ${t} where barrio_id = any($1::uuid[])`, [[arbol.barrioA1.id, arbol.barrioA2.id]]);
  }
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

const enHoraDelBarrio = (usuario: string, barrioId: string, sesionTz: string) =>
  conUsuario(db, usuario, async (tx) => {
    await tx.execute(sql.raw(`set local time zone '${sesionTz}'`));
    const { rows } = await tx.execute<{ texto: string }>(
      sql`select app.en_hora_del_barrio(${INSTANTE}::timestamptz, ${barrioId}) as texto`,
    );
    return rows[0]?.texto;
  });

describe("la hora del barrio", () => {
  it("un barrio nuevo muestra la hora oficial argentina, y el día es el local (no el de UTC)", async () => {
    const texto = await enHoraDelBarrio(arbol.usuarios.adminBarrioA1, arbol.barrioA1.id, "UTC");
    expect(texto).toBe("2026-08-29 21:30");
    expect(formatearFechaHora(texto!)).toBe("29/08/2026 21:30");
  });

  it("no depende del TimeZone de la sesión", async () => {
    expect(await enHoraDelBarrio(arbol.usuarios.adminBarrioA1, arbol.barrioA1.id, "Asia/Tokyo")).toBe("2026-08-29 21:30");
  });

  it("es dato del barrio: otro barrio con otra zona ve el mismo instante con su hora", async () => {
    await admin.query("update barrio set zona_horaria = 'Europe/Madrid' where barrio_id = $1", [arbol.barrioA2.id]);
    expect(await enHoraDelBarrio(arbol.usuarios.adminEstudioA, arbol.barrioA2.id, "UTC")).toBe("2026-08-30 02:30");
  });

  it("rechaza una zona que la base no conoce", async () => {
    await expect(
      admin.query("update barrio set zona_horaria = 'America/Ciudad_Inventada' where barrio_id = $1", [arbol.barrioA2.id]),
    ).rejects.toThrow(/barrio_zona_horaria_chk/);
  });

  it("nace cerrada para el rol de request: un administrador del barrio no la cambia desde la app", async () => {
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        tx.execute(sql`update barrio set zona_horaria = 'UTC' where barrio_id = ${arbol.barrioA1.id}`),
      ),
    ).rejects.toThrow(/permission denied|permiso denegado/);
  });
});
