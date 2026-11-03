/**
 * El escenario de las pruebas de volumen (BL-016): un barrio de **700 UF** —el más grande de los que
 * tiene que aguantar la demo y el piloto— con padrón, titulares, coeficientes cerrados y un mes de
 * gastos, armado en lote por la conexión de dueño. No depende del seed de la demo: el CI no lo corre,
 * y una prueba de volumen que dependiera de datos sembrados a mano mediría otra cosa en cada máquina.
 *
 * Todo queda colgado de los barrios del árbol de prueba y se borra acotado a ellos (BL-004: la base
 * de los tests es la misma que la de la demo).
 */
import { borrarArbol, borrarParametrosDe, crearArbol, crearBarrio, poolAdmin, type Arbol } from "../../packages/data/test/helpers.ts";

type Pool = ReturnType<typeof poolAdmin>;

export const UNIDADES = 700;

export type Escenario = {
  readonly arbol: Arbol;
  readonly barrioId: string;
  readonly periodoId: string;
  /** `admin_barrio` del barrio: la identidad con la que la aplicación genera, emite y lee. */
  readonly usuario: string;
};

/** Monto de gastos del mes: unos $ 220.000 por unidad, el orden de magnitud real. */
const GASTOS: ReadonlyArray<readonly [string, string, "ordinaria" | "extraordinaria"]> = [
  ["Seguridad y vigilancia", "79800000.00", "ordinaria"],
  ["Mantenimiento de espacios verdes", "21700000.00", "ordinaria"],
  ["Recolección de residuos", "11450000.00", "ordinaria"],
  ["Personal de mantenimiento", "9150000.00", "ordinaria"],
  ["Energía eléctrica de espacios comunes", "5840000.00", "ordinaria"],
  ["Honorarios de administración", "4720000.00", "ordinaria"],
  ["Comisiones de medios de pago", "1970000.00", "ordinaria"],
];

export async function armarEscenario(admin: Pool, periodo: string): Promise<Escenario> {
  const arbol = await crearArbol(admin);
  const barrioId = arbol.barrioA1.id;
  await crearBarrio(admin, barrioId, { figuraJuridica: "asociacion_civil", adecuadoArt2075: "no_aplica" });
  await admin.query("update barrio set denominacion_concepto = 'cuota social' where barrio_id = $1", [barrioId]);

  const { rows: ufs } = await admin.query<{ id: string }>(
    `insert into unidad_funcional (barrio_id, manzana, lote, estado_unidad, superficie_m2)
     select $1, ((g - 1) / 25 + 1)::text, ((g - 1) % 25 + 1)::text,
            (case when g % 12 = 0 then 'baldio' else 'construido' end)::app.estado_unidad, 450 + (g * 37) % 700
       from generate_series(1, $2::int) g order by g
     returning id`,
    [barrioId, UNIDADES],
  );
  const ids = ufs.map((u) => u.id);
  const { rows: obligados } = await admin.query<{ id: string }>(
    `insert into obligado (barrio_id, nombre, tipo_documento, numero_documento, email)
     select $1, 'Titular de prueba ' || g, 'DNI', (30000000 + g)::text, 'titular' || g || '@ejemplo.test'
       from generate_series(1, $2::int) g order by g
     returning id`,
    [barrioId, UNIDADES],
  );
  await admin.query(
    `insert into unidad_obligado (barrio_id, unidad_funcional_id, obligado_id, tipo, desde, es_notificado)
     select $1, u, o, 'propietario', current_date - 400, true from unnest($2::uuid[], $3::uuid[]) as x(u, o)`,
    [barrioId, ids, obligados.map((o) => o.id)],
  );

  // Coeficientes iguales que suman exactamente 1: el resto va a la última unidad.
  const { rows: ver } = await admin.query<{ id: string }>(
    "insert into coeficiente_version (barrio_id, base, vigente_desde) values ($1, 'parte_indivisa', current_date - 400) returning id",
    [barrioId],
  );
  const parte = Math.floor(1_000_000_000 / UNIDADES);
  const valores = ids.map((_, i) =>
    ((i === ids.length - 1 ? 1_000_000_000 - parte * (ids.length - 1) : parte) / 1_000_000_000).toFixed(9),
  );
  await admin.query(
    `insert into coeficiente (barrio_id, version_id, unidad_funcional_id, valor)
     select $1, $2, u, v::numeric from unnest($3::uuid[], $4::text[]) as x(u, v)`,
    [barrioId, ver[0]!.id, ids, valores],
  );
  await admin.query("update coeficiente_version set cerrada = true where id = $1", [ver[0]!.id]);

  const { rows: per } = await admin.query<{ id: string }>(
    `insert into periodo_expensa (barrio_id, periodo, primer_vencimiento, segundo_vencimiento)
     values ($1, $2, current_date + 10, current_date + 20) returning id`,
    [barrioId, periodo],
  );
  const periodoId = per[0]!.id;
  for (const [nombre, monto, tipo] of GASTOS) {
    const { rows: c } = await admin.query<{ id: string }>(
      "insert into concepto (barrio_id, nombre, tipo, clasificacion_fiscal) values ($1, $2, $3, 'sin_clasificar') returning id",
      [barrioId, nombre, tipo],
    );
    await admin.query(
      "insert into gasto_periodo (barrio_id, periodo_id, concepto_id, descripcion, monto) values ($1, $2, $3, $4, $5)",
      [barrioId, periodoId, c[0]!.id, nombre, monto],
    );
  }
  return { arbol, barrioId, periodoId, usuario: arbol.usuarios.adminBarrioA1 };
}

/** Borra todo lo del escenario, acotado a sus barrios. Las tablas se leen del catálogo, como el seed. */
export async function desarmarEscenario(admin: Pool, escenario: Escenario): Promise<void> {
  const barrios = [escenario.arbol.barrioA1.id, escenario.arbol.barrioA2.id, escenario.arbol.barrioB1.id];
  const { rows } = await admin.query<{ tabla: string }>(
    `select c.table_name as tabla from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'barrio_id' and t.table_type = 'BASE TABLE'`,
  );
  const conexion = await admin.connect();
  try {
    // `set local` dentro de una transacción: si un `delete` falla, el modo mantenimiento no vuelve
    // prendido a la pool (revisión de seguridad).
    await conexion.query("begin");
    await conexion.query("set local session_replication_role = replica");
    for (const { tabla } of rows) {
      await conexion.query(`delete from ${tabla} where barrio_id = any($1::uuid[])`, [barrios]);
    }
    await conexion.query("commit");
  } catch (e) {
    await conexion.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    conexion.release();
  }
  await borrarParametrosDe(admin, [escenario.arbol.adminA.id, ...barrios]);
  await borrarArbol(admin, escenario.arbol);
}

/** Mide una operación: duración en ms y el pico de memoria residente del proceso mientras corría. */
export async function medir<T>(fn: () => Promise<T>): Promise<{ resultado: T; ms: number; picoRssMb: number }> {
  let pico = process.memoryUsage().rss;
  const muestreo = setInterval(() => {
    pico = Math.max(pico, process.memoryUsage().rss);
  }, 50);
  const inicio = performance.now();
  try {
    const resultado = await fn();
    return { resultado, ms: Math.round(performance.now() - inicio), picoRssMb: Math.round(pico / 1024 / 1024) };
  } finally {
    clearInterval(muestreo);
  }
}

/** Una línea por medición, para sacar los topes de las corridas (docs/devops/tiempos-del-gate.md). */
export function anotar(prueba: string, datos: Record<string, number>): void {
  console.log(`[volumen] ${prueba} ${Object.entries(datos).map(([k, v]) => `${k}=${v}`).join(" ")}`);
}
