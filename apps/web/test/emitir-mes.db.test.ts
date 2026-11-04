/**
 * «Emitir N boletas» desde la pantalla (T2, D1), contra Postgres real: la acción de verdad con el
 * `FormData` que manda el navegador, y el reenvío de `PedidoDeConfirmacion` cuando cambió algo desde la
 * vista previa. Lo único doblado es la sesión (la administradora del barrio, bajo RLS).
 *
 * Correr con: pnpm vitest run --project db apps/web/test/emitir-mes.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { nuevoToken } from "@admin-barrios/almacenamiento";
import { boletasDelMes } from "@admin-barrios/data/servicios/circuito-del-mes";
import { emitirPeriodo, generarLiquidaciones } from "@admin-barrios/data/servicios/liquidacion";
import { registrarEImputarPago } from "@admin-barrios/data/servicios/deuda";
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
let uf: string;
let febrero: string;

const barrio = () => arbol.barrioA1.id;

vi.mock("../src/servidor/db.ts", () => ({
  conSesion: <T>(fn: (tx: DbRequest) => Promise<T>) => conUsuario(db, arbol.usuarios.adminBarrioA1, fn),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", async (original) => ({ ...(await original<object>()), redirect: () => undefined }));

const { emitirMesAction } = await import("../src/acciones/liquidacion.ts");

const formulario = (valores: ValoresDeFormulario): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(valores)) f.append(k, v);
  return f;
};

/** Lo que reemite `PedidoDeConfirmacion` cuando la persona marca la casilla y confirma. */
const confirmando = (r: ResultadoDeAccion<unknown>): FormData => {
  if (r.estado !== "confirmar") throw new Error(`se esperaba un pedido de confirmación: ${JSON.stringify(r)}`);
  return formulario({
    ...Object.fromEntries(Object.entries(r.valores).filter(([clave]) => !CAMPOS_DE_CONFIRMACION.has(clave))),
    [CAMPO_CODIGO_CONFIRMADO]: r.error.codigo,
    ...(r.error.datos["cifras"] !== undefined ? { [CAMPO_CIFRAS_CONFIRMADAS]: r.error.datos["cifras"] } : {}),
    [CAMPO_CONFIRMO]: VALOR_CONFIRMO,
  });
};

const estado = async () =>
  (await admin.query<{ e: string }>("select estado::text as e from periodo_expensa where id = $1", [febrero])).rows[0]!.e;

beforeAll(async () => {
  admin = poolAdmin();
  appPool = poolApp();
  db = dbDe(appPool);
  arbol = await crearArbol(admin);
  await crearBarrio(admin, barrio(), { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  const { rows: u } = await admin.query<{ id: string }>(
    "insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad) values ($1,'1','1','construido') returning id",
    [barrio()],
  );
  uf = u[0]!.id;
  const { rows: v } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', '2000-01-01') returning id",
    [barrio()],
  );
  await admin.query("insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor) values ($1,$2,$3,1)", [barrio(), v[0]!.id, uf]);
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [v[0]!.id]);
  const { rows: c } = await admin.query<{ id: string }>(
    "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, 'Vigilancia', 'ordinaria', 'sin_clasificar') returning id",
    [barrio()],
  );
  await borrarParametrosDe(admin, [barrio()]);
  for (const [clave, valor] of [
    ["interes.cobra", true], ["interes.tasa_compensatoria", "0.03"], ["interes.tasa_punitoria", "0"], ["interes.gracia_dias", 0],
    ["interes.forma_gracia", "corre_inicio"], ["interes.tolerancia", "0.00"], ["imputacion.orden", "intereses_primero_capital_antiguo"],
  ] as const) {
    await cargarParametro(admin, barrio(), clave, valor);
  }
  const periodo = async (mes: string) => {
    const { rows } = await admin.query<{ id: string }>(
      "insert into periodo_expensa (barrio_id, periodo, primer_vencimiento) values ($1, $2, $3) returning id",
      [barrio(), mes, `${mes}-10`],
    );
    await admin.query("insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, 'Vigilancia', '1000.00')", [
      barrio(), rows[0]!.id, c[0]!.id,
    ]);
    return rows[0]!.id;
  };
  const enero = await periodo("2025-01");
  await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => generarLiquidaciones(tx, { periodoId: enero, origenSaldo: "calculado", fechaCorteMora: "2025-01-01" }));
  await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => emitirPeriodo(tx, { periodoId: enero }));
  febrero = await periodo("2025-02");
});

afterAll(async () => {
  await borrarParametrosDe(admin, [barrio()]);
  await admin.query("set session_replication_role = replica");
  for (const t of ["trabajo", "pago_imputacion_interes", "pago_imputacion", "interes_devengado", "saldo_uf", "pago", "item_liquidacion", "liquidacion",
    "gasto_periodo", "periodo_expensa", "concepto", "coeficiente", "coeficiente_version", "unidad_funcional", "codigo_pago_secuencia",
    "barrio_atributo_vigencia", "barrio"]) {
    await admin.query(`delete from ${t} where barrio_id = $1`, [barrio()]);
  }
  await admin.query("set session_replication_role = origin");
  await borrarArbol(admin, arbol);
  await Promise.all([admin.end(), appPool.end()]);
});

describe("«Emitir N boletas» cuando cambió algo desde la vista previa (D1)", () => {
  it("pide confirmar la diferencia con una casilla; confirmada, emite con las cifras de ahora", async () => {
    const vista = await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) => boletasDelMes(tx, { periodoId: febrero }));
    if (vista.estado !== "vista_previa") throw new Error(vista.estado);
    await conUsuario(db, arbol.usuarios.adminBarrioA1, (tx) =>
      registrarEImputarPago(tx, {
        pago: { unidadFuncionalId: uf, obligadoId: null, monto: "300.00", fecha: "2025-02-03", origen: "manual", comprobanteAdjunto: `barrios/${barrio()}/pagos/comprobantes/${nuevoToken()}.pdf` },
        confirmarPagoConInteres: true,
        noCobrarInteres: null,
      }),
    );

    const v1 = await emitirMesAction({ estado: "inicial" }, formulario({ periodoId: febrero, huellaVista: vista.huella, vistaCalculadaEl: vista.calculadaEl }));
    expect(v1.estado).toBe("confirmar");
    if (v1.estado === "confirmar") {
      expect(v1.confirmacion.titulo).toBe("Cambió desde la vista previa.");
      expect(v1.error.mensaje).toMatch(/entró 1 pago\. El total pasa de \$ /);
    }
    expect(await estado()).toBe("borrador");

    const v2 = await emitirMesAction(v1 as never, confirmando(v1));
    expect(v2, JSON.stringify(v2)).toMatchObject({ estado: "ok" });
    expect(await estado()).toBe("emitida");
  });

  it("sin la casilla, no emite", async () => {
    // Ya emitido por el caso anterior: emitir otra vez se rechaza (una sola emisión).
    const r = await emitirMesAction({ estado: "inicial" }, formulario({ periodoId: febrero, huellaVista: "x" }));
    expect(r.estado).toBe("falla");
    if (r.estado === "falla") expect(r.error.codigo).toBe("periodo_no_editable");
  });
});
