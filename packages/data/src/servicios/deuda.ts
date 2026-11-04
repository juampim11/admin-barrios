/**
 * El circuito de la deuda (ADR-0009): el interés que devenga el capital impago, el que se paga, el que
 * se condona, y lo que la boleta siguiente arrastra.
 *
 * El cálculo es el de `@admin-barrios/shared/interes-pago-tardio` (sobre el motor de T1); acá se lee
 * de la base lo que hace falta para calcular, y se escribe con la identidad de quien opera. Las reglas
 * de fondo —que un tramo arranque donde terminó el anterior, que su base sea el capital pendiente de
 * ese momento, los topes de imputación y de condonación, quién puede condonar— las hace cumplir la
 * base (`0062`). Nada de esto recalcula hacia atrás: un tramo nunca se reabre.
 */

import { sql } from "drizzle-orm";
import { aCentavos, deCentavos, formatearMonto, sumarMontos, type Monto } from "@admin-barrios/shared/dinero";
import {
  cierraElTramo,
  interesCobrable,
  interesDelTramo,
  repartirPago,
  type RepartoDelPago,
  type ResultadoTramo,
} from "@admin-barrios/shared/interes-pago-tardio";
import type { OrdenImputacionBarrio } from "@admin-barrios/shared/cobros";
import { numeroDeDia } from "@admin-barrios/shared/interes-mora";
import { consultaBarrioSchema, consultaInteresDelPagoSchema, consultaUnidadSchema } from "@admin-barrios/shared/consultas";
import {
  condonarInteresSchema,
  imputarPagoConInteresSchema,
  type CondonarInteres,
  type ImputarPagoConInteres,
  type NoCobrarInteres,
} from "@admin-barrios/shared/escrituras";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";
import { parametrosParaLaVentana } from "./parametros.ts";
import { registrarPago, type PagoEscrito } from "./pagos.ts";
import type { RegistrarPago } from "@admin-barrios/shared/escrituras";

/** Un tramo calculado: el capital pendiente de una liquidación, de `inicio` a `fin`. */
export type TramoCalculado = {
  readonly liquidacionId: string;
  readonly unidadFuncionalId: string;
  readonly inicio: string;
  readonly fin: string;
  readonly desdeVencimiento: boolean;
  readonly base: Monto;
  readonly resultado: ResultadoTramo;
  /**
   * Con qué se calculó: los valores vigentes y los tramos de tasa de la ventana (T1). Se guarda con el
   * interés registrado (regla 4: toda cifra se explica con su origen).
   */
  readonly parametros: { readonly valores: unknown; readonly tramos: unknown };
};

/** El estado de la deuda de una unidad a una fecha, sin escribir nada. */
export type DeudaDeUnidad = {
  readonly unidadFuncionalId: string;
  /** Capital pendiente (lo que las liquidaciones emitidas suman a la deuda, menos lo imputado). */
  readonly capital: Monto;
  /** Interés ya registrado y todavía no pagado ni condonado. */
  readonly interesPendiente: Monto;
  /** Interés de los tramos que cerraría un hecho en esa fecha (todavía sin registrar). */
  readonly interesNuevo: Monto;
  /** El vencimiento impago más antiguo, o `null` si no debe capital. */
  readonly vencimientoMasAntiguo: string | null;
  readonly tramos: readonly TramoCalculado[];
};

type FilaCapital = {
  liquidacion_id: string;
  unidad_funcional_id: string;
  vencimiento: string;
  pendiente: string;
  ultimo: string | null;
};

/**
 * La deuda de las unidades de un barrio (o de una sola) a `fecha`: capital pendiente, interés
 * pendiente y los tramos que se cerrarían ese día. **No escribe nada**: la boleta lo usa para el
 * borrador, el pago para saber cuánto interés devengó, la pantalla para mostrarlo.
 */
export async function deudaALaFecha(
  tx: DbConIdentidad,
  entrada: {
    readonly barrioId: string;
    readonly fecha: string;
    readonly unidadFuncionalId?: string;
    /** Un período cuyas liquidaciones no cuentan (el que se está emitiendo: no es deuda anterior). */
    readonly excluirPeriodoId?: string;
  },
): Promise<Map<string, DeudaDeUnidad>> {
  const unidad = entrada.unidadFuncionalId ?? null;
  const excluir = entrada.excluirPeriodoId ?? null;
  const capital = (
    await tx.execute<FilaCapital>(sql`
      select x.liquidacion_id, x.unidad_funcional_id, x.vencimiento, x.pendiente::numeric(14,2)::text as pendiente,
             (select max(d.hasta)::text from interes_devengado d where d.liquidacion_id = x.liquidacion_id) as ultimo
        from (
          select l.id as liquidacion_id, l.unidad_funcional_id, pe.primer_vencimiento::text as vencimiento,
                 app.capital_pendiente(l.id) as pendiente, pe.primer_vencimiento, l.created_at
            from liquidacion l
            join periodo_expensa pe on pe.id = l.periodo_id
           where l.barrio_id = ${entrada.barrioId}
             and (${unidad}::uuid is null or l.unidad_funcional_id = ${unidad}::uuid)
             and pe.estado in ('emitida', 'distribuida')
             and pe.primer_vencimiento is not null
             and (${excluir}::uuid is null or pe.id <> ${excluir}::uuid)
        ) x
       where x.pendiente > 0
       order by x.primer_vencimiento, x.created_at, x.liquidacion_id
    `)
  ).rows;
  const intereses = (
    await tx.execute<{ unidad_funcional_id: string; pendiente: string }>(sql`
      select d.unidad_funcional_id, sum(app.interes_pendiente(d.id))::numeric(14,2)::text as pendiente
        from interes_devengado d
       where d.barrio_id = ${entrada.barrioId}
         and (${unidad}::uuid is null or d.unidad_funcional_id = ${unidad}::uuid)
         and d.monto > 0
       group by d.unidad_funcional_id
    `)
  ).rows;

  // Un hecho en el futuro no devenga nada (la base tampoco lo acepta, `0064`): hoy es el del barrio.
  const hoy = (
    await tx.execute<{ hoy: string }>(sql`
      select (now() at time zone zona_horaria)::date::text as hoy from barrio where barrio_id = ${entrada.barrioId}
    `)
  ).rows[0]?.hoy;
  const futuro = hoy !== undefined && entrada.fecha > hoy;

  // Las vigencias de T1 para toda la vida de la deuda: del vencimiento más antiguo a la fecha.
  const desde = capital.reduce<string | null>((min, f) => {
    const inicio = f.ultimo ?? f.vencimiento;
    return min === null || inicio < min ? inicio : min;
  }, null);
  const ventana =
    desde !== null && desde < entrada.fecha
      ? await parametrosParaLaVentana(tx, { barrioId: entrada.barrioId, inicio: desde, corte: entrada.fecha })
      : null;

  const porUnidad = new Map<string, { capital: string[]; tramos: TramoCalculado[]; vto: string | null }>();
  const de = (u: string) => {
    let x = porUnidad.get(u);
    if (!x) porUnidad.set(u, (x = { capital: [], tramos: [], vto: null }));
    return x;
  };
  for (const f of capital) {
    const x = de(f.unidad_funcional_id);
    x.capital.push(f.pendiente);
    if (x.vto === null || f.vencimiento < x.vto) x.vto = f.vencimiento;
    const inicio = f.ultimo ?? f.vencimiento;
    // Un hecho con fecha anterior o igual al inicio del tramo no recalcula nada hacia atrás.
    if (futuro || entrada.fecha <= inicio || !ventana?.vigencias) continue;
    x.tramos.push({
      liquidacionId: f.liquidacion_id,
      unidadFuncionalId: f.unidad_funcional_id,
      inicio,
      fin: entrada.fecha,
      desdeVencimiento: f.ultimo === null,
      base: f.pendiente as Monto,
      parametros: { valores: ventana.valores, tramos: ventana.tramos },
      resultado: interesDelTramo({
        base: f.pendiente as Monto,
        inicio,
        fin: entrada.fecha,
        desdeVencimiento: f.ultimo === null,
        vigencias: ventana.vigencias,
      }),
    });
  }
  for (const i of intereses) de(i.unidad_funcional_id);

  const pendientePorUnidad = new Map(intereses.map((i) => [i.unidad_funcional_id, i.pendiente]));
  const salida = new Map<string, DeudaDeUnidad>();
  for (const [u, x] of porUnidad) {
    salida.set(u, {
      unidadFuncionalId: u,
      capital: sumarMontos("0.00", ...x.capital),
      interesPendiente: sumarMontos("0.00", pendientePorUnidad.get(u) ?? "0.00"),
      interesNuevo: sumarMontos("0.00", ...x.tramos.map((t) => interesCobrable(t.resultado))),
      vencimientoMasAntiguo: x.vto,
      tramos: x.tramos,
    });
  }
  return salida;
}

/** Registra los tramos que se cierran (los calculados y los no cobrados por tolerancia). Devuelve los ids con monto. */
export async function registrarTramos(
  tx: DbConIdentidad,
  tramos: readonly TramoCalculado[],
  cierre: { readonly origen: "pago"; readonly pagoId: string } | { readonly origen: "corte"; readonly periodoId: string },
): Promise<Array<{ readonly id: string; readonly monto: Monto }>> {
  const creados: Array<{ id: string; monto: Monto }> = [];
  for (const t of tramos) {
    const r = t.resultado;
    if (!cierraElTramo(r)) continue;
    const calculado = r.estado === "calculado";
    const monto = calculado ? r.interes : "0.00";
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into interes_devengado (barrio_id, unidad_funcional_id, liquidacion_id, origen, pago_id, periodo_id,
                                     desde, hasta, desde_vencimiento, base, monto, compensatorio, punitorio,
                                     interes_calculado, no_cobrado_por_tolerancia, dias, dias_devengados, parametros)
      select l.barrio_id, l.unidad_funcional_id, l.id, ${cierre.origen},
             ${cierre.origen === "pago" ? cierre.pagoId : null}::uuid,
             ${cierre.origen === "corte" ? cierre.periodoId : null}::uuid,
             ${t.inicio}::date, ${t.fin}::date, ${t.desdeVencimiento}, ${t.base}::numeric, ${monto}::numeric,
             ${calculado ? r.compensatorio : "0.00"}::numeric, ${calculado ? r.punitorio : "0.00"}::numeric,
             ${calculado ? r.interes : r.estado === "tolerancia" ? r.interesCalculado : "0.00"}::numeric,
             ${!calculado}, ${r.estado === "calculado" || r.estado === "tolerancia" ? r.dias : 0},
             ${calculado ? r.diasDevengados : 0},
             ${JSON.stringify({ ...t.parametros, estado: r.estado, desdeVencimiento: t.desdeVencimiento })}::jsonb
        from liquidacion l where l.id = ${t.liquidacionId}
      returning id
    `);
    const id = rows[0]?.id;
    if (!id) throw new Error("no se pudo registrar el interés del tramo");
    creados.push({ id, monto });
  }
  return creados;
}

async function ordenDeImputacion(tx: DbConIdentidad, barrioId: string, fecha: string): Promise<OrdenImputacionBarrio> {
  const { rows } = await tx.execute<{ orden: string | null }>(sql`
    select (select x.valor #>> '{}' from app.parametro_resuelto(${barrioId}::uuid, 'imputacion.orden', ${fecha}::date) x) as orden
  `);
  return rows[0]?.orden === "capital_primero" ? "capital_primero" : "intereses_primero_capital_antiguo";
}

/** Lo que pasa con un pago antes de imputarlo: cuánto interés devengó y cómo se repartiría. */
export type VistaPreviaDelPago = {
  readonly orden: OrdenImputacionBarrio;
  readonly capital: Monto;
  readonly interesPendiente: Monto;
  /** El interés que devengó hasta la fecha del pago (lo nuevo, que se registra al imputarlo). */
  readonly interesDelPago: Monto;
  /** Días de atraso: del vencimiento impago más antiguo a la fecha del pago. */
  readonly diasDeAtraso: number;
  readonly reparto: RepartoDelPago;
};

function diasEntre(desde: string, hasta: string): number {
  return numeroDeDia(hasta) - numeroDeDia(desde);
}

/**
 * Los importes de los dos renglones de «No cobrar interés» para un pago de la unidad en `fecha`, sin
 * escribir nada (encargo 11, BL-030 j): el interés que devengaría ese pago (`delPago`) y el interés
 * anterior que la unidad todavía debe (`anterior`). Son las mismas cifras que usa `registrarEImputarPago`.
 */
export async function interesQueSePuedeNoCobrar(
  tx: DbConIdentidad,
  parametros: { readonly unidadFuncionalId: string; readonly fecha: string },
): Promise<{ readonly delPago: Monto; readonly anterior: Monto }> {
  const { unidadFuncionalId, fecha } = consultaInteresDelPagoSchema.parse(parametros);
  const vista = await vistaPreviaDelPago(tx, { unidadFuncionalId, fecha, monto: "0.00" });
  return { delPago: vista.interesDelPago, anterior: vista.interesPendiente };
}

/** La vista previa de un pago de `monto` en `fecha` para la unidad: no escribe nada. */
export async function vistaPreviaDelPago(
  tx: DbConIdentidad,
  entrada: { readonly unidadFuncionalId: string; readonly fecha: string; readonly monto: Monto },
): Promise<VistaPreviaDelPago> {
  const { rows } = await tx.execute<{ barrio_id: string }>(
    sql`select barrio_id from unidad_funcional where id = ${entrada.unidadFuncionalId}`,
  );
  const barrioId = rows[0]?.barrio_id;
  if (!barrioId) rechazar("unidad_no_encontrada", "Esa unidad no existe o no tenés acceso a ella.", "Volvé al padrón del barrio.");
  const deuda = (await deudaALaFecha(tx, { barrioId, fecha: entrada.fecha, unidadFuncionalId: entrada.unidadFuncionalId })).get(
    entrada.unidadFuncionalId,
  );
  const orden = await ordenDeImputacion(tx, barrioId, entrada.fecha);
  const capital = deuda?.capital ?? "0.00";
  const interesPendiente = deuda?.interesPendiente ?? "0.00";
  const interesDelPago = deuda?.interesNuevo ?? "0.00";
  return {
    orden,
    capital,
    interesPendiente,
    interesDelPago,
    diasDeAtraso: deuda?.vencimientoMasAntiguo ? Math.max(0, diasEntre(deuda.vencimientoMasAntiguo, entrada.fecha)) : 0,
    reparto: repartirPago({ monto: entrada.monto, interes: sumarMontos(interesPendiente, interesDelPago), capital, orden }),
  };
}

export type PagoImputado = {
  readonly interesDevengado: Monto;
  /** Todo lo condonado con el pago: la suma de las dos partes de abajo. */
  readonly interesCondonado: Monto;
  /** Del interés de este atraso (el que devengó este pago), condonado con «No cobrar interés». */
  readonly interesCondonadoDelPago: Monto;
  /**
   * Del interés anterior que la unidad todavía debía (de boletas y pagos anteriores), condonado con
   * «No cobrar interés» (encargo 11, BL-030 j).
   */
  readonly interesCondonadoAnterior: Monto;
  readonly aInteres: Monto;
  readonly aCapital: Monto;
};

/**
 * Las dos partes que puede condonar «No cobrar interés» (encargo 11, BL-030 j). Sin decir: solo el
 * interés de este atraso, como antes del encargo 11.
 */
export type PartesQueSeCondonan = { readonly delPago: boolean; readonly anterior: boolean };
const SOLO_EL_DEL_PAGO: PartesQueSeCondonan = { delPago: true, anterior: false };

/**
 * Imputa un pago con su interés (ADR-0009): registra el interés que el capital pendiente devengó hasta
 * la fecha del pago, y —si se pidió no cobrarlo— lo condona en el mismo acto; después imputa con
 * `app.resolver_imputacion`, en el orden del barrio.
 *
 * «No cobrar interés» condona dos partes, cada una por separado (encargo 11, BL-030 j):
 * - **el interés de este atraso**: lo que devengó este pago, entero;
 * - **el interés anterior**: todo el interés que la unidad ya debía antes de este pago —el de las
 *   boletas anteriores y el de pagos anteriores que no lo cubrieron—, lo pendiente de cada fila.
 *
 * Las boletas emitidas no se tocan: lo condonado queda como condonación, con este pago, y se anula
 * con él. Con las dos partes, la imputación es la misma que si la unidad no debiera interés.
 */
export async function imputarPagoConInteres(tx: DbConIdentidad, parametros: ImputarPagoConInteres): Promise<PagoImputado> {
  const p = imputarPagoConInteresSchema.parse(parametros);
  return enBase(async () => {
    const pago = (
      await tx.execute<{ barrio_id: string; unidad_funcional_id: string; fecha: string }>(sql`
        select barrio_id, unidad_funcional_id, fecha::text as fecha from pago where id = ${p.pagoId} and anulado_at is null
      `)
    ).rows[0];
    if (!pago) rechazar("pago_no_encontrado", "Ese pago no existe, está anulado o no tenés acceso.", "Recargá la lista de pagos.");
    await serializarCobrosDeLaUnidad(tx, pago.unidad_funcional_id);

    const partes = p.noCobrarInteres ? p.condonar : { delPago: false, anterior: false };
    // El interés anterior se lee ANTES de registrar los tramos de este pago: lo de este atraso no es
    // «anterior», aunque al registrarlo también quede pendiente.
    const anteriores = partes.anterior ? await interesPendienteDeUnidad(tx, { unidadFuncionalId: pago.unidad_funcional_id }) : [];

    const deuda = (
      await deudaALaFecha(tx, { barrioId: pago.barrio_id, fecha: pago.fecha, unidadFuncionalId: pago.unidad_funcional_id })
    ).get(pago.unidad_funcional_id);
    const creados = await registrarTramos(tx, deuda?.tramos ?? [], { origen: "pago", pagoId: p.pagoId });
    const devengado = sumarMontos("0.00", ...creados.map((c) => c.monto));

    let condonadoDelPago: Monto = "0.00";
    let condonadoAnterior: Monto = "0.00";
    if (p.noCobrarInteres && partes.delPago) {
      for (const c of creados.filter((x) => aCentavos(x.monto) > 0n)) {
        await insertarCondonacion(tx, { interesId: c.id, monto: c.monto, origen: "pago", pagoId: p.pagoId, datos: p.noCobrarInteres });
      }
      condonadoDelPago = devengado;
    }
    if (p.noCobrarInteres && partes.anterior) {
      // Cada fila, por lo que todavía se debe de ella (`app.interes_pendiente`): lo ya pagado o
      // condonado no se vuelve a condonar (la base lo controla igual).
      for (const x of anteriores) {
        await insertarCondonacion(tx, { interesId: x.id, monto: x.pendiente, origen: "pago", pagoId: p.pagoId, datos: p.noCobrarInteres });
      }
      condonadoAnterior = sumarMontos("0.00", ...anteriores.map((x) => x.pendiente));
    }
    const condonado = sumarMontos(condonadoDelPago, condonadoAnterior);

    await tx.execute(sql`select app.resolver_imputacion(${p.pagoId})`);
    const { rows } = await tx.execute<{ a_interes: string; a_capital: string }>(sql`
      select coalesce((select sum(monto_imputado) from pago_imputacion_interes where pago_id = ${p.pagoId} and anulado_at is null), 0)::numeric(14,2)::text as a_interes,
             coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = ${p.pagoId} and anulado_at is null), 0)::numeric(14,2)::text as a_capital
    `);
    return {
      interesDevengado: devengado,
      interesCondonado: condonado,
      interesCondonadoDelPago: condonadoDelPago,
      interesCondonadoAnterior: condonadoAnterior,
      aInteres: deCentavos(aCentavos(rows[0]?.a_interes ?? "0.00")),
      aCapital: deCentavos(aCentavos(rows[0]?.a_capital ?? "0.00")),
    };
  });
}

/**
 * El candado de los cobros de una unidad hasta el fin de la transacción (`app.serializar_cobros_de_unidad`,
 * `0068`). Reentrante: tomarlo dos veces en la misma transacción no espera. Si otro pago lo tiene más
 * de 5 segundos, la base lo rechaza con un texto propio que `errores.ts` traduce (`pago_concurrente`).
 */
async function serializarCobrosDeLaUnidad(tx: DbConIdentidad, unidadFuncionalId: string): Promise<void> {
  await enBase(() => tx.execute(sql`select app.serializar_cobros_de_unidad(${unidadFuncionalId}::uuid)`));
}

async function insertarCondonacion(
  tx: DbConIdentidad,
  e: {
    readonly interesId: string;
    readonly monto: Monto;
    readonly origen: "pago" | "estado_cuenta";
    readonly pagoId: string | null;
    readonly datos: NoCobrarInteres;
  },
): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    insert into interes_condonacion (barrio_id, unidad_funcional_id, interes_id, monto, motivo, detalle,
                                     respaldo_tipo, respaldo_referencia, respaldo_adjunto, origen, pago_id,
                                     rol_al_condonar, creado_por)
    select d.barrio_id, d.unidad_funcional_id, d.id, ${e.monto}::numeric, ${e.datos.motivo}, ${e.datos.detalle},
           ${e.datos.respaldoTipo}, ${e.datos.respaldoReferencia}, ${e.datos.respaldoAdjunto},
           ${e.origen}, ${e.pagoId}::uuid, 'admin_barrio', app.current_user_id()
      from interes_devengado d where d.id = ${e.interesId}
    returning id
  `);
  return rows[0]?.id ?? null;
}

/** El interés pendiente de una unidad, fila por fila (el más antiguo primero): lo que se puede condonar. */
export type InteresPendiente = {
  readonly id: string;
  readonly liquidacionId: string;
  readonly desde: string;
  readonly hasta: string;
  readonly devengado: Monto;
  readonly pendiente: Monto;
};

export async function interesPendienteDeUnidad(
  tx: DbConIdentidad,
  parametros: { readonly unidadFuncionalId: string },
): Promise<InteresPendiente[]> {
  const { unidadFuncionalId } = consultaUnidadSchema.parse(parametros);
  const { rows } = await tx.execute<{ id: string; liquidacion_id: string; desde: string; hasta: string; monto: string; pendiente: string }>(sql`
    select d.id, d.liquidacion_id, d.desde::text, d.hasta::text, d.monto::text, app.interes_pendiente(d.id)::numeric(14,2)::text as pendiente
      from interes_devengado d
     where d.unidad_funcional_id = ${unidadFuncionalId} and d.monto > 0 and app.interes_pendiente(d.id) > 0
     order by d.hasta, d.created_at, d.id
  `);
  return rows.map((r) => ({
    id: r.id,
    liquidacionId: r.liquidacion_id,
    desde: r.desde,
    hasta: r.hasta,
    devengado: r.monto as Monto,
    pendiente: deCentavos(aCentavos(r.pendiente)),
  }));
}

/**
 * Condona interés pendiente de una unidad, total o parcial (ADR-0009). Se reparte sobre el interés
 * pendiente del más antiguo al más nuevo. Pide confirmación con el importe a la vista: la primera
 * vez rechaza con `condonacion_requiere_confirmacion`, y se reintenta con `confirmarCondonacion`.
 */
export async function condonarInteres(
  tx: DbConIdentidad,
  parametros: CondonarInteres,
): Promise<{ readonly condonado: Monto; readonly condonacionId: string | null }> {
  const p = condonarInteresSchema.parse(parametros);
  return enBase(async () => {
    const pendientes = await interesPendienteDeUnidad(tx, { unidadFuncionalId: p.unidadFuncionalId });
    const total = sumarMontos("0.00", ...pendientes.map((x) => x.pendiente));
    if (aCentavos(p.monto) > aCentavos(total)) {
      rechazar(
        "condonacion_excede_pendiente",
        `Se quiere condonar $ ${p.monto} y el interés pendiente de la unidad es $ ${total}.`,
        "Solo se condona interés devengado y no pagado. Lo que ya se pagó no se condona.",
        { monto: p.monto, pendiente: total },
      );
    }
    if (!p.confirmarCondonacion) {
      rechazar(
        "condonacion_requiere_confirmacion",
        `Se van a condonar $ ${p.monto} de interés de esta unidad (el pendiente es $ ${total}).`,
        "La condonación no se deshace: queda en el registro con su motivo, y el saldo de la unidad baja exactamente ese importe.",
        { monto: p.monto, pendiente: total },
      );
    }
    let resto = aCentavos(p.monto);
    // La primera fila del acto: con ella la pantalla vuelve a leer lo condonado («Listo:», encargo 10).
    let condonacionId: string | null = null;
    for (const x of pendientes) {
      if (resto <= 0n) break;
      const parte = resto < aCentavos(x.pendiente) ? resto : aCentavos(x.pendiente);
      const id = await insertarCondonacion(tx, { interesId: x.id, monto: deCentavos(parte), origen: "estado_cuenta", pagoId: null, datos: p });
      condonacionId ??= id;
      resto -= parte;
    }
    return { condonado: p.monto, condonacionId };
  });
}

/** Días de atraso de cada unidad con capital vencido e impago: del vencimiento más antiguo a hoy, en la hora del barrio. */
export async function diasDeAtrasoPorUnidad(
  tx: DbConIdentidad,
  parametros: { readonly barrioId: string; readonly unidadFuncionalId?: string },
): Promise<Map<string, { readonly dias: number; readonly desde: string }>> {
  const { barrioId } = consultaBarrioSchema.parse({ barrioId: parametros.barrioId });
  const unidad = parametros.unidadFuncionalId ?? null;
  const { rows } = await tx.execute<{ unidad_funcional_id: string; desde: string; dias: number }>(sql`
    with hoy as (select (now() at time zone b.zona_horaria)::date as dia from barrio b where b.barrio_id = ${barrioId})
    select l.unidad_funcional_id, min(pe.primer_vencimiento)::text as desde,
           ((select dia from hoy) - min(pe.primer_vencimiento))::int as dias
      from liquidacion l
      join periodo_expensa pe on pe.id = l.periodo_id
     where l.barrio_id = ${barrioId}
       and (${unidad}::uuid is null or l.unidad_funcional_id = ${unidad}::uuid)
       and pe.estado in ('emitida', 'distribuida')
       and pe.primer_vencimiento < (select dia from hoy)
       and app.capital_pendiente(l.id) > 0
     group by l.unidad_funcional_id
  `);
  return new Map(rows.map((r) => [r.unidad_funcional_id, { dias: Number(r.dias), desde: r.desde }]));
}

/**
 * Lo condonado en un acto de `condonarInteres` desde el estado de cuenta de la unidad, a partir de la
 * primera fila del acto (`condonacionId`): para el «Listo:» de la pantalla al volver de condonar
 * (encargo 10). Un acto puede dejar varias filas (una por cada interés pendiente que alcanza), todas con
 * el mismo `created_at` —es el `now()` de la transacción— y el mismo autor, y por eso se suman las de
 * ese instante. Con el id, una URL vieja no muestra «la última» condonación sino la suya
 * (security-engineer). `null` si la fila no es de esa unidad o no se ve.
 */
export async function condonacionDeUnidad(
  tx: DbConIdentidad,
  parametros: { readonly unidadFuncionalId: string; readonly condonacionId: string },
): Promise<{ readonly monto: Monto } | null> {
  const { unidadFuncionalId } = consultaUnidadSchema.parse({ unidadFuncionalId: parametros.unidadFuncionalId });
  const { unidadFuncionalId: condonacionId } = consultaUnidadSchema.parse({ unidadFuncionalId: parametros.condonacionId });
  const { rows } = await tx.execute<{ total: string | null }>(sql`
    select sum(c.monto)::numeric(14,2)::text as total
      from interes_condonacion c
      join interes_condonacion acto on acto.id = ${condonacionId}
     where c.unidad_funcional_id = ${unidadFuncionalId}
       and acto.unidad_funcional_id = ${unidadFuncionalId}
       and c.origen = 'estado_cuenta'
       and c.created_at = acto.created_at
       and c.creado_por = acto.creado_por
  `);
  const total = rows[0]?.total ?? null;
  return total === null ? null : { monto: deCentavos(aCentavos(total)) };
}

/** Lo condonado en un barrio en un mes (`YYYY-MM`, en la hora del barrio): el total por barrio y período. */
export async function interesCondonadoEnElPeriodo(
  tx: DbConIdentidad,
  parametros: { readonly barrioId: string; readonly periodo: string },
): Promise<{ readonly total: Monto; readonly condonaciones: number }> {
  const { barrioId } = consultaBarrioSchema.parse({ barrioId: parametros.barrioId });
  const { rows } = await tx.execute<{ total: string; n: string }>(sql`
    select coalesce(sum(c.monto), 0)::numeric(14,2)::text as total, count(*)::text as n
      from interes_condonacion c join barrio b on b.barrio_id = c.barrio_id
     where c.barrio_id = ${barrioId}
       and c.anulado_at is null -- una condonación anulada con su pago ya no condona nada (0068)
       and to_char(c.created_at at time zone b.zona_horaria, 'YYYY-MM') = ${parametros.periodo}
  `);
  return { total: deCentavos(aCentavos(rows[0]?.total ?? "0.00")), condonaciones: Number(rows[0]?.n ?? "0") };
}

const ETIQUETA_ORDEN: Record<OrdenImputacionBarrio, string> = {
  intereses_primero_capital_antiguo: "Intereses primero",
  capital_primero: "Capital primero",
};

export type PagoRegistradoEImputado = PagoEscrito & PagoImputado;

/**
 * Registra un pago y lo imputa en el mismo acto (ADR-0009). Si el pago llega fuera de término y
 * devengó interés, **la primera vez no escribe nada**: rechaza con
 * `pago_con_interes_requiere_confirmacion` diciendo cuánto interés devengó, en cuántos días, y cómo se
 * va a imputar —con o sin «No cobrar interés de este pago»—; la pantalla lo muestra y se reintenta con
 * `confirmarPagoConInteres`.
 */
export async function registrarEImputarPago(
  tx: DbConIdentidad,
  entrada: {
    readonly pago: RegistrarPago;
    readonly confirmarPagoConInteres: boolean;
    readonly noCobrarInteres: NoCobrarInteres | null;
    /**
     * Qué partes condona «No cobrar interés» (encargo 11, BL-030 j): el interés de este atraso, el
     * anterior que la unidad todavía debe, o los dos. Sin decir, solo el de este atraso, como antes.
     */
    readonly condonar?: PartesQueSeCondonan;
    /**
     * Las cifras que se le mostraron a la persona al pedirle la confirmación (`datos.cifras` del
     * pedido, devuelto tal cual por la pantalla). Si al confirmar el interés o el reparto ya no son
     * esos —entró otro pago, se condonó, cambió el día—, se vuelve a pedir la confirmación con las
     * cifras nuevas (encargo 8, BL-022 b). `undefined` = quien llama no pasa por una pantalla (un
     * script o un test) y no hay cifras mostradas que comparar.
     */
    readonly cifrasConfirmadas?: string;
  },
): Promise<PagoRegistradoEImputado> {
  // BL-022 f (encargo 9): los pagos de una unidad, de a uno. El candado se toma antes de leer la deuda,
  // así un segundo pago simultáneo espera y calcula con lo que ya imputó el primero (`0068`).
  await serializarCobrosDeLaUnidad(tx, entrada.pago.unidadFuncionalId);
  const { rows: hoy } = await tx.execute<{ futuro: boolean }>(sql`
    select ${entrada.pago.fecha}::date > (now() at time zone b.zona_horaria)::date as futuro
      from unidad_funcional u join barrio b on b.barrio_id = u.barrio_id where u.id = ${entrada.pago.unidadFuncionalId}
  `);
  if (hoy[0]?.futuro) {
    rechazar(
      "dato_invalido",
      "La fecha del pago es posterior a hoy.",
      "Revisá la fecha: es cuándo se cobró, y no puede ser futura (el interés se calcula hasta esa fecha).",
    );
  }
  const vista = await vistaPreviaDelPago(tx, {
    unidadFuncionalId: entrada.pago.unidadFuncionalId,
    fecha: entrada.pago.fecha,
    monto: entrada.pago.monto as Monto,
  });
  // Lo que «No cobrar interés» condonaría de cada parte (encargo 11, BL-030 j): el interés de este
  // atraso entero, y todo el interés anterior pendiente. Lo que no se condona, se cobra en el orden del
  // barrio (`repartirPago`, el mismo reparto de siempre con el interés que queda).
  const partes = entrada.noCobrarInteres ? (entrada.condonar ?? SOLO_EL_DEL_PAGO) : { delPago: false, anterior: false };
  // «No cobrar» sin ninguna parte no condona nada: se rechaza acá también, no solo en la pantalla
  // (code-reviewer, encargo 11).
  if (entrada.noCobrarInteres && !partes.delPago && !partes.anterior) {
    rechazar(
      "dato_invalido",
      "Marcaste «No cobrar el interés» sin elegir qué interés.",
      "Marcá el interés de este atraso, el anterior o los dos, o desmarcá «No cobrar el interés».",
    );
  }
  const condonaDelPago: Monto = partes.delPago ? vista.interesDelPago : "0.00";
  const condonaAnterior: Monto = partes.anterior ? vista.interesPendiente : "0.00";
  const r = repartirPago({
    monto: entrada.pago.monto as Monto,
    interes: sumarMontos(partes.anterior ? "0.00" : vista.interesPendiente, partes.delPago ? "0.00" : vista.interesDelPago),
    capital: vista.capital,
    orden: vista.orden,
  });
  // La huella de lo que se muestra: interés, días, reparto y qué se condona. Es lo que la persona
  // confirma; si cambió, lo confirmado ya no es lo que se va a escribir.
  const cifras = [
    vista.interesDelPago, String(vista.diasDeAtraso), r.aInteres, r.aCapital, r.sobrante,
    entrada.noCobrarInteres ? `condona:${condonaDelPago}:${condonaAnterior}` : "cobra",
  ].join("|");
  const cambiaron =
    entrada.confirmarPagoConInteres && entrada.cifrasConfirmadas !== undefined && entrada.cifrasConfirmadas !== cifras;
  // Se confirma si el pago devengó interés, y también si se condona interés anterior: condonar no se
  // deshace sin anular el pago, y la persona tiene que ver el importe antes.
  const hayQueConfirmar = aCentavos(vista.interesDelPago) > 0n || aCentavos(condonaAnterior) > 0n;
  if (hayQueConfirmar && (!entrada.confirmarPagoConInteres || cambiaron)) {
    const pesos = (m: Monto) => `$ ${formatearMonto(m)}`;
    const queSeCondona = [
      aCentavos(condonaDelPago) > 0n ? `${pesos(condonaDelPago)} del interés de este atraso` : null,
      aCentavos(condonaAnterior) > 0n ? `${pesos(condonaAnterior)} de interés anterior que la unidad todavía debía` : null,
    ].filter((x): x is string => x !== null);
    const mensaje =
      (cambiaron ? "Las cifras cambiaron desde que se mostraron: revisalas de nuevo. " : "") +
      (aCentavos(vista.interesDelPago) > 0n
        ? `Este pago es fuera de término: el capital impago devengó ${pesos(vista.interesDelPago)} de interés ` +
          `(${vista.diasDeAtraso} días desde el vencimiento más antiguo).`
        : "Este pago no devengó interés nuevo.") +
      (entrada.noCobrarInteres && queSeCondona.length > 0
        ? ` Marcaste «No cobrar interés»: se condonan ${queSeCondona.join(" y ")}, y el pago va a ${pesos(r.aCapital)} de capital` +
          (aCentavos(r.aInteres) > 0n ? ` y ${pesos(r.aInteres)} de interés que sí se cobra.` : ".")
        : ` Con «${ETIQUETA_ORDEN[vista.orden]}» se imputa ${pesos(r.aInteres)} a interés y ${pesos(r.aCapital)} a capital.`);
    rechazar(
      "pago_con_interes_requiere_confirmacion",
      mensaje,
      aCentavos(r.sobrante) > 0n
        ? `Quedan ${pesos(r.sobrante)} a cuenta, sin imputar.`
        : "Lo que quede pendiente aparece en la boleta siguiente como interés por mora.",
      { interes: vista.interesDelPago, dias: String(vista.diasDeAtraso), aInteres: r.aInteres, aCapital: r.aCapital, cifras },
    );
  }
  const escrito = await registrarPago(tx, entrada.pago);
  const imputado = await imputarPagoConInteres(tx, {
    pagoId: escrito.id,
    noCobrarInteres: entrada.noCobrarInteres,
    condonar: entrada.noCobrarInteres ? partes : undefined,
  });
  return { ...escrito, ...imputado };
}

/** Si quien mira puede condonar interés en el barrio: para mostrar u ocultar el diálogo (la base decide igual). */
export async function puedeCondonarEnElBarrio(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<boolean> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);
  const { rows } = await tx.execute<{ puede: boolean }>(sql`
    select app.has_role_on(${barrioId}::uuid, array['admin_plataforma','admin_barrio']::app.rol_membership[]) as puede
  `);
  return rows[0]?.puede ?? false;
}
