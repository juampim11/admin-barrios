/**
 * Registrar y anular un pago. El motor puro de conciliación (cruzarlo contra un extracto bancario)
 * queda fuera de esta tanda; acá solo se registra el cobro y se lo puede anular. `estado_conciliacion`
 * nace `pendiente` y no lo cambia nada de lo que hay en este archivo — es el hook que ese motor va a
 * usar el día que exista.
 *
 * Mismo patrón que `gastos.ts`: Zod valida forma, la base decide fondo, `enBase()` traduce cualquier
 * fallo de la base a un `ErrorDeNegocio`.
 *
 * **`barrioId` no viaja en el parámetro.** Igual que `registrarGasto` deriva el barrio del período,
 * `registrarPago` lo deriva de la unidad funcional en la misma sentencia
 * (`insert … select … from unidad_funcional`): si el usuario no puede leer esa unidad bajo RLS, no
 * hay fila de origen y no se inserta nada. Un `barrioId` de más sería el aislamiento dependiendo de
 * un valor que manda el cliente.
 */

import { sql } from "drizzle-orm";
import {
  anularPagoSchema,
  registrarPagoSchema,
  type AnularPago,
  type RegistrarPago,
} from "@admin-barrios/shared/escrituras";
import { consultaUnidadSchema } from "@admin-barrios/shared/consultas";
import type { OrigenPago, EstadoConciliacionPago } from "@admin-barrios/shared/cobros";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";

export type PagoEscrito = {
  readonly id: string;
  readonly unidadFuncionalId: string;
  readonly monto: string;
  readonly fecha: string;
  readonly origen: OrigenPago;
  readonly estadoConciliacion: EstadoConciliacionPago;
};

type FilaPago = {
  id: string;
  unidad_funcional_id: string;
  monto: string;
  fecha: string;
  origen: string;
  estado_conciliacion: string;
};

const mapear = (f: FilaPago): PagoEscrito => ({
  id: f.id,
  unidadFuncionalId: f.unidad_funcional_id,
  monto: f.monto,
  fecha: f.fecha,
  origen: f.origen as OrigenPago,
  estadoConciliacion: f.estado_conciliacion as EstadoConciliacionPago,
});

/**
 * Registra un pago contra una unidad. **No imputa nada**: eso es un paso aparte, deliberadamente
 * separado — ver `cobros.ts`. Un pago se puede registrar aunque el barrio no tenga
 * `orden_imputacion` configurado; solo la imputación *automática* depende de eso.
 */
export async function registrarPago(tx: DbConIdentidad, parametros: RegistrarPago): Promise<PagoEscrito> {
  const p = registrarPagoSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<FilaPago>(sql`
      insert into pago (barrio_id, unidad_funcional_id, obligado_id, monto, fecha, origen, comprobante_adjunto)
      select uf.barrio_id, uf.id, ${p.obligadoId}, ${p.monto}::numeric, ${p.fecha}::date, ${p.origen},
             ${p.comprobanteAdjunto}
        from unidad_funcional uf
       where uf.id = ${p.unidadFuncionalId}
      returning id, unidad_funcional_id, monto::text, fecha::text, origen::text, estado_conciliacion::text
    `);

    const fila = rows[0];
    // No se distingue "no existe" de "no la podés ver": el uuid de una unidad ajena no puede ser
    // un oráculo de existencia.
    if (!fila) {
      rechazar(
        "unidad_no_encontrada",
        "Esa unidad no existe o no tenés acceso a ella.",
        "Volvé al padrón del barrio y elegí la unidad de nuevo.",
      );
    }
    return mapear(fila);
  });
}

/**
 * Anula un pago, con motivo. Es el único camino para dejarlo sin efecto: un pago no se edita.
 *
 * **No revierte imputaciones existentes.** Si el pago ya estaba imputado contra alguna liquidación,
 * esas imputaciones siguen vivas hasta que alguien las anule aparte (`anularImputacion`, en
 * `cobros.ts`) — anular el cobro y anular a qué se aplicó son dos decisiones distintas, y la base no
 * las junta en una sola operación silenciosa.
 */
export async function anularPago(tx: DbConIdentidad, parametros: AnularPago): Promise<void> {
  const p = anularPagoSchema.parse(parametros);

  await enBase(async () => {
    const resultado = await tx.execute(sql`
      update pago
         set anulado_at = now(),
             anulado_por = app.current_user_id(),
             motivo_anulacion = ${p.motivo}
       where id = ${p.pagoId}
         and anulado_at is null
    `);
    if ((resultado.rowCount ?? 0) > 0) return;

    const { rows } = await tx.execute<{ anulado: boolean }>(
      sql`select anulado_at is not null as anulado from pago where id = ${p.pagoId}`,
    );
    if (rows[0]?.anulado) {
      rechazar(
        "pago_ya_anulado",
        "Ese pago ya estaba anulado.",
        "Una anulación no se revierte ni se reescribe. Si hay que volver a registrarlo, cargá el pago de nuevo.",
      );
    }
    rechazar(
      "pago_no_encontrado",
      "Ese pago no existe o no tenés permiso para anularlo.",
      "Recargá la lista de pagos del barrio.",
    );
  });
}

/** Un pago de la unidad, para el panel "Pagos registrados" del estado de cuenta. */
export type PagoDeUnidad = {
  readonly id: string;
  readonly monto: string;
  readonly fecha: string;
  readonly origen: OrigenPago;
  /**
   * Si tiene comprobante para descargar. **Nunca la storage key**: la ruta de descarga
   * (`prepararDescargaDeComprobante`, `documentos.ts`) la resuelve de nuevo bajo RLS a partir del
   * `pagoId` — la clave cruda no tiene motivo para salir de la base hacia una pantalla.
   */
  readonly tieneComprobante: boolean;
};

type FilaPagoDeUnidad = {
  id: string;
  monto: string;
  fecha: string;
  origen: string;
  tiene_comprobante: boolean;
};

/**
 * Los pagos vivos de una unidad, más nuevo primero — **no** el estado de cuenta.
 *
 * `estadoDeCuenta()` (`cobros.ts`) es el libro de débitos/créditos vía `app.v_estado_cuenta_uf`, y
 * para un crédito expone el id de la **imputación**, no el del pago (la vista no lo necesita para lo
 * que resuelve). Este panel es otra pregunta —"¿qué pagos entraron, con qué comprobante?"— y por eso
 * lee `pago` directo: agregar `pago_id` a la vista para esto habría significado tocar
 * `app.v_estado_cuenta_uf` de nuevo, con su propio candado de `security_invoker` ya revisado en
 * panel, por una lectura que no lo necesita.
 */
export async function listarPagosDeUnidad(
  tx: DbConIdentidad,
  parametros: { unidadFuncionalId: string },
): Promise<PagoDeUnidad[]> {
  const { unidadFuncionalId } = consultaUnidadSchema.parse(parametros);

  const { rows } = await tx.execute<FilaPagoDeUnidad>(sql`
    select id, monto::text, fecha::text, origen::text,
           (comprobante_adjunto is not null) as tiene_comprobante
      from pago
     where unidad_funcional_id = ${unidadFuncionalId} and anulado_at is null
     order by fecha desc
  `);

  return rows.map((f) => ({
    id: f.id,
    monto: f.monto,
    fecha: f.fecha,
    origen: f.origen as OrigenPago,
    tieneComprobante: f.tiene_comprobante,
  }));
}
