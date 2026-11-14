/**
 * Encargo 15, contra Postgres real (`0077` y `0078`):
 *  - Los vencimientos del barrio: se editan solo con rol de administración (servicio y trigger), y al
 *    abrir un mes —solo o a mano— se proponen el segundo vencimiento y la fecha de corte.
 *  - `periodo_expensa.fecha_corte`: su check, y que se congela al emitir.
 *  - La figura «Sin entidad constituida» en el alta, con su representante.
 *  - La unidad: número de acción único en el barrio, residente informativo con la RLS de la unidad.
 *  - «Padrón a una fecha» con un cambio de titular en el medio, y quién lo puede bajar.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { crearBarrioSchema } from "@admin-barrios/shared/escrituras";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { abrirMesEnCurso, cambiarVencimientos } from "../src/servicios/circuito-del-mes.ts";
import { crearPeriodo, proponerVencimientos } from "../src/servicios/periodos.ts";
import { leerBarrio } from "../src/servicios/barrios.ts";
import {
  agregarUnidad,
  cambiarTitular,
  cambiarVencimientosDelBarrio,
  confirmarImportacion,
  crearBarrio as crearBarrioServicio,
  editarUnidad,
  exportarPadron,
  fichaDeUnidad,
  listarPadronEditable,
  padronAUnaFecha,
} from "../src/servicios/padron-edicion.ts";
import { columnasDelPadron } from "@admin-barrios/shared/padron";
import { borrarArbol, borrarParametrosDe, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
const creadosPorServicio: string[] = [];

const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const a1 = () => arbol.barrioA1.id;
const adminA1 = () => arbol.usuarios.adminBarrioA1;

// CBU inventado con los verificadores bien, sobre una entidad que no existe (000).
const CBU_BARRIO_NUEVO = "0000003110000000000502";

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

async function limpiarBarrio(c: pg.PoolClient, barrioId: string) {
  for (const t of [
    "padron_evento", "unidad_contacto", "unidad_obligado", "obligado", "periodo_expensa", "coeficiente", "coeficiente_version",
    "unidad_funcional", "codigo_pago_secuencia", "mandato_administracion", "documento_barrio", "barrio_atributo_vigencia", "barrio",
  ]) {
    await c.query(`delete from ${t} where barrio_id = $1`, [barrioId]);
  }
}

const hoyDelBarrio = async () =>
  (await admin.query<{ h: string }>("select (now() at time zone 'America/Argentina/Buenos_Aires')::date::text as h")).rows[0]!.h;

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
    for (const b of [...creadosPorServicio, arbol.barrioA1.id, arbol.barrioA2.id, arbol.barrioB1.id]) await limpiarBarrio(c, b);
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarParametrosDe(admin, creadosPorServicio);
  for (const id of creadosPorServicio) await admin.query("delete from tenant_node where id = $1", [id]);
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("los vencimientos del barrio (0078)", () => {
  it("la administración los cambia y queda en el historial del padrón", async () => {
    await como(adminA1(), (tx) =>
      cambiarVencimientosDelBarrio(tx, { barrioId: a1(), diaVencimiento: "10", diasSegundoVencimiento: "10", diasCorte: "5" }),
    );
    const { rows } = await admin.query(
      "select dia_vencimiento, dias_segundo_vencimiento, dias_corte from barrio where barrio_id = $1",
      [a1()],
    );
    expect(rows[0]).toEqual({ dia_vencimiento: 10, dias_segundo_vencimiento: 10, dias_corte: 5 });
    const { rows: ev } = await admin.query<{ detalle: string; rol: string }>(
      "select detalle, rol from padron_evento where barrio_id = $1 and tipo = 'configuracion_barrio'",
      [a1()],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.rol).toBe("admin_barrio");
    expect(ev[0]!.detalle).toContain("segundo vencimiento no usa → 10 días");
    // Sin cambios, no hay evento nuevo.
    await como(adminA1(), (tx) =>
      cambiarVencimientosDelBarrio(tx, { barrioId: a1(), diaVencimiento: 10, diasSegundoVencimiento: 10, diasCorte: 5 }),
    );
    const { rows: n } = await admin.query<{ n: number }>(
      "select count(*)::int as n from padron_evento where barrio_id = $1 and tipo = 'configuracion_barrio'",
      [a1()],
    );
    expect(n[0]!.n).toBe(1);
    // Y se leen en la ficha del barrio (Configuración).
    const b = await como(adminA1(), (tx) => leerBarrio(tx, { barrioId: a1() }));
    expect(b?.vencimientos).toEqual({ diaVencimiento: 10, diasSegundoVencimiento: 10, diasCorte: 5 });
  });

  it("acceso por rol: operador, contador y auditor no los cambian, ni por el servicio ni por SQL directo", async () => {
    for (const u of [arbol.usuarios.operadorA1, arbol.usuarios.contadorA1, arbol.usuarios.auditorA1]) {
      const e = await capturar(() =>
        como(u, (tx) => cambiarVencimientosDelBarrio(tx, { barrioId: a1(), diaVencimiento: 5, diasSegundoVencimiento: "", diasCorte: "" })),
      );
      expect(e.codigo).toBe("sin_permiso");
    }
    // El operador tiene policy de UPDATE sobre `barrio` (0003): lo frena el trigger de 0078.
    await expect(
      como(arbol.usuarios.operadorA1, (tx) => tx.execute(sql`update barrio set dias_corte = 30 where barrio_id = ${a1()}`)),
    ).rejects.toThrow(/los vencimientos del barrio los configura la administración/);
    // Un admin de otra administración no ve el barrio.
    const e = await capturar(() =>
      como(arbol.usuarios.adminEstudioB, (tx) => cambiarVencimientosDelBarrio(tx, { barrioId: a1(), diaVencimiento: 5 })),
    );
    expect(e.codigo).toBe("sin_permiso");
    const { rows } = await admin.query("select dias_corte from barrio where barrio_id = $1", [a1()]);
    expect(rows[0]).toEqual({ dias_corte: 5 });
  });

  it("los valores fuera de rango no entran (check de la base)", async () => {
    await expect(admin.query("update barrio set dias_segundo_vencimiento = 0 where barrio_id = $1", [a1()])).rejects.toThrow(
      /barrio_dias_segundo_vencimiento_chk/,
    );
    await expect(admin.query("update barrio set dias_corte = -1 where barrio_id = $1", [a1()])).rejects.toThrow(/barrio_dias_corte_chk/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("al abrir un mes se proponen el segundo vencimiento y la fecha de corte", () => {
  it("la regla, sin base: segundo = primero + N; corte = último + M; sin config o sin primero, nada", () => {
    const config = { dias_segundo_vencimiento: 10, dias_corte: 5 };
    expect(proponerVencimientos("2026-12-10", config)).toEqual({ segundoVencimiento: "2026-12-20", fechaCorte: "2026-12-25" });
    // Cruza de mes y de año.
    expect(proponerVencimientos("2026-12-28", config)).toEqual({ segundoVencimiento: "2027-01-07", fechaCorte: "2027-01-12" });
    // Sin segundo vencimiento, el corte se cuenta desde el primero.
    expect(proponerVencimientos("2026-12-10", { dias_segundo_vencimiento: null, dias_corte: 0 })).toEqual({
      segundoVencimiento: null,
      fechaCorte: "2026-12-10",
    });
    expect(proponerVencimientos(null, config)).toEqual({ segundoVencimiento: null, fechaCorte: null });
    expect(proponerVencimientos("2026-12-10", { dias_segundo_vencimiento: null, dias_corte: null })).toEqual({
      segundoVencimiento: null,
      fechaCorte: null,
    });
    // Con un segundo ya decidido, el corte se cuenta desde ese.
    expect(proponerVencimientos("2026-12-10", config, "2026-12-15")).toEqual({ segundoVencimiento: "2026-12-15", fechaCorte: "2026-12-20" });
  });

  it("abrirMesEnCurso: el primer vencimiento se calcula como antes y los otros dos salen de la configuración", async () => {
    await admin.query(
      "update barrio set modelo_liquidacion = 'fija', dia_vencimiento = 10, dias_segundo_vencimiento = 10, dias_corte = 5 where barrio_id = $1",
      [a1()],
    );
    const mes = await como(adminA1(), (tx) => abrirMesEnCurso(tx, { barrioId: a1() }));
    expect(mes?.recienAbierto).toBe(true);
    const { rows } = await admin.query<{ primer: string; segundo: string | null; corte: string | null; esperado: string }>(
      `select primer_vencimiento::text as primer, segundo_vencimiento::text as segundo, fecha_corte::text as corte,
              periodo || '-10' as esperado
         from periodo_expensa where id = $1`,
      [mes!.periodoId],
    );
    // Cuota fija: vence el mismo mes, el día del barrio (la regla de siempre, sin cambios).
    expect(rows[0]!.primer).toBe(rows[0]!.esperado);
    // La misma regla que la apertura manual.
    expect({ segundoVencimiento: rows[0]!.segundo, fechaCorte: rows[0]!.corte }).toEqual(
      proponerVencimientos(rows[0]!.primer, { dias_segundo_vencimiento: 10, dias_corte: 5 }),
    );
    await admin.query("delete from periodo_expensa where id = $1", [mes!.periodoId]);
  });

  it("abrirMesEnCurso sin segundo vencimiento ni corte configurados: quedan vacíos", async () => {
    await admin.query("update barrio set dias_segundo_vencimiento = null, dias_corte = null where barrio_id = $1", [a1()]);
    const mes = await como(adminA1(), (tx) => abrirMesEnCurso(tx, { barrioId: a1() }));
    const { rows } = await admin.query(
      "select primer_vencimiento is not null as primer, segundo_vencimiento, fecha_corte from periodo_expensa where id = $1",
      [mes!.periodoId],
    );
    expect(rows[0]).toEqual({ primer: true, segundo_vencimiento: null, fecha_corte: null });
    await admin.query("delete from periodo_expensa where id = $1", [mes!.periodoId]);
    await admin.query("update barrio set dias_segundo_vencimiento = 10, dias_corte = 5 where barrio_id = $1", [a1()]);
  });

  it("crearPeriodo (apertura manual): lo vacío se propone, lo cargado se respeta", async () => {
    const propuesto = await como(adminA1(), (tx) =>
      crearPeriodo(tx, { barrioId: a1(), periodo: "2030-01", modelo: "fija", primerVencimiento: "2030-01-10", segundoVencimiento: null, notas: null }),
    );
    const cargado = await como(adminA1(), (tx) =>
      crearPeriodo(tx, {
        barrioId: a1(),
        periodo: "2030-02",
        modelo: "fija",
        primerVencimiento: "2030-02-10",
        segundoVencimiento: "2030-02-14",
        fechaCorte: null,
        notas: null,
      }),
    );
    const { rows } = await admin.query<{ periodo: string; segundo: string | null; corte: string | null }>(
      `select periodo, segundo_vencimiento::text as segundo, fecha_corte::text as corte
         from periodo_expensa where id = any($1::uuid[]) order by periodo`,
      [[propuesto.id, cargado.id]],
    );
    expect(rows).toEqual([
      { periodo: "2030-01", segundo: "2030-01-20", corte: "2030-01-25" },
      // El segundo cargado a mano se respeta, y el corte se cuenta desde él.
      { periodo: "2030-02", segundo: "2030-02-14", corte: "2030-02-19" },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("la fecha de corte del período (0078)", () => {
  let marzo: string;
  beforeAll(async () => {
    marzo = (
      await como(adminA1(), (tx) =>
        crearPeriodo(tx, { barrioId: a1(), periodo: "2030-03", modelo: "fija", primerVencimiento: "2030-03-10", segundoVencimiento: null, notas: null }),
      )
    ).id;
  });

  it("se cambia en los vencimientos del mes, y vacía queda sin corte", async () => {
    await como(adminA1(), (tx) =>
      cambiarVencimientos(tx, { periodoId: marzo, primerVencimiento: "2030-03-10", segundoVencimiento: "2030-03-20", fechaCorte: "2030-03-31", motivo: "Prueba" }),
    );
    let { rows } = await admin.query("select fecha_corte::text as c from periodo_expensa where id = $1", [marzo]);
    expect(rows[0]).toEqual({ c: "2030-03-31" });
    await como(adminA1(), (tx) =>
      cambiarVencimientos(tx, { periodoId: marzo, primerVencimiento: "2030-03-10", segundoVencimiento: "2030-03-20", fechaCorte: "", motivo: "Sin corte" }),
    );
    ({ rows } = await admin.query("select fecha_corte from periodo_expensa where id = $1", [marzo]));
    expect(rows[0]).toEqual({ fecha_corte: null });
  });

  it("check: no antes del último vencimiento, y no sin vencimiento", async () => {
    // El esquema lo dice en el campo…
    await expect(
      como(adminA1(), (tx) =>
        cambiarVencimientos(tx, { periodoId: marzo, primerVencimiento: "2030-03-10", segundoVencimiento: "2030-03-20", fechaCorte: "2030-03-15", motivo: "x" }),
      ),
    ).rejects.toThrow(/anterior al último vencimiento/);
    // …y la base lo hace cumplir aunque se escriba directo (con su mensaje traducido).
    await expect(
      admin.query("update periodo_expensa set segundo_vencimiento = '2030-03-20', fecha_corte = '2030-03-19' where id = $1", [marzo]),
    ).rejects.toThrow(/periodo_fecha_corte_chk/);
    await expect(
      admin.query("update periodo_expensa set primer_vencimiento = null, segundo_vencimiento = null, fecha_corte = '2030-03-30' where id = $1", [marzo]),
    ).rejects.toThrow(/periodo_fecha_corte_chk/);
    const e = await capturar(() =>
      como(adminA1(), (tx) => tx.execute(sql`update periodo_expensa set fecha_corte = '2030-03-01' where id = ${marzo}`)).catch(async (x) => {
        // `tx.execute` crudo no traduce; se traduce con la misma tabla que usan los servicios.
        const { traducirError } = await import("../src/errores.ts");
        throw traducirError(x);
      }),
    );
    expect(e.codigo).toBe("fecha_corte_invalida");
    // El mismo día del último vencimiento, sí.
    await admin.query("update periodo_expensa set segundo_vencimiento = '2030-03-20', fecha_corte = '2030-03-20' where id = $1", [marzo]);
  });

  it("se congela al emitir, como los vencimientos (app.periodo_emitido_inmutable, 0078)", async () => {
    // Un período emitido armado salteando los triggers: lo que se prueba es el congelamiento.
    const c = await admin.connect();
    let emitido: string;
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      emitido = (
        await c.query<{ id: string }>(
          `insert into periodo_expensa (barrio_id, periodo, estado, modelo, primer_vencimiento, segundo_vencimiento, fecha_corte, emitida_at)
           values ($1, '2029-12', 'emitida', 'fija', '2029-12-10', '2029-12-20', '2029-12-31', now()) returning id`,
          [a1()],
        )
      ).rows[0]!.id;
      await c.query("commit");
    } finally {
      c.release();
    }
    await expect(admin.query("update periodo_expensa set fecha_corte = '2030-01-15' where id = $1", [emitido])).rejects.toThrow(
      /los vencimientos de un período emitida no se pueden cambiar/,
    );
    await expect(admin.query("update periodo_expensa set fecha_corte = null where id = $1", [emitido])).rejects.toThrow(
      /no se pueden cambiar/,
    );
    const e = await capturar(() =>
      como(adminA1(), (tx) =>
        cambiarVencimientos(tx, { periodoId: emitido, primerVencimiento: "2029-12-10", segundoVencimiento: "2029-12-20", fechaCorte: "2030-01-20", motivo: "Tarde" }),
      ),
    );
    expect(e.codigo).toBe("periodo_no_editable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("la figura «Sin entidad constituida» (0077)", () => {
  const alta = (extra: Record<string, unknown>) => ({
    administradorId: arbol.adminA.id,
    nombre: "Barrio sin entidad de prueba",
    razonSocial: "",
    cuit: "",
    municipio: "Malagueño",
    figuraJuridica: "sin_entidad",
    modelo: "fija",
    diaVencimiento: "10",
    diasSegundoVencimiento: "7",
    diasCorte: "",
    primerPeriodo: "2027-01",
    identificacionPago: "cuenta_unica",
    cuentaCbu: CBU_BARRIO_NUEVO,
    cuentaAlias: "",
    recaudador: "",
    medioCobranza: "transferencia-qr",
    codigoPagoPrefijo: "",
    mandatoDesde: "2026-11-01",
    actaAdjunto: "",
    adecuadoArt2075: "",
    encuadreUrbanistico: "",
    serviciosInternos: "",
    reglamentoInscripto: "",
    ...extra,
  });

  it("el esquema del alta pide el representante para esta figura, y solo para esta", () => {
    const sin = crearBarrioSchema.safeParse(alta({}));
    expect(sin.success).toBe(false);
    expect(sin.error?.issues.map((i) => i.path.join("."))).toEqual(["representanteNombre", "representanteCaracter"]);
    expect(crearBarrioSchema.safeParse(alta({ representanteNombre: "Comisión vecinal", representanteCaracter: "comision" })).success).toBe(true);
    const otra = crearBarrioSchema.safeParse(alta({ figuraJuridica: "sa", representanteNombre: "Alguien", representanteCaracter: "delegado" }));
    expect(otra.success).toBe(false);
  });

  it("se da de alta sin CUIT ni razón social, con su representante, y la figura se versiona", async () => {
    const { barrioId } = await como(arbol.usuarios.adminEstudioA, (tx) =>
      crearBarrioServicio(tx, alta({ representanteNombre: "Rosa Delegada", representanteCaracter: "delegado" }) as never),
    );
    creadosPorServicio.push(barrioId);
    const { rows } = await admin.query(
      `select b.figura_juridica::text as figura, b.cuit, b.razon_social, b.representante_nombre, b.representante_caracter,
              b.dias_segundo_vencimiento, b.dias_corte, b.denominacion_concepto,
              (select valor from barrio_atributo_vigencia v where v.barrio_id = b.barrio_id and v.eje = 'figura_juridica') as vigencia
         from barrio b where b.barrio_id = $1`,
      [barrioId],
    );
    expect(rows[0]).toEqual({
      figura: "sin_entidad",
      cuit: null,
      razon_social: null,
      representante_nombre: "Rosa Delegada",
      representante_caracter: "delegado",
      dias_segundo_vencimiento: 7,
      dias_corte: null,
      // Sin fuente para esta figura: la denominación no se inventa.
      denominacion_concepto: null,
      vigencia: "sin_entidad",
    });
    const b = await como(arbol.usuarios.adminEstudioA, (tx) => leerBarrio(tx, { barrioId }));
    expect(b?.representante).toEqual({ nombre: "Rosa Delegada", caracter: "delegado" });
  });

  it("la base no deja un barrio sin entidad sin representante", async () => {
    await expect(
      admin.query("update barrio set figura_juridica = 'sin_entidad' where barrio_id = $1", [arbol.barrioA2.id]),
    ).rejects.toThrow(/barrio_sin_entidad_con_representante_chk/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("la unidad: número de acción y residente (0078)", () => {
  let lote1: string;
  let lote2: string;

  beforeAll(async () => {
    lote1 = (
      await como(adminA1(), (tx) =>
        agregarUnidad(tx, {
          barrioId: a1(),
          manzana: "7",
          lote: "1",
          estado: "construido",
          numeroAccion: "A-101",
          residenteNombre: "Marcos Inquilino",
          residenteCaracter: "inquilino",
          residenteTelefono: "351 555-0199",
          residenteMail: "marcos.inquilino@correo.example",
          titulares: [{ nombre: "Laura Propietaria", documento: "27333333", mail: "laura@correo.example" }],
        }),
      )
    ).unidadFuncionalId;
    lote2 = (await como(adminA1(), (tx) => agregarUnidad(tx, { barrioId: a1(), manzana: "7", lote: "2", estado: "baldio", titulares: [] })))
      .unidadFuncionalId;
  });

  it("el número de acción es único en el barrio (sin mayúsculas ni espacios), y vacío se repite sin problema", async () => {
    const e = await capturar(() => como(adminA1(), (tx) => editarUnidad(tx, { unidadFuncionalId: lote2, estado: "baldio", numeroAccion: " a-101 " })));
    expect(e.codigo).toBe("numero_accion_repetido");
    // Dos unidades sin número: sin problema (lote2 y las del barrio).
    await como(adminA1(), (tx) => editarUnidad(tx, { unidadFuncionalId: lote2, estado: "baldio", numeroAccion: "A-102" }));
    // En otro barrio, el mismo número es otro.
    await admin.query(
      "insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad, numero_accion) values ($1, '1', '1', 'baldio', 'A-101')",
      [arbol.barrioA2.id],
    );
  });

  it("la ficha y la lista lo muestran; editar sin los campos nuevos no los borra; vacío los borra", async () => {
    let ficha = await como(adminA1(), (tx) => fichaDeUnidad(tx, { unidadFuncionalId: lote1 }));
    expect(ficha?.numeroAccion).toBe("A-101");
    expect(ficha?.residente).toEqual({
      nombre: "Marcos Inquilino",
      caracter: "inquilino",
      telefono: "351 555-0199",
      mail: "marcos.inquilino@correo.example",
    });
    // Un formulario que no conoce los campos (no los manda) no los pisa.
    await como(adminA1(), (tx) => editarUnidad(tx, { unidadFuncionalId: lote1, estado: "construido", superficie: "600" }));
    ficha = await como(adminA1(), (tx) => fichaDeUnidad(tx, { unidadFuncionalId: lote1 }));
    expect([ficha?.numeroAccion, ficha?.residente?.nombre]).toEqual(["A-101", "Marcos Inquilino"]);
    const lista = await como(adminA1(), (tx) => listarPadronEditable(tx, { barrioId: a1(), filtro: "todas", busqueda: "", limite: 50, desplazamiento: 0 }));
    expect(lista.filas.find((f) => f.id === lote1)?.numeroAccion).toBe("A-101");
    // El historial registra el cambio de residente sin sus datos de contacto.
    await como(adminA1(), (tx) =>
      editarUnidad(tx, {
        unidadFuncionalId: lote1,
        estado: "construido",
        superficie: "600",
        residenteNombre: "",
        residenteCaracter: "",
        residenteTelefono: "",
        residenteMail: "",
      }),
    );
    ficha = await como(adminA1(), (tx) => fichaDeUnidad(tx, { unidadFuncionalId: lote1 }));
    expect(ficha?.residente).toBeNull();
    expect(ficha?.historial[0]?.detalle).toBe("Edición: residente quitado.");
    expect(ficha?.historial.some((h) => h.detalle.includes("555-0199") || h.detalle.includes("marcos.inquilino"))).toBe(false);
    await como(adminA1(), (tx) =>
      editarUnidad(tx, { unidadFuncionalId: lote1, estado: "construido", superficie: "600", residenteNombre: "Marcos Inquilino", residenteCaracter: "inquilino" }),
    );
  });

  it("el residente no es destinatario de nada: la boleta sigue yendo al propietario", async () => {
    const { rows } = await admin.query<{ email: string }>(
      "select email from unidad_contacto where unidad_funcional_id = $1 and activo",
      [lote1],
    );
    expect(rows.map((r) => r.email)).toEqual(["laura@correo.example"]);
  });

  it("acceso: la misma RLS que la unidad (gestión del barrio lee; propietario, residente y otra administración, no)", async () => {
    const leer = (u: string) =>
      como(u, (tx) => tx.execute<{ r: string | null }>(sql`select residente_nombre as r from unidad_funcional where id = ${lote1}`)).then((x) => x.rows);
    for (const u of [adminA1(), arbol.usuarios.operadorA1, arbol.usuarios.contadorA1, arbol.usuarios.auditorA1]) {
      expect(await leer(u)).toEqual([{ r: "Marcos Inquilino" }]);
    }
    for (const u of [arbol.usuarios.propietarioA1, arbol.usuarios.residenteA1, arbol.usuarios.adminEstudioB, arbol.usuarios.sinMembresia]) {
      expect(await leer(u)).toEqual([]);
    }
    // Editar por el servicio es de la administración.
    const e = await capturar(() =>
      como(arbol.usuarios.operadorA1, (tx) => editarUnidad(tx, { unidadFuncionalId: lote1, estado: "construido", residenteNombre: "Otro" })),
    );
    expect(e.codigo).toBe("sin_permiso");
  });

  it("la planilla: las columnas nuevas entran, se exportan y vuelven a entrar sin cambios", async () => {
    const encabezado = columnasDelPadron(false);
    expect(encabezado.length).toBeLessThanOrEqual(20);
    const fila = (v: Partial<Record<(typeof encabezado)[number], string>>) => encabezado.map((c) => v[c] ?? "");
    const filas = [
      [...encabezado],
      fila({ manzana: "8", lote: "1", estado: "Baldío", titular: "Iván Planilla", numero_accion: "B-1", residente: "Sofía Residente", residente_caracter: "Residente" }),
      fila({ manzana: "8", lote: "2", estado: "Baldío", titular: "Julia Planilla", numero_accion: "b-1" }),
    ];
    const conRepetido = await capturar(() => como(adminA1(), (tx) => confirmarImportacion(tx, { barrioId: a1(), archivo: "padron.csv", filas })));
    expect(conRepetido.codigo).toBe("planilla_con_errores");
    const r = await como(adminA1(), (tx) =>
      confirmarImportacion(tx, { barrioId: a1(), archivo: "padron.csv", filas: [filas[0]!, filas[1]!] }),
    );
    expect(r.altas).toBe(1);
    const { rows } = await admin.query(
      "select numero_accion, residente_nombre, residente_caracter from unidad_funcional where barrio_id = $1 and manzana = '8'",
      [a1()],
    );
    expect(rows).toEqual([{ numero_accion: "B-1", residente_nombre: "Sofía Residente", residente_caracter: "residente" }]);
    const exportado = await como(adminA1(), (tx) => exportarPadron(tx, { barrioId: a1() }));
    const f81 = exportado.find((f) => f[0] === "8" && f[1] === "1")!;
    expect(f81[encabezado.indexOf("numero_accion")]).toBe("B-1");
    expect(f81[encabezado.indexOf("residente_caracter")]).toBe("Residente");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("padrón a una fecha", () => {
  let unidad: string;

  beforeAll(async () => {
    unidad = (
      await como(adminA1(), (tx) =>
        agregarUnidad(tx, {
          barrioId: a1(),
          manzana: "9",
          lote: "1",
          estado: "construido",
          numeroAccion: "C-9",
          titulares: [{ nombre: "Primer Dueño", documento: "20-11111111-2" }],
        }),
      )
    ).unidadFuncionalId;
    // El titular rige desde 2024; el cambio, desde el 1/6/2025.
    await admin.query("update unidad_obligado set desde = '2024-01-01' where unidad_funcional_id = $1", [unidad]);
    await como(adminA1(), (tx) =>
      cambiarTitular(tx, { unidadFuncionalId: unidad, desde: "2025-06-01", titular: { nombre: "Segunda Dueña", documento: "27222222" }, motivo: "venta" }),
    );
  });

  const filasDe9 = (filas: string[][]) => filas.filter((f) => f[0] === "Mza 9 · Lote 1");

  it("una fila por titular vigente ese día, del historial (el cambio de titular en el medio)", async () => {
    const antes = await como(adminA1(), (tx) => padronAUnaFecha(tx, { barrioId: a1(), fecha: "2025-05-31" }));
    expect(antes[0]).toEqual(["unidad", "numero_accion", "titular", "caracter", "documento", "porcentaje_titularidad", "desde"]);
    expect(filasDe9(antes)).toEqual([["Mza 9 · Lote 1", "C-9", "Primer Dueño", "Propietario", "20-11111111-2", "100", "01/01/2024"]]);
    const despues = await como(adminA1(), (tx) => padronAUnaFecha(tx, { barrioId: a1(), fecha: "2025-06-01" }));
    expect(filasDe9(despues)).toEqual([["Mza 9 · Lote 1", "C-9", "Segunda Dueña", "Propietario", "DNI 27222222", "100", "01/06/2025"]]);
    // Antes del primer titular, la unidad no tiene a nadie: no hay fila.
    const muyAntes = await como(adminA1(), (tx) => padronAUnaFecha(tx, { barrioId: a1(), fecha: "2023-12-31" }));
    expect(filasDe9(muyAntes)).toEqual([]);
  });

  it("con varios titulares el porcentaje queda vacío (no está en el modelo: no se inventan partes)", async () => {
    const hoy = await hoyDelBarrio();
    const fila = (await como(adminA1(), (tx) => padronAUnaFecha(tx, { barrioId: a1(), fecha: hoy }))).filter((f) => f[0] === "Mza 7 · Lote 1");
    expect(fila.map((f) => f[5])).toEqual(["100"]);
    await admin.query(
      `insert into obligado (barrio_id, nombre) values ($1, 'Co Titular') returning id`,
      [a1()],
    ).then(({ rows }) =>
      admin.query(
        "insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde) values ($1, $2, $3, 'propietario', '2024-01-01')",
        [a1(), unidad, rows[0]!.id],
      ),
    );
    const dos = filasDe9(await como(adminA1(), (tx) => padronAUnaFecha(tx, { barrioId: a1(), fecha: hoy })));
    expect(dos.map((f) => [f[2], f[5]])).toEqual([
      ["Segunda Dueña", ""],
      ["Co Titular", ""],
    ]);
  });

  it("queda registrada la exportación, y solo la baja la administración", async () => {
    const { rows } = await admin.query<{ detalle: string }>(
      "select detalle from padron_evento where barrio_id = $1 and tipo = 'exportacion' and detalle like 'Exportación del padrón al %' order by created_at",
      [a1()],
    );
    expect(rows[0]?.detalle).toBe("Exportación del padrón al 31/05/2025 (planilla).");
    for (const u of [arbol.usuarios.operadorA1, arbol.usuarios.contadorA1, arbol.usuarios.auditorA1, arbol.usuarios.adminEstudioB]) {
      const e = await capturar(() => como(u, (tx) => padronAUnaFecha(tx, { barrioId: a1(), fecha: "2025-06-01" })));
      expect(e.codigo).toBe("sin_permiso");
    }
  });

  it("una unidad dada de baja después de la fecha entra; una dada de baja antes, no", async () => {
    await admin.query("update unidad_funcional set baja_at = '2025-07-01 12:00-03', baja_motivo = 'otro' where id = $1", [unidad]);
    expect(filasDe9(await como(adminA1(), (tx) => padronAUnaFecha(tx, { barrioId: a1(), fecha: "2025-06-15" })))).toHaveLength(2); // la dueña y el co-titular del caso anterior
    expect(filasDe9(await como(adminA1(), (tx) => padronAUnaFecha(tx, { barrioId: a1(), fecha: "2025-07-02" })))).toHaveLength(0);
    await admin.query("update unidad_funcional set baja_at = null, baja_motivo = null where id = $1", [unidad]);
  });
});

describe("sin nombre no hay residente (0078)", () => {
  it("editar no deja datos del residente sin su nombre, y la base tampoco", async () => {
    const id = (await como(adminA1(), (tx) => agregarUnidad(tx, { barrioId: a1(), manzana: "10", lote: "1", estado: "baldio", titulares: [] })))
      .unidadFuncionalId;
    const e = await capturar(() =>
      como(adminA1(), (tx) => editarUnidad(tx, { unidadFuncionalId: id, estado: "baldio", residenteTelefono: "351 555-0100" })),
    );
    expect(e.codigo).toBe("dato_invalido");
    await expect(admin.query("update unidad_funcional set residente_email = 'x@correo.example' where id = $1", [id])).rejects.toThrow(
      /uf_residente_con_nombre_chk/,
    );
  });
});

describe("lo que pidió la revisión de código (H1, H2, H4)", () => {
  it("crearPeriodo: un corte cargado antes del segundo vencimiento propuesto se rechaza en el campo", async () => {
    const e = await capturar(() =>
      como(adminA1(), (tx) =>
        crearPeriodo(tx, { barrioId: a1(), periodo: "2030-06", modelo: "fija", primerVencimiento: "2030-06-10", segundoVencimiento: null, fechaCorte: "2030-06-15", notas: null }),
      ),
    );
    expect(e.codigo).toBe("fecha_corte_invalida");
  });

  it("padrón a una fecha: una fecha que no existe es un dato inválido, no un error de base", async () => {
    const e = await capturar(() => como(adminA1(), (tx) => padronAUnaFecha(tx, { barrioId: a1(), fecha: "2026-02-31" })));
    expect(e.codigo).toBe("dato_invalido");
  });

  it("padrón a una fecha: un tenedor sale con su carácter y no le quita el 100 al único propietario", async () => {
    const id = (
      await como(adminA1(), (tx) =>
        agregarUnidad(tx, { barrioId: a1(), manzana: "11", lote: "1", estado: "baldio", titulares: [{ nombre: "Única Propietaria" }] }),
      )
    ).unidadFuncionalId;
    const { rows } = await admin.query<{ id: string }>("insert into obligado (barrio_id, nombre) values ($1, 'Tito Tenedor') returning id", [a1()]);
    const hoy = await hoyDelBarrio();
    await admin.query(
      "insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde) values ($1, $2, $3, 'tenedor', $4)",
      [a1(), id, rows[0]!.id, hoy],
    );
    const filas = (await como(adminA1(), (tx) => padronAUnaFecha(tx, { barrioId: a1(), fecha: hoy }))).filter((f) => f[0] === "Mza 11 · Lote 1");
    expect(filas.map((f) => [f[2], f[3], f[5]])).toEqual([
      ["Única Propietaria", "Propietario", "100"],
      ["Tito Tenedor", "Tenedor", ""],
    ]);
  });
});
