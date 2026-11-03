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
import { aCentavos, sumarMontos } from "@admin-barrios/shared/dinero";
import {
  calcularLiquidacion,
  type GastoDelPeriodo,
  type ModeloExpensa,
  type UnidadAPRorratear,
} from "@admin-barrios/shared/liquidacion";
import {
  emitirPeriodoSchema,
  generarBorradorSchema,
  type EmitirPeriodo,
} from "@admin-barrios/shared/escrituras";
import { calcularInteresMora, sumarDias } from "@admin-barrios/shared/interes-mora";
import type { ParametrosMoraUsados } from "@admin-barrios/shared/parametros-mora";
import { parametrosParaLaVentana } from "./parametros.ts";
import { deudaALaFecha, registrarTramos, type DeudaDeUnidad, type TramoCalculado } from "./deuda.ts";
import { interesCobrable } from "@admin-barrios/shared/interes-pago-tardio";
import { numeroDeDia, type ResultadoInteres } from "@admin-barrios/shared/interes-mora";
import { tasaAMillonesimas } from "@admin-barrios/shared/parametros-mora";

/**
 * La tasa total (compensatoria + punitoria) de los tramos en los que se cobró, si es UNA sola; si no,
 * `null`. Como fracción decimal sin ceros de más, la misma forma que `tasa_mora_aplicada`.
 */
function tasaUnicaDe(tramos: readonly { cobra: boolean; tasaCompensatoria: string; tasaPunitoria: string }[]): string | null {
  const totales = new Set(
    tramos.filter((t) => t.cobra).map((t) => tasaAMillonesimas(t.tasaCompensatoria) + tasaAMillonesimas(t.tasaPunitoria)),
  );
  if (totales.size !== 1) return null;
  const m = [...totales][0]!;
  const dec = (m % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return dec === "" ? (m / 1_000_000n).toString() : `${m / 1_000_000n}.${dec}`;
}
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
  /** Unidades cuya mora no se pudo calcular porque faltaba un parámetro (no debería pasar desde ADR-0006). */
  conMoraPendiente: number;
  /** Unidades con «Cobra interés: No»: no se calculó interés, y se dice. */
  conMoraNoSeCobra: number;
  /** Extraordinarias cargadas sin acta de asamblea: no bloquean, pero conviene avisarlo. */
  extraordinariasSinRespaldo: number;
};

/**
 * El interés de una unidad con saldo arrastrado, en la forma de `ResultadoInteres` para reusar el
 * resto del armado: lo pendiente más lo de los tramos al corte. «No se cobra» solo si no hay nada que
 * cobrar y al corte no se cobra interés (lo pendiente de antes se sigue debiendo aunque hoy no se cobre).
 */
function interesArrastrado(deuda: DeudaDeUnidad | undefined, cobraAlCorte: boolean, corte: string): ResultadoInteres {
  const nuevo = deuda?.tramos ?? [];
  const total = sumarMontos(deuda?.interesPendiente ?? "0.00", deuda?.interesNuevo ?? "0.00");
  if (aCentavos(total) === 0n && !cobraAlCorte) return { estado: "no_se_cobra" };
  const comp = sumarMontos("0.00", ...nuevo.map((t) => (t.resultado.estado === "calculado" ? t.resultado.compensatorio : "0.00")));
  const dias = deuda?.vencimientoMasAntiguo ? Math.max(0, numeroDeDia(corte) - numeroDeDia(deuda.vencimientoMasAntiguo)) : 0;
  return {
    estado: "calculado",
    interes: total,
    compensatorio: sumarMontos(comp, deuda?.interesPendiente ?? "0.00"),
    punitorio: sumarMontos("0.00", ...nuevo.map((t) => (t.resultado.estado === "calculado" ? t.resultado.punitorio : "0.00"))),
    diasAtraso: dias,
    diasDevengados: dias,
    motivoCero: aCentavos(total) > 0n ? null : "sin_saldo",
  };
}

/** Un tramo tal como queda guardado en `parametros_mora.arrastre`: lo necesario para rehacer la cifra. */
function tramoUsado(t: TramoCalculado) {
  const r = t.resultado;
  return {
    liquidacionId: t.liquidacionId,
    inicio: t.inicio,
    fin: t.fin,
    desdeVencimiento: t.desdeVencimiento,
    base: t.base,
    estado: r.estado,
    interes: interesCobrable(r),
    compensatorio: r.estado === "calculado" ? r.compensatorio : "0.00",
    punitorio: r.estado === "calculado" ? r.punitorio : "0.00",
    interesCalculado: r.estado === "calculado" ? r.interes : r.estado === "tolerancia" ? r.interesCalculado : "0.00",
    dias: r.estado === "calculado" || r.estado === "tolerancia" ? r.dias : 0,
    diasDevengados: r.estado === "calculado" ? r.diasDevengados : 0,
  };
}

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
    /**
     * De dónde sale el saldo anterior. `carga_manual` (el valor de siempre): los `saldosAnteriores`
     * recibidos, deuda traída de afuera del sistema. `calculado`: **lo lee este servicio** de la cuenta
     * corriente (`saldo_uf`) en la misma transacción —no se acepta un saldo de afuera con ese rótulo,
     * porque la base lo descuenta de `importe_exigible` (`0060`) y un valor que no coincidiera con la
     * deuda real dejaría plata impresa sin débito (security-engineer, 2026-11-02)—.
     */
    origenSaldo?: "carga_manual" | "calculado";
  },
): Promise<ResumenLiquidacion> {
  // Solo el `periodoId` pasa por el esquema: es el único que llega de un formulario. `saldosAnteriores`
  // entra por parámetro desde un script mientras no exista el módulo de cobros (ADR-0002 §8), y por
  // eso `generarBorradorSchema` no lo tiene — ofrecerlo como campo sería invitar a tipear a mano la
  // deuda de un vecino.
  const { periodoId } = generarBorradorSchema.parse({ periodoId: parametros.periodoId });
  const { saldosAnteriores, diasDeAtraso = 0, fechaCorteMora, origenSaldo = "carga_manual" } = parametros;

  return enBase(() =>
    generar(tx, { periodoId, saldosAnteriores, diasDeAtraso, fechaCorteMora, origenSaldo }),
  );
}

async function generar(
  tx: DbConIdentidad,
  parametros: {
    periodoId: string;
    saldosAnteriores: Map<string, string> | undefined;
    diasDeAtraso: number;
    fechaCorteMora: string | undefined;
    origenSaldo: "carga_manual" | "calculado";
  },
): Promise<ResumenLiquidacion> {
  const { periodoId, saldosAnteriores, diasDeAtraso, fechaCorteMora, origenSaldo: origenDeLaCarga } = parametros;

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
      primer_vencimiento: string | null;
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
      sql`select id, barrio_id, estado, periodo, modelo, coeficiente_version_id, cuota_fija_version_id,
                 primer_vencimiento::text as primer_vencimiento
            from periodo_expensa where id = ${periodoId} for no key update`,
    )
  ).rows[0];
  if (!periodo) rechazarPeriodoInaccesible();

  if (origenDeLaCarga === "calculado" && saldosAnteriores) {
    throw new Error("con saldo calculado el saldo lo lee el servicio de la cuenta corriente: no se pasa saldosAnteriores");
  }
  /*
   * Con saldo calculado (ADR-0009), la deuda de cada unidad sale de la cuenta corriente a la fecha de
   * corte —la que se pasó, o hoy en la hora del barrio—: el saldo anterior es el CAPITAL pendiente, y
   * el interés por mora es el que quedó pendiente (pagos fuera de término, tramos anteriores) más el de
   * cada tramo de capital impago hasta el corte, que se registra al emitir.
   */
  const corteArrastre =
    origenDeLaCarga === "calculado"
      ? (fechaCorteMora ??
        (
          await tx.execute<{ hoy: string }>(sql`
            select (now() at time zone zona_horaria)::date::text as hoy from barrio where barrio_id = ${periodo.barrio_id}
          `)
        ).rows[0]?.hoy)
      : undefined;
  const arrastre =
    corteArrastre !== undefined ? await deudaALaFecha(tx, { barrioId: periodo.barrio_id, fecha: corteArrastre }) : null;
  const saldosDelPeriodo = arrastre
    ? new Map(
        [...arrastre.values()]
          .filter((d) => aCentavos(d.capital) > 0n || aCentavos(sumarMontos(d.interesPendiente, d.interesNuevo)) > 0n)
          .map((d) => [d.unidadFuncionalId, d.capital]),
      )
    : saldosAnteriores;
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

  /*
   * ────────────────────────────────────────────────────────────────────────────────────────────
   * Modelo fijo: qué valor de expensa se le aplica a este período.
   *
   * **Lo decide la base**, con `app.cuota_fija_version_del_periodo` (migración `0029`): la vigente
   * al mes que se liquida mientras el período es borrador, la que quedó fijada una vez emitido.
   *
   * Acá había **dos** defectos encadenados, los dos de dinero y los dos invisibles:
   *
   * 1. Tomaba la versión **abierta**, sin mirar el mes del período: definir en agosto el valor que
   *    rige desde septiembre hacía que la boleta de agosto saliera con el de septiembre.
   * 2. Después, respetaba la versión **ya fijada** en la fila (`?? buscar`). Un período en borrador
   *    que ya se había generado una vez quedaba pegado al valor de esa corrida: se cargaba el
   *    aumento, se regeneraba el borrador y seguía saliendo el valor viejo. Medido en pantalla el
   *    2026-08-04 con el aumento del 3,25 % del barrio piloto.
   *
   * El principio que el segundo violaba es el que la propia pantalla de revisión enuncia: **un
   * borrador es derivado y regenerable**, "se vuelve a calcular con los gastos y los cargos de
   * ahora". El valor de la expensa también es "de ahora". Congelar es correcto **al emitir**, que es
   * cuando el número se le comunicó a alguien — y de eso se ocupa la función, no este archivo.
   *
   * Esta función solo corre en `borrador` o `revisada` (se rechaza más arriba), así que acá nunca se
   * está recalculando algo ya emitido.
   * ────────────────────────────────────────────────────────────────────────────────────────────
   */
  let cuotaFijaVersionId: string | null = null;
  let cuotasFijas: Map<string, string> | undefined;
  if (periodo.modelo === "fija") {
    cuotaFijaVersionId =
      (
        await tx.execute<{ id: string | null }>(sql`
          select app.cuota_fija_version_del_periodo(${periodoId}) as id
        `)
      ).rows[0]?.id ?? null;
    if (!cuotaFijaVersionId) {
      rechazar(
        "periodo_incompleto",
        "El barrio liquida por cuota fija y no tiene una cuota vigente para el mes de este período.",
        "Definí la cuota del barrio con una fecha de vigencia igual o anterior al mes que se liquida.",
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

  /*
   * Los parámetros de mora (ADR-0006), resueltos **para la ventana de atraso** y no para el día en que
   * se genera el borrador. La versión anterior resolvía la tasa a `current_date`: regenerar el
   * borrador otro día podía cambiar el interés (hallazgo del panel de arquitectura). La fecha de
   * referencia es el corte de la mora; sin días de atraso, el vencimiento del período; sin
   * vencimiento, el primer día del mes. Cada día de la ventana devenga con lo que regía ese día.
   */
  const fechaReferencia = corteArrastre ?? fechaCorteMora ?? periodo.primer_vencimiento ?? `${periodo.periodo}-01`;
  const inicioVentana = sumarDias(fechaReferencia, -diasDeAtraso);
  const ventana = await parametrosParaLaVentana(tx, {
    barrioId: periodo.barrio_id,
    inicio: inicioVentana,
    corte: fechaReferencia,
  });

  // Las líneas se regeneran; **las aplicaciones de cargos y descuentos NO se tocan**: son una
  // entrada cargada por una persona, hermana de `gasto_periodo`, no un derivado. Por eso
  // `concepto_boleta_unidad` no tiene FK a `liquidacion`: si la tuviera con cascade, cada
  // regeneración del borrador evaporaría en silencio el trabajo del administrador.
  await tx.execute(sql`delete from liquidacion where periodo_id = ${periodoId}`);

  // El obligado notificado de cada unidad, en UNA consulta para todo el barrio (antes, una por unidad).
  // `distinct on` con orden explícito: si una unidad tuviera dos notificados vigentes, elige siempre el
  // mismo (el más antiguo), en vez del que devolviera un `limit 1` sin orden.
  const obligadoDe = new Map(
    (
      await tx.execute<{ unidad_funcional_id: string; obligado_id: string }>(sql`
        select distinct on (unidad_funcional_id) unidad_funcional_id, obligado_id
          from unidad_obligado
         where barrio_id = ${periodo.barrio_id} and hasta is null and es_notificado
         order by unidad_funcional_id, desde, obligado_id
      `)
    ).rows.map((r) => [r.unidad_funcional_id, r.obligado_id]),
  );
  const filas: Array<Record<string, unknown>> = [];

  let conMoraPendiente = 0;
  let conMoraNoSeCobra = 0;
  for (const liq of liquidaciones) {
    const saldoAnterior = saldosDelPeriodo?.get(liq.unidadFuncionalId) ?? "0.00";
    // Por fila: si se cargó el saldo de 3 unidades sobre 200, las otras 197 no tienen "carga manual".
    const origenSaldo = saldosDelPeriodo?.has(liq.unidadFuncionalId) ? origenDeLaCarga : "sin_movimientos";
    // Sin parámetros resueltos (no debería pasar desde `0057`: toda administración tiene valores),
    // la mora sale "pendiente de definición", igual que antes: el sistema no inventa un valor.
    const deuda = arrastre?.get(liq.unidadFuncionalId);
    const mora = !ventana.vigencias
      ? null
      : arrastre
        ? interesArrastrado(deuda, ventana.vigencias.en(fechaReferencia).cobra, fechaReferencia)
        : calcularInteresMora({ saldoVencido: saldoAnterior, fechaCorte: fechaReferencia, diasDeAtraso, vigencias: ventana.vigencias });
    const interes = mora?.estado === "calculado" ? mora.interes : null;
    const noSeCobra = mora?.estado === "no_se_cobra";
    if (mora === null) conMoraPendiente++;
    if (noSeCobra) conMoraNoSeCobra++;
    /*
     * Lo que se guarda en `tasa_mora_aplicada` y `dias_atraso` es lo que la boleta imprime como
     * "Base · X % mensual · N días", así que **tiene que reproducir la cifra** (regla dura 4; hallazgo
     * de la revisión de código). Por eso la tasa es la TOTAL (compensatoria + punitoria) y los días son
     * los que devengaron (después de la gracia, sin los días con «Cobra: No»). Si en la ventana rigió más
     * de una tasa, no hay UNA tasa que reproduzca el interés: va NULL, y la boleta no imprime una tasa
     * que mentiría (el detalle por tramo queda en `parametros_mora`).
     */
    // Con arrastre, el interés junta tramos de liquidaciones y fechas distintas: no hay UNA tasa que lo
    // reproduzca, y la boleta no la imprime (el detalle queda en `parametros_mora.arrastre`).
    const tasa = interes === null || arrastre ? null : tasaUnicaDe(ventana.tramos);
    const dias = mora?.estado === "calculado" && interes !== "0.00" ? mora.diasDevengados : diasDeAtraso;
    const usados: ParametrosMoraUsados | null =
      mora === null
        ? null
        : {
            fechaReferencia,
            ventana: diasDeAtraso > 0 ? { desde: sumarDias(inicioVentana, 1), hasta: fechaReferencia } : null,
            valores: ventana.valores,
            tramos: [...ventana.tramos],
            desglose:
              mora.estado === "calculado" ? { compensatorio: mora.compensatorio, punitorio: mora.punitorio } : null,
            ...(arrastre
              ? {
                  arrastre: {
                    capital: deuda?.capital ?? "0.00",
                    interesPendiente: deuda?.interesPendiente ?? "0.00",
                    interesNuevo: deuda?.interesNuevo ?? "0.00",
                    tramos: (deuda?.tramos ?? []).map(tramoUsado),
                  },
                }
              : {}),
          };

    // Suma exacta en centavos: las tres cifras ya tienen dos decimales (es lo que hacía la suma
    // `numeric` que antes se pedía a la base, una consulta por unidad).
    const total = sumarMontos(liq.total, saldoAnterior, interes ?? "0.00");

    filas.push({
      barrio_id: periodo.barrio_id,
      periodo_id: periodoId,
      unidad_funcional_id: liq.unidadFuncionalId,
      obligado_id: obligadoDe.get(liq.unidadFuncionalId) ?? null,
      coeficiente_aplicado: liq.coeficienteAplicado,
      numero_comprobante: numeroComprobante(periodo.periodo, etiquetaUnidad, liq.unidadFuncionalId),
      subtotal_cuota_fija: liq.subtotalCuotaFija,
      subtotal_ordinarias: liq.subtotalOrdinarias,
      subtotal_extraordinarias: liq.subtotalExtraordinarias,
      subtotal_fondo_reserva: liq.subtotalFondoReserva,
      saldo_anterior: saldoAnterior,
      saldo_anterior_origen: origenSaldo,
      interes_mora: interes,
      mora_pendiente_definicion: mora === null,
      mora_no_se_cobra: noSeCobra,
      tasa_mora_aplicada: tasa,
      dias_atraso: interes === null ? null : dias,
      // Con arrastre el corte puede ser "hoy" (la pantalla no lo pasa): se guarda el que se usó,
      // porque `liquidacion_mora_verificable_chk` lo exige y la emisión recalcula con él.
      fecha_corte_mora: interes === null ? null : (corteArrastre ?? fechaCorteMora ?? null),
      parametros_mora: usados,
      total,
    });
  }

  /*
   * **Todas las liquidaciones en UNA sentencia, y todas sus líneas en otra** (BL-016). Antes iba una
   * por una —tres viajes a la base por unidad más uno por línea— y un barrio de 700 UF tardaba 30 s
   * en generar el borrador. Los valores son exactamente los mismos y los triggers de la base corren
   * igual, fila por fila, del lado del servidor. Viajan como un `jsonb` (un solo parámetro) y se
   * abren con `jsonb_to_recordset`, cada columna tipada como en la tabla.
   */
  const creadas = (
    await tx.execute<{ id: string; unidad_funcional_id: string }>(sql`
      insert into liquidacion (barrio_id, periodo_id, unidad_funcional_id, obligado_id, coeficiente_aplicado,
                               numero_comprobante, subtotal_cuota_fija, subtotal_ordinarias,
                               subtotal_extraordinarias, subtotal_fondo_reserva, saldo_anterior,
                               saldo_anterior_origen, interes_mora, mora_pendiente_definicion,
                               mora_no_se_cobra, tasa_mora_aplicada, dias_atraso, fecha_corte_mora,
                               parametros_mora, total)
      select barrio_id, periodo_id, unidad_funcional_id, obligado_id, coeficiente_aplicado,
             numero_comprobante, subtotal_cuota_fija, subtotal_ordinarias,
             subtotal_extraordinarias, subtotal_fondo_reserva, saldo_anterior,
             saldo_anterior_origen, interes_mora, mora_pendiente_definicion,
             mora_no_se_cobra, tasa_mora_aplicada, dias_atraso, fecha_corte_mora,
             parametros_mora, total
        from jsonb_to_recordset(${JSON.stringify(filas)}::jsonb) as x(
               barrio_id uuid, periodo_id uuid, unidad_funcional_id uuid, obligado_id uuid,
               coeficiente_aplicado numeric, numero_comprobante text, subtotal_cuota_fija numeric,
               subtotal_ordinarias numeric, subtotal_extraordinarias numeric, subtotal_fondo_reserva numeric,
               saldo_anterior numeric, saldo_anterior_origen text, interes_mora numeric,
               mora_pendiente_definicion boolean, mora_no_se_cobra boolean, tasa_mora_aplicada numeric,
               dias_atraso integer, fecha_corte_mora date, parametros_mora jsonb, total numeric)
      returning id, unidad_funcional_id
    `)
  ).rows;
  if (creadas.length !== filas.length) throw new Error("no se pudieron crear todas las liquidaciones");
  const liquidacionDe = new Map(creadas.map((c) => [c.unidad_funcional_id, c.id]));

  const lineas = liquidaciones.flatMap((liq) =>
    liq.items.map((item) => {
      const snapshot = item.gastoId ? snapshotPorGasto.get(item.gastoId) : undefined;
      return {
        barrio_id: periodo.barrio_id,
        liquidacion_id: liquidacionDe.get(liq.unidadFuncionalId),
        gasto_id: item.gastoId,
        concepto_id: item.conceptoId,
        descripcion: item.descripcion,
        tipo: item.tipo,
        es_fondo_reserva: item.esFondoReserva,
        es_cuota_fija: item.esCuotaFija,
        clase_item: item.esCuotaFija ? "cuota_fija" : "prorrateo",
        clasificacion_fiscal: item.gastoId ? (snapshot?.clasificacionFiscal ?? null) : null,
        sin_respaldo_asamblea: item.gastoId ? (snapshot?.sinRespaldoAsamblea ?? false) : false,
        acta_titulo: item.gastoId ? (snapshot?.actaTitulo ?? null) : null,
        base_monto: item.baseMonto,
        coeficiente_aplicado: item.coeficienteAplicado,
        monto: item.monto,
        monto_teorico: item.montoTeorico,
        ajuste_redondeo: item.ajusteRedondeo,
      };
    }),
  );
  if (lineas.length > 0) {
    await tx.execute(sql`
      insert into item_liquidacion (barrio_id, liquidacion_id, gasto_id, concepto_id, descripcion, tipo,
                                    es_fondo_reserva, es_cuota_fija, clase_item, clasificacion_fiscal,
                                    sin_respaldo_asamblea, acta_titulo, base_monto, coeficiente_aplicado,
                                    monto, monto_teorico, ajuste_redondeo)
      select barrio_id, liquidacion_id, gasto_id, concepto_id, descripcion, tipo::app.tipo_concepto,
             es_fondo_reserva, es_cuota_fija, clase_item::app.clase_item,
             clasificacion_fiscal::app.clasificacion_fiscal, sin_respaldo_asamblea, acta_titulo, base_monto,
             coeficiente_aplicado, monto, monto_teorico, ajuste_redondeo
        from jsonb_to_recordset(${JSON.stringify(lineas)}::jsonb) as x(
               barrio_id uuid, liquidacion_id uuid, gasto_id uuid, concepto_id uuid, descripcion text,
               tipo text, es_fondo_reserva boolean, es_cuota_fija boolean, clase_item text,
               clasificacion_fiscal text, sin_respaldo_asamblea boolean, acta_titulo text, base_monto numeric,
               coeficiente_aplicado numeric, monto numeric, monto_teorico numeric, ajuste_redondeo numeric)
    `);
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
    conMoraNoSeCobra,
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
 * Al emitir un período con saldo arrastrado (ADR-0009): se vuelve a calcular la deuda de cada unidad al
 * corte con que se generó el borrador y, si algo cambió desde entonces —un pago, una imputación, una
 * condonación—, **no se emite**: la boleta saldría con cifras viejas. Si coincide, se registran los
 * tramos de interés que el corte cierra (el débito del interés nuevo en la cuenta corriente).
 */
async function registrarArrastreAlEmitir(tx: DbConIdentidad, periodoId: string): Promise<void> {
  const { rows } = await tx.execute<{
    barrio_id: string;
    unidad_funcional_id: string;
    saldo_anterior: string;
    interes: string;
    corte: string | null;
  }>(sql`
    select l.barrio_id, l.unidad_funcional_id, l.saldo_anterior::text,
           coalesce(l.interes_mora, 0)::numeric(14,2)::text as interes,
           l.parametros_mora ->> 'fechaReferencia' as corte
      from liquidacion l
     where l.periodo_id = ${periodoId} and l.parametros_mora ? 'arrastre'
  `);
  const primera = rows[0];
  if (!primera?.corte) return;
  const deuda = await deudaALaFecha(tx, { barrioId: primera.barrio_id, fecha: primera.corte, excluirPeriodoId: periodoId });
  for (const r of rows) {
    const d = deuda.get(r.unidad_funcional_id);
    const capital = d?.capital ?? "0.00";
    const interes = sumarMontos(d?.interesPendiente ?? "0.00", d?.interesNuevo ?? "0.00");
    if (aCentavos(capital) !== aCentavos(r.saldo_anterior) || aCentavos(interes) !== aCentavos(r.interes)) {
      rechazar(
        "borrador_desactualizado",
        "La deuda de alguna unidad cambió después de generar el borrador (un pago, una imputación o una condonación).",
        "Volvé a generar el borrador para que el saldo y el interés salgan con lo que hay hoy, y después emití.",
      );
    }
  }
  // Solo las unidades que tienen boleta en este período: una deuda de una unidad que no está en el
  // padrón del período no se debita sin que ninguna boleta lo muestre (revisión de código, R2).
  const conBoleta = new Set(rows.map((r) => r.unidad_funcional_id));
  await registrarTramos(
    tx,
    [...deuda.values()].filter((d) => conBoleta.has(d.unidadFuncionalId)).flatMap((d) => d.tramos),
    { origen: "corte", periodoId },
  );
}

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
    /*
     * Un parámetro de mora que el borrador usó y que se ANULÓ después de generarlo (revisión de
     * código, hallazgo 3): emitir así dejaría la liquidación citando una fila anulada y con un interés
     * calculado con un valor que ya no rige. Se pide regenerar el borrador. Usó = una fila del barrio o
     * de su administración, de las que pesan en el interés, con fecha ≤ la de referencia guardada.
     */
    const viejo = await tx.execute(sql`
      select 1
        from liquidacion l
        join tenant_node n on n.id = l.barrio_id
        join parametro_valor v on v.nodo_id in (l.barrio_id, n.parent_id)
        join parametro_anulacion a on a.fila_id = v.id
       where l.periodo_id = ${periodoId}
         and l.parametros_mora is not null
         and v.vigente_desde <= (l.parametros_mora ->> 'fechaReferencia')::date
         and a.created_at > l.created_at
       limit 1
    `);
    if (viejo.rows.length > 0) {
      rechazar(
        "periodo_incompleto",
        "Después de generar el borrador se anuló un parámetro de mora que el cálculo usó.",
        "Volvé a generar el borrador para que la mora se calcule con lo que rige ahora, y después emití.",
      );
    }

    const { rows } = await tx.execute<{ emitida_at: string; emitida_por: string }>(sql`
      update periodo_expensa
         set estado = 'emitida'
       where id = ${periodoId}
         and estado in ('borrador', 'revisada')
      returning emitida_at, emitida_por
    `);

    const fila = rows[0];
    if (fila) {
      await registrarArrastreAlEmitir(tx, periodoId);
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
