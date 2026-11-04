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
import {
  deudaVencidaDelBarrio,
  anularImputacion,
  deudaVencidaPorUnidad,
  estadoDeCuenta,
  imputarPago,
  titularesVigentesDelBarrio,
} from "@admin-barrios/data/servicios/cobros";
import { emitirPeriodo, generarLiquidaciones } from "@admin-barrios/data/servicios/liquidacion";
import { condonacionDeUnidad, registrarEImputarPago } from "@admin-barrios/data/servicios/deuda";
import { anularPago, listarPagosDeUnidad, registrarPago } from "@admin-barrios/data/servicios/pagos";
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

const { registrarPagoAction, condonarInteresAction, anularPagoAction, interesQueSePuedeNoCobrarAction } = await import(
  "../src/acciones/cobros.ts"
);
const { listoDelPago, resumenDeAnulacion } = await import("../src/componentes/textos-de-cobros.ts");

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

// ── Encargo 9, PR 2 ─────────────────────────────────────────────────────────────────────────────


/** Una sentencia SQL a mano con la conexión de la aplicación (sujeta a RLS), como la administradora. */
async function comoAdministradora(texto: string, valores: unknown[]): Promise<void> {
  const c = await appPool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.user_id', $1, true)", [arbol.usuarios.adminBarrioA1]);
    await c.query(texto, valores);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

const NO_COBRAR = {
  motivo: "negociacion",
  detalle: "Acordado con el titular: el débito automático lo rechazó el banco.",
  respaldoTipo: null,
  respaldoReferencia: null,
  respaldoAdjunto: null,
} as const;

/** El pago tardío de `pagoTardio`, por el servicio, ya confirmado; con o sin «No cobrar interés». */
const registrarTardio = (periodo: string, noCobrar: boolean) =>
  conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
    registrarEImputarPago(tx, {
      pago: { ...pagoTardio(periodo), origen: "manual" } as never,
      confirmarPagoConInteres: true,
      noCobrarInteres: noCobrar ? NO_COBRAR : null,
    }),
  );

const condonaciones = async () =>
  (
    await admin.query<{ pago: string | null; anulada: boolean; motivo: string | null }>(
      `select pago_id as pago, anulado_at is not null as anulada, motivo_anulacion as motivo
         from interes_condonacion where unidad_funcional_id = $1 order by created_at`,
      [uf1],
    )
  ).rows;

const saldoDelEstadoDeCuenta = async () =>
  (await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => estadoDeCuenta(tx, { unidadFuncionalId: uf1 }))).at(-1)!.saldoCorriente;

describe("anular un pago anula la condonación que se registró con él (encargo 9, P5)", () => {
  it("pago con «No cobrar interés» → anular: la condonación queda anulada con el mismo motivo y el interés vuelve a deberse", async () => {
    await limpiarMovimientos();
    await parametros("intereses_primero_capital_antiguo");
    await emitirMes("2025-01");
    const pago = await registrarTardio("2025-01", true);
    expect(pago.interesCondonado).toBe("15.00");
    expect(await saldoUf()).toBe("0.00");

    const motivo = "El banco rechazó la transferencia";
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => anularPago(tx, { pagoId: pago.id, motivo }));

    // No se borró nada: la condonación sigue ahí, anulada, con el motivo del pago.
    expect(await condonaciones()).toEqual([{ pago: pago.id, anulada: true, motivo }]);
    const { rows } = await admin.query<{ pendiente: string }>(
      "select sum(app.interes_pendiente(id))::numeric(14,2)::text as pendiente from interes_devengado where unidad_funcional_id = $1",
      [uf1],
    );
    expect(rows[0]!.pendiente).toBe("15.00");
    // Al centavo: la boleta más el interés que devengó hasta el día del pago, en los dos lados.
    expect(await saldoDelEstadoDeCuenta()).toBe(await saldoUf());
    expect(await saldoUf()).toBe("1015.00");
  });

  it("si se vuelve a registrar el pago, la condonación anulada no revive: se decide de nuevo", async () => {
    // Sigue del caso anterior: el pago anulado, $ 1.015,00 adeudados. Se vuelve a registrar el mismo
    // día con «No cobrar interés». La condonación anulada sigue anulada (no se reutiliza), y la nueva
    // decisión alcanza al interés que devenga ESTE pago — que es cero, porque el tramo ya se cerró ese
    // día. Los $ 15,00 que había condonado el pago anulado quedan adeudados y se cobran con este pago
    // (intereses primero); para no cobrarlos, se condonan desde el estado de cuenta.
    const otra = await registrarTardio("2025-01", true);
    expect(otra.interesCondonado).toBe("0.00");
    expect(otra.aInteres).toBe("15.00");
    expect(otra.aCapital).toBe("985.00");
    const filas = await condonaciones();
    expect(filas).toHaveLength(1);
    expect(filas[0]!.anulada).toBe(true);
    expect(await saldoDelEstadoDeCuenta()).toBe(await saldoUf());
    expect(await saldoUf()).toBe("15.00");
  });

  it("pago sin condonación → anular: no toca ninguna otra condonación de la unidad", async () => {
    await limpiarMovimientos();
    await parametros("intereses_primero_capital_antiguo");
    await emitirMes("2025-01");
    const conCondonacion = await registrarTardio("2025-01", true);
    // Un segundo pago, sin condonación: $ 1,00 que queda a cuenta.
    const otro = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      registrarEImputarPago(tx, {
        pago: { ...pagoTardio("2025-01"), monto: "1.00" } as never,
        confirmarPagoConInteres: true,
        noCobrarInteres: null,
      }),
    );
    const antes = await condonaciones();
    const saldoAntes = await saldoUf();
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => anularPago(tx, { pagoId: otro.id, motivo: "Cargado dos veces" }));
    expect(await condonaciones()).toEqual(antes);
    expect(antes).toEqual([{ pago: conCondonacion.id, anulada: false, motivo: null }]);
    // Ese peso no estaba imputado a nada: el saldo no cambia, y las dos cifras siguen coincidiendo.
    expect(await saldoUf()).toBe(saldoAntes);
    expect(await saldoDelEstadoDeCuenta()).toBe(await saldoUf());
  });

  it("una condonación no se anula sola: solo junto con su pago (la base lo rechaza)", async () => {
    const { rows } = await admin.query<{ id: string }>("select id from interes_condonacion where unidad_funcional_id = $1 and anulado_at is null", [uf1]);
    await expect(
      comoAdministradora("update interes_condonacion set anulado_at = now(), motivo_anulacion = 'Porque sí' where id = $1", [rows[0]!.id]),
    ).rejects.toThrow(/solo se anula junto con el pago/);
  });
});

describe("dos pagos simultáneos de la misma unidad (encargo 9, BL-022 f)", () => {
  /** Un pago en término (antes del vencimiento): no pide confirmación ni devenga interés. */
  const enTermino = (monto: string) =>
    ({ unidadFuncionalId: uf1, obligadoId: titularId, monto, fecha: "2025-01-05", origen: "manual",
       comprobanteAdjunto: `barrios/${barrio()}/pagos/comprobantes/${nuevoToken()}.pdf` }) as never;

  it("quedan uno detrás del otro: el segundo ve lo que imputó el primero y nunca se imputa dos veces", async () => {
    await limpiarMovimientos();
    await parametros("intereses_primero_capital_antiguo");
    await emitirMes("2025-01");

    let soltar!: () => void;
    const barrera = new Promise<void>((r) => (soltar = r));
    let avisar!: () => void;
    const primeroAdentro = new Promise<void>((r) => (avisar = r));

    const primero = conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
      const r = await registrarEImputarPago(tx, { pago: enTermino("1000.00"), confirmarPagoConInteres: false, noCobrarInteres: null });
      avisar();
      await barrera; // la transacción sigue abierta: el segundo llega mientras tanto
      return r;
    });
    await primeroAdentro;
    const segundo = conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      registrarEImputarPago(tx, { pago: enTermino("1000.00"), confirmarPagoConInteres: false, noCobrarInteres: null }),
    );
    await new Promise((r) => setTimeout(r, 500));
    soltar();
    const [r1, r2] = await Promise.allSettled([primero, segundo]);

    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    const { rows } = await admin.query<{ imputado: string; pagos: number }>(
      `select coalesce(sum(pi.monto_imputado), 0)::numeric(14,2)::text as imputado, count(distinct p.id)::int as pagos
         from pago p left join pago_imputacion pi on pi.pago_id = p.id and pi.anulado_at is null
        where p.unidad_funcional_id = $1 and p.anulado_at is null`,
      [uf1],
    );
    // Los dos pagos quedaron registrados, pero la boleta de $ 1.000 se imputó una sola vez.
    expect(rows[0]).toEqual({ imputado: "1000.00", pagos: 2 });
    expect(await saldoDelEstadoDeCuenta()).toBe(await saldoUf());
  });

  it("si el otro tarda demasiado, falla con un mensaje propio y no escribe nada", async () => {
    await limpiarMovimientos();
    await parametros("intereses_primero_capital_antiguo");
    await emitirMes("2025-01");

    let soltar!: () => void;
    const barrera = new Promise<void>((r) => (soltar = r));
    let avisar!: () => void;
    const primeroAdentro = new Promise<void>((r) => (avisar = r));
    const primero = conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => {
      await registrarEImputarPago(tx, { pago: enTermino("1000.00"), confirmarPagoConInteres: false, noCobrarInteres: null });
      avisar();
      await barrera;
    });
    await primeroAdentro;
    const segundo = conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      registrarEImputarPago(tx, { pago: enTermino("1000.00"), confirmarPagoConInteres: false, noCobrarInteres: null }),
    );
    await expect(segundo).rejects.toThrow("Se está registrando otro pago de esta unidad; probá de nuevo.");
    soltar();
    await primero;
    const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from pago where unidad_funcional_id = $1", [uf1]);
    expect(rows[0]!.n).toBe(1);
  }, 30_000);
});

describe("el obligado de un pago es titular de la unidad a la fecha del pago (encargo 9, BL-022 g)", () => {
  const pagoA = (obligadoId: string) =>
    conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      registrarPago(tx, {
        unidadFuncionalId: uf1, obligadoId, monto: "10.00", fecha: "2025-01-05", origen: "manual",
        comprobanteAdjunto: `barrios/${barrio()}/pagos/comprobantes/${nuevoToken()}.pdf`,
      } as never),
    );
  const insertarDirecto = (obligadoId: string) =>
    comoAdministradora(
      "insert into pago (barrio_id, unidad_funcional_id, obligado_id, monto, fecha, origen) values ($1, $2, $3, 10, '2025-01-05', 'extracto')",
      [barrio(), uf1, obligadoId],
    );

  it("un obligado ajeno a la unidad: rechazado, por el servicio y por la base", async () => {
    await limpiarMovimientos();
    const { rows } = await admin.query<{ id: string }>("insert into obligado (barrio_id, nombre) values ($1, 'Nadie Tiene') returning id", [barrio()]);
    await expect(pagoA(rows[0]!.id)).rejects.toThrow(/no es titular de la unidad/);
    await expect(insertarDirecto(rows[0]!.id)).rejects.toThrow(/no es titular de la unidad/);
    await admin.query("delete from obligado where id = $1", [rows[0]!.id]);
  });

  it("un ex titular (dejó de serlo en 2019): rechazado, por el servicio y por la base", async () => {
    const { rows } = await admin.query<{ id: string }>("select id from obligado where barrio_id = $1 and nombre = 'Pedro Viejo'", [barrio()]);
    await expect(pagoA(rows[0]!.id)).rejects.toThrow(/no es titular de la unidad/);
    await expect(insertarDirecto(rows[0]!.id)).rejects.toThrow(/no es titular de la unidad/);
  });

  it("la pregunta «¿es titular?» no responde por otro barrio (security-engineer, 0069)", async () => {
    const c = await appPool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.user_id', $1, true)", [arbol.usuarios.adminEstudioB]);
      const { rows } = await c.query<{ ok: boolean }>("select app.obligado_titular_a_la_fecha($1, $2, '2025-01-05') as ok", [uf1, titularId]);
      expect(rows[0]!.ok).toBe(false);
      await c.query("rollback");
    } finally {
      c.release();
    }
  });

  it("un titular vigente: pasa, y un pago sin obligado también", async () => {
    await expect(pagoA(titularId)).resolves.toMatchObject({ unidadFuncionalId: uf1 });
    await expect(
      conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
        registrarPago(tx, {
          unidadFuncionalId: uf1, obligadoId: null, monto: "10.00", fecha: "2025-01-05", origen: "manual",
          comprobanteAdjunto: `barrios/${barrio()}/pagos/comprobantes/${nuevoToken()}.pdf`,
        } as never),
      ),
    ).resolves.toMatchObject({ unidadFuncionalId: uf1 });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Encargo 10: el estado de cuenta después de registrar, condonar y anular (BL-030 b, BL-029)
// ────────────────────────────────────────────────────────────────────────────────────────────────

const pagosDeLaUnidad = (incluirAnulados = false) =>
  conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => listarPagosDeUnidad(tx, { unidadFuncionalId: uf1, incluirAnulados }));

describe("el «Listo:» del pago sale de las filas del pago (encargo 10, BL-030 b)", () => {
  it("la lectura del estado de cuenta trae cómo se imputó, igual que lo que devolvió el registro", async () => {
    await limpiarMovimientos();
    await parametros("intereses_primero_capital_antiguo");
    await emitirMes("2025-01");
    const v1 = await registrarPagoAction({ estado: "inicial" }, formulario(pagoTardio("2025-01")));
    const v2 = await registrarPagoAction(v1 as never, confirmando(v1));
    if (v2.estado !== "ok") throw new Error(JSON.stringify(v2));

    const [pago] = await pagosDeLaUnidad();
    expect(pago).toMatchObject({ id: v2.valor.id, aCapital: "985.00", aInteres: "15.00", interesCondonado: "0.00", anulacion: null });
    expect(listoDelPago(pago!)).toBe(listoDelPago(v2.valor));
    expect(listoDelPago(pago!)).toBe(
      "Listo: se registró el pago de $ 1.000,00 del 25/01/2025: $ 985,00 a capital y $ 15,00 a interés.",
    );
  });

  it("la condonación desde el estado de cuenta: el «Listo:» lee el total de ese acto", async () => {
    await limpiarMovimientos();
    await parametros("capital_primero");
    await emitirMes("2025-01");
    const pago = await registrarPagoAction({ estado: "inicial" }, formulario(pagoTardio("2025-01")));
    expect((await registrarPagoAction(pago as never, confirmando(pago))).estado).toBe("ok");
    const v1 = await condonarInteresAction(
      { estado: "inicial" },
      formulario({ unidadFuncionalId: uf1, monto: "10.00", motivo: "negociacion", detalle: "Acordado con el titular por la demora del correo." }),
    );
    const v2 = await condonarInteresAction(v1 as never, confirmando(v1));
    if (v2.estado !== "ok" || v2.valor.condonacionId === null) throw new Error(JSON.stringify(v2));
    const leida = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      condonacionDeUnidad(tx, { unidadFuncionalId: uf1, condonacionId: v2.valor.condonacionId! }),
    );
    expect(leida).toEqual({ monto: "10.00" });
    // De otro barrio, la misma fila no se ve: no hay «Listo:» que armar.
    const ajena = await conUsuario(db, arbol.usuarios.adminEstudioB, (tx) =>
      condonacionDeUnidad(tx, { unidadFuncionalId: uf1, condonacionId: v2.valor.condonacionId! }),
    );
    expect(ajena).toBeNull();
  });
});

describe("anular un pago desde el estado de cuenta (encargo 10, BL-029)", () => {
  it("el motivo es obligatorio: sin motivo no se anula nada", async () => {
    await limpiarMovimientos();
    await parametros("intereses_primero_capital_antiguo");
    await emitirMes("2025-01");
    const pago = await registrarTardio("2025-01", true);
    const r = await anularPagoAction({ estado: "inicial" }, formulario({ pagoId: pago.id, motivo: "" }));
    expect(r.estado).toBe("campos");
    if (r.estado === "campos") expect(r.campos["motivo"]?.length).toBeGreaterThan(0);
    expect((await pagosDeLaUnidad()).map((p) => p.id)).toEqual([pago.id]);
  });

  it("el saldo «después» del diálogo es el que queda: anula el pago, sus imputaciones y su condonación", async () => {
    // Sigue del caso anterior: un pago tardío con «No cobrar interés», $ 15,00 condonados.
    const [pago] = await pagosDeLaUnidad();
    expect(pago).toMatchObject({ aCapital: "1000.00", aInteres: "0.00", interesCondonado: "15.00" });
    const saldoAntes = await saldoUf();
    const resumen = resumenDeAnulacion(pago!, saldoAntes as never);
    expect(resumen.lineas.some((l) => l.includes("esa condonación también se anula"))).toBe(true);

    const motivo = "La transferencia vino rebotada";
    const r = await anularPagoAction({ estado: "inicial" }, formulario({ pagoId: pago!.id, motivo }));
    expect(r, JSON.stringify(r)).toMatchObject({ estado: "ok", valor: { pagoId: pago!.id } });

    // Lo que el diálogo prometió es lo que hizo la base, al centavo, y el estado de cuenta coincide.
    expect(await saldoUf()).toBe(resumen.saldoDespues);
    expect(await saldoUf()).toBe("1015.00");
    expect(await saldoDelEstadoDeCuenta()).toBe(await saldoUf());
    expect(await condonaciones()).toEqual([{ pago: pago!.id, anulada: true, motivo }]);
  });

  it("«Ver anulados»: el pago anulado sale de los vigentes y aparece con su motivo y lo que imputaba", async () => {
    expect(await pagosDeLaUnidad()).toEqual([]);
    const anulados = await pagosDeLaUnidad(true);
    expect(anulados).toHaveLength(1);
    expect(anulados[0]).toMatchObject({
      aCapital: "1000.00",
      aInteres: "0.00",
      interesCondonado: "15.00",
      anulacion: { motivo: "La transferencia vino rebotada" },
    });
    expect(anulados[0]!.anulacion!.el).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("un pago ya anulado no se anula dos veces: falla con el mensaje del catálogo", async () => {
    const [anulado] = await pagosDeLaUnidad(true);
    const r = await anularPagoAction({ estado: "inicial" }, formulario({ pagoId: anulado!.id, motivo: "Otra vez, por error" }));
    expect(r.estado).toBe("falla");
    if (r.estado === "falla") expect(r.error.codigo).toBe("pago_ya_anulado");
  });

  it("otro barrio no ve los pagos de la unidad, ni vigentes ni anulados (RLS)", async () => {
    const ajenos = await conUsuario(db, arbol.usuarios.adminEstudioB, (tx) =>
      listarPagosDeUnidad(tx, { unidadFuncionalId: uf1, incluirAnulados: true }),
    );
    expect(ajenos).toEqual([]);
  });
});

describe("la deuda vencida de cada unidad, para los filtros de Cobros (encargo 10, BL-030 e)", () => {
  const vencida = () =>
    conUsuario(db, arbol.usuarios.adminBarrioA1, async (tx) => ({
      barrio: await deudaVencidaDelBarrio(tx, { barrioId: barrio() }),
      porUnidad: await deudaVencidaPorUnidad(tx, { barrioId: barrio() }),
    }));

  it("una boleta vencida es deuda vencida; la que todavía no venció, no (aunque esté en el saldo)", async () => {
    await limpiarMovimientos();
    await parametros("intereses_primero_capital_antiguo");
    await emitirMes("2025-01"); // vence el 10/01/2025: vencida
    const antes = await vencida();
    expect(antes.porUnidad.get(uf1)).toBe("1000.00");
    expect(antes.barrio).toEqual({ unidades: 1, total: "1000.00" });

    await emitirMes("2099-12"); // vence el 10/12/2099: todavía no
    const despues = await vencida();
    // Lo vencido sigue siendo la boleta de enero de 2025: la de 2099 está en el saldo, a vencer.
    expect(despues.porUnidad.get(uf1)).toBe("1000.00");
    expect(despues.barrio.total).toBe("1000.00");
    expect(Number(await saldoUf())).toBeGreaterThan(1000);
  });

  it("el total por unidad y el del barrio (el del tablero) son la misma cuenta", async () => {
    const { barrio: total, porUnidad } = await vencida();
    expect(porUnidad.size).toBe(total.unidades);
    const suma = [...porUnidad.values()].reduce((a, v) => a + Math.round(Number(v) * 100), 0);
    expect((suma / 100).toFixed(2)).toBe(total.total);
  });

  it("pagada la boleta vencida, la unidad queda «Al día» aunque tenga saldo a vencer", async () => {
    await registrarTardio("2025-01", true); // $ 1.000 con «No cobrar interés»: cubre la boleta vencida
    const { barrio: total, porUnidad } = await vencida();
    expect(porUnidad.has(uf1)).toBe(false);
    expect(total).toEqual({ unidades: 0, total: "0.00" });
    expect(Number(await saldoUf())).toBeGreaterThan(0);
  });

  it("otro barrio no ve la deuda vencida de este (RLS)", async () => {
    await limpiarMovimientos();
    await parametros("intereses_primero_capital_antiguo");
    await emitirMes("2025-01");
    const ajena = await conUsuario(db, arbol.usuarios.adminEstudioB, (tx) => deudaVencidaPorUnidad(tx, { barrioId: barrio() }));
    expect(ajena.size).toBe(0);
  });
});

describe("anular un pago: quién puede y qué muestra después (encargo 10, security-engineer)", () => {
  const capturar = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "sin error";
    } catch (e) {
      return (e as { codigo?: string }).codigo ?? String(e);
    }
  };

  it("otro barrio no anula un pago de este: «no encontrado», y no se toca nada", async () => {
    await limpiarMovimientos();
    await parametros("intereses_primero_capital_antiguo");
    await emitirMes("2025-01");
    const pago = await registrarTardio("2025-01", false);
    const saldo = await saldoUf();
    const codigo = await capturar(
      conUsuario(db, arbol.usuarios.adminEstudioB, (tx) => anularPago(tx, { pagoId: pago.id, motivo: "Intento ajeno de anular" })),
    );
    expect(codigo).toBe("pago_no_encontrado");
    expect(await saldoUf()).toBe(saldo);
    expect((await pagosDeLaUnidad()).map((p) => p.id)).toEqual([pago.id]);
  });

  it.each(["contadorA1", "auditorA1"] as const)("%s (solo lectura) no anula", async (rol) => {
    const [pago] = await pagosDeLaUnidad();
    const codigo = await capturar(
      conUsuario(db, arbol.usuarios[rol], (tx) => anularPago(tx, { pagoId: pago!.id, motivo: "Intento sin permiso" })),
    );
    expect(codigo).not.toBe("sin error");
    expect((await pagosDeLaUnidad()).map((p) => p.id)).toEqual([pago!.id]);
  });

  it("un propietario no ve los pagos de la unidad, ni los anulados", async () => {
    const vistos = await conUsuario(db, arbol.usuarios.propietarioA1, (tx) =>
      listarPagosDeUnidad(tx, { unidadFuncionalId: uf1, incluirAnulados: true }),
    );
    expect(vistos).toEqual([]);
  });

  it("de un pago anulado se ve solo lo que se anuló con él, no una imputación anulada antes", async () => {
    // El pago del caso anterior imputó $ 15 a interés y $ 985 a capital. Se anula aparte la de capital,
    // se vuelve a imputar a mano, y después se anula el pago: «A capital» tiene que ser 985, no 1.970.
    const [pago] = await pagosDeLaUnidad();
    expect(pago).toMatchObject({ aCapital: "985.00", aInteres: "15.00" });
    const { rows } = await admin.query<{ id: string; liquidacion_id: string }>(
      "select id, liquidacion_id from pago_imputacion where pago_id = $1 and anulado_at is null",
      [pago!.id],
    );
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      anularImputacion(tx, { imputacionId: rows[0]!.id, motivo: "Imputada a la boleta equivocada" }),
    );
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      imputarPago(tx, { pagoId: pago!.id, liquidacionId: rows[0]!.liquidacion_id, montoImputado: "985.00" }),
    );
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => anularPago(tx, { pagoId: pago!.id, motivo: "El banco la revirtió" }));

    const [anulado] = await pagosDeLaUnidad(true);
    expect(anulado).toMatchObject({ id: pago!.id, aCapital: "985.00", aInteres: "15.00", anulacion: { motivo: "El banco la revirtió" } });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Encargo 11: «No cobrar interés» en dos renglones, de punta a punta (BL-030 j)
// ────────────────────────────────────────────────────────────────────────────────────────────────

describe("«No cobrar interés» en dos renglones, desde el formulario (encargo 11, BL-030 j)", () => {
  /**
   * Enero tarde con «Capital primero»: quedan $ 15,00 de interés, que la boleta de febrero factura.
   * Febrero ($ 1.000) pagado el 25/02: el atraso de ese pago es $ 15,00. Los dos renglones, $ 15 cada uno.
   */
  async function conInteresAnterior() {
    await limpiarMovimientos();
    await parametros("capital_primero");
    await emitirMes("2025-01");
    await registrarTardio("2025-01", false);
    await emitirMes("2025-02");
    expect(await saldoUf()).toBe("1015.00");
  }

  const conRenglones = (renglones: { delPago: boolean; anterior: boolean }): ValoresDeFormulario => ({
    ...pagoTardio("2025-02"),
    noCobrarInteres: "1",
    ...(renglones.delPago ? { noCobrarInteresDelPago: "1" } : {}),
    ...(renglones.anterior ? { noCobrarInteresAnterior: "1" } : {}),
    motivo: "negociacion",
    detalle: "Acordado con el titular por la demora del correo.",
  });

  it("los importes de los dos renglones, antes de enviar, son los que después se condonan", async () => {
    await conInteresAnterior();
    const datos = new FormData();
    datos.set("unidadFuncionalId", uf1);
    datos.set("fecha", "2025-02-25");
    const importes = await interesQueSePuedeNoCobrarAction({ estado: "inicial" }, datos);
    expect(importes).toMatchObject({ estado: "ok", valor: { delPago: "15.00", anterior: "15.00" } });

    const v1 = await registrarPagoAction({ estado: "inicial" }, formulario(conRenglones({ delPago: true, anterior: true })));
    expect(v1.estado).toBe("confirmar");
    if (v1.estado === "confirmar") {
      expect(v1.error.mensaje).toMatch(/se condonan \$ 15,00 del interés de este atraso y \$ 15,00 de interés anterior/);
    }
    const v2 = await registrarPagoAction(v1 as never, confirmando(v1));
    if (v2.estado !== "ok") throw new Error(JSON.stringify(v2));
    expect(v2.valor).toMatchObject({ interesCondonadoDelPago: "15.00", interesCondonadoAnterior: "15.00", aCapital: "1000.00" });
    expect(await saldoUf()).toBe("0.00");

    // La lectura del estado de cuenta trae las dos partes, y el «Listo:» las dice igual que el registro.
    const [pago] = await pagosDeLaUnidad();
    expect(pago).toMatchObject({ interesCondonado: "30.00", interesCondonadoAnterior: "15.00" });
    expect(listoDelPago(pago!)).toBe(listoDelPago(v2.valor));
    expect(listoDelPago(pago!)).toMatch(/no se cobraron \$ 15,00 de interés de este atraso y \$ 15,00 de interés anterior\.$/);
  });

  it("anular desde el diálogo: el saldo «después» es el que deja la base, con las dos condonaciones anuladas", async () => {
    const [pago] = await pagosDeLaUnidad();
    const resumen = resumenDeAnulacion(pago!, (await saldoUf()) as never);
    expect(resumen.lineas.some((l) => l.includes("Esas condonaciones también se anulan"))).toBe(true);
    const r = await anularPagoAction({ estado: "inicial" }, formulario({ pagoId: pago!.id, motivo: "La transferencia vino rebotada" }));
    expect(r.estado).toBe("ok");
    expect(await saldoUf()).toBe(resumen.saldoDespues);
    expect(await saldoUf()).toBe("1030.00");
    expect(await saldoDelEstadoDeCuenta()).toBe(await saldoUf());
  });

  it("un renglón destildado se cobra: solo el de este atraso", async () => {
    await conInteresAnterior();
    const v1 = await registrarPagoAction({ estado: "inicial" }, formulario(conRenglones({ delPago: true, anterior: false })));
    const v2 = await registrarPagoAction(v1 as never, confirmando(v1));
    if (v2.estado !== "ok") throw new Error(JSON.stringify(v2));
    // «Capital primero»: los $ 1.000 van a capital y el interés anterior queda adeudado.
    expect(v2.valor).toMatchObject({ interesCondonadoDelPago: "15.00", interesCondonadoAnterior: "0.00", aCapital: "1000.00", aInteres: "0.00" });
    expect(await saldoUf()).toBe("15.00");
  });

  it("con la casilla marcada y los dos renglones destildados, no se registra nada: pide marcar uno", async () => {
    await conInteresAnterior();
    const antes = await pagosDeLaUnidad(); // el pago de enero, del escenario
    const r = await registrarPagoAction({ estado: "inicial" }, formulario(conRenglones({ delPago: false, anterior: false })));
    expect(r.estado).toBe("campos");
    if (r.estado === "campos") expect(r.campos["noCobrarInteresDelPago"]?.[0]).toMatch(/Marcá qué interés no se cobra/);
    expect(await pagosDeLaUnidad()).toEqual(antes);
    expect(await saldoUf()).toBe("1015.00");
  });
});
