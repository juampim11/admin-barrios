/**
 * Imputación de pagos contra liquidaciones, manual o automática, el estado de cuenta de una unidad
 * (y de todas las de un barrio), y el encolado del recibo de un pago. Mismo patrón que el resto del
 * módulo: Zod valida forma, la base decide fondo (`app.pago_imputacion_antes()`,
 * `app.resolver_imputacion()`, `app.trabajo_antes_insert()`), `enBase()` traduce.
 *
 * **`resolverImputacionAutomatica()` no reemplaza a `imputarPago()`.** La automática recorre las
 * liquidaciones pendientes de la unidad del pago según `barrio.orden_imputacion`; la manual imputa
 * una línea concreta, elegida por la persona. Las dos pasan por el mismo trigger
 * (`app.pago_imputacion_antes()`), así que las dos respetan el mismo tope: no se sobre-imputa ni la
 * liquidación ni el pago.
 *
 * **`encolarEmisionDeRecibo()` vive acá y no en `documentos.ts`/`trabajos.ts`.** Emite el recibo de un
 * PAGO, no los documentos de un PERÍODO: el dominio al que sirve la función decide dónde vive, no la
 * tabla `trabajo` que las dos tocan.
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
import { consultaBarrioSchema, consultaPagoSchema, consultaUnidadSchema } from "@admin-barrios/shared/consultas";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";
import { SQL_ROLES_QUE_REGISTRAN_PAGO } from "./roles.ts";
import { COLUMNAS as COLUMNAS_TRABAJO, comoTrabajo, type FilaTrabajo, type Trabajo } from "./trabajos.ts";

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

/** El saldo de una unidad, para la grilla de "todas las unidades del barrio". */
export type SaldoUF = {
  readonly unidadFuncionalId: string;
  readonly manzana: string;
  readonly lote: string;
  readonly etiqueta: string;
  /** `numeric` como string, nunca `Number()` — ver el docstring de `periodos.ts` sobre por qué. */
  readonly saldoActual: string;
  /**
   * `null` = la unidad todavía no tuvo ningún movimiento: no hay fila en `saldo_uf` para ella. "Sin
   * fila" y "saldo cero" son el mismo hecho a propósito (ver el encabezado de `0037_estado_cuenta.sql`).
   */
  readonly fechaUltimoMovimiento: string | null;
};

export type SaldosDeBarrio = {
  /** El usuario tiene un rol que puede registrar pagos. Es para la UI; la base lo vuelve a verificar. */
  readonly puedeRegistrarPago: boolean;
  readonly saldos: readonly SaldoUF[];
};

type FilaSaldoUF = {
  unidad_funcional_id: string;
  manzana: string;
  lote: string;
  saldo_actual: string;
  fecha_ultimo_movimiento: string | null;
  puede_registrar_pago: boolean;
};

/**
 * El saldo de CADA unidad de un barrio — la grilla del administrador, "quién debe cuánto".
 *
 * Lee `saldo_uf` (mantenido incremental por trigger, migración `0037`) y **no**
 * `app.v_estado_cuenta_uf`: esa vista reordena el historial completo con una window function y está
 * pensada para el detalle de UNA unidad (`estadoDeCuenta()`, arriba); su costo crece con los años y
 * con 500 unidades sería la consulta ancha que la regla de recursos prohíbe.
 *
 * **Arranca de `unidad_funcional` y no de `saldo_uf`** — mismo criterio que `listarPadron()`: una
 * unidad sin movimientos todavía no tiene fila en `saldo_uf` ("sin fila" = "saldo cero", por diseño
 * de `0037`), y arrancar del lado chico la dejaría afuera de la grilla en vez de mostrarla en $ 0,00.
 *
 * **`puedeRegistrarPago` viaja en la MISMA consulta**, con `app.has_role_on()` — mismo patrón que
 * `puedeEmitir` en `leerPeriodo()` (`periodos.ts:277`): una sola lectura por transacción, no dos
 * round-trips que podrían leer contra una membresía que cambió en el medio. Como el valor es del
 * BARRIO y no de la unidad, viene repetido en cada fila; se toma el de la primera. Si el barrio no
 * tiene ninguna unidad visible (barrio vacío, o sin acceso bajo RLS), no hay fila de la que leerlo y
 * el resultado es `false` — que es correcto igual: sin ninguna unidad en pantalla no hay contra qué
 * registrar un pago.
 */
export async function listarSaldosUF(
  tx: DbConIdentidad,
  parametros: { barrioId: string },
): Promise<SaldosDeBarrio> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);

  const { rows } = await tx.execute<FilaSaldoUF>(sql`
    select u.id as unidad_funcional_id, u.manzana, u.lote,
           coalesce(s.saldo_actual, 0.00)::text as saldo_actual,
           s.fecha_ultimo_movimiento::text,
           app.has_role_on(${barrioId}, ${SQL_ROLES_QUE_REGISTRAN_PAGO}) as puede_registrar_pago
      from unidad_funcional u
      left join saldo_uf s on s.barrio_id = u.barrio_id and s.unidad_funcional_id = u.id
     where u.barrio_id = ${barrioId}
     order by u.manzana, u.lote
  `);

  return {
    puedeRegistrarPago: rows[0]?.puede_registrar_pago ?? false,
    saldos: rows.map((f) => ({
      unidadFuncionalId: f.unidad_funcional_id,
      manzana: f.manzana,
      lote: f.lote,
      etiqueta: etiquetaUnidad(f.manzana, f.lote),
      saldoActual: f.saldo_actual,
      fechaUltimoMovimiento: f.fecha_ultimo_movimiento,
    })),
  };
}

/**
 * Encola la generación del recibo de un pago.
 *
 * Vive acá y no en `documentos.ts`/`trabajos.ts` **a propósito**: `encolarEmisionDeDocumentos()`
 * emite los documentos de un PERÍODO; esto emite el recibo de un PAGO. Es el dominio al que sirve la
 * función, no la tabla `trabajo` que las dos tocan, lo que decide dónde vive — mismo criterio por el
 * que `imputarPago()`/`estadoDeCuenta()` están en este archivo y no en `pagos.ts`.
 *
 * **No recibe `barrioId`**: `app.trabajo_antes_insert()` (migración `0039`) lo deriva de `pago` bajo
 * RLS, igual que deriva el de `periodo_expensa` para `emitir_documentos_periodo`. Las dos compuertas
 * de acá abajo —el pago existe (y es accesible) y no está anulado— no reemplazan esa derivación:
 * están para dar un mensaje accionable antes de intentar el `insert`, mismo criterio que
 * `encolarEmisionDeDocumentos()`.
 */
export async function encolarEmisionDeRecibo(
  tx: DbConIdentidad,
  entrada: { pagoId: string },
): Promise<Trabajo> {
  const { pagoId } = consultaPagoSchema.parse(entrada);

  return enBase(async () => {
    const pago = (
      await tx.execute<{ anulado: boolean }>(sql`
        select anulado_at is not null as anulado from pago where id = ${pagoId}
      `)
    ).rows[0];

    // Cero filas bajo RLS = "no existe" y "no es tuyo" son el mismo caso, a propósito: el uuid de un
    // pago ajeno no puede ser un oráculo de existencia.
    if (!pago) {
      rechazar(
        "pago_no_encontrado",
        "Ese pago no existe o no tenés acceso.",
        "Volvé a la lista de pagos del barrio y elegí de nuevo.",
      );
    }

    // Un pago anulado SÍ es accesible (es de este barrio, y quien pide esto ya lo puede leer): no
    // es el mismo caso que "no existe", y decirlo distinto no filtra nada de otro barrio.
    if (pago.anulado) {
      rechazar(
        "pago_ya_anulado",
        "Ese pago está anulado: no se le puede emitir un recibo.",
        "Si el pago era válido, cargalo de nuevo y generá el recibo desde ahí.",
      );
    }

    const fila = (
      await tx.execute<FilaTrabajo>(sql`
        insert into trabajo (tipo, referencia_id)
        values ('emitir_recibo_pago', ${pagoId})
        returning ${COLUMNAS_TRABAJO}
      `)
    ).rows[0];

    // Un `insert` que no insertó y no rebotó no debería existir. Si pasa, es un camino nuevo.
    if (!fila) {
      rechazar(
        "desconocido",
        "No se pudo encolar la emisión del recibo.",
        "Recargá la pantalla y volvé a intentar.",
      );
    }
    return comoTrabajo(fila);
  });
}
