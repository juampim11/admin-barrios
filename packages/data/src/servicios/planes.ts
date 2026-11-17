/**
 * Los planes de pago: el motor (encargo P1, BL-051; `0093`).
 *
 * El servicio orquesta y la base hace cumplir. Las cuentas que importan las hace el código de siempre:
 *   · la deuda que entra es la de `deudaALaFecha` (capital y mora a la fecha de firma);
 *   · la mora que se cierra al firmar y la que se cobra al caer la calculan `deudaALaFecha` y
 *     `registrarTramos`: sobre capital, con las vigencias de la tasa del barrio, sin interés sobre
 *     interés (`0062`, `0064`, y la cuota de plan en `0093`);
 *   · las cuotas las arma `@admin-barrios/shared/planes` (portado de Aclade).
 *
 * **Firmar** (`aprobarPlan`), en una transacción: candado de la unidad → la deuda a la fecha → el pago
 * del plan (`app.plan_crear_pago`) → los tramos de mora cerrados con ese pago → `app.plan_firmar`
 * (imputa, deja vigente, retira la derivación, emite las cuotas de meses ya emitidos).
 *
 * **Caer** (`declararCaido`), en una transacción: `app.plan_caer_preparar` (anula lo imputado a las
 * cuotas y la firma: vuelve la deuda original con su quita) → las cuotas emitidas e impagas se cancelan
 * con otro pago del plan → lo pagado del plan se vuelve a imputar (`app.resolver_imputacion`) → la
 * mora que no corrió, de la firma a hoy y sobre el capital que sigue impago, se cierra con el código
 * de siempre (es el cargo de la caída) → `app.plan_caer_cerrar`.
 */
import { sql } from "drizzle-orm";
import { aCentavos, deCentavos, sumarMontos, type Monto } from "@admin-barrios/shared/dinero";
import { idSchema } from "@admin-barrios/shared/consultas";
import { esErrorDeNegocio } from "@admin-barrios/shared/errores";
import { porcentajeDeTasa } from "@admin-barrios/shared/activacion";
import {
  cerrarPlanSchema,
  cronogramaDeCatalogo,
  cuadreAMedida,
  fueraDelCatalogo,
  aprobarPlanSchema,
  PlanInvalido,
  proponerPlanAMedidaSchema,
  proponerPlanDeCatalogoSchema,
  validarCronograma,
  type AprobarPlan,
  type CerrarPlan,
  type CronogramaDePlan,
  type EstadoPlan,
  type ProponerPlanAMedida,
  type ProponerPlanDeCatalogo,
} from "@admin-barrios/shared/planes";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";
import { deudaALaFecha, registrarTramos } from "./deuda.ts";

type Unidad = { barrioId: string; hoy: string };

async function unidad(tx: DbConIdentidad, unidadFuncionalId: string): Promise<Unidad> {
  const { rows } = await tx.execute<{ barrio_id: string; hoy: string }>(sql`
    select u.barrio_id, (now() at time zone b.zona_horaria)::date::text as hoy
      from unidad_funcional u join barrio b on b.barrio_id = u.barrio_id where u.id = ${unidadFuncionalId}
  `);
  const f = rows[0];
  if (!f) rechazar("unidad_no_encontrada", "Esa unidad no existe o no tenés acceso a ella.", "Volvé a la mora del barrio.");
  return { barrioId: f.barrio_id, hoy: f.hoy };
}

/** La deuda que entra: cada liquidación elegida, vencida a `fecha`, con su capital y su mora a esa fecha. */
async function deudaQueEntra(
  tx: DbConIdentidad,
  u: Unidad & { unidadFuncionalId: string },
  liquidacionIds: readonly string[],
  fecha: string,
) {
  const deuda = (await deudaALaFecha(tx, { barrioId: u.barrioId, fecha, unidadFuncionalId: u.unidadFuncionalId })).get(u.unidadFuncionalId);
  const elegidas = new Set(liquidacionIds);
  const meses = (deuda?.porMes ?? []).filter((m) => elegidas.has(m.liquidacionId));
  if (meses.length !== elegidas.size) {
    rechazar("dato_invalido", "Alguno de los meses elegidos ya no debe nada o no es de esta unidad.", "Recargá la deuda y volvé a elegir.");
  }
  for (const m of meses) {
    if (m.origen === "plan" || m.vencimiento >= fecha) {
      rechazar("dato_invalido", "Al plan entran meses vencidos (no cuotas de otro plan).", "Sacá los meses que todavía no vencieron.");
    }
  }
  const capital = sumarMontos("0.00", ...meses.map((m) => m.capital));
  const interes = sumarMontos("0.00", ...meses.map((m) => m.interes));
  return { meses, capital, interes, total: sumarMontos(capital, interes), tramos: (deuda?.tramos ?? []).filter((t) => elegidas.has(t.liquidacionId)) };
}

async function insertarPartes(
  tx: DbConIdentidad,
  planId: string,
  barrioId: string,
  meses: readonly { liquidacionId: string; capital: Monto; interes: Monto }[],
  cronograma: CronogramaDePlan["cuotas"],
): Promise<void> {
  for (const m of meses) {
    await tx.execute(sql`
      insert into plan_liquidacion (plan_id, barrio_id, liquidacion_id, capital, interes)
      values (${planId}, ${barrioId}, ${m.liquidacionId}, ${m.capital}::numeric, ${m.interes}::numeric)
    `);
  }
  for (const c of cronograma) {
    await tx.execute(sql`
      insert into plan_cuota (plan_id, barrio_id, numero, vencimiento, importe, capital, interes, mora_incluida)
      values (${planId}, ${barrioId}, ${c.numero}, ${c.vencimiento}::date, ${c.importe}::numeric, ${c.capital}::numeric, ${c.interes}::numeric,
              ${c.moraIncluida ?? "0.00"}::numeric)
    `);
  }
}

function enPlanInvalido<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PlanInvalido) rechazar("dato_invalido", e.message, "Revisá las cuotas del plan.");
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Proponer
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Un plan del catálogo: lo arma el sistema con la deuda de hoy y lo firma en la misma transacción
 * (está acordado de antemano). Devuelve el plan ya vigente.
 */
export async function crearPlanDeCatalogo(
  tx: DbConIdentidad,
  parametros: ProponerPlanDeCatalogo,
): Promise<{ readonly planId: string; readonly barrioId: string }> {
  const q = proponerPlanDeCatalogoSchema.parse(parametros);
  return enBase(async () => {
    const u = { ...(await unidad(tx, q.unidadFuncionalId)), unidadFuncionalId: q.unidadFuncionalId };
    const { rows: cat } = await tx.execute<{
      sistema: "fija" | "frances";
      tasa: string;
      cuotas_min: number;
      cuotas_max: number;
      anticipo: "no" | "opcional" | "obligatorio";
      anticipo_max_pct: string | null;
      deuda_maxima: string | null;
      estudio_id: string | null;
      modo_cobro: "barrio" | "estudio";
    }>(sql`
      select c.sistema, c.tasa_mensual::text as tasa, c.cuotas_min, c.cuotas_max, c.anticipo, c.anticipo_max_pct::text as anticipo_max_pct,
             c.deuda_maxima::text as deuda_maxima, c.estudio_id, c.modo_cobro
        from plan_catalogo c join plan_catalogo_barrio cb on cb.catalogo_id = c.id
       where c.id = ${q.catalogoId} and cb.barrio_id = ${u.barrioId} and c.activo
    `);
    const c = cat[0];
    if (!c) rechazar("dato_invalido", "Ese plan del catálogo no es de este barrio o está dado de baja.", "Elegí otro plan.");
    // [P2a-2] Quién cobra: el del plan del catálogo, o el barrio si se cambia (el estudio solo si el plan tiene uno).
    const modoCobro = q.modoCobro ?? c.modo_cobro;
    if (modoCobro === "estudio" && c.estudio_id === null) {
      rechazar("dato_invalido", "Ese plan del catálogo no es con un estudio: lo cobra el barrio.", "Elegí que cobre el barrio.");
    }
    const estudioId = modoCobro === "estudio" ? c.estudio_id : null;
    const fecha = q.fecha ?? u.hoy;
    if (fecha > u.hoy) rechazar("dato_invalido", "La fecha de firma no puede ser futura.", "Revisá la fecha del acuerdo.");
    const { rows: posteriores } = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from pago where unidad_funcional_id = ${q.unidadFuncionalId} and anulado_at is null and fecha > ${fecha}::date
    `);
    if ((posteriores[0]?.n ?? 0) > 0) {
      rechazar("dato_invalido", "La unidad tiene pagos posteriores a esa fecha de firma.", "Firmá el plan con la fecha de hoy.");
    }
    const deuda = await deudaQueEntra(tx, u, q.liquidacionIds, fecha);
    const anticipo = q.anticipo !== null && aCentavos(q.anticipo) > 0n ? q.anticipo : null;
    // [P2a-2] La misma regla que usa la pantalla para avisar que el plan pasa a ser a medida.
    const [fuera] = fueraDelCatalogo(
      {
        cuotasMin: c.cuotas_min,
        cuotasMax: c.cuotas_max,
        anticipo: c.anticipo,
        anticipoMaxPorcentaje: c.anticipo_max_pct,
        deudaMaxima: c.deuda_maxima as Monto | null,
      },
      { deuda: deuda.total, cuotas: q.cuotas, anticipo },
    );
    if (fuera) rechazar("dato_invalido", fuera, "Ajustalo a lo que dice el plan del catálogo, o armalo a medida.");
    const entrada = {
      deuda: deuda.total,
      anticipo,
      cuotas: q.cuotas,
      primerVencimiento: q.primerVencimiento,
      ...(q.vencimientoAnticipo ? { vencimientoAnticipo: q.vencimientoAnticipo } : {}),
    };
    // [0094] Si el barrio financia la mora (el francés corre sobre capital + mora) o no (solo sobre el
    // capital, y la mora en partes iguales sin interés). La firma verifica que la mora marcada en las
    // cuotas sea la de la deuda que entra.
    const { rows: opcion } = await tx.execute<{ financia_mora: boolean }>(sql`
      select coalesce((select financia_mora from plan_parametro_barrio where barrio_id = ${u.barrioId}), false) as financia_mora
    `);
    const cronograma = enPlanInvalido(() =>
      cronogramaDeCatalogo({
        ...entrada,
        sistema: c.sistema,
        tasaMensual: c.tasa,
        mora: deuda.interes,
        financiaMora: opcion[0]?.financia_mora ?? false,
      }),
    );
    if (cronograma.cuotas.some((x) => x.vencimiento <= fecha)) {
      rechazar("dato_invalido", "Las cuotas vencen después de la firma.", "Cambiá el primer vencimiento.");
    }
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into plan_pago (barrio_id, unidad_funcional_id, catalogo_id, tipo, sistema, tasa_mensual, modo_cobro, estudio_id,
                             deuda_capital, deuda_interes, anticipo, total_cuotas, interes_financiacion, cantidad_cuotas, creado_por)
      values (${u.barrioId}, ${q.unidadFuncionalId}, ${q.catalogoId}, 'catalogo', ${c.sistema}, ${c.tasa}::numeric, ${modoCobro}, ${estudioId},
              ${deuda.capital}::numeric, ${deuda.interes}::numeric, ${anticipo ?? "0.00"}::numeric, ${cronograma.total}::numeric,
              ${cronograma.interesFinanciacion}::numeric, ${cronograma.cuotas.length}, app.current_user_id())
      returning id
    `);
    const planId = rows[0]!.id;
    await insertarPartes(tx, planId, u.barrioId, deuda.meses, cronograma.cuotas);
    await firmar(tx, planId, fecha);
    return { planId, barrioId: u.barrioId };
  });
}

/** Un plan a medida: queda pendiente hasta que la administración lo apruebe (`aprobarPlan`). */
export async function proponerPlanAMedida(
  tx: DbConIdentidad,
  parametros: ProponerPlanAMedida,
): Promise<{ readonly planId: string; readonly barrioId: string }> {
  const q = proponerPlanAMedidaSchema.parse(parametros);
  return enBase(async () => {
    const u = { ...(await unidad(tx, q.unidadFuncionalId)), unidadFuncionalId: q.unidadFuncionalId };
    enPlanInvalido(() => validarCronograma(q.cronograma));
    // [P2a-2] Hoy tampoco: la firma exige que cada cuota venza después del día en que se firma.
    if (q.cronograma.some((c) => c.vencimiento <= u.hoy)) rechazar("dato_invalido", "Las cuotas vencen después de hoy.", "Revisá las fechas.");
    if ((q.modoCobro === "estudio") !== (q.estudioId !== null)) rechazar("dato_invalido", "Si cobra el estudio, elegí cuál.", "Revisá quién cobra.");
    if (q.estudioId !== null) {
      // [P2a-2] El estudio que cobra tiene que trabajar en el barrio.
      const { rows: trabaja } = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from estudio_barrio eb join tenant_node n on n.id = eb.barrio_id
          join estudio_administracion ea on ea.estudio_id = eb.estudio_id and ea.administracion_id = n.parent_id and ea.activo
         where eb.estudio_id = ${q.estudioId} and eb.barrio_id = ${u.barrioId}
      `);
      if ((trabaja[0]?.n ?? 0) === 0) rechazar("dato_invalido", "Ese estudio no trabaja en el barrio.", "Elegí otro estudio o que cobre el barrio.");
    }
    const deuda = await deudaQueEntra(tx, u, q.liquidacionIds, u.hoy);
    const cuadre = cuadreAMedida({ capital: deuda.capital, interes: deuda.interes }, q.cronograma);
    const total = sumarMontos("0.00", ...q.cronograma.map((c) => c.importe));
    const excedente = cuadre.excede ? deCentavos(aCentavos(total) - aCentavos(deuda.total)) : "0.00";
    const anticipo = q.cronograma.find((c) => c.numero === 0)?.importe ?? "0.00";
    const { rows } = await tx.execute<{ id: string }>(sql`
      insert into plan_pago (barrio_id, unidad_funcional_id, tipo, sistema, modo_cobro, estudio_id, motivo, acta_referencia, acta_adjunto,
                             deuda_capital, deuda_interes, anticipo, total_cuotas, interes_financiacion, quita_interes, quita_capital,
                             cantidad_cuotas, creado_por)
      values (${u.barrioId}, ${q.unidadFuncionalId}, 'a_medida', 'libre', ${q.modoCobro}, ${q.estudioId}, ${q.motivo},
              ${q.actaReferencia}, ${q.actaReferencia === null ? null : q.actaAdjunto},
              ${deuda.capital}::numeric, ${deuda.interes}::numeric, ${anticipo}::numeric, ${total}::numeric, ${excedente}::numeric,
              ${cuadre.quitaInteres}::numeric, ${cuadre.quitaCapital}::numeric, ${q.cronograma.length}, app.current_user_id())
      returning id
    `);
    const planId = rows[0]!.id;
    // En un plan a medida la cuota no separa capital de interés: la mora, si cae una cuota, corre sobre
    // ella (el excedente pactado, si lo hay, va como interés de financiación de la primera cuota).
    let excedentePorRepartir = aCentavos(excedente);
    const cuotas = [...q.cronograma]
      .sort((a, b) => a.numero - b.numero)
      .map((c) => {
        const interes = excedentePorRepartir < aCentavos(c.importe) ? excedentePorRepartir : aCentavos(c.importe);
        excedentePorRepartir -= interes;
        return { numero: c.numero, vencimiento: c.vencimiento, importe: c.importe, interes: deCentavos(interes), capital: deCentavos(aCentavos(c.importe) - interes) };
      });
    await insertarPartes(tx, planId, u.barrioId, deuda.meses, cuotas);
    return { planId, barrioId: u.barrioId };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Firmar, rechazar, retirar
// ────────────────────────────────────────────────────────────────────────────────────────────────

async function firmar(tx: DbConIdentidad, planId: string, fecha: string): Promise<void> {
  const { rows } = await tx.execute<{ unidad_funcional_id: string; barrio_id: string; tipo: string; sistema: string }>(sql`
    select unidad_funcional_id, barrio_id, tipo, sistema from plan_pago where id = ${planId} and estado = 'pendiente'
  `);
  const p = rows[0];
  if (!p) rechazar("dato_invalido", "Ese plan ya no está pendiente.", "Recargá la ficha de la unidad.");
  await tx.execute(sql`select app.serializar_cobros_de_unidad(${p.unidad_funcional_id}::uuid)`);
  const { rows: liqs } = await tx.execute<{ liquidacion_id: string }>(sql`select liquidacion_id from plan_liquidacion where plan_id = ${planId}`);
  const deuda = await deudaQueEntra(
    tx,
    { barrioId: p.barrio_id, hoy: fecha, unidadFuncionalId: p.unidad_funcional_id },
    liqs.map((l) => l.liquidacion_id),
    fecha,
  );
  const { rows: pago } = await tx.execute<{ id: string }>(sql`select app.plan_crear_pago(${planId}::uuid, ${deuda.total}::numeric, ${fecha}::date) as id`);
  const pagoId = pago[0]!.id;
  // La mora de la deuda incluida, cerrada a la fecha de firma con el código de siempre.
  await registrarTramos(tx, deuda.tramos, { origen: "pago", pagoId });
  await tx.execute(sql`select app.plan_firmar(${planId}::uuid, ${pagoId}::uuid)`);
}

/**
 * Aprueba un plan a medida pendiente: se firma con la deuda de hoy (la quita se recalcula). [P2a-2] Con el
 * acta, si llega: se carga antes de firmar (`app.plan_cargar_acta`). Si el barrio la exige y el plan
 * tiene quita, sin acta lo frena la base (`0095`).
 */
export async function aprobarPlan(tx: DbConIdentidad, parametros: AprobarPlan): Promise<void> {
  const q = aprobarPlanSchema.parse(parametros);
  const planId = q.planId;
  await enBase(async () => {
    if (q.actaReferencia !== null) {
      await tx.execute(sql`select app.plan_cargar_acta(${planId}::uuid, ${q.actaReferencia}, ${q.actaAdjunto})`);
    }
    const { rows } = await tx.execute<{ hoy: string }>(sql`
      select (now() at time zone b.zona_horaria)::date::text as hoy from plan_pago p join barrio b on b.barrio_id = p.barrio_id where p.id = ${planId}
    `);
    if (!rows[0]) rechazar("referencia_inexistente", "Ese plan no existe o no tenés acceso.", "Recargá la ficha.");
    await firmar(tx, planId, rows[0].hoy);
  });
}

export async function rechazarPlan(tx: DbConIdentidad, parametros: CerrarPlan): Promise<void> {
  const q = cerrarPlanSchema.parse(parametros);
  await enBase(() => tx.execute(sql`select app.plan_cerrar_pendiente(${q.planId}::uuid, 'rechazado', ${q.motivo})`).then(() => undefined));
}

export async function retirarPlan(tx: DbConIdentidad, parametros: CerrarPlan): Promise<void> {
  const q = cerrarPlanSchema.parse(parametros);
  await enBase(() => tx.execute(sql`select app.plan_cerrar_pendiente(${q.planId}::uuid, 'retirado', ${q.motivo})`).then(() => undefined));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Caer
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type ResultadoDeLaCaida = {
  /** La deuda que había entrado al plan (capital + mora a la firma, sin quita). */
  readonly deudaOriginal: Monto;
  /** Lo que se pagó de las cuotas: vuelve a imputarse a la deuda original. */
  readonly pagadoDelPlan: Monto;
  /** El interés por mora que no corrió durante el plan: de la firma a hoy, sobre el capital que seguía impago. */
  readonly cargo: Monto;
  /** Lo que queda debiendo de esa deuda: deuda original − pagado + cargo (si lo pagado no fue a otra deuda). */
  readonly quedaDebiendo: Monto;
};

export async function declararCaido(tx: DbConIdentidad, parametros: { readonly planId: string; readonly nota?: string | null }): Promise<ResultadoDeLaCaida> {
  const planId = idSchema.parse(parametros.planId);
  return enBase(async () => {
    const { rows } = await tx.execute<{ unidad_funcional_id: string; barrio_id: string; hoy: string; deuda: string }>(sql`
      select p.unidad_funcional_id, p.barrio_id, (now() at time zone b.zona_horaria)::date::text as hoy,
             (p.deuda_capital + p.deuda_interes)::numeric(14,2)::text as deuda
        from plan_pago p join barrio b on b.barrio_id = p.barrio_id where p.id = ${planId}
    `);
    const p = rows[0];
    if (!p) rechazar("referencia_inexistente", "Ese plan no existe o no tenés acceso.", "Recargá la ficha.");
    // Primero la unidad (como la firma y cada cobro), después el plan: mismo orden de candados que un
    // pago concurrente, y lo pagado que se lee abajo ya no cambia.
    await tx.execute(sql`select app.serializar_cobros_de_unidad(${p.unidad_funcional_id}::uuid)`);
    // Lo pagado de las cuotas (capital, financiación y mora de la cuota), por pagos reales.
    const { rows: pagado } = await tx.execute<{ pagado: string }>(sql`
      select (coalesce((select sum(pi.monto_imputado) from pago_imputacion pi join pago pg on pg.id = pi.pago_id
                         join plan_cuota c on c.liquidacion_id = pi.liquidacion_id
                        where c.plan_id = ${planId} and pi.anulado_at is null and pg.origen <> 'plan'), 0)
            + coalesce((select sum(pii.monto_imputado) from pago_imputacion_interes pii join pago pg on pg.id = pii.pago_id
                         join interes_devengado d on d.id = pii.interes_id join plan_cuota c on c.liquidacion_id = d.liquidacion_id
                        where c.plan_id = ${planId} and pii.anulado_at is null and pg.origen <> 'plan'), 0))::numeric(14,2)::text as pagado
    `);
    const { rows: pagos } = await tx.execute<{ pago_id: string }>(sql`select pago_id from app.plan_caer_preparar(${planId}::uuid) as pago_id`);

    // Las cuotas emitidas e impagas (y su mora) se cancelan: la deuda volvió entera en los meses originales.
    const { rows: resto } = await tx.execute<{ total: string }>(sql`
      select (coalesce((select sum(app.saldo_de_liquidacion(c.liquidacion_id)) from plan_cuota c
                         where c.plan_id = ${planId} and c.liquidacion_id is not null), 0)
            + coalesce((select sum(app.interes_pendiente(d.id)) from interes_devengado d join plan_cuota c on c.liquidacion_id = d.liquidacion_id
                         where c.plan_id = ${planId} and d.monto > 0), 0))::numeric(14,2)::text as total
    `);
    const cancelar = resto[0]!.total as Monto;
    if (aCentavos(cancelar) <= 0n) rechazar("dato_invalido", "El plan no tiene cuotas impagas para cancelar.", "Recargá la ficha.");
    const { rows: cancelacion } = await tx.execute<{ id: string }>(sql`select app.plan_crear_pago(${planId}::uuid, ${cancelar}::numeric, ${p.hoy}::date) as id`);
    const cancelacionId = cancelacion[0]!.id;
    await tx.execute(sql`select app.plan_caer_cancelar_cuotas(${planId}::uuid, ${cancelacionId}::uuid)`);

    // Lo pagado del plan vuelve a la deuda ORIGINAL del plan (deuda original − lo pagado): primero a sus
    // meses —con el orden de imputación del barrio entre su mora y su capital, lo más viejo primero—, y
    // recién lo que sobre, con el orden general. Si volviera con el orden general, una parte podía ir a la
    // mora de otros meses posteriores a la firma y dejar más capital del plan corriendo: el cargo de la
    // caída salía más alto que el de la regla.
    await reimputarALaDeudaOriginal(tx, { planId, barrioId: p.barrio_id, hoy: p.hoy, pagos: pagos.map((x) => x.pago_id) });
    for (const x of pagos) await tx.execute(sql`select app.resolver_imputacion(${x.pago_id}::uuid)`);

    // El cargo: la mora de la deuda original de la firma a hoy, sobre el capital que sigue impago.
    const { rows: liqs } = await tx.execute<{ liquidacion_id: string }>(sql`select liquidacion_id from plan_liquidacion where plan_id = ${planId}`);
    const originales = new Set(liqs.map((l) => l.liquidacion_id));
    const deuda = (await deudaALaFecha(tx, { barrioId: p.barrio_id, fecha: p.hoy, unidadFuncionalId: p.unidad_funcional_id })).get(p.unidad_funcional_id);
    const tramos = (deuda?.tramos ?? []).filter((t) => originales.has(t.liquidacionId));
    const creados = await registrarTramos(tx, tramos, { origen: "pago", pagoId: cancelacionId });
    const cargo = sumarMontos("0.00", ...creados.map((c) => c.monto));
    const pagadoDelPlan = pagado[0]!.pagado as Monto;
    const quedaDebiendo = deCentavos(aCentavos(p.deuda) - aCentavos(pagadoDelPlan) + aCentavos(cargo));
    await tx.execute(sql`
      select app.plan_caer_cerrar(${planId}::uuid, ${cargo}::numeric,
        ${JSON.stringify({ deudaOriginal: p.deuda, pagadoDelPlan, cuotasCanceladas: cancelar, quedaDebiendo, nota: parametros.nota ?? null })}::jsonb)
    `);
    return { deudaOriginal: p.deuda as Monto, pagadoDelPlan, cargo, quedaDebiendo };
  });
}

/**
 * La reimputación de la caída: cada pago real que había ido a las cuotas (por fecha), contra la deuda
 * original del plan. Dos pasadas como `app.resolver_imputacion` —la mora pendiente de esos meses y su
 * capital, en el orden que el barrio tenga configurado—, pero acotadas a las liquidaciones del plan.
 */
async function reimputarALaDeudaOriginal(
  tx: DbConIdentidad,
  a: { readonly planId: string; readonly barrioId: string; readonly hoy: string; readonly pagos: readonly string[] },
): Promise<void> {
  if (a.pagos.length === 0) return;
  const { rows: orden } = await tx.execute<{ orden: string | null }>(sql`
    select (select x.valor #>> '{}' from app.parametro_resuelto(${a.barrioId}::uuid, 'imputacion.orden', ${a.hoy}::date) x) as orden
  `);
  const interesPrimero = orden[0]?.orden === "intereses_primero_capital_antiguo";
  const { rows: pagos } = await tx.execute<{ id: string; libre: string }>(sql`
    select p.id, (p.monto - coalesce((select sum(monto_imputado) from pago_imputacion where pago_id = p.id and anulado_at is null), 0)
                          - coalesce((select sum(monto_imputado) from pago_imputacion_interes where pago_id = p.id and anulado_at is null), 0)
                 )::numeric(14,2)::text as libre
      from pago p where p.id = any(${sql.param(a.pagos)}::uuid[]) order by p.fecha, p.id
  `);
  for (const pago of pagos) {
    let libre = aCentavos(pago.libre as Monto);
    for (const pasada of interesPrimero ? (["interes", "capital"] as const) : (["capital", "interes"] as const)) {
      if (libre <= 0n) break;
      const { rows: destinos } =
        pasada === "interes"
          ? await tx.execute<{ id: string; saldo: string }>(sql`
              select d.id, app.interes_pendiente(d.id)::numeric(14,2)::text as saldo
                from interes_devengado d join plan_liquidacion pl on pl.liquidacion_id = d.liquidacion_id
               where pl.plan_id = ${a.planId} and d.monto > 0 order by d.hasta, d.id`)
          : await tx.execute<{ id: string; saldo: string }>(sql`
              select l.id, app.saldo_de_liquidacion(l.id)::numeric(14,2)::text as saldo
                from liquidacion l join plan_liquidacion pl on pl.liquidacion_id = l.id
                join periodo_expensa pe on pe.id = l.periodo_id
               where pl.plan_id = ${a.planId}
               order by coalesce(l.vencimiento, pe.primer_vencimiento), pe.periodo, l.id`);
      for (const d of destinos) {
        if (libre <= 0n) break;
        const saldo = aCentavos(d.saldo as Monto);
        if (saldo <= 0n) continue;
        const monto = deCentavos(libre < saldo ? libre : saldo);
        if (pasada === "interes") {
          await tx.execute(sql`insert into pago_imputacion_interes (pago_id, interes_id, monto_imputado) values (${pago.id}, ${d.id}, ${monto}::numeric)`);
        } else {
          await tx.execute(sql`insert into pago_imputacion (pago_id, liquidacion_id, monto_imputado) values (${pago.id}, ${d.id}, ${monto}::numeric)`);
        }
        libre -= aCentavos(monto);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Lecturas
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que la unidad debe en total, contando las cuotas de sus planes vigentes que todavía no se
 * emitieron: la deuda emitida (lo que falta de cada liquidación, vencida o no), la mora registrada
 * pendiente, la que correría hoy, y las cuotas por emitir. Firmar un plan sin interés ni quita no lo
 * cambia.
 */
export async function saldoTotalDeUnidad(tx: DbConIdentidad, parametros: { readonly unidadFuncionalId: string }): Promise<Monto> {
  const unidadId = idSchema.parse(parametros.unidadFuncionalId);
  const u = await unidad(tx, unidadId);
  const { rows } = await tx.execute<{ emitido: string; interes: string; por_emitir: string }>(sql`
    select coalesce((select sum(app.saldo_de_liquidacion(l.id)) from liquidacion l join periodo_expensa pe on pe.id = l.periodo_id
                      where l.unidad_funcional_id = ${unidadId} and pe.estado in ('emitida', 'distribuida')), 0)::numeric(14,2)::text as emitido,
           coalesce((select sum(app.interes_pendiente(d.id)) from interes_devengado d where d.unidad_funcional_id = ${unidadId} and d.monto > 0), 0)::numeric(14,2)::text as interes,
           coalesce((select sum(c.importe) from plan_cuota c join plan_pago p on p.id = c.plan_id
                      where p.unidad_funcional_id = ${unidadId} and p.estado = 'vigente' and c.liquidacion_id is null), 0)::numeric(14,2)::text as por_emitir
  `);
  const deuda = (await deudaALaFecha(tx, { barrioId: u.barrioId, fecha: u.hoy, unidadFuncionalId: unidadId })).get(unidadId);
  const r = rows[0]!;
  return sumarMontos(r.emitido, r.interes, r.por_emitir, deuda?.interesNuevo ?? "0.00");
}

/** Cómo está una cuota hoy (pantalla 4). */
/** `cancelada`: el plan cayó y la cuota se canceló (no se pagó: su deuda volvió a los meses originales). */
export type EstadoDeCuota = "pagada" | "cancelada" | "vencida" | "a_vencer" | "sin_emitir";

export type CuotaDeUnidad = {
  readonly numero: number;
  readonly vencimiento: string;
  readonly importe: Monto;
  /**
   * Lo que se pagó de la cuota **con pagos reales** (capital y su mora; no el pago del plan que la cancela
   * al caer): la misma cuenta que `declararCaido`. null si todavía no se emitió.
   */
  readonly pagado: Monto | null;
  readonly estado: EstadoDeCuota;
};

export type PlanDeUnidad = {
  readonly id: string;
  readonly estado: EstadoPlan;
  readonly tipo: "catalogo" | "a_medida";
  readonly sistema: "fija" | "frances" | "libre";
  /** El nombre del plan del catálogo, o null si es a medida. */
  readonly nombre: string | null;
  /** Tasa mensual como se escribe (`2`), solo en francés. */
  readonly tasaPorcentaje: string | null;
  readonly estudio: string | null;
  readonly modoCobro: "barrio" | "estudio";
  readonly fechaFirma: string | null;
  readonly firmadoPor: string | null;
  readonly cerradoEl: string | null;
  readonly motivo: string | null;
  /** Lo que entró al plan: capital + mora a la firma, y de qué meses. */
  readonly deuda: Monto;
  readonly deudaCapital: Monto;
  readonly deudaInteres: Monto;
  readonly meses: readonly string[];
  readonly quita: Monto;
  readonly totalCuotas: Monto;
  /** Lo pagado de las cuotas emitidas. */
  readonly pagado: Monto;
  readonly cargoCaida: Monto | null;
  /** Con cuántas cuotas impagas vencidas se puede declarar caído (regla del barrio). */
  readonly cuotasParaCaer: number;
  readonly cuotasVencidas: number;
  readonly cuotas: readonly CuotaDeUnidad[];
  /** Si quien mira puede declararlo caído (administración del barrio; la base lo vuelve a decidir). */
  readonly puedeAdministrar: boolean;
  /** [P2a-2] El acta del órgano del barrio, si se cargó (planes a medida). */
  readonly actaReferencia: string | null;
  readonly actaAdjunta: boolean;
  /** [P2a-2] Si para aprobarlo hace falta el acta: es a medida, tiene quita y el barrio la exige (`0094`). */
  readonly pideActa: boolean;
  /**
   * [P2a-2] Es a medida y el barrio exige el acta para una quita, aunque la quita guardada sea cero: al
   * aprobarlo se recalcula con la deuda de hoy y puede aparecer (la mora siguió corriendo).
   */
  readonly exigeActa: boolean;
  /** [P2a-2] De la quita, cuánto es de mora y cuánto de capital. */
  readonly quitaInteres: Monto;
  readonly quitaCapital: Monto;
};

/**
 * Los planes de una unidad, el más nuevo primero, con lo que muestra la pantalla 4: sus cuotas y cómo
 * está cada una hoy, lo que entró, lo pagado y la regla de caída del barrio. Todo sale de la base.
 */
export async function planesDeUnidad(tx: DbConIdentidad, parametros: { readonly unidadFuncionalId: string }): Promise<PlanDeUnidad[]> {
  const unidadId = idSchema.parse(parametros.unidadFuncionalId);
  const { rows } = await tx.execute<{
    id: string;
    estado: EstadoPlan;
    tipo: "catalogo" | "a_medida";
    sistema: "fija" | "frances" | "libre";
    nombre: string | null;
    tasa: string;
    estudio: string | null;
    modo_cobro: "barrio" | "estudio";
    fecha_firma: string | null;
    firmado_por: string | null;
    cerrado_el: string | null;
    motivo: string | null;
    deuda_capital: string;
    deuda_interes: string;
    quita: string;
    total: string;
    cargo_caida: string | null;
    cuotas_para_caer: number;
    quita_requiere_acta: boolean;
    acta_referencia: string | null;
    acta_adjunta: boolean;
    quita_interes: string;
    quita_capital: string;
    meses: string[] | null;
    cuotas: { numero: number; vencimiento: string; importe: string; saldo: string | null; capital_real: string | null; pagado_real: string | null }[] | null;
    hoy: string;
    puede: boolean;
  }>(sql`
    select p.id, p.estado, p.tipo, p.sistema, k.nombre, p.tasa_mensual::text as tasa,
           (select ea.nombre from estudio_administracion ea join tenant_node b on b.parent_id = ea.administracion_id
             where ea.estudio_id = p.estudio_id and b.id = p.barrio_id) as estudio,
           p.modo_cobro, p.fecha_firma::text as fecha_firma,
           (select coalesce(ud.nombre, 'La administración') from plan_evento e left join usuario_demo ud on ud.user_id = e.registrado_por
             where e.plan_id = p.id and e.tipo = 'firmado' limit 1) as firmado_por,
           (p.cerrado_at at time zone b.zona_horaria)::date::text as cerrado_el, p.motivo,
           p.deuda_capital::text, p.deuda_interes::text, (p.quita_interes + p.quita_capital)::numeric(14,2)::text as quita,
           p.total_cuotas::text as total, p.cargo_caida::text,
           coalesce((select cuotas_para_caer from plan_parametro_barrio where barrio_id = p.barrio_id), 2) as cuotas_para_caer,
           coalesce((select quita_requiere_acta from plan_parametro_barrio where barrio_id = p.barrio_id), false) as quita_requiere_acta,
           p.acta_referencia, p.acta_adjunto is not null as acta_adjunta,
           p.quita_interes::text as quita_interes, p.quita_capital::text as quita_capital,
           (select array_agg(pe.periodo order by pe.periodo) from plan_liquidacion pl join liquidacion l on l.id = pl.liquidacion_id
              join periodo_expensa pe on pe.id = l.periodo_id where pl.plan_id = p.id) as meses,
           (select json_agg(json_build_object('numero', c.numero, 'vencimiento', c.vencimiento::text, 'importe', c.importe::text,
                                              'saldo', case when c.liquidacion_id is null then null else app.saldo_de_liquidacion(c.liquidacion_id)::numeric(14,2)::text end,
                                              -- Lo pagado con pagos reales (no el del plan): capital, y capital + su mora.
                                              -- En un plan caído, la caída anuló esas imputaciones (lo pagado volvió a la deuda
                                              -- original) pero el pago sigue vivo: también cuentan como pagado de la cuota.
                                              'capital_real', case when c.liquidacion_id is null then null else
                                                coalesce((select sum(pi.monto_imputado) from pago_imputacion pi join pago pg on pg.id = pi.pago_id
                                                           where pi.liquidacion_id = c.liquidacion_id and (pi.anulado_at is null or p.estado = 'caido') and pg.anulado_at is null
                                                             and pg.origen <> 'plan'), 0)::numeric(14,2)::text end,
                                              'pagado_real', case when c.liquidacion_id is null then null else
                                                (coalesce((select sum(pi.monto_imputado) from pago_imputacion pi join pago pg on pg.id = pi.pago_id
                                                            where pi.liquidacion_id = c.liquidacion_id and (pi.anulado_at is null or p.estado = 'caido') and pg.anulado_at is null
                                                              and pg.origen <> 'plan'), 0)
                                               + coalesce((select sum(pii.monto_imputado) from pago_imputacion_interes pii join pago pg on pg.id = pii.pago_id
                                                             join interes_devengado d on d.id = pii.interes_id
                                                            where d.liquidacion_id = c.liquidacion_id and (pii.anulado_at is null or p.estado = 'caido') and pg.anulado_at is null
                                                              and pg.origen <> 'plan'), 0))::numeric(14,2)::text end)
                            order by c.numero)
              from plan_cuota c where c.plan_id = p.id) as cuotas,
           (now() at time zone b.zona_horaria)::date::text as hoy,
           app.has_role_on(p.barrio_id, array['admin_plataforma', 'admin_barrio']::app.rol_membership[]) as puede
      from plan_pago p join barrio b on b.barrio_id = p.barrio_id
      left join plan_catalogo k on k.id = p.catalogo_id
     where p.unidad_funcional_id = ${unidadId}
     order by p.created_at desc
  `);
  return rows.map((r) => {
    const cuotas: CuotaDeUnidad[] = (r.cuotas ?? []).map((c) => {
      const pagado = c.pagado_real === null ? null : (c.pagado_real as Monto);
      const estado: EstadoDeCuota =
        c.saldo === null
          ? "sin_emitir"
          : aCentavos((c.capital_real ?? "0.00") as Monto) >= aCentavos(c.importe as Monto)
            ? "pagada"
            : aCentavos(c.saldo as Monto) <= 0n
              ? "cancelada"
              : c.vencimiento < r.hoy
                ? "vencida"
                : "a_vencer";
      return { numero: c.numero, vencimiento: c.vencimiento, importe: c.importe as Monto, pagado, estado };
    });
    return {
      id: r.id,
      estado: r.estado,
      tipo: r.tipo,
      sistema: r.sistema,
      nombre: r.nombre,
      tasaPorcentaje: r.sistema === "frances" ? porcentajeDeTasa(r.tasa) : null,
      estudio: r.estudio,
      modoCobro: r.modo_cobro,
      fechaFirma: r.fecha_firma,
      firmadoPor: r.firmado_por,
      cerradoEl: r.cerrado_el,
      motivo: r.motivo,
      deuda: sumarMontos(r.deuda_capital as Monto, r.deuda_interes as Monto),
      deudaCapital: r.deuda_capital as Monto,
      deudaInteres: r.deuda_interes as Monto,
      meses: r.meses ?? [],
      quita: r.quita as Monto,
      totalCuotas: r.total as Monto,
      pagado: sumarMontos("0.00", ...cuotas.map((c) => c.pagado ?? "0.00")),
      cargoCaida: r.cargo_caida as Monto | null,
      cuotasParaCaer: r.cuotas_para_caer,
      cuotasVencidas: cuotas.filter((c) => c.estado === "vencida").length,
      cuotas,
      puedeAdministrar: r.puede,
      actaReferencia: r.acta_referencia,
      actaAdjunta: r.acta_adjunta,
      pideActa: r.tipo === "a_medida" && r.quita_requiere_acta && aCentavos(r.quita as Monto) > 0n,
      exigeActa: r.tipo === "a_medida" && r.quita_requiere_acta,
      quitaInteres: r.quita_interes as Monto,
      quitaCapital: r.quita_capital as Monto,
    };
  });
}

/** Lo que devuelve la simulación cuando la caída se puede declarar. */
class CaidaSimulada extends Error {
  // Propiedad común y no `constructor(readonly …)`: los scripts corren con Node sin compilar
  // (strip-only), que no acepta propiedades en los parámetros.
  readonly resultado: ResultadoDeLaCaida;
  constructor(resultado: ResultadoDeLaCaida) {
    super("caída simulada");
    this.resultado = resultado;
  }
}

/**
 * El desglose de «Declarar caído» **antes** de declararlo (pantalla 4): corre `declararCaido` entero,
 * con el mismo código y la misma base, dentro de un punto de guardado, y lo deshace. Así las cifras del
 * diálogo son exactamente las que quedarían, sin un segundo cálculo que pueda diferir. Si el plan no se
 * puede declarar caído todavía, devuelve null.
 */
export async function simularCaida(tx: DbConIdentidad, parametros: { readonly planId: string }): Promise<ResultadoDeLaCaida | null> {
  const planId = idSchema.parse(parametros.planId);
  try {
    await tx.transaction(async (punto) => {
      // El punto de guardado corre en la misma conexión y transacción: la identidad (y la RLS) son las mismas.
      throw new CaidaSimulada(await declararCaido(punto as unknown as DbConIdentidad, { planId, nota: null }));
    });
  } catch (e) {
    if (e instanceof CaidaSimulada) return e.resultado;
    // Solo «todavía no se puede» (faltan cuotas impagas, o ya no está vigente): cualquier otro error es
    // un problema real y no se esconde detrás de un botón apagado.
    if (esErrorDeNegocio(e) && e.codigo === "dato_invalido") return null;
    throw e;
  }
  return null;
}
