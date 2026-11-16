/**
 * «Cómo se devenga» (encargo 16, Etapa 1.3): la configuración por barrio y por mes, la bonificación
 * por pago en término que se aplica sola, y sus excepciones.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * DÓNDE VIVE CADA COSA
 *
 * - **La configuración** vive en `parametro_valor` (ADR-0006): siete claves del barrio, con vigencia
 *   desde el primer día de un mes, solo se agregan y cada fila lleva motivo y firma. Qué rige en un mes
 *   lo contesta la base (`app.parametro_resuelto`), como con la mora: acá no hay una segunda regla.
 * - **Sin valor cargado, todo sigue como antes del encargo** (`porDefecto`): por eso ningún barrio
 *   existente cambia.
 * - **La bonificación es un `concepto_boleta` de clase descuento**, con su valor versionado, y cada
 *   unidad que la recibe tiene su `concepto_boleta_unidad` con origen `regla_barrio`. `app.cbu_antes`
 *   no cambió: firma con quien emite y aplica los topes del operador, igual que un descuento a mano.
 * - **Lo que se usó queda congelado en el período** al emitir (`periodo_expensa.cupon_cobra`,
 *   `bonificacion_*`), y las excepciones también (`app.periodo_editable`).
 *
 * El cálculo del importe NO está acá: lo resuelve la base (`app.resolver_aplicaciones`), contra la
 * expensa común de la propia liquidación (cuota fija + ordinarias).
 */

import { sql } from "drizzle-orm";
import { formatearMonto, sumarMontos, type Monto } from "@admin-barrios/shared/dinero";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { formatearFecha, nombreDelPeriodo } from "@admin-barrios/shared/fechas";
import { consultaBarrioSchema, idSchema } from "@admin-barrios/shared/consultas";
import type { ModeloExpensa } from "@admin-barrios/shared/liquidacion";
import {
  cambiarComoSeDevengaSchema,
  inicialDeBarrioNuevo,
  modeloDeOrigen,
  NOMBRE_BONIFICACION,
  ponerExcepcionDeBonificacionSchema,
  porDefecto,
  recibeBonificacion,
  REGLA_BONIFICACION,
  sacarExcepcionDeBonificacionSchema,
  textoDePorcentaje,
  type CambiarComoSeDevenga,
  type ComoSeDevenga,
  type FormaBonificacion,
  type ModoBonificacion,
  type PonerExcepcionDeBonificacion,
  type SacarExcepcionDeBonificacion,
  type TipoExcepcionBonificacion,
  type ValorDeBonificacion,
} from "@admin-barrios/shared/devengado";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar, rechazarPeriodoInaccesible, traducirError } from "../errores.ts";
import { ORDEN_NATURAL_U } from "./orden-de-unidades.ts";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Qué rige en un mes
// ────────────────────────────────────────────────────────────────────────────────────────────────

const CLAVES = [
  "devengado.origen",
  "devengado.reparto",
  "cupon.cobra",
  "bonificacion.modo",
  "bonificacion.forma",
  "bonificacion.valor",
  "bonificacion.tope",
] as const;
type Clave = (typeof CLAVES)[number];

/** Lo que rige en un mes, y qué parte salió de un valor cargado (el resto es el comportamiento anterior). */
export type ComoSeDevengaDelMes = ComoSeDevenga & {
  /** Hay al menos un valor cargado que rige en ese mes. */
  readonly cargado: boolean;
  /** El origen lo cargó la administración: el modelo del mes sale de ahí y no de `modelo_liquidacion`. */
  readonly origenCargado: boolean;
  readonly repartoCargado: boolean;
};

/** Los valores crudos que rigen en el barrio a una fecha, por clave. Sin fila → la clave no está. */
async function valoresA(tx: DbConIdentidad, barrioId: string, fecha: string): Promise<Map<Clave, unknown>> {
  // `app.parametro_resuelto` LANZA si el barrio no se ve. Acá un barrio ajeno no es un error: es un
  // barrio sin nada cargado, y quien llama sigue hasta donde lo frene la RLS de lo que vaya a escribir
  // (un alta de período en un barrio ajeno tiene que rebotar en su policy, como siempre).
  const { rows: visible } = await tx.execute<{ ok: boolean }>(sql`select app.puede_leer_parametros(${barrioId}::uuid) as ok`);
  if (visible[0]?.ok !== true) return new Map();
  const { rows } = await tx.execute<{ clave: Clave; valor: unknown }>(sql`
    select r.clave, x.valor
      from parametro_registro r
     cross join lateral app.parametro_resuelto(${barrioId}::uuid, r.clave, ${fecha}::date) x
     where r.solo_barrio
  `);
  return new Map(rows.filter((r) => r.valor !== null).map((r) => [r.clave, r.valor]));
}

/** El modelo con que el barrio liquida si no cargó «Cómo se devenga»: la regla de siempre. */
async function modeloDelBarrio(tx: DbConIdentidad, barrioId: string): Promise<ModeloExpensa> {
  const { rows } = await tx.execute<{ modelo: ModeloExpensa }>(sql`
    select coalesce(b.modelo_liquidacion,
                    (select p.modelo from periodo_expensa p where p.barrio_id = b.barrio_id order by p.periodo desc limit 1),
                    'variable'::app.modelo_expensa)::text as modelo
      from barrio b where b.barrio_id = ${barrioId}
  `);
  return rows[0]?.modelo ?? "variable";
}

function armar(valores: Map<Clave, unknown>, modelo: ModeloExpensa): ComoSeDevengaDelMes {
  const base = porDefecto(modelo);
  const texto = (c: Clave) => (typeof valores.get(c) === "string" ? (valores.get(c) as string) : null);
  const origen = (texto("devengado.origen") as ComoSeDevenga["origen"] | null) ?? base.origen;
  // Sin reparto cargado, el del origen que rige: un importe por unidad si lo define la administración,
  // por coeficiente si son los gastos del mes.
  const reparto =
    (texto("devengado.reparto") as ComoSeDevenga["reparto"] | null) ?? porDefecto(modeloDeOrigen(origen)).reparto;
  const forma = texto("bonificacion.forma") as FormaBonificacion | null;
  const valor = texto("bonificacion.valor");
  const tope = texto("bonificacion.tope") as Monto | null;
  const cuanto: ValorDeBonificacion | null =
    forma !== null && valor !== null ? { forma, valor, tope: forma === "porcentaje" ? tope : null } : null;
  return {
    origen,
    reparto,
    cuponCobra: (texto("cupon.cobra") as ComoSeDevenga["cuponCobra"] | null) ?? base.cuponCobra,
    bonificacion: { modo: (texto("bonificacion.modo") as ModoBonificacion | null) ?? base.bonificacion.modo, cuanto },
    cargado: valores.size > 0,
    origenCargado: valores.has("devengado.origen"),
    repartoCargado: valores.has("devengado.reparto"),
  };
}

/** Cómo se devenga un mes (`YYYY-MM`) en el barrio: lo cargado que rige ese mes, y el resto como antes. */
export async function comoSeDevengaEn(
  tx: DbConIdentidad,
  parametros: { readonly barrioId: string; readonly mes: string },
): Promise<ComoSeDevengaDelMes> {
  const valores = await valoresA(tx, parametros.barrioId, `${parametros.mes}-01`);
  return armar(valores, await modeloDelBarrio(tx, parametros.barrioId));
}

/**
 * El modelo con que se abre un mes: el del origen cargado que rige ese mes; si no hay, `null` y quien
 * abre el mes usa la regla de siempre (`barrio.modelo_liquidacion`, o el del último período).
 */
export async function modeloDelMesSegunDevengado(
  tx: DbConIdentidad,
  parametros: { readonly barrioId: string; readonly mes: string },
): Promise<ModeloExpensa | null> {
  const valores = await valoresA(tx, parametros.barrioId, `${parametros.mes}-01`);
  const origen = valores.get("devengado.origen");
  return origen === "administracion" || origen === "gastos" ? modeloDeOrigen(origen) : null;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El panel «Cómo se devenga»
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Un cambio guardado, para el historial del panel. */
export type CambioDeDevengado = {
  /** `YYYY-MM`: el mes desde el que rige. */
  readonly rigeDesde: string;
  readonly clave: Clave;
  /** `null` = desde ese mes vuelve a ser como antes de configurar. */
  readonly valor: string | null;
  readonly motivo: string;
  readonly cargoNombre: string | null;
  /** `YYYY-MM-DD` en la hora del barrio. */
  readonly cargadoEl: string;
};

export type PanelDeDevengado = {
  readonly barrio: { readonly id: string; readonly nombre: string; readonly unidades: number };
  readonly puedeEditar: boolean;
  /** El mes en curso en la hora del barrio, `YYYY-MM`. */
  readonly mesEnCurso: string;
  /** El primer mes que se ofrece: el siguiente al último emitido; si el barrio no emitió nada, el mes en curso. */
  readonly primerMesEditable: string;
  /** El último mes emitido, `YYYY-MM`, o `null` si el barrio no emitió nada. */
  readonly ultimoMesEmitido: string | null;
  /** Lo que rige en `primerMesEditable`: es lo que el formulario muestra para cambiar. */
  readonly vigente: ComoSeDevengaDelMes;
  /** Cambios que rigen desde un mes posterior a `primerMesEditable`. */
  readonly programados: readonly { readonly rigeDesde: string; readonly config: ComoSeDevengaDelMes }[];
  readonly historial: readonly CambioDeDevengado[];
  /** Para el ejemplo del punto 2: lo que hoy se cobra, si el barrio define el importe. */
  readonly referencia: {
    /** La cuota de todas las unidades, cuando es una sola. */
    readonly importePorUnidad: Monto | null;
    /** El total del mes: el definido por coeficiente, o la suma de las cuotas por unidad. */
    readonly totalDelMes: Monto | null;
  };
};

/** Lo que muestra el panel de Configuración. `null` si el barrio no es accesible. */
export async function leerComoSeDevenga(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<PanelDeDevengado | null> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);
  const { rows } = await tx.execute<{
    id: string;
    nombre: string;
    unidades: number;
    mes: string;
    ultimo_emitido: string | null;
    puede: boolean;
    total_definido: string | null;
    importe_unico: string | null;
    total_por_unidad: string | null;
  }>(sql`
    with v as (
      select cv.id, cv.total_del_mes
        from cuota_fija_version cv join barrio b on b.barrio_id = cv.barrio_id
       where cv.barrio_id = ${barrioId} and cv.vigente_desde <= (now() at time zone b.zona_horaria)::date
       order by cv.vigente_desde desc, cv.created_at desc limit 1
    )
    select n.id, n.nombre,
           (select count(*)::int from unidad_funcional u where u.barrio_id = b.barrio_id and u.baja_at is null) as unidades,
           to_char(now() at time zone b.zona_horaria, 'YYYY-MM') as mes,
           (select max(p.periodo) from periodo_expensa p where p.barrio_id = b.barrio_id and p.estado in ('emitida', 'distribuida')) as ultimo_emitido,
           app.puede_editar_parametros(b.barrio_id) as puede,
           (select total_del_mes::numeric(14,2)::text from v) as total_definido,
           (select case when count(distinct c.importe) = 1 then min(c.importe)::numeric(14,2)::text end
              from cuota_fija c join unidad_funcional u on u.id = c.unidad_funcional_id and u.baja_at is null
             where c.version_id = (select id from v)) as importe_unico,
           (select sum(c.importe)::numeric(14,2)::text
              from cuota_fija c join unidad_funcional u on u.id = c.unidad_funcional_id and u.baja_at is null
             where c.version_id = (select id from v)) as total_por_unidad
      from barrio b join tenant_node n on n.id = b.barrio_id
     where b.barrio_id = ${barrioId} and n.deleted_at is null
  `);
  const f = rows[0];
  if (!f) return null;

  const siguiente = (mes: string): string => {
    const [a = 0, m = 0] = mes.split("-").map(Number);
    return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
  };
  // Lo emitido no se toca: el primer mes que se ofrece es el que sigue al último emitido (que puede
  // ser anterior al mes en curso si el barrio va atrasado); sin nada emitido, el mes en curso.
  const primerMesEditable = f.ultimo_emitido === null ? f.mes : siguiente(f.ultimo_emitido);

  const modelo = await modeloDelBarrio(tx, barrioId);
  const vigente = armar(await valoresA(tx, barrioId, `${primerMesEditable}-01`), modelo);

  const filas = (
    await tx.execute<{ clave: Clave; valor: unknown; rige: string; motivo: string; cargo: string | null; cargado_el: string }>(sql`
      select v.clave, v.valor, to_char(v.vigente_desde, 'YYYY-MM') as rige, v.motivo,
             (select u.nombre from usuario_demo u where u.user_id = v.creado_por) as cargo,
             to_char(v.created_at at time zone b.zona_horaria, 'YYYY-MM-DD') as cargado_el
        from parametro_valor v
        join parametro_registro r on r.clave = v.clave and r.solo_barrio
        join barrio b on b.barrio_id = v.nodo_id
       where v.nodo_id = ${barrioId}
         and not exists (select 1 from parametro_anulacion a where a.fila_id = v.id)
       order by v.created_at desc, v.orden desc
    `)
  ).rows;

  const mesesProgramados = [...new Set(filas.map((x) => x.rige).filter((m) => m > primerMesEditable))].sort();
  const programados: { rigeDesde: string; config: ComoSeDevengaDelMes }[] = [];
  // En serie: una transacción es una sola conexión (regla 16 del gate).
  for (const m of mesesProgramados) programados.push({ rigeDesde: m, config: armar(await valoresA(tx, barrioId, `${m}-01`), modelo) });

  return {
    barrio: { id: f.id, nombre: f.nombre, unidades: f.unidades },
    puedeEditar: f.puede,
    mesEnCurso: f.mes,
    primerMesEditable,
    ultimoMesEmitido: f.ultimo_emitido,
    vigente,
    programados,
    historial: filas.map((x) => ({
      rigeDesde: x.rige,
      clave: x.clave,
      valor: x.valor === null ? null : String(x.valor),
      motivo: x.motivo,
      cargoNombre: x.cargo,
      cargadoEl: x.cargado_el,
    })),
    referencia: {
      importePorUnidad: (f.importe_unico as Monto | null) ?? null,
      totalDelMes: ((f.total_definido ?? f.total_por_unidad) as Monto | null) ?? null,
    },
  };
}

/**
 * El concepto de la bonificación del barrio, con el valor que rige desde `desde`. Lo crea la primera
 * vez; si el valor cambió, agrega una versión. Devuelve el concepto.
 *
 * El método de un concepto no cambia (`fk_cbv_concepto_metodo`), así que porcentaje e importe fijo son
 * dos conceptos, cada uno con un nombre estable en el catálogo. **Guardar no renombra ni desactiva el
 * otro**: un mes anterior todavía sin emitir lo sigue usando (code-reviewer, 2). En la boleta los dos
 * salen como «Bonificación por pago en término» (lo pone la vista, `vista-boleta.ts`).
 */
async function asegurarConceptoDeBonificacion(
  tx: DbConIdentidad,
  barrioId: string,
  cuanto: ValorDeBonificacion,
  desde: string,
): Promise<string> {
  const metodo = cuanto.forma === "porcentaje" ? "porcentaje" : "monto_fijo";
  const { rows: existentes } = await tx.execute<{ id: string }>(sql`
    select id from concepto_boleta
     where barrio_id = ${barrioId} and regla_barrio = ${REGLA_BONIFICACION} and metodo = ${metodo}::app.metodo_concepto_boleta
  `);
  let conceptoId = existentes[0]?.id ?? null;

  if (conceptoId === null) {
    // El nombre es único en el barrio: uno por método, y distinto de cualquier concepto que el barrio
    // ya tuviera cargado a mano con ese nombre.
    const propuesto = metodo === "porcentaje" ? NOMBRE_BONIFICACION : `${NOMBRE_BONIFICACION} (importe fijo)`;
    const { rows: tomado } = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from concepto_boleta where barrio_id = ${barrioId} and lower(nombre) = lower(${propuesto})
    `);
    const nombre = (tomado[0]?.n ?? 0) > 0 ? `${propuesto} · regla del barrio` : propuesto;
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into concepto_boleta (barrio_id, nombre, clase, metodo, base_calculo, clasificacion_fiscal,
                                   financiamiento, requiere_admin, orden_impresion, regla_barrio)
      values (${barrioId}, ${nombre}, 'descuento', ${metodo}::app.metodo_concepto_boleta,
              ${metodo === "porcentaje" ? "expensa_ordinaria" : "sin_base"}::app.base_calculo_concepto,
              'sin_clasificar', 'absorbe_barrio', false, 0, ${REGLA_BONIFICACION})
      returning id
    `);
    conceptoId = rows[0]?.id ?? null;
    if (conceptoId === null) rechazar("desconocido", "No se pudo crear el concepto de la bonificación.", "Recargá la pantalla y volvé a intentar.");
  }

  const { rows: valores } = await tx.execute<{ vigente_desde: string; porcentaje: string | null; monto_fijo: string | null; tope: string | null; rige: boolean }>(sql`
    select vigente_desde::text, porcentaje::text, monto_fijo::numeric(14,2)::text as monto_fijo, tope::numeric(14,2)::text as tope,
           (vigente_desde <= ${desde}::date and (vigente_hasta is null or vigente_hasta > ${desde}::date)) as rige
      from concepto_boleta_valor where concepto_boleta_id = ${conceptoId}
     order by vigente_desde desc
  `);
  const actual = valores.find((v) => v.rige);
  const igual =
    actual !== undefined &&
    (cuanto.forma === "porcentaje"
      ? actual.porcentaje !== null && Number(actual.porcentaje) === Number(cuanto.valor) && actual.tope === cuanto.tope
      : actual.monto_fijo === cuanto.valor);
  if (!igual) {
    // Las versiones del catálogo van hacia adelante: no se intercala una antes de otra ya cargada.
    const posterior = valores.find((v) => v.vigente_desde > desde);
    if (posterior) {
      rechazar(
        "dato_invalido",
        `La bonificación ya tiene un valor que rige desde ${nombreDelPeriodo(posterior.vigente_desde.slice(0, 7))}, posterior al mes elegido.`,
        "Elegí ese mes o uno posterior para cambiar cuánto se bonifica.",
        { campo: "rigeDesde" },
      );
    }
    await tx.execute(sql`
      insert into concepto_boleta_valor (barrio_id, concepto_boleta_id, metodo, monto_fijo, porcentaje, tope, vigente_desde, aprobada_por)
      values (${barrioId}, ${conceptoId}, ${metodo}::app.metodo_concepto_boleta,
              ${cuanto.forma === "importe" ? cuanto.valor : null}::numeric,
              ${cuanto.forma === "porcentaje" ? cuanto.valor : null}::numeric,
              ${cuanto.forma === "porcentaje" ? cuanto.tope : null}::numeric,
              ${desde}::date, app.current_user_id())
    `);
  }
  return conceptoId;
}

export type DevengadoCambiado = {
  /** Cuántas claves cambiaron de valor. Cero: lo guardado ya era eso. */
  readonly cambios: number;
  readonly rigeDesde: string;
};

/**
 * Guarda «Cómo se devenga» desde un mes. Solo la administración del barrio; el mes no puede estar
 * emitido ni tener un mes emitido después (lo hace cumplir la base, `0079`). Se escriben solo las
 * claves que cambian respecto de lo que regía ese mes: el historial dice qué cambió, no repite todo.
 */
export async function cambiarComoSeDevenga(tx: DbConIdentidad, parametros: CambiarComoSeDevenga): Promise<DevengadoCambiado> {
  const p = cambiarComoSeDevengaSchema.parse(parametros);
  const desde = `${p.rigeDesde}-01`;
  return enBase(async () => {
    const { rows } = await tx.execute<{ puede: boolean; ultimo: string | null }>(sql`
      select app.puede_editar_parametros(b.barrio_id) as puede,
             (select max(x.periodo) from periodo_expensa x where x.barrio_id = b.barrio_id and x.estado in ('emitida', 'distribuida')) as ultimo
        from barrio b where b.barrio_id = ${p.barrioId}
    `);
    const f = rows[0];
    if (!f?.puede) {
      rechazar(
        "sin_permiso",
        "Cómo se devenga lo define la administración del barrio.",
        "Pedíselo a quien administra el barrio. Podés ver lo que rige y su historial, pero no cambiarlo.",
      );
    }
    if (f.ultimo !== null && p.rigeDesde <= f.ultimo) {
      rechazar(
        "devengado_mes_emitido",
        `${nombreDelPeriodo(f.ultimo)} ya está emitido: un cambio no toca lo emitido.`,
        "Elegí un mes posterior al último emitido.",
        { campo: "rigeDesde", ultimoEmitido: f.ultimo },
      );
    }
    // La bonificación que se aplica sola necesita con qué calcularse.
    if (p.bonificacionModo === "sola" && p.cuanto === null) {
      rechazar("dato_invalido", "Para que la bonificación se aplique sola hay que decir cuánto es.", "Completá la forma y el valor.", {
        campo: "bonificacionValor",
      });
    }

    const actuales = await valoresA(tx, p.barrioId, desde);
    const nuevos: Record<Clave, string | null> = {
      "devengado.origen": p.origen,
      "devengado.reparto": p.reparto,
      "cupon.cobra": p.cuponCobra,
      "bonificacion.modo": p.bonificacionModo,
      "bonificacion.forma": p.cuanto?.forma ?? null,
      "bonificacion.valor": p.cuanto?.valor ?? null,
      "bonificacion.tope": p.cuanto?.tope ?? null,
    };
    const cambia = (clave: Clave) => (actuales.has(clave) ? String(actuales.get(clave)) : null) !== nuevos[clave];
    // Forma, valor y tope son UN dato: si cambia alguno, se escriben los tres con la misma vigencia.
    // Escritos por separado, un cambio posterior de uno solo se combinaría con los otros dos de otra
    // fecha y daría una bonificación que nadie eligió (code-reviewer, 4).
    const CUANTO: readonly Clave[] = ["bonificacion.forma", "bonificacion.valor", "bonificacion.tope"];
    const cambiaElCuanto = CUANTO.some(cambia);
    let cambios = 0;
    for (const clave of CLAVES) {
      if (!(CUANTO.includes(clave) ? cambiaElCuanto : cambia(clave))) continue;
      await tx.execute(sql`
        select app.fijar_parametro(${p.barrioId}::uuid, ${clave}, ${JSON.stringify(nuevos[clave])}::jsonb, ${desde}::date, ${p.motivo})
      `);
      cambios++;
    }

    // El concepto del catálogo acompaña al parámetro: la bonificación se cobra con un `concepto_boleta`.
    if (p.cuanto !== null) await asegurarConceptoDeBonificacion(tx, p.barrioId, p.cuanto, desde);

    // Los meses abiertos desde ese mes toman el modelo del origen. Sus vencimientos NO se tocan: se
    // cambian en la ficha del mes («Cambiar»), con su motivo.
    await tx.execute(sql`
      update periodo_expensa
         set modelo = ${modeloDeOrigen(p.origen)}::app.modelo_expensa
       where barrio_id = ${p.barrioId} and estado in ('borrador', 'revisada')
         and periodo >= ${p.rigeDesde} and modelo <> ${modeloDeOrigen(p.origen)}::app.modelo_expensa
    `);
    return { cambios, rigeDesde: p.rigeDesde };
  });
}

/**
 * Lo que `crearBarrio` deja cargado en un barrio nuevo: el origen y el reparto de su modelo, y el
 * cupón que cobra **solo el mes**. Los barrios que ya existían no reciben nada.
 */
export async function sembrarDevengadoDeBarrioNuevo(
  tx: DbConIdentidad,
  parametros: { readonly barrioId: string; readonly modelo: ModeloExpensa; readonly desdeMes: string },
): Promise<void> {
  const inicial = inicialDeBarrioNuevo(parametros.modelo);
  const filas: [Clave, string][] = [
    ["devengado.origen", inicial.origen],
    ["devengado.reparto", inicial.reparto],
    ["cupon.cobra", inicial.cuponCobra],
  ];
  for (const [clave, valor] of filas) {
    await tx.execute(sql`
      select app.fijar_parametro(${parametros.barrioId}::uuid, ${clave}, ${JSON.stringify(valor)}::jsonb,
                                 ${`${parametros.desdeMes}-01`}::date, 'Valor inicial al dar de alta el barrio')
    `);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Quién recibe la bonificación
// ────────────────────────────────────────────────────────────────────────────────────────────────

type FilaSituacion = {
  unidad_funcional_id: string;
  manzana: string;
  lote: string;
  debe: string[] | null;
  saldo_inicial: boolean;
  excepcion: TipoExcepcionBonificacion | null;
  excepcion_motivo: string | null;
  excepcion_por: string | null;
  excepcion_el: string | null;
};

/** La situación de una unidad frente a la bonificación de un mes. */
export type SituacionDeBonificacion = {
  readonly unidadFuncionalId: string;
  readonly etiqueta: string;
  /** Sin deuda vencida a la fecha de evaluación, con los pagos imputados hasta ese momento. */
  readonly alDia: boolean;
  /** Los meses (`YYYY-MM`) con capital vencido pendiente. Vacío si está al día. */
  readonly mesesAdeudados: readonly string[];
  /** Trae deuda de antes de usar el sistema (saldo inicial) que todavía no entró en ninguna boleta. */
  readonly conSaldoInicial: boolean;
  readonly excepcion: {
    readonly tipo: TipoExcepcionBonificacion;
    readonly motivo: string;
    readonly cargoNombre: string | null;
    /** `YYYY-MM-DD` en la hora del barrio. */
    readonly cargadaEl: string;
  } | null;
  readonly recibe: boolean;
};

/**
 * La situación de cada unidad activa **hoy** (la hora del barrio): quién está al día y quién tiene una
 * excepción cargada para el mes.
 *
 * **Estar al día** = no tener capital pendiente de una boleta emitida cuyo primer vencimiento sea
 * anterior a hoy, con los pagos imputados hasta este momento. Lo que todavía no venció no cuenta: la
 * boleta del mes pasado que vence la semana que viene no es deuda vencida. Una unidad que trae deuda
 * de antes del sistema (saldo inicial) y todavía no recibió su primera boleta tampoco está al día.
 */
async function situacionDeLasUnidades(
  tx: DbConIdentidad,
  barrioId: string,
  periodoId: string,
): Promise<{ readonly fecha: string; readonly unidades: SituacionDeBonificacion[] }> {
  const { rows: hoy } = await tx.execute<{ hoy: string }>(sql`
    select (now() at time zone zona_horaria)::date::text as hoy from barrio where barrio_id = ${barrioId}
  `);
  const fecha = hoy[0]?.hoy ?? "";
  const { rows } = await tx.execute<FilaSituacion>(sql`
    with deuda as (
      select l.unidad_funcional_id, array_agg(distinct pe.periodo order by pe.periodo) as debe
        from liquidacion l
        join periodo_expensa pe on pe.id = l.periodo_id
        join app.capitales_pendientes(${barrioId}::uuid) cp on cp.liquidacion_id = l.id
       where l.barrio_id = ${barrioId}
         and pe.id <> ${periodoId}
         and pe.estado in ('emitida', 'distribuida')
         and pe.primer_vencimiento is not null
         and pe.primer_vencimiento < ${fecha}::date
         and cp.pendiente > 0
       group by l.unidad_funcional_id
    ),
    con_boleta as (
      select distinct l.unidad_funcional_id
        from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
       where l.barrio_id = ${barrioId} and pe.estado in ('emitida', 'distribuida') and pe.id <> ${periodoId}
    )
    select u.id as unidad_funcional_id, u.manzana, u.lote, d.debe,
           (u.saldo_inicial > 0 and cb.unidad_funcional_id is null) as saldo_inicial,
           e.tipo as excepcion, e.motivo as excepcion_motivo,
           (select x.nombre from usuario_demo x where x.user_id = e.creado_por) as excepcion_por,
           to_char(e.created_at at time zone b.zona_horaria, 'YYYY-MM-DD') as excepcion_el
      from unidad_funcional u
      join barrio b on b.barrio_id = u.barrio_id
      left join deuda d on d.unidad_funcional_id = u.id
      left join con_boleta cb on cb.unidad_funcional_id = u.id
      left join bonificacion_excepcion e on e.periodo_id = ${periodoId} and e.unidad_funcional_id = u.id
     where u.barrio_id = ${barrioId} and u.baja_at is null
     order by ${ORDEN_NATURAL_U}
  `);
  return {
    fecha,
    unidades: rows.map((r) => {
      const mesesAdeudados = r.debe ?? [];
      const alDia = mesesAdeudados.length === 0 && !r.saldo_inicial;
      return {
        unidadFuncionalId: r.unidad_funcional_id,
        etiqueta: etiquetaUnidad(r.manzana, r.lote),
        alDia,
        mesesAdeudados,
        conSaldoInicial: r.saldo_inicial,
        excepcion:
          r.excepcion === null
            ? null
            : { tipo: r.excepcion, motivo: r.excepcion_motivo ?? "", cargoNombre: r.excepcion_por, cargadaEl: r.excepcion_el ?? "" },
        recibe: recibeBonificacion({ alDia, excepcion: r.excepcion }),
      };
    }),
  };
}

/** El concepto de la regla y su valor para un mes: lo usan la aplicación y la «no aplicada», el mismo. */
async function valorDeLaReglaDelMes(
  tx: DbConIdentidad,
  barrioId: string,
  mes: string,
  forma: FormaBonificacion,
): Promise<{ concepto_id: string; valor_id: string; importe_fijo: string | null } | null> {
  const { rows } = await tx.execute<{ concepto_id: string; valor_id: string; importe_fijo: string | null }>(sql`
    select cb.id as concepto_id, v.id as valor_id, v.monto_fijo::numeric(14,2)::text as importe_fijo
      from concepto_boleta cb
      join concepto_boleta_valor v on v.concepto_boleta_id = cb.id
     where cb.barrio_id = ${barrioId} and cb.regla_barrio = ${REGLA_BONIFICACION}
       and cb.metodo = ${forma === "porcentaje" ? "porcentaje" : "monto_fijo"}::app.metodo_concepto_boleta
       and v.vigente_desde <= ${`${mes}-01`}::date and (v.vigente_hasta is null or v.vigente_hasta > ${`${mes}-01`}::date)
     order by v.vigente_desde desc limit 1
  `);
  return rows[0] ?? null;
}

/**
 * Al calcular el mes: deja aplicada la bonificación a quien le corresponde, y solo a ellos.
 *
 * Corre dentro de `generarLiquidaciones`, antes de `app.resolver_aplicaciones` —que es quien calcula
 * el importe contra la expensa común de cada unidad—. Como una aplicación no se borra ni se edita, la
 * conciliación es: se anula (con motivo) la que ya no corresponde y se agrega la que falta. En la
 * emisión de un solo acto (ADR-0011) no queda nada de antes y esto solo agrega.
 *
 * Cada alta pasa por `app.cbu_antes`: la firma es de quien emite y, si es un operador, valen sus
 * topes. Si el tope no alcanza, la emisión no sale y el mensaje dice por qué.
 */
export async function aplicarBonificacionDeLaRegla(
  tx: DbConIdentidad,
  parametros: { readonly periodoId: string; readonly barrioId: string; readonly mes: string; readonly bonificacion: ComoSeDevenga["bonificacion"] },
): Promise<void> {
  const { periodoId, barrioId, mes, bonificacion } = parametros;
  // Todas las aplicaciones vivas del concepto de la regla en el mes: las que puso la regla y las que
  // alguien haya cargado a mano con ese concepto (mientras el mes bonificaba «a mano»).
  const delConcepto = (
    await tx.execute<{ id: string; unidad_funcional_id: string; valor_id: string; de_la_regla: boolean }>(sql`
      select c.id, c.unidad_funcional_id, c.valor_id, (c.origen_evaluacion = 'regla_barrio') as de_la_regla
        from concepto_boleta_unidad c
        join concepto_boleta cb on cb.id = c.concepto_boleta_id
       where c.periodo_id = ${periodoId} and c.anulado_at is null
         and (c.origen_evaluacion = 'regla_barrio' or cb.regla_barrio is not null)
    `)
  ).rows;
  const activas = delConcepto.filter((a) => a.de_la_regla);
  const anular = async (ids: readonly string[], motivo: string) => {
    if (ids.length === 0) return;
    await tx.execute(sql`
      update concepto_boleta_unidad
         set anulado_at = now(), anulado_por = app.current_user_id(), motivo_anulacion = ${motivo}
       where id = any(${sql.param(ids)}::uuid[]) and anulado_at is null
    `);
  };

  if (bonificacion.modo !== "sola") {
    await anular(activas.map((a) => a.id), "Este mes la bonificación no se aplica sola.");
    return;
  }
  const cuanto = bonificacion.cuanto;
  if (cuanto === null) {
    rechazar(
      "periodo_incompleto",
      "La bonificación se aplica sola y no tiene cargado cuánto es.",
      "Completá el valor en Configuración → Cómo se devenga.",
    );
  }
  const concepto = await valorDeLaReglaDelMes(tx, barrioId, mes, cuanto.forma);
  if (!concepto) {
    rechazar(
      "periodo_incompleto",
      "La bonificación se aplica sola y el barrio no tiene su concepto con un valor para este mes.",
      "Guardá de nuevo Configuración → Cómo se devenga con el valor de la bonificación desde este mes.",
    );
  }

  const { fecha, unidades } = await situacionDeLasUnidades(tx, barrioId, periodoId);
  const reciben = new Map(unidades.filter((u) => u.recibe).map((u) => [u.unidadFuncionalId, u]));

  // El mes bonifica solo: lo que se había cargado a mano con el concepto de la regla deja de valer (la
  // unidad que corresponde la recibe por la regla, abajo). Queda anulado con su motivo, no borrado.
  await anular(
    delConcepto.filter((a) => !a.de_la_regla).map((a) => a.id),
    "El mes pasó a bonificar solo: la bonificación la aplica la regla del barrio.",
  );
  // Lo que sobra: quien ya no la recibe, o la tiene con un valor que no es el de este mes.
  await anular(
    activas.filter((a) => !reciben.has(a.unidad_funcional_id) || a.valor_id !== concepto.valor_id).map((a) => a.id),
    "La unidad ya no recibe la bonificación con lo que hay al calcular.",
  );
  const quedan = new Set(
    activas.filter((a) => reciben.has(a.unidad_funcional_id) && a.valor_id === concepto.valor_id).map((a) => a.unidad_funcional_id),
  );
  const faltan = [...reciben.values()].filter((u) => !quedan.has(u.unidadFuncionalId));
  if (faltan.length === 0) return;

  // Un importe fijo no puede ser más que la expensa común de la unidad (`cbu_no_supera_base_chk`): la
  // base lo rechazaría sin decir cuál. Se dice acá, con las unidades y las dos salidas (code-reviewer, 5).
  if (concepto.importe_fijo !== null) {
    const { rows: chicas } = await tx.execute<{ manzana: string; lote: string; n: number }>(sql`
      select u.manzana, u.lote, count(*) over ()::int as n
        from liquidacion l join unidad_funcional u on u.id = l.unidad_funcional_id
       where l.periodo_id = ${periodoId}
         and l.unidad_funcional_id = any(${sql.param(faltan.map((u) => u.unidadFuncionalId))}::uuid[])
         and l.subtotal_cuota_fija + l.subtotal_ordinarias < ${concepto.importe_fijo}::numeric
       order by ${ORDEN_NATURAL_U} limit 3
    `);
    if (chicas.length > 0) {
      const n = chicas[0]!.n;
      rechazar(
        "periodo_incompleto",
        `La bonificación de $ ${formatearMonto(concepto.importe_fijo)} es mayor que la expensa de ${n === 1 ? "una unidad" : `${n} unidades`} ` +
          `(${chicas.map((u) => etiquetaUnidad(u.manzana, u.lote)).join(", ")}${n > 3 ? "…" : ""}).`,
        "Bajá el importe en Configuración → Cómo se devenga, o quitásela a esas unidades desde «Ver quién».",
      );
    }
  }

  const filas = faltan.map((u) => ({
    unidad_funcional_id: u.unidadFuncionalId,
    // Va impreso en la boleta: dice por qué la recibe, sin el texto libre del motivo de una excepción.
    detalle: u.excepcion?.tipo === "dar" ? "Otorgada por la administración" : `Al día al ${formatearFecha(fecha)}`,
  }));
  try {
    await tx.execute(sql`
      insert into concepto_boleta_unidad (periodo_id, unidad_funcional_id, concepto_boleta_id, fecha_hecho, detalle, origen_evaluacion)
      select ${periodoId}, x.unidad_funcional_id, ${concepto.concepto_id}, ${`${mes}-01`}::date, x.detalle, 'regla_barrio'
        from jsonb_to_recordset(${JSON.stringify(filas)}::jsonb) as x(unidad_funcional_id uuid, detalle text)
    `);
  } catch (e) {
    // El tope del operador no es un error de quien emite: se dice qué pasa y quién lo destraba. Lo
    // rechaza `app.cbu_antes` con el mismo texto que a un descuento cargado a mano.
    const traducido = traducirError(e);
    if (traducido.codigo === "tope_operador" || traducido.codigo === "sin_limite_de_aplicacion") {
      rechazar(
        "tope_operador",
        "La bonificación por pago en término supera lo que un operador puede descontar en este barrio.",
        "Emití con un usuario administrador del barrio, o pedile que cargue o suba el límite de descuentos del operador.",
        undefined,
        e,
      );
    }
    throw traducido;
  }
}

/**
 * Después de resolver las aplicaciones: a cada unidad que NO recibió la bonificación de la regla se le
 * anota cuánto habría sido (va en la banda de la boleta). Con la misma cuenta que usa la base para
 * las que sí: el valor del catálogo sobre la expensa común de su liquidación, con el tope.
 */
export async function anotarBonificacionNoAplicada(
  tx: DbConIdentidad,
  parametros: { readonly periodoId: string; readonly barrioId: string; readonly mes: string; readonly bonificacion: ComoSeDevenga["bonificacion"] },
): Promise<void> {
  const { periodoId, barrioId, mes, bonificacion } = parametros;
  if (bonificacion.modo !== "sola" || bonificacion.cuanto === null) return;
  const regla = await valorDeLaReglaDelMes(tx, barrioId, mes, bonificacion.cuanto.forma);
  if (!regla) return;
  await tx.execute(sql`
    with v as (
      select v.metodo, v.monto_fijo, v.porcentaje, v.tope from concepto_boleta_valor v where v.id = ${regla.valor_id}
    ),
    x as (
      select l.id,
             least(
               least(app.cbu_importe_bruto(v.metodo, v.monto_fijo, v.porcentaje, null, null, l.subtotal_cuota_fija + l.subtotal_ordinarias),
                     coalesce(v.tope, l.subtotal_cuota_fija + l.subtotal_ordinarias)),
               l.subtotal_cuota_fija + l.subtotal_ordinarias) as importe
        from liquidacion l cross join v
       where l.periodo_id = ${periodoId}
         and not exists (select 1 from concepto_boleta_unidad c
                          where c.periodo_id = l.periodo_id and c.unidad_funcional_id = l.unidad_funcional_id
                            and c.anulado_at is null and c.origen_evaluacion = 'regla_barrio')
    )
    update liquidacion l set bonificacion_no_aplicada = x.importe
      from x where x.id = l.id and x.importe > 0
  `);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// «Ver quién»: el detalle de la bonificación del mes
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type UnidadEnLaBonificacion = SituacionDeBonificacion & {
  /** El importe bonificado (emitido y la recibe) o el que no recibió (emitido y no la recibe). */
  readonly importe: Monto | null;
};

export type BonificacionDelMes = {
  readonly periodoId: string;
  /** `YYYY-MM`. */
  readonly periodo: string;
  readonly modo: ModoBonificacion;
  readonly cuanto: ValorDeBonificacion | null;
  /** Una frase con el valor: «7,5 % de la expensa, hasta $ 20.000,00». */
  readonly cuantoTexto: string | null;
  readonly emitido: boolean;
  /** La fecha a la que se evaluó quién está al día: hoy antes de emitir; la de emisión después. */
  readonly evaluadaAl: string;
  /** Quien mira puede cargar o sacar excepciones (la administración, antes de emitir). */
  readonly puedeExceptuar: boolean;
  readonly unidades: readonly UnidadEnLaBonificacion[];
  readonly resumen: {
    readonly alDia: number;
    readonly reciben: number;
    readonly noReciben: number;
    readonly excepciones: number;
    /** Lo bonificado en total (negativo no: es la magnitud). Solo después de emitir. */
    readonly total: Monto | null;
  };
};

const textoDeCuanto = (c: ValorDeBonificacion | null): string | null =>
  c === null
    ? null
    : c.forma === "porcentaje"
      ? `${textoDePorcentaje(c.valor)} de la expensa${c.tope ? `, hasta $ ${formatearMonto(c.tope)} por unidad` : ""}`
      : `$ ${formatearMonto(c.valor)} por unidad`;

/**
 * Quién recibe la bonificación del mes, con las excepciones y sus motivos. Antes de emitir se evalúa
 * con lo que hay ahora (es lo que la emisión va a aplicar); después, es lo que quedó emitido.
 */
export async function bonificacionDelMes(tx: DbConIdentidad, parametros: { readonly periodoId: string }): Promise<BonificacionDelMes> {
  const periodoId = idSchema.parse(parametros.periodoId);
  return enBase(async () => {
    const { rows } = await tx.execute<{
      barrio_id: string;
      periodo: string;
      estado: string;
      modo: ModoBonificacion | null;
      forma: FormaBonificacion | null;
      valor: string | null;
      tope: string | null;
      emitida_el: string | null;
      puede: boolean;
    }>(sql`
      select p.barrio_id, p.periodo, p.estado::text as estado, p.bonificacion_modo as modo, p.bonificacion_forma as forma,
             (case when p.bonificacion_forma = 'importe' then p.bonificacion_valor::numeric(14,2)::text
                   else trim_scale(p.bonificacion_valor)::text end) as valor,
             p.bonificacion_tope::numeric(14,2)::text as tope,
             to_char(p.emitida_at at time zone b.zona_horaria, 'YYYY-MM-DD') as emitida_el,
             app.has_role_on(p.barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]) as puede
        from periodo_expensa p join barrio b on b.barrio_id = p.barrio_id where p.id = ${periodoId}
    `);
    const p = rows[0];
    if (!p) rechazarPeriodoInaccesible();
    const emitido = p.estado === "emitida" || p.estado === "distribuida";

    if (!emitido) {
      const dev = await comoSeDevengaEn(tx, { barrioId: p.barrio_id, mes: p.periodo });
      const { fecha, unidades } = await situacionDeLasUnidades(tx, p.barrio_id, periodoId);
      const sola = dev.bonificacion.modo === "sola";
      const lista = unidades.map((u) => ({ ...u, recibe: sola && u.recibe, importe: null }));
      return {
        periodoId,
        periodo: p.periodo,
        modo: dev.bonificacion.modo,
        cuanto: dev.bonificacion.cuanto,
        cuantoTexto: textoDeCuanto(dev.bonificacion.cuanto),
        emitido,
        evaluadaAl: fecha,
        puedeExceptuar: p.puede && sola,
        unidades: lista,
        resumen: {
          alDia: lista.filter((u) => u.alDia).length,
          reciben: lista.filter((u) => u.recibe).length,
          noReciben: lista.filter((u) => !u.recibe).length,
          excepciones: lista.filter((u) => u.excepcion !== null).length,
          total: null,
        },
      };
    }

    // Emitido: lo que quedó. Quién estaba al día ya no se puede volver a evaluar (entraron pagos), así
    // que se lee de lo que la emisión dejó escrito: la aplicación, la excepción y la deuda de la boleta.
    const cuanto: ValorDeBonificacion | null =
      p.forma !== null && p.valor !== null ? { forma: p.forma, valor: p.valor, tope: (p.tope as Monto | null) ?? null } : null;
    const { rows: filas } = await tx.execute<{
      unidad_funcional_id: string;
      manzana: string;
      lote: string;
      bonificado: string | null;
      no_aplicada: string | null;
      debe: string[] | null;
      excepcion: TipoExcepcionBonificacion | null;
      excepcion_motivo: string | null;
      excepcion_por: string | null;
      excepcion_el: string | null;
    }>(sql`
      select l.unidad_funcional_id, u.manzana, u.lote,
             (select sum(c.importe_resuelto)::numeric(14,2)::text from concepto_boleta_unidad c
               where c.periodo_id = l.periodo_id and c.unidad_funcional_id = l.unidad_funcional_id
                 and c.anulado_at is null and c.origen_evaluacion = 'regla_barrio') as bonificado,
             l.bonificacion_no_aplicada::numeric(14,2)::text as no_aplicada,
             -- Lo que debía VENCIDO al emitir: capital de un mes cuyo vencimiento es anterior a la emisión.
             (select array_agg(m ->> 'periodo' order by m ->> 'periodo')
                from jsonb_array_elements(coalesce(l.deuda_anterior, '[]'::jsonb)) m
               where (m ->> 'capital')::numeric > 0
                 and (m ->> 'vencimiento')::date < (pe.emitida_at at time zone b.zona_horaria)::date) as debe,
             e.tipo as excepcion, e.motivo as excepcion_motivo,
             (select x.nombre from usuario_demo x where x.user_id = e.creado_por) as excepcion_por,
             to_char(e.created_at at time zone b.zona_horaria, 'YYYY-MM-DD') as excepcion_el
        from liquidacion l
        join periodo_expensa pe on pe.id = l.periodo_id
        join unidad_funcional u on u.id = l.unidad_funcional_id
        join barrio b on b.barrio_id = l.barrio_id
        left join bonificacion_excepcion e on e.periodo_id = l.periodo_id and e.unidad_funcional_id = l.unidad_funcional_id
       where l.periodo_id = ${periodoId}
       order by ${ORDEN_NATURAL_U}
    `);
    const lista: UnidadEnLaBonificacion[] = filas.map((r) => {
      const recibe = r.bonificado !== null;
      // Quién estaba al día al emitir se lee de la deuda vencida que quedó en la boleta. Si la boleta
      // no trae el desglose, de lo que pasó: sin excepción, recibirla es haber estado al día.
      const debe = r.debe ?? [];
      const alDia = debe.length > 0 ? false : r.excepcion === null ? recibe || p.modo !== "sola" : r.excepcion === "quitar";
      return {
        unidadFuncionalId: r.unidad_funcional_id,
        etiqueta: etiquetaUnidad(r.manzana, r.lote),
        alDia,
        mesesAdeudados: debe,
        conSaldoInicial: false,
        excepcion:
          r.excepcion === null
            ? null
            : { tipo: r.excepcion, motivo: r.excepcion_motivo ?? "", cargoNombre: r.excepcion_por, cargadaEl: r.excepcion_el ?? "" },
        recibe,
        importe: (r.bonificado ?? r.no_aplicada) as Monto | null,
      };
    });
    const bonificados = lista.filter((u) => u.recibe && u.importe !== null).map((u) => u.importe as Monto);
    return {
      periodoId,
      periodo: p.periodo,
      modo: p.modo ?? "a_mano",
      cuanto,
      cuantoTexto: textoDeCuanto(cuanto),
      emitido,
      evaluadaAl: p.emitida_el ?? "",
      puedeExceptuar: false,
      unidades: lista,
      resumen: {
        alDia: lista.filter((u) => u.alDia).length,
        reciben: lista.filter((u) => u.recibe).length,
        noReciben: lista.filter((u) => !u.recibe).length,
        excepciones: lista.filter((u) => u.excepcion !== null).length,
        total: sumarMontos("0.00", ...bonificados),
      },
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Las excepciones: «Dársela igual» y «Quitar»
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** El período de una excepción, con lo que hace falta para decidir si se puede cargar. */
async function periodoParaExceptuar(
  tx: DbConIdentidad,
  periodoId: string,
): Promise<{ barrioId: string; periodo: string }> {
  const { rows } = await tx.execute<{ barrio_id: string; periodo: string; estado: string; puede: boolean }>(sql`
    select p.barrio_id, p.periodo, p.estado::text as estado,
           app.has_role_on(p.barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]) as puede
      from periodo_expensa p where p.id = ${periodoId}
  `);
  const p = rows[0];
  if (!p) rechazarPeriodoInaccesible();
  if (p.estado !== "borrador" && p.estado !== "revisada") {
    rechazar(
      "periodo_no_editable",
      "El mes ya está emitido: sus bonificaciones son las de las boletas.",
      "Las excepciones se cargan hasta emitir.",
      { estado: p.estado },
    );
  }
  if (!p.puede) {
    rechazar(
      "sin_permiso",
      "Darle o quitarle la bonificación a una unidad lo decide la administración del barrio.",
      "Pedíselo a quien administra el barrio.",
    );
  }
  return { barrioId: p.barrio_id, periodo: p.periodo };
}

async function registrarEnElHistorial(
  tx: DbConIdentidad,
  e: { barrioId: string; unidadId: string; detalle: string; datos: Record<string, unknown> },
): Promise<void> {
  await tx.execute(sql`
    insert into padron_evento (barrio_id, unidad_funcional_id, tipo, detalle, datos)
    values (${e.barrioId}, ${e.unidadId}, 'excepcion_bonificacion', ${e.detalle.slice(0, 1000)}, ${JSON.stringify(e.datos)}::jsonb)
  `);
}

/**
 * «Dársela igual» o «Quitar»: la excepción de una unidad para un mes, con motivo. Reemplaza la que
 * hubiera. Queda en el historial de la unidad y se congela al emitir.
 */
export async function ponerExcepcionDeBonificacion(tx: DbConIdentidad, parametros: PonerExcepcionDeBonificacion): Promise<void> {
  const p = ponerExcepcionDeBonificacionSchema.parse(parametros);
  await enBase(async () => {
    const periodo = await periodoParaExceptuar(tx, p.periodoId);
    const dev = await comoSeDevengaEn(tx, { barrioId: periodo.barrioId, mes: periodo.periodo });
    if (dev.bonificacion.modo !== "sola") {
      rechazar(
        "dato_invalido",
        "Este mes la bonificación no se aplica sola: no hay regla de la cual exceptuar a una unidad.",
        "Si el barrio bonifica a mano, aplicá o anulá el descuento en la unidad.",
      );
    }
    const { rows: unidad } = await tx.execute<{ id: string }>(sql`
      select id from unidad_funcional where id = ${p.unidadFuncionalId} and barrio_id = ${periodo.barrioId} and baja_at is null
    `);
    if (unidad.length === 0) rechazar("unidad_no_encontrada", "Esa unidad no existe en este barrio o está dada de baja.", "Volvé a la lista del mes.");

    await tx.execute(sql`delete from bonificacion_excepcion where periodo_id = ${p.periodoId} and unidad_funcional_id = ${p.unidadFuncionalId}`);
    await tx.execute(sql`
      insert into bonificacion_excepcion (barrio_id, periodo_id, unidad_funcional_id, tipo, motivo)
      values (${periodo.barrioId}, ${p.periodoId}, ${p.unidadFuncionalId}, ${p.tipo}, ${p.motivo})
    `);
    await registrarEnElHistorial(tx, {
      barrioId: periodo.barrioId,
      unidadId: p.unidadFuncionalId,
      detalle: `Bonificación por pago en término de ${nombreDelPeriodo(periodo.periodo)}: ${p.tipo === "dar" ? "se le da igual" : "se le quita"}. Motivo: ${p.motivo}`,
      // El motivo va una sola vez, en `detalle`: es texto libre y el historial no se borra.
      datos: { periodo: periodo.periodo, excepcion: p.tipo },
    });
  });
}

/** Saca la excepción: la unidad vuelve a la regla. También queda en el historial, con su motivo. */
export async function sacarExcepcionDeBonificacion(tx: DbConIdentidad, parametros: SacarExcepcionDeBonificacion): Promise<void> {
  const p = sacarExcepcionDeBonificacionSchema.parse(parametros);
  await enBase(async () => {
    const periodo = await periodoParaExceptuar(tx, p.periodoId);
    const { rows } = await tx.execute<{ tipo: string }>(sql`
      delete from bonificacion_excepcion where periodo_id = ${p.periodoId} and unidad_funcional_id = ${p.unidadFuncionalId}
      returning tipo
    `);
    const sacada = rows[0];
    if (!sacada) rechazar("dato_invalido", "Esa unidad no tiene una excepción cargada para este mes.", "Recargá la lista.");
    await registrarEnElHistorial(tx, {
      barrioId: periodo.barrioId,
      unidadId: p.unidadFuncionalId,
      detalle: `Bonificación por pago en término de ${nombreDelPeriodo(periodo.periodo)}: se saca la excepción («${sacada.tipo === "dar" ? "dársela igual" : "quitar"}») y vuelve a la regla. Motivo: ${p.motivo}`,
      datos: { periodo: periodo.periodo, excepcion: null, anterior: sacada.tipo },
    });
  });
}
