/**
 * Encargo 17b, punto 7(d), contra Postgres real: el historial de valores de cada concepto de boleta
 * —vigente desde, hasta y quién lo cargó— que muestra «Conceptos del barrio».
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { crearConceptoBoleta, historialDeValoresDeConceptos, registrarValorConcepto } from "../src/servicios/conceptos-boleta.ts";
import { borrarArbol, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;

const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);

const fechaRelativa = async (dias: number) =>
  (await admin.query<{ f: string }>("select ((now() at time zone 'America/Argentina/Buenos_Aires')::date + $1::int)::text as f", [dias])).rows[0]!.f;

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, barrio());
  await crearBarrio(admin, arbol.barrioB1.id);
  // Quién cargó se lee de `usuario_demo` (el directorio de personas de la demo), como en el historial de la cuota.
  await admin.query(
    `insert into usuario_demo (user_id, email, nombre, descripcion) values ($1, 'admin.historial@ejemplo.test', 'Admin del Historial', 'Administración')
     on conflict (user_id) do nothing`,
    [arbol.usuarios.adminBarrioA1],
  );
});

afterAll(async () => {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query("delete from usuario_demo where user_id = $1", [arbol.usuarios.adminBarrioA1]);
    for (const t of ["padron_evento", "concepto_boleta_valor", "concepto_boleta", "barrio"]) {
      await c.query(`delete from ${t} where barrio_id = any($1::uuid[])`, [[barrio(), arbol.barrioB1.id]]);
    }
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("el historial de valores de un concepto", () => {
  it("cada valor con su vigencia, su estado y quién lo cargó, del más nuevo al más viejo", async () => {
    const [hace60, hace10, hoy, en20] = [await fechaRelativa(-60), await fechaRelativa(-10), await fechaRelativa(0), await fechaRelativa(20)];
    const { conceptoId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      crearConceptoBoleta(tx, {
        barrioId: barrio(), nombre: "Uso del salón", clase: "cargo", metodo: "monto_fijo", baseCalculo: "sin_base", clasificacionFiscal: "sin_clasificar",
        financiamiento: null, requiereAdmin: false, ordenImpresion: 0, vigenteDesde: hace60, montoFijo: "10000.00", porcentaje: null, precioUnitario: null, tope: null,
      } as never),
    );
    for (const [desde, monto] of [[hace10, "12500.00"], [en20, "15000.00"]] as const) {
      await como(arbol.usuarios.adminBarrioA1, (tx) =>
        registrarValorConcepto(tx, { conceptoBoletaId: conceptoId, vigenteDesde: desde, montoFijo: monto, porcentaje: null, precioUnitario: null, tope: null }),
      );
    }
    // Un valor que venía de antes, sin una persona detrás (así quedan los de una carga inicial).
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("update concepto_boleta_valor set aprobada_por = null where concepto_boleta_id = $1 and vigente_desde = $2", [conceptoId, hace60]);
      await c.query("commit");
    } finally {
      c.release();
    }

    const historial = await como(arbol.usuarios.adminBarrioA1, (tx) => historialDeValoresDeConceptos(tx, { barrioId: barrio() }));
    expect(historial.get(conceptoId)?.map(({ id: _id, ...v }) => v)).toEqual([
      { vigenteDesde: en20, vigenteHasta: null, estado: "programado", montoFijo: "15000.00", porcentaje: null, precioUnitario: null, tope: null, cargadoPor: "Admin del Historial", cargadoEl: hoy },
      { vigenteDesde: hace10, vigenteHasta: en20, estado: "vigente", montoFijo: "12500.00", porcentaje: null, precioUnitario: null, tope: null, cargadoPor: "Admin del Historial", cargadoEl: hoy },
      { vigenteDesde: hace60, vigenteHasta: hace10, estado: "anterior", montoFijo: "10000.00", porcentaje: null, precioUnitario: null, tope: null, cargadoPor: null, cargadoEl: hoy },
    ]);

    // Lo ve quien lee el barrio (el operador), y nadie de otro estudio.
    expect((await como(arbol.usuarios.operadorA1, (tx) => historialDeValoresDeConceptos(tx, { barrioId: barrio() }))).get(conceptoId)).toHaveLength(3);
    expect((await como(arbol.usuarios.adminEstudioB, (tx) => historialDeValoresDeConceptos(tx, { barrioId: barrio() }))).size).toBe(0);
  });
});
