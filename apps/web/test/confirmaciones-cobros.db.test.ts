/**
 * **El recorrido de la pantalla de Cobros, de punta a punta contra Postgres real** (BL-024, paso 8).
 *
 * Las acciones de verdad (`registrarPagoAction`, `condonarInteresAction`) con el `FormData` que manda
 * el navegador, el reenvío que hace `PedidoDeConfirmacion` (sin los campos de confirmación, con la
 * casilla) y los servicios de verdad sobre la base, con la RLS puesta. Lo único doblado es la sesión:
 * `conSesion` corre como la administradora del barrio, con `conUsuario` sobre la conexión sujeta a RLS.
 *
 * Los dos casos son los de la demo:
 * - **como Los Talas** («Intereses primero», el orden general): un pago fuera de término pide
 *   confirmación con el interés, y confirmado se registra y cubre primero el interés;
 * - **como El Algarrobal** («Capital primero»): el interés del pago tardío queda como deuda, y se
 *   condona desde el estado de cuenta con su confirmación.
 *
 * Antes del arreglo de BL-024 el segundo envío volvía a pedir la confirmación sin fin (ver
 * `src/acciones/confirmacion-acciones.test.ts`, que lo fija sin base).
 *
 * De paso fija lo que agrega BL-024 a la lectura: los titulares vigentes para «A nombre de» y el mes de
 * cada movimiento para la columna «Origen» del estado de cuenta.
 *
 * Correr con: pnpm vitest run --project db apps/web/test/confirmaciones-cobros.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { nuevoToken } from "@admin-barrios/almacenamiento";
import { estadoDeCuenta, titularesVigentesDelBarrio } from "@admin-barrios/data/servicios/cobros";
import { emitirPeriodo, generarLiquidaciones } from "@admin-barrios/data/servicios/liquidacion";
import { registrarEImputarPago } from "@admin-barrios/data/servicios/deuda";
import { anularPago } from "@admin-barrios/data/servicios/pagos";
import { conUsuario, type DbRequest } from "../../../packages/data/src/client.ts";
import {
  borrarArbol,
  borrarParametrosDe,
  cargarParametro,
  crearArbol,
  crearBarrio,
  dbDe,
  poolAdmin,
  poolApp,
  type Arbol,
} from "../../../packages/data/test/helpers.ts";
import {
  CAMPO_CIFRAS_CONFIRMADAS,
  CAMPO_CODIGO_CONFIRMADO,
  CAMPO_CONFIRMO,
  CAMPOS_DE_CONFIRMACION,
  VALOR_CONFIRMO,
} from "../src/acciones/confirmacion.ts";
import type { ResultadoDeAccion, ValoresDeFormulario } from "../src/acciones/resultado.ts";

let admin: pg.Pool;
let appPool: pg.Pool;
let db: DbRequest;
let arbol: Arbol;
let uf1: string;
let titularId: string;
let conceptoId: string;

const barrio = () => arbol.barrioA1.id;

// La sesión: la administradora del barrio, sobre la conexión con RLS. El resto es de producción.
vi.mock("../src/servidor/db.ts", () => ({
  conSesion: <T>(fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, arbol.usuarios.adminBarrioA1, fn),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("../src/servidor/almacenamiento.ts", () => ({ urlDeSubidaDeComprobante: vi.fn(), exigirSubidaConfigurada: vi.fn() }));

const { registrarPagoAction, condonarInteresAction } = await import("../src/acciones/cobros.ts");

const formulario = (valores: ValoresDeFormulario): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(valores)) f.append(k, v);
  return f;
};

/** Lo que reemite `PedidoDeConfirmacion` cuando la persona marca la casilla y aprieta confirmar. */
const confirmando = (r: ResultadoDeAccion<unknown>): FormData => {
  if (r.estado !== "confirmar") throw new Error(`se esperaba un pedido de confirmación: ${JSON.stringify(r)}`);
  return formulario({
    ...Object.fromEntries(Object.entries(r.valores).filter(([clave]) => !CAMPOS_DE_CONFIRMACION.has(clave))),
    [CAMPO_CODIGO_CONFIRMADO]: r.error.codigo,
    // Como el componente: las cifras que se mostraron, si el servidor las mandó (BL-022 b).
    ...(r.error.datos["cifras"] !== undefined ? { [CAMPO_CIFRAS_CONFIRMADAS]: r.error.datos["cifras"] } : {}),
    [CAMPO_CONFIRMO]: VALOR_CONFIRMO,
  });
};

async function parametros(orden: string) {
  await borrarParametrosDe(admin, [barrio()]);
  const n = barrio();
  await cargarParametro(admin, n, "interes.cobra", true);
  await cargarParametro(admin, n, "interes.tasa_compensatoria", "0.03");
  await cargarParametro(admin, n, "interes.tasa_punitoria", "0");
  await cargarParametro(admin, n, "interes.gracia_dias", 0);
  await cargarParametro(admin, n, "interes.forma_gracia", "corre_inicio");
  await cargarParametro(admin, n, "interes.tolerancia", "0.00");
  await cargarParametro(admin, n, "imputacion.orden", orden);
}

/** $ 1.000 de gasto, una sola unidad con coeficiente 1: la boleta es de $ 1.000 y vence el 10. */
async function emitirMes(periodo: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, $2, $3) returning id",
    [barrio(), periodo, `${periodo}-10`],
  );
  const periodoId = rows[0]!.id;
  await admin.query(
    "insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '1000.00')",
    [barrio(), periodoId, conceptoId],
  );
  await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
    generarLiquidaciones(tx, { periodoId, origenSaldo: "calculado", fechaCorteMora: `${periodo}-01` }),
  );
  await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => emitirPeriodo(tx, { periodoId }));
  return periodoId;
}

const pagoTardio = (periodo: string): ValoresDeFormulario => ({
  unidadFuncionalId: uf1,
  obligadoId: titularId,
  monto: "1000.00",
  fecha: `${periodo}-25`, // 15 días después del vencimiento: 1.000 × 0,03 × 15/30 = $ 15,00
  origen: "manual",
  comprobanteAdjunto: `barrios/${barrio()}/pagos/comprobantes/${nuevoToken()}.pdf`,
});

const saldoUf = async () =>
  (await admin.query<{ s: string }>("select coalesce((select saldo_actual::text from saldo_uf where unidad_funcional_id = $1), '0.00') as s", [uf1]))
    .rows[0]!.s;

async function limpiarMovimientos() {
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["interes_condonacion", "pago_imputacion_interes", "pago_imputacion", "interes_devengado", "saldo_uf", "pago",
      "item_liquidacion", "liquidacion", "gasto_periodo", "periodo_expensa"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
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
  await crearBarrio(admin, barrio(), { figuraJuridica: "sa", adecuadoArt2075: "no_aplica" });
  const { rows: ufs } = await admin.query<{ id: string }>(
    "insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad) values ($1, '1', '1', 'construido') returning id",
    [barrio()],
  );
  uf1 = ufs[0]!.id;
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [barrio()],
  );
  await admin.query("insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1, $2, $3, 1)", [barrio(), v[0]!.id, uf1]);
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
  const { rows: c } = await admin.query<{ id: string }>(
    "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
    [barrio()],
  );
  conceptoId = c[0]!.id;
  // Dos titulares vigentes y uno que ya no lo es: el desplegable ofrece los vigentes, primero el que
  // recibe la boleta.
  const { rows: o } = await admin.query<{ id: string }>(
    "insert into obligado (barrio_id, nombre) values ($1, 'Zulema Paz'), ($1, 'Ana Ruiz'), ($1, 'Pedro Viejo') returning id",
    [barrio()],
  );
  titularId = o[0]!.id;
  await admin.query(
    `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, hasta, es_notificado)
     values ($1, $2, $3, 'propietario', '2020-01-01', null, true),
            ($1, $2, $4, 'propietario', '2020-01-01', null, false),
            ($1, $2, $5, 'propietario', '2010-01-01', '2019-12-31', false)`,
    [barrio(), uf1, o[0]!.id, o[1]!.id, o[2]!.id],
  );
});

afterAll(async () => {
  await limpiarMovimientos();
  await borrarParametrosDe(admin, [barrio()]);
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const t of ["unidad_obligado", "obligado", "concepto", "coeficiente", "coeficiente_version", "unidad_funcional",
      "codigo_pago_secuencia", "barrio_atributo_vigencia", "barrio"]) {
      await c.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
    }
    await c.query("commit");
  } finally {
    c.release();
  }
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("como Los Talas («Intereses primero»): un pago fuera de término desde la pantalla", () => {
  it("pide confirmación con el interés; confirmado, se registra a nombre del titular y cubre primero el interés", async () => {
    await limpiarMovimientos();
    await parametros("intereses_primero_capital_antiguo");
    await emitirMes("2025-01");

    const v1 = await registrarPagoAction({ estado: "inicial" }, formulario(pagoTardio("2025-01")));
    expect(v1.estado).toBe("confirmar");
    if (v1.estado === "confirmar") expect(v1.error.codigo).toBe("pago_con_interes_requiere_confirmacion");
    expect(await saldoUf()).toBe("1000.00"); // pedir la confirmación no escribe nada

    const v2 = await registrarPagoAction(v1 as never, confirmando(v1));
    expect(v2.estado, JSON.stringify(v2)).toBe("ok");
    if (v2.estado === "ok") expect(v2.valor).toMatchObject({ interesDevengado: "15.00", aInteres: "15.00", aCapital: "985.00" });

    const { rows } = await admin.query<{ obligado_id: string | null }>("select obligado_id from pago where unidad_funcional_id = $1", [uf1]);
    expect(rows.map((r) => r.obligado_id)).toEqual([titularId]);
  });

  it("la columna «Origen» tiene de qué hablar: el mes de la liquidación y del interés", async () => {
    const movimientos = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => estadoDeCuenta(tx, { unidadFuncionalId: uf1 }));
    const porConcepto = new Map(movimientos.map((m) => [m.concepto, m]));
    expect(porConcepto.get("liquidacion")?.periodo).toBe("2025-01");
    expect(porConcepto.get("interes")?.periodo).toBe("2025-01");
    expect(porConcepto.get("pago")?.periodo).toBeNull();
    expect(porConcepto.get("pago")?.fecha).toBe("2025-01-25");
  });
});

describe("como El Algarrobal («Capital primero»): condonar desde el estado de cuenta", () => {
  it("el interés queda como deuda, condonar pide confirmación y, confirmada, baja el saldo lo condonado", async () => {
    await limpiarMovimientos();
    await parametros("capital_primero");
    await emitirMes("2025-01");
    const pago = await registrarPagoAction({ estado: "inicial" }, formulario(pagoTardio("2025-01")));
    expect((await registrarPagoAction(pago as never, confirmando(pago))).estado).toBe("ok");
    expect(await saldoUf()).toBe("15.00");

    const condonar = formulario({
      unidadFuncionalId: uf1,
      monto: "10.00",
      motivo: "comision_asamblea",
      detalle: "La comisión resolvió condonar parte del interés por la demora del correo.",
      respaldoTipo: "acta_comision",
      respaldoReferencia: "Acta de comisión 3/2025",
    });
    const v1 = await condonarInteresAction({ estado: "inicial" }, condonar);
    expect(v1.estado).toBe("confirmar");
    if (v1.estado === "confirmar") expect(v1.error.codigo).toBe("condonacion_requiere_confirmacion");
    expect(await saldoUf()).toBe("15.00");

    const v2 = await condonarInteresAction(v1 as never, confirmando(v1));
    expect(v2.estado, JSON.stringify(v2)).toBe("ok");
    expect(await saldoUf()).toBe("5.00");
  });
});

describe("«A nombre de» en Registrar pago", () => {
  it("ofrece solo los titulares vigentes de la unidad, primero el que recibe la boleta", async () => {
    const titulares = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => titularesVigentesDelBarrio(tx, { barrioId: barrio() }));
    expect(titulares[uf1]?.map((t) => [t.nombre, t.recibeBoleta])).toEqual([
      ["Zulema Paz", true],
      ["Ana Ruiz", false],
    ]);
  });

  it("otro barrio no ve los titulares (RLS)", async () => {
    const ajenos = await conUsuario(db, arbol.usuarios.adminEstudioB, (tx) => titularesVigentesDelBarrio(tx, { barrioId: barrio() }));
    expect(ajenos).toEqual({});
  });
});

describe("las cifras confirmadas son las que se mostraron (BL-022 b)", () => {
  it("si entre mostrarlas y confirmarlas cambió la deuda, se vuelve a pedir la confirmación con las nuevas", async () => {
    await limpiarMovimientos();
    await parametros("intereses_primero_capital_antiguo");
    await emitirMes("2025-01");

    const v1 = await registrarPagoAction({ estado: "inicial" }, formulario(pagoTardio("2025-01")));
    expect(v1.estado).toBe("confirmar");
    const mostradas = v1.estado === "confirmar" ? v1.error.datos["cifras"] : undefined;
    expect(mostradas).toBe("15.00|15|15.00|985.00|0.00|cobra");

    // Mientras la pantalla mostraba el pedido, entró otro pago de la misma unidad (otra persona, otra
    // pestaña): $ 500 el 12, con 2 días de atraso. La deuda sobre la que se calculó el interés cambió.
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      registrarEImputarPago(tx, {
        pago: { ...pagoTardio("2025-01"), monto: "500.00", fecha: "2025-01-12", obligadoId: titularId, unidadFuncionalId: uf1, origen: "manual" } as never,
        confirmarPagoConInteres: true,
        noCobrarInteres: null,
      }),
    );
    const antes = await saldoUf();

    // Confirmar lo que se mostró ya no registra: vuelve a pedir, con las cifras de ahora.
    const v2 = await registrarPagoAction(v1 as never, confirmando(v1));
    expect(v2.estado, JSON.stringify(v2)).toBe("confirmar");
    if (v2.estado === "confirmar") {
      expect(v2.error.codigo).toBe("pago_con_interes_requiere_confirmacion");
      expect(v2.error.mensaje).toMatch(/^Las cifras cambiaron desde que se mostraron/);
      expect(v2.error.datos["cifras"]).not.toBe(mostradas);
    }
    expect(await saldoUf()).toBe(antes);
    const { rows } = await admin.query<{ n: string }>("select count(*)::text as n from pago where unidad_funcional_id = $1", [uf1]);
    expect(rows[0]!.n).toBe("1");

    // Con las cifras nuevas a la vista, confirmar sí registra.
    const v3 = await registrarPagoAction(v2 as never, confirmando(v2));
    expect(v3.estado, JSON.stringify(v3)).toBe("ok");
  });
});

describe("anular un pago anula sus imputaciones (BL-022 a)", () => {
  it("las de capital y las de interés, con el mismo motivo y sin borrar nada; el estado de cuenta y saldo_uf coinciden", async () => {
    await limpiarMovimientos();
    await parametros("intereses_primero_capital_antiguo");
    await emitirMes("2025-01");
    const v1 = await registrarPagoAction({ estado: "inicial" }, formulario(pagoTardio("2025-01")));
    const v2 = await registrarPagoAction(v1 as never, confirmando(v1));
    expect(v2.estado).toBe("ok");
    const pagoId = v2.estado === "ok" ? v2.valor.id : "";

    const motivo = "El banco rechazó la transferencia";
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => anularPago(tx, { pagoId, motivo }));

    const { rows: imputaciones } = await admin.query<{ tabla: string; anulada: boolean; motivo: string | null }>(
      `select 'capital' as tabla, anulado_at is not null as anulada, motivo_anulacion as motivo from pago_imputacion where pago_id = $1
       union all
       select 'interes', anulado_at is not null, motivo_anulacion from pago_imputacion_interes where pago_id = $1
       order by 1`,
      [pagoId],
    );
    expect(imputaciones).toEqual([
      { tabla: "capital", anulada: true, motivo },
      { tabla: "interes", anulada: true, motivo },
    ]);

    const movimientos = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => estadoDeCuenta(tx, { unidadFuncionalId: uf1 }));
    const saldoDelEstadoDeCuenta = movimientos.at(-1)!.saldoCorriente;
    // Al centavo: la deuda vuelve a ser la boleta más el interés que devengó hasta el día del pago.
    expect(saldoDelEstadoDeCuenta).toBe(await saldoUf());
    expect(saldoDelEstadoDeCuenta).toBe("1015.00");
  });
});
