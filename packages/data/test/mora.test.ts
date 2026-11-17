/**
 * Encargo E-a1, contra Postgres real (`0091`): estudios jurídicos, derivaciones y gestiones.
 *
 * Los CUIT de los estudios de acá NO son los de la demo (la limpieza los borra por CUIT).
 *
 * El caso: el barrio A1 de «Estudio Pérez» con tres unidades. Las dos primeras deben un mes vencido de
 * $ 1.000 (el barrio no cobra interés, para que las cuentas se lean a mano); la tercera se crea después
 * de emitir y no debe nada. Dos estudios: el 1 trabaja en A1; el 2 está vinculado con la administración
 * pero no trabaja en A1. «Otro Estudio» (la administración B) no tiene nada que ver.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import {
  agregarEstudio,
  bajaEstudio,
  buscarEstudio,
  cambiarEstudioDelBarrio,
  derivar,
  guardarCriterioAdministracion,
  guardarMoraBarrio,
  moraDeLaAdministracion,
  retirar,
} from "../src/servicios/mora.ts";
import { borrarArbol, borrarParametrosDe, cargarParametro, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf1: string;
let uf2: string;
let uf3: string;
let estudio1: string;
let estudio2: string;

const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminA = () => arbol.usuarios.adminEstudioA;

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

/** El error crudo de Postgres de una escritura directa (sin servicio). */
async function falla(usuario: string, consulta: ReturnType<typeof sql>): Promise<string> {
  try {
    await como(usuario, (tx) => tx.execute(consulta));
  } catch (e) {
    const causa = (e as { cause?: { message?: string } }).cause;
    return causa?.message ?? (e as Error).message;
  }
  throw new Error("no falló, y tenía que fallar");
}

const cuantas = async (usuario: string, tabla: string) =>
  (await como(usuario, (tx) => tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${tabla}`)))).rows[0]!.n;

async function limpiarMora(): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["gestion_anulacion", "gestion", "derivacion_foto", "derivacion", "estudio_barrio", "mora_barrio"]) {
      await c.query(`delete from ${t} where barrio_id = any($1::uuid[])`, [[arbol.barrioA1.id, arbol.barrioA2.id, arbol.barrioB1.id]]);
    }
    await c.query("delete from estudio_administracion where administracion_id = any($1::uuid[])", [[arbol.adminA.id, arbol.adminB.id]]);
    await c.query("delete from mora_criterio_administracion where administracion_id = any($1::uuid[])", [[arbol.adminA.id, arbol.adminB.id]]);
    await c.query("delete from estudio_juridico where cuit in ('30710000030', '30710000049')");
    await c.query("commit");
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, barrio(), { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  await crearBarrio(admin, arbol.barrioB1.id);
  await borrarParametrosDe(admin, [barrio()]);
  await cargarParametro(admin, barrio(), "interes.cobra", false);
  const { rows: ufs } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad) values ($1,'1','1','construido'), ($1,'1','2','construido') returning id`,
    [barrio()],
  );
  [uf1, uf2] = [ufs[0]!.id, ufs[1]!.id];
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [barrio()],
  );
  await admin.query("insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,0.5), ($1,$2,$4,0.5)", [
    barrio(),
    v[0]!.id,
    uf1,
    uf2,
  ]);
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
  const { rows: c } = await admin.query<{ id: string }>(
    "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
    [barrio()],
  );
  const { rows: p } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, '2026-01', '2026-01-10') returning id",
    [barrio()],
  );
  await admin.query(
    "insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '2000.00')",
    [barrio(), p[0]!.id, c[0]!.id],
  );
  await como(adminA(), (tx) => generarLiquidaciones(tx, { periodoId: p[0]!.id, origenSaldo: "calculado", fechaCorteMora: "2026-01-01" }));
  await como(adminA(), (tx) => emitirPeriodo(tx, { periodoId: p[0]!.id }));
  const { rows: u3 } = await admin.query<{ id: string }>(
    "insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad) values ($1,'1','3','construido') returning id",
    [barrio()],
  );
  uf3 = u3[0]!.id;

  await limpiarMora();
  const base = { administracionId: arbol.adminA.id, telefonoBoleta: "(0351) 555-0100", preferenciaAviso: "cada_derivacion" } as const;
  estudio1 = (await como(adminA(), (tx) => agregarEstudio(tx, { ...base, nombre: "Estudio Uno", cuit: "30-71000003-0", correoAvisos: "Uno@Estudio.test" }))).estudioId;
  estudio2 = (await como(adminA(), (tx) => agregarEstudio(tx, { ...base, nombre: "Estudio Dos", cuit: "30710000049", correoAvisos: "dos@estudio.test" }))).estudioId;
  await como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: barrio(), estudioId: estudio1, accion: "sumar" }));
  await como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: barrio(), estudioId: estudio1, accion: "por_defecto" }));
});

afterAll(async () => {
  await limpiarMora();
  await borrarParametrosDe(admin, [barrio()]);
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["pago_imputacion", "pago", "item_liquidacion", "liquidacion", "gasto_periodo", "periodo_expensa", "concepto", "coeficiente",
      "coeficiente_version", "unidad_funcional"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("delete from barrio where barrio_id = any($1::uuid[])", [[barrio(), arbol.barrioB1.id]]);
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarArbol(admin, arbol);
  await appPool.end();
  await admin.end();
});

describe("buscar un estudio para vincularlo: solo coincidencia exacta, solo id y nombre", () => {
  it("encuentra por CUIT (con o sin guiones) y por correo (sin importar mayúsculas)", async () => {
    for (const dato of ["30-71000003-0", "30710000030", "uno@estudio.test", "  UNO@ESTUDIO.TEST "]) {
      expect(await como(adminA(), (tx) => buscarEstudio(tx, { administracionId: arbol.adminA.id, dato }))).toEqual({
        id: estudio1,
        nombre: "Estudio Uno",
        vinculado: true,
      });
    }
  });

  it("con una búsqueda parcial no aparece ningún estudio", async () => {
    for (const dato of ["3071000003", "30-7100000", "uno@estudio", "estudio.test", "Estudio Uno", "Uno", "%", "_"]) {
      expect(await como(adminA(), (tx) => buscarEstudio(tx, { administracionId: arbol.adminA.id, dato }))).toBeNull();
      const { rows } = await como(adminA(), (tx) => tx.execute(sql`select * from app.buscar_estudio_exacto(${dato})`));
      expect(rows, dato).toEqual([]);
    }
  });

  it("la función devuelve solo el id y el nombre, también a otra administración (para vincularlo)", async () => {
    const { rows } = await como(arbol.usuarios.adminEstudioB, (tx) => tx.execute(sql`select * from app.buscar_estudio_exacto('30-71000003-0')`));
    expect(rows).toEqual([{ id: estudio1, nombre: "Estudio Uno" }]);
    expect(await como(arbol.usuarios.adminEstudioB, (tx) => buscarEstudio(tx, { administracionId: arbol.adminB.id, dato: "30710000030" }))).toEqual({
      id: estudio1,
      nombre: "Estudio Uno",
      vinculado: false,
    });
  });

  it("quien no administra (operador, contador) no encuentra nada", async () => {
    for (const u of [arbol.usuarios.operadorA1, arbol.usuarios.contadorA1, arbol.usuarios.sinMembresia]) {
      const { rows } = await como(u, (tx) => tx.execute(sql`select * from app.buscar_estudio_exacto('30710000030')`));
      expect(rows).toEqual([]);
    }
  });

  it("un CUIT repetido no crea otro estudio: avisa que hay que vincularlo", async () => {
    const e = await capturar(() =>
      como(arbol.usuarios.adminEstudioB, (tx) =>
        agregarEstudio(tx, {
          administracionId: arbol.adminB.id,
          nombre: "Otro nombre",
          cuit: "30710000030",
          correoAvisos: "x@estudio.test",
          telefonoBoleta: null,
          preferenciaAviso: "solo_resumen",
        }),
      ),
    );
    expect(e.codigo).toBe("estudio_ya_existe");
  });
});

describe("estudios del barrio", () => {
  it("un solo estudio por defecto por barrio", async () => {
    // El 2 se vincula a A1 solo para esta prueba y se saca al final.
    const e = await falla(
      adminA(),
      sql`insert into estudio_barrio (estudio_id, barrio_id, por_defecto) values (${estudio2}, ${barrio()}, true)`,
    );
    // Sin estar en el barrio no puede ser «por defecto», pero lo primero que salta es la regla del vínculo
    // o el índice: los dos dicen que no.
    expect(e).toMatch(/uq_estudio_barrio_por_defecto|duplicate key/);
    await como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: barrio(), estudioId: estudio2, accion: "sumar" }));
    await como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: barrio(), estudioId: estudio2, accion: "por_defecto" }));
    const { rows } = await admin.query<{ estudio_id: string }>("select estudio_id from estudio_barrio where barrio_id = $1 and por_defecto", [barrio()]);
    expect(rows.map((r) => r.estudio_id)).toEqual([estudio2]);
    await como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: barrio(), estudioId: estudio1, accion: "por_defecto" }));
    await como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: barrio(), estudioId: estudio2, accion: "sacar" }));
  });

  it("un estudio que no está vinculado con la administración del barrio no se suma", async () => {
    // El estudio 1 no está vinculado con B: no puede trabajar en Las Lomas.
    const e = await falla(adminA(), sql`
      insert into estudio_barrio (estudio_id, barrio_id) values (${estudio1}, ${arbol.barrioB1.id})`);
    expect(e).toMatch(/row-level security|no está vinculado/);
    const c = await admin.connect();
    try {
      // Aun saltando la RLS (dueño), el trigger lo frena.
      await expect(c.query("insert into estudio_barrio (estudio_id, barrio_id) values ($1, $2)", [estudio1, arbol.barrioB1.id])).rejects.toThrow(
        /no está vinculado con la administración de este barrio/,
      );
    } finally {
      c.release();
    }
  });
});

describe("derivar y retirar", () => {
  it("deriva con la foto de la deuda mes por mes y un renglón «Derivación» en las gestiones", async () => {
    const r = await como(adminA(), (tx) =>
      derivar(tx, { unidades: [{ unidadFuncionalId: uf1, barrioId: barrio(), estudioId: estudio1 }], motivo: "criterio_cumplido", nota: null }),
    );
    expect(r.unidades).toBe(1);
    expect(r.porEstudio).toEqual([{ estudioId: estudio1, estudio: "Estudio Uno", unidades: 1, barrios: 1 }]);
    const { rows } = await admin.query<{ foto: { meses: { periodo: string; capital: string; vencido: boolean }[]; capitalVencido: string; total: string } }>(
      "select f.foto from derivacion_foto f join derivacion d on d.id = f.derivacion_id where d.unidad_funcional_id = $1",
      [uf1],
    );
    expect(rows[0]!.foto.meses).toEqual([{ periodo: "2026-01", vencimiento: "2026-01-10", vencido: true, capital: "1000.00", interes: "0.00" }]);
    expect(rows[0]!.foto.capitalVencido).toBe("1000.00");
    expect(rows[0]!.foto.total).toBe("1000.00");
    const { rows: g } = await admin.query<{ canal: string; resultado: string | null }>(
      "select canal, resultado from gestion where unidad_funcional_id = $1",
      [uf1],
    );
    expect(g).toEqual([{ canal: "derivacion", resultado: null }]);
  });

  it("una sola derivación vigente por unidad", async () => {
    const e = await capturar(() =>
      como(adminA(), (tx) =>
        derivar(tx, { unidades: [{ unidadFuncionalId: uf1, barrioId: barrio(), estudioId: estudio1 }], motivo: "criterio_cumplido", nota: null }),
      ),
    );
    expect(e.codigo).toBe("unidad_ya_derivada");
    expect(
      await falla(adminA(), sql`
        insert into derivacion (barrio_id, unidad_funcional_id, estudio_id, tanda_id, motivo, derivada_por)
        values (${barrio()}, ${uf1}, ${estudio1}, gen_random_uuid(), 'criterio_cumplido', app.current_user_id())`),
    ).toMatch(/uq_derivacion_vigente/);
  });

  it("el estudio que no trabaja en el barrio se rechaza, y la tanda entera no se deriva", async () => {
    const e = await capturar(() =>
      como(adminA(), (tx) =>
        derivar(tx, { unidades: [{ unidadFuncionalId: uf2, barrioId: barrio(), estudioId: estudio2 }], motivo: "criterio_cumplido", nota: null }),
      ),
    );
    expect(e.codigo).toBe("estudio_fuera_del_barrio");
    const { rows } = await admin.query("select 1 from derivacion where unidad_funcional_id = $1", [uf2]);
    expect(rows).toEqual([]);
  });

  it("una unidad sin deuda vencida no se deriva", async () => {
    const e = await capturar(() =>
      como(adminA(), (tx) =>
        derivar(tx, { unidades: [{ unidadFuncionalId: uf3, barrioId: barrio(), estudioId: estudio1 }], motivo: "criterio_cumplido", nota: null }),
      ),
    );
    expect(e.codigo).toBe("dato_invalido");
  });

  it("derivar es de la administración: el operador no puede", async () => {
    const e = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        derivar(tx, { unidades: [{ unidadFuncionalId: uf2, barrioId: barrio(), estudioId: estudio1 }], motivo: "criterio_cumplido", nota: null }),
      ),
    );
    expect(e.codigo).toBe("sin_permiso");
  });

  it("no se da de baja ni se saca del barrio un estudio con unidades derivadas", async () => {
    expect((await capturar(() => como(adminA(), (tx) => bajaEstudio(tx, { administracionId: arbol.adminA.id, estudioId: estudio1 })))).codigo).toBe(
      "estudio_con_derivaciones",
    );
    expect(
      (await capturar(() => como(adminA(), (tx) => cambiarEstudioDelBarrio(tx, { barrioId: barrio(), estudioId: estudio1, accion: "sacar" })))).codigo,
    ).toBe("estudio_con_derivaciones");
  });

  it("retirar deja la historia; una derivación retirada no se vuelve a retirar ni se edita", async () => {
    const { rows } = await admin.query<{ id: string }>("select id from derivacion where unidad_funcional_id = $1", [uf1]);
    const id = rows[0]!.id;
    await como(adminA(), (tx) => retirar(tx, { derivacionId: id, motivo: "pago", nota: null }));
    expect((await capturar(() => como(adminA(), (tx) => retirar(tx, { derivacionId: id, motivo: "pago", nota: null })))).codigo).toBe(
      "derivacion_ya_retirada",
    );
    expect(await falla(adminA(), sql`update derivacion set motivo = 'otro' where id = ${id}`)).toMatch(/permission denied|ya se retiró/);
    expect(await falla(adminA(), sql`delete from derivacion where id = ${id}`)).toMatch(/permission denied|no se borra/);
    const { rows: d } = await admin.query<{ retiro_motivo: string; retirada_por: string }>(
      "select retiro_motivo, retirada_por from derivacion where id = $1",
      [id],
    );
    expect(d[0]).toEqual({ retiro_motivo: "pago", retirada_por: adminA() });
    // Retirada, se puede volver a derivar.
    await como(adminA(), (tx) =>
      derivar(tx, { unidades: [{ unidadFuncionalId: uf1, barrioId: barrio(), estudioId: estudio1 }], motivo: "incumplio_promesa", nota: null }),
    );
  });

  it("la foto de una derivación no se edita ni se borra", async () => {
    const c = await admin.connect();
    try {
      await expect(c.query("update derivacion_foto set foto = '{\"meses\": []}'::jsonb")).rejects.toThrow(/no se edita ni se borra/);
      await expect(c.query("delete from derivacion_foto")).rejects.toThrow(/no se edita ni se borra/);
    } finally {
      c.release();
    }
  });
});

describe("gestiones: solo se agregan filas", () => {
  let gestionId: string;

  it("la administración registra; la gestión no acepta UPDATE ni DELETE, ni siquiera del dueño de la base", async () => {
    const { rows } = await como(arbol.usuarios.operadorA1, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, resultado, fecha, registrado_por)
        values (${barrio()}, ${uf2}, 'administracion', 'llamada', 'no_contesta', '2026-11-10', app.current_user_id()) returning id`),
    );
    gestionId = rows[0]!.id;
    expect(await falla(arbol.usuarios.operadorA1, sql`update gestion set nota = 'x' where id = ${gestionId}`)).toMatch(/permission denied|no se editan/);
    expect(await falla(arbol.usuarios.operadorA1, sql`delete from gestion where id = ${gestionId}`)).toMatch(/permission denied|no se editan/);
    const c = await admin.connect();
    try {
      await expect(c.query("update gestion set nota = 'x' where id = $1", [gestionId])).rejects.toThrow(/no se editan ni se borran/);
      await expect(c.query("delete from gestion where id = $1", [gestionId])).rejects.toThrow(/no se editan ni se borran/);
    } finally {
      c.release();
    }
  });

  it("se anula una vez, con motivo, y cada parte anula solo las suyas", async () => {
    await como(arbol.usuarios.operadorA1, (tx) =>
      tx.execute(sql`
        insert into gestion_anulacion (gestion_id, barrio_id, autor_tipo, motivo, anulada_por)
        values (${gestionId}, ${barrio()}, 'administracion', 'Cargada en la unidad equivocada.', app.current_user_id())`),
    );
    expect(
      await falla(arbol.usuarios.operadorA1, sql`
        insert into gestion_anulacion (gestion_id, barrio_id, autor_tipo, motivo, anulada_por)
        values (${gestionId}, ${barrio()}, 'administracion', 'Otra vez.', app.current_user_id())`),
    ).toMatch(/duplicate key|gestion_anulacion_pkey/);
    const c = await admin.connect();
    try {
      await expect(c.query("update gestion_anulacion set motivo = 'x' where gestion_id = $1", [gestionId])).rejects.toThrow(/no se editan/);
      // Una gestión de la administración no la anula el estudio (ni aun saltando la RLS).
      await c.query("begin");
      await c.query("select set_config('app.user_id', $1, true)", [adminA()]);
      const { rows } = await c.query<{ id: string }>(
        `insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, resultado, fecha, registrado_por)
         values ($1, $2, 'administracion', 'mail', 'contactado', '2026-11-10', $3) returning id`,
        [barrio(), uf2, adminA()],
      );
      await expect(
        c.query("insert into gestion_anulacion (gestion_id, barrio_id, autor_tipo, motivo, anulada_por) values ($1, $2, 'estudio', 'No es mía.', $3)", [
          rows[0]!.id,
          barrio(),
          adminA(),
        ]),
      ).rejects.toThrow(/cada parte anula solo sus gestiones/);
      await c.query("rollback");
    } finally {
      c.release();
    }
  });

  it("la carta documento y la nota firmada piden adjunto", async () => {
    for (const canal of ["carta_documento", "nota"]) {
      expect(
        await falla(arbol.usuarios.operadorA1, sql`
          insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, resultado, fecha, registrado_por)
          values (${barrio()}, ${uf2}, 'administracion', ${canal}, 'enviada', '2026-11-10', app.current_user_id())`),
      ).toMatch(/gestion_adjunto_fehaciente_chk/);
    }
  });

  it("una promesa lleva fecha y monto, y la fecha no es anterior al alta", async () => {
    expect(
      await falla(arbol.usuarios.operadorA1, sql`
        insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, resultado, fecha, registrado_por)
        values (${barrio()}, ${uf2}, 'administracion', 'whatsapp', 'promesa_de_pago', '2026-11-10', app.current_user_id())`),
    ).toMatch(/gestion_promesa_chk/);
    expect(
      await falla(arbol.usuarios.operadorA1, sql`
        insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, resultado, fecha, promesa_fecha, promesa_monto, registrado_por)
        values (${barrio()}, ${uf2}, 'administracion', 'whatsapp', 'promesa_de_pago', '2026-11-10', '2026-11-09', 100, app.current_user_id())`),
    ).toMatch(/gestion_promesa_orden_chk/);
  });

  it("la administración no puede registrar a nombre del estudio", async () => {
    expect(
      await falla(adminA(), sql`
        insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, estudio_id, canal, resultado, fecha, registrado_por)
        values (${barrio()}, ${uf2}, 'estudio', ${estudio1}, 'llamada', 'contactado', '2026-11-10', app.current_user_id())`),
    ).toMatch(/row-level security/);
  });
});

describe("la lista de mora: criterio efectivo y promesas", () => {
  it("con el criterio de la administración, la unidad sin derivar que pasa el criterio se propone", async () => {
    await como(adminA(), (tx) =>
      guardarCriterioAdministracion(tx, {
        administracionId: arbol.adminA.id,
        meses: "0",
        montoMinimo: "500.00",
        pedirIntimacion: "no",
        leyendaBoleta: "Unidad derivada a {estudio}: comuníquese al {telefono}.",
      }),
    );
    const m = await como(adminA(), (tx) => moraDeLaAdministracion(tx, { barrioId: barrio() }));
    const f2 = m!.filas.find((f) => f.unidadFuncionalId === uf2)!;
    expect([f2.meses, f2.capital, f2.interes, f2.situacion]).toEqual([1, "1000.00", "0.00", "para_derivar"]);
    expect(m!.filas.find((f) => f.unidadFuncionalId === uf1)!.situacion).toBe("derivada");
    expect(m!.filas.some((f) => f.unidadFuncionalId === uf3)).toBe(false);
    expect(m!.barrios[0]!.origenCriterio).toBe("administracion");
    expect(m!.filas.map((f) => [f.meses, f.situacion]).sort()).toEqual([[1, "derivada"], [1, "para_derivar"]]);
  });

  it("con un criterio propio más alto, la misma unidad queda debajo del monto mínimo", async () => {
    await como(adminA(), (tx) =>
      guardarMoraBarrio(tx, { barrioId: barrio(), criterio: "propio", meses: "0", montoMinimo: "5000.00", pactoEjecutividad: "si", aviso: "administracion", leyendaBoleta: "" }),
    );
    const m = await como(adminA(), (tx) => moraDeLaAdministracion(tx, { barrioId: barrio() }));
    expect(m!.filas.find((f) => f.unidadFuncionalId === uf2)!.situacion).toBe("debajo_del_minimo");
    expect(m!.barrios[0]!.origenCriterio).toBe("barrio");
    const { rows } = await admin.query<{ pacto: boolean }>("select pacto_ejecutividad as pacto from barrio where barrio_id = $1", [barrio()]);
    expect(rows[0]!.pacto).toBe(true);
  });

  it("una promesa pendiente frena la propuesta; vencida, cuenta como promesa vencida", async () => {
    await como(adminA(), (tx) =>
      guardarMoraBarrio(tx, { barrioId: barrio(), criterio: "administracion", meses: "", montoMinimo: "", pactoEjecutividad: "a_confirmar", aviso: "administracion", leyendaBoleta: "" }),
    );
    await como(adminA(), (tx) =>
      tx.execute(sql`
        insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, resultado, fecha, promesa_fecha, promesa_monto, registrado_por)
        values (${barrio()}, ${uf2}, 'administracion', 'whatsapp', 'promesa_de_pago', current_date, current_date + 10, 400, app.current_user_id())`),
    );
    let f2 = (await como(adminA(), (tx) => moraDeLaAdministracion(tx, { barrioId: barrio() })))!.filas.find((f) => f.unidadFuncionalId === uf2)!;
    expect([f2.situacion, f2.promesa?.estado, f2.promesa?.pagado]).toEqual(["promesa", "pendiente", "0.00"]);
    // Una promesa de hace 20 días: la base fija la fecha de alta en «hoy», así que va con los triggers
    // apagados, como en el seed (con el autor y la hora a mano).
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query(
        `insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, resultado, fecha, promesa_fecha, promesa_monto, registrado_por, registrado_at)
         values ($1, $2, 'administracion', 'whatsapp', 'promesa_de_pago', current_date - 20, current_date - 10, 400, $3, now() + interval '1 second')`,
        [barrio(), uf2, adminA()],
      );
      await c.query("commit");
    } finally {
      c.release();
    }
    const m = (await como(adminA(), (tx) => moraDeLaAdministracion(tx, { barrioId: barrio() })))!;
    f2 = m.filas.find((f) => f.unidadFuncionalId === uf2)!;
    expect([f2.situacion, f2.promesa?.estado]).toEqual(["para_derivar", "vencida"]);
    expect(m.filas.filter((f) => f.promesa?.estado === "vencida")).toHaveLength(1);
  });
});

describe("lo que la base fija y no elige quien escribe", () => {
  it("el día de una gestión es hoy en el barrio, aunque se mande otro", async () => {
    const { rows } = await como(arbol.usuarios.operadorA1, (tx) =>
      tx.execute<{ fecha: string; hoy: string }>(sql`
        insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, resultado, fecha, registrado_por)
        values (${barrio()}, ${uf2}, 'administracion', 'llamada', 'contactado', '2001-01-01', ${adminA()})
        returning fecha::text as fecha, registrado_por::text as registrado_por,
                  (select (now() at time zone b.zona_horaria)::date::text from barrio b where b.barrio_id = ${barrio()}) as hoy`),
    );
    expect(rows[0]!.fecha).toBe(rows[0]!.hoy);
    // El autor tampoco: se mandó el de la administradora y quedó el de quien la cargó.
    expect((rows[0] as unknown as { registrado_por: string }).registrado_por).toBe(arbol.usuarios.operadorA1);
  });

  it("el renglón «Derivación» lo escribe solo la derivación: no se inventa ni se anula", async () => {
    const { rows: d } = await admin.query<{ id: string }>("select id from derivacion where unidad_funcional_id = $1 and retirada_at is null", [uf1]);
    expect(
      await falla(arbol.usuarios.operadorA1, sql`
        insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, nota, fecha, derivacion_id, registrado_por)
        values (${barrio()}, ${uf1}, 'administracion', 'derivacion', 'Derivada a OTRO estudio', current_date, ${d[0]!.id}, app.current_user_id())`),
    ).toMatch(/lo escribe la derivación/);
    const { rows: g } = await admin.query<{ id: string }>("select id from gestion where derivacion_id = $1", [d[0]!.id]);
    expect(
      await falla(arbol.usuarios.operadorA1, sql`
        insert into gestion_anulacion (gestion_id, barrio_id, autor_tipo, motivo, anulada_por)
        values (${g[0]!.id}, ${barrio()}, 'administracion', 'No pasó.', app.current_user_id())`),
    ).toMatch(/no se anula/);
  });

  it("el adjunto va con la clave del barrio de la gestión", async () => {
    const sha = "a".repeat(64);
    expect(
      await falla(arbol.usuarios.operadorA1, sql`
        insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, resultado, fecha, adjunto_clave, adjunto_sha256, adjunto_nombre, adjunto_tipo, registrado_por)
        values (${barrio()}, ${uf2}, 'administracion', 'carta_documento', 'enviada', current_date,
                ${`barrios/${arbol.barrioB1.id}/gestiones/AAAAAAAAAAAAAAAAAAAAAAAA.pdf`}, ${sha}, 'cd.pdf', 'application/pdf', app.current_user_id())`),
    ).toMatch(/gestion_adjunto_clave_chk/);
    await como(arbol.usuarios.operadorA1, (tx) =>
      tx.execute(sql`
        insert into gestion (barrio_id, unidad_funcional_id, autor_tipo, canal, resultado, fecha, adjunto_clave, adjunto_sha256, adjunto_nombre, adjunto_tipo, registrado_por)
        values (${barrio()}, ${uf2}, 'administracion', 'carta_documento', 'enviada', current_date,
                ${`barrios/${barrio()}/gestiones/AAAAAAAAAAAAAAAAAAAAAAAA.pdf`}, ${sha}, 'cd.pdf', 'application/pdf', app.current_user_id())`),
    );
  });

  it("la foto no admite más claves que las de la deuda (sin datos personales)", async () => {
    const { rows: d } = await admin.query<{ id: string }>("select id from derivacion where unidad_funcional_id = $1 and retirada_at is null", [uf1]);
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("delete from derivacion_foto where derivacion_id = $1", [d[0]!.id]).catch(() => undefined);
      await c.query("rollback");
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("delete from derivacion_foto where derivacion_id = $1", [d[0]!.id]);
      await c.query("set local session_replication_role = origin");
      await expect(
        c.query(`insert into derivacion_foto (derivacion_id, barrio_id, foto) values ($1, $2, '{"meses": [], "nombre": "Lucía"}'::jsonb)`, [d[0]!.id, barrio()]),
      ).rejects.toThrow(/derivacion_foto_forma_chk/);
      await c.query("rollback");
    } finally {
      c.release();
    }
  });

  it("la búsqueda la hace solo quien administra la administración, y queda registrada", async () => {
    // admin_barrio de un solo barrio: no puede vincular, y tampoco busca.
    const { rows } = await como(arbol.usuarios.adminBarrioA1, (tx) => tx.execute(sql`select * from app.buscar_estudio_exacto('30710000030')`));
    expect(rows).toEqual([]);
    const antes = (await admin.query<{ n: number }>("select count(*)::int as n from estudio_busqueda where usuario_id = $1", [adminA()])).rows[0]!.n;
    await como(adminA(), (tx) => tx.execute(sql`select * from app.buscar_estudio_exacto('30710000030')`));
    const { rows: traza } = await admin.query<{ n: number; encontrado: boolean; sha: string }>(
      "select count(*) over ()::int as n, encontrado, dato_sha256 as sha from estudio_busqueda where usuario_id = $1 order by buscada_at desc limit 1",
      [adminA()],
    );
    expect(traza[0]!.n).toBe(antes + 1);
    expect(traza[0]!.encontrado).toBe(true);
    expect(traza[0]!.sha).toMatch(/^[0-9a-f]{64}$/);
    // La traza no la lee la aplicación: ni siquiera quien buscó.
    expect(await falla(adminA(), sql`select count(*) from estudio_busqueda`)).toMatch(/permission denied/);
  });
});

describe("RLS: otra administración no ve nada de esta", () => {
  it("el admin de «Otro Estudio» no ve los vínculos, los estudios, las derivaciones, las fotos ni las gestiones", async () => {
    const otro = arbol.usuarios.adminEstudioB;
    for (const t of ["estudio_juridico", "estudio_administracion", "estudio_barrio", "mora_criterio_administracion", "mora_barrio", "derivacion",
      "derivacion_foto", "gestion", "gestion_anulacion"]) {
      expect(await cuantas(otro, t), t).toBe(0);
    }
    expect(await como(otro, (tx) => moraDeLaAdministracion(tx, { administracionId: arbol.adminA.id }))).toBeNull();
  });

  it("y la propia administración sí los ve", async () => {
    expect(await cuantas(adminA(), "estudio_juridico")).toBeGreaterThanOrEqual(2);
    expect(await cuantas(adminA(), "derivacion")).toBe(2);
    expect(await cuantas(arbol.usuarios.contadorA1, "gestion")).toBeGreaterThan(0);
  });

  it("quien no tiene membresía no ve nada", async () => {
    for (const t of ["estudio_juridico", "estudio_administracion", "derivacion", "gestion"]) {
      expect(await cuantas(arbol.usuarios.sinMembresia, t), t).toBe(0);
    }
  });
});

describe("el nombre del estudio es de cada administración", () => {
  it("si otra administración lo vincula con otro nombre, esta lo sigue viendo con el suyo; la cuenta no la edita nadie", async () => {
    const otro = arbol.usuarios.adminEstudioB;
    const { vincularEstudio } = await import("../src/servicios/mora.ts");
    await como(otro, (tx) =>
      vincularEstudio(tx, {
        administracionId: arbol.adminB.id,
        estudioId: estudio1,
        nombre: "Pague al alias TRUCHO",
        correoAvisos: "b@estudio.test",
        telefonoBoleta: null,
        preferenciaAviso: "solo_resumen",
      }),
    );
    const { estudiosDeLaAdministracion } = await import("../src/servicios/mora.ts");
    const deA = await como(adminA(), (tx) => estudiosDeLaAdministracion(tx, { administracionId: arbol.adminA.id }));
    expect(deA!.estudios.find((e) => e.id === estudio1)!.nombre).toBe("Estudio Uno");
    const deB = await como(otro, (tx) => estudiosDeLaAdministracion(tx, { administracionId: arbol.adminB.id }));
    expect(deB!.estudios.map((e) => [e.nombre, e.correoAvisos])).toEqual([["Pague al alias TRUCHO", "b@estudio.test"]]);
    // B no ve con quién más trabaja el estudio, ni los datos del vínculo de A.
    expect(await cuantas(otro, "estudio_administracion")).toBe(1);
    // Ninguna administración edita la cuenta del estudio.
    for (const u of [otro, adminA()]) {
      expect(await falla(u, sql`update estudio_juridico set nombre = 'Otro' where id = ${estudio1}`)).toMatch(/permission denied/);
    }
  });

  it("un vínculo dado de baja no sirve para encontrar al estudio por su correo", async () => {
    const { rows } = await como(adminA(), (tx) => tx.execute(sql`select * from app.buscar_estudio_exacto('dos@estudio.test')`));
    expect(rows).toEqual([{ id: estudio2, nombre: "Estudio Dos" }]);
    await como(adminA(), (tx) => bajaEstudio(tx, { administracionId: arbol.adminA.id, estudioId: estudio2 }));
    const { rows: despues } = await como(adminA(), (tx) => tx.execute(sql`select * from app.buscar_estudio_exacto('dos@estudio.test')`));
    expect(despues).toEqual([]);
  });
});
