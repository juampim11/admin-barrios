/**
 * Encargo 17b, puntos (h) e (i), contra Postgres real (`0089`):
 *  - (h) El documento del titular se devuelve **como dato**, sin el tipo pegado: «27989690», no
 *    «DNI 27989690» (la lista del padrón, la ficha y «Padrón a una fecha»). Guardado ya estaba así.
 *  - (i) El **CUIT informativo** del titular (`obligado.cuit_informativo`): entra por el alta, por la
 *    edición, por el cambio de titular y por la planilla; se valida; sale en la ficha, en la
 *    exportación y en «Padrón a una fecha»; y **no interviene en «es la misma persona»**.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { columnasDelPadron, columnasParaArmarElPadron } from "@admin-barrios/shared/padron";
import { conUsuario, type DbRequest } from "../src/client.ts";
import {
  agregarUnidad,
  cambiarTitular,
  confirmarImportacion,
  editarUnidad,
  exportarPadron,
  fichaDeUnidad,
  listarPadronEditable,
  padronAUnaFecha,
  vistaPreviaDeImportacion,
} from "../src/servicios/padron-edicion.ts";
import { borrarArbol, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const a1 = () => arbol.barrioA1.id;
const adminA1 = () => arbol.usuarios.adminBarrioA1;

// CUIT inventados con el verificador bien.
const CUIT_DE_ANA = "27272222229"; // contiene el DNI 27222222
const CUIT_DE_BEA = "27312223339";
const CUIT_DE_RAUL = "20111111112"; // el documento de IDENTIDAD de Raúl
const OTRO_CUIT = "27280001118";

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

const hoyDelBarrio = async () =>
  (await admin.query<{ h: string }>("select (now() at time zone 'America/Argentina/Buenos_Aires')::date::text as h")).rows[0]!.h;

const personas = async (donde: string, valores: unknown[] = []) =>
  (
    await admin.query<{ nombre: string; tipo_documento: string | null; numero_documento: string | null; cuit_cuil: string | null; cuit_informativo: string | null }>(
      `select nombre, tipo_documento, numero_documento, cuit_cuil, cuit_informativo from obligado where barrio_id = $1 and ${donde} order by nombre`,
      [a1(), ...valores],
    )
  ).rows;

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  for (const b of [arbol.barrioA1.id, arbol.barrioA2.id, arbol.barrioB1.id]) {
    await crearBarrio(admin, b, { figuraJuridica: "sa", adecuadoArt2075: "no_aplica" });
  }
});

afterAll(async () => {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const b of [arbol.barrioA1.id, arbol.barrioA2.id, arbol.barrioB1.id]) {
      for (const t of [
        "padron_evento", "unidad_contacto", "unidad_obligado", "obligado", "periodo_expensa", "coeficiente", "coeficiente_version",
        "unidad_funcional", "codigo_pago_secuencia", "mandato_administracion", "documento_barrio", "barrio_atributo_vigencia", "barrio",
      ]) {
        await c.query(`delete from ${t} where barrio_id = $1`, [b]);
      }
    }
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("17b: el documento como dato y el CUIT informativo del titular (0089)", () => {
  let unidadDeAna: string;
  let anaId: string;

  it("el alta: el titular con DNI lleva su CUIT informativo; el documento se guarda en dígitos, sin el tipo", async () => {
    unidadDeAna = (
      await como(adminA1(), (tx) =>
        agregarUnidad(tx, {
          barrioId: a1(),
          manzana: "30",
          lote: "1",
          estado: "construido",
          titulares: [
            { nombre: "Ana Ledesma", documento: "27.222.222", cuitInformativo: "27-27222222-9", mail: "ana.ledesma@correo.example" },
            // Raúl se identifica con un CUIT: el informativo con ese mismo número se ignora.
            { nombre: "Raúl Molina", documento: "20-11111111-2", cuitInformativo: CUIT_DE_RAUL },
          ],
        }),
      )
    ).unidadFuncionalId;
    expect(await personas("nombre in ('Ana Ledesma', 'Raúl Molina')")).toEqual([
      { nombre: "Ana Ledesma", tipo_documento: "DNI", numero_documento: "27222222", cuit_cuil: null, cuit_informativo: CUIT_DE_ANA },
      { nombre: "Raúl Molina", tipo_documento: "CUIT", numero_documento: CUIT_DE_RAUL, cuit_cuil: CUIT_DE_RAUL, cuit_informativo: null },
    ]);
  });

  it("(h) la ficha y la lista del padrón muestran el número solo: «27222222», no «DNI 27222222»", async () => {
    const ficha = (await como(adminA1(), (tx) => fichaDeUnidad(tx, { unidadFuncionalId: unidadDeAna })))!;
    const deFicha = ficha.titulares.map((t) => ({ nombre: t.nombre, documento: t.documento, tipoDocumento: t.tipoDocumento, cuitInformativo: t.cuitInformativo }));
    expect(deFicha).toEqual([
      { nombre: "Ana Ledesma", documento: "27222222", tipoDocumento: "DNI", cuitInformativo: "27-27222222-9" },
      { nombre: "Raúl Molina", documento: "20-11111111-2", tipoDocumento: "CUIT", cuitInformativo: null },
    ]);
    anaId = ficha.titulares.find((t) => t.nombre === "Ana Ledesma")!.obligadoId;
    const lista = await como(adminA1(), (tx) =>
      listarPadronEditable(tx, { barrioId: a1(), filtro: "todas", busqueda: "", limite: 100, desplazamiento: 0 }),
    );
    expect(lista.filas.find((f) => f.id === unidadDeAna)!.titulares).toEqual([
      { nombre: "Ana Ledesma", documento: "27222222" },
      { nombre: "Raúl Molina", documento: "20-11111111-2" },
    ]);
  });

  it("(h) ningún camino guarda el tipo pegado al número: «DNI 27222222» se rechaza en el borde", async () => {
    await expect(
      como(adminA1(), (tx) =>
        agregarUnidad(tx, { barrioId: a1(), manzana: "30", lote: "9", estado: "baldio", titulares: [{ nombre: "Con Tipo Pegado", documento: "DNI 27222222" }] }),
      ),
    ).rejects.toThrow();
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from obligado where barrio_id = $1 and numero_documento !~ '^[0-9]+$'",
      [a1()],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("el alta valida el verificador, y rechaza un CUIT informativo distinto del CUIT de identidad", async () => {
    const base = { barrioId: a1(), manzana: "30", lote: "8", estado: "baldio" as const };
    await expect(
      como(adminA1(), (tx) => agregarUnidad(tx, { ...base, titulares: [{ nombre: "Mal Verificador", documento: "28000111", cuitInformativo: "27280001119" }] })),
    ).rejects.toThrow(/dígito verificador/);
    await expect(
      como(adminA1(), (tx) => agregarUnidad(tx, { ...base, titulares: [{ nombre: "Dos Cuits", documento: CUIT_DE_BEA, cuitInformativo: OTRO_CUIT }] })),
    ).rejects.toThrow(/ya se identifica con un CUIT/);
    const { rows } = await admin.query("select 1 from unidad_funcional where barrio_id = $1 and manzana = '30' and lote = '8'", [a1()]);
    expect(rows).toHaveLength(0);
  });

  it("la edición: cambia y borra el CUIT informativo de un titular vigente, y queda en el historial sin el número", async () => {
    await como(adminA1(), (tx) =>
      editarUnidad(tx, { unidadFuncionalId: unidadDeAna, estado: "construido", cuitsInformativos: [{ obligadoId: anaId, cuit: OTRO_CUIT }] }),
    );
    expect((await personas("id = $2", [anaId]))[0]!.cuit_informativo).toBe(OTRO_CUIT);
    // Sin el campo, no se toca (un formulario que no lo conoce no lo pisa).
    await como(adminA1(), (tx) => editarUnidad(tx, { unidadFuncionalId: unidadDeAna, estado: "construido" }));
    expect((await personas("id = $2", [anaId]))[0]!.cuit_informativo).toBe(OTRO_CUIT);
    // Vacío lo borra.
    await como(adminA1(), (tx) =>
      editarUnidad(tx, { unidadFuncionalId: unidadDeAna, estado: "construido", cuitsInformativos: [{ obligadoId: anaId, cuit: "" }] }),
    );
    expect((await personas("id = $2", [anaId]))[0]!.cuit_informativo).toBeNull();
    await como(adminA1(), (tx) =>
      editarUnidad(tx, { unidadFuncionalId: unidadDeAna, estado: "construido", cuitsInformativos: [{ obligadoId: anaId, cuit: CUIT_DE_ANA }] }),
    );
    const { rows: ev } = await admin.query<{ detalle: string }>(
      "select detalle from padron_evento where unidad_funcional_id = $1 and tipo = 'edicion' order by created_at, id",
      [unidadDeAna],
    );
    expect(ev.map((e) => e.detalle)).toEqual([
      "Edición: CUIT de Ana Ledesma.",
      "Edición: CUIT de Ana Ledesma quitado.",
      "Edición: CUIT de Ana Ledesma.",
    ]);
    expect(ev.some((e) => /\d{11}|\d{2}-\d{8}-\d/.test(e.detalle))).toBe(false);
    // No cambia el documento de identidad.
    expect(await personas("id = $2", [anaId])).toEqual([
      { nombre: "Ana Ledesma", tipo_documento: "DNI", numero_documento: "27222222", cuit_cuil: null, cuit_informativo: CUIT_DE_ANA },
    ]);
  });

  it("la edición rechaza a quien no es titular vigente de la unidad, y un CUIT distinto para quien se identifica con CUIT", async () => {
    const otra = (
      await como(adminA1(), (tx) =>
        agregarUnidad(tx, { barrioId: a1(), manzana: "30", lote: "2", estado: "baldio", titulares: [{ nombre: "Beatriz Otra", documento: "31222333" }] }),
      )
    ).unidadFuncionalId;
    const ajeno = await capturar(() =>
      como(adminA1(), (tx) => editarUnidad(tx, { unidadFuncionalId: otra, estado: "baldio", cuitsInformativos: [{ obligadoId: anaId, cuit: OTRO_CUIT }] })),
    );
    expect(ajeno.codigo).toBe("dato_invalido");
    expect((await personas("id = $2", [anaId]))[0]!.cuit_informativo).toBe(CUIT_DE_ANA);
    const raulId = (await admin.query<{ id: string }>("select id from obligado where barrio_id = $1 and cuit_cuil = $2", [a1(), CUIT_DE_RAUL])).rows[0]!.id;
    const conCuit = await capturar(() =>
      como(adminA1(), (tx) =>
        editarUnidad(tx, { unidadFuncionalId: unidadDeAna, estado: "construido", cuitsInformativos: [{ obligadoId: raulId, cuit: OTRO_CUIT }] }),
      ),
    );
    expect(conCuit.codigo).toBe("dato_invalido");
    expect(conCuit.message).toMatch(/Raúl Molina.*ya se identifica con un CUIT, y no es este/);
    // Quien no administra el barrio no lo edita.
    const operador = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        editarUnidad(tx, { unidadFuncionalId: unidadDeAna, estado: "construido", cuitsInformativos: [{ obligadoId: anaId, cuit: "" }] }),
      ),
    );
    expect(operador.codigo).toBe("sin_permiso");
    expect((await personas("id = $2", [anaId]))[0]!.cuit_informativo).toBe(CUIT_DE_ANA);
  });

  it("NO interviene en «es la misma persona»: no tiene unicidad ni reconoce a nadie", async () => {
    // Otra persona, con otro DNI, informa como CUIT el número con el que Raúl se IDENTIFICA, y otra
    // más informa el mismo CUIT que Ana: entran las dos, como personas nuevas, sin preguntar nada.
    await como(adminA1(), (tx) =>
      agregarUnidad(tx, {
        barrioId: a1(),
        manzana: "30",
        lote: "3",
        estado: "baldio",
        titulares: [
          { nombre: "Carlos Tercero", documento: "30111222", cuitInformativo: CUIT_DE_RAUL },
          { nombre: "Diana Cuarta", documento: "28000111", cuitInformativo: CUIT_DE_ANA },
        ],
      }),
    );
    expect(await personas("nombre in ('Carlos Tercero', 'Diana Cuarta')")).toEqual([
      { nombre: "Carlos Tercero", tipo_documento: "DNI", numero_documento: "30111222", cuit_cuil: null, cuit_informativo: CUIT_DE_RAUL },
      { nombre: "Diana Cuarta", tipo_documento: "DNI", numero_documento: "28000111", cuit_cuil: null, cuit_informativo: CUIT_DE_ANA },
    ]);
    // Raúl sigue siendo uno solo, y nadie más quedó con su identidad.
    expect(await personas("cuit_cuil = $2", [CUIT_DE_RAUL])).toHaveLength(1);
    // A la inversa: alguien que se identifica con el CUIT que Ana solo INFORMA no es Ana.
    await como(adminA1(), (tx) =>
      agregarUnidad(tx, { barrioId: a1(), manzana: "30", lote: "4", estado: "baldio", titulares: [{ nombre: "Elsa Quinta", documento: CUIT_DE_ANA }] }),
    );
    expect(await personas("cuit_cuil = $2", [CUIT_DE_ANA])).toEqual([
      { nombre: "Elsa Quinta", tipo_documento: "CUIT", numero_documento: CUIT_DE_ANA, cuit_cuil: CUIT_DE_ANA, cuit_informativo: null },
    ]);
    expect((await personas("id = $2", [anaId]))[0]!.nombre).toBe("Ana Ledesma");
  });

  it("el cambio de titular: el nuevo trae su CUIT informativo; a una persona que ya estaba, se le guarda", async () => {
    const unidad = (
      await como(adminA1(), (tx) =>
        agregarUnidad(tx, { barrioId: a1(), manzana: "30", lote: "5", estado: "baldio", titulares: [{ nombre: "Primer Dueño", documento: "25000111" }] }),
      )
    ).unidadFuncionalId;
    await admin.query("update unidad_obligado set desde = '2024-01-01' where unidad_funcional_id = $1", [unidad]);
    // Beatriz ya está en el barrio (Mza 30 · Lote 2), sin CUIT informativo: ahora lo trae.
    await como(adminA1(), (tx) =>
      cambiarTitular(tx, {
        unidadFuncionalId: unidad,
        desde: "2025-06-01",
        motivo: "venta",
        titular: { nombre: "Beatriz Otra", documento: "31222333", cuitInformativo: "27-31222333-9" },
      }),
    );
    expect(await personas("numero_documento = '31222333'")).toEqual([
      { nombre: "Beatriz Otra", tipo_documento: "DNI", numero_documento: "31222333", cuit_cuil: null, cuit_informativo: CUIT_DE_BEA },
    ]);
    const ficha = (await como(adminA1(), (tx) => fichaDeUnidad(tx, { unidadFuncionalId: unidad })))!;
    expect(ficha.titulares.map((t) => [t.nombre, t.documento, t.cuitInformativo])).toEqual([["Beatriz Otra", "31222333", "27-31222333-9"]]);
    // El titular anterior también va sin el tipo pegado.
    expect(ficha.anteriores.map((t) => [t.nombre, t.documento, t.tipoDocumento, t.cuitInformativo])).toEqual([["Primer Dueño", "25000111", "DNI", null]]);
  });

  it("(h)+(i) «Padrón a una fecha»: el documento sin el tipo, y el CUIT informativo en su columna, la última", async () => {
    const hoy = await hoyDelBarrio();
    const filas = await como(adminA1(), (tx) => padronAUnaFecha(tx, { barrioId: a1(), fecha: hoy }));
    expect(filas[0]).toEqual(["unidad", "numero_accion", "titular", "caracter", "documento", "porcentaje_titularidad", "desde", "cuit"]);
    const de = (unidad: string) => filas.filter((f) => f[0] === unidad).map((f) => [f[2], f[4], f[7]]);
    expect(de("Mza 30 · Lote 1")).toEqual([
      ["Ana Ledesma", "27222222", "27-27222222-9"],
      ["Raúl Molina", "20-11111111-2", ""],
    ]);
    expect(de("Mza 30 · Lote 5")).toEqual([["Beatriz Otra", "31222333", "27-31222333-9"]]);
    expect(filas.slice(1).some((f) => /DNI|CUIT/.test(f[4]!))).toBe(false);
  });

  it("la planilla: la columna `cuit` entra en un alta, corrige a un titular que ya está y se exporta", async () => {
    const encabezado = columnasDelPadron(false);
    expect(encabezado.at(-1)).toBe("cuit");
    const fila = (v: Partial<Record<(typeof encabezado)[number], string>>) => encabezado.map((c) => v[c] ?? "");
    const filas = [
      [...encabezado],
      // Alta, con una persona nueva en dos unidades: el CUIT viene solo en la segunda fila.
      fila({ manzana: "31", lote: "1", estado: "Baldío", titular: "Iván Planilla", cuit_o_dni: "29000111" }),
      fila({ manzana: "31", lote: "2", estado: "Baldío", titular: "Iván Planilla", cuit_o_dni: "29000111", cuit: "20-29000111-1" }),
      // Corrige: Diana ya es titular de Mza 30 · Lote 3 junto a Carlos; la planilla le cambia el CUIT.
      fila({ manzana: "30", lote: "3", titular: "Carlos Tercero", cuit_o_dni: "30111222", recibe_boleta: "sí" }),
      fila({ manzana: "30", lote: "3", titular: "Diana Cuarta", cuit_o_dni: "28000111", cuit: OTRO_CUIT }),
    ];
    const previa = await como(adminA1(), (tx) => vistaPreviaDeImportacion(tx, { barrioId: a1(), archivo: "padron.csv", filas }));
    expect(previa.ok).toBe(true);
    expect(previa.aRevisar).toBe(0);
    expect(previa.unidades.map((u) => u.accion)).toEqual(["alta", "alta", "corrige"]);
    expect(previa.unidades[2]!.detalle).toContain("CUIT de Diana Cuarta: 27-28000111-8.");
    const r = await como(adminA1(), (tx) => confirmarImportacion(tx, { barrioId: a1(), archivo: "padron.csv", filas }));
    expect(r).toEqual({ altas: 2, correcciones: 1, sinCambios: 0 });
    // Iván es UNA persona (por su DNI) y quedó con el CUIT que traía una de sus filas.
    expect(await personas("numero_documento = '29000111'")).toEqual([
      { nombre: "Iván Planilla", tipo_documento: "DNI", numero_documento: "29000111", cuit_cuil: null, cuit_informativo: "20290001111" },
    ]);
    expect((await personas("nombre = 'Diana Cuarta'"))[0]!.cuit_informativo).toBe(OTRO_CUIT);
    // Carlos vino con la celda vacía: conserva el suyo.
    expect((await personas("nombre = 'Carlos Tercero'"))[0]!.cuit_informativo).toBe(CUIT_DE_RAUL);

    const exportado = await como(adminA1(), (tx) => exportarPadron(tx, { barrioId: a1() }));
    const columnas = columnasParaArmarElPadron(false);
    expect(exportado[0]).toEqual([...columnas]);
    const celda = (f: string[], c: (typeof columnas)[number]) => f[columnas.indexOf(c)];
    const deIvan = exportado.find((f) => f[0] === "31" && f[1] === "2")!;
    expect([celda(deIvan, "cuit_o_dni"), celda(deIvan, "cuit")]).toEqual(["29000111", "20290001111"]);
    const deRaul = exportado.find((f) => celda(f, "titular") === "Raúl Molina")!;
    expect([celda(deRaul, "cuit_o_dni"), celda(deRaul, "cuit")]).toEqual([CUIT_DE_RAUL, ""]);
    // Lo exportado vuelve a entrar sin cambios.
    const vuelta = await como(adminA1(), (tx) => vistaPreviaDeImportacion(tx, { barrioId: a1(), archivo: "padron.csv", filas: exportado }));
    expect(vuelta.ok).toBe(true);
    expect(vuelta.unidades.every((u) => u.accion === "sin_cambios")).toBe(true);
  });

  it("la planilla: un CUIT con el verificador mal, o distinto del CUIT de identidad, frena la importación entera", async () => {
    const encabezado = columnasDelPadron(false);
    const fila = (v: Partial<Record<(typeof encabezado)[number], string>>) => encabezado.map((c) => v[c] ?? "");
    for (const mala of [
      fila({ manzana: "32", lote: "1", titular: "Mal Verificador", cuit_o_dni: "26000111", cuit: "20260001110" }),
      fila({ manzana: "32", lote: "1", titular: "Dos Cuits", cuit_o_dni: CUIT_DE_BEA, cuit: OTRO_CUIT }),
    ]) {
      const e = await capturar(() => como(adminA1(), (tx) => confirmarImportacion(tx, { barrioId: a1(), archivo: "padron.csv", filas: [[...encabezado], mala] })));
      expect(e.codigo).toBe("planilla_con_errores");
    }
    const { rows } = await admin.query("select 1 from unidad_funcional where barrio_id = $1 and manzana = '32'", [a1()]);
    expect(rows).toHaveLength(0);
  });

  it("una planilla de antes, sin la columna, no le borra el CUIT a nadie", async () => {
    const filas = [
      ["manzana", "lote", "superficie_m2", "titular", "cuit_o_dni", "recibe_boleta"],
      ["30", "1", "700,00", "Ana Ledesma", "27222222", "sí"],
      ["30", "1", "", "Raúl Molina", CUIT_DE_RAUL, ""],
    ];
    const r = await como(adminA1(), (tx) => confirmarImportacion(tx, { barrioId: a1(), archivo: "vieja.csv", filas }));
    expect(r.correcciones).toBe(1);
    expect((await personas("id = $2", [anaId]))[0]!.cuit_informativo).toBe(CUIT_DE_ANA);
  });

  it("la base: 11 dígitos, y nunca junto a un CUIT de identidad", async () => {
    await expect(
      admin.query("insert into obligado (barrio_id, nombre, tipo_documento, numero_documento, cuit_informativo) values ($1, 'X', 'DNI', '20000111', '2720000111')", [a1()]),
    ).rejects.toThrow(/obligado_cuit_informativo_chk/);
    await expect(
      admin.query(
        "insert into obligado (barrio_id, nombre, tipo_documento, numero_documento, cuit_cuil, cuit_informativo) values ($1, 'X', 'CUIT', $2, $2, $3)",
        [a1(), "20301112220", OTRO_CUIT],
      ),
    ).rejects.toThrow(/obligado_cuit_informativo_sin_cuit_chk/);
  });
});
