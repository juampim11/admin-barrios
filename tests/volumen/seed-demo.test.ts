/**
 * Humo del seed de la demo (encargo 9, PR 1 §1): `pnpm db:seed` deja **al menos un registro de cada
 * estado** que hace falta para recorrer cada pantalla, y correrlo dos veces no duplica nada.
 *
 * Va en el proyecto `volumen` y no en `db` porque siembra unas 2.000 unidades (unos 45 segundos por
 * corrida): es el paso del gate que ya paga los tiempos largos. Corre el script de verdad, en un
 * proceso aparte y con `APP_ENTORNO=local` (la base del gate es efímera: es desarrollo), y después
 * cuenta con la conexión de dueño, acotado a la administración de la demo (id fijo).
 *
 * Lo que cuenta es la lista a–f del encargo: proveedores activos e inactivos; órdenes de pago
 * pendientes (2), aprobada, pagada, rechazada con motivo y anulada con su ajuste en el borrador;
 * gastos del borrador a mano y de una orden; un mes emitido con sello y el mes en curso en borrador;
 * pagos en término, tardío con interés cobrado, con «No cobrar interés» y anulado (sin imputaciones
 * vivas), y unidades con deuda vencida; un cargo vigente y uno anulado. Y en Los Aromos **y** en Las
 * Cortaderas, que son los barrios del recorrido.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { poolAdmin } from "../../packages/data/test/helpers.ts";

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ADMINISTRACION_DEMO = "00000000-0000-4000-9000-000000000001";

/** Corre `pnpm db:seed` tal cual (el mismo script, desde su paquete). */
const sembrar = (): void => {
  execFileSync(process.execPath, ["./scripts/seed-demo.ts"], {
    cwd: resolve(raiz, "packages/data"),
    env: { ...process.env, APP_ENTORNO: "local" },
    stdio: "pipe",
    timeout: 400_000,
  });
};

/** Una fila por barrio de la demo, con cada cantidad que el encargo pide sembrar. */
const CONTEOS = `
  with demo as (
    select n.id, n.nombre from tenant_node n where n.parent_id = $1 and n.tipo = 'barrio'
  )
  select d.nombre,
    (select count(*) from proveedor p where p.barrio_id = d.id and p.activo)::int as proveedores_activos,
    (select count(*) from proveedor p where p.barrio_id = d.id and not p.activo)::int as proveedores_inactivos,
    (select count(*) from orden_pago o where o.barrio_id = d.id and o.estado = 'pendiente')::int as op_pendientes,
    (select count(*) from orden_pago o where o.barrio_id = d.id and o.estado = 'aprobada')::int as op_aprobadas,
    (select count(*) from orden_pago o where o.barrio_id = d.id and o.estado = 'pagada')::int as op_pagadas,
    (select count(*) from orden_pago o where o.barrio_id = d.id and o.estado = 'rechazada'
                                         and nullif(btrim(o.motivo_rechazo), '') is not null)::int as op_rechazadas,
    (select count(*) from orden_pago o
       join periodo_expensa origen on origen.id = o.periodo_id and origen.estado = 'emitida'
      where o.barrio_id = d.id and o.estado = 'anulada'
        and exists (select 1 from gasto_periodo g join periodo_expensa pe on pe.id = g.periodo_id
                     where g.orden_pago_id = o.id and g.gasto_periodo_origen_id is not null
                       and g.monto < 0 and pe.estado = 'borrador'))::int as op_anuladas_con_ajuste,
    (select count(*) from gasto_periodo g join periodo_expensa pe on pe.id = g.periodo_id
      where g.barrio_id = d.id and pe.estado = 'borrador' and g.orden_pago_id is null)::int as gastos_manuales_borrador,
    (select count(*) from gasto_periodo g join periodo_expensa pe on pe.id = g.periodo_id
      where g.barrio_id = d.id and pe.estado = 'borrador' and g.orden_pago_id is not null
        and g.gasto_periodo_origen_id is null)::int as gastos_de_op_borrador,
    (select count(*) from periodo_expensa pe where pe.barrio_id = d.id and pe.estado = 'emitida'
                                              and pe.emitida_at is not null and pe.emitida_por is not null)::int as meses_emitidos,
    (select count(*) from periodo_expensa pe where pe.barrio_id = d.id and pe.estado = 'borrador'
                                              and pe.periodo = to_char(current_date, 'YYYY-MM'))::int as mes_en_curso_borrador,
    (select count(*) from pago p where p.barrio_id = d.id and p.anulado_at is null)::int as pagos_vivos,
    (select count(distinct pi.pago_id) from pago_imputacion_interes pi join pago p on p.id = pi.pago_id
      where p.barrio_id = d.id and p.anulado_at is null and pi.anulado_at is null and pi.monto_imputado > 0)::int as pagos_con_interes,
    (select count(*) from interes_condonacion c where c.barrio_id = d.id and c.pago_id is not null)::int as pagos_sin_cobrar_interes,
    (select count(*) from pago p where p.barrio_id = d.id and p.anulado_at is not null
        and not exists (select 1 from pago_imputacion pi where pi.pago_id = p.id and pi.anulado_at is null))::int as pagos_anulados,
    (select count(*) from saldo_uf s where s.barrio_id = d.id and s.saldo_actual > 0
        and exists (select 1 from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
                     where l.unidad_funcional_id = s.unidad_funcional_id and pe.estado = 'emitida'
                       and pe.primer_vencimiento < current_date
                       and not exists (select 1 from pago_imputacion pi
                                        where pi.liquidacion_id = l.id and pi.anulado_at is null)))::int as unidades_con_deuda_vencida,
    (select count(*) from concepto_boleta_unidad c join periodo_expensa pe on pe.id = c.periodo_id
      where pe.barrio_id = d.id and pe.estado = 'borrador' and c.anulado_at is null)::int as cargos_vigentes,
    (select count(*) from concepto_boleta_unidad c join periodo_expensa pe on pe.id = c.periodo_id
      where pe.barrio_id = d.id and c.anulado_at is not null)::int as cargos_anulados,
    (select count(*) from unidad_funcional u where u.barrio_id = d.id)::int as unidades
  from demo d order by d.nombre`;

type Conteo = Record<string, number | string>;

let admin: ReturnType<typeof poolAdmin>;
let primera: Conteo[];
let segunda: Conteo[];

const delBarrio = (conteos: Conteo[], parte: string): Conteo => {
  const fila = conteos.find((c) => String(c["nombre"]).includes(parte));
  if (!fila) throw new Error(`el seed no sembró ${parte}`);
  return fila;
};

beforeAll(async () => {
  admin = poolAdmin();
  sembrar();
  primera = (await admin.query<Conteo>(CONTEOS, [ADMINISTRACION_DEMO])).rows;
  sembrar();
  segunda = (await admin.query<Conteo>(CONTEOS, [ADMINISTRACION_DEMO])).rows;
});

afterAll(async () => {
  await admin.end();
});

describe("seed de la demo (encargo 9, PR 1 §1)", () => {
  it("es idempotente: dos corridas dejan exactamente lo mismo, con una sola administración demo", async () => {
    expect(segunda).toEqual(primera);
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from tenant_node where tipo = 'administrador' and (id = $1 or nombre like 'Estudio Demo%')",
      [ADMINISTRACION_DEMO],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it.each(["Los Aromos", "Las Cortaderas"])("%s tiene al menos un registro de cada estado del recorrido", (barrio) => {
    const c = delBarrio(segunda, barrio);
    // a. Catálogo de proveedores: 6 a 8, uno inactivo.
    expect(Number(c["proveedores_activos"]) + Number(c["proveedores_inactivos"])).toBeGreaterThanOrEqual(6);
    expect(Number(c["proveedores_activos"]) + Number(c["proveedores_inactivos"])).toBeLessThanOrEqual(8);
    expect(c["proveedores_inactivos"]).toBeGreaterThanOrEqual(1);
    // b. Órdenes de pago en todos los estados.
    expect(c["op_pendientes"]).toBeGreaterThanOrEqual(2);
    expect(c["op_aprobadas"]).toBeGreaterThanOrEqual(1);
    expect(c["op_pagadas"]).toBeGreaterThanOrEqual(1);
    expect(c["op_rechazadas"]).toBeGreaterThanOrEqual(1);
    expect(c["op_anuladas_con_ajuste"]).toBeGreaterThanOrEqual(1);
    // c. Gastos del borrador: a mano y de órdenes de pago.
    expect(c["gastos_manuales_borrador"]).toBeGreaterThanOrEqual(1);
    expect(c["gastos_de_op_borrador"]).toBeGreaterThanOrEqual(1);
    // d. Un mes emitido con sello y el mes en curso en borrador.
    expect(c["meses_emitidos"]).toBeGreaterThanOrEqual(1);
    expect(c["mes_en_curso_borrador"]).toBe(1);
    // e. Pagos: al día, anulado y unidades con deuda vencida para un pago tardío en vivo.
    expect(c["pagos_vivos"]).toBeGreaterThanOrEqual(2);
    expect(c["pagos_anulados"]).toBeGreaterThanOrEqual(1);
    expect(c["unidades_con_deuda_vencida"]).toBeGreaterThanOrEqual(1);
    // f. Un cargo vigente y uno anulado.
    expect(c["cargos_vigentes"]).toBeGreaterThanOrEqual(1);
    expect(c["cargos_anulados"]).toBeGreaterThanOrEqual(1);
  });

  it("Los Aromos tiene el pago tardío con interés cobrado y el de «No cobrar interés»", () => {
    // Las Cortaderas no cobra interés (su configuración), así que estos dos casos viven en Los Aromos.
    const c = delBarrio(segunda, "Los Aromos");
    expect(c["pagos_con_interes"]).toBeGreaterThanOrEqual(1);
    expect(c["pagos_sin_cobrar_interes"]).toBeGreaterThanOrEqual(1);
  });
});
