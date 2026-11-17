/**
 * El presupuesto del mes, los gastos contra presupuesto y el resultado del mes (encargo 16c, `0090`).
 *
 * **Nada de esto calcula plata que se cobre.** El presupuesto propone el importe del mes —que se sigue
 * grabando por la cuota del barrio (`definirCuotaFija`), con su misma confirmación— y después se compara
 * contra lo gastado. El resultado del mes lee lo que ya pasó: lo que se devengó, lo que se gastó, lo que
 * entró y lo que salió. No mueve plata y no toca la imputación, la mora ni el interés.
 *
 * Cada número dice de dónde sale (regla 4 de `CLAUDE.md`); las definiciones exactas están junto a cada
 * consulta y en `HANDOFF.md`.
 */
import { sql } from "drizzle-orm";
import { aCentavos, sumarMontos, restarMontos, type Monto } from "@admin-barrios/shared/dinero";
import {
  avanceDelRubro,
  copiarPresupuestoSchema,
  guardarPresupuestoSchema,
  importePorUnidadQueCubre,
  type CopiarPresupuesto,
  type GuardarPresupuesto,
  type ModoDelImporte,
} from "@admin-barrios/shared/presupuesto";
import type { DbConIdentidad } from "../client.ts";
import { enBase, rechazar } from "../errores.ts";
import { comoSeDevengaEn } from "./devengado.ts";

// ────────────────────────────────────────────────────────────────────────────────────────────────
// El período y su mes anterior
// ────────────────────────────────────────────────────────────────────────────────────────────────

type DatosDelPeriodo = {
  readonly periodoId: string;
  readonly barrioId: string;
  readonly periodo: string;
  readonly mesAnterior: string;
  readonly periodoAnteriorId: string | null;
  readonly estado: "borrador" | "revisada" | "emitida" | "distribuida";
  readonly zonaHoraria: string;
  readonly puedeEditar: boolean;
};

async function leerPeriodo(tx: DbConIdentidad, periodoId: string): Promise<DatosDelPeriodo> {
  const { rows } = await tx.execute<{
    barrio_id: string;
    periodo: string;
    mes_anterior: string;
    periodo_anterior_id: string | null;
    estado: DatosDelPeriodo["estado"];
    zona_horaria: string;
    puede: boolean;
  }>(sql`
    select p.barrio_id, p.periodo,
           to_char((p.periodo || '-01')::date - interval '1 month', 'YYYY-MM') as mes_anterior,
           (select a.id from periodo_expensa a
             where a.barrio_id = p.barrio_id and a.origen = 'mensual'
               and a.periodo = to_char((p.periodo || '-01')::date - interval '1 month', 'YYYY-MM')) as periodo_anterior_id,
           p.estado::text as estado, b.zona_horaria,
           app.has_role_on(p.barrio_id, array['admin_plataforma','admin_barrio']::app.rol_membership[]) as puede
      from periodo_expensa p join barrio b on b.barrio_id = p.barrio_id
     where p.id = ${periodoId} and p.origen = 'mensual'
  `);
  const f = rows[0];
  if (!f) rechazar("periodo_no_encontrado", "El mes no existe o no tenés acceso.", "Volvé a la lista de meses del barrio.");
  return {
    periodoId,
    barrioId: f.barrio_id,
    periodo: f.periodo,
    mesAnterior: f.mes_anterior,
    periodoAnteriorId: f.periodo_anterior_id,
    estado: f.estado,
    zonaHoraria: f.zona_horaria,
    puedeEditar: f.puede,
  };
}

const enPreparacion = (estado: DatosDelPeriodo["estado"]) => estado === "borrador" || estado === "revisada";

/** Lo gastado por rubro en un período: la suma de `gasto_periodo.monto`, con los ajustes negativos restando. */
async function gastadoPorRubro(tx: DbConIdentidad, periodoId: string | null): Promise<Map<string, Monto>> {
  if (periodoId === null) return new Map();
  const { rows } = await tx.execute<{ concepto_id: string; gastado: string }>(sql`
    select g.concepto_id, sum(g.monto)::numeric(14,2)::text as gastado
      from gasto_periodo g where g.periodo_id = ${periodoId}
     group by g.concepto_id
  `);
  return new Map(rows.map((r) => [r.concepto_id, r.gastado as Monto]));
}

async function presupuestoPorRubro(tx: DbConIdentidad, periodoId: string | null): Promise<{ rubros: Map<string, Monto>; margen: Monto | null }> {
  if (periodoId === null) return { rubros: new Map(), margen: null };
  const { rows } = await tx.execute<{ concepto_id: string; monto: string }>(sql`
    select concepto_id, monto::text from presupuesto_rubro where periodo_id = ${periodoId}
  `);
  const { rows: margen } = await tx.execute<{ monto: string }>(sql`select monto::text from presupuesto_margen where periodo_id = ${periodoId}`);
  return { rubros: new Map(rows.map((r) => [r.concepto_id, r.monto as Monto])), margen: (margen[0]?.monto as Monto | undefined) ?? null };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Pantalla 3 · el presupuesto del mes
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type RubroDelPresupuesto = {
  readonly conceptoId: string;
  readonly nombre: string;
  /** Lo gastado en ese rubro el mes anterior (`null` si no hubo gasto). */
  readonly gastadoMesAnterior: Monto | null;
  /** Lo presupuestado este mes (`null` si el rubro no está en el presupuesto). */
  readonly presupuesto: Monto | null;
};

export type ImporteDelMes = {
  /** Por unidad, o el total del mes si el barrio reparte por coeficiente. */
  readonly modo: ModoDelImporte;
  readonly unidades: number;
  /** El importe que rige este mes, si ya hay uno cargado en la cuota. */
  readonly vigente: Monto | null;
  /** El del mes anterior, para comparar («En noviembre fue…»). */
  readonly mesAnterior: Monto | null;
  /** El que cubre el total a pedir (por unidad, redondeado hacia arriba al centavo). */
  readonly queCubre: Monto | null;
};

export type PresupuestoDelMes = {
  readonly periodoId: string;
  readonly barrioId: string;
  readonly periodo: string;
  readonly mesAnterior: string;
  /** Se puede cambiar: el mes se prepara y quien mira es la administración. */
  readonly editable: boolean;
  readonly enPreparacion: boolean;
  readonly rubros: readonly RubroDelPresupuesto[];
  /** Los conceptos del catálogo que todavía no están en el presupuesto, para «Agregar un rubro». */
  readonly paraAgregar: readonly { readonly conceptoId: string; readonly nombre: string }[];
  /** Lo gastado el mes anterior en los rubros que se listan. */
  readonly gastoMesAnterior: Monto;
  /** La suma de los rubros presupuestados. */
  readonly gastoEsperado: Monto;
  readonly margen: Monto;
  /** Gasto esperado + margen. */
  readonly totalAPedir: Monto;
  /** Si el mes anterior tiene presupuesto o gastos para copiar. */
  readonly sePuedeCopiar: boolean;
  /** `null` en un barrio cuyo importe sale de los gastos del mes: ahí no hay importe que proponer. */
  readonly importe: ImporteDelMes | null;
};

/** El importe que rige un mes en la cuota del barrio: el único por unidad, o el total del mes. */
async function importeDeLaCuota(tx: DbConIdentidad, barrioId: string, mes: string, modo: ModoDelImporte): Promise<Monto | null> {
  const { rows } = await tx.execute<{ total: string | null; unico: string | null }>(sql`
    select v.total_del_mes::text as total,
           (select case when count(distinct c.importe) = 1 then min(c.importe)::text end
              from cuota_fija c join unidad_funcional u on u.id = c.unidad_funcional_id and u.baja_at is null
             where c.version_id = v.id) as unico
      from cuota_fija_version v
     where v.barrio_id = ${barrioId} and v.vigente_desde <= ${`${mes}-01`}::date
       and (v.vigente_hasta is null or v.vigente_hasta > ${`${mes}-01`}::date)
     order by v.vigente_desde desc limit 1
  `);
  const f = rows[0];
  if (!f) return null;
  return ((modo === "total_del_mes" ? f.total : f.unico) as Monto | null) ?? null;
}

export async function presupuestoDelMes(tx: DbConIdentidad, parametros: { readonly periodoId: string }): Promise<PresupuestoDelMes> {
  return enBase(async () => {
    const p = await leerPeriodo(tx, parametros.periodoId);
    const { rows: catalogo } = await tx.execute<{ id: string; nombre: string; activo: boolean }>(sql`
      select id, nombre, activo from concepto where barrio_id = ${p.barrioId} order by lower(nombre)
    `);
    const actual = await presupuestoPorRubro(tx, p.periodoId);
    const anterior = await presupuestoPorRubro(tx, p.periodoAnteriorId);
    const gastadoAntes = await gastadoPorRubro(tx, p.periodoAnteriorId);

    // Los rubros del presupuesto; si todavía no hay presupuesto, los que tuvieron gasto el mes anterior
    // (con el presupuesto vacío), para que se vea contra qué se presupuesta.
    const enLista = actual.rubros.size > 0 ? new Set(actual.rubros.keys()) : new Set(gastadoAntes.keys());
    const rubros: RubroDelPresupuesto[] = catalogo
      .filter((c) => enLista.has(c.id))
      .map((c) => ({
        conceptoId: c.id,
        nombre: c.nombre,
        gastadoMesAnterior: gastadoAntes.get(c.id) ?? null,
        presupuesto: actual.rubros.get(c.id) ?? null,
      }));
    const paraAgregar = catalogo.filter((c) => c.activo && !actual.rubros.has(c.id)).map((c) => ({ conceptoId: c.id, nombre: c.nombre }));

    const gastoEsperado = sumarMontos("0.00", ...actual.rubros.values());
    const margen = actual.margen ?? ("0.00" as Monto);
    const totalAPedir = sumarMontos(gastoEsperado, margen);

    // El panel del importe: solo si el importe del mes lo define la administración.
    const devengado = await comoSeDevengaEn(tx, { barrioId: p.barrioId, mes: p.periodo });
    let importe: ImporteDelMes | null = null;
    if (devengado.origen === "administracion") {
      const modo: ModoDelImporte = devengado.reparto === "coeficiente" ? "total_del_mes" : "por_unidad";
      const { rows: u } = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from unidad_funcional where barrio_id = ${p.barrioId} and baja_at is null
      `);
      const unidades = u[0]?.n ?? 0;
      importe = {
        modo,
        unidades,
        vigente: await importeDeLaCuota(tx, p.barrioId, p.periodo, modo),
        mesAnterior: await importeDeLaCuota(tx, p.barrioId, p.mesAnterior, modo),
        queCubre: modo === "total_del_mes" ? totalAPedir : importePorUnidadQueCubre(totalAPedir, unidades),
      };
    }

    return {
      periodoId: p.periodoId,
      barrioId: p.barrioId,
      periodo: p.periodo,
      mesAnterior: p.mesAnterior,
      editable: enPreparacion(p.estado) && p.puedeEditar,
      enPreparacion: enPreparacion(p.estado),
      rubros,
      paraAgregar,
      // De los rubros que se listan, para que la fila compare lo mismo que la columna.
      gastoMesAnterior: sumarMontos("0.00", ...rubros.map((r) => r.gastadoMesAnterior ?? "0.00")),
      gastoEsperado,
      margen,
      totalAPedir,
      sePuedeCopiar: actual.rubros.size === 0 && (anterior.rubros.size > 0 || gastadoAntes.size > 0),
      importe,
    };
  });
}

async function exigirQueSeEdite(tx: DbConIdentidad, periodoId: string): Promise<DatosDelPeriodo> {
  const p = await leerPeriodo(tx, periodoId);
  if (!p.puedeEditar) rechazar("sin_permiso", "El presupuesto lo carga la administración del barrio.", "Pedíselo a quien administra el barrio.");
  if (!enPreparacion(p.estado)) {
    rechazar("periodo_no_editable", "El mes ya se emitió: el presupuesto queda como se cargó.", "El presupuesto se carga mientras el mes se prepara.");
  }
  return p;
}

/**
 * Deja el presupuesto del mes exactamente como viene: los rubros que no vienen se sacan, los que
 * vienen se cargan o se actualizan, y el margen se fija. Solo la administración y mientras el mes se
 * prepara (también lo controla `app.presupuesto_antes`).
 */
export async function guardarPresupuesto(tx: DbConIdentidad, parametros: GuardarPresupuesto): Promise<void> {
  const q = guardarPresupuestoSchema.parse(parametros);
  await enBase(async () => {
    const p = await exigirQueSeEdite(tx, q.periodoId);
    const ids = q.rubros.map((r) => r.conceptoId);
    // Los rubros tienen que ser del catálogo de ESTE barrio (lo garantiza también la FK compuesta).
    if (ids.length > 0) {
      const { rows } = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from concepto where barrio_id = ${p.barrioId} and id = any(${sql.param(ids)}::uuid[])
      `);
      if ((rows[0]?.n ?? 0) !== ids.length) {
        rechazar("dato_invalido", "Algún rubro no está en los conceptos del barrio.", "Recargá la pantalla y volvé a elegir.");
      }
    }
    await tx.execute(sql`
      delete from presupuesto_rubro
       where periodo_id = ${q.periodoId} and not (concepto_id = any(${sql.param(ids)}::uuid[]))
    `);
    for (const r of q.rubros) {
      await tx.execute(sql`
        insert into presupuesto_rubro (barrio_id, periodo_id, concepto_id, monto, cargado_por)
        values (${p.barrioId}, ${q.periodoId}, ${r.conceptoId}, ${r.monto}::numeric, app.current_user_id())
        on conflict (periodo_id, concepto_id) do update set monto = excluded.monto
          where presupuesto_rubro.monto is distinct from excluded.monto
      `);
    }
    await tx.execute(sql`
      insert into presupuesto_margen (periodo_id, barrio_id, monto, cargado_por)
      values (${q.periodoId}, ${p.barrioId}, ${q.margen}::numeric, app.current_user_id())
      on conflict (periodo_id) do update set monto = excluded.monto
        where presupuesto_margen.monto is distinct from excluded.monto
    `);
  });
}

/**
 * «Copiar del mes anterior»: el presupuesto del mes anterior, rubro por rubro, con su margen. Si el mes
 * anterior no tuvo presupuesto, lo gastado en cada rubro (sin margen). Solo sobre un presupuesto vacío:
 * no pisa lo que ya se cargó.
 */
export async function copiarPresupuestoDelMesAnterior(tx: DbConIdentidad, parametros: CopiarPresupuesto): Promise<{ readonly rubros: number }> {
  const { periodoId } = copiarPresupuestoSchema.parse(parametros);
  return enBase(async () => {
    const p = await exigirQueSeEdite(tx, periodoId);
    const actual = await presupuestoPorRubro(tx, periodoId);
    if (actual.rubros.size > 0) {
      rechazar("dato_invalido", "Este mes ya tiene presupuesto cargado.", "Cambiá los importes a mano: copiar no pisa lo que ya está.");
    }
    const anterior = await presupuestoPorRubro(tx, p.periodoAnteriorId);
    const origen =
      anterior.rubros.size > 0
        ? { rubros: anterior.rubros, margen: anterior.margen ?? ("0.00" as Monto) }
        : {
            // Del gasto, solo lo positivo: un rubro que cerró en negativo (un ajuste) no se presupuesta en negativo.
            rubros: new Map([...(await gastadoPorRubro(tx, p.periodoAnteriorId))].filter(([, m]) => aCentavos(m) > 0n)),
            margen: "0.00" as Monto,
          };
    if (origen.rubros.size === 0) {
      rechazar("dato_invalido", `El mes anterior no tiene presupuesto ni gastos para copiar.`, "Agregá los rubros a mano.");
    }
    await guardarPresupuesto(tx, {
      periodoId,
      rubros: [...origen.rubros].map(([conceptoId, monto]) => ({ conceptoId, monto })),
      margen: origen.margen,
    });
    return { rubros: origen.rubros.size };
  });
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Pantalla 6 · gastos contra presupuesto
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type RubroContraPresupuesto = {
  readonly conceptoId: string;
  readonly nombre: string;
  /** `null`: el rubro tiene gasto pero no estaba en el presupuesto. */
  readonly presupuesto: Monto | null;
  /** La suma de `gasto_periodo.monto` del mes en ese rubro, con los ajustes negativos restando. */
  readonly gastado: Monto;
  /** Presupuesto − gastado (negativo: se pasó). `null` sin presupuesto. */
  readonly diferencia: Monto | null;
  /** Gastado sobre presupuesto, en porcentaje entero. `null` sin presupuesto o con presupuesto cero. */
  readonly avance: number | null;
  /** Gastó más de lo presupuestado. */
  readonly excedido: boolean;
};

export type GastosContraPresupuesto = {
  /** El mes tiene presupuesto cargado. Sin presupuesto la pantalla no muestra el cuadro. */
  readonly hayPresupuesto: boolean;
  readonly rubros: readonly RubroContraPresupuesto[];
  readonly totalPresupuesto: Monto;
  readonly totalGastado: Monto;
  readonly totalDiferencia: Monto;
};

export async function gastosContraPresupuesto(tx: DbConIdentidad, parametros: { readonly periodoId: string }): Promise<GastosContraPresupuesto> {
  return enBase(async () => {
    const p = await leerPeriodo(tx, parametros.periodoId);
    const { rubros: presupuesto } = await presupuestoPorRubro(tx, p.periodoId);
    const gastado = await gastadoPorRubro(tx, p.periodoId);
    const ids = new Set([...presupuesto.keys(), ...gastado.keys()]);
    const { rows: nombres } = ids.size
      ? await tx.execute<{ id: string; nombre: string }>(sql`
          select id, nombre from concepto where id = any(${sql.param([...ids])}::uuid[])
        `)
      : { rows: [] };
    const nombreDe = new Map(nombres.map((n) => [n.id, n.nombre]));
    const rubros = [...ids]
      .map((id): RubroContraPresupuesto => {
        const pres = presupuesto.get(id) ?? null;
        const gas = gastado.get(id) ?? ("0.00" as Monto);
        return {
          conceptoId: id,
          nombre: nombreDe.get(id) ?? "",
          presupuesto: pres,
          gastado: gas,
          diferencia: pres === null ? null : restarMontos(pres, gas),
          avance: avanceDelRubro(pres, gas),
          excedido: pres !== null && aCentavos(gas) > aCentavos(pres),
        };
      })
      // Primero los presupuestados, en el orden del catálogo por nombre; después lo gastado fuera del presupuesto.
      .sort((a, b) => (a.presupuesto === null) !== (b.presupuesto === null) ? (a.presupuesto === null ? 1 : -1) : a.nombre.localeCompare(b.nombre, "es"));
    const totalPresupuesto = sumarMontos("0.00", ...presupuesto.values());
    // El total gastado es el de los rubros presupuestados, para que «Diferencia» compare lo mismo.
    const totalGastado = sumarMontos("0.00", ...rubros.filter((r) => r.presupuesto !== null).map((r) => r.gastado));
    return {
      hayPresupuesto: presupuesto.size > 0,
      rubros,
      totalPresupuesto,
      totalGastado,
      totalDiferencia: restarMontos(totalPresupuesto, totalGastado),
    };
  });
}

/** Un rubro que se pasó del presupuesto, para el aviso del mes. */
export type RubroExcedido = {
  readonly nombre: string;
  /** Cuánto se pasó. */
  readonly excedente: Monto;
  /** El último gasto cargado en ese rubro: de dónde vino el exceso. */
  readonly ultimoGasto: {
    readonly descripcion: string;
    readonly monto: Monto;
    /** `YYYY-MM-DD`, en la hora del barrio. */
    readonly fecha: string;
    /** Quién lo cargó, si se sabe (un gasto de una orden de pago lo sabe; uno cargado a mano, no). */
    readonly quien: string | null;
  } | null;
};

export async function rubrosExcedidos(tx: DbConIdentidad, periodoId: string): Promise<RubroExcedido[]> {
  const { rows } = await tx.execute<{
    nombre: string;
    excedente: string;
    descripcion: string | null;
    monto: string | null;
    fecha: string | null;
    quien: string | null;
  }>(sql`
    with x as (
      select r.concepto_id, r.monto as presupuesto,
             coalesce((select sum(g.monto) from gasto_periodo g where g.periodo_id = r.periodo_id and g.concepto_id = r.concepto_id), 0) as gastado
        from presupuesto_rubro r where r.periodo_id = ${periodoId}
    )
    select c.nombre, (x.gastado - x.presupuesto)::numeric(14,2)::text as excedente,
           u.descripcion, u.monto::text as monto, u.fecha, u.quien
      from x
      join concepto c on c.id = x.concepto_id
      left join lateral (
        select g.descripcion, g.monto,
               to_char(g.created_at at time zone b.zona_horaria, 'YYYY-MM-DD') as fecha,
               (select d.nombre from orden_pago o join usuario_demo d on d.user_id = o.creada_por where o.id = g.orden_pago_id) as quien
          from gasto_periodo g join barrio b on b.barrio_id = g.barrio_id
         -- El último gasto **positivo**: un ajuste negativo (la anulación de una orden) no explica un exceso.
         where g.periodo_id = ${periodoId} and g.concepto_id = x.concepto_id and g.monto > 0
         order by g.created_at desc, g.id desc limit 1
      ) u on true
     where x.gastado > x.presupuesto
     order by c.nombre
  `);
  return rows.map((r) => ({
    nombre: r.nombre,
    excedente: r.excedente as Monto,
    ultimoGasto:
      r.descripcion !== null && r.monto !== null && r.fecha !== null
        ? { descripcion: r.descripcion, monto: r.monto as Monto, fecha: r.fecha, quien: r.quien }
        : null,
  }));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Pantalla 7 · el resultado del mes
// ────────────────────────────────────────────────────────────────────────────────────────────────

export type ResultadoDelMes = {
  readonly periodo: string;
  /**
   * **En los papeles.** `devengado`: lo que el mes le pidió a las unidades, sin la deuda arrastrada ni
   * el interés por mora — la suma, en las liquidaciones del mes, de `total − saldo_anterior −
   * interes_mora`, que es la suma de sus líneas (cuota o prorrateo, cargos y descuentos). Con «solo el
   * mes» es exactamente `importe_cupon`. `gastado`: la suma de `gasto_periodo.monto` del mes, con los
   * ajustes negativos restando.
   */
  readonly enLosPapeles: { readonly devengado: Monto; readonly gastado: Monto; readonly diferencia: Monto };
  /**
   * **En la cuenta.** `cobrado`: la suma de los pagos no anulados con fecha en el mes (sin el saldo a
   * favor que una unidad trajo al activar el barrio, que no es plata que entró). `pagado`: la suma de
   * las órdenes de pago en estado pagada con `pagada_at` en el mes, en la hora del barrio.
   */
  readonly enLaCuenta: { readonly cobrado: Monto; readonly pagado: Monto; readonly diferencia: Monto };
  /** **Falta cobrar**: el capital pendiente hoy de las liquidaciones del mes, y cuántas unidades lo deben. */
  readonly faltaCobrar: { readonly monto: Monto; readonly unidades: number };
};

/** El resultado de un mes emitido. Solo lectura: no escribe nada. */
export async function resultadoDelMes(tx: DbConIdentidad, parametros: { readonly periodoId: string }): Promise<ResultadoDelMes> {
  return enBase(async () => {
    const p = await leerPeriodo(tx, parametros.periodoId);
    if (enPreparacion(p.estado)) {
      rechazar("periodo_no_editable", "El resultado es de un mes emitido.", "Emití el mes para ver cómo cerró.");
    }
    const { rows } = await tx.execute<{ devengado: string; gastado: string; cobrado: string; pagado: string; falta: string; unidades: number }>(sql`
      select
        (select coalesce(sum(l.total - l.saldo_anterior - coalesce(l.interes_mora, 0)), 0)
           from liquidacion l where l.periodo_id = ${p.periodoId})::numeric(14,2)::text as devengado,
        (select coalesce(sum(g.monto), 0) from gasto_periodo g where g.periodo_id = ${p.periodoId})::numeric(14,2)::text as gastado,
        (select coalesce(sum(pg.monto), 0) from pago pg
          where pg.barrio_id = ${p.barrioId} and pg.anulado_at is null and pg.origen not in ('activacion', 'plan')
            and to_char(pg.fecha, 'YYYY-MM') = ${p.periodo})::numeric(14,2)::text as cobrado,
        (select coalesce(sum(o.monto), 0) from orden_pago o
          where o.barrio_id = ${p.barrioId} and o.estado = 'pagada'
            and to_char(o.pagada_at at time zone ${p.zonaHoraria}, 'YYYY-MM') = ${p.periodo})::numeric(14,2)::text as pagado,
        (select coalesce(sum(cp.pendiente), 0)
           from liquidacion l join app.capitales_pendientes(${p.barrioId}::uuid) cp on cp.liquidacion_id = l.id
          where l.periodo_id = ${p.periodoId} and cp.pendiente > 0)::numeric(14,2)::text as falta,
        (select count(distinct l.unidad_funcional_id)::int
           from liquidacion l join app.capitales_pendientes(${p.barrioId}::uuid) cp on cp.liquidacion_id = l.id
          where l.periodo_id = ${p.periodoId} and cp.pendiente > 0) as unidades
    `);
    const f = rows[0]!;
    const devengado = f.devengado as Monto;
    const gastado = f.gastado as Monto;
    const cobrado = f.cobrado as Monto;
    const pagado = f.pagado as Monto;
    return {
      periodo: p.periodo,
      enLosPapeles: { devengado, gastado, diferencia: restarMontos(devengado, gastado) },
      enLaCuenta: { cobrado, pagado, diferencia: restarMontos(cobrado, pagado) },
      faltaCobrar: { monto: f.falta as Monto, unidades: f.unidades },
    };
  });
}
