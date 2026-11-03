/**
 * Parámetros de mora (ADR-0006, migraciones `0056`-`0058`), contra Postgres real.
 *
 * Lo que se prueba es lo que la base hace cumplir, no lo que la pantalla muestra: el registro igual al
 * de `shared`, los valores iniciales de una administración nueva, la herencia barrio → administración,
 * el "volver al valor general" que cancela lo programado, que nada sea retroactivo, el respaldo
 * obligatorio de una tasa, la confirmación al activar el interés, quién puede escribir (y que
 * `app_request` no puede tocar la tabla directo), y la anulación de un cambio programado.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { REGISTRO_PARAMETROS } from "@admin-barrios/shared/parametros-mora";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { enBase } from "../src/errores.ts";
import {
  anularParametroProgramado,
  fijarParametro,
  leerConfiguracionDelBarrio,
  leerConfiguracionGeneral,
  prepararSubidaDeRespaldo,
  volverAlValorGeneral,
} from "../src/servicios/parametros.ts";
import {
  borrarArbol,
  borrarParametrosDe,
  cargarParametro,
  crearArbol,
  crearBarrio,
  crearUnidades,
  dbDe,
  poolAdmin,
  poolApp,
  type Arbol,
} from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let hoy: string;
let manana: string;
let enUnMes: string;

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>): Promise<T> => conUsuario(db, usuario, fn);

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

async function resuelto(nodo: string, clave: string, fecha: string): Promise<{ valor: unknown; origen: string } | null> {
  const { rows } = await admin.query<{ valor: unknown; origen: string }>(
    "select valor, origen from app.parametro_resuelto_interno($1, $2, $3::date)",
    [nodo, clave, fecha],
  );
  return rows[0] ?? null;
}

const MOTIVO = "Lo aprobó la asamblea del barrio";

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, arbol.barrioA1.id);
  await crearBarrio(admin, arbol.barrioA2.id);
  const { rows } = await admin.query<{ hoy: string; manana: string; mes: string }>(
    "select current_date::text as hoy, (current_date + 1)::text as manana, (current_date + 30)::text as mes",
  );
  hoy = rows[0]!.hoy;
  manana = rows[0]!.manana;
  enUnMes = rows[0]!.mes;
});

beforeEach(async () => {
  // Cada test arranca con los barrios heredando todo de la administración recién sembrada.
  await borrarParametrosDe(admin, [arbol.barrioA1.id, arbol.barrioA2.id]);
});

afterAll(async () => {
  await admin.query("set session_replication_role = replica");
  await admin.query("delete from barrio where barrio_id = any($1::uuid[])", [[arbol.barrioA1.id, arbol.barrioA2.id]]);
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("el registro", () => {
  it("la base tiene las mismas claves, valores iniciales y respaldo obligatorio que `shared`", async () => {
    const { rows } = await admin.query<{ clave: string; valor_inicial: unknown; requiere_respaldo: boolean }>(
      "select clave, valor_inicial, requiere_respaldo from parametro_registro order by clave",
    );
    const esperado = REGISTRO_PARAMETROS.map((d) => ({
      clave: d.clave,
      valor_inicial: d.inicial,
      requiere_respaldo: d.requiereRespaldo,
    })).sort((a, b) => a.clave.localeCompare(b.clave));
    expect(rows).toEqual(esperado);
  });

  it("una administración nueva nace con los valores iniciales: «Cobra: No», 5 días, corre el inicio, $100, intereses primero", async () => {
    const r = async (clave: string) => (await resuelto(arbol.adminA.id, clave, hoy))?.valor;
    expect(await r("interes.cobra")).toBe(false);
    expect(await r("interes.gracia_dias")).toBe(5);
    expect(await r("interes.forma_gracia")).toBe("corre_inicio");
    expect(await r("interes.tolerancia")).toBe("100.00");
    expect(await r("imputacion.orden")).toBe("intereses_primero_capital_antiguo");
    const { rows } = await admin.query<{ carga: string; n: string }>(
      "select carga, count(*)::text as n from parametro_valor where nodo_id = $1 group by carga",
      [arbol.adminA.id],
    );
    expect(rows).toEqual([{ carga: "inicial", n: String(REGISTRO_PARAMETROS.length) }]);
  });
});

describe("la herencia barrio → administración", () => {
  it("sin valor propio, el barrio hereda; con valor propio, lo pisa; con «volver», hereda de nuevo", async () => {
    expect(await resuelto(arbol.barrioA1.id, "interes.gracia_dias", hoy)).toEqual({ valor: 5, origen: "administracion" });

    await cargarParametro(admin, arbol.barrioA1.id, "interes.gracia_dias", 10, "2020-01-01");
    expect(await resuelto(arbol.barrioA1.id, "interes.gracia_dias", hoy)).toEqual({ valor: 10, origen: "barrio" });
    // El hermano no se entera.
    expect(await resuelto(arbol.barrioA2.id, "interes.gracia_dias", hoy)).toEqual({ valor: 5, origen: "administracion" });

    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      volverAlValorGeneral(tx, { barrioId: arbol.barrioA1.id, clave: "interes.gracia_dias", rigeDesde: manana, motivo: MOTIVO }),
    );
    // Hoy sigue el propio; desde mañana, el general. Nada retroactivo.
    expect(await resuelto(arbol.barrioA1.id, "interes.gracia_dias", hoy)).toEqual({ valor: 10, origen: "barrio" });
    expect(await resuelto(arbol.barrioA1.id, "interes.gracia_dias", manana)).toEqual({ valor: 5, origen: "administracion" });
  });

  it("«volver al valor general» también cancela los propios programados para después", async () => {
    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      fijarParametro(tx, { nodoId: arbol.barrioA1.id, clave: "interes.gracia_dias", valor: "8", rigeDesde: enUnMes, motivo: MOTIVO }),
    );
    expect((await resuelto(arbol.barrioA1.id, "interes.gracia_dias", enUnMes))?.valor).toBe(8);

    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      volverAlValorGeneral(tx, { barrioId: arbol.barrioA1.id, clave: "interes.gracia_dias", rigeDesde: manana, motivo: MOTIVO }),
    );
    expect(await resuelto(arbol.barrioA1.id, "interes.gracia_dias", enUnMes)).toEqual({ valor: 5, origen: "administracion" });
    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from parametro_anulacion where nodo_id = $1",
      [arbol.barrioA1.id],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("un cambio general programado alcanza a los que heredan y no a los que tienen valor propio", async () => {
    await cargarParametro(admin, arbol.barrioA1.id, "interes.tolerancia", "50.00", "2020-01-01");
    await como(arbol.usuarios.adminEstudioA, (tx) =>
      fijarParametro(tx, { nodoId: arbol.adminA.id, clave: "interes.tolerancia", valor: "200", rigeDesde: enUnMes, motivo: MOTIVO }),
    );
    expect((await resuelto(arbol.barrioA1.id, "interes.tolerancia", enUnMes))?.valor).toBe("50.00");
    expect((await resuelto(arbol.barrioA2.id, "interes.tolerancia", enUnMes))?.valor).toBe("200.00");

    const general = await como(arbol.usuarios.adminEstudioA, (tx) => leerConfiguracionGeneral(tx, { administracionId: arbol.adminA.id }));
    const tol = general?.parametros.find((p) => p.clave === "interes.tolerancia");
    expect(tol?.programados.map((p) => p.valor)).toEqual(["200.00"]);
    expect(tol?.barriosConPropio.map((b) => b.id)).toEqual([arbol.barrioA1.id]);
  });
});

describe("las reglas de un cambio", () => {
  it("nada es retroactivo: una fecha anterior a hoy se rechaza", async () => {
    const err = await capturar(() =>
      como(arbol.usuarios.adminEstudioA, (tx) =>
        fijarParametro(tx, { nodoId: arbol.adminA.id, clave: "interes.gracia_dias", valor: "3", rigeDesde: "2020-01-01", motivo: MOTIVO }),
      ),
    );
    expect(err.codigo).toBe("parametro_retroactivo");
  });

  /** Llama a la función de la base salteando el Zod del servicio: lo que se prueba es el guardia. */
  const directo = (usuario: string, consulta: ReturnType<typeof sql>) =>
    capturar(() =>
      como(usuario, (tx) => enBase(() => tx.execute(consulta))),
    );

  it("el motivo de menos de 15 caracteres lo rechaza la base aunque el formulario no lo filtre", async () => {
    const err = await directo(
      arbol.usuarios.adminEstudioA,
      sql`select app.fijar_parametro(${arbol.adminA.id}::uuid, 'interes.gracia_dias', '3'::jsonb, current_date, 'corto')`,
    );
    expect(err.codigo).toBe("parametro_motivo_corto");
  });

  it("una tasa sin respaldo se rechaza en la base, aunque se llame directo a la función", async () => {
    const err = await directo(
      arbol.usuarios.adminEstudioA,
      sql`select app.fijar_parametro(${arbol.adminA.id}::uuid, 'interes.tasa_compensatoria', '"0.03"'::jsonb, current_date, ${MOTIVO})`,
    );
    expect(err.codigo).toBe("parametro_requiere_respaldo");
  });

  it("un valor que no es de la clave lo rechaza la base", async () => {
    const err = await directo(
      arbol.usuarios.adminEstudioA,
      sql`select app.fijar_parametro(${arbol.adminA.id}::uuid, 'imputacion.orden', '"fifo_estricto"'::jsonb, current_date, ${MOTIVO})`,
    );
    expect(err.codigo).toBe("dato_invalido");
  });

  it("con respaldo, la tasa se guarda y el respaldo queda en la fila", async () => {
    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      fijarParametro(tx, {
        nodoId: arbol.barrioA1.id,
        clave: "interes.tasa_compensatoria",
        valor: "2,5",
        rigeDesde: hoy,
        motivo: MOTIVO,
        respaldoTipo: "acta_asamblea",
        respaldoReferencia: "Acta de asamblea del 10/09/2026",
      }),
    );
    const { rows } = await admin.query<{ valor: unknown; respaldo_tipo: string; respaldo_referencia: string }>(
      "select valor, respaldo_tipo, respaldo_referencia from parametro_valor where nodo_id = $1 and clave = 'interes.tasa_compensatoria'",
      [arbol.barrioA1.id],
    );
    expect(rows).toEqual([{ valor: "0.025", respaldo_tipo: "acta_asamblea", respaldo_referencia: "Acta de asamblea del 10/09/2026" }]);
  });

  it("«Cobra: Sí» sin tasa se rechaza", async () => {
    const err = await capturar(() =>
      como(arbol.usuarios.adminEstudioA, (tx) =>
        fijarParametro(tx, {
          nodoId: arbol.adminA.id,
          clave: "interes.cobra",
          valor: "si",
          rigeDesde: enUnMes,
          motivo: MOTIVO,
          confirmarActivarInteres: "si",
        }),
      ),
    );
    expect(err.codigo).toBe("parametro_sin_tasa");
  });

  it("«Cobra: Sí» pide confirmación diciendo qué orden de imputación rige; confirmado, se guarda", async () => {
    await cargarParametro(admin, arbol.barrioA1.id, "interes.tasa_compensatoria", "0.03", "2020-01-01");
    const pedido = await capturar(() =>
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        fijarParametro(tx, { nodoId: arbol.barrioA1.id, clave: "interes.cobra", valor: "si", rigeDesde: manana, motivo: MOTIVO }),
      ),
    );
    expect(pedido.codigo).toBe("activar_interes_requiere_confirmacion");
    expect(pedido.message).toMatch(/Intereses primero, después la deuda más antigua/);
    expect(pedido.message).toMatch(/configuración general/);

    await como(arbol.usuarios.adminBarrioA1, (tx) =>
      fijarParametro(tx, {
        nodoId: arbol.barrioA1.id,
        clave: "interes.cobra",
        valor: "si",
        rigeDesde: manana,
        motivo: MOTIVO,
        confirmarActivarInteres: "si",
      }),
    );
    expect(await resuelto(arbol.barrioA1.id, "interes.cobra", manana)).toEqual({ valor: true, origen: "barrio" });
  });
});

describe("quién puede escribir", () => {
  it("el operador no cambia parámetros, aunque escribía en `tasa_mora`", async () => {
    const err = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) =>
        fijarParametro(tx, { nodoId: arbol.barrioA1.id, clave: "interes.gracia_dias", valor: "3", rigeDesde: hoy, motivo: MOTIVO }),
      ),
    );
    expect(err.codigo).toBe("sin_permiso");
  });

  it("el admin de UN barrio cambia su barrio pero no la configuración general", async () => {
    const err = await capturar(() =>
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        fijarParametro(tx, { nodoId: arbol.adminA.id, clave: "interes.gracia_dias", valor: "3", rigeDesde: hoy, motivo: MOTIVO }),
      ),
    );
    expect(err.codigo).toBe("sin_permiso");
  });

  it("el contador y el admin de un barrio VEN la configuración general (de dónde heredan), sin poder editarla", async () => {
    const contador = await como(arbol.usuarios.contadorA1, (tx) => leerConfiguracionGeneral(tx, { administracionId: arbol.adminA.id }));
    expect(contador?.puedeEditar).toBe(false);
    expect(contador?.parametros.find((p) => p.clave === "interes.gracia_dias")?.vigente?.valor).toBe(5);
    const delBarrio = await como(arbol.usuarios.contadorA1, (tx) => leerConfiguracionDelBarrio(tx, { barrioId: arbol.barrioA1.id }));
    expect(delBarrio?.puedeEditar).toBe(false);
    const adminBarrio = await como(arbol.usuarios.adminBarrioA1, (tx) => leerConfiguracionGeneral(tx, { administracionId: arbol.adminA.id }));
    expect(adminBarrio?.puedeEditar).toBe(false);
    const adminBarrioPropio = await como(arbol.usuarios.adminBarrioA1, (tx) => leerConfiguracionDelBarrio(tx, { barrioId: arbol.barrioA1.id }));
    expect(adminBarrioPropio?.puedeEditar).toBe(true);
  });

  it("otra administración no ve nada", async () => {
    expect(await como(arbol.usuarios.adminEstudioB, (tx) => leerConfiguracionGeneral(tx, { administracionId: arbol.adminA.id }))).toBeNull();
    const n = await como(arbol.usuarios.adminEstudioB, async (tx) => {
      const { rows } = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from parametro_valor where nodo_id in (${arbol.adminA.id}::uuid, ${arbol.barrioA1.id}::uuid)`,
      );
      return rows[0]?.n;
    });
    expect(n).toBe(0);
  });

  it("`app_request` no puede escribir la tabla directo: ni insert, ni update, ni delete", async () => {
    for (const consulta of [
      sql`insert into parametro_valor (nodo_id, clave, valor, vigente_desde, motivo, carga, creado_por)
          values (${arbol.barrioA1.id}::uuid, 'interes.gracia_dias', '1'::jsonb, current_date, 'motivo de prueba larga', 'usuario', ${arbol.usuarios.adminEstudioA}::uuid)`,
      sql`update parametro_valor set valor = '1'::jsonb where nodo_id = ${arbol.adminA.id}::uuid`,
      sql`delete from parametro_valor where nodo_id = ${arbol.adminA.id}::uuid`,
    ]) {
      await expect(como(arbol.usuarios.adminEstudioA, (tx) => tx.execute(consulta))).rejects.toThrow(/permission denied|permiso/);
    }
  });

  it("y ni el superusuario edita una fila fuera del modo de mantenimiento: es append-only", async () => {
    await expect(
      admin.query("update parametro_valor set motivo = 'reescrito' where nodo_id = $1", [arbol.adminA.id]),
    ).rejects.toThrow(/no se editan ni se borran/);
  });

  it("el pedido de subida de un respaldo solo lo puede hacer quien edita ese nivel", async () => {
    const ok = await como(arbol.usuarios.adminEstudioA, (tx) =>
      prepararSubidaDeRespaldo(tx, { nodoId: arbol.adminA.id, contentType: "application/pdf" }),
    );
    expect(ok.storageKey).toMatch(new RegExp(`^administraciones/${arbol.adminA.id}/parametros/respaldos/`));
    const err = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) => prepararSubidaDeRespaldo(tx, { nodoId: arbol.barrioA1.id, contentType: "application/pdf" })),
    );
    expect(err.codigo).toBe("sin_permiso");
  });
});

describe("anular un cambio programado", () => {
  it("se anula lo que todavía no rige, y la resolución lo saltea", async () => {
    const { filaId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      fijarParametro(tx, { nodoId: arbol.barrioA1.id, clave: "interes.gracia_dias", valor: "9", rigeDesde: enUnMes, motivo: MOTIVO }),
    );
    expect((await resuelto(arbol.barrioA1.id, "interes.gracia_dias", enUnMes))?.valor).toBe(9);
    await como(arbol.usuarios.adminBarrioA1, (tx) => anularParametroProgramado(tx, { filaId, motivo: "Se votó de nuevo en la asamblea" }));
    expect(await resuelto(arbol.barrioA1.id, "interes.gracia_dias", enUnMes)).toEqual({ valor: 5, origen: "administracion" });

    const otraVez = await capturar(() =>
      como(arbol.usuarios.adminBarrioA1, (tx) => anularParametroProgramado(tx, { filaId, motivo: "Se votó de nuevo en la asamblea" })),
    );
    expect(otraVez.codigo).toBe("parametro_no_anulable");
  });

  it("lo que ya rige no se anula", async () => {
    const { filaId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      fijarParametro(tx, { nodoId: arbol.barrioA1.id, clave: "interes.gracia_dias", valor: "9", rigeDesde: hoy, motivo: MOTIVO }),
    );
    const err = await capturar(() =>
      como(arbol.usuarios.adminBarrioA1, (tx) => anularParametroProgramado(tx, { filaId, motivo: "Me equivoqué de fecha" })),
    );
    expect(err.codigo).toBe("parametro_no_anulable");
  });
});

describe("aislamiento entre administraciones y guardas de la tabla (revisión de security-engineer)", () => {
  it("otra administración no fija en un barrio ni en la administración ajena, ni anula sus filas", async () => {
    for (const nodoId of [arbol.barrioA1.id, arbol.adminA.id]) {
      const err = await capturar(() =>
        como(arbol.usuarios.adminEstudioB, (tx) =>
          fijarParametro(tx, { nodoId, clave: "interes.gracia_dias", valor: "3", rigeDesde: enUnMes, motivo: MOTIVO }),
        ),
      );
      expect(err.codigo).toBe("sin_permiso");
    }
    const { filaId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      fijarParametro(tx, { nodoId: arbol.barrioA1.id, clave: "interes.gracia_dias", valor: "7", rigeDesde: enUnMes, motivo: MOTIVO }),
    );
    const err = await capturar(() =>
      como(arbol.usuarios.adminEstudioB, (tx) => anularParametroProgramado(tx, { filaId, motivo: "Intento desde otra administración" })),
    );
    expect(err.codigo).toBe("sin_permiso");
  });

  it("resolver o listar cambios de un nodo ajeno o inexistente da el MISMO mensaje: no hay oráculo", async () => {
    const mensajes: string[] = [];
    for (const nodo of [arbol.barrioA1.id, "00000000-0000-4000-8000-00000000dead"]) {
      for (const consulta of [
        sql`select * from app.parametro_resuelto(${nodo}::uuid, 'interes.cobra', current_date)`,
        sql`select * from app.parametros_cambios(${nodo}::uuid, current_date - 30, current_date)`,
      ]) {
        const err = await capturar(() => como(arbol.usuarios.adminEstudioB, (tx) => enBase(() => tx.execute(consulta))));
        expect(err.codigo).toBe("referencia_inexistente");
        mensajes.push(err.message);
      }
    }
    expect(new Set(mensajes).size).toBe(1);
  });

  it("un adjunto pedido para otro nodo no sirve de respaldo", async () => {
    const { storageKey } = await como(arbol.usuarios.adminEstudioA, (tx) =>
      prepararSubidaDeRespaldo(tx, { nodoId: arbol.adminA.id, contentType: "application/pdf" }),
    );
    const err = await capturar(() =>
      como(arbol.usuarios.adminEstudioA, (tx) =>
        fijarParametro(tx, {
          nodoId: arbol.barrioA1.id,
          clave: "interes.tasa_compensatoria",
          valor: "3",
          rigeDesde: enUnMes,
          motivo: MOTIVO,
          respaldoTipo: "reglamento",
          respaldoReferencia: "Reglamento, art. 12",
          respaldoAdjunto: storageKey,
        }),
      ),
    );
    expect(err.codigo).toBe("parametro_adjunto_ajeno");
  });

  it("un subsector no tiene parámetros: ni se fija ni se pide una subida", async () => {
    const fijar = await capturar(() =>
      como(arbol.usuarios.adminEstudioA, (tx) =>
        fijarParametro(tx, { nodoId: arbol.subsectorA1.id, clave: "interes.gracia_dias", valor: "3", rigeDesde: enUnMes, motivo: MOTIVO }),
      ),
    );
    expect(fijar.codigo).toBe("sin_permiso");
    const subida = await capturar(() =>
      como(arbol.usuarios.adminEstudioA, (tx) => prepararSubidaDeRespaldo(tx, { nodoId: arbol.subsectorA1.id, contentType: "application/pdf" })),
    );
    expect(subida.codigo).toBe("sin_permiso");
  });

  it("los roles de la aplicación no escriben un valor retroactivo ni sin firma, aunque tengan insert (app_job)", async () => {
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("set local role app_job");
      await expect(
        c.query(
          `insert into parametro_valor (nodo_id, clave, valor, vigente_desde, motivo, carga)
           values ($1, 'interes.gracia_dias', '1'::jsonb, '2020-01-01', 'cargado por un job', 'migrado')`,
          [arbol.barrioA1.id],
        ),
      ).rejects.toThrow(/lo carga una persona con sesión/);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("una anulación escrita a mano hereda el nodo de su fila y no cae sobre lo que ya rige", async () => {
    const vigente = await cargarParametro(admin, arbol.barrioA1.id, "interes.gracia_dias", 4, "2020-01-01");
    await expect(
      admin.query(
        "insert into parametro_anulacion (fila_id, nodo_id, motivo, anulado_por) values ($1, $2, 'a mano', $3)",
        [vigente, arbol.adminB.id, arbol.usuarios.adminEstudioA],
      ),
    ).rejects.toThrow(/ya rige/);
  });
});

describe("lo que una liquidación emitida ya usó no se anula (revisión de security-engineer, M2)", () => {
  it("un cambio programado que cae dentro de la fecha de referencia de una liquidación emitida no se anula", async () => {
    const { filaId } = await como(arbol.usuarios.adminBarrioA1, (tx) =>
      fijarParametro(tx, { nodoId: arbol.barrioA1.id, clave: "interes.gracia_dias", valor: "6", rigeDesde: enUnMes, motivo: MOTIVO }),
    );
    // Una liquidación emitida cuya fecha de referencia (su vencimiento) es posterior al cambio: lo usó.
    const [unidad] = await crearUnidades(admin, arbol.barrioA1.id, 1);
    const { rows: p } = await admin.query<{ id: string }>(
      "insert into periodo_expensa (barrio_id, periodo) values ($1, '2099-01') returning id",
      [arbol.barrioA1.id],
    );
    const periodoId = p[0]!.id;
    const c = await admin.connect();
    try {
      await c.query(
        `insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, coeficiente_aplicado, subtotal_ordinarias,
                                  subtotal_extraordinarias, subtotal_fondo_reserva, total, interes_mora, parametros_mora)
         values ($1, $2, $3, 1, 100, 0, 0, 100, 0, jsonb_build_object('fechaReferencia', ($4::date + 5)::text))`,
        [arbol.barrioA1.id, periodoId, unidad, enUnMes],
      );
      await c.query("set session_replication_role = replica");
      await c.query("update periodo_expensa set estado = 'emitida', emitida_at = now() where id = $1", [periodoId]);
      await c.query("set session_replication_role = origin");

      const err = await capturar(() =>
        como(arbol.usuarios.adminBarrioA1, (tx) => anularParametroProgramado(tx, { filaId, motivo: "Se votó de nuevo en la asamblea" })),
      );
      expect(err.codigo).toBe("parametro_no_anulable");
      expect(err.message).toMatch(/liquidación emitida/);
    } finally {
      await c.query("set session_replication_role = replica");
      await c.query("delete from liquidacion where periodo_id = $1", [periodoId]);
      await c.query("delete from periodo_expensa where id = $1", [periodoId]);
      await c.query("delete from unidad_funcional where barrio_id = $1", [arbol.barrioA1.id]);
      await c.query("set session_replication_role = origin");
      c.release();
    }
  });
});

describe("la tasa no queda en cero mientras se cobra (revisión de código, hallazgo 2)", () => {
  it("bajar la tasa propia a 0 con «Cobra: Sí» se rechaza; volver a heredar un 0 también", async () => {
    await cargarParametro(admin, arbol.barrioA1.id, "interes.cobra", true, "2020-01-01");
    await cargarParametro(admin, arbol.barrioA1.id, "interes.tasa_compensatoria", "0.03", "2020-01-01");
    const respaldo = { respaldoTipo: "reglamento" as const, respaldoReferencia: "Reglamento, art. 12" };
    const cero = await capturar(() =>
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        fijarParametro(tx, { nodoId: arbol.barrioA1.id, clave: "interes.tasa_compensatoria", valor: "0", rigeDesde: enUnMes, motivo: MOTIVO, ...respaldo }),
      ),
    );
    expect(cero.codigo).toBe("parametro_sin_tasa");
    // La administración nueva tiene tasa 0: volver a heredarla con «Cobra: Sí» propio deja el interés en cero.
    const volver = await capturar(() =>
      como(arbol.usuarios.adminBarrioA1, (tx) =>
        volverAlValorGeneral(tx, { barrioId: arbol.barrioA1.id, clave: "interes.tasa_compensatoria", rigeDesde: enUnMes, motivo: MOTIVO }),
      ),
    );
    expect(volver.codigo).toBe("parametro_sin_tasa");
  });
});
