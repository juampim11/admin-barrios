/**
 * Imputación de pagos contra liquidaciones, manual o automática, y el estado de cuenta de una
 * unidad. Mismo patrón que el resto del módulo: Zod valida forma, la base decide fondo
 * (`app.pago_imputacion_antes()`, `app.resolver_imputacion()`), `enBase()` traduce.
 *
 * **`resolverImputacionAutomatica()` no reemplaza a `imputarPago()`.** La automática recorre las
 * liquidaciones pendientes de la unidad del pago según `barrio.orden_imputacion`; la manual imputa
 * una línea concreta, elegida por la persona. Las dos pasan por el mismo trigger
 * (`app.pago_imputacion_antes()`), así que las dos respetan el mismo tope: no se sobre-imputa ni la
 * liquidación ni el pago.
 */

import { sql } from "drizzle-orm";
import {
  anularImputacionSchema,
  imputarPagoSchema,
  resolverImputacionAutomaticaSchema,
  type AnularImputacion,
  type ImputarPago,
  type ResolverImputacionAutomatica,
} from "@admin-barrios/shared/escrituras";
import { consultaUnidadSchema } from "@admin-barrios/shared/consultas";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";

export type ImputacionEscrita = {
  readonly id: string;
  readonly pagoId: string;
  readonly liquidacionId: string;
  readonly montoImputado: string;
};

type FilaImputacion = {
  id: string;
  pago_id: string;
  liquidacion_id: string;
  monto_imputado: string;
};

const mapearImputacion = (f: FilaImputacion): ImputacionEscrita => ({
  id: f.id,
  pagoId: f.pago_id,
  liquidacionId: f.liquidacion_id,
  montoImputado: f.monto_imputado,
});

/** Imputación manual, línea por línea: este pago contra esta liquidación, por este importe. */
export async function imputarPago(tx: DbConIdentidad, parametros: ImputarPago): Promise<ImputacionEscrita> {
  const p = imputarPagoSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<FilaImputacion>(sql`
      insert into pago_imputacion (pago_id, liquidacion_id, monto_imputado)
      values (${p.pagoId}, ${p.liquidacionId}, ${p.montoImputado}::numeric)
      returning id, pago_id, liquidacion_id, monto_imputado::text
    `);

    const fila = rows[0];
    if (!fila) {
      rechazar(
        "desconocido",
        "No se pudo registrar la imputación.",
        "Recargá la pantalla y volvé a intentar. Si sigue pasando, pasale el código de referencia a quien te da soporte.",
      );
    }
    return mapearImputacion(fila);
  });
}

/**
 * Imputa automáticamente el remanente de un pago contra las liquidaciones pendientes de su unidad,
 * según `barrio.orden_imputacion`. Devuelve las imputaciones vivas del pago **después** de correr
 * (no solo las que se acaban de crear): si el pago ya estaba parcialmente imputado a mano, la lista
 * completa es lo que la pantalla necesita mostrar.
 */
export async function resolverImputacionAutomatica(
  tx: DbConIdentidad,
  parametros: ResolverImputacionAutomatica,
): Promise<ImputacionEscrita[]> {
  const { pagoId } = resolverImputacionAutomaticaSchema.parse(parametros);

  return enBase(async () => {
    await tx.execute(sql`select app.resolver_imputacion(${pagoId})`);

    const { rows } = await tx.execute<FilaImputacion>(sql`
      select id, pago_id, liquidacion_id, monto_imputado::text
        from pago_imputacion
       where pago_id = ${pagoId} and anulado_at is null
       order by created_at
    `);
    return rows.map(mapearImputacion);
  });
}

/** Anula una imputación, con motivo. Libera el saldo tanto del pago como de la liquidación. */
export async function anularImputacion(tx: DbConIdentidad, parametros: AnularImputacion): Promise<void> {
  const p = anularImputacionSchema.parse(parametros);

  await enBase(async () => {
    const resultado = await tx.execute(sql`
      update pago_imputacion
         set anulado_at = now(),
             anulado_por = app.current_user_id(),
             motivo_anulacion = ${p.motivo}
       where id = ${p.imputacionId}
         and anulado_at is null
    `);
    if ((resultado.rowCount ?? 0) > 0) return;

    const { rows } = await tx.execute<{ anulada: boolean }>(
      sql`select anulado_at is not null as anulada from pago_imputacion where id = ${p.imputacionId}`,
    );
    if (rows[0]?.anulada) {
      rechazar(
        "imputacion_ya_anulada",
        "Esa imputación ya estaba anulada.",
        "Una anulación no se revierte ni se reescribe. Si hay que volver a imputar el pago, cargá una imputación nueva.",
      );
    }
    rechazar(
      "imputacion_no_encontrada",
      "Esa imputación no existe o no tenés permiso para anularla.",
      "Recargá la lista de imputaciones.",
    );
  });
}

/** Un movimiento del estado de cuenta de una unidad: un débito (liquidación) o un crédito (pago). */
export type MovimientoEstadoCuenta = {
  readonly fecha: string;
  readonly origenId: string;
  readonly tipo: "debito" | "credito";
  readonly monto: string;
  readonly saldoCorriente: string;
};

/**
 * El estado de cuenta de UNA unidad, línea por línea — consulta `app.v_estado_cuenta_uf`
 * (`security_invoker = true`, migración `0037`): la RLS de `liquidacion`/`pago`/`pago_imputacion` se
 * sigue aplicando a través de la vista, así que esto nunca devuelve el estado de cuenta de una
 * unidad que el usuario no puede leer.
 *
 * **No usar para "todas las unidades del barrio"**: para esa grilla está `saldo_uf`, que no
 * reordena la historia completa en cada consulta (ver el comentario de `0037_estado_cuenta.sql`).
 */
export async function estadoDeCuenta(
  tx: DbConIdentidad,
  parametros: { unidadFuncionalId: string },
): Promise<MovimientoEstadoCuenta[]> {
  const { unidadFuncionalId } = consultaUnidadSchema.parse(parametros);

  const { rows } = await tx.execute<{
    fecha: string;
    origen_id: string;
    tipo: "debito" | "credito";
    monto: string;
    saldo_corriente: string;
  }>(sql`
    select fecha::text, origen_id, tipo, monto::text, saldo_corriente::text
      from app.v_estado_cuenta_uf
     where unidad_funcional_id = ${unidadFuncionalId}
     order by fecha, origen_id
  `);

  return rows.map((r) => ({
    fecha: r.fecha,
    origenId: r.origen_id,
    tipo: r.tipo,
    monto: r.monto,
    saldoCorriente: r.saldo_corriente,
  }));
}
