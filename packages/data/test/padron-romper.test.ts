/**
 * Intento de ROMPER el alta de barrio y el padrón editable (T3, migración `0065`), contra Postgres real.
 *
 * Complementa `padron-edicion.test.ts` con los casos borde: filas raras en la planilla, cuentas que
 * chocan, fechas de titular en el borde, baja/alta frente a un borrador, coeficientes que se pisan,
 * saldo inicial que cambia entre generar y emitir, y permisos.
 *
 * Los casos marcados con `it.fails` son **bugs o piezas faltantes** encontrados por el tester: el
 * comentario de cada uno dice qué se espera y qué pasa. Cuando se arreglen, `it.fails` empieza a
 * fallar y hay que pasarlo a `it`.
 *
 * Cada escenario de emisión usa un barrio propio (un período emitido no se puede deshacer y
 * contaminaría al siguiente). Todo lo que se crea se borra en `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { columnasDelPadron } from "@admin-barrios/shared/padron";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import {
  agregarUnidad,
  cambiarTitular,
  coeficientesDelBarrio,
  confirmarImportacion,
  crearVersionCoeficientes,
  darDeBaja,
  editarUnidad,
  exportarPadron,
  fichaDeUnidad,
  listarPadronEditable,
  vistaPreviaDeImportacion,
} from "../src/servicios/padron-edicion.ts";
import { borrarArbol, borrarParametrosDe, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
const barriosExtra: string[] = [];

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminA = () => arbol.usuarios.adminEstudioA;

/** CBU válido inventado (entidad 000) con el número `n` en la cuenta: verificadores calculados. */
function cbu(n: number): string {
  const cuerpo = `1${String(n).padStart(12, "0")}`;
  const pesos = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3];
  const suma = [...cuerpo].reduce((s, d, i) => s + Number(d) * pesos[i]!, 0);
  return `00000031${cuerpo}${(10 - (suma % 10)) % 10}`;
}

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

/** Un barrio nuevo de Estudio Pérez (A), liquidación variable, cuenta por unidad, con un concepto. */
async function nuevoBarrio(nombre: string): Promise<{ id: string; conceptoId: string }> {
  const { rows } = await admin.query<{ id: string }>(
    "insert into tenant_node (tipo, nombre, parent_id) values ('barrio', $1, $2) returning id",
    [nombre, arbol.adminA.id],
  );
  const id = rows[0]!.id;
  barriosExtra.push(id);
  await crearBarrio(admin, id, { figuraJuridica: "sa", adecuadoArt2075: "no_aplica" });
  await admin.query(
    `update barrio set cuenta_cbu = $2, identificacion_pago = 'cuenta_por_unidad', recaudador = 'Recaudador' where barrio_id = $1`,
    [id, cbu(800_000 + barriosExtra.length)],
  );
  const { rows: c } = await admin.query<{ id: string }>(
    "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
    [id],
  );
  return { id, conceptoId: c[0]!.id };
}

async function periodo(barrioId: string, conceptoId: string, p: string, monto = "3000.00"): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, $2, $3) returning id",
    [barrioId, p, `${p}-10`],
  );
  await admin.query(
    "insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', $4)",
    [barrioId, rows[0]!.id, conceptoId, monto],
  );
  return rows[0]!.id;
}

const unidad = (barrioId: string, manzana: string, lote: string, extra: Record<string, unknown> = {}) =>
  como(adminA(), (tx) => agregarUnidad(tx, { barrioId, manzana, lote, estado: "baldio", titulares: [], ...extra } as never));

const generar = (periodoId: string) =>
  como(adminA(), (tx) => generarLiquidaciones(tx, { periodoId, origenSaldo: "calculado", fechaCorteMora: "2026-11-01" }));

async function limpiarBarrio(c: pg.PoolClient, barrioId: string) {
  for (const t of [
    "padron_evento", "interes_devengado", "saldo_uf", "item_liquidacion", "liquidacion", "gasto_periodo", "periodo_expensa",
    "concepto", "coeficiente", "coeficiente_version", "cuota_fija", "cuota_fija_version", "unidad_contacto", "unidad_obligado",
    "obligado", "unidad_funcional", "codigo_pago_secuencia", "mandato_administracion", "documento_barrio",
    "barrio_atributo_vigencia", "barrio",
  ]) {
    await c.query(`delete from ${t} where barrio_id = $1`, [barrioId]);
  }
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  for (const [b, cuenta] of [
    [arbol.barrioA1.id, cbu(900_001)],
    [arbol.barrioA2.id, cbu(900_002)],
    [arbol.barrioB1.id, cbu(900_003)],
  ] as const) {
    await crearBarrio(admin, b, { figuraJuridica: "sa", adecuadoArt2075: "no_aplica" });
    await admin.query(
      `update barrio set cuenta_cbu = $2, identificacion_pago = 'cuenta_por_unidad', recaudador = 'Recaudador' where barrio_id = $1`,
      [b, cuenta],
    );
  }
});

afterAll(async () => {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const b of [...barriosExtra, arbol.barrioA1.id, arbol.barrioA2.id, arbol.barrioB1.id]) await limpiarBarrio(c, b);
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarParametrosDe(admin, barriosExtra);
  for (const id of barriosExtra) await admin.query("delete from tenant_node where id = $1", [id]);
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("unidad: manzana y lote", () => {
  /*
   * BUG. `agregarUnidad` guarda manzana y lote tal cual, y el único que impide el duplicado es
   * `uq_uf_barrio_manzana_lote`, que distingue mayúsculas. «Mza A · Lote 1» y «Mza a · Lote 1» quedan
   * como DOS unidades. La planilla, en cambio, compara en mayúsculas (`clave()` de shared/padron.ts:195):
   * con las dos cargadas, `planDePadron` arma `porClave` con un Map y una de las dos desaparece del plan
   * (la planilla corrige a la que le toque). Arreglo probable: índice único sobre
   * (barrio_id, upper(btrim(manzana)), upper(btrim(lote))) en la migración, o normalizar al guardar.
   */
  it("«Mza A · Lote 1» y «Mza a · Lote 1» son la misma unidad: la segunda se rechaza", async () => {
    const b = arbol.barrioA1.id;
    await unidad(b, "A", "1");
    const e = await capturar(() => unidad(b, "a", "1"));
    expect(e.codigo).toBe("unidad_ya_existe");
  });

  it("la planilla reconoce la unidad aunque venga con otras mayúsculas y espacios", async () => {
    const b = arbol.barrioA1.id;
    await unidad(b, "B", "7");
    const ENC = [...columnasDelPadron(true)];
    const filas = [ENC, ENC.map((c) => (c === "manzana" ? " b " : c === "lote" ? "7 " : c === "superficie_m2" ? "500" : ""))];
    const previa = await como(adminA(), (tx) => vistaPreviaDeImportacion(tx, { barrioId: b, archivo: "p.csv", filas }));
    expect([previa.altas, previa.correcciones, previa.conError]).toEqual([0, 1, 0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("planilla: filas raras", () => {
  const ENC = [...columnasDelPadron(true)];
  const fila = (v: Partial<Record<(typeof ENC)[number], string>>) => ENC.map((c) => v[c] ?? "");
  const b = () => arbol.barrioA2.id;
  const previa = (filas: string[][], decisiones?: Map<number, "misma" | "otra">) =>
    como(adminA(), (tx) => vistaPreviaDeImportacion(tx, { barrioId: b(), archivo: "p.csv", filas, decisiones }));
  const confirmar = (filas: string[][], decisiones?: Map<number, "misma" | "otra">) =>
    como(adminA(), (tx) => confirmarImportacion(tx, { barrioId: b(), archivo: "p.csv", filas, decisiones }));
  const cuantas = async (manzana: string) =>
    (await admin.query<{ n: number }>("select count(*)::int as n from unidad_funcional where barrio_id = $1 and manzana = $2", [b(), manzana])).rows[0]!.n;

  it("el mismo CUIT con dos nombres en la planilla es error, y no entra nada", async () => {
    const filas = [
      ENC,
      fila({ manzana: "10", lote: "1", titular: "Pablo Ferreyra", cuit_o_dni: "20-11111111-2" }),
      fila({ manzana: "10", lote: "2", titular: "Pablo Ferreira Otro", cuit_o_dni: "20111111112" }),
    ];
    const p = await previa(filas);
    expect(p.conError).toBe(1);
    expect((await capturar(() => confirmar(filas))).codigo).toBe("planilla_con_errores");
    expect(await cuantas("10")).toBe(0);
  });

  it("la misma persona en dos unidades nuevas es UNA persona", async () => {
    const filas = [
      ENC,
      fila({ manzana: "11", lote: "1", titular: "Marta Gómez", cuit_o_dni: "30111222" }),
      fila({ manzana: "11", lote: "2", titular: "MARTA GOMEZ", cuit_o_dni: "30111222" }),
    ];
    expect(await confirmar(filas)).toEqual({ altas: 2, correcciones: 0, sinCambios: 0 });
    const { rows } = await admin.query<{ n: number; u: number }>(
      `select count(distinct o.id)::int as n, count(*)::int as u from obligado o join unidad_obligado uo on uo.obligado_id = o.id
        where o.barrio_id = $1 and o.numero_documento = '30111222'`,
      [b()],
    );
    expect(rows[0]).toEqual({ n: 1, u: 2 });
  });

  /*
   * BUG menor (acentos, regla 7 del CLAUDE.md). La misma persona escrita «Marta Gómez» en la primera
   * fila y «MARTA GOMEZ» en la segunda: `nombresIguales` las da por iguales (bien), pero
   * `confirmarImportacion` arma `nuevas` con `Map.set` por documento (padron-edicion.ts:1242) y gana la
   * ÚLTIMA grafía: la persona queda registrada en mayúsculas y sin acento. Arreglo: no pisar si ya está.
   */
  it("la persona nueva queda con la grafía de su PRIMERA fila (no la última)", async () => {
    const { rows } = await admin.query<{ nombre: string }>("select nombre from obligado where barrio_id = $1 and numero_documento = '30111222'", [b()]);
    expect(rows.map((r) => r.nombre)).toEqual(["Marta Gómez"]);
  });

  it("un titular sin documento repetido en dos unidades: entra (dos personas, no se pueden identificar)", async () => {
    const filas = [ENC, fila({ manzana: "12", lote: "1", titular: "Sin Documento" }), fila({ manzana: "12", lote: "2", titular: "Sin Documento" })];
    expect((await confirmar(filas)).altas).toBe(2);
    const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from obligado where barrio_id = $1 and nombre = 'Sin Documento'", [b()]);
    expect(rows[0]!.n).toBe(2);
  });

  it("«a revisar»: sin decidir no entra; «otra» es error; «misma» usa la registrada", async () => {
    const filas = [ENC, fila({ manzana: "13", lote: "1", titular: "Marta G. de Pérez", cuit_o_dni: "30111222" })];
    const p = await previa(filas);
    expect([p.aRevisar, p.ok]).toEqual([1, false]);
    expect((await capturar(() => confirmar(filas))).codigo).toBe("planilla_con_errores");
    expect((await capturar(() => confirmar(filas, new Map([[2, "otra"]])))).codigo).toBe("planilla_con_errores");
    expect(await cuantas("13")).toBe(0);
    await confirmar(filas, new Map([[2, "misma"]]));
    const { rows } = await admin.query<{ id: string }>(
      `select o.id from unidad_obligado uo join obligado o on o.id = uo.obligado_id join unidad_funcional u on u.id = uo.unidad_funcional_id
        where u.barrio_id = $1 and u.manzana = '13'`,
      [b()],
    );
    // «Es la misma»: se usa la persona ya registrada con ese DNI, no se crea otra.
    const { rows: registrada } = await admin.query<{ id: string }>("select id from obligado where barrio_id = $1 and numero_documento = '30111222'", [b()]);
    expect(registrada).toHaveLength(1);
    expect(rows.map((r) => r.id)).toEqual([registrada[0]!.id]);
  });

  it("corregir una unidad dada de baja por planilla es error", async () => {
    const { unidadFuncionalId } = await como(adminA(), (tx) => agregarUnidad(tx, { barrioId: b(), manzana: "14", lote: "1", estado: "baldio", titulares: [] }));
    await como(adminA(), (tx) => darDeBaja(tx, { unidadFuncionalId, motivo: "carga_por_error", detalle: "Detalle de la baja de prueba" } as never));
    const p = await previa([ENC, fila({ manzana: "14", lote: "1", superficie_m2: "300" })]);
    expect(p.conError).toBe(1);
    expect(p.unidades[0]?.error).toMatch(/dada de baja/);
  });

  it("un CBU que ya usa una unidad del barrio HERMANO: la confirmación falla entera, no queda nada a medias", async () => {
    const repetido = cbu(900_100);
    await unidad(arbol.barrioA1.id, "50", "1", { cbu: repetido });
    const filas = [
      ENC,
      fila({ manzana: "15", lote: "1", titular: "Alguien Nuevo", cuit_o_dni: "31222333" }),
      fila({ manzana: "15", lote: "2", cbu_unidad: repetido }),
    ];
    // Observación (no rompe la integridad): la vista previa NO mira las cuentas de la base, solo las
    // repetidas dentro de la planilla. Dice «ok» y la confirmación después falla.
    expect((await previa(filas)).ok).toBe(true);
    const e = await capturar(() => confirmar(filas));
    expect(e.codigo).toBe("cuenta_repetida");
    expect(await cuantas("15")).toBe(0);
    const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from obligado where barrio_id = $1 and numero_documento = '31222333'", [b()]);
    expect(rows[0]!.n).toBe(0);
  });

  it("el mismo CBU en una unidad de OTRA administración sí se puede", async () => {
    const otro = cbu(900_101);
    await unidad(arbol.barrioA2.id, "51", "1", { cbu: otro });
    await como(arbol.usuarios.adminEstudioB, (tx) =>
      agregarUnidad(tx, { barrioId: arbol.barrioB1.id, manzana: "1", lote: "1", estado: "baldio", cbu: otro, titulares: [] }),
    );
  });

  /*
   * BUG (o pieza faltante). Dos unidades con las cuentas cruzadas («suele ser un número copiado de la
   * fila de al lado», dice el propio mensaje de `cuenta_repetida`): se exporta, se corrigen las dos
   * filas intercambiando el CBU, y se sube. El plan no ve conflicto (cada cuenta está una sola vez en
   * la planilla), pero `confirmarImportacion` actualiza fila por fila (padron-edicion.ts:1300) y el
   * trigger `app.uf_cuenta_unica` (0065) ve la cuenta todavía en la otra unidad. Resultado: imposible
   * corregir el cruce por planilla, y a mano tampoco (hay que pasar por una cuenta intermedia).
   * Arreglo probable: en la corrección, vaciar primero las cuentas que cambian y después escribirlas,
   * o hacer el control del trigger diferible.
   */
  // LÍMITE CONOCIDO (ADR-0010 §9): la corrección por planilla actualiza unidad por unidad y el trigger
  // de cuenta única ve la cuenta todavía en la otra. Se corrige en dos pasos (una cuenta intermedia).
  it.fails("dos unidades con el CBU cruzado se corrigen con una planilla", async () => {
    const [c1, c2] = [cbu(900_200), cbu(900_201)];
    await unidad(b(), "16", "1", { cbu: c1 });
    await unidad(b(), "16", "2", { cbu: c2 });
    await confirmar([ENC, fila({ manzana: "16", lote: "1", cbu_unidad: c2 }), fila({ manzana: "16", lote: "2", cbu_unidad: c1 })]);
    const { rows } = await admin.query<{ lote: string; cbu: string }>(
      "select lote, cbu from unidad_funcional where barrio_id = $1 and manzana = '16' order by lote",
      [b()],
    );
    expect(rows).toEqual([{ lote: "1", cbu: c2 }, { lote: "2", cbu: c1 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("cambio de titular: fechas en el borde", () => {
  const b = () => arbol.barrioA1.id;
  const cambiar = (unidadFuncionalId: string, desde: string, nombre: string) =>
    como(adminA(), (tx) => cambiarTitular(tx, { unidadFuncionalId, desde, titular: { nombre }, motivo: "venta" } as never));
  const hoy = async () =>
    (await admin.query<{ hoy: string }>("select (now() at time zone zona_horaria)::date::text as hoy from barrio where barrio_id = $1", [b()])).rows[0]!.hoy;

  it("futura no; igual al inicio actual no; el día siguiente sí, y el anterior cierra el día previo", async () => {
    const { unidadFuncionalId: u } = await unidad(b(), "60", "1", { titulares: [{ nombre: "Uno" }] });
    await admin.query("update unidad_obligado set desde = '2026-01-01' where unidad_funcional_id = $1", [u]);
    const manana = (await admin.query<{ d: string }>("select ($1::date + 1)::text as d", [await hoy()])).rows[0]!.d;
    expect((await capturar(() => cambiar(u, manana, "Futuro"))).codigo).toBe("fecha_de_titular_invalida");
    expect((await capturar(() => cambiar(u, "2026-01-01", "Mismo Día"))).codigo).toBe("fecha_de_titular_invalida");
    await cambiar(u, "2026-01-02", "Dos");
    const { rows } = await admin.query<{ nombre: string; desde: string; hasta: string | null }>(
      `select o.nombre, uo.desde::text, uo.hasta::text from unidad_obligado uo join obligado o on o.id = uo.obligado_id
        where uo.unidad_funcional_id = $1 order by uo.desde`,
      [u],
    );
    expect(rows).toEqual([
      { nombre: "Uno", desde: "2026-01-01", hasta: "2026-01-01" },
      { nombre: "Dos", desde: "2026-01-02", hasta: null },
    ]);
  });

  it("titulares con distintos «desde»: el cambio tiene que ser posterior al más nuevo", async () => {
    const { unidadFuncionalId: u } = await unidad(b(), "60", "2", { titulares: [{ nombre: "Viejo" }, { nombre: "Nuevo" }], recibeBoleta: 0 });
    await admin.query(
      `update unidad_obligado uo set desde = case o.nombre when 'Viejo' then date '2025-01-01' else date '2026-06-01' end
         from obligado o where o.id = uo.obligado_id and uo.unidad_funcional_id = $1`,
      [u],
    );
    expect((await capturar(() => cambiar(u, "2026-03-01", "Medio"))).codigo).toBe("fecha_de_titular_invalida");
    const r = await cambiar(u, "2026-06-02", "Tercero");
    expect(r.cerrados).toBe(2);
  });

  it("una unidad sin titular acepta cualquier fecha pasada", async () => {
    const { unidadFuncionalId: u } = await unidad(b(), "60", "3");
    const r = await cambiar(u, "2020-01-01", "Primero");
    expect(r.cerrados).toBe(0);
  });

  /*
   * PIEZA FALTANTE. El alta (a mano o por planilla) pone a los titulares `desde = hoy`
   * (padron-edicion.ts:499 y :1333), y el cambio exige una fecha POSTERIOR a esa y no futura. Si la
   * administración carga mal el titular hoy, no lo puede corregir hasta mañana; y una venta escriturada
   * antes del día de la carga del padrón no se puede registrar con su fecha real nunca (la fecha tiene
   * que ser > hoy-de-la-carga). El motivo «Corrección de datos» existe en la pantalla pero choca con la
   * misma regla.
   */
  it("un titular cargado mal hoy se corrige hoy (motivo «corrección»)", async () => {
    const { unidadFuncionalId: u } = await unidad(b(), "60", "4", { titulares: [{ nombre: "Equivocado" }] });
    await como(adminA(), async (tx) =>
      cambiarTitular(tx, { unidadFuncionalId: u, desde: await hoy(), titular: { nombre: "Correcto" }, motivo: "correccion" } as never),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("baja, alta y saldo inicial frente a un borrador", () => {
  /*
   * Con un borrador ya generado, dar de baja una unidad y agregar otra deja la MISMA cantidad de
   * unidades activas, y `app.validar_emision` (0017:440-445) solo compara cantidades. Lo frena el
   * control de CONJUNTO de `emitirPeriodo` (liquidacion.ts, «El padrón cambió después de generar»),
   * agregado durante la revisión: este caso lo fija.
   */
  it("baja + alta después de generar: emitir sin regenerar se rechaza", async () => {
    const { id, conceptoId } = await nuevoBarrio("Romper baja y alta");
    const ids: string[] = [];
    for (const l of ["1", "2", "3"]) ids.push((await unidad(id, "1", l)).unidadFuncionalId);
    await como(adminA(), (tx) => crearVersionCoeficientes(tx, { barrioId: id, forma: "iguales", rigeDesde: "2027-01" }));
    const p = await periodo(id, conceptoId, "2027-01");
    await generar(p);
    const { sinBoletaDesde } = await como(adminA(), (tx) => darDeBaja(tx, { unidadFuncionalId: ids[2]!, motivo: "unificacion", detalle: "Detalle de la baja de prueba" } as never));
    expect(sinBoletaDesde).toBe("2027-01");
    await unidad(id, "1", "4");
    const e = await capturar(() => como(adminA(), (tx) => emitirPeriodo(tx, { periodoId: p })));
    expect(e.codigo).toBe("borrador_desactualizado");
    // Regenerado, sale con la nueva y sin la baja… si la nueva tiene coeficiente (variable: no se inventa).
    expect((await capturar(() => generar(p))).codigo).toBe("unidades_sin_coeficiente");
  });

  it("solo baja después de generar: la emisión se frena (las cantidades no cuadran)", async () => {
    const { id, conceptoId } = await nuevoBarrio("Romper solo baja");
    const ids: string[] = [];
    for (const l of ["1", "2"]) ids.push((await unidad(id, "1", l)).unidadFuncionalId);
    await como(adminA(), (tx) => crearVersionCoeficientes(tx, { barrioId: id, forma: "iguales", rigeDesde: "2027-01" }));
    const p = await periodo(id, conceptoId, "2027-01");
    await generar(p);
    await como(adminA(), (tx) => darDeBaja(tx, { unidadFuncionalId: ids[1]!, motivo: "otro", detalle: "Detalle de la baja de prueba" } as never));
    await capturar(() => como(adminA(), (tx) => emitirPeriodo(tx, { periodoId: p })));
    // Regenerado, sale sin la baja y se emite.
    expect((await generar(p)).unidadesLiquidadas).toBe(1);
    await como(adminA(), (tx) => emitirPeriodo(tx, { periodoId: p }));
  });

  it("saldo inicial: entra en la primera boleta como carga manual y la segunda lo arrastra como deuda calculada", async () => {
    const { id, conceptoId } = await nuevoBarrio("Romper saldo arrastre");
    const { unidadFuncionalId: u } = await unidad(id, "1", "1", { saldoInicial: "1500.00" });
    await unidad(id, "1", "2");
    await unidad(id, "1", "3");
    await como(adminA(), (tx) => crearVersionCoeficientes(tx, { barrioId: id, forma: "iguales", rigeDesde: "2027-01" }));
    const p1 = await periodo(id, conceptoId, "2027-01");
    await generar(p1);
    await como(adminA(), (tx) => emitirPeriodo(tx, { periodoId: p1 }));
    const l1 = (
      await admin.query<{ saldo: string; origen: string; total: string }>(
        "select saldo_anterior::text as saldo, saldo_anterior_origen as origen, total::text from liquidacion where periodo_id = $1 and unidad_funcional_id = $2",
        [p1, u],
      )
    ).rows[0]!;
    expect(l1).toMatchObject({ saldo: "1500.00", origen: "carga_manual" });
    const p2 = await periodo(id, conceptoId, "2027-02");
    await como(adminA(), (tx) => generarLiquidaciones(tx, { periodoId: p2, origenSaldo: "calculado", fechaCorteMora: "2027-01-05" }));
    const l2 = (
      await admin.query<{ saldo: string; origen: string }>(
        "select saldo_anterior::text as saldo, saldo_anterior_origen as origen from liquidacion where periodo_id = $1 and unidad_funcional_id = $2",
        [p2, u],
      )
    ).rows[0]!;
    // 1.500 traídos + 1.000 de la expensa de enero (3.000 / 3), sin pagos: la deuda de la unidad.
    expect(l2).toEqual({ saldo: "2500.00", origen: "calculado" });
    await como(adminA(), (tx) => emitirPeriodo(tx, { periodoId: p2 }));
    // Y el saldo inicial no se puede cambiar, ni por la ficha ni por SQL directo de la administración.
    expect((await capturar(() => como(adminA(), (tx) => editarUnidad(tx, { unidadFuncionalId: u, estado: "baldio", saldoInicial: "1.00" })))).codigo).toBe(
      "saldo_inicial_usado",
    );
  });

  /*
   * BUG (dinero sin trazabilidad). El saldo inicial se puede editar mientras no haya una boleta
   * EMITIDA, pero el borrador ya generado guardó el valor viejo. `registrarArrastreAlEmitir`
   * (liquidacion.ts ~826) para origen `carga_manual` solo verifica que el capital de la cuenta corriente
   * sea 0, no que `saldo_anterior` siga siendo el `saldo_inicial` de la unidad. Se emite la boleta con
   * $1.500, la ficha dice $2.000, y desde la emisión el trigger `uf_saldo_inicial_una_vez` congela los
   * $2.000 que nunca se cobraron. Arreglo probable: comparar `saldo_anterior` contra `saldo_inicial` al
   * emitir (→ `borrador_desactualizado`), o bloquear el cambio con un borrador generado que lo usó.
   */
  it("cambiar el saldo inicial después de generar: emitir sin regenerar se rechaza", async () => {
    const { id, conceptoId } = await nuevoBarrio("Romper saldo editado");
    const { unidadFuncionalId: u } = await unidad(id, "1", "1", { saldoInicial: "1500.00" });
    await como(adminA(), (tx) => crearVersionCoeficientes(tx, { barrioId: id, forma: "iguales", rigeDesde: "2027-01" }));
    const p = await periodo(id, conceptoId, "2027-01");
    await generar(p);
    await como(adminA(), (tx) => editarUnidad(tx, { unidadFuncionalId: u, estado: "baldio", saldoInicial: "2000.00" }));
    const e = await capturar(() => como(adminA(), (tx) => emitirPeriodo(tx, { periodoId: p })));
    expect(e.codigo).toBe("borrador_desactualizado");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("coeficientes", () => {
  it("planilla incompleta, con una unidad de baja o desde un período emitido: se rechaza", async () => {
    const { id, conceptoId } = await nuevoBarrio("Romper coeficientes");
    const ids: string[] = [];
    for (const l of ["1", "2", "3"]) ids.push((await unidad(id, "1", l)).unidadFuncionalId);
    await como(adminA(), (tx) => darDeBaja(tx, { unidadFuncionalId: ids[2]!, motivo: "otro", detalle: "Detalle de la baja de prueba" } as never));
    const crear = (rigeDesde: string, planilla: string[][]) =>
      como(adminA(), (tx) => crearVersionCoeficientes(tx, { barrioId: id, forma: "planilla", rigeDesde, planilla }));
    const ENC = ["manzana", "lote", "coeficiente"];
    expect((await capturar(() => crear("2027-01", [ENC, ["1", "1", "1"]]))).message).toMatch(/Faltan 1/);
    expect((await capturar(() => crear("2027-01", [ENC, ["1", "1", "1"], ["1", "2", "1"], ["1", "3", "1"]]))).message).toMatch(/Sobran 1/);
    // Con mayúsculas/espacios distintos entra igual.
    await crear("2027-01", [ENC, [" 1", "1 ", "1"], ["1", "2", "3"]]);
    const p = await periodo(id, conceptoId, "2027-01");
    await generar(p);
    await como(adminA(), (tx) => emitirPeriodo(tx, { periodoId: p }));
    expect((await capturar(() => crear("2027-01", [ENC, ["1", "1", "1"], ["1", "2", "1"]]))).codigo).toBe("coeficientes_superpuestos");
    expect((await capturar(() => crear("2026-12", [ENC, ["1", "1", "1"], ["1", "2", "1"]]))).codigo).toBe("coeficientes_superpuestos");
  });

  it("dos versiones con el mismo «desde»: la segunda reemplaza a la primera, y la generación usa la segunda", async () => {
    const { id, conceptoId } = await nuevoBarrio("Romper mismo desde");
    for (const l of ["1", "2"]) await unidad(id, "1", l);
    await como(adminA(), (tx) => crearVersionCoeficientes(tx, { barrioId: id, forma: "iguales", rigeDesde: "2027-03" }));
    const ENC = ["manzana", "lote", "coeficiente"];
    const v2 = await como(adminA(), (tx) =>
      crearVersionCoeficientes(tx, { barrioId: id, forma: "planilla", rigeDesde: "2027-03", planilla: [ENC, ["1", "1", "3"], ["1", "2", "1"]] }),
    );
    // Una anterior a la vigente no se puede (no se reemplaza hacia atrás).
    expect((await capturar(() => como(adminA(), (tx) => crearVersionCoeficientes(tx, { barrioId: id, forma: "iguales", rigeDesde: "2027-02" })))).codigo).toBe(
      "coeficientes_superpuestos",
    );
    const lista = await como(adminA(), (tx) => coeficientesDelBarrio(tx, { barrioId: id }));
    expect(lista.versiones.map((v) => v.id)).toEqual([v2.versionId]);
    const p = await periodo(id, conceptoId, "2027-03");
    await generar(p);
    const { rows } = await admin.query<{ v: string }>("select coeficiente_version_id as v from periodo_expensa where id = $1", [p]);
    expect(rows[0]!.v).toBe(v2.versionId);
  });

  /*
   * BUG. Igual que con el saldo inicial: una versión nueva que rige desde el período del borrador (la
   * pantalla la ofrece justamente para eso) no invalida el borrador ya generado, y `emitirPeriodo` no
   * mira qué versión rige. Se emite con los coeficientes VIEJOS, y desde ese momento la pantalla de
   * coeficientes muestra como «vigente» para ese mes una versión que nunca se usó, y ya no se puede
   * reemplazar (`coeficientes_superpuestos`). Arreglo probable: al emitir, verificar que
   * `periodo_expensa.coeficiente_version_id` sea la versión que rige para el mes; si no, pedir regenerar.
   */
  it("versión nueva desde el período del borrador: emitir sin regenerar se rechaza", async () => {
    const { id, conceptoId } = await nuevoBarrio("Romper versión tardía");
    for (const l of ["1", "2"]) await unidad(id, "1", l);
    await como(adminA(), (tx) => crearVersionCoeficientes(tx, { barrioId: id, forma: "iguales", rigeDesde: "2027-01" }));
    const p = await periodo(id, conceptoId, "2027-01");
    await generar(p);
    await como(adminA(), (tx) =>
      crearVersionCoeficientes(tx, {
        barrioId: id,
        forma: "planilla",
        rigeDesde: "2027-01",
        planilla: [["manzana", "lote", "coeficiente"], ["1", "1", "9"], ["1", "2", "1"]],
      }),
    );
    const e = await capturar(() => como(adminA(), (tx) => emitirPeriodo(tx, { periodoId: p })));
    expect(e.codigo).toBe("borrador_desactualizado");
  });

  it("dos versiones a la vez en el mismo barrio: queda UNA abierta, y la que pierde sale con un error traducido", async () => {
    const { id } = await nuevoBarrio("Romper concurrencia coef");
    for (const l of ["1", "2"]) await unidad(id, "1", l);
    const r = await Promise.allSettled(
      ["2027-04", "2027-04"].map((rigeDesde) => como(adminA(), (tx) => crearVersionCoeficientes(tx, { barrioId: id, forma: "iguales", rigeDesde }))),
    );
    for (const x of r) if (x.status === "rejected") expect(esErrorDeNegocio(x.reason), String(x.reason)).toBe(true);
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from coeficiente_version where barrio_id = $1 and cerrada and vigente_hasta is null",
      [id],
    );
    expect(rows[0]!.n).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("permisos", () => {
  const b = () => arbol.barrioA1.id;
  let u: string;
  beforeAll(async () => {
    u = (await unidad(b(), "70", "1", { titulares: [{ nombre: "Dueño" }] })).unidadFuncionalId;
    await admin.query("update unidad_obligado set desde = '2026-01-01' where unidad_funcional_id = $1", [u]);
  });

  it("operador, contador y auditor: ninguna escritura del padrón", async () => {
    const ENC = [...columnasDelPadron(true)];
    for (const quien of [arbol.usuarios.operadorA1, arbol.usuarios.contadorA1, arbol.usuarios.auditorA1]) {
      const intentos: (() => Promise<unknown>)[] = [
        () => como(quien, (tx) => agregarUnidad(tx, { barrioId: b(), manzana: "71", lote: "1", estado: "baldio", titulares: [] })),
        () => como(quien, (tx) => editarUnidad(tx, { unidadFuncionalId: u, estado: "construido" })),
        () => como(quien, (tx) => cambiarTitular(tx, { unidadFuncionalId: u, desde: "2026-02-01", titular: { nombre: "X" }, motivo: "venta" } as never)),
        () => como(quien, (tx) => darDeBaja(tx, { unidadFuncionalId: u, motivo: "otro", detalle: "Detalle de la baja de prueba" } as never)),
        () => como(quien, (tx) => confirmarImportacion(tx, { barrioId: b(), archivo: "p.csv", filas: [ENC, ENC.map((c) => (c === "manzana" ? "71" : c === "lote" ? "2" : ""))] })),
        () => como(quien, (tx) => crearVersionCoeficientes(tx, { barrioId: b(), forma: "iguales", rigeDesde: "2027-06" })),
        () => como(quien, (tx) => exportarPadron(tx, { barrioId: b() })),
      ];
      for (const intento of intentos) expect((await capturar(intento)).codigo).toBe("sin_permiso");
    }
    const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from unidad_funcional where barrio_id = $1 and manzana = '71'", [b()]);
    expect(rows[0]!.n).toBe(0);
  });

  it("admin de A1 no toca A2; admin de otra administración no ve A1", async () => {
    const e1 = await capturar(() =>
      como(arbol.usuarios.adminBarrioA1, (tx) => agregarUnidad(tx, { barrioId: arbol.barrioA2.id, manzana: "1", lote: "99", estado: "baldio", titulares: [] })),
    );
    expect(e1.codigo).toBe("sin_permiso");
    const e2 = await capturar(() =>
      como(arbol.usuarios.adminEstudioB, (tx) => listarPadronEditable(tx, { barrioId: b(), filtro: "todas", busqueda: "", limite: 10, desplazamiento: 0 })),
    );
    expect(e2.codigo).toBe("referencia_inexistente");
    expect(await como(arbol.usuarios.adminEstudioB, (tx) => fichaDeUnidad(tx, { unidadFuncionalId: u }))).toBeNull();
    const e3 = await capturar(() => como(arbol.usuarios.adminEstudioB, (tx) => darDeBaja(tx, { unidadFuncionalId: u, motivo: "otro", detalle: "Detalle de la baja de prueba" } as never)));
    expect(e3.codigo).toBe("referencia_inexistente");
  });

  /*
   * HUECO (defensa en profundidad). El encabezado de padron-edicion.ts dice que quién escribe «lo hace
   * cumplir la base», pero eso vale solo para lo que pasa por `padron_evento`. La migración 0065 deja a
   * propósito las policies de `unidad_funcional` como estaban (un `operador` escribe unidades), y el
   * trigger `uf_saldo_inicial_una_vez` no mira el rol (el de la cuenta, `uf_cuenta_unica`, sí). Un
   * `operador` cambia el saldo inicial —deuda que se imprime en la boleta— sin evento en el historial.
   * Hoy ningún camino de la app lo hace; el hueco está en la base. Arreglo probable: la misma guarda
   * de rol que `uf_cuenta_unica` en `uf_saldo_inicial_una_vez` (y que el trigger corra siempre, no solo
   * con emisión previa).
   */
  it("un operador no puede cambiar el saldo inicial ni dar de baja por SQL directo", async () => {
    let paso = 0;
    for (const sentencia of [
      "update unidad_funcional set saldo_inicial = 99999 where id = $1",
      "update unidad_funcional set baja_at = now(), baja_motivo = 'otro' where id = $1",
    ]) {
      const c = await appPool.connect();
      try {
        await c.query("begin");
        await c.query("select set_config('app.user_id', $1, true)", [arbol.usuarios.operadorA1]);
        const r = await c.query(sentencia, [u]);
        if ((r.rowCount ?? 0) > 0) paso++;
      } catch {
        // rechazado: es lo esperado
      } finally {
        await c.query("rollback");
        c.release();
      }
    }
    expect(paso).toBe(0);
  });
});
