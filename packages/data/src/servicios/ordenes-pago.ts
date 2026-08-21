/**
 * El circuito de una orden de pago: cargarla, aprobarla/rechazarla, marcarla pagada, anularla, y el
 * comprobante que se le adjunta.
 *
 * **Casi toda la lógica de negocio vive en la base, no acá.** `app.orden_pago_transicion()`
 * (`0044_ordenes_pago_reglas.sql`) es la que valida la lista blanca de transiciones, congela las
 * columnas fuera de `pendiente`, aplica los gates de rol por transición, el control de cuatro-ojos,
 * y genera/revierte la fila de `gasto_periodo` correspondiente. Este archivo es una capa fina: arma
 * el `UPDATE` correcto para cada transición y traduce el resultado — mismo principio que
 * `gastos.ts`/`pagos.ts` (Zod parsea la forma, la base decide el fondo).
 *
 * **`barrioId` no viaja como parámetro en `registrarOrdenPago`**: se deriva de `periodoId` bajo RLS,
 * mismo patrón que `registrarGasto()`. En las transiciones (`aprobarOrdenPago`, etc.) tampoco hace
 * falta: el `WHERE id = $1` ya está acotado por la RLS de `UPDATE`, y el propio trigger deriva
 * cualquier dato que necesite de la fila misma.
 */

import { sql } from "drizzle-orm";
import {
  registrarOrdenPagoSchema,
  aprobarOrdenPagoSchema,
  rechazarOrdenPagoSchema,
  marcarOrdenPagadaSchema,
  anularOrdenPagoSchema,
  prepararSubidaDeComprobanteDeOPSchema,
  adjuntarComprobanteDeOPSchema,
  type RegistrarOrdenPago,
  type AprobarOrdenPago,
  type RechazarOrdenPago,
  type MarcarOrdenPagada,
  type AnularOrdenPago,
  type PrepararSubidaDeComprobanteDeOP,
  type AdjuntarComprobanteDeOP,
} from "@admin-barrios/shared/escrituras";
import { consultaBarrioSchema } from "@admin-barrios/shared/consultas";
import {
  claveDeComprobanteDeOP,
  nuevoToken,
  type ContentTypeDeComprobante,
} from "@admin-barrios/almacenamiento";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar, rechazarPeriodoInaccesible } from "../errores.ts";
import type { SubidaDeComprobantePreparada } from "./documentos.ts";

export type OrdenPago = {
  readonly id: string;
  readonly proveedorId: string;
  readonly periodoId: string;
  readonly conceptoId: string;
  readonly numeroFactura: string | null;
  readonly descripcion: string;
  readonly monto: string;
  readonly medioPago: string | null;
  readonly comprobanteAdjunto: string | null;
  readonly estado: string;
  readonly creadaPor: string;
  readonly creadaAt: string;
};

type FilaOrdenPago = {
  id: string;
  proveedor_id: string;
  periodo_id: string;
  concepto_id: string;
  numero_factura: string | null;
  descripcion: string;
  monto: string;
  medio_pago: string | null;
  comprobante_adjunto: string | null;
  estado: string;
  creada_por: string;
  creada_at: string;
};

const filaAOrdenPago = (f: FilaOrdenPago): OrdenPago => ({
  id: f.id,
  proveedorId: f.proveedor_id,
  periodoId: f.periodo_id,
  conceptoId: f.concepto_id,
  numeroFactura: f.numero_factura,
  descripcion: f.descripcion,
  monto: f.monto,
  medioPago: f.medio_pago,
  comprobanteAdjunto: f.comprobante_adjunto,
  estado: f.estado,
  creadaPor: f.creada_por,
  creadaAt: f.creada_at,
});

const COLUMNAS_ORDEN_PAGO = sql`id, proveedor_id, periodo_id, concepto_id, numero_factura, descripcion,
                                 monto::text, medio_pago, comprobante_adjunto, estado, creada_por,
                                 creada_at::text`;

/**
 * Carga una orden de pago en `pendiente`. **Una sola sentencia**: el barrio sale del período bajo
 * RLS y, si el período no es legible, no hay fila de origen y no se inserta nada — mismo patrón que
 * `registrarGasto()` (`gastos.ts`).
 */
export async function registrarOrdenPago(
  tx: DbConIdentidad,
  parametros: RegistrarOrdenPago,
): Promise<OrdenPago> {
  const p = registrarOrdenPagoSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<FilaOrdenPago>(sql`
      insert into orden_pago (barrio_id, proveedor_id, periodo_id, concepto_id, numero_factura,
                              descripcion, monto)
      select pe.barrio_id, ${p.proveedorId}, pe.id, ${p.conceptoId}, ${p.numeroFactura},
             ${p.descripcion}, ${p.monto}::numeric
        from periodo_expensa pe
       where pe.id = ${p.periodoId}
      returning ${COLUMNAS_ORDEN_PAGO}
    `);

    const fila = rows[0];
    // No hay forma de distinguir "no existe" de "no lo podés ver", y no se intenta — mismo criterio
    // que `registrarGasto()`.
    if (!fila) rechazarPeriodoInaccesible();
    return filaAOrdenPago(fila);
  });
}

/** Adjunta el comprobante ya subido. No es una transición de estado (no cambia `estado`) — por eso
 *  no pasa por `transicion()`, aunque el mensaje de error sea el mismo. */
export async function adjuntarComprobanteDeOP(
  tx: DbConIdentidad,
  parametros: AdjuntarComprobanteDeOP,
): Promise<OrdenPago> {
  const { ordenPagoId, storageKey } = adjuntarComprobanteDeOPSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<FilaOrdenPago>(sql`
      update orden_pago
         set comprobante_adjunto = ${storageKey}
       where id = ${ordenPagoId}
      returning ${COLUMNAS_ORDEN_PAGO}
    `);
    const fila = rows[0];
    if (!fila) {
      rechazar(
        "desconocido",
        "Esa orden de pago no existe, o no tenés permiso para modificarla.",
        "Recargá la lista de órdenes de pago del barrio.",
      );
    }
    return filaAOrdenPago(fila);
  });
}

async function transicion(
  tx: DbConIdentidad,
  ordenPagoId: string,
  set: ReturnType<typeof sql>,
): Promise<OrdenPago> {
  return enBase(async () => {
    const { rows } = await tx.execute<FilaOrdenPago>(sql`
      update orden_pago
         set ${set}
       where id = ${ordenPagoId}
      returning ${COLUMNAS_ORDEN_PAGO}
    `);
    const fila = rows[0];
    if (!fila) {
      rechazar(
        "desconocido",
        "Esa orden de pago no existe, o no tenés permiso para modificarla.",
        "Recargá la lista de órdenes de pago del barrio.",
      );
    }
    return filaAOrdenPago(fila);
  });
}

/** Aprueba la orden. `app.orden_pago_transicion()` hace todo lo demás: el gate de rol, el control de
 *  cuatro-ojos si el barrio lo tiene activo, y la generación de la fila de `gasto_periodo`. */
export async function aprobarOrdenPago(
  tx: DbConIdentidad,
  parametros: AprobarOrdenPago,
): Promise<OrdenPago> {
  const { ordenPagoId } = aprobarOrdenPagoSchema.parse(parametros);
  return transicion(tx, ordenPagoId, sql`estado = 'aprobada'`);
}

export async function rechazarOrdenPago(
  tx: DbConIdentidad,
  parametros: RechazarOrdenPago,
): Promise<OrdenPago> {
  const { ordenPagoId } = rechazarOrdenPagoSchema.parse(parametros);
  return transicion(tx, ordenPagoId, sql`estado = 'rechazada'`);
}

/** Marca la orden como pagada. `medioPago` es cómo se ejecutó ESTE pago — se manda en la misma
 *  transición, no antes: fuera de `pendiente` la columna está congelada salvo por esta vía. */
export async function marcarOrdenPagada(
  tx: DbConIdentidad,
  parametros: MarcarOrdenPagada,
): Promise<OrdenPago> {
  const { ordenPagoId, medioPago } = marcarOrdenPagadaSchema.parse(parametros);
  return transicion(tx, ordenPagoId, sql`estado = 'pagada', medio_pago = ${medioPago}`);
}

/**
 * Anula la orden, con motivo. Si ya había generado su `gasto_periodo` (venía de `aprobada` o
 * `pagada`), el trigger lo revierte o genera el ajuste correspondiente — ver el comentario de
 * cabecera de `0044_ordenes_pago_reglas.sql` para el detalle completo, incluido qué pasa si no hay
 * un período en borrador donde asentar un ajuste (falla cerrado, no se inventa uno).
 */
export async function anularOrdenPago(
  tx: DbConIdentidad,
  parametros: AnularOrdenPago,
): Promise<OrdenPago> {
  const { ordenPagoId, motivo } = anularOrdenPagoSchema.parse(parametros);
  return transicion(tx, ordenPagoId, sql`estado = 'anulada', motivo_anulacion = ${motivo}`);
}

/** Las órdenes de pago del barrio, las `pendiente` primero (la cola de aprobación), después por
 *  fecha de carga descendente. */
export async function listarOrdenesPago(
  tx: DbConIdentidad,
  parametros: { barrioId: string },
): Promise<OrdenPago[]> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<FilaOrdenPago>(sql`
      select ${COLUMNAS_ORDEN_PAGO}
        from orden_pago
       where barrio_id = ${barrioId}
       order by (estado = 'pendiente') desc, creada_at desc
    `);
    return rows.map(filaAOrdenPago);
  });
}

/**
 * Deriva el barrio de la orden de pago bajo RLS, arma la clave del comprobante y registra el pedido
 * de subida **antes** de devolver la clave — mismo patrón que `prepararSubidaDeComprobante()`
 * (`documentos.ts`), aplicado a `orden_pago` en vez de a `unidad_funcional`.
 */
export async function prepararSubidaDeComprobanteDeOP(
  tx: DbConIdentidad,
  parametros: PrepararSubidaDeComprobanteDeOP,
): Promise<SubidaDeComprobantePreparada> {
  const p = prepararSubidaDeComprobanteDeOPSchema.parse(parametros);

  return enBase(async () => {
    const fila = (
      await tx.execute<{ barrio_id: string }>(sql`
        select barrio_id from orden_pago where id = ${p.ordenPagoId}
      `)
    ).rows[0];

    if (!fila) {
      rechazar(
        "desconocido",
        "Esa orden de pago no existe o no tenés acceso a ella.",
        "Volvé a la lista de órdenes de pago del barrio.",
      );
    }

    const storageKey = claveDeComprobanteDeOP({
      barrioId: fila.barrio_id,
      ordenPagoId: p.ordenPagoId,
      token: nuevoToken(),
      contentType: p.contentType as ContentTypeDeComprobante,
    });

    // Antes de devolver la clave, no después — mismo motivo que `prepararSubidaDeComprobante()`.
    // `barrio_id`/`orden_pago_id` viajan explícitos: ya se leyeron bajo RLS arriba, y la FK
    // compuesta `fk_subida_comprobante_op_barrio` (`0046`) rechaza estructuralmente cualquier par
    // que no sea el real de la orden.
    await tx.execute(sql`
      insert into subida_comprobante_solicitada (barrio_id, orden_pago_id, storage_key, content_type)
      values (${fila.barrio_id}, ${p.ordenPagoId}, ${storageKey}, ${p.contentType})
    `);

    return { storageKey };
  });
}
