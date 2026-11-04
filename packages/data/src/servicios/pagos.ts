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
import type { Monto } from "@admin-barrios/shared/dinero";
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
    // BL-022 g (encargo 9): el obligado tiene que ser titular de la unidad a la fecha del pago. Se
    // mira acá para dar el mensaje propio y la base lo vuelve a mirar en el trigger (`0068`).
    // Solo sobre una unidad que quien registra ve (lectura bajo RLS): con una ajena no hay fila, y el
    // `insert` de abajo da el mismo «no existe o no tenés acceso» de siempre — sin oráculo (0069).
    if (p.obligadoId !== null) {
      const { rows: titular } = await tx.execute<{ ok: boolean }>(sql`
        select app.obligado_titular_a_la_fecha(uf.id, ${p.obligadoId}::uuid, ${p.fecha}::date) as ok
          from unidad_funcional uf where uf.id = ${p.unidadFuncionalId}
      `);
      if (titular[0] && !titular[0].ok) {
        rechazar(
          "obligado_no_titular",
          "Esa persona no es titular de la unidad a la fecha del pago.",
          "Elegí uno de los titulares de la unidad a esa fecha, o registrá el pago sin «A nombre de».",
        );
      }
    }
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
 * **Anula también sus imputaciones** (a capital y a interés), con el mismo motivo y sin borrar
 * ninguna (encargo 8, BL-022 a). La versión anterior las dejaba vivas "para que fueran dos
 * decisiones", y el resultado era un pago que no existe bajando la deuda en `saldo_uf`.
 *
 * **Y la condonación de interés que se registró con él** («No cobrar interés de este pago»), igual:
 * mismo motivo, sin borrar (encargo 9, P5; `0068`). El interés vuelve a estar adeudado. Si el pago se
 * vuelve a registrar, la condonación anulada no revive: se decide de nuevo con el pago nuevo.
 */
export async function anularPago(tx: DbConIdentidad, parametros: AnularPago): Promise<void> {
  const p = anularPagoSchema.parse(parametros);

  await enBase(async () => {
    /*
     * Las imputaciones del pago, a capital y a interés, se anulan con él y con el mismo motivo
     * (encargo 8, BL-022 a). Antes quedaban vivas: el pago anulado seguía bajando la deuda en
     * `saldo_uf` mientras el estado de cuenta ya no lo contaba, y las dos cifras dejaban de coincidir.
     * No se borra nada: cada imputación queda anulada, con autor y motivo, y el trigger de cada tabla
     * le devuelve el importe a `saldo_uf`. Van antes que el pago: si el pago ya estaba anulado o no
     * es accesible, el rechazo de abajo revierte toda la transacción.
     */
    // La fila del pago se toma primero: una imputación nueva (que toma el pago `for update` al
    // insertarse) no puede colarse entre anular las imputaciones y anular el pago (revisión de código).
    await tx.execute(sql`select 1 from pago where id = ${p.pagoId} for update`);
    await tx.execute(sql`
      update pago_imputacion
         set anulado_at = now(), anulado_por = app.current_user_id(), motivo_anulacion = ${p.motivo}
       where pago_id = ${p.pagoId} and anulado_at is null
    `);
    await tx.execute(sql`
      update pago_imputacion_interes
         set anulado_at = now(), anulado_por = app.current_user_id(), motivo_anulacion = ${p.motivo}
       where pago_id = ${p.pagoId} and anulado_at is null
    `);
    const resultado = await tx.execute(sql`
      update pago
         set anulado_at = now(),
             anulado_por = app.current_user_id(),
             motivo_anulacion = ${p.motivo}
       where id = ${p.pagoId}
         and anulado_at is null
    `);
    if ((resultado.rowCount ?? 0) > 0) {
      // Después del pago, porque la base solo deja anular la condonación de un pago ya anulado.
      await tx.execute(sql`
        update interes_condonacion
           set anulado_at = now(), anulado_por = app.current_user_id(), motivo_anulacion = ${p.motivo}
         where pago_id = ${p.pagoId} and anulado_at is null
      `);
      return;
    }

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
  readonly monto: Monto;
  readonly fecha: string;
  readonly origen: OrigenPago;
  /**
   * Si tiene comprobante para descargar. **Nunca la storage key**: la ruta de descarga
   * (`prepararDescargaDeComprobante`, `documentos.ts`) la resuelve de nuevo bajo RLS a partir del
   * `pagoId` — la clave cruda no tiene motivo para salir de la base hacia una pantalla.
   */
  readonly tieneComprobante: boolean;
  /**
   * Cómo se imputó, leído de las filas de imputación y de condonación del pago (encargo 10: el
   * «Listo:» al registrarlo y el diálogo de anularlo, BL-029). De un pago anulado, lo que imputaba
   * hasta que se anuló: las filas que se anularon junto con él.
   */
  readonly aCapital: Monto;
  readonly aInteres: Monto;
  /** El interés condonado con «No cobrar interés de este pago»; `0.00` si no se marcó. */
  readonly interesCondonado: Monto;
  /** `null` si está vivo. */
  readonly anulacion: { readonly el: string; readonly motivo: string } | null;
};

type FilaPagoDeUnidad = {
  id: string;
  monto: string;
  fecha: string;
  origen: string;
  tiene_comprobante: boolean;
  a_capital: string;
  a_interes: string;
  condonado: string;
  anulado_el: string | null;
  motivo_anulacion: string | null;
};

/**
 * Los pagos de una unidad, más nuevo primero — **no** el estado de cuenta. Por defecto, solo los
 * vivos; con `incluirAnulados`, también los anulados con su motivo («Ver anulados», BL-029).
 *
 * `estadoDeCuenta()` (`cobros.ts`) es el libro de débitos/créditos vía `app.v_estado_cuenta_uf`, y
 * para un crédito expone el id de la **imputación**, no el del pago (la vista no lo necesita para lo
 * que resuelve). Este panel es otra pregunta —"¿qué pagos entraron, con qué comprobante, cómo se
 * imputaron?"— y por eso lee `pago` y sus imputaciones directo: agregar `pago_id` a la vista para esto
 * habría significado tocar `app.v_estado_cuenta_uf` de nuevo, con su propio candado de
 * `security_invoker` ya revisado en panel, por una lectura que no lo necesita.
 *
 * **Las imputaciones se cuentan con el mismo estado que el pago**: de un pago vivo, las vivas; de uno
 * anulado, **solo las que se anularon con él** (`anulado_at` igual al del pago: `anularPago` las anula
 * en la misma transacción, y `now()` es el mismo). Una imputación anulada antes, de a una, no se suma:
 * si no, un pago reimputado y después anulado mostraba más imputado que su monto (security-engineer).
 * Son sumas de filas que ya existen: ninguna cifra se recalcula acá.
 */
export async function listarPagosDeUnidad(
  tx: DbConIdentidad,
  parametros: { unidadFuncionalId: string; incluirAnulados?: boolean },
): Promise<PagoDeUnidad[]> {
  const { unidadFuncionalId } = consultaUnidadSchema.parse({ unidadFuncionalId: parametros.unidadFuncionalId });
  const incluirAnulados = parametros.incluirAnulados === true;

  const { rows } = await tx.execute<FilaPagoDeUnidad>(sql`
    select p.id, p.monto::text, p.fecha::text, p.origen::text,
           (p.comprobante_adjunto is not null) as tiene_comprobante,
           coalesce((select sum(i.monto_imputado) from pago_imputacion i
                      where i.pago_id = p.id and i.anulado_at is not distinct from p.anulado_at), 0)::numeric(14,2)::text as a_capital,
           coalesce((select sum(i.monto_imputado) from pago_imputacion_interes i
                      where i.pago_id = p.id and i.anulado_at is not distinct from p.anulado_at), 0)::numeric(14,2)::text as a_interes,
           coalesce((select sum(c.monto) from interes_condonacion c
                      where c.pago_id = p.id and c.anulado_at is not distinct from p.anulado_at), 0)::numeric(14,2)::text as condonado,
           (p.anulado_at at time zone b.zona_horaria)::date::text as anulado_el,
           p.motivo_anulacion
      from pago p
      join barrio b on b.barrio_id = p.barrio_id
     where p.unidad_funcional_id = ${unidadFuncionalId}
       and (${incluirAnulados}::boolean or p.anulado_at is null)
     order by p.fecha desc, p.created_at desc
  `);

  return rows.map((f) => ({
    id: f.id,
    monto: f.monto as Monto,
    fecha: f.fecha,
    origen: f.origen as OrigenPago,
    tieneComprobante: f.tiene_comprobante,
    aCapital: f.a_capital as Monto,
    aInteres: f.a_interes as Monto,
    interesCondonado: f.condonado as Monto,
    anulacion: f.anulado_el === null ? null : { el: f.anulado_el, motivo: f.motivo_anulacion ?? "" },
  }));
}
