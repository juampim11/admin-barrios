/**
 * El circuito del mes (ADR-0011, T2, decisión D1): **emitir calcula**.
 *
 * Antes de emitir no hay un «borrador» guardado que se pueda quedar viejo. Lo que la pantalla muestra
 * es una **vista previa** que se calcula al pedirla, con el motor de siempre, y no se guarda:
 * `vistaPreviaDelMes` corre la emisión entera —`generarLiquidaciones` con el saldo de la cuenta
 * corriente y el interés a hoy, y `emitirPeriodo`, que valida con `app.validar_emision`— dentro de un
 * punto de guardado, lee las boletas y vuelve atrás. Lo que bloquea la vista previa es exactamente lo
 * que bloquearía la emisión: la regla es una sola, la de la base.
 *
 * `emitirMes` hace lo mismo **de verdad**, en un solo acto: traba el barrio, calcula, valida y firma.
 * Si lo que sale difiere de la última vista previa que vio la persona, rechaza con
 * `emision_con_cambios` diciendo qué cambió, y se reintenta con la casilla marcada.
 *
 * **El motor no cambia**: `calcularLiquidacion`, `prorratearDetallado`, `validar_emision`,
 * `resolver_aplicaciones` y `registrarArrastreAlEmitir` se llaman tal cual, desde
 * `generarLiquidaciones` y `emitirPeriodo`. Este archivo solo decide cuándo.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { aCentavos, formatearMonto, restarMontos, sumarMontos, type Monto } from "@admin-barrios/shared/dinero";
import { etiquetaUnidad } from "@admin-barrios/shared/barrio";
import { esErrorDeNegocio, type CodigoError } from "@admin-barrios/shared/errores";
import {
  cambiarVencimientosSchema,
  emitirMesSchema,
  vistaPreviaDelMesSchema,
  type CambiarVencimientos,
  type EmitirMes,
} from "@admin-barrios/shared/escrituras";
import { consultaBarrioSchema } from "@admin-barrios/shared/consultas";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar, rechazarPeriodoInaccesible } from "../errores.ts";
import { emitirPeriodo, generarLiquidaciones, type PeriodoEmitido } from "./liquidacion.ts";
import { ORDEN_NATURAL_U } from "./orden-de-unidades.ts";
import { encolarEmisionDeDocumentos, encolarTrabajoDelPeriodo } from "./trabajos.ts";

/** Una boleta del mes: la de la vista previa o la emitida, con las mismas columnas. */
export type BoletaDelMes = {
  readonly unidadFuncionalId: string;
  readonly etiqueta: string;
  /** Lo que la unidad paga por el mes: cuota fija, o ordinarias, extraordinarias y fondo de reserva. */
  readonly expensa: Monto;
  /** Cargos menos descuentos. */
  readonly cargos: Monto;
  readonly saldoAnterior: Monto;
  readonly interes: Monto;
  readonly total: Monto;
};

export type TotalesDelMes = {
  readonly boletas: number;
  readonly expensa: Monto;
  readonly cargos: Monto;
  readonly interes: Monto;
  readonly conInteres: number;
  readonly conCargos: number;
  readonly total: Monto;
};

/**
 * La vista previa (antes de emitir) o las boletas emitidas. `huella` resume las cifras: si la de la
 * emisión no es la de la última vista previa que se vio, la emisión pide confirmar la diferencia.
 */
export type BoletasDelMes =
  | {
      readonly estado: "vista_previa" | "emitida";
      /**
       * Cuándo se calculó (vista previa) o se emitió, en la hora del barrio: `YYYY-MM-DD HH:MM:SS.ffffff`
       * (la pantalla muestra hasta los minutos; el resto sirve para contar lo que entró después).
       */
      readonly calculadaEl: string;
      readonly boletas: readonly BoletaDelMes[];
      readonly totales: TotalesDelMes;
      readonly huella: string;
    }
  | {
      /** La emisión no pasaría: el motivo es el de la base, el mismo que daría «Emitir». */
      readonly estado: "bloqueada";
      readonly calculadaEl: string;
      /** El código del rechazo: con él la pantalla ofrece la salida (`salidasDelPeriodo`). */
      readonly codigo: CodigoError;
      readonly motivo: string;
      readonly sugerencia: string;
    }
  | {
      /**
       * Quien mira no emite (contador, auditor): la vista previa es la emisión entera y no la puede
       * calcular. No es un bloqueo del mes (security-engineer y code-reviewer, T2).
       */
      readonly estado: "sin_permiso";
      readonly calculadaEl: string;
    };

type FilaBoleta = {
  unidad_funcional_id: string;
  manzana: string;
  lote: string;
  expensa: string;
  cargos: string;
  saldo_anterior: string;
  interes: string;
  total: string;
};

async function leerBoletas(tx: DbConIdentidad, periodoId: string): Promise<BoletaDelMes[]> {
  const { rows } = await tx.execute<FilaBoleta>(sql`
    select l.unidad_funcional_id, u.manzana, u.lote,
           (coalesce(l.subtotal_cuota_fija, 0) + coalesce(l.subtotal_ordinarias, 0)
            + coalesce(l.subtotal_extraordinarias, 0) + coalesce(l.subtotal_fondo_reserva, 0))::numeric(14,2)::text as expensa,
           (coalesce(l.subtotal_cargos, 0) - coalesce(l.subtotal_descuentos, 0))::numeric(14,2)::text as cargos,
           coalesce(l.saldo_anterior, 0)::numeric(14,2)::text as saldo_anterior,
           coalesce(l.interes_mora, 0)::numeric(14,2)::text as interes,
           l.total::numeric(14,2)::text as total
      from liquidacion l
      join unidad_funcional u on u.id = l.unidad_funcional_id
     where l.periodo_id = ${periodoId}
     order by ${ORDEN_NATURAL_U}
  `);
  return rows.map((r) => ({
    unidadFuncionalId: r.unidad_funcional_id,
    etiqueta: etiquetaUnidad(r.manzana, r.lote),
    expensa: r.expensa as Monto,
    cargos: r.cargos as Monto,
    saldoAnterior: r.saldo_anterior as Monto,
    interes: r.interes as Monto,
    total: r.total as Monto,
  }));
}

function totalesDe(boletas: readonly BoletaDelMes[]): TotalesDelMes {
  return {
    boletas: boletas.length,
    expensa: sumarMontos("0.00", ...boletas.map((b) => b.expensa)),
    cargos: sumarMontos("0.00", ...boletas.map((b) => b.cargos)),
    interes: sumarMontos("0.00", ...boletas.map((b) => b.interes)),
    conInteres: boletas.filter((b) => aCentavos(b.interes) > 0n).length,
    conCargos: boletas.filter((b) => aCentavos(b.cargos) !== 0n).length,
    total: sumarMontos("0.00", ...boletas.map((b) => b.total)),
  };
}

/**
 * La huella de las cifras: cantidad, total y un resumen de cada boleta. Dos cálculos con las mismas
 * boletas dan la misma huella; un centavo distinto en cualquier unidad la cambia. Lleva adelante, en
 * claro, la cantidad y el total, para poder decir «el total pasa de X a Y» sin guardar nada.
 */
function huellaDe(boletas: readonly BoletaDelMes[], totales: TotalesDelMes): string {
  const h = createHash("sha256");
  for (const b of boletas) h.update(`${b.unidadFuncionalId}:${b.expensa}:${b.cargos}:${b.saldoAnterior}:${b.interes}:${b.total};`);
  return `${totales.boletas}|${totales.total}|${h.digest("hex").slice(0, 32)}`;
}

const ahoraEnElBarrio = async (tx: DbConIdentidad, periodoId: string): Promise<string> =>
  (
    await tx.execute<{ ahora: string }>(sql`
      select to_char(now() at time zone b.zona_horaria, 'YYYY-MM-DD HH24:MI:SS.US') as ahora
        from periodo_expensa p join barrio b on b.barrio_id = p.barrio_id where p.id = ${periodoId}
    `)
  ).rows[0]?.ahora ?? "";

type FilaPeriodo = { barrio_id: string; estado: string; emitida_el: string | null };

async function leerPeriodo(tx: DbConIdentidad, periodoId: string, bloquear: boolean): Promise<FilaPeriodo> {
  const { rows } = await tx.execute<FilaPeriodo>(
    bloquear
      ? sql`select p.barrio_id, p.estado::text as estado, null::text as emitida_el
              from periodo_expensa p where p.id = ${periodoId} for no key update`
      : sql`select p.barrio_id, p.estado::text as estado,
                   to_char(p.emitida_at at time zone b.zona_horaria, 'YYYY-MM-DD HH24:MI:SS.US') as emitida_el
              from periodo_expensa p join barrio b on b.barrio_id = p.barrio_id where p.id = ${periodoId}`,
  );
  const fila = rows[0];
  if (!fila) rechazarPeriodoInaccesible();
  return fila;
}

/** Si quien mira puede emitir en el barrio (la policy de `update` de `periodo_expensa`, `0005`). */
async function puedeEmitirEnElBarrio(tx: DbConIdentidad, barrioId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ puede: boolean }>(sql`
    select app.has_role_on(${barrioId}::uuid, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) as puede
  `);
  return rows[0]?.puede ?? false;
}

/** Antes de emitir: el estado del período donde se calcula. «Revisada» se trata como «Preparando» (D3). */
const sinEmitir = (estado: string) => estado === "borrador" || estado === "revisada";

/**
 * Las boletas del mes. Antes de emitir, la **vista previa**: la emisión entera en un punto de
 * guardado, y vuelta atrás. Después de emitir, las emitidas.
 */
export async function boletasDelMes(tx: DbConIdentidad, parametros: { readonly periodoId: string }): Promise<BoletasDelMes> {
  const { periodoId } = vistaPreviaDelMesSchema.parse(parametros);
  return enBase(async () => {
    const periodo = await leerPeriodo(tx, periodoId, false);
    if (!sinEmitir(periodo.estado)) {
      const boletas = await leerBoletas(tx, periodoId);
      const totales = totalesDe(boletas);
      return { estado: "emitida", calculadaEl: periodo.emitida_el ?? "", boletas, totales, huella: huellaDe(boletas, totales) };
    }

    const calculadaEl = await ahoraEnElBarrio(tx, periodoId);
    if (!(await puedeEmitirEnElBarrio(tx, periodo.barrio_id))) return { estado: "sin_permiso", calculadaEl };
    await tx.execute(sql`savepoint vista_previa_del_mes`);
    try {
      await calcularYEmitir(tx, periodoId);
      const boletas = await leerBoletas(tx, periodoId);
      const totales = totalesDe(boletas);
      return { estado: "vista_previa", calculadaEl, boletas, totales, huella: huellaDe(boletas, totales) };
    } catch (e) {
      // Un fallo técnico (un candado que no llegó, una conexión caída) no es una regla del mes: sube.
      if (!esErrorDeNegocio(e) || e.codigo === "desconocido") throw e;
      return { estado: "bloqueada", calculadaEl, codigo: e.codigo, motivo: e.message, sugerencia: e.sugerencia };
    } finally {
      // Nada de la vista previa queda: ni las liquidaciones, ni la firma, ni los tramos de interés.
      await tx.execute(sql`rollback to savepoint vista_previa_del_mes`);
      await tx.execute(sql`release savepoint vista_previa_del_mes`);
    }
  });
}

/**
 * Calcula con el motor de siempre y emite: el saldo sale de la cuenta corriente y el interés corre
 * hasta hoy, en la hora del barrio. Es lo que hacía «Generar el borrador» y después «Emitir», en el
 * mismo acto.
 */
async function calcularYEmitir(tx: DbConIdentidad, periodoId: string): Promise<PeriodoEmitido> {
  await generarLiquidaciones(tx, { periodoId, origenSaldo: "calculado" });
  return emitirPeriodo(tx, { periodoId });
}

/** Lo que cambió desde la vista previa, contado de lo que entró después: pagos, gastos y cargos. */
async function queEntroDesde(tx: DbConIdentidad, barrioId: string, periodoId: string, desde: string): Promise<string[]> {
  const { rows } = await tx.execute<{ pagos: number; gastos: number; cargos: number }>(sql`
    with b as (select zona_horaria from barrio where barrio_id = ${barrioId}),
         desde as (select (${desde}::timestamp at time zone (select zona_horaria from b)) as t)
    select (select count(*)::int from pago where barrio_id = ${barrioId} and (created_at >= (select t from desde) or anulado_at >= (select t from desde))) as pagos,
           (select count(*)::int from gasto_periodo where periodo_id = ${periodoId} and created_at >= (select t from desde)) as gastos,
           (select count(*)::int from concepto_boleta_unidad where periodo_id = ${periodoId}
              and (aplicado_at >= (select t from desde) or anulado_at >= (select t from desde))) as cargos
  `);
  const f = rows[0];
  if (!f) return [];
  const contar = (n: number, uno: string, varios: string) => (n === 0 ? null : n === 1 ? `1 ${uno}` : `${n} ${varios}`);
  return [contar(f.pagos, "pago", "pagos"), contar(f.gastos, "gasto", "gastos"), contar(f.cargos, "cargo o descuento", "cargos o descuentos")].filter(
    (x): x is string => x !== null,
  );
}

export type MesEmitido = PeriodoEmitido & {
  readonly barrioId: string;
  readonly totales: TotalesDelMes;
  /** Si quedaron encolados solos (D5) las boletas en PDF y el informe. */
  readonly encolados: { readonly boletas: boolean; readonly informe: boolean };
};

/**
 * Emite el mes en un solo acto (D1). Traba el barrio —el período, y los cobros de todas sus
 * unidades—, calcula con el motor de siempre, valida con `app.validar_emision` y firma.
 *
 * - **Dos emisiones a la vez:** la segunda espera el período trabado por la primera y, cuando le toca,
 *   lo encuentra emitido: «ya está emitido». Una sola gana.
 * - **Un pago, un gasto o un cargo a la vez:** esperan a que termine la emisión. Un pago espera hasta
 *   5 segundos (el candado de cobros, `0068`) y si no, pide reintentar: entra al saldo del mes siguiente.
 * - **Si cambió desde la vista previa** (`huellaVista`), no emite: rechaza con `emision_con_cambios`
 *   y el total de antes y de ahora, y se reintenta con `confirmarCambios`. Sin `huellaVista` (un script
 *   o un test, sin pantalla), no hay nada que comparar.
 */
export async function emitirMes(tx: DbConIdentidad, parametros: EmitirMes): Promise<MesEmitido> {
  const p = emitirMesSchema.parse(parametros);
  return enBase(async () => {
    const periodo = await leerPeriodo(tx, p.periodoId, true);
    if (!sinEmitir(periodo.estado)) {
      rechazar(
        "periodo_no_editable",
        `El período ya está ${periodo.estado === "distribuida" ? "enviado" : "emitido"}: no se vuelve a emitir.`,
        "Si hace falta corregir algo, se registra en el mes siguiente.",
        { estado: periodo.estado },
      );
    }
    // Los cobros de todas las unidades del barrio, en orden (sin deadlocks entre dos que traban lo mismo).
    // Con tope: un cobro colgado no deja la emisión esperando sin límite (security-engineer, O1).
    await tx.execute(sql`set local lock_timeout = '15s'`);
    await tx.execute(sql`
      select count(pg_advisory_xact_lock(hashtextextended('cobros-de-unidad:' || u.id::text, 0)))
        from (select id from unidad_funcional where barrio_id = ${periodo.barrio_id} order by id) u
    `);

    await tx.execute(sql`set local lock_timeout = 0`);
    const emitido = await calcularYEmitir(tx, p.periodoId);
    const boletas = await leerBoletas(tx, p.periodoId);
    const totales = totalesDe(boletas);

    if (p.huellaVista !== null && !p.confirmarCambios) {
      const huella = huellaDe(boletas, totales);
      const [n, total] = p.huellaVista.split("|");
      if (huella !== p.huellaVista) {
        const entro = p.vistaCalculadaEl ? await queEntroDesde(tx, periodo.barrio_id, p.periodoId, p.vistaCalculadaEl) : [];
        const totalAntes = total && /^-?\d+\.\d{2}$/.test(total) ? (total as Monto) : null;
        const partes = [
          entro.length > 0 ? `${entro.length === 1 && entro[0]!.startsWith("1 ") ? "entró" : "entraron"} ${entro.join(", ")}` : "cambió lo cargado",
          totalAntes !== null && totalAntes !== totales.total
            ? `El total pasa de $ ${formatearMonto(totalAntes)} a $ ${formatearMonto(totales.total)}`
            : totalAntes !== null
              ? `El total sigue en $ ${formatearMonto(totales.total)}, con cambios en alguna boleta`
              : `El total es $ ${formatearMonto(totales.total)}`,
          n && Number(n) !== totales.boletas ? `y las boletas pasan de ${n} a ${totales.boletas}` : null,
        ];
        rechazar(
          "emision_con_cambios",
          `Cambió desde la vista previa${p.vistaCalculadaEl ? ` de las ${p.vistaCalculadaEl.slice(11, 16)}` : ""}: ${partes[0]}. ${partes[1]}${partes[2] ? ` ${partes[2]}` : ""}.`,
          "Revisá las cifras: si están bien, confirmá y se emite con lo de ahora.",
          {
            totalAntes: totalAntes ?? "",
            totalAhora: totales.total,
            diferencia: totalAntes !== null ? restarMontos(totales.total, totalAntes) : "",
            cifras: huella,
          },
        );
      }
    }
    // D5: lo de después de emitir se encadena solo. Las boletas en PDF y el informe se encolan ya; el
    // paquete, cuando terminan las boletas (lo encola el worker, `encadenarElPaquete`). Si quien emite
    // no puede encolar alguno (un rol sin permiso de documentos), la emisión no se cae: queda el botón.
    const encolados = {
      boletas: await encolarSinFrenar(tx, () => encolarEmisionDeDocumentos(tx, { periodoId: p.periodoId })),
      informe: await encolarSinFrenar(tx, () => encolarTrabajoDelPeriodo(tx, { periodoId: p.periodoId, tipo: "emitir_informe_periodo" })),
    };
    return { ...emitido, barrioId: periodo.barrio_id, totales, encolados };
  });
}

/** Encola un trabajo en un punto de guardado: si la base lo rechaza, vuelve atrás solo eso. */
async function encolarSinFrenar(tx: DbConIdentidad, encolar: () => Promise<unknown>): Promise<boolean> {
  await tx.execute(sql`savepoint encolar_despues_de_emitir`);
  try {
    await encolar();
    await tx.execute(sql`release savepoint encolar_despues_de_emitir`);
    return true;
  } catch (e) {
    if (!esErrorDeNegocio(e)) throw e;
    await tx.execute(sql`rollback to savepoint encolar_despues_de_emitir`);
    await tx.execute(sql`release savepoint encolar_despues_de_emitir`);
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El mes se abre solo (T2): el período del mes en curso, con el modelo y el vencimiento del barrio
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** El mes en curso en la hora del barrio, `YYYY-MM`. */
async function mesEnCurso(tx: DbConIdentidad, barrioId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ mes: string }>(sql`
    select to_char(now() at time zone zona_horaria, 'YYYY-MM') as mes from barrio where barrio_id = ${barrioId}
  `);
  return rows[0]?.mes ?? null;
}

export type MesAbierto = { readonly periodoId: string; readonly periodo: string; readonly recienAbierto: boolean };

/**
 * El período del mes en curso del barrio; si no existe, **lo abre** (la ficha del mes no tiene botón
 * «Abrir período»). Con el modelo del barrio (`modelo_liquidacion`, o el del último período) y el
 * primer vencimiento en su día (`dia_vencimiento`): el mismo mes en cuota fija, que se cobra dentro del
 * mes, y el mes siguiente por coeficiente, que se emite cuando llegaron las facturas. El segundo
 * vencimiento no tiene configuración en el barrio: queda vacío y se carga en «Cambiar».
 *
 * `null` si quien mira no ve el barrio, o si no lo puede abrir (un rol de solo lectura): la pantalla
 * dice que el mes todavía no se abrió. Dos pestañas a la vez no abren dos: la segunda encuentra el de
 * la primera (`uq_periodo_barrio`).
 */
export async function abrirMesEnCurso(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<MesAbierto | null> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);
  const mes = await mesEnCurso(tx, barrioId);
  if (mes === null) return null;
  const existente = async () =>
    (
      await tx.execute<{ id: string }>(sql`select id from periodo_expensa where barrio_id = ${barrioId} and periodo = ${mes}`)
    ).rows[0] ?? null;
  const ya = await existente();
  if (ya) return { periodoId: ya.id, periodo: mes, recienAbierto: false };

  const { rows: puede } = await tx.execute<{ puede: boolean }>(sql`
    select app.has_role_on(${barrioId}::uuid, array['admin_plataforma','admin_barrio','operador']::app.rol_membership[]) as puede
  `);
  if (!puede[0]?.puede) return null;

  return enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      with b as (
        select b.barrio_id,
               coalesce(b.modelo_liquidacion,
                        (select p.modelo from periodo_expensa p where p.barrio_id = b.barrio_id order by p.periodo desc limit 1),
                        'variable'::app.modelo_expensa) as modelo,
               b.dia_vencimiento
          from barrio b where b.barrio_id = ${barrioId}
      )
      insert into periodo_expensa (barrio_id, periodo, modelo, primer_vencimiento, notas)
      select b.barrio_id, ${mes}, b.modelo,
             case when b.dia_vencimiento is null then null
                  else (date_trunc('month', (${mes} || '-01')::date)
                        + case when b.modelo = 'fija' then interval '0 month' else interval '1 month' end
                        + make_interval(days => b.dia_vencimiento - 1))::date end,
             'Abierto solo al entrar al mes'
        from b
      on conflict (barrio_id, periodo) do nothing
      returning id
    `);
    const id = rows[0]?.id ?? (await existente())?.id;
    if (!id) return null;
    return { periodoId: id, periodo: mes, recienAbierto: rows.length > 0 };
  });
}

/**
 * Cambia los vencimientos del mes, solo para este mes y solo antes de emitir (el diálogo de la
 * maqueta). El motivo queda en el período (`motivo_vencimientos`, `0071`).
 */
export async function cambiarVencimientos(tx: DbConIdentidad, parametros: CambiarVencimientos): Promise<void> {
  const p = cambiarVencimientosSchema.parse(parametros);
  await enBase(async () => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      update periodo_expensa
         set primer_vencimiento = ${p.primerVencimiento}::date,
             segundo_vencimiento = ${p.segundoVencimiento}::date,
             motivo_vencimientos = ${p.motivo}
       where id = ${p.periodoId} and estado in ('borrador', 'revisada')
      returning id
    `);
    if (rows.length === 0) {
      const periodo = await leerPeriodo(tx, p.periodoId, false);
      if (!sinEmitir(periodo.estado)) {
        rechazar(
          "periodo_no_editable",
          "El mes ya está emitido: sus vencimientos son los de las boletas.",
          "Los vencimientos se cambian hasta emitir.",
          { estado: periodo.estado },
        );
      }
      // Lo ve pero no lo puede cambiar: un rol de solo lectura (security-engineer, O2).
      rechazar(
        "sin_permiso",
        "No tenés permiso para cambiar los vencimientos de este mes.",
        "Los cambia la administración del barrio o un operador.",
      );
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Lo que falta: una sola lista, con lo que bloquea y lo que avisa
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type Falta = {
  readonly tipo: "bloquea" | "avisa";
  readonly titulo: string;
  readonly detalle: string;
  /** A qué pestaña del mes lleva («Ver…»). */
  readonly donde: "gastos" | "boletas" | "ordenes" | "vencimientos";
  /** El código del rechazo, cuando lo que bloquea es la vista previa (para ofrecer su salida). */
  readonly codigo?: CodigoError;
};

/**
 * Lo que falta para emitir, en una lista. **Bloquea** solo lo que bloquearía la emisión: el rechazo de
 * la vista previa, que es la emisión misma (`boletasDelMes`). **Avisa** lo que no frena: órdenes de
 * pago sin aprobar, un gasto extraordinario sin respaldo de asamblea (decisión de `0007`), el mes sin
 * vencimiento y, por coeficiente, el mes sin gastos.
 */
export async function loQueFaltaDelMes(
  tx: DbConIdentidad,
  parametros: { readonly periodoId: string; readonly vista: BoletasDelMes },
): Promise<Falta[]> {
  const { periodoId } = vistaPreviaDelMesSchema.parse({ periodoId: parametros.periodoId });
  const faltas: Falta[] = [];
  if (parametros.vista.estado === "bloqueada") {
    faltas.push({
      tipo: "bloquea",
      titulo: parametros.vista.motivo,
      detalle: parametros.vista.sugerencia,
      donde: "boletas",
      codigo: parametros.vista.codigo,
    });
  }
  const { rows } = await tx.execute<{
    ordenes: number;
    ordenes_monto: string;
    sin_respaldo: number;
    sin_respaldo_monto: string;
    sin_vencimiento: boolean;
    modelo: string;
    gastos: number;
    gastos_mes_anterior: number;
  }>(sql`
    select (select count(*)::int from orden_pago o where o.periodo_id = p.id and o.estado = 'pendiente') as ordenes,
           (select coalesce(sum(o.monto), 0)::numeric(14,2)::text from orden_pago o where o.periodo_id = p.id and o.estado = 'pendiente') as ordenes_monto,
           (select count(*)::int from gasto_periodo g join concepto c on c.id = g.concepto_id
             where g.periodo_id = p.id and c.tipo = 'extraordinaria' and g.sin_respaldo_asamblea) as sin_respaldo,
           (select coalesce(sum(g.monto), 0)::numeric(14,2)::text from gasto_periodo g join concepto c on c.id = g.concepto_id
             where g.periodo_id = p.id and c.tipo = 'extraordinaria' and g.sin_respaldo_asamblea) as sin_respaldo_monto,
           p.primer_vencimiento is null as sin_vencimiento,
           p.modelo::text as modelo,
           (select count(*)::int from gasto_periodo g where g.periodo_id = p.id) as gastos,
           (select count(*)::int from gasto_periodo g join periodo_expensa pa on pa.id = g.periodo_id
             where pa.barrio_id = p.barrio_id and pa.periodo = to_char((p.periodo || '-01')::date - interval '1 month', 'YYYY-MM')) as gastos_mes_anterior
      from periodo_expensa p where p.id = ${periodoId}
  `);
  const f = rows[0];
  if (!f) return faltas;
  if (f.ordenes > 0) {
    faltas.push({
      tipo: "avisa",
      titulo: `${f.ordenes === 1 ? "1 orden de pago sin aprobar" : `${f.ordenes} órdenes de pago sin aprobar`} por $ ${formatearMonto(f.ordenes_monto)}`,
      detalle: "Si no se aprueban antes de emitir, su gasto no entra en este mes.",
      donde: "ordenes",
    });
  }
  // El gasto extraordinario sin respaldo de asamblea AVISA, no bloquea: se puede emitir y condiciona el
  // reclamo de la deuda (decisión de `0007`, confirmada por el titular en T2 frente a la maqueta).
  if (f.sin_respaldo > 0) {
    faltas.push({
      tipo: "avisa",
      titulo: `${f.sin_respaldo === 1 ? "1 gasto extraordinario" : `${f.sin_respaldo} gastos extraordinarios`} sin respaldo de asamblea · $ ${formatearMonto(f.sin_respaldo_monto)}`,
      detalle: "Se puede emitir, pero condiciona el reclamo de la deuda: conviene adjuntar el acta.",
      donde: "gastos",
    });
  }
  if (f.sin_vencimiento) {
    faltas.push({ tipo: "avisa", titulo: "El mes no tiene vencimiento", detalle: "Las boletas saldrían sin fecha de vencimiento.", donde: "vencimientos" });
  }
  if (f.modelo === "variable" && f.gastos === 0) {
    faltas.push({
      tipo: "avisa",
      titulo: "Sin gastos cargados",
      detalle: f.gastos_mes_anterior > 0 ? `El mes pasado tuvo ${f.gastos_mes_anterior} ${f.gastos_mes_anterior === 1 ? "gasto" : "gastos"}.` : "Por coeficiente, la boleta es el gasto del mes.",
      donde: "gastos",
    });
  }
  return faltas;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// «<Mes> en mis barrios»: el estado del mes en cada barrio
// ────────────────────────────────────────────────────────────────────────────────────────────────

/** El estado del mes en palabras: «Revisada» no existe en pantalla, se ve como «Preparando» (D3). */
export type EstadoDelMes = "sin_abrir" | "preparando" | "emitido" | "enviado";

export const estadoDelMes = (estado: string | null): EstadoDelMes =>
  estado === null ? "sin_abrir" : estado === "emitida" ? "emitido" : estado === "distribuida" ? "enviado" : "preparando";

export type MesDeUnBarrio = {
  readonly barrioId: string;
  readonly nombre: string;
  readonly modelo: "variable" | "fija";
  readonly unidades: number;
  readonly periodoId: string | null;
  readonly periodo: string;
  readonly estado: EstadoDelMes;
  readonly primerVencimiento: string | null;
  readonly gastos: number;
  readonly ordenesSinAprobar: number;
  /** Emitido: boletas emitidas y envíos aceptados (para «N boletas sin enviar»). */
  readonly boletas: number;
  readonly enviadas: number;
  readonly enviadoEl: string | null;
  /** Meses anteriores sin emitir o sin enviar. */
  readonly anterioresPendientes: number;
};

/**
 * El mes en curso de cada barrio que se ve (la RLS decide cuáles). Sin vista previa: es una lectura
 * corta; si un barrio está «Listo para emitir» lo dice la vista previa de cada fila, que la pantalla
 * pide aparte.
 */
export async function mesEnMisBarrios(tx: DbConIdentidad): Promise<MesDeUnBarrio[]> {
  const { rows } = await tx.execute<{
    barrio_id: string;
    nombre: string;
    modelo: string;
    unidades: number;
    periodo_id: string | null;
    periodo: string;
    estado: string | null;
    primer_vencimiento: string | null;
    gastos: number;
    ordenes: number;
    boletas: number;
    enviadas: number;
    enviado_el: string | null;
    anteriores: number;
  }>(sql`
    with b as (
      select b.barrio_id, n.nombre, to_char(now() at time zone b.zona_horaria, 'YYYY-MM') as mes, b.zona_horaria,
             coalesce(b.modelo_liquidacion::text,
                      (select p.modelo::text from periodo_expensa p where p.barrio_id = b.barrio_id order by p.periodo desc limit 1),
                      'variable') as modelo
        from barrio b join tenant_node n on n.id = b.barrio_id
       where n.deleted_at is null
    )
    select b.barrio_id, b.nombre, b.modelo, b.mes as periodo,
           (select count(*)::int from unidad_funcional u where u.barrio_id = b.barrio_id and u.baja_at is null) as unidades,
           p.id as periodo_id, p.estado::text as estado, p.primer_vencimiento::text as primer_vencimiento,
           (select count(*)::int from gasto_periodo g where g.periodo_id = p.id) as gastos,
           (select count(*)::int from orden_pago o where o.periodo_id = p.id and o.estado = 'pendiente') as ordenes,
           (select count(*)::int from liquidacion l where l.periodo_id = p.id and p.estado in ('emitida', 'distribuida')) as boletas,
           (select count(distinct e.unidad_funcional_id)::int from envio_liquidacion e where e.periodo_id = p.id and e.estado = 'aceptado') as enviadas,
           to_char(p.distribuida_at at time zone b.zona_horaria, 'YYYY-MM-DD') as enviado_el,
           (select count(*)::int from periodo_expensa a where a.barrio_id = b.barrio_id and a.periodo < b.mes
              and a.estado in ('borrador', 'revisada', 'emitida')) as anteriores
      from b left join periodo_expensa p on p.barrio_id = b.barrio_id and p.periodo = b.mes
     order by b.nombre
  `);
  return rows.map((r) => ({
    barrioId: r.barrio_id,
    nombre: r.nombre,
    modelo: r.modelo === "fija" ? "fija" : "variable",
    unidades: r.unidades,
    periodoId: r.periodo_id,
    periodo: r.periodo,
    estado: estadoDelMes(r.periodo_id === null ? null : r.estado),
    primerVencimiento: r.primer_vencimiento,
    gastos: r.gastos,
    ordenesSinAprobar: r.ordenes,
    boletas: r.boletas,
    enviadas: r.enviadas,
    enviadoEl: r.enviado_el,
    anterioresPendientes: r.anteriores,
  }));
}

/** Los conteos del mes para las pestañas, las cifras y Envío. Lectura corta, sin vista previa. */
export type ConteosDelMes = {
  readonly gastos: number;
  readonly totalGastos: Monto;
  readonly cargos: number;
  readonly unidades: number;
  readonly boletasEmitidas: number;
  /** Boletas emitidas sin capital pendiente: «N de M pagadas». Cero antes de emitir. */
  readonly pagadas: number;
  /** Meses anteriores del barrio sin emitir o sin enviar: que no se pierdan al cambiar de mes. */
  readonly anterioresPendientes: number;
};

export async function conteosDelMes(tx: DbConIdentidad, parametros: { readonly periodoId: string }): Promise<ConteosDelMes> {
  const { periodoId } = vistaPreviaDelMesSchema.parse(parametros);
  const { rows } = await tx.execute<{
    gastos: number;
    total_gastos: string;
    cargos: number;
    unidades: number;
    emitidas: number;
    pagadas: number;
    anteriores: number;
  }>(sql`
    select (select count(*)::int from gasto_periodo g where g.periodo_id = p.id) as gastos,
           (select coalesce(sum(g.monto), 0)::numeric(14,2)::text from gasto_periodo g where g.periodo_id = p.id) as total_gastos,
           (select count(*)::int from concepto_boleta_unidad a where a.periodo_id = p.id and a.anulado_at is null) as cargos,
           (select count(*)::int from unidad_funcional u where u.barrio_id = p.barrio_id and u.baja_at is null) as unidades,
           (select count(*)::int from liquidacion l where l.periodo_id = p.id and p.estado in ('emitida', 'distribuida')) as emitidas,
           (select count(*)::int from liquidacion l
              join app.capitales_pendientes(p.barrio_id) cp on cp.liquidacion_id = l.id
             where l.periodo_id = p.id and p.estado in ('emitida', 'distribuida') and cp.pendiente <= 0) as pagadas,
           (select count(*)::int from periodo_expensa a where a.barrio_id = p.barrio_id and a.periodo < p.periodo
              and a.estado in ('borrador', 'revisada', 'emitida')) as anteriores
      from periodo_expensa p where p.id = ${periodoId}
  `);
  const f = rows[0];
  if (!f) rechazarPeriodoInaccesible();
  return {
    gastos: f.gastos,
    totalGastos: f.total_gastos as Monto,
    cargos: f.cargos,
    unidades: f.unidades,
    boletasEmitidas: f.emitidas,
    pagadas: f.pagadas,
    anterioresPendientes: f.anteriores,
  };
}

/**
 * Lo que bloquearía el mes **a la vista**, sin calcularlo: lecturas cortas, sin candados. Es lo que usan
 * «Liquidación actual» y la cabecera del mes para decir «Preparando» o «Listo para emitir» sin correr
 * la vista previa de cada barrio (security-engineer, B1: una vista previa por barrio a la vez agotaba
 * las conexiones y trababa la carga de gastos de todos). La vista previa de la ficha del mes sigue
 * siendo la palabra final: si algo más bloquea, lo dice ahí y «Emitir» lo rechaza igual.
 *
 * Mira lo que más se rompe al preparar: por coeficiente, que haya una versión cerrada que rija para el
 * mes y que todas las unidades activas estén en ella; en cuota fija, que haya cuota para el mes y que
 * todas las unidades tengan su importe.
 */
export async function bloqueosALaVista(tx: DbConIdentidad, parametros: { readonly periodoId: string }): Promise<string[]> {
  const { periodoId } = vistaPreviaDelMesSchema.parse(parametros);
  const { rows } = await tx.execute<{ modelo: string; version: string | null; sin_coeficiente: number; cuota: string | null; sin_cuota: number }>(sql`
    with p as (select id, barrio_id, periodo, modelo from periodo_expensa where id = ${periodoId}),
         v as (
           select cv.id from coeficiente_version cv join barrio b on b.barrio_id = cv.barrio_id, p
            where cv.barrio_id = p.barrio_id and cv.cerrada
              and ((date_trunc('month', cv.vigente_desde) <= (p.periodo || '-01')::date
                    and (cv.vigente_hasta is null or cv.vigente_hasta > (p.periodo || '-01')::date))
                   or (cv.vigente_hasta is null and b.primer_periodo is null))
            order by (date_trunc('month', cv.vigente_desde) <= (p.periodo || '-01')::date) desc, cv.vigente_desde desc, cv.created_at desc
            limit 1
         ),
         c as (select app.cuota_fija_version_vigente(p.barrio_id, p.periodo) as id from p)
    select p.modelo::text as modelo,
           (select id from v)::text as version,
           (select count(*)::int from unidad_funcional u where u.barrio_id = p.barrio_id and u.baja_at is null
              and not exists (select 1 from coeficiente k where k.version_id = (select id from v) and k.unidad_funcional_id = u.id)) as sin_coeficiente,
           (select id from c)::text as cuota,
           (select count(*)::int from unidad_funcional u where u.barrio_id = p.barrio_id and u.baja_at is null
              and not exists (select 1 from cuota_fija f where f.version_id = (select id from c) and f.unidad_funcional_id = u.id)) as sin_cuota
      from p
  `);
  const f = rows[0];
  if (!f) return [];
  const unidades = (n: number) => (n === 1 ? "1 unidad activa" : `${n} unidades activas`);
  if (f.modelo === "fija") {
    if (f.cuota === null) return ["No hay cuota para el mes"];
    return f.sin_cuota > 0 ? [`${unidades(f.sin_cuota)} sin cuota`] : [];
  }
  if (f.version === null) return ["No hay una versión de coeficientes cerrada que rija para el mes"];
  return f.sin_coeficiente > 0 ? [`${unidades(f.sin_coeficiente)} sin coeficiente`] : [];
}

/** Si quien mira gestiona el mes del barrio (emite, cambia vencimientos, define la cuota): para mostrar u ocultar acciones. La base decide igual. */
export async function puedeGestionarElMes(tx: DbConIdentidad, parametros: { readonly barrioId: string }): Promise<boolean> {
  const { barrioId } = consultaBarrioSchema.parse(parametros);
  return puedeEmitirEnElBarrio(tx, barrioId);
}
