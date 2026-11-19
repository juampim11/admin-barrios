/**
 * Encargo 17 (Etapa 1.4), contra Postgres real (`0085` a `0088`): activar un barrio que ya venía
 * funcionando, con su deuda mes por mes.
 *  - La planilla de deuda: vista previa con los errores por fila, entra entera o no entra, y deja
 *    períodos históricos emitidos (una liquidación por unidad, mes y vencimiento), la cuenta corriente
 *    debitada y el saldo a favor como cobro sin imputar.
 *  - Lo histórico no aparece en los lectores de «los meses del barrio».
 *  - Un barrio sin activar no emite; activa solo la administración, una vez, y queda firmado.
 *  - El interés de la deuda anterior, AL CENTAVO: de cada vencimiento a la activación con la tasa que
 *    se eligió al activar, y desde ahí con la normal.
 *  - La imputación por vencimiento: un histórico cargado después de un mes normal se cobra primero.
 *  - El primer cupón con «solo el mes» cobra solo el mes y lleva la deuda anterior mes por mes.
 *  - Resubir la planilla antes de emitir, y que después no se pueda.
 *  - Saldo inicial y deuda histórica, excluyentes. RLS y permisos por rol.
 *
 * Escenario: tres unidades con coeficientes 0,5 / 0,3 / 0,2. Las fechas son relativas a hoy (la base no
 * acepta un vencimiento futuro ni un interés a futuro): los importes no dependen del día en que corre.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { esErrorDeNegocio, type ErrorDeNegocio } from "@admin-barrios/shared/errores";
import { nuevoToken } from "@admin-barrios/almacenamiento";
import { registroPorDefecto } from "@admin-barrios/documentos/cobranza";
import { conUsuario, type DbRequest } from "../src/client.ts";
import {
  activarBarrio,
  cargarDeudaAnterior,
  declararSinDeudaAnterior,
  deudaMesPorMesDeUnidad,
  estadoDeLaActivacion,
  verificacionDeDeudaAnterior,
  vistaPreviaDeDeudaAnterior,
} from "../src/servicios/activacion.ts";
import { deudaALaFecha, registrarEImputarPago } from "../src/servicios/deuda.ts";
import { emitirMes } from "../src/servicios/circuito-del-mes.ts";
import { listarPeriodos } from "../src/servicios/periodos.ts";
import { leerBarrioDelPadron } from "../src/servicios/padron-edicion.ts";
import { armarVistasDelPeriodo } from "../src/servicios/vista-boleta.ts";
import { borrarArbol, borrarParametrosDe, cargarParametro, crearArbol, crearBarrio, dbDe, poolAdmin, poolApp, type Arbol } from "./helpers.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf1: string;
let uf2: string;
let uf3: string;
let expensaId: string;
/** Hoy en la hora del barrio y los meses del escenario (`YYYY-MM`): el primero a devengar y los anteriores. */
let hoy: string;
let mes0: string;
let mes1: string;
let mes3: string;

const registro = registroPorDefecto();
const barrio = () => arbol.barrioA1.id;
const como = <T>(usuario: string, fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, usuario, fn);
const adminB = () => arbol.usuarios.adminBarrioA1;
const operador = () => arbol.usuarios.operadorA1;

async function capturar(fn: () => Promise<unknown>): Promise<ErrorDeNegocio> {
  try {
    await fn();
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw new Error(`salió un error SIN traducir: ${String(e)}`);
    return e;
  }
  throw new Error("no falló, y tenía que fallar");
}

const fechaRelativa = async (dias: number) =>
  (await admin.query<{ f: string }>("select ((now() at time zone 'America/Argentina/Buenos_Aires')::date + $1::int)::text as f", [dias])).rows[0]!.f;
const mesRelativo = async (meses: number) =>
  (
    await admin.query<{ m: string }>(
      "select to_char(date_trunc('month', (now() at time zone 'America/Argentina/Buenos_Aires')::date) + make_interval(months => $1::int), 'YYYY-MM') as m",
      [meses],
    )
  ).rows[0]!.m;

/** Sin triggers, como dueño del esquema: para armar o desarmar un escenario, no para probar una regla. */
async function sinTriggers(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await fn(c);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

const ENCABEZADO = ["manzana", "lote", "mes", "concepto", "vencimiento", "importe"];

/**
 * La planilla del escenario:
 *   · 1-1: debe $ 1.000 de hace tres meses (venció hace 90 días) y $ 600 del mes pasado (hace 30).
 *   · 1-2: del mes pasado debe la expensa ($ 400,50, venció hace 30 días) y una extraordinaria ($ 250,
 *          venció hace 10): un mes con dos vencimientos.
 *   · 1-3: trae $ 180 a favor.
 */
async function planillaBase(): Promise<string[][]> {
  const [v90, v30, v10] = [await fechaRelativa(-90), await fechaRelativa(-30), await fechaRelativa(-10)];
  return [
    ENCABEZADO,
    ["1", "1", mes3, "Expensa", v90, "1000"],
    ["1", "1", mes1, "Expensa", v30, "600,00"],
    ["1", "2", mes1, "expensa", v30, "400,50"],
    ["1", "2", mes1, "Obra de cloacas", v10, "250"],
    ["1", "3", "", "", "", "-180"],
  ];
}

const cargar = (filas: string[][], usuario = adminB(), archivo = "deuda.xlsx") =>
  como(usuario, (tx) => cargarDeudaAnterior(tx, { barrioId: barrio(), archivo, filas }));
const previa = (filas: string[][], usuario = adminB()) =>
  como(usuario, (tx) => vistaPreviaDeDeudaAnterior(tx, { barrioId: barrio(), archivo: "deuda.xlsx", filas }));
const activar = (tasa = "3", motivo: string | null = null, usuario = adminB()) =>
  como(usuario, (tx) => activarBarrio(tx, { barrioId: barrio(), tasa, motivo }));

/** Deja la activación como si hubiera sido hace `dias` días: para ver correr la tasa normal después. */
const activacionHace = (dias: number) =>
  sinTriggers(async (c) => {
    await c.query("update barrio set activacion_fecha = (now() at time zone zona_horaria)::date - $2::int where barrio_id = $1", [barrio(), dias]);
  });

/** La mora del barrio: 3 % mensual, sin gracia ni tolerancia. Con `cobra: false`, los pagos van enteros a capital. */
async function mora(cobra: boolean): Promise<void> {
  for (const [clave, valor] of [
    ["interes.cobra", cobra], ["interes.tasa_compensatoria", "0.03"], ["interes.tasa_punitoria", "0"], ["interes.gracia_dias", 0],
    ["interes.forma_gracia", "corre_inicio"], ["interes.tolerancia", "0.00"], ["imputacion.orden", "intereses_primero_capital_antiguo"],
  ] as const) {
    await cargarParametro(admin, barrio(), clave, valor);
  }
}

/** El primer mes del sistema: $ 2.000 de gasto (por coeficiente: $ 1.000 / $ 600 / $ 400), vence en diez días. */
async function crearPrimerMes(): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, modelo, primer_vencimiento) values ($1, $2, 'variable', $3) returning id",
    [barrio(), mes0, await fechaRelativa(10)],
  );
  await admin.query(
    "insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '2000.00')",
    [barrio(), rows[0]!.id, expensaId],
  );
  return rows[0]!.id;
}

const emitir = (periodoId: string, usuario = adminB()) =>
  como(usuario, (tx) => emitirMes(tx, { periodoId, huellaVista: null, vistaCalculadaEl: null, confirmarCambios: false }));

const pagar = (unidad: string, monto: string, fecha: string) =>
  como(adminB(), (tx) =>
    registrarEImputarPago(tx, {
      pago: { unidadFuncionalId: unidad, obligadoId: null, monto, fecha, origen: "manual", comprobanteAdjunto: `barrios/${barrio()}/pagos/comprobantes/${nuevoToken()}.pdf` },
      confirmarPagoConInteres: true,
      noCobrarInteres: null,
    }),
  );

const saldos = async () =>
  Object.fromEntries(
    (await admin.query<{ uf: string; saldo: string }>("select unidad_funcional_id as uf, saldo_actual::text as saldo from saldo_uf where barrio_id = $1", [barrio()])).rows.map(
      (r) => [r.uf === uf1 ? "uf1" : r.uf === uf2 ? "uf2" : "uf3", r.saldo],
    ),
  );

const historicas = async () =>
  (
    await admin.query<{ uf: string; periodo: string; estado: string; vencimiento: string; total: string; exigible: string; comprobante: string | null; lineas: string }>(
      `select l.unidad_funcional_id as uf, pe.periodo, pe.estado::text as estado, l.vencimiento::text as vencimiento, l.total::text,
              l.importe_exigible::text as exigible, l.numero_comprobante as comprobante,
              (select string_agg(i.descripcion || ' ' || i.monto::text || ' ' || i.clase_item::text, ' | ' order by i.descripcion)
                 from item_liquidacion i where i.liquidacion_id = l.id) as lineas
         from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
        where pe.barrio_id = $1 and pe.origen = 'historico'
        order by l.unidad_funcional_id = $2 desc, l.unidad_funcional_id = $3 desc, l.vencimiento`,
      [barrio(), uf1, uf2],
    )
  ).rows.map(({ uf, ...r }) => ({ uf: uf === uf1 ? "uf1" : uf === uf2 ? "uf2" : "uf3", ...r }));

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, barrio(), { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  hoy = await fechaRelativa(0);
  [mes0, mes1, mes3] = [await mesRelativo(0), await mesRelativo(-1), await mesRelativo(-3)];
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
    `insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal)
     values ($1, 'Expensa', 'ordinaria', 'sin_clasificar'), ($1, 'Obra de cloacas', 'extraordinaria', 'sin_clasificar') returning id`,
    [barrio()],
  );
  expensaId = c[0]!.id;
  await dejarSinActivar();
});

/** El barrio del escenario arranca cada test sin activar, con el mes en curso como primero a devengar. */
async function dejarSinActivar(): Promise<void> {
  await sinTriggers(async (c) => {
    await c.query(
      `update barrio set activacion = 'sin_activar', activado_at = null, activado_por = null, activacion_fecha = null,
              deuda_anterior_estado = null, deuda_anterior_tasa = null, deuda_anterior_tasa_vigente = null,
              deuda_anterior_tasa_motivo = null, primer_periodo = $2, modelo_liquidacion = null, dia_vencimiento = null
        where barrio_id = $1`,
      [barrio(), mes0],
    );
    await c.query("update unidad_funcional set saldo_inicial = 0 where barrio_id = $1", [barrio()]);
  });
}

afterEach(async () => {
  await sinTriggers(async (c) => {
    for (const t of [
      "trabajo", "padron_evento", "bonificacion_excepcion", "interes_condonacion", "pago_imputacion_interes", "pago_imputacion",
      "interes_devengado", "saldo_uf", "pago", "concepto_boleta_unidad_evento", "concepto_boleta_unidad", "item_liquidacion", "liquidacion",
      "gasto_periodo", "periodo_expensa", "concepto_boleta_valor", "concepto_boleta", "limite_aplicacion_barrio",
    ]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
  });
  await dejarSinActivar();
  await borrarParametrosDe(admin, [barrio()]);
});

afterAll(async () => {
  await sinTriggers(async (c) => {
    for (const t of [
      "padron_evento", "concepto", "coeficiente", "coeficiente_version", "unidad_funcional", "codigo_pago_secuencia",
      "mandato_administracion", "documento_barrio", "barrio_atributo_vigencia", "barrio",
    ]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
  });
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("la planilla de deuda", () => {
  it("la vista previa no escribe nada y marca cada error en su fila", async () => {
    await admin.query("update unidad_funcional set saldo_inicial = 500 where id = $1", [uf3]);
    const v30 = await fechaRelativa(-30);
    const vista = await previa([
      ENCABEZADO,
      ["1", "1", mes1, "Expensa", v30, "600"],
      ["9", "9", mes1, "Expensa", v30, "100"], // 3: unidad fuera del padrón
      ["1", "2", mes1, "Cuota del club", v30, "100"], // 4: concepto desconocido
      ["1", "2", mes1, "Expensa", await fechaRelativa(5), "100"], // 5: vencimiento en el futuro
      ["1", "1", mes1, "EXPENSA", v30, "50"], // 6: renglón repetido (misma unidad, mes, concepto y vencimiento)
      ["1", "3", mes1, "Expensa", v30, "100"], // 7: la unidad tiene saldo inicial
      ["1", "2", mes0, "Expensa", v30, "100"], // 8: el mes no es anterior al primero a devengar
      ["1", "2", mes1, "Expensa", v30, "125.000"], // 9: importe que no se adivina
      ["1", "2", mes1, "Expensa", "2006-08-10", "100"], // 10: vencimiento anterior a su mes (un año mal tipeado)
    ]);
    expect(vista.errores.map((e) => e.fila)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(vista.errores.map((e) => e.mensaje)).toEqual([
      "La unidad Mza 9 · Lote 9 no está en el padrón del barrio (o está dada de baja).",
      "El concepto «Cuota del club» no está en los conceptos del barrio: cargalo en Configuración antes de subir la planilla.",
      "El vencimiento es posterior a hoy: lo que todavía no venció no es deuda anterior.",
      "Renglón repetido: es la misma unidad, mes, concepto y vencimiento que la fila 2.",
      "La unidad Mza 1 · Lote 3 tiene un saldo inicial cargado: la deuda entra mes por mes o como saldo, no de las dos formas. Poné el saldo inicial en cero.",
      `El mes ${mes0.slice(5)}/${mes0.slice(0, 4)} no es anterior al primer mes que va a devengar el sistema: la deuda anterior es de meses previos.`,
      "El importe «125.000» no se entiende: escribilo sin punto de miles (125000 o 125000,50).",
      "El vencimiento es anterior al mes de la deuda: revisá la fecha (dd/mm/aaaa).",
    ]);
    expect(vista).toMatchObject({ deudas: 1, totalDeuda: "600.00", saldosAFavor: 0, unidadesConDeuda: 1, reemplaza: false });

    // Con un solo error no entra ningún renglón.
    const e = await capturar(() =>
      cargar([ENCABEZADO, ["1", "1", mes1, "Expensa", v30, "600"], ["9", "9", mes1, "Expensa", v30, "100"]]),
    );
    expect(e.codigo).toBe("dato_invalido");
    expect(e.message).toBe("La planilla tiene un renglón con error: no se cargó nada.");
    const { rows } = await admin.query("select 1 from periodo_expensa where barrio_id = $1", [barrio()]);
    expect(rows).toEqual([]);
    expect((await como(adminB(), (tx) => estadoDeLaActivacion(tx, { barrioId: barrio() })))?.deudaAnterior).toBeNull();
  });

  it("entra entera: períodos históricos emitidos, una liquidación por unidad, mes y vencimiento, y la cuenta debitada", async () => {
    const vista = await previa(await planillaBase());
    expect(vista.errores).toEqual([]);
    expect(vista).toMatchObject({ deudas: 4, totalDeuda: "2250.50", saldosAFavor: 1, totalAFavor: "180.00", unidadesConDeuda: 2 });
    expect(vista.renglones.map((r) => `${r.unidad} ${r.tipo} ${r.concepto ?? "-"} ${r.importe}`)).toEqual([
      "Mza 1 · Lote 1 deuda Expensa 1000.00",
      "Mza 1 · Lote 1 deuda Expensa 600.00",
      "Mza 1 · Lote 2 deuda Expensa 400.50",
      "Mza 1 · Lote 2 deuda Obra de cloacas 250.00",
      "Mza 1 · Lote 3 a_favor - 180.00",
    ]);

    const r = await cargar(await planillaBase());
    expect(r).toEqual({ deudas: 4, unidades: 2, total: "2250.50", saldosAFavor: 1, totalAFavor: "180.00", reemplaza: false });

    const [v90, v30, v10] = [await fechaRelativa(-90), await fechaRelativa(-30), await fechaRelativa(-10)];
    expect(await historicas()).toEqual([
      { uf: "uf1", periodo: mes3, estado: "emitida", vencimiento: v90, total: "1000.00", exigible: "1000.00", comprobante: null, lineas: "Expensa 1000.00 historico" },
      { uf: "uf1", periodo: mes1, estado: "emitida", vencimiento: v30, total: "600.00", exigible: "600.00", comprobante: null, lineas: "Expensa 600.00 historico" },
      // Un mes con dos vencimientos: dos liquidaciones de la misma unidad en el mismo período.
      { uf: "uf2", periodo: mes1, estado: "emitida", vencimiento: v30, total: "400.50", exigible: "400.50", comprobante: null, lineas: "Expensa 400.50 historico" },
      { uf: "uf2", periodo: mes1, estado: "emitida", vencimiento: v10, total: "250.00", exigible: "250.00", comprobante: null, lineas: "Obra de cloacas 250.00 historico" },
    ]);
    // Dos períodos históricos (uno por mes), no cuatro.
    const { rows: periodos } = await admin.query<{ periodo: string; origen: string }>(
      "select periodo, origen from periodo_expensa where barrio_id = $1 order by periodo",
      [barrio()],
    );
    expect(periodos).toEqual([{ periodo: mes3, origen: "historico" }, { periodo: mes1, origen: "historico" }]);
    // La cuenta corriente debita lo histórico; el saldo a favor no la mueve hasta que se imputa.
    expect(await saldos()).toEqual({ uf1: "1600.00", uf2: "650.50" });

    // El saldo a favor: un cobro sin imputar de origen `activacion`, firmado por quien subió la planilla.
    const { rows: pagos } = await admin.query(
      `select p.unidad_funcional_id = $2 as de_la_3, p.monto::text, p.fecha::text, p.origen, p.estado_conciliacion, p.usuario_registrador,
              p.comprobante_adjunto, (select count(*)::int from pago_imputacion pi where pi.pago_id = p.id) as imputaciones
         from pago p where p.barrio_id = $1`,
      [barrio(), uf3],
    );
    expect(pagos).toEqual([
      { de_la_3: true, monto: "180.00", fecha: hoy, origen: "activacion", estado_conciliacion: "conciliado", usuario_registrador: adminB(), comprobante_adjunto: null, imputaciones: 0 },
    ]);

    // Queda en el historial del barrio, con el archivo y quién.
    const { rows: eventos } = await admin.query("select tipo, detalle, archivo, rol, creado_por from padron_evento where barrio_id = $1", [barrio()]);
    expect(eventos).toEqual([
      {
        tipo: "configuracion_barrio",
        detalle: "Deuda anterior a la activación: se cargan 4 deudas de 2 unidades por $ 2250.50 y 1 saldo a favor por $ 180.00.",
        archivo: "deuda.xlsx",
        rol: "admin_barrio",
        creado_por: adminB(),
      },
    ]);
    expect(await como(adminB(), (tx) => estadoDeLaActivacion(tx, { barrioId: barrio() }))).toMatchObject({
      activacion: "sin_activar", deudaAnterior: "cargada", deudas: 4, unidadesConDeuda: 2, totalDeuda: "2250.50", saldosAFavor: 1, totalAFavor: "180.00",
      unidades: 3, conceptos: 2, primerPeriodo: mes0, puedeActivar: true, yaEmitio: false, conCobros: false,
    });
  });

  it("«El barrio no trae deuda» lo deja dicho, sin ningún período", async () => {
    const r = await como(adminB(), (tx) => declararSinDeudaAnterior(tx, { barrioId: barrio() }));
    expect(r).toMatchObject({ deudas: 0, saldosAFavor: 0, total: "0.00" });
    expect((await como(adminB(), (tx) => estadoDeLaActivacion(tx, { barrioId: barrio() })))?.deudaAnterior).toBe("sin_deuda");
    expect((await admin.query("select 1 from periodo_expensa where barrio_id = $1", [barrio()])).rows).toEqual([]);
    const { rows } = await admin.query<{ detalle: string }>("select detalle from padron_evento where barrio_id = $1", [barrio()]);
    expect(rows).toEqual([{ detalle: "Deuda anterior a la activación: el barrio no trae deuda." }]);
  });

  it("lo histórico no aparece en los lectores de los meses del barrio", async () => {
    await cargar(await planillaBase());
    expect(await como(adminB(), (tx) => listarPeriodos(tx, { barrioId: barrio() }))).toEqual([]);
    // El próximo mes a liquidar es el primero a devengar, no «el siguiente al último emitido».
    expect((await como(adminB(), (tx) => leerBarrioDelPadron(tx, { barrioId: barrio() })))?.proximoPeriodo).toBe(mes0);
    // Tampoco después de emitir el primer mes: la lista trae ese mes y nada más.
    await mora(false);
    await activar("0");
    const primero = await crearPrimerMes();
    await emitir(primero);
    expect((await como(adminB(), (tx) => listarPeriodos(tx, { barrioId: barrio() }))).map((p) => p.periodo)).toEqual([mes0]);
  });

  it("saldo inicial y deuda histórica son excluyentes, en los dos sentidos", async () => {
    await cargar(await planillaBase());
    // Con deuda histórica cargada, el saldo inicial ya no se toca.
    await expect(
      como(adminB(), (tx) => tx.execute(sql`update unidad_funcional set saldo_inicial = 100 where id = ${uf1}`)),
    ).rejects.toThrow(/el saldo inicial de la unidad ya se usó/);
    // Y una unidad con saldo inicial no entra por la función, aunque se la llame sin pasar por el servicio.
    await admin.query("update unidad_funcional set saldo_inicial = 500 where id = $1", [uf3]);
    await expect(
      como(adminB(), (tx) =>
        tx.execute(sql`
          select app.cargar_deuda_historica(${barrio()}::uuid,
            ${JSON.stringify([{ unidad: uf3, periodo: mes1, vencimiento: hoy, concepto: expensaId, importe: "10.00" }])}::jsonb, '[]'::jsonb, 'x')
        `),
      ),
    ).rejects.toThrow(/que ya tienen saldo inicial/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("activar el barrio", () => {
  it("un barrio sin activar no emite; activado, sí", async () => {
    await mora(false);
    await como(adminB(), (tx) => declararSinDeudaAnterior(tx, { barrioId: barrio() }));
    const primero = await crearPrimerMes();
    const e = await capturar(() => emitir(primero));
    expect(e.codigo).toBe("periodo_incompleto");
    expect(e.message).toBe("El barrio todavía no está activado: no se puede emitir.");
    expect((await admin.query<{ estado: string }>("select estado::text as estado from periodo_expensa where id = $1", [primero])).rows[0]!.estado).not.toBe("emitida");

    await activar("0");
    await emitir(primero);
    expect((await admin.query<{ estado: string }>("select estado::text as estado from periodo_expensa where id = $1", [primero])).rows[0]!.estado).toBe("emitida");
  });

  it("activa solo la administración, con la deuda anterior resuelta, y queda firmado y en el historial", async () => {
    await mora(true);
    // Sin resolver la deuda anterior no se activa.
    const sinDeuda = await capturar(() => activar());
    expect(sinDeuda.message).toBe("Falta resolver la deuda anterior del barrio.");

    await cargar(await planillaBase());
    // Un operador no carga la deuda ni activa: ni por el servicio ni yendo directo a la tabla.
    expect((await capturar(() => activar("3", null, operador()))).codigo).toBe("sin_permiso");
    await expect(
      como(operador(), (tx) => tx.execute(sql`update barrio set activacion = 'activo', deuda_anterior_tasa = 0.03 where barrio_id = ${barrio()}`)),
    ).rejects.toThrow(/el barrio lo activa su administración/);

    // Otra tasa que la vigente pide un motivo.
    const sinMotivo = await capturar(() => activar("6"));
    expect(sinMotivo.message).toBe("Elegiste para la deuda anterior una tasa distinta de la vigente del barrio: falta el motivo.");

    const r = await activar("6", "El reglamento anterior fijaba el 6 % mensual");
    expect(r).toEqual({ activadoEl: hoy, primerPeriodo: mes0, tasa: "0.060000", tasaVigente: "0.030000" });
    const { rows } = await admin.query(
      `select activacion, activado_por, activacion_fecha::text as fecha, activado_at is not null as con_hora,
              deuda_anterior_tasa::text as tasa, deuda_anterior_tasa_vigente::text as vigente, deuda_anterior_tasa_motivo as motivo
         from barrio where barrio_id = $1`,
      [barrio()],
    );
    expect(rows).toEqual([
      { activacion: "activo", activado_por: adminB(), fecha: hoy, con_hora: true, tasa: "0.060000", vigente: "0.030000", motivo: "El reglamento anterior fijaba el 6 % mensual" },
    ]);
    const { rows: eventos } = await admin.query<{ detalle: string; rol: string; creado_por: string }>(
      "select detalle, rol, creado_por from padron_evento where barrio_id = $1 and datos ? 'activacion'",
      [barrio()],
    );
    expect(eventos).toEqual([
      {
        detalle: `Se activa el barrio. Primer mes a devengar: ${mes0}. Tasa mensual para la deuda anterior: 6.0000 % (la vigente era 3.0000 %).`,
        rol: "admin_barrio",
        creado_por: adminB(),
      },
    ]);

    // Una sola vez: ni se vuelve a activar, ni se desactiva, ni se le cambia la tasa o la firma.
    expect((await capturar(() => activar())).message).toBe("El barrio ya está activado.");
    for (const cambio of [
      sql`update barrio set activacion = 'sin_activar' where barrio_id = ${barrio()}`,
      sql`update barrio set deuda_anterior_tasa = 0.01 where barrio_id = ${barrio()}`,
      sql`update barrio set deuda_anterior_tasa_motivo = 'Otro motivo, escrito después' where barrio_id = ${barrio()}`,
    ]) {
      await expect(como(adminB(), (tx) => tx.execute(cambio))).rejects.toThrow(/el barrio ya está activado/);
    }
    // La firma y la tasa vigente ni siquiera se le conceden a un pedido de la aplicación: las escribe la base.
    for (const cambio of [
      sql`update barrio set activado_por = ${operador()}::uuid where barrio_id = ${barrio()}`,
      sql`update barrio set activacion_fecha = '2020-01-01' where barrio_id = ${barrio()}`,
      sql`update barrio set activado_at = now() where barrio_id = ${barrio()}`,
      sql`update barrio set deuda_anterior_tasa_vigente = 0.5 where barrio_id = ${barrio()}`,
    ]) {
      await expect(como(adminB(), (tx) => tx.execute(cambio))).rejects.toThrow(/permission denied for table barrio/);
    }
  });

  it("con la tasa vigente no hace falta motivo, y la tasa vigente la calcula la base", async () => {
    await mora(true);
    await como(adminB(), (tx) => declararSinDeudaAnterior(tx, { barrioId: barrio() }));
    // Yendo directo a la tabla, sin el servicio: la firma, la fecha y la tasa vigente las pone la base,
    // y un motivo que no hace falta no se guarda.
    await como(adminB(), (tx) =>
      tx.execute(sql`
        update barrio set activacion = 'activo', deuda_anterior_tasa = 0.03, deuda_anterior_tasa_motivo = 'No hace falta'
         where barrio_id = ${barrio()}
      `),
    );
    const { rows } = await admin.query(
      "select activado_por, activacion_fecha::text as fecha, deuda_anterior_tasa_vigente::text as vigente, deuda_anterior_tasa_motivo as motivo from barrio where barrio_id = $1",
      [barrio()],
    );
    expect(rows).toEqual([{ activado_por: adminB(), fecha: hoy, vigente: "0.030000", motivo: null }]);
  });

  it("un barrio que no cobra interés propone tasa cero", async () => {
    await mora(false);
    await como(adminB(), (tx) => declararSinDeudaAnterior(tx, { barrioId: barrio() }));
    expect((await como(adminB(), (tx) => estadoDeLaActivacion(tx, { barrioId: barrio() })))?.tasaVigente).toBe("0.000000");
    expect(await activar("0")).toMatchObject({ tasa: "0.000000", tasaVigente: "0.000000" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("el interés de la deuda anterior, al centavo", () => {
  it("antes de activar: de cada vencimiento a hoy con la tasa que se está por elegir", async () => {
    await mora(true);
    await cargar(await planillaBase());
    // Al 6 % mensual: 1.000 × 6 % × 90/30 = 180; 600 × 6 % × 30/30 = 36; 400,50 × 6 % × 30/30 = 24,03; 250 × 6 % × 10/30 = 5.
    const v = await como(adminB(), (tx) => verificacionDeDeudaAnterior(tx, { barrioId: barrio(), tasa: "0.060000" }));
    expect(v).toMatchObject({ fecha: hoy, tasa: "0.060000", tasaVigente: "0.030000", capital: "2250.50", interes: "245.03" });
    expect(v.unidades.map((u) => ({ unidad: u.unidad, capital: u.capital, interes: u.interes, meses: u.meses.map((m) => `${m.periodo} ${m.concepto} ${m.capital} ${m.interes}`) }))).toEqual([
      { unidad: "Mza 1 · Lote 1", capital: "1600.00", interes: "216.00", meses: [`${mes3} Expensa 1000.00 180.00`, `${mes1} Expensa 600.00 36.00`] },
      { unidad: "Mza 1 · Lote 2", capital: "650.50", interes: "29.03", meses: [`${mes1} Expensa 400.50 24.03`, `${mes1} Obra de cloacas 250.00 5.00`] },
    ]);
    expect(v.saldosAFavor).toEqual([{ unidadFuncionalId: uf3, unidad: "Mza 1 · Lote 3", importe: "180.00" }]);
    // Sin decir la tasa, la vigente del barrio (3 %): la mitad.
    expect((await como(adminB(), (tx) => verificacionDeDeudaAnterior(tx, { barrioId: barrio() }))).interes).toBe("122.51");
    // Y sin que nadie haya elegido una tasa, la deuda anterior todavía no devenga: no se inventa.
    const cruda = await como(adminB(), (tx) => deudaALaFecha(tx, { barrioId: barrio(), fecha: hoy }));
    expect(cruda.get(uf1)).toMatchObject({ capital: "1600.00", interesNuevo: "0.00", tramos: [] });
  });

  it("después de activar: la tasa de la activación hasta ese día, y la normal desde el siguiente", async () => {
    await mora(true);
    await cargar(await planillaBase());
    await activar("6", "El reglamento anterior fijaba el 6 % mensual");
    await activacionHace(20);
    const deuda = await como(adminB(), (tx) => deudaALaFecha(tx, { barrioId: barrio(), fecha: hoy }));
    /*
     * La 1-1:
     *   $ 1.000 vencido hace 90 días → 70 días al 6 % (hasta la activación) + 20 días al 3 %:
     *       1.000 × 0,06 × 70/30 = 140,00   +   1.000 × 0,03 × 20/30 = 20,00   →  160,00
     *   $ 600 vencido hace 30 días → 10 días al 6 % + 20 días al 3 %:
     *       600 × 0,06 × 10/30 = 12,00      +   600 × 0,03 × 20/30 = 12,00     →   24,00
     */
    expect(deuda.get(uf1)).toMatchObject({ capital: "1600.00", interesPendiente: "0.00", interesNuevo: "184.00" });
    expect(deuda.get(uf1)!.porMes.map((m) => `${m.periodo} ${m.origen} ${m.capital} ${m.interes}`)).toEqual([
      `${mes3} historico 1000.00 160.00`,
      `${mes1} historico 600.00 24.00`,
    ]);
    /*
     * La 1-2:
     *   $ 400,50 vencido hace 30 días → 400,50 × 0,06 × 10/30 = 8,01  +  400,50 × 0,03 × 20/30 = 8,01  →  16,02
     *   $ 250 vencido hace 10 días (después de la activación): todo a la tasa normal → 250 × 0,03 × 10/30 = 2,50
     */
    expect(deuda.get(uf2)).toMatchObject({ capital: "650.50", interesNuevo: "18.52" });
    expect(deuda.get(uf2)!.porMes.map((m) => `${m.capital} ${m.interes}`)).toEqual(["400.50 16.02", "250.00 2.50"]);

    // El tramo guarda con qué se calculó: la tasa de la activación y hasta cuándo rigió.
    const tramo = deuda.get(uf1)!.tramos[0]!;
    expect(tramo.parametros.deudaAnterior).toEqual({ tasa: "0.060000", hasta: await fechaRelativa(-20) });

    // Un pago hoy registra ese interés, tal cual, y lo cobra primero (intereses primero).
    const pago = await pagar(uf1, "200.00", hoy);
    expect(pago).toMatchObject({ interesDevengado: "184.00", aInteres: "184.00", aCapital: "16.00" });
    const { rows } = await admin.query(
      `select d.desde::text, d.hasta::text, d.base::text, d.monto::text, d.parametros -> 'deudaAnterior' ->> 'tasa' as tasa
         from interes_devengado d where d.unidad_funcional_id = $1 order by d.desde`,
      [uf1],
    );
    expect(rows).toEqual([
      { desde: await fechaRelativa(-90), hasta: hoy, base: "1000.00", monto: "160.00", tasa: "0.060000" },
      { desde: await fechaRelativa(-30), hasta: hoy, base: "600.00", monto: "24.00", tasa: "0.060000" },
    ]);
  });

  it("con tasa cero para la deuda anterior, solo devenga desde la activación", async () => {
    await mora(true);
    await cargar(await planillaBase());
    await activar("0", "La comisión resolvió no cobrar interés por la deuda anterior");
    await activacionHace(20);
    const deuda = await como(adminB(), (tx) => deudaALaFecha(tx, { barrioId: barrio(), fecha: hoy }));
    // 1.000 × 0,03 × 20/30 = 20,00 y 600 × 0,03 × 20/30 = 12,00.
    expect(deuda.get(uf1)).toMatchObject({ interesNuevo: "32.00" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("la imputación por vencimiento", () => {
  it("un histórico cargado después de un mes normal se cobra primero", async () => {
    await mora(false);
    await cargar(await planillaBase());
    await activar("0");
    const primero = await crearPrimerMes();
    await emitir(primero);
    // El mes del sistema queda como cargado ANTES que lo histórico: con el orden viejo (por fecha de
    // carga) se cobraba primero, aunque venza después.
    await sinTriggers(async (c) => {
      await c.query("update liquidacion set created_at = now() - interval '2 days' where periodo_id = $1", [primero]);
    });

    await pagar(uf1, "1200.00", hoy);
    const { rows } = await admin.query<{ origen: string; vencimiento: string; imputado: string }>(
      `select pe.origen, coalesce(l.vencimiento, pe.primer_vencimiento)::text as vencimiento, sum(pi.monto_imputado)::text as imputado
         from pago_imputacion pi join liquidacion l on l.id = pi.liquidacion_id join periodo_expensa pe on pe.id = l.periodo_id
        where l.unidad_funcional_id = $1 and pi.anulado_at is null
        group by pe.origen, coalesce(l.vencimiento, pe.primer_vencimiento) order by 2`,
      [uf1],
    );
    expect(rows).toEqual([
      { origen: "historico", vencimiento: await fechaRelativa(-90), imputado: "1000.00" },
      { origen: "historico", vencimiento: await fechaRelativa(-30), imputado: "200.00" },
    ]);
    // Lo que queda: $ 400 del mes pasado y el mes del sistema entero.
    const deuda = await como(adminB(), (tx) => deudaMesPorMesDeUnidad(tx, { unidadFuncionalId: uf1 }));
    expect(deuda.meses.map((m) => `${m.periodo} ${m.origen} ${m.capital}`)).toEqual([`${mes1} historico 400.00`, `${mes0} mensual 1000.00`]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("el estado de cuenta y el primer cupón", () => {
  it("la deuda mes por mes dice de dónde sale cada mes, y lo histórico se fecha por su vencimiento", async () => {
    await mora(true);
    await cargar(await planillaBase());
    await activar();
    const deuda = await como(adminB(), (tx) => deudaMesPorMesDeUnidad(tx, { unidadFuncionalId: uf2 }));
    // Activado hoy con la vigente (3 %): 400,50 × 3 % × 30/30 = 12,01 (trunca 12,015) y 250 × 3 % × 10/30 = 2,50.
    expect(deuda).toMatchObject({ fecha: hoy, capital: "650.50", interes: "14.51" });
    expect(deuda.meses.map(({ liquidacionId: _l, ...m }) => m)).toEqual([
      { periodo: mes1, concepto: "Expensa", vencimiento: await fechaRelativa(-30), capital: "400.50", interes: "12.01", origen: "historico" },
      { periodo: mes1, concepto: "Obra de cloacas", vencimiento: await fechaRelativa(-10), capital: "250.00", interes: "2.50", origen: "historico" },
    ]);
    const { rows } = await admin.query<{ fecha: string; monto: string }>(
      "select fecha::text, monto::text from app.v_estado_cuenta_uf where unidad_funcional_id = $1 and concepto = 'liquidacion' order by fecha",
      [uf2],
    );
    expect(rows).toEqual([
      { fecha: await fechaRelativa(-30), monto: "400.50" },
      { fecha: await fechaRelativa(-10), monto: "250.00" },
    ]);
  });

  it("el primer cupón con «solo el mes» cobra solo el mes, y la deuda anterior va aparte, mes por mes", async () => {
    await mora(true);
    for (const [clave, valor] of Object.entries({ "devengado.origen": "gastos", "devengado.reparto": "coeficiente", "cupon.cobra": "solo_mes", "bonificacion.modo": "no" })) {
      await cargarParametro(admin, barrio(), clave, valor);
    }
    await cargar(await planillaBase());
    await activar();
    const primero = await crearPrimerMes();
    await emitir(primero);

    const { rows } = await admin.query<{ saldo: string; origen: string; interes: string; total: string; exigible: string; cupon: string; deuda: unknown }>(
      `select saldo_anterior::text as saldo, saldo_anterior_origen as origen, interes_mora::text as interes, total::text,
              importe_exigible::text as exigible, importe_cupon::text as cupon, deuda_anterior as deuda
         from liquidacion where periodo_id = $1 and unidad_funcional_id = $2`,
      [primero, uf1],
    );
    // La 1-1 debe $ 1.600 de antes, con interés a hoy al 3 %: 1.000 × 3 % × 90/30 = 90 y 600 × 3 % × 30/30 = 18.
    expect(rows[0]).toEqual({
      saldo: "1600.00",
      origen: "calculado",
      interes: "108.00",
      total: "2708.00",
      exigible: "1000.00",
      cupon: "1000.00", // solo el mes
      deuda: [
        { periodo: mes3, vencimiento: await fechaRelativa(-90), capital: "1000.00", interes: "90.00" },
        { periodo: mes1, vencimiento: await fechaRelativa(-30), capital: "600.00", interes: "18.00" },
      ],
    });
    // La cuenta corriente: lo histórico, más el mes, más el interés que cerró el corte.
    expect((await saldos()).uf1).toBe("2708.00");

    const vistas = await como(adminB(), (tx) => armarVistasDelPeriodo(tx, primero, { registro }));
    const v = vistas[0]!;
    expect(v.cupon).toMatchObject({ modo: "solo_mes", importe: { monto: "1000.00" }, deudaNoIncluida: { monto: "1708.00" } });
    expect(v.deudaAnterior).toEqual([
      expect.objectContaining({ periodo: mes3, capital: expect.objectContaining({ monto: "1000.00" }), interes: expect.objectContaining({ monto: "90.00" }) }),
      expect.objectContaining({ periodo: mes1, capital: expect.objectContaining({ monto: "600.00" }), interes: expect.objectContaining({ monto: "18.00" }) }),
    ]);
    // La unidad que traía saldo a favor no debe nada de antes: su cupón es el mes y su deuda anterior, una lista vacía.
    // El cupón se calcula antes de emitir y no cambia (lo que muestra la boleta es F6 tramo 2).
    expect(vistas[2]!.cupon).toMatchObject({ importe: { monto: "400.00" }, deudaNoIncluida: { monto: "0.00" } });
    expect(vistas[2]!.deudaAnterior).toEqual([]);
    // [F6 tramo 1] Antes, el saldo a favor de la activación quedaba en la cuenta como un cobro sin imputar
    // y la emisión no lo descontaba. Ahora, con «Se aplica en la boleta siguiente» (el valor de una
    // administración nueva), la emisión lo imputa: los $ 180 van a la boleta del primer mes, que queda
    // debiendo $ 220 de sus $ 400.
    const { rows: favor } = await admin.query<{ imputado: string; saldo: string }>(
      `select pi.monto_imputado::text as imputado, app.saldo_de_liquidacion(l.id)::text as saldo
         from pago p join pago_imputacion pi on pi.pago_id = p.id and pi.anulado_at is null
         join liquidacion l on l.id = pi.liquidacion_id
        where p.unidad_funcional_id = $1 and p.origen = 'activacion' and p.anulado_at is null and l.periodo_id = $2`,
      [uf3, primero],
    );
    expect(favor).toEqual([{ imputado: "180.00", saldo: "220.00" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("volver a subir la planilla", () => {
  it("antes de emitir el primer mes, descarta y reemplaza; después, no", async () => {
    await mora(false);
    await cargar(await planillaBase());
    await activar("0");

    // Otra planilla: la 1-1 ya no debe nada, la 1-3 pasa a deber, y el saldo a favor es de la 1-2.
    const v30 = await fechaRelativa(-30);
    const otra = [ENCABEZADO, ["1", "3", mes1, "Expensa", v30, "75,25"], ["1", "2", "", "", "", "-40"]];
    expect((await previa(otra)).reemplaza).toBe(true);
    const r = await cargar(otra, adminB(), "deuda-corregida.xlsx");
    expect(r).toEqual({ deudas: 1, unidades: 1, total: "75.25", saldosAFavor: 1, totalAFavor: "40.00", reemplaza: true });
    expect(await historicas()).toEqual([
      { uf: "uf3", periodo: mes1, estado: "emitida", vencimiento: v30, total: "75.25", exigible: "75.25", comprobante: null, lineas: "Expensa 75.25 historico" },
    ]);
    // La cuenta corriente quedó como si la primera planilla no hubiera existido.
    expect(await saldos()).toEqual({ uf1: "0.00", uf2: "0.00", uf3: "75.25" });
    // El saldo a favor anterior queda anulado, con su motivo; el nuevo, vigente.
    const { rows: pagos } = await admin.query(
      "select monto::text, anulado_at is not null as anulado, motivo_anulacion as motivo from pago where barrio_id = $1 order by created_at, monto desc",
      [barrio()],
    );
    expect(pagos).toEqual([
      { monto: "180.00", anulado: true, motivo: "Se volvió a cargar la deuda anterior del barrio" },
      { monto: "40.00", anulado: false, motivo: null },
    ]);
    const { rows: eventos } = await admin.query<{ detalle: string }>(
      "select detalle from padron_evento where barrio_id = $1 and archivo = 'deuda-corregida.xlsx'",
      [barrio()],
    );
    expect(eventos[0]!.detalle).toMatch(/\(reemplaza la carga anterior\)\.$/);

    // Emitido el primer mes, la planilla ya no se reemplaza: ni otra, ni «no trae deuda».
    const primero = await crearPrimerMes();
    await emitir(primero);
    const e = await capturar(async () => cargar(await planillaBase()));
    expect(e.message).toBe("La planilla tiene un renglón con error: no se cargó nada.");
    expect((await previa(await planillaBase())).errores[0]!.mensaje).toMatch(/ya emitió su primer mes/);
    const directo = await capturar(() => como(adminB(), (tx) => declararSinDeudaAnterior(tx, { barrioId: barrio() })));
    expect(directo.message).toBe("El barrio ya emitió su primer mes: la deuda anterior no se reemplaza con otra planilla.");
    expect(directo.sugerencia).toMatch(/Conceptos del mes/);
    expect((await historicas()).length).toBe(1);
  });

  it("con un cobro ya imputado a la deuda anterior tampoco se reemplaza", async () => {
    await mora(false);
    await cargar(await planillaBase());
    // Sin activar todavía no se cobra: un pago contra la deuda anterior antes de elegir su tasa se
    // imputaría al capital sin registrar el interés (panel `security-engineer`, A1).
    const temprano = await capturar(() => pagar(uf1, "100.00", hoy));
    expect(temprano.message).toBe("El barrio todavía no está activado: no se registran cobros hasta activarlo.");
    expect((await admin.query("select 1 from pago where barrio_id = $1 and origen <> 'activacion'", [barrio()])).rows).toEqual([]);
    await activar("0");
    await pagar(uf1, "100.00", hoy);
    const e = await capturar(async () => cargar(await planillaBase()));
    expect(e.message).toBe("La deuda anterior ya tiene cobros registrados: no se reemplaza con otra planilla.");
    expect((await saldos()).uf1).toBe("1500.00");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("permisos y aislamiento", () => {
  it("la deuda anterior entra solo por su función, y solo de la administración de ESE barrio", async () => {
    const v30 = await fechaRelativa(-30);
    const filas = [ENCABEZADO, ["1", "1", mes1, "Expensa", v30, "600"]];
    for (const usuario of [operador(), arbol.usuarios.auditorA1, arbol.usuarios.contadorA1, arbol.usuarios.adminEstudioB]) {
      expect((await capturar(() => cargar(filas, usuario))).codigo).toBe("sin_permiso");
      expect((await capturar(() => previa(filas, usuario))).codigo).toBe("sin_permiso");
      expect((await capturar(() => como(usuario, (tx) => declararSinDeudaAnterior(tx, { barrioId: barrio() })))).codigo).toBe("sin_permiso");
      await expect(
        como(usuario, (tx) =>
          tx.execute(sql`select app.cargar_deuda_historica(${barrio()}::uuid, '[]'::jsonb, '[]'::jsonb, null)`),
        ),
      ).rejects.toThrow(/la deuda anterior la carga la administración/);
    }

    // Ni la administración la escribe a mano: un período histórico, una liquidación con vencimiento
    // propio o un saldo a favor de la activación entran solo por la función.
    await expect(
      como(adminB(), (tx) => tx.execute(sql`insert into periodo_expensa (barrio_id, periodo, origen) values (${barrio()}, ${mes1}, 'historico')`)),
    ).rejects.toThrow(/se carga con la planilla de deuda, no a mano/);
    const { rows: p } = await admin.query<{ id: string }>(
      "insert into periodo_expensa (barrio_id, periodo, modelo) values ($1, $2, 'variable') returning id",
      [barrio(), mes0],
    );
    await expect(
      como(adminB(), (tx) =>
        tx.execute(sql`
          insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, coeficiente_aplicado, subtotal_ordinarias,
                                   subtotal_extraordinarias, subtotal_fondo_reserva, interes_mora, total, vencimiento)
          values (${barrio()}, ${p[0]!.id}, ${uf1}, 0, 10, 0, 0, 0, 10, ${v30}::date)
        `),
      ),
    ).rejects.toThrow(/el vencimiento propio es de la deuda anterior/);
    await expect(
      como(adminB(), (tx) =>
        tx.execute(sql`
          insert into pago (barrio_id, unidad_funcional_id, monto, fecha, origen, estado_conciliacion)
          values (${barrio()}, ${uf1}, 500, ${hoy}::date, 'activacion', 'conciliado')
        `),
      ),
    ).rejects.toThrow(/un saldo a favor de la activación entra con la planilla/);
    await expect(
      como(adminB(), (tx) => tx.execute(sql`update barrio set deuda_anterior_estado = 'sin_deuda' where barrio_id = ${barrio()}`)),
    ).rejects.toThrow(/permission denied for table barrio/);

    // Cargada, un período histórico no se toca: ni se le cambia el origen ni se distribuye.
    await cargar(filas);
    await expect(
      como(adminB(), (tx) => tx.execute(sql`update periodo_expensa set origen = 'mensual' where barrio_id = ${barrio()} and origen = 'historico'`)),
    ).rejects.toThrow(/el origen de un período no se cambia/);
    await expect(
      como(adminB(), (tx) => tx.execute(sql`update periodo_expensa set estado = 'distribuida' where barrio_id = ${barrio()} and origen = 'historico'`)),
    ).rejects.toThrow(/se carga con la planilla de deuda, no a mano/);
  });

  it("el saldo a favor de la activación lo anula solo la administración, y no sale como ingreso ni tiene recibo", async () => {
    await cargar(await planillaBase());
    const { rows } = await admin.query<{ id: string }>("select id from pago where barrio_id = $1 and origen = 'activacion'", [barrio()]);
    const pagoId = rows[0]!.id;
    await expect(
      como(operador(), (tx) => tx.execute(sql`update pago set anulado_at = now(), motivo_anulacion = 'No corresponde' where id = ${pagoId}`)),
    ).rejects.toThrow(/anular un saldo a favor de la activación es de la administración/);
    const { rows: ingresos } = await como(adminB(), (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from pago p where p.barrio_id = ${barrio()} and p.anulado_at is null and p.origen <> 'activacion'`),
    );
    expect(ingresos[0]!.n).toBe(0);
    await como(adminB(), (tx) => tx.execute(sql`update pago set anulado_at = now(), motivo_anulacion = 'Cargado por error' where id = ${pagoId}`));
    expect((await admin.query<{ a: boolean }>("select anulado_at is not null as a from pago where id = $1", [pagoId])).rows[0]!.a).toBe(true);
  });

  it("un barrio que ya operaba (activo y sin firma de activación) no carga deuda anterior", async () => {
    // Como quedan los barrios anteriores a la activación: activos, sin fecha ni tasa. Lo que cargaran
    // no devengaría nunca (panel `security-engineer`, A2).
    await sinTriggers(async (c) => {
      await c.query("update barrio set activacion = 'activo' where barrio_id = $1", [barrio()]);
    });
    const e = await capturar(async () => cargar(await planillaBase()));
    expect(e.message).toBe("Este barrio ya operaba en el sistema: no trae deuda anterior por planilla.");
    expect((await admin.query("select 1 from periodo_expensa where barrio_id = $1", [barrio()])).rows).toEqual([]);
  });

  it("otro estudio no ve la deuda anterior de este barrio, y un vecino no ve el estado de la activación de otro", async () => {
    await cargar(await planillaBase());
    const ajeno = arbol.usuarios.adminEstudioB;
    const { rows } = await como(ajeno, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from periodo_expensa where barrio_id = ${barrio()}`),
    );
    expect(rows[0]!.n).toBe(0);
    expect(await como(ajeno, (tx) => estadoDeLaActivacion(tx, { barrioId: barrio() }))).toBeNull();
    // El operador del barrio la ve (es deuda de la cuenta corriente), pero no puede activar.
    expect(await como(operador(), (tx) => estadoDeLaActivacion(tx, { barrioId: barrio() }))).toMatchObject({ deudas: 4, puedeActivar: false });
  });

  it("un barrio dado de alta por una persona nace sin activar, pida lo que pida", async () => {
    // El alta directa con identidad no puede colar un barrio ya activo ni una firma ajena.
    const { rows } = await admin.query<{ activacion: string }>("select activacion from barrio where barrio_id = $1", [barrio()]);
    expect(rows[0]!.activacion).toBe("sin_activar");
    const { rows: def } = await admin.query<{ d: string }>(
      "select column_default as d from information_schema.columns where table_name = 'barrio' and column_name = 'activacion'",
    );
    expect(def[0]!.d).toBe("'sin_activar'::text");
  });
});
