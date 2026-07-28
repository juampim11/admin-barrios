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
import { sumarMontos } from "@admin-barrios/shared/dinero";
import {
  calcularLiquidacion,
  calcularMora,
  type GastoDelPeriodo,
  type ModeloExpensa,
  type UnidadAPRorratear,
} from "@admin-barrios/shared/liquidacion";
import {
  emitirPeriodoSchema,
  generarBorradorSchema,
  type EmitirPeriodo,
} from "@admin-barrios/shared/escrituras";
import type { DbConIdentidad } from "../client.ts";
import type { CodigoError } from "@admin-barrios/shared/errores";
import { enBase, rechazar, rechazarPeriodoInaccesible } from "../errores.ts";

/**
 * Los fallos del **motor puro** que son situaciones de negocio, y no bugs.
 *
 * Lista cerrada, escrita contra los `throw` de `@admin-barrios/shared/liquidacion`. Que sea cerrada
 * es el punto: lo que no está acá es un invariante roto del motor (por ejemplo *"la liquidación no
 * cierra: esperado X vs repartido Y"*, que significa que el prorrateo se equivocó) o directamente un
 * bug de programación, y ninguno de los dos se le explica a un administrador de consorcios como si
 * hubiera cargado algo mal.
 *
 * Los mensajes se muestran **tal cual** y eso es seguro por una razón concreta: el motor es puro
 * —sin base, sin red— así que no puede contener nada que la RLS hubiera filtrado. Es el único paso
 * directo del módulo junto con la regla genérica de `periodo no cuadra` (ver `errores.ts`).
 */
function motivoDelMotorPuro(
  e: unknown,
): { codigo: CodigoError; mensaje: string; sugerencia: string } | null {
  if (!(e instanceof Error)) return null;
  const m = e.message;

  if (m.startsWith("no hay unidades activas")) {
    return {
      codigo: "periodo_incompleto",
      mensaje: "El barrio no tiene unidades activas para liquidar.",
      sugerencia: "Revisá el padrón: todas las unidades están dadas de baja.",
    };
  }
  if (m.startsWith("el modelo de expensa fija necesita") || m.startsWith("falta la cuota fija")) {
    return {
      codigo: "periodo_incompleto",
      mensaje: m,
      sugerencia: "Cargá la cuota fija de esa unidad en la versión vigente y volvé a generar el borrador.",
    };
  }
  if (m.startsWith("la cuota fija de") && m.endsWith("es negativa")) {
    return {
      codigo: "dato_invalido",
      mensaje: "Hay una cuota fija cargada en negativo.",
      sugerencia: "Corregí el importe en la versión de cuotas del barrio.",
    };
  }
  if (/^el gasto ".*" es negativo/.test(m)) {
    return {
      codigo: "dato_invalido",
      mensaje: m,
      sugerencia: "Corregí el importe del gasto. Una devolución no es un gasto negativo.",
    };
  }
  return null;
}

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
  /** Cargos de unidad aplicados (quincho, invitados…). */
  totalCargos: string;
  /** Descuentos aplicados (negativo). */
  totalDescuentos: string;
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
  // Solo el `periodoId` pasa por el esquema: es el único que llega de un formulario. `saldosAnteriores`
  // entra por parámetro desde un script mientras no exista el módulo de cobros (ADR-0002 §8), y por
  // eso `generarBorradorSchema` no lo tiene — ofrecerlo como campo sería invitar a tipear a mano la
  // deuda de un vecino.
  const { periodoId } = generarBorradorSchema.parse({ periodoId: parametros.periodoId });
  const { saldosAnteriores, diasDeAtraso = 0, fechaCorteMora } = parametros;

  return enBase(() =>
    generar(tx, { periodoId, saldosAnteriores, diasDeAtraso, fechaCorteMora }),
  );
}

async function generar(
  tx: DbConIdentidad,
  parametros: {
    periodoId: string;
    saldosAnteriores: Map<string, string> | undefined;
    diasDeAtraso: number;
    fechaCorteMora: string | undefined;
  },
): Promise<ResumenLiquidacion> {
  const { periodoId, saldosAnteriores, diasDeAtraso, fechaCorteMora } = parametros;

  // Si se van a cobrar intereses, hay que decir hasta qué fecha se computaron: sin eso la cifra no se
  // puede rehacer y el sistema no inventa una fecha (misma regla que con la tasa de mora).
  if (diasDeAtraso > 0 && !fechaCorteMora) {
    rechazar(
      "dato_invalido",
      "Para cobrar intereses hay que indicar hasta qué fecha se computaron.",
      "Sin fecha de corte la cifra no se puede rehacer, y el sistema no inventa una.",
    );
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
      // `for no key update` — el escalón de arriba de la escalera de locks que introdujo la
      // migración 0023. Los escritores de gastos y cargos toman `for share` desde
      // `app.periodo_editable()` y conviven entre ellos; una regeneración, en cambio, borra y
      // reescribe TODAS las liquidaciones del período, así que se toma el lock exclusivo acá, al
      // principio.
      //
      // Tomarlo arriba y no dejarlo para el `update` del final es lo que evita un deadlock: dos
      // regeneraciones simultáneas ya tendrían cada una su `for share` (por los inserts) y las dos
      // intentarían subir de nivel al mismo tiempo. Así se serializan de entrada, y la segunda ve el
      // estado ya commiteado por la primera.
      sql`select id, barrio_id, estado, periodo, modelo, coeficiente_version_id, cuota_fija_version_id
            from periodo_expensa where id = ${periodoId} for no key update`,
    )
  ).rows[0];
  if (!periodo) rechazarPeriodoInaccesible();
  if (periodo.estado !== "borrador" && periodo.estado !== "revisada") {
    rechazar(
      "periodo_no_editable",
      `El período ya está ${periodo.estado}: no se puede volver a generar el borrador.`,
      "Un período emitido no se recalcula: la diferencia se registra en el período siguiente.",
      { estado: periodo.estado },
    );
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
  if (!versionId) {
    rechazar(
      "barrio_sin_coeficientes",
      "El barrio no tiene una versión de coeficientes cerrada y vigente.",
      "Sin coeficientes cerrados no se puede repartir el gasto. Hay que cargar la versión y cerrarla " +
        "antes de liquidar.",
    );
  }

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
      rechazar(
        "periodo_incompleto",
        "El barrio liquida por cuota fija y no tiene una cuota vigente cargada.",
        "Cargá la versión de cuota fija del barrio antes de generar el borrador.",
      );
    }
    const filas = (
      await tx.execute<{ unidad_funcional_id: string; importe: string }>(sql`
        select unidad_funcional_id, importe from cuota_fija where version_id = ${cuotaFijaVersionId}
      `)
    ).rows;
    cuotasFijas = new Map(filas.map((f) => [f.unidad_funcional_id, f.importe]));
  }

  let calculo;
  try {
    calculo = calcularLiquidacion({
      modelo: periodo.modelo,
      gastos,
      unidades,
      ...(cuotasFijas ? { cuotasFijas } : {}),
    });
  } catch (e) {
    // Se traduce **solo lo que está en la lista**, y todo lo demás se re-lanza para que `enBase` lo
    // registre y lo degrade a genérico.
    //
    // La versión anterior traducía cualquier throw a `periodo_incompleto` con el texto del error. Eso
    // tenía dos problemas y el segundo era el grave: un `TypeError` salía a pantalla como "revisá el
    // padrón", mandando a la persona a buscar el problema donde no está; y como `rechazar()` armaba
    // un `ErrorDeNegocio` que `traducirError()` deja pasar de largo, **el stack del fallo real no
    // quedaba en ningún lado**. Era el único punto del módulo que se tragaba un throw arbitrario y
    // justo el único sin log.
    const motivo = motivoDelMotorPuro(e);
    if (!motivo) throw e;
    rechazar(motivo.codigo, motivo.mensaje, motivo.sugerencia, undefined, e);
  }
  const { liquidaciones, totalGastos, totalCuotasFijas, totalRepartido, extraordinariasSinRespaldo } =
    calculo;

  // Tasa de mora del barrio: si no hay, no se inventa (la liquidación sale marcada).
  const tasa =
    (await tx.execute<{ tasa: string | null }>(sql`select app.tasa_mora_vigente(${periodo.barrio_id}) as tasa`))
      .rows[0]?.tasa ?? null;

  // Las líneas se regeneran; **las aplicaciones de cargos y descuentos NO se tocan**: son una
  // entrada cargada por una persona, hermana de `gasto_periodo`, no un derivado. Por eso
  // `concepto_boleta_unidad` no tiene FK a `liquidacion`: si la tuviera con cascade, cada
  // regeneración del borrador evaporaría en silencio el trabajo del administrador.
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
                                      es_fondo_reserva, es_cuota_fija, clase_item, clasificacion_fiscal,
                                      sin_respaldo_asamblea, acta_titulo, base_monto, coeficiente_aplicado,
                                      monto, monto_teorico, ajuste_redondeo)
        values (${periodo.barrio_id}, ${creada.id}, ${item.gastoId}, ${item.conceptoId}, ${item.descripcion},
                ${item.tipo}, ${item.esFondoReserva}, ${item.esCuotaFija},
                ${item.esCuotaFija ? "cuota_fija" : "prorrateo"},
                ${item.gastoId ? (snapshotPorGasto.get(item.gastoId)?.clasificacionFiscal ?? null) : null},
                ${item.gastoId ? (snapshotPorGasto.get(item.gastoId)?.sinRespaldoAsamblea ?? false) : false},
                ${item.gastoId ? (snapshotPorGasto.get(item.gastoId)?.actaTitulo ?? null) : null},
                ${item.baseMonto}, ${item.coeficienteAplicado}, ${item.monto},
                ${item.montoTeorico}, ${item.ajusteRedondeo})
      `);
    }
  }

  // --- Cargos y descuentos del período ---------------------------------------------------------
  //
  // La resolución **la hace la base**: deriva la base de cálculo de la propia liquidación de cada
  // unidad y escribe el importe. El servicio no puede escribirlo aunque quisiera — perdió el
  // permiso sobre esas columnas a propósito (migración 0017), porque una tabla que mueve plata no
  // puede confiar en lo que le manda el request.
  //
  // Y va en una sola pasada para todo el período, no unidad por unidad: con 200 unidades el bucle
  // costaba tres viajes a la base por vecino, la mayoría para no hacer nada.
  await tx.execute(sql`select app.resolver_aplicaciones(${periodoId})`);

  await tx.execute(sql`
    insert into item_liquidacion (barrio_id, liquidacion_id, descripcion, es_fondo_reserva, es_cuota_fija,
                                  clase_item, clasificacion_fiscal, base_monto, monto,
                                  aplicacion_id, aplicacion_periodo_id, aplicacion_unidad_id)
    select c.barrio_id, l.id, c.nombre_concepto, false, false,
           c.clase::text::app.clase_item, c.clasificacion_fiscal,
           -- La cifra se explica: en el porcentual, la base; en el resto, el bruto ANTES del tope.
           coalesce(c.base_calculada, c.importe_sin_tope), c.monto_resuelto,
           c.id, c.periodo_id, c.unidad_funcional_id
      from concepto_boleta_unidad c
      join liquidacion l on l.periodo_id = c.periodo_id and l.unidad_funcional_id = c.unidad_funcional_id
     where c.periodo_id = ${periodoId} and c.anulado_at is null
  `);

  await tx.execute(sql`
    with s as (
      select l.id,
             coalesce(sum(i.monto) filter (where i.clase_item = 'cargo'), 0) as cargos,
             coalesce(sum(i.monto) filter (where i.clase_item = 'descuento'), 0) as descuentos
        from liquidacion l left join item_liquidacion i on i.liquidacion_id = l.id
       where l.periodo_id = ${periodoId}
       group by l.id
    )
    update liquidacion l
       set subtotal_cargos = s.cargos, subtotal_descuentos = s.descuentos,
           total = l.total + s.cargos + s.descuentos
      from s where s.id = l.id and (s.cargos <> 0 or s.descuentos <> 0)
  `);

  const totales = (
    await tx.execute<{ cargos: string; descuentos: string }>(sql`
      select coalesce(sum(subtotal_cargos), 0)::text as cargos,
             coalesce(sum(subtotal_descuentos), 0)::text as descuentos
        from liquidacion where periodo_id = ${periodoId}
    `)
  ).rows[0];
  const totalCargos = totales?.cargos ?? "0.00";
  const totalDescuentos = totales?.descuentos ?? "0.00";

  // Guarda de cero filas, como el resto del módulo. Acá el `for no key update` de arriba ya
  // garantiza que la fila es nuestra, así que llegar a cero significa que desapareció en el medio.
  const actualizado = await tx.execute(sql`
    update periodo_expensa
       set coeficiente_version_id = ${versionId},
           cuota_fija_version_id = ${cuotaFijaVersionId},
           denominacion_concepto = ${denominacion},
           total_gastos = ${totalGastos},
           total_cargos = ${totalCargos},
           total_descuentos = ${totalDescuentos}
     where id = ${periodoId}
  `);
  if ((actualizado.rowCount ?? 0) === 0) rechazarPeriodoInaccesible();

  return {
    periodoId,
    modelo: periodo.modelo,
    unidadesLiquidadas: liquidaciones.length,
    totalGastos,
    totalCuotasFijas,
    totalRepartido,
    totalCargos,
    totalDescuentos,
    conMoraPendiente,
    extraordinariasSinRespaldo,
  };
}

/** Lo que devuelve emitir: sirve para que la pantalla muestre la firma sin volver a consultar. */
export type PeriodoEmitido = {
  readonly periodoId: string;
  /** Como la entrega Postgres, no como `Date`: ver la nota de `emitidaAt` en `periodos.ts`. */
  readonly emitidaAt: string;
  /** Quién firmó. Lo escribió la base desde `app.current_user_id()`, no el request. */
  readonly emitidaPor: string;
};

/**
 * Emite el período. La validación pesada (cuadre, unidades completas, versión cerrada, biyección de
 * cargos, totales por unidad, piso de cero) la corre la base en `app.validar_emision` v4, desde el
 * trigger de transición: acá solo se pide el cambio de estado.
 *
 * **No recibe el usuario a propósito.** La firma de quién emitió la pone la base desde la identidad
 * de la sesión (`app.current_user_id()`): si viniera por parámetro, cualquiera podría firmar con el
 * nombre de otro (migración `0013` §3). Por eso hay que llamarla dentro de `conUsuario()`.
 *
 * ## Los dos éxitos falsos que esta versión cierra
 *
 * La versión anterior era `update periodo_expensa set estado = 'emitida' where id = $1`, sin mirar
 * nada. Medido contra la base (auditoría de `dba-data`, 2026-07-28), eso tenía **dos caminos que
 * devolvían éxito sin emitir nada**, los dos indistinguibles del camino feliz:
 *
 * 1. **Período de otro barrio, o sin acceso: `UPDATE 0`, sin error.** El `using` de una policy de
 *    UPDATE actúa como **filtro de filas** —se agrega al `where`—, no como una verificación que
 *    aborte. Lo único que aborta con `42501` es el `with check`, y acá `using` y `with check` son la
 *    misma expresión sobre `barrio_id`, columna que la sentencia no toca: si pasa una, pasa la otra.
 *    Por este camino **`42501` nunca ocurre**. La UI decía "emitido" y no había pasado nada.
 * 2. **Período ya emitido: `UPDATE 1`, y `validar_emision` no corre.** `app.periodo_transicion()`
 *    corta en su primera línea con `if new.estado = old.estado then return new`. O sea que volver a
 *    emitir algo ya emitido "funcionaba", pisaba nada, y la persona se quedaba creyendo que acababa
 *    de emitir.
 *
 * Se cierran con `and estado in ('borrador','revisada')` en el `where` y con el `returning`: cero
 * filas ya no es un éxito. Cuál de los dos casos fue se averigua con una consulta más **solo en el
 * camino de error**, para poder decirlo en castellano.
 */
export async function emitirPeriodo(
  tx: DbConIdentidad,
  parametros: EmitirPeriodo,
): Promise<PeriodoEmitido> {
  const { periodoId } = emitirPeriodoSchema.parse(parametros);

  return enBase(async () => {
    const { rows } = await tx.execute<{ emitida_at: string; emitida_por: string }>(sql`
      update periodo_expensa
         set estado = 'emitida'
       where id = ${periodoId}
         and estado in ('borrador', 'revisada')
      returning emitida_at, emitida_por
    `);

    const fila = rows[0];
    if (fila) {
      return { periodoId, emitidaAt: fila.emitida_at, emitidaPor: fila.emitida_por };
    }

    const { rows: estado } = await tx.execute<{ estado: string }>(
      sql`select estado::text as estado from periodo_expensa where id = ${periodoId}`,
    );
    const actual = estado[0]?.estado;

    // Tres desenlaces distintos, y confundirlos manda a la persona a buscar el problema donde no está:
    //
    //  · el período se LEE y ya pasó de borrador   → ya estaba emitido;
    //  · el período se LEE y sigue en borrador     → lo pudo leer pero no actualizar, o sea que la
    //    policy de UPDATE no lo alcanza: le falta el rol. Es el caso de un `contador`, que lee todo
    //    el barrio. Decirle "ya está borrador" sería absurdo — está mirando un botón que no puede
    //    apretar;
    //  · el período no se lee                      → no existe o no tiene acceso, indistinguibles.
    if (actual === "emitida" || actual === "distribuida") {
      rechazar(
        "periodo_no_editable",
        `El período ya está ${actual}: no se vuelve a emitir.`,
        actual === "emitida"
          ? "Si hace falta corregir algo, se registra en el período siguiente."
          : "El período ya se distribuyó.",
        { estado: actual },
      );
    }
    if (actual) {
      rechazar(
        "sin_permiso",
        "No tenés permiso para emitir en este barrio.",
        "Emitir es de un administrador del barrio o de un operador. Si tu rol es de solo lectura " +
          "(contador o auditor), pedile a quien administra el barrio que emita.",
        { estado: actual },
      );
    }
    rechazarPeriodoInaccesible();
  });
}
