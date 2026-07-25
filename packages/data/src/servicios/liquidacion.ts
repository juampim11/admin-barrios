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
import type { Db } from "../client.ts";

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
  tx: Db,
  parametros: { periodoId: string; saldosAnteriores?: Map<string, string>; diasDeAtraso?: number },
): Promise<ResumenLiquidacion> {
  const { periodoId, saldosAnteriores, diasDeAtraso = 0 } = parametros;

  const periodo = (
    await tx.execute<{
      id: string;
      barrio_id: string;
      estado: string;
      modelo: ModeloExpensa;
      coeficiente_version_id: string | null;
      cuota_fija_version_id: string | null;
    }>(
      sql`select id, barrio_id, estado, modelo, coeficiente_version_id, cuota_fija_version_id
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

  const unidades: UnidadAPRorratear[] = (
    await tx.execute<{ unidad_funcional_id: string; valor: string }>(sql`
      select c.unidad_funcional_id, c.valor
        from coeficiente c
        join unidad_funcional u on u.id = c.unidad_funcional_id
       where c.version_id = ${versionId} and u.baja_at is null
       order by u.manzana, u.lote
    `)
  ).rows.map((r) => ({ unidadFuncionalId: r.unidad_funcional_id, coeficiente: r.valor }));

  const gastos: GastoDelPeriodo[] = (
    await tx.execute<{
      id: string;
      concepto_id: string;
      descripcion: string;
      tipo: "ordinaria" | "extraordinaria";
      es_fondo_reserva: boolean;
      monto: string;
      sin_respaldo_asamblea: boolean;
    }>(sql`
      select g.id, g.concepto_id, g.descripcion, c.tipo, c.es_fondo_reserva, g.monto, g.sin_respaldo_asamblea
        from gasto_periodo g join concepto c on c.id = g.concepto_id
       where g.periodo_id = ${periodoId}
       order by g.created_at
    `)
  ).rows.map((r) => ({
    gastoId: r.id,
    conceptoId: r.concepto_id,
    descripcion: r.descripcion,
    tipo: r.tipo,
    esFondoReserva: r.es_fondo_reserva,
    monto: r.monto,
    sinRespaldoAsamblea: r.sin_respaldo_asamblea,
  }));

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
                                 subtotal_cuota_fija, subtotal_ordinarias, subtotal_extraordinarias,
                                 subtotal_fondo_reserva, saldo_anterior, interes_mora, mora_pendiente_definicion,
                                 tasa_mora_aplicada, total)
        values (${periodo.barrio_id}, ${periodoId}, ${liq.unidadFuncionalId}, ${obligadoId}, ${liq.coeficienteAplicado},
                ${liq.subtotalCuotaFija}, ${liq.subtotalOrdinarias}, ${liq.subtotalExtraordinarias},
                ${liq.subtotalFondoReserva}, ${saldoAnterior}, ${mora.interes}, ${mora.interes === null},
                ${tasa}, ${total})
        returning id
      `)
    ).rows[0];
    if (!creada) throw new Error("no se pudo crear la liquidación");

    for (const item of liq.items) {
      await tx.execute(sql`
        insert into item_liquidacion (barrio_id, liquidacion_id, gasto_id, concepto_id, descripcion, tipo,
                                      es_fondo_reserva, es_cuota_fija, base_monto, coeficiente_aplicado, monto)
        values (${periodo.barrio_id}, ${creada.id}, ${item.gastoId}, ${item.conceptoId}, ${item.descripcion},
                ${item.tipo}, ${item.esFondoReserva}, ${item.esCuotaFija}, ${item.baseMonto},
                ${item.coeficienteAplicado}, ${item.monto})
      `);
    }
  }

  await tx.execute(sql`
    update periodo_expensa
       set coeficiente_version_id = ${versionId},
           cuota_fija_version_id = ${cuotaFijaVersionId},
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
 */
export async function emitirPeriodo(tx: Db, periodoId: string, usuarioId: string): Promise<void> {
  await tx.execute(sql`
    update periodo_expensa set estado = 'emitida', emitida_por = ${usuarioId} where id = ${periodoId}
  `);
}
