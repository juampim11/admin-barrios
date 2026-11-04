/**
 * La búsqueda de unidades de Cobros y del Padrón, contra la base (encargo 10, BL-030 c). Las dos
 * pantallas usan la misma condición (`busqueda-de-unidad.ts`); acá se prueba por
 * `unidadesQueCoincidenConLaBusqueda` (Cobros) y por `listarPadronEditable` (Padrón).
 *
 * El barrio tiene las manzanas 1, 10, 11 y A, para que «Mza 1» que trajera la 10 o la 11 se vea.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { codigoDePago } from "@admin-barrios/shared/codigo-pago";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { unidadesQueCoincidenConLaBusqueda } from "../src/servicios/cobros.ts";
import { listarPadronEditable } from "../src/servicios/padron-edicion.ts";
import { borrarArbol, crearArbol, crearBarrio, crearUnidades, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
/** `manzana-lote` → id. */
const unidad = new Map<string, string>();

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioB1.id);
  for (const [manzana, cantidad] of [["1", 9], ["10", 6], ["11", 3], ["A", 2]] as const) {
    const ids = await crearUnidades(admin, arbol.barrioA1.id, cantidad, manzana);
    ids.forEach((id, i) => unidad.set(`${manzana}-${i + 1}`, id));
  }
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  for (const b of [arbol.barrioA1.id, arbol.barrioB1.id]) {
    await admin.query("delete from unidad_funcional where barrio_id = $1", [b]);
    await admin.query("delete from barrio where barrio_id = $1", [b]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

const enCobros = async (busqueda: string): Promise<string[]> => {
  const ids = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
    unidadesQueCoincidenConLaBusqueda(tx, { barrioId: arbol.barrioA1.id, busqueda }),
  );
  return [...(ids ?? [])].sort();
};

const enPadron = async (busqueda: string): Promise<string[]> => {
  const r = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
    listarPadronEditable(tx, { barrioId: arbol.barrioA1.id, filtro: "todas", busqueda, limite: 100, desplazamiento: 0 }),
  );
  return r.filas.map((u) => u.id).sort();
};

const deLaManzana = (manzana: string): string[] =>
  [...unidad.entries()].filter(([clave]) => clave.split("-")[0] === manzana).map(([, id]) => id).sort();

describe("buscar una manzana trae esa manzana y ninguna otra (BL-030 c)", () => {
  it.each(["Mza 1", "mza 1", "1-"])("%j en Cobros y en el Padrón: la manzana 1, sin la 10 ni la 11", async (busqueda) => {
    expect(await enCobros(busqueda)).toEqual(deLaManzana("1"));
    expect(await enPadron(busqueda)).toEqual(deLaManzana("1"));
  });

  it("la manzana con letra también", async () => {
    expect(await enCobros("Mza A")).toEqual(deLaManzana("A"));
  });

  it("«Mza 1 Lote 2» trae esa unidad (y en el Padrón, igual)", async () => {
    const id = unidad.get("1-2")!;
    expect(await enCobros("Mza 1 Lote 2")).toEqual([id]);
    expect(await enPadron("Mza 1 Lote 2")).toEqual([id]);
    expect(await enCobros("mza 10 lote 2")).toEqual([unidad.get("10-2")!]);
  });
});

describe("el código de pago, con o sin ceros y con o sin verificador (BL-030 c)", () => {
  it("«19», «000019» y «000019-x» traen la misma unidad, y no la del código 1", async () => {
    const { rows } = await admin.query<{ id: string; numero: string; largo: number; prefijo: string; separador: string }>(
      `select u.id, u.codigo_pago_numero::text as numero, b.codigo_pago_largo as largo,
              b.codigo_pago_prefijo as prefijo, b.codigo_pago_separador as separador
         from unidad_funcional u join barrio b on b.barrio_id = u.barrio_id
        where u.barrio_id = $1 and u.codigo_pago_numero >= 10
        order by u.codigo_pago_numero limit 1`,
      [arbol.barrioA1.id],
    );
    const { id, numero, largo, prefijo, separador } = rows[0]!;
    const conCeros = numero.padStart(largo, "0");
    const impreso = codigoDePago(Number(numero), { largo, prefijo, separador: "-" });
    const verificador = impreso.slice(-1);

    for (const busqueda of [numero, conCeros, `${conCeros}-${verificador}`, `${conCeros}-x`, impreso]) {
      expect(await enCobros(busqueda), busqueda).toEqual([id]);
    }
    // El impreso sin separador, como sale en un extracto, si el barrio no usa prefijo.
    if (prefijo === "" && separador !== undefined) {
      expect(await enCobros(`${conCeros}${verificador}`)).toEqual([id]);
    }
    expect(await enPadron(conCeros)).toEqual([id]);
  });
});

describe("la búsqueda no cruza barrios (RLS)", () => {
  it("otro barrio no encuentra la manzana 1 de este", async () => {
    const ids = await conUsuario(db, arbol.usuarios.adminEstudioB, (tx) =>
      unidadesQueCoincidenConLaBusqueda(tx, { barrioId: arbol.barrioA1.id, busqueda: "Mza 1" }),
    );
    expect(ids?.size).toBe(0);
  });
});
