/**
 * Encargo 16 (Etapa 1.3), contra Postgres real (`0079`, `0080`, `0081`):
 *  - «Cómo se devenga»: se guarda por mes, solo lo cambia la administración, no toca un mes emitido,
 *    y sin nada cargado el barrio se comporta como antes.
 *  - El importe definido por coeficiente: el total del mes repartido al centavo, con su centavo
 *    sobrante, y la emisión que lo verifica.
 *  - La bonificación por pago en término que se aplica sola: quién está al día (pagó antes, pagó
 *    después, deuda no vencida), las excepciones con motivo, y el orden expensa → bonificación → resto.
 *  - El cupón que cobra solo el mes: `importe_cupon` en los dos modos, y que la deuda y el interés al
 *    corte son los MISMOS con un modo y con el otro.
 *  - Lo que se usó se congela al emitir, y los permisos por rol.
 *
 * Escenario: tres unidades con coeficientes 0,5 / 0,3 / 0,2.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { nuevoToken } from "@admin-barrios/almacenamiento";
import { registroPorDefecto } from "@admin-barrios/documentos/cobranza";
import { conUsuario, type DbRequest } from "../src/client.ts";
import { registrarEImputarPago } from "../src/servicios/deuda.ts";
import { boletasDelMes, emitirMes, abrirMesEnCurso } from "../src/servicios/circuito-del-mes.ts";
import { emitirPeriodo, generarLiquidaciones } from "../src/servicios/liquidacion.ts";
import { cuotaFijaVigente, definirCuotaFija } from "../src/servicios/cuota-fija.ts";
import { crearConceptoBoleta, registrarValorConcepto } from "../src/servicios/conceptos-boleta.ts";
import { anularParametroProgramado, fijarParametro } from "../src/servicios/parametros.ts";
import { aplicarConceptoAUnidad } from "../src/servicios/cargos.ts";
import { armarVistasDelPeriodo } from "../src/servicios/vista-boleta.ts";
import { crearBarrio as crearBarrioServicio } from "../src/servicios/padron-edicion.ts";
import {
  bonificacionDelMes,
  cambiarComoSeDevenga,
  comoSeDevengaEn,
  leerComoSeDevenga,
  ponerExcepcionDeBonificacion,
  sacarExcepcionDeBonificacion,
} from "../src/servicios/devengado.ts";
import { borrarArbol, borrarParametrosDe, cargarParametro, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf1: string;
let uf2: string;
let uf3: string;
let conceptoId: string;
const creadosPorServicio: string[] = [];

const registro = registroPorDefecto();
const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminB = () => arbol.usuarios.adminBarrioA1;

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

/** Llama a `app.fijar_parametro` sin pasar por el servicio: lo que tiene que frenar es la base. */
const fijarDirecto = (usuario: string, nodo: string, desde: string) =>
  como(usuario, (tx) =>
    tx.execute(sql`
      select app.fijar_parametro(${nodo}::uuid, 'cupon.cobra', '"solo_mes"'::jsonb, ${desde}::date, 'Un motivo de quince caracteres')
    `),
  );

/** Hoy en la hora del barrio, y hoy ± días: para armar vencimientos pasados y futuros. */
const fechaRelativa = async (dias: number) =>
  (await admin.query<{ f: string }>("select ((now() at time zone 'America/Argentina/Buenos_Aires')::date + $1::int)::text as f", [dias])).rows[0]!.f;

/** Un período con $ 2.000 de gasto (por coeficiente: $ 1.000 / $ 600 / $ 400). */
async function crearPeriodo(periodo: string, vencimiento: string, modelo: "variable" | "fija" = "variable", gasto: string | null = "2000.00"): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, modelo, primer_vencimiento) values ($1, $2, $3, $4) returning id",
    [barrio(), periodo, modelo, vencimiento],
  );
  if (gasto !== null) {
    await admin.query(
      "insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', $4)",
      [barrio(), rows[0]!.id, conceptoId, gasto],
    );
  }
  return rows[0]!.id;
}

const pagar = (unidad: string, monto: string, fecha: string) =>
  como(adminB(), (tx) =>
    registrarEImputarPago(tx, {
      pago: { unidadFuncionalId: unidad, obligadoId: null, monto, fecha, origen: "manual", comprobanteAdjunto: `barrios/${barrio()}/pagos/comprobantes/${nuevoToken()}.pdf` },
      confirmarPagoConInteres: true,
      noCobrarInteres: null,
    }),
  );

/** Carga «Cómo se devenga» desde siempre, por la puerta del dueño del esquema (un escenario, no una persona). */
async function devengado(valores: Record<string, unknown>): Promise<void> {
  for (const [clave, valor] of Object.entries(valores)) await cargarParametro(admin, barrio(), clave, valor);
}

/** La mora del escenario. `cobra: false` deja la deuda sin interés, para que los pagos cierren redondo. */
async function mora(cobra: boolean): Promise<void> {
  for (const [clave, valor] of [
    ["interes.cobra", cobra], ["interes.tasa_compensatoria", "0.03"], ["interes.tasa_punitoria", "0"], ["interes.gracia_dias", 0],
    ["interes.forma_gracia", "corre_inicio"], ["interes.tolerancia", "0.00"], ["imputacion.orden", "intereses_primero_capital_antiguo"],
  ] as const) {
    await cargarParametro(admin, barrio(), clave, valor);
  }
}

const BONIFICA_SOLA = {
  "devengado.origen": "gastos",
  "devengado.reparto": "coeficiente",
  "cupon.cobra": "solo_mes",
  "bonificacion.modo": "sola",
  "bonificacion.forma": "porcentaje",
  "bonificacion.valor": "10",
  "bonificacion.tope": "500.00",
};

/** El concepto de la bonificación del barrio, como lo deja «Cómo se devenga»: 10 % con tope $ 500. */
async function conceptoDeBonificacion(porcentaje = "10", tope = "500.00"): Promise<void> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo, clasificacion_fiscal, financiamiento, regla_barrio)
     values ($1, 'Bonificación por pago en término', 'descuento', 'porcentaje', 'expensa_ordinaria', 'sin_clasificar', 'absorbe_barrio', 'bonificacion_pago_en_termino')
     returning id`,
    [barrio()],
  );
  await admin.query(
    `insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, porcentaje, tope, vigente_desde)
     values ($1, $2, 'porcentaje', $3, $4, '2000-01-01')`,
    [barrio(), rows[0]!.id, porcentaje, tope],
  );
}

type Liq = {
  uf: string;
  ordinarias: string;
  cuota: string;
  descuentos: string;
  cargos: string;
  saldo: string;
  interes: string | null;
  total: string;
  exigible: string;
  cupon: string | null;
  no_aplicada: string | null;
  deuda: { periodo: string; vencimiento: string; capital: string; interes: string }[] | null;
};

async function liquidacionesDe(periodoId: string): Promise<Record<"uf1" | "uf2" | "uf3", Liq>> {
  const { rows } = await admin.query<Liq>(
    `select l.unidad_funcional_id as uf, l.subtotal_ordinarias::text as ordinarias, l.subtotal_cuota_fija::text as cuota,
            l.subtotal_descuentos::text as descuentos, l.subtotal_cargos::text as cargos, l.saldo_anterior::text as saldo,
            l.interes_mora::text as interes, l.total::text, l.importe_exigible::text as exigible, l.importe_cupon::text as cupon,
            l.bonificacion_no_aplicada::text as no_aplicada, l.deuda_anterior as deuda
       from liquidacion l where l.periodo_id = $1`,
    [periodoId],
  );
  const de = (u: string) => rows.find((r) => r.uf === u)!;
  return { uf1: de(uf1), uf2: de(uf2), uf3: de(uf3) };
}

const emitir = (periodoId: string, usuario = adminB()) =>
  como(usuario, (tx) => emitirMes(tx, { periodoId, huellaVista: null, vistaCalculadaEl: null, confirmarCambios: false }));

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, barrio(), { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  const { rows: ufs } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad)
     values ($1,'1','1','construido'), ($1,'1','2','construido'), ($1,'1','3','construido') returning id`,
    [barrio()],
  );
  [uf1, uf2, uf3] = [ufs[0]!.id, ufs[1]!.id, ufs[2]!.id];
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [barrio()],
  );
  await admin.query(
    "insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,0.5), ($1,$2,$4,0.3), ($1,$2,$5,0.2)",
    [barrio(), v[0]!.id, uf1, uf2, uf3],
  );
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
  const { rows: c } = await admin.query<{ id: string }>(
    "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
    [barrio()],
  );
  conceptoId = c[0]!.id;
});

afterEach(async () => {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of [
      "trabajo", "padron_evento", "bonificacion_excepcion", "interes_condonacion", "pago_imputacion_interes", "pago_imputacion",
      "interes_devengado", "saldo_uf", "pago", "concepto_boleta_unidad_evento", "concepto_boleta_unidad", "item_liquidacion", "liquidacion",
      "gasto_periodo", "periodo_expensa", "cuota_fija", "cuota_fija_version", "concepto_boleta_valor", "concepto_boleta", "limite_aplicacion_barrio",
    ]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("update barrio set modelo_liquidacion = null, dia_vencimiento = null where barrio_id = $1", [barrio()]);
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarParametrosDe(admin, [barrio()]);
});

afterAll(async () => {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const b of [...creadosPorServicio, barrio()]) {
      for (const t of [
        "padron_evento", "concepto", "coeficiente", "coeficiente_version", "unidad_funcional", "codigo_pago_secuencia",
        "mandato_administracion", "documento_barrio", "barrio_atributo_vigencia", "barrio",
      ]) {
        await c.query(`delete from ${t} where barrio_id = $1`, [b]);
      }
    }
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
describe("sin «Cómo se devenga» cargado, el barrio se comporta como antes", () => {
  it("lo que rige es el modelo del barrio, el cupón con deuda y la bonificación a mano; y la emisión no escribe nada nuevo", async () => {
    await mora(true);
    const dev = await como(adminB(), (tx) => comoSeDevengaEn(tx, { barrioId: barrio(), mes: "2025-01" }));
    expect(dev).toMatchObject({
      origen: "gastos",
      reparto: "coeficiente",
      cuponCobra: "mes_mas_deuda",
      bonificacion: { modo: "a_mano", cuanto: null },
      cargado: false,
    });
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await emitir(enero);
    const { rows } = await admin.query(
      "select cupon_cobra, bonificacion_modo, bonificacion_forma, bonificacion_valor, bonificacion_tope from periodo_expensa where id = $1",
      [enero],
    );
    expect(rows[0]).toEqual({ cupon_cobra: null, bonificacion_modo: null, bonificacion_forma: null, bonificacion_valor: null, bonificacion_tope: null });
    const l = await liquidacionesDe(enero);
    expect([l.uf1.total, l.uf2.total, l.uf3.total]).toEqual(["1000.00", "600.00", "400.00"]);
    expect([l.uf1.cupon, l.uf1.no_aplicada, l.uf1.descuentos]).toEqual([null, null, "0.00"]);
    // La vista de la boleta no trae modo de cupón: es la de siempre.
    const vistas = await como(adminB(), (tx) => armarVistasDelPeriodo(tx, enero, { registro }));
    expect(vistas[0]!.cupon).toBeNull();
    expect(vistas[0]!.bloquePago.importes.alVencimiento.monto).toBe(vistas[0]!.totales.aPagar.monto);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("«Cómo se devenga»: guardar, vigencia por mes y permisos", () => {
  const cambio = (extra: Record<string, unknown> = {}) => ({
    barrioId: barrio(),
    rigeDesde: "2025-03",
    origen: "administracion",
    reparto: "igual",
    cuponCobra: "solo_mes",
    bonificacionModo: "sola",
    bonificacionForma: "porcentaje",
    bonificacionValor: "7,5",
    bonificacionTope: "20.000,00",
    motivo: "Lo resolvió la comisión en su reunión de marzo",
    ...extra,
  });

  it("la administración lo guarda desde un mes: rige ese mes y no el anterior, queda en el historial y crea el concepto", async () => {
    const r = await como(adminB(), (tx) => cambiarComoSeDevenga(tx, cambio() as never));
    expect(r).toEqual({ cambios: 7, rigeDesde: "2025-03" });

    const febrero = await como(adminB(), (tx) => comoSeDevengaEn(tx, { barrioId: barrio(), mes: "2025-02" }));
    expect(febrero.cargado).toBe(false);
    const marzo = await como(adminB(), (tx) => comoSeDevengaEn(tx, { barrioId: barrio(), mes: "2025-03" }));
    expect(marzo).toMatchObject({
      origen: "administracion",
      reparto: "igual",
      cuponCobra: "solo_mes",
      bonificacion: { modo: "sola", cuanto: { forma: "porcentaje", valor: "7.5", tope: "20000.00" } },
      cargado: true,
    });

    const { rows: filas } = await admin.query<{ clave: string; motivo: string; creado_por: string; desde: string }>(
      "select clave, motivo, creado_por, vigente_desde::text as desde from parametro_valor where nodo_id = $1 and clave not like 'interes.%' and clave <> 'imputacion.orden' order by clave",
      [barrio()],
    );
    expect(filas.map((f) => f.clave)).toEqual([
      "bonificacion.forma", "bonificacion.modo", "bonificacion.tope", "bonificacion.valor", "cupon.cobra", "devengado.origen", "devengado.reparto",
    ]);
    expect(new Set(filas.map((f) => f.desde))).toEqual(new Set(["2025-03-01"]));
    expect(new Set(filas.map((f) => f.creado_por))).toEqual(new Set([adminB()]));
    expect(filas[0]!.motivo).toBe("Lo resolvió la comisión en su reunión de marzo");

    // El concepto de la bonificación, con su valor desde ese mes.
    const { rows: concepto } = await admin.query(
      `select cb.nombre, cb.clase::text as clase, cb.metodo::text as metodo, cb.base_calculo::text as base, cb.regla_barrio,
              v.porcentaje::text as porcentaje, v.tope::text as tope, v.vigente_desde::text as desde
         from concepto_boleta cb join concepto_boleta_valor v on v.concepto_boleta_id = cb.id where cb.barrio_id = $1`,
      [barrio()],
    );
    expect(concepto).toEqual([
      {
        nombre: "Bonificación por pago en término", clase: "descuento", metodo: "porcentaje", base: "expensa_ordinaria",
        regla_barrio: "bonificacion_pago_en_termino", porcentaje: "7.500000", tope: "20000.00", desde: "2025-03-01",
      },
    ]);

    // Guardar lo mismo no agrega nada; cambiar un punto agrega una sola fila.
    expect((await como(adminB(), (tx) => cambiarComoSeDevenga(tx, cambio() as never))).cambios).toBe(0);
    expect((await como(adminB(), (tx) => cambiarComoSeDevenga(tx, cambio({ cuponCobra: "mes_mas_deuda" }) as never))).cambios).toBe(1);

    // El panel lo lee: lo que rige, y el historial con quién y por qué.
    const panel = await como(adminB(), (tx) => leerComoSeDevenga(tx, { barrioId: barrio() }));
    expect(panel?.puedeEditar).toBe(true);
    expect(panel?.historial).toHaveLength(8);
    expect(panel?.historial[0]).toMatchObject({ rigeDesde: "2025-03", clave: "cupon.cobra", valor: "mes_mas_deuda" });
  });

  it("los meses abiertos desde ese mes toman el modelo del origen, y uno nuevo se abre con él", async () => {
    const abierto = await crearPeriodo("2025-04", "2025-05-10", "variable");
    await como(adminB(), (tx) => cambiarComoSeDevenga(tx, cambio({ bonificacionModo: "no" }) as never));
    const { rows } = await admin.query<{ modelo: string }>("select modelo::text as modelo from periodo_expensa where id = $1", [abierto]);
    expect(rows[0]!.modelo).toBe("fija");
    // El mes en curso se abre solo con el modelo de «Cómo se devenga», no con el del barrio (que no tiene).
    const mes = await como(adminB(), (tx) => abrirMesEnCurso(tx, { barrioId: barrio() }));
    const { rows: nuevo } = await admin.query<{ modelo: string }>("select modelo::text as modelo from periodo_expensa where id = $1", [mes!.periodoId]);
    expect(nuevo[0]!.modelo).toBe("fija");
  });

  it("un cambio nunca toca un mes emitido: ni ese mes ni uno anterior a él", async () => {
    await mora(false);
    const enero = await crearPeriodo("2025-03", "2025-03-10");
    await emitir(enero);
    for (const mes of ["2025-03", "2025-01"]) {
      const e = await capturar(() => como(adminB(), (tx) => cambiarComoSeDevenga(tx, cambio({ rigeDesde: mes }) as never)));
      expect(e.codigo).toBe("devengado_mes_emitido");
    }
    // El mes siguiente al emitido sí.
    expect((await como(adminB(), (tx) => cambiarComoSeDevenga(tx, cambio({ rigeDesde: "2025-04" }) as never))).cambios).toBe(7);
    // Y la base lo rechaza aunque no pase por el servicio.
    await expect(fijarDirecto(adminB(), barrio(), "2025-02-01")).rejects.toThrow(/no se cambia para un mes ya emitido/);
  });

  it("permisos por rol: operador, contador y auditor no lo cambian, ni por el servicio ni llamando a la base", async () => {
    for (const u of [arbol.usuarios.operadorA1, arbol.usuarios.contadorA1, arbol.usuarios.auditorA1]) {
      const e = await capturar(() => como(u, (tx) => cambiarComoSeDevenga(tx, cambio() as never)));
      expect(e.codigo).toBe("sin_permiso");
      await expect(fijarDirecto(u, barrio(), "2031-01-01")).rejects.toThrow(/solo la administración/);
    }
    const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from parametro_valor where nodo_id = $1", [barrio()]);
    expect(rows[0]!.n).toBe(0);
    // Quien no edita, igual lo ve.
    const panel = await como(arbol.usuarios.contadorA1, (tx) => leerComoSeDevenga(tx, { barrioId: barrio() }));
    expect(panel?.puedeEditar).toBe(false);
  });

  it("la base no acepta una clave del barrio en la administración, ni una fecha que no sea el día 1", async () => {
    await expect(fijarDirecto(arbol.usuarios.adminEstudioA, arbol.adminA.id, "2031-01-01")).rejects.toThrow(/se define en cada barrio/);
    await expect(fijarDirecto(arbol.usuarios.adminEstudioA, barrio(), "2031-01-15")).rejects.toThrow(/primer día de un mes/);
  });

  it("la bonificación que se aplica sola exige cuánto, y un porcentaje exige su tope", async () => {
    await expect(como(adminB(), (tx) => cambiarComoSeDevenga(tx, cambio({ bonificacionTope: "" }) as never))).rejects.toThrow(/tope/i);
    await expect(como(adminB(), (tx) => cambiarComoSeDevenga(tx, cambio({ bonificacionValor: "" }) as never))).rejects.toThrow(/cuánto/i);
    await expect(como(adminB(), (tx) => cambiarComoSeDevenga(tx, cambio({ motivo: "corto" }) as never))).rejects.toThrow(/motivo/i);
  });

  it("un barrio NUEVO nace con el origen y el reparto de su modelo, y el cupón que cobra solo el mes", async () => {
    const { barrioId } = await como(arbol.usuarios.adminEstudioA, (tx) =>
      crearBarrioServicio(tx, {
        administradorId: arbol.adminA.id, nombre: "Barrio nuevo del encargo 16", razonSocial: "Barrio Nuevo S.A.", cuit: "30-71234567-1",
        municipio: "Malagueño", figuraJuridica: "sa", modelo: "fija", diaVencimiento: "10", diasSegundoVencimiento: "", diasCorte: "",
        primerPeriodo: "2027-01", identificacionPago: "cuenta_unica", cuentaCbu: "0000003110000000000502", cuentaAlias: "", recaudador: "",
        medioCobranza: "transferencia-qr", codigoPagoPrefijo: "", mandatoDesde: "2026-11-01", actaAdjunto: "", adecuadoArt2075: "",
        encuadreUrbanistico: "", serviciosInternos: "", reglamentoInscripto: "",
      } as never),
    );
    creadosPorServicio.push(barrioId);
    const dev = await como(arbol.usuarios.adminEstudioA, (tx) => comoSeDevengaEn(tx, { barrioId, mes: "2027-01" }));
    expect(dev).toMatchObject({
      origen: "administracion", reparto: "igual", cuponCobra: "solo_mes", bonificacion: { modo: "a_mano", cuanto: null }, cargado: true,
    });
    const { rows } = await admin.query<{ clave: string; desde: string }>(
      "select clave, vigente_desde::text as desde from parametro_valor where nodo_id = $1 order by clave",
      [barrioId],
    );
    expect(rows).toEqual([
      { clave: "cupon.cobra", desde: "2027-01-01" },
      { clave: "devengado.origen", desde: "2027-01-01" },
      { clave: "devengado.reparto", desde: "2027-01-01" },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("el importe definido por coeficiente", () => {
  const cuota = (total: string) =>
    como(adminB(), (tx) => definirCuotaFija(tx, { barrioId: barrio(), rigeDesde: "2025-01", descripcion: "Acta 1", forma: "total", total } as never));

  it("reparte el total del mes al centavo: los centavos que sobran van a las unidades con mayor resto", async () => {
    await mora(false);
    await devengado({ "devengado.origen": "administracion", "devengado.reparto": "coeficiente", "cupon.cobra": "solo_mes" });
    // $ 1.000,03 por 0,5 / 0,3 / 0,2 = 500,015 / 300,009 / 200,006. Truncado: 500,01 + 300,00 + 200,00,
    // faltan dos centavos, que van a los dos restos más grandes (0,9 y 0,6): la segunda y la tercera.
    // La primera, que con un redondeo simple se llevaría 500,02, queda en 500,01: ajuste de −0,01.
    await cuota("1000.03");
    const vigente = await como(adminB(), (tx) => cuotaFijaVigente(tx, barrio()));
    expect(vigente).toMatchObject({ totalDelMes: "1000.03", totalMensual: "1000.03", importeUnico: null, unidadesSinImporte: 0 });
    const { rows: sinFilas } = await admin.query<{ n: number }>("select count(*)::int as n from cuota_fija where barrio_id = $1", [barrio()]);
    expect(sinFilas[0]!.n).toBe(0);

    const enero = await crearPeriodo("2025-01", "2025-01-10", "fija", null);
    await emitir(enero);
    const l = await liquidacionesDe(enero);
    expect([l.uf1.cuota, l.uf2.cuota, l.uf3.cuota]).toEqual(["500.01", "300.01", "200.01"]);
    expect([l.uf1.total, l.uf2.total, l.uf3.total]).toEqual(["500.01", "300.01", "200.01"]);

    // Cada línea explica su cifra: la base es el total del mes, con la cuenta a mano y su resto.
    const { rows: items } = await admin.query(
      `select l.unidad_funcional_id as uf, i.clase_item::text as clase, i.base_monto::text as base, i.monto::text as monto,
              i.monto_teorico::text as teorico, i.ajuste_redondeo::text as ajuste
         from item_liquidacion i join liquidacion l on l.id = i.liquidacion_id where l.periodo_id = $1`,
      [enero],
    );
    const item = (u: string) => items.find((i) => i.uf === u);
    expect(item(uf1)).toMatchObject({ clase: "cuota_fija", base: "1000.03", monto: "500.01", teorico: "500.02", ajuste: "-0.01" });
    expect(item(uf2)).toMatchObject({ clase: "cuota_fija", base: "1000.03", monto: "300.01", teorico: "300.01", ajuste: "0.00" });
    expect(item(uf3)).toMatchObject({ clase: "cuota_fija", base: "1000.03", monto: "200.01", teorico: "200.01", ajuste: "0.00" });

    // Y la boleta lo dice.
    const vistas = await como(adminB(), (tx) => armarVistasDelPeriodo(tx, enero, { registro }));
    expect(vistas[0]!.composicion[0]!.aclaracion).toBe("Tu parte de $ 1.000,03 del mes, por tu coeficiente (50,0000 %)");
  });

  it("la emisión verifica que lo repartido sea el total: si el total cambia después de calcular, no emite", async () => {
    await mora(false);
    await devengado({ "devengado.origen": "administracion", "devengado.reparto": "coeficiente", "cupon.cobra": "mes_mas_deuda" });
    await cuota("1000.01");
    const enero = await crearPeriodo("2025-01", "2025-01-10", "fija", null);
    await como(adminB(), (tx) => generarLiquidaciones(tx, { periodoId: enero, origenSaldo: "calculado" }));
    // Alguien cambia el total por fuera, sin recalcular: `app.validar_emision` lo ve.
    await admin.query("update cuota_fija_version set total_del_mes = 1000.02 where barrio_id = $1", [barrio()]);
    const e = await capturar(() => como(adminB(), (tx) => emitirPeriodo(tx, { periodoId: enero })));
    expect(e.message).toMatch(/no cuadra|no es el total del mes/i);
  });

  it("la forma de la cuota tiene que ser la del reparto: con «por coeficiente» no se carga un importe por unidad", async () => {
    await devengado({ "devengado.origen": "administracion", "devengado.reparto": "coeficiente" });
    const e = await capturar(() =>
      como(adminB(), (tx) => definirCuotaFija(tx, { barrioId: barrio(), rigeDesde: "2025-01", descripcion: "Acta 1", forma: "importe", importe: "300.00" } as never)),
    );
    expect(e.codigo).toBe("dato_invalido");
    expect(e.message).toMatch(/total del mes/);
    // Y la base no deja mezclar: una versión por total no acepta importes por unidad.
    await cuota("900.00");
    await expect(
      admin.query(
        "insert into cuota_fija (barrio_id, version_id, unidad_funcional_id, importe) select barrio_id, id, $2, 100 from cuota_fija_version where barrio_id = $1",
        [barrio(), uf1],
      ),
    ).rejects.toThrow(/no lleva importes por unidad/);
  });

  it("un aumento por porcentaje sobre un total ajusta el total", async () => {
    await devengado({ "devengado.origen": "administracion", "devengado.reparto": "coeficiente" });
    await cuota("1000.00");
    await como(adminB(), (tx) =>
      definirCuotaFija(tx, { barrioId: barrio(), rigeDesde: "2025-02", descripcion: "Acta 2", forma: "porcentaje", porcentaje: "10", redondeo: "centavo" } as never),
    );
    const vigente = await como(adminB(), (tx) => cuotaFijaVigente(tx, barrio()));
    expect(vigente.totalDelMes).toBe("1100.00");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("la bonificación por pago en término que se aplica sola", () => {
  /**
   * Enero (venció) se emite con las tres al día. La 1 y la 3 pagan; la 2 no. Febrero se emite: la 2
   * debe enero vencido y no la recibe. Después la 2 paga enero. Marzo se emite con febrero todavía sin
   * vencer: nadie tiene deuda VENCIDA y las tres la reciben.
   */
  async function hastaFebrero(): Promise<{ enero: string; febrero: string }> {
    await mora(false);
    await devengado(BONIFICA_SOLA);
    await conceptoDeBonificacion();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await emitir(enero);
    await pagar(uf1, "900.00", "2025-01-05");
    await pagar(uf3, "360.00", "2025-01-09");
    // Febrero vence dentro de 20 días: emitido, pero todavía no vencido.
    const febrero = await crearPeriodo("2025-02", await fechaRelativa(20));
    return { enero, febrero };
  }

  it("el primer mes las tres están al día: 10 % de la expensa común, firmado por quien emite", async () => {
    const { enero } = await hastaFebrero();
    const l = await liquidacionesDe(enero);
    expect([l.uf1.descuentos, l.uf2.descuentos, l.uf3.descuentos]).toEqual(["-100.00", "-60.00", "-40.00"]);
    expect([l.uf1.total, l.uf2.total, l.uf3.total]).toEqual(["900.00", "540.00", "360.00"]);
    expect([l.uf1.no_aplicada, l.uf2.no_aplicada, l.uf3.no_aplicada]).toEqual([null, null, null]);
    const { rows } = await admin.query(
      `select origen_evaluacion, aplicado_por, base_calculada::text as base, importe_resuelto::text as importe, detalle, fecha_hecho::text as fecha
         from concepto_boleta_unidad where periodo_id = $1 and unidad_funcional_id = $2`,
      [enero, uf2],
    );
    expect(rows).toEqual([
      { origen_evaluacion: "regla_barrio", aplicado_por: adminB(), base: "600.00", importe: "60.00", detalle: expect.stringMatching(/^Al día al \d{2}\/\d{2}\/\d{4}$/), fecha: "2025-01-01" },
    ]);
    // Lo que se usó quedó en el período.
    const { rows: p } = await admin.query(
      "select cupon_cobra, bonificacion_modo, bonificacion_forma, bonificacion_valor::text as valor, bonificacion_tope::text as tope from periodo_expensa where id = $1",
      [enero],
    );
    expect(p[0]).toEqual({ cupon_cobra: "solo_mes", bonificacion_modo: "sola", bonificacion_forma: "porcentaje", valor: "10.000000", tope: "500.00" });
  });

  it("quien pagó ANTES de emitir la recibe; quien debe un mes vencido no, y la boleta dice cuánto no recibió", async () => {
    const { febrero } = await hastaFebrero();
    const vista = await como(adminB(), (tx) => boletasDelMes(tx, { periodoId: febrero }));
    if (vista.estado !== "vista_previa") throw new Error(`la vista previa salió ${vista.estado}`);
    const de = (u: string) => vista.boletas.find((b) => b.unidadFuncionalId === u)!;
    expect([de(uf1).bonificada, de(uf2).bonificada, de(uf3).bonificada]).toEqual([true, false, true]);
    expect(de(uf2).bonificacionNoAplicada).toBe("60.00");
    expect(vista.totales).toMatchObject({ bonificadas: 2, sinBonificacion: 1, conDeuda: 1, deudaAnterior: "540.00" });
    expect(vista.devengado).toEqual({ cuponCobra: "solo_mes", bonificacionModo: "sola" });
    // La vista previa no dejó nada escrito.
    const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from concepto_boleta_unidad where periodo_id = $1", [febrero]);
    expect(rows[0]!.n).toBe(0);

    await emitir(febrero);
    const l = await liquidacionesDe(febrero);
    expect([l.uf1.descuentos, l.uf2.descuentos, l.uf3.descuentos]).toEqual(["-100.00", "0.00", "-40.00"]);
    expect(l.uf2.no_aplicada).toBe("60.00");

    const quien = await como(adminB(), (tx) => bonificacionDelMes(tx, { periodoId: febrero }));
    expect(quien.resumen).toMatchObject({ alDia: 2, reciben: 2, noReciben: 1, excepciones: 0, total: "140.00" });
    expect(quien.unidades.find((u) => u.unidadFuncionalId === uf2)).toMatchObject({ alDia: false, recibe: false, mesesAdeudados: ["2025-01"], importe: "60.00" });

    // La boleta: la banda de la bonificación que no recibió.
    const vistas = await como(adminB(), (tx) => armarVistasDelPeriodo(tx, febrero, { registro }));
    const v2 = vistas[1]!;
    expect(v2.bandas.map((b) => b.clave)).toContain("bonificacion_no_aplicada");
    expect(v2.bandas.find((b) => b.clave === "bonificacion_no_aplicada")!.texto).toBe(
      "Este mes no se aplicó la bonificación por pago en término de $ 60,00.",
    );
    expect(vistas[0]!.bandas.map((b) => b.clave)).toContain("bonificacion_aplicada");
  });

  it("quien pagó DESPUÉS de emitir no la gana en ese mes; y con deuda que todavía NO venció, sí está al día", async () => {
    const { febrero } = await hastaFebrero();
    await emitir(febrero);
    // La 2 paga enero después de emitido febrero: febrero ya está emitido y no cambia.
    await pagar(uf2, "540.00", await fechaRelativa(0));
    const l = await liquidacionesDe(febrero);
    expect([l.uf2.descuentos, l.uf2.no_aplicada]).toEqual(["0.00", "60.00"]);

    // Marzo: las tres deben febrero, que todavía no venció. Eso no es deuda vencida: están al día.
    const marzo = await crearPeriodo("2025-03", await fechaRelativa(50));
    const quien = await como(adminB(), (tx) => bonificacionDelMes(tx, { periodoId: marzo }));
    expect(quien.unidades.map((u) => [u.alDia, u.recibe])).toEqual([[true, true], [true, true], [true, true]]);
    await emitir(marzo);
    const m = await liquidacionesDe(marzo);
    expect([m.uf1.descuentos, m.uf2.descuentos, m.uf3.descuentos]).toEqual(["-100.00", "-60.00", "-40.00"]);
  });

  it("orden fijo en la boleta: la expensa, la bonificación, y después el resto", async () => {
    const { febrero } = await hastaFebrero();
    // Un cargo cuyo nombre va antes en el abecedario: igual sale después de la bonificación.
    const { conceptoId: quincho } = await como(adminB(), (tx) =>
      crearConceptoBoleta(tx, {
        barrioId: barrio(), nombre: "Alquiler de quincho", clase: "cargo", metodo: "monto_fijo", baseCalculo: "sin_base",
        clasificacionFiscal: "sin_clasificar", financiamiento: null, requiereAdmin: false, ordenImpresion: 0,
        vigenteDesde: "2025-01-01", montoFijo: "50.00", porcentaje: null, precioUnitario: null, tope: null,
      }),
    );
    await como(adminB(), (tx) =>
      aplicarConceptoAUnidad(tx, {
        periodoId: febrero, unidadFuncionalId: uf1, conceptoBoletaId: quincho, fechaHecho: "2025-02-08", cantidad: null,
        detalle: "sábado 08/02", origenEvaluacion: "carga_manual", confirmarMontoInusual: true,
      } as never),
    );
    await emitir(febrero);
    const vistas = await como(adminB(), (tx) => armarVistasDelPeriodo(tx, febrero, { registro }));
    expect(vistas[0]!.composicion.map((r) => r.etiqueta)).toEqual([
      "Expensa ordinaria 02/2025",
      "Bonificación por pago en término",
      "Alquiler de quincho",
    ]);
    // La bonificación se calcula sobre la expensa común, no sobre el cargo.
    const l = await liquidacionesDe(febrero);
    expect([l.uf1.ordinarias, l.uf1.descuentos, l.uf1.cargos, l.uf1.total]).toEqual(["1000.00", "-100.00", "50.00", "950.00"]);
  });

  it("excepciones con motivo: «Dársela igual» y «Quitar», quedan en el historial de la unidad y se congelan al emitir", async () => {
    const { febrero } = await hastaFebrero();
    await como(adminB(), (tx) =>
      ponerExcepcionDeBonificacion(tx, { periodoId: febrero, unidadFuncionalId: uf2, tipo: "dar", motivo: "Pagó el 09/01; el banco lo acreditó el 12/01" }),
    );
    await como(adminB(), (tx) =>
      ponerExcepcionDeBonificacion(tx, { periodoId: febrero, unidadFuncionalId: uf1, tipo: "quitar", motivo: "Convenio de pago incumplido" }),
    );
    // Sin motivo no se carga.
    await expect(
      como(adminB(), (tx) => ponerExcepcionDeBonificacion(tx, { periodoId: febrero, unidadFuncionalId: uf3, tipo: "quitar", motivo: " " })),
    ).rejects.toThrow(/motivo/i);

    const antes = await como(adminB(), (tx) => bonificacionDelMes(tx, { periodoId: febrero }));
    expect(antes.puedeExceptuar).toBe(true);
    expect(antes.unidades.map((u) => [u.alDia, u.excepcion?.tipo ?? null, u.recibe])).toEqual([
      [true, "quitar", false],
      [false, "dar", true],
      [true, null, true],
    ]);
    expect(antes.unidades[1]!.excepcion).toMatchObject({ motivo: "Pagó el 09/01; el banco lo acreditó el 12/01" });

    // Sacar una y volver a ponerla también queda registrado.
    await como(adminB(), (tx) => sacarExcepcionDeBonificacion(tx, { periodoId: febrero, unidadFuncionalId: uf1, motivo: "Se cargó por error" }));
    await como(adminB(), (tx) =>
      ponerExcepcionDeBonificacion(tx, { periodoId: febrero, unidadFuncionalId: uf1, tipo: "quitar", motivo: "Convenio de pago incumplido" }),
    );
    const { rows: historial } = await admin.query<{ unidad: string; detalle: string; rol: string }>(
      "select unidad_funcional_id as unidad, detalle, rol from padron_evento where barrio_id = $1 and tipo = 'excepcion_bonificacion' order by created_at",
      [barrio()],
    );
    expect(historial.map((h) => h.unidad)).toEqual([uf2, uf1, uf1, uf1]);
    expect(historial[0]).toMatchObject({ rol: "admin_barrio", detalle: expect.stringContaining("se le da igual. Motivo: Pagó el 09/01") });
    expect(historial[2]!.detalle).toContain("se saca la excepción");

    await emitir(febrero);
    const l = await liquidacionesDe(febrero);
    expect([l.uf1.descuentos, l.uf2.descuentos, l.uf3.descuentos]).toEqual(["0.00", "-60.00", "-40.00"]);
    expect([l.uf1.no_aplicada, l.uf2.no_aplicada]).toEqual(["100.00", null]);
    const { rows: detalle } = await admin.query<{ detalle: string }>(
      "select detalle from concepto_boleta_unidad where periodo_id = $1 and unidad_funcional_id = $2 and anulado_at is null",
      [febrero, uf2],
    );
    // En la boleta va que la otorgó la administración, no el texto libre del motivo.
    expect(detalle[0]!.detalle).toBe("Otorgada por la administración");

    // Emitido: no se cargan ni se sacan, ni por el servicio ni por la base.
    const e = await capturar(() =>
      como(adminB(), (tx) => ponerExcepcionDeBonificacion(tx, { periodoId: febrero, unidadFuncionalId: uf3, tipo: "quitar", motivo: "Tarde, ya emitido" })),
    );
    expect(e.codigo).toBe("periodo_no_editable");
    await expect(admin.query("delete from bonificacion_excepcion where periodo_id = $1", [febrero])).rejects.toThrow(/no se edita/);
    await expect(admin.query("update bonificacion_excepcion set motivo = 'otro motivo' where periodo_id = $1", [febrero])).rejects.toThrow(/no se edita/);
    const despues = await como(adminB(), (tx) => bonificacionDelMes(tx, { periodoId: febrero }));
    expect(despues.puedeExceptuar).toBe(false);
    expect(despues.unidades.map((u) => [u.alDia, u.excepcion?.tipo ?? null, u.recibe, u.importe])).toEqual([
      [true, "quitar", false, "100.00"],
      [false, "dar", true, "60.00"],
      [true, null, true, "40.00"],
    ]);
  });

  it("las excepciones las decide la administración: operador, contador y auditor no", async () => {
    const { febrero } = await hastaFebrero();
    for (const u of [arbol.usuarios.operadorA1, arbol.usuarios.contadorA1, arbol.usuarios.auditorA1]) {
      const e = await capturar(() =>
        como(u, (tx) => ponerExcepcionDeBonificacion(tx, { periodoId: febrero, unidadFuncionalId: uf2, tipo: "dar", motivo: "Sin permiso para esto" })),
      );
      expect(e.codigo).toBe("sin_permiso");
      // Tampoco por SQL directo: la policy de la tabla.
      await expect(
        como(u, (tx) =>
          tx.execute(sql`
            insert into bonificacion_excepcion (barrio_id, periodo_id, unidad_funcional_id, tipo, motivo)
            values (${barrio()}, ${febrero}, ${uf2}, 'dar', 'Un motivo cualquiera')
          `),
        ),
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("emite quien hoy puede emitir: el operador, con sus topes; si la bonificación los supera, se le dice", async () => {
    const { febrero } = await hastaFebrero();
    // Sin límite cargado, un operador no aplica descuentos (falla cerrado): la emisión se lo dice.
    const sinLimite = await capturar(() => emitir(febrero, arbol.usuarios.operadorA1));
    expect(sinLimite.codigo).toBe("tope_operador");
    expect(sinLimite.message).toMatch(/supera lo que un operador puede descontar/);
    // Con un límite que alcanza (el tope del 10 % es $ 500), emite, y firma él.
    await admin.query(
      "insert into limite_aplicacion_barrio (barrio_id, monto_max_operador, porcentaje_max_operador, vigente_desde) values ($1, 600, 15, '2000-01-01')",
      [barrio()],
    );
    await emitir(febrero, arbol.usuarios.operadorA1);
    const { rows } = await admin.query<{ aplicado_por: string }>(
      "select distinct aplicado_por from concepto_boleta_unidad where periodo_id = $1 and origen_evaluacion = 'regla_barrio'",
      [febrero],
    );
    expect(rows).toEqual([{ aplicado_por: arbol.usuarios.operadorA1 }]);
  });

  it("una bonificación cargada a mano con el rótulo de la regla, en un mes que no bonifica solo, se anula al calcular", async () => {
    await mora(false);
    await devengado({ ...BONIFICA_SOLA, "bonificacion.modo": "a_mano" });
    await conceptoDeBonificacion();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    const { rows: concepto } = await admin.query<{ id: string }>("select id from concepto_boleta where barrio_id = $1", [barrio()]);
    await como(adminB(), (tx) =>
      tx.execute(sql`
        insert into concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id, fecha_hecho, detalle, origen_evaluacion)
        values (${enero}, ${uf1}, ${concepto[0]!.id}, '2025-01-01', 'a mano', 'regla_barrio')
      `),
    );
    // Al calcular, la que no corresponde se anula sola (el mes no bonifica solo).
    await emitir(enero);
    const { rows } = await admin.query<{ anulada: boolean; motivo: string }>(
      "select anulado_at is not null as anulada, motivo_anulacion as motivo from concepto_boleta_unidad where periodo_id = $1",
      [enero],
    );
    expect(rows).toEqual([{ anulada: true, motivo: "Este mes la bonificación no se aplica sola." }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("el cupón que cobra solo el mes", () => {
  /** Enero emitido, la 2 no paga; febrero emitido con interés al corte. Devuelve todo lo que mueve plata. */
  async function correr(cupon: "solo_mes" | "mes_mas_deuda") {
    await mora(true);
    await devengado({ "devengado.origen": "gastos", "devengado.reparto": "coeficiente", "cupon.cobra": cupon, "bonificacion.modo": "no" });
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await emitir(enero);
    await pagar(uf1, "1000.00", "2025-01-05");
    await pagar(uf3, "400.00", "2025-01-09");
    const febrero = await crearPeriodo("2025-02", await fechaRelativa(20));
    await emitir(febrero);
    const l = await liquidacionesDe(febrero);
    const { rows: intereses } = await admin.query(
      `select d.unidad_funcional_id as uf, d.origen, d.desde::text, d.hasta::text, d.base::text, d.monto::text
         from interes_devengado d where d.barrio_id = $1 order by d.unidad_funcional_id, d.desde`,
      [barrio()],
    );
    const { rows: saldos } = await admin.query(
      "select unidad_funcional_id as uf, saldo_actual::text as saldo from saldo_uf where barrio_id = $1 order by unidad_funcional_id",
      [barrio()],
    );
    const vistas = await como(adminB(), (tx) => armarVistasDelPeriodo(tx, febrero, { registro }));
    return { febrero, l, intereses: intereses.map(({ uf, ...r }) => ({ uf: uf === uf2 ? "uf2" : "otra", ...r })), saldos: saldos.map((s) => s.saldo), vistas };
  }

  async function limpiar(): Promise<void> {
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      for (const t of ["trabajo", "pago_imputacion_interes", "pago_imputacion", "interes_devengado", "saldo_uf", "pago", "item_liquidacion", "liquidacion", "gasto_periodo", "periodo_expensa"]) {
        await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
      }
      await c.query("commit");
    } finally {
      c.release();
    }
    await borrarParametrosDe(admin, [barrio()]);
  }

  it("importe_cupon en los dos modos; y la deuda y el interés al corte son los MISMOS con uno y con otro", async () => {
    const solo = await correr("solo_mes");
    await limpiar();
    const todo = await correr("mes_mas_deuda");

    // Lo que mueve plata es idéntico: saldo anterior, interés, total, lo exigible, los intereses y la cuenta corriente.
    for (const u of ["uf1", "uf2", "uf3"] as const) {
      const { cupon: _a, ...sinCuponSolo } = solo.l[u];
      const { cupon: _b, ...sinCuponTodo } = todo.l[u];
      expect({ ...sinCuponSolo, uf: u }).toEqual({ ...sinCuponTodo, uf: u });
    }
    expect(solo.intereses).toEqual(todo.intereses);
    expect(solo.saldos).toEqual(todo.saldos);

    // La 2 debe enero ($ 600) con interés: el total lo incluye en los dos modos; el cupón, no siempre.
    const dos = solo.l.uf2;
    expect(dos.saldo).toBe("600.00");
    expect(Number(dos.interes)).toBeGreaterThan(0);
    expect(dos.exigible).toBe("600.00");
    expect(solo.l.uf2.cupon).toBe("600.00"); // solo el mes: lo devengado en febrero
    expect(todo.l.uf2.cupon).toBe(todo.l.uf2.total); // el mes más la deuda: el total
    // Sin deuda, los dos modos dan lo mismo.
    expect([solo.l.uf1.cupon, todo.l.uf1.cupon]).toEqual(["1000.00", "1000.00"]);

    // La deuda anterior, mes por mes, con el interés pegado al mes que lo generó.
    expect(dos.deuda).toEqual([{ periodo: "2025-01", vencimiento: "2025-01-10", capital: "600.00", interes: dos.interes }]);
    expect(solo.l.uf1.deuda).toEqual([]);
  });

  it("la boleta con «solo el mes»: el cupón es el del mes, la deuda va aparte mes por mes y no suma", async () => {
    const { vistas, l } = await correr("solo_mes");
    const v = vistas[1]!; // la unidad 2
    expect(v.cupon).toMatchObject({ modo: "solo_mes", importe: { monto: "600.00" } });
    expect(v.bloquePago.importes.alVencimiento.monto).toBe("600.00");
    expect(v.totales.aPagar.monto).toBe(l.uf2.total); // la cifra de la liquidación no cambia
    expect(v.cupon!.deudaNoIncluida.monto).toBe((Number(l.uf2.total) - 600).toFixed(2));
    expect(v.deudaAnterior).toEqual([
      expect.objectContaining({ periodo: "2025-01", etiqueta: "Enero 2025", capital: expect.objectContaining({ monto: "600.00" }), interes: expect.objectContaining({ monto: l.uf2.interes }) }),
    ]);
    expect(v.bandas[0]).toMatchObject({ clave: "saldo_anterior", titulo: "Deuda de meses anteriores" });
    expect(v.bandas[0]!.texto).toMatch(/no están incluidos en este cupón/);
    expect(v.faltantes.join(" ")).not.toMatch(/desglose del saldo/);
    // La unidad al día: cupón = total, y la deuda anterior es una lista vacía (no «no se sabe»).
    expect(vistas[0]!.cupon).toMatchObject({ importe: { monto: "1000.00" }, deudaNoIncluida: { monto: "0.00" } });
    expect(vistas[0]!.deudaAnterior).toEqual([]);
  });

  it("con «el mes más la deuda» el cupón es el total, como siempre", async () => {
    const { vistas, l } = await correr("mes_mas_deuda");
    const v = vistas[1]!;
    expect(v.cupon).toMatchObject({ modo: "mes_mas_deuda", importe: { monto: l.uf2.total }, deudaNoIncluida: { monto: "0.00" } });
    expect(v.bloquePago.importes.alVencimiento.monto).toBe(v.totales.aPagar.monto);
    expect(v.bandas[0]).toMatchObject({ clave: "saldo_anterior", titulo: "Incluye períodos anteriores" });
  });

  it("la emisión verifica el cupón: un importe que no es el del modo no emite", async () => {
    await mora(false);
    await devengado({ "devengado.origen": "gastos", "devengado.reparto": "coeficiente", "cupon.cobra": "solo_mes", "bonificacion.modo": "no" });
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await como(adminB(), (tx) => generarLiquidaciones(tx, { periodoId: enero, origenSaldo: "calculado" }));
    await admin.query("update liquidacion set importe_cupon = importe_cupon + 1 where periodo_id = $1 and unidad_funcional_id = $2", [enero, uf1]);
    const e = await capturar(() => como(adminB(), (tx) => emitirPeriodo(tx, { periodoId: enero })));
    expect(e.message).toMatch(/no cuadra|cupones/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("el congelamiento al emitir (0080)", () => {
  it("cómo se devengó un mes emitido no se cambia: ni el cupón ni la bonificación", async () => {
    await mora(false);
    await devengado(BONIFICA_SOLA);
    await conceptoDeBonificacion();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    // Antes de emitir se puede (es un borrador).
    await admin.query("update periodo_expensa set cupon_cobra = 'mes_mas_deuda' where id = $1", [enero]);
    await emitir(enero);
    for (const cambio of [
      "cupon_cobra = 'mes_mas_deuda'",
      "bonificacion_modo = 'no'",
      "bonificacion_valor = 50",
      "bonificacion_tope = null",
      "cupon_cobra = null",
    ]) {
      await expect(admin.query(`update periodo_expensa set ${cambio} where id = $1`, [enero])).rejects.toThrow(/cómo se devengó un período emitida no se puede cambiar/);
    }
    // Y un cambio posterior en «Cómo se devenga» no lo alcanza: rige desde el mes siguiente.
    await como(adminB(), (tx) =>
      cambiarComoSeDevenga(tx, {
        barrioId: barrio(), rigeDesde: "2025-02", origen: "gastos", reparto: "coeficiente", cuponCobra: "mes_mas_deuda",
        bonificacionModo: "no", bonificacionForma: "", bonificacionValor: "", bonificacionTope: "", motivo: "La asamblea decidió no bonificar más",
      } as never),
    );
    const { rows } = await admin.query("select cupon_cobra, bonificacion_modo from periodo_expensa where id = $1", [enero]);
    expect(rows[0]).toEqual({ cupon_cobra: "solo_mes", bonificacion_modo: "sola" });
    const l = await liquidacionesDe(enero);
    expect(l.uf1.cupon).toBe("900.00");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("aislamiento y candados (panel security-engineer)", () => {
  async function mesQueBonificaSolo(): Promise<string> {
    await mora(false);
    await devengado(BONIFICA_SOLA);
    await conceptoDeBonificacion();
    return crearPeriodo("2025-01", "2025-01-10");
  }

  it("otra administración no ve ni cambia nada, y un propietario no lee las excepciones", async () => {
    const enero = await mesQueBonificaSolo();
    await como(adminB(), (tx) => ponerExcepcionDeBonificacion(tx, { periodoId: enero, unidadFuncionalId: uf1, tipo: "quitar", motivo: "Convenio de pago incumplido" }));
    const otra = arbol.usuarios.adminEstudioB;
    expect(await como(otra, (tx) => leerComoSeDevenga(tx, { barrioId: barrio() }))).toBeNull();
    const cambiar = await capturar(() =>
      como(otra, (tx) =>
        cambiarComoSeDevenga(tx, {
          barrioId: barrio(), rigeDesde: "2031-01", origen: "gastos", reparto: "coeficiente", cuponCobra: "mes_mas_deuda",
          bonificacionModo: "no", motivo: "Un motivo de otra administración",
        } as never),
      ),
    );
    expect(cambiar.codigo).toBe("sin_permiso");
    const exceptuar = await capturar(() =>
      como(otra, (tx) => ponerExcepcionDeBonificacion(tx, { periodoId: enero, unidadFuncionalId: uf2, tipo: "dar", motivo: "Desde otra administración" })),
    );
    expect(exceptuar.codigo).toBe("periodo_no_encontrado");
    const ver = await capturar(() => como(otra, (tx) => bonificacionDelMes(tx, { periodoId: enero })));
    expect(ver.codigo).toBe("periodo_no_encontrado");
    // Ni la otra administración ni un propietario leen la tabla (con sus motivos).
    for (const u of [otra, arbol.usuarios.propietarioA1]) {
      const { rows } = await como(u, (tx) => tx.execute(sql`select id from bonificacion_excepcion where periodo_id = ${enero}`));
      expect(rows).toHaveLength(0);
    }
    const { rows: propias } = await como(arbol.usuarios.contadorA1, (tx) => tx.execute(sql`select id from bonificacion_excepcion where periodo_id = ${enero}`));
    expect(propias).toHaveLength(1);
  });

  it("en un mes que bonifica solo, la bonificación no se carga a mano: ni por el servicio ni colándola en la base", async () => {
    const enero = await mesQueBonificaSolo();
    const { rows: concepto } = await admin.query<{ id: string }>("select id from concepto_boleta where barrio_id = $1", [barrio()]);
    const aMano = { periodoId: enero, unidadFuncionalId: uf1, conceptoBoletaId: concepto[0]!.id, fechaHecho: null, cantidad: null, detalle: "a mano", origenEvaluacion: "carga_manual", confirmarMontoInusual: false };
    const e = await capturar(() => como(adminB(), (tx) => aplicarConceptoAUnidad(tx, aMano as never)));
    expect(e.codigo).toBe("dato_invalido");
    expect(e.message).toMatch(/se aplica sola/);

    // Cargada por fuera del servicio (o de cuando el mes bonificaba a mano), en una unidad a la que la
    // administración se la quitó y en otra que sí la recibe: al calcular, la de a mano se anula con su
    // motivo y manda la regla.
    await como(adminB(), (tx) => ponerExcepcionDeBonificacion(tx, { periodoId: enero, unidadFuncionalId: uf1, tipo: "quitar", motivo: "Convenio de pago incumplido" }));
    for (const u of [uf1, uf2]) {
      await como(adminB(), (tx) =>
        tx.execute(sql`
          insert into concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id, fecha_hecho, detalle, origen_evaluacion)
          values (${enero}, ${u}, ${concepto[0]!.id}, '2025-01-01', 'a mano', 'carga_manual')
        `),
      );
    }
    await emitir(enero);
    const { rows } = await admin.query<{ uf: string; origen: string; anulada: boolean }>(
      `select unidad_funcional_id as uf, origen_evaluacion as origen, anulado_at is not null as anulada
         from concepto_boleta_unidad where periodo_id = $1 order by aplicado_at, origen_evaluacion`,
      [enero],
    );
    expect(rows.filter((r) => r.origen === "carga_manual").every((r) => r.anulada)).toBe(true);
    expect(rows.filter((r) => !r.anulada).map((r) => [r.uf, r.origen]).sort()).toEqual([[uf2, "regla_barrio"], [uf3, "regla_barrio"]].sort());
    const l = await liquidacionesDe(enero);
    expect([l.uf1.descuentos, l.uf2.descuentos, l.uf3.descuentos]).toEqual(["0.00", "-60.00", "-40.00"]);

  });

  it("el valor de la bonificación es el de «Cómo se devenga»: uno distinto en el catálogo no emite, y el catálogo no deja cargarlo", async () => {
    const enero = await mesQueBonificaSolo();
    const { rows: concepto } = await admin.query<{ id: string }>("select id from concepto_boleta where barrio_id = $1", [barrio()]);
    const porServicio = await capturar(() =>
      como(adminB(), (tx) =>
        registrarValorConcepto(tx, { conceptoBoletaId: concepto[0]!.id, vigenteDesde: "2025-01-01", montoFijo: null, porcentaje: "50", precioUnitario: null, tope: "500.00" } as never),
      ),
    );
    expect(porServicio.codigo).toBe("dato_invalido");
    expect(porServicio.message).toMatch(/Cómo se devenga/);
    // Cargado igual por fuera (50 % donde el barrio dijo 10 %): la emisión lo rechaza.
    await admin.query("update concepto_boleta_valor set porcentaje = 50 where barrio_id = $1", [barrio()]);
    const emision = await capturar(() => emitir(enero));
    expect(emision.message).toMatch(/cuyo valor no es el de cómo se devenga este mes/);
  });

  it("un cambio de «Cómo se devenga» no se anula, y el servicio de parámetros de mora no acepta sus claves", async () => {
    await como(adminB(), (tx) =>
      cambiarComoSeDevenga(tx, {
        barrioId: barrio(), rigeDesde: "2031-01", origen: "gastos", reparto: "coeficiente", cuponCobra: "solo_mes",
        bonificacionModo: "no", motivo: "Un cambio programado para más adelante",
      } as never),
    );
    const { rows } = await admin.query<{ id: string }>("select id from parametro_valor where nodo_id = $1 and clave = 'cupon.cobra'", [barrio()]);
    const anular = await capturar(() => como(adminB(), (tx) => anularParametroProgramado(tx, { filaId: rows[0]!.id, motivo: "Quiero sacar este cambio programado" })));
    expect(anular.codigo).toBe("parametro_no_anulable");
    await expect(
      como(adminB(), (tx) =>
        fijarParametro(tx, { nodoId: barrio(), clave: "cupon.cobra", valor: "solo_mes", rigeDesde: "2031-02-01", motivo: "Por la puerta de la mora no entra" } as never),
      ),
    ).rejects.toThrow(/Cómo se devenga/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("los casos de la revisión de código", () => {
  const guardar = (extra: Record<string, unknown>) =>
    como(adminB(), (tx) =>
      cambiarComoSeDevenga(tx, {
        barrioId: barrio(), rigeDesde: "2025-01", origen: "gastos", reparto: "coeficiente", cuponCobra: "solo_mes",
        bonificacionModo: "sola", bonificacionForma: "importe", bonificacionValor: "150,00", bonificacionTope: "",
        motivo: "Lo resolvió la comisión del barrio", ...extra,
      } as never),
    );

  it("bonificación de importe fijo, de punta a punta con el concepto que crea «Cómo se devenga»", async () => {
    await mora(false);
    await guardar({});
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await emitir(enero);
    const l = await liquidacionesDe(enero);
    expect([l.uf1.descuentos, l.uf2.descuentos, l.uf3.descuentos]).toEqual(["-150.00", "-150.00", "-150.00"]);
    expect([l.uf1.cupon, l.uf2.cupon, l.uf3.cupon]).toEqual(["850.00", "450.00", "250.00"]);
    const { rows } = await admin.query("select bonificacion_forma, bonificacion_valor::text as valor, bonificacion_tope from periodo_expensa where id = $1", [enero]);
    expect(rows[0]).toEqual({ bonificacion_forma: "importe", valor: "150.000000", bonificacion_tope: null });
    // En la boleta sale con su nombre de siempre, no con el nombre interno del concepto del catálogo.
    const vistas = await como(adminB(), (tx) => armarVistasDelPeriodo(tx, enero, { registro }));
    expect(vistas[0]!.composicion.map((r) => r.etiqueta)).toEqual(["Expensa ordinaria 01/2025", "Bonificación por pago en término"]);
    expect(vistas[0]!.composicion[1]!.aclaracion).toMatch(/^Al día al \d{2}\/\d{2}\/\d{4}$/);
  });

  it("un importe fijo mayor que la expensa de una unidad no emite, y dice cuál y cómo salir", async () => {
    await mora(false);
    await guardar({ bonificacionValor: "450,00" }); // la unidad 3 paga $ 400 de expensa
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    const e = await capturar(() => emitir(enero));
    expect(e.codigo).toBe("periodo_incompleto");
    expect(e.message).toBe("La bonificación de $ 450,00 es mayor que la expensa de una unidad (Mza 1 · Lote 3).");
    // Quitándosela a esa unidad, el mes emite.
    await como(adminB(), (tx) => ponerExcepcionDeBonificacion(tx, { periodoId: enero, unidadFuncionalId: uf3, tipo: "quitar", motivo: "El importe supera su expensa" }));
    await emitir(enero);
    const l = await liquidacionesDe(enero);
    expect([l.uf1.descuentos, l.uf2.descuentos, l.uf3.descuentos]).toEqual(["-450.00", "-450.00", "0.00"]);
    expect(l.uf3.no_aplicada).toBe("400.00"); // no más que su expensa
  });

  it("cambiar la forma desde un mes posterior no toca el mes anterior sin emitir, y se puede guardar otra cosa antes de un cambio programado", async () => {
    await mora(false);
    await guardar({ bonificacionForma: "porcentaje", bonificacionValor: "10", bonificacionTope: "500,00" });
    await guardar({ rigeDesde: "2025-03" }); // desde marzo, importe fijo de $ 150
    // Entre los dos, un cambio que no toca la bonificación: no lo frena el valor programado.
    expect((await guardar({ rigeDesde: "2025-02", bonificacionForma: "porcentaje", bonificacionValor: "10", bonificacionTope: "500,00", cuponCobra: "mes_mas_deuda" })).cambios).toBe(1);

    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await emitir(enero);
    const l = await liquidacionesDe(enero);
    expect([l.uf1.descuentos, l.uf2.descuentos, l.uf3.descuentos]).toEqual(["-100.00", "-60.00", "-40.00"]);
    const vistas = await como(adminB(), (tx) => armarVistasDelPeriodo(tx, enero, { registro }));
    expect(vistas[0]!.composicion[1]!.etiqueta).toBe("Bonificación por pago en término");
    // Marzo rige con el importe fijo, entero: forma, valor y tope se escriben juntos.
    const marzo = await como(adminB(), (tx) => comoSeDevengaEn(tx, { barrioId: barrio(), mes: "2025-03" }));
    expect(marzo.bonificacion.cuanto).toEqual({ forma: "importe", valor: "150.00", tope: null });
    const { rows } = await admin.query<{ clave: string }>(
      "select clave from parametro_valor where nodo_id = $1 and vigente_desde = '2025-03-01' and clave like 'bonificacion.%' order by clave",
      [barrio()],
    );
    expect(rows.map((r) => r.clave)).toEqual(["bonificacion.forma", "bonificacion.tope", "bonificacion.valor"]);
  });

  it("al volver a calcular un borrador, la bonificación sigue a lo que hay ahora: se anula la que sobra y se agrega la que falta", async () => {
    await mora(false);
    await devengado(BONIFICA_SOLA);
    await conceptoDeBonificacion();
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    await emitir(enero);
    await pagar(uf1, "900.00", "2025-01-05");
    await pagar(uf3, "360.00", "2025-01-09");
    const febrero = await crearPeriodo("2025-02", await fechaRelativa(20));
    const calcular = () => como(adminB(), (tx) => generarLiquidaciones(tx, { periodoId: febrero, origenSaldo: "calculado" }));
    const vivas = async () =>
      (
        await admin.query<{ uf: string }>(
          "select unidad_funcional_id as uf from concepto_boleta_unidad where periodo_id = $1 and anulado_at is null",
          [febrero],
        )
      ).rows.map((r) => r.uf).sort();

    await calcular();
    expect(await vivas()).toEqual([uf1, uf3].sort());
    // La 2 paga enero y a la 1 se la quitan: al recalcular, la 2 la gana y la de la 1 se anula.
    await pagar(uf2, "540.00", await fechaRelativa(0));
    await como(adminB(), (tx) => ponerExcepcionDeBonificacion(tx, { periodoId: febrero, unidadFuncionalId: uf1, tipo: "quitar", motivo: "Convenio de pago incumplido" }));
    await calcular();
    expect(await vivas()).toEqual([uf2, uf3].sort());
    const { rows } = await admin.query<{ motivo: string }>(
      "select motivo_anulacion as motivo from concepto_boleta_unidad where periodo_id = $1 and anulado_at is not null",
      [febrero],
    );
    expect(rows).toEqual([{ motivo: "La unidad ya no recibe la bonificación con lo que hay al calcular." }]);
    // Recalcular sin cambios no duplica ni anula nada.
    await calcular();
    expect(await vivas()).toEqual([uf2, uf3].sort());
    const l = await liquidacionesDe(febrero);
    expect([l.uf1.descuentos, l.uf2.descuentos, l.uf3.descuentos]).toEqual(["0.00", "-60.00", "-40.00"]);
  });

  it("una unidad con deuda de antes del sistema no está al día, y su primer cupón «solo el mes» incluye ese saldo", async () => {
    await mora(false);
    await devengado(BONIFICA_SOLA);
    await conceptoDeBonificacion();
    await admin.query("update unidad_funcional set saldo_inicial = 300 where id = $1", [uf3]);
    try {
      const enero = await crearPeriodo("2025-01", "2025-01-10");
      const quien = await como(adminB(), (tx) => bonificacionDelMes(tx, { periodoId: enero }));
      expect(quien.unidades[2]).toMatchObject({ alDia: false, conSaldoInicial: true, recibe: false });
      await emitir(enero);
      const l = await liquidacionesDe(enero);
      expect([l.uf3.descuentos, l.uf3.no_aplicada, l.uf3.saldo, l.uf3.total, l.uf3.cupon, l.uf3.deuda]).toEqual(["0.00", "40.00", "300.00", "700.00", "700.00", null]);
      // La boleta arma: el saldo traído de afuera va adentro del cupón, como sumando.
      const vistas = await como(adminB(), (tx) => armarVistasDelPeriodo(tx, enero, { registro }));
      expect(vistas[2]!.cupon).toMatchObject({ modo: "solo_mes", importe: { monto: "700.00" }, deudaNoIncluida: { monto: "0.00" } });
      expect(vistas[2]!.deudaAnterior).toBeNull();
    } finally {
      const c = await admin.connect();
      try {
        await c.query("begin");
        await c.query("set local session_replication_role = replica");
        await c.query("update unidad_funcional set saldo_inicial = 0 where id = $1", [uf3]);
        await c.query("commit");
      } finally {
        c.release();
      }
    }
  });

  it("«los gastos del mes» en partes iguales exige una versión de coeficientes iguales: no dice una cosa y hace otra", async () => {
    await mora(false);
    await devengado({ "devengado.origen": "gastos", "devengado.reparto": "igual", "cupon.cobra": "solo_mes", "bonificacion.modo": "no" });
    const enero = await crearPeriodo("2025-01", "2025-01-10");
    const e = await capturar(() => emitir(enero));
    expect(e.codigo).toBe("periodo_incompleto");
    expect(e.message).toMatch(/partes iguales/);
    // Con «por coeficiente» emite con los mismos coeficientes.
    await borrarParametrosDe(admin, [barrio()]);
    await mora(false);
    await devengado({ "devengado.origen": "gastos", "devengado.reparto": "coeficiente", "cupon.cobra": "solo_mes", "bonificacion.modo": "no" });
    await emitir(enero);
    const l = await liquidacionesDe(enero);
    expect([l.uf1.total, l.uf2.total, l.uf3.total]).toEqual(["1000.00", "600.00", "400.00"]);
  });
});
