/**
 * Servicio de liquidación: orquesta lectura → cálculo puro → escritura.
 *
 * El **cálculo** vive en `@admin-barrios/shared/liquidacion` (sin base, testeado aparte). Acá solo se
 * lee el estado del barrio, se llama al cálculo y se persiste, todo **dentro de una transacción** con
 * la identidad del usuario puesta (la RLS decide qué barrio puede tocar).
 *
 * Los invariantes duros (extraordinaria con acta, período emitido inmutable, cuadre al emitir) los
 * hace cumplir la base — ver `0005_expensas_rls.sql`. Este código no es la última línea de defensa.
 */

import { sql } from "drizzle-orm";
import {
  calcularLiquidacion,
  calcularMora,
  type GastoDelPeriodo,
  type ModeloExpensa,
  type UnidadAPRorratear,
} from "@admin-barrios/shared/liquidacion";
import type { DbConIdentidad } from "../client.ts";

/** Número de comprobante legible. Si falta la etiqueta de la unidad, es un bug: se corta acá. */
function numeroComprobante(periodo: string, etiquetas: Map<string, string>, unidadId: string): string {
  const etiqueta = etiquetas.get(unidadId);
  if (!etiqueta) throw new Error(`no se pudo armar el comprobante: falta la unidad ${unidadId}`);
  return `${periodo}-${etiqueta}`;
}

export type ResumenLiquidacion = {
  periodoId: string;
  modelo: ModeloExpensa;
  unidadesLiquidadas: number;
  /** Gastos registrados en el período (en el modelo fijo no son lo que se cobra). */
  totalGastos: string;
  /** Cuotas fijas cobradas (0 en el modelo variable). */
  totalCuotasFijas: string;
  totalRepartido: string;
  /** Unidades cuya mora no se pudo calcular porque el barrio no tiene tasa cargada. */
  conMoraPendiente: number;
  /** Extraordinarias cargadas sin acta de asamblea: no bloquean, pero conviene avisarlo. */
  extraordinariasSinRespaldo: number;
};

/**
 * Genera (o regenera) las liquidaciones de un período en **borrador**.
 *
 * Regenerar es seguro: borra las liquidaciones previas del período y las vuelve a calcular. Si el
 * período ya está emitido, la base rechaza la operación.
 */
export async function generarLiquidaciones(
  tx: DbConIdentidad,
  parametros: {
    periodoId: string;
    saldosAnteriores?: Map<string, string>;
    diasDeAtraso?: number;
    /** Hasta qué fecha se computó la mora (queda impresa en la liquidación). */
    fechaCorteMora?: string;
  },
): Promise<ResumenLiquidacion> {
  const { periodoId, saldosAnteriores, diasDeAtraso = 0, fechaCorteMora } = parametros;

  // Si se van a cobrar intereses, hay que decir hasta qué fecha se computaron: sin eso la cifra no se
  // puede rehacer y el sistema no inventa una fecha (misma regla que con la tasa de mora).
  if (diasDeAtraso > 0 && !fechaCorteMora) {
    throw new Error("para cobrar mora hay que indicar `fechaCorteMora`: hasta qué fecha se computó");
  }

  const periodo = (
    await tx.execute<{
      id: string;
      barrio_id: string;
      estado: string;
      periodo: string;
      modelo: ModeloExpensa;
      coeficiente_version_id: string | null;
      cuota_fija_version_id: string | null;
    }>(
      sql`select id, barrio_id, estado, periodo, modelo, coeficiente_version_id, cuota_fija_version_id
            from periodo_expensa where id = ${periodoId}`,
    )
  ).rows[0];
  if (!periodo) throw new Error("el período no existe o no es accesible");
  if (periodo.estado !== "borrador" && periodo.estado !== "revisada") {
    throw new Error(`el período está ${periodo.estado}: solo se liquida en borrador o revisada`);
  }

  // Versión de coeficientes: la del período si ya quedó fijada, o la vigente cerrada del barrio.
  const versionId =
    periodo.coeficiente_version_id ??
    (
      await tx.execute<{ id: string }>(sql`
        select id from coeficiente_version
         where barrio_id = ${periodo.barrio_id} and cerrada and vigente_hasta is null
         order by vigente_desde desc limit 1
      `)
    ).rows[0]?.id;
  if (!versionId) throw new Error("el barrio no tiene una versión de coeficientes cerrada y vigente");

  const filasUnidades = (
    await tx.execute<{ unidad_funcional_id: string; valor: string; manzana: string; lote: string }>(sql`
      select c.unidad_funcional_id, c.valor, u.manzana, u.lote
        from coeficiente c
        join unidad_funcional u on u.id = c.unidad_funcional_id
       where c.version_id = ${versionId} and u.baja_at is null
       order by u.manzana, u.lote
    `)
  ).rows;
  const unidades: UnidadAPRorratear[] = filasUnidades.map((r) => ({
    unidadFuncionalId: r.unidad_funcional_id,
    coeficiente: r.valor,
  }));
  const etiquetaUnidad = new Map(filasUnidades.map((r) => [r.unidad_funcional_id, `M${r.manzana}L${r.lote}`]));

  const filasGastos = (
    await tx.execute<{
      id: string;
      concepto_id: string;
      descripcion: string;
      tipo: "ordinaria" | "extraordinaria";
      es_fondo_reserva: boolean;
      monto: string;
      sin_respaldo_asamblea: boolean;
      clasificacion_fiscal: string;
      acta_titulo: string | null;
    }>(sql`
      select g.id, g.concepto_id, g.descripcion, c.tipo, c.es_fondo_reserva, g.monto,
             g.sin_respaldo_asamblea, c.clasificacion_fiscal, d.titulo as acta_titulo
        from gasto_periodo g
        join concepto c on c.id = g.concepto_id
        left join documento_barrio d on d.id = g.acta_documento_id
       where g.periodo_id = ${periodoId}
       order by g.created_at
    `)
  ).rows;

  const gastos: GastoDelPeriodo[] = filasGastos.map((r) => ({
    gastoId: r.id,
    conceptoId: r.concepto_id,
    descripcion: r.descripcion,
    tipo: r.tipo,
    esFondoReserva: r.es_fondo_reserva,
    monto: r.monto,
    sinRespaldoAsamblea: r.sin_respaldo_asamblea,
  }));

  // Snapshot por gasto: el catálogo de conceptos es editable después de emitir, así que lo que
  // muestre un documento regenerado tiene que salir de la liquidación y no del catálogo de hoy.
  const snapshotPorGasto = new Map(
    filasGastos.map((r) => [
      r.id,
      {
        clasificacionFiscal: r.clasificacion_fiscal,
        actaTitulo: r.acta_titulo,
        sinRespaldoAsamblea: r.sin_respaldo_asamblea,
      },
    ]),
  );

  // La denominación del concepto se congela en el período (la figura jurídica se versiona: si el
  // barrio cambia de figura, no puede cambiar la etiqueta de lo ya emitido).
  const denominacion =
    (
      await tx.execute<{ denominacion_concepto: string | null }>(sql`
        select denominacion_concepto from barrio where barrio_id = ${periodo.barrio_id}
      `)
    ).rows[0]?.denominacion_concepto ?? null;

  // Modelo fijo: la cuota de cada unidad sale de la versión vigente (o de la que ya quedó fijada).
  let cuotaFijaVersionId: string | null = null;
  let cuotasFijas: Map<string, string> | undefined;
  if (periodo.modelo === "fija") {
    cuotaFijaVersionId =
      periodo.cuota_fija_version_id ??
      (
        await tx.execute<{ id: string }>(sql`
          select id from cuota_fija_version
           where barrio_id = ${periodo.barrio_id} and vigente_hasta is null
           order by vigente_desde desc limit 1
        `)
      ).rows[0]?.id ??
      null;
    if (!cuotaFijaVersionId) {
      throw new Error("el barrio liquida por cuota fija pero no tiene una cuota vigente cargada");
    }
    const filas = (
      await tx.execute<{ unidad_funcional_id: string; importe: string }>(sql`
        select unidad_funcional_id, importe from cuota_fija where version_id = ${cuotaFijaVersionId}
      `)
    ).rows;
    cuotasFijas = new Map(filas.map((f) => [f.unidad_funcional_id, f.importe]));
  }

  const { liquidaciones, totalGastos, totalCuotasFijas, totalRepartido, extraordinariasSinRespaldo } =
    calcularLiquidacion({
      modelo: periodo.modelo,
      gastos,
      unidades,
      ...(cuotasFijas ? { cuotasFijas } : {}),
    });

  // Tasa de mora del barrio: si no hay, no se inventa (la liquidación sale marcada).
  const tasa =
    (await tx.execute<{ tasa: string | null }>(sql`select app.tasa_mora_vigente(${periodo.barrio_id}) as tasa`))
      .rows[0]?.tasa ?? null;

  await tx.execute(sql`delete from liquidacion where periodo_id = ${periodoId}`);

  let conMoraPendiente = 0;
  for (const liq of liquidaciones) {
    const saldoAnterior = saldosAnteriores?.get(liq.unidadFuncionalId) ?? "0.00";
    // Por fila: si se cargó el saldo de 3 unidades sobre 200, las otras 197 no tienen "carga manual".
    const origenSaldo = saldosAnteriores?.has(liq.unidadFuncionalId) ? "carga_manual" : "sin_movimientos";
    const mora = calcularMora({ saldoVencido: saldoAnterior, tasaMensual: tasa, diasDeAtraso });
    if (mora.interes === null) conMoraPendiente++;

    const total = (
      await tx.execute<{ total: string }>(sql`
        select (${liq.total}::numeric + ${saldoAnterior}::numeric + coalesce(${mora.interes}::numeric, 0))::numeric(14,2) as total
      `)
    ).rows[0]?.total;

    const obligadoId =
      (
        await tx.execute<{ obligado_id: string }>(sql`
          select obligado_id from unidad_obligado
           where unidad_funcional_id = ${liq.unidadFuncionalId} and hasta is null and es_notificado
           limit 1
        `)
      ).rows[0]?.obligado_id ?? null;

    const creada = (
      await tx.execute<{ id: string }>(sql`
        insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, obligado_id, coeficiente_aplicado,
                                 numero_comprobante, subtotal_cuota_fija, subtotal_ordinarias,
                                 subtotal_extraordinarias, subtotal_fondo_reserva, saldo_anterior,
                                 saldo_anterior_origen, interes_mora, mora_pendiente_definicion,
                                 tasa_mora_aplicada, dias_atraso, fecha_corte_mora, total)
        values (${periodo.barrio_id}, ${periodoId}, ${liq.unidadFuncionalId}, ${obligadoId}, ${liq.coeficienteAplicado},
                ${numeroComprobante(periodo.periodo, etiquetaUnidad, liq.unidadFuncionalId)},
                ${liq.subtotalCuotaFija}, ${liq.subtotalOrdinarias}, ${liq.subtotalExtraordinarias},
                ${liq.subtotalFondoReserva}, ${saldoAnterior}, ${origenSaldo}, ${mora.interes},
                ${mora.interes === null}, ${tasa}, ${mora.interes === null ? null : diasDeAtraso},
                ${mora.interes === null ? null : fechaCorteMora ?? null}, ${total})
        returning id
      `)
    ).rows[0];
    if (!creada) throw new Error("no se pudo crear la liquidación");

    for (const item of liq.items) {
      await tx.execute(sql`
        insert into item_liquidacion (barrio_id, liquidacion_id, gasto_id, concepto_id, descripcion, tipo,
                                      es_fondo_reserva, es_cuota_fija, clasificacion_fiscal,
                                      sin_respaldo_asamblea, acta_titulo, base_monto, coeficiente_aplicado,
                                      monto, monto_teorico, ajuste_redondeo)
        values (${periodo.barrio_id}, ${creada.id}, ${item.gastoId}, ${item.conceptoId}, ${item.descripcion},
                ${item.tipo}, ${item.esFondoReserva}, ${item.esCuotaFija},
                ${item.gastoId ? (snapshotPorGasto.get(item.gastoId)?.clasificacionFiscal ?? null) : null},
                ${item.gastoId ? (snapshotPorGasto.get(item.gastoId)?.sinRespaldoAsamblea ?? false) : false},
                ${item.gastoId ? (snapshotPorGasto.get(item.gastoId)?.actaTitulo ?? null) : null},
                ${item.baseMonto}, ${item.coeficienteAplicado}, ${item.monto},
                ${item.montoTeorico}, ${item.ajusteRedondeo})
      `);
    }
  }

  await tx.execute(sql`
    update periodo_expensa
       set coeficiente_version_id = ${versionId},
           cuota_fija_version_id = ${cuotaFijaVersionId},
           denominacion_concepto = ${denominacion},
           total_gastos = ${totalGastos}
     where id = ${periodoId}
  `);

  return {
    periodoId,
    modelo: periodo.modelo,
    unidadesLiquidadas: liquidaciones.length,
    totalGastos,
    totalCuotasFijas,
    totalRepartido,
    conMoraPendiente,
    extraordinariasSinRespaldo,
  };
}

/**
 * Emite el período. La validación pesada (cuadre, unidades completas, versión cerrada) la corre la
 * base en el trigger de transición: acá solo se pide el cambio de estado.
 *
 * **No recibe el usuario a propósito.** La firma de quién emitió la pone la base desde la identidad
 * de la sesión (`app.current_user_id()`): si viniera por parámetro, cualquiera podría firmar con el
 * nombre de otro. Por eso hay que llamarla dentro de `conUsuario()`.
 */
export async function emitirPeriodo(tx: DbConIdentidad, periodoId: string): Promise<void> {
  await tx.execute(sql`update periodo_expensa set estado = 'emitida' where id = ${periodoId}`);
}
